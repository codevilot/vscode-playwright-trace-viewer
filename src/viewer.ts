import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { getWorkspaceRoot, validateTraceUri } from './trace';

const viewType = 'playwrightTraceViewer.traceZipEditor';

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
      const realTabs = [...actionToolbar.children]
        .filter(child => child.classList.contains('tabbed-pane-tab') && !child.classList.contains('pw-tv-details-nav-tab'));
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
      document.body.classList.toggle('pw-tv-hide-actions');
    });
    makeButton('placement', 'layout-sidebar-left', 'Dock actions to bottom', event => {
      document.body.classList.toggle('pw-tv-actions-bottom');
      const isBottom = document.body.classList.contains('pw-tv-actions-bottom');
      setButtonIcon(event.currentTarget, isBottom ? 'layout-panel' : 'layout-sidebar-left');
      event.currentTarget.title = isBottom ? 'Dock actions to left' : 'Dock actions to bottom';
      event.currentTarget.setAttribute('aria-label', event.currentTarget.title);
    });
    makeButton('layout', 'screen-full', 'Exit full view', event => {
      document.body.classList.toggle('pw-tv-focus-mode');
      document.body.classList.remove('pw-tv-hide-actions');
      const isFocusMode = document.body.classList.contains('pw-tv-focus-mode');
      setButtonIcon(event.currentTarget, isFocusMode ? 'screen-full' : 'screen-normal');
      event.currentTarget.title = isFocusMode ? 'Exit full view' : 'Enter full view';
      event.currentTarget.setAttribute('aria-label', event.currentTarget.title);
    });

    document.body.appendChild(controls);
  };

  const applyViewerLayout = () => {
    placeTimelineBelowSnapshot();
    tagWorkbenchPanels();
    ensureDetailsNavigatorTab();
    ensureLayoutControls();
  };

  const observer = new MutationObserver(applyViewerLayout);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  applyViewerLayout();
})();
</script>`;

  return indexHtml.replace('</body>', `${viewerCustomizations}\n  </body>`);
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
