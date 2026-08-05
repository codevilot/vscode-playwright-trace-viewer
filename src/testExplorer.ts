import { spawn } from 'child_process';
import * as syncFs from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { getWorkspaceRoot, isTraceFilePath } from './trace';
import { outputChannelName, resolvePlaywrightCommand, runInTerminal, runTestsWithTraceDetailed } from './terminal';
import { matchLocationsToTestRange, readCachedTraceSourceLocations, TraceSourceLocation } from './playwright/traceMapping';
import { findNearestWorkingDirectory, getWorkingDirectory } from './workspace/workingDirectory';

type TestNode = FolderNode | FileNode | ResultFileNode | TestSuiteNode | TestCaseNode;

type TestExplorerViewMode = 'test' | 'file';

type FolderNode = {
  type: 'folder';
  label: string;
  relativePath: string;
  files: Array<FileNode | ResultFileNode>;
  resultOnly?: boolean;
};

type FileNode = {
  type: 'file';
  label: string;
  relativePath: string;
  framework: TestFramework;
  uri: vscode.Uri;
  results: ResultFileNode[];
};

type ResultFileNode = {
  type: 'resultFile';
  label: string;
  relativePath: string;
  resultDirRelativePath: string;
  sourceFileSlugs: string[];
  traceSourceLocations?: TraceSourceLocation[];
  uri: vscode.Uri;
  mtimeMs: number;
};

type TestCaseNode = {
  type: 'test';
  label: string;
  titlePath: string[];
  relativePath: string;
  line: number;
  column: number;
  projectName?: string;
  framework: 'playwright';
  uri: vscode.Uri;
  results: ResultFileNode[];
};

type TestSuiteNode = {
  type: 'suite';
  label: string;
  titlePath: string[];
  children: Array<TestSuiteNode | TestCaseNode>;
};

type TestFramework = 'playwright' | 'vitest';

type TestFileTarget = {
  framework: TestFramework;
  uri: vscode.Uri;
  line?: number;
};

type TestRunGroup = {
  cwd: string;
  framework: TestFramework;
  testPaths: string[];
  targets: TestFileTarget[];
};

type RunTestsOptions = {
  filter?: string;
  continueOnFailure?: boolean;
  openTrace?: boolean;
};

type WebviewTestNode = {
  id: string;
  type: TestNode['type'];
  label: string;
  icon: string;
  meta?: string;
  running: boolean;
  canRun: boolean;
  canOpen: boolean;
  canCopy: boolean;
  children: WebviewTestNode[];
};

type WebviewState = {
  viewMode: TestExplorerViewMode;
  searchFilter: string;
  nodes: WebviewTestNode[];
};

export function registerPlaywrightTestExplorer(context: vscode.ExtensionContext): void {
  const provider = new PlaywrightTestProvider();
  const webviewProvider = new PlaywrightTestWebviewProvider(context.extensionUri, provider);
  const refreshResults = () => provider.refreshResults();
  let resultWatcher: vscode.FileSystemWatcher | undefined;
  const sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{spec,test}.{ts,tsx,js,jsx,mjs,cjs}');
  const configWatcher = vscode.workspace.createFileSystemWatcher('**/playwright.config.{ts,js,mjs,cjs,cts,mts}');

  const recreateResultWatcher = () => {
    resultWatcher?.dispose();
    resultWatcher = vscode.workspace.createFileSystemWatcher(getResultWatcherGlob());
    resultWatcher.onDidCreate(refreshResults);
    resultWatcher.onDidChange(refreshResults);
    resultWatcher.onDidDelete(refreshResults);
  };

  recreateResultWatcher();

  const configurationWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration('playwrightTraceViewer.traceGlob')
      || event.affectsConfiguration('playwrightTraceViewer.testResultGlob')
      || event.affectsConfiguration('playwrightTraceViewer.testGlob')
      || event.affectsConfiguration('playwrightTraceViewer.testExcludeGlobs')
      || event.affectsConfiguration('playwrightTraceViewer.testExplorerViewMode')
      || event.affectsConfiguration('playwrightTraceViewer.workingDirectory')
    ) {
      recreateResultWatcher();
      provider.refresh();
    }
  });

  sourceWatcher.onDidCreate(() => provider.refresh());
  sourceWatcher.onDidChange(() => provider.refresh());
  sourceWatcher.onDidDelete(() => provider.refresh());
  configWatcher.onDidCreate(() => provider.refresh());
  configWatcher.onDidChange(() => provider.refresh());
  configWatcher.onDidDelete(() => provider.refresh());

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('playwrightTraceViewer.tests', webviewProvider),
    configurationWatcher,
    { dispose: () => resultWatcher?.dispose() },
    sourceWatcher,
    configWatcher,
    vscode.commands.registerCommand('playwrightTraceViewer.refreshTests', () => provider.refresh()),
    vscode.commands.registerCommand('playwrightTraceViewer.searchTests', () => provider.search()),
    vscode.commands.registerCommand('playwrightTraceViewer.selectTestExplorerViewMode', () => provider.selectViewMode()),
    vscode.commands.registerCommand('playwrightTraceViewer.installDependencies', () => {
      installDependencies();
      provider.refresh();
    }),
    vscode.commands.registerCommand('playwrightTraceViewer.runAllTestsFromExplorer', (options?: RunTestsOptions) => runTests(provider, undefined, options)),
    vscode.commands.registerCommand('playwrightTraceViewer.runTestNode', (node?: TestNode) => runTests(provider, node)),
    vscode.commands.registerCommand('playwrightTraceViewer.runTests', (options?: RunTestsOptions) => runTests(provider, undefined, options)),
    vscode.commands.registerCommand('playwrightTraceViewer.openTestFile', (node?: FileNode) => openTestFile(node)),
    vscode.commands.registerCommand('playwrightTraceViewer.openResultFile', (node?: ResultFileNode) => openResultFile(node)),
    vscode.commands.registerCommand('playwrightTraceViewer.copyTestPath', (node?: TestNode) => copyTestPath(node))
  );
}

