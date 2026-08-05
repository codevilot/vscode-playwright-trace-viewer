import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  clearOutputDir,
  copyLatestTrace,
  findLatestTrace,
  getLatestTraceFileName,
  getPlaywrightOutputDir
} from './playwright/runArtifacts';

const terminalName = 'Playwright Trace Viewer';
export const outputChannelName = 'Playwright Trace Viewer';

export type RunTestsWithTraceResult = {
  tracePath?: string;
  exitCode: number;
};

export async function runTestsWithTrace(
  workspaceRoot: string,
  traceMode: 'on' | 'retain-on-failure',
  testPaths: string[] = []
): Promise<string | undefined> {
  return (await runTestsWithTraceDetailed(workspaceRoot, traceMode, testPaths)).tracePath;
}

export async function runTestsWithTraceDetailed(
  workspaceRoot: string,
  traceMode: 'on' | 'retain-on-failure',
  testPaths: string[] = []
): Promise<RunTestsWithTraceResult> {
  const outputDir = getPlaywrightOutputDir(testPaths);
  return runPlaywrightInExtension(workspaceRoot, [
    'test',
    ...testPaths,
    '--trace',
    traceMode,
    '--max-failures',
    '0',
    '--output',
    outputDir
  ], outputDir);
}

export function runInTerminal(cwd: string, args: string[]): void {
  const terminal = vscode.window.createTerminal({
    name: terminalName,
    cwd
  });

  terminal.show();
  terminal.sendText(args.map(quoteShellArg).join(' '));
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_/:=@%+.,~-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function runPlaywrightInExtension(
  cwd: string,
  playwrightArgs: string[],
  outputDir: string
): Promise<RunTestsWithTraceResult> {
  const output = vscode.window.createOutputChannel(outputChannelName);
  const command = await resolvePlaywrightCommand(cwd, playwrightArgs);
  const startedAt = Date.now();

  output.show(true);
  output.appendLine(`$ ${command.runner} ${command.args.map(quoteShellArg).join(' ')}`);
  await clearOutputDir(path.resolve(cwd, outputDir));

  const exitCode = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Running Playwright tests',
    cancellable: false
  }, () => runProcess(cwd, command.runner, command.args, output));

  if (exitCode !== 0) {
    vscode.window.showWarningMessage(`Playwright tests finished with exit code ${exitCode}.`);
  }

  const latestTrace = await findLatestTrace(path.resolve(cwd, outputDir), startedAt);
  if (!latestTrace) {
    return { exitCode };
  }

  const tracePath = await copyLatestTrace(latestTrace, [
    path.resolve(cwd, outputDir, 'trace.zip'),
    path.resolve(cwd, 'test-results', 'latest', getLatestTraceFileName(outputDir))
  ]);
  return { tracePath, exitCode };
}

function runProcess(
  cwd: string,
  runner: string,
  args: string[],
  output: vscode.OutputChannel
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(runner, args, { cwd });

    child.stdout.on('data', (chunk: Buffer) => output.append(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => output.append(chunk.toString()));
    child.on('error', (error) => {
      output.appendLine(`Failed to run Playwright: ${error.message}`);
      vscode.window.showErrorMessage(`Failed to run Playwright: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function resolvePlaywrightCommand(
  cwd: string,
  playwrightArgs: string[]
): Promise<{ runner: string; args: string[] }> {
  const localBin = await findLocalPlaywrightBin(cwd);
  if (localBin) {
    return { runner: localBin, args: playwrightArgs };
  }

  const packageRunner = vscode.workspace
    .getConfiguration('playwrightTraceViewer')
    .get<string>('packageRunner', 'npx')
    .trim() || 'npx';

  if (packageRunner === 'npx') {
    const bundledCli = findBundledPlaywrightCli();
    if (bundledCli) {
      return { runner: process.execPath, args: [bundledCli, ...playwrightArgs] };
    }
  }

  return {
    runner: process.platform === 'win32' && packageRunner === 'npx' ? 'npx.cmd' : packageRunner,
    args: ['playwright', ...playwrightArgs]
  };
}

async function findLocalPlaywrightBin(startDir: string): Promise<string | undefined> {
  const executable = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
  let current = startDir;

  while (true) {
    const candidate = path.join(current, 'node_modules', '.bin', executable);
    if (await pathExists(candidate)) {
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
