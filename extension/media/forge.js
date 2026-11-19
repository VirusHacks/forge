// Forge sidebar webview. Renders TrueForge activity; all actions are validated by the extension host.
(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const saved = vscode.getState() || {};
  let state = { runs: [], models: [], model: "", workspace: "", pendingReview: undefined };
  let mentions = saved.mentions || [];
  let draft = saved.draft || "";
  const views = new Map(); // runId -> { items, byTool, usage, metrics, calls, model, waitingUntil, session }
  let renderedRun = null, feed = null, statusLine = null, scrollPinned = true, frame = 0;

  const send = m => vscode.postMessage(m);
  const persist = () => vscode.setState({ draft, mentions });
  const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = String(text); return n; };
  const btn = (text, onClick, cls = "", title) => { const b = h("button", cls, text); b.type = "button"; if (title) { b.title = title; b.setAttribute("aria-label", title); } b.addEventListener("click", onClick); return b; };
  const fmtTokens = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n || 0);
  const fmtMs = ms => ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
  const short = m => String(m || "").split("/").pop();

  // ---------- markdown (safe: DOM text nodes only) ----------
  function inline(target, text) {
    const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g; let at = 0, m;
    while ((m = re.exec(text))) {
      target.append(document.createTextNode(text.slice(at, m.index)));
      const t = m[0];
      target.append(t.startsWith("`") ? h("code", "", t.slice(1, -1)) : t.startsWith("**") ? h("strong", "", t.slice(2, -2)) : h("em", "", t.slice(1, -1)));
      at = m.index + t.length;
    }
    target.append(document.createTextNode(text.slice(at)));
  }
  function markdown(node, text) {
    node.replaceChildren();
    const parts = String(text).split(/```/);
    parts.forEach((part, i) => {
      if (i % 2) {
        const code = part.replace(/^[^\n]*\n/, "");
        const block = h("div", "md-code"); const pre = h("pre", "", code.replace(/\n$/, ""));
        block.append(btn("Copy", () => send({ type: "copy", text: code }), "copy", "Copy code"), pre); node.append(block); return;
      }
      let list = null;
      for (const line of part.split("\n")) {
        const head = /^(#{1,4})\s+(.*)$/.exec(line), item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
        if (item) { if (!list) { list = h("ul"); node.append(list); } const li = h("li"); inline(li, item[1]); list.append(li); continue; }
        list = null;
        if (head) { const e = h("div", "md-h"); inline(e, head[2]); node.append(e); }
        else if (line.trim()) { const p = h("p"); inline(p, line); node.append(p); }
      }
    });
  }

  // ---------- event model ----------
  function view(runId) {
    let v = views.get(runId);
    if (!v) { v = { items: [], byTool: new Map(), usage: null, metrics: null, calls: 0, model: "", waitingUntil: 0, waitLabel: "", session: null, reviews: new Map() }; views.set(runId, v); }
    return v;
  }
  function ingest(run, e) {
    const v = view(run.id);
    const push = item => { item.key = v.items.length; item.dirty = true; v.items.push(item); return item; };
    const last = v.items.at(-1);
    const closeText = () => { if (last && (last.kind === "text" || last.kind === "thinking")) last.closed = true; };
    switch (e.type) {
      case "assistant.delta": case "reasoning.delta": {
        const kind = e.type === "assistant.delta" ? "text" : "thinking";
        if (last && last.kind === kind && !last.closed) { last.text += e.text; last.dirty = true; }
        else { closeText(); push({ kind, text: e.text, started: Date.now() }); }
        v.waitingUntil = 0; return;
      }
      case "context.pack": closeText(); push({ kind: "context", ...e }); return;
      case "session": v.session = e; v.model = e.model; push({ kind: "session", ...e }); return;
      case "model.call": closeText(); v.calls = e.n; v.model = e.model; v.waitingUntil = 0; return;
      case "tool.start": { closeText(); const item = push({ kind: "tool", ...e, status: "running", t0: Date.now() }); v.byTool.set(e.id, item); return; }
      case "tool.end": { const item = v.byTool.get(e.id); if (item) Object.assign(item, { status: e.ok ? "ok" : "error", ms: e.ms, summary: e.summary, preview: e.preview, dirty: true }); return; }
      case "model.retry": closeText(); v.waitingUntil = Date.now() + e.delayMs; v.waitLabel = `${short(e.model)} · ${e.kind.replace(/_/g, " ")}`;
        push({ kind: "banner", tone: "warn", icon: "↻", text: `Retrying ${short(e.model)} in ${Math.ceil(e.delayMs / 1000)} s — ${e.kind.replace(/_/g, " ")}`, detail: e.message }); return;
      case "model.switch": closeText(); v.model = e.to;
        push({ kind: "banner", tone: "switch", icon: "⇄", text: `Fallback: ${short(e.from)} → ${short(e.to)} (${e.kind.replace(/_/g, " ")}). Same TrueForge session continues.`, detail: e.message }); return;
      case "model.failed": closeText(); push({ kind: "banner", tone: "error", icon: "✕", text: `${short(e.model)} failed${e.kind ? ` — ${e.kind.replace(/_/g, " ")}` : ""}`, detail: e.message }); return;
      case "compaction": if (e.phase === "finished") push({ kind: "divider", text: "TrueForge compacted earlier context to stay within the token budget" }); return;
      case "usage": v.usage = e; return;
      case "metrics": v.metrics = e.metrics; return;
      case "review.request": closeText(); { const item = push({ kind: "review", ...e, decided: false, checked: new Set(e.hunks.map(x => x.index)) }); v.reviews.set(e.reviewId, item); } return;
      case "review.result": { for (const r of v.reviews.values()) if (!r.decided) { r.decided = true; r.applied = e.applied; r.dirty = true; } push({ kind: "result", ...e }); return; }
      case "notice": closeText(); push({ kind: "banner", tone: e.level === "error" ? "error" : e.level === "warning" ? "warn" : "info", icon: e.level === "info" ? "ℹ" : "!", text: e.message }); return;
      case "run.end": closeText(); push({ kind: "end", ...e }); return;
    }
  }

  // ---------- item renderers ----------
  const ROLE = { implementation: "impl", test: "test", docs: "docs", config: "cfg" };
  const ICON = { search_code: "⌕", read_code: "▤", find_symbol: "◈", list_files: "☰", stage_edits: "✎", view_staged: "◫", discard_staged: "⌫", run_command: "▶", submit_for_review: "✓", propose_edit: "✎" };

  function renderItem(run, item, node) {
    const v = view(run.id);
    node.replaceChildren();
    node.className = "item item-" + item.kind;
    switch (item.kind) {
      case "text": { if (!item.text.trim()) { node.className = "item hidden"; break; } const body = h("div", "md"); markdown(body, item.text); node.append(body); break; }
      case "thinking": {
        const d = item.node?.querySelector("details") || h("details", "thinking"); d.replaceChildren();
        const s = h("summary", "", item.closed ? "Thought" : "Thinking…"); const body = h("div", "thinking-body", item.text);
        d.append(s, body); if (!item.closed && !item.userToggled) d.open = true; else if (item.closed && !item.userToggled) d.open = false;
        d.addEventListener("toggle", () => { item.userToggled = true; }, { once: true });
        node.append(d); break;
      }
      case "context": {
        const card = h("div", "card context");
        const head = h("div", "card-head");
        head.append(h("span", "card-icon", "◎"), h("span", "card-title", "Context assembled"), h("span", "muted", `${item.files.length} files · ${fmtTokens(item.tokens)} / ${fmtTokens(item.budget)} tokens · ${item.ms} ms${item.graph ? " · RepoMap graph" : ""}`));
        const meter = h("div", "meter"); const fill = h("div", "meter-fill"); fill.style.width = Math.min(100, Math.round(item.tokens / Math.max(1, item.budget) * 100)) + "%"; meter.append(fill);
        card.append(head, meter);
        for (const f of item.files) {
          const row = h("div", "ctx-row");
          const top = h("div", "ctx-top");
          top.append(h("span", "role role-" + (ROLE[f.role] || "impl"), ROLE[f.role] || f.role));
          const link = btn(f.path, () => send({ type: "openFile", path: f.path, line: parseInt(f.ranges[0]) || 1 }), "link path", `Open ${f.path}`);
          top.append(link, h("span", "muted tok", `${fmtTokens(f.tokens)} tok`));
          row.append(top, h("div", "ctx-why", f.reasons.join(" · ") + (f.ranges.length ? ` · lines ${f.ranges.join(", ")}` : "")));
          card.append(row);
        }
        if (item.graphInfo) card.append(graphView(item.graphInfo));
        if (item.omitted) card.append(h("div", "muted small", `${item.omitted} more candidates ranked but left out to respect the budget. Terms: ${item.terms.slice(0, 10).join(", ")}`));
        node.append(card); break;
      }
      case "session": {
        const row = h("div", "session-row");
        row.append(h("span", "muted", "TrueForge session"), btn(item.sessionId.slice(-10) + " ↗", () => send({ type: "openUrl", url: item.url }), "link mono", "Open the session in TrueForge"), h("span", "chip", short(item.model)));
        node.append(row); break;
      }
      case "tool": {
        const card = h("details", "tool tool-" + item.status);
        const sum = h("summary"), line = h("div", "tool-line");
        const [verb, ...rest] = String(item.title).split(" ");
        line.append(h("span", "dot"), h("span", "tool-verb", verb), h("span", "tool-arg", rest.join(" ")));
        const meta = h("span", "tool-meta");
        if (item.status === "running") meta.append(h("span", "muted", "running…"));
        else if (item.ms !== undefined) meta.append(h("span", "muted", fmtMs(item.ms)));
        line.append(meta);
        sum.append(line);
        if (item.summary) { const r = h("div", "tool-result"); r.append(h("span", "elbow", "⎿"), h("span", "", item.summary)); sum.append(r); }
        card.append(sum);
        if (item.preview) card.append(h("pre", "tool-preview", item.preview));
        node.append(card); break;
      }
      case "banner": { const b = h("div", "banner banner-" + item.tone); b.append(h("span", "banner-icon", item.icon), h("span", "", item.text)); if (item.detail) b.title = item.detail; node.append(b); break; }
      case "divider": node.append(h("div", "divider", item.text)); break;
      case "review": node.append(reviewCard(run, item)); break;
      case "result": {
        const r = h("div", "banner " + (item.applied ? "banner-ok" : "banner-info"));
        r.append(h("span", "banner-icon", item.applied ? "✓" : "–"), h("span", "", item.applied ? `Applied ${item.hunks} hunk${item.hunks === 1 ? "" : "s"} to ${item.files.join(", ")} (saved).` : "No changes applied."));
        if (item.applied) r.append(btn("Undo", () => send({ type: "undo" }), "small-btn", "Restore the files to their previous content"));
        node.append(r); break;
      }
      case "end": {
        const m = v.metrics;
        const label = { complete: "Done", rejected: "Rejected", cancelled: "Cancelled", error: "Stopped" }[item.status] || item.status;
        const row = h("div", "end end-" + item.status);
        row.append(h("strong", "", label));
        if (item.message) row.append(h("span", "", " · " + item.message));
        if (m) row.append(h("div", "muted small", `${m.modelCalls} model calls · ${m.toolCalls} tool calls · ${fmtTokens(m.inputTokens)} in / ${fmtTokens(m.outputTokens)} out · ${fmtMs(m.ms)} · ${m.models.map(short).join(" → ")}`));
        node.append(row); break;
      }
    }
    item.node = node;
  }

  // Small node-link view of the RepoMap neighbourhood: callers → focus → callees / tests.
  function graphView(g) {
    const NS = "http://www.w3.org/2000/svg";
    const el = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); if (text !== undefined) n.textContent = text; return n; };
    const left = g.callers.slice(0, 4), right = [...g.callees.slice(0, 2).map(n => ({ ...n, edge: "calls" })), ...g.tests.slice(0, 3).map(t => ({ name: t.split("/").pop(), file: t, line: 1, edge: "test" }))];
    const rows = Math.max(1, left.length, right.length), W = 360, rowH = 26, H = rows * rowH + 18, nodeW = 104, nodeH = 20;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "graph", role: "img", "aria-label": `Code graph around ${g.focus.name}` });
    const y = (i, n) => 9 + (H - 18) * (i + 0.5) / n;
    const box = (x, cy, node, cls) => {
      const grp = el("g", { class: "g-node " + cls, tabindex: 0 });
      const label = node.name.length > 15 ? node.name.slice(0, 14) + "…" : node.name;
      grp.append(el("rect", { x, y: cy - nodeH / 2, width: nodeW, height: nodeH, rx: 4 }), el("text", { x: x + nodeW / 2, y: cy + 3.5, "text-anchor": "middle" }, label), el("title", {}, `${node.name} — ${node.file}:${node.line}`));
      grp.addEventListener("click", () => send({ type: "openFile", path: node.file, line: node.line }));
      svg.append(grp);
    };
    const fx = (W - nodeW) / 2, fy = H / 2;
    left.forEach((n, i) => svg.append(el("line", { x1: 6 + nodeW, y1: y(i, left.length), x2: fx, y2: fy, class: "g-edge" })));
    right.forEach((n, i) => svg.append(el("line", { x1: fx + nodeW, y1: fy, x2: W - 6 - nodeW, y2: y(i, right.length), class: "g-edge" + (n.edge === "test" ? " g-test" : "") })));
    left.forEach((n, i) => box(6, y(i, left.length), n, "g-caller"));
    right.forEach((n, i) => box(W - 6 - nodeW, y(i, right.length), n, n.edge === "test" ? "g-testnode" : "g-callee"));
    box(fx, fy, g.focus, "g-focus");
    const wrap = h("div", "graph-wrap");
    const head = h("div", "graph-head");
    head.append(h("span", "card-icon", "⌬"), h("span", "", "Code graph"), h("span", "muted small", "RepoMap · callers → focus → calls / tests"));
    wrap.append(head, svg);
    return wrap;
  }

  function reviewCard(run, item) {
    const card = h("div", "card review" + (item.decided ? " decided" : ""));
    const pending = state.pendingReview && state.pendingReview.reviewId === item.reviewId && !item.decided;
    const head = h("div", "card-head");
    const files = [...new Set(item.hunks.map(x => x.path))];
    head.append(h("span", "card-icon", "⊟"), h("span", "card-title", "Review changes"), h("span", "muted", `${item.hunks.length} hunks · ${files.length} files`));
    card.append(head);
    if (item.summary) { const s = h("div", "md review-summary"); markdown(s, item.summary); card.append(s); }
    if (item.verification) {
      const ok = item.verification.exitCode === 0;
      const badge = h("div", "verify " + (item.verification.stale ? "verify-stale" : ok ? "verify-ok" : "verify-fail"));
      badge.append(h("span", "", item.verification.stale ? "◌" : ok ? "✓" : "✕"), h("span", "mono", item.verification.command), h("span", "", `— ${item.verification.summary}${item.verification.stale ? " (before the last edit)" : ""}`));
      card.append(badge);
    } else card.append(h("div", "verify verify-stale", "◌ No verification command was run for this proposal."));
    for (const hunk of item.hunks) {
      const row = h("div", "hunk");
      const top = h("label", "hunk-top");
      const box = h("input"); box.type = "checkbox"; box.checked = item.checked.has(hunk.index); box.disabled = !pending;
      box.addEventListener("change", () => { box.checked ? item.checked.add(hunk.index) : item.checked.delete(hunk.index); updateCount(); });
      top.append(box, h("span", "path mono", `${hunk.path}:${hunk.line}`), h("span", "add", `+${hunk.added}`), h("span", "del", `−${hunk.removed}`));
      if (hunk.newFile) top.append(h("span", "chip", "new file"));
      const open = btn("Diff", e => { e.preventDefault(); send({ type: "openHunk", reviewId: item.reviewId, index: hunk.index }); }, "small-btn", "Show this hunk in the diff editor");
      top.append(open);
      const pre = h("pre", "hunk-preview");
      for (const line of hunk.preview.split("\n")) pre.append(h("span", line.startsWith("+") ? "ln-add" : line.startsWith("-") ? "ln-del" : "ln-ctx", line + "\n"));
      row.append(top, pre); card.append(row);
    }
    const actions = h("div", "actions");
    const accept = btn("", () => { send({ type: "decision", reviewId: item.reviewId, indices: [...item.checked] }); item.decided = true; }, "primary");
    const reject = btn("Reject all", () => { send({ type: "decision", reviewId: item.reviewId, indices: [] }); item.decided = true; }, "secondary");
    const all = btn("Select all", () => { item.hunks.forEach(x => item.checked.add(x.index)); card.querySelectorAll("input[type=checkbox]").forEach(c => { c.checked = true; }); updateCount(); }, "link");
    function updateCount() { accept.textContent = `Accept ${item.checked.size} of ${item.hunks.length}`; accept.disabled = !pending || item.checked.size === 0; }
    updateCount();
    if (pending) actions.append(accept, reject, all);
    else actions.append(h("span", "muted", item.decided ? (item.applied ? "Accepted" : "Closed") : "Waiting for the agent…"));
    card.append(actions);
    return card;
  }

  // ---------- layout ----------
  function currentRun() { return state.runs.find(r => r.id === state.current); }

  function renderAll() {
    const run = currentRun();
    app.replaceChildren();
    const top = h("header", "top");
    const brand = h("div", "brand"); brand.append(h("span", "logo", "◆"), h("span", "", "Forge"));
    top.append(brand, h("span", "workspace muted", state.workspace));
    if (state.runs.length) {
      const sel = h("select", "history"); sel.title = "Run history";
      sel.append(h("option", "", "History"));
      [...state.runs].reverse().forEach(r => { const o = h("option", "", `${r.kind === "inline" ? "✎ " : ""}${r.title.slice(0, 50)} · ${r.status}`); o.value = r.id; if (r.id === state.current) o.selected = true; sel.append(o); });
      sel.addEventListener("change", () => sel.value && send({ type: "select", runId: sel.value }));
      top.append(sel);
    }
    top.append(btn("+", () => send({ type: "newChat" }), "icon-btn", "New task"));
    app.append(top);

    feed = h("div", "feed"); feed.setAttribute("role", "log");
    feed.addEventListener("scroll", () => { scrollPinned = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60; });
    app.append(feed);
    renderedRun = run ? run.id : null;
    if (!run) feed.append(emptyState());
    else {
      const user = h("div", "user-msg"); const meta = h("div", "user-meta");
      meta.append(h("span", "chip", run.kind === "inline" ? "Inline edit" : "Agent"), h("span", "chip", short(run.model)));
      user.append(meta, h("div", "", run.title)); feed.append(user);
      const v = view(run.id);
      for (const item of v.items) { const node = h("div"); renderItem(run, item, node); item.dirty = false; feed.append(node); }
    }
    // Visually hidden live region so screen readers hear run status changes (pattern adapted from Cline).
    const announce = h("div", "screen-reader-announcement", run ? `Forge run ${run.status}` : "Forge ready");
    announce.setAttribute("aria-live", "polite"); announce.setAttribute("aria-atomic", "true");
    app.append(announce);
    statusLine = h("div", "status-line"); app.append(statusLine); updateStatus();
    app.append(composer());
    if (scrollPinned) feed.scrollTop = feed.scrollHeight;
  }

  function emptyState() {
    const e = h("div", "empty");
    e.append(h("div", "empty-logo", "◆"), h("h2", "", "What should Forge change?"),
      h("p", "muted", "Forge assembles the relevant code automatically, edits several files through TrueForge, runs your tests in a sandbox copy, and shows every hunk for review before anything is written."),
      h("p", "muted small", "Inline edit: select code and press ⌘⌥K (Ctrl+Alt+K)."));
    return e;
  }

  function composer() {
    const wrap = h("div", "composer");
    if (mentions.length) {
      const chips = h("div", "chips");
      mentions.forEach((m, i) => { const c = h("span", "mention"); c.append(h("span", "", m), btn("×", () => { mentions.splice(i, 1); persist(); renderAll(); }, "chip-x", `Remove ${m}`)); chips.append(c); });
      wrap.append(chips);
    }
    const ta = h("textarea"); ta.value = draft; ta.rows = 3; ta.placeholder = "Describe a change… type @ to mention a file";
    ta.setAttribute("aria-label", "Task for Forge");
    ta.addEventListener("input", () => { draft = ta.value; persist(); if (/(^|\s)@$/.test(ta.value)) { ta.value = ta.value.slice(0, -1); draft = ta.value; send({ type: "attachFile" }); } });
    const running = state.runs.some(r => r.status === "running");
    const submit = () => { if (running || !ta.value.trim()) return; send({ type: "start", task: ta.value, model: modelSel.value, mentions }); draft = ""; mentions = []; persist(); };
    ta.addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } });
    const bar = h("div", "toolbar");
    const left = h("div", "toolbar-left");
    left.append(btn("@", () => send({ type: "attachFile" }), "icon-btn", "Mention a file"), btn("#", () => send({ type: "attachSymbol" }), "icon-btn", "Mention a symbol"));
    const modelSel = h("select", "model"); modelSel.title = "Model configured in TrueForge";
    if (!state.models.length) modelSel.append(h("option", "", state.modelError ? "TrueForge unreachable" : "Loading models…"));
    state.models.forEach(m => { const o = h("option", "", m); o.value = m; if (m === state.model) o.selected = true; modelSel.append(o); });
    modelSel.addEventListener("change", () => send({ type: "model", model: modelSel.value }));
    left.append(modelSel, btn("↻", () => send({ type: "models" }), "icon-btn", "Refresh models"));
    bar.append(left);
    if (running) { const r = state.runs.find(x => x.status === "running"); bar.append(btn("■ Stop", () => send({ type: "stop", runId: r.id }), "stop", "Stop the run (Esc)")); }
    else bar.append(btn("Send ⌘↵", submit, "primary send"));
    wrap.append(ta, bar);
    if (state.modelError) wrap.append(h("div", "banner banner-error small", state.modelError));
    setTimeout(() => { if (!running && document.activeElement === document.body) ta.focus(); }, 0);
    return wrap;
  }

  function updateStatus() {
    if (!statusLine) return;
    const run = currentRun();
    statusLine.replaceChildren();
    if (!run) return;
    const v = view(run.id);
    if (run.status === "running") {
      const waiting = v.waitingUntil > Date.now();
      statusLine.append(h("span", "spinner"), h("span", "", waiting ? `Waiting ${Math.ceil((v.waitingUntil - Date.now()) / 1000)} s · ${v.waitLabel}` : v.calls ? `Model call ${v.calls} · ${short(v.model)}` : "Assembling context…"));
    }
    if (v.usage) statusLine.append(h("span", "muted right", `${fmtTokens(v.usage.totalInput)} in · ${fmtTokens(v.usage.totalOutput)} out`));
  }
  setInterval(updateStatus, 500);

  function flushRender() {
    frame = 0;
    const run = currentRun();
    if (!run || renderedRun !== run.id || !feed) return renderAll();
    const v = view(run.id);
    const nodes = feed.children; // [user-msg, ...items]
    for (const item of v.items) {
      if (!item.dirty) continue;
      const existing = nodes[item.key + 1];
      if (existing) renderItem(run, item, existing); else { const n = h("div"); renderItem(run, item, n); feed.append(n); }
      item.dirty = false;
    }
    updateStatus();
    if (scrollPinned) feed.scrollTop = feed.scrollHeight;
  }

  window.addEventListener("message", ({ data }) => {
    if (!data || typeof data.type !== "string") return;
    if (data.type === "state") {
      // Rebuild event views for runs we have not seen (e.g. after the view was reopened).
      for (const run of data.runs) if (!views.has(run.id)) { const v = view(run.id); for (const e of run.events) ingest(run, e); v.items.forEach(i => { i.dirty = true; }); }
      state = data; renderAll();
    } else if (data.type === "events") {
      const run = state.runs.find(r => r.id === data.runId);
      if (!run) return;
      for (const e of data.events) ingest(run, e);
      if (data.runId === state.current && !frame) frame = requestAnimationFrame(flushRender);
    } else if (data.type === "mention") {
      if (!mentions.includes(data.value)) mentions.push(data.value); persist(); renderAll();
    } else if (data.type === "toast") {
      const t = h("div", "toast", data.text); document.body.append(t); setTimeout(() => t.remove(), 4000);
    }
  });
  window.addEventListener("keydown", e => { if (e.key === "Escape") { const r = state.runs.find(x => x.status === "running"); if (r) send({ type: "stop", runId: r.id }); } });
  renderAll();
  send({ type: "ready" });
})();
