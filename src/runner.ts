import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export function getPackageRunner(): string {
  const packageRunner = vscode.workspace
    .getConfiguration('playwrightTraceViewer')
    .get<string>('packageRunner', 'npx')
    .trim() || 'npx';

  if (['npx', 'pnpm', 'yarn'].includes(packageRunner)) {
    return packageRunner;
  }

  vscode.window.showErrorMessage(
    `Unsupported package runner "${packageRunner}". Use npx, pnpm, or yarn.`
  );
  return 'npx';
}

export function resolveRunnerCommand(packageRunner = getPackageRunner()): string {
  if (process.platform === 'win32' && packageRunner === 'npx') {
    return 'npx.cmd';
  }

  return packageRunner;
}

export function showTrace(tracePath: string, workspaceRoot: string): void {
  runPlaywright(['show-trace', tracePath], findCommandCwd(workspaceRoot));
}

export function showReport(workspaceRoot: string): void {
  runPlaywright(['show-report'], findCommandCwd(workspaceRoot));
}

function runPlaywright(playwrightArgs: string[], workspaceRoot: string): void {
  const packageRunner = getPackageRunner();
  const localPlaywrightBin = packageRunner === 'npx'
    ? findLocalPlaywrightBin(workspaceRoot)
    : undefined;
  const bundledPlaywrightCli = packageRunner === 'npx' && !localPlaywrightBin
    ? findBundledPlaywrightCli()
    : undefined;
  const runner = localPlaywrightBin ?? (bundledPlaywrightCli ? process.execPath : resolveRunnerCommand(packageRunner));
  const args = localPlaywrightBin
    ? playwrightArgs
    : bundledPlaywrightCli
      ? [bundledPlaywrightCli, ...playwrightArgs]
      : ['playwright', ...playwrightArgs];

  const child = spawn(runner, args, {
    cwd: workspaceRoot,
    detached: true,
    stdio: 'ignore'
  });

  child.on('error', (error) => {
    vscode.window.showErrorMessage(
      `Failed to run "${runner} ${args.join(' ')}": ${error.message}`
    );
  });

  child.on('exit', (code) => {
    if (typeof code === 'number' && code !== 0) {
      vscode.window.showErrorMessage(
        `Playwright CLI exited with code ${code}. Make sure Playwright is installed in this workspace.`
      );
    }
  });

  child.unref();
}

function findCommandCwd(workspaceRoot: string): string {
  let current = workspaceRoot;

  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return workspaceRoot;
    }

    current = parent;
  }
}

function findLocalPlaywrightBin(workspaceRoot: string): string | undefined {
  const executable = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
  let current = workspaceRoot;

  while (true) {
    const candidate = path.join(current, 'node_modules', '.bin', executable);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;
  }
}

function findBundledPlaywrightCli(): string | undefined {
  try {
    return path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  } catch {
    return undefined;
  }
}
