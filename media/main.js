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
  let selectedId = null;

  const bubbleCache = new Map(); // id -> bubble element
  const groupCache = new Map(); // sessionId -> { group, head, agentsRow }
  const linkCache = new Map(); // agentId -> <path>
  const tweens = new Map();

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
    if (s < 5) return "à l'instant";
    if (s < 60) return s + " s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + " min";
    const h = Math.floor(m / 60);
    if (h < 24) return h + " h";
    return Math.floor(h / 24) + " j";
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

  // ---------- bubble ----------
  function createBubble(node) {
    const el = document.createElement("div");
    el.className = "bubble " + node.kind;
    el.dataset.id = node.id;
    el.innerHTML = `
      <div class="b-top">
        <span class="dot"></span>
        ${node.kind === "agent" ? '<span class="chip agenttype"></span>' : ""}
        <span class="chip model"></span>
        <span class="b-spacer"></span>
        <span class="managed-dot hidden" title="Pilotée par Fleet"></span>
        <span class="b-cost" data-val="0">$0.000</span>
      </div>
      <div class="b-title"></div>
      <div class="b-activity"><span class="act-ico"></span><span class="act-text"></span></div>
      <div class="work-bar"></div>`;
    el.addEventListener("click", () => openDrawer(node.id));
    return el;
  }

  function updateBubble(el, node) {
    el.querySelector(".dot").className = "dot " + node.status;
    el.classList.toggle("working", !!node.working);
    el.classList.toggle("live-emph", node.status === "live");

    if (node.kind === "agent") {
      const at = el.querySelector(".agenttype");
      if (at) at.textContent = node.subtitle;
    }
    el.querySelector(".model").textContent = shortModel(node.model);
    el.querySelector(".b-title").textContent = node.title;

    const act = el.querySelector(".b-activity");
    act.className = "b-activity " + node.activityKind;
    el.querySelector(".act-ico").textContent = actIcon(node.status === "done" ? "done" : node.activityKind);
    el.querySelector(".act-text").textContent = node.activity;

    const costEl = el.querySelector(".b-cost");
    costEl.classList.toggle("approx", !!node.approx);
    costEl.title = node.approx ? "Coût partiel (transcript volumineux lu depuis la fin)" : "";
    tween(costEl, node.cost.total, fmtCost);

    el.querySelector(".managed-dot").classList.toggle("hidden", !(node.managed && node.kind === "session"));
  }

  function ensureBubble(node) {
    let el = bubbleCache.get(node.id);
    if (!el) { el = createBubble(node); bubbleCache.set(node.id, el); }
    updateBubble(el, node);
    return el;
  }

  // ---------- filter ----------
  function samePath(a, b) {
    return (a || "").replace(/[\\/]+$/, "").toLowerCase() === (b || "").replace(/[\\/]+$/, "").toLowerCase();
  }
  function visibleNodes() {
    let nodes = state.nodes;
    if (filterScope === "workspace" && workspaceCwd) {
      const sessions = nodes.filter((n) => n.kind === "session" && samePath(n.cwd, workspaceCwd));
      const ids = new Set(sessions.map((s) => s.id));
      nodes = nodes.filter(
        (n) => (n.kind === "session" && ids.has(n.id)) || (n.kind === "agent" && ids.has(n.parentId))
      );
    }
    return nodes;
  }
  function statusRank(n) { return n.status === "live" ? 0 : n.status === "idle" ? 1 : 2; }

  // ---------- DOM reconciliation (no full rebuild -> no flicker) ----------
  function placeInOrder(container, orderedEls) {
    for (let i = 0; i < orderedEls.length; i++) {
      const el = orderedEls[i];
      if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
    }
  }
  function removeBubble(id) {
    const el = bubbleCache.get(id);
    if (!el) return;
    bubbleCache.delete(id);
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 260);
  }

  function render() {
    const nodes = visibleNodes();
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

    const desiredBubbleIds = new Set(nodes.map((n) => n.id));
    const desiredSessionIds = new Set(sessions.map((s) => s.id));

    // remove vanished bubbles
    for (const id of [...bubbleCache.keys()]) if (!desiredBubbleIds.has(id)) removeBubble(id);
    // remove vanished groups
    for (const [sid, g] of [...groupCache.entries()]) {
      if (!desiredSessionIds.has(sid)) { g.group.remove(); groupCache.delete(sid); }
    }

    const groupEls = [];
    for (const s of sessions) {
      let g = groupCache.get(s.id);
      if (!g) {
        const group = document.createElement("div");
        group.className = "group";
        group.dataset.session = s.id;
        const head = document.createElement("div");
        head.className = "group-head";
        const agentsRow = document.createElement("div");
        agentsRow.className = "group-agents";
        group.appendChild(head);
        group.appendChild(agentsRow);
        g = { group, head, agentsRow };
        groupCache.set(s.id, g);
      }
      // head bubble
      const headBubble = ensureBubble(s);
      if (g.head.firstChild !== headBubble) placeInOrder(g.head, [headBubble]);

      // agents row
      const agents = (agentsByParent.get(s.id) || []).sort(
        (a, b) => statusRank(a) - statusRank(b) || a.startedTs - b.startedTs
      );
      const agentEls = agents.map((a) => ensureBubble(a));
      placeInOrder(g.agentsRow, agentEls);

      groupEls.push(g.group);
    }
    placeInOrder(bubblesEl, groupEls);

    requestAnimationFrame(drawLinks);
    if (selectedId) refreshDrawer();
  }

  // ---------- connectors (reuse paths) ----------
  function drawLinks() {
    linksEl.style.width = stageEl.clientWidth + "px";
    linksEl.style.height = stageEl.scrollHeight + "px";
    const sr = stageEl.getBoundingClientRect();
    const ox = -sr.left + stageEl.scrollLeft;
    const oy = -sr.top + stageEl.scrollTop;

    const nodes = visibleNodes();
    const present = new Set();
    for (const n of nodes) {
      if (n.kind !== "agent") continue;
      const childEl = bubbleCache.get(n.id);
      const parentEl = bubbleCache.get(n.parentId);
      if (!childEl || !parentEl || !childEl.isConnected || !parentEl.isConnected) continue;
      const c = childEl.getBoundingClientRect();
      const p = parentEl.getBoundingClientRect();
      if (!c.width || !p.width) continue;
      const x1 = p.left + p.width / 2 + ox, y1 = p.bottom + oy;
      const x2 = c.left + c.width / 2 + ox, y2 = c.top + oy;
      const dy = Math.max(16, (y2 - y1) / 2);
      let path = linkCache.get(n.id);
      if (!path) {
        path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        linksEl.appendChild(path);
        linkCache.set(n.id, path);
      }
      path.setAttribute("d", `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`);
      const cls = "link" + (n.status === "live" ? " live" : "");
      if (path.getAttribute("class") !== cls) path.setAttribute("class", cls);
      present.add(n.id);
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
    drawerEl.classList.remove("hidden");
    scrimEl.classList.remove("hidden");
    refreshDrawer();
    vscode.postMessage({ type: "requestTail", nodeId: id });
  }
  function closeDrawer() {
    selectedId = null;
    drawerEl.classList.add("hidden");
    scrimEl.classList.add("hidden");
  }
  document.getElementById("drawer-close").addEventListener("click", closeDrawer);
  scrimEl.addEventListener("click", closeDrawer);

  function refreshDrawer() {
    const n = nodeById(selectedId);
    if (!n) { closeDrawer(); return; }
    const t = n.tokens, c = n.cost;
    const dur = n.lastTs && n.startedTs ? Math.max(0, n.lastTs - n.startedTs) : 0;
    const durStr = dur > 60000 ? Math.round(dur / 60000) + " min" : dur > 0 ? Math.round(dur / 1000) + " s" : "—";
    drawerContent.innerHTML = `
      <div class="d-title">${esc(n.title)}</div>
      <div class="d-sub">
        <span class="dot ${n.status}"></span>
        <span class="chip model">${esc(shortModel(n.model))}</span>
        <span class="chip agenttype">${esc(n.kind === "agent" ? n.subtitle : "session")}</span>
        ${n.status === "live" ? '<span style="color:var(--green)">en direct</span>' : ""}
      </div>
      <div class="d-section">
        <h4>Activité</h4>
        <div class="b-activity ${n.activityKind}" style="font-size:12px">
          <span class="act-ico">${actIcon(n.status === "done" ? "done" : n.activityKind)}</span>
          <span class="act-text" style="white-space:normal">${esc(n.activity)}</span>
        </div>
      </div>
      <div class="d-section">
        <h4>Coût API · ${esc(n.modelFamily)}</h4>
        <div class="d-grid">
          <span class="k">Input</span><span class="v">${fmtCost(c.input)}</span>
          <span class="k">Output</span><span class="v">${fmtCost(c.output)}</span>
          <span class="k">Cache (écriture)</span><span class="v">${fmtCost(c.cacheWrite)}</span>
          <span class="k">Cache (lecture)</span><span class="v">${fmtCost(c.cacheRead)}</span>
          <span class="k d-total">Total</span><span class="v accent d-total">${n.approx ? "≈ " : ""}${fmtCost(c.total)}</span>
        </div>
        ${n.approx ? '<div class="tail-empty" style="margin-top:7px">≈ transcript volumineux : coût calculé sur la partie récente.</div>' : ""}
      </div>
      <div class="d-section">
        <h4>Tokens</h4>
        <div class="d-grid">
          <span class="k">Input</span><span class="v">${fmtTokens(t.input)}</span>
          <span class="k">Output</span><span class="v">${fmtTokens(t.output)}</span>
          <span class="k">Cache write</span><span class="v">${fmtTokens(t.cacheWrite5m + t.cacheWrite1h)}</span>
          <span class="k">Cache read</span><span class="v">${fmtTokens(t.cacheRead)}</span>
          <span class="k d-total">Total</span><span class="v d-total">${fmtTokens(sumTokens(t))}</span>
        </div>
      </div>
      <div class="d-section">
        <h4>Contexte</h4>
        <div class="d-grid">
          <span class="k">Messages</span><span class="v">${n.messageCount}</span>
          <span class="k">Durée active</span><span class="v">${durStr}</span>
          <span class="k">Dernière activité</span><span class="v">${timeAgo(n.lastTs)}</span>
          <span class="k">Dossier</span><span class="v" style="font-size:11px">${esc(folderOf(n.cwd))}</span>
          ${n.gitBranch ? `<span class="k">Branche</span><span class="v" style="font-size:11px">${esc(n.gitBranch)}</span>` : ""}
        </div>
      </div>
      <div class="d-actions">
        <button class="primary" id="act-resume">↩ Reprendre la main</button>
        <button id="act-copy">Copier resume</button>
        <button id="act-open">Transcript</button>
        <button id="act-reveal">Révéler</button>
      </div>
      <div class="d-section">
        <h4>Flux en direct</h4>
        <div class="tail" id="tail-list"><div class="tail-empty">Chargement…</div></div>
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

  function renderTail(nodeId, lines) {
    if (nodeId !== selectedId) return;
    const list = document.getElementById("tail-list");
    if (!list) return;
    if (!lines.length) { list.innerHTML = '<div class="tail-empty">Aucun événement récent.</div>'; return; }
    list.innerHTML = lines.slice().reverse().map((l) => `
      <div class="tail-item">
        <div class="tl-head"><span class="tl-kind ${l.kind}">${l.kind}</span><span class="tl-time">${timeAgo(l.ts)}</span></div>
        <div class="tl-body">${esc(l.text)}</div>
      </div>`).join("");
  }
  setInterval(() => { if (selectedId) vscode.postMessage({ type: "requestTail", nodeId: selectedId }); }, 2500);

  // ---------- topbar ----------
  function aggStats() {
    if (filterScope === "all") {
      const s = state.summary || {};
      return { cost: s.totalCost || 0, tok: s.totalTokens || 0, live: s.liveCount || 0 };
    }
    let cost = 0, tok = 0, live = 0;
    for (const n of visibleNodes()) { cost += n.cost.total; tok += sumTokens(n.tokens); if (n.status === "live") live++; }
    return { cost, tok, live };
  }
  function updateStats() {
    const a = aggStats();
    tween(document.getElementById("stat-cost"), a.cost, fmtCost);
    tween(document.getElementById("stat-tokens"), a.tok, fmtTokens);
    document.getElementById("stat-live").textContent = a.live;
  }

  document.getElementById("btn-new").addEventListener("click", () =>
    vscode.postMessage({ type: "newSession", cwd: workspaceCwd }));
  const filterBtn = document.getElementById("filter-toggle");
  filterBtn.addEventListener("click", () => {
    filterScope = filterScope === "all" ? "workspace" : "all";
    filterBtn.textContent = filterScope === "all" ? "Tous" : "Ce projet";
    filterBtn.classList.toggle("primary", filterScope === "workspace");
    render();
    updateStats();
  });

  // ---------- messaging ----------
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (msg.type === "state") { state = msg.state; render(); updateStats(); }
    else if (msg.type === "config") { workspaceCwd = msg.workspaceCwd; }
    else if (msg.type === "tail") { renderTail(msg.nodeId, msg.lines); }
  });

  window.addEventListener("resize", () => requestAnimationFrame(drawLinks));
  stageEl.addEventListener("scroll", () => requestAnimationFrame(drawLinks));

  vscode.postMessage({ type: "ready" });
})();
