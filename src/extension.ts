import * as vscode from 'vscode';
import { showReport } from './runner';
import { findLatestTrace, getWorkspaceRoot, validateTraceUri } from './trace';
import { runTestsWithTrace } from './terminal';
import { openTraceViewer, registerTraceViewer } from './viewer';

export function activate(context: vscode.ExtensionContext): void {
  registerTraceViewer(context);

  const openLatestTraceCommand = vscode.commands.registerCommand(
    'playwrightTraceViewer.openLatestTrace',
    openLatestTrace
  );

  const openSelectedTraceCommand = vscode.commands.registerCommand(
    'playwrightTraceViewer.openSelectedTrace',
    (uri?: vscode.Uri) => openSelectedTrace(uri)
  );

  const openReportCommand = vscode.commands.registerCommand(
    'playwrightTraceViewer.openReport',
    openReport
  );

  const runTestsWithTraceCommand = vscode.commands.registerCommand(
    'playwrightTraceViewer.runTestsWithTrace',
    () => runTests('on')
  );

  const runTestsRetainTraceCommand = vscode.commands.registerCommand(
    'playwrightTraceViewer.runTestsRetainTrace',
    () => runTests('retain-on-failure')
  );

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = 'Open PW Trace';
  statusBarItem.command = 'playwrightTraceViewer.openLatestTrace';
  statusBarItem.tooltip = 'Open the latest Playwright trace.zip';
  statusBarItem.show();

  context.subscriptions.push(
    openLatestTraceCommand,
    openSelectedTraceCommand,
    openReportCommand,
    runTestsWithTraceCommand,
    runTestsRetainTraceCommand,
    statusBarItem
  );
}

export function deactivate(): void {
  // Nothing to clean up.
}

async function openLatestTrace(): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Open a workspace folder before opening a Playwright trace.');
    return;
  }

  const tracePath = await findLatestTrace();

  if (!tracePath) {
    vscode.window.showInformationMessage(
      'No Playwright trace.zip files found. Run tests with trace enabled or update playwrightTraceViewer.traceGlob.'
    );
    return;
  }

  await openTraceViewer(tracePath);
}

async function openSelectedTrace(uri: vscode.Uri | undefined): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Open a workspace folder before opening a Playwright trace.');
    return;
  }

  const tracePath = validateTraceUri(uri);

  if (!tracePath) {
    vscode.window.showErrorMessage('Select a Playwright trace file named trace.zip.');
    return;
  }

  await openTraceViewer(tracePath);
}

function openReport(): void {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Open a workspace folder before opening a Playwright report.');
    return;
  }

  showReport(workspaceRoot);
}

function runTests(traceMode: 'on' | 'retain-on-failure'): void {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Open a workspace folder before running Playwright tests.');
    return;
  }

  runTestsWithTrace(workspaceRoot, traceMode);
}
