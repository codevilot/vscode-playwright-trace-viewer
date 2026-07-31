import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { getWorkspaceRoot } from './trace';
import { runInTerminal } from './terminal';

type TestNode = InstallNode | FolderNode | FileNode | ResultFileNode;

type InstallNode = {
  type: 'install';
  packageManager: string;
};

type FolderNode = {
  type: 'folder';
  label: string;
  relativePath: string;
  files: Array<FileNode | ResultFileNode>;
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
  uri: vscode.Uri;
  mtimeMs: number;
};

type TestFramework = 'playwright' | 'vitest';

type TestFileTarget = {
  framework: TestFramework;
  uri: vscode.Uri;
};

type TestRunGroup = {
  cwd: string;
  framework: TestFramework;
  testPaths: string[];
};

export function registerPlaywrightTestExplorer(context: vscode.ExtensionContext): void {
  const provider = new PlaywrightTestProvider();
  const treeView = vscode.window.createTreeView('playwrightTraceViewer.tests', {
    treeDataProvider: provider,
    showCollapseAll: true
  });
  const resultWatcher = vscode.workspace.createFileSystemWatcher('test-results/**');
  const refreshResults = () => provider.refreshResults();

  resultWatcher.onDidCreate(refreshResults, null, context.subscriptions);
  resultWatcher.onDidChange(refreshResults, null, context.subscriptions);
  resultWatcher.onDidDelete(refreshResults, null, context.subscriptions);

  context.subscriptions.push(
    treeView,
    resultWatcher,
    vscode.commands.registerCommand('playwrightTraceViewer.refreshTests', () => provider.refresh()),
    vscode.commands.registerCommand('playwrightTraceViewer.searchTests', () => provider.search()),
    vscode.commands.registerCommand('playwrightTraceViewer.installDependencies', () => {
      installDependencies();
      provider.refresh();
    }),
    vscode.commands.registerCommand('playwrightTraceViewer.runAllTestsFromExplorer', () => runTests()),
    vscode.commands.registerCommand('playwrightTraceViewer.runTestNode', (node?: TestNode) => runTests(node)),
    vscode.commands.registerCommand('playwrightTraceViewer.openTestFile', (node?: FileNode) => openTestFile(node)),
    vscode.commands.registerCommand('playwrightTraceViewer.openResultFile', (node?: ResultFileNode) => openResultFile(node))
  );
}

