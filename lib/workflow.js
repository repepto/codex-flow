'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const COMMAND_FORMATS = [
  'strict:true',
  'strict:false',
  'ok',
  'ask:<question>',
  'goal:<description>',
  'discuss',
  'discuss:close',
  'record:<id> "description"',
  'forget:<id>',
  'forget',
  'apply',
  'discard-step',
  'adopt-step "title"',
  'help',
  'status',
  'compare',
  'compare:<branch-name>',
  'check',
  'check:deep',
  'details',
  'details:<id>',
  'ls-steps:<n>',
  'resync'
];

const REMOVED_COMMANDS = [
  'commit',
  'commit "message"',
  'apply-only',
  'run-steps',
  'run-steps:auto',
  'abort-steps'
];

const TRANSIENT_RUNTIME_PATHS = [
  '.codex/state.md',
  '.codex/tmp/'
];

const REQUIRED_STATE_FIELDS = [
  'Sync Backend',
  'Last Known Revision',
  'Last Known Branch',
  'Last Sync Source',
  'Strict Mode',
  'Discussion Mode'
];

const REQUIRED_GITIGNORE_ENTRIES = [
  '.codex/state.md',
  '.codex/tmp/'
];

const SUPPORTED_OVERRIDE_FILES = new Set([
  'commands.md',
  'commit-rules.md',
  'after-step.md',
  'step-report-rules.md'
]);

const PROTECTED_ADOPT_CODEX_MEMORY_PATHS = [
  '.codex/config.toml',
  '.codex/context.md',
  '.codex/goal.md',
  '.codex/history.md',
  '.codex/current-step.md',
  '.codex/next-step.md',
  '.codex/last-report.md',
  '.codex/reports/'
];

const RULE_ANCHORS = [
  ['AGENTS.md', 'Starter Pack Repository Exception'],
  ['AGENTS.md', 'Startup Procedure'],
  ['AGENTS.md', 'Commands are valid only when the entire user prompt exactly matches'],
  ['.codex/core/commands.md', '## Exact Match Rule'],
  ['.codex/core/commands.md', '## Stability Safety Gate'],
  ['.codex/core/commands.md', '## apply'],
  ['.codex/core/commands.md', '## discard-step'],
  ['.codex/core/commands.md', '## adopt-step'],
  ['.codex/core/commands.md', '## discuss'],
  ['.codex/core/commands.md', '## resync'],
  ['.codex/core/commit-rules.md', 'One completed normal step or adopted manual step must create exactly one git commit.'],
  ['.codex/core/commit-rules.md', 'Transient Runtime Files'],
  ['.codex/core/after-step.md', 'Required Commit Failure Recovery'],
  ['.codex/core/step-report-rules.md', 'Completed step reports use numeric filenames'],
  ['.codex/core/overrides.md', 'Full-file replacement is not supported']
];

const CONVENTIONAL_CHECK_SCRIPTS = [
  'check',
  'lint',
  'typecheck',
  'test'
];

const DEFAULT_REQUIRED_CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const WORKFLOW_FOOTER_SEPARATOR = '────────────────────';
const READ_ONLY_WORKFLOW_COMMANDS = [
  'ask:<question>',
  'help',
  'status',
  'check',
  'check:deep',
  'compare',
  'compare:<branch-name>',
  'details',
  'details:<id>',
  'ls-steps:<n>'
];
const RUNTIME_MODE_COMMANDS = [
  'strict:true',
  'strict:false'
];

function parseWorkflowCommand(prompt) {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return invalidCommand('Prompt is empty.');
  }

  if (prompt !== prompt.trim() || prompt.includes('\n') || prompt.includes('\r')) {
    return invalidCommand('Commands must match exactly with no surrounding whitespace or line breaks.');
  }

  const fixed = new Set([
    'strict:true',
    'strict:false',
    'ok',
    'discuss',
    'discuss:close',
    'forget',
    'apply',
    'discard-step',
    'help',
    'status',
    'compare',
    'check',
    'check:deep',
    'details',
    'resync'
  ]);

  if (fixed.has(prompt)) {
    return validCommand(prompt, {});
  }

  let match = prompt.match(/^ask:(.+)$/);
  if (match) {
    const question = match[1].trim();
    if (question.length === 0) {
      return invalidCommand('ask question is empty.');
    }
    return validCommand('ask', { question });
  }

  match = prompt.match(/^goal:(.+)$/);
  if (match) {
    const description = match[1].trim();
    if (description.length === 0) {
      return invalidCommand('goal description is empty.');
    }
    return validCommand('goal', { description });
  }

  match = prompt.match(/^record:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?) "([^"]*)"$/);
  if (match) {
    const id = match[1];
    const description = match[2];
    if (!isValidDecisionId(id)) {
      return invalidCommand('record id is invalid.');
    }
    if (description.trim().length === 0) {
      return invalidCommand('record description is empty.');
    }
    return validCommand('record', { id, description });
  }

  match = prompt.match(/^forget:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/);
  if (match) {
    const id = match[1];
    if (!isValidDecisionId(id)) {
      return invalidCommand('forget id is invalid.');
    }
    return validCommand('forget-by-id', { id });
  }

  match = prompt.match(/^adopt-step "([^"]*)"$/);
  if (match) {
    const title = match[1];
    if (title.trim().length === 0) {
      return invalidCommand('adopt-step title is empty.');
    }
    return validCommand('adopt-step', { title });
  }

  match = prompt.match(/^details:([1-9][0-9]*)$/);
  if (match) {
    return validCommand('details-by-id', { id: Number(match[1]) });
  }

  match = prompt.match(/^ls-steps:([1-9][0-9]*)$/);
  if (match) {
    return validCommand('ls-steps', { count: Number(match[1]) });
  }

  match = prompt.match(/^compare:(.+)$/);
  if (match) {
    const branchName = match[1];
    if (!isValidBranchArgument(branchName)) {
      return invalidCommand('compare branch argument is invalid.');
    }
    return validCommand('compare-branch', { branchName });
  }

  return invalidCommand('Prompt does not exactly match a supported command.');
}

function evaluateNormalStepGate(targetRoot) {
  const errors = [];
  const warnings = [];
  const git = getGitState(targetRoot);
  if (!git.ok) {
    return gateResult(false, [git.error], warnings, { git });
  }

  const state = readCodexState(targetRoot);
  if (!state.exists) {
    errors.push('.codex/state.md is missing; run resync after bootstrap install is committed.');
  } else {
    const initialized = isInitializedState(state.fields);
    if (!initialized) {
      errors.push('Sync baseline is uninitialized; run resync after the working tree is clean.');
    } else {
      if (state.fields['Last Known Revision'] !== git.revision) {
        errors.push('Current git revision does not match .codex/state.md.');
      }
      if (state.fields['Last Known Branch'] !== git.branch) {
        errors.push('Current git branch does not match .codex/state.md.');
      }
    }
  }

  const currentStep = readCurrentStep(targetRoot);
  if (currentStep.active) {
    errors.push('Active step already exists.');
  }

  if (state.exists && state.fields['Discussion Mode'] === 'active') {
    errors.push('Discussion mode is active.');
  }

  if (git.changes.length > 0) {
    errors.push('Pre-existing project changes are present.');
  }

  return gateResult(errors.length === 0, errors, warnings, { git, state, currentStep });
}

function evaluateStartStepGate(targetRoot) {
  return mergeGateResults(
    validateWorkflowState(targetRoot),
    evaluateNormalStepGate(targetRoot)
  );
}

function inspectAskContext(targetRoot, question) {
  const normalizedQuestion = normalizeAskQuestion(question);
  if (!normalizedQuestion) {
    return gateResult(false, ['ask question is empty.'], [], {});
  }

  const git = getGitState(targetRoot);
  const state = readCodexState(targetRoot);
  const currentStep = readCurrentStep(targetRoot);
  const nextStepIds = calculateNextStepId(targetRoot);
  const planningContext = readPlanningContext(targetRoot);
  const validation = validateWorkflowState(targetRoot);
  const applyGate = evaluateApplyGate(targetRoot);

  return gateResult(true, [], [], {
    question: normalizedQuestion,
    git,
    state,
    currentStep,
    nextStepIds,
    planningContext,
    validation,
    applyGate,
    readOnly: true
  });
}

function buildWorkflowStateFooter(targetRoot, options = {}) {
  const state = inspectWorkflowFooterState(targetRoot);
  const compact = options.compact === true;
  const footer = formatWorkflowStateFooter(state.details, { compact });

  return gateResult(true, [], state.warnings, {
    ...state.details,
    compact,
    footer,
    readOnly: true
  });
}

function inspectWorkflowFooterState(targetRoot) {
  const warnings = [];
  const git = getGitState(targetRoot);
  const state = readCodexState(targetRoot);
  const currentStep = readCurrentStep(targetRoot);
  const goal = readGoal(targetRoot);
  const nextStep = readNextStepRecommendation(targetRoot);
  const validation = validateWorkflowState(targetRoot);
  const startGate = evaluateStartStepGate(targetRoot);
  const goalGate = evaluateGoalGate(targetRoot, 'Temporary footer goal probe');
  const applyGate = evaluateApplyGate(targetRoot);
  const resyncGate = evaluateResyncGate(targetRoot);
  const discardGate = evaluateDiscardStepAvailability(currentStep, git);
  const adoptGate = evaluateAdoptStepAvailability(targetRoot, {
    git,
    state,
    currentStep
  });
  const gitTree = describeFooterGitTree(git, currentStep);
  const stepBase = describeFooterStepBase(currentStep, git, state);
  const commandState = classifyWorkflowCommands({
    git,
    state,
    currentStep,
    nextStep,
    startGate,
    goalGate,
    applyGate,
    resyncGate,
    discardGate,
    adoptGate
  });

  if (!git.ok) {
    warnings.push(git.error);
  }
  warnings.push(...goal.errors, ...goal.warnings);
  warnings.push(...validation.errors, ...validation.warnings);

  return gateResult(true, [], uniqueStrings(warnings), {
    activeStep: describeFooterActiveStep(currentStep),
    goal: goal.ok && goal.details.exists
      ? goal.details.goal
      : goal.ok
        ? null
        : 'unknown',
    strictMode: state.fields['Strict Mode'] || 'true',
    discussionMode: state.fields['Discussion Mode'] || 'none',
    gitTree,
    stepBase,
    commands: commandState,
    git,
    state,
    currentStep,
    nextStep,
    validation,
    readOnly: true
  });
}