class PlaywrightTestProvider implements vscode.TreeDataProvider<TestNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TestNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private nodes: TestNode[] | undefined;
  private results: ResultFileNode[] | undefined;
  private discovery: PlaywrightDiscoveryResult | undefined;
  private searchFilter = '';
  private runningTargetKeys = new Set<string>();
  private nodeCacheVersion = 0;

  refresh(): void {
    this.nodeCacheVersion += 1;
    this.nodes = undefined;
    this.results = undefined;
    this.discovery = undefined;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  refreshResults(): void {
    this.nodeCacheVersion += 1;
    this.nodes = undefined;
    this.results = undefined;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  async search(): Promise<void> {
    const viewMode = getViewMode();
    const title = viewMode === 'test' ? 'Search Playwright tests' : 'Search Playwright test files';
    const prompt = viewMode === 'test'
      ? 'Type a test title, describe title, or file path. Leave empty to clear the filter.'
      : 'Type a file or folder name. Leave empty to clear the filter.';
    const placeHolder = viewMode === 'test'
      ? 'checkout, smoke › mobile, tests/auth.spec.ts'
      : 'login, dashboard, tests/auth';
    const value = await vscode.window.showInputBox({
      title,
      prompt,
      value: this.searchFilter,
      placeHolder
    });

    if (value === undefined) {
      return;
    }

    await this.setSearchFilter(value);
  }

  async setSearchFilter(filter: string, notify = true): Promise<boolean> {
    const normalizedFilter = filter.trim().toLowerCase();

    if (this.searchFilter === normalizedFilter) {
      return false;
    }

    this.searchFilter = normalizedFilter;
    this.nodeCacheVersion += 1;
    this.nodes = undefined;
    if (notify) {
      this.onDidChangeTreeDataEmitter.fire(undefined);
    }
    return true;
  }

  hasSearchFilter(): boolean {
    return this.searchFilter.length > 0;
  }

  getSearchFilter(): string {
    return this.searchFilter;
  }

  async getVisibleNodes(): Promise<TestNode[]> {
    if (!this.nodes) {
      const cacheVersion = this.nodeCacheVersion;
      const nodes = await this.discoverNodes();
      if (this.nodeCacheVersion === cacheVersion) {
        this.nodes = nodes;
      }
      return nodes;
    }

    return this.nodes;
  }

  async selectViewMode(): Promise<void> {
    const currentMode = getViewMode();
    const selected = await vscode.window.showQuickPick([
      {
        label: 'View by Test Name',
        description: 'Use describe hierarchy and test() titles',
        mode: 'test' as const,
        picked: currentMode === 'test'
      },
      {
        label: 'View by File Name',
        description: 'Use folders and test file paths',
        mode: 'file' as const,
        picked: currentMode === 'file'
      }
    ], {
      title: 'Change Test Explorer View',
      placeHolder: 'Choose how tests are shown'
    });

    if (!selected || selected.mode === currentMode) {
      return;
    }

    await vscode.workspace
      .getConfiguration('playwrightTraceViewer')
      .update('testExplorerViewMode', selected.mode, vscode.ConfigurationTarget.Workspace);
    this.searchFilter = '';
    this.refresh();
  }

  async getChildren(element?: TestNode): Promise<TestNode[]> {
    if (element?.type === 'folder') {
      return element.files;
    }

    if (element?.type === 'suite') {
      return element.children;
    }

    if (element?.type === 'test') {
      return element.results;
    }

    if (element?.type === 'file') {
      return element.results;
    }

    if (element) {
      return [];
    }

    if (!this.nodes) {
      this.nodes = await this.discoverNodes();
    }

    return this.nodes;
  }

  getTreeItem(element: TestNode): vscode.TreeItem {
    if (element.type === 'suite') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'playwrightTestSuite';
      item.iconPath = this.isNodeRunning(element)
        ? new vscode.ThemeIcon('loading~spin')
        : new vscode.ThemeIcon('symbol-namespace');
      item.tooltip = element.titlePath.join(' › ');
      return item;
    }

    if (element.type === 'test') {
      const item = new vscode.TreeItem(
        element.label,
        element.results.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
      );
      item.description = `${path.basename(element.relativePath)}:${element.line}`;
      item.contextValue = 'playwrightTestCase';
      item.iconPath = this.isNodeRunning(element)
        ? new vscode.ThemeIcon('loading~spin')
        : new vscode.ThemeIcon('beaker');
      item.resourceUri = element.uri;
      item.tooltip = [
        element.titlePath.join(' › '),
        `${element.relativePath}:${element.line}`,
        element.projectName ? `Project: ${element.projectName}` : undefined
      ].filter(Boolean).join('\n');
      item.command = {
        command: 'playwrightTraceViewer.openTestFile',
        title: 'Open Test File',
        arguments: [element]
      };
      return item;
    }

    if (element.type === 'folder') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${element.files.length}`;
      item.contextValue = element.resultOnly ? 'playwrightResultFolder' : 'playwrightTestFolder';
      item.iconPath = this.isNodeRunning(element)
        ? new vscode.ThemeIcon('loading~spin')
        : new vscode.ThemeIcon('folder');
      item.tooltip = element.relativePath;
      return item;
    }

    if (element.type === 'resultFile') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.description = path.basename(element.resultDirRelativePath);
      item.contextValue = 'playwrightResultFile';
      item.iconPath = getResultFileIcon(element.relativePath);
      item.resourceUri = element.uri;
      item.tooltip = element.relativePath;
      item.command = {
        command: 'playwrightTraceViewer.openResultFile',
        title: 'Open Test Result File',
        arguments: [element]
      };
      return item;
    }

    const item = new vscode.TreeItem(
      element.label,
      element.results.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    item.description = path.dirname(element.relativePath);
    item.contextValue = 'playwrightTestFile';
    item.iconPath = this.isNodeRunning(element)
      ? new vscode.ThemeIcon('loading~spin')
      : new vscode.ThemeIcon(element.framework === 'vitest' ? 'testing-view-icon' : 'beaker');
    item.resourceUri = element.uri;
    item.tooltip = `${element.framework}: ${element.relativePath}`;
    item.command = {
      command: 'playwrightTraceViewer.openTestFile',
      title: 'Open Test File',
      arguments: [element]
    };
    return item;
  }

  setRunningTarget(target: TestFileTarget, running: boolean): void {
    const key = getTestTargetKey(target);
    if (running) {
      this.runningTargetKeys.add(key);
    } else {
      this.runningTargetKeys.delete(key);
    }
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  isNodeRunningForWebview(node: TestNode): boolean {
    return this.isNodeRunning(node);
  }

  private isNodeRunning(node: TestNode): boolean {
    if (node.type === 'file' || node.type === 'test') {
      return this.runningTargetKeys.has(getTestTargetKey(node));
    }

    if (node.type === 'folder') {
      return node.files.some((child) => this.isNodeRunning(child));
    }

    if (node.type === 'suite') {
      return node.children.some((child) => this.isNodeRunning(child));
    }

    return false;
  }

  private async discoverNodes(): Promise<TestNode[]> {
    if (!this.results) {
      this.results = await discoverResults();
    }

    const viewMode = getViewMode();

    if (viewMode === 'file') {
      return discoverFileView(this.searchFilter, this.results);
    }

    this.discovery ??= await discoverPlaywrightTests();
    if (this.discovery.error) {
      vscode.window.showWarningMessage(`${this.discovery.error} Showing file name view instead.`);
      return discoverFileView(this.searchFilter, this.results);
    }

    const tests = attachResultsToTests(this.discovery.tests, this.results);
    const nodes: TestNode[] = buildTestView(tests, this.searchFilter);
    const vitestNodes = await discoverFileView(this.searchFilter, [], new Set<TestFramework>(['vitest']));
    nodes.push(...vitestNodes);
    if (nodes.length > 0 || this.searchFilter) {
      return nodes;
    }

    return discoverFileView(this.searchFilter, this.results);
  }
}

class PlaywrightTestWebviewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private didSetHtml = false;
  private stateUpdateVersion = 0;
  private nodesById = new Map<string, TestNode>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly provider: PlaywrightTestProvider
  ) {
    this.provider.onDidChangeTreeData(() => this.refresh());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    view.webview.onDidReceiveMessage((message: { command?: string; id?: string; value?: string }) => {
      void this.handleMessage(message);
    });
    this.didSetHtml = false;
    void this.refresh();
  }

  private async handleMessage(message: { command?: string; id?: string; value?: string }): Promise<void> {
    if (message.command === 'refresh') {
      this.provider.refresh();
      return;
    }

    if (message.command === 'search') {
      const changed = await this.provider.setSearchFilter(message.value ?? '', false);
      if (changed) {
        await this.updateState();
      }
      return;
    }

    if (message.command === 'viewMode') {
      await this.provider.selectViewMode();
      return;
    }

    const node = message.id ? this.nodesById.get(message.id) : undefined;

    if (message.command === 'run') {
      await runTests(this.provider, node);
    } else if (message.command === 'open') {
      if (node?.type === 'file' || node?.type === 'test') {
        await openTestFile(node);
      } else if (node?.type === 'resultFile') {
        await openResultFile(node);
      }
    } else if (message.command === 'copy') {
      await copyTestPath(node);
    }
  }

  private async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }

    const updateVersion = ++this.stateUpdateVersion;
    const state = await this.getState();
    if (updateVersion !== this.stateUpdateVersion) {
      return;
    }

    if (!this.didSetHtml) {
      this.view.webview.html = this.getHtml(this.view.webview, state);
      this.didSetHtml = true;
      return;
    }

    await this.view.webview.postMessage({ command: 'state', state });
  }

  private async updateState(): Promise<void> {
    if (!this.view || !this.didSetHtml) {
      await this.refresh();
      return;
    }

    const updateVersion = ++this.stateUpdateVersion;
    const state = await this.getState();
    if (updateVersion !== this.stateUpdateVersion) {
      return;
    }

    await this.view.webview.postMessage({ command: 'state', state });
  }

  private async getState(): Promise<WebviewState> {
    const nodes = await this.provider.getVisibleNodes();
    this.nodesById = new Map<string, TestNode>();
    return {
      viewMode: getViewMode(),
      searchFilter: this.provider.getSearchFilter(),
      nodes: this.toWebviewNodes(nodes, [])
    };
  }

  private toWebviewNodes(nodes: TestNode[], pathParts: number[]): WebviewTestNode[] {
    return nodes.map((node, index) => {
      const id = [...pathParts, index].join('.');
      const children = this.getChildren(node);
      this.nodesById.set(id, node);
      return {
        id,
        type: node.type,
        label: node.label,
        icon: this.getIcon(node),
        meta: this.getMeta(node),
        running: this.provider.isNodeRunningForWebview(node),
        canRun: node.type === 'file' || node.type === 'folder' || node.type === 'suite' || node.type === 'test',
        canOpen: node.type === 'file' || node.type === 'test' || node.type === 'resultFile',
        canCopy: node.type === 'file' || node.type === 'test' || node.type === 'resultFile',
        children: this.toWebviewNodes(children, [...pathParts, index])
      };
    });
  }

  private getChildren(node: TestNode): TestNode[] {
    if (node.type === 'folder') {
      return node.files;
    }
    if (node.type === 'suite') {
      return node.children;
    }
    if (node.type === 'file' || node.type === 'test') {
      return node.results;
    }
    return [];
  }

  private getMeta(node: TestNode): string | undefined {
    let meta: string | undefined;

    if (node.type === 'test') {
      meta = `${node.relativePath}:${node.line}`;
    } else if (node.type === 'file') {
      const directory = path.dirname(node.relativePath);
      meta = [node.framework, directory === '.' ? undefined : directory].filter(Boolean).join(' · ');
    } else if (node.type === 'folder') {
      meta = `${node.files.length} ${node.files.length === 1 ? 'item' : 'items'}`;
    } else if (node.type === 'resultFile') {
      meta = node.resultDirRelativePath === node.label ? undefined : node.resultDirRelativePath;
    } else {
      meta = node.titlePath.slice(0, -1).join(' > ');
    }

    return this.getDistinctMeta(node.label, meta);
  }

  private getDistinctMeta(label: string, meta: string | undefined): string | undefined {
    const normalizedMeta = meta?.trim();

    if (!normalizedMeta || normalizedMeta === label) {
      return undefined;
    }

    return normalizedMeta;
  }

  private getIcon(node: TestNode): string {
    if (node.type === 'folder') {
      return 'folder';
    }
    if (node.type === 'resultFile') {
      return isTraceFilePath(node.relativePath) ? 'preview' : 'file';
    }
    if (node.type === 'suite') {
      return 'suite';
    }
    if (node.type === 'file') {
      return node.framework === 'vitest' ? 'vitest' : 'file';
    }
    return 'test';
  }

  private getHtml(webview: vscode.Webview, state: WebviewState): string {
    const nonce = getNonce();
    const serializedState = JSON.stringify(state).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      padding: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 1;
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 2px;
      padding: 3px 8px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
    }
    input {
      min-width: 0;
      height: 24px;
      box-sizing: border-box;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      padding: 2px 8px;
      outline: none;
    }
    input:focus { border-color: var(--vscode-focusBorder); }
    button {
      height: 24px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border: 0;
      padding: 0 8px;
      font: inherit;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .tree { padding: 1px 0 4px 0; }
    .empty {
      padding: 12px;
      color: var(--vscode-descriptionForeground);
    }
    details {
      margin: 0;
      padding: 0;
    }
    summary {
      display: block;
      list-style: none;
      margin: 0;
      padding: 0;
      cursor: default;
    }
    summary::-webkit-details-marker { display: none; }
    .row {
      display: grid;
      grid-template-columns: 8px 14px 1fr auto;
      gap: 1px;
      align-items: start;
      min-height: 20px;
      padding: 1px 8px;
      box-sizing: border-box;
    }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row.openable { cursor: pointer; }
    .twisty {
      display: inline-block;
      color: var(--vscode-descriptionForeground);
      line-height: 17px;
      user-select: none;
    }
    details[open] > summary .twisty { transform: rotate(90deg); }
    .icon {
      width: 14px;
      height: 17px;
      color: var(--vscode-symbolIcon-classForeground, var(--vscode-foreground));
      text-align: center;
      line-height: 17px;
      font-size: 12px;
      user-select: none;
    }
    .folder .icon { color: var(--vscode-symbolIcon-folderForeground, var(--vscode-foreground)); }
    .suite .icon { color: var(--vscode-symbolIcon-namespaceForeground, var(--vscode-foreground)); }
    .test .icon { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
    .file .icon { color: var(--vscode-symbolIcon-fileForeground, var(--vscode-foreground)); }
    .resultFile .icon { color: var(--vscode-charts-blue, var(--vscode-foreground)); }
    .content {
      min-width: 0;
      line-height: 16px;
      padding-top: 0;
    }
    .label {
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: normal;
    }
    .folder > .icon + .content .label,
    .suite > .icon + .content .label {
      font-weight: 600;
    }
    .meta {
      color: var(--vscode-descriptionForeground);
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: normal;
      font-size: 0.92em;
      margin-top: 0;
    }
    .actions {
      display: flex;
      gap: 0;
      visibility: hidden;
      padding-top: 0;
    }
    .row:hover .actions,
    .row:focus-within .actions {
      visibility: visible;
    }
    .action {
      width: 18px;
      height: 20px;
      padding: 0;
      border-radius: 3px;
    }
    .children {
      margin-left: 2px;
      padding-left: 2px;
      border-left: 1px solid var(--vscode-tree-indentGuidesStroke);
    }
    .running .label {
      color: var(--vscode-testing-iconQueued);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <input id="search" type="search" placeholder="${state.viewMode === 'test' ? 'Search tests' : 'Search files'}" aria-label="Search">
    <button id="viewMode" title="Change view mode">${state.viewMode === 'test' ? 'Test' : 'File'}</button>
    <button id="refresh" title="Refresh">Refresh</button>
  </div>
  <main id="tree" class="tree"></main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = ${serializedState};
    const tree = document.getElementById('tree');
    const search = document.getElementById('search');
    const viewMode = document.getElementById('viewMode');
    search.value = state.searchFilter;
    const renderText = value => String(value ?? '');
    const icons = {
      folder: '▣',
      suite: '◇',
      test: '✓',
      file: '▤',
      vitest: 'V',
      preview: '◉'
    };

    function post(command, id, value) {
      vscode.postMessage({ command, id, value });
    }

    function createAction(label, title, command, id) {
      const button = document.createElement('button');
      button.className = 'action';
      button.type = 'button';
      button.textContent = label;
      button.title = title;
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        post(command, id);
      });
      return button;
    }

    function renderNode(node) {
      const hasChildren = node.children.length > 0;
      const wrapper = document.createElement(hasChildren ? 'details' : 'div');
      if (hasChildren) {
        wrapper.open = true;
      }

      const rowParent = hasChildren ? document.createElement('summary') : wrapper;
      const row = document.createElement('div');
      row.className = 'row ' + node.type + (node.running ? ' running' : '') + (node.canOpen ? ' openable' : '');
      row.title = [node.label, node.meta].filter(Boolean).join('\\n');
      if (node.canOpen) {
        row.tabIndex = 0;
        row.addEventListener('click', event => {
          event.preventDefault();
          post('open', node.id);
        });
        row.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            post('open', node.id);
          }
        });
      }

      const twisty = document.createElement('span');
      twisty.className = 'twisty';
      twisty.textContent = hasChildren ? '›' : '';
      if (hasChildren) {
        twisty.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          wrapper.open = !wrapper.open;
        });
      }
      row.appendChild(twisty);

      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = icons[node.icon] || '•';
      row.appendChild(icon);

      const content = document.createElement('span');
      content.className = 'content';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = renderText(node.label);
      content.appendChild(label);
      if (node.meta) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = renderText(node.meta);
        content.appendChild(meta);
      }
      row.appendChild(content);

      const actions = document.createElement('span');
      actions.className = 'actions';
      if (node.canRun) {
        actions.appendChild(createAction('▶', 'Run', 'run', node.id));
      }
      row.appendChild(actions);

      rowParent.appendChild(row);
      if (hasChildren) {
        wrapper.appendChild(rowParent);
        const children = document.createElement('div');
        children.className = 'children';
        node.children.forEach(child => children.appendChild(renderNode(child)));
        wrapper.appendChild(children);
      }

      return wrapper;
    }

    function renderState(nextState) {
      state = nextState;
      search.placeholder = state.viewMode === 'test' ? 'Search tests' : 'Search files';
      if (document.activeElement !== search) {
        search.value = state.searchFilter;
      }
      viewMode.textContent = state.viewMode === 'test' ? 'Test' : 'File';
      tree.replaceChildren();

      if (state.nodes.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No tests found.';
        tree.appendChild(empty);
      } else {
        state.nodes.forEach(node => tree.appendChild(renderNode(node)));
      }
    }

    renderState(state);

    window.addEventListener('message', event => {
      if (event.data?.command === 'state') {
        renderState(event.data.state);
      }
    });

    let searchTimer;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => post('search', undefined, search.value), 200);
    });
    viewMode.addEventListener('click', () => post('viewMode'));
    document.getElementById('refresh').addEventListener('click', () => post('refresh'));
  </script>
</body>
</html>`;
  }
}

