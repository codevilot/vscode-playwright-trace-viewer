import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

export function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function getTraceGlob(): string {
  return vscode.workspace
    .getConfiguration('playwrightTraceViewer')
    .get<string>('traceGlob', 'test-results/**/trace.zip');
}

export async function findLatestTrace(): Promise<string | undefined> {
  const files = await vscode.workspace.findFiles(getTraceGlob());

  if (files.length === 0) {
    return undefined;
  }

  const traces = await Promise.all(
    files.map(async (file) => {
      const stat = await fs.stat(file.fsPath);
      return {
        path: file.fsPath,
        mtimeMs: stat.mtimeMs
      };
    })
  );

  traces.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return traces[0]?.path;
}

export function validateTraceUri(uri: vscode.Uri | undefined): string | undefined {
  if (!uri || uri.scheme !== 'file') {
    return undefined;
  }

  if (path.basename(uri.fsPath) !== 'trace.zip') {
    return undefined;
  }

  return uri.fsPath;
}
