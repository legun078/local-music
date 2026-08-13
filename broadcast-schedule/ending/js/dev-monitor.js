(() => {
  const TOKEN_KEY = "ending_soop_access_token";
  const TAB_KEY = "ending_dev_monitor_tab";
  const base = () => window.CREDITS_BASE || "";
  const POLL_MS = 5000;

  const els = {
    gate: document.getElementById("dev-gate"),
    gateMsg: document.getElementById("dev-gate-msg"),
    app: document.getElementById("dev-app"),
    stamp: document.getElementById("dev-stamp"),
    auto: document.getElementById("dev-auto"),
    refresh: document.getElementById("btn-dev-refresh"),
    strip: document.getElementById("dev-strip"),
    tabSirian: document.getElementById("tab-sirian"),
    tabMe: document.getElementById("tab-me"),
    tabSirianId: document.getElementById("tab-sirian-id"),
    tabMeId: document.getElementById("tab-me-id"),
    tabSirianDot: document.getElementById("tab-sirian-dot"),
    tabMeDot: document.getElementById("tab-me-dot"),
    panel: document.getElementById("panel-account"),
    label: document.getElementById("acc-label"),
    title: document.getElementById("acc-title"),
    badge: document.getElementById("acc-badge"),
    broadcast: document.getElementById("acc-broadcast"),
    meta: document.getElementById("acc-meta"),
    note: document.getElementById("acc-note"),
    viewmode: document.getElementById("acc-viewmode"),
    viewLive: document.getElementById("view-live"),
    viewHistory: document.getElementById("view-history"),
    history: document.getElementById("acc-history"),
    historyDate: document.getElementById("acc-history-date"),
    historyList: document.getElementById("acc-history-list"),
    flags: document.getElementById("acc-flags"),
    stats: document.getElementById("acc-stats"),
    peak: document.getElementById("acc-peak"),
    peakImg: document.getElementById("acc-peak-img"),
    peakCap: document.getElementById("acc-peak-cap"),
    dataNav: document.getElementById("acc-data-nav"),
    dataBody: document.getElementById("acc-data-body"),
    dataHint: document.getElementById("acc-data-hint"),
    segments: document.getElementById("acc-segments"),
    collectorsHint: document.getElementById("collectors-hint"),
    collectorsBody: document.getElementById("collectors-body"),
  };

  const DATA_TAB_KEY = "ending_dev_monitor_data_tab";
  const DATA_LIMIT_KEY = "ending_dev_monitor_data_limit";
  const METRICS_CHART_MODE_KEY = "ending_dev_monitor_metrics_chart_mode";
  const VIEW_KEY = "ending_dev_monitor_view";
  const METRICS_CHART_MODES = [
    { value: "both", label: "겹침" },
    { value: "viewers", label: "시청자" },
    { value: "chat", label: "화력" },
  ];
  const DATA_LIMITS = [
    { value: 10, label: "10" },
    { value: 50, label: "50" },
    { value: 100, label: "100" },
    { value: 0, label: "전체" },
  ];
  let timer = null;
  let busy = false;
  let lastData = null;
  let activeTab = "sirian";
  let dataTabId = "";
  let dataLimit = 10;
  let metricsChartMode = "both";
  let dataCatsCache = [];
  let viewMode = "live"; // live | history
  let historyDate = "";
  let historyArchiveId = "";
  let historyPayload = null;
  let historyListCache = [];
  let historyBusy = false;

  try {
    const saved = String(sessionStorage.getItem(TAB_KEY) || "").trim();
    if (saved === "me" || saved === "sirian") activeTab = saved;
  } catch (_) {
    /* ignore */
  }
  try {
    dataTabId = String(sessionStorage.getItem(DATA_TAB_KEY) || "").trim();
    if (dataTabId === "viewersChart") {
      dataTabId = "metricsChart";
      metricsChartMode = "viewers";
    } else if (dataTabId === "chatChart") {
      dataTabId = "metricsChart";
      metricsChartMode = "chat";
    }
  } catch (_) {
    /* ignore */
  }
  try {
    const modeRaw = String(sessionStorage.getItem(METRICS_CHART_MODE_KEY) || "").trim();
    if (modeRaw === "both" || modeRaw === "viewers" || modeRaw === "chat") {
      metricsChartMode = modeRaw;
    }
  } catch (_) {
    /* ignore */
  }
  try {
    const limRaw = sessionStorage.getItem(DATA_LIMIT_KEY);
    if (limRaw != null && limRaw !== "") {
      const n = Number(limRaw);
      if (n === 0 || n === 10 || n === 50 || n === 100) dataLimit = n;
    }
  } catch (_) {
    /* ignore */
  }
  try {
    const v = String(sessionStorage.getItem(VIEW_KEY) || "").trim();
    if (v === "history" || v === "live") viewMode = v;
  } catch (_) {
    /* ignore */
  }

  function authHeaders() {
    const headers = {};
    const token = String(localStorage.getItem(TOKEN_KEY) || "").trim();
    if (token) headers["X-Soop-Access-Token"] = token;
    return headers;
  }

  function apiUrl(path) {
    const p = String(path || "");
    return `${base()}${p.startsWith("/") ? p : `/${p}`}`;
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtTime(raw) {
    const s = String(raw || "").trim();
    if (!s) return "—";
    const d = new Date(s.endsWith("Z") || s.includes("+") ? s : `${s}Z`);
    if (Number.isNaN(d.getTime())) return s;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(
      d.getSeconds()
    )}`;
  }

  function fmtNum(n) {
    const v = Number(n) || 0;
    return v.toLocaleString("ko-KR");
  }

  function fmtAge(sec) {
    if (sec == null || sec === "" || Number.isNaN(Number(sec))) return "";
    const n = Math.max(0, Math.floor(Number(sec)));
    if (n < 60) return `${n}초 전`;
    if (n < 3600) return `${Math.floor(n / 60)}분 전`;
    return `${Math.floor(n / 3600)}시간 전`;
  }

  async function fetchJson(path, opts) {
    const res = await fetch(apiUrl(path), {
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(opts?.headers || {}) },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function pill(label, on, kind) {
    const extra = kind ? ` ${kind}` : "";
    return `<span class="ending-dev-pill ${on ? "is-on" : ""}${extra}"><span class="dot" aria-hidden="true"></span>${esc(
      label
    )}</span>`;
  }

  function ingestLabel(live) {
    const src = String(live?.lastIngestSource || live?.ingest?.lastSource || "").trim();
    if (src === "obs") return "OBS";
    if (src === "collector") return "수집기";
    return src || "";
  }

  function ingestStatusText(live) {
    const at = live?.lastIngestAt || live?.ingest?.lastOkAt || "";
    if (!at) return "기록 없음";
    const age = fmtAge(live?.lastIngestAgeSec ?? live?.ingest?.lastOkAgeSec);
    const src = ingestLabel(live);
    return `${fmtTime(at)}${age ? ` (${age})` : ""}${src ? ` · ${src}` : ""}`;
  }

  function setBadge(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.className = "ending-dev-badge";
    if (kind) el.classList.add(kind);
  }

  function renderStats(el, rows) {
    if (!el) return;
    el.innerHTML = rows
      .map(
        ([label, value]) =>
          `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`
      )
      .join("");
  }

  function mediaUrl(path) {
    const raw = String(path || "").trim();
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw) || raw.startsWith("data:")) return raw;
    if (raw.startsWith("/")) return apiUrl(raw);
    return apiUrl(`/${raw}`);
  }

  function renderPeakThumb(acc) {
    if (!els.peak || !els.peakImg) return;
    const info = acc.info || {};
    const sess = acc.session || {};
    const peakN = Number(info.peakViewers || sess.peakViewers || 0) || 0;
    let thumb = String(info.peakThumbUrl || sess.peakThumbUrl || "").trim();
    if (!thumb && acc.archiveId) {
      thumb = `/api/credits/archive-peak-thumb?archiveId=${encodeURIComponent(acc.archiveId)}`;
    }
    if (!thumb && peakN > 0 && viewMode === "live" && acc.kind !== "me") {
      // 시리안 라이브: 로컬 캐시 엔드포인트 시도
      thumb = "/api/credits/peak-thumb";
    }
    const src = mediaUrl(thumb);
    const when =
      String(info.peakAtLabel || sess.peakAtLabel || "").trim() ||
      (sess.peakViewersAt || info.peakViewersAt ? fmtTime(sess.peakViewersAt || info.peakViewersAt) : "");
    if (!src || peakN <= 0) {
      els.peak.hidden = true;
      els.peakImg.removeAttribute("src");
      if (els.peakCap) els.peakCap.textContent = "";
      return;
    }
    els.peak.hidden = false;
    if (els.peakImg.getAttribute("src") !== src) {
      els.peakImg.src = src;
    }
    els.peakImg.alt = `최고 시청 ${peakN.toLocaleString("ko-KR")}명 순간`;
    if (els.peakCap) {
      els.peakCap.textContent = when
        ? `최고 시청 ${peakN.toLocaleString("ko-KR")}명 · ${when}`
        : `최고 시청 ${peakN.toLocaleString("ko-KR")}명`;
    }
  }

  function renderFlags(el, live) {
    if (!el) return;
    const obsPhase = live?.clients?.obs?.phase || "";
    const tabPhase = live?.clients?.collector?.phase || "";
    const ingestOn = Boolean(live?.ingestActive);
    const ingestSrc = ingestLabel(live);
    const authFail = Boolean(live?.ingestAuthFailRecent);
    el.innerHTML = [
      pill("실제 수집", ingestOn, authFail && !ingestOn ? "is-warn" : ""),
      pill("세션", Boolean(live?.active)),
      pill("Chat SDK", Boolean(live?.chatSdkConnected)),
      pill("수집 구간", Boolean(live?.collectorOpen)),
      pill(
        obsPhase ? `OBS · ${obsPhase}` : "OBS 브라우저",
        false,
        live?.obsBrowserActive ? "is-present" : ""
      ),
      pill(
        tabPhase ? `수집기 · ${tabPhase}` : "수집기 탭",
        false,
        live?.collectorTabActive ? "is-present" : ""
      ),
      authFail && !ingestOn
        ? pill(ingestSrc ? `인증 실패 · ${ingestSrc}` : "인증 실패", false, "is-warn")
        : "",
    ]
      .filter(Boolean)
      .join("");
  }

  function renderSegments(el, segs) {
    if (!el) return;
    const rows = Array.isArray(segs) ? segs.slice(-5).reverse() : [];
    if (!rows.length) {
      el.innerHTML = `<p class="ending-dev-empty">수집 구간 기록 없음</p>`;
      return;
    }
    el.innerHTML = `
      <p class="ending-dev-sec-title">최근 수집 구간</p>
      <ul class="ending-dev-seg-list">
        ${rows
          .map((s) => {
            const open = !s?.endedAt;
            return `<li class="${open ? "is-open" : ""}">${esc(fmtTime(s.startedAt))}${
              open ? "" : ` → ${esc(fmtTime(s.endedAt))}`
            }</li>`;
          })
          .join("")}
      </ul>`;
  }

  function setPanelStatus(acc) {
    if (!els.panel) return;
    const sess = acc.session || {};
    const modes = ["is-live", "is-ended", "is-warn", "is-archive", "is-idle"];
    els.panel.classList.remove(...modes);
    if (acc.source === "archive" || viewMode === "history") {
      els.panel.classList.add("is-archive");
    } else if (sess.ingestActive) {
      els.panel.classList.add("is-live");
    } else if (sess.ingestAuthFailRecent) {
      els.panel.classList.add("is-warn");
    } else if (sess.lastIngestAt || sess.collectorOpen || sess.active) {
      els.panel.classList.add("is-ended");
    } else {
      els.panel.classList.add("is-idle");
    }
  }

  function normalizeItems(rows, valueKey) {
    const list = Array.isArray(rows) ? rows : [];
    return list.map((row, i) => {
      const rank = row.rank || i + 1;
      const name = row.name || row.id || "—";
      let val = valueKey ? row[valueKey] : null;
      if (val == null) val = row.value ?? row.count ?? row.total ?? "";
      let display;
      if (typeof val === "number") {
        if (valueKey === "count") display = `${fmtNum(val)}회`;
        else if (valueKey === "total") display = `${fmtNum(val)}개`;
        else display = fmtNum(val);
      } else {
        display = String(val || "—");
      }
      return {
        rank,
        name,
        value: display,
        imageUrl: String(row.imageUrl || "").trim(),
      };
    });
  }

  function seriesPoints(series) {
    if (!Array.isArray(series)) return [];
    return series
      .filter((p) => p && p.at != null && Number.isFinite(Number(p.v)))
      .map((p) => ({ at: String(p.at), v: Number(p.v) }));
  }

  function mergeMetricsTimeline(viewerPoints, chatPoints) {
    const map = new Map();
    const touch = (at, key, v) => {
      const row = map.get(at) || { at, viewers: null, chats: null };
      row[key] = v;
      map.set(at, row);
    };
    for (const p of viewerPoints || []) touch(p.at, "viewers", p.v);
    for (const p of chatPoints || []) touch(p.at, "chats", p.v);
    return [...map.values()].sort((a, b) => a.at.localeCompare(b.at));
  }

  function metricsTabCountLabel(viewerN, chatN) {
    const v = Number(viewerN) || 0;
    const c = Number(chatN) || 0;
    if (v > 0 && c > 0) return `${v}·${c}`;
    if (v > 0) return String(v);
    if (c > 0) return String(c);
    return "대기";
  }

  const CHART_W = 680;
  const CHART_H = 176;
  const CHART_HEADROOM = 0.12;
  const CHART_X_INSET = 6;
  const CHART_Y_INSET = 5;
  const CHART_PAD_SINGLE = { t: 18, r: 40, b: 30, l: 48 };
  const CHART_PAD_DUAL = { t: 18, r: 58, b: 30, l: 48 };

  function chartScaleMax(peak) {
    const p = Math.max(0, Number(peak) || 0);
    if (p <= 0) return 1;
    return Math.max(1, Math.ceil(p * (1 + CHART_HEADROOM)));
  }

  function chartAxisLayout(count, pad, w, h, maxV, opts = {}) {
    const xInset = opts.xInset ?? CHART_X_INSET;
    const yInset = opts.yInset ?? CHART_Y_INSET;
    const innerW = w - pad.l - pad.r;
    const innerH = h - pad.t - pad.b;
    const xSpan = Math.max(0, innerW - xInset * 2);
    const ySpan = Math.max(0, innerH - yInset * 2);
    const xAt = (i) =>
      count <= 1 ? pad.l + xInset + xSpan / 2 : pad.l + xInset + (i / (count - 1)) * xSpan;
    const yAt = (v) => pad.t + yInset + ySpan - (v / maxV) * ySpan;
    return { innerW, innerH, xSpan, ySpan, xAt, yAt, xInset, yInset };
  }

  function chartTimeRangeFromPoints(...lists) {
    let minMs = Infinity;
    let maxMs = -Infinity;
    for (const list of lists) {
      for (const p of list || []) {
        const ms = parseChartDate(p?.at)?.getTime();
        if (!ms) continue;
        minMs = Math.min(minMs, ms);
        maxMs = Math.max(maxMs, ms);
      }
    }
    if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return null;
    if (maxMs <= minMs) maxMs = minMs + 60_000;
    return { minMs, maxMs };
  }

  function chartDualTimeLayout(pad, w, h, minMs, maxMs, maxViewers, maxChats) {
    const xInset = CHART_X_INSET;
    const yInset = CHART_Y_INSET;
    const innerW = w - pad.l - pad.r;
    const innerH = h - pad.t - pad.b;
    const xSpan = Math.max(0, innerW - xInset * 2);
    const ySpan = Math.max(0, innerH - yInset * 2);
    const spanMs = Math.max(1, maxMs - minMs);
    const xAtTime = (at) => {
      const ms = parseChartDate(at)?.getTime();
      if (!ms) return pad.l + xInset;
      const t = Math.max(0, Math.min(1, (ms - minMs) / spanMs));
      return pad.l + xInset + t * xSpan;
    };
    const yViewers = (v) => pad.t + yInset + ySpan - (v / maxViewers) * ySpan;
    const yChats = (v) => pad.t + yInset + ySpan - (v / maxChats) * ySpan;
    return { innerW, innerH, xAtTime, yViewers, yChats };
  }

  /** 분 단위 실측값은 호버/마커에서만 쓰고, 선은 부드럽게 잇는다. */
  function pathSmoothFromXY(pts) {
    const list = Array.isArray(pts) ? pts : [];
    if (!list.length) return "";
    const fmt = (n) => Number(n).toFixed(1);
    if (list.length === 1) return `M${fmt(list[0].x)},${fmt(list[0].y)}`;
    if (list.length === 2) {
      return `M${fmt(list[0].x)},${fmt(list[0].y)} L${fmt(list[1].x)},${fmt(list[1].y)}`;
    }
    // Catmull-Rom → cubic Bézier (선만 부드럽게, 꼭짓점은 실측 좌표 유지)
    let d = `M${fmt(list[0].x)},${fmt(list[0].y)}`;
    for (let i = 0; i < list.length - 1; i++) {
      const p0 = list[Math.max(0, i - 1)];
      const p1 = list[i];
      const p2 = list[i + 1];
      const p3 = list[Math.min(list.length - 1, i + 2)];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C${fmt(cp1x)},${fmt(cp1y)} ${fmt(cp2x)},${fmt(cp2y)} ${fmt(p2.x)},${fmt(p2.y)}`;
    }
    return d;
  }

  function pathForSeriesPointsSmooth(points, xAt, yAt) {
    const list = Array.isArray(points) ? points : [];
    if (!list.length) return "";
    const pts = list.map((p) => ({
      x: Number(xAt(p.at)),
      y: Number(yAt(p.v)),
    }));
    return pathSmoothFromXY(pts);
  }

  function chartClockLabel(at) {
    const d = new Date(String(at).endsWith("Z") || String(at).includes("+") ? at : `${at}Z`);
    if (Number.isNaN(d.getTime())) return String(at || "");
    return d.toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Seoul",
    });
  }

  function renderFirstChatPanel(firstChat) {
    const fc = firstChat && typeof firstChat === "object" ? firstChat : null;
    if (!fc || !String(fc.name || "").trim()) {
      return `<p class="ending-dev-empty ending-dev-data-empty">아직 첫 채팅이 기록되지 않았습니다.</p>`;
    }
    const img = String(fc.imageUrl || "").trim();
    const msg = String(fc.message || fc.emoticonName || "").trim();
    const body = img
      ? `<img class="ending-dev-first-chat__emo" src="${esc(mediaUrl(img))}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
      : msg
        ? `<p class="ending-dev-first-chat__msg">“${esc(msg)}”</p>`
        : "";
    const at = String(fc.atLabel || "").trim();
    return `<div class="ending-dev-first-chat">
      <p class="ending-dev-first-chat__name">${esc(fc.name)}</p>
      ${body}
      ${at ? `<p class="ending-dev-first-chat__at">${esc(at)}</p>` : ""}
    </div>`;
  }

  function parseChartDate(at) {
    const raw = String(at || "").trim();
    if (!raw) return null;
    const d = new Date(raw.endsWith("Z") || raw.includes("+") ? raw : `${raw}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function chartClientXToSvgX(svg, clientX, w) {
    const rect = svg?.getBoundingClientRect?.();
    if (!rect?.width) return 0;
    return ((clientX - rect.left) / rect.width) * w;
  }

  function showChartCursorLine(el, x, y1, y2) {
    if (!el) return;
    el.removeAttribute("hidden");
    el.setAttribute("x1", String(x));
    el.setAttribute("x2", String(x));
    el.setAttribute("y1", String(y1));
    el.setAttribute("y2", String(y2));
  }

  function hideChartCursorLine(el) {
    if (!el) return;
    el.setAttribute("hidden", "");
  }

  function chartTipIdleHtml() {
    return `<span class="ending-dev-chart__tip-idle">마우스를 올리면 시점 · 수치가 표시됩니다</span>`;
  }

  function chartTipEl(wrap) {
    return wrap?.closest?.(".ending-dev-chart")?.querySelector?.("[data-chart-tip]") || null;
  }

  function chartXToTimeMs(chartX, pad, w, minMs, maxMs) {
    const xInset = CHART_X_INSET;
    const innerW = w - pad.l - pad.r;
    const xSpan = Math.max(0, innerW - xInset * 2);
    const spanMs = Math.max(1, maxMs - minMs);
    const t = xSpan <= 0 ? 0 : (chartX - pad.l - xInset) / xSpan;
    const clamped = Math.max(0, Math.min(1, t));
    return minMs + clamped * spanMs;
  }

  function nearestMergedPointAtTime(merged, atMs) {
    const t = Number(atMs);
    if (!Number.isFinite(t)) return null;
    const list = (Array.isArray(merged) ? merged : [])
      .map((row) => ({ ...row, ms: parseChartDate(row.at)?.getTime() }))
      .filter((row) => row.ms != null);
    if (!list.length) return null;
    let best = list[0];
    let bestDist = Math.abs(list[0].ms - t);
    for (let i = 1; i < list.length; i++) {
      const d = Math.abs(list[i].ms - t);
      if (d < bestDist) {
        bestDist = d;
        best = list[i];
      }
    }
    return best;
  }

  function nearestSeriesPointAtChartX(points, chartX, xAt) {
    const list = Array.isArray(points) ? points : [];
    const n = list.length;
    if (!n) return null;
    let bestI = 0;
    let bestDist = Math.abs(xAt(0) - chartX);
    for (let i = 1; i < n; i++) {
      const d = Math.abs(xAt(i) - chartX);
      if (d < bestDist) {
        bestDist = d;
        bestI = i;
      }
    }
    const p = list[bestI];
    return { at: p.at, v: p.v, chartX: xAt(bestI), index: bestI };
  }

  function chartFullLabel(at) {
    const d = parseChartDate(at);
    if (!d) return String(at || "");
    return d.toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Seoul",
    });
  }

  function formatOffsetSec(sec) {
    const n = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = n % 60;
    if (h > 0) return `${h}시간 ${m}분 ${s}초`;
    if (m > 0) return `${m}분 ${s}초`;
    return `${s}초`;
  }

  function replayLinksForPoint(replay, pointAt) {
    const ctx = replay && typeof replay === "object" ? replay : null;
    const sid = String(ctx?.stationId || "").trim();
    const broadNo = String(ctx?.broadNo || "").trim();
    const vodTitleNo = String(ctx?.vodTitleNo || "").trim();
    const startedAt = String(ctx?.startedAt || "").trim();
    const at = String(pointAt || "").trim();
    if (!sid || !startedAt || !at) return null;
    const startMs = parseChartDate(startedAt)?.getTime();
    const atMs = parseChartDate(at)?.getTime();
    if (!startMs || !atMs) return null;
    const offsetSec = Math.max(0, Math.floor((atMs - startMs) / 1000));
    const offsetLabel = formatOffsetSec(offsetSec);
    if (ctx.active && broadNo) {
      return {
        offsetSec,
        offsetLabel,
        primaryUrl: `https://play.sooplive.co.kr/${encodeURIComponent(sid)}/${encodeURIComponent(broadNo)}`,
        note: "라이브 중 — 다시보기 구간 이동은 방종 후 가능합니다",
        canSeek: false,
      };
    }
    if (vodTitleNo) {
      const enc = encodeURIComponent(vodTitleNo);
      const qs = `change_second=${offsetSec}`;
      return {
        offsetSec,
        offsetLabel,
        primaryUrl: `https://vod.sooplive.com/player/${enc}?${qs}`,
        fallbackUrl: `https://vod.sooplive.co.kr/player/${enc}?${qs}`,
        note: "다시보기 플레이어에서 해당 시점으로 이동합니다",
        canSeek: true,
      };
    }
    if (sid) {
      return {
        offsetSec,
        offsetLabel,
        primaryUrl: `https://www.sooplive.co.kr/station/${encodeURIComponent(sid)}/vods/replay`,
        note: broadNo
          ? "다시보기 VOD 처리 중이면 채널 VOD 목록에서 찾아주세요"
          : "방송 번호가 없어 채널 VOD 목록으로 이동합니다",
        canSeek: false,
      };
    }
    return null;
  }

  function chartReplayNodes(wrap) {
    const root = wrap?.closest?.(".ending-dev-chart");
    if (!root) {
      return { replay: null, replayMeta: null, replayLink: null };
    }
    return {
      replay: root.querySelector("[data-chart-replay]"),
      replayMeta: root.querySelector("[data-replay-meta]"),
      replayLink: root.querySelector("[data-replay-link]"),
    };
  }

  function applyChartReplay(wrap, replay, pointAt, summaryText, { openTab = false } = {}) {
    const links = replayLinksForPoint(replay, pointAt);
    if (!links?.primaryUrl) return null;
    const { replay: bar, replayMeta, replayLink } = chartReplayNodes(wrap);
    if (bar && replayMeta && replayLink) {
      bar.hidden = false;
      replayMeta.textContent =
        typeof summaryText === "function" ? summaryText(links) : String(summaryText || "");
      replayLink.href = links.primaryUrl;
      replayLink.textContent = links.canSeek ? "다시보기에서 이 시점 보기" : "SOOP 방송 열기";
    }
    if (openTab) {
      window.open(links.primaryUrl, "_blank", "noopener,noreferrer");
    }
    return links;
  }

  let chartBindToken = 0;

  function bindInteractiveChart(wrap, config) {
    if (!wrap || !config?.points?.length) return;
    const token = ++chartBindToken;
    wrap.dataset.chartToken = String(token);
    const svg = wrap.querySelector("[data-chart-svg]");
    const overlay = wrap.querySelector("[data-chart-overlay]");
    const tip = chartTipEl(wrap);
    const cursor = wrap.querySelector("[data-chart-cursor]");
    const marker = wrap.querySelector("[data-chart-marker]");
    if (!svg || !overlay || !tip) return;

    const points = config.points;
    const w = Number(config.width) || CHART_W;
    const h = Number(config.height) || CHART_H;
    const pad = config.pad || CHART_PAD_SINGLE;
    const maxV = chartScaleMax(Math.max(...points.map((p) => p.v), 0));
    const { innerH, xAt, yAt } = chartAxisLayout(points.length, pad, w, h, maxV);
    const valueFmt =
      typeof config.formatValue === "function"
        ? config.formatValue
        : (v) => `${fmtNum(v)}${config.valueSuffix || ""}`;

    function showAtChartX(chartX) {
      if (String(wrap.dataset.chartToken) !== String(token)) return;
      const hit = nearestSeriesPointAtChartX(points, chartX, xAt);
      if (!hit) return;
      const links = replayLinksForPoint(config.replay, hit.at);
      if (tip) {
        tip.innerHTML = `<strong>${esc(chartFullLabel(hit.at))}</strong><span>${esc(
          valueFmt(hit.v)
        )}</span>${links ? `<span class="ending-dev-chart__tip-sub">시작 + ${esc(links.offsetLabel)}</span>` : ""}`;
      }
      const x = hit.chartX;
      if (cursor) {
        showChartCursorLine(cursor, x, pad.t, pad.t + innerH);
      }
      if (marker) {
        marker.hidden = false;
        marker.setAttribute("cx", String(x));
        marker.setAttribute("cy", String(yAt(hit.v)));
        if (config.lineColor) {
          marker.style.stroke = config.lineColor;
        }
      }
      wrap.dataset.hoverAt = hit.at;
    }

    function hideHover() {
      if (tip) tip.innerHTML = chartTipIdleHtml();
      if (cursor) hideChartCursorLine(cursor);
      if (marker) marker.hidden = true;
      delete wrap.dataset.hoverAt;
    }

    function pinAt(clientX) {
      const hit = nearestSeriesPointAtChartX(points, chartClientXToSvgX(svg, clientX, w), xAt);
      if (!hit) return;
      applyChartReplay(
        wrap,
        config.replay,
        hit.at,
        (links) =>
          `${chartFullLabel(hit.at)} · ${valueFmt(hit.v)} · 시작 + ${links.offsetLabel}${
            links.note ? ` · ${links.note}` : ""
          }`,
        { openTab: true }
      );
    }

    overlay.addEventListener("mousemove", (ev) => {
      showAtChartX(chartClientXToSvgX(svg, ev.clientX, w));
    });
    overlay.addEventListener("mouseleave", hideHover);
    overlay.addEventListener("click", (ev) => {
      pinAt(ev.clientX);
    });
  }

  function bindDualInteractiveChart(wrap, config) {
    const merged = Array.isArray(config?.merged) ? config.merged : [];
    if (!wrap || !merged.length) return;
    const token = ++chartBindToken;
    wrap.dataset.chartToken = String(token);
    const svg = wrap.querySelector("[data-chart-svg]");
    const overlay = wrap.querySelector("[data-chart-overlay]");
    const tip = chartTipEl(wrap);
    const cursor = wrap.querySelector("[data-chart-cursor]");
    const markerViewers = wrap.querySelector("[data-chart-marker-viewers]");
    const markerChats = wrap.querySelector("[data-chart-marker-chats]");
    if (!svg || !overlay || !tip) return;

    const w = Number(config.width) || CHART_W;
    const h = Number(config.height) || CHART_H;
    const pad = config.pad || CHART_PAD_DUAL;
    const maxViewers = Number(config.maxViewers) || 1;
    const maxChats = Number(config.maxChats) || 1;
    const minMs = Number(config.minMs);
    const maxMs = Number(config.maxMs);
    const { innerH, xAtTime, yViewers, yChats } = chartDualTimeLayout(
      pad,
      w,
      h,
      minMs,
      maxMs,
      maxViewers,
      maxChats
    );

    function showAtChartX(chartX) {
      if (String(wrap.dataset.chartToken) !== String(token)) return;
      const hoverMs = chartXToTimeMs(chartX, pad, w, minMs, maxMs);
      const snap = nearestMergedPointAtTime(merged, hoverMs);
      if (!snap) return;
      const snapAt = snap.at;
      const x = xAtTime(snapAt);
      const viewerV = snap.viewers;
      const chatV = snap.chats;
      const links = replayLinksForPoint(config.replay, snapAt);
      const rows = [];
      if (viewerV != null && Number.isFinite(Number(viewerV))) {
        rows.push(
          `<span class="ending-dev-chart__tip-row ending-dev-chart__tip-row--viewers">시청 ${esc(fmtNum(Math.round(viewerV)))}명</span>`
        );
      }
      if (chatV != null && Number.isFinite(Number(chatV))) {
        rows.push(
          `<span class="ending-dev-chart__tip-row ending-dev-chart__tip-row--chat">화력 ${esc(fmtNum(Math.round(chatV)))}회/분</span>`
        );
      }
      if (tip) {
        tip.innerHTML = `<strong>${esc(chartFullLabel(snapAt))}</strong>${rows.join("")}${
          links ? `<span class="ending-dev-chart__tip-sub">시작 + ${esc(links.offsetLabel)}</span>` : ""
        }`;
      }
      if (cursor) {
        showChartCursorLine(cursor, x, pad.t, pad.t + innerH);
      }
      if (markerViewers) {
        if (viewerV != null && Number.isFinite(Number(viewerV))) {
          markerViewers.hidden = false;
          markerViewers.setAttribute("cx", String(x));
          markerViewers.setAttribute("cy", String(yViewers(viewerV)));
        } else {
          markerViewers.hidden = true;
        }
      }
      if (markerChats) {
        if (chatV != null && Number.isFinite(Number(chatV))) {
          markerChats.hidden = false;
          markerChats.setAttribute("cx", String(x));
          markerChats.setAttribute("cy", String(yChats(chatV)));
        } else {
          markerChats.hidden = true;
        }
      }
      wrap.dataset.hoverAt = snapAt;
    }

    function hideHover() {
      if (tip) tip.innerHTML = chartTipIdleHtml();
      if (cursor) hideChartCursorLine(cursor);
      if (markerViewers) markerViewers.hidden = true;
      if (markerChats) markerChats.hidden = true;
      delete wrap.dataset.hoverAt;
    }

    function pinAt(clientX) {
      const hoverMs = chartXToTimeMs(chartClientXToSvgX(svg, clientX, w), pad, w, minMs, maxMs);
      const snap = nearestMergedPointAtTime(merged, hoverMs);
      if (!snap) return;
      const snapAt = snap.at;
      applyChartReplay(
        wrap,
        config.replay,
        snapAt,
        (links) => {
          const parts = [];
          if (snap.viewers != null && Number.isFinite(Number(snap.viewers))) {
            parts.push(`시청 ${fmtNum(Math.round(snap.viewers))}명`);
          }
          if (snap.chats != null && Number.isFinite(Number(snap.chats))) {
            parts.push(`화력 ${fmtNum(Math.round(snap.chats))}회/분`);
          }
          return `${chartFullLabel(snapAt)} · ${parts.join(" · ")} · 시작 + ${links.offsetLabel}${
            links.note ? ` · ${links.note}` : ""
          }`;
        },
        { openTab: true }
      );
    }

    overlay.addEventListener("mousemove", (ev) => {
      showAtChartX(chartClientXToSvgX(svg, ev.clientX, w));
    });
    overlay.addEventListener("mouseleave", hideHover);
    overlay.addEventListener("click", (ev) => {
      pinAt(ev.clientX);
    });
  }

  function renderMetricChartPanel(points, opts) {
    const o = opts || {};
    const emptyMsg = o.emptyMsg || "시계열 데이터가 아직 없습니다.";
    if (!points.length) {
      return `<p class="ending-dev-empty ending-dev-data-empty">${esc(emptyMsg)}</p>`;
    }
    const w = CHART_W;
    const h = CHART_H;
    const pad = CHART_PAD_SINGLE;
    const maxV = chartScaleMax(Math.max(...points.map((p) => p.v), 0));
    const { innerW, innerH, xAt, yAt } = chartAxisLayout(points.length, pad, w, h, maxV);
    const linePts = points.map((p, i) => ({
      x: Number(xAt(i)),
      y: Number(yAt(p.v)),
    }));
    const line = pathSmoothFromXY(linePts);
    const area = `${line} L${xAt(points.length - 1).toFixed(1)},${(pad.t + innerH).toFixed(1)} L${xAt(0).toFixed(1)},${(pad.t + innerH).toFixed(1)} Z`;
    const yTicks = [0, Math.round(maxV / 2), maxV];
    const yLines = yTicks
      .map((v) => {
        const y = yAt(v).toFixed(1);
        return `<line class="ending-dev-chart__grid" x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" />
          <text class="ending-dev-chart__ylabel" x="${pad.l - 8}" y="${y}" text-anchor="end" dominant-baseline="middle">${esc(fmtNum(v))}</text>`;
      })
      .join("");
    const xIdx = [0, Math.floor((points.length - 1) / 2), points.length - 1].filter(
      (v, i, arr) => arr.indexOf(v) === i
    );
    const xLabels = xIdx
      .map((i) => {
        const x = xAt(i).toFixed(1);
        const anchor = i === 0 ? "start" : i === points.length - 1 ? "end" : "middle";
        const dx = i === 0 ? 0 : i === points.length - 1 ? 0 : 0;
        return `<text class="ending-dev-chart__xlabel" x="${x}" y="${h - 8}" text-anchor="${anchor}" dx="${dx}">${esc(
          chartClockLabel(points[i].at)
        )}</text>`;
      })
      .join("");
    const lineColor = o.lineColor || "var(--dev-blue)";
    const areaColor = o.areaColor || "rgba(47, 95, 154, 0.12)";
    const meta = typeof o.meta === "function" ? o.meta(points, maxV) : String(o.meta || "");
    return `<div class="ending-dev-chart">
      ${meta ? `<p class="ending-dev-chart__meta">${esc(meta)} · 호버로 시점 확인 · 클릭하면 다시보기</p>` : `<p class="ending-dev-chart__meta">호버로 시점 확인 · 클릭하면 다시보기</p>`}
      <div class="ending-dev-chart__readout" data-chart-readout aria-live="polite">
        <div class="ending-dev-chart__tip" data-chart-tip>${chartTipIdleHtml()}</div>
      </div>
      <div class="ending-dev-chart__wrap" data-chart-wrap
        data-chart-width="${w}" data-chart-height="${h}"
        data-chart-pad="${esc(JSON.stringify(pad))}">
        <svg class="ending-dev-chart__svg" data-chart-svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(o.ariaLabel || "추이")}">
          ${yLines}
          <path class="ending-dev-chart__area" style="fill:${esc(areaColor)}" d="${area}" />
          <path class="ending-dev-chart__line" style="stroke:${esc(lineColor)}" d="${line}" />
          ${xLabels}
          <circle class="ending-dev-chart__marker" data-chart-marker hidden vector-effect="non-scaling-stroke" cx="0" cy="0" r="3.5" />
          <line class="ending-dev-chart__cursor" data-chart-cursor hidden x1="0" y1="0" x2="0" y2="0" />
        </svg>
        <div class="ending-dev-chart__overlay" data-chart-overlay aria-hidden="true"></div>
      </div>
      <div class="ending-dev-chart__replay" data-chart-replay hidden>
        <p class="ending-dev-chart__replay-meta" data-replay-meta></p>
        <a class="ending-dev-chart__replay-link" data-replay-link href="#" target="_blank" rel="noopener noreferrer">다시보기에서 이 시점 보기</a>
      </div>
    </div>`;
  }

  function mountMetricChartInteraction(root, opts) {
    const wrap = root?.querySelector?.("[data-chart-wrap]");
    if (!wrap || !opts?.points?.length) return;
    let pad = CHART_PAD_SINGLE;
    try {
      const parsed = JSON.parse(wrap.dataset.chartPad || "{}");
      if (parsed && typeof parsed === "object") pad = parsed;
    } catch (_) {
      /* ignore */
    }
    bindInteractiveChart(wrap, {
      points: opts.points,
      replay: opts.replay,
      lineColor: opts.lineColor || "",
      width: Number(wrap.dataset.chartWidth) || CHART_W,
      height: Number(wrap.dataset.chartHeight) || CHART_H,
      pad,
      valueSuffix: opts.valueSuffix || "",
      formatValue: opts.formatValue,
    });
  }

  function renderDualMetricChartPanel(viewerPoints, chatPoints, counts, replay) {
    const viewers = seriesPoints(viewerPoints);
    const chats = seriesPoints(chatPoints);
    const merged = mergeMetricsTimeline(viewers, chats);
    if (!merged.length) {
      return {
        html: `<p class="ending-dev-empty ending-dev-data-empty">시청자·채팅 화력 시계열이 아직 없습니다.</p>`,
        bind: null,
      };
    }
    const w = CHART_W;
    const h = CHART_H;
    const pad = CHART_PAD_DUAL;
    const timeRange = chartTimeRangeFromPoints(viewers, chats);
    if (!timeRange) {
      return {
        html: `<p class="ending-dev-empty ending-dev-data-empty">시청자·채팅 화력 시계열이 아직 없습니다.</p>`,
        bind: null,
      };
    }
    const { minMs, maxMs } = timeRange;
    const maxViewers = chartScaleMax(Math.max(...viewers.map((p) => p.v), 0));
    const maxChats = chartScaleMax(Math.max(...chats.map((p) => p.v), 0));
    const { innerH, xAtTime, yViewers, yChats } = chartDualTimeLayout(
      pad,
      w,
      h,
      minMs,
      maxMs,
      maxViewers,
      maxChats
    );
    const viewerLine = pathForSeriesPointsSmooth(viewers, xAtTime, yViewers);
    const chatLine = pathForSeriesPointsSmooth(chats, xAtTime, yChats);
    const yTicksViewers = [0, Math.round(maxViewers / 2), maxViewers];
    const yTicksChats = [0, Math.round(maxChats / 2), maxChats];
    const yLines = yTicksViewers
      .map((v) => {
        const y = yViewers(v).toFixed(1);
        return `<line class="ending-dev-chart__grid" x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" />
          <text class="ending-dev-chart__ylabel" x="${pad.l - 8}" y="${y}" text-anchor="end" dominant-baseline="middle">${esc(fmtNum(v))}</text>`;
      })
      .join("");
    const yRight = yTicksChats
      .map((v) => {
        const y = yChats(v).toFixed(1);
        return `<text class="ending-dev-chart__ylabel ending-dev-chart__ylabel--right" x="${w - pad.r + 8}" y="${y}" text-anchor="start" dominant-baseline="middle">${esc(fmtNum(v))}</text>`;
      })
      .join("");
    const midMs = minMs + (maxMs - minMs) / 2;
    const xLabelTimes = [
      { at: new Date(minMs).toISOString(), anchor: "start" },
      { at: new Date(midMs).toISOString(), anchor: "middle" },
      { at: new Date(maxMs).toISOString(), anchor: "end" },
    ];
    const xLabels = xLabelTimes
      .map(({ at, anchor }) => {
        const x = xAtTime(at).toFixed(1);
        return `<text class="ending-dev-chart__xlabel" x="${x}" y="${h - 8}" text-anchor="${anchor}">${esc(
          chartClockLabel(at)
        )}</text>`;
      })
      .join("");
    const peak = Number(counts?.peakViewers) || 0;
    const lastViewers = Number(counts?.lastViewerCount) || viewers[viewers.length - 1]?.v || 0;
    const peakChat = chats.length ? Math.max(...chats.map((p) => p.v)) : 0;
    const lastChat = chats.length ? chats[chats.length - 1].v : 0;
    const totalChat = Number(counts?.chatCount) || chats.reduce((n, p) => n + p.v, 0);
    const meta = [
      peak ? `시청 최고 ${fmtNum(peak)}명` : "",
      lastViewers ? `현재 ${fmtNum(lastViewers)}명` : "",
      peakChat ? `화력 피크 ${fmtNum(peakChat)}회/분` : "",
      totalChat ? `누적 ${fmtNum(totalChat)}회` : "",
      viewers.length ? `시청 ${fmtNum(viewers.length)}분` : "",
      chats.length ? `화력 ${fmtNum(chats.length)}분` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      html: `<div class="ending-dev-chart ending-dev-chart--dual">
      <p class="ending-dev-chart__meta">${esc(meta)} · 호버로 시점 확인 · 클릭하면 다시보기</p>
      <div class="ending-dev-chart__legend" aria-hidden="true">
        <span class="ending-dev-chart__legend-item ending-dev-chart__legend-item--viewers">시청자</span>
        <span class="ending-dev-chart__legend-item ending-dev-chart__legend-item--chat">채팅 화력</span>
      </div>
      <div class="ending-dev-chart__readout" data-chart-readout aria-live="polite">
        <div class="ending-dev-chart__tip" data-chart-tip>${chartTipIdleHtml()}</div>
      </div>
      <div class="ending-dev-chart__wrap" data-chart-wrap data-chart-dual="1"
        data-chart-width="${w}" data-chart-height="${h}"
        data-chart-pad="${esc(JSON.stringify(pad))}">
        <svg class="ending-dev-chart__svg" data-chart-svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="시청자·채팅 화력 추이">
          ${yLines}
          ${yRight}
          ${viewerLine ? `<path class="ending-dev-chart__line ending-dev-chart__line--viewers" d="${viewerLine}" />` : ""}
          ${chatLine ? `<path class="ending-dev-chart__line ending-dev-chart__line--chat" d="${chatLine}" />` : ""}
          ${xLabels}
          <circle class="ending-dev-chart__marker ending-dev-chart__marker--viewers" data-chart-marker-viewers hidden vector-effect="non-scaling-stroke" cx="0" cy="0" r="3.5" />
          <circle class="ending-dev-chart__marker ending-dev-chart__marker--chat" data-chart-marker-chats hidden vector-effect="non-scaling-stroke" cx="0" cy="0" r="3.5" />
          <line class="ending-dev-chart__cursor" data-chart-cursor hidden x1="0" y1="0" x2="0" y2="0" />
        </svg>
        <div class="ending-dev-chart__overlay" data-chart-overlay aria-hidden="true"></div>
      </div>
      <div class="ending-dev-chart__replay" data-chart-replay hidden>
        <p class="ending-dev-chart__replay-meta" data-replay-meta></p>
        <a class="ending-dev-chart__replay-link" data-replay-link href="#" target="_blank" rel="noopener noreferrer">다시보기에서 이 시점 보기</a>
      </div>
    </div>`,
      bind: {
        kind: "dual",
        merged,
        viewerPoints: viewers,
        chatPoints: chats,
        replay,
        width: w,
        height: h,
        pad,
        minMs,
        maxMs,
        maxViewers,
        maxChats,
      },
    };
  }

  function mountDualMetricChartInteraction(root, opts) {
    const wrap = root?.querySelector?.("[data-chart-wrap][data-chart-dual]");
    if (!wrap || !opts?.merged?.length) return;
    bindDualInteractiveChart(wrap, {
      merged: opts.merged,
      viewerPoints: opts.viewerPoints,
      chatPoints: opts.chatPoints,
      replay: opts.replay,
      width: opts.width || Number(wrap.dataset.chartWidth) || CHART_W,
      height: opts.height || Number(wrap.dataset.chartHeight) || CHART_H,
      pad: opts.pad || CHART_PAD_DUAL,
      minMs: opts.minMs,
      maxMs: opts.maxMs,
      maxViewers: opts.maxViewers,
      maxChats: opts.maxChats,
    });
  }

  function renderViewersChartPanel(metricsSeries, counts, replay) {
    const points = seriesPoints(metricsSeries?.viewers);
    const peak = Number(counts?.peakViewers) || 0;
    const last = Number(counts?.lastViewerCount) || points[points.length - 1]?.v || 0;
    return {
      html: renderMetricChartPanel(points, {
        emptyMsg: "시청자 시계열이 아직 없습니다. 라이브 폴링이 켜진 뒤 분 단위로 쌓입니다.",
        ariaLabel: "시청자 추이",
        meta: () =>
          [
            peak ? `최고 ${fmtNum(peak)}명` : "",
            last ? `현재 ${fmtNum(last)}명` : "",
            points.length ? `${fmtNum(points.length)}분` : "",
          ]
            .filter(Boolean)
            .join(" · "),
      }),
      bind: {
        points,
        replay,
        lineColor: "#2f5f9a",
        valueSuffix: "명",
        formatValue: (v) => `${fmtNum(v)}명`,
      },
    };
  }

  function renderChatChartPanel(metricsSeries, counts, replay) {
    const points = seriesPoints(metricsSeries?.chats);
    const peakMin = points.length ? Math.max(...points.map((p) => p.v)) : 0;
    const lastMin = points.length ? points[points.length - 1].v : 0;
    const total = Number(counts?.chatCount) || points.reduce((n, p) => n + p.v, 0);
    return {
      html: renderMetricChartPanel(points, {
        emptyMsg: "채팅 화력 시계열이 아직 없습니다. 방송 중 채팅이 수집되면 분 단위로 표시됩니다.",
        ariaLabel: "채팅 화력 추이",
        lineColor: "#c45c26",
        areaColor: "rgba(196, 92, 38, 0.14)",
        meta: () =>
          [
            peakMin ? `피크 ${fmtNum(peakMin)}회/분` : "",
            lastMin ? `최근 ${fmtNum(lastMin)}회/분` : "",
            total ? `누적 ${fmtNum(total)}회` : "",
            points.length ? `${fmtNum(points.length)}분` : "",
          ]
            .filter(Boolean)
            .join(" · "),
      }),
      bind: {
        points,
        replay,
        lineColor: "#c45c26",
        valueSuffix: "회/분",
        formatValue: (v) => `${fmtNum(v)}회/분`,
      },
    };
  }

  function renderMetricsChartPanel(metricsSeries, counts, replay, mode) {
    const viewerPoints = seriesPoints(metricsSeries?.viewers);
    const chatPoints = seriesPoints(metricsSeries?.chats);
    if (mode === "viewers") {
      return renderViewersChartPanel(metricsSeries, counts, replay);
    }
    if (mode === "chat") {
      return renderChatChartPanel(metricsSeries, counts, replay);
    }
    return renderDualMetricChartPanel(viewerPoints, chatPoints, counts, replay);
  }

  function devLiveExtras(collected) {
    const raw = collected?.liveExtras;
    return raw && typeof raw === "object" ? raw : null;
  }

  function buildDataCategories(sections, collected) {
    const c = collected || {};
    const counts = c.counts || {};
    const byId = new Map();
    const order = [
      "firstChat",
      "metricsChart",
      "chat",
      "watch",
      "donation",
      "signature",
      "fanclub",
      "subscribe_gift",
      "subscribe",
      "subscribe_renew",
      "emoticon",
      "thanks",
      "mission",
      "topfan",
      "quickview",
    ];

    for (const sec of Array.isArray(sections) ? sections : []) {
      if (!sec || typeof sec !== "object") continue;
      const id = String(sec.id || "").trim();
      if (!id) continue;
      const items = normalizeItems(sec.items || []);
      byId.set(id, {
        id,
        title: String(sec.title || id),
        count: Number(sec.itemCount || items.length || 0),
        pending: Boolean(sec.pending) && items.length === 0,
        items,
      });
    }

    // 모니터는 collected 전체 목록을 우선 (크레딧 섹션은 상위 일부만)
    const preferred = [
      ["chat", "채팅 순위", c.topChatters, "count", counts.chatters],
      ["watch", "시청 시간 순위", c.topWatchers, "value", counts.watchers],
      ["donation", "후원 순위", c.topDonations, "total", counts.donors],
      ["fanclub", "팬클럽 가입", c.fanclubJoins, "value", counts.fanclubJoins],
      ["subscribe_gift", "구독 선물", c.subscriptionGifts, "value", counts.subscriptionGifts],
      ["subscribe", "신규 구독", c.subscribers, "value", counts.subscribers],
      ["subscribe_renew", "연속 구독", c.subscriberRenewals, "value", counts.subscriberRenewals],
      ["emoticon", "이모티콘 순위", c.topEmoticons, "count", counts.emoticons],
      ["topfan", "열혈팬 승급", c.topFans, "value", null],
    ];
    for (const [id, title, rows, key, totalHint] of preferred) {
      const items = normalizeItems(rows, key);
      const prev = byId.get(id);
      if (!items.length) {
        if (prev && !prev.count && totalHint) prev.count = Number(totalHint) || 0;
        continue;
      }
      const useCollected =
        !prev ||
        items.length >= (prev.items?.length || 0) ||
        (id === "emoticon" && items.some((it) => it.imageUrl));
      if (!useCollected) continue;
      byId.set(id, {
        id,
        title: prev?.title || title,
        count: Number(totalHint) > 0 ? Number(totalHint) : items.length,
        pending: false,
        items,
      });
    }

    const extras = devLiveExtras(c);
    if (extras) {
      const firstChat =
        extras.firstChat && typeof extras.firstChat === "object" ? extras.firstChat : null;
      if (firstChat && String(firstChat.name || "").trim()) {
        byId.set("firstChat", {
          id: "firstChat",
          title: "첫 채팅",
          count: 1,
          pending: false,
          kind: "firstChat",
          firstChat,
          items: [],
        });
      } else {
        byId.set("firstChat", {
          id: "firstChat",
          title: "첫 채팅",
          count: 0,
          pending: true,
          kind: "firstChat",
          firstChat: null,
          items: [],
        });
      }

      const viewerPoints = seriesPoints(extras.metricsSeries?.viewers);
      const chatPoints = seriesPoints(extras.metricsSeries?.chats);
      const viewerN = viewerPoints.length;
      const chatN = chatPoints.length;
      byId.set("metricsChart", {
        id: "metricsChart",
        title: "시청 · 화력",
        count: Math.max(viewerN, chatN),
        countLabel: metricsTabCountLabel(viewerN, chatN),
        pending: viewerN === 0 && chatN === 0,
        kind: "metricsChart",
        metricsSeries: extras.metricsSeries || {},
        viewerCount: viewerN,
        chatCount: chatN,
        counts: counts,
        items: [],
      });
    }

    const cats = [];
    for (const id of order) {
      if (byId.has(id)) cats.push(byId.get(id));
    }
    for (const [id, cat] of byId) {
      if (!order.includes(id)) cats.push(cat);
    }
    return cats;
  }

  function sliceItemsForLimit(items, limit) {
    const list = Array.isArray(items) ? items : [];
    const n = Number(limit);
    const sliced = !n || n <= 0 ? list.slice() : list.slice(0, n);
    return sliced.map((row, i) => ({ ...row, rank: i + 1 }));
  }

  function renderChartModeToggles(mode) {
    return `<div class="ending-dev-chart-mode" role="group" aria-label="그래프 보기">
      ${METRICS_CHART_MODES.map((opt) => {
        const on = mode === opt.value;
        return `<button type="button" class="ending-dev-chart-mode__btn${on ? " is-on" : ""}" data-chart-mode="${esc(
          opt.value
        )}">${esc(opt.label)}</button>`;
      }).join("")}
    </div>`;
  }

  function renderLimitToggles(total) {
    return `<div class="ending-dev-limit" role="group" aria-label="표시 개수">
      ${DATA_LIMITS.map((opt) => {
        const on = dataLimit === opt.value;
        const label = opt.value === 0 ? "전체" : opt.label;
        return `<button type="button" class="ending-dev-limit__btn${on ? " is-on" : ""}" data-limit="${
          opt.value
        }">${esc(label)}</button>`;
      }).join("")}
      <span class="ending-dev-limit__total">${esc(fmtNum(total))}건</span>
    </div>`;
  }

  function renderDataList(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      return `<p class="ending-dev-empty ending-dev-data-empty">이 카테고리에 아직 데이터가 없습니다.</p>`;
    }
    const hasImg = list.some((row) => row.imageUrl);
    return `<ol class="ending-dev-rank ending-dev-rank--lg${hasImg ? " ending-dev-rank--emo" : ""}">
      ${list
        .map((row) => {
          const img = String(row.imageUrl || "").trim();
          const thumb = img
            ? `<img class="ending-dev-rank__img" src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
            : hasImg
              ? `<span class="ending-dev-rank__img ending-dev-rank__img--empty" aria-hidden="true"></span>`
              : "";
          return `<li>
            <span class="ending-dev-rank__n">${esc(row.rank)}</span>
            ${thumb}
            <span class="ending-dev-rank__name" title="${esc(row.name)}">${esc(row.name)}</span>
            <span class="ending-dev-rank__val">${esc(row.value)}</span>
          </li>`;
        })
        .join("")}
    </ol>`;
  }

  function renderDataPanel(sections, collected) {
    const cats = buildDataCategories(sections, collected)
      .map((c, i) => ({ ...c, _ord: i }))
      .sort((a, b) => {
        const ar = Number(a.count || 0) > 0 ? 0 : 1;
        const br = Number(b.count || 0) > 0 ? 0 : 1;
        if (ar !== br) return ar - br;
        return a._ord - b._ord;
      });
    dataCatsCache = cats;
    const readyN = cats.filter((c) => c.count > 0).length;
    if (els.dataHint) {
      els.dataHint.textContent = cats.length
        ? `${readyN}개 카테고리 · ${cats.reduce((n, c) => n + (c.count || 0), 0)}건`
        : "데이터 없음";
    }
    if (!els.dataNav || !els.dataBody) return;

    if (!cats.length) {
      els.dataNav.innerHTML = "";
      els.dataBody.innerHTML = `<p class="ending-dev-empty">수집된 데이터가 없습니다.</p>`;
      return;
    }

    if (!dataTabId || !cats.some((c) => c.id === dataTabId)) {
      const firstReady = cats.find((c) => c.count > 0) || cats[0];
      dataTabId = firstReady.id;
    }

    els.dataNav.innerHTML = cats
      .map((c) => {
        const on = c.id === dataTabId;
        const state = c.count > 0 ? "is-ready" : "is-pending";
        return `<button type="button" class="ending-dev-data-tab ${state}${on ? " is-on" : ""}" role="tab" aria-selected="${
          on ? "true" : "false"
        }" data-id="${esc(c.id)}">
          <span class="ending-dev-data-tab__title">${esc(c.title)}</span>
          <span class="ending-dev-data-tab__count">${esc(
            c.kind === "metricsChart" ? c.countLabel || metricsTabCountLabel(c.viewerCount, c.chatCount) : c.count > 0 ? c.count : "대기"
          )}</span>
        </button>`;
      })
      .join("");

    const active = cats.find((c) => c.id === dataTabId) || cats[0];
    const counts = active.counts || (collected || {}).counts || {};
    const replay = devLiveExtras(collected)?.replay || {};
    let panelBody = "";
    let chartBind = null;
    if (active.kind === "firstChat") {
      panelBody = renderFirstChatPanel(active.firstChat);
    } else if (active.kind === "metricsChart") {
      const chart = renderMetricsChartPanel(active.metricsSeries, counts, replay, metricsChartMode);
      panelBody = chart.html;
      chartBind = chart.bind;
    } else {
      const shown = sliceItemsForLimit(active.items, dataLimit);
      panelBody = renderDataList(shown);
    }
    const total = active.items?.length || active.count || 0;
    const showLimit = active.kind !== "firstChat" && active.kind !== "metricsChart";
    const panelHeadExtra =
      active.kind === "metricsChart"
        ? renderChartModeToggles(metricsChartMode)
        : `<span class="ending-dev-data-panel__meta">실시간</span>`;
    els.dataBody.innerHTML = `
      <div class="ending-dev-data-panel">
        <div class="ending-dev-data-panel__head">
          <h4 class="ending-dev-data-panel__title">${esc(active.title)}</h4>
          ${showLimit ? renderLimitToggles(total) : panelHeadExtra}
        </div>
        ${panelBody}
      </div>`;
    if (chartBind?.kind === "dual") mountDualMetricChartInteraction(els.dataBody, chartBind);
    else if (chartBind) mountMetricChartInteraction(els.dataBody, chartBind);
  }

  function onChartModeClick(mode) {
    const next = String(mode || "").trim();
    if (!(next === "both" || next === "viewers" || next === "chat")) return;
    if (next === metricsChartMode) return;
    metricsChartMode = next;
    try {
      sessionStorage.setItem(METRICS_CHART_MODE_KEY, metricsChartMode);
    } catch (_) {
      /* ignore */
    }
    if (!lastData) return;
    const acc = resolveAccount(lastData, activeTab);
    renderDataPanel(acc.sections, (acc.session || {}).collected || {});
  }

  function onDataLimitClick(limit) {
    const n = Number(limit);
    if (!(n === 0 || n === 10 || n === 50 || n === 100)) return;
    if (n === dataLimit) return;
    dataLimit = n;
    try {
      sessionStorage.setItem(DATA_LIMIT_KEY, String(dataLimit));
    } catch (_) {
      /* ignore */
    }
    if (!lastData) return;
    const acc = resolveAccount(lastData, activeTab);
    renderDataPanel(acc.sections, (acc.session || {}).collected || {});
  }

  function onDataTabClick(id) {
    const next = String(id || "").trim();
    if (!next || next === dataTabId) return;
    dataTabId = next;
    try {
      sessionStorage.setItem(DATA_TAB_KEY, dataTabId);
    } catch (_) {
      /* ignore */
    }
    if (!lastData) return;
    const acc = resolveAccount(lastData, activeTab);
    renderDataPanel(acc.sections, (acc.session || {}).collected || {});
  }

  function roleClass(role) {
    if (role === "sirian") return "is-sirian";
    if (role === "overlayDev") return "is-dev";
    return "";
  }

  function roleLabel(role) {
    if (role === "sirian") return "시리안";
    if (role === "overlayDev") return "오버레이 개발";
    return "수집";
  }

  function yn(v) {
    return v
      ? `<span class="ending-dev-pill is-on">ON</span>`
      : `<span class="ending-dev-pill">OFF</span>`;
  }

  function resolveAccount(data, tab) {
    if (tab === "me") {
      const live = data.live || {};
      return {
        kind: "me",
        label: "내 계정",
        stationId: live.stationId || data.viewerStationId || "—",
        session: live,
        info: data.livePreview?.info || {},
        sections: live.sections || data.livePreview?.sections || [],
        source: "session",
        meta: "",
        stubNote: "",
      };
    }
    if (viewMode === "history" && historyPayload) {
      const sess = historyPayload.session || {};
      const info = historyPayload.info || {};
      return {
        kind: "sirian",
        label: "시리안 · 아카이브",
        stationId: historyPayload.stationId || data.sirianStationId || "sirianrain",
        session: sess,
        info,
        sections: historyPayload.sections || [],
        source: "archive",
        meta: [
          info.dateLabel || null,
          info.durationLabel || historyPayload.durationLabel || null,
          historyPayload.archiveId ? `archive ${historyPayload.archiveId}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        stubNote: "",
        archiveId: historyPayload.archiveId || "",
      };
    }
    const sirian = data.sirian || {};
    const sess = sirian.session || {};
    const info = sirian.info || {};
    return {
      kind: "sirian",
      label: "시리안",
      stationId: sirian.stationId || data.sirianStationId || "sirianrain",
      session: sess,
      info,
      sections: sirian.sections || [],
      source: String(sirian.source || "none"),
      meta: [
        info.dateLabel || null,
        info.durationLabel || null,
        sirian.source === "archive" && sirian.archiveId ? `archive ${sirian.archiveId}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      stubNote: String(sirian.stubNote || ""),
      archiveId: sirian.archiveId || "",
    };
  }

  function setViewModeUi() {
    const isHist = viewMode === "history";
    els.viewLive?.classList.toggle("is-on", !isHist);
    els.viewHistory?.classList.toggle("is-on", isHist);
    els.viewLive?.setAttribute("aria-selected", isHist ? "false" : "true");
    els.viewHistory?.setAttribute("aria-selected", isHist ? "true" : "false");
    if (els.history) els.history.hidden = !isHist;
  }

  function stationForHistory(data) {
    if (activeTab === "me") return data.viewerStationId || "";
    return data.sirianStationId || "sirianrain";
  }

  async function loadHistoryDates(data) {
    const sid = stationForHistory(data);
    if (!sid || !els.historyDate) return;
    const fromPayload = activeTab === "sirian" ? data.sirian?.archiveDates : null;
    let items = Array.isArray(fromPayload) ? fromPayload : null;
    if (!items) {
      const res = await fetchJson(
        `/api/credits/dev-monitor/archive-dates?stationId=${encodeURIComponent(sid)}&limit=90`,
        { headers: authHeaders() }
      );
      items = Array.isArray(res?.items) ? res.items : [];
    }
    if (!historyDate && items[0]?.date) historyDate = String(items[0].date);
    els.historyDate.innerHTML = items.length
      ? items
          .map((d) => {
            const date = String(d.date || "");
            const n = Number(d.count || d.broadcasts || 0);
            const label = n > 0 ? `${date} (${n})` : date;
            return `<option value="${esc(date)}"${date === historyDate ? " selected" : ""}>${esc(
              label
            )}</option>`;
          })
          .join("")
      : `<option value="">아카이브 없음</option>`;
  }

  async function loadHistoryList() {
    if (!lastData || !els.historyList) return;
    const sid = stationForHistory(lastData);
    if (!sid || !historyDate) {
      els.historyList.innerHTML = `<p class="ending-dev-empty">날짜를 선택하세요.</p>`;
      return;
    }
    historyBusy = true;
    els.historyList.innerHTML = `<p class="ending-muted">불러오는 중…</p>`;
    try {
      const res = await fetchJson(
        `/api/credits/dev-monitor/archives?stationId=${encodeURIComponent(sid)}&date=${encodeURIComponent(
          historyDate
        )}&limit=40`,
        { headers: authHeaders() }
      );
      historyListCache = Array.isArray(res?.items) ? res.items : [];
      if (!historyListCache.length) {
        els.historyList.innerHTML = `<p class="ending-dev-empty">이 날짜에 아카이브가 없습니다.</p>`;
        return;
      }
      if (!historyArchiveId || !historyListCache.some((x) => x.archiveId === historyArchiveId)) {
        historyArchiveId = String(historyListCache[0].archiveId || "");
      }
      els.historyList.innerHTML = historyListCache
        .map((it) => {
          const on = it.archiveId === historyArchiveId;
          const dur = it.durationLabel || "—";
          const peak = fmtNum(it.peakViewers);
          const chat = fmtNum(it.chatCount);
          const balloon = fmtNum(it.balloonTotal);
          return `<button type="button" class="ending-dev-history__item${on ? " is-on" : ""}" data-archive-id="${esc(
            it.archiveId
          )}">
            <span class="ending-dev-history__item-title">${esc(it.title || "(제목 없음)")}</span>
            <span class="ending-dev-history__item-meta">${esc(fmtTime(it.startedAt))} · ${esc(
            dur
          )} · 피크 ${esc(peak)} · 채팅 ${esc(chat)} · 별풍 ${esc(balloon)}</span>
          </button>`;
        })
        .join("");
      if (historyArchiveId) await loadHistoryArchive(historyArchiveId);
    } catch (err) {
      els.historyList.innerHTML = `<p class="ending-dev-empty">목록 오류: ${esc(
        err?.data?.error || err.message || "fail"
      )}</p>`;
    } finally {
      historyBusy = false;
    }
  }

  async function loadHistoryArchive(archiveId) {
    const aid = String(archiveId || "").trim();
    if (!aid) return;
    historyArchiveId = aid;
    try {
      const packed = await fetchJson(
        `/api/credits/dev-monitor/archive?archiveId=${encodeURIComponent(aid)}`,
        { headers: authHeaders() }
      );
      if (!packed?.ok && packed?.error) throw new Error(packed.error);
      historyPayload = packed;
      if (lastData) paint(lastData, { animate: false });
    } catch (err) {
      historyPayload = null;
      if (els.note) {
        els.note.hidden = false;
        els.note.textContent = `아카이브를 불러오지 못했습니다: ${err.message || err}`;
      }
    }
  }

  function setViewMode(mode) {
    const next = mode === "history" ? "history" : "live";
    if (next === viewMode && (next !== "history" || historyPayload)) {
      setViewModeUi();
      return;
    }
    viewMode = next;
    try {
      sessionStorage.setItem(VIEW_KEY, viewMode);
    } catch (_) {
      /* ignore */
    }
    setViewModeUi();
    if (viewMode === "history" && lastData) {
      loadHistoryDates(lastData).then(() => loadHistoryList());
    } else if (lastData) {
      paint(lastData, { animate: true });
    }
  }

  function setTabUi(tab) {
    activeTab = tab === "me" ? "me" : "sirian";
    const isSirian = activeTab === "sirian";
    els.tabSirian?.setAttribute("aria-selected", isSirian ? "true" : "false");
    els.tabMe?.setAttribute("aria-selected", isSirian ? "false" : "true");
    try {
      sessionStorage.setItem(TAB_KEY, activeTab);
    } catch (_) {
      /* ignore */
    }
  }

  function activeStationId(data) {
    if (activeTab === "me") {
      return String(data.viewerStationId || data.live?.stationId || "").trim();
    }
    return String(data.sirianStationId || data.sirian?.stationId || "sirianrain").trim();
  }

  function renderStrip(data) {
    if (!els.strip) return;
    const acc = resolveAccount(data, activeTab);
    const sess = acc.session || {};
    const liveIngest = Boolean(sess.ingestActive);
    const lastAt = sess.lastIngestAt || "";
    const lastAge = sess.lastIngestAgeSec;
    const boundSid = String((data.activeBound || {}).stationId || "").trim();
    const thisSid = String(acc.stationId || "").trim();
    const boundHere = Boolean(boundSid && thisSid && boundSid === thisSid);
    const statusLabel = liveIngest ? "INGEST ON" : sess.ingestAuthFailRecent ? "AUTH FAIL" : "STANDBY";
    els.strip.innerHTML = `
      <div class="ending-dev-chip ending-dev-chip--status ${liveIngest ? "is-live" : ""}">
        <p class="ending-dev-chip__label">실제 수집 · ${esc(acc.label)}</p>
        <p class="ending-dev-chip__value">${esc(statusLabel)}</p>
        <span class="ending-dev-chip__pulse" aria-hidden="true"></span>
      </div>
      <div class="ending-dev-chip">
        <p class="ending-dev-chip__label">마지막 수집</p>
        <p class="ending-dev-chip__value ending-dev-chip__value--sm">${
          lastAt
            ? `${esc(fmtTime(lastAt))}${
                fmtAge(lastAge)
                  ? `<span class="ending-dev-chip__sub">${esc(fmtAge(lastAge))}${
                      ingestLabel(sess) ? ` · ${esc(ingestLabel(sess))}` : ""
                    }</span>`
                  : ""
              }`
            : "—"
        }</p>
      </div>
      <div class="ending-dev-chip">
        <p class="ending-dev-chip__label">서버 바인드</p>
        <p class="ending-dev-chip__value ending-dev-chip__value--sm">${
          boundHere ? "이 계정" : boundSid ? `<code>${esc(boundSid)}</code>` : "—"
        }<span class="ending-dev-chip__sub">${boundHere ? "활성 포인터" : "다른 계정/없음"}</span></p>
      </div>
      <div class="ending-dev-chip">
        <p class="ending-dev-chip__label">채널 ID</p>
        <p class="ending-dev-chip__value"><code>${esc(thisSid || "—")}</code></p>
      </div>`;
  }

  function renderAccount(data) {
    const acc = resolveAccount(data, activeTab);
    const sess = acc.session || {};
    const info = acc.info || {};
    const collected = sess.collected || {};

    if (els.label) els.label.textContent = acc.label;
    if (els.title) els.title.textContent = acc.stationId;
    if (els.broadcast) {
      els.broadcast.textContent = info.title || sess.title || "방송 정보 없음";
    }
    if (els.meta) {
      els.meta.textContent = acc.meta || (sess.updatedAt ? `세션 갱신 ${fmtTime(sess.updatedAt)}` : "—");
    }
    if (els.note) {
      if (viewMode === "history" && acc.archiveId) {
        els.note.hidden = false;
        els.note.textContent = `날짜별 보기 · ${acc.archiveId}`;
      } else {
        els.note.hidden = true;
        els.note.textContent = "";
      }
    }

    setViewModeUi();

    if (acc.source === "archive" || viewMode === "history") {
      setBadge(els.badge, "아카이브", "is-archive");
    } else if (sess.ingestActive) {
      setBadge(els.badge, "수집 중", "is-on");
    } else if (sess.ingestAuthFailRecent) {
      setBadge(els.badge, "인증 실패", "is-warn");
    } else if (sess.active || sess.collectorOpen || sess.chatSdkConnected) {
      setBadge(els.badge, "세션만 유지", "is-off");
    } else {
      setBadge(els.badge, "대기", "is-off");
    }

    setPanelStatus(acc);
    renderFlags(els.flags, sess);
    renderStats(els.stats, [
      ["실제 수집", viewMode === "history" ? "—" : sess.ingestActive ? "ON" : "OFF"],
      ["마지막 수집", viewMode === "history" ? "아카이브" : ingestStatusText(sess)],
      ["채팅", `${fmtNum(info.chatters || collected.counts?.chatters || sess.chatterCount)}명 · ${fmtNum(info.chatCount || collected.counts?.chatCount || sess.chatCount)}회`],
      ["별풍", fmtNum(info.balloonTotal || collected.counts?.balloonTotal || sess.balloonTotal)],
      ["시청", `현재 ${fmtNum(sess.lastViewerCount || collected.counts?.lastViewerCount)} · 피크 ${fmtNum(info.peakViewers || sess.peakViewers)}`],
      ["팬 / 구독", `팬 ${fmtNum(info.fanclubCount || collected.counts?.fanclubJoins)} · 구독 ${fmtNum(info.subscribeCount || collected.counts?.subscribers)} · 선물 ${fmtNum(collected.counts?.subscriptionGifts)}`],
    ]);
    renderPeakThumb(acc);

    renderDataPanel(acc.sections, collected);
    renderSegments(els.segments, viewMode === "history" ? [] : sess.collectorSegments);

    if (els.tabSirianId) els.tabSirianId.textContent = data.sirianStationId || "sirianrain";
    if (els.tabMeId) els.tabMeId.textContent = data.viewerStationId || "—";
    const sirianOn = Boolean((data.sirian || {}).session?.ingestActive);
    const meOn = Boolean((data.live || {}).ingestActive);
    if (els.tabSirianDot) els.tabSirianDot.hidden = !sirianOn;
    if (els.tabMeDot) els.tabMeDot.hidden = !meOn;
  }

  function signal(label, on, mode) {
    // mode: truthy warn / "present" = 접속(노랑) / 생략 = 활성(초록)
    let kind = "";
    if (mode === "present") kind = on ? " is-present" : "";
    else if (mode) kind = " is-warn";
    else if (on) kind = " is-on";
    return `<span class="ending-dev-signal${kind}"><span class="ending-dev-signal__dot" aria-hidden="true"></span>${esc(
      label
    )}</span>`;
  }

  function renderCollectors(data) {
    const activeStation = activeStationId(data);
    const rows = (Array.isArray(data.collectors) ? data.collectors : []).filter((c) => {
      const sid = String(c.stationId || "").trim();
      return Boolean(activeStation && sid && sid === activeStation);
    });
    if (els.collectorsHint) {
      els.collectorsHint.textContent = activeStation
        ? `${activeStation} · OBS / 수집기 탭 / 키`
        : "선택한 계정 없음";
    }
    if (!els.collectorsBody) return;
    if (!rows.length) {
      els.collectorsBody.innerHTML = `<p class="ending-dev-empty">${
        activeStation ? `${esc(activeStation)} 수집기 정보 없음` : "선택한 계정 없음"
      }</p>`;
      return;
    }
    els.collectorsBody.innerHTML = rows
      .map((c) => {
        const role = c.role || "collector";
        const sid = String(c.stationId || "").trim();
        const classes = ["ending-dev-collector", c.ingestActive ? "is-ingest" : "", "is-active-tab"]
          .filter(Boolean)
          .join(" ");
        return `<article class="${classes}">
          <div class="ending-dev-collector__top">
            <div>
              <p class="ending-dev-collector__id">${esc(sid || "—")}</p>
              <p class="ending-dev-collector__meta">${
                c.lastIngestAt
                  ? `마지막 ${esc(fmtTime(c.lastIngestAt))}`
                  : `키 ${esc(fmtTime(c.obsKeyUpdatedAt))}`
              }</p>
            </div>
            <span class="ending-dev-role ${roleClass(role)}">${esc(roleLabel(role))}</span>
          </div>
          <div class="ending-dev-collector__signals">
            ${signal("수집", c.ingestActive, c.ingestAuthFailRecent && !c.ingestActive)}
            ${signal("OBS", c.obsBrowserActive, "present")}
            ${signal("탭", c.collectorTabActive, "present")}
            ${signal("키", c.hasObsKey)}
            ${signal("바인드", c.boundLive)}
          </div>
        </article>`;
      })
      .join("");
  }

  function paint(data, { animate = false } = {}) {
    lastData = data;
    setTabUi(activeTab);
    renderStrip(data);
    renderAccount(data);
    renderCollectors(data);
    if (els.stamp) {
      els.stamp.textContent = data.generatedAt ? `갱신 ${fmtTime(data.generatedAt)}` : "—";
    }
    // 탭 전환 때만 fade — 자동 갱신마다 돌리면 메인 박스가 깜빡임
    if (animate && els.panel) {
      els.panel.classList.remove("is-switching");
      void els.panel.offsetWidth;
      els.panel.classList.add("is-switching");
    }
  }

  function showGate(msg) {
    if (els.app) els.app.hidden = true;
    if (els.gate) els.gate.hidden = false;
    if (els.gateMsg && msg) els.gateMsg.textContent = msg;
  }

  function showApp() {
    if (els.gate) els.gate.hidden = true;
    if (els.app) els.app.hidden = false;
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const data = await fetchJson("/api/credits/dev-monitor", { headers: authHeaders() });
      if (!data?.ok) throw new Error(data?.error || "monitor_failed");
      showApp();
      paint(data);
      if (viewMode === "history") {
        await loadHistoryDates(data);
        if (!historyPayload) await loadHistoryList();
      }
    } catch (err) {
      const code = err?.data?.error || err.message;
      if (err.status === 403 || code === "overlay_dev_required") {
        showGate("오버레이 개발자 계정으로 수집기에서 로그인한 뒤 다시 열어 주세요.");
      } else if (err.status === 401) {
        showGate("숲 로그인이 필요합니다. 수집기에서 로그인해 주세요.");
      } else {
        showGate(`모니터를 불러오지 못했습니다: ${code}`);
      }
    } finally {
      busy = false;
    }
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = null;
    if (els.auto?.checked) {
      timer = setInterval(() => refresh(), POLL_MS);
    }
  }

  function onTabClick(tab) {
    if (tab !== "me" && tab !== "sirian") return;
    if (tab === activeTab) return;
    setTabUi(tab);
    historyPayload = null;
    historyArchiveId = "";
    if (viewMode === "history" && lastData) {
      loadHistoryDates(lastData).then(() => loadHistoryList());
    } else if (lastData) {
      paint(lastData, { animate: true });
    }
  }

  els.tabSirian?.addEventListener("click", () => onTabClick("sirian"));
  els.tabMe?.addEventListener("click", () => onTabClick("me"));
  els.viewLive?.addEventListener("click", () => setViewMode("live"));
  els.viewHistory?.addEventListener("click", () => setViewMode("history"));
  els.historyDate?.addEventListener("change", () => {
    historyDate = String(els.historyDate.value || "");
    historyArchiveId = "";
    historyPayload = null;
    loadHistoryList();
  });
  els.historyList?.addEventListener("click", (ev) => {
    const btn = ev.target?.closest?.("[data-archive-id]");
    if (!btn || historyBusy) return;
    const aid = btn.getAttribute("data-archive-id");
    els.historyList.querySelectorAll(".ending-dev-history__item").forEach((el) => {
      el.classList.toggle("is-on", el.getAttribute("data-archive-id") === aid);
    });
    loadHistoryArchive(aid);
  });
  els.dataNav?.addEventListener("click", (ev) => {
    const btn = ev.target?.closest?.("[data-id]");
    if (!btn) return;
    onDataTabClick(btn.getAttribute("data-id"));
  });
  els.dataBody?.addEventListener("click", (ev) => {
    const modeBtn = ev.target?.closest?.("[data-chart-mode]");
    if (modeBtn) {
      onChartModeClick(modeBtn.getAttribute("data-chart-mode"));
      return;
    }
    const btn = ev.target?.closest?.("[data-limit]");
    if (!btn) return;
    onDataLimitClick(btn.getAttribute("data-limit"));
  });
  els.refresh?.addEventListener("click", () => refresh());
  els.auto?.addEventListener("change", () => schedule());

  refresh().then(() => schedule());
})();