type PlaywrightDiscoveryResult = {
  tests: TestCaseNode[];
  error?: string;
};

type JsonObject = Record<string, unknown>;

type PlaywrightDiscoveryContext = {
  projectNames: Map<string, string>;
  testDirs: string[];
};

async function discoverPlaywrightTests(): Promise<PlaywrightDiscoveryResult> {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    return { tests: [] };
  }

  const workingDirectory = getWorkingDirectory() ?? workspaceRoot;
  const output = vscode.window.createOutputChannel(outputChannelName);
  const playwrightArgs = ['test', '--list', '--reporter=json'];
  const command = await resolvePlaywrightCommand(workingDirectory, playwrightArgs);

  output.appendLine(`$ ${command.runner} ${command.args.map(quoteShellArg).join(' ')}`);

  const result = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Discovering Playwright tests',
    cancellable: false
  }, () => runDiscoveryProcess(workingDirectory, command.runner, command.args, output));

  if (result.exitCode !== 0) {
    output.show(true);
    return { tests: [], error: `Playwright test discovery failed with exit code ${result.exitCode}.` };
  }

  const jsonText = extractJsonObject(result.stdout);
  if (!jsonText) {
    output.show(true);
    output.appendLine('Could not find JSON reporter output in Playwright --list output.');
    return { tests: [], error: 'Playwright test discovery did not produce JSON output.' };
  }

  try {
    return { tests: parsePlaywrightJsonReport(JSON.parse(jsonText), workspaceRoot, workingDirectory) };
  } catch (error) {
    output.show(true);
    output.appendLine(`Failed to parse Playwright JSON reporter output: ${String(error)}`);
    return { tests: [], error: 'Playwright test discovery output could not be parsed.' };
  }
}