class PlaywrightTestProvider implements vscode.TreeDataProvider<TestNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TestNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private nodes: FolderNode[] | undefined;
  private results: ResultFileNode[] | undefined;
  private fileNameFilter = '';

  refresh(): void {
    this.nodes = undefined;
    this.results = undefined;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  refreshResults(): void {
    this.nodes = undefined;
    this.results = undefined;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  async search(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: 'Search Playwright test files',
      prompt: 'Type a file or folder name. Leave empty to clear the filter.',
      value: this.fileNameFilter,
      placeHolder: 'login, dashboard, tests/auth'
    });

    if (value === undefined) {
      return;
    }

    this.fileNameFilter = value.trim().toLowerCase();
    this.refresh();
  }

  async getChildren(element?: TestNode): Promise<TestNode[]> {
    if (element?.type === 'folder') {
      return element.files;
    }

    if (element) {
      return [];
    }

    if (!this.results) {
      this.results = await discoverResults();
    }

    if (!this.nodes) {
      this.nodes = await discoverTests(this.fileNameFilter, this.results);
    }

    const installNode = await getInstallNode();
    return installNode ? [installNode, ...this.nodes] : this.nodes;
  }

  getTreeItem(element: TestNode): vscode.TreeItem {
    if (element.type === 'install') {
      const item = new vscode.TreeItem('Install Dependencies', vscode.TreeItemCollapsibleState.None);
      item.description = element.packageManager;
      item.contextValue = 'playwrightInstallDependencies';
      item.iconPath = new vscode.ThemeIcon('cloud-download');
      item.tooltip = `Run ${element.packageManager} install in this workspace`;
      item.command = {
        command: 'playwrightTraceViewer.installDependencies',
        title: 'Install Dependencies'
      };
      return item;
    }

    if (element.type === 'folder') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${element.files.length}`;
      item.contextValue = 'playwrightTestFolder';
      item.iconPath = new vscode.ThemeIcon('folder');
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

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = path.dirname(element.relativePath);
    item.contextValue = 'playwrightTestFile';
    item.iconPath = new vscode.ThemeIcon(element.framework === 'vitest' ? 'testing-view-icon' : 'beaker');
    item.resourceUri = element.uri;
    item.tooltip = `${element.framework}: ${element.relativePath}`;
    item.command = {
      command: 'playwrightTraceViewer.openTestFile',
      title: 'Open Test File',
      arguments: [element]
    };
    return item;
  }
}

async function getInstallNode(): Promise<InstallNode | undefined> {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot || !(await pathExists(path.join(workspaceRoot, 'package.json')))) {
    return undefined;
  }

  if (await pathExists(path.join(workspaceRoot, 'node_modules'))) {
    return undefined;
  }

  return {
    type: 'install',
    packageManager: await detectPackageManager(workspaceRoot)
  };
}

async function discoverTests(fileNameFilter: string, resultFiles: ResultFileNode[]): Promise<FolderNode[]> {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    return [];
  }

  const files = await vscode.workspace.findFiles(getTestGlob(), getExcludeGlob());
  const testFiles = await filterTestFiles(files);
  const filteredTestFiles = fileNameFilter
    ? testFiles.filter((file) => {
      const relativePath = path.relative(workspaceRoot, file.uri.fsPath).toLowerCase();
      return relativePath.includes(fileNameFilter);
    })
    : testFiles;
  const folders = new Map<string, Array<FileNode | ResultFileNode>>();

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
        ? matchResultsToTestFile(relativePath, resultFiles)
        : []
    };

    const group = folders.get(folder) ?? [];
    group.push(fileNode);
    group.push(...fileNode.results.map((result) => ({
      ...result,
      label: getInlineResultLabel(fileNode.label, result)
    })));
    folders.set(folder, group);
  }

  return [...folders.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([relativePath, filesInFolder]) => ({
      type: 'folder',
      label: relativePath === '.' ? 'Workspace Root' : relativePath,
      relativePath,
      files: filesInFolder.sort(compareTestExplorerItems)
    }));
}

function compareTestExplorerItems(a: FileNode | ResultFileNode, b: FileNode | ResultFileNode): number {
  const aBaseLabel = a.type === 'resultFile' ? getTestLabelFromResultLabel(a.label) : a.label;
  const bBaseLabel = b.type === 'resultFile' ? getTestLabelFromResultLabel(b.label) : b.label;
  const labelComparison = aBaseLabel.localeCompare(bBaseLabel);

  if (labelComparison !== 0) {
    return labelComparison;
  }

  if (a.type !== b.type) {
    return a.type === 'file' ? -1 : 1;
  }

  return a.label.localeCompare(b.label);
}

function getInlineResultLabel(testFileLabel: string, result: ResultFileNode): string {
  const resultName = path.basename(result.relativePath) === 'trace.zip'
    ? 'trace'
    : path.basename(result.relativePath);

  return `${testFileLabel}-${resultName}`;
}

function getTestLabelFromResultLabel(label: string): string {
  return label.replace(/-(trace|[^-]+)$/i, '');
}

async function discoverResults(): Promise<ResultFileNode[]> {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    return [];
  }

  const files = await vscode.workspace.findFiles(getResultGlob());
  const resultFiles = await Promise.all(
    files.map(async (uri) => {
      try {
        const stat = await fs.stat(uri.fsPath);

        if (!stat.isFile() || !isVisibleResultFile(uri.fsPath)) {
          return undefined;
        }

        const relativePath = path.relative(workspaceRoot, uri.fsPath);
        const resultDirRelativePath = getResultDirRelativePath(relativePath);
        return {
          type: 'resultFile' as const,
          label: path.basename(relativePath),
          relativePath,
          resultDirRelativePath,
          uri,
          mtimeMs: stat.mtimeMs
        };
      } catch {
        return undefined;
      }
    })
  );
  return resultFiles
    .filter((file): file is ResultFileNode => !!file)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.relativePath.localeCompare(b.relativePath));
}

function matchResultsToTestFile(relativePath: string, resultFiles: ResultFileNode[]): ResultFileNode[] {
  const candidates = getTestResultSlugCandidates(relativePath);

  return resultFiles.filter((file) => {
    const resultSlug = slugify(path.basename(file.resultDirRelativePath));

    return candidates.some((candidate) => resultSlug === candidate || resultSlug.startsWith(`${candidate}-`));
  });
}

function getTestResultSlugCandidates(relativePath: string): string[] {
  const withoutExtension = relativePath
    .replace(/\\/g, '/')
    .replace(/\.(spec|test)\.[^.]+$/i, '')
    .replace(/\.[^.]+$/i, '');
  const pathParts = withoutExtension.split('/').filter(Boolean);
  const withoutCommonRoot = ['test', 'tests', 'e2e', 'spec', 'specs'].includes(pathParts[0] ?? '')
    ? pathParts.slice(1)
    : pathParts;
  const candidates = [
    slugify(withoutCommonRoot.join('-')),
    slugify(pathParts.join('-'))
  ];

  return [...new Set(candidates.filter(Boolean))];
}

function getResultDirRelativePath(relativePath: string): string {
  const parts = relativePath.replace(/\\/g, '/').split('/');

  if (parts.length >= 2 && parts[0] === 'test-results' && !parts[1].startsWith('.')) {
    return parts.slice(0, 2).join('/');
  }

  return path.dirname(relativePath);
}

function isVisibleResultFile(filePath: string): boolean {
  const fileName = path.basename(filePath);

  return !fileName.startsWith('.')
    && !fileName.startsWith('source-');
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
    .get<string>('testResultGlob', 'test-results/**/*');
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

async function openTestFile(node?: FileNode): Promise<void> {
  if (!node || node.type !== 'file') {
    return;
  }

  const document = await vscode.workspace.openTextDocument(node.uri);
  await vscode.window.showTextDocument(document);
}

async function openResultFile(node?: ResultFileNode): Promise<void> {
  if (!node || node.type !== 'resultFile') {
    return;
  }

  if (path.basename(node.uri.fsPath) === 'trace.zip') {
    await vscode.commands.executeCommand('playwrightTraceViewer.openSelectedTrace', node.uri);
    return;
  }

  await vscode.commands.executeCommand('vscode.open', node.uri);
}

function getResultFileIcon(relativePath: string): vscode.ThemeIcon {
  const fileName = path.basename(relativePath);
  const extension = path.extname(fileName).toLowerCase();

  if (fileName === 'trace.zip') {
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
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Open a workspace folder before installing dependencies.');
    return;
  }

  if (!(await pathExists(path.join(workspaceRoot, 'package.json')))) {
    vscode.window.showErrorMessage('No package.json found in the current workspace.');
    return;
  }

  const packageManager = await detectPackageManager(workspaceRoot);
  runInTerminal(workspaceRoot, [packageManager, 'install']);
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

async function runTests(node?: TestNode): Promise<void> {
  if (node && node.type !== 'file' && node.type !== 'folder') {
    return;
  }

  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Open a workspace folder before running tests.');
    return;
  }

  if (node?.type === 'file') {
    const group = await getTestRunGroup(workspaceRoot, node);
    runTestFramework(group.cwd, group.framework, group.testPaths);
    return;
  }

  if (node?.type === 'folder') {
    const groups = await groupTestFilesByProject(workspaceRoot, node.files);
    runGroupedTests(groups);
    return;
  }

  const files = await vscode.workspace.findFiles(getTestGlob(), getExcludeGlob());
  const testFiles = await filterTestFiles(files);
  const groups = await groupTestFilesByProject(workspaceRoot, testFiles);

  if (groups.length === 0) {
    vscode.window.showInformationMessage('No supported Playwright or Vitest test files found.');
    return;
  }

  runGroupedTests(groups);
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

async function groupTestFilesByProject(
  workspaceRoot: string,
  files: Array<TestFileTarget | ResultFileNode>
): Promise<TestRunGroup[]> {
  const groups = new Map<string, TestRunGroup>();

  for (const file of files) {
    if (!('framework' in file)) {
      continue;
    }

    const group = await getTestRunGroup(workspaceRoot, file);
    const key = `${group.cwd}\0${group.framework}`;
    const existing = groups.get(key);

    if (existing) {
      existing.testPaths.push(...group.testPaths);
    } else {
      groups.set(key, group);
    }
  }

  return [...groups.values()];
}

async function getTestRunGroup(workspaceRoot: string, file: TestFileTarget): Promise<TestRunGroup> {
  const cwd = await findNearestPackageRoot(path.dirname(file.uri.fsPath), workspaceRoot);

  return {
    cwd,
    framework: file.framework,
    testPaths: [path.relative(cwd, file.uri.fsPath)]
  };
}

async function findNearestPackageRoot(startDir: string, workspaceRoot: string): Promise<string> {
  let current = startDir;

  while (current.startsWith(workspaceRoot)) {
    if (await pathExists(path.join(current, 'package.json'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  return workspaceRoot;
}

function runGroupedTests(groups: TestRunGroup[]): void {
  for (const group of groups) {
    runTestFramework(group.cwd, group.framework, group.testPaths);
  }
}

function runTestFramework(cwd: string, framework: TestFramework, testPaths: string[] = []): void {
  const runner = getTerminalRunner();
  const args = framework === 'vitest'
    ? [runner, 'vitest', 'run', ...testPaths]
    : [runner, 'playwright', 'test', ...testPaths, '--trace', 'on'];

  runInTerminal(cwd, args);
}
