'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  COMMAND_FORMATS,
  REMOVED_COMMANDS,
  evaluateAdoptStepGate,
  evaluateNormalStepGate,
  evaluateResyncGate,
  extractDocumentedCommandFormats,
  extractReadmeCommandList,
  normalizeCommandFormat,
  parseRunStepsQueue,
  parseWorkflowCommand
} = require('../lib/workflow');

const packageRoot = path.resolve(__dirname, '..');
const cliPath = path.join(packageRoot, 'bin/codex-flow.js');

test('exact workflow command parser accepts only supported exact prompts', () => {
  const validPrompts = [
    'strict:true',
    'strict:false',
    'record:api-v2 "Use the v2 endpoint."',
    'forget:api-v2',
    'forget',
    'apply',
    'adopt-step "Adopt manual changes"',
    'status',
    'compare',
    'compare:feature/settings',
    'check',
    'check:deep',
    'details',
    'details:42',
    'ls-steps:3',
    'run-steps',
    'abort-steps',
    'resync'
  ];

  for (const prompt of validPrompts) {
    assert.equal(parseWorkflowCommand(prompt).valid, true, prompt);
  }

  const invalidPrompts = [
    ' status',
    'status now',
    'record:Api "Uppercase id"',
    'record:bad--id "Bad id"',
    'record:valid "   "',
    'adopt-step ""',
    'compare:bad;rm',
    'details:0',
    'ls-steps:0',
    'run-steps:auto',
    'commit',
    'apply\n'
  ];

  for (const prompt of invalidPrompts) {
    assert.equal(parseWorkflowCommand(prompt).valid, false, prompt);
  }
});

test('documented command surface stays aligned with executable parser expectations', () => {
  const commands = fs.readFileSync(path.join(packageRoot, '.codex/core/commands.md'), 'utf8');
  const readme = fs.readFileSync(path.join(packageRoot, 'README.md'), 'utf8');
  const coreFormats = new Set(extractDocumentedCommandFormats(commands).map(normalizeCommandFormat));
  const readmeCommands = new Set(extractReadmeCommandList(readme).map(normalizeCommandFormat));
  const expected = new Set(COMMAND_FORMATS.map(normalizeCommandFormat));

  assert.deepEqual(coreFormats, expected);
  assert.deepEqual(readmeCommands, expected);

  for (const removed of REMOVED_COMMANDS) {
    assert.equal(readmeCommands.has(removed), false, removed);
  }
});

test('run-steps queue parser accepts valid queues and rejects ambiguous grammar', () => {
  const valid = parseRunStepsQueue(`# Steps

No pending steps.

## Add compact mode

Task:
Add the compact mode setting.

---

## Cover compact mode
Task:
Add persistence tests.
`);

  assert.equal(valid.ok, true);
  assert.deepEqual(valid.items, [
    { title: 'Add compact mode', task: 'Add the compact mode setting.' },
    { title: 'Cover compact mode', task: 'Add persistence tests.' }
  ]);

  const duplicateTask = parseRunStepsQueue(`## Bad item

Task:
Do one thing.

Task:
Do another thing.
`);
  assert.equal(duplicateTask.ok, false);
  assert.match(duplicateTask.errors.join('\n'), /duplicate Task label/);

  const emptyTitle = parseRunStepsQueue(`##

Task:
Do something.
`);
  assert.equal(emptyTitle.ok, false);
  assert.match(emptyTitle.errors.join('\n'), /title is empty/);

  const contentAfterSeparator = parseRunStepsQueue(`## First

Task:
Do something.

---
Unexpected prose.
`);
  assert.equal(contentAfterSeparator.ok, false);
  assert.match(contentAfterSeparator.errors.join('\n'), /content after separator/);
});

test('init cancellation in non-git targets exits non-zero and leaves target unchanged', () => {
  const target = makeTempDir('codex-flow-nongit-');
  const result = runCli(['init', '--target', target], { input: '' });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /No changes/);
  assert.equal(fs.existsSync(path.join(target, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(target, '.codex')), false);
  assert.equal(fs.existsSync(path.join(target, '.git')), false);
});

test('init installs downstream workflow and doctor validates it', () => {
  const target = makeTempDir('codex-flow-init-');
  initGit(target);

  const init = runCli(['init', '--target', target]);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /Created AGENTS.md/);
  assert.equal(fs.existsSync(path.join(target, '.codex/state.md')), true);
  assert.equal(fs.existsSync(path.join(target, '.codex/reports')), true);

  const doctor = runCli(['doctor', '--target', target]);
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert.match(doctor.stdout, /OK: workflow invariants passed/);
});