function evaluateDiscardStepAvailability(currentStep, git) {
  const errors = [];
  if (!currentStep.active) {
    errors.push('No active step.');
  }
  if (!git.ok) {
    errors.push(git.error);
  }

  const blockingChanges = git.ok
    ? git.changes.filter((change) => change.path !== '.codex/current-step.md')
    : [];
  if (blockingChanges.length > 0) {
    errors.push(`discard-step cannot run while project changes are present: ${blockingChanges.map((change) => change.path).join(', ')}.`);
  }

  return gateResult(errors.length === 0, errors, [], {
    currentStep,
    git,
    blockingChanges
  });
}

function evaluateAdoptStepAvailability(targetRoot, { git, state, currentStep }) {
  const errors = [];
  const warnings = [];

  if (!git.ok) {
    return gateResult(false, [git.error], warnings, { git, state, currentStep });
  }

  if (!state.exists) {
    errors.push('.codex/state.md is missing.');
  } else if (!isInitializedState(state.fields)) {
    errors.push('Sync baseline is uninitialized.');
  } else {
    if (state.fields['Last Known Revision'] !== git.revision) {
      errors.push('Current git revision does not match .codex/state.md.');
    }
    if (state.fields['Last Known Branch'] !== git.branch) {
      errors.push('Current git branch does not match .codex/state.md.');
    }
    if (state.fields['Discussion Mode'] === 'active') {
      errors.push('Discussion mode is active.');
    }
  }

  if (currentStep.active) {
    errors.push('Active step already exists.');
  }

  const commitWorthyChanges = git.changes.filter((change) => !isTransientRuntimePath(change.path));
  if (commitWorthyChanges.length === 0) {
    errors.push('No commit-worthy manual changes to adopt.');
  }

  const protectedCodexMemoryChanges = commitWorthyChanges
    .filter((change) => isProtectedAdoptCodexMemoryPath(change.path));
  if (protectedCodexMemoryChanges.length > 0) {
    errors.push('adopt-step cannot adopt pre-existing changes in versioned Codex memory/config.');
  }

  let stability = null;
  if (errors.length === 0) {
    stability = evaluateStabilitySafetyGate(targetRoot, { git, changes: commitWorthyChanges });
    errors.push(...stability.errors);
    warnings.push(...stability.warnings);
  }

  return gateResult(errors.length === 0, errors, warnings, {
    git,
    state,
    currentStep,
    commitWorthyChanges,
    protectedCodexMemoryChanges,
    stability
  });
}

function classifyWorkflowCommands({
  git,
  state,
  currentStep,
  nextStep,
  startGate,
  goalGate,
  applyGate,
  resyncGate,
  discardGate,
  adoptGate
}) {
  const available = [];
  const blocked = [];
  const blockedReasons = {};
  const availableNextCommands = [];
  let recommendedNextCommand = null;

  const addAvailable = (command) => {
    available.push(command);
  };
  const addBlocked = (command, reason) => {
    blocked.push(command);
    blockedReasons[command] = reason || 'Blocked in the current workflow state.';
  };
  const addByGate = (command, gate) => {
    if (gate.ok) {
      addAvailable(command);
      return;
    }
    addBlocked(command, gate.errors.join(' ') || 'Blocked in the current workflow state.');
  };

  for (const command of READ_ONLY_WORKFLOW_COMMANDS) {
    addAvailable(command);
  }
  for (const command of RUNTIME_MODE_COMMANDS) {
    addAvailable(command);
  }

  const discussionMode = state.fields['Discussion Mode'] || 'none';
  const discussionActive = discussionMode === 'active';

  if (discussionActive) {
    addAvailable('discuss:close');
    addBlocked('discuss', 'Discussion mode is already active.');
    addBlocked('ok', 'Discussion mode is active.');
    addBlocked('goal:<description>', 'Discussion mode is active.');
    addBlocked('record:<id> "description"', 'Discussion mode is active.');
    addBlocked('forget:<id>', 'Discussion mode is active.');
    addBlocked('forget', 'Discussion mode is active.');
    addBlocked('apply', 'Discussion mode is active.');
    addBlocked('discard-step', 'Discussion mode is active.');
    addBlocked('adopt-step "title"', 'Discussion mode is active.');
    addBlocked('resync', 'Discussion mode is active.');
    recommendedNextCommand = 'discuss:close';
  } else if (currentStep.active) {
    addAvailable('record:<id> "description"');
    addAvailable('forget:<id>');
    addAvailable('forget');
    addByGate('apply', applyGate);
    addByGate('discard-step', discardGate);
    addBlocked('ok', 'Active step already exists.');
    addBlocked('goal:<description>', 'Active step already exists.');
    addBlocked('discuss', 'Active step already exists.');
    addBlocked('adopt-step "title"', 'Active step already exists.');
    addBlocked('resync', 'Active step already exists.');

    if (applyGate.ok) {
      recommendedNextCommand = 'apply';
    } else if (discardGate.ok) {
      recommendedNextCommand = 'discard-step';
    }
  } else {
    addByGate('goal:<description>', goalGate);
    if (startGate.ok && nextStep.ok) {
      addAvailable('ok');
    } else {
      const reasons = [...startGate.errors, ...nextStep.errors].join(' ');
      addBlocked('ok', reasons || 'No recommended next step is available.');
    }
    addAvailable('discuss');
    addBlocked('record:<id> "description"', 'No active step.');
    addBlocked('forget:<id>', 'No active step.');
    addBlocked('forget', 'No active step.');
    addBlocked('apply', 'No active step.');
    addBlocked('discard-step', 'No active step.');
    addByGate('adopt-step "title"', adoptGate);
    addByGate('resync', resyncGate);

    if (resyncGate.ok && syncNeedsResync(state, git)) {
      recommendedNextCommand = 'resync';
    } else if (startGate.ok && nextStep.ok) {
      recommendedNextCommand = 'ok';
    } else if (startGate.ok) {
      availableNextCommands.push('normal task prompt');
      availableNextCommands.push('goal:<description>');
      availableNextCommands.push('discuss');
    } else if (adoptGate.ok) {
      availableNextCommands.push('check');
      availableNextCommands.push('adopt-step "title"');
    } else if (resyncGate.ok) {
      availableNextCommands.push('resync');
    }
  }

  return {
    availableCommands: uniqueStrings(available),
    blockedCommands: uniqueStrings(blocked),
    blockedReasons,
    recommendedNextCommand,
    availableNextCommands: uniqueStrings(availableNextCommands)
  };
}

function syncNeedsResync(state, git) {
  if (!git.ok) {
    return false;
  }
  if (!state.exists || !isInitializedState(state.fields)) {
    return true;
  }
  return state.fields['Last Known Revision'] !== git.revision
    || state.fields['Last Known Branch'] !== git.branch;
}

function describeFooterActiveStep(currentStep) {
  if (!currentStep.exists) {
    return {
      active: false,
      display: 'none',
      shortDisplay: 'none',
      stepId: null,
      taskTitle: null
    };
  }
  if (!currentStep.active) {
    return {
      active: false,
      display: 'none',
      shortDisplay: 'none',
      stepId: null,
      taskTitle: null
    };
  }

  const title = firstTaskLine(currentStep.content) || 'untitled';
  return {
    active: true,
    display: `Step ${currentStep.stepId || 'unknown'} (${title})`,
    shortDisplay: `Step ${currentStep.stepId || 'unknown'}`,
    stepId: currentStep.stepId,
    taskTitle: title
  };
}

function describeFooterGitTree(git, currentStep) {
  if (!git.ok) {
    return {
      status: 'unknown',
      display: 'unknown',
      dirtyPaths: [],
      rawDirtyPaths: []
    };
  }

  const rawDirtyPaths = git.changes.map((change) => change.path);
  const dirtyChanges = git.changes.filter((change) => {
    if (isTransientRuntimePath(change.path)) {
      return false;
    }
    return !(currentStep.active && change.path === '.codex/current-step.md');
  });
  const dirtyPaths = dirtyChanges.map((change) => change.path);
  const status = dirtyPaths.length === 0 ? 'clean' : 'dirty';
  const onlyActiveStepMetadata = status === 'clean' && rawDirtyPaths.includes('.codex/current-step.md');

  return {
    status,
    display: onlyActiveStepMetadata ? 'clean (active-step metadata pending)' : status,
    dirtyPaths,
    rawDirtyPaths
  };
}

function describeFooterStepBase(currentStep, git, state) {
  if (!currentStep.exists) {
    return 'unknown';
  }
  if (!currentStep.active) {
    return 'none';
  }
  if (!git.ok) {
    return 'unknown';
  }
  if (!currentStep.baseRevision || currentStep.baseRevision === 'none') {
    return 'unknown';
  }
  if (!currentStep.baseBranch || currentStep.baseBranch === 'none') {
    return 'unknown';
  }
  if (currentStep.baseRevision !== git.revision || currentStep.baseBranch !== git.branch) {
    return 'stale';
  }
  if (state.exists && isInitializedState(state.fields)) {
    if (state.fields['Last Known Revision'] !== currentStep.baseRevision) {
      return 'stale';
    }
    if (state.fields['Last Known Branch'] !== currentStep.baseBranch) {
      return 'stale';
    }
  }
  return 'current';
}

function formatWorkflowStateFooter(details, options = {}) {
  if (options.compact === true) {
    return formatCompactWorkflowStateFooter(details);
  }
  return formatFullWorkflowStateFooter(details);
}

function formatFullWorkflowStateFooter(details) {
  const commands = details.commands;
  const lines = [
    WORKFLOW_FOOTER_SEPARATOR,
    '',
    'Workflow State',
    '',
    'Active Step:',
    '',
    details.activeStep.display,
    '',
    'Goal:',
    '',
    details.goal || 'none',
    '',
    'State:',
    '',
    `Strict Mode: ${details.strictMode}`,
    `Discussion Mode: ${details.discussionMode}`,
    `Git Tree: ${details.gitTree.display}`,
    `Step Base: ${details.stepBase}`,
    ''
  ];

  appendNextCommandLines(lines, commands);
  lines.push('');
  lines.push('Available Commands:');
  lines.push('');
  appendListLines(lines, commands.availableCommands);
  lines.push('');
  lines.push('Blocked Commands:');
  lines.push('');
  appendListLines(lines, commands.blockedCommands);

  return lines.join('\n').trimEnd();
}

