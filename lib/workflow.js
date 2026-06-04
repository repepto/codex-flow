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
  'adopt-step "title"',
  'status',
  'compare',
  'compare:<branch-name>',
  'check',
  'check:deep',
  'details',
  'details:<id>',
  'ls-steps:<n>',
  'run-steps',
  'abort-steps',
  'resync'
];

const REMOVED_COMMANDS = [
  'commit',
  'commit "message"',
  'apply-only',
  'run-steps:auto'
];

const TRANSIENT_RUNTIME_PATHS = [
  '.codex/state.md',
  '.codex/checkpoints/',
  '.codex/tmp/'
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
    'discuss',
    'discuss:close',
    'forget',
    'apply',
    'status',
    'compare',
    'check',
    'check:deep',
    'details',
    'run-steps',
    'abort-steps',
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

function parseRunStepsQueue(content) {
  const errors = [];
  const items = [];
  const lines = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const firstHeadingIndex = lines.findIndex((line) => /^##(?:\s|$)/.test(line));

  if (firstHeadingIndex === -1) {
    return { ok: true, items, errors };
  }

  let index = firstHeadingIndex;
  let previousWasSeparator = false;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      index += 1;
      continue;
    }

    if (trimmed === '---') {
      if (previousWasSeparator) {
        errors.push(`Line ${index + 1}: ambiguous repeated separator.`);
      }
      previousWasSeparator = true;
      index += 1;
      continue;
    }

    previousWasSeparator = false;

    const heading = line.match(/^##(?:\s*(.*))$/);
    if (!heading) {
      errors.push(`Line ${index + 1}: content outside an executable item.`);
      index += 1;
      continue;
    }

    const title = heading[1].trim();
    if (title.length === 0) {
      errors.push(`Line ${index + 1}: executable item title is empty.`);
    }

    const itemStartLine = index + 1;
    index += 1;

    const itemLines = [];
    while (index < lines.length && !/^##(?:\s|$)/.test(lines[index])) {
      itemLines.push({ lineNumber: index + 1, value: lines[index] });
      index += 1;
    }

    const item = parseRunStepItem(title, itemStartLine, itemLines, errors);
    if (item) {
      items.push(item);
    }
  }

  return { ok: errors.length === 0, items, errors };
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

function evaluateAdoptStepGate(targetRoot, title) {
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
    if (state.fields['Step Chain Mode'] === 'active') {
      errors.push('run-steps chain is active.');
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

  return gateResult(errors.length === 0, errors, warnings, {
    git,
    state,
    currentStep,
    commitWorthyChanges
  });
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
  return {
    exists: true,
    active: /^Status:\s*active$/m.test(content),
    content
  };
}

function isInitializedState(fields) {
  return fields['Last Known Revision']
    && fields['Last Known Revision'] !== 'none'
    && fields['Last Known Branch']
    && fields['Last Known Branch'] !== 'none';
}

function isTransientRuntimePath(relativePath) {
  return relativePath === '.codex/state.md'
    || relativePath.startsWith('.codex/checkpoints/')
    || relativePath.startsWith('.codex/tmp/');
}

function parseRunStepItem(title, itemStartLine, itemLines, errors) {
  let taskLine = null;
  let separatorLine = null;
  const taskTextLines = [];

  for (const entry of itemLines) {
    const trimmed = entry.value.trim();

    if (trimmed === '---') {
      if (separatorLine !== null) {
        errors.push(`Line ${entry.lineNumber}: ambiguous repeated separator in item "${title || '<empty>'}".`);
      }
      separatorLine = entry.lineNumber;
      continue;
    }

    if (separatorLine !== null) {
      if (trimmed.length > 0) {
        errors.push(`Line ${entry.lineNumber}: content after separator before next item.`);
      }
      continue;
    }

    if (trimmed === 'Task:') {
      if (taskLine !== null) {
        errors.push(`Line ${entry.lineNumber}: duplicate Task label in item "${title || '<empty>'}".`);
      }
      taskLine = entry.lineNumber;
      continue;
    }

    if (taskLine === null) {
      if (trimmed.length > 0) {
        errors.push(`Line ${entry.lineNumber}: content before Task label in item "${title || '<empty>'}".`);
      }
      continue;
    }

    taskTextLines.push(entry.value);
  }

  if (taskLine === null) {
    errors.push(`Line ${itemStartLine}: item "${title || '<empty>'}" is missing a Task label.`);
    return null;
  }

  const task = taskTextLines.join('\n').trim();
  if (task.length === 0) {
    errors.push(`Line ${taskLine}: item "${title || '<empty>'}" has empty task text.`);
    return null;
  }

  if (title.length === 0) {
    return null;
  }

  return { title, task };
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

function validCommand(command, params) {
  return { valid: true, command, params };
}

function invalidCommand(reason) {
  return { valid: false, reason };
}

function gateResult(ok, errors, warnings, details) {
  return { ok, errors, warnings, details };
}

module.exports = {
  COMMAND_FORMATS,
  REMOVED_COMMANDS,
  TRANSIENT_RUNTIME_PATHS,
  evaluateAdoptStepGate,
  evaluateNormalStepGate,
  evaluateResyncGate,
  extractDocumentedCommandFormats,
  extractReadmeCommandList,
  normalizeCommandFormat,
  parseRunStepsQueue,
  parseWorkflowCommand
};
