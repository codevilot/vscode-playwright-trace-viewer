import * as path from 'path';
import * as vscode from 'vscode';
import { getWorkspaceRoot, validateTraceUri } from './trace';

const viewType = 'playwrightTraceViewer.traceZipEditor';

type TraceViewerServer = {
  stop(): Promise<void>;
  urlPrefix(purpose: 'human-readable' | 'precise'): string;
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
      const viewerUrl = await buildTraceViewerUrl(server, tracePath);
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

async function buildTraceViewerUrl(server: TraceViewerServer, tracePath: string): Promise<string> {
  const traceUrl = `file?path=${encodeURIComponent(tracePath)}`;
  const params = new URLSearchParams();

  if (path.sep !== path.posix.sep) {
    params.set('pathSeparator', path.sep);
  }

  params.append('trace', traceUrl);
  const localViewerUri = vscode.Uri.parse(`${server.urlPrefix('human-readable')}/trace/index.html?${params.toString()}`);
  return (await vscode.env.asExternalUri(localViewerUri)).toString();
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
