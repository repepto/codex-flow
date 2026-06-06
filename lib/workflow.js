'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const COMMAND_FORMATS = [
  'strict:true',
  'strict:false',
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

  let match = prompt.match(/^record:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?) "([^"]*)"$/);
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
    errors.push('No active step.');
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
      if (isTransientRuntimePath(change.path)) {
        return false;
      }
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

  const lastCompletedStep = stepIds.nextStepId > 1 ? String(stepIds.nextStepId - 1) : 'none';
  fs.writeFileSync(path.join(targetRoot, '.codex/current-step.md'), `# Current Step

No active step.

Last completed step: ${lastCompletedStep}
`, 'utf8');

  return gateResult(true, [], warnings, {
    discardedStepId: currentStep.stepId,
    lastCompletedStep
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
  fs.writeFileSync(path.join(targetRoot, '.codex/next-step.md'), `# Next Step

## Recommended Step

No recommendation yet.
`, 'utf8');

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
  fs.writeFileSync(path.join(targetRoot, '.codex/next-step.md'), `# Next Step

## Recommended Step

No recommendation yet.
`, 'utf8');

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
  const match = String(content || '').match(/## Commands[\s\S]*?```text\n([\s\S]*?)```/);
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

function restoreFinalizationSnapshot(snapshot) {
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
  buildCommitPlan,
  buildApplyCommitPlan,
  calculateNextStepId,
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
  normalizeCommandFormat,
  parseWorkflowCommand,
  recordDecision,
  runRequiredChecks,
  resyncState,
  startStep,
  validateWorkflowState
};
