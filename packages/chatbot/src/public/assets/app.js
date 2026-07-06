/* ────────────────────────────────────────────────────────────────────────────
   Blindfold Chatbot — client-side JS.
   Plain ES2022, no framework, no build step. Hand-crafted.
   ──────────────────────────────────────────────────────────────────────────── */

(() => {
  "use strict";

  // ── Elements ──────────────────────────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const messagesEl = $("#messages");
  const composer = $("#composer");
  const inputEl = $("#input");
  const sendBtn = $("#send-btn");
  const audienceSel = $("#audience-select");
  const topicList = $("#topic-list");
  const topicSearch = $("#topic-search");
  const historyList = $("#history-list");
  const historyEmpty = $("#history-empty");
  const sideTabs = $$(".side-tab");
  const sidePanes = $$(".side-pane");
  const side = $("#side");
  const sideToggle = $("#side-toggle");
  const sideOverlay = $("#side-overlay");

  // ── State ─────────────────────────────────────────────────────────────────
  const state = {
    audience: "auto",
    history: [],          // [{role, content, ts}]
    kb: [],               // [{id, intent, question, audience, confidence, sources}]
    inFlight: false,
  };

  // ── Markdown → HTML (tiny safe renderer; no external deps) ────────────────
  function renderMarkdown(md) {
    // We render server-side responses — they're already produced by the chatbot.
    // To avoid double-encoding, we use a minimal converter.
    let s = String(md || "");

    // Escape HTML.
    s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // Code fences ```lang ... ```
    s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code class="lang-${escapeAttr(lang)}">${code.trim()}</code></pre>`,
    );

    // Inline code `code`
    s = s.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);

    // Headings (##, ###, ####)
    s = s.replace(/^######\s+(.+)$/gm, "<h4>$1</h4>");
    s = s.replace(/^#####\s+(.+)$/gm, "<h4>$1</h4>");
    s = s.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
    s = s.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
    s = s.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");

    // Blockquote
    s = s.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");
    s = s.replace(/^>\s?(.+)$/gm, "<blockquote>$1</blockquote>");

    // Horizontal rule
    s = s.replace(/^---$/gm, "<hr>");

    // Bold / italic
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");

    // Links [label](url)
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
      `<a href="${escapeAttr(safeUrl(url))}" target="_blank" rel="noopener">${label}</a>`,
    );

    // Tables — minimal | a | b | parsing
    s = renderTables(s);

    // Lists (basic)
    s = renderLists(s);

    // Paragraphs: split on double newline for non-block content
    s = renderParagraphs(s);

    return s;
  }

  function renderTables(s) {
    const lines = s.split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line && line.trim().startsWith("|") && line.trim().endsWith("|")) {
        // Collect contiguous table lines.
        const rows = [];
        while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
          rows.push(lines[i].trim());
          i++;
        }
        if (rows.length >= 2) {
          // Skip separator row (---).
          const header = parseRow(rows[0]);
          const bodyRows = rows.slice(1).filter((r) => !/^\|[\s-:|]+\|$/.test(r));
          out.push("<table>");
          out.push("<thead><tr>" + header.map((c) => `<th>${c}</th>`).join("") + "</tr></thead>");
          if (bodyRows.length > 0) {
            out.push("<tbody>");
            for (const r of bodyRows) {
              const cells = parseRow(r);
              out.push("<tr>" + cells.map((c) => `<td>${c}</td>`).join("") + "</tr>");
            }
            out.push("</tbody>");
          }
          out.push("</table>");
          continue;
        }
      }
      out.push(line);
      i++;
    }
    return out.join("\n");
  }
  function parseRow(row) {
    return row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  }

  function renderLists(s) {
    const lines = s.split("\n");
    const out = [];
    let inList = false;
    let ordered = false;
    for (const line of lines) {
      const m = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)/);
      if (m) {
        const isOrdered = /^\d+\./.test(m[2]);
        if (!inList || ordered !== isOrdered) {
          if (inList) out.push(ordered ? "</ol>" : "</ul>");
          out.push(isOrdered ? "<ol>" : "<ul>");
          inList = true;
          ordered = isOrdered;
        }
        out.push(`<li>${m[3]}</li>`);
      } else {
        if (inList) {
          out.push(ordered ? "</ol>" : "</ul>");
          inList = false;
        }
        out.push(line);
      }
    }
    if (inList) out.push(ordered ? "</ol>" : "</ul>");
    return out.join("\n");
  }

  function renderParagraphs(s) {
    return s
      .split(/\n{2,}/)
      .map((block) => {
        if (/^\s*<(h\d|ul|ol|pre|table|blockquote|hr)/.test(block.trim())) return block;
        // Preserve single newlines as <br>.
        return `<p>${block.replace(/\n/g, "<br>")}</p>`;
      })
      .join("\n\n");
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Only allow safe URL schemes in rendered links. Blocks javascript:, data:,
  // vbscript:, etc. so poisoned KB/model output can't produce a clickable
  // script-executing anchor. Relative URLs (/, #, ./, ../) are allowed.
  function safeUrl(url) {
    const raw = String(url || "").replace(/[\x00-\x20]/g, "");
    if (raw === "") return "#";
    if (/^(\/|#|\.\/|\.\.\/)/.test(raw)) return raw;
    const m = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (!m) return raw; // schemeless relative (e.g. "docs/foo")
    const scheme = m[1].toLowerCase();
    if (scheme === "http" || scheme === "https" || scheme === "mailto") return raw;
    return "#";
  }

  // ── Render messages ──────────────────────────────────────────────────────
  function renderMessage(role, content, meta = {}) {
    const wrap = document.createElement("div");
    wrap.className = `msg msg-${role}`;

    const header = document.createElement("div");
    header.className = "msg-header";
    header.innerHTML = `<span class="msg-role ${role}">${role}</span>` +
      (meta.intent ? `<span class="msg-tag intent">${escapeAttr(meta.intent)}</span>` : "") +
      (meta.audience ? `<span class="msg-tag audience-${meta.audience}">${meta.audience}</span>` : "") +
      (meta.confidence != null ? `<span class="msg-tag">conf ${meta.confidence.toFixed(2)}</span>` : "") +
      (meta.usedFallback ? `<span class="msg-tag fallback">fallback</span>` : "");
    wrap.appendChild(header);

    const body = document.createElement("div");
    body.className = "msg-body";
    body.innerHTML = renderMarkdown(content);
    wrap.appendChild(body);

    if (Array.isArray(meta.sources) && meta.sources.length > 0) {
      const s = document.createElement("div");
      s.className = "msg-sources";
      s.innerHTML = `<strong>sources</strong><ul>` +
        meta.sources.slice(0, 8).map((x) =>
          `<li>${typeof x === "string" ? x : `<a href="${escapeAttr(safeUrl(x.url || "#"))}" target="_blank" rel="noopener">${escapeAttr(x.label || x.url)}</a>`}</li>`,
        ).join("") + `</ul>`;
      wrap.appendChild(s);
    }
    if (Array.isArray(meta.related) && meta.related.length > 0) {
      const r = document.createElement("div");
      r.className = "msg-related";
      r.innerHTML = `<strong>related</strong><ul>` +
        meta.related.slice(0, 4).map((q) => `<li>${escapeAttr(q.question || q)}</li>`).join("") + `</ul>`;
      wrap.appendChild(r);
    }

    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderTyping() {
    const wrap = document.createElement("div");
    wrap.className = "msg msg-assistant";
    wrap.id = "typing-indicator";
    wrap.innerHTML = `<div class="msg-header"><span class="msg-role assistant">assistant</span><span class="msg-tag">…</span></div><div class="msg-body"><div class="typing"><span></span><span></span><span></span></div></div>`;
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function clearTyping() {
    const t = $("#typing-indicator");
    if (t) t.remove();
  }

  function renderWelcome() {
    const w = document.createElement("div");
    w.className = "welcome";
    w.innerHTML = `
      <h2>Blindfold Chatbot — rule-based Q&A</h2>
      <p>Ask anything about <strong>Blindfold</strong>, the open-source Terminal 3 TDX enclave wrapper that makes AI agent API keys un-leakable.</p>
      <p>Pick a role on the top right to calibrate depth, or just start typing. The chatbot reads the project's actual docs and source code — no fabricated APIs.</p>
      <ul>
        <li><strong>Users / newcomers</strong> — "what is Blindfold?"</li>
        <li><strong>Developers</strong> — "how do I register a key?"</li>
        <li><strong>Founders</strong> — "vs Vault? pricing?"</li>
        <li><strong>Enterprise</strong> — "trust model? audit?"</li>
        <li><strong>Researchers</strong> — "what is TDX? in-enclave substitution?"</li>
      </ul>
    `;
    messagesEl.appendChild(w);
  }

  // ── Topic sidebar ─────────────────────────────────────────────────────────
  async function loadTopics() {
    try {
      const res = await fetch("/api/audit?limit=200");
      if (!res.ok) return;
      const data = await res.json();
      state.kb = data.entries || [];
      renderTopics();
    } catch (e) {
      // ignore
    }
  }

  function renderTopics() {
    const q = (topicSearch.value || "").toLowerCase();
    const filtered = state.kb
      .filter((e) =>
        !q ||
        e.question.toLowerCase().includes(q) ||
        e.intent.toLowerCase().includes(q) ||
        (e.audience || []).some((a) => a.includes(q)),
      )
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 80);

    topicList.innerHTML = "";
    for (const e of filtered) {
      const btn = document.createElement("button");
      btn.className = "topic-item";
      btn.dataset.q = e.question;
      const aud = (e.audience || []).filter((a) => a !== "general").join(", ") || "all";
      btn.innerHTML = `<span class="topic-q">${escapeAttr(e.question)}</span><span class="topic-meta">${escapeAttr(e.intent)} · ${escapeAttr(aud)} · ${(e.confidence || 0).toFixed(2)}</span>`;
      btn.addEventListener("click", () => {
        inputEl.value = e.question;
        inputEl.focus();
        autoResize();
      });
      topicList.appendChild(btn);
    }
    if (filtered.length === 0) {
      topicList.innerHTML = `<div class="history-empty">No matching topics.</div>`;
    }
  }

  // ── Side panel tabs ──────────────────────────────────────────────────────
  sideTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      sideTabs.forEach((t) => t.classList.remove("active"));
      sidePanes.forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      const pane = $(`.side-pane[data-pane="${tab.dataset.tab}"]`);
      if (pane) pane.classList.add("active");
    });
  });

  // ── Sidebar toggle (mobile) ────────────────────────────────────────────────
  function openSide() {
    if (!side) return;
    side.classList.add("open");
    sideOverlay?.classList.add("open");
    sideToggle?.setAttribute("aria-expanded", "true");
  }
  function closeSide() {
    if (!side) return;
    side.classList.remove("open");
    sideOverlay?.classList.remove("open");
    sideToggle?.setAttribute("aria-expanded", "false");
  }
  sideToggle?.addEventListener("click", () => {
    if (side?.classList.contains("open")) closeSide();
    else openSide();
  });
  sideOverlay?.addEventListener("click", closeSide);
  window.addEventListener("resize", () => {
    if (window.innerWidth >= 900) {
      side?.classList.remove("open");
      sideOverlay?.classList.remove("open");
    }
  });
  topicList?.addEventListener("click", (e) => {
    const target = e.target;
    if (target instanceof Element && target.closest(".topic-item")) {
      if (window.innerWidth < 900) closeSide();
    }
  });

  // ── Composer ──────────────────────────────────────────────────────────────
  function autoResize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(180, inputEl.scrollHeight) + "px";
  }
  inputEl.addEventListener("input", autoResize);

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      composer.requestSubmit();
    }
    if (e.key === "/" && inputEl.value === "") {
      // optional: show /help hint
    }
  });

  composer.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (state.inFlight) return;
    const message = inputEl.value.trim();
    if (!message) return;

    // Special: /help
    if (message === "/help") {
      inputEl.value = "";
      autoResize();
      renderMessage("assistant", [
        "**Slash commands**",
        "- `/help` — show this",
        "- `/clear` — clear the conversation",
        "- `/audience <role>` — pin audience for next messages",
        "",
        "**Keyboard**",
        "- `Enter` — send",
        "- `Shift+Enter` — newline",
      ].join("\n"));
      return;
    }

    inputEl.value = "";
    autoResize();
    renderMessage("user", message);
    state.history.push({ role: "user", content: message, ts: Date.now() });

    renderTyping();
    state.inFlight = true;
    sendBtn.disabled = true;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          audience: state.audience === "auto" ? undefined : state.audience,
          history: state.history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      clearTyping();
      if (!res.ok) {
        renderMessage("assistant", `**Error** — HTTP ${res.status} from the chatbot. Try again.`, {
          intent: "error",
        });
        return;
      }
      const data = await res.json();
      renderMessage("assistant", data.message, {
        intent: data.intent,
        audience: data.audience,
        confidence: data.confidence,
        usedFallback: data.usedFallback,
        sources: data.sources,
        related: data.related,
      });
      state.history.push({ role: "assistant", content: data.message, ts: Date.now() });
      while (state.history.length > 20) state.history.shift();
      pushHistory(message, data);
    } catch (err) {
      clearTyping();
      renderMessage("assistant", `**Network error** — ${escapeAttr((err && err.message) || "unknown")}. Check the server is up.`, { intent: "error" });
    } finally {
      state.inFlight = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }
  });

  // ── History pane ──────────────────────────────────────────────────────────
  function pushHistory(question, response) {
    historyEmpty.style.display = "none";
    const li = document.createElement("li");
    li.innerHTML = `<strong>${escapeAttr(question)}</strong><span class="h-time">${new Date().toLocaleTimeString()} · ${escapeAttr(response.intent || "")} · ${escapeAttr(response.audience || "")}</span>`;
    li.addEventListener("click", () => {
      inputEl.value = question;
      inputEl.focus();
    });
    historyList.insertBefore(li, historyList.firstChild);
  }

  // ── Audience select ───────────────────────────────────────────────────────
  audienceSel.addEventListener("change", () => {
    state.audience = audienceSel.value;
  });

  // ── Quick-actions dock ────────────────────────────────────────────────────
  $$(".dock-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      inputEl.value = btn.dataset.q || "";
      autoResize();
      inputEl.focus();
      composer.requestSubmit();
    });
  });

  // ── Topic search ──────────────────────────────────────────────────────────
  topicSearch.addEventListener("input", renderTopics);

  // ── Boot ──────────────────────────────────────────────────────────────────
  renderWelcome();
  loadTopics();
})();