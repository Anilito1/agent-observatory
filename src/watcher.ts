import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { FleetNode, FleetState, FleetSummary, NodeStatus, TailLine } from "./types";
import { FileAggregate, createAggregate, processLine, bestTitle } from "./parser";
import { Pricing, modelFamily, sumTokens } from "./pricing";

interface AgentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
}

interface Tracker {
  filePath: string;
  agg: FileAggregate;
  kind: "session" | "agent";
  parentSessionId: string | null;
  sessionId: string; // owning top-level session id (for resume)
  agentId?: string;
  meta?: AgentMeta;
  mtimeMs: number;
  size: number;
}

export interface WatcherOptions {
  projectsDir: string;
  activeWindowMinutes: number;
  liveWindowSeconds: number;
  pollIntervalMs: number;
  maxInitialBytes: number;
  pricing: Pricing;
  managedSessionIds: () => Set<string>;
  workspaceCwd: string | null;
  onState: (state: FleetState) => void;
}

export class FleetWatcher {
  private trackers = new Map<string, Tracker>(); // key = filePath
  private timer: NodeJS.Timeout | undefined;
  private opts: WatcherOptions;
  private disposed = false;

  constructor(opts: WatcherOptions) {
    this.opts = opts;
  }

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opts.pollIntervalMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
  }

  forceRefresh(): void {
    this.tick();
  }

  setPricing(p: Pricing): void {
    this.opts.pricing = p;
  }

  setWorkspaceCwd(cwd: string | null): void {
    this.opts.workspaceCwd = cwd;
  }

  getTail(nodeId: string): TailLine[] {
    for (const t of this.trackers.values()) {
      if (this.nodeId(t) === nodeId) return t.agg.recentTail.slice(-40);
    }
    return [];
  }

  private nodeId(t: Tracker): string {
    return t.kind === "session" ? t.sessionId : t.agentId || `agent-${t.sessionId}`;
  }

  private tick(): void {
    if (this.disposed) return;
    try {
      this.scan();
      this.emit();
    } catch (e) {
      console.error("[claude-fleet] tick error", e);
    }
  }

  private scan(): void {
    const root = this.opts.projectsDir;
    if (!fs.existsSync(root)) return;
    const activeCutoff = Date.now() - this.opts.activeWindowMinutes * 60_000;

    let projectDirs: string[] = [];
    try {
      projectDirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(root, d.name));
    } catch {
      return;
    }

    for (const proj of projectDirs) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(proj, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
        const filePath = path.join(proj, e.name);
        const sessionId = e.name.replace(/\.jsonl$/, "");

        // Is this session recent enough to display? (gates whether we pull its agents)
        let sessionRecent = false;
        try {
          sessionRecent = fs.statSync(filePath).mtimeMs >= activeCutoff;
        } catch {
          continue;
        }
        this.consider(filePath, "session", sessionId, null, undefined, undefined, activeCutoff);

        // A visible session shows its FULL agent tree, regardless of each agent's age.
        if (!sessionRecent) continue;
        const subDir = path.join(proj, sessionId, "subagents");
        if (fs.existsSync(subDir)) {
          let subs: string[] = [];
          try {
            subs = fs.readdirSync(subDir).filter((n) => n.endsWith(".jsonl"));
          } catch {
            subs = [];
          }
          for (const sn of subs) {
            const agentPath = path.join(subDir, sn);
            const agentId = sn.replace(/\.jsonl$/, "").replace(/^agent-/, "");
            const meta = readMeta(path.join(subDir, sn.replace(/\.jsonl$/, ".meta.json")));
            this.consider(agentPath, "agent", sessionId, sessionId, agentId, meta, Number.NEGATIVE_INFINITY);
          }
        }
      }
    }

    for (const key of [...this.trackers.keys()]) {
      if (!fs.existsSync(key)) this.trackers.delete(key);
    }
  }

  private consider(
    filePath: string,
    kind: "session" | "agent",
    sessionId: string,
    parentSessionId: string | null,
    agentId: string | undefined,
    meta: AgentMeta | undefined,
    activeCutoff: number
  ): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch {
      return;
    }
    let tracker = this.trackers.get(filePath);
    if (!tracker && st.mtimeMs < activeCutoff) return; // never recently active -> ignore

    if (!tracker) {
      tracker = {
        filePath,
        agg: createAggregate(),
        kind,
        parentSessionId,
        sessionId,
        agentId,
        meta,
        mtimeMs: 0,
        size: 0,
      };
      this.trackers.set(filePath, tracker);
    }
    if (meta) tracker.meta = meta;
    if (agentId) tracker.agentId = agentId;

    if (tracker.size === st.size && tracker.mtimeMs === st.mtimeMs) return; // unchanged

    this.readDelta(tracker, st);
    tracker.mtimeMs = st.mtimeMs;
    tracker.size = st.size;
  }

  private readDelta(tracker: Tracker, st: fs.Stats): void {
    if (st.size < tracker.agg.offset) {
      // file rotated/truncated
      const wasCapped = tracker.agg.capped;
      tracker.agg = createAggregate();
      tracker.agg.capped = wasCapped;
    }
    let startOffset = tracker.agg.offset;
    let dropFirstPartial = false;
    if (startOffset === 0 && st.size > this.opts.maxInitialBytes) {
      startOffset = st.size - this.opts.maxInitialBytes;
      tracker.agg.capped = true;
      dropFirstPartial = true;
    }
    if (startOffset >= st.size) {
      tracker.agg.offset = st.size;
      return;
    }

    let fd: number | undefined;
    let buf: Buffer;
    try {
      fd = fs.openSync(tracker.filePath, "r");
      const len = st.size - startOffset;
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, startOffset);
    } catch {
      if (fd !== undefined) fs.closeSync(fd);
      return;
    }
    if (fd !== undefined) fs.closeSync(fd);

    const text = tracker.agg.partial + buf.toString("utf8");
    const lines = text.split("\n");
    tracker.agg.partial = lines.pop() ?? "";
    tracker.agg.offset = st.size;

    let first = true;
    for (const line of lines) {
      const skip = first && dropFirstPartial;
      first = false;
      if (skip) continue;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let o: any;
      try {
        o = JSON.parse(trimmed);
      } catch {
        continue;
      }
      try {
        processLine(tracker.agg, o);
      } catch {
        /* ignore */
      }
    }
  }

  private statusOf(mtimeMs: number, lastTs: number): NodeStatus {
    const ref = Math.max(mtimeMs, lastTs);
    const age = Date.now() - ref;
    if (age < this.opts.liveWindowSeconds * 1000) return "live";
    if (age < this.opts.activeWindowMinutes * 60_000) return "idle";
    return "done";
  }

  private emit(): void {
    const managed = this.opts.managedSessionIds();
    const nodes: FleetNode[] = [];

    for (const t of this.trackers.values()) {
      const agg = t.agg;
      if (agg.messageCount === 0 && !agg.lastTs && !t.meta) continue;

      const status = this.statusOf(t.mtimeMs, agg.lastTs);
      const cost = this.opts.pricing.cost(agg.model, agg.tokens);
      const isAgent = t.kind === "agent";
      const folder = (agg.cwd || "").split(/[\\/]/).filter(Boolean).pop() || "";

      let title: string;
      let subtitle: string;
      if (isAgent) {
        title = t.meta?.description || bestTitle(agg, "Agent");
        subtitle = t.meta?.agentType || "agent";
      } else {
        title = bestTitle(agg, folder || "Session");
        subtitle = folder || "session";
      }

      let activity = agg.activity || (status === "done" ? "Terminé" : "…");
      let working = agg.working && status !== "done";

      const node: FleetNode = {
        id: this.nodeId(t),
        kind: t.kind,
        parentId: isAgent ? t.parentSessionId : null,
        title,
        subtitle,
        model: agg.model || "—",
        modelFamily: modelFamily(agg.model),
        status,
        working,
        activity,
        activityKind: agg.activityKind,
        tokens: agg.tokens,
        cost,
        messageCount: agg.messageCount,
        lastTs: agg.lastTs || t.mtimeMs,
        startedTs: agg.firstTs || t.mtimeMs,
        cwd: agg.cwd,
        gitBranch: agg.gitBranch,
        sessionId: t.sessionId,
        filePath: t.filePath,
        managed: managed.has(t.sessionId),
        approx: agg.capped,
      };
      nodes.push(node);
    }

    // Show recent (non-"done") sessions + their FULL agent tree (any agent age).
    const shownSessionIds = new Set(
      nodes.filter((n) => n.kind === "session" && n.status !== "done").map((n) => n.id)
    );
    const filtered = nodes.filter(
      (n) =>
        (n.kind === "session" && shownSessionIds.has(n.id)) ||
        (n.kind === "agent" && shownSessionIds.has(n.parentId || ""))
    );

    let totalCost = 0;
    let totalTokens = 0;
    let liveCount = 0;
    let sessionCount = 0;
    let agentCount = 0;
    for (const n of filtered) {
      totalCost += n.cost.total;
      totalTokens += sumTokens(n.tokens);
      if (n.status === "live") liveCount++;
      if (n.kind === "agent") agentCount++;
      else sessionCount++;
    }

    const summary: FleetSummary = { totalCost, totalTokens, liveCount, sessionCount, agentCount };
    this.opts.onState({
      generatedAt: Date.now(),
      nodes: filtered,
      summary,
      workspaceCwd: this.opts.workspaceCwd,
    });
  }
}

function readMeta(p: string): AgentMeta | undefined {
  try {
    if (!fs.existsSync(p)) return undefined;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

export function defaultProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}