function runDiscoveryProcess(
  cwd: string,
  runner: string,
  args: string[],
  output: vscode.OutputChannel
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(runner, args, { cwd });
    let stdout = '';

    child.stdout.on('data', (chunk: Buffer) => {
      const value = chunk.toString();
      stdout += value;
      output.append(value);
    });
    child.stderr.on('data', (chunk: Buffer) => output.append(chunk.toString()));
    child.on('error', (error) => {
      output.appendLine(`Failed to run Playwright discovery: ${error.message}`);
      vscode.window.showErrorMessage(`Failed to run Playwright discovery: ${error.message}`);
      resolve({ exitCode: 1, stdout });
    });
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout }));
  });
}

function parsePlaywrightJsonReport(report: unknown, workspaceRoot: string, discoveryRoot: string): TestCaseNode[] {
  if (!isJsonObject(report)) {
    return [];
  }

  const context = getDiscoveryContext(report.config);
  const suites = Array.isArray(report.suites) ? report.suites : [];

  return suites.flatMap((suite) => collectSuiteTests(suite, [], workspaceRoot, discoveryRoot, context));
}

function collectSuiteTests(
  suite: unknown,
  parentTitles: string[],
  workspaceRoot: string,
  discoveryRoot: string,
  context: PlaywrightDiscoveryContext
): TestCaseNode[] {
  if (!isJsonObject(suite)) {
    return [];
  }

  const suiteTitle = shouldIncludeSuiteTitle(suite) ? suite.title as string : undefined;
  const suiteTitles = suiteTitle ? [...parentTitles, suiteTitle] : parentTitles;
  const children: TestCaseNode[] = [];

  if (Array.isArray(suite.specs)) {
    for (const spec of suite.specs) {
      children.push(...collectSpecTests(spec, suiteTitles, workspaceRoot, discoveryRoot, context));
    }
  }

  if (Array.isArray(suite.suites)) {
    for (const childSuite of suite.suites) {
      children.push(...collectSuiteTests(childSuite, suiteTitles, workspaceRoot, discoveryRoot, context));
    }
  }

  return children;
}

function shouldIncludeSuiteTitle(suite: JsonObject): boolean {
  return typeof suite.title === 'string'
    && suite.title.length > 0
    && (typeof suite.line !== 'number' || suite.line > 0);
}

function collectSpecTests(
  spec: unknown,
  parentTitles: string[],
  workspaceRoot: string,
  discoveryRoot: string,
  context: PlaywrightDiscoveryContext
): TestCaseNode[] {
  if (!isJsonObject(spec)) {
    return [];
  }

  const specTitle = typeof spec.title === 'string' ? spec.title : 'Unnamed test';
  const titlePath = [...parentTitles, specTitle];
  const location = getLocation(spec);
  const file = location.file;

  if (!file) {
    return [];
  }

  const absolutePath = resolveDiscoveredFilePath(file, discoveryRoot, context.testDirs);
  const relativePath = normalizeRelativePath(path.relative(workspaceRoot, absolutePath));
  const uri = vscode.Uri.file(absolutePath);
  const tests = Array.isArray(spec.tests) && spec.tests.length > 0 ? spec.tests : [undefined];

  return tests.map((test) => ({
    type: 'test' as const,
    label: specTitle,
    titlePath,
    relativePath,
    line: location.line,
    column: location.column,
    projectName: getProjectName(test, context.projectNames),
    framework: 'playwright' as const,
    uri,
    results: []
  }));
}

function getProjectName(test: unknown, projectNames: Map<string, string>): string | undefined {
  if (!isJsonObject(test)) {
    return undefined;
  }

  if (typeof test.projectName === 'string') {
    return test.projectName;
  }

  if (typeof test.projectId === 'string') {
    return projectNames.get(test.projectId) ?? test.projectId;
  }

  return undefined;
}

