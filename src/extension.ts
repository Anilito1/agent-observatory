import * as vscode from "vscode";
import * as path from "path";
import { FleetState, InboundMessage, OutboundMessage } from "./types";
import { Pricing } from "./pricing";
import { FleetWatcher, defaultProjectsDir } from "./watcher";
import { Launcher } from "./launcher";
import { FleetViewProvider, openPanel, WebviewHandlers } from "./panel";

let watcher: FleetWatcher | undefined;
let launcher: Launcher;
const posters = new Set<(msg: OutboundMessage) => void>();
let latest: FleetState | undefined;
let extContext: vscode.ExtensionContext;
let period = "session";
let language = "fr";

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;
  period = context.globalState.get<string>("period", "session");
  language = context.globalState.get<string>("language", "fr");
  launcher = new Launcher(() =>
    vscode.workspace.getConfiguration("claudeFleet").get<string>("claudeCommand", "claude")
  );

  const handlers: WebviewHandlers = {
    onMessage: handleInbound,
    onAttach: (post) => {
      posters.add(post);
      if (latest) post({ type: "state", state: latest });
      post({ type: "config", workspaceCwd: workspaceCwd(), period, language });
    },
    onDetach: (post) => posters.delete(post),
  };

  const provider = new FleetViewProvider(context.extensionUri, handlers);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("claudeFleet.view", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeFleet.openPanel", () => {
      openPanel(context.extensionUri, handlers);
    }),
    vscode.commands.registerCommand("claudeFleet.newSession", async () => {
      const prompt = await vscode.window.showInputBox({
        title: "Nouvelle session Claude Code",
        prompt: "Message de départ (optionnel) — laisser vide pour ouvrir Claude interactif",
        placeHolder: "ex: refactore le module auth…",
      });
      if (prompt === undefined) return;
      launcher.newSession(prompt, workspaceCwd() || undefined);
    }),
    vscode.commands.registerCommand("claudeFleet.refresh", () => watcher?.forceRefresh())
  );

  startWatcher(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeFleet")) {
        watcher?.dispose();
        startWatcher(context);
      }
    })
  );

  context.subscriptions.push({ dispose: () => watcher?.dispose() });
}

export function deactivate(): void {
  watcher?.dispose();
}

function workspaceCwd(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function startWatcher(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration("claudeFleet");
  const projectsDir = cfg.get<string>("projectsDir") || defaultProjectsDir();
  const pricing = new Pricing(cfg.get<Record<string, any>>("pricing") || {});

  watcher = new FleetWatcher({
    projectsDir,
    activeWindowMinutes: cfg.get<number>("activeWindowMinutes", 180),
    liveWindowSeconds: cfg.get<number>("liveWindowSeconds", 120),
    pollIntervalMs: cfg.get<number>("pollIntervalMs", 1500),
    maxInitialBytes: 12 * 1024 * 1024,
    pricing,
    period,
    managedSessionIds: () => launcher.managedSessionIds(),
    workspaceCwd: workspaceCwd(),
    onState: (state) => {
      latest = state;
      const msg: OutboundMessage = { type: "state", state };
      for (const post of posters) post(msg);
    },
  });
  watcher.start();
}

function handleInbound(msg: InboundMessage): void {
  switch (msg.type) {
    case "ready":
      if (latest) for (const post of posters) post({ type: "state", state: latest });
      break;
    case "newSession":
      launcher.newSession(msg.prompt, msg.cwd || workspaceCwd() || undefined);
      break;
    case "resume":
      launcher.resume(msg.sessionId, msg.cwd || workspaceCwd() || "");
      break;
    case "openTranscript":
      if (msg.filePath) {
        vscode.workspace.openTextDocument(vscode.Uri.file(msg.filePath)).then(
          (doc) => vscode.window.showTextDocument(doc, { preview: true }),
          () => vscode.window.showWarningMessage("Transcript introuvable.")
        );
      }
      break;
    case "revealFolder":
      if (msg.filePath) {
        vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(msg.filePath));
      }
      break;
    case "copyResume": {
      const cmd = launcher.resumeCommand(msg.sessionId);
      vscode.env.clipboard.writeText(cmd);
      vscode.window.setStatusBarMessage(`$(clippy) Copié : ${cmd}`, 3000);
      break;
    }
    case "requestTail": {
      const lines = watcher?.getTail(msg.nodeId) ?? [];
      for (const post of posters) post({ type: "tail", nodeId: msg.nodeId, lines });
      break;
    }
    case "setFilter":
      // filtering is handled client-side in the webview
      break;
    case "setPeriod":
      period = msg.period;
      watcher?.setPeriod(period);
      extContext.globalState.update("period", period);
      break;
    case "setLanguage":
      language = msg.language;
      extContext.globalState.update("language", language);
      for (const post of posters) post({ type: "config", workspaceCwd: workspaceCwd(), period, language });
      break;
  }
}
