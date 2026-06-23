import { TokenTotals, TailLine } from "./types";
import { addTotals, emptyTotals } from "./pricing";

// Accumulated, incrementally-updated state for a single transcript file.
export interface FileAggregate {
  offset: number; // bytes consumed so far
  partial: string; // trailing incomplete line buffer
  model: string;
  aiTitle: string;
  firstUserText: string;
  cwd: string;
  gitBranch: string;
  tokens: TokenTotals;
  messageCount: number;
  firstTs: number;
  lastTs: number;
  activity: string;
  activityKind: "thinking" | "text" | "tool" | "tool_result" | "idle" | "done";
  working: boolean;
  lastWasToolUse: boolean;
  capped: boolean; // initial read was truncated to the tail of a large file -> totals are partial
  recentTail: TailLine[]; // rolling window of recent human-readable events
  events: UsageEvent[]; // per-assistant-message usage, for period filtering
}

export interface UsageEvent {
  ts: number;
  model: string;
  t: TokenTotals;
}

const TAIL_MAX = 60;

export function createAggregate(): FileAggregate {
  return {
    offset: 0,
    partial: "",
    model: "",
    aiTitle: "",
    firstUserText: "",
    cwd: "",
    gitBranch: "",
    tokens: emptyTotals(),
    messageCount: 0,
    firstTs: 0,
    lastTs: 0,
    activity: "",
    activityKind: "idle",
    working: false,
    lastWasToolUse: false,
    capped: false,
    recentTail: [],
    events: [],
  };
}

function tsOf(o: any): number {
  const t = o?.timestamp;
  if (!t) return 0;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? 0 : ms;
}

function truncate(s: string, n = 160): string {
  s = (s || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function extractUsage(usage: any): TokenTotals {
  const t = emptyTotals();
  if (!usage) return t;
  t.input = usage.input_tokens || 0;
  t.output = usage.output_tokens || 0;
  t.cacheRead = usage.cache_read_input_tokens || 0;
  const cc = usage.cache_creation;
  if (cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null)) {
    t.cacheWrite5m = cc.ephemeral_5m_input_tokens || 0;
    t.cacheWrite1h = cc.ephemeral_1h_input_tokens || 0;
  } else {
    // No split available: treat all cache-creation as 5m writes.
    t.cacheWrite5m = usage.cache_creation_input_tokens || 0;
  }
  return t;
}

function toolLabel(name: string, input: any): string {
  if (!input || typeof input !== "object") return name;
  if (name === "Bash") return `Bash · ${truncate(input.description || input.command || "", 80)}`;
  if (name === "Edit" || name === "Write" || name === "Read") {
    const p = String(input.file_path || "").split(/[\\/]/).pop() || "";
    return `${name} · ${p}`;
  }
  if (name === "Task" || name === "Agent") {
    return `↳ Lance un agent · ${truncate(input.description || input.subagent_type || "", 70)}`;
  }
  if (name === "Grep") return `Grep · ${truncate(input.pattern || "", 60)}`;
  if (name === "Glob") return `Glob · ${truncate(input.pattern || "", 60)}`;
  if (name === "Workflow") return `Workflow · ${truncate(input.title || input.description || "", 70)}`;
  return `${name}`;
}

function pushTail(agg: FileAggregate, line: TailLine): void {
  agg.recentTail.push(line);
  if (agg.recentTail.length > TAIL_MAX) agg.recentTail.shift();
}

// Process one parsed JSONL object, mutating the aggregate.
export function processLine(agg: FileAggregate, o: any): void {
  const type = o?.type;
  if (type === "ai-title" && o.aiTitle) {
    agg.aiTitle = o.aiTitle;
    return;
  }
  if (type === "summary" && o.summary && !agg.aiTitle) {
    agg.aiTitle = o.summary;
    return;
  }

  const ts = tsOf(o);
  if (ts) {
    if (!agg.firstTs) agg.firstTs = ts;
    agg.lastTs = Math.max(agg.lastTs, ts);
  }

  if (type === "user") {
    const msg = o.message || {};
    if (o.cwd) agg.cwd = o.cwd;
    if (o.gitBranch) agg.gitBranch = o.gitBranch;
    const content = msg.content;
    let isToolResult = false;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "tool_result") isToolResult = true;
        if (b?.type === "text" && !text) text = b.text || "";
      }
    }
    if (!agg.firstUserText && text && !isToolResult) agg.firstUserText = truncate(text, 200);
    if (isToolResult) {
      agg.activity = "Résultat reçu";
      agg.activityKind = "tool_result";
      agg.lastWasToolUse = false;
      pushTail(agg, { role: "user", ts, kind: "tool_result", text: "↩ résultat d'outil" });
    } else if (text) {
      pushTail(agg, { role: "user", ts, kind: "text", text: truncate(text, 400) });
    }
    return;
  }

  if (type === "assistant") {
    const msg = o.message || {};
    if (msg.model) agg.model = msg.model;
    if (o.cwd) agg.cwd = o.cwd;
    if (o.gitBranch) agg.gitBranch = o.gitBranch;
    if (msg.usage) {
      const u = extractUsage(msg.usage);
      addTotals(agg.tokens, u);
      agg.messageCount++;
      agg.events.push({ ts: ts || agg.lastTs || Date.now(), model: msg.model || agg.model, t: u });
    }
    const content = Array.isArray(msg.content) ? msg.content : [];
    let lastText = "";
    let lastThinking = "";
    let toolUse: { name: string; input: any } | null = null;
    for (const b of content) {
      if (b?.type === "text" && b.text) lastText = b.text;
      else if (b?.type === "thinking" && b.thinking) lastThinking = b.thinking;
      else if (b?.type === "tool_use") toolUse = { name: b.name, input: b.input };
    }
    if (toolUse) {
      agg.activity = toolLabel(toolUse.name, toolUse.input);
      agg.activityKind = "tool";
      agg.working = true;
      agg.lastWasToolUse = true;
      pushTail(agg, { role: "assistant", ts, kind: "tool", text: agg.activity });
    } else if (lastText) {
      agg.activity = truncate(lastText, 160);
      agg.activityKind = "text";
      agg.working = false;
      agg.lastWasToolUse = false;
      pushTail(agg, { role: "assistant", ts, kind: "text", text: truncate(lastText, 600) });
    } else if (lastThinking) {
      agg.activity = truncate(lastThinking, 160);
      agg.activityKind = "thinking";
      agg.working = true;
      pushTail(agg, { role: "assistant", ts, kind: "thinking", text: truncate(lastThinking, 600) });
    }
    return;
  }
}

export function bestTitle(agg: FileAggregate, fallback: string): string {
  return agg.aiTitle || agg.firstUserText || fallback;
}
