// Shared data model between the watcher (extension host) and the webview.

export type NodeKind = "session" | "agent";
export type NodeStatus = "live" | "idle" | "done";

export interface TokenTotals {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
}

export interface FleetNode {
  id: string; // sessionId or agentId
  kind: NodeKind;
  parentId: string | null; // agent -> parent sessionId
  title: string;
  subtitle: string; // agentType, or cwd folder for sessions
  model: string;
  modelFamily: string;
  status: NodeStatus;
  working: boolean; // currently producing output / awaiting a tool result
  activity: string; // short human label of what it is doing right now
  activityKind: "thinking" | "text" | "tool" | "tool_result" | "idle" | "done";
  tokens: TokenTotals;
  cost: CostBreakdown;
  messageCount: number;
  lastTs: number; // epoch ms of last activity
  startedTs: number; // epoch ms of first activity
  cwd: string;
  gitBranch: string;
  sessionId: string; // the owning top-level session id (for resume)
  filePath: string; // transcript path
  managed: boolean; // launched / resumed by Fleet -> controllable terminal
  approx: boolean; // cost/tokens are partial (very large transcript read from tail only)
}

export interface FleetSummary {
  totalCost: number;
  totalTokens: number;
  liveCount: number;
  sessionCount: number;
  agentCount: number;
}

export interface FleetState {
  generatedAt: number;
  nodes: FleetNode[];
  summary: FleetSummary;
  workspaceCwd: string | null;
}

// Messages: webview -> extension
export type InboundMessage =
  | { type: "ready" }
  | { type: "newSession"; prompt?: string; cwd?: string }
  | { type: "resume"; sessionId: string; cwd: string }
  | { type: "openTranscript"; filePath: string }
  | { type: "revealFolder"; filePath: string }
  | { type: "copyResume"; sessionId: string }
  | { type: "setFilter"; scope: "workspace" | "all" }
  | { type: "setPeriod"; period: string }
  | { type: "setLanguage"; language: string }
  | { type: "requestTail"; nodeId: string };

// Messages: extension -> webview
export type OutboundMessage =
  | { type: "state"; state: FleetState }
  | { type: "tail"; nodeId: string; lines: TailLine[] }
  | { type: "config"; workspaceCwd: string | null; period: string; language: string };

export interface TailLine {
  role: "user" | "assistant" | "system";
  ts: number;
  kind: "thinking" | "text" | "tool" | "tool_result";
  text: string;
}