function formatCompactWorkflowStateFooter(details) {
  const commands = details.commands;
  const lines = [
    WORKFLOW_FOOTER_SEPARATOR,
    '',
    'State:',
    '',
    `Active Step: ${details.activeStep.shortDisplay}`,
    `Goal: ${details.goal || 'none'}`,
    `Strict: ${details.strictMode}`,
    `Discussion: ${details.discussionMode}`,
    `Git Tree: ${details.gitTree.display}`,
    `Step Base: ${details.stepBase}`,
    ''
  ];

  lines.push('Next:');
  lines.push('');
  lines.push(commands.recommendedNextCommand || 'none');
  if (!commands.recommendedNextCommand && commands.availableNextCommands.length > 0) {
    lines.push('');
    lines.push('Available Next:');
    lines.push('');
    appendListLines(lines, commands.availableNextCommands);
  }
  lines.push('');
  lines.push('Available:');
  lines.push('');
  appendListLines(lines, commands.availableCommands);
  lines.push('');
  lines.push('Blocked:');
  lines.push('');
  appendListLines(lines, commands.blockedCommands);

  return lines.join('\n').trimEnd();
}

function appendNextCommandLines(lines, commands) {
  lines.push('Recommended Next Command:');
  lines.push('');
  lines.push(commands.recommendedNextCommand || 'none');
  if (!commands.recommendedNextCommand && commands.availableNextCommands.length > 0) {
    lines.push('');
    lines.push('Available Next Commands:');
    lines.push('');
    appendListLines(lines, commands.availableNextCommands);
  }
}

function appendListLines(lines, values) {
  if (!values || values.length === 0) {
    lines.push('none');
    return;
  }
  for (const value of values) {
    lines.push(value);
  }
}

function evaluateGoalGate(targetRoot, description) {
  const validation = validateWorkflowState(targetRoot);
  const errors = [...validation.errors];
  const warnings = [...validation.warnings];

  const normalized = normalizeGoalDescription(description);
  if (!normalized) {
    errors.push('goal description is empty.');
  }

  const git = getGitState(targetRoot);
  if (!git.ok) {
    errors.push(git.error);
    return gateResult(false, errors, warnings, {
      validation,
      git,
      normalizedDescription: normalized
    });
  }
  if (isGitTracked(targetRoot, '.codex/state.md')) {
    errors.push('.codex/state.md must be ignored runtime state before setting the project goal.');
  }

  const state = validation.details.state;
  const currentStep = validation.details.currentStep;

  if (!state.exists) {
    errors.push('.codex/state.md is missing; run resync after bootstrap install is committed.');
  } else if (!isInitializedState(state.fields)) {
    errors.push('Sync baseline is uninitialized; run resync after the working tree is clean.');
  } else {
    if (state.fields['Last Known Revision'] !== git.revision) {
      errors.push('Current git revision does not match .codex/state.md.');
    }
    if (state.fields['Last Known Branch'] !== git.branch) {
      errors.push('Current git branch does not match .codex/state.md.');
    }
  }

  if (state.exists && state.fields['Discussion Mode'] === 'active') {
    errors.push('Discussion mode is active.');
  }

  if (currentStep.active) {
    errors.push('Active step already exists.');
  }

  if (git.changes.length > 0) {
    errors.push('Git working tree must be clean before setting the project goal.');
  }

  return gateResult(errors.length === 0, errors, warnings, {
    validation,
    git,
    state,
    currentStep,
    normalizedDescription: normalized
  });
}

function evaluateResyncGate(targetRoot) {
  const errors = [];
  const warnings = [];
  const git = getGitState(targetRoot);
  if (!git.ok) {
    return gateResult(false, [git.error], warnings, { git });
  }

  const state = readCodexState(targetRoot);
  const currentStep = readCurrentStep(targetRoot);
  if (currentStep.active) {
    warnings.push('Active current step requires review before resync can advance baseline.');
  }

  if (git.changes.length > 0) {
    errors.push('Git working tree is dirty; resync cannot initialize or advance baseline.');
  }

  return gateResult(errors.length === 0, errors, warnings, { git, state, currentStep });
}

function evaluateAdoptStepGate(targetRoot, title, options = {}) {
  const errors = [];
  const warnings = [];

  if (typeof title !== 'string' || title.trim().length === 0 || title.includes('\n') || title.includes('\r')) {
    errors.push('adopt-step title is invalid.');
  }

  const git = getGitState(targetRoot);
  if (!git.ok) {
    return gateResult(false, [git.error, ...errors], warnings, { git });
  }

  const state = readCodexState(targetRoot);
  if (!state.exists) {
    errors.push('.codex/state.md is missing.');
  } else {
    const initialized = isInitializedState(state.fields);
    if (!initialized) {
      errors.push('Sync baseline is uninitialized.');
    } else {
      if (state.fields['Last Known Revision'] !== git.revision) {
        errors.push('Current git revision does not match .codex/state.md.');
      }
      if (state.fields['Last Known Branch'] !== git.branch) {
        errors.push('Current git branch does not match .codex/state.md.');
      }
    }
    if (state.fields['Discussion Mode'] === 'active') {
      errors.push('Discussion mode is active.');
    }
  }

  const currentStep = readCurrentStep(targetRoot);
  if (currentStep.active) {
    errors.push('Active step already exists.');
  }

  const commitWorthyChanges = git.changes.filter((change) => !isTransientRuntimePath(change.path));
  if (commitWorthyChanges.length === 0) {
    errors.push('No commit-worthy manual changes to adopt.');
  }

  const protectedCodexMemoryChanges = commitWorthyChanges
    .filter((change) => isProtectedAdoptCodexMemoryPath(change.path));
  if (protectedCodexMemoryChanges.length > 0) {
    const paths = protectedCodexMemoryChanges.map((change) => change.path).join(', ');
    errors.push(
      `adopt-step cannot adopt pre-existing changes in versioned Codex memory/config: ${paths}. ` +
      'These files are written only by Codex finalization; clean them up or resync before adopting manual project changes.'
    );
  }

  const stability = evaluateStabilitySafetyGate(targetRoot, { git, changes: commitWorthyChanges });
  errors.push(...stability.errors);
  warnings.push(...stability.warnings);

  let checks = null;
  if (errors.length === 0) {
    checks = runRequiredChecks(targetRoot, {
      extraCommands: options.checkCommands || [],
      checkTimeoutMs: options.checkTimeoutMs
    });
    errors.push(...checks.errors);
    warnings.push(...checks.warnings);
  }

  return gateResult(errors.length === 0, errors, warnings, {
    git,
    state,
    currentStep,
    commitWorthyChanges,
    protectedCodexMemoryChanges,
    stability,
    checks
  });
}

function evaluateApplyGate(targetRoot) {
  const validation = validateWorkflowState(targetRoot);
  const errors = [...validation.errors];
  const warnings = [...validation.warnings];
  const git = getGitState(targetRoot);

  if (!git.ok) {
    errors.push(git.error);
    return gateResult(false, errors, warnings, {
      validation,
      git
    });
  }

  const state = validation.details.state;
  const currentStep = validation.details.currentStep;
  const nextStepId = validation.details.nextStepId;

  if (!currentStep.exists || !currentStep.active) {
    errors.push('No active step.');
  } else {
    if (currentStep.stepId !== nextStepId) {
      errors.push(`Active step id ${currentStep.stepId || 'unknown'} does not match next step id ${nextStepId}.`);
    }

    if (!currentStep.baseRevision || currentStep.baseRevision === 'none') {
      errors.push('Active step base revision is missing or uninitialized.');
    } else if (currentStep.baseRevision !== git.revision) {
      errors.push('Current git revision does not match the active step base revision.');
    }

    if (!currentStep.baseBranch || currentStep.baseBranch === 'none') {
      errors.push('Active step base branch is missing or uninitialized.');
    } else if (currentStep.baseBranch !== git.branch) {
      errors.push('Current git branch does not match the active step base branch.');
    }
  }

  if (state.exists && state.fields['Discussion Mode'] === 'active') {
    errors.push('Discussion mode is active.');
  }

  if (state.exists && isInitializedState(state.fields) && currentStep.active) {
    if (state.fields['Last Known Revision'] !== currentStep.baseRevision) {
      errors.push('Active step base revision does not match .codex/state.md.');
    }
    if (state.fields['Last Known Branch'] !== currentStep.baseBranch) {
      errors.push('Active step base branch does not match .codex/state.md.');
    }
  }

  return gateResult(errors.length === 0, errors, warnings, {
    validation,
    git,
    state,
    currentStep,
    nextStepId
  });
}

function evaluateApplyPreflight(targetRoot) {
  const applyGate = evaluateApplyGate(targetRoot);
  const commitPlan = buildApplyCommitPlan(targetRoot);
  const stability = evaluateStabilitySafetyGate(targetRoot);
  const errors = [...applyGate.errors, ...commitPlan.errors, ...stability.errors];
  const warnings = [...applyGate.warnings, ...commitPlan.warnings, ...stability.warnings];

  return gateResult(errors.length === 0, errors, warnings, {
    applyGate,
    commitPlan,
    stability
  });
}

function evaluateStabilitySafetyGate(targetRoot, options = {}) {
  const errors = [];
  const warnings = [];
  const git = options.git || getGitState(targetRoot);
  if (!git.ok) {
    return gateResult(false, [git.error], warnings, { git });
  }

  const changes = Array.isArray(options.changes)
    ? options.changes
    : git.changes.filter((change) => !isTransientRuntimePath(change.path));
  const sensitiveChanges = changes.filter((change) => isStabilitySensitivePath(change.path));

  if (sensitiveChanges.length === 0) {
    return gateResult(true, errors, warnings, { git, changes, sensitiveChanges });
  }

  warnings.push('Stability-sensitive workflow files changed; machine guardrails were applied.');

  validateRuleAnchors(targetRoot, errors);
  validateWorkflowCommandSurface(targetRoot, errors);
  validateGitignoreRuntimeEntries(targetRoot, errors);
  validateOverrideFiles(targetRoot, errors);

  return gateResult(errors.length === 0, errors, warnings, {
    git,
    changes,
    sensitiveChanges
  });
}

