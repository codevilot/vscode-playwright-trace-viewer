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
- Status bar shortcut for latest trace

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
