'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const configuredCommandTimeoutMs = Number(process.env.CODEX_FLOW_TEST_COMMAND_TIMEOUT_MS || 30_000);
const TEST_COMMAND_TIMEOUT_MS = Number.isFinite(configuredCommandTimeoutMs) && configuredCommandTimeoutMs > 0
  ? configuredCommandTimeoutMs
  : 30_000;
const createdTempDirs = [];
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-flow-test-home-'));
const testGitTemplate = path.join(testHome, 'git-template');
const testXdgConfig = path.join(testHome, 'xdg-config');

createdTempDirs.push(testHome);
fs.mkdirSync(path.join(testGitTemplate, 'hooks'), { recursive: true });
fs.mkdirSync(testXdgConfig, { recursive: true });

Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_TEMPLATE_DIR: testGitTemplate,
  HOME: testHome,
  XDG_CONFIG_HOME: testXdgConfig
});

const {
  buildCommitPlan,
  calculateNextStepId,
  COMMAND_FORMATS,
  REMOVED_COMMANDS,
  discardActiveStep,
  evaluateAdoptStepGate,
  evaluateApplyGate,
  evaluateApplyPreflight,
  evaluateNormalStepGate,
  evaluateResyncGate,
  evaluateStartStepGate,
  evaluateStabilitySafetyGate,
  extractDocumentedCommandFormats,
  extractReadmeCommandList,
  finalizeAdoptStep,
  finalizeStep,
  normalizeCommandFormat,
  parseWorkflowCommand,
  recordDecision,
  resyncState,
  startStep,
  validateWorkflowState
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
    'discard-step',
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
    'abort-steps',
    'commit',
    'steps: Add compact mode /-/ Cover compact mode',
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

test('steps prompts are no longer special workflow commands', () => {
  const parsed = parseWorkflowCommand('steps: Add compact mode /-/ Cover compact mode');

  assert.equal(parsed.valid, false);
  assert.match(parsed.reason, /does not exactly match/);
});

test('test command helper fails fast when a subprocess exceeds its timeout', () => {
  assert.throws(
    () => run(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { timeout: 100 }),
    /Command failed while running tests:.*timeout_ms: 100.*ETIMEDOUT/s
  );
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

test('state validators compute next step id and validate active apply state', () => {
  const target = makeTempDir('codex-flow-state-validators-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  writeInitializedState(target);

  const initialStepId = calculateNextStepId(target);
  assert.equal(initialStepId.ok, true);
  assert.equal(initialStepId.nextStepId, 1);
  assert.equal(validateWorkflowState(target).ok, true);
  assert.equal(evaluateStartStepGate(target).ok, true);

  writeActiveStep(target, 1);
  const applyGate = evaluateApplyGate(target);
  assert.equal(applyGate.ok, true, applyGate.errors.join('\n'));
  assert.equal(evaluateApplyPreflight(target).ok, true);

  writeActiveStep(target, 9);
  const mismatchedApplyGate = evaluateApplyGate(target);
  assert.equal(mismatchedApplyGate.ok, false);
  assert.match(mismatchedApplyGate.errors.join('\n'), /does not match next step id 1/);
});

test('commit plan excludes transient state and blocks active current-step commits', () => {
  const target = makeTempDir('codex-flow-commit-plan-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  assert.equal(run('git', ['add', '-f', '.codex/state.md'], { cwd: target }).status, 0);
  assert.equal(run('git', ['commit', '-m', 'chore: track transient state for guardrail test'], { cwd: target }).status, 0);
  writeInitializedState(target);

  fs.writeFileSync(path.join(target, 'manual.txt'), 'manual change\n', 'utf8');
  writeActiveStep(target, 1);

  const plan = buildCommitPlan(target, { requireCommitWorthy: true });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join('\n'), /blocked paths/);
  assert.deepEqual(plan.details.included.map((change) => change.path), ['manual.txt']);
  assert.deepEqual(plan.details.excludedTransient.map((change) => change.path), ['.codex/state.md']);
  assert.deepEqual(plan.details.blocked.map((change) => change.path), ['.codex/current-step.md']);
});

test('internal CLI exposes JSON guardrails without changing public help', () => {
  const target = makeTempDir('codex-flow-internal-cli-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  writeInitializedState(target);

  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /internal/);

  const parse = runCli(['internal', 'parse-command', '--prompt', 'apply', '--target', target]);
  assert.equal(parse.status, 0, parse.stderr);
  assert.equal(JSON.parse(parse.stdout).command, 'apply');

  const next = runCli(['internal', 'next-step-id', '--target', target]);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).nextStepId, 1);

  const preflightWithoutStep = runCli(['internal', 'preflight', 'apply', '--target', target]);
  assert.equal(preflightWithoutStep.status, 1);
  assert.match(JSON.parse(preflightWithoutStep.stdout).errors.join('\n'), /No active step/);

  const startGate = runCli(['internal', 'gate', 'start-step', '--target', target]);
  assert.equal(startGate.status, 0, startGate.stdout + startGate.stderr);
  assert.equal(JSON.parse(startGate.stdout).ok, true);

  fs.writeFileSync(path.join(target, 'manual.txt'), 'manual change\n', 'utf8');
  const dirtyStartGate = runCli(['internal', 'gate', 'start-step', '--target', target]);
  assert.equal(dirtyStartGate.status, 1);
  assert.match(JSON.parse(dirtyStartGate.stdout).errors.join('\n'), /Pre-existing project changes/);

  const adoptGate = runCli(['internal', 'gate', 'adopt-step', '--title', 'Adopt manual diff', '--target', target]);
  assert.equal(adoptGate.status, 0, adoptGate.stdout + adoptGate.stderr);
  assert.equal(JSON.parse(adoptGate.stdout).ok, true);
});

test('internal normal flow runs resync, task, record, apply finalization, report, and clean state', () => {
  const target = makeTempDir('codex-flow-normal-flow-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);

  let result = runCli(['internal', 'state', 'resync', '--target', target]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).details.state.fields['Last Sync Source'], 'resync');

  result = runCli(['internal', 'state', 'start-step', '--prompt', 'Add hello file', '--target', target]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).details.stepId, 1);

  result = runCli([
    'internal',
    'state',
    'record',
    '--id',
    'hello-file',
    '--description',
    'Create a small hello.txt fixture.',
    '--target',
    target
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  fs.writeFileSync(path.join(target, 'hello.txt'), 'hello\n', 'utf8');

  result = runCli(['internal', 'preflight', 'apply', '--target', target]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).details.commitPlan.details.included.map((change) => change.path), ['hello.txt']);

  result = runCli([
    'internal',
    'state',
    'finalize-step',
    '--title',
    'Add hello file',
    '--summary',
    'Added a hello fixture.',
    '--implementation',
    'Added hello.txt and recorded the completed step metadata.',
    '--next-step',
    'Add coverage for hello fixture consumers before changing the fixture again.',
    '--message',
    'chore: add hello file',
    '--target',
    target
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const finalization = JSON.parse(result.stdout);
  assert.equal(finalization.details.stepId, 1);
  assert.match(finalization.details.commit, /^[a-f0-9]{40}$/);
  assert.equal(
    finalization.details.nextStep,
    'Add coverage for hello fixture consumers before changing the fixture again.'
  );

  assert.equal(fs.existsSync(path.join(target, '.codex/reports/1.md')), true);
  assert.match(fs.readFileSync(path.join(target, '.codex/history.md'), 'utf8'), /## Step 1/);
  assert.match(fs.readFileSync(path.join(target, '.codex/current-step.md'), 'utf8'), /No active step/);
  assert.match(
    fs.readFileSync(path.join(target, '.codex/next-step.md'), 'utf8'),
    /Add coverage for hello fixture consumers before changing the fixture again\./
  );
  assert.doesNotMatch(fs.readFileSync(path.join(target, '.codex/next-step.md'), 'utf8'), /No recommendation yet/);
  assert.match(fs.readFileSync(path.join(target, '.codex/state.md'), 'utf8'), /Last Sync Source: apply:1/);
  assert.equal(run('git', ['status', '--short'], { cwd: target }).stdout.trim(), '');
  assert.equal(run('git', ['log', '-1', '--format=%s'], { cwd: target }).stdout.trim(), 'chore: add hello file');
});

test('discard-step finalizes active state, leaves a clean tree, and allows resync', () => {
  const target = makeTempDir('codex-flow-discard-step-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  assert.equal(runCli(['internal', 'state', 'resync', '--target', target]).status, 0);
  fs.writeFileSync(path.join(target, '.codex/history.md'), `# History

## Step 1

Title:
Seed completed step

Sync:
seed commit

Summary:
Seeded completed history for discard finalization.

Important Knowledge:
none

Report:
reports/1.md
`, 'utf8');
  fs.writeFileSync(path.join(target, '.codex/reports/1.md'), `# Step 1: Seed completed step

## Task

Seed completed history.

## Applied Decisions

The step was completed directly from the task.

## Reasoning

Seed data for discard-step finalization coverage.

## Implementation Summary

Seeded completed history.

`, 'utf8');
  fs.writeFileSync(path.join(target, '.codex/current-step.md'), `# Current Step

No active step.

Last completed step: none
`, 'utf8');
  assert.equal(run('git', ['add', '--', '.codex/history.md', '.codex/reports/1.md', '.codex/current-step.md'], { cwd: target }).status, 0);
  assert.equal(run('git', ['commit', '-m', 'chore: seed completed step'], { cwd: target }).status, 0);
  assert.equal(run('git', ['status', '--short'], { cwd: target }).stdout.trim(), '');
  assert.equal(runCli(['internal', 'state', 'resync', '--target', target]).status, 0);

  assert.equal(runCli(['internal', 'state', 'start-step', '--prompt', 'Discard this step', '--target', target]).status, 0);
  assert.match(fs.readFileSync(path.join(target, '.codex/current-step.md'), 'utf8'), /Status: active/);
  assert.match(fs.readFileSync(path.join(target, '.codex/current-step.md'), 'utf8'), /Step ID: 2/);

  const result = runCli(['internal', 'state', 'discard-step', '--target', target]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const discard = JSON.parse(result.stdout);
  assert.equal(discard.details.discardedStepId, 2);
  assert.equal(discard.details.lastCompletedStep, '1');
  assert.equal(discard.details.committed, true);
  assert.equal(discard.details.message, 'chore: discard step 2');
  assert.equal(discard.details.runtimeStateUpdated, true);
  assert.match(fs.readFileSync(path.join(target, '.codex/current-step.md'), 'utf8'), /No active step/);
  assert.match(fs.readFileSync(path.join(target, '.codex/current-step.md'), 'utf8'), /Last completed step: 1/);
  assert.equal(fs.existsSync(path.join(target, '.codex/reports/2.md')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(target, '.codex/history.md'), 'utf8'), /## Step 2/);
  assert.equal(run('git', ['status', '--short'], { cwd: target }).stdout.trim(), '');
  assert.match(fs.readFileSync(path.join(target, '.codex/state.md'), 'utf8'), /Last Sync Source: discard-step:2/);
  assert.equal(run('git', ['log', '-1', '--format=%s'], { cwd: target }).stdout.trim(), 'chore: discard step 2');

  const resync = runCli(['internal', 'state', 'resync', '--target', target]);
  assert.equal(resync.status, 0, resync.stdout + resync.stderr);
  assert.match(fs.readFileSync(path.join(target, '.codex/state.md'), 'utf8'), /Last Sync Source: resync/);
  assert.equal(run('git', ['status', '--short'], { cwd: target }).stdout.trim(), '');

  const secondDiscard = runCli(['internal', 'state', 'discard-step', '--target', target]);
  assert.equal(secondDiscard.status, 1);
  assert.deepEqual(JSON.parse(secondDiscard.stdout).errors, ['No active step.']);
});

test('discard-step refuses to orphan active-step project changes', () => {
  const target = makeTempDir('codex-flow-discard-step-dirty-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  assert.equal(runCli(['internal', 'state', 'resync', '--target', target]).status, 0);
  assert.equal(runCli(['internal', 'state', 'start-step', '--prompt', 'Add payload', '--target', target]).status, 0);
  fs.writeFileSync(path.join(target, 'payload.txt'), 'payload\n', 'utf8');

  const result = discardActiveStep(target);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /project changes are present: payload\.txt/);
  assert.match(fs.readFileSync(path.join(target, '.codex/current-step.md'), 'utf8'), /Status: active/);
  assert.equal(fs.existsSync(path.join(target, '.codex/reports/1.md')), false);
});

test('internal finalize-step rejects metadata-only apply completion', () => {
  const target = makeTempDir('codex-flow-metadata-only-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  assert.equal(runCli(['internal', 'state', 'resync', '--target', target]).status, 0);
  assert.equal(runCli(['internal', 'state', 'start-step', '--prompt', 'Do nothing', '--target', target]).status, 0);

  const result = runCli([
    'internal',
    'state',
    'finalize-step',
    '--title',
    'Do nothing',
    '--target',
    target
  ]);

  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).errors.join('\n'), /metadata-only step completion/);
  assert.equal(fs.existsSync(path.join(target, '.codex/reports/1.md')), false);
  assert.match(fs.readFileSync(path.join(target, '.codex/current-step.md'), 'utf8'), /Status: active/);
  assert.doesNotMatch(fs.readFileSync(path.join(target, '.codex/history.md'), 'utf8'), /## Step 1/);
  assert.equal(run('git', ['log', '-1', '--format=%s'], { cwd: target }).stdout.trim(), 'chore: install codex flow');
});

test('internal finalize-step runs discovered checks before completed metadata', () => {
  const target = makeTempDir('codex-flow-checks-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  assert.equal(runCli(['internal', 'state', 'resync', '--target', target]).status, 0);
  assert.equal(runCli(['internal', 'state', 'start-step', '--prompt', 'Add failing package check', '--target', target]).status, 0);
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
    scripts: {
      test: 'node -e "process.exit(1)"'
    }
  }, null, 2), 'utf8');

  const result = runCli([
    'internal',
    'state',
    'finalize-step',
    '--title',
    'Add failing package check',
    '--target',
    target
  ]);

  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).errors.join('\n'), /Required check failed: npm test/);
  assert.equal(fs.existsSync(path.join(target, '.codex/reports/1.md')), false);
  assert.match(fs.readFileSync(path.join(target, '.codex/current-step.md'), 'utf8'), /Status: active/);
  assert.doesNotMatch(fs.readFileSync(path.join(target, '.codex/history.md'), 'utf8'), /## Step 1/);
  assert.equal(run('git', ['log', '-1', '--format=%s'], { cwd: target }).stdout.trim(), 'chore: install codex flow');
});

test('internal finalize-step times out hung required checks before completed metadata', () => {
  const target = makeTempDir('codex-flow-check-timeout-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  assert.equal(runCli(['internal', 'state', 'resync', '--target', target]).status, 0);
  assert.equal(runCli(['internal', 'state', 'start-step', '--prompt', 'Add file with hung check', '--target', target]).status, 0);
  fs.writeFileSync(path.join(target, 'payload.txt'), 'payload\n', 'utf8');

  const result = finalizeStep(target, {
    title: 'Add file with hung check',
    checkCommands: ['while :; do :; done'],
    checkTimeoutMs: 100
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Required check timed out after 100 ms: while :; do :; done/);
  assert.equal(fs.existsSync(path.join(target, '.codex/reports/1.md')), false);
  assert.match(fs.readFileSync(path.join(target, '.codex/current-step.md'), 'utf8'), /Status: active/);
  assert.doesNotMatch(fs.readFileSync(path.join(target, '.codex/history.md'), 'utf8'), /## Step 1/);
  assert.equal(run('git', ['log', '-1', '--format=%s'], { cwd: target }).stdout.trim(), 'chore: install codex flow');
});

test('stability gate rejects workflow diffs that weaken machine-checkable invariants', () => {
  const target = makeTempDir('codex-flow-stability-gate-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  writeInitializedState(target);

  fs.writeFileSync(path.join(target, '.gitignore'), '.DS_Store\n', 'utf8');
  let gate = evaluateStabilitySafetyGate(target);
  assert.equal(gate.ok, false);
  assert.match(gate.errors.join('\n'), /\.gitignore is missing required runtime ignore: \.codex\/state\.md/);
  assert.equal(evaluateAdoptStepGate(target, 'Adopt unsafe workflow diff').ok, false);

  fs.writeFileSync(path.join(target, '.gitignore'), '.codex/state.md\n.codex/tmp/\n', 'utf8');
  const commandsPath = path.join(target, '.codex/core/commands.md');
  fs.writeFileSync(
    commandsPath,
    fs.readFileSync(commandsPath, 'utf8').replace('## Stability Safety Gate', '## Safety Gate'),
    'utf8'
  );
  gate = evaluateStabilitySafetyGate(target);
  assert.equal(gate.ok, false);
  assert.match(gate.errors.join('\n'), /missing invariant anchor: ## Stability Safety Gate/);
});

test('adopt-step gate rejects pre-existing versioned codex memory changes', () => {
  const target = makeTempDir('codex-flow-adopt-memory-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  writeInitializedState(target);

  fs.appendFileSync(path.join(target, '.codex/history.md'), '\nBROKEN manual history edit\n', 'utf8');
  fs.writeFileSync(path.join(target, '.codex/reports/99.md'), '# Manual report corruption\n', 'utf8');
  fs.writeFileSync(path.join(target, 'manual.txt'), 'manual project change\n', 'utf8');

  const gate = evaluateAdoptStepGate(target, 'Adopt manual project change');
  assert.equal(gate.ok, false);
  assert.match(gate.errors.join('\n'), /cannot adopt pre-existing changes in versioned Codex memory\/config/);
  assert.deepEqual(
    gate.details.protectedCodexMemoryChanges.map((change) => change.path).sort(),
    ['.codex/history.md', '.codex/reports/']
  );
  assert.equal(fs.existsSync(path.join(target, '.codex/reports/1.md')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(target, '.codex/history.md'), 'utf8'), /## Step 1/);
});

test('adopt-step gate runs discovered checks against the manual diff', () => {
  const target = makeTempDir('codex-flow-adopt-checks-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  writeInitializedState(target);
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
    scripts: {
      test: 'node -e "process.exit(1)"'
    }
  }, null, 2), 'utf8');

  const gate = evaluateAdoptStepGate(target, 'Adopt failing package check');
  assert.equal(gate.ok, false);
  assert.match(gate.errors.join('\n'), /Required check failed: npm test/);
  assert.equal(fs.existsSync(path.join(target, '.codex/reports/1.md')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(target, '.codex/history.md'), 'utf8'), /## Step 1/);
  assert.equal(run('git', ['log', '-1', '--format=%s'], { cwd: target }).stdout.trim(), 'chore: install codex flow');
});

test('internal finalize-adopt-step adopts manual diff, metadata, commit, and state', () => {
  const target = makeTempDir('codex-flow-adopt-finalize-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  assert.equal(runCli(['internal', 'state', 'resync', '--target', target]).status, 0);
  fs.writeFileSync(path.join(target, 'manual.txt'), 'manual\n', 'utf8');

  const result = runCli([
    'internal',
    'state',
    'finalize-adopt-step',
    '--title',
    'Adopt manual file',
    '--next-step',
    'Review the adopted manual file and decide whether it needs project tests.',
    '--message',
    'chore: adopt manual file',
    '--target',
    target
  ]);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const finalization = JSON.parse(result.stdout);
  assert.equal(finalization.details.stepId, 1);
  assert.match(finalization.details.commit, /^[a-f0-9]{40}$/);
  assert.equal(
    finalization.details.nextStep,
    'Review the adopted manual file and decide whether it needs project tests.'
  );
  assert.equal(fs.existsSync(path.join(target, '.codex/reports/1.md')), true);
  assert.match(fs.readFileSync(path.join(target, '.codex/reports/1.md'), 'utf8'), /manual working-tree diff/);
  assert.match(fs.readFileSync(path.join(target, '.codex/history.md'), 'utf8'), /adopt-step accepted the user's manual working-tree diff/);
  assert.match(fs.readFileSync(path.join(target, '.codex/current-step.md'), 'utf8'), /No active step/);
  assert.match(
    fs.readFileSync(path.join(target, '.codex/next-step.md'), 'utf8'),
    /Review the adopted manual file and decide whether it needs project tests\./
  );
  assert.match(fs.readFileSync(path.join(target, '.codex/state.md'), 'utf8'), /Last Sync Source: adopt-step:1/);
  assert.equal(run('git', ['status', '--short'], { cwd: target }).stdout.trim(), '');
  assert.equal(run('git', ['log', '-1', '--format=%s'], { cwd: target }).stdout.trim(), 'chore: adopt manual file');
  assert.match(run('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: target }).stdout, /manual\.txt/);
});

test('internal finalize-adopt-step times out hung required checks before completed metadata', () => {
  const target = makeTempDir('codex-flow-adopt-timeout-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  assert.equal(runCli(['internal', 'state', 'resync', '--target', target]).status, 0);
  fs.writeFileSync(path.join(target, 'manual.txt'), 'manual\n', 'utf8');

  const result = finalizeAdoptStep(target, {
    title: 'Adopt manual file with hung check',
    checkCommands: ['while :; do :; done'],
    checkTimeoutMs: 100
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Required check timed out after 100 ms: while :; do :; done/);
  assert.equal(fs.existsSync(path.join(target, '.codex/reports/1.md')), false);
  assert.match(fs.readFileSync(path.join(target, '.codex/current-step.md'), 'utf8'), /No active step/);
  assert.doesNotMatch(fs.readFileSync(path.join(target, '.codex/history.md'), 'utf8'), /## Step 1/);
  assert.equal(run('git', ['log', '-1', '--format=%s'], { cwd: target }).stdout.trim(), 'chore: install codex flow');
  assert.match(run('git', ['status', '--short'], { cwd: target }).stdout, /manual\.txt/);
});

test('internal finalize-adopt-step stops on check failure before completed metadata', () => {
  const target = makeTempDir('codex-flow-adopt-finalize-checks-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  assert.equal(runCli(['internal', 'state', 'resync', '--target', target]).status, 0);
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
    scripts: {
      test: 'node -e "process.exit(1)"'
    }
  }, null, 2), 'utf8');

  const result = runCli([
    'internal',
    'state',
    'finalize-adopt-step',
    '--title',
    'Adopt failing package check',
    '--target',
    target
  ]);

  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).errors.join('\n'), /Required check failed: npm test/);
  assert.equal(fs.existsSync(path.join(target, '.codex/reports/1.md')), false);
  assert.match(fs.readFileSync(path.join(target, '.codex/current-step.md'), 'utf8'), /No active step/);
  assert.doesNotMatch(fs.readFileSync(path.join(target, '.codex/history.md'), 'utf8'), /## Step 1/);
  assert.equal(run('git', ['log', '-1', '--format=%s'], { cwd: target }).stdout.trim(), 'chore: install codex flow');
  assert.match(run('git', ['status', '--short'], { cwd: target }).stdout, /package\.json/);
});

test('internal finalize-adopt-step restores pre-adoption metadata when commit creation fails', () => {
  const target = makeTempDir('codex-flow-adopt-finalize-failure-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  assert.equal(runCli(['internal', 'state', 'resync', '--target', target]).status, 0);
  fs.writeFileSync(path.join(target, 'blocked.txt'), 'blocked\n', 'utf8');

  const hookPath = path.join(target, '.git/hooks/pre-commit');
  fs.writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', 'utf8');
  fs.chmodSync(hookPath, 0o755);

  const result = runCli([
    'internal',
    'state',
    'finalize-adopt-step',
    '--title',
    'Adopt blocked file',
    '--message',
    'chore: adopt blocked file',
    '--target',
    target
  ]);

  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).errors.join('\n'), /git commit failed/);
  assert.equal(fs.existsSync(path.join(target, '.codex/reports/1.md')), false);
  assert.match(fs.readFileSync(path.join(target, '.codex/current-step.md'), 'utf8'), /Last completed step: none/);
  assert.doesNotMatch(fs.readFileSync(path.join(target, '.codex/history.md'), 'utf8'), /## Step 1/);
  assert.doesNotMatch(fs.readFileSync(path.join(target, '.codex/state.md'), 'utf8'), /Last Sync Source: adopt-step:1/);
  assert.equal(run('git', ['log', '-1', '--format=%s'], { cwd: target }).stdout.trim(), 'chore: install codex flow');
  assert.match(run('git', ['status', '--short'], { cwd: target }).stdout, /blocked\.txt/);
});

test('internal finalize-step restores active state when commit creation fails', () => {
  const target = makeTempDir('codex-flow-finalize-failure-');
  initGit(target);
  assert.equal(runCli(['init', '--target', target]).status, 0);
  commitVersionedInstall(target);
  assert.equal(runCli(['internal', 'state', 'resync', '--target', target]).status, 0);
  assert.equal(runCli(['internal', 'state', 'start-step', '--prompt', 'Add blocked file', '--target', target]).status, 0);
  fs.writeFileSync(path.join(target, 'blocked.txt'), 'blocked\n', 'utf8');

  const hookPath = path.join(target, '.git/hooks/pre-commit');
  fs.writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', 'utf8');
  fs.chmodSync(hookPath, 0o755);

  const result = runCli([
    'internal',
    'state',
    'finalize-step',
    '--title',
    'Add blocked file',
    '--message',
    'chore: blocked commit',
    '--target',
    target
  ]);

  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).errors.join('\n'), /git commit failed/);
  assert.equal(fs.existsSync(path.join(target, '.codex/reports/1.md')), false);
  assert.match(fs.readFileSync(path.join(target, '.codex/current-step.md'), 'utf8'), /Status: active/);
  assert.doesNotMatch(fs.readFileSync(path.join(target, '.codex/history.md'), 'utf8'), /## Step 1/);
  assert.equal(run('git', ['log', '-1', '--format=%s'], { cwd: target }).stdout.trim(), 'chore: install codex flow');
  assert.match(run('git', ['status', '--short'], { cwd: target }).stdout, /blocked\.txt/);
});

function makeTempDir(prefix) {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTempDirs.push(target);
  return target;
}

function runCli(args, options = {}) {
  return run('node', [cliPath, ...args], {
    cwd: packageRoot,
    input: options.input
  });
}

function run(command, args, options = {}) {
  const cwd = options.cwd || packageRoot;
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    input: options.input,
    timeout: options.timeout || TEST_COMMAND_TIMEOUT_MS
  });

  if (result.error) {
    const commandLine = [command, ...args].join(' ');
    const detail = [
      `Command failed while running tests: ${commandLine}`,
      `cwd: ${cwd}`,
      `timeout_ms: ${options.timeout || TEST_COMMAND_TIMEOUT_MS}`,
      `error: ${result.error.message}`,
      result.stdout ? `stdout:\n${result.stdout}` : '',
      result.stderr ? `stderr:\n${result.stderr}` : ''
    ].filter(Boolean).join('\n');
    throw new Error(detail);
  }

  return result;
}

process.once('exit', () => {
  for (const target of createdTempDirs.reverse()) {
    fs.rmSync(target, {
      recursive: true,
      force: true
    });
  }
});

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
Discussion Mode: none
`, 'utf8');
}

function writeActiveStep(target, stepId) {
  const revision = run('git', ['rev-parse', 'HEAD'], { cwd: target }).stdout.trim();
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target }).stdout.trim();
  fs.writeFileSync(path.join(target, '.codex/current-step.md'), `# Current Step

Status: active
Step ID: ${stepId}

Task:
Existing active step.

Base Sync:
Backend: git
Base Revision: ${revision}
Base Branch: ${branch}

Decisions:
none

Open Questions:
none

Working Notes:
none
`, 'utf8');
}
