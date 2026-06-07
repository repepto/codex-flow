#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');
const {
  COMMAND_FORMATS,
  REMOVED_COMMANDS,
  buildCommitPlan,
  buildWorkflowStateFooter,
  calculateNextStepId,
  discardActiveStep,
  evaluateGoalGate,
  evaluateAdoptStepGate,
  evaluateApplyGate,
  evaluateApplyPreflight,
  evaluateResyncGate,
  evaluateStartStepGate,
  evaluateStabilitySafetyGate,
  extractDocumentedCommandFormats,
  extractReadmeCommandList,
  finalizeAdoptStep,
  finalizeStep,
  inspectAskContext,
  normalizeCommandFormat,
  parseWorkflowCommand,
  readPlanningContext,
  recordDecision,
  resyncState,
  setGoal,
  setStrictMode,
  startRecommendedStep,
  startStep,
  validateWorkflowState
} = require('../lib/workflow');

const packageRoot = path.resolve(__dirname, '..');

const requiredCoreFiles = [
  'after-step.md',
  'bootstrap.md',
  'commands.md',
  'commit-rules.md',
  'config.toml',
  'overrides.md',
  'step-report-rules.md'
];

const obsoleteCoreFiles = [
  'run-step-examples.md'
];

const requiredGitignoreEntries = [
  '.codex/state.md',
  '.codex/tmp/'
];

const supportedOverrideFiles = new Set([
  'commands.md',
  'commit-rules.md',
  'after-step.md',
  'step-report-rules.md'
]);

const projectOwnedFileTemplates = new Map([
  ['.codex/config.toml', `# Project-local Codex defaults.
# Codex loads this file only after the project is trusted.

# Do not pause for approval prompts during normal project work.
approval_policy = "never"

# Keep filesystem access scoped to the project workspace by default.
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
# Allow package managers, test tools, and documentation fetches to use the network
# inside the workspace sandbox without asking for approval.
network_access = true
`],
  ['.codex/context.md', `# Context

## Architecture Knowledge

## Project Constraints

## Important Decisions

## Known Pitfalls
`],
  ['.codex/history.md', `# History

No completed steps.
`],
  ['.codex/current-step.md', `# Current Step

No active step.

Last completed step: none
`],
  ['.codex/next-step.md', `# Next Step

## Recommended Step

No recommendation yet.
`],
  ['.codex/last-report.md', `# Last Report

No reports available.
`],
  ['.codex/state.md', `# Codex State

Sync Backend: git
Last Known Revision: none
Last Known Branch: none
Last Sync Source: none
Strict Mode: true
Discussion Mode: none
`]
]);

const projectOwnedPaths = [
  '.codex/config.toml',
  '.codex/context.md',
  '.codex/goal.md',
  '.codex/history.md',
  '.codex/current-step.md',
  '.codex/next-step.md',
  '.codex/state.md',
  '.codex/last-report.md',
  '.codex/reports',
  '.codex/tmp',
  '.codex/overrides'
];

const packageName = '@repepto/codex-flow';

async function main() {
  try {
    const rawArgs = process.argv.slice(2);

    if (rawArgs[0] === 'internal') {
      runInternalCommand(parseInternalArgs(rawArgs.slice(1)));
      return;
    }

    const { command, options } = parseArgs(rawArgs);

    if (command === 'help') {
      printHelp();
      return;
    }

    if (command === 'init') {
      await initProject(options);
      return;
    }

    if (command === 'update') {
      updateProject(options);
      return;
    }

    if (command === 'doctor') {
      doctorProject(options);
      return;
    }

    throw new CliError(`Unknown command: ${command}`, 2);
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message);
      if (error.showHelp) {
        console.error('');
        printHelp();
      }
      process.exit(error.exitCode);
    }

    console.error(error.stack || error.message);
    process.exit(1);
  }
}

