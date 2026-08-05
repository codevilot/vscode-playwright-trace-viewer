const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  extractTraceSourceLocations,
  matchLocationsToTestRange,
  readTraceSourceLocations
} = require('../dist/playwright/traceMapping');

test('maps a long Korean test title by source location instead of result directory slug', () => {
  const workspaceRoot = path.join(os.tmpdir(), 'pw-workspace');
  const traceText = JSON.stringify({
    type: 'before',
    stack: [{ file: path.join(workspaceRoot, 'tdp-web/e2e/full-stack.spec.ts'), line: 42, column: 7 }]
  });
  const locations = extractTraceSourceLocations(traceText, workspaceRoot);

  assert.equal(matchLocationsToTestRange(locations, {
    relativePath: 'tdp-web/e2e/full-stack.spec.ts',
    line: 40,
    nextLine: 50
  }), true);
});

test('maps hashed Playwright result directories by trace stack location', () => {
  const workspaceRoot = path.join(os.tmpdir(), 'pw-workspace');
  const traceText = JSON.stringify({
    type: 'action',
    stack: [{ file: path.join(workspaceRoot, 'tests/checkout.spec.ts'), line: 12, column: 3 }]
  });
  const locations = extractTraceSourceLocations(traceText, workspaceRoot);

  assert.equal(matchLocationsToTestRange(locations, {
    relativePath: 'tests/checkout.spec.ts',
    line: 10,
    nextLine: 20
  }), true);
});

test('separates multiple tests in one spec file by declaration line range', () => {
  const locations = [
    { relativePath: 'tests/full-stack.spec.ts', line: 75, column: 1 }
  ];

  assert.equal(matchLocationsToTestRange(locations, {
    relativePath: 'tests/full-stack.spec.ts',
    line: 40,
    nextLine: 70
  }), false);
  assert.equal(matchLocationsToTestRange(locations, {
    relativePath: 'tests/full-stack.spec.ts',
    line: 70,
    nextLine: 100
  }), true);
});

test('supports helper-file test locations returned by Playwright discovery', () => {
  const locations = [
    { relativePath: 'tdp-web/e2e/helpers/scenarios.ts', line: 18, column: 5 },
    { relativePath: 'tdp-web/e2e/full-stack.spec.ts', line: 4, column: 1 }
  ];

  assert.equal(matchLocationsToTestRange(locations, {
    relativePath: 'tdp-web/e2e/helpers/scenarios.ts',
    line: 10,
    nextLine: 30
  }), true);
});

test('returns undefined for broken trace.zip or missing test.trace so callers can fallback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mapping-'));
  const brokenZip = path.join(dir, 'broken-trace.zip');
  const missingTraceZip = path.join(dir, 'missing-trace.zip');

  fs.writeFileSync(brokenZip, 'not a zip');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'ok');
  execFileSync('zip', ['-q', missingTraceZip, 'other.txt'], { cwd: dir });

  assert.equal(await readTraceSourceLocations(brokenZip, dir), undefined);
  assert.equal(await readTraceSourceLocations(missingTraceZip, dir), undefined);
});

test('filters project and Playwright internal stack frames', () => {
  const traceText = [
    JSON.stringify({ stack: [{ file: 'project#chromium', line: 1, column: 1 }] }),
    JSON.stringify({ stack: [{ file: 'node_modules/playwright-core/index.js', line: 2, column: 1 }] }),
    JSON.stringify({ stack: [{ file: 'tests/real.spec.ts', line: 30, column: 1 }] })
  ].join('\n');

  assert.deepEqual(extractTraceSourceLocations(traceText, process.cwd()), [
    { relativePath: 'tests/real.spec.ts', line: 30, column: 1 }
  ]);
});