function validateWorkflowState(targetRoot) {
  const errors = [];
  const warnings = [];
  const state = readCodexState(targetRoot);
  const currentStep = readCurrentStep(targetRoot);
  const stepIds = calculateNextStepId(targetRoot);

  if (!state.exists) {
    errors.push('.codex/state.md is missing.');
  } else {
    for (const field of REQUIRED_STATE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(state.fields, field)) {
        errors.push(`.codex/state.md is missing required field: ${field}.`);
      }
    }

    if (state.fields['Sync Backend'] && state.fields['Sync Backend'] !== 'git') {
      errors.push('.codex/state.md Sync Backend must be git.');
    }
    if (state.fields['Strict Mode'] && !['true', 'false'].includes(state.fields['Strict Mode'])) {
      errors.push('.codex/state.md Strict Mode must be true or false.');
    }
    if (state.fields['Discussion Mode'] && !['none', 'active'].includes(state.fields['Discussion Mode'])) {
      errors.push('.codex/state.md Discussion Mode must be none or active.');
    }
  }

  errors.push(...validateCurrentStepShape(currentStep));
  errors.push(...stepIds.errors);
  warnings.push(...stepIds.warnings);

  if (currentStep.active && stepIds.ok && currentStep.stepId !== stepIds.nextStepId) {
    errors.push(`Active step id ${currentStep.stepId || 'unknown'} does not match next step id ${stepIds.nextStepId}.`);
  }

  return gateResult(errors.length === 0, errors, warnings, {
    state,
    currentStep,
    nextStepId: stepIds.nextStepId,
    historyStepIds: stepIds.historyStepIds,
    reportStepIds: stepIds.reportStepIds
  });
}