class CliError extends Error {
  constructor(message, exitCode = 1, showHelp = false) {
    super(message);
    this.exitCode = exitCode;
    this.showHelp = showHelp;
  }
}

function parseArgs(args) {
  let command = args[0] || 'help';
  const options = {
    target: process.cwd(),
    dryRun: false,
    force: false,
    commit: false
  };

  if (command === '--help' || command === '-h') {
    command = 'help';
  }

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--force') {
      options.force = true;
      continue;
    }

    if (arg === '--commit') {
      options.commit = true;
      continue;
    }

    if (arg === '--target' || arg === '-t') {
      const value = args[i + 1];
      if (!value) {
        throw new CliError(`${arg} requires a directory path.`, 2, true);
      }
      options.target = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--target=')) {
      options.target = arg.slice('--target='.length);
      if (!options.target) {
        throw new CliError('--target requires a directory path.', 2, true);
      }
      continue;
    }

    throw new CliError(`Unknown option: ${arg}`, 2, true);
  }

  if (options.commit && command !== 'update') {
    throw new CliError('--commit is supported only for update.', 2, true);
  }

  options.target = path.resolve(options.target);
  return { command, options };
}

function parseInternalArgs(args) {
  const options = {
    target: process.cwd(),
    prompt: null,
    title: null,
    id: null,
    description: null,
    question: null,
    summary: null,
    implementation: null,
    message: null,
    nextStep: null,
    strict: null,
    checkCommands: [],
    requireCommitWorthy: false,
    compact: false
  };
  const commandArgs = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--target' || arg === '-t') {
      const value = args[i + 1];
      if (!value) {
        throw new CliError(`${arg} requires a directory path.`, 2);
      }
      options.target = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--target=')) {
      options.target = arg.slice('--target='.length);
      if (!options.target) {
        throw new CliError('--target requires a directory path.', 2);
      }
      continue;
    }

    if (arg === '--prompt') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliError('--prompt requires a value.', 2);
      }
      options.prompt = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--prompt=')) {
      options.prompt = arg.slice('--prompt='.length);
      continue;
    }

    if (arg === '--title') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliError('--title requires a value.', 2);
      }
      options.title = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--title=')) {
      options.title = arg.slice('--title='.length);
      continue;
    }

    if (arg === '--id') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliError('--id requires a value.', 2);
      }
      options.id = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--id=')) {
      options.id = arg.slice('--id='.length);
      continue;
    }

    if (arg === '--description') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliError('--description requires a value.', 2);
      }
      options.description = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--description=')) {
      options.description = arg.slice('--description='.length);
      continue;
    }

    if (arg === '--question') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliError('--question requires a value.', 2);
      }
      options.question = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--question=')) {
      options.question = arg.slice('--question='.length);
      continue;
    }

    if (arg === '--summary') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliError('--summary requires a value.', 2);
      }
      options.summary = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--summary=')) {
      options.summary = arg.slice('--summary='.length);
      continue;
    }

    if (arg === '--implementation') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliError('--implementation requires a value.', 2);
      }
      options.implementation = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--implementation=')) {
      options.implementation = arg.slice('--implementation='.length);
      continue;
    }

    if (arg === '--next-step') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliError('--next-step requires a value.', 2);
      }
      options.nextStep = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--next-step=')) {
      options.nextStep = arg.slice('--next-step='.length);
      continue;
    }

    if (arg === '--message') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliError('--message requires a value.', 2);
      }
      options.message = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--message=')) {
      options.message = arg.slice('--message='.length);
      continue;
    }

    if (arg === '--strict') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliError('--strict requires a value.', 2);
      }
      options.strict = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--strict=')) {
      options.strict = arg.slice('--strict='.length);
      continue;
    }

    if (arg === '--check-command') {
      const value = args[i + 1];
      if (value === undefined) {
        throw new CliError('--check-command requires a value.', 2);
      }
      options.checkCommands.push(value);
      i += 1;
      continue;
    }

    if (arg.startsWith('--check-command=')) {
      options.checkCommands.push(arg.slice('--check-command='.length));
      continue;
    }

    if (arg === '--require-commit-worthy') {
      options.requireCommitWorthy = true;
      continue;
    }

    if (arg === '--compact') {
      options.compact = true;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new CliError(`Unknown internal option: ${arg}`, 2);
    }

    commandArgs.push(arg);
  }

  options.target = path.resolve(options.target);
  return { commandArgs, options };
}

