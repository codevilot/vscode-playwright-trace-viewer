import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { getWorkspaceRoot, validateTraceUri } from './trace';

const viewType = 'playwrightTraceViewer.traceZipEditor';
const scenarioDiffRoutePath = '/pw-tv-scenario-diff';
const scenarioDiffTraceRoutePath = '/trace/pw-tv-scenario-diff';

type TraceViewerServer = {
  stop(): Promise<void>;
  urlPrefix(purpose: 'human-readable' | 'precise'): string;
  _routes?: TraceViewerRoute[];
  routePath(
    path: string,
    handler: (
      request: unknown,
      response: TraceViewerResponse
    ) => boolean
  ): void;
};

type TraceViewerRoute = {
  exact?: string;
  prefix?: string;
  handler: (request: unknown, response: TraceViewerResponse) => boolean;
};

type TraceViewerResponse = {
  statusCode: number;
  setHeader(name: string, value: number | string): void;
  end(data?: string | Buffer): void;
};

type ScenarioDiffAttachment = {
  name: string;
  data: unknown;
};

type ScenarioVisualAttachment = {
  name: string;
  contentType: string;
  dataUrl: string;
  source: 'attachment' | 'trace';
};

type ScenarioDiffPair = {
  key: string;
  before?: ScenarioDiffAttachment;
  after?: ScenarioDiffAttachment;
};

type ScenarioVisualPair = {
  key: string;
  before?: ScenarioVisualAttachment;
  after?: ScenarioVisualAttachment;
};

type ScenarioDiffPayload = {
  pairs: ScenarioDiffPair[];
  visualPairs: ScenarioVisualPair[];
  deltas: ScenarioDiffAttachment[];
  attachmentCount: number;
};

type PlaywrightCoreBundle = {
  server: {
    startTraceViewerServer(options: {
      host?: string;
      port?: number;
      allowedFileRoots?: string[];
    }): Promise<TraceViewerServer>;
  };
};

export function registerTraceViewer(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      viewType,
      new TraceZipEditorProvider(),
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );
}

export async function openTraceViewer(tracePath: string): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(tracePath), viewType, {
    preview: false
  });
}

class TraceZipDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}

  dispose(): void {
    // Nothing to dispose.
  }
}

class TraceZipEditorProvider implements vscode.CustomReadonlyEditorProvider<TraceZipDocument> {
  openCustomDocument(uri: vscode.Uri): TraceZipDocument {
    return new TraceZipDocument(uri);
  }

