import * as vscode from 'vscode';

const terminalName = 'Playwright Trace Opener';

export function runTestsWithTrace(workspaceRoot: string, traceMode: 'on' | 'retain-on-failure'): void {
  const runner = resolveTerminalRunner();
  runInTerminal(workspaceRoot, [runner, 'playwright', 'test', '--trace', traceMode]);
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

function resolveTerminalRunner(): string {
  const packageRunner = vscode.workspace
    .getConfiguration('playwrightTraceOpener')
    .get<string>('packageRunner', 'npx')
    .trim() || 'npx';

  if (process.platform === 'win32' && packageRunner === 'npx') {
    return 'npx.cmd';
  }

  return packageRunner;
}