function runInternalCommand({ commandArgs, options }) {
  const targetRoot = ensureTargetDirectory(options.target);
  const [group, action] = commandArgs;
  let result;

  if (group === 'parse-command') {
    if (options.prompt === null) {
      throw new CliError('internal parse-command requires --prompt.', 2);
    }
    const parsed = parseWorkflowCommand(options.prompt);
    result = {
      ok: parsed.valid,
      valid: parsed.valid,
      command: parsed.command || null,
      params: parsed.params || {},
      reason: parsed.reason || null
    };
    return printInternalResult(result);
  }

  if (group === 'validate-state') {
    return printInternalResult(validateWorkflowState(targetRoot));
  }

  if (group === 'planning-context') {
    return printInternalResult(readPlanningContext(targetRoot));
  }

  if (group === 'ask-context') {
    if (options.question === null) {
      throw new CliError('internal ask-context requires --question.', 2);
    }
    return printInternalResult(inspectAskContext(targetRoot, options.question));
  }

  if (group === 'footer') {
    return printInternalResult(buildWorkflowStateFooter(targetRoot, {
      compact: options.compact
    }));
  }

  if (group === 'next-step-id') {
    result = calculateNextStepId(targetRoot);
    return printInternalResult({
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      nextStepId: result.nextStepId,
      historyStepIds: result.historyStepIds,
      reportStepIds: result.reportStepIds
    });
  }

  if (group === 'commit-plan') {
    return printInternalResult(buildCommitPlan(targetRoot, {
      requireCommitWorthy: options.requireCommitWorthy
    }));
  }

  if (group === 'preflight') {
    if (action === 'apply') {
      return printInternalResult(evaluateApplyPreflight(targetRoot));
    }
  }

  if (group === 'state') {
    if (action === 'resync') {
      return printInternalResult(resyncState(targetRoot));
    }

    if (action === 'set-strict') {
      if (options.strict === null) {
        throw new CliError('internal state set-strict requires --strict true|false.', 2);
      }
      return printInternalResult(setStrictMode(targetRoot, options.strict));
    }

    if (action === 'start-step') {
      if (options.prompt === null) {
        throw new CliError('internal state start-step requires --prompt.', 2);
      }
      return printInternalResult(startStep(targetRoot, options.prompt));
    }

    if (action === 'start-recommended-step') {
      return printInternalResult(startRecommendedStep(targetRoot));
    }

    if (action === 'set-goal') {
      if (options.description === null) {
        throw new CliError('internal state set-goal requires --description.', 2);
      }
      return printInternalResult(setGoal(targetRoot, options.description));
    }

    if (action === 'record') {
      if (options.id === null) {
        throw new CliError('internal state record requires --id.', 2);
      }
      if (options.description === null) {
        throw new CliError('internal state record requires --description.', 2);
      }
      return printInternalResult(recordDecision(targetRoot, options.id, options.description));
    }

    if (action === 'discard-step') {
      return printInternalResult(discardActiveStep(targetRoot));
    }

    if (action === 'finalize-step') {
      return printInternalResult(finalizeStep(targetRoot, {
        title: options.title,
        summary: options.summary,
        implementation: options.implementation,
        nextStep: options.nextStep,
        message: options.message,
        checkCommands: options.checkCommands
      }));
    }

    if (action === 'finalize-adopt-step') {
      if (options.title === null) {
        throw new CliError('internal state finalize-adopt-step requires --title.', 2);
      }
      return printInternalResult(finalizeAdoptStep(targetRoot, {
        title: options.title,
        summary: options.summary,
        implementation: options.implementation,
        nextStep: options.nextStep,
        message: options.message,
        checkCommands: options.checkCommands
      }));
    }
  }

  if (group === 'gate') {
    if (action === 'start-step') {
      return printInternalResult(evaluateStartStepGate(targetRoot));
    }

    if (action === 'goal') {
      if (options.description === null) {
        throw new CliError('internal gate goal requires --description.', 2);
      }
      return printInternalResult(evaluateGoalGate(targetRoot, options.description));
    }

    if (action === 'apply') {
      return printInternalResult(evaluateApplyGate(targetRoot));
    }

    if (action === 'adopt-step') {
      if (options.title === null) {
        throw new CliError('internal gate adopt-step requires --title.', 2);
      }
      return printInternalResult(evaluateAdoptStepGate(targetRoot, options.title, {
        checkCommands: options.checkCommands
      }));
    }

    if (action === 'resync') {
      return printInternalResult(evaluateResyncGate(targetRoot));
    }

    if (action === 'stability') {
      return printInternalResult(evaluateStabilitySafetyGate(targetRoot));
    }
  }

  throw new CliError(
    'Unknown internal command. Supported: parse-command, validate-state, planning-context, ask-context, footer, next-step-id, commit-plan, preflight apply, state resync|set-strict|start-step|start-recommended-step|set-goal|record|discard-step|finalize-step|finalize-adopt-step, gate start-step|goal|apply|adopt-step|resync|stability.',
    2
  );
}