function calculateNextStepId(targetRoot) {
  const errors = [];
  const warnings = [];
  const historyStepIds = [];
  const reportStepIds = [];
  const duplicateHistoryIds = new Set();
  const seenHistoryIds = new Set();
  const historyPath = path.join(targetRoot, '.codex/history.md');
  const reportsDir = path.join(targetRoot, '.codex/reports');

  if (!fs.existsSync(historyPath)) {
    errors.push('.codex/history.md is missing.');
  } else {
    const history = fs.readFileSync(historyPath, 'utf8');
    const re = /^## Step ([1-9][0-9]*)$/gm;
    let match;
    while ((match = re.exec(history)) !== null) {
      const id = Number(match[1]);
      if (seenHistoryIds.has(id)) {
        duplicateHistoryIds.add(id);
      }
      seenHistoryIds.add(id);
      historyStepIds.push(id);
    }
  }

  for (const id of duplicateHistoryIds) {
    errors.push(`.codex/history.md contains duplicate Step ${id}.`);
  }

  if (!fs.existsSync(reportsDir)) {
    errors.push('.codex/reports/ is missing.');
  } else if (!fs.statSync(reportsDir).isDirectory()) {
    errors.push('.codex/reports/ is not a directory.');
  } else {
    for (const entry of fs.readdirSync(reportsDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        warnings.push(`.codex/reports/${entry.name} is not a completed-step report file.`);
        continue;
      }

      const match = entry.name.match(/^([1-9][0-9]*)\.md$/);
      if (!match) {
        warnings.push(`.codex/reports/${entry.name} is not a numeric completed-step report.`);
        continue;
      }

      reportStepIds.push(Number(match[1]));
    }
  }

  const maxId = Math.max(0, ...historyStepIds, ...reportStepIds);
  const nextStepId = maxId + 1;
  const nextReportPath = path.join(reportsDir, `${nextStepId}.md`);
  if (fs.existsSync(nextReportPath)) {
    errors.push(`.codex/reports/${nextStepId}.md already exists.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    nextStepId,
    historyStepIds,
    reportStepIds
  };
}

function buildCommitPlan(targetRoot, options = {}) {
  const errors = [];
  const warnings = [];
  const git = getGitState(targetRoot);
  if (!git.ok) {
    return gateResult(false, [git.error], warnings, { git });
  }

  const currentStep = readCurrentStep(targetRoot);
  const included = [];
  const excludedTransient = [];
  const blocked = [];

  for (const change of git.changes) {
    if (isTransientRuntimePath(change.path)) {
      excludedTransient.push(change);
      continue;
    }

    if (change.path === '.codex/current-step.md' && currentStep.active && options.allowActiveCurrentStep !== true) {
      blocked.push({
        ...change,
        reason: '.codex/current-step.md contains an active step and must not be committed.'
      });
      continue;
    }

    included.push(change);
  }

  if (blocked.length > 0) {
    errors.push('Commit plan contains blocked paths.');
  }

  if (options.requireCommitWorthy === true && included.length === 0) {
    errors.push('No commit-worthy changes after excluding transient runtime state.');
  } else if (included.length === 0) {
    warnings.push('No commit-worthy changes after excluding transient runtime state.');
  }

  return gateResult(errors.length === 0, errors, warnings, {
    git,
    currentStep,
    included,
    excludedTransient,
    blocked
  });
}

function buildApplyCommitPlan(targetRoot) {
  const errors = [];
  const warnings = [];
  const git = getGitState(targetRoot);
  if (!git.ok) {
    return gateResult(false, [git.error], warnings, { git });
  }

  const currentStep = readCurrentStep(targetRoot);
  const included = [];
  const excludedTransient = [];
  const pendingFinalization = [];

  for (const change of git.changes) {
    if (isTransientRuntimePath(change.path)) {
      excludedTransient.push(change);
      continue;
    }

    if (change.path === '.codex/current-step.md' && currentStep.active) {
      pendingFinalization.push({
        ...change,
        reason: '.codex/current-step.md must be rewritten to inactive final state before commit.'
      });
      continue;
    }

    included.push(change);
  }

  if (included.length === 0) {
    warnings.push('No current project changes; completed-step metadata must provide the commit-worthy payload.');
  }

  return gateResult(errors.length === 0, errors, warnings, {
    git,
    currentStep,
    included,
    excludedTransient,
    pendingFinalization
  });
}

function resyncState(targetRoot) {
  const gate = evaluateResyncGate(targetRoot);
  if (!gate.ok) {
    return gate;
  }

  const state = readCodexState(targetRoot);
  const git = gate.details.git;
  const fields = {
    'Sync Backend': 'git',
    'Last Known Revision': git.revision,
    'Last Known Branch': git.branch,
    'Last Sync Source': 'resync',
    'Strict Mode': state.fields['Strict Mode'] || 'true',
    'Discussion Mode': state.fields['Discussion Mode'] || 'none'
  };
  writeCodexState(targetRoot, fields);

  return gateResult(true, [], gate.warnings, {
    git,
    state: readCodexState(targetRoot)
  });
}

function startStep(targetRoot, task) {
  if (typeof task !== 'string' || task.trim().length === 0) {
    return gateResult(false, ['Task is empty.'], [], {});
  }

  const gate = evaluateStartStepGate(targetRoot);
  if (!gate.ok) {
    return gate;
  }

  const stepId = gate.details.result1.nextStepId;
  const git = gate.details.result2.git;
  const content = `# Current Step

Status: active
Step ID: ${stepId}

Task:
${task.trim()}

Base Sync:
Backend: git
Base Revision: ${git.revision}
Base Branch: ${git.branch}

Decisions:
none

Open Questions:
none

Working Notes:
none
`;

  fs.writeFileSync(path.join(targetRoot, '.codex/current-step.md'), content, 'utf8');

  return gateResult(true, [], gate.warnings, {
    stepId,
    baseRevision: git.revision,
    baseBranch: git.branch
  });
}

function startRecommendedStep(targetRoot) {
  const gate = evaluateStartStepGate(targetRoot);
  if (!gate.ok) {
    return gate;
  }

  const nextStep = readNextStepRecommendation(targetRoot);
  if (!nextStep.ok) {
    return nextStep;
  }

  const started = startStep(targetRoot, nextStep.details.recommendation);
  if (!started.ok) {
    return started;
  }

  return gateResult(true, [], [...nextStep.warnings, ...started.warnings], {
    ...started.details,
    recommendedStep: nextStep.details.recommendation,
    source: '.codex/next-step.md'
  });
}

function setGoal(targetRoot, description, options = {}) {
  const gate = evaluateGoalGate(targetRoot, description);
  if (!gate.ok) {
    return gate;
  }

  const goal = gate.details.normalizedDescription;
  const existingGoal = readGoal(targetRoot);
  if (existingGoal.ok && existingGoal.details.exists && existingGoal.details.goal === goal) {
    const finalGit = getGitState(targetRoot);
    if (!finalGit.ok) {
      return gateResult(false, [finalGit.error], gate.warnings, {
        gate,
        existingGoal,
        finalGit
      });
    }

    const currentStep = readCurrentStep(targetRoot);
    return gateResult(true, [], gate.warnings, {
      goal,
      updatedDate: existingGoal.details.updatedDate,
      path: '.codex/goal.md',
      changed: false,
      unchanged: true,
      commit: null,
      message: null,
      runtimeStateUpdated: false,
      stability: null,
      currentStep,
      finalGit
    });
  }

  const updatedDate = normalizeGoalDate(options.updatedDate) || currentIsoDate();
  const goalContent = buildGoalContent(goal, updatedDate);
  const snapshot = capturePathSnapshot(targetRoot, [
    '.codex/goal.md',
    '.codex/state.md'
  ]);

  fs.mkdirSync(path.join(targetRoot, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, '.codex/goal.md'), goalContent, 'utf8');

  const stability = evaluateStabilitySafetyGate(targetRoot);
  if (!stability.ok) {
    restorePathSnapshot(snapshot);
    return stability;
  }

  const commitPlan = buildCommitPlan(targetRoot);
  if (!commitPlan.ok) {
    restorePathSnapshot(snapshot);
    return commitPlan;
  }

  const unexpectedChanges = commitPlan.details.included
    .filter((change) => change.path !== '.codex/goal.md');
  if (unexpectedChanges.length > 0) {
    restorePathSnapshot(snapshot);
    const paths = unexpectedChanges.map((change) => change.path).join(', ');
    return gateResult(false, [`goal produced unexpected commit-worthy changes: ${paths}.`], [...gate.warnings, ...stability.warnings], {
      gate,
      stability,
      commitPlan
    });
  }

  let commit = null;
  let message = null;
  let runtimeStateUpdated = false;
  let changed = commitPlan.details.included.length > 0;

  if (changed) {
    const add = runGit(targetRoot, ['add', '--', '.codex/goal.md']);
    if (add.status !== 0) {
      restorePathSnapshot(snapshot);
      return gateResult(false, [`git add failed.${formatCommandFailure(add)}`], [...gate.warnings, ...stability.warnings], {
        gate,
        stability,
        commitPlan
      });
    }

    message = 'chore: set project goal';
    const result = runGit(targetRoot, ['commit', '-m', message]);
    if (result.status !== 0) {
      runGit(targetRoot, ['reset', '-q', '--mixed']);
      restorePathSnapshot(snapshot);
      return gateResult(false, [`git commit failed.${formatCommandFailure(result)}`], [...gate.warnings, ...stability.warnings], {
        gate,
        stability,
        commitPlan
      });
    }

    commit = runGit(targetRoot, ['rev-parse', 'HEAD']).stdout.trim();
    const branch = runGit(targetRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
    if (!isGitTracked(targetRoot, '.codex/state.md')) {
      const state = readCodexState(targetRoot);
      writeCodexState(targetRoot, {
        'Sync Backend': 'git',
        'Last Known Revision': commit,
        'Last Known Branch': branch,
        'Last Sync Source': 'goal',
        'Strict Mode': state.fields['Strict Mode'] || 'true',
        'Discussion Mode': state.fields['Discussion Mode'] || 'none'
      });
      runtimeStateUpdated = true;
    }
  }

  const finalGit = getGitState(targetRoot);
  if (!finalGit.ok) {
    return gateResult(false, [finalGit.error], [...gate.warnings, ...stability.warnings], {
      gate,
      stability,
      finalGit,
      commit,
      message
    });
  }
  if (finalGit.changes.length > 0) {
    return gateResult(false, [
      `goal did not leave a clean git tree: ${finalGit.changes.map((change) => change.path).join(', ')}.`
    ], [...gate.warnings, ...stability.warnings], {
      gate,
      stability,
      finalGit,
      commit,
      message
    });
  }

  const currentStep = readCurrentStep(targetRoot);
  if (currentStep.active) {
    return gateResult(false, ['goal left an active step unexpectedly.'], [...gate.warnings, ...stability.warnings], {
      gate,
      stability,
      currentStep,
      finalGit
    });
  }

  return gateResult(true, [], [...gate.warnings, ...stability.warnings], {
    goal,
    updatedDate,
    path: '.codex/goal.md',
    changed,
    unchanged: false,
    commit,
    message,
    runtimeStateUpdated,
    stability,
    currentStep,
    finalGit
  });
}

function recordDecision(targetRoot, id, description) {
  const errors = [];
  if (!isValidDecisionId(id)) {
    errors.push('record id is invalid.');
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    errors.push('record description is empty.');
  }

  const currentStep = readCurrentStep(targetRoot);
  if (!currentStep.active) {
    errors.push('No active step.');
  }

  if (errors.length > 0) {
    return gateResult(false, errors, [], { currentStep });
  }

  const nextContent = upsertDecision(currentStep.content, id, description.trim());
  fs.writeFileSync(path.join(targetRoot, '.codex/current-step.md'), nextContent, 'utf8');

  return gateResult(true, [], [], {
    id,
    description: description.trim()
  });
}

function discardActiveStep(targetRoot) {
  const errors = [];
  const warnings = [];
  const currentStep = readCurrentStep(targetRoot);
  if (!currentStep.active) {
    return gateResult(false, ['No active step.'], warnings, { currentStep });
  }
  if (!currentStep.stepId) {
    errors.push('.codex/current-step.md active step is missing a valid Step ID.');
  }

  const stepIds = calculateNextStepId(targetRoot);
  errors.push(...stepIds.errors);
  warnings.push(...stepIds.warnings);

  const git = getGitState(targetRoot);
  if (!git.ok) {
    errors.push(git.error);
  }

  const blockingChanges = git.ok
    ? git.changes.filter((change) => {
      return change.path !== '.codex/current-step.md';
    })
    : [];

  if (blockingChanges.length > 0) {
    const paths = blockingChanges.map((change) => change.path).join(', ');
    errors.push(`discard-step cannot run while project changes are present: ${paths}.`);
  }

  if (errors.length > 0) {
    return gateResult(false, errors, warnings, {
      currentStep,
      git,
      blockingChanges,
      nextStepId: stepIds.nextStepId
    });
  }

  const snapshot = captureFinalizationSnapshot(targetRoot, currentStep.stepId || stepIds.nextStepId);
  const lastCompletedStep = stepIds.nextStepId > 1 ? String(stepIds.nextStepId - 1) : 'none';
  fs.writeFileSync(path.join(targetRoot, '.codex/current-step.md'), `# Current Step

No active step.

Last completed step: ${lastCompletedStep}
`, 'utf8');

  const commitPlan = buildCommitPlan(targetRoot);
  if (!commitPlan.ok) {
    restoreFinalizationSnapshot(snapshot);
    return commitPlan;
  }

  const unexpectedChanges = commitPlan.details.included
    .filter((change) => change.path !== '.codex/current-step.md');
  if (unexpectedChanges.length > 0) {
    restoreFinalizationSnapshot(snapshot);
    const paths = unexpectedChanges.map((change) => change.path).join(', ');
    return gateResult(false, [`discard-step produced unexpected commit-worthy changes: ${paths}.`], warnings, {
      currentStep,
      git,
      commitPlan
    });
  }

  let commit = null;
  let message = null;
  let runtimeStateUpdated = false;
  if (commitPlan.details.included.length > 0) {
    const paths = commitPlan.details.included.map((change) => change.path);
    const add = runGit(targetRoot, ['add', '--', ...paths]);
    if (add.status !== 0) {
      restoreFinalizationSnapshot(snapshot);
      return gateResult(false, [`git add failed.${formatCommandFailure(add)}`], warnings, { commitPlan });
    }

    message = `chore: discard step ${currentStep.stepId}`;
    const result = runGit(targetRoot, ['commit', '-m', message]);
    if (result.status !== 0) {
      runGit(targetRoot, ['reset', '-q', '--mixed']);
      restoreFinalizationSnapshot(snapshot);
      return gateResult(false, [`git commit failed.${formatCommandFailure(result)}`], warnings, { commitPlan });
    }

    commit = runGit(targetRoot, ['rev-parse', 'HEAD']).stdout.trim();
    const branch = runGit(targetRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
    if (!isGitTracked(targetRoot, '.codex/state.md')) {
      const state = readCodexState(targetRoot);
      writeCodexState(targetRoot, {
        'Sync Backend': 'git',
        'Last Known Revision': commit,
        'Last Known Branch': branch,
        'Last Sync Source': `discard-step:${currentStep.stepId}`,
        'Strict Mode': state.fields['Strict Mode'] || 'true',
        'Discussion Mode': state.fields['Discussion Mode'] || 'none'
      });
      runtimeStateUpdated = true;
    }
  }

  const finalGit = getGitState(targetRoot);
  if (!finalGit.ok) {
    return gateResult(false, [finalGit.error], warnings, { finalGit });
  }
  if (finalGit.changes.length > 0) {
    return gateResult(false, [
      `discard-step did not leave a clean git tree: ${finalGit.changes.map((change) => change.path).join(', ')}.`
    ], warnings, {
      finalGit,
      commit,
      message
    });
  }

  return gateResult(true, [], warnings, {
    discardedStepId: currentStep.stepId,
    lastCompletedStep,
    commit,
    message,
    committed: Boolean(commit),
    runtimeStateUpdated,
    finalGit
  });
}

function finalizeStep(targetRoot, options = {}) {
  const preflight = evaluateApplyPreflight(targetRoot);
  if (!preflight.ok) {
    return preflight;
  }

  const payloadPlan = buildApplyCommitPlan(targetRoot);
  if (payloadPlan.details.included.length === 0) {
    return gateResult(false, [
      'No apply payload changes were found before finalization; refusing metadata-only step completion.'
    ], [...preflight.warnings, ...payloadPlan.warnings], {
      preflight,
      payloadPlan
    });
  }

  const checks = runRequiredChecks(targetRoot, {
    extraCommands: options.checkCommands || [],
    checkTimeoutMs: options.checkTimeoutMs
  });
  if (!checks.ok) {
    return gateResult(false, checks.errors, [...preflight.warnings, ...checks.warnings], {
      preflight,
      payloadPlan,
      checks
    });
  }

  const currentStep = preflight.details.applyGate.details.currentStep;
  const stepId = currentStep.stepId;
  const title = sanitizeTitle(options.title || firstTaskLine(currentStep.content) || `Step ${stepId}`);
  const summary = String(options.summary || 'Completed the requested step.').trim();
  const implementation = String(options.implementation || summary).trim();
  const nextStep = buildNextStepRecommendation({
    nextStep: options.nextStep,
    stepId,
    title
  });
  const decisions = extractDecisions(currentStep.content);
  const reportContent = buildReport({
    stepId,
    title,
    task: extractSection(currentStep.content, 'Task:', 'Base Sync:') || '',
    decisions,
    summary,
    implementation
  });

  const reportsDir = path.join(targetRoot, '.codex/reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `${stepId}.md`);
  if (fs.existsSync(reportPath)) {
    return gateResult(false, [`.codex/reports/${stepId}.md already exists.`], [], { stepId });
  }

  const snapshot = captureFinalizationSnapshot(targetRoot, stepId);
  fs.writeFileSync(reportPath, reportContent, 'utf8');
  fs.writeFileSync(path.join(targetRoot, '.codex/last-report.md'), reportContent, 'utf8');
  updateHistory(targetRoot, {
    stepId,
    title,
    sync: options.message || `pending commit for step ${stepId}`,
    summary
  });
  fs.writeFileSync(path.join(targetRoot, '.codex/current-step.md'), `# Current Step

No active step.

Last completed step: ${stepId}
`, 'utf8');
  fs.writeFileSync(path.join(targetRoot, '.codex/next-step.md'), buildNextStepContent(nextStep), 'utf8');

  const commitPlan = buildCommitPlan(targetRoot, { requireCommitWorthy: true });
  if (!commitPlan.ok) {
    restoreFinalizationSnapshot(snapshot);
    return commitPlan;
  }

  const paths = commitPlan.details.included.map((change) => change.path);
  const add = runGit(targetRoot, ['add', '--', ...paths]);
  if (add.status !== 0) {
    restoreFinalizationSnapshot(snapshot);
    return gateResult(false, [`git add failed.${formatCommandFailure(add)}`], [], { commitPlan });
  }

  const message = options.message || `chore: complete step ${stepId}`;
  const commit = runGit(targetRoot, ['commit', '-m', message]);
  if (commit.status !== 0) {
    runGit(targetRoot, ['reset', '-q', '--mixed']);
    restoreFinalizationSnapshot(snapshot);
    return gateResult(false, [`git commit failed.${formatCommandFailure(commit)}`], [], { commitPlan });
  }

  const revision = runGit(targetRoot, ['rev-parse', 'HEAD']).stdout.trim();
  const branch = runGit(targetRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const state = readCodexState(targetRoot);
  writeCodexState(targetRoot, {
    'Sync Backend': 'git',
    'Last Known Revision': revision,
    'Last Known Branch': branch,
    'Last Sync Source': `apply:${stepId}`,
    'Strict Mode': state.fields['Strict Mode'] || 'true',
    'Discussion Mode': state.fields['Discussion Mode'] || 'none'
  });

  return gateResult(true, [], [...preflight.warnings, ...checks.warnings], {
    stepId,
    title,
    commit: revision,
    message,
    report: `.codex/reports/${stepId}.md`,
    nextStep,
    checks: checks.details
  });
}

function finalizeAdoptStep(targetRoot, options = {}) {
  const validation = validateWorkflowState(targetRoot);
  if (!validation.ok) {
    return validation;
  }

  const gate = evaluateAdoptStepGate(targetRoot, options.title, {
    checkCommands: options.checkCommands || [],
    checkTimeoutMs: options.checkTimeoutMs
  });
  if (!gate.ok) {
    return gate;
  }

  const stepId = validation.details.nextStepId;
  const title = sanitizeTitle(options.title);
  const baseSummary = 'adopt-step accepted the user\'s manual working-tree diff as a completed Codex step.';
  const summary = options.summary
    ? `${baseSummary}\n\n${String(options.summary).trim()}`
    : baseSummary;
  const implementation = String(
    options.implementation || 'Adopted the manual working-tree diff as a completed Codex step.'
  ).trim();
  const nextStep = buildNextStepRecommendation({
    nextStep: options.nextStep,
    stepId,
    title,
    adopted: true
  });
  const reportContent = buildAdoptReport({
    stepId,
    title,
    summary,
    implementation
  });

  const reportsDir = path.join(targetRoot, '.codex/reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `${stepId}.md`);
  if (fs.existsSync(reportPath)) {
    return gateResult(false, [`.codex/reports/${stepId}.md already exists.`], [], { stepId });
  }

  const snapshot = captureFinalizationSnapshot(targetRoot, stepId);
  fs.writeFileSync(reportPath, reportContent, 'utf8');
  fs.writeFileSync(path.join(targetRoot, '.codex/last-report.md'), reportContent, 'utf8');
  updateHistory(targetRoot, {
    stepId,
    title,
    sync: options.message || `pending adopt-step commit for step ${stepId}`,
    summary
  });
  fs.writeFileSync(path.join(targetRoot, '.codex/current-step.md'), `# Current Step

No active step.

Last completed step: ${stepId}
`, 'utf8');
  fs.writeFileSync(path.join(targetRoot, '.codex/next-step.md'), buildNextStepContent(nextStep), 'utf8');

  const commitPlan = buildCommitPlan(targetRoot, { requireCommitWorthy: true });
  if (!commitPlan.ok) {
    restoreFinalizationSnapshot(snapshot);
    return commitPlan;
  }

  const paths = commitPlan.details.included.map((change) => change.path);
  const add = runGit(targetRoot, ['add', '--', ...paths]);
  if (add.status !== 0) {
    restoreFinalizationSnapshot(snapshot);
    return gateResult(false, [`git add failed.${formatCommandFailure(add)}`], [], { commitPlan });
  }

  const message = options.message || `chore: adopt manual step ${stepId}`;
  const commit = runGit(targetRoot, ['commit', '-m', message]);
  if (commit.status !== 0) {
    runGit(targetRoot, ['reset', '-q', '--mixed']);
    restoreFinalizationSnapshot(snapshot);
    return gateResult(false, [`git commit failed.${formatCommandFailure(commit)}`], [], { commitPlan });
  }

  const revision = runGit(targetRoot, ['rev-parse', 'HEAD']).stdout.trim();
  const branch = runGit(targetRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const state = readCodexState(targetRoot);
  writeCodexState(targetRoot, {
    'Sync Backend': 'git',
    'Last Known Revision': revision,
    'Last Known Branch': branch,
    'Last Sync Source': `adopt-step:${stepId}`,
    'Strict Mode': state.fields['Strict Mode'] || 'true',
    'Discussion Mode': state.fields['Discussion Mode'] || 'none'
  });

  return gateResult(true, [], gate.warnings, {
    stepId,
    title,
    commit: revision,
    message,
    report: `.codex/reports/${stepId}.md`,
    nextStep,
    adoptedChanges: gate.details.commitWorthyChanges,
    checks: gate.details.checks ? gate.details.checks.details : null
  });
}

function discoverRequiredChecks(targetRoot, options = {}) {
  const errors = [];
  const warnings = [];
  const commands = [];
  const packageJsonPath = path.join(targetRoot, 'package.json');

  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const scripts = packageJson && typeof packageJson.scripts === 'object' && packageJson.scripts
        ? packageJson.scripts
        : {};
      const checkScript = typeof scripts.check === 'string' ? scripts.check : '';

      for (const scriptName of CONVENTIONAL_CHECK_SCRIPTS) {
        if (typeof scripts[scriptName] !== 'string') {
          continue;
        }
        if (scriptName !== 'check' && checkScript && scriptMentionsScript(checkScript, scriptName)) {
          continue;
        }
        commands.push(scriptName === 'test' ? 'npm test' : `npm run ${scriptName}`);
      }
    } catch (error) {
      errors.push(`package.json could not be parsed for required checks: ${error.message}`);
    }
  }

  for (const command of options.extraCommands || []) {
    const normalized = String(command || '').trim();
    if (normalized.length > 0) {
      commands.push(normalized);
    }
  }

  return gateResult(errors.length === 0, errors, warnings, {
    commands: uniqueStrings(commands)
  });
}

function runRequiredChecks(targetRoot, options = {}) {
  const discovery = discoverRequiredChecks(targetRoot, options);
  const errors = [...discovery.errors];
  const warnings = [...discovery.warnings];
  const results = [];
  const checkTimeoutMs = resolveRequiredCheckTimeoutMs(options);

  if (!discovery.ok) {
    return gateResult(false, errors, warnings, {
      commands: discovery.details.commands || [],
      checkTimeoutMs,
      results
    });
  }

  const commands = discovery.details.commands;
  if (commands.length === 0) {
    warnings.push('No configured checks found.');
    return gateResult(true, errors, warnings, {
      commands,
      checkTimeoutMs,
      results
    });
  }

  for (const command of commands) {
    const result = runShellCommand(targetRoot, command, {
      timeoutMs: checkTimeoutMs
    });
    results.push(result);
    if (result.status !== 0) {
      if (result.timedOut) {
        errors.push(`Required check timed out after ${checkTimeoutMs} ms: ${command}.${formatCheckFailure(result)}`);
      } else {
        errors.push(`Required check failed: ${command}.${formatCheckFailure(result)}`);
      }
      break;
    }
  }

  return gateResult(errors.length === 0, errors, warnings, {
    commands,
    checkTimeoutMs,
    results
  });
}

function resolveRequiredCheckTimeoutMs(options = {}) {
  const rawValue = options.checkTimeoutMs
    || process.env.CODEX_FLOW_REQUIRED_CHECK_TIMEOUT_MS
    || process.env.CODEX_FLOW_CHECK_TIMEOUT_MS
    || DEFAULT_REQUIRED_CHECK_TIMEOUT_MS;
  const value = Number(rawValue);

  if (Number.isFinite(value) && value > 0) {
    return value;
  }

  return DEFAULT_REQUIRED_CHECK_TIMEOUT_MS;
}

function scriptMentionsScript(script, scriptName) {
  const escaped = escapeRegExp(scriptName);
  const patterns = [
    new RegExp(`\\bnpm\\s+(?:run\\s+)?${escaped}\\b`),
    new RegExp(`\\bpnpm\\s+(?:run\\s+)?${escaped}\\b`),
    new RegExp(`\\byarn\\s+(?:run\\s+)?${escaped}\\b`)
  ];
  return patterns.some((pattern) => pattern.test(script));
}

function runShellCommand(targetRoot, command, options = {}) {
  const rawTimeoutMs = Number(options.timeoutMs || DEFAULT_REQUIRED_CHECK_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeoutMs) && rawTimeoutMs > 0
    ? rawTimeoutMs
    : DEFAULT_REQUIRED_CHECK_TIMEOUT_MS;
  const result = spawnSync(command, {
    cwd: targetRoot,
    encoding: 'utf8',
    shell: true,
    timeout: timeoutMs
  });
  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');

  return {
    command,
    status: typeof result.status === 'number' ? result.status : 1,
    signal: result.signal || null,
    stdout: trimCommandOutput(result.stdout || ''),
    stderr: trimCommandOutput(result.stderr || ''),
    error: result.error ? result.error.message : null,
    timedOut,
    timeoutMs
  };
}

function trimCommandOutput(output) {
  const value = String(output || '').trim();
  const maxLength = 4000;
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, 1000)}\n...[truncated]...\n${value.slice(-3000)}`;
}

function formatCheckFailure(result) {
  const parts = [];
  if (result.error) {
    parts.push(result.error);
  }
  if (result.signal) {
    parts.push(`signal ${result.signal}`);
  }
  if (result.stderr) {
    parts.push(result.stderr);
  } else if (result.stdout) {
    parts.push(result.stdout);
  }
  return parts.length > 0 ? `\n${parts.join('\n')}` : '';
}

function extractDocumentedCommandFormats(content) {
  const formats = [];
  const re = /Formats?:\n\n```text\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(String(content || ''))) !== null) {
    for (const line of match[1].split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        formats.push(trimmed);
      }
    }
  }
  return formats;
}

function extractReadmeCommandList(content) {
  const match = String(content || '').match(/## Codex Chat Workflow Commands[\s\S]*?```text\n([\s\S]*?)```/);
  if (!match) {
    return [];
  }
  return match[1].split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function normalizeCommandFormat(format) {
  return format.replace(/<[^>]+>/g, '<arg>').replace(/"[^"]*"/g, '"arg"');
}

function isValidDecisionId(id) {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(id)
    && !id.includes('--')
    && !id.startsWith('-')
    && !id.endsWith('-');
}

function isValidBranchArgument(branchName) {
  return branchName.length > 0
    && !/\s/.test(branchName)
    && !/[;&|`$<>(){}[\]*?!~#'"\\]/.test(branchName);
}

function readCodexState(targetRoot) {
  const fullPath = path.join(targetRoot, '.codex/state.md');
  if (!fs.existsSync(fullPath)) {
    return { exists: false, fields: {} };
  }

  const fields = {};
  const content = fs.readFileSync(fullPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) {
      fields[match[1].trim()] = match[2].trim();
    }
  }
  return { exists: true, fields };
}

function writeCodexState(targetRoot, fields) {
  const lines = [
    '# Codex State',
    '',
    `Sync Backend: ${fields['Sync Backend'] || 'git'}`,
    `Last Known Revision: ${fields['Last Known Revision'] || 'none'}`,
    `Last Known Branch: ${fields['Last Known Branch'] || 'none'}`,
    `Last Sync Source: ${fields['Last Sync Source'] || 'none'}`,
    `Strict Mode: ${fields['Strict Mode'] || 'true'}`,
    `Discussion Mode: ${fields['Discussion Mode'] || 'none'}`,
    ''
  ];
  fs.mkdirSync(path.join(targetRoot, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, '.codex/state.md'), lines.join('\n'), 'utf8');
}

function getGitState(targetRoot) {
  const inside = runGit(targetRoot, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    return { ok: false, error: 'Git repository is unavailable.' };
  }

  const revision = runGit(targetRoot, ['rev-parse', 'HEAD']);
  if (revision.status !== 0) {
    return { ok: false, error: 'Git HEAD is unavailable.' };
  }

  const branch = runGit(targetRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.status !== 0) {
    return { ok: false, error: 'Git branch is unavailable.' };
  }

  const status = runGit(targetRoot, ['status', '--porcelain']);
  if (status.status !== 0) {
    return { ok: false, error: 'Git status is unavailable.' };
  }

  const changes = status.stdout.split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map(parseGitStatusLine);

  return {
    ok: true,
    revision: revision.stdout.trim(),
    branch: branch.stdout.trim(),
    changes
  };
}

function readCurrentStep(targetRoot) {
  const fullPath = path.join(targetRoot, '.codex/current-step.md');
  if (!fs.existsSync(fullPath)) {
    return { exists: false, active: false };
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  const stepIdMatch = content.match(/^Step ID:\s*([1-9][0-9]*)$/m);
  const baseRevisionMatch = content.match(/^Base Revision:\s*(.+)$/m);
  const baseBranchMatch = content.match(/^Base Branch:\s*(.+)$/m);
  const lastCompletedMatch = content.match(/^Last completed step:\s*(none|[1-9][0-9]*)$/m);

  return {
    exists: true,
    active: /^Status:\s*active$/m.test(content),
    inactive: /^No active step\.$/m.test(content),
    stepId: stepIdMatch ? Number(stepIdMatch[1]) : null,
    baseRevision: baseRevisionMatch ? baseRevisionMatch[1].trim() : null,
    baseBranch: baseBranchMatch ? baseBranchMatch[1].trim() : null,
    lastCompletedStep: lastCompletedMatch ? lastCompletedMatch[1] : null,
    content
  };
}

function validateCurrentStepShape(currentStep) {
  const errors = [];

  if (!currentStep.exists) {
    errors.push('.codex/current-step.md is missing.');
    return errors;
  }

  if (!/^# Current Step\s*$/m.test(currentStep.content)) {
    errors.push('.codex/current-step.md is missing the # Current Step heading.');
  }

  if (currentStep.active) {
    if (currentStep.inactive) {
      errors.push('.codex/current-step.md mixes active and inactive markers.');
    }
    if (!currentStep.stepId) {
      errors.push('.codex/current-step.md active step is missing a valid Step ID.');
    }
    if (!/^Base Sync:\s*$/m.test(currentStep.content)) {
      errors.push('.codex/current-step.md active step is missing Base Sync.');
    }
    if (!/^Backend:\s*git\s*$/m.test(currentStep.content)) {
      errors.push('.codex/current-step.md active step Base Sync backend must be git.');
    }
    if (!currentStep.baseRevision) {
      errors.push('.codex/current-step.md active step is missing Base Revision.');
    }
    if (!currentStep.baseBranch) {
      errors.push('.codex/current-step.md active step is missing Base Branch.');
    }
    if (!sectionHasContent(currentStep.content, 'Task:', 'Base Sync:')) {
      errors.push('.codex/current-step.md active step Task section is empty.');
    }
    for (const heading of ['Decisions:', 'Open Questions:', 'Working Notes:']) {
      if (!new RegExp(`^${escapeRegExp(heading)}\\s*$`, 'm').test(currentStep.content)) {
        errors.push(`.codex/current-step.md active step is missing ${heading}`);
      }
    }
    return errors;
  }

  if (!currentStep.inactive) {
    errors.push('.codex/current-step.md is neither active nor inactive.');
  }
  if (!currentStep.lastCompletedStep) {
    errors.push('.codex/current-step.md inactive state is missing Last completed step.');
  }

  return errors;
}

function sectionHasContent(content, startHeading, endHeading) {
  const start = content.indexOf(`${startHeading}\n`);
  if (start === -1) {
    return false;
  }

  const contentStart = start + startHeading.length + 1;
  const end = content.indexOf(`\n\n${endHeading}`, contentStart);
  const value = end === -1
    ? content.slice(contentStart)
    : content.slice(contentStart, end);
  return value.trim().length > 0;
}

function extractSection(content, startHeading, endHeading) {
  const start = content.indexOf(`${startHeading}\n`);
  if (start === -1) {
    return '';
  }

  const contentStart = start + startHeading.length + 1;
  const end = content.indexOf(`\n\n${endHeading}`, contentStart);
  const value = end === -1
    ? content.slice(contentStart)
    : content.slice(contentStart, end);
  return value.trim();
}

function firstTaskLine(content) {
  const task = extractSection(content, 'Task:', 'Base Sync:');
  return task.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function extractDecisions(content) {
  const decisions = extractSection(content, 'Decisions:', 'Open Questions:');
  if (!decisions || decisions === 'none') {
    return [];
  }

  return decisions.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^- ([a-z0-9][a-z0-9-]*):\s*(.*)$/);
      if (!match) {
        return { id: null, description: line.replace(/^- /, '') };
      }
      return { id: match[1], description: match[2] };
    });
}