function getDiscoveryContext(config: unknown): PlaywrightDiscoveryContext {
  const projectNames = new Map<string, string>();
  const testDirs = new Set<string>();

  if (!isJsonObject(config) || !Array.isArray(config.projects)) {
    return { projectNames, testDirs: [] };
  }

  for (const project of config.projects) {
    if (!isJsonObject(project)) {
      continue;
    }

    const id = typeof project.id === 'string' ? project.id : undefined;
    const name = typeof project.name === 'string' ? project.name : id;

    if (id && name) {
      projectNames.set(id, name);
    }

    if (typeof project.testDir === 'string') {
      testDirs.add(project.testDir);
    }
  }

  return { projectNames, testDirs: [...testDirs] };
}

function resolveDiscoveredFilePath(file: string, workspaceRoot: string, testDirs: string[]): string {
  if (path.isAbsolute(file)) {
    return file;
  }

  for (const testDir of testDirs) {
    const candidate = path.join(testDir, file);
    if (path.isAbsolute(testDir) && syncFs.existsSync(candidate)) {
      return candidate;
    }
  }

  const workspaceCandidate = path.join(workspaceRoot, file);
  if (syncFs.existsSync(workspaceCandidate)) {
    return workspaceCandidate;
  }

  const firstAbsoluteTestDir = testDirs.find((testDir) => path.isAbsolute(testDir));
  if (firstAbsoluteTestDir) {
    return path.join(firstAbsoluteTestDir, file);
  }

  return workspaceCandidate;
}

function getLocation(value: JsonObject): { file: string; line: number; column: number } {
  const location = isJsonObject(value.location) ? value.location : value;
  return {
    file: typeof location.file === 'string' ? location.file : '',
    line: typeof location.line === 'number' ? location.line : 1,
    column: typeof location.column === 'number' ? location.column : 1
  };
}

function buildTestView(tests: TestCaseNode[], searchFilter: string): Array<TestSuiteNode | TestCaseNode> {
  const filteredTests = searchFilter
    ? tests.filter((test) => doesTestMatchFilter(test, searchFilter))
    : tests;
  const roots: Array<TestSuiteNode | TestCaseNode> = [];

  for (const test of filteredTests) {
    const suiteTitles = [
      ...getFolderTitlePath(test.relativePath),
      ...test.titlePath.slice(0, -1)
    ];

    if (suiteTitles.length === 0) {
      roots.push(test);
      continue;
    }

    let siblings: Array<TestSuiteNode | TestCaseNode> = roots;
    const suitePath: string[] = [];

    for (const suiteTitle of suiteTitles) {
      suitePath.push(suiteTitle);
      let suite = siblings.find((child): child is TestSuiteNode => {
        return child.type === 'suite' && child.titlePath.join('\0') === suitePath.join('\0');
      });

      if (!suite) {
        suite = { type: 'suite', label: suiteTitle, titlePath: [...suitePath], children: [] };
        siblings.push(suite);
      }

      siblings = suite.children;
    }

    siblings.push(test);
  }

  return sortSuitesAndTests(roots);
}

function getFolderTitlePath(relativePath: string): string[] {
  const folder = path.dirname(relativePath).replace(/\\/g, '/');

  if (!folder || folder === '.') {
    return [];
  }

  return [`[${folder}]`];
}

function attachResultsToTests(tests: TestCaseNode[], resultFiles: ResultFileNode[]): TestCaseNode[] {
  const testRelativePaths = [...new Set(tests.map((test) => test.relativePath))];
  const testCountByFile = tests.reduce((counts, test) => {
    counts.set(test.relativePath, (counts.get(test.relativePath) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());

  return tests.map((test) => ({
    ...test,
    results: getChildResults(matchResultsToTestCase(test, tests, resultFiles, testRelativePaths, testCountByFile.get(test.relativePath) === 1))
  }));
}

function matchResultsToTestCase(
  test: TestCaseNode,
  tests: TestCaseNode[],
  resultFiles: ResultFileNode[],
  testRelativePaths: string[],
  isOnlyTestInFile: boolean
): ResultFileNode[] {
  const range = {
    relativePath: test.relativePath,
    line: test.line,
    nextLine: getNextTestLine(test, tests)
  };
  const locationMatches = resultFiles.filter((result) => {
    return matchLocationsToTestRange(result.traceSourceLocations, range) === true;
  });

  if (locationMatches.length > 0) {
    return locationMatches;
  }

  const sourceMatches = matchResultsToTestFile(test.relativePath, resultFiles, testRelativePaths);
  const titleSlug = slugify(test.label);
  const titlePathSlug = slugify(test.titlePath.join('-'));

  if (!titleSlug) {
    return [];
  }

  return sourceMatches.filter((result) => {
    const resultSlug = canonicalizeResultDirName(path.basename(result.resultDirRelativePath));
    return isOnlyTestInFile
      || resultSlug.includes(titleSlug)
      || (!!titlePathSlug && resultSlug.includes(titlePathSlug))
      || doesResultSlugPartiallyMatchTitle(resultSlug, titleSlug);
  });
}

function getNextTestLine(test: TestCaseNode, tests: TestCaseNode[]): number | undefined {
  return tests
    .filter((candidate) => candidate.relativePath === test.relativePath && candidate.line > test.line)
    .sort((a, b) => a.line - b.line)[0]?.line;
}

function doesResultSlugPartiallyMatchTitle(resultSlug: string, titleSlug: string): boolean {
  const titleParts = titleSlug.split('-').filter((part) => part.length >= 3);

  if (titleParts.length === 0) {
    return false;
  }

  return titleParts
    .slice(0, Math.min(titleParts.length, 4))
    .every((part) => resultSlug.includes(part));
}

function sortSuitesAndTests<T extends TestSuiteNode | TestCaseNode>(nodes: T[]): T[] {
  nodes.sort((a, b) => a.label.localeCompare(b.label));
  for (const node of nodes) {
    if (node.type === 'suite') {
      node.children = sortSuitesAndTests(node.children);
    }
  }
  return nodes;
}

function doesTestMatchFilter(test: TestCaseNode, filter: string): boolean {
  return [
    test.label,
    test.titlePath.join(' '),
    test.titlePath.join(' › '),
    test.relativePath,
    path.basename(test.relativePath)
  ].some((value) => value.toLowerCase().includes(filter));
}

function extractJsonObject(output: string): string | undefined {
  const start = output.indexOf('{');

  if (start === -1) {
    return undefined;
  }

  for (let end = output.length - 1; end >= start; end -= 1) {
    if (output[end] !== '}') {
      continue;
    }

    const candidate = output.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Keep looking for the matching end brace.
    }
  }

  return undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getViewMode(): TestExplorerViewMode {
  return vscode.workspace
    .getConfiguration('playwrightTraceViewer')
    .get<TestExplorerViewMode>('testExplorerViewMode', 'test');
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_/:=@%+.,~-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';

  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return nonce;
}

async function discoverFileView(
  fileNameFilter: string,
  resultFiles: ResultFileNode[],
  frameworks?: Set<TestFramework>
): Promise<FolderNode[]> {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    return [];
  }

  const files = await vscode.workspace.findFiles(getTestGlob(), getExcludeGlob());
  const testFiles = (await filterTestFiles(files))
    .filter((file) => !frameworks || frameworks.has(file.framework));
  const filteredTestFiles = fileNameFilter
    ? testFiles.filter((file) => {
      const relativePath = path.relative(workspaceRoot, file.uri.fsPath).toLowerCase();
      return relativePath.includes(fileNameFilter);
    })
    : testFiles;
  const folders = new Map<string, Array<FileNode | ResultFileNode>>();
  const matchedResultPaths = new Set<string>();
  const testRelativePaths = testFiles.map((file) => path.relative(workspaceRoot, file.uri.fsPath));

  for (const testFile of filteredTestFiles) {
    const uri = testFile.uri;
    const relativePath = path.relative(workspaceRoot, uri.fsPath);
    const folder = path.dirname(relativePath);
    const fileNode: FileNode = {
      type: 'file',
      label: path.basename(relativePath),
      relativePath,
      framework: testFile.framework,
      uri,
      results: testFile.framework === 'playwright'
        ? getChildResults(matchResultsToTestFile(relativePath, resultFiles, testRelativePaths))
        : []
    };

    const group = folders.get(folder) ?? [];
    group.push(fileNode);
    fileNode.results.forEach((result) => matchedResultPaths.add(result.uri.fsPath));
    folders.set(folder, group);
  }

  const nodes: FolderNode[] = [...folders.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([relativePath, filesInFolder]) => ({
      type: 'folder' as const,
      label: relativePath === '.' ? 'Workspace Root' : relativePath,
      relativePath,
      files: filesInFolder.sort(compareTestExplorerItems)
    }));
  const unmatchedResults = resultFiles.filter((result) => !matchedResultPaths.has(result.uri.fsPath));

  if (!fileNameFilter && unmatchedResults.length > 0) {
    const resultNode = getTestResultsFolder(unmatchedResults);
    if (resultNode) {
      nodes.push(resultNode);
    }
  }

  return nodes;
}

function compareTestExplorerItems(a: FileNode | ResultFileNode, b: FileNode | ResultFileNode): number {
  const aBaseLabel = a.label;
  const bBaseLabel = b.label;
  const labelComparison = aBaseLabel.localeCompare(bBaseLabel);

  if (labelComparison !== 0) {
    return labelComparison;
  }

  if (a.type !== b.type) {
    return a.type === 'file' ? -1 : 1;
  }

  return a.label.localeCompare(b.label);
}

function getTestResultsFolder(resultFiles: ResultFileNode[]): FolderNode | undefined {
  if (resultFiles.length === 0) {
    return undefined;
  }

  return {
    type: 'folder',
    label: 'Test Results',
    relativePath: 'test-results',
    files: resultFiles.map((result) => ({
      ...result,
      label: getStandaloneResultLabel(result)
    })),
    resultOnly: true
  };
}

function getChildResults(results: ResultFileNode[]): ResultFileNode[] {
  return results.map((result) => ({
    ...result,
    label: getChildResultLabel(result, results)
  }));
}

function getChildResultLabel(result: ResultFileNode, results: ResultFileNode[]): string {
  if (!isTraceFilePath(result.relativePath)) {
    return path.basename(result.relativePath);
  }

  const traceCount = results.filter((candidate) => isTraceFilePath(candidate.relativePath)).length;

  return traceCount > 1
    ? `trace (${path.basename(result.resultDirRelativePath)})`
    : 'trace';
}

function getStandaloneResultLabel(result: ResultFileNode): string {
  const resultDir = path.basename(result.resultDirRelativePath);
  const fileName = isTraceFilePath(result.relativePath) ? 'trace' : path.basename(result.relativePath);

  return `${resultDir}-${fileName}`;
}

async function discoverResults(): Promise<ResultFileNode[]> {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    return [];
  }

  const files = await vscode.workspace.findFiles(getResultGlob());
  const traceLocationsByResultDir = new Map<string, Promise<TraceSourceLocation[] | undefined>>();
  const resultFiles = await Promise.all(
    files.map(async (uri): Promise<ResultFileNode | undefined> => {
      try {
        const stat = await fs.stat(uri.fsPath);

        const relativePath = path.relative(workspaceRoot, uri.fsPath);

        if (!stat.isFile() || !isVisibleResultFile(relativePath)) {
          return undefined;
        }

        const resultDirRelativePath = getResultDirRelativePath(relativePath);
        const resultDirPath = path.join(workspaceRoot, resultDirRelativePath);
        let traceLocationsPromise = traceLocationsByResultDir.get(resultDirPath);
        if (!traceLocationsPromise) {
          const tracePath = isTraceFilePath(relativePath)
            ? uri.fsPath
            : path.join(resultDirPath, 'trace.zip');
          traceLocationsPromise = readCachedTraceSourceLocations(tracePath, workspaceRoot);
          traceLocationsByResultDir.set(resultDirPath, traceLocationsPromise);
        }

        return {
          type: 'resultFile' as const,
          label: path.basename(relativePath),
          relativePath,
          resultDirRelativePath,
          sourceFileSlugs: await getResultSourceFileSlugs(resultDirPath),
          traceSourceLocations: await traceLocationsPromise,
          uri,
          mtimeMs: stat.mtimeMs
        };
      } catch {
        return undefined;
      }
    })
  );
  return getLatestResultDirs(resultFiles
    .filter((file): file is ResultFileNode => !!file)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.relativePath.localeCompare(b.relativePath)));
}