function printInternalResult(result) {
  console.log(JSON.stringify(result, null, 2));
  if (result.ok === false || result.valid === false) {
    process.exitCode = 1;
  }
}

function printHelp() {
  console.log(`codex-flow

Usage:
  codex-flow init [--target <dir>] [--force] [--dry-run]
  codex-flow update [--target <dir>] [--commit] [--dry-run]
  codex-flow doctor [--target <dir>]

Commands:
  init     Ensure git, install AGENTS.md, .codex/core/, .codex/config.toml, state/data, and gitignore entries.
  update   Replace AGENTS.md and .codex/core/, create missing .codex/config.toml; --commit validates and commits them.
  doctor   Validate package or installed-project workflow invariants.
`);
}

async function initProject(options) {
  const targetRoot = ensureTargetDirectory(options.target);

  if (isPackageSource(targetRoot)) {
    throw new CliError(
      'Refusing to run init inside the codex-flow package source. Run init in a downstream project.',
      1
    );
  }

  const actions = [];
  const warnings = [];

  if (!isGitRepository(targetRoot)) {
    if (options.dryRun) {
      actions.push('Would initialize git repository');
    } else {
      const shouldInitGit = await confirmGitInit(targetRoot);
      if (!shouldInitGit) {
        printCancelledInit(targetRoot);
        process.exitCode = 1;
        return;
      }

      initializeGitRepository(targetRoot, actions);
    }
  }

  copyStarterTemplates(targetRoot, {
    overwrite: options.force,
    dryRun: options.dryRun,
    actions
  });

  bootstrapProjectState(targetRoot, {
    dryRun: options.dryRun,
    actions
  });

  ensureGitignore(targetRoot, {
    dryRun: options.dryRun,
    actions
  });

  printActionReport('codex-flow init', targetRoot, actions, warnings, options.dryRun);
  console.log('');
  console.log('Next: review and commit versioned files, then run resync after the working tree is clean.');
}

async function confirmGitInit(targetRoot) {
  const question = `Codex Flow works only in git repositories. ${targetRoot} is not a git repository. Create one with "git init"? [y/N] `;

  if (!process.stdin.isTTY) {
    const answer = fs.readFileSync(0, 'utf8').split(/\r?\n/, 1)[0] || '';
    if (answer.trim().length > 0) {
      console.log(`${question}${answer}`);
    }
    return isAffirmative(answer);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    return isAffirmative(await rl.question(question));
  } finally {
    rl.close();
  }
}