function upsertDecision(content, id, description) {
  const startMarker = 'Decisions:\n';
  const endMarker = '\n\nOpen Questions:';
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start);
  if (start === -1 || end === -1) {
    return content;
  }

  const decisions = extractDecisions(content).filter((decision) => decision.id !== id);
  decisions.push({ id, description });
  const body = decisions.length === 0
    ? 'none'
    : decisions.map((decision) => `- ${decision.id}: ${decision.description}`).join('\n');

  return `${content.slice(0, start + startMarker.length)}${body}${content.slice(end)}`;
}

function sanitizeTitle(title) {
  return String(title || 'Completed step').trim().replace(/\s+/g, ' ').slice(0, 80) || 'Completed step';
}

function buildNextStepRecommendation({ nextStep, stepId, title, adopted = false }) {
  const explicit = normalizeRecommendation(nextStep);
  if (explicit) {
    return explicit;
  }

  const source = adopted ? 'adopted manual diff' : 'completed step';
  return `Review the ${source} in Step ${stepId} (${title}) and explicitly choose the next project task before starting it. This recommendation does not start a step automatically.`;
}

function buildNextStepContent(nextStep) {
  return `# Next Step

## Recommended Step

${nextStep}
`;
}

function buildGoalContent(goal, updatedDate) {
  return `# Goal

${goal}

Updated: ${updatedDate}

Rules:

- Long-term project objective.
- Used for prioritization and planning.
- Does not authorize changes by itself.
- Cannot override workflow safety rules.
`;
}

