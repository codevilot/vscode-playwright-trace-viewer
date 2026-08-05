# Playwright Trace Viewer

A lightweight VS Code extension for opening Playwright trace.zip files quickly.

For `trace.zip` files, this extension uses the official Playwright trace viewer assets bundled through `playwright-core` and opens the viewer inside VS Code. It does not need `npx` or an internet connection to open traces.

For report and test commands, it calls the Playwright CLI:

```bash
npx playwright show-report
npx playwright test --trace on
```

## Features

- Open latest trace.zip from test-results
- Open selected trace.zip from Explorer context menu
- Open trace.zip by double-clicking it in Explorer
- Open Playwright HTML report
- Run Playwright tests with trace enabled
- Run Playwright tests with trace retained on failure
- Browse tests by Playwright `test()` title or by file path
- Run a single Playwright `test()` from the Tests sidebar by source location
- Compare scenario before/after states inside trace.zip with Scenario Diff
- Status bar shortcut for latest trace

## Scenario Diff

Scenario Diff is an optional view inside the embedded trace viewer for tests that attach structured before/after state. Open a `trace.zip`, then use the `Trace / Scenario Diff` toggle where Playwright normally shows the `Action / Before / After` snapshot tabs.

The Scenario Diff view shows cases in the left list and the selected case detail on the right. Use the `All / Visual / JSON / Delta` filter to focus on one kind of evidence at a time. A case can include a visual before/after pair, a JSON field diff, and one or more summary attachments.

Naming rules:

- Use `test.step('before: case name')` and `test.step('after: case name')` to group scenario cases in the trace.
- Attach JSON named `before-case-key` and `after-case-key` to show changed fields.
- Attach JSON named `case-key-delta` to show a summary payload.
- Attach screenshots named `before-case-key` and `after-case-key` with `image/png` content type to show Visual.

Minimal example:

```ts
import { expect, test } from '@playwright/test';

test('curation KPI scenario', async ({ page }) => {
  const before = await test.step('before: collector KPI', async () => {
    const state = { completedCount: 12, silverHours: 4, totalScore: 14400 };
    await attachJson('before-collector-kpi', state);
    await page.goto('/admin/control-tower');
    await attachScreenshot(page, 'before-collector-kpi');
    return state;
  });

  await test.step('when: curator approves as good', async () => {
    await page.getByRole('button', { name: 'Good' }).click();
  });

  const after = await test.step('after: collector KPI', async () => {
    const state = { completedCount: 13, silverHours: 5, totalScore: 18000 };
    await attachJson('after-collector-kpi', state);
    await page.goto('/admin/control-tower');
    await attachScreenshot(page, 'after-collector-kpi');
    return state;
  });

  await attachJson('collector-kpi-delta', {
    completedCount: after.completedCount - before.completedCount,
    silverHours: after.silverHours - before.silverHours,
    totalScore: after.totalScore - before.totalScore
  });

  expect(after.silverHours).toBe(before.silverHours + 1);
});

async function attachJson(name: string, data: unknown) {
  await test.info().attach(name, {
    body: JSON.stringify(data, null, 2),
    contentType: 'application/json'
  });
}

async function attachScreenshot(page: import('@playwright/test').Page, name: string) {
  await test.info().attach(name, {
    body: await page.screenshot(),
    contentType: 'image/png'
  });
}
```

Run with trace enabled so the test, attachments, and normal Playwright trace can be opened together:

```bash
npx playwright test --trace on
```

## Tests Sidebar

The Tests sidebar supports two workspace-persisted view modes.

`View by Test Name` shows Playwright tests by source folder, `test.describe()` hierarchy, and `test()` title. Test file location is shown as secondary metadata, and matched trace files appear under the related test node. Running a test node executes only that `test()` using its source location, for example:

```bash
npx playwright test e2e/bronze-data-lifecycle.spec.ts:28 --trace on
```

`View by File Name` shows folders and test files. Running a file node executes every test in that file, for example:

```bash
npx playwright test e2e/bronze-data-lifecycle.spec.ts --trace on
```

Use the view selector in the Tests toolbar to switch between `View by Test Name` and `View by File Name`. Search works inside the selected mode: test mode searches titles, describe titles, title paths, and file paths; file mode searches file and folder paths.

Test-name discovery uses Playwright's own test listing command and loads the workspace Playwright configuration. If discovery fails or Playwright is not installed in the workspace, the sidebar falls back to the file-name view and writes the command output to the Playwright Trace Viewer output channel.

## Commands

- Playwright Trace Viewer: Open Latest Trace
- Open Playwright Trace
- Playwright Trace Viewer: Open Report
- Playwright Trace Viewer: Run Tests with Trace
- Playwright Trace Viewer: Run Tests Retain Trace on Failure

## Settings

`playwrightTraceViewer.traceGlob`

Default: `**/test-results/**/*trace.zip`

`playwrightTraceViewer.packageRunner`

Default: `npx`

Allowed examples: `npx`, `pnpm`, `yarn`

`playwrightTraceViewer.testExplorerViewMode`

Default: `test`

Allowed values: `test`, `file`

`playwrightTraceViewer.workingDirectory`

Default: empty, auto-detects the nearest `package.json` or Playwright config from the active or selected test file.

## Usage

1. Install dependencies with `npm install`.
2. Compile with `npm run compile`.
3. Open this folder in VS Code.
4. Press `F5` to launch an Extension Development Host.
5. Open a Playwright project in the Extension Development Host.
6. Run one of the contributed commands from the Command Palette.

Manual Tests sidebar checks:

- A file with one `test()` and no `test.describe()` appears as a test title with the file shown as metadata.
- A file with multiple tests shows each `test()` as a separate runnable node.
- Nested `test.describe()` blocks appear as nested suite nodes ending in test title nodes.
- Tests with the same title in different files run by their own `file:line` target.
- Similar test titles in the same file run by their own `file:line` target.
- A test file under a path containing spaces runs without shell quoting issues.
- Invalid Playwright configuration or failed discovery falls back to file-name view and logs stderr in the output channel.
- A workspace without Playwright installed does not break the sidebar.
- On Windows, test execution uses process arguments rather than a concatenated shell command.

For a typical Playwright workflow, run `Playwright Trace Viewer: Run Tests Retain Trace on Failure`, then use `Playwright Trace Viewer: Open Latest Trace` after a failing test generates a trace under `test-results`.

Double-clicking `trace.zip` in Explorer opens it through this extension and launches the Playwright trace viewer. You can also right-click `trace.zip` in Explorer and choose `Open Playwright Trace`, or run `Playwright Trace Viewer: Open Latest Trace`.