function getLatestResultDirs(resultFiles: ResultFileNode[]): ResultFileNode[] {
  const resultDirs = new Map<string, ResultFileNode[]>();

  for (const file of resultFiles) {
    const group = resultDirs.get(file.resultDirRelativePath) ?? [];
    group.push(file);
    resultDirs.set(file.resultDirRelativePath, group);
  }

  const latestByResultKey = new Map<string, ResultFileNode[]>();

  for (const files of resultDirs.values()) {
    const key = getResultDirDedupeKey(files);
    const existing = latestByResultKey.get(key);

    if (!existing || getResultDirMtime(files) > getResultDirMtime(existing)) {
      latestByResultKey.set(key, files);
    }
  }

  return [...latestByResultKey.values()]
    .flat()
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.relativePath.localeCompare(b.relativePath));
}

function getResultDirDedupeKey(files: ResultFileNode[]): string {
  const firstFile = files[0];

  if (!firstFile) {
    return '';
  }

  const sourceKey = firstFile.sourceFileSlugs.length > 0
    ? [...firstFile.sourceFileSlugs].sort().join(',')
    : 'unknown-source';

  return `${sourceKey}\0${canonicalizeResultDirName(path.basename(firstFile.resultDirRelativePath))}`;
}

function getResultDirMtime(files: ResultFileNode[]): number {
  return Math.max(...files.map((file) => file.mtimeMs));
}

function canonicalizeResultDirName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/-(chromium|firefox|webkit)$/i, '')
    .replace(/-[a-f0-9]{5,}(?=-|$)/gi, '')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function matchResultsToTestFile(
  relativePath: string,
  resultFiles: ResultFileNode[],
  testRelativePaths: string[]
): ResultFileNode[] {
  const candidates = getTestResultSlugCandidates(relativePath);
  const sourceSlug = getSourceFileSlugCandidate(relativePath);
  const isSourceSlugAmbiguous = testRelativePaths
    .filter((testPath) => getSourceFileSlugCandidate(testPath) === sourceSlug)
    .length > 1;

  return resultFiles.filter((file) => {
    if (file.traceSourceLocations?.some((location) => location.relativePath === normalizeRelativePath(relativePath))) {
      return true;
    }

    if (!isSourceSlugAmbiguous && file.sourceFileSlugs.some((slug) => slug === sourceSlug || slug.startsWith(`${sourceSlug}-`))) {
      return true;
    }

    const packageRoot = getResultPackageRootRelativePath(file.resultDirRelativePath);
    const resultSlugs = getResultPathSlugs(file.resultDirRelativePath);
    const packageScopedCandidates = packageRoot && isPathInside(relativePath, packageRoot)
      ? getTestResultSlugCandidates(path.relative(packageRoot, relativePath))
      : [];

    if (packageScopedCandidates.some((candidate) => resultSlugs.some((slug) => slug === candidate || slug.startsWith(`${candidate}-`)))) {
      return true;
    }

    return candidates.some((candidate) => resultSlugs.some((slug) => slug === candidate || slug.startsWith(`${candidate}-`)));
  });
}

function getResultPathSlugs(relativePath: string): string[] {
  return relativePath
    .replace(/\\/g, '/')
    .split('/')
    .map(slugify)
    .filter(Boolean);
}

