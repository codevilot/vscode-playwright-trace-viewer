import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { getWorkspaceRoot, isTraceFilePath } from './trace';
import { runInTerminal, runTestsWithTrace } from './terminal';

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
  const refreshResults = () => provider.refreshResults();
  let resultWatcher: vscode.FileSystemWatcher | undefined;

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
    ) {
      recreateResultWatcher();
      provider.refresh();
    }
  });

  context.subscriptions.push(
    treeView,
    configurationWatcher,
    { dispose: () => resultWatcher?.dispose() },
    vscode.commands.registerCommand('playwrightTraceViewer.refreshTests', () => provider.refresh()),
    vscode.commands.registerCommand('playwrightTraceViewer.searchTests', () => provider.search()),
    vscode.commands.registerCommand('playwrightTraceViewer.installDependencies', () => {
      installDependencies();
      provider.refresh();
    }),
    vscode.commands.registerCommand('playwrightTraceViewer.runAllTestsFromExplorer', () => runTests(provider)),
    vscode.commands.registerCommand('playwrightTraceViewer.runTestNode', (node?: TestNode) => runTests(provider, node)),
    vscode.commands.registerCommand('playwrightTraceViewer.openTestFile', (node?: FileNode) => openTestFile(node)),
    vscode.commands.registerCommand('playwrightTraceViewer.openResultFile', (node?: ResultFileNode) => openResultFile(node)),
    vscode.commands.registerCommand('playwrightTraceViewer.copyTestPath', (node?: TestNode) => copyTestPath(node))
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

    if (element?.type === 'file') {
      return element.results;
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
      item.contextValue = element.resultOnly ? 'playwrightResultFolder' : 'playwrightTestFolder';
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

    const item = new vscode.TreeItem(
      element.label,
      element.results.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
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
    nodes.push({
      type: 'folder',
      label: 'Test Results',
      relativePath: 'test-results',
      files: unmatchedResults.map((result) => ({
        ...result,
        label: getStandaloneResultLabel(result)
      })),
      resultOnly: true
    });
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
  const resultFiles = await Promise.all(
    files.map(async (uri) => {
      try {
        const stat = await fs.stat(uri.fsPath);

        const relativePath = path.relative(workspaceRoot, uri.fsPath);

        if (!stat.isFile() || !isVisibleResultFile(relativePath)) {
          return undefined;
        }

        const resultDirRelativePath = getResultDirRelativePath(relativePath);
        const resultDirPath = path.join(workspaceRoot, resultDirRelativePath);
        return {
          type: 'resultFile' as const,
          label: path.basename(relativePath),
          relativePath,
          resultDirRelativePath,
          sourceFileSlugs: await getResultSourceFileSlugs(resultDirPath),
          uri,
          mtimeMs: stat.mtimeMs
        };
      } catch {
        return undefined;
      }
    })
  );
  return getLatestResultDirs(getVisibleExtensionResultFiles(resultFiles
    .filter((file): file is ResultFileNode => !!file)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.relativePath.localeCompare(b.relativePath))));
}

function getVisibleExtensionResultFiles(resultFiles: ResultFileNode[]): ResultFileNode[] {
  const summaryDirs = new Set(
    resultFiles
      .filter((file) => {
        const summaryDir = getExtensionRunSummaryDir(file.resultDirRelativePath);
        return path.basename(file.relativePath) === 'trace.zip'
          && !!summaryDir
          && fileNormalizedPath(file.resultDirRelativePath) === summaryDir;
      })
      .map((file) => fileNormalizedPath(file.resultDirRelativePath))
  );

  return resultFiles.filter((file) => {
    const summaryDir = getExtensionRunSummaryDir(file.resultDirRelativePath);

    return !summaryDir
      || fileNormalizedPath(file.resultDirRelativePath) === summaryDir
      || !summaryDirs.has(summaryDir);
  });
}

function fileNormalizedPath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

function getExtensionRunSummaryDir(relativePath: string): string | undefined {
  const parts = fileNormalizedPath(relativePath).split('/');
  const testResultsIndex = parts.indexOf('test-results');

  if (testResultsIndex === -1 || parts.length <= testResultsIndex + 1) {
    return undefined;
  }

  return parts.slice(0, testResultsIndex + 2).join('/');
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

  if (isTraceFilePath(node.uri.fsPath)) {
    await vscode.commands.executeCommand('playwrightTraceViewer.openSelectedTrace', node.uri);
    return;
  }

  await vscode.commands.executeCommand('vscode.open', node.uri);
}

async function copyTestPath(node?: TestNode): Promise<void> {
  if (!node || (node.type !== 'file' && node.type !== 'resultFile')) {
    return;
  }

  await vscode.env.clipboard.writeText(node.uri.fsPath);
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

async function runTests(provider: PlaywrightTestProvider, node?: TestNode): Promise<void> {
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
    await runTestFramework(group.cwd, group.framework, group.testPaths, provider);
    return;
  }

  if (node?.type === 'folder') {
    const groups = await groupTestFilesByProject(workspaceRoot, node.files);
    await runGroupedTests(groups, provider);
    return;
  }

  const files = await vscode.workspace.findFiles(getTestGlob(), getExcludeGlob());
  const testFiles = await filterTestFiles(files);
  const groups = await groupTestFilesByProject(workspaceRoot, testFiles);

  if (groups.length === 0) {
    vscode.window.showInformationMessage('No supported Playwright or Vitest test files found.');
    return;
  }

  await runGroupedTests(groups, provider);
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

async function runGroupedTests(groups: TestRunGroup[], provider: PlaywrightTestProvider): Promise<void> {
  for (const group of groups) {
    await runTestFramework(group.cwd, group.framework, group.testPaths, provider);
  }
}

async function runTestFramework(
  cwd: string,
  framework: TestFramework,
  testPaths: string[] = [],
  provider?: PlaywrightTestProvider
): Promise<void> {
  if (framework === 'playwright') {
    try {
      const tracePath = await runTestsWithTrace(cwd, 'on', testPaths);
      provider?.refreshResults();
      if (tracePath) {
        await vscode.commands.executeCommand('playwrightTraceViewer.openSelectedTrace', vscode.Uri.file(tracePath));
      } else {
        vscode.window.showInformationMessage('Playwright finished, but no trace.zip was generated.');
      }
    } finally {
      provider?.refreshResults();
    }
    return;
  }

  const runner = getTerminalRunner();
  const localBin = await findLocalFrameworkBin(cwd, framework);
  const args = localBin
    ? [localBin, 'run', ...testPaths]
    : [runner, 'vitest', 'run', ...testPaths];

  runInTerminal(cwd, args);
}

async function findLocalFrameworkBin(cwd: string, framework: TestFramework): Promise<string | undefined> {
  const executable = process.platform === 'win32' ? `${framework}.cmd` : framework;
  const candidate = path.join(cwd, 'node_modules', '.bin', executable);

  return await pathExists(candidate) ? candidate : undefined;
}
