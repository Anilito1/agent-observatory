(function () {
  const vscode = acquireVsCodeApi();
  const bubblesEl = document.getElementById("bubbles");
  const linksEl = document.getElementById("links");
  const stageEl = document.getElementById("stage");
  const emptyEl = document.getElementById("empty");
  const drawerEl = document.getElementById("drawer");
  const drawerContent = document.getElementById("drawer-content");
  const scrimEl = document.getElementById("scrim");

  let state = { nodes: [], summary: {}, workspaceCwd: null };
  let workspaceCwd = null;
  let filterScope = "all";
  let showMode = "active"; // 'active' = only open/running sessions, 'recent' = include idle
  let selectedId = null;
  let drawerBuiltFor = null; // node id the drawer DOM was built for (avoid rebuilding -> avoid tail flicker)
  let lang = "fr";
  let period = "session";

  const bubbleCache = new Map(); // id -> .node element
  const linkCache = new Map(); // agentId -> <path>
  const tweens = new Map();
  let layoutNodes = []; // [{id, el, kind, status, parentId, capOut, bx, by, r, cx, cy, ax, ay, sx, sy, px, py, pinned}]
  let layoutById = new Map();
  let linksOffL = 0, linksOffT = 0; // cached at render time (avoid per-frame layout reads)
  const manualPos = new Map(); // id -> {x, y} when user-dragged
  const NODE_W = 150, SESSION_R = 33, AGENT_R = 23, HUB_R = 27;
  const HUB_ID = "__hub__";
  const MEDIA = (typeof window !== "undefined" && window.__mediaBase) || "media";
  // generated character clips per pose (others fall back to the SVG character)
  const VIDEO_BY_POSE = { type: "working.mp4", sit: "chilling.mp4" };

  // little animated character drawn inside each orb (pose set via [data-pose])
  const AVATAR_SVG =
    '<svg class="avatar" viewBox="0 0 48 48" aria-hidden="true">' +
    '<g class="av-seat"><rect x="12" y="31" width="24" height="8" rx="4"/><rect x="12" y="24" width="5" height="11" rx="2.5"/><rect x="31" y="24" width="5" height="11" rx="2.5"/></g>' +
    '<g class="av-desk"><rect class="av-deskbar" x="13" y="34" width="22" height="2.4" rx="1.2"/><rect class="av-laptop" x="17" y="26" width="14" height="9" rx="1.6"/><rect class="av-screen" x="18.4" y="27.3" width="11.2" height="6.4" rx="1"/></g>' +
    '<g class="av-fig"><ellipse class="av-torso" cx="24" cy="28" rx="7" ry="8"/><rect class="av-arm av-arm-l" x="15" y="25" width="7" height="3" rx="1.5"/><rect class="av-arm av-arm-r" x="26" y="25" width="7" height="3" rx="1.5"/><circle class="av-head" cx="24" cy="15.5" r="6"/></g>' +
    '<g class="av-think"><circle class="d1" cx="33" cy="12" r="1.4"/><circle class="d2" cx="37" cy="8.5" r="1.8"/><circle class="d3" cx="41.5" cy="5.5" r="2.2"/></g>' +
    '<g class="av-check"><circle cx="35" cy="13" r="6"/><path d="M32 13 l2 2 l4 -4.2"/></g>' +
    "</svg>";
  const HUB_SVG =
    '<svg class="avatar hub-av" viewBox="0 0 48 48" aria-hidden="true">' +
    '<rect class="hub-mon" x="11" y="13" width="26" height="18" rx="2.5"/>' +
    '<rect class="hub-scr" x="13.5" y="15.5" width="21" height="13" rx="1.2"/>' +
    '<rect class="hub-stand" x="22" y="31" width="4" height="4"/>' +
    '<rect class="hub-base" x="17" y="35" width="14" height="2.4" rx="1.2"/>' +
    "</svg>";

  function poseOf(node) {
    if (node.kind === "hub") return "hub";
    if (node.status === "done") return "done";
    if (node.working && node.activityKind === "thinking") return "think";
    if (node.working || node.activityKind === "tool_result") return "type"; // mid-task = still working
    return "sit"; // genuinely waiting / idle
  }
  // anti-flicker: only switch to the calm "sit" pose after a sustained idle (~3s),
  // so brief gaps during a tool burst don't flash the chilling clip.
  const SIT_DWELL = 3000;
  function effectivePose(el, node) {
    let desired = poseOf(node);
    if (desired === "sit") {
      const now = Date.now();
      if (!el.dataset.sitSince) el.dataset.sitSince = String(now);
      const elapsed = now - parseFloat(el.dataset.sitSince);
      const shown = el.dataset.shownPose;
      if (elapsed < SIT_DWELL && shown && shown !== "sit") desired = shown;
    } else {
      el.dataset.sitSince = "";
    }
    el.dataset.shownPose = desired;
    return desired;
  }

  // ---------- format ----------
  function fmtTokens(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }
  function fmtCost(n) {
    if (n >= 100) return "$" + n.toFixed(1);
    if (n >= 1) return "$" + n.toFixed(2);
    return "$" + n.toFixed(3);
  }
  function sumTokens(t) { return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead; }
  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return lang === "en" ? "just now" : "à l'instant";
    if (s < 60) return s + " s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + " min";
    const h = Math.floor(m / 60);
    if (h < 24) return h + " h";
    return Math.floor(h / 24) + (lang === "en" ? " d" : " j");
  }
  function esc(s) {
    return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function actIcon(kind) {
    switch (kind) {
      case "thinking": return "✷";
      case "tool": return "›_";
      case "tool_result": return "↩";
      case "text": return "▍";
      case "done": return "✓";
      default: return "·";
    }
  }
  function shortModel(m) {
    if (!m || m === "—") return "—";
    return m.replace(/^claude-/, "").replace(/-(\d{8})$/, "");
  }

  // ---------- i18n ----------
  const I18N = {
    live: { fr: "en direct", en: "live" },
    tokens: { fr: "tokens", en: "tokens" },
    cost: { fr: "coût", en: "cost" },
    active: { fr: "Actives", en: "Active" },
    recent: { fr: "Récentes", en: "Recent" },
    all: { fr: "Tous", en: "All" },
    thisProject: { fr: "Ce projet", en: "This project" },
    newSession: { fr: "+ Session", en: "+ Session" },
    emptyActiveTitle: { fr: "Aucune session ouverte", en: "No open session" },
    emptyActiveDesc: { fr: "Les sessions Claude Code en cours d'exécution apparaîtront ici, en direct. Bascule sur « Récentes » pour revoir les sessions inactives.", en: "Running Claude Code sessions show here, live. Switch to “Recent” to see inactive ones." },
    emptyRecentTitle: { fr: "Aucune session récente", en: "No recent session" },
    emptyRecentDesc: { fr: "Lance une session Claude Code — elle apparaîtra ici.", en: "Start a Claude Code session — it will show up here." },
    myMachine: { fr: "Ma machine", en: "My machine" },
    session: { fr: "session", en: "session" },
    liveWord: { fr: "en direct", en: "live" },
    activity: { fr: "Activité", en: "Activity" },
    apiCost: { fr: "Coût API", en: "API cost" },
    input: { fr: "Input", en: "Input" },
    output: { fr: "Output", en: "Output" },
    cacheWrite: { fr: "Cache (écriture)", en: "Cache (write)" },
    cacheRead: { fr: "Cache (lecture)", en: "Cache (read)" },
    cacheWriteShort: { fr: "Cache write", en: "Cache write" },
    cacheReadShort: { fr: "Cache read", en: "Cache read" },
    total: { fr: "Total", en: "Total" },
    context: { fr: "Contexte", en: "Context" },
    messages: { fr: "Messages", en: "Messages" },
    activeDuration: { fr: "Durée active", en: "Active duration" },
    lastActivity: { fr: "Dernière activité", en: "Last activity" },
    folder: { fr: "Dossier", en: "Folder" },
    branch: { fr: "Branche", en: "Branch" },
    takeControl: { fr: "↩ Reprendre la main", en: "↩ Take control" },
    copyResume: { fr: "Copier resume", en: "Copy resume" },
    transcript: { fr: "Transcript", en: "Transcript" },
    reveal: { fr: "Révéler", en: "Reveal" },
    liveFeed: { fr: "Flux en direct", en: "Live feed" },
    loading: { fr: "Chargement…", en: "Loading…" },
    noEvents: { fr: "Aucun événement récent.", en: "No recent events." },
    approxNote: { fr: "≈ transcript volumineux : coût calculé sur la partie récente.", en: "≈ large transcript: cost computed on the recent part." },
    periodTitle: { fr: "Période de calcul tokens & coût", en: "Token & cost period" },
  };
  const PERIODS = [
    { v: "session", fr: "Session (total)", en: "Session (total)" },
    { v: "today", fr: "Aujourd'hui", en: "Today" },
    { v: "24h", fr: "24 h", en: "24h" },
    { v: "7d", fr: "7 jours", en: "7d" },
    { v: "1h", fr: "1 h", en: "1h" },
  ];
  function t(key) { return (I18N[key] && I18N[key][lang]) || (I18N[key] && I18N[key].en) || key; }
  function periodLabel(v) { const p = PERIODS.find((x) => x.v === v) || PERIODS[0]; return p[lang] || p.en; }

  // localize the few fixed French phrases produced by the parser (host side)
  function loc(s) {
    if (lang !== "en" || !s) return s;
    return s
      .replace(/^Résultat reçu$/, "Result received")
      .replace(/^Terminé$/, "Done")
      .replace(/^↩ résultat d'outil$/, "↩ tool result")
      .replace(/^↳ Lance un agent · /, "↳ Launch agent · ");
  }

  // ---------- number tween ----------
  function tween(el, target, fmt) {
    const cur = parseFloat(el.dataset.val || "0");
    if (Math.abs(cur - target) < 1e-9) {
      el.textContent = fmt(target);
      el.dataset.val = String(target);
      return;
    }
    const prev = tweens.get(el);
    if (prev) cancelAnimationFrame(prev);
    const start = performance.now();
    const dur = 450;
    const from = cur;
    function step(now) {
      const p = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      const v = from + (target - from) * e;
      el.textContent = fmt(v);
      el.dataset.val = String(v);
      if (p < 1) tweens.set(el, requestAnimationFrame(step));
      else { el.textContent = fmt(target); el.dataset.val = String(target); tweens.delete(el); }
    }
    tweens.set(el, requestAnimationFrame(step));
  }

  // ---------- node (floating orb + animated character + caption) ----------
  function createNode(node) {
    const el = document.createElement("div");
    el.className = "node " + node.kind;
    el.dataset.id = node.id;
    el.style.transform = "translate3d(-9999px,-9999px,0)"; // hidden until first layout frame
    const inner = node.kind === "hub" ? HUB_SVG : AVATAR_SVG;
    const vid = node.kind === "hub" ? "" : '<video class="orb-video" muted loop playsinline></video>';
    el.innerHTML =
      '<div class="orb">' + vid + inner + "</div>" +
      '<div class="caption">' +
      '<div class="cap-title"></div>' +
      '<div class="cap-act"><span class="ca-ico"></span><span class="ca-text"></span></div>' +
      '<div class="cap-meta">' +
      '<span class="cap-tag"></span>' +
      '<span class="cap-cost" data-val="0">$0.000</span>' +
      '<span class="cap-managed hidden" title="Pilotée par Agent Observatory">●</span>' +
      "</div></div>";
    attachDrag(el, node.id);
    return el;
  }

  function updateNode(el, node) {
    el.className =
      "node " + node.kind + " " + node.status +
      (node.working ? " working" : "") +
      (node.managed && node.kind === "session" ? " managed" : "") +
      (manualPos.has(node.id) ? " pinned" : "");
    const pose = effectivePose(el, node);
    el.dataset.pose = pose;

    // video character for poses that have a clip; SVG fallback otherwise
    const video = el.querySelector(".orb-video");
    if (video) {
      const orb = el.querySelector(".orb");
      const vfile = VIDEO_BY_POSE[pose];
      if (vfile) {
        if (video.dataset.file !== vfile) {
          video.src = MEDIA + "/avatars/" + vfile;
          video.dataset.file = vfile;
        }
        orb.classList.add("has-video");
        if (video.paused) video.play().catch(() => {});
      } else {
        orb.classList.remove("has-video");
        if (!video.paused) video.pause();
      }
    }

    el.querySelector(".cap-title").textContent = node.title;
    const act = el.querySelector(".cap-act");
    act.className = "cap-act " + node.activityKind;
    el.querySelector(".ca-ico").textContent = actIcon(node.status === "done" ? "done" : node.activityKind);
    el.querySelector(".ca-text").textContent = loc(node.activity);

    if (node.kind === "hub") {
      el.querySelector(".cap-tag").textContent = "";
      el.querySelector(".cap-cost").textContent = "";
      return;
    }
    el.querySelector(".cap-tag").textContent =
      node.kind === "agent" ? node.subtitle : shortModel(node.model);
    const costEl = el.querySelector(".cap-cost");
    costEl.classList.toggle("approx", !!node.approx);
    tween(costEl, node.cost.total, fmtCost);
    el.querySelector(".cap-managed").classList.toggle(
      "hidden", !(node.managed && node.kind === "session")
    );
  }

  function ensureNode(node) {
    let el = bubbleCache.get(node.id);
    if (!el) { el = createNode(node); bubbleCache.set(node.id, el); bubblesEl.appendChild(el); }
    updateNode(el, node);
    return el;
  }

  // ---------- drag (hold + move) / click ----------
  let drag = null;
  function attachDrag(el, id) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const ln = layoutById.get(id);
      const br = bubblesEl.getBoundingClientRect();
      drag = {
        id, el, moved: false,
        sx: e.clientX, sy: e.clientY,
        offX: (ln ? ln.cx : 0) - (e.clientX - br.left),
        offY: (ln ? ln.cy : 0) - (e.clientY - br.top),
      };
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
      el.classList.add("dragging");
    });
  }
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 4) return;
    drag.moved = true;
    const br = bubblesEl.getBoundingClientRect();
    const cx = e.clientX - br.left + drag.offX;
    const cy = e.clientY - br.top + drag.offY;
    manualPos.set(drag.id, { x: cx, y: cy });
    const ln = layoutById.get(drag.id);
    if (ln) { ln.bx = cx; ln.by = cy; ln.cx = cx; ln.cy = cy; ln.ax = 0; ln.ay = 0; ln.pinned = true; }
  });
  window.addEventListener("pointerup", () => {
    if (!drag) return;
    const d = drag; drag = null;
    d.el.classList.remove("dragging");
    if (!d.moved) {
      if (d.id === HUB_ID) vscode.postMessage({ type: "newSession", cwd: workspaceCwd });
      else openDrawer(d.id);
    } else {
      d.el.classList.add("pinned");
    }
  });

  // ---------- filter ----------
  function samePath(a, b) {
    return (a || "").replace(/[\\/]+$/, "").toLowerCase() === (b || "").replace(/[\\/]+$/, "").toLowerCase();
  }
  function computeNodes() {
    let nodes = state.nodes;

    // workspace filter
    if (filterScope === "workspace" && workspaceCwd) {
      const sessions = nodes.filter((n) => n.kind === "session" && samePath(n.cwd, workspaceCwd));
      const ids = new Set(sessions.map((s) => s.id));
      nodes = nodes.filter(
        (n) => (n.kind === "session" && ids.has(n.id)) || (n.kind === "agent" && ids.has(n.parentId))
      );
    }

    // a session counts as "open" if it is live itself OR has a live (working) agent
    const liveAgentParents = new Set(
      nodes.filter((n) => n.kind === "agent" && n.status === "live").map((n) => n.parentId)
    );

    if (showMode === "active") {
      const openSessions = nodes.filter(
        (n) => n.kind === "session" && (n.status === "live" || liveAgentParents.has(n.id))
      );
      const openIds = new Set(openSessions.map((s) => s.id));
      const openAgents = nodes.filter(
        (n) => n.kind === "agent" && n.status === "live" && openIds.has(n.parentId)
      );
      nodes = [...openSessions, ...openAgents];
    }

    // annotate: a session with a live agent is itself shown as live + working
    return nodes.map((n) => {
      if (n.kind === "session" && liveAgentParents.has(n.id)) {
        return { ...n, status: "live", working: true };
      }
      return n;
    });
  }
  function statusRank(n) { return n.status === "live" ? 0 : n.status === "idle" ? 1 : 2; }

  function setEmptyText() {
    const title = showMode === "active" ? t("emptyActiveTitle") : t("emptyRecentTitle");
    const desc = showMode === "active" ? t("emptyActiveDesc") : t("emptyRecentDesc");
    emptyEl.innerHTML = '<div class="empty-glow"></div><p>' + esc(title) + "</p><span>" + esc(desc) + "</span>";
  }

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function removeNode(id) {
    const el = bubbleCache.get(id);
    if (!el) return;
    bubbleCache.delete(id);
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 280);
  }
  function pushLayout(arr, byId, node, el, bx, by, r, parentId, capOut) {
    const h = hashStr(node.id);
    const m = manualPos.get(node.id);
    const baseAx = node.kind === "session" ? 4.5 : node.kind === "hub" ? 3 : 6.5;
    const baseAy = node.kind === "session" ? 5.5 : node.kind === "hub" ? 3.5 : 7.5;
    const ln = {
      id: node.id, el, kind: node.kind, status: node.status,
      parentId: parentId || null, capOut: capOut || 0,
      bx: m ? m.x : bx, by: m ? m.y : by, r,
      cx: m ? m.x : bx, cy: m ? m.y : by,
      ax: m ? 0 : baseAx, ay: m ? 0 : baseAy,
      sx: 0.45 + (h % 35) / 100, sy: 0.4 + ((h >> 3) % 35) / 100,
      px: (h % 628) / 100, py: ((h >> 5) % 628) / 100,
      pinned: !!m,
    };
    arr.push(ln);
    byId.set(node.id, ln);
  }

  function render() {
    const nodes = computeNodes();
    const sessions = nodes
      .filter((n) => n.kind === "session")
      .sort((a, b) => statusRank(a) - statusRank(b) || b.lastTs - a.lastTs);
    const agentsByParent = new Map();
    for (const n of nodes) {
      if (n.kind === "agent") {
        if (!agentsByParent.has(n.parentId)) agentsByParent.set(n.parentId, []);
        agentsByParent.get(n.parentId).push(n);
      }
    }

    emptyEl.classList.toggle("hidden", sessions.length > 0);
    if (sessions.length === 0) setEmptyText();

    const desired = new Set(nodes.map((n) => n.id));
    desired.add(HUB_ID);
    for (const id of [...bubbleCache.keys()]) {
      if (!desired.has(id)) { removeNode(id); manualPos.delete(id); }
    }

    const newLayout = [];
    const byId = new Map();
    if (sessions.length === 0) {
      removeNode(HUB_ID);
      layoutNodes = newLayout; layoutById = byId;
      syncDrawer();
      return;
    }

    const W = Math.max(320, bubblesEl.clientWidth || stageEl.clientWidth || 360);
    const SESSION_BLOCK = SESSION_R * 2 + 12 + 46;
    const AGENT_BLOCK = AGENT_R * 2 + 10 + 46;
    const AGENT_SPACING = NODE_W + 16;

    // measure a column per session (session + its agent cluster)
    const cols = sessions.map((s) => {
      const agents = (agentsByParent.get(s.id) || []).sort(
        (a, b) => statusRank(a) - statusRank(b) || a.startedTs - b.startedTs
      );
      const perRow = Math.max(1, Math.min(agents.length || 1, Math.floor((W - 24) / AGENT_SPACING)));
      const agentRowW = Math.min(agents.length, perRow) * AGENT_SPACING;
      const colW = Math.max(NODE_W + 30, agentRowW || 0);
      return { s, agents, perRow, colW };
    });
    const totalW = cols.reduce((a, c) => a + c.colW, 0);
    const contentW = Math.max(W, totalW + 24);

    // root "machine" hub, connecting all sessions
    const anyLive = sessions.some((s) => s.status === "live");
    const hub = {
      id: HUB_ID, kind: "hub", title: t("myMachine"), subtitle: "", activity: "",
      activityKind: "idle", status: anyLive ? "live" : "idle", working: false,
      model: "", cost: { total: 0 },
      tokens: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
      managed: false, approx: false,
    };
    const hubY = 20 + HUB_R;
    pushLayout(newLayout, byId, hub, ensureNode(hub), contentW / 2, hubY, HUB_R, null, 42);

    const sessionsY = hubY + HUB_R + 62;
    let x = Math.max(12, (contentW - totalW) / 2);
    let maxBottom = sessionsY + SESSION_R;

    for (const c of cols) {
      const sx = x + c.colW / 2, sy = sessionsY + SESSION_R;
      pushLayout(newLayout, byId, c.s, ensureNode(c.s), sx, sy, SESSION_R, HUB_ID, 58);
      if (c.agents.length) {
        const rows = Math.ceil(c.agents.length / c.perRow);
        const agentsTop = sy + SESSION_BLOCK + 22;
        c.agents.forEach((a, i) => {
          const row = Math.floor(i / c.perRow);
          const colCount = row < rows - 1 ? c.perRow : c.agents.length - c.perRow * (rows - 1);
          const col = i % c.perRow;
          const rowW = colCount * AGENT_SPACING;
          const ax = sx - rowW / 2 + AGENT_SPACING / 2 + col * AGENT_SPACING;
          const ay = agentsTop + row * AGENT_BLOCK + AGENT_R;
          pushLayout(newLayout, byId, a, ensureNode(a), ax, ay, AGENT_R, c.s.id, 0);
          maxBottom = Math.max(maxBottom, ay + AGENT_R + 46);
        });
      } else {
        maxBottom = Math.max(maxBottom, sy + SESSION_BLOCK);
      }
      x += c.colW;
    }

    bubblesEl.style.width = contentW + "px";
    bubblesEl.style.height = maxBottom + 30 + "px";
    layoutNodes = newLayout;
    layoutById = byId;

    // size the link layer + cache offsets ONCE here (not every animation frame)
    linksEl.style.width = stageEl.clientWidth + "px";
    linksEl.style.height = stageEl.scrollHeight + "px";
    linksOffL = bubblesEl.offsetLeft;
    linksOffT = bubblesEl.offsetTop;

    syncDrawer();
  }

  // ---------- floating animation loop ----------
  function frame(t) {
    if (!layoutNodes.length) { requestAnimationFrame(frame); return; }
    const tt = t * 0.001;
    for (const ln of layoutNodes) {
      const ox = Math.sin(tt * ln.sx + ln.px) * ln.ax;
      const oy = Math.sin(tt * ln.sy + ln.py) * ln.ay;
      ln.cx = ln.bx + ox;
      ln.cy = ln.by + oy;
      ln.el.style.transform =
        "translate3d(" + (ln.cx - NODE_W / 2).toFixed(1) + "px," + (ln.cy - ln.r).toFixed(1) + "px,0)";
    }
    drawLinks();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Rebuild the drawer DOM only when the selected node changes; otherwise update
  // live values in place so the "Flux en direct" list is never wiped (no flicker).
  function syncDrawer() {
    if (!selectedId) return;
    const n = nodeById(selectedId);
    if (!n) { closeDrawer(); return; }
    if (drawerBuiltFor !== selectedId) {
      buildDrawer(n);
      drawerBuiltFor = selectedId;
      vscode.postMessage({ type: "requestTail", nodeId: selectedId });
    } else {
      updateDrawerLive(n);
    }
  }

  // ---------- connectors (follow the floating orbs) — path updates only, no layout reads ----------
  function drawLinks() {
    const offL = linksOffL, offT = linksOffT;
    const present = new Set();
    for (const ln of layoutNodes) {
      if (!ln.parentId) continue;
      const p = layoutById.get(ln.parentId);
      if (!p) continue;
      // branch out from BELOW the parent's caption (not through its text)
      const x1 = p.cx + offL, y1 = p.cy + p.r + (p.capOut || 0) + offT;
      const x2 = ln.cx + offL, y2 = ln.cy - ln.r + offT;
      const dy = Math.max(12, (y2 - y1) / 2);
      let path = linkCache.get(ln.id);
      if (!path) {
        path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        linksEl.appendChild(path);
        linkCache.set(ln.id, path);
      }
      path.setAttribute(
        "d",
        "M " + x1.toFixed(1) + " " + y1.toFixed(1) +
        " C " + x1.toFixed(1) + " " + (y1 + dy).toFixed(1) + ", " +
        x2.toFixed(1) + " " + (y2 - dy).toFixed(1) + ", " +
        x2.toFixed(1) + " " + y2.toFixed(1)
      );
      const cls = "link" + (ln.status === "live" ? " live" : "");
      if (path.getAttribute("class") !== cls) path.setAttribute("class", cls);
      present.add(ln.id);
    }
    for (const [id, path] of [...linkCache.entries()]) {
      if (!present.has(id)) { path.remove(); linkCache.delete(id); }
    }
  }

  // ---------- drawer ----------
  function nodeById(id) { return state.nodes.find((n) => n.id === id); }
  function folderOf(p) {
    if (!p) return "—";
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts.slice(-2).join("/") || p;
  }
  function openDrawer(id) {
    selectedId = id;
    drawerBuiltFor = null;
    drawerEl.classList.remove("hidden");
    scrimEl.classList.remove("hidden");
    syncDrawer();
  }
  function closeDrawer() {
    selectedId = null;
    drawerBuiltFor = null;
    drawerEl.classList.add("hidden");
    scrimEl.classList.add("hidden");
  }
  document.getElementById("drawer-close").addEventListener("click", closeDrawer);
  scrimEl.addEventListener("click", closeDrawer);

  function durStr(n) {
    const dur = n.lastTs && n.startedTs ? Math.max(0, n.lastTs - n.startedTs) : 0;
    return dur > 60000 ? Math.round(dur / 60000) + " min" : dur > 0 ? Math.round(dur / 1000) + " s" : "—";
  }

  function buildDrawer(n) {
    const tk = n.tokens, c = n.cost;
    drawerContent.innerHTML = `
      <div class="d-title">${esc(n.title)}</div>
      <div class="d-sub">
        <span class="dot ${n.status}" id="d-dot"></span>
        <span class="chip model">${esc(shortModel(n.model))}</span>
        <span class="chip agenttype">${esc(n.kind === "agent" ? n.subtitle : t("session"))}</span>
        <span id="d-live" style="color:var(--green)${n.status === "live" ? "" : ";display:none"}">${esc(t("liveWord"))}</span>
      </div>
      <div class="d-section">
        <h4>${esc(t("activity"))}</h4>
        <div class="b-activity ${n.activityKind}" id="d-act" style="font-size:12px">
          <span class="act-ico" id="d-act-ico">${actIcon(n.status === "done" ? "done" : n.activityKind)}</span>
          <span class="act-text" id="d-act-text" style="white-space:normal">${esc(loc(n.activity))}</span>
        </div>
      </div>
      <div class="d-section">
        <h4>${esc(t("apiCost"))} · ${esc(n.modelFamily)} · ${esc(periodLabel(period))}</h4>
        <div class="d-grid">
          <span class="k">${esc(t("input"))}</span><span class="v" id="d-c-in">${fmtCost(c.input)}</span>
          <span class="k">${esc(t("output"))}</span><span class="v" id="d-c-out">${fmtCost(c.output)}</span>
          <span class="k">${esc(t("cacheWrite"))}</span><span class="v" id="d-c-cw">${fmtCost(c.cacheWrite)}</span>
          <span class="k">${esc(t("cacheRead"))}</span><span class="v" id="d-c-cr">${fmtCost(c.cacheRead)}</span>
          <span class="k d-total">${esc(t("total"))}</span><span class="v accent d-total" id="d-c-total">${n.approx ? "≈ " : ""}${fmtCost(c.total)}</span>
        </div>
        ${n.approx ? '<div class="tail-empty" style="margin-top:7px">' + esc(t("approxNote")) + "</div>" : ""}
      </div>
      <div class="d-section">
        <h4>${esc(t("tokens"))}</h4>
        <div class="d-grid">
          <span class="k">${esc(t("input"))}</span><span class="v" id="d-t-in">${fmtTokens(tk.input)}</span>
          <span class="k">${esc(t("output"))}</span><span class="v" id="d-t-out">${fmtTokens(tk.output)}</span>
          <span class="k">${esc(t("cacheWriteShort"))}</span><span class="v" id="d-t-cw">${fmtTokens(tk.cacheWrite5m + tk.cacheWrite1h)}</span>
          <span class="k">${esc(t("cacheReadShort"))}</span><span class="v" id="d-t-cr">${fmtTokens(tk.cacheRead)}</span>
          <span class="k d-total">${esc(t("total"))}</span><span class="v d-total" id="d-t-total">${fmtTokens(sumTokens(tk))}</span>
        </div>
      </div>
      <div class="d-section">
        <h4>${esc(t("context"))}</h4>
        <div class="d-grid">
          <span class="k">${esc(t("messages"))}</span><span class="v" id="d-msgs">${n.messageCount}</span>
          <span class="k">${esc(t("activeDuration"))}</span><span class="v" id="d-dur">${durStr(n)}</span>
          <span class="k">${esc(t("lastActivity"))}</span><span class="v" id="d-last">${timeAgo(n.lastTs)}</span>
          <span class="k">${esc(t("folder"))}</span><span class="v" style="font-size:11px">${esc(folderOf(n.cwd))}</span>
          ${n.gitBranch ? `<span class="k">${esc(t("branch"))}</span><span class="v" style="font-size:11px">${esc(n.gitBranch)}</span>` : ""}
        </div>
      </div>
      <div class="d-actions">
        <button class="primary" id="act-resume">${esc(t("takeControl"))}</button>
        <button id="act-copy">${esc(t("copyResume"))}</button>
        <button id="act-open">${esc(t("transcript"))}</button>
        <button id="act-reveal">${esc(t("reveal"))}</button>
      </div>
      <div class="d-section">
        <h4>${esc(t("liveFeed"))}</h4>
        <div class="tail" id="tail-list"><div class="tail-empty">${esc(t("loading"))}</div></div>
      </div>`;
    document.getElementById("act-resume").addEventListener("click", () =>
      vscode.postMessage({ type: "resume", sessionId: n.sessionId, cwd: n.cwd }));
    document.getElementById("act-copy").addEventListener("click", () =>
      vscode.postMessage({ type: "copyResume", sessionId: n.sessionId }));
    document.getElementById("act-open").addEventListener("click", () =>
      vscode.postMessage({ type: "openTranscript", filePath: n.filePath }));
    document.getElementById("act-reveal").addEventListener("click", () =>
      vscode.postMessage({ type: "revealFolder", filePath: n.filePath }));
  }

  // In-place live update of the open drawer (never touches the "Flux en direct" list).
  function updateDrawerLive(n) {
    const set = (id, v) => { const el = document.getElementById(id); if (el && el.textContent !== v) el.textContent = v; };
    const dot = document.getElementById("d-dot"); if (dot) dot.className = "dot " + n.status;
    const live = document.getElementById("d-live"); if (live) live.style.display = n.status === "live" ? "" : "none";
    const act = document.getElementById("d-act"); if (act) act.className = "b-activity " + n.activityKind;
    set("d-act-ico", actIcon(n.status === "done" ? "done" : n.activityKind));
    set("d-act-text", loc(n.activity));
    const c = n.cost, t = n.tokens;
    set("d-c-in", fmtCost(c.input)); set("d-c-out", fmtCost(c.output));
    set("d-c-cw", fmtCost(c.cacheWrite)); set("d-c-cr", fmtCost(c.cacheRead));
    set("d-c-total", (n.approx ? "≈ " : "") + fmtCost(c.total));
    set("d-t-in", fmtTokens(t.input)); set("d-t-out", fmtTokens(t.output));
    set("d-t-cw", fmtTokens(t.cacheWrite5m + t.cacheWrite1h)); set("d-t-cr", fmtTokens(t.cacheRead));
    set("d-t-total", fmtTokens(sumTokens(t)));
    set("d-msgs", String(n.messageCount));
    set("d-dur", durStr(n)); set("d-last", timeAgo(n.lastTs));
  }

  function renderTail(nodeId, lines) {
    if (nodeId !== selectedId) return;
    const list = document.getElementById("tail-list");
    if (!list) return;
    const sig = nodeId + ":" + lines.length + ":" + (lines.length ? lines[lines.length - 1].ts : 0);
    if (list.dataset.sig === sig) return; // unchanged -> don't re-render (no flicker)
    list.dataset.sig = sig;
    if (!lines.length) { list.innerHTML = '<div class="tail-empty">' + esc(t("noEvents")) + "</div>"; return; }
    list.innerHTML = lines.slice().reverse().map((l) => `
      <div class="tail-item">
        <div class="tl-head"><span class="tl-kind ${l.kind}">${l.kind}</span><span class="tl-time">${timeAgo(l.ts)}</span></div>
        <div class="tl-body">${esc(loc(l.text))}</div>
      </div>`).join("");
  }
  setInterval(() => { if (selectedId) vscode.postMessage({ type: "requestTail", nodeId: selectedId }); }, 2500);

  // ---------- topbar ----------
  function aggStats() {
    // always reflect what is actually shown (respects active/recent + workspace filters)
    let cost = 0, tok = 0, live = 0;
    for (const n of computeNodes()) {
      cost += n.cost.total;
      tok += sumTokens(n.tokens);
      if (n.status === "live" && n.kind === "session") live++;
    }
    return { cost, tok, live };
  }
  function updateStats() {
    const a = aggStats();
    tween(document.getElementById("stat-cost"), a.cost, fmtCost);
    tween(document.getElementById("stat-tokens"), a.tok, fmtTokens);
    document.getElementById("stat-live").textContent = a.live;
  }

  const modeBtn = document.getElementById("mode-toggle");
  const filterBtn = document.getElementById("filter-toggle");
  const newBtn = document.getElementById("btn-new");
  const langBtn = document.getElementById("lang-toggle");
  const periodSel = document.getElementById("period");

  // (re)apply all chrome strings for the current language
  function applyI18n() {
    document.getElementById("lbl-live").textContent = t("live");
    document.getElementById("lbl-tokens").textContent = t("tokens");
    document.getElementById("lbl-cost").textContent = t("cost") + " · " + periodLabel(period);
    modeBtn.textContent = showMode === "active" ? t("active") : t("recent");
    filterBtn.textContent = filterScope === "all" ? t("all") : t("thisProject");
    newBtn.textContent = t("newSession");
    langBtn.textContent = lang.toUpperCase();
    periodSel.title = t("periodTitle");
    // rebuild period options
    const cur = period;
    periodSel.innerHTML = PERIODS.map((p) => '<option value="' + p.v + '">' + esc(p[lang] || p.en) + "</option>").join("");
    periodSel.value = cur;
  }

  newBtn.addEventListener("click", () =>
    vscode.postMessage({ type: "newSession", cwd: workspaceCwd }));

  modeBtn.addEventListener("click", () => {
    showMode = showMode === "active" ? "recent" : "active";
    modeBtn.textContent = showMode === "active" ? t("active") : t("recent");
    modeBtn.classList.toggle("on", showMode === "active");
    render();
    updateStats();
  });

  filterBtn.addEventListener("click", () => {
    filterScope = filterScope === "all" ? "workspace" : "all";
    filterBtn.textContent = filterScope === "all" ? t("all") : t("thisProject");
    filterBtn.classList.toggle("primary", filterScope === "workspace");
    render();
    updateStats();
  });

  periodSel.addEventListener("change", () => {
    period = periodSel.value;
    document.getElementById("lbl-cost").textContent = t("cost") + " · " + periodLabel(period);
    vscode.postMessage({ type: "setPeriod", period }); // host recomputes tokens/cost -> new state
  });

  langBtn.addEventListener("click", () => {
    lang = lang === "fr" ? "en" : "fr";
    vscode.postMessage({ type: "setLanguage", language: lang });
    applyI18n();
    if (selectedId) { drawerBuiltFor = null; syncDrawer(); }
    render();
    updateStats();
  });

  applyI18n();

  // ---------- messaging ----------
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (msg.type === "state") { state = msg.state; render(); updateStats(); }
    else if (msg.type === "config") {
      workspaceCwd = msg.workspaceCwd;
      if (msg.language && msg.language !== lang) lang = msg.language;
      if (msg.period && msg.period !== period) period = msg.period;
      applyI18n();
      if (selectedId) { drawerBuiltFor = null; syncDrawer(); }
      render();
      updateStats();
    }
    else if (msg.type === "tail") { renderTail(msg.nodeId, msg.lines); }
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 120);
  });

  vscode.postMessage({ type: "ready" });
})();