function getTestResultSlugCandidates(relativePath: string): string[] {
  const withoutLastExtension = relativePath
    .replace(/\\/g, '/')
    .replace(/\.[^.]+$/i, '');
  const withoutExtension = relativePath
    .replace(/\\/g, '/')
    .replace(/\.(spec|test)\.[^.]+$/i, '')
    .replace(/\.[^.]+$/i, '');
  const pathParts = withoutExtension.split('/').filter(Boolean);
  const pathPartsWithSpec = withoutLastExtension.split('/').filter(Boolean);
  const withoutCommonRoot = ['test', 'tests', 'e2e', 'spec', 'specs'].includes(pathParts[0] ?? '')
    ? pathParts.slice(1)
    : pathParts;
  const withoutCommonRootWithSpec = ['test', 'tests', 'e2e', 'spec', 'specs'].includes(pathPartsWithSpec[0] ?? '')
    ? pathPartsWithSpec.slice(1)
    : pathPartsWithSpec;
  const candidates = [
    slugify(withoutCommonRoot.join('-')),
    slugify(pathParts.join('-')),
    slugify(withoutCommonRootWithSpec.join('-')),
    slugify(pathPartsWithSpec.join('-'))
  ];

  return [...new Set(candidates.filter(Boolean))];
}

function getSourceFileSlugCandidate(relativePath: string): string {
  const fileName = path.basename(relativePath)
    .replace(/\.(spec|test)\.[^.]+$/i, '')
    .replace(/\.[^.]+$/i, '');

  return slugify(fileName);
}

function getResultDirRelativePath(relativePath: string): string {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const parts = normalizedPath.split('/');
  const attachmentsIndex = parts.indexOf('attachments');

  if (attachmentsIndex > 1) {
    return parts.slice(0, attachmentsIndex).join('/');
  }

  if (parts[0] === 'test-results') {
    return path.dirname(normalizedPath);
  }

  return path.dirname(relativePath);
}

function getResultPackageRootRelativePath(relativePath: string): string | undefined {
  const parts = relativePath.replace(/\\/g, '/').split('/');
  const testResultsIndex = parts.indexOf('test-results');

  if (testResultsIndex <= 0) {
    return undefined;
  }

  return parts.slice(0, testResultsIndex).join('/');
}