function isAffirmative(answer) {
  return /^(y|yes)$/i.test(answer.trim());
}

function initializeGitRepository(targetRoot, actions) {
  const result = spawnSync('git', ['init'], {
    cwd: targetRoot,
    encoding: 'utf8'
  });

  if (result.error) {
    throw new CliError(`Failed to run git init: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new CliError(`git init failed.${detail ? `\n${detail}` : ''}`);
  }

  actions.push('Initialized git repository');
}

function printCancelledInit(targetRoot) {
  console.log('codex-flow init');
  console.log(`Target: ${targetRoot}`);
  console.log('');
  console.log('No changes.');
  console.log('Codex Flow works only in git repositories. Initialization cancelled.');
}

function updateProject(options) {
  const targetRoot = ensureTargetDirectory(options.target);
  const actions = [];
  const warnings = [];

  if (isPackageSource(targetRoot)) {
    throw new CliError(
      'Refusing to run update inside the codex-flow package source. Run update in a downstream project.',
      1
    );
  }

  if (options.commit) {
    if (options.dryRun) {
      throw new CliError('update --commit cannot be combined with --dry-run.', 2);
    }

    requireCleanGitWorkingTree(targetRoot, 'update --commit');
  }

  copyStarterTemplates(targetRoot, {
    overwrite: true,
    dryRun: options.dryRun,
    actions
  });

  removeObsoleteCoreFiles(targetRoot, {
    dryRun: options.dryRun,
    actions
  });

  bootstrapProjectConfig(targetRoot, {
    dryRun: options.dryRun,
    actions
  });

  const missingIgnores = getMissingGitignoreEntries(targetRoot);
  if (missingIgnores.length > 0) {
    warnings.push(`Missing required .gitignore entries: ${missingIgnores.join(', ')}`);
  }

  printActionReport('codex-flow update', targetRoot, actions, warnings, options.dryRun);

  if (!options.commit) {
    return;
  }

  console.log('');
  const doctor = collectDoctorFindings(targetRoot);
  printDoctorReport(targetRoot, doctor);

  if (doctor.errors.length > 0) {
    throw new CliError('update --commit stopped because doctor found workflow errors.');
  }

  const updateCommitPaths = ['AGENTS.md', '.codex/core', '.codex/config.toml'];
  const changedPaths = getGitStatusForPaths(targetRoot, updateCommitPaths);
  if (changedPaths.length === 0) {
    console.log('');
    console.log('No update changes to commit.');
    return;
  }

  runGitOrThrow(targetRoot, ['add', ...updateCommitPaths]);
  runGitOrThrow(targetRoot, ['commit', '-m', 'chore: update codex flow']);
  const revision = runGitOrThrow(targetRoot, ['rev-parse', '--short', 'HEAD']).stdout.trim();

  console.log('');
  console.log(`Created commit ${revision}: chore: update codex flow`);
  console.log('Next: run resync in Codex chat after the working tree is clean.');
}

function doctorProject(options) {
  const targetRoot = ensureTargetDirectory(options.target);
  const findings = collectDoctorFindings(targetRoot);

  printDoctorReport(targetRoot, findings);

  if (findings.errors.length > 0) {
    process.exit(1);
  }
}

function collectDoctorFindings(targetRoot) {
  const errors = [];
  const warnings = [];
  const sourcePackage = isPackageSource(targetRoot);

  requireFile(targetRoot, 'AGENTS.md', errors);

  for (const file of requiredCoreFiles) {
    requireFile(targetRoot, path.join('.codex/core', file), errors);
  }

  validateRuleAnchors(targetRoot, errors);
  validateCommandSurface(targetRoot, errors, {
    validateReadme: sourcePackage
  });
  validateObsoleteCoreFiles(targetRoot, errors);
  validateGitignore(targetRoot, errors);
  validateOverrides(targetRoot, errors);

  if (sourcePackage) {
    validatePackageSource(targetRoot, errors);
  } else {
    validateInstalledProjectState(targetRoot, warnings);
  }

  return { errors, warnings, sourcePackage };
}

function printDoctorReport(targetRoot, findings) {
  const { errors, warnings, sourcePackage } = findings;

  console.log('codex-flow doctor');
  console.log(`Target: ${targetRoot}`);
  console.log(`Mode: ${sourcePackage ? 'package source' : 'installed project'}`);
  console.log('');

  if (errors.length === 0 && warnings.length === 0) {
    console.log('OK: workflow invariants passed.');
    return;
  }

  if (errors.length > 0) {
    console.log('Errors:');
    for (const error of errors) {
      console.log(`- ${error}`);
    }
  }

  if (warnings.length > 0) {
    if (errors.length > 0) {
      console.log('');
    }
    console.log('Warnings:');
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
  }
}

function validateCommandSurface(targetRoot, errors, options = {}) {
  const commandsPath = path.join(targetRoot, '.codex/core/commands.md');
  const readmePath = path.join(targetRoot, 'README.md');
  const validateReadme = options.validateReadme === true;

  if (!pathExists(commandsPath)) {
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

  if (!validateReadme) {
    return;
  }

  if (!pathExists(readmePath)) {
    errors.push('Missing required file: README.md');
    return;
  }

  const readmeCommands = extractReadmeCommandList(fs.readFileSync(readmePath, 'utf8'));
  const normalizedReadme = new Set(readmeCommands.map(normalizeCommandFormat));

  for (const expected of normalizedExpected) {
    if (!normalizedReadme.has(expected)) {
      errors.push(`README.md command list is missing command format: ${expected}`);
    }
  }

  for (const command of normalizedReadme) {
    if (!normalizedCore.has(command)) {
      errors.push(`README.md documents unsupported workflow command: ${command}`);
    }
  }

  for (const removed of REMOVED_COMMANDS) {
    if (readmeCommands.includes(removed)) {
      errors.push(`README.md command list includes removed command: ${removed}`);
    }
  }
}

function copyStarterTemplates(targetRoot, options) {
  copyTemplateFile('AGENTS.md', targetRoot, options);

  for (const file of requiredCoreFiles) {
    copyTemplateFile(path.join('.codex/core', file), targetRoot, options);
  }
}

function removeObsoleteCoreFiles(targetRoot, options) {
  for (const file of obsoleteCoreFiles) {
    const relativePath = path.join('.codex/core', file);
    const fullPath = path.join(targetRoot, relativePath);
    if (!pathExists(fullPath)) {
      continue;
    }

    options.actions.push(`Removed obsolete ${relativePath}`);
    if (!options.dryRun) {
      fs.rmSync(fullPath);
    }
  }
}

function copyTemplateFile(relativePath, targetRoot, options) {
  const source = path.join(packageRoot, relativePath);
  const destination = path.join(targetRoot, relativePath);

  if (!pathExists(source)) {
    throw new CliError(`Package template is missing: ${relativePath}`);
  }

  if (pathExists(destination) && !options.overwrite) {
    options.actions.push(`Skipped existing ${relativePath}`);
    return;
  }

  options.actions.push(`${options.overwrite && pathExists(destination) ? 'Updated' : 'Created'} ${relativePath}`);

  if (options.dryRun) {
    return;
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function bootstrapProjectState(targetRoot, options) {
  bootstrapProjectConfig(targetRoot, options);

  for (const [relativePath, content] of projectOwnedFileTemplates) {
    if (relativePath === '.codex/config.toml') {
      continue;
    }

    const destination = path.join(targetRoot, relativePath);
    if (pathExists(destination)) {
      options.actions.push(`Kept existing ${relativePath}`);
      continue;
    }

    options.actions.push(`Created ${relativePath}`);
    if (!options.dryRun) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content, 'utf8');
    }
  }

  const reportsDir = path.join(targetRoot, '.codex/reports');
  if (pathExists(reportsDir)) {
    options.actions.push('Kept existing .codex/reports/');
    return;
  }

  options.actions.push('Created .codex/reports/');
  if (!options.dryRun) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
}

function bootstrapProjectConfig(targetRoot, options) {
  const relativePath = '.codex/config.toml';
  const destination = path.join(targetRoot, relativePath);
  if (pathExists(destination)) {
    options.actions.push(`Kept existing ${relativePath}`);
    return;
  }

  options.actions.push(`Created ${relativePath}`);
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, projectOwnedFileTemplates.get(relativePath), 'utf8');
  }
}

function ensureGitignore(targetRoot, options) {
  const gitignore = path.join(targetRoot, '.gitignore');
  const missing = getMissingGitignoreEntries(targetRoot);

  if (missing.length === 0) {
    options.actions.push('Kept .gitignore runtime entries');
    return;
  }

  options.actions.push(`Added .gitignore entries: ${missing.join(', ')}`);

  if (options.dryRun) {
    return;
  }

  let current = '';
  if (pathExists(gitignore)) {
    current = fs.readFileSync(gitignore, 'utf8');
  }

  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  const separator = current.trim().length > 0 ? '\n' : '';
  fs.writeFileSync(gitignore, `${current}${prefix}${separator}${missing.join('\n')}\n`, 'utf8');
}

function getMissingGitignoreEntries(targetRoot) {
  const gitignore = path.join(targetRoot, '.gitignore');
  const lines = pathExists(gitignore)
    ? fs.readFileSync(gitignore, 'utf8').split(/\r?\n/).map((line) => line.trim())
    : [];

  return requiredGitignoreEntries.filter((entry) => !lines.includes(entry));
}

function validateRuleAnchors(targetRoot, errors) {
  const anchors = [
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

  for (const [relativePath, needle] of anchors) {
    const fullPath = path.join(targetRoot, relativePath);
    if (!pathExists(fullPath)) {
      continue;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    if (!content.includes(needle)) {
      errors.push(`${relativePath} is missing invariant anchor: ${needle}`);
    }
  }
}

function validateGitignore(targetRoot, errors) {
  const missing = getMissingGitignoreEntries(targetRoot);
  for (const entry of missing) {
    errors.push(`.gitignore is missing required runtime ignore: ${entry}`);
  }
}

function validateOverrides(targetRoot, errors) {
  const overridesDir = path.join(targetRoot, '.codex/overrides');
  if (!pathExists(overridesDir)) {
    return;
  }

  const entries = fs.readdirSync(overridesDir, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.join('.codex/overrides', entry.name);
    const fullPath = path.join(overridesDir, entry.name);

    if (!entry.isFile()) {
      errors.push(`${relativePath} is invalid; overrides must be supported .md files.`);
      continue;
    }

    if (!supportedOverrideFiles.has(entry.name)) {
      errors.push(`${relativePath} is not a supported override file.`);
      continue;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    if (content.includes('#replace')) {
      errors.push(`${relativePath} contains #replace, which is not supported.`);
    }
  }
}

