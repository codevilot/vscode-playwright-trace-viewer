import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { getWorkspaceRoot } from './trace';
import { runInTerminal } from './terminal';

type TestNode = InstallNode | FolderNode | FileNode;

type InstallNode = {
  type: 'install';
  packageManager: string;
};

type FolderNode = {
  type: 'folder';
  label: string;
  relativePath: string;
  files: FileNode[];
};

type FileNode = {
  type: 'file';
  label: string;
  relativePath: string;
  uri: vscode.Uri;
};

export function registerPlaywrightTestExplorer(context: vscode.ExtensionContext): void {
  const provider = new PlaywrightTestProvider();
  const treeView = vscode.window.createTreeView('playwrightTraceViewer.tests', {
    treeDataProvider: provider,
    showCollapseAll: true
  });

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('playwrightTraceViewer.refreshTests', () => provider.refresh()),
    vscode.commands.registerCommand('playwrightTraceViewer.searchTests', () => provider.search()),
    vscode.commands.registerCommand('playwrightTraceViewer.installDependencies', () => {
      installDependencies();
      provider.refresh();
    }),
    vscode.commands.registerCommand('playwrightTraceViewer.runAllTestsFromExplorer', () => runTests()),
    vscode.commands.registerCommand('playwrightTraceViewer.runTestNode', (node?: TestNode) => runTests(node)),
    vscode.commands.registerCommand('playwrightTraceViewer.openTestFile', (node?: FileNode) => openTestFile(node))
  );
}

class PlaywrightTestProvider implements vscode.TreeDataProvider<TestNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TestNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private nodes: FolderNode[] | undefined;
  private fileNameFilter = '';

  refresh(): void {
    this.nodes = undefined;
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

    if (!this.nodes) {
      this.nodes = await discoverTests(this.fileNameFilter);
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

    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.description = path.dirname(element.relativePath);
    item.contextValue = 'playwrightTestFile';
    item.iconPath = new vscode.ThemeIcon('beaker');
    item.resourceUri = element.uri;
    item.tooltip = element.relativePath;
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

async function discoverTests(fileNameFilter: string): Promise<FolderNode[]> {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    return [];
  }

  const files = await vscode.workspace.findFiles(getTestGlob(), getExcludeGlob());
  const testFiles = await filterPlaywrightFiles(files);
  const filteredTestFiles = fileNameFilter
    ? testFiles.filter((file) => {
      const relativePath = path.relative(workspaceRoot, file.fsPath).toLowerCase();
      return relativePath.includes(fileNameFilter);
    })
    : testFiles;
  const folders = new Map<string, FileNode[]>();

  for (const uri of filteredTestFiles) {
    const relativePath = path.relative(workspaceRoot, uri.fsPath);
    const folder = path.dirname(relativePath);
    const fileNode: FileNode = {
      type: 'file',
      label: path.basename(relativePath),
      relativePath,
      uri
    };

    const group = folders.get(folder) ?? [];
    group.push(fileNode);
    folders.set(folder, group);
  }

  return [...folders.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([relativePath, filesInFolder]) => ({
      type: 'folder',
      label: relativePath === '.' ? 'Workspace Root' : relativePath,
      relativePath,
      files: filesInFolder.sort((a, b) => a.label.localeCompare(b.label))
    }));
}

async function filterPlaywrightFiles(files: vscode.Uri[]): Promise<vscode.Uri[]> {
  const results = await Promise.all(
    files.map(async (file) => {
      try {
        const content = await fs.readFile(file.fsPath, 'utf8');
        return isPlaywrightTest(content) ? file : undefined;
      } catch {
        return undefined;
      }
    })
  );

  return results.filter((file): file is vscode.Uri => !!file);
}

function isPlaywrightTest(content: string): boolean {
  return content.includes('@playwright/test')
    || content.includes('playwright/test')
    || /\btest\.describe\s*\(/.test(content)
    || /\btest\s*\(/.test(content);
}

function getTestGlob(): string {
  return vscode.workspace
    .getConfiguration('playwrightTraceViewer')
    .get<string>('testGlob', '**/*.{spec,test}.{ts,tsx,js,jsx,mjs,cjs}');
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

function runTests(node?: TestNode): void {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Open a workspace folder before running Playwright tests.');
    return;
  }

  const runner = getTerminalRunner();
  const args = [runner, 'playwright', 'test'];

  if (node?.type === 'file') {
    args.push(node.relativePath);
  } else if (node?.type === 'folder' && node.relativePath !== '.') {
    args.push(node.relativePath);
  }

  args.push('--trace', 'on');
  runInTerminal(workspaceRoot, args);
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