test('update replaces package-owned files and preserves project-owned state', () => {
  const target = makeTempDir('codex-flow-update-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);

  fs.writeFileSync(path.join(target, '.codex/context.md'), '# Context\n\nSENTINEL context\n', 'utf8');
  fs.writeFileSync(path.join(target, '.codex/current-step.md'), '# Current Step\n\nSENTINEL current\n', 'utf8');
  fs.writeFileSync(path.join(target, '.codex/core/commands.md'), 'BROKEN CORE\n', 'utf8');

  const update = runCli(['update', '--target', target]);
  assert.equal(update.status, 0, update.stderr);

  assert.match(fs.readFileSync(path.join(target, '.codex/context.md'), 'utf8'), /SENTINEL context/);
  assert.match(fs.readFileSync(path.join(target, '.codex/current-step.md'), 'utf8'), /SENTINEL current/);
  assert.match(fs.readFileSync(path.join(target, '.codex/core/commands.md'), 'utf8'), /## Exact Match Rule/);
});

test('doctor rejects invalid overrides', () => {
  const target = makeTempDir('codex-flow-overrides-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);

  fs.mkdirSync(path.join(target, '.codex/overrides'), { recursive: true });
  fs.writeFileSync(path.join(target, '.codex/overrides/commands.md'), '#replace\n', 'utf8');
  fs.writeFileSync(path.join(target, '.codex/overrides/state.md'), '# Invalid\n', 'utf8');

  const doctor = runCli(['doctor', '--target', target]);
  assert.equal(doctor.status, 1);
  assert.match(doctor.stdout, /contains #replace/);
  assert.match(doctor.stdout, /not a supported override file/);
});

test('sync gate evaluators model resync, normal step, and adopt-step blocking states', () => {
  const target = makeTempDir('codex-flow-gates-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);

  const uninitializedNormalGate = evaluateNormalStepGate(target);
  assert.equal(uninitializedNormalGate.ok, false);
  assert.match(uninitializedNormalGate.errors.join('\n'), /uninitialized/);
  assert.doesNotMatch(uninitializedNormalGate.errors.join('\n'), /Current git revision/);
  assert.doesNotMatch(uninitializedNormalGate.errors.join('\n'), /Current git branch/);
  const uninitializedAdoptGate = evaluateAdoptStepGate(target, 'Adopt manual diff');
  assert.equal(uninitializedAdoptGate.ok, false);
  assert.match(uninitializedAdoptGate.errors.join('\n'), /uninitialized/);
  assert.doesNotMatch(uninitializedAdoptGate.errors.join('\n'), /Current git revision/);
  assert.doesNotMatch(uninitializedAdoptGate.errors.join('\n'), /Current git branch/);
  assert.equal(evaluateResyncGate(target).ok, true);

  writeInitializedState(target);
  assert.equal(evaluateNormalStepGate(target).ok, true);
  assert.equal(evaluateAdoptStepGate(target, 'Adopt manual diff').ok, false);
  assert.match(evaluateAdoptStepGate(target, 'Adopt manual diff').errors.join('\n'), /No commit-worthy/);

  fs.writeFileSync(path.join(target, 'manual.txt'), 'manual change\n', 'utf8');
  assert.equal(evaluateNormalStepGate(target).ok, false);
  assert.match(evaluateNormalStepGate(target).errors.join('\n'), /Pre-existing project changes/);
  assert.equal(evaluateResyncGate(target).ok, false);
  assert.match(evaluateResyncGate(target).errors.join('\n'), /dirty/);
  assert.equal(evaluateAdoptStepGate(target, 'Adopt manual diff').ok, true);

  fs.writeFileSync(path.join(target, '.codex/current-step.md'), `# Current Step

Status: active
Step ID: 1

Task:
Existing active step.
`, 'utf8');
  assert.equal(evaluateAdoptStepGate(target, 'Adopt manual diff').ok, false);
  assert.match(evaluateAdoptStepGate(target, 'Adopt manual diff').errors.join('\n'), /Active step already exists/);
});

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args, options = {}) {
  return run('node', [cliPath, ...args], {
    cwd: packageRoot,
    input: options.input
  });
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || packageRoot,
    encoding: 'utf8',
    input: options.input
  });
}

function initGit(target) {
  assert.equal(run('git', ['init', '-q'], { cwd: target }).status, 0);
  assert.equal(run('git', ['config', 'user.email', 'codex-flow-test@example.invalid'], { cwd: target }).status, 0);
  assert.equal(run('git', ['config', 'user.name', 'Codex Flow Test'], { cwd: target }).status, 0);
}

function commitVersionedInstall(target) {
  assert.equal(run('git', ['add', 'AGENTS.md', '.gitignore', '.codex'], { cwd: target }).status, 0);
  const commit = run('git', ['commit', '-m', 'chore: install codex flow'], { cwd: target });
  assert.equal(commit.status, 0, commit.stderr);
}

function writeInitializedState(target) {
  const revision = run('git', ['rev-parse', 'HEAD'], { cwd: target }).stdout.trim();
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target }).stdout.trim();
  fs.writeFileSync(path.join(target, '.codex/state.md'), `# Codex State

Sync Backend: git
Last Known Revision: ${revision}
Last Known Branch: ${branch}
Last Sync Source: resync
Strict Mode: true
Step Chain Mode: none
`, 'utf8');
}