function isPathInside(relativePath: string, parentRelativePath: string): boolean {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const normalizedParent = parentRelativePath.replace(/\\/g, '/').replace(/\/+$/g, '');

  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

async function getResultSourceFileSlugs(resultDirPath: string): Promise<string[]> {
  const attachmentsDir = path.join(resultDirPath, 'attachments');

  try {
    const entries = await fs.readdir(attachmentsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.startsWith('source-'))
      .map((entry) => slugify(entry.name.replace(/^source-/, '').replace(/-[a-f0-9]{40}\.[^.]+$/i, '')));
  } catch {
    return [];
  }
}

function isVisibleResultFile(relativePath: string): boolean {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const parts = normalizedPath.split('/');
  const fileName = parts[parts.length - 1] ?? '';
  const latestIndex = parts.findIndex((part, index) => {
    return part === 'latest'
      && (
        (index >= 1 && parts[index - 1] === 'test-results')
        || (index >= 2 && parts[index - 1] === 'playwright-trace-viewer' && parts[index - 2] === 'test-results')
      );
  });

  return !fileName.startsWith('.')
    && !fileName.startsWith('source-')
    && latestIndex === -1;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[^.]+$/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function filterTestFiles(files: vscode.Uri[]): Promise<Array<{ uri: vscode.Uri; framework: TestFramework }>> {
  const results = await Promise.all(
    files.map(async (file) => {
      try {
        const content = await fs.readFile(file.fsPath, 'utf8');
        const framework = detectTestFramework(content);
        return framework ? { uri: file, framework } : undefined;
      } catch {
        return undefined;
      }
    })
  );

  return results.filter((file): file is { uri: vscode.Uri; framework: TestFramework } => !!file);
}

function detectTestFramework(content: string): TestFramework | undefined {
  if (content.includes('from "vitest"') || content.includes("from 'vitest'")) {
    return 'vitest';
  }

  if (content.includes('@playwright/test') || content.includes('playwright/test')) {
    return 'playwright';
  }

  if (/\btest\.describe\s*\(/.test(content) || /\btest\s*\(/.test(content)) {
    return 'playwright';
  }

  return undefined;
}

function getTestGlob(): string {
  return vscode.workspace
    .getConfiguration('playwrightTraceViewer')
    .get<string>('testGlob', '**/*.{spec,test}.{ts,tsx,js,jsx,mjs,cjs}');
}

function getResultGlob(): string {
  return vscode.workspace
    .getConfiguration('playwrightTraceViewer')
    .get<string>('testResultGlob', '**/test-results/**/*');
}

function getResultWatcherGlob(): string {
  const resultGlob = getResultGlob().replace(/\\/g, '/');
  const testResultsIndex = resultGlob.indexOf('test-results');

  if (testResultsIndex === -1) {
    return resultGlob;
  }

  return `${resultGlob.slice(0, testResultsIndex)}test-results/**`;
}

function getExcludeGlob(): string | undefined {
  const patterns = [
    ...getEnabledExcludePatterns('search.exclude'),
    ...getEnabledExcludePatterns('files.exclude'),
    ...vscode.workspace
      .getConfiguration('playwrightTraceViewer')
      .get<string[]>('testExcludeGlobs', [])
  ];
  const uniquePatterns = [...new Set(patterns.map((pattern) => pattern.trim()).filter(Boolean))];

  if (uniquePatterns.length === 0) {
    return undefined;
  }

  if (uniquePatterns.length === 1) {
    return uniquePatterns[0];
  }

  return `{${uniquePatterns.join(',')}}`;
}

function getEnabledExcludePatterns(settingName: 'search.exclude' | 'files.exclude'): string[] {
  const excludes = vscode.workspace.getConfiguration().get<Record<string, boolean | string>>(settingName, {});

  return Object.entries(excludes)
    .filter(([, value]) => value !== false)
    .map(([pattern]) => pattern);
}

async function openTestFile(node?: FileNode | TestCaseNode): Promise<void> {
  if (!node || (node.type !== 'file' && node.type !== 'test')) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(node.uri);
  const editor = await vscode.window.showTextDocument(document);

  if (node.type === 'test') {
    const position = new vscode.Position(Math.max(node.line - 1, 0), Math.max(node.column - 1, 0));
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }
}

async function openResultFile(node?: ResultFileNode): Promise<void> {
  if (!node || node.type !== 'resultFile') {
    return;
  }

  if (isTraceFilePath(node.uri.fsPath)) {
    await vscode.commands.executeCommand('playwrightTraceViewer.openSelectedTrace', node.uri);
    return;
  }

  await vscode.commands.executeCommand('vscode.open', node.uri);
}

async function copyTestPath(node?: TestNode): Promise<void> {
  if (!node || (node.type !== 'file' && node.type !== 'test' && node.type !== 'resultFile')) {
    return;
  }

  const suffix = node.type === 'test' ? `:${node.line}` : '';
  await vscode.env.clipboard.writeText(`${node.uri.fsPath}${suffix}`);
}

function getResultFileIcon(relativePath: string): vscode.ThemeIcon {
  const fileName = path.basename(relativePath);
  const extension = path.extname(fileName).toLowerCase();

  if (isTraceFilePath(relativePath)) {
    return new vscode.ThemeIcon('preview');
  }

  if (['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
    return new vscode.ThemeIcon('file-media');
  }

  if (['.webm', '.mp4'].includes(extension)) {
    return new vscode.ThemeIcon('device-camera-video');
  }

  return new vscode.ThemeIcon('file');
}

async function installDependencies(): Promise<void> {
  const workingDirectory = getWorkingDirectory();

  if (!workingDirectory) {
    vscode.window.showErrorMessage('Open a workspace folder before installing dependencies.');
    return;
  }

  if (!(await pathExists(path.join(workingDirectory, 'package.json')))) {
    vscode.window.showErrorMessage('No package.json found in the Playwright working directory.');
    return;
  }

  const packageManager = await detectPackageManager(workingDirectory);
  runInTerminal(workingDirectory, [packageManager, 'install']);
}

async function detectPackageManager(workspaceRoot: string): Promise<string> {
  if (await pathExists(path.join(workspaceRoot, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }

  if (await pathExists(path.join(workspaceRoot, 'yarn.lock'))) {
    return 'yarn';
  }

  return 'npm';
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runTests(
  provider: PlaywrightTestProvider,
  node?: TestNode,
  options: RunTestsOptions = {}
): Promise<void> {
  if (node && node.type !== 'file' && node.type !== 'folder' && node.type !== 'test' && node.type !== 'suite') {
    return;
  }

  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Open a workspace folder before running tests.');
    return;
  }

  if (typeof options.filter === 'string') {
    await provider.setSearchFilter(options.filter);
  }

  if (node?.type === 'file' || node?.type === 'test') {
    const group = await getTestRunGroup(workspaceRoot, node);
    await runGroupedTests([group], provider, options);
    return;
  }

  if (node?.type === 'folder' || node?.type === 'suite') {
    const targets = getRunnableTargets([node]);
    const groups = await getTestRunGroups(workspaceRoot, targets);
    await runGroupedTests(groups, provider, options);
    return;
  }

  const targets = provider.hasSearchFilter() || getViewMode() === 'test'
    ? getRunnableTargets(await provider.getVisibleNodes())
    : await getAllTestFileTargets();
  const groups = await getTestRunGroups(workspaceRoot, targets);

  if (groups.length === 0) {
    vscode.window.showInformationMessage(provider.hasSearchFilter()
      ? 'No tests match the current search filter.'
      : 'No supported Playwright or Vitest test files found.');
    return;
  }

  await runGroupedTests(groups, provider, options);
}

function getTerminalRunner(): string {
  const packageRunner = vscode.workspace
    .getConfiguration('playwrightTraceViewer')
    .get<string>('packageRunner', 'npx')
    .trim() || 'npx';

  if (process.platform === 'win32' && packageRunner === 'npx') {
    return 'npx.cmd';
  }

  return packageRunner;
}

async function getAllTestFileTargets(): Promise<TestFileTarget[]> {
  const files = await vscode.workspace.findFiles(getTestGlob(), getExcludeGlob());
  return filterTestFiles(files);
}

async function getTestRunGroups(
  workspaceRoot: string,
  files: TestFileTarget[]
): Promise<TestRunGroup[]> {
  const groups: TestRunGroup[] = [];

  for (const file of files) {
    groups.push(await getTestRunGroup(workspaceRoot, file));
  }

  return dedupeTestRunGroups(groups);
}

async function getTestRunGroup(workspaceRoot: string, file: TestFileTarget): Promise<TestRunGroup> {
  const cwd = findNearestWorkingDirectory(path.dirname(file.uri.fsPath), workspaceRoot);
  const relativePath = normalizeRelativePath(path.relative(cwd, file.uri.fsPath));

  return {
    cwd,
    framework: file.framework,
    testPaths: [file.line ? `${relativePath}:${file.line}` : relativePath],
    targets: [file]
  };
}

function getTestTargetKey(target: TestFileTarget): string {
  return `${target.framework}\0${target.uri.fsPath}\0${target.line ?? ''}`;
}

function flattenSuiteTests(suite: TestSuiteNode): TestCaseNode[] {
  return suite.children.flatMap((child) => child.type === 'test' ? [child] : flattenSuiteTests(child));
}

function getRunnableTargets(nodes: TestNode[]): TestFileTarget[] {
  const targets: TestFileTarget[] = [];

  for (const node of nodes) {
    if (node.type === 'file' || node.type === 'test') {
      targets.push(node);
    } else if (node.type === 'folder') {
      targets.push(...getRunnableTargets(node.files));
    } else if (node.type === 'suite') {
      targets.push(...flattenSuiteTests(node));
    }
  }

  return targets;
}

function dedupeTestRunGroups(groups: TestRunGroup[]): TestRunGroup[] {
  const groupsByProject = new Map<string, TestRunGroup>();

  for (const group of groups) {
    const key = `${group.cwd}\0${group.framework}`;
    const existing = groupsByProject.get(key);

    if (existing) {
      existing.testPaths.push(...group.testPaths);
      existing.targets.push(...group.targets);
    } else {
      groupsByProject.set(key, {
        cwd: group.cwd,
        framework: group.framework,
        testPaths: [...group.testPaths],
        targets: [...group.targets]
      });
    }
  }

  for (const group of groupsByProject.values()) {
    const pathSeen = new Set<string>();
    const targetSeen = new Set<string>();
    group.testPaths = group.testPaths.filter((testPath) => {
      if (pathSeen.has(testPath)) {
        return false;
      }

      pathSeen.add(testPath);
      return true;
    });
    group.targets = group.targets.filter((target) => {
      const key = getTestTargetKey(target);
      if (targetSeen.has(key)) {
        return false;
      }

      targetSeen.add(key);
      return true;
    });
  }

  return [...groupsByProject.values()];
}

async function runGroupedTests(
  groups: TestRunGroup[],
  provider: PlaywrightTestProvider,
  options: RunTestsOptions
): Promise<void> {
  let failedCount = 0;
  const continueOnFailure = options.continueOnFailure !== false;

  for (const group of groups) {
    group.targets.forEach((target) => provider.setRunningTarget(target, true));
    let succeeded = false;

    try {
      succeeded = await runTestFramework(group.cwd, group.framework, group.testPaths, provider, {
        ...options,
        openTrace: options.openTrace ?? groups.length === 1
      });
    } finally {
      group.targets.forEach((target) => provider.setRunningTarget(target, false));
    }

    if (succeeded) {
      continue;
    }

    failedCount += 1;
    if (!continueOnFailure) {
      break;
    }
  }

  if (failedCount > 0 && continueOnFailure && groups.length > 1) {
    vscode.window.showWarningMessage(`${failedCount} test run(s) failed. Remaining runs were still attempted.`);
  }
}

async function runTestFramework(
  cwd: string,
  framework: TestFramework,
  testPaths: string[] = [],
  provider?: PlaywrightTestProvider,
  options: RunTestsOptions = {}
): Promise<boolean> {
  if (framework === 'playwright') {
    try {
      const result = await runTestsWithTraceDetailed(cwd, 'on', testPaths);
      provider?.refreshResults();
      if (result.tracePath && options.openTrace !== false) {
        await vscode.commands.executeCommand('playwrightTraceViewer.openSelectedTrace', vscode.Uri.file(result.tracePath));
      } else if (!result.tracePath) {
        vscode.window.showInformationMessage('Playwright finished, but no trace.zip was generated.');
      }
      return result.exitCode === 0;
    } catch (error) {
      vscode.window.showWarningMessage(`Playwright run failed: ${String(error)}`);
      return false;
    } finally {
      provider?.refreshResults();
    }
  }

  const runner = getTerminalRunner();
  const localBin = await findLocalFrameworkBin(cwd, framework);
  const args = localBin
    ? [localBin, 'run', ...testPaths]
    : [runner, 'vitest', 'run', ...testPaths];

  runInTerminal(cwd, args);
  return true;
}

async function findLocalFrameworkBin(cwd: string, framework: TestFramework): Promise<string | undefined> {
  const executable = process.platform === 'win32' ? `${framework}.cmd` : framework;
  const candidate = path.join(cwd, 'node_modules', '.bin', executable);

  return await pathExists(candidate) ? candidate : undefined;
}
