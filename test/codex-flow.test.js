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
  parseInlineStepsPrompt,
  parseWorkflowCommand
} = require('../lib/workflow');

const packageRoot = path.resolve(__dirname, '..');
const cliPath = path.join(packageRoot, 'bin/codex-flow.js');

test('exact workflow command parser accepts only supported exact prompts', () => {
  const validPrompts = [
    'strict:true',
    'strict:false',
    'discuss',
    'discuss:close',
    'record:api-v2 "Use the v2 endpoint."',
    'forget:api-v2',
    'forget',
    'apply',
    'adopt-step "Adopt manual changes"',
    'help',
    'status',
    'compare',
    'compare:feature/settings',
    'check',
    'check:deep',
    'details',
    'details:42',
    'ls-steps:3',
    'abort-steps',
    'resync'
  ];

  for (const prompt of validPrompts) {
    assert.equal(parseWorkflowCommand(prompt).valid, true, prompt);
  }

  const invalidPrompts = [
    ' status',
    'help now',
    'status now',
    'record:Api "Uppercase id"',
    'record:bad--id "Bad id"',
    'record:valid "   "',
    'adopt-step ""',
    'compare:bad;rm',
    'details:0',
    'ls-steps:0',
    'run-steps',
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

test('inline multi-step prompt parser accepts explicit chains and rejects ambiguous grammar', () => {
  const valid = parseInlineStepsPrompt('steps: Add compact mode /-/ Cover compact mode');

  assert.equal(valid.ok, true);
  assert.equal(valid.matches, true);
  assert.deepEqual(valid.items, [
    { task: 'Add compact mode' },
    { task: 'Cover compact mode' }
  ]);

  const ordinaryPrompt = parseInlineStepsPrompt('Add compact mode /-/ Cover compact mode');
  assert.equal(ordinaryPrompt.ok, true);
  assert.equal(ordinaryPrompt.matches, false);
  assert.deepEqual(ordinaryPrompt.items, []);

  const missingSeparator = parseInlineStepsPrompt('steps: Add compact mode');
  assert.equal(missingSeparator.ok, false);
  assert.match(missingSeparator.errors.join('\n'), /exact delimiter/);

  const wrongSeparatorSpacing = parseInlineStepsPrompt('steps: Add compact mode/-/Cover compact mode');
  assert.equal(wrongSeparatorSpacing.ok, false);
  assert.match(wrongSeparatorSpacing.errors.join('\n'), /exact delimiter/);

  const emptyTask = parseInlineStepsPrompt('steps: Add compact mode /-/   ');
  assert.equal(emptyTask.ok, false);
  assert.match(emptyTask.errors.join('\n'), /task 2 is empty/);

  const multiline = parseInlineStepsPrompt('steps: Add compact mode /-/ Cover compact mode\n');
  assert.equal(multiline.ok, false);
  assert.match(multiline.errors.join('\n'), /single line/);
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
  assert.equal(fs.existsSync(path.join(target, '.codex/config.toml')), true);
  assert.equal(fs.existsSync(path.join(target, '.codex/state.md')), true);
  assert.equal(fs.existsSync(path.join(target, '.codex/reports')), true);
  assert.match(fs.readFileSync(path.join(target, '.codex/config.toml'), 'utf8'), /approval_policy = "never"/);
  assert.match(fs.readFileSync(path.join(target, '.codex/state.md'), 'utf8'), /Discussion Mode: none/);

  const doctor = runCli(['doctor', '--target', target]);
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert.match(doctor.stdout, /OK: workflow invariants passed/);
});

test('installed-project doctor does not validate the application README command list', () => {
  const target = makeTempDir('codex-flow-app-readme-');
  initGit(target);
  fs.writeFileSync(path.join(target, 'README.md'), '# App\n\nThis is normal project documentation.\n', 'utf8');

  const init = runCli(['init', '--target', target]);
  assert.equal(init.status, 0, init.stderr);

  const doctor = runCli(['doctor', '--target', target]);
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert.match(doctor.stdout, /Mode: installed project/);
  assert.match(doctor.stdout, /OK: workflow invariants passed/);
  assert.doesNotMatch(doctor.stdout, /README\.md command list is missing/);
});

test('update replaces package-owned files and preserves project-owned state', () => {
  const target = makeTempDir('codex-flow-update-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);

  fs.writeFileSync(path.join(target, '.codex/context.md'), '# Context\n\nSENTINEL context\n', 'utf8');
  fs.writeFileSync(path.join(target, '.codex/config.toml'), '# Project config\n\nSENTINEL config\n', 'utf8');
  fs.writeFileSync(path.join(target, '.codex/current-step.md'), '# Current Step\n\nSENTINEL current\n', 'utf8');
  fs.writeFileSync(path.join(target, '.codex/core/commands.md'), 'BROKEN CORE\n', 'utf8');
  fs.writeFileSync(path.join(target, '.codex/core/run-step-examples.md'), 'OBSOLETE CORE\n', 'utf8');

  const update = runCli(['update', '--target', target]);
  assert.equal(update.status, 0, update.stderr);

  assert.match(fs.readFileSync(path.join(target, '.codex/context.md'), 'utf8'), /SENTINEL context/);
  assert.match(fs.readFileSync(path.join(target, '.codex/config.toml'), 'utf8'), /SENTINEL config/);
  assert.match(fs.readFileSync(path.join(target, '.codex/current-step.md'), 'utf8'), /SENTINEL current/);
  assert.match(fs.readFileSync(path.join(target, '.codex/core/commands.md'), 'utf8'), /## Exact Match Rule/);
  assert.equal(fs.existsSync(path.join(target, '.codex/core/run-step-examples.md')), false);
});

test('update --commit validates and commits package-owned changes only', () => {
  const target = makeTempDir('codex-flow-update-commit-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);

  fs.writeFileSync(path.join(target, '.codex/context.md'), '# Context\n\nSENTINEL context\n', 'utf8');
  fs.writeFileSync(path.join(target, '.codex/core/commands.md'), 'BROKEN CORE\n', 'utf8');
  assert.equal(run('git', ['add', '.codex/context.md', '.codex/core/commands.md'], { cwd: target }).status, 0);
  assert.equal(run('git', ['commit', '-m', 'chore: simulate old workflow'], { cwd: target }).status, 0);

  const update = runCli(['update', '--commit', '--target', target]);
  assert.equal(update.status, 0, update.stdout + update.stderr);
  assert.match(update.stdout, /codex-flow doctor/);
  assert.match(update.stdout, /Created commit [a-f0-9]+: chore: update codex flow/);
  assert.match(fs.readFileSync(path.join(target, '.codex/context.md'), 'utf8'), /SENTINEL context/);
  assert.match(fs.readFileSync(path.join(target, '.codex/core/commands.md'), 'utf8'), /## Exact Match Rule/);
  assert.equal(run('git', ['log', '-1', '--format=%s'], { cwd: target }).stdout.trim(), 'chore: update codex flow');
  assert.equal(run('git', ['status', '--short'], { cwd: target }).stdout.trim(), '');
});

test('update --commit creates missing project config for legacy installs', () => {
  const target = makeTempDir('codex-flow-update-commit-config-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  fs.rmSync(path.join(target, '.codex/config.toml'));
  assert.equal(run('git', ['add', '.codex/config.toml'], { cwd: target }).status, 0);
  assert.equal(run('git', ['commit', '-m', 'chore: simulate legacy install'], { cwd: target }).status, 0);

  const update = runCli(['update', '--commit', '--target', target]);
  assert.equal(update.status, 0, update.stdout + update.stderr);
  assert.match(update.stdout, /Created .codex\/config.toml/);
  assert.match(update.stdout, /Created commit [a-f0-9]+: chore: update codex flow/);
  assert.match(fs.readFileSync(path.join(target, '.codex/config.toml'), 'utf8'), /approval_policy = "never"/);
  assert.equal(run('git', ['log', '-1', '--format=%s'], { cwd: target }).stdout.trim(), 'chore: update codex flow');
  assert.equal(run('git', ['status', '--short'], { cwd: target }).stdout.trim(), '');
});

test('update --commit rejects pre-existing dirty working trees', () => {
  const target = makeTempDir('codex-flow-update-commit-dirty-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  fs.writeFileSync(path.join(target, 'manual.txt'), 'manual change\n', 'utf8');

  const update = runCli(['update', '--commit', '--target', target]);
  assert.equal(update.status, 1);
  assert.match(update.stderr, /requires a clean git working tree/);
  assert.match(update.stderr, /manual.txt/);
  assert.equal(run('git', ['log', '-1', '--format=%s'], { cwd: target }).stdout.trim(), 'chore: install codex flow');
});

test('update --commit exits cleanly when there are no update changes', () => {
  const target = makeTempDir('codex-flow-update-commit-noop-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);

  const before = run('git', ['rev-parse', 'HEAD'], { cwd: target }).stdout.trim();
  const update = runCli(['update', '--commit', '--target', target]);
  const after = run('git', ['rev-parse', 'HEAD'], { cwd: target }).stdout.trim();

  assert.equal(update.status, 0, update.stdout + update.stderr);
  assert.match(update.stdout, /No update changes to commit/);
  assert.equal(after, before);
  assert.equal(run('git', ['status', '--short'], { cwd: target }).stdout.trim(), '');
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

  fs.appendFileSync(path.join(target, '.codex/state.md'), 'Discussion Mode: active\n', 'utf8');
  assert.equal(evaluateNormalStepGate(target).ok, false);
  assert.match(evaluateNormalStepGate(target).errors.join('\n'), /Discussion mode is active/);
  assert.equal(evaluateAdoptStepGate(target, 'Adopt manual diff').ok, false);
  assert.match(evaluateAdoptStepGate(target, 'Adopt manual diff').errors.join('\n'), /Discussion mode is active/);
  writeInitializedState(target);

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
Discussion Mode: none
`, 'utf8');
}
