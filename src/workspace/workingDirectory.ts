import * as syncFs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getWorkspaceRoot } from '../trace';

const configFileNames = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
  'playwright.config.cts',
  'playwright.config.mts',
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
  'vitest.config.cts',
  'vitest.config.mts'
];

export function getWorkingDirectory(startPath?: string): string | undefined {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    return undefined;
  }

  const configured = getConfiguredWorkingDirectory(workspaceRoot);
  if (configured) {
    return configured;
  }

  const startDir = getStartDirectory(startPath ?? getActiveFilePath());
  if (startDir && isPathInsideOrEqual(startDir, workspaceRoot)) {
    return findNearestWorkingDirectory(startDir, workspaceRoot);
  }

  const projectRoot = findFirstProjectRoot(workspaceRoot);
  return projectRoot ? findNearestWorkingDirectory(projectRoot, workspaceRoot) : workspaceRoot;
}

export function findNearestWorkingDirectory(startDir: string, workspaceRoot: string): string {
  let current = startDir;

  while (isPathInsideOrEqual(current, workspaceRoot)) {
    if (hasProjectRootMarker(current)) {
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

function getConfiguredWorkingDirectory(workspaceRoot: string): string | undefined {
  const configured = vscode.workspace
    .getConfiguration('playwrightTraceViewer')
    .get<string>('workingDirectory', '')
    .trim();

  if (!configured) {
    return undefined;
  }

  const absolutePath = path.isAbsolute(configured)
    ? configured
    : path.resolve(workspaceRoot, configured);

  if (syncFs.existsSync(absolutePath)) {
    return absolutePath;
  }

  vscode.window.showWarningMessage(
    `playwrightTraceViewer.workingDirectory does not exist: ${configured}`
  );
  return undefined;
}

function getActiveFilePath(): string | undefined {
  const document = vscode.window.activeTextEditor?.document;
  return document?.uri.scheme === 'file' ? document.uri.fsPath : undefined;
}

function getStartDirectory(startPath: string | undefined): string | undefined {
  if (!startPath) {
    return undefined;
  }

  try {
    return syncFs.statSync(startPath).isDirectory() ? startPath : path.dirname(startPath);
  } catch {
    return path.dirname(startPath);
  }
}

function hasProjectRootMarker(directory: string): boolean {
  return syncFs.existsSync(path.join(directory, 'package.json'))
    || configFileNames.some((fileName) => syncFs.existsSync(path.join(directory, fileName)));
}

function findFirstProjectRoot(workspaceRoot: string): string | undefined {
  return findFirstRootByFile(workspaceRoot, (fileName) => configFileNames.includes(fileName))
    ?? findFirstRootByFile(workspaceRoot, (fileName) => fileName === 'package.json');
}

function findFirstRootByFile(
  workspaceRoot: string,
  isRootFile: (fileName: string) => boolean
): string | undefined {
  const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'out']);
  const pending = [workspaceRoot];

  while (pending.length > 0) {
    const current = pending.shift()!;
    let entries: syncFs.Dirent[];

    try {
      entries = syncFs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    if (entries.some((entry) => entry.isFile() && isRootFile(entry.name))) {
      return current;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
        pending.push(path.join(current, entry.name));
      }
    }
  }

  return undefined;
}

function isPathInsideOrEqual(filePath: string, parentPath: string): boolean {
  const relativePath = path.relative(parentPath, filePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}
