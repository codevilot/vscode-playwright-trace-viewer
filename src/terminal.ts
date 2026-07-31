import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

const terminalName = 'Playwright Trace Viewer';
const outputChannelName = 'Playwright Trace Viewer';

export async function runTestsWithTrace(
  workspaceRoot: string,
  traceMode: 'on' | 'retain-on-failure',
  testPaths: string[] = []
): Promise<string | undefined> {
  const outputDir = getPlaywrightOutputDir(testPaths);
  const latestTracePath = await runPlaywrightInExtension(workspaceRoot, [
    'test',
    ...testPaths,
    '--trace',
    traceMode,
    '--output',
    outputDir
  ], outputDir);

  return latestTracePath;
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
): Promise<string | undefined> {
  const output = vscode.window.createOutputChannel(outputChannelName);
  const command = await resolvePlaywrightCommand(cwd, playwrightArgs);
  const startedAt = Date.now();

  output.show(true);
  output.appendLine(`$ ${command.runner} ${command.args.map(quoteShellArg).join(' ')}`);

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
    return undefined;
  }

  return copyLatestTrace(latestTrace, path.resolve(cwd, 'test-results', 'playwright-trace-viewer', 'latest', 'trace.zip'));
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

async function resolvePlaywrightCommand(
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

async function findLatestTrace(rootDir: string, startedAt: number): Promise<string | undefined> {
  const traces = await collectTraceFiles(rootDir, startedAt);
  traces.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return traces[0]?.path;
}

async function collectTraceFiles(rootDir: string, startedAt: number): Promise<Array<{ path: string; mtimeMs: number }>> {
  let entries: Array<import('fs').Dirent>;

  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const traces = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'latest') {
        return [];
      }

      return collectTraceFiles(entryPath, startedAt);
    }

    if (!entry.isFile() || entry.name !== 'trace.zip') {
      return [];
    }

    const stat = await fs.stat(entryPath);
    return stat.mtimeMs >= startedAt - 1000 ? [{ path: entryPath, mtimeMs: stat.mtimeMs }] : [];
  }));

  return traces.flat();
}

async function copyLatestTrace(sourcePath: string, targetPath: string): Promise<string> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
  return targetPath;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getPlaywrightOutputDir(testPaths: string[]): string {
  const slug = slugify(testPaths.length > 0 ? testPaths.join('-') : 'all') || 'all';

  return path.join('test-results', 'playwright-trace-viewer', slug);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[^.]+$/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