function validateObsoleteCoreFiles(targetRoot, errors) {
  for (const file of obsoleteCoreFiles) {
    const relativePath = path.join('.codex/core', file);
    if (pathExists(path.join(targetRoot, relativePath))) {
      errors.push(`${relativePath} is obsolete; run codex-flow update to remove it.`);
    }
  }
}

function validatePackageSource(targetRoot, errors) {
  const packageJsonPath = path.join(targetRoot, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  if (packageJson.name !== packageName) {
    errors.push(`package.json name must be ${packageName}.`);
  }

  if (!packageJson.bin || packageJson.bin['codex-flow'] !== 'bin/codex-flow.js') {
    errors.push('package.json must expose bin/codex-flow.js as the codex-flow CLI.');
  }

  const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
  for (const required of ['AGENTS.md', '.codex/core/', 'bin/', 'lib/']) {
    if (!packageFiles.includes(required)) {
      errors.push(`package.json files must include ${required}`);
    }
  }

  for (const relativePath of projectOwnedPaths) {
    const fullPath = path.join(targetRoot, relativePath);
    if (pathExists(fullPath)) {
      errors.push(`Package source must not contain project-owned state/data path: ${relativePath}`);
    }
  }
}

function validateInstalledProjectState(targetRoot, warnings) {
  for (const relativePath of projectOwnedFileTemplates.keys()) {
    if (!pathExists(path.join(targetRoot, relativePath))) {
      warnings.push(`Missing bootstrap-created state/data file: ${relativePath}`);
    }
  }

  if (!pathExists(path.join(targetRoot, '.codex/reports'))) {
    warnings.push('Missing bootstrap-created directory: .codex/reports/');
  }
}

function requireCleanGitWorkingTree(targetRoot, actionName) {
  if (!isGitRepository(targetRoot)) {
    throw new CliError(`${actionName} requires a git repository.`);
  }

  const status = runGitOrThrow(targetRoot, ['status', '--porcelain']).stdout.trim();
  if (status.length > 0) {
    throw new CliError(`${actionName} requires a clean git working tree before update.\nDirty paths:\n${status}`);
  }
}

function getGitStatusForPaths(targetRoot, paths) {
  const status = runGitOrThrow(targetRoot, ['status', '--porcelain', '--', ...paths]).stdout.trim();
  if (status.length === 0) {
    return [];
  }
  return status.split(/\r?\n/);
}

function runGitOrThrow(targetRoot, args) {
  const result = spawnSync('git', args, {
    cwd: targetRoot,
    encoding: 'utf8'
  });

  if (result.error) {
    throw new CliError(`Failed to run git ${args[0]}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new CliError(`git ${args.join(' ')} failed.${detail ? `\n${detail}` : ''}`);
  }

  return result;
}

function requireFile(targetRoot, relativePath, errors) {
  const fullPath = path.join(targetRoot, relativePath);
  if (!pathExists(fullPath) || !fs.statSync(fullPath).isFile()) {
    errors.push(`Missing required file: ${relativePath}`);
  }
}

function ensureTargetDirectory(target) {
  if (!pathExists(target)) {
    throw new CliError(`Target directory does not exist: ${target}`);
  }

  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    throw new CliError(`Target is not a directory: ${target}`);
  }

  return target;
}

function isPackageSource(targetRoot) {
  const packageJsonPath = path.join(targetRoot, 'package.json');
  if (!pathExists(packageJsonPath)) {
    return false;
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return packageJson.name === packageName
      && pathExists(path.join(targetRoot, 'AGENTS.md'))
      && pathExists(path.join(targetRoot, '.codex/core/bootstrap.md'));
  } catch (_error) {
    return false;
  }
}

function isGitRepository(targetRoot) {
  let current = targetRoot;

  while (true) {
    if (pathExists(path.join(current, '.git'))) {
      return true;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

function pathExists(fullPath) {
  return fs.existsSync(fullPath);
}

function printActionReport(title, targetRoot, actions, warnings, dryRun) {
  console.log(title);
  console.log(`Target: ${targetRoot}`);
  if (dryRun) {
    console.log('Mode: dry-run');
  }
  console.log('');

  if (actions.length === 0) {
    console.log('No changes.');
  } else {
    for (const action of actions) {
      console.log(`- ${action}`);
    }
  }

  if (warnings.length > 0) {
    console.log('');
    console.log('Warnings:');
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
  }
}

main();
