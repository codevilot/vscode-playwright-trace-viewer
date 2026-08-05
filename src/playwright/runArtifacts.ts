import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { isTraceFilePath } from '../trace';

const maxOutputDirPrefixLength = 48;

export function getPlaywrightOutputDir(testPaths: string[]): string {
  const input = testPaths.length > 0 ? testPaths.join('-') : 'all';
  const slug = shortenSlug(slugify(input) || 'all', input);
  const hash = hashString(input);
  const runId = `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${process.pid.toString(36)}-${randomBytes(3).toString('hex')}`;
  return path.join('test-results', `${slug}-${hash}-${runId}`);
}

export async function clearOutputDir(outputDir: string): Promise<void> {
  await fs.rm(outputDir, { recursive: true, force: true });
}

export async function findLatestTrace(rootDir: string, startedAt: number): Promise<string | undefined> {
  const traces = await collectTraceFiles(rootDir, startedAt);
  traces.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return traces[0]?.path;
}

export async function copyLatestTrace(sourcePath: string, targetPaths: string[]): Promise<string> {
  for (const targetPath of targetPaths) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }

  return targetPaths[0];
}

export function getLatestTraceFileName(outputDir: string): string {
  return `${path.basename(outputDir)}-trace.zip`;
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
      return entry.name === 'latest' ? [] : collectTraceFiles(entryPath, startedAt);
    }

    if (!entry.isFile() || !isTraceFilePath(entry.name)) {
      return [];
    }

    const stat = await fs.stat(entryPath);
    return stat.mtimeMs >= startedAt - 1000 ? [{ path: entryPath, mtimeMs: stat.mtimeMs }] : [];
  }));

  return traces.flat();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[^.]+$/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function shortenSlug(slug: string, input: string): string {
  if (slug.length <= maxOutputDirPrefixLength) {
    return slug;
  }

  const hash = hashString(input);
  return slug.slice(0, maxOutputDirPrefixLength - hash.length - 1).replace(/-+$/g, '') || hash;
}

function hashString(value: string): string {
  let hash = 5381;

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}