function readGoal(targetRoot) {
  const fullPath = path.join(targetRoot, '.codex/goal.md');
  if (!fs.existsSync(fullPath)) {
    return gateResult(true, [], [], {
      exists: false,
      goal: null,
      updatedDate: null,
      content: null
    });
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  const match = content.match(/^# Goal\s*\n\n([\s\S]*?)\n\nUpdated:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*$/m);
  if (!match) {
    return gateResult(false, ['.codex/goal.md does not match the expected goal format.'], [], {
      exists: true,
      goal: null,
      updatedDate: null,
      content
    });
  }

  return gateResult(true, [], [], {
    exists: true,
    goal: normalizeGoalDescription(match[1]),
    updatedDate: match[2],
    content
  });
}

function readPlanningContext(targetRoot) {
  const errors = [];
  const warnings = [];
  const goal = readGoal(targetRoot);
  errors.push(...goal.errors);
  warnings.push(...goal.warnings);

  const context = readOptionalProjectFile(targetRoot, '.codex/context.md');
  const history = readOptionalProjectFile(targetRoot, '.codex/history.md');
  errors.push(...context.errors, ...history.errors);
  warnings.push(...context.warnings, ...history.warnings);

  return gateResult(errors.length === 0, errors, warnings, {
    goal: goal.details,
    context: context.details,
    history: history.details
  });
}

function readOptionalProjectFile(targetRoot, relativePath) {
  const fullPath = path.join(targetRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    return gateResult(true, [], [`${relativePath} is missing.`], {
      path: relativePath,
      exists: false,
      content: null
    });
  }

  return gateResult(true, [], [], {
    path: relativePath,
    exists: true,
    content: fs.readFileSync(fullPath, 'utf8')
  });
}

function readNextStepRecommendation(targetRoot) {
  const fullPath = path.join(targetRoot, '.codex/next-step.md');
  if (!fs.existsSync(fullPath)) {
    return gateResult(false, ['.codex/next-step.md is missing.'], [], {});
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  const heading = content.match(/^## Recommended Step\s*$/m);
  if (!heading) {
    return gateResult(false, ['.codex/next-step.md is missing ## Recommended Step.'], [], {
      content
    });
  }

  const recommendation = normalizeRecommendation(content.slice(heading.index + heading[0].length));
  if (!isSubstantiveRecommendation(recommendation)) {
    return gateResult(false, [
      'No recommended next step has been recorded. Provide the next task prompt explicitly or run discuss to decide one.'
    ], [], {
      recommendation
    });
  }

  return gateResult(true, [], [], {
    recommendation,
    path: '.codex/next-step.md'
  });
}

function normalizeRecommendation(value) {
  const normalized = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return normalized.length > 0 ? normalized : null;
}

function normalizeGoalDescription(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeAskQuestion(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeGoalDate(value) {
  const normalized = String(value || '').trim();
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(normalized) ? normalized : null;
}

function currentIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function isSubstantiveRecommendation(value) {
  const normalized = normalizeRecommendation(value);
  return Boolean(normalized) && normalized !== 'No recommendation yet.';
}

function buildReport({ stepId, title, task, decisions, summary, implementation }) {
  const decisionsText = decisions.length === 0
    ? 'The step was completed directly from the task.'
    : decisions.map((decision) => `- ${decision.id}: ${decision.description}`).join('\n');

  return `# Step ${stepId}: ${title}

## Task

${task.trim()}

## Applied Decisions

${decisionsText}

## Reasoning

The step was finalized through the internal normal-flow helper after apply preflight and commit-plan checks passed.

## Implementation Summary

${implementation.trim()}

`;
}

function buildAdoptReport({ stepId, title, summary, implementation }) {
  return `# Step ${stepId}: ${title}

## Task

Adopted title: ${title}

The task was to adopt the user's manual working-tree diff as one completed Codex step.

## Applied Decisions

There were no recorded active-step decisions. This step adopted a pre-existing manual working-tree diff.

## Reasoning

The diff was manually authored and accepted through adopt-step. The report does not infer implementation reasoning beyond the inspected diff and user-provided title.

## Implementation Summary

${implementation.trim() || summary.trim()}

`;
}

function updateHistory(targetRoot, { stepId, title, sync, summary }) {
  const historyPath = path.join(targetRoot, '.codex/history.md');
  const entry = `## Step ${stepId}

Title:
${title}

Sync:
${sync}

Summary:
${summary}

Important Knowledge:
none

Report:
reports/${stepId}.md
`;

  let history = fs.existsSync(historyPath)
    ? fs.readFileSync(historyPath, 'utf8')
    : '# History\n\nNo completed steps.\n';
  history = history.replace(/\n?No completed steps\.\s*$/m, '').trimEnd();
  fs.writeFileSync(historyPath, `${history}\n\n${entry}`, 'utf8');
}

function captureFinalizationSnapshot(targetRoot, stepId) {
  const paths = [
    '.codex/current-step.md',
    '.codex/history.md',
    '.codex/last-report.md',
    '.codex/context.md',
    '.codex/next-step.md',
    '.codex/state.md',
    `.codex/reports/${stepId}.md`
  ];

  return {
    targetRoot,
    paths: paths.map((relativePath) => {
      const fullPath = path.join(targetRoot, relativePath);
      return {
        relativePath,
        exists: fs.existsSync(fullPath),
        content: fs.existsSync(fullPath) ? fs.readFileSync(fullPath) : null
      };
    })
  };
}

function capturePathSnapshot(targetRoot, paths) {
  return {
    targetRoot,
    paths: paths.map((relativePath) => {
      const fullPath = path.join(targetRoot, relativePath);
      return {
        relativePath,
        exists: fs.existsSync(fullPath),
        content: fs.existsSync(fullPath) ? fs.readFileSync(fullPath) : null
      };
    })
  };
}

function restoreFinalizationSnapshot(snapshot) {
  restorePathSnapshot(snapshot);
}

function restorePathSnapshot(snapshot) {
  for (const entry of snapshot.paths) {
    const fullPath = path.join(snapshot.targetRoot, entry.relativePath);
    if (!entry.exists) {
      if (fs.existsSync(fullPath)) {
        fs.rmSync(fullPath);
      }
      continue;
    }

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, entry.content);
  }
}

function validateRuleAnchors(targetRoot, errors) {
  for (const [relativePath, needle] of RULE_ANCHORS) {
    const fullPath = path.join(targetRoot, relativePath);
    if (!fs.existsSync(fullPath)) {
      errors.push(`${relativePath} is missing required workflow rule content.`);
      continue;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    if (!content.includes(needle)) {
      errors.push(`${relativePath} is missing invariant anchor: ${needle}`);
    }
  }
}

function validateWorkflowCommandSurface(targetRoot, errors) {
  const commandsPath = path.join(targetRoot, '.codex/core/commands.md');
  if (!fs.existsSync(commandsPath)) {
    return;
  }

  const coreFormats = extractDocumentedCommandFormats(fs.readFileSync(commandsPath, 'utf8'));
  const normalizedCore = new Set(coreFormats.map(normalizeCommandFormat));
  const normalizedExpected = new Set(COMMAND_FORMATS.map(normalizeCommandFormat));

  for (const expected of normalizedExpected) {
    if (!normalizedCore.has(expected)) {
      errors.push(`.codex/core/commands.md is missing command format: ${expected}`);
    }
  }

  for (const command of normalizedCore) {
    if (!normalizedExpected.has(command)) {
      errors.push(`.codex/core/commands.md documents unsupported workflow command: ${command}`);
    }
  }
}

function validateGitignoreRuntimeEntries(targetRoot, errors) {
  const gitignorePath = path.join(targetRoot, '.gitignore');
  const lines = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf8').split(/\r?\n/).map((line) => line.trim())
    : [];

  for (const entry of REQUIRED_GITIGNORE_ENTRIES) {
    if (!lines.includes(entry)) {
      errors.push(`.gitignore is missing required runtime ignore: ${entry}`);
    }
  }
}

function validateOverrideFiles(targetRoot, errors) {
  const overridesDir = path.join(targetRoot, '.codex/overrides');
  if (!fs.existsSync(overridesDir)) {
    return;
  }

  for (const entry of fs.readdirSync(overridesDir, { withFileTypes: true })) {
    const relativePath = `.codex/overrides/${entry.name}`;
    const fullPath = path.join(overridesDir, entry.name);

    if (!entry.isFile()) {
      errors.push(`${relativePath} is invalid; overrides must be supported .md files.`);
      continue;
    }

    if (!SUPPORTED_OVERRIDE_FILES.has(entry.name)) {
      errors.push(`${relativePath} is not a supported override file.`);
      continue;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    if (content.includes('#replace')) {
      errors.push(`${relativePath} contains #replace, which is not supported.`);
    }
  }
}

function isStabilitySensitivePath(relativePath) {
  return relativePath === 'AGENTS.md'
    || relativePath === '.gitignore'
    || relativePath.startsWith('.codex/core/')
    || relativePath.startsWith('.codex/overrides/');
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isInitializedState(fields) {
  return fields['Last Known Revision']
    && fields['Last Known Revision'] !== 'none'
    && fields['Last Known Branch']
    && fields['Last Known Branch'] !== 'none';
}

function isTransientRuntimePath(relativePath) {
  return relativePath === '.codex/state.md'
    || relativePath.startsWith('.codex/tmp/');
}

function isProtectedAdoptCodexMemoryPath(relativePath) {
  return PROTECTED_ADOPT_CODEX_MEMORY_PATHS.some((protectedPath) => {
    if (protectedPath.endsWith('/')) {
      return relativePath.startsWith(protectedPath);
    }
    return relativePath === protectedPath;
  });
}

function parseGitStatusLine(line) {
  const status = line.slice(0, 2);
  let rawPath = line.slice(3);
  if (rawPath.includes(' -> ')) {
    rawPath = rawPath.split(' -> ').pop();
  }
  return {
    status,
    path: rawPath
  };
}

function isGitTracked(targetRoot, relativePath) {
  return runGit(targetRoot, ['ls-files', '--error-unmatch', '--', relativePath]).status === 0;
}

function runGit(targetRoot, args) {
  return spawnSync('git', args, {
    cwd: targetRoot,
    encoding: 'utf8'
  });
}

function formatCommandFailure(result) {
  const detail = (result.stderr || result.stdout || '').trim();
  return detail ? `\n${detail}` : '';
}

function validCommand(command, params) {
  return { valid: true, command, params };
}

function invalidCommand(reason) {
  return { valid: false, reason };
}

function gateResult(ok, errors, warnings, details) {
  return { ok, errors, warnings, details };
}

function mergeGateResults(...results) {
  const errors = [];
  const warnings = [];
  const details = {};

  for (const [index, result] of results.entries()) {
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    details[`result${index + 1}`] = result.details;
  }

  return gateResult(errors.length === 0, errors, warnings, details);
}

module.exports = {
  COMMAND_FORMATS,
  REMOVED_COMMANDS,
  TRANSIENT_RUNTIME_PATHS,
  buildWorkflowStateFooter,
  buildCommitPlan,
  buildApplyCommitPlan,
  calculateNextStepId,
  evaluateGoalGate,
  evaluateAdoptStepGate,
  evaluateApplyGate,
  evaluateApplyPreflight,
  evaluateNormalStepGate,
  evaluateResyncGate,
  evaluateStartStepGate,
  evaluateStabilitySafetyGate,
  discardActiveStep,
  finalizeAdoptStep,
  finalizeStep,
  discoverRequiredChecks,
  extractDocumentedCommandFormats,
  extractReadmeCommandList,
  inspectAskContext,
  normalizeCommandFormat,
  parseWorkflowCommand,
  recordDecision,
  readGoal,
  readNextStepRecommendation,
  readPlanningContext,
  runRequiredChecks,
  resyncState,
  setGoal,
  startRecommendedStep,
  startStep,
  validateWorkflowState
};
