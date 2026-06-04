#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawnSync } = require('node:child_process');
const {
  COMMAND_FORMATS,
  REMOVED_COMMANDS,
  extractDocumentedCommandFormats,
  extractReadmeCommandList,
  normalizeCommandFormat,
  parseRunStepsQueue
} = require('../lib/workflow');

const packageRoot = path.resolve(__dirname, '..');

const requiredCoreFiles = [
  'after-step.md',
  'bootstrap.md',
  'commands.md',
  'commit-rules.md',
  'config.toml',
  'overrides.md',
  'run-step-examples.md',
  'step-report-rules.md'
];

const requiredGitignoreEntries = [
  '.codex/state.md',
  '.codex/checkpoints/',
  '.codex/tmp/'
];

const supportedOverrideFiles = new Set([
  'commands.md',
  'commit-rules.md',
  'after-step.md',
  'step-report-rules.md'
]);

const projectOwnedFileTemplates = new Map([
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
  ['.codex/steps.md', `# Steps

No pending steps.
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
Step Chain Mode: none
`]
]);

const projectOwnedPaths = [
  '.codex/context.md',
  '.codex/history.md',
  '.codex/current-step.md',
  '.codex/next-step.md',
  '.codex/state.md',
  '.codex/steps.md',
  '.codex/last-report.md',
  '.codex/reports',
  '.codex/checkpoints',
  '.codex/tmp',
  '.codex/overrides'
];

async function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));

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
    force: false
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

  options.target = path.resolve(options.target);
  return { command, options };
}

function printHelp() {
  console.log(`codex-flow

Usage:
  codex-flow init [--target <dir>] [--force] [--dry-run]
  codex-flow update [--target <dir>] [--dry-run]
  codex-flow doctor [--target <dir>]

Commands:
  init     Ensure git, install AGENTS.md, .codex/core/, bootstrap state/data, and gitignore entries.
  update   Replace AGENTS.md and package-owned .codex/core/ files only.
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

  copyStarterTemplates(targetRoot, {
    overwrite: true,
    dryRun: options.dryRun,
    actions
  });

  const missingIgnores = getMissingGitignoreEntries(targetRoot);
  if (missingIgnores.length > 0) {
    warnings.push(`Missing required .gitignore entries: ${missingIgnores.join(', ')}`);
  }

  printActionReport('codex-flow update', targetRoot, actions, warnings, options.dryRun);
}

function doctorProject(options) {
  const targetRoot = ensureTargetDirectory(options.target);
  const errors = [];
  const warnings = [];
  const sourcePackage = isPackageSource(targetRoot);

  requireFile(targetRoot, 'AGENTS.md', errors);

  for (const file of requiredCoreFiles) {
    requireFile(targetRoot, path.join('.codex/core', file), errors);
  }

  validateRuleAnchors(targetRoot, errors);
  validateCommandSurface(targetRoot, errors);
  validateRunStepsExamples(targetRoot, errors);
  validateGitignore(targetRoot, errors);
  validateOverrides(targetRoot, errors);

  if (sourcePackage) {
    validatePackageSource(targetRoot, errors);
  } else {
    validateInstalledProjectState(targetRoot, warnings);
  }

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

  if (errors.length > 0) {
    process.exit(1);
  }
}

function validateCommandSurface(targetRoot, errors) {
  const commandsPath = path.join(targetRoot, '.codex/core/commands.md');
  const readmePath = path.join(targetRoot, 'README.md');
  if (!pathExists(commandsPath) || !pathExists(readmePath)) {
    return;
  }

  const coreFormats = extractDocumentedCommandFormats(fs.readFileSync(commandsPath, 'utf8'));
  const readmeCommands = extractReadmeCommandList(fs.readFileSync(readmePath, 'utf8'));
  const normalizedCore = new Set(coreFormats.map(normalizeCommandFormat));
  const normalizedReadme = new Set(readmeCommands.map(normalizeCommandFormat));
  const normalizedExpected = new Set(COMMAND_FORMATS.map(normalizeCommandFormat));

  for (const expected of normalizedExpected) {
    if (!normalizedCore.has(expected)) {
      errors.push(`.codex/core/commands.md is missing command format: ${expected}`);
    }
    if (!normalizedReadme.has(expected)) {
      errors.push(`README.md command list is missing command format: ${expected}`);
    }
  }

  for (const command of normalizedReadme) {
    if (!normalizedCore.has(command)) {
      errors.push(`README.md documents unsupported workflow command: ${command}`);
    }
  }

  for (const command of normalizedCore) {
    if (!normalizedExpected.has(command)) {
      errors.push(`.codex/core/commands.md documents unsupported workflow command: ${command}`);
    }
  }

  for (const removed of REMOVED_COMMANDS) {
    if (readmeCommands.includes(removed)) {
      errors.push(`README.md command list includes removed command: ${removed}`);
    }
  }
}

function validateRunStepsExamples(targetRoot, errors) {
  const examplesPath = path.join(targetRoot, '.codex/core/run-step-examples.md');
  if (!pathExists(examplesPath)) {
    return;
  }

  const content = fs.readFileSync(examplesPath, 'utf8');
  const blocks = [...content.matchAll(/```md\n([\s\S]*?)```/g)];
  for (const [index, block] of blocks.entries()) {
    const result = parseRunStepsQueue(block[1]);
    if (!result.ok || result.items.length === 0) {
      errors.push(`.codex/core/run-step-examples.md block ${index + 1} is not valid run-steps grammar.`);
      for (const error of result.errors) {
        errors.push(`.codex/core/run-step-examples.md block ${index + 1}: ${error}`);
      }
    }
  }
}

function copyStarterTemplates(targetRoot, options) {
  copyTemplateFile('AGENTS.md', targetRoot, options);

  for (const file of requiredCoreFiles) {
    copyTemplateFile(path.join('.codex/core', file), targetRoot, options);
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
  for (const [relativePath, content] of projectOwnedFileTemplates) {
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
    ['.codex/core/commands.md', '## adopt-step'],
    ['.codex/core/commands.md', '## run-steps'],
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

function validatePackageSource(targetRoot, errors) {
  const packageJsonPath = path.join(targetRoot, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  if (packageJson.name !== 'codex-flow') {
    errors.push('package.json name must be codex-flow.');
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
    return packageJson.name === 'codex-flow'
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
