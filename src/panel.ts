import * as vscode from "vscode";
import { InboundMessage, OutboundMessage } from "./types";

export interface WebviewHandlers {
  onMessage: (msg: InboundMessage) => void;
  onAttach: (post: (msg: OutboundMessage) => void) => void;
  onDetach: (post: (msg: OutboundMessage) => void) => void;
}

function nonceStr(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

export function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = nonceStr();
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "style.css")
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "main.js")
  );
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return /* html */ `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Claude Fleet</title>
</head>
<body>
  <div id="app">
    <header id="topbar">
      <div class="brand">
        <span class="logo"></span>
        <span class="brand-name">Claude Fleet</span>
      </div>
      <div class="stats">
        <div class="stat"><span class="stat-val" id="stat-live">0</span><span class="stat-label" id="lbl-live">live</span></div>
        <div class="stat"><span class="stat-val" id="stat-tokens">0</span><span class="stat-label" id="lbl-tokens">tokens</span></div>
        <div class="stat cost"><span class="stat-val" id="stat-cost">$0.00</span><span class="stat-label" id="lbl-cost">cost</span></div>
      </div>
      <div class="actions">
        <select id="period" class="period-select" title="Période de calcul tokens & coût"></select>
        <button id="mode-toggle" class="toggle on"></button>
        <button id="filter-toggle" class="ghost"></button>
        <button id="btn-new" class="primary"></button>
        <button id="lang-toggle" class="toggle" title="Langue / Language">FR</button>
      </div>
    </header>
    <div id="stage">
      <svg id="links" xmlns="http://www.w3.org/2000/svg"></svg>
      <div id="bubbles"></div>
      <div id="empty" class="empty hidden">
        <div class="empty-glow"></div>
        <p>Aucune session récente.</p>
        <span>Lance une session Claude Code — elle apparaîtra ici en direct.</span>
      </div>
    </div>
  </div>

  <aside id="drawer" class="drawer hidden">
    <button id="drawer-close" class="drawer-close" aria-label="Fermer">×</button>
    <div id="drawer-content"></div>
  </aside>
  <div id="scrim" class="scrim hidden"></div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export class FleetViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private extensionUri: vscode.Uri,
    private handlers: WebviewHandlers
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = buildHtml(view.webview, this.extensionUri);
    const post = (msg: OutboundMessage) => view.webview.postMessage(msg);
    const sub = view.webview.onDidReceiveMessage((m) => this.handlers.onMessage(m));
    this.handlers.onAttach(post);
    view.onDidDispose(() => {
      sub.dispose();
      this.handlers.onDetach(post);
    });
  }
}

export function openPanel(
  extensionUri: vscode.Uri,
  handlers: WebviewHandlers
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "claudeFleet.panel",
    "Claude Fleet",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    }
  );
  panel.webview.html = buildHtml(panel.webview, extensionUri);
  const post = (msg: OutboundMessage) => panel.webview.postMessage(msg);
  const sub = panel.webview.onDidReceiveMessage((m) => handlers.onMessage(m));
  handlers.onAttach(post);
  panel.onDidDispose(() => {
    sub.dispose();
    handlers.onDetach(post);
  });
  return panel;
}
