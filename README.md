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
- Status bar shortcut for latest trace

## Commands

- Playwright Trace Viewer: Open Latest Trace
- Open Playwright Trace
- Playwright Trace Viewer: Open Report
- Playwright Trace Viewer: Run Tests with Trace
- Playwright Trace Viewer: Run Tests Retain Trace on Failure

## Settings

`playwrightTraceViewer.traceGlob`

Default: `test-results/**/trace.zip`

`playwrightTraceViewer.packageRunner`

Default: `npx`

Allowed examples: `npx`, `pnpm`, `yarn`

## Usage

1. Install dependencies with `npm install`.
2. Compile with `npm run compile`.
3. Open this folder in VS Code.
4. Press `F5` to launch an Extension Development Host.
5. Open a Playwright project in the Extension Development Host.
6. Run one of the contributed commands from the Command Palette.

For a typical Playwright workflow, run `Playwright Trace Viewer: Run Tests Retain Trace on Failure`, then use `Playwright Trace Viewer: Open Latest Trace` after a failing test generates `test-results/**/trace.zip`.

Double-clicking `trace.zip` in Explorer opens it through this extension and launches the Playwright trace viewer. You can also right-click `trace.zip` in Explorer and choose `Open Playwright Trace`, or run `Playwright Trace Viewer: Open Latest Trace`.
