// 스마트 크롤러 콘텐츠 스크립트
// 1) 클릭한 요소에서 위로 올라가며 "같은 모양으로 반복되는 단위(레코드)"를 찾고
// 2) 같은 구조의 레코드를 페이지 전체에서 모은 뒤
// 3) 레코드 안의 텍스트/링크/이미지를 '구조 경로' 키로 추출
// 4) (선택) OpenAI가 키를 의미 있는 필드로 묶고 이름을 붙임 → JSON 다운로드
(() => {
  if (window.__smartCrawler) { window.__smartCrawler.startPicker(); return; }

  const S = {
    picking: false, hoverEl: null, picked: null,
    chain: [], level: 0, selector: "", roots: [],
    raws: [], keys: [], plan: null, rows: [], source: "규칙 기반", busy: false
  };
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH", "TEMPLATE", "IFRAME"]);

  // ---------- 셀렉터 생성 ----------
  const stableClasses = (el) => [...el.classList].filter((c) =>
    /^[A-Za-z_][\w-]*$/.test(c) && !/\d{4,}/.test(c) && c.length < 40 && !c.startsWith("sc-"));

  // 같은 태그 형제들과 공통인 클래스만 사용 → 'active' 같은 상태 클래스에 흔들리지 않음
  function sig(el) {
    const tag = el.tagName.toLowerCase();
    let cls = stableClasses(el);
    const sibs = el.parentElement ? [...el.parentElement.children].filter((s) => s !== el && s.tagName === el.tagName) : [];
    if (sibs.length) cls = cls.filter((c) => sibs.filter((s) => s.classList.contains(c)).length >= Math.ceil(sibs.length * 0.5));
    return tag + cls.slice(0, 3).map((c) => "." + CSS.escape(c)).join("");
  }

  const stableId = (el) => el.id && /^[A-Za-z][\w-]*$/.test(el.id) && !/\d{4,}/.test(el.id);

  function pathSelector(el) {
    const parts = [];
    for (let cur = el; cur && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) {
      if (cur !== el && stableId(cur)) { parts.unshift("#" + CSS.escape(cur.id)); return parts.join(" > "); }
      parts.unshift(sig(cur));
    }
    return "body > " + parts.join(" > ");
  }

  // 부모 안에서 같은 모양의 형제가 몇 개인지 = 반복 단위일 가능성
  function repeatCount(el) {
    const p = el.parentElement; if (!p) return 1;
    const s = sig(el);
    return [...p.children].filter((c) => c.matches(s)).length;
  }

  function buildChain(el) {
    const chain = [];
    for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) {
      if (cur.tagName === "TD" || cur.tagName === "TH") continue; // 표는 행(tr) 단위로
      chain.push({ el: cur, k: repeatCount(cur) });
    }
    return chain;
  }

  function bestLevel(chain) {
    let best = 0, bestK = 1;
    chain.forEach((c, i) => { if (c.k >= 2 && c.k >= bestK) { best = i; bestK = c.k; } });
    return best;
  }

  function collectRoots(selector) {
    let els;
    try { els = [...document.querySelectorAll(selector)]; } catch { return []; }
    els = els.filter((e) => !e.closest("#__sc_host"));
    return els.filter((e) => !els.some((o) => o !== e && o.contains(e))); // 중첩 제거
  }

  // ---------- 추출 ----------
  // 상태 클래스(active/selected 등)는 레코드마다 달라지므로 키에서 제외
  const STATE = /^(is-|has-)|^(active|on|off|selected|current|hover|focus|open|opened|show|hide|hidden|visible|new|hot|first|last|odd|even|disabled|checked)$/i;
  function relSig(el) {
    return el.tagName.toLowerCase() + stableClasses(el).filter((c) => !STATE.test(c)).slice(0, 2).map((c) => "." + c).join("");
  }

  function extractRaw(root) {
    const out = {}, seen = {};
    const put = (k, v) => {
      v = (v || "").replace(/\s+/g, " ").trim();
      if (!v) return;
      seen[k] = (seen[k] || 0) + 1;
      out[seen[k] > 1 ? `${k} #${seen[k]}` : k] = v;
    };
    const walk = (el, path) => {
      if (SKIP.has(el.tagName)) return;
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ");
      put(path, own);
      if (el.tagName === "A" && el.href && !el.href.startsWith("javascript:")) put(path + "@href", el.href);
      if (el.tagName === "IMG") put(path + "@src", el.currentSrc || el.src || el.dataset.src || el.dataset.original);
      if (el.tagName === "IMG" && el.alt) put(path + "@alt", el.alt);
      for (const c of el.children) walk(c, path + ">" + relSig(c));
    };
    walk(root, "$"); // 루트는 항상 '$' → 레코드마다 키가 같아짐
    out._text = (root.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1000);
    return out;
  }

  function computeKeys(raws) {
    const freq = {};
    raws.forEach((r) => Object.keys(r).forEach((k) => { if (k !== "_text") freq[k] = (freq[k] || 0) + 1; }));
    const min = Math.max(1, Math.ceil(raws.length * 0.2));
    return Object.keys(freq).filter((k) => freq[k] >= min);
  }

  function shortName(key, used) {
    const [seg, attr] = key.split(">").pop().split("@");
    const parts = seg.split(".");                       // "a.title" → ["a","title"]
    let base = (parts.length > 1 ? parts.slice(1).join("_") : parts[0]) + (attr ? "_" + attr : "");
    let name = base, i = 2;
    while (used.has(name)) name = `${base}_${i++}`;
    used.add(name);
    return name;
  }

  function toAbs(v) { try { return new URL(v, location.href).href; } catch { return v; } }

  function buildRows() {
    if (S.plan) {
      S.rows = S.raws.map((r) => {
        const o = {};
        for (const f of S.plan.fields) {
          let v = f.source_keys.map((k) => r[k]).filter(Boolean).join(" ").trim();
          if (f.type === "number" && /^[\d,.\s+\-원$₩%]+$/.test(v) && /\d/.test(v)) v = Number(v.replace(/[^\d.\-]/g, ""));
          if (f.type === "url" && v) v = toAbs(v);
          o[f.name] = v;
        }
        return o;
      });
    } else {
      const used = new Set();
      const headers = tableHeaders();
      const names = S.keys.map((k, i) => {
        const m = headers && k.match(/^\$>t[dh](?: #(\d+))?$/);
        if (m && headers[(+m[1] || 1) - 1]) { const h = headers[(+m[1] || 1) - 1]; used.add(h); return [k, h]; }
        return [k, shortName(k, used)];
      });
      S.rows = S.raws.map((r) => Object.fromEntries(names.map(([k, n]) => [n, r[k] || ""])));
    }
  }

  // 표(tr) 레코드면 머리글(th) 텍스트를 열 이름으로 사용
  function tableHeaders() {
    const tr = S.roots[0];
    if (!tr || tr.tagName !== "TR") return null;
    const table = tr.closest("table");
    const hr = table?.querySelector("thead tr") || [...(table?.rows || [])].find((r) => r.querySelector("th") && !r.querySelector("td"));
    return hr ? [...hr.cells].map((c) => c.innerText.trim()).map((t, i) => t || `열${i + 1}`) : null;
  }

  function scan() {
    const roots = collectRoots(S.selector);
    const raws = roots.map(extractRaw);
    const keys = computeKeys(raws);
    // 수집 키에 값이 하나도 없는 레코드(표 머리글 행, 빈 자리표시 등) 제외
    const keep = raws.map((r) => keys.some((k) => r[k]));
    S.roots = roots.filter((_, i) => keep[i]);
    S.raws = raws.filter((_, i) => keep[i]);
    S.keys = computeKeys(S.raws);
    document.querySelectorAll("[data-sc-record]").forEach((e) => e.removeAttribute("data-sc-record"));
    S.roots.forEach((e) => e.setAttribute("data-sc-record", ""));
    buildRows();
    render();
  }

  function applyLevel() {
    const rec = S.chain[S.level].el;
    S.selector = pathSelector(rec);
    S.plan = null; S.source = "규칙 기반";
    scan();
  }

  // ---------- 선택 모드 ----------
  const inPanel = (e) => e.composedPath().some((n) => n.id === "__sc_host");
  function onOver(e) {
    if (inPanel(e)) return;
    S.hoverEl?.removeAttribute("data-sc-hover");
    S.hoverEl = e.target; S.hoverEl.setAttribute("data-sc-hover", "");
  }
  function onClick(e) {
    if (inPanel(e)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    stopPicker();
    S.picked?.removeAttribute("data-sc-picked");
    S.picked = e.target; S.picked.setAttribute("data-sc-picked", "");
    S.chain = buildChain(e.target);
    if (!S.chain.length) { setStatus("선택한 요소를 분석할 수 없습니다. 다른 요소를 클릭하세요."); return; }
    S.level = bestLevel(S.chain);
    statusMsg = "";
    applyLevel();
  }
  function onKey(e) { if (e.key === "Escape") { stopPicker(); setStatus("선택을 취소했습니다."); } }

  function startPicker() {
    ensurePanel();
    if (S.picking) return;
    S.picking = true;
    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    setStatus("수집할 항목 하나를 클릭하세요. (Esc: 취소)");
  }
  function stopPicker() {
    S.picking = false;
    document.removeEventListener("mouseover", onOver, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    S.hoverEl?.removeAttribute("data-sc-hover");
  }

  // ---------- AI ----------
  function aiPayload(lockSelector) {
    const keys = S.keys.slice(0, 120);
    const samples = S.raws.slice(0, 6).map((r) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => keys.includes(k) || k === "_text").map(([k, v]) => [k, String(v).slice(0, 150)])));
    const clean = (el) => {
      const c = el.cloneNode(true);
      c.querySelectorAll("script,style,svg,noscript").forEach((n) => n.remove());
      c.querySelectorAll("*").forEach((n) => n.removeAttribute("style"));
      return c.outerHTML.replace(/\s+/g, " ");
    };
    const parent = S.roots[0]?.parentElement;
    const html = S.roots.slice(0, 2).map(clean).join("\n").slice(0, 6000) +
      (parent ? `\n\n[레코드의 부모: ${pathSelector(parent)}]` : "");
    return { url: location.href, title: document.title, hint: S.hint || "", selector: S.selector,
      count: S.roots.length, keys, samples, html, lockSelector };
  }

  const askAI = (payload) => new Promise((resolve, reject) => {
    if (!chrome?.runtime?.sendMessage) return reject(new Error("확장 프로그램 환경이 아닙니다."));
    chrome.runtime.sendMessage({ type: "ai", payload }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      res?.ok ? resolve(res.plan) : reject(new Error(res?.error || "AI 호출 실패"));
    });
  });

  function validPlan(plan) {
    const ks = new Set(S.keys.concat(Object.keys(S.raws[0] || {})));
    plan.fields = plan.fields.map((f) => ({ ...f, source_keys: f.source_keys.filter((k) => ks.has(k)) }))
      .filter((f) => f.source_keys.length);
    return plan.fields.length ? plan : null;
  }

  async function runAI() {
    if (S.busy || !S.roots.length) return;
    S.busy = true; render();
    try {
      setStatus("AI가 구조를 분석하는 중…");
      let plan = await askAI(aiPayload(false));
      const sel = (plan.record_selector || "").trim();
      if (sel && sel !== S.selector) {
        const r = collectRoots(sel);
        if (r.length >= 2) {
          S.selector = sel; S.plan = null; scan();
          setStatus(`AI가 레코드 영역을 보정했습니다 (${r.length}개). 필드 정리 중…`);
          plan = await askAI(aiPayload(true));
        }
      }
      S.plan = validPlan(plan);
      S.source = S.plan ? "AI 정리" : "규칙 기반 (AI 결과가 비어 기본값 사용)";
      buildRows();
      setStatus("");
    } catch (e) {
      setStatus("⚠ " + e.message);
    } finally { S.busy = false; render(); }
  }

  // ---------- 내보내기 ----------
  function downloadJSON() {
    const now = new Date();
    const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const data = {
      url: location.href, title: document.title, extracted_at: now.toISOString(),
      record_selector: S.selector, mode: S.source, count: S.rows.length,
      fields: S.plan ? S.plan.fields : S.rows[0] ? Object.keys(S.rows[0]) : [],
      records: S.rows
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `crawl_${location.hostname}_${stamp}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- 패널 UI (Shadow DOM: 페이지 CSS 영향 차단) ----------
  let host, $root, statusMsg = "";
  function ensurePanel() {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement("div");
    host.id = "__sc_host";
    host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    $root = host.attachShadow({ mode: "open" });
    document.documentElement.appendChild(host);
    render();
  }
  function setStatus(m) { statusMsg = m; render(); }
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function render() {
    if (!$root) return;
    const cols = S.rows[0] ? Object.keys(S.rows[0]) : [];
    const preview = S.rows.slice(0, 5);
    const lvl = S.chain.length ? `${S.level + 1}/${S.chain.length}` : "-";
    $root.innerHTML = `
<style>
  .p{font:12px/1.45 system-ui,"Malgun Gothic",sans-serif;color:#111;background:#fff;width:440px;max-height:70vh;display:flex;flex-direction:column;border:1px solid #d0d7de;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);overflow:hidden}
  .h{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#2563eb;color:#fff;font-weight:700}
  .h button{background:transparent;color:#fff;border:0;font-size:16px;cursor:pointer}
  .b{padding:10px 12px;display:flex;flex-direction:column;gap:8px;overflow:auto}
  .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  button.x{border:1px solid #d0d7de;background:#f6f8fa;border-radius:6px;padding:5px 9px;cursor:pointer;font:inherit}
  button.x.pri{background:#2563eb;color:#fff;border-color:#2563eb}
  button.x:disabled{opacity:.5;cursor:default}
  input{flex:1;min-width:0;padding:5px 7px;border:1px solid #d0d7de;border-radius:6px;font:inherit}
  .sel{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#57606a;word-break:break-all;background:#f6f8fa;padding:4px 6px;border-radius:4px}
  .st{color:#b45309;min-height:0}
  .tw{overflow:auto;border:1px solid #eaeef2;border-radius:6px;max-height:220px}
  table{border-collapse:collapse;font-size:11px;white-space:nowrap}
  th,td{border-bottom:1px solid #eaeef2;padding:4px 6px;text-align:left;max-width:180px;overflow:hidden;text-overflow:ellipsis}
  th{background:#f6f8fa;position:sticky;top:0}
  .muted{color:#6b7280}
</style>
<div class="p">
  <div class="h"><span>🕸️ 스마트 크롤러</span><button id="close" title="닫기">✕</button></div>
  <div class="b">
    <div><b>${S.roots.length}</b>개 레코드 · 필드 <b>${cols.length}</b>개 <span class="muted">(${esc(S.source)})</span></div>
    ${S.selector ? `<div class="sel">${esc(S.selector)}</div>` : ""}
    <div class="row">
      <span class="muted">범위 ${lvl}</span>
      <button class="x" id="down" ${S.level <= 0 ? "disabled" : ""} title="더 작은 단위">◀ 좁게</button>
      <button class="x" id="up" ${S.level >= S.chain.length - 1 ? "disabled" : ""} title="더 큰 단위">넓게 ▶</button>
      <button class="x" id="rescan" ${S.selector ? "" : "disabled"} title="스크롤로 더 불러온 뒤 다시 수집">다시 스캔</button>
      <button class="x" id="repick">다시 선택</button>
    </div>
    <div class="row">
      <input id="hint" placeholder="원하는 필드(선택) 예: 회사명, 급여, 지역, 링크" value="${esc(S.hint || "")}">
      <button class="x pri" id="ai" ${S.roots.length && !S.busy ? "" : "disabled"}>${S.busy ? "분석 중…" : "AI 정리"}</button>
    </div>
    ${statusMsg ? `<div class="st">${esc(statusMsg)}</div>` : ""}
    ${preview.length ? `<div class="tw"><table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
      <tbody>${preview.map((r) => `<tr>${cols.map((c) => `<td title="${esc(r[c])}">${esc(r[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      <div class="muted">미리보기: 앞 ${preview.length}개</div>` : ""}
    <div class="row"><button class="x pri" id="dl" ${S.rows.length ? "" : "disabled"}>JSON 다운로드</button></div>
  </div>
</div>`;
    const on = (id, fn) => $root.getElementById(id)?.addEventListener("click", fn);
    on("close", destroy);
    on("down", () => { S.level--; applyLevel(); });
    on("up", () => { S.level++; applyLevel(); });
    on("rescan", () => { scan(); });
    on("repick", () => startPicker());
    on("ai", runAI);
    on("dl", downloadJSON);
    $root.getElementById("hint")?.addEventListener("input", (e) => { S.hint = e.target.value; });
  }

  function destroy() {
    stopPicker();
    document.querySelectorAll("[data-sc-record],[data-sc-picked],[data-sc-hover]").forEach((e) => {
      e.removeAttribute("data-sc-record"); e.removeAttribute("data-sc-picked"); e.removeAttribute("data-sc-hover");
    });
    host?.remove(); host = null; $root = null;
    delete window.__smartCrawler;
  }

  window.__smartCrawler = { startPicker, _state: S };
  startPicker();
})();