  async resolveCustomEditor(document: TraceZipDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    const tracePath = validateTraceUri(document.uri);
    const workspaceRoot = getWorkspaceRootForUri(document.uri);

    webviewPanel.title = 'Playwright Trace';
    webviewPanel.webview.options = {
      enableScripts: true
    };

    if (!workspaceRoot) {
      webviewPanel.webview.html = renderMessage('Open a workspace folder before opening a Playwright trace.');
      return;
    }

    if (!tracePath) {
      webviewPanel.webview.html = renderMessage('Select a Playwright trace file named trace.zip.');
      return;
    }

    webviewPanel.webview.html = renderMessage('Opening Playwright trace...');

    try {
      const server = await startBundledTraceViewerServer(tracePath, workspaceRoot);
      configureScenarioDiffRoute(server, tracePath);
      configureTraceViewerKeyboardShortcuts(server);
      configureRootRedirect(server, tracePath);
      const viewerUrl = await buildTraceViewerUrl(server);
      webviewPanel.webview.html = renderTraceViewer(webviewPanel.webview, viewerUrl);

      webviewPanel.onDidDispose(() => {
        server.stop().catch(() => {
          // Ignore shutdown errors from an already-closed local server.
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      webviewPanel.webview.html = renderMessage(`Failed to open Playwright trace: ${message}`);
      vscode.window.showErrorMessage(`Failed to open Playwright trace: ${message}`);
    }
  }
}

async function startBundledTraceViewerServer(tracePath: string, workspaceRoot: string): Promise<TraceViewerServer> {
  const playwrightCore = getPlaywrightCoreBundle();
  return playwrightCore.server.startTraceViewerServer({
    host: '127.0.0.1',
    port: 0,
    allowedFileRoots: [
      workspaceRoot,
      path.dirname(tracePath)
    ]
  });
}

function getPlaywrightCoreBundle(): PlaywrightCoreBundle {
  const packageJsonPath = require.resolve('playwright-core/package.json');
  const coreBundlePath = path.join(path.dirname(packageJsonPath), 'lib', 'coreBundle.js');
  return require(coreBundlePath) as PlaywrightCoreBundle;
}

async function buildTraceViewerUrl(server: TraceViewerServer): Promise<string> {
  const localViewerUri = vscode.Uri.parse(`${server.urlPrefix('human-readable')}/`);
  return (await vscode.env.asExternalUri(localViewerUri)).toString();
}

function configureRootRedirect(server: TraceViewerServer, tracePath: string): void {
  const redirectPath = buildTraceViewerRedirectPath(tracePath);

  server.routePath('/', (_request, response) => {
    response.statusCode = 302;
    response.setHeader('Location', redirectPath);
    response.end();
    return true;
  });
}

function configureTraceViewerKeyboardShortcuts(server: TraceViewerServer): void {
  const handler = (_request: unknown, response: TraceViewerResponse): boolean => {
    const html = renderTraceViewerIndexWithKeyboardShortcuts();
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Content-Length', Buffer.byteLength(html));
    response.end(html);
    return true;
  };

  const route = {
    exact: '/trace/index.html',
    handler
  };

  if (server._routes) {
    server._routes.unshift(route);
  } else {
    server.routePath('/trace/index.html', handler);
  }
}

function renderTraceViewerIndexWithKeyboardShortcuts(): string {
  const indexHtmlPath = path.join(
    path.dirname(require.resolve('playwright-core/package.json')),
    'lib',
    'vite',
    'traceViewer',
    'index.html'
  );
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const viewerCustomizations = `<style>
.timeline-view-container.pw-tv-youtube-timeline {
  border-top: 1px solid var(--vscode-panel-border);
  border-bottom: 0;
  background: var(--vscode-panel-background);
}

.pw-tv-youtube-timeline .timeline-view {
  height: 38px;
  margin: 0 14px;
  padding-top: 0;
  justify-content: flex-end;
  cursor: pointer;
}

.pw-tv-youtube-timeline .film-strip {
  position: absolute;
  inset: 0;
  min-height: 0;
  pointer-events: none;
}

.pw-tv-youtube-timeline .film-strip-lanes {
  height: 1px;
  min-height: 1px;
  max-height: 1px;
  opacity: 0;
  overflow: hidden;
  pointer-events: none;
}

.pw-tv-youtube-timeline .film-strip-frame {
  box-shadow: none;
}

.pw-tv-youtube-timeline .film-strip-hover {
  top: auto !important;
  bottom: 34px;
  max-width: min(420px, 45vw);
  overflow: hidden;
  border-radius: 4px;
  border: 1px solid var(--vscode-panel-border);
  transform: none;
}

.pw-tv-youtube-timeline .film-strip-hover > div:first-child {
  width: auto !important;
  height: auto !important;
}

.pw-tv-youtube-timeline .film-strip-hover img {
  display: block;
  width: auto !important;
  height: auto !important;
  max-width: min(420px, 45vw);
  max-height: min(260px, 38vh);
  object-fit: contain;
}

.pw-tv-youtube-timeline .film-strip-hover-title {
  max-width: min(420px, 45vw);
  background: var(--vscode-panel-background);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.pw-tv-youtube-timeline .timeline-time,
.pw-tv-youtube-timeline .timeline-divider {
  display: none;
}

.pw-tv-youtube-timeline .timeline-grid {
  display: none;
}

.pw-tv-youtube-timeline .timeline-window {
  bottom: 0;
  z-index: 2;
}

.pw-tv-youtube-timeline .timeline-window-drag {
  height: 38px;
}

.pw-tv-youtube-timeline .playback-scrubber {
  height: 28px;
  z-index: 3;
}

.pw-tv-youtube-timeline .playback-track,
.pw-tv-youtube-timeline .playback-track-filled {
  top: 13px;
  height: 4px;
  border-radius: 2px;
}

.pw-tv-youtube-timeline .playback-tick {
  top: 10px;
  height: 10px;
  opacity: .45;
}

.pw-tv-youtube-timeline .playback-thumb {
  top: 9px;
  width: 12px;
  height: 12px;
  margin-left: -6px;
}

body.pw-tv-focus-mode .pw-tv-properties-sidebar {
  flex-basis: 0 !important;
  width: 0 !important;
  height: 0 !important;
  min-width: 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
  border: 0 !important;
}

body.pw-tv-focus-mode .pw-tv-properties-sidebar.pw-tv-details-in-nav {
  display: none !important;
}

body.pw-tv-focus-mode .pw-tv-action-sidebar.pw-tv-action-details-selected .pw-tv-properties-sidebar.pw-tv-details-in-nav {
  display: flex !important;
  flex: auto !important;
  flex-basis: auto !important;
  width: auto !important;
  height: auto !important;
  min-width: 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
  border: 0 !important;
  background: var(--vscode-panel-background);
}

body.pw-tv-focus-mode .pw-tv-action-sidebar.pw-tv-action-details-selected .pw-tv-action-tab-content > :not(.pw-tv-properties-sidebar) {
  display: none !important;
}

body.pw-tv-focus-mode .pw-tv-action-sidebar.pw-tv-action-details-selected .pw-tv-details-nav-tab {
  background-color: var(--vscode-tab-activeBackground);
}

body.pw-tv-focus-mode .pw-tv-details-nav-tab {
  height: 100%;
}

body.pw-tv-focus-mode .pw-tv-properties-resizer {
  display: none !important;
}

body.pw-tv-focus-mode .pw-tv-action-sidebar {
  display: flex;
  flex-basis: clamp(220px, 24vw, 300px) !important;
}

body.pw-tv-focus-mode .pw-tv-action-split {
  flex-direction: row-reverse !important;
}

body.pw-tv-focus-mode.pw-tv-actions-bottom .pw-tv-action-split {
  flex-direction: column !important;
}

body.pw-tv-focus-mode.pw-tv-actions-bottom .pw-tv-action-sidebar {
  flex-basis: clamp(140px, 24vh, 220px) !important;
  width: auto !important;
  border-top: 1px solid var(--vscode-panel-border) !important;
  border-right: 0 !important;
}

body.pw-tv-focus-mode.pw-tv-actions-bottom .pw-tv-action-resizer {
  display: none !important;
}

body.pw-tv-focus-mode.pw-tv-hide-actions .pw-tv-action-sidebar {
  flex-basis: 0 !important;
  width: 0 !important;
  min-width: 0 !important;
  overflow: hidden !important;
  border: 0 !important;
}

body.pw-tv-focus-mode.pw-tv-hide-actions .pw-tv-action-resizer {
  display: none !important;
}

.pw-tv-layout-controls {
  position: fixed;
  top: 6px;
  right: 8px;
  z-index: 500;
  display: flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background: var(--vscode-sideBar-background);
  box-shadow: #0002 0 1.6px 10px, #0000001c 0 .3px 10px;
}

.pw-tv-layout-controls button {
  width: 28px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  color: var(--vscode-sideBarTitle-foreground);
  background: transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.pw-tv-layout-controls button:hover,
body.pw-tv-focus-mode:not(.pw-tv-hide-actions) .pw-tv-layout-controls [data-panel="actions"],
body.pw-tv-actions-bottom .pw-tv-layout-controls [data-panel="placement"],
body:not(.pw-tv-focus-mode) .pw-tv-layout-controls [data-panel="layout"] {
  background: var(--vscode-toolbar-hoverBackground);
}

.pw-tv-layout-controls .codicon {
  font-size: 16px;
  line-height: 1;
}

body.pw-tv-focus-mode .snapshot-wrapper {
  padding: 4px;
}

body.pw-tv-focus-mode .snapshot-container {
  box-shadow: 0 8px 18px #0002, 0 1px 3px #0000001a;
}

body.pw-tv-focus-mode .workbench-action-filter {
  margin-top: 0;
}

body.pw-tv-focus-mode .workbench-action-filter input[type=search] {
  line-height: 18px;
  padding: 3px 8px;
}

body.pw-tv-focus-mode .tabbed-pane .toolbar {
  min-height: 26px;
}

body.pw-tv-focus-mode .tabbed-pane-tab {
  padding-left: 5px;
  padding-right: 5px;
}

body.pw-tv-focus-mode .tree-view-entry {
  line-height: 24px;
}

body.pw-tv-focus-mode .action-title-selector {
  display: none;
}

.pw-tv-scenario-diff-panel {
  position: fixed;
  top: 44px;
  right: 8px;
  bottom: 8px;
  left: 8px;
  z-index: 420;
  display: none;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
  overflow: hidden;
}

body.pw-tv-scenario-mode .pw-tv-scenario-diff-panel {
  display: flex;
  flex-direction: column;
}

body.pw-tv-scenario-mode .workbench {
  visibility: hidden;
}

.pw-tv-hidden-snapshot-tab {
  display: none !important;
}

.pw-tv-snapshot-scenario-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 100%;
  margin-left: 4px;
}

.pw-tv-snapshot-scenario-toggle button {
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: 3px;
  color: var(--vscode-foreground);
  background: transparent;
  cursor: pointer;
  font: inherit;
}

.pw-tv-snapshot-scenario-toggle button:hover,
.pw-tv-snapshot-scenario-toggle button[data-active="true"] {
  background: var(--vscode-toolbar-hoverBackground);
}

.pw-tv-scenario-diff-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.pw-tv-scenario-diff-title {
  font-weight: 600;
  flex: auto;
}

.pw-tv-scenario-diff-close,
.pw-tv-scenario-refresh,
.pw-tv-scenario-help-toggle {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 3px;
  color: inherit;
  background: transparent;
  cursor: pointer;
}

.pw-tv-scenario-diff-close:hover,
.pw-tv-scenario-refresh:hover,
.pw-tv-scenario-help-toggle:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.pw-tv-scenario-diff-content {
  min-height: 0;
  flex: auto;
}

.pw-tv-scenario-help {
  display: none;
  padding: 10px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-editor-background);
  font-size: 12px;
  line-height: 1.45;
}

.pw-tv-scenario-help[data-open="true"] {
  display: block;
}

.pw-tv-scenario-help code {
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-editor-font-family, monospace);
}

.pw-tv-scenario-help div + div {
  margin-top: 4px;
}

.pw-tv-scenario-layout {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  flex: auto;
  min-height: 0;
}

.pw-tv-scenario-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.pw-tv-scenario-kind-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-sideBar-background);
}

.pw-tv-scenario-kind-tabs button {
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  color: inherit;
  background: transparent;
  cursor: pointer;
  font: inherit;
}

.pw-tv-scenario-kind-tabs button:hover,
.pw-tv-scenario-kind-tabs button[data-active="true"] {
  background: var(--vscode-toolbar-hoverBackground);
}

.pw-tv-scenario-list {
  overflow: auto;
  border-right: 1px solid var(--vscode-panel-border);
  background: var(--vscode-sideBar-background);
}

.pw-tv-scenario-case-button {
  display: block;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border), transparent 45%);
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
}

.pw-tv-scenario-case-button:hover,
.pw-tv-scenario-case-button[data-active="true"] {
  background: var(--vscode-list-hoverBackground);
}

.pw-tv-scenario-case-title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.pw-tv-scenario-case-meta {
  display: block;
  margin-top: 3px;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}

.pw-tv-scenario-detail {
  min-width: 0;
  overflow: auto;
  padding: 10px;
}

.pw-tv-scenario-diff-empty,
.pw-tv-scenario-diff-error {
  padding: 12px;
  color: var(--vscode-descriptionForeground);
}

.pw-tv-scenario-card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  margin-bottom: 10px;
  background: var(--vscode-editor-background);
}

.pw-tv-scenario-card-title {
  padding: 8px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
  font-weight: 600;
}

.pw-tv-scenario-source {
  float: right;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  font-weight: 400;
}

.pw-tv-scenario-row {
  display: grid;
  grid-template-columns: minmax(160px, 1.2fr) minmax(0, 1fr) minmax(0, 1fr) minmax(54px, auto);
  gap: 8px;
  align-items: center;
  padding: 6px 10px;
  border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border), transparent 50%);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
}

.pw-tv-scenario-row:first-child {
  border-top: 0;
}

.pw-tv-scenario-path {
  color: var(--vscode-descriptionForeground);
  overflow-wrap: anywhere;
}

.pw-tv-scenario-before,
.pw-tv-scenario-after,
.pw-tv-scenario-delta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pw-tv-scenario-delta {
  color: var(--vscode-testing-iconPassed);
  text-align: right;
}

.pw-tv-scenario-delta[data-negative="true"] {
  color: var(--vscode-testing-iconFailed);
}

.pw-tv-scenario-json {
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  max-height: 240px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
}

.pw-tv-visual-toolbar {
  display: flex;
  gap: 4px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.pw-tv-visual-toolbar button {
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  color: inherit;
  background: transparent;
  cursor: pointer;
}

.pw-tv-visual-toolbar button[data-active="true"],
.pw-tv-visual-toolbar button:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.pw-tv-visual-body {
  padding: 10px;
}

.pw-tv-visual-sxs {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
}

.pw-tv-visual-frame {
  min-width: 0;
}

.pw-tv-visual-label {
  margin-bottom: 6px;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.pw-tv-visual-image {
  display: block;
  width: 100%;
  max-height: 360px;
  object-fit: contain;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background: var(--vscode-editor-background);
}

.pw-tv-visual-stack {
  position: relative;
  overflow: hidden;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background: var(--vscode-editor-background);
}

.pw-tv-visual-stack img {
  display: block;
  width: 100%;
  max-height: 460px;
  object-fit: contain;
}

.pw-tv-visual-stack .pw-tv-visual-after-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.pw-tv-visual-stack .pw-tv-visual-after-layer img {
  width: 100%;
  height: 100%;
  max-height: none;
  object-fit: contain;
}

.pw-tv-visual-slider {
  width: 100%;
  margin-top: 8px;
}

.pw-tv-visual-difference {
  position: relative;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  overflow: hidden;
  background: #000;
}

.pw-tv-visual-difference img {
  display: block;
  width: 100%;
  max-height: 460px;
  object-fit: contain;
}

.pw-tv-visual-difference img + img {
  position: absolute;
  inset: 0;
  height: 100%;
  max-height: none;
  mix-blend-mode: difference;
  opacity: .9;
}
</style>
<script>
(() => {
  let hasStartedPlayback = false;
  let replayingClick = false;

  const findToolbarButton = title =>
    document.querySelector('button[title="' + title + '"]');

  const isEditableTarget = target => {
    if (!(target instanceof Element))
      return false;
    const editable = target.closest('input, textarea, select, [contenteditable="true"]');
    return !!editable;
  };

  const playFromStartIfNeeded = playButton => {
    if (hasStartedPlayback)
      return false;
    const stopButton = findToolbarButton('Stop');
    if (!stopButton || stopButton.disabled)
      return false;
    hasStartedPlayback = true;
    stopButton.click();
    requestAnimationFrame(() => {
      replayingClick = true;
      playButton.click();
      replayingClick = false;
    });
    return true;
  };

  const togglePlayback = () => {
    const pauseButton = findToolbarButton('Pause');
    if (pauseButton) {
      pauseButton.click();
      return;
    }
    const playButton = findToolbarButton('Play');
    if (!playButton || playButton.disabled)
      return;
    if (!playFromStartIfNeeded(playButton)) {
      hasStartedPlayback = true;
      playButton.click();
    }
  };

  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isEditableTarget(event.target))
      return;
    event.preventDefault();
    event.stopPropagation();
    togglePlayback();
  }, true);

  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.type !== 'playwrightTraceViewer.togglePlayback')
      return;
    togglePlayback();
  });

  document.addEventListener('click', event => {
    if (replayingClick)
      return;
    const playButton = event.target instanceof Element ? event.target.closest('button[title="Play"]') : null;
    if (!playButton)
      return;
    if (playFromStartIfNeeded(playButton)) {
      event.preventDefault();
      event.stopPropagation();
    } else {
      hasStartedPlayback = true;
    }
  }, true);

  const placeTimelineBelowSnapshot = () => {
    const timeline = document.querySelector('.timeline-view-container');
    const snapshotTab = document.querySelector('.snapshot-tab');
    if (!timeline || !snapshotTab)
      return;
    timeline.classList.add('pw-tv-youtube-timeline');
    if (timeline.parentElement === snapshotTab)
      return;
    snapshotTab.appendChild(timeline);
  };

  const scenarioDiff = (() => {
    let panel;
    let content;
    let loaded = false;
    let selectedKey;
    let selectedKind = 'all';

    const formatValue = value => {
      if (typeof value === 'string')
        return JSON.stringify(value);
      if (typeof value === 'number' || typeof value === 'boolean' || value === null)
        return String(value);
      return JSON.stringify(value);
    };

    const flatten = (value, prefix = '', output = new Map()) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const entries = Object.entries(value);
        if (entries.length) {
          for (const [key, child] of entries)
            flatten(child, prefix ? prefix + '.' + key : key, output);
          return output;
        }
      }
      output.set(prefix || '(root)', value);
      return output;
    };

    const deltaLabel = (before, after) => {
      if (typeof before === 'number' && typeof after === 'number') {
        const delta = after - before;
        return {
          text: delta > 0 ? '+' + delta : String(delta),
          negative: delta < 0
        };
      }
      return { text: 'changed', negative: false };
    };

    const changedRows = pair => {
      if (!pair.before || !pair.after)
        return [];
      const before = flatten(pair.before.data);
      const after = flatten(pair.after.data);
      const keys = Array.from(new Set([...before.keys(), ...after.keys()])).sort();
      return keys
        .filter(key => JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key)))
        .map(key => {
          const delta = deltaLabel(before.get(key), after.get(key));
          return { key, before: before.get(key), after: after.get(key), delta };
        });
    };

    const renderPair = pair => {
      const rows = changedRows(pair);
      if (!rows.length) {
        return '<section class="pw-tv-scenario-card"><div class="pw-tv-scenario-card-title">' +
          escapeHtml(pair.key) + '</div><div class="pw-tv-scenario-diff-empty">No changed JSON fields detected.</div></section>';
      }
      return '<section class="pw-tv-scenario-card"><div class="pw-tv-scenario-card-title">' +
        escapeHtml(pair.key) + '</div>' +
        rows.map(row => '<div class="pw-tv-scenario-row">' +
          '<div class="pw-tv-scenario-path" title="' + escapeHtml(row.key) + '">' + escapeHtml(row.key) + '</div>' +
          '<div class="pw-tv-scenario-before" title="' + escapeHtml(formatValue(row.before)) + '">' + escapeHtml(formatValue(row.before)) + '</div>' +
          '<div class="pw-tv-scenario-after" title="' + escapeHtml(formatValue(row.after)) + '">' + escapeHtml(formatValue(row.after)) + '</div>' +
          '<div class="pw-tv-scenario-delta" data-negative="' + row.delta.negative + '">' + escapeHtml(row.delta.text) + '</div>' +
        '</div>').join('') + '</section>';
    };

    const renderDelta = attachment => '<section class="pw-tv-scenario-card">' +
      '<div class="pw-tv-scenario-card-title">' + escapeHtml(attachment.name) + '</div>' +
      '<pre class="pw-tv-scenario-json">' + escapeHtml(JSON.stringify(attachment.data, null, 2)) + '</pre>' +
      '</section>';

    const hasKind = (scenarioCase, kind) => {
      if (kind === 'visual')
        return !!scenarioCase.visual;
      if (kind === 'json')
        return !!scenarioCase.pair;
      if (kind === 'delta')
        return scenarioCase.deltas.length > 0;
      return !!scenarioCase.visual || !!scenarioCase.pair || scenarioCase.deltas.length > 0;
    };

    const renderCaseDetail = scenarioCase => {
      const parts = [];
      if ((selectedKind === 'all' || selectedKind === 'visual') && scenarioCase.visual)
        parts.push(renderVisualPair(scenarioCase.visual));
      if ((selectedKind === 'all' || selectedKind === 'json') && scenarioCase.pair)
        parts.push(renderPair(scenarioCase.pair));
      if (selectedKind === 'all' || selectedKind === 'delta')
        parts.push(...scenarioCase.deltas.map(renderDelta));
      return parts.join('') || '<div class="pw-tv-scenario-diff-empty">No ' + escapeHtml(selectedKind) + ' detail for this case.</div>';
    };

    const renderCaseList = cases => cases.map(scenarioCase => {
      const kinds = [
        scenarioCase.visual ? 'visual' : '',
        scenarioCase.pair ? 'json' : '',
        scenarioCase.deltas.length ? 'delta' : ''
      ].filter(Boolean).join(' / ');
      return '<button type="button" class="pw-tv-scenario-case-button" data-case-key="' + escapeHtml(scenarioCase.key) + '" data-active="' + (scenarioCase.key === selectedKey) + '">' +
        '<span class="pw-tv-scenario-case-title">' + escapeHtml(scenarioCase.key) + '</span>' +
        '<span class="pw-tv-scenario-case-meta">' + escapeHtml(kinds || 'empty') + '</span>' +
        '</button>';
    }).join('');

    const renderKindTabs = allCases => {
      const kinds = [
        ['all', 'All', allCases.filter(scenarioCase => hasKind(scenarioCase, 'all')).length],
        ['visual', 'Visual', allCases.filter(scenarioCase => hasKind(scenarioCase, 'visual')).length],
        ['json', 'JSON', allCases.filter(scenarioCase => hasKind(scenarioCase, 'json')).length],
        ['delta', 'Delta', allCases.filter(scenarioCase => hasKind(scenarioCase, 'delta')).length]
      ];
      return '<div class="pw-tv-scenario-kind-tabs" role="tablist" aria-label="Scenario diff type filter">' +
        kinds.map(([kind, label, count]) => '<button type="button" data-kind-filter="' + kind + '" data-active="' + (selectedKind === kind) + '">' +
          escapeHtml(label) + ' ' + escapeHtml(count) +
          '</button>').join('') +
        '</div>';
    };

    const renderCases = payload => {
      const allCases = buildCases(payload);
      if (!allCases.length)
        return '';
      const cases = allCases.filter(scenarioCase => hasKind(scenarioCase, selectedKind));
      if (!selectedKey || !cases.some(scenarioCase => scenarioCase.key === selectedKey))
        selectedKey = cases[0]?.key;
      const selected = cases.find(scenarioCase => scenarioCase.key === selectedKey);

      if (!selected)
        return '<div class="pw-tv-scenario-view">' + renderKindTabs(allCases) +
          '<div class="pw-tv-scenario-diff-empty">No Scenario Diff ' + escapeHtml(selectedKind) + ' items found.</div></div>';

      return '<div class="pw-tv-scenario-view">' +
        renderKindTabs(allCases) +
        '<div class="pw-tv-scenario-layout">' +
        '<nav class="pw-tv-scenario-list" aria-label="Scenario diff cases">' + renderCaseList(cases) + '</nav>' +
        '<main class="pw-tv-scenario-detail">' + renderCaseDetail(selected) + '</main>' +
        '</div></div>';
    };

    const buildCases = payload => {
      const cases = new Map();
      const ensure = key => {
        const existing = cases.get(key);
        if (existing)
          return existing;
        const created = { key, visual: undefined, pair: undefined, deltas: [] };
        cases.set(key, created);
        return created;
      };

      for (const visual of payload.visualPairs)
        ensure(visual.key).visual = visual;
      for (const pair of payload.pairs)
        ensure(pair.key).pair = pair;
      for (const delta of payload.deltas)
        ensure(delta.name.replace(/-delta$/u, '')).deltas.push(delta);

      return [...cases.values()].sort((a, b) => a.key.localeCompare(b.key));
    };

    const imageFrame = (title, image) => '<div class="pw-tv-visual-frame">' +
      '<div class="pw-tv-visual-label">' + escapeHtml(title) + '</div>' +
      (image
        ? '<img class="pw-tv-visual-image" src="' + escapeHtml(image.dataUrl) + '" alt="' + escapeHtml(title) + '">'
        : '<div class="pw-tv-scenario-diff-empty">Missing ' + escapeHtml(title.toLowerCase()) + ' image.</div>') +
      '</div>';

    const renderVisualPair = pair => {
      const canCompare = pair.before && pair.after;
      const firstMode = canCompare ? 'sxs' : 'single';
      const source = pair.before?.source || pair.after?.source || 'attachment';
      return '<section class="pw-tv-scenario-card pw-tv-visual-card" data-mode="' + firstMode + '" data-key="' + escapeHtml(pair.key) + '">' +
        '<div class="pw-tv-scenario-card-title">' + escapeHtml(pair.key) +
        '<span class="pw-tv-scenario-source">' + escapeHtml(source === 'trace' ? 'trace frame' : 'attachment') + '</span></div>' +
        '<div class="pw-tv-visual-toolbar">' +
        '<button data-visual-mode="sxs" data-active="' + (firstMode === 'sxs') + '">Side by side</button>' +
        '<button data-visual-mode="slider" data-active="false" ' + (canCompare ? '' : 'disabled') + '>Slider</button>' +
        '<button data-visual-mode="difference" data-active="false" ' + (canCompare ? '' : 'disabled') + '>Difference</button>' +
        '</div>' +
        '<div class="pw-tv-visual-body">' + renderVisualBody(pair, firstMode) + '</div>' +
        '</section>';
    };

    const renderVisualBody = (pair, mode, split = 50) => {
      if (!pair.before || !pair.after)
        return '<div class="pw-tv-visual-sxs">' + imageFrame('Before', pair.before) + imageFrame('After', pair.after) + '</div>';
      if (mode === 'slider') {
        return '<div class="pw-tv-visual-stack">' +
          '<img src="' + escapeHtml(pair.before.dataUrl) + '" alt="Before">' +
          '<div class="pw-tv-visual-after-layer" style="width:' + split + '%">' +
          '<img src="' + escapeHtml(pair.after.dataUrl) + '" alt="After">' +
          '</div>' +
          '</div>' +
          '<input class="pw-tv-visual-slider" type="range" min="0" max="100" value="' + split + '" aria-label="Before after split">';
      }
      if (mode === 'difference') {
        return '<div class="pw-tv-visual-difference">' +
          '<img src="' + escapeHtml(pair.before.dataUrl) + '" alt="Before">' +
          '<img src="' + escapeHtml(pair.after.dataUrl) + '" alt="After difference overlay">' +
          '</div>';
      }
      return '<div class="pw-tv-visual-sxs">' + imageFrame('Before', pair.before) + imageFrame('After', pair.after) + '</div>';
    };

    const escapeHtml = value => String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');

    const load = async () => {
      if (loaded)
        return;
      loaded = true;
      content.innerHTML = '<div class="pw-tv-scenario-diff-empty">Loading scenario diff attachments...</div>';
      try {
        const response = await fetch('pw-tv-scenario-diff', {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache' }
        });
        if (!response.ok)
          throw new Error((await response.text()) || (response.status + ' ' + response.statusText));
        const payload = normalizePayload(await response.json());
        window.__pwTvScenarioDiffPayload = payload;
        const html = renderCases(payload);
        if (html) {
          content.innerHTML = html;
        } else if (payload.attachmentCount > 0) {
          content.innerHTML = '<div class="pw-tv-scenario-diff-empty">JSON attachments were found, but none matched before-*, after-*, or *-delta.</div>';
        } else {
          content.innerHTML = '<div class="pw-tv-scenario-diff-empty">No Scenario Diff attachments found. Add JSON attachments named before-*, after-*, or *-delta.</div>';
        }
      } catch (error) {
        content.innerHTML = '<div class="pw-tv-scenario-diff-error">Failed to load scenario diff: ' + escapeHtml(error.message || error) + '</div>';
      }
    };

    const reload = () => {
      loaded = false;
      selectedKey = undefined;
      load();
    };

    const normalizePayload = payload => ({
      visualPairs: Array.isArray(payload?.visualPairs) ? payload.visualPairs : [],
      pairs: Array.isArray(payload?.pairs) ? payload.pairs : [],
      deltas: Array.isArray(payload?.deltas) ? payload.deltas : [],
      attachmentCount: Number.isFinite(payload?.attachmentCount) ? payload.attachmentCount : 0
    });

    const visualPairForCard = card => {
      const cases = buildCases(normalizePayload(window.__pwTvScenarioDiffPayload));
      return cases.find(scenarioCase => scenarioCase.key === card.dataset.key)?.visual;
    };

    const setVisualMode = (card, mode) => {
      const pair = visualPairForCard(card);
      const body = card.querySelector('.pw-tv-visual-body');
      if (!pair || !body)
        return;
      card.dataset.mode = mode;
      for (const button of card.querySelectorAll('[data-visual-mode]'))
        button.dataset.active = String(button.dataset.visualMode === mode);
      body.innerHTML = renderVisualBody(pair, mode);
    };

    const toggle = () => {
      const open = !document.body.classList.contains('pw-tv-scenario-mode');
      document.body.classList.toggle('pw-tv-scenario-mode', open);
      if (open)
        load();
      updateToggleButtons();
    };

    const setOpen = open => {
      document.body.classList.toggle('pw-tv-scenario-mode', open);
      if (open)
        load();
      updateToggleButtons();
    };

    const updateToggleButtons = () => {
      const open = document.body.classList.contains('pw-tv-scenario-mode');
      for (const button of document.querySelectorAll('[data-scenario-toggle]')) {
        const target = button.dataset.scenarioToggle;
        const active = target === (open ? 'diff' : 'trace');
        button.dataset.active = String(active);
      }
    };

    const install = () => {
      if (panel)
        return;

      panel = document.createElement('aside');
      panel.className = 'pw-tv-scenario-diff-panel';
      panel.innerHTML = '<div class="pw-tv-scenario-diff-header">' +
        '<div class="pw-tv-scenario-diff-title">Scenario Diff</div>' +
        '<button class="pw-tv-scenario-refresh" title="Reload Scenario Diff">↻</button>' +
        '<button class="pw-tv-scenario-help-toggle" title="Scenario Diff usage">?</button>' +
        '<button class="pw-tv-scenario-diff-close" title="Close">x</button>' +
        '</div><div class="pw-tv-scenario-help">' +
        '<div><code>test.step("before: case name")</code> and <code>test.step("after: case name")</code> group scenario cases.</div>' +
        '<div>Attach JSON as <code>before-case-key</code> and <code>after-case-key</code>; attach summaries as <code>case-key-delta</code>.</div>' +
        '<div>Attach screenshots with the same before/after names and <code>image/png</code> content type to show Visual.</div>' +
        '</div><div class="pw-tv-scenario-diff-content"></div>';
      const helpToggle = panel.querySelector('.pw-tv-scenario-help-toggle');
      helpToggle?.addEventListener('click', () => {
        const help = panel.querySelector('.pw-tv-scenario-help');
        if (!help)
          return;
        help.dataset.open = String(help.dataset.open !== 'true');
      });
      panel.querySelector('.pw-tv-scenario-diff-close')?.addEventListener('click', () => {
        setOpen(false);
      });
      panel.querySelector('.pw-tv-scenario-refresh')?.addEventListener('click', () => {
        reload();
      });
      content = panel.querySelector('.pw-tv-scenario-diff-content');
      content.addEventListener('click', event => {
        const kindButton = event.target instanceof Element ? event.target.closest('[data-kind-filter]') : null;
        if (kindButton) {
          selectedKind = kindButton.dataset.kindFilter || 'all';
          selectedKey = undefined;
          content.innerHTML = renderCases(normalizePayload(window.__pwTvScenarioDiffPayload));
          return;
        }

        const caseButton = event.target instanceof Element ? event.target.closest('[data-case-key]') : null;
        if (caseButton) {
          selectedKey = caseButton.dataset.caseKey;
          content.innerHTML = renderCases(normalizePayload(window.__pwTvScenarioDiffPayload));
          return;
        }

        const button = event.target instanceof Element ? event.target.closest('[data-visual-mode]') : null;
        const card = button?.closest('.pw-tv-visual-card');
        if (!button || !card || button.disabled)
          return;
        setVisualMode(card, button.dataset.visualMode);
      });
      content.addEventListener('input', event => {
        const slider = event.target instanceof Element ? event.target.closest('.pw-tv-visual-slider') : null;
        const card = slider?.closest('.pw-tv-visual-card');
        const layer = card?.querySelector('.pw-tv-visual-after-layer');
        if (!slider || !layer)
          return;
        layer.style.width = slider.value + '%';
      });

      document.body.append(panel);
    };

    return { install, toggle, setOpen, updateToggleButtons };
  })();

  const getDirectChild = (parent, className) => {
    if (!parent)
      return null;
    return [...parent.children].find(child => child.classList.contains(className)) || null;
  };

  const tagWorkbenchPanels = () => {
    const actionList = document.querySelector('.action-list-container');
    const actionSidebar = actionList?.closest('.split-view-sidebar');
    const actionSplit = actionSidebar?.parentElement;
    const actionResizer = getDirectChild(actionSplit, 'split-view-resizer');
    const propertiesSidebar = [...document.querySelectorAll('.split-view-sidebar')]
      .find(sidebar => sidebar !== actionSidebar && !sidebar.contains(actionList) && sidebar.querySelector('.tabbed-pane'));
    const propertiesSplit = propertiesSidebar?.parentElement;
    const propertiesResizer = getDirectChild(propertiesSplit, 'split-view-resizer');

    actionSidebar?.classList.add('pw-tv-action-sidebar');
    actionSplit?.classList.add('pw-tv-action-split');
    actionResizer?.classList.add('pw-tv-action-resizer');
    propertiesSidebar?.classList.add('pw-tv-properties-sidebar');
    propertiesResizer?.classList.add('pw-tv-properties-resizer');
  };

  const ensureDetailsNavigatorTab = () => {
    const actionSidebar = document.querySelector('.pw-tv-action-sidebar');
    const propertiesSidebar = document.querySelector('.pw-tv-properties-sidebar');
    const actionToolbar = actionSidebar?.querySelector('.toolbar');
    const actionContent = actionSidebar?.querySelector('.tab-content');
    if (!actionSidebar || !propertiesSidebar || !actionToolbar || !actionContent)
      return;

    actionContent.classList.add('pw-tv-action-tab-content');
    propertiesSidebar.classList.add('pw-tv-details-in-nav');
    if (propertiesSidebar.parentElement !== actionContent)
      actionContent.appendChild(propertiesSidebar);

    let detailsTab = actionToolbar.querySelector('.pw-tv-details-nav-tab');
    if (!detailsTab) {
      detailsTab = document.createElement('div');
      detailsTab.className = 'tabbed-pane-tab pw-tv-details-nav-tab';
      detailsTab.tabIndex = 0;
      detailsTab.setAttribute('role', 'tab');
      detailsTab.innerHTML = '<span class="tabbed-pane-tab-label">Details</span>';
      detailsTab.addEventListener('click', () => {
        actionSidebar.classList.add('pw-tv-action-details-selected');
      });
      detailsTab.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ')
          return;
        event.preventDefault();
        actionSidebar.classList.add('pw-tv-action-details-selected');
      });
      const toolbarChildren = actionToolbar?.children ? Array.from(actionToolbar.children) : [];
      const realTabs = toolbarChildren
        .filter(child => child instanceof Element && child.classList.contains('tabbed-pane-tab') && !child.classList.contains('pw-tv-details-nav-tab'));
      const lastRealTab = realTabs[realTabs.length - 1];
      actionToolbar.insertBefore(detailsTab, lastRealTab?.nextSibling || null);
    }

    for (const tab of actionToolbar.querySelectorAll('.tabbed-pane-tab:not(.pw-tv-details-nav-tab)')) {
      if (tab.dataset.pwTvClearsDetails === 'true')
        continue;
      tab.dataset.pwTvClearsDetails = 'true';
      tab.addEventListener('click', () => {
        actionSidebar.classList.remove('pw-tv-action-details-selected');
      });
    }
  };

  const ensureSnapshotScenarioToggle = () => {
    const snapshotTab = document.querySelector('.snapshot-tab');
    if (!snapshotTab)
      return;

    const candidates = [...snapshotTab.querySelectorAll('button, [role="tab"], .tabbed-pane-tab')]
      .filter(element => {
        const label = element.textContent?.trim();
        return label === 'Action' || label === 'Before' || label === 'After';
      });

    if (candidates.length < 2)
      return;

    for (const candidate of candidates)
      candidate.classList.add('pw-tv-hidden-snapshot-tab');

    const first = candidates[0];
    const parent = first.parentElement;
    if (!parent)
      return;

    let toggle = parent.querySelector('.pw-tv-snapshot-scenario-toggle');
    if (!toggle) {
      toggle = document.createElement('div');
      toggle.className = 'pw-tv-snapshot-scenario-toggle';
      toggle.innerHTML = '<button type="button" data-scenario-toggle="trace">Trace</button>' +
        '<button type="button" data-scenario-toggle="diff">Scenario Diff</button>';
      toggle.addEventListener('click', event => {
        const button = event.target instanceof Element ? event.target.closest('[data-scenario-toggle]') : null;
        if (!button)
          return;
        scenarioDiff.setOpen(button.dataset.scenarioToggle === 'diff');
      });
      parent.insertBefore(toggle, first);
    }

    scenarioDiff.updateToggleButtons();
  };

  const ensureLayoutControls = () => {
    if (document.querySelector('.pw-tv-layout-controls'))
      return;
    document.body.classList.add('pw-tv-focus-mode');

    const controls = document.createElement('div');
    controls.className = 'pw-tv-layout-controls';

    const setButtonIcon = (button, icon) => {
      button.innerHTML = '<span class="codicon codicon-' + icon + '"></span>';
    };

    const makeButton = (panel, icon, title, onClick) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.panel = panel;
      button.title = title;
      button.setAttribute('aria-label', title);
      setButtonIcon(button, icon);
      button.addEventListener('click', onClick);
      controls.appendChild(button);
      return button;
    };

    makeButton('actions', 'layout-sidebar-left', 'Toggle actions panel', () => {
      scenarioDiff.setOpen(false);
      document.body.classList.toggle('pw-tv-hide-actions');
    });
    makeButton('placement', 'layout-sidebar-left', 'Dock actions to bottom', event => {
      scenarioDiff.setOpen(false);
      document.body.classList.toggle('pw-tv-actions-bottom');
      const isBottom = document.body.classList.contains('pw-tv-actions-bottom');
      setButtonIcon(event.currentTarget, isBottom ? 'layout-panel' : 'layout-sidebar-left');
      event.currentTarget.title = isBottom ? 'Dock actions to left' : 'Dock actions to bottom';
      event.currentTarget.setAttribute('aria-label', event.currentTarget.title);
    });
    makeButton('layout', 'screen-full', 'Exit full view', event => {
      scenarioDiff.setOpen(false);
      document.body.classList.toggle('pw-tv-focus-mode');
      document.body.classList.remove('pw-tv-hide-actions');
      const isFocusMode = document.body.classList.contains('pw-tv-focus-mode');
      setButtonIcon(event.currentTarget, isFocusMode ? 'screen-full' : 'screen-normal');
      event.currentTarget.title = isFocusMode ? 'Exit full view' : 'Enter full view';
      event.currentTarget.setAttribute('aria-label', event.currentTarget.title);
    });

    document.body.appendChild(controls);
    scenarioDiff.updateToggleButtons();
  };

  const applyViewerLayout = () => {
    try {
      placeTimelineBelowSnapshot();
      scenarioDiff.install();
      tagWorkbenchPanels();
      ensureDetailsNavigatorTab();
      ensureSnapshotScenarioToggle();
      ensureLayoutControls();
    } catch (error) {
      console.warn('Playwright Trace Viewer customization failed:', error);
    }
  };

  const observer = new MutationObserver(applyViewerLayout);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  applyViewerLayout();
})();
</script>`;

  return indexHtml.replace('</body>', `${viewerCustomizations}\n  </body>`);
}

function configureScenarioDiffRoute(server: TraceViewerServer, tracePath: string): void {
  const handler = (_request: unknown, response: TraceViewerResponse) => {
    extractScenarioDiff(tracePath)
      .then((payload) => {
        const body = JSON.stringify(payload);
        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Length', Buffer.byteLength(body));
        response.end(body);
      })
      .catch((error) => {
        const message = `Scenario Diff could not read this trace: ${formatError(error)}`;
        response.statusCode = 500;
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Content-Length', Buffer.byteLength(message));
        response.end(message);
      });
    return true;
  };

  const routes = [
    { exact: scenarioDiffRoutePath, handler },
    { exact: scenarioDiffTraceRoutePath, handler }
  ];

  if (server._routes) {
    server._routes.unshift(...routes);
  } else {
    for (const route of routes) {
      server.routePath(route.exact, route.handler);
    }
  }
}

async function extractScenarioDiff(tracePath: string): Promise<ScenarioDiffPayload> {
  const entries = await readZipEntries(tracePath);
  const candidates = collectTraceAttachments(entries);
  const jsonAttachments: ScenarioDiffAttachment[] = [];
  const visualAttachments: ScenarioVisualAttachment[] = [];

  for (const attachment of candidates) {
    if (isImageAttachment(attachment)) {
      const buffer = readAttachmentBuffer(entries, attachment);
      const contentType = typeof attachment.contentType === 'string' ? attachment.contentType : 'image/png';
      if (buffer) {
        visualAttachments.push({
          name: String(attachment.name),
          contentType,
          dataUrl: `data:${contentType};base64,${buffer.toString('base64')}`,
          source: 'attachment'
        });
      }
      continue;
    }

    const text = readAttachmentText(entries, attachment);
    if (!text) {
      continue;
    }

    try {
      jsonAttachments.push({
        name: String(attachment.name),
        data: JSON.parse(text)
      });
    } catch {
      // Only JSON attachments can be rendered as structured before/after state.
    }
  }

  const before = new Map<string, ScenarioDiffAttachment>();
  const after = new Map<string, ScenarioDiffAttachment>();
  const deltas: ScenarioDiffAttachment[] = [];
  const visualBefore = new Map<string, ScenarioVisualAttachment>();
  const visualAfter = new Map<string, ScenarioVisualAttachment>();

  for (const attachment of jsonAttachments) {
    if (attachment.name.startsWith('before-')) {
      before.set(attachment.name.slice('before-'.length), attachment);
    } else if (attachment.name.startsWith('after-')) {
      after.set(attachment.name.slice('after-'.length), attachment);
    } else if (attachment.name.endsWith('-delta')) {
      deltas.push(attachment);
    }
  }

  for (const attachment of visualAttachments) {
    if (attachment.name.startsWith('before-')) {
      visualBefore.set(attachment.name.slice('before-'.length), attachment);
    } else if (attachment.name.startsWith('after-')) {
      visualAfter.set(attachment.name.slice('after-'.length), attachment);
    }
  }

  const pairKeys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const pairs = pairKeys.map((key) => ({
    key,
    before: before.get(key),
    after: after.get(key)
  }));
  const visualPairKeys = [...new Set([...visualBefore.keys(), ...visualAfter.keys()])].sort();
  const visualPairs = visualPairKeys
    .map((key) => ({
      key,
      before: visualBefore.get(key),
      after: visualAfter.get(key)
    }))
    .filter((pair) => {
      if (pair.before && pair.after) {
        return true;
      }

      return pair.before?.source === 'attachment' || pair.after?.source === 'attachment';
    });

  return {
    pairs,
    visualPairs,
    deltas,
    attachmentCount: candidates.length
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || 'Unknown error';
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function collectTraceVisualAttachments(entries: Map<string, Buffer>): ScenarioVisualAttachment[] {
  type SceneStep = {
    callId: string;
    phase: 'before' | 'after';
    key: string;
    startTime: number;
    endTime?: number;
  };
  type TraceFrame = {
    timestamp: number;
    sha1: string;
  };

  const sceneSteps: SceneStep[] = [];
  const sceneStepsByCallId = new Map<string, SceneStep>();

  for (const line of readTraceLines(entries, 'test.trace')) {
    const event = parseTraceLine(line);
    if (!event || typeof event.callId !== 'string') {
      continue;
    }

    if (event.type === 'before' && event.method === 'test.step' && typeof event.title === 'string') {
      const scene = parseSceneStepTitle(event.title);
      const startTime = getNumber(event.startTime);
      if (!scene || startTime === undefined) {
        continue;
      }

      const step = {
        callId: event.callId,
        phase: scene.phase,
        key: scene.key,
        startTime
      };
      sceneSteps.push(step);
      sceneStepsByCallId.set(step.callId, step);
    } else if (event.type === 'after') {
      const step = sceneStepsByCallId.get(event.callId);
      const endTime = getNumber(event.endTime);
      if (step && endTime !== undefined) {
        step.endTime = endTime;
      }
    }
  }

  if (sceneSteps.length === 0) {
    return [];
  }

  const frames: TraceFrame[] = [];

  for (const [entryName] of entries) {
    if (entryName === 'test.trace' || !entryName.endsWith('.trace')) {
      continue;
    }

    for (const line of readTraceLines(entries, entryName)) {
      const event = parseTraceLine(line);
      if (!event) {
        continue;
      }

      const timestamp = getNumber(event.timestamp);
      if (event.type === 'screencast-frame' && typeof event.sha1 === 'string' && timestamp !== undefined) {
        frames.push({ timestamp, sha1: event.sha1 });
      }
    }
  }

  frames.sort((a, b) => a.timestamp - b.timestamp);
  sceneSteps.sort((a, b) => a.startTime - b.startTime);

  const visualByName = new Map<string, ScenarioVisualAttachment>();

  sceneSteps.forEach((step, index) => {
    const nextStepStart = sceneSteps[index + 1]?.startTime;
    const frame = findBestFrameForStep(step, nextStepStart, frames);
    const buffer = frame ? entries.get(`resources/${frame.sha1}`) : undefined;

    if (!buffer) {
      return;
    }

    const name = `${step.phase}-${step.key}`;
    visualByName.set(name, {
      name,
      contentType: 'image/jpeg',
      dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`,
      source: 'trace'
    });
  });

  return [...visualByName.values()];
}

function findBestFrameForStep(
  step: { startTime: number; endTime?: number },
  nextStepStart: number | undefined,
  frames: Array<{ timestamp: number; sha1: string }>
): { timestamp: number; sha1: string } | undefined {
  const endTime = step.endTime ?? nextStepStart ?? step.startTime + 1500;
  const hardEnd = nextStepStart === undefined ? endTime + 250 : Math.min(endTime + 250, nextStepStart - 1);
  const inWindow = frames.filter((frame) => frame.timestamp >= step.startTime && frame.timestamp <= hardEnd);

  if (inWindow.length > 0) {
    const target = step.endTime ? Math.max(step.startTime, step.endTime - 100) : step.startTime + 150;
    return inWindow
      .filter((frame, index, list) => index === 0 || frame.sha1 !== list[index - 1].sha1)
      .sort((a, b) => Math.abs(a.timestamp - target) - Math.abs(b.timestamp - target))[0];
  }

  return frames
    .filter((frame) => frame.timestamp >= step.startTime - 250 && frame.timestamp <= endTime + 500)
    .sort((a, b) => Math.abs(a.timestamp - step.startTime) - Math.abs(b.timestamp - step.startTime))[0];
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseSceneStepTitle(title: string): { phase: 'before' | 'after'; key: string } | undefined {
  const match = title.match(/^\s*(before|after)\s*[:：\-·]\s*(.+?)\s*$/iu);
  if (!match) {
    return undefined;
  }

  return {
    phase: match[1].toLowerCase() as 'before' | 'after',
    key: match[2]
  };
}

function readTraceLines(entries: Map<string, Buffer>, entryName: string): string[] {
  return entries.get(entryName)?.toString('utf8').split(/\r?\n/) ?? [];
}

function parseTraceLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function collectTraceAttachments(entries: Map<string, Buffer>): Array<Record<string, unknown>> {
  const attachments: Array<Record<string, unknown>> = [];

  for (const [name, data] of entries) {
    if (!/\.(trace|jsonl|json)$/i.test(name)) {
      continue;
    }

    const text = data.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        collectAttachmentsFromValue(JSON.parse(trimmed), attachments);
      } catch {
        // Trace files are JSONL. Ignore non-JSON records defensively.
      }
    }
  }

  return attachments.filter((attachment) => {
    const name = typeof attachment.name === 'string' ? attachment.name : '';
    const contentType = typeof attachment.contentType === 'string' ? attachment.contentType : '';
    return (
      (name.startsWith('before-') || name.startsWith('after-') || name.endsWith('-delta'))
      && (contentType.includes('json') || contentType.startsWith('image/') || name.endsWith('.json') || !contentType)
    );
  });
}

function collectAttachmentsFromValue(value: unknown, output: Array<Record<string, unknown>>): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectAttachmentsFromValue(item, output);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.attachments)) {
    for (const attachment of record.attachments) {
      if (attachment && typeof attachment === 'object' && typeof (attachment as Record<string, unknown>).name === 'string') {
        output.push(attachment as Record<string, unknown>);
      }
    }
  }

  for (const child of Object.values(record)) {
    collectAttachmentsFromValue(child, output);
  }
}

function readAttachmentText(entries: Map<string, Buffer>, attachment: Record<string, unknown>): string | undefined {
  const buffer = readAttachmentBuffer(entries, attachment);
  return buffer?.toString('utf8');
}

function readAttachmentBuffer(entries: Map<string, Buffer>, attachment: Record<string, unknown>): Buffer | undefined {
  const body = attachment.body;
  if (typeof body === 'string') {
    return Buffer.from(body, 'base64');
  }

  const sha1 = typeof attachment.sha1 === 'string' ? attachment.sha1 : undefined;
  if (sha1) {
    const resource = entries.get(`resources/${sha1}`) ?? entries.get(sha1);
    if (resource) {
      return resource;
    }
  }

  const pathValue = typeof attachment.path === 'string' ? attachment.path : undefined;
  if (pathValue) {
    const normalized = pathValue.replace(/\\/g, '/');
    const zipEntry = entries.get(normalized) ?? entries.get(`resources/${path.basename(normalized)}`);
    if (zipEntry) {
      return zipEntry;
    }
  }

  return undefined;
}

function isImageAttachment(attachment: Record<string, unknown>): boolean {
  const contentType = typeof attachment.contentType === 'string' ? attachment.contentType : '';
  return contentType.startsWith('image/');
}

function readZipEntries(zipPath: string): Promise<Map<string, Buffer>> {
  type YauzlEntry = { fileName: string };
  type YauzlZipFile = {
    readEntry(): void;
    openReadStream(entry: YauzlEntry, callback: (error: Error | null, stream: NodeJS.ReadableStream) => void): void;
    close(): void;
    on(event: 'entry', listener: (entry: YauzlEntry) => void): void;
    on(event: 'end', listener: () => void): void;
    on(event: 'error', listener: (error: Error) => void): void;
  };

  const yauzl = require('yauzl') as {
    open(path: string, options: { lazyEntries: boolean }, callback: (error: Error | null, zipfile: YauzlZipFile) => void): void;
  };

  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipfile) => {
      if (openError || !zipfile) {
        reject(openError ?? new Error('Failed to open trace zip.'));
        return;
      }

      const entries = new Map<string, Buffer>();

      zipfile.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) {
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            zipfile.close();
            reject(streamError);
            return;
          }

          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
          stream.on('error', (error: Error) => {
            zipfile.close();
            reject(error);
          });
        });
      });

      zipfile.on('end', () => resolve(entries));
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

function buildTraceViewerRedirectPath(tracePath: string): string {
  const traceUrl = `file?path=${encodeURIComponent(tracePath)}`;
  const params = new URLSearchParams();

  if (path.sep !== path.posix.sep) {
    params.set('pathSeparator', path.sep);
  }

  params.append('trace', traceUrl);
  return `./trace/index.html?${params.toString()}`;
}

function renderTraceViewer(webview: vscode.Webview, viewerUrl: string): string {
  const origin = new URL(viewerUrl).origin;
  const nonce = createNonce();
  const csp = [
    "default-src 'none'",
    `frame-src ${origin}`,
    `img-src ${webview.cspSource} ${origin} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
  <style>
    html,
    body {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: #fff;
    }

    body {
      position: fixed;
      inset: 0;
    }

    iframe {
      display: block;
      position: absolute;
      inset: 0;
      width: 100vw;
      height: 100vh;
      margin: 0;
      padding: 0;
      border: 0;
      background: #fff;
    }
  </style>
</head>
<body>
  <iframe
    id="trace-viewer"
    src="${escapeHtml(viewerUrl)}"
    title="Playwright Trace Viewer"
    allow="autoplay; fullscreen"
    tabindex="0"
  ></iframe>
  <script nonce="${nonce}">
    const frame = document.getElementById('trace-viewer');

    function focusViewer() {
      frame.focus();
    }

    frame.addEventListener('load', () => {
      requestAnimationFrame(focusViewer);
    });

    window.addEventListener('focus', focusViewer);
    document.addEventListener('pointerdown', focusViewer, true);
    document.addEventListener('keydown', event => {
      if (event.code === 'Space' && document.activeElement !== frame) {
        event.preventDefault();
        focusViewer();
        frame.contentWindow?.postMessage({ type: 'playwrightTraceViewer.togglePlayback' }, '${escapeJavaScript(origin)}');
      }
    }, true);
  </script>
</body>
</html>`;
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';

  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return nonce;
}

function renderMessage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      box-sizing: border-box;
      margin: 0;
      padding: 16px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
  </style>
</head>
<body>${escapeHtml(message)}</body>
</html>`;
}

function getWorkspaceRootForUri(uri: vscode.Uri): string | undefined {
  return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? getWorkspaceRoot();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}

function escapeJavaScript(value: string): string {
  return value.replace(/[\\']/g, (char) => `\\${char}`);
}
