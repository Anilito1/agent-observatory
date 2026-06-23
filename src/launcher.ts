import * as vscode from "vscode";

// Manages Claude Code sessions launched / resumed from Agent Observatory.
// "Taking control" of a session = opening `claude --resume <id>` in a terminal,
// where the user can interrupt (Esc / Ctrl-C) or steer it interactively.
export class Launcher {
  private managed = new Set<string>();
  private terminals = new Map<string, vscode.Terminal>();
  private genericTerminals = new Set<vscode.Terminal>();

  constructor(private claudeCommand: () => string) {
    vscode.window.onDidCloseTerminal((t) => {
      this.genericTerminals.delete(t);
      for (const [id, term] of this.terminals.entries()) {
        if (term === t) {
          this.terminals.delete(id);
          this.managed.delete(id);
        }
      }
    });
  }

  managedSessionIds(): Set<string> {
    return this.managed;
  }

  newSession(prompt?: string, cwd?: string): void {
    const term = vscode.window.createTerminal({
      name: "Agent Observatory · session",
      cwd: cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    });
    this.genericTerminals.add(term);
    term.show();
    const cmd = prompt && prompt.trim()
      ? `${this.claudeCommand()} ${quote(prompt.trim())}`
      : this.claudeCommand();
    term.sendText(cmd, true);
  }

  resume(sessionId: string, cwd: string): void {
    const existing = this.terminals.get(sessionId);
    if (existing) {
      existing.show();
      return;
    }
    const term = vscode.window.createTerminal({
      name: `Agent Observatory · ${sessionId.slice(0, 8)}`,
      cwd: cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    });
    this.terminals.set(sessionId, term);
    this.managed.add(sessionId);
    term.show();
    term.sendText(`${this.claudeCommand()} --resume ${sessionId}`, true);
  }

  resumeCommand(sessionId: string): string {
    return `${this.claudeCommand()} --resume ${sessionId}`;
  }
}

function quote(s: string): string {
  return '"' + s.replace(/"/g, '\\"') + '"';
}
