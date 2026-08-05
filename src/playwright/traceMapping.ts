import * as fs from 'fs/promises';
import * as path from 'path';
import { Readable } from 'stream';

const yauzl = require('yauzl') as {
  open(filePath: string, options: { lazyEntries: boolean }, callback: (error: Error | null, zipFile?: ZipFile) => void): void;
};

type ZipFile = {
  readEntry(): void;
  close(): void;
  on(event: 'entry', listener: (entry: ZipEntry) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'end', listener: () => void): void;
  openReadStream(entry: ZipEntry, callback: (error: Error | null, stream?: Readable) => void): void;
};

type ZipEntry = {
  fileName: string;
};

export type TraceSourceLocation = {
  relativePath: string;
  line: number;
  column: number;
};

export type TestLocationRange = {
  relativePath: string;
  line: number;
  nextLine?: number;
};

type JsonObject = Record<string, unknown>;

const traceLocationCache = new Map<string, Promise<TraceSourceLocation[] | undefined>>();

export async function readCachedTraceSourceLocations(
  tracePath: string,
  workspaceRoot: string
): Promise<TraceSourceLocation[] | undefined> {
  let stat: import('fs').Stats;

  try {
    stat = await fs.stat(tracePath);
  } catch {
    return undefined;
  }

  const cacheKey = `${tracePath}\0${stat.mtimeMs}\0${stat.size}`;
  let cached = traceLocationCache.get(cacheKey);

  if (!cached) {
    cached = readTraceSourceLocations(tracePath, workspaceRoot);
    traceLocationCache.set(cacheKey, cached);
  }

  return cached;
}

export function matchLocationsToTestRange(
  locations: TraceSourceLocation[] | undefined,
  range: TestLocationRange
): boolean | undefined {
  if (!locations) {
    return undefined;
  }

  const normalizedRangePath = normalizePath(range.relativePath);
  return locations.some((location) => {
    return location.relativePath === normalizedRangePath
      && location.line >= range.line
      && (range.nextLine === undefined || location.line < range.nextLine);
  });
}

export async function readTraceSourceLocations(
  tracePath: string,
  workspaceRoot: string
): Promise<TraceSourceLocation[] | undefined> {
  try {
    const traceText = await readZipEntry(tracePath, 'test.trace');
    if (traceText === undefined) {
      return undefined;
    }

    return extractTraceSourceLocations(traceText, workspaceRoot);
  } catch {
    return undefined;
  }
}

export function extractTraceSourceLocations(traceText: string, workspaceRoot: string): TraceSourceLocation[] {
  const locations = new Map<string, TraceSourceLocation>();

  for (const line of traceText.split(/\r?\n/g)) {
    if (!line.trim()) {
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    for (const frame of collectStackFrames(event)) {
      const location = normalizeStackFrame(frame, workspaceRoot);
      if (!location) {
        continue;
      }

      locations.set(`${location.relativePath}:${location.line}:${location.column}`, location);
    }
  }

  return [...locations.values()];
}

function collectStackFrames(value: unknown): JsonObject[] {
  if (!isJsonObject(value)) {
    return [];
  }

  const stack = value.stack;
  if (Array.isArray(stack)) {
    return stack.filter(isJsonObject);
  }

  if (isJsonObject(stack) && Array.isArray(stack.frames)) {
    return stack.frames.filter(isJsonObject);
  }

  return [];
}

function normalizeStackFrame(frame: JsonObject, workspaceRoot: string): TraceSourceLocation | undefined {
  const file = getFrameFile(frame);
  const line = typeof frame.line === 'number' ? frame.line : undefined;
  const column = typeof frame.column === 'number' ? frame.column : 1;

  if (!file || !line || isIgnoredFrame(file)) {
    return undefined;
  }

  const relativePath = path.isAbsolute(file)
    ? path.relative(workspaceRoot, file)
    : file;
  const normalizedPath = normalizePath(relativePath);

  if (!normalizedPath || normalizedPath.startsWith('..') || path.isAbsolute(normalizedPath) || isIgnoredFrame(normalizedPath)) {
    return undefined;
  }

  return { relativePath: normalizedPath, line, column };
}

function getFrameFile(frame: JsonObject): string | undefined {
  for (const key of ['file', 'url', 'source']) {
    const value = frame[key];
    if (typeof value === 'string' && value.length > 0) {
      return stripFileUrl(value);
    }
  }

  return undefined;
}

function stripFileUrl(value: string): string {
  if (!value.startsWith('file://')) {
    return value;
  }

  try {
    return new URL(value).pathname;
  } catch {
    return value.replace(/^file:\/\//, '');
  }
}

function isIgnoredFrame(file: string): boolean {
  const normalized = normalizePath(file);
  return normalized.includes('/node_modules/')
    || normalized.includes('/playwright-core/')
    || normalized.includes('/@playwright/test/')
    || normalized.startsWith('node_modules/')
    || normalized.startsWith('internal/')
    || normalized.startsWith('project#')
    || normalized.includes('/project#');
}

function readZipEntry(zipPath: string, entryName: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('Unable to open zip file.'));
        return;
      }

      let settled = false;
      const finish = (value: string | undefined) => {
        if (!settled) {
          settled = true;
          zipFile.close();
          resolve(value);
        }
      };

      zipFile.on('entry', (entry) => {
        if (entry.fileName !== entryName) {
          zipFile.readEntry();
          return;
        }

        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error(`Unable to read ${entryName}.`));
            return;
          }

          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
        });
      });
      zipFile.on('error', reject);
      zipFile.on('end', () => finish(undefined));
      zipFile.readEntry();
    });
  });
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
