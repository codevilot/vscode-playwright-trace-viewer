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
  const shortcutScript = `<script>
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
})();
</script>`;

  return indexHtml.replace('</body>', `${shortcutScript}\n  </body>`);
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
