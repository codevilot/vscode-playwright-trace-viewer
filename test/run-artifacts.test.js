const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: {
        workspaceFolders: undefined,
        getConfiguration: () => ({ get: (_key, fallback) => fallback }),
        findFiles: async () => []
      },
      Uri: { file: (fsPath) => ({ fsPath }) }
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

const { getPlaywrightOutputDir } = require('../dist/playwright/runArtifacts');

test('uses short stable prefix and unique run id for repeated executions', () => {
  const longSelection = 'tdp-web/e2e/full-stack.spec.ts '.repeat(20);
  const first = getPlaywrightOutputDir([longSelection]);
  const second = getPlaywrightOutputDir([longSelection]);
  const firstBase = path.basename(first);
  const secondBase = path.basename(second);
  const firstStablePrefix = firstBase.split('-').slice(0, -3).join('-');
  const secondStablePrefix = secondBase.split('-').slice(0, -3).join('-');

  assert.notEqual(first, second);
  assert.equal(path.dirname(first), 'test-results');
  assert.equal(firstStablePrefix, secondStablePrefix);
  assert.ok(firstBase.length < 90, firstBase);
});
