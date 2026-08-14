(() => {
  const TOKEN_KEY = "ending_soop_access_token";
  const MONITOR_MODE =
    window.ENDING_MONITOR_MODE === "me"
      ? "me"
      : window.ENDING_MONITOR_MODE === "live_data"
        ? "live_data"
        : "sirian";
  const isMeMonitor = () => MONITOR_MODE === "me";
  const isLiveDataPage = () => MONITOR_MODE === "live_data";
  const monitorApiBase = () => (isLiveDataPage() ? "/api/credits/live-data" : "/api/credits/dev-monitor");
  const base = () => window.CREDITS_BASE || "";
  const POLL_MS = 5000;
  /** VOD 다시보기: 차트 분 버킷(00초)보다 앞에서 재생해 맥락을 보여준다. */
  const REPLAY_SEEK_LEAD_SEC = 10;

  const els = {
    gate: document.getElementById("dev-gate"),
    gateMsg: document.getElementById("dev-gate-msg"),
    app: document.getElementById("dev-app"),
    stamp: document.getElementById("dev-stamp"),
    auto: document.getElementById("dev-auto"),
    refresh: document.getElementById("btn-dev-refresh"),
    strip: document.getElementById("dev-strip"),
    panel: document.getElementById("panel-account"),
    title: document.getElementById("acc-title"),
    broadcast: document.getElementById("acc-broadcast"),
    meta: document.getElementById("acc-meta"),
    note: document.getElementById("acc-note"),
    viewmode: document.getElementById("acc-viewmode"),
    viewLive: document.getElementById("view-live"),
    viewHistory: document.getElementById("view-history"),
    history: document.getElementById("acc-history"),
    historyDate: document.getElementById("acc-history-date"),
    historyList: document.getElementById("acc-history-list"),
    flags: null,
    stats: document.getElementById("acc-stats"),
    peak: document.getElementById("acc-peak"),
    peakImg: document.getElementById("acc-peak-img"),
    peakCap: document.getElementById("acc-peak-cap"),
    dataBody: document.getElementById("acc-data-body"),
    dataHint: document.getElementById("acc-data-hint"),
    gateLogin: document.getElementById("btn-live-data-login"),
  };

  const DATA_TAB_KEY = "ending_dev_monitor_data_tab";
  const DATA_LIMIT_KEY = "ending_dev_monitor_data_limit";
  const METRICS_CHART_MODE_KEY = "ending_dev_monitor_metrics_chart_mode";
  const CHART_ZOOM_STORAGE_KEY = "ending_dev_chart_zoom";
  const CHART_PAN_STORAGE_KEY = "ending_dev_chart_pan";
  const VIEW_KEY = "ending_dev_monitor_view";
  const SCROLL_STATE_KEY = "ending_dev_monitor_scroll";
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
  let activeTab = MONITOR_MODE;
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
  let scrollRestorePending = null;
  let scrollPersistTimer = null;

  try {
    dataTabId = String(sessionStorage.getItem(DATA_TAB_KEY) || "").trim();
    if (dataTabId === "viewersChart") {
      dataTabId = "metricsChart";
      metricsChartMode = "viewers";
    } else if (dataTabId === "chatChart") {
      dataTabId = "metricsChart";
      metricsChartMode = "chat";
    } else if (dataTabId === "firstChat") {
      dataTabId = "metricsChart";
    }
  } catch (_) {
    /* ignore */
  }
  if (isMeMonitor() && dataTabId === "ssapi") {
    dataTabId = "";
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

  function formatHistoryDateLabel(dateStr, count) {
    const raw = String(dateStr || "").trim();
    if (!raw) return "—";
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return raw;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    const label = d.toLocaleDateString("ko-KR", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
    const n = Number(count) || 0;
    return n > 0 ? `${label} · ${n}회` : label;
  }

  function formatHistoryClock(iso) {
    const s = String(iso || "").trim();
    if (!s) return "—";
    const d = new Date(s.endsWith("Z") || s.includes("+") ? s : `${s}Z`);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Seoul",
    });
  }

  function isBroadcastLive(data) {
    if (!data) return false;
    if (activeTab === "me") {
      return Boolean(data.live?.active);
    }
    const sess = data.sirian?.session || {};
    return Boolean(sess.active);
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

  function chartMinuteMs(at) {
    const d = parseChartDate(at);
    if (!d) return 0;
    return Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes()
    );
  }

  function applyViewerPeakToPoints(points, counts) {
    const list = (Array.isArray(points) ? points : []).map((p) => ({
      at: String(p.at),
      v: Number(p.v),
    }));
    const peak = Math.max(0, Number(counts?.peakViewers) || 0);
    const peakMs = chartMinuteMs(counts?.peakViewersAt);
    if (peak <= 0 || !peakMs) return list;
    const hit = list.find((p) => chartMinuteMs(p.at) === peakMs);
    if (hit) {
      hit.v = Math.max(hit.v, peak);
      return list;
    }
    const at = new Date(peakMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    list.push({ at, v: peak });
    list.sort((a, b) => chartMinuteMs(a.at) - chartMinuteMs(b.at));
    return list;
  }

  function peakSeriesPoint(points) {
    let best = null;
    for (const p of Array.isArray(points) ? points : []) {
      if (!p || !Number.isFinite(Number(p.v))) continue;
      if (!best || p.v > best.v || (p.v === best.v && String(p.at) < String(best.at))) {
        best = p;
      }
    }
    return best;
  }

  function nearestSeriesPointAtTime(points, at) {
    const want = parseChartDate(at)?.getTime();
    if (!want) return null;
    let best = null;
    let bestDist = Infinity;
    for (const p of Array.isArray(points) ? points : []) {
      const t = parseChartDate(p?.at)?.getTime();
      if (t == null) continue;
      const d = Math.abs(t - want);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  }

  function resolveViewerPeak(points, counts) {
    const seriesPeak = peakSeriesPoint(points);
    const hinted = nearestSeriesPointAtTime(points, counts?.peakViewersAt);
    // 힌트 시각이 한 분 앞으로 붙으면 최고점이 아닌 오르막(1872 등)을 집을 수 있다.
    const peak =
      seriesPeak && hinted && Number(hinted.v) >= Number(seriesPeak.v) ? hinted : seriesPeak || hinted;
    const at = String(peak?.at || "").trim();
    const v = Math.max(Number(counts?.peakViewers) || 0, Number(peak?.v) || 0);
    if (!at || v <= 0) return null;
    return { kind: "viewers", at, v };
  }

  function resolveChatPeak(points) {
    const p = peakSeriesPoint(points);
    if (!p || p.v <= 0) return null;
    return { kind: "chat", at: p.at, v: p.v };
  }

  function renderChartToolbar({ jumps, meta, showLegend = false }) {
    const items = (Array.isArray(jumps) ? jumps : []).filter(Boolean);
    const peaksHtml = items.length ? renderPeakJumpBar(items) : "";
    const metaText = String(meta || "").trim();
    const metaHtml = metaText ? `<p class="ending-dev-chart__meta">${esc(metaText)}</p>` : "";
    const legendHtml = showLegend
      ? `<div class="ending-dev-chart__legend" aria-hidden="true">
        <span class="ending-dev-chart__legend-item ending-dev-chart__legend-item--viewers">시청자</span>
        <span class="ending-dev-chart__legend-item ending-dev-chart__legend-item--chat">채팅 화력</span>
      </div>`
      : "";
    if (!peaksHtml && !metaHtml && !legendHtml) return "";
    return `<div class="ending-dev-chart__toolbar">
      ${peaksHtml}
      <div class="ending-dev-chart__toolbar-side">${metaHtml}${legendHtml}</div>
    </div>`;
  }

  function renderPeakJumpBar(jumps) {
    const items = (Array.isArray(jumps) ? jumps : []).filter(Boolean);
    if (!items.length) return "";
    return `<div class="ending-dev-chart__jumps" role="group" aria-label="피크 바로가기">
      ${items
        .map((j) => {
          const isChat = j.kind === "chat";
          const label = isChat ? "최고 화력" : "최고 시청";
          const value = isChat ? `${fmtNum(j.v)}회/분` : `${fmtNum(j.v)}명`;
          const clock = chartClockLabel(j.at);
          return `<button type="button" class="ending-dev-chart__jump is-${esc(
            j.kind
          )}" data-peak-jump="${esc(j.at)}">
            <span class="ending-dev-chart__jump-k">${esc(label)}</span>
            <span class="ending-dev-chart__jump-v"><strong>${esc(value)}</strong><span class="ending-dev-chart__jump-t">${esc(clock)}</span></span>
          </button>`;
        })
        .join("")}
    </div>`;
  }

  function bindPeakJumpButtons(root, wrap) {
    if (!root || !wrap) return;
    root.querySelectorAll("[data-peak-jump]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const at = String(btn.getAttribute("data-peak-jump") || "").trim();
        if (!at) return;
        wrap.dispatchEvent(new CustomEvent("ending-chart-jump", { detail: { at } }));
      });
    });
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
    const n = Math.max(Number(viewerN) || 0, Number(chatN) || 0);
    return n > 0 ? `${n}분` : "대기";
  }

  const DATA_TAB_TITLES = {
    metricsChart: "종합",
    chat: "채팅",
    watch: "시청시간",
    donation: "후원",
    signature: "시그풍",
    fanclub: "팬클럽",
    subscribe_gift: "구독선물",
    subscribe: "신규구독",
    subscribe_renew: "연속구독",
    emoticon: "이모티콘",
    mission: "미션",
    ssapi: "SSAPI",
    topfan: "열혈",
    quickview: "퀵뷰",
  };

  function dataTabTitle(id, fallback) {
    return DATA_TAB_TITLES[id] || String(fallback || id || "").trim() || id;
  }

  const CHART_W = 680;
  const CHART_H = 176;
  const CHART_W_MIN = 320;
  let activeChartLayoutWidth = CHART_W;
  let chartLayoutWidthCache = CHART_W;
  let chartLayoutRerenderTimer = null;
  const CHART_HEADROOM = 0.12;
  const CHART_X_INSET = 6;
  const CHART_Y_INSET = 5;
  const CHART_ZOOM_MIN = 1;
  const CHART_ZOOM_MAX = 8;
  const CHART_ZOOM_DEFAULT = 1;
  const CHART_PAD_SINGLE = { t: 18, r: 40, b: 30, l: 48 };
  const CHART_PAD_DUAL = { t: 18, r: 58, b: 30, l: 48 };

  function chartZoomLevel() {
    const stored = Number(sessionStorage.getItem(CHART_ZOOM_STORAGE_KEY));
    if (Number.isFinite(stored) && stored >= CHART_ZOOM_MIN && stored <= CHART_ZOOM_MAX) {
      return stored;
    }
    return CHART_ZOOM_DEFAULT;
  }

  function setChartZoomLevel(zoom) {
    const z = Math.max(CHART_ZOOM_MIN, Math.min(CHART_ZOOM_MAX, Number(zoom) || CHART_ZOOM_DEFAULT));
    const prevZoom = chartZoomLevel();
    const prevPan = chartPanLevel();
    try {
      sessionStorage.setItem(CHART_ZOOM_STORAGE_KEY, String(z));
    } catch (_) {
      /* ignore */
    }
    if (chartIsFitZoom(z)) {
      try {
        sessionStorage.setItem(CHART_PAN_STORAGE_KEY, "0");
      } catch (_) {
        /* ignore */
      }
    } else {
      const range = chartFullRangeMs(chartActiveFullTimeRange());
      if (range) {
        const { fullMinMs, fullMaxMs } = range;
        let centerMs;
        if (chartIsFitZoom(prevZoom)) {
          centerMs = (fullMinMs + fullMaxMs) / 2;
        } else {
          const oldWin = chartVisibleWindow(fullMinMs, fullMaxMs, prevZoom, prevPan);
          centerMs = (oldWin.viewMinMs + oldWin.viewMaxMs) / 2;
        }
        const nextPan = chartPanForCenterTime(fullMinMs, fullMaxMs, centerMs, z);
        try {
          sessionStorage.setItem(CHART_PAN_STORAGE_KEY, String(nextPan));
        } catch (_) {
          /* ignore */
        }
      }
    }
    if (!lastData) return;
    refreshMetricsChartView();
  }

  function chartPanLevel() {
    const stored = Number(sessionStorage.getItem(CHART_PAN_STORAGE_KEY));
    if (Number.isFinite(stored) && stored >= 0 && stored <= 1) return stored;
    return 0;
  }

  function setChartPanLevel(pan, { rerender = true } = {}) {
    const p = Math.max(0, Math.min(1, Number(pan) || 0));
    try {
      sessionStorage.setItem(CHART_PAN_STORAGE_KEY, String(p));
    } catch (_) {
      /* ignore */
    }
    if (!rerender || !lastData) return;
    refreshMetricsChartView();
  }

  /** zoom·pan에 맞춰 X축에 그릴 시간 구간(전체 타임라인 대비). */
  function chartVisibleWindow(fullMinMs, fullMaxMs, zoom = chartZoomLevel(), pan = chartPanLevel()) {
    const span = Math.max(60_000, fullMaxMs - fullMinMs);
    const z = Math.max(CHART_ZOOM_MIN, Math.min(CHART_ZOOM_MAX, Number(zoom) || CHART_ZOOM_DEFAULT));
    const visible = span / z;
    const maxPanMs = Math.max(0, span - visible);
    const p = Math.max(0, Math.min(1, Number(pan) || 0));
    const viewMinMs = fullMinMs + maxPanMs * p;
    return {
      viewMinMs,
      viewMaxMs: viewMinMs + visible,
      fullMinMs,
      fullMaxMs,
      visibleMs: visible,
      maxPanMs,
    };
  }

  function chartPanForCenterTime(fullMinMs, fullMaxMs, centerMs, zoom = chartZoomLevel()) {
    const win = chartVisibleWindow(fullMinMs, fullMaxMs, zoom, 0);
    if (win.maxPanMs <= 0) return 0;
    const targetStart = Number(centerMs) - win.visibleMs / 2;
    const start = Math.max(fullMinMs, Math.min(fullMinMs + win.maxPanMs, targetStart));
    return (start - fullMinMs) / win.maxPanMs;
  }

  function renderChartPanScroll() {
    if (chartIsFitZoom()) return "";
    const zoom = chartZoomLevel();
    return `<div class="ending-dev-chart__pan-scroll" data-chart-pan-scroll aria-label="그래프 시간 이동">
      <div class="ending-dev-chart__pan-spacer" style="width:${zoom * 100}%"></div>
    </div>`;
  }

  function syncChartPanScroll(root) {
    if (!root) return;
    root.querySelectorAll("[data-chart-pan-scroll]").forEach((scroller) => {
      if (chartIsFitZoom()) {
        scroller.hidden = true;
        scroller.scrollLeft = 0;
        clearChartPanSlide(scroller.closest(".ending-dev-chart"));
        return;
      }
      scroller.hidden = false;
      const zoom = chartZoomLevel();
      const spacer = scroller.querySelector(".ending-dev-chart__pan-spacer");
      if (spacer) spacer.style.width = `${zoom * 100}%`;
      const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      scroller.scrollLeft = Math.round(chartPanLevel() * max);
      clearChartPanSlide(scroller.closest(".ending-dev-chart"));
    });
  }

  function chartPanScrollerMetrics(scroller) {
    const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    return {
      max,
      committedLeft: Math.round(chartPanLevel() * max),
    };
  }

  function clearChartPanSlide(scope) {
    if (!scope) return;
    const wraps = scope.matches?.("[data-chart-wrap]")
      ? [scope]
      : [...(scope.querySelectorAll?.("[data-chart-wrap]") || [])];
    wraps.forEach((wrap) => {
      wrap.style.transition = "";
      wrap.style.transform = "";
    });
  }

  function updateChartPanSlide(scroller) {
    const chart = scroller?.closest?.(".ending-dev-chart");
    const wrap = chart?.querySelector?.("[data-chart-wrap]");
    if (!wrap) return;
    const { committedLeft } = chartPanScrollerMetrics(scroller);
    const slidePx = scroller.scrollLeft - committedLeft;
    if (Math.abs(slidePx) < 0.5) {
      wrap.style.transition = "";
      wrap.style.transform = "";
      return;
    }
    wrap.style.transition = "none";
    wrap.style.transform = `translate3d(${-slidePx}px, 0, 0)`;
  }

  function commitChartPanFromScroller(scroller) {
    if (!scroller) return;
    const { max } = chartPanScrollerMetrics(scroller);
    const pan = max > 0 ? scroller.scrollLeft / max : 0;
    const cur = chartPanLevel();
    clearChartPanSlide(scroller.closest(".ending-dev-chart"));
    if (Math.abs(cur - pan) < 0.002) return;
    setChartPanLevel(pan);
  }

  let chartPanScrollTimer = null;

  function chartActiveFullTimeRange() {
    const wrap = els.dataBody?.querySelector?.("[data-chart-wrap]");
    if (wrap) {
      const fullMinMs = Number(wrap.dataset.chartFullMin);
      const fullMaxMs = Number(wrap.dataset.chartFullMax);
      if (Number.isFinite(fullMinMs) && Number.isFinite(fullMaxMs) && fullMaxMs > fullMinMs) {
        return { fullMinMs, fullMaxMs };
      }
    }
    if (!lastData) return null;
    const acc = resolveAccount(lastData, activeTab);
    const extras = devLiveExtras((acc.session || {}).collected || {});
    return chartTimeRangeFromPoints(
      seriesPoints(extras?.metricsSeries?.viewers),
      seriesPoints(extras?.metricsSeries?.chats)
    );
  }

  function chartFullRangeMs(range) {
    if (!range) return null;
    const fullMinMs = Number(range.fullMinMs ?? range.minMs);
    const fullMaxMs = Number(range.fullMaxMs ?? range.maxMs);
    if (!Number.isFinite(fullMinMs) || !Number.isFinite(fullMaxMs) || fullMaxMs <= fullMinMs) {
      return null;
    }
    return { fullMinMs, fullMaxMs };
  }

  function chartPanWheelDelta(ev) {
    let dx = Number(ev?.deltaX) || 0;
    if (Math.abs(dx) < 0.5 && ev?.shiftKey) {
      dx = Number(ev?.deltaY) || 0;
    }
    return dx;
  }

  function scheduleChartPanFromWheel(wrap, deltaPx) {
    if (!wrap || chartIsFitZoom()) return;
    const chart = wrap.closest(".ending-dev-chart");
    const scroller = chart?.querySelector?.("[data-chart-pan-scroll]");
    if (!scroller) return;
    const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    if (max <= 0) return;
    scroller.scrollLeft = Math.max(0, Math.min(max, scroller.scrollLeft + deltaPx));
    scheduleChartPanFromScroll(scroller);
  }

  function onChartPanWheel(ev) {
    if (chartIsFitZoom()) return;
    const chart = ev.target?.closest?.(".ending-dev-chart");
    if (!chart) return;
    const viewport = chart.querySelector(".ending-dev-chart__viewport");
    const wrap = chart.querySelector("[data-chart-wrap]");
    if (!viewport || !wrap) return;
    const dx = chartPanWheelDelta(ev);
    if (Math.abs(dx) < 0.5) return;
    ev.preventDefault();
    scheduleChartPanFromWheel(wrap, dx);
  }

  function scheduleChartPanFromScroll(scroller) {
    if (!scroller) return;
    updateChartPanSlide(scroller);
    clearTimeout(chartPanScrollTimer);
    chartPanScrollTimer = setTimeout(() => commitChartPanFromScroller(scroller), 140);
  }

  function chartZoomSliderValue(zoom) {
    const z = Math.max(CHART_ZOOM_MIN, Math.min(CHART_ZOOM_MAX, Number(zoom) || CHART_ZOOM_DEFAULT));
    if (CHART_ZOOM_MAX <= CHART_ZOOM_MIN) return 0;
    return Math.round(((z - CHART_ZOOM_MIN) / (CHART_ZOOM_MAX - CHART_ZOOM_MIN)) * 100);
  }

  function chartZoomFromSlider(value) {
    const pct = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
    return CHART_ZOOM_MIN + pct * (CHART_ZOOM_MAX - CHART_ZOOM_MIN);
  }

  function chartZoomLabel(zoom) {
    const z = Math.max(CHART_ZOOM_MIN, Math.min(CHART_ZOOM_MAX, Number(zoom) || CHART_ZOOM_DEFAULT));
    if (z <= CHART_ZOOM_MIN + 0.001) return "전체";
    return `${Math.round(z * 100)}%`;
  }

  function chartIsFitZoom(zoom = chartZoomLevel()) {
    return Number(zoom) <= CHART_ZOOM_MIN + 0.001;
  }

  function chartLayoutWidth(rootEl) {
    const root = rootEl || els.dataBody;
    if (!root) return CHART_W;
    const viewport = root.querySelector?.(".ending-dev-chart__viewport");
    if (viewport?.clientWidth >= CHART_W_MIN) return Math.round(viewport.clientWidth);
    const digest = root.querySelector?.(".ending-dev-digest");
    if (digest?.clientWidth >= CHART_W_MIN) return Math.round(digest.clientWidth);
    const overview = root.querySelector?.(".ending-dev-overview-panel");
    if (overview?.clientWidth >= CHART_W_MIN) return Math.round(overview.clientWidth);
    const panel = root.querySelector?.(".ending-dev-data-panel");
    if (panel?.clientWidth >= CHART_W_MIN) return Math.round(panel.clientWidth - 32);
    if (root.clientWidth >= CHART_W_MIN) return Math.round(root.clientWidth - 32);
    return CHART_W;
  }

  function scheduleChartLayoutRerender() {
    clearTimeout(chartLayoutRerenderTimer);
    chartLayoutRerenderTimer = setTimeout(() => {
      if (!lastData || !els.dataBody) return;
      const nextW = chartLayoutWidth(els.dataBody);
      if (Math.abs(nextW - chartLayoutWidthCache) < 8) return;
      chartLayoutWidthCache = nextW;
      activeChartLayoutWidth = nextW;
      scrollRestorePending = captureScrollState(els.dataBody);
      const acc = resolveAccount(lastData, activeTab);
      renderDataPanel(acc.sections, (acc.session || {}).collected || {});
    }, 120);
  }

  function chartLogicalWidth() {
    return activeChartLayoutWidth || CHART_W;
  }

  function renderChartZoomControls() {
    const zoom = chartZoomLevel();
    return `<div class="ending-dev-chart__zoom" role="group" aria-label="그래프 X축 확대">
      <span class="ending-dev-chart__zoom-label">X축</span>
      <button type="button" class="ending-dev-chart__zoom-btn" data-chart-zoom="out" aria-label="축소">−</button>
      <button type="button" class="ending-dev-chart__zoom-btn" data-chart-zoom="in" aria-label="확대">+</button>
      <button type="button" class="ending-dev-chart__zoom-btn ending-dev-chart__zoom-btn--fit" data-chart-zoom="fit" aria-label="전체 보기">전체</button>
      <span class="ending-dev-chart__zoom-readout" data-chart-zoom-readout>${esc(chartZoomLabel(zoom))}</span>
    </div>`;
  }

  function chartTimeTickTimes(minMs, maxMs, chartWidthPx) {
    const spanMs = Math.max(60_000, maxMs - minMs);
    const intervals = [
      5 * 60_000,
      10 * 60_000,
      15 * 60_000,
      30 * 60_000,
      60 * 60_000,
      2 * 60 * 60_000,
      3 * 60 * 60_000,
      4 * 60 * 60_000,
    ];
    const minLabelGapPx = 58;
    const innerPx = Math.max(120, chartWidthPx);
    const maxTicks = Math.max(3, Math.floor(innerPx / minLabelGapPx));
    const minGapMs = (minLabelGapPx / innerPx) * spanMs;
    let intervalMs = intervals[intervals.length - 1];
    for (const candidate of intervals) {
      if (Math.ceil(spanMs / candidate) + 1 <= maxTicks) {
        intervalMs = candidate;
        break;
      }
    }
    const times = [];
    let t = Math.ceil(minMs / intervalMs) * intervalMs;
    while (t <= maxMs + intervalMs * 0.05) {
      times.push(t);
      t += intervalMs;
    }
    if (!times.length || times[0] - minMs > minGapMs) {
      times.unshift(minMs);
    }
    if (maxMs - times[times.length - 1] > minGapMs) {
      times.push(maxMs);
    }
    const deduped = [];
    for (const ms of times) {
      if (!deduped.length || ms - deduped[deduped.length - 1] >= minGapMs * 0.95) {
        deduped.push(ms);
      }
    }
    return deduped;
  }

  /** x 위치 기준으로 겹치는 시간 라벨을 제거한다. 끝 시각은 간격 눈금보다 우선. */
  function chartFilterTimeTicksForLabels(tickTimes, xAtTime, minGapPx = 58) {
    const list = (Array.isArray(tickTimes) ? tickTimes : [])
      .map((ms) => ({ ms, x: Number(xAtTime(new Date(ms).toISOString())) }))
      .filter((row) => Number.isFinite(row.x));
    if (list.length <= 1) return list.map((row) => row.ms);

    const kept = [list[0]];
    for (let i = 1; i < list.length; i++) {
      const item = list[i];
      const prev = kept[kept.length - 1];
      const gap = item.x - prev.x;
      const isLast = i === list.length - 1;
      if (gap >= minGapPx) {
        kept.push(item);
        continue;
      }
      if (!isLast) continue;
      if (kept.length > 1) {
        const prev2 = kept[kept.length - 2];
        if (item.x - prev2.x >= minGapPx) {
          kept.pop();
          kept.push(item);
        }
      }
    }
    return kept.map((row) => row.ms);
  }

  function chartIndexTickIndices(count, chartWidthPx) {
    const n = Math.max(1, Number(count) || 1);
    if (n <= 1) return [0];
    const minLabelGapPx = 54;
    const maxTicks = Math.max(3, Math.floor(Math.max(120, chartWidthPx) / minLabelGapPx));
    const step = Math.max(1, Math.ceil((n - 1) / Math.max(1, maxTicks - 1)));
    const indices = [];
    for (let i = 0; i < n; i += step) indices.push(i);
    if (indices[indices.length - 1] !== n - 1) indices.push(n - 1);
    return indices;
  }

  function renderChartTimeAxisDual(tickTimes, xAtTime, pad, w, h) {
    const yGridBottom = pad.t + (h - pad.t - pad.b);
    const yLabel = h - 8;
    const labels = chartFilterTimeTicksForLabels(tickTimes, xAtTime, 58);
    return tickTimes
      .map((ms, i) => {
        const at = new Date(ms).toISOString();
        const x = xAtTime(at);
        const anchor = i === 0 ? "start" : i === tickTimes.length - 1 ? "end" : "middle";
        const grid = `<line class="ending-dev-chart__grid-v" x1="${x.toFixed(1)}" y1="${pad.t}" x2="${x.toFixed(1)}" y2="${yGridBottom.toFixed(1)}" />`;
        if (!labels.includes(ms)) return grid;
        const labelIdx = labels.indexOf(ms);
        const labelAnchor =
          labelIdx === 0 ? "start" : labelIdx === labels.length - 1 ? "end" : "middle";
        return `${grid}
          <text class="ending-dev-chart__xlabel" x="${x.toFixed(1)}" y="${yLabel}" text-anchor="${labelAnchor}">${esc(
          chartClockLabel(at)
        )}</text>`;
      })
      .join("");
  }

  function renderChartTimeAxisIndexed(points, xAt, pad, w, h) {
    const innerW = w - pad.l - pad.r;
    const indices = chartIndexTickIndices(points.length, innerW);
    const yGridBottom = pad.t + (h - pad.t - pad.b);
    const yLabel = h - 8;
    return indices
      .map((idx, i) => {
        const x = xAt(idx);
        const anchor = i === 0 ? "start" : i === indices.length - 1 ? "end" : "middle";
        return `<line class="ending-dev-chart__grid-v" x1="${x.toFixed(1)}" y1="${pad.t}" x2="${x.toFixed(1)}" y2="${yGridBottom.toFixed(1)}" />
          <text class="ending-dev-chart__xlabel" x="${x.toFixed(1)}" y="${yLabel}" text-anchor="${anchor}">${esc(
          chartClockLabel(points[idx].at)
        )}</text>`;
      })
      .join("");
  }

  function chartScaleMax(peak) {
    const p = Math.max(0, Number(peak) || 0);
    if (p <= 0) return 1;
    return Math.max(1, Math.ceil(p * (1 + CHART_HEADROOM)));
  }

  function chartPixelWidth(_count, _pad, minW = CHART_W) {
    return chartLogicalWidth();
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
      const t = (ms - minMs) / spanMs;
      return pad.l + xInset + t * xSpan;
    };
    const yViewers = (v) => pad.t + yInset + ySpan - (v / maxViewers) * ySpan;
    const yChats = (v) => pad.t + yInset + ySpan - (v / maxChats) * ySpan;
    return { innerW, innerH, xAtTime, yViewers, yChats, xInset, yInset };
  }

  /** 보이는 시간 구간(+경계 1점)만 골라 X축 비율 재계산 시 왜곡을 막는다. */
  function chartSeriesInWindow(points, viewMinMs, viewMaxMs) {
    const minMs = Number(viewMinMs);
    const maxMs = Number(viewMaxMs);
    const list = (Array.isArray(points) ? points : [])
      .map((p) => ({ p, ms: parseChartDate(p?.at)?.getTime() }))
      .filter((row) => row.ms != null)
      .sort((a, b) => a.ms - b.ms);
    if (!list.length) return [];
    if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return list.map((row) => row.p);

    let before = null;
    let after = null;
    const inWindow = [];
    for (const row of list) {
      if (row.ms < minMs) {
        before = row.p;
        continue;
      }
      if (row.ms > maxMs) {
        if (!after) after = row.p;
        break;
      }
      inWindow.push(row.p);
    }
    const out = [];
    if (before) out.push(before);
    out.push(...inWindow);
    if (after) out.push(after);
    if (out.length) return out;

    const target = (minMs + maxMs) / 2;
    let best = list[0];
    let bestDist = Math.abs(best.ms - target);
    for (const row of list) {
      const dist = Math.abs(row.ms - target);
      if (dist < bestDist) {
        best = row;
        bestDist = dist;
      }
    }
    return [best.p];
  }

  function chartTimeInWindow(at, viewMinMs, viewMaxMs) {
    const ms = parseChartDate(at)?.getTime();
    if (!ms) return false;
    return ms >= Number(viewMinMs) && ms <= Number(viewMaxMs);
  }

  function renderChartClipDef(pad, w, h) {
    const yBottom = pad.t + (h - pad.t - pad.b);
    return `<defs><clipPath id="ending-dev-chart-clip"><rect x="${pad.l}" y="${pad.t}" width="${Math.max(
      0,
      w - pad.l - pad.r
    )}" height="${Math.max(0, yBottom - pad.t)}" /></clipPath></defs>`;
  }

  /** 실측 점을 지나고, 뾰족한 피크에서 아래로 빠지지 않게 잇는다. */
  function pathSmoothFromXY(pts) {
    const list = Array.isArray(pts) ? pts : [];
    if (!list.length) return "";
    const fmt = (n) => Number(n).toFixed(1);
    if (list.length === 1) return `M${fmt(list[0].x)},${fmt(list[0].y)}`;
    if (list.length === 2) {
      return `M${fmt(list[0].x)},${fmt(list[0].y)} L${fmt(list[1].x)},${fmt(list[1].y)}`;
    }
    const n = list.length;
    const dx = [];
    const slope = [];
    for (let i = 0; i < n - 1; i++) {
      const w = list[i + 1].x - list[i].x;
      dx[i] = w;
      slope[i] = w ? (list[i + 1].y - list[i].y) / w : 0;
    }
    const d = new Array(n);
    d[0] = slope[0];
    d[n - 1] = slope[n - 2];
    for (let i = 1; i < n - 1; i++) {
      d[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
    }
    for (let i = 0; i < n - 1; i++) {
      if (Math.abs(slope[i]) < 1e-12) {
        d[i] = 0;
        d[i + 1] = 0;
        continue;
      }
      const a = d[i] / slope[i];
      const b = d[i + 1] / slope[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        d[i] = t * a * slope[i];
        d[i + 1] = t * b * slope[i];
      }
    }
    let path = `M${fmt(list[0].x)},${fmt(list[0].y)}`;
    for (let i = 0; i < n - 1; i++) {
      const p0 = list[i];
      const p1 = list[i + 1];
      const seg = dx[i] / 3;
      path += ` C${fmt(p0.x + seg)},${fmt(p0.y + d[i] * seg)} ${fmt(p1.x - seg)},${fmt(
        p1.y - d[i + 1] * seg
      )} ${fmt(p1.x)},${fmt(p1.y)}`;
    }
    return path;
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
      return `<p class="ending-dev-empty ending-dev-data-empty">없음</p>`;
    }
    const img = String(fc.imageUrl || "").trim();
    const msg = String(fc.message || fc.emoticonName || "").trim();
    const at = String(fc.atLabel || "").trim();
    const thumb = img
      ? `<img class="ending-dev-first-chat__emo" src="${esc(mediaUrl(img))}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
      : "";
    const text = !img && msg ? `<p class="ending-dev-first-chat__msg">“${esc(msg)}”</p>` : "";
    return `<div class="ending-dev-first-chat ending-dev-first-chat--compact">
      ${thumb}
      <div class="ending-dev-first-chat__body">
        <p class="ending-dev-first-chat__name">${esc(fc.name)}</p>
        ${text}
        ${at ? `<p class="ending-dev-first-chat__at">${esc(at)}</p>` : ""}
      </div>
    </div>`;
  }

  function normalizeTitleHistory(rows) {
    return (Array.isArray(rows) ? rows : [])
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const title = String(row.title || "").trim();
        if (!title) return null;
        const at = String(row.at || "").trim();
        const clock = String(row.clock || "").trim() || chartClockLabel(at);
        return { title, at, clock };
      })
      .filter(Boolean);
  }

  function renderTitleHistoryPanel(rows) {
    const list = normalizeTitleHistory(rows);
    if (!list.length) {
      return `<p class="ending-dev-empty ending-dev-data-empty">없음</p>`;
    }
    return `<ol class="ending-dev-titles">
      ${list
        .map(
          (row, i) => `<li>
          <span class="ending-dev-titles__n">${i + 1}</span>
          <span class="ending-dev-titles__clock">${esc(row.clock || "—")}</span>
          <span class="ending-dev-titles__name" title="${esc(row.title)}">${esc(row.title)}</span>
        </li>`
        )
        .join("")}
    </ol>`;
  }

  function normalizeMissionRuns(rows) {
    return (Array.isArray(rows) ? rows : [])
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const title = String(row.title || "").trim();
        const status = String(row.status || "pending").trim() || "pending";
        const kind = String(row.kind || "challenge").trim() || "challenge";
        const donors = (Array.isArray(row.donors) ? row.donors : [])
          .map((d) => {
            if (!d || typeof d !== "object") return null;
            const name = String(d.name || "").trim();
            if (!name) return null;
            return { name, value: String(d.value || "").trim() || `${fmtNum(d.total)}개` };
          })
          .filter(Boolean);
        return {
          title: title || `${row.kindLabel || "미션"}`,
          status,
          statusLabel: String(row.statusLabel || "").trim() || status,
          kind,
          kindLabel: String(row.kindLabel || "").trim() || kind,
          total: Number(row.total) || 0,
          startedAt: String(row.startedAt || "").trim(),
          endedAt: String(row.endedAt || "").trim(),
          winner: String(row.winner || "").trim(),
          donors,
        };
      })
      .filter(Boolean);
  }

  function normalizeDonationNotes(rows) {
    return (Array.isArray(rows) ? rows : [])
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const text = String(row.text || "").trim();
        if (!text) return null;
        return {
          name: String(row.name || "").trim() || "익명",
          text,
          value: String(row.value || "").trim(),
          count: Number(row.count) || 0,
          at: String(row.at || "").trim(),
        };
      })
      .filter(Boolean);
  }

  function renderDonationNotes(rows) {
    const list = normalizeDonationNotes(rows);
    if (!list.length) return "";
    return `<ol class="ending-dev-notes">
      ${list
        .map((row) => {
          const when = row.at ? `<span class="ending-dev-notes__at">${esc(chartClockLabel(row.at))}</span>` : "";
          const amt = row.value ? `<span class="ending-dev-notes__amt">${esc(row.value)}</span>` : "";
          return `<li>
            <span class="ending-dev-notes__name">${esc(row.name)}</span>
            ${amt}
            ${when}
            <p class="ending-dev-notes__text">${esc(row.text)}</p>
          </li>`;
        })
        .join("")}
    </ol>`;
  }

  function ssapiPhaseLabel(phase) {
    const key = String(phase || "").trim().toLowerCase();
    if (key === "receive") return "시작";
    if (key === "settle") return "정산";
    if (key === "result") return "결과";
    if (key === "donation") return "후원";
    return key || "이벤트";
  }

  function normalizeSsapiAssist(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const events = (Array.isArray(src.events) ? src.events : []).map((row) => {
      if (!row || typeof row !== "object") return null;
      const kind = String(row.kind || "").trim() === "donation" ? "donation" : "mission";
      return {
        id: String(row.id || ""),
        kind,
        at: String(row.at || "").trim(),
        phase: String(row.phase || "").trim(),
        phaseLabel: ssapiPhaseLabel(row.phase),
        key: String(row.key || "").trim(),
        title: String(row.title || "").trim(),
        status: String(row.status || "").trim(),
        statusLabel: String(row.statusLabel || "").trim(),
        winner: String(row.winner || "").trim(),
        name: String(row.name || "").trim(),
        count: Number(row.count) || 0,
        value: String(row.value || "").trim(),
        text: String(row.text || "").trim(),
      };
    }).filter(Boolean);
    const missions = events.filter((row) => row.kind === "mission");
    const donations = events.filter((row) => row.kind === "donation");
    return {
      connected: Boolean(src.connected),
      hasStatus: Boolean(src.hasStatus),
      lastError: String(src.lastError || "").trim(),
      lastAction: String(src.lastAction || "").trim(),
      lastPhase: String(src.lastPhase || "").trim(),
      lastTitle: String(src.lastTitle || "").trim(),
      lastIngestAt: String(src.lastIngestAt || "").trim(),
      updatedAt: String(src.updatedAt || "").trim(),
      stationId: String(src.stationId || "").trim(),
      events,
      missions,
      donations,
      missionCount: missions.length,
      donationCount: donations.length,
      eventCount: events.length,
    };
  }

  function renderSsapiStatus(ssapi) {
    const on = Boolean(ssapi?.connected);
    const err = String(ssapi?.lastError || "").trim();
    const when = ssapi?.lastIngestAt || ssapi?.updatedAt || "";
    const bits = [
      on ? "소켓 연결" : err ? `끊김 · ${err}` : "대기",
      ssapi?.stationId ? `채널 ${ssapi.stationId}` : "",
      when ? chartClockLabel(when) : "",
      ssapi?.lastTitle ? ssapi.lastTitle : "",
    ].filter(Boolean);
    return `<p class="ending-dev-ssapi__status ${on ? "is-on" : err ? "is-warn" : ""}">${esc(
      bits.join(" · ") || "SSAPI 상태 없음"
    )}</p>`;
  }

  function renderSsapiMissionList(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      return `<p class="ending-dev-empty ending-dev-data-empty">미션 이벤트 없음</p>`;
    }
    return `<ol class="ending-dev-ssapi-list">
      ${list
        .map((row) => {
          const title = row.title || "미션";
          const who = row.name ? `<span class="ending-dev-ssapi-list__name">${esc(row.name)}</span>` : "";
          const amt = row.value ? `<span class="ending-dev-ssapi-list__amt">${esc(row.value)}</span>` : "";
          const extra = [
            row.statusLabel && row.phase === "result" ? row.statusLabel : "",
            row.winner ? `승 ${row.winner}` : "",
            row.key ? row.key : "",
          ]
            .filter(Boolean)
            .join(" · ");
          return `<li>
            <span class="ending-dev-ssapi-list__phase is-${esc(row.phase || "event")}">${esc(row.phaseLabel)}</span>
            <span class="ending-dev-ssapi-list__title" title="${esc(title)}">${esc(title)}</span>
            ${who}
            ${amt}
            ${row.at ? `<span class="ending-dev-ssapi-list__at">${esc(chartClockLabel(row.at))}</span>` : ""}
            ${extra ? `<p class="ending-dev-ssapi-list__meta">${esc(extra)}</p>` : ""}
          </li>`;
        })
        .join("")}
    </ol>`;
  }

  function renderSsapiDonationList(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      return `<p class="ending-dev-empty ending-dev-data-empty">별풍 메시지 없음</p>`;
    }
    return `<ol class="ending-dev-notes ending-dev-notes--ssapi">
      ${list
        .map((row) => {
          const when = row.at ? `<span class="ending-dev-notes__at">${esc(chartClockLabel(row.at))}</span>` : "";
          const amt = row.value ? `<span class="ending-dev-notes__amt">${esc(row.value)}</span>` : "";
          return `<li>
            <span class="ending-dev-notes__name">${esc(row.name || "익명")}</span>
            ${amt}
            ${when}
            <p class="ending-dev-notes__text">${esc(row.text)}</p>
          </li>`;
        })
        .join("")}
    </ol>`;
  }

  function renderSsapiPanel(ssapi) {
    const data = normalizeSsapiAssist(ssapi);
    return `<div class="ending-dev-ssapi">
      ${renderSsapiStatus(data)}
      <div class="ending-dev-ssapi__grid">
        <section class="ending-dev-ssapi__card">
          <h5 class="ending-dev-ssapi__h">미션 · ${esc(fmtNum(data.missionCount))}</h5>
          ${renderSsapiMissionList(data.missions)}
        </section>
        <section class="ending-dev-ssapi__card">
          <h5 class="ending-dev-ssapi__h">별풍 메시지 · ${esc(fmtNum(data.donationCount))}</h5>
          ${renderSsapiDonationList(data.donations)}
        </section>
      </div>
    </div>`;
  }

  function renderMissionRunsPanel(rows) {
    const list = normalizeMissionRuns(rows);
    if (!list.length) {
      return `<p class="ending-dev-empty ending-dev-data-empty">미션 없음</p>`;
    }
    return `<ol class="ending-dev-missions">
      ${list
        .map((row) => {
          const donors = row.donors.length
            ? `<p class="ending-dev-missions__donors">${row.donors
                .slice(0, 8)
                .map((d) => `${esc(d.name)} ${esc(d.value)}`)
                .join(" · ")}${row.donors.length > 8 ? ` 외 ${row.donors.length - 8}명` : ""}</p>`
            : "";
          const when = row.endedAt || row.startedAt;
          return `<li>
            <span class="ending-dev-missions__status is-${esc(row.status)}">${esc(row.statusLabel)}</span>
            <span class="ending-dev-missions__kind">${esc(row.kindLabel)}</span>
            <span class="ending-dev-missions__title" title="${esc(row.title)}">${esc(row.title)}</span>
            <span class="ending-dev-missions__total">${row.total ? `${esc(fmtNum(row.total))}개` : "—"}</span>
            ${when ? `<span class="ending-dev-missions__at">${esc(chartClockLabel(when))}</span>` : ""}
            ${row.winner ? `<p class="ending-dev-missions__winner">승 ${esc(row.winner)}</p>` : ""}
            ${donors}
          </li>`;
        })
        .join("")}
    </ol>`;
  }

  function renderMetricsDigest(active, counts, replay, mode) {
    const chart = renderMetricsChartPanel(active?.metricsSeries, counts, replay, mode);
    const titles = normalizeTitleHistory(active?.titleHistory);
    const titleN = titles.length;
    return {
      html: `<div class="ending-dev-digest">
        ${chart.html}
        <div class="ending-dev-digest__grid">
          <section class="ending-dev-digest__card">
            <h5 class="ending-dev-digest__h">첫 채팅</h5>
            ${renderFirstChatPanel(active?.firstChat)}
          </section>
          <section class="ending-dev-digest__card">
            <h5 class="ending-dev-digest__h">방제 변경${titleN ? ` · ${titleN}` : ""}</h5>
            ${renderTitleHistoryPanel(titles)}
          </section>
        </div>
      </div>`,
      bind: chart.bind,
    };
  }

  function parseChartDate(at) {
    const raw = String(at || "").trim();
    if (!raw) return null;
    const d = new Date(raw.endsWith("Z") || raw.includes("+") ? raw : `${raw}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function chartClientXToSvgX(svg, clientX, w) {
    return chartClientToSvg(svg, clientX, 0, w, 1).x;
  }

  function chartClientToSvg(svg, clientX, clientY, w, h) {
    try {
      const ctm = svg?.getScreenCTM?.();
      if (ctm && typeof ctm.inverse === "function") {
        const inv = ctm.inverse();
        return {
          x: inv.a * clientX + inv.c * clientY + inv.e,
          y: inv.b * clientX + inv.d * clientY + inv.f,
        };
      }
    } catch (_) {
      /* fall through */
    }
    const rect = svg?.getBoundingClientRect?.();
    if (!rect?.width) return { x: 0, y: 0 };
    const height = rect.height || 1;
    return {
      x: ((clientX - rect.left) / rect.width) * (Number(w) || rect.width),
      y: ((clientY - rect.top) / height) * (Number(h) || height),
    };
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

  function chartTipEl(wrap) {
    return wrap?.closest?.(".ending-dev-chart")?.querySelector?.("[data-chart-tip]") || null;
  }

  function setChartTipHtml(wrap, html) {
    const tip = chartTipEl(wrap);
    const box = wrap?.closest?.(".ending-dev-chart")?.querySelector?.("[data-chart-readout]");
    if (tip) tip.innerHTML = html || "";
    if (box) box.hidden = false;
  }

  function renderChartMeta(text) {
    const t = String(text || "").trim();
    return t ? `<p class="ending-dev-chart__meta">${esc(t)}</p>` : "";
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
    const rawOffsetSec = Math.max(0, Math.floor((atMs - startMs) / 1000));
    const replayOffsetSec = Number(ctx?.replayOffsetSec);
    const offsetAdjust = Number.isFinite(replayOffsetSec) ? replayOffsetSec : 0;
    const vodRawSec = Math.max(0, rawOffsetSec + offsetAdjust);
    const offsetSec = Math.max(0, vodRawSec - REPLAY_SEEK_LEAD_SEC);
    const offsetLabel = formatOffsetSec(offsetSec);
    if (ctx.active && broadNo) {
      return {
        offsetSec,
        offsetLabel,
        primaryUrl: `https://play.sooplive.co.kr/${encodeURIComponent(sid)}/${encodeURIComponent(broadNo)}`,
        note: "",
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
        note: "",
        canSeek: true,
      };
    }
    if (sid) {
      return {
        offsetSec,
        offsetLabel,
        primaryUrl: `https://www.sooplive.co.kr/station/${encodeURIComponent(sid)}/vods/replay`,
        note: "",
        canSeek: false,
      };
    }
    return null;
  }

  function applyChartReplay(_wrap, replay, pointAt, _summaryText, { openTab = false } = {}) {
    const links = replayLinksForPoint(replay, pointAt);
    if (!links?.primaryUrl) return null;
    if (openTab) {
      window.open(links.primaryUrl, "_blank", "noopener,noreferrer");
    }
    return links;
  }

  function chartPeakLabelBox(x, labelY, text, anchor = "middle") {
    const t = String(text || "");
    const w = Math.max(18, t.length * 6.2 + 8);
    const h = 12;
    let x0 = x - w / 2;
    if (anchor === "end") x0 = x - w;
    if (anchor === "start") x0 = x;
    return { x0, y0: labelY - 10, x1: x0 + w, y1: labelY + 2, anchor, w, h };
  }

  function chartPeakLabelBoxesOverlap(a, b) {
    return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  }

  function chartPeakSideBox(cx, cy, boxW, boxH, pad, w, h, prefer = "right") {
    const gap = 18;
    const plotLeft = pad.l + 2;
    const plotRight = w - pad.r - 2;
    let boxX = prefer === "right" ? cx + gap : cx - gap - boxW;
    if (boxX + boxW > plotRight) boxX = cx - gap - boxW;
    if (boxX < plotLeft) boxX = cx + gap;
    boxX = Math.max(plotLeft, Math.min(plotRight - boxW, boxX));
    let boxY = cy - boxH / 2;
    boxY = Math.max(pad.t + 2, Math.min(h - pad.b - boxH - 2, boxY));
    return { boxX, boxY, boxW, boxH };
  }

  function chartPeakLeadTarget(x, y, boxX, boxY, boxW, boxH) {
    const onLeft = x <= boxX + boxW / 2;
    return {
      x1: x,
      y1: y,
      x2: onLeft ? boxX : boxX + boxW,
      y2: Math.max(boxY + 5, Math.min(boxY + boxH - 5, y)),
    };
  }

  function chartPeakPreferSide(y, pad, h) {
    const plotH = h - pad.t - pad.b;
    return y < pad.t + Math.max(28, plotH * 0.32);
  }

  function renderPeakMark(peak, x, y, extraClass, layout = {}, chartBox = null) {
    if (!peak || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return "";
    const v = Number(peak.v);
    if (!Number.isFinite(v) || v <= 0) return "";
    const pad = chartBox?.pad || CHART_PAD_DUAL;
    const w = chartBox?.w || chartLogicalWidth();
    const h = chartBox?.h || CHART_H;
    const cls = extraClass ? ` ending-dev-chart__peak ${extraClass}` : " ending-dev-chart__peak";
    const text = fmtNum(v);
    const textW = Math.max(18, text.length * 6.2 + 8);
    const boxH = 14;
    const boxW = textW + 8;
    let lx = Number(layout.labelX ?? x);
    let ly = Number(layout.labelY ?? y - 10);
    let anchor = layout.anchor || "middle";
    let badgeX = lx - boxW / 2;
    let badgeY = ly - 11;
    let lead = "";

    const useSide =
      layout.side ||
      (layout.labelX == null && layout.labelY == null && chartPeakPreferSide(y, pad, h));
    if (useSide) {
      const prefer = x < (pad.l + w - pad.r) / 2 ? "right" : "left";
      const box = chartPeakSideBox(x, y, boxW, boxH, pad, w, h, prefer);
      badgeX = box.boxX;
      badgeY = box.boxY;
      anchor = "middle";
      lx = badgeX + boxW / 2;
      ly = badgeY + boxH - 3;
      const leadEnd = chartPeakLeadTarget(x, y, badgeX, badgeY, boxW, boxH);
      lead = `<line class="ending-dev-chart__peak-lead" x1="${leadEnd.x1.toFixed(1)}" y1="${leadEnd.y1.toFixed(1)}" x2="${leadEnd.x2.toFixed(1)}" y2="${leadEnd.y2.toFixed(1)}" vector-effect="non-scaling-stroke" />`;
    } else if (layout.lead) {
      lead = `<line class="ending-dev-chart__peak-lead" x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${lx.toFixed(1)}" y2="${(ly + 2).toFixed(1)}" vector-effect="non-scaling-stroke" />`;
      badgeX = anchor === "end" ? lx - boxW : anchor === "start" ? lx : lx - boxW / 2;
      badgeY = ly - 11;
    } else {
      badgeX = lx - boxW / 2;
      badgeY = ly - 11;
    }

    return `<g class="${cls.trim()}" pointer-events="none">
      ${lead}
      <circle cx="${Number(x).toFixed(1)}" cy="${Number(y).toFixed(1)}" r="3.2" vector-effect="non-scaling-stroke" />
      <rect class="ending-dev-chart__peak-badge" x="${badgeX.toFixed(1)}" y="${badgeY.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}" rx="4" />
      <text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}">${esc(text)}</text>
    </g>`;
  }

  function renderCombinedPeakMark(marks, pad, w, h) {
    const list = Array.isArray(marks) ? marks : [];
    if (!list.length) return "";
    if (list.length === 1) {
      const m = list[0];
      return renderPeakMark(m.peak, m.x, m.y, m.extraClass, {}, { pad, w, h });
    }
    const cx = list.reduce((sum, m) => sum + m.x, 0) / list.length;
    const midY = list.reduce((sum, m) => sum + m.y, 0) / list.length;
    const rows = list.map((m) => ({
      kind: m.kind,
      text: fmtNum(m.peak.v),
    }));
    const lineH = 12;
    const padX = 8;
    const padY = 5;
    const maxTextW = Math.max(...rows.map((r) => r.text.length * 6.2 + 4));
    const boxW = maxTextW + padX * 2;
    const boxH = rows.length * lineH + padY * 2;
    const prefer = cx < (pad.l + w - pad.r) / 2 ? "right" : "left";
    const box = chartPeakSideBox(cx, midY, boxW, boxH, pad, w, h, prefer);
    const anchorX = box.boxX + boxW / 2;
    const dots = list
      .map(
        (m) =>
          `<circle class="ending-dev-chart__peak ${m.extraClass}" cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="3.2" vector-effect="non-scaling-stroke" />`
      )
      .join("");
    const leads = list
      .map((m) => {
        const lead = chartPeakLeadTarget(m.x, m.y, box.boxX, box.boxY, boxW, boxH);
        return `<line class="ending-dev-chart__peak-combo-lead ending-dev-chart__peak-combo-lead--${m.kind}" x1="${lead.x1.toFixed(1)}" y1="${lead.y1.toFixed(1)}" x2="${lead.x2.toFixed(1)}" y2="${lead.y2.toFixed(1)}" vector-effect="non-scaling-stroke" />`;
      })
      .join("");
    const labels = rows
      .map((row, i) => {
        const y = box.boxY + padY + 9 + i * lineH;
        return `<text class="ending-dev-chart__peak-combo-line ending-dev-chart__peak-combo-line--${row.kind}" x="${anchorX.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle">${esc(row.text)}</text>`;
      })
      .join("");
    return `<g class="ending-dev-chart__peak-combo" pointer-events="none">
      ${leads}
      ${dots}
      <rect class="ending-dev-chart__peak-combo-bg" x="${box.boxX.toFixed(1)}" y="${box.boxY.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}" rx="6" />
      ${labels}
    </g>`;
  }

  function renderDualPeakMarks(viewerPeak, chatPeak, xAtTime, yViewers, yChats, viewMinMs, viewMaxMs, pad, w, h) {
    const items = [];
    if (viewerPeak && chartTimeInWindow(viewerPeak.at, viewMinMs, viewMaxMs)) {
      items.push({
        peak: viewerPeak,
        kind: "viewers",
        extraClass: "ending-dev-chart__peak--viewers",
        x: xAtTime(viewerPeak.at),
        y: yViewers(viewerPeak.v),
      });
    }
    if (chatPeak && chartTimeInWindow(chatPeak.at, viewMinMs, viewMaxMs)) {
      items.push({
        peak: chatPeak,
        kind: "chat",
        extraClass: "ending-dev-chart__peak--chat",
        x: xAtTime(chatPeak.at),
        y: yChats(chatPeak.v),
      });
    }
    if (!items.length) return "";
    const chartBox = { pad, w, h };
    if (items.length === 1) {
      const m = items[0];
      return renderPeakMark(m.peak, m.x, m.y, m.extraClass, {}, chartBox);
    }

    const a = items[0];
    const b = items[1];
    const dx = Math.abs(a.x - b.x);
    const msA = parseChartDate(a.peak.at)?.getTime();
    const msB = parseChartDate(b.peak.at)?.getTime();
    const dt = Number.isFinite(msA) && Number.isFinite(msB) ? Math.abs(msA - msB) : Infinity;
    const boxA = chartPeakLabelBox(a.x, a.y - 10, fmtNum(a.peak.v));
    const boxB = chartPeakLabelBox(b.x, b.y - 10, fmtNum(b.peak.v));
    const labelsOverlap = chartPeakLabelBoxesOverlap(boxA, boxB);
    const sameSpike = dx < 48 && dt <= 6 * 60_000;
    const nearTop = Math.min(a.y, b.y) < pad.t + (h - pad.t - pad.b) * 0.35;

    if (labelsOverlap || sameSpike || dx < 88 || nearTop) {
      return renderCombinedPeakMark(items, pad, w, h);
    }

    return items.map((m) => renderPeakMark(m.peak, m.x, m.y, m.extraClass, {}, chartBox)).join("");
  }

  function scrollChartXIntoView(wrap, chartX, fullMinMs, fullMaxMs, viewMinMs, viewMaxMs) {
    if (chartIsFitZoom() || !fullMinMs || !fullMaxMs) return;
    const w = Number(wrap?.dataset?.chartWidth) || CHART_W;
    const padRaw = wrap?.dataset?.chartPad;
    let pad = CHART_PAD_DUAL;
    try {
      if (padRaw) pad = JSON.parse(padRaw);
    } catch (_) {
      /* ignore */
    }
    const xInset = CHART_X_INSET;
    const innerW = w - pad.l - pad.r;
    const xSpan = Math.max(0, innerW - xInset * 2);
    const ratio = Math.max(0, Math.min(1, (Number(chartX) - pad.l - xInset) / xSpan));
    const vMin = Number(viewMinMs) || fullMinMs;
    const vMax = Number(viewMaxMs) || fullMaxMs;
    const centerMs = vMin + ratio * Math.max(1, vMax - vMin);
    setChartPanLevel(chartPanForCenterTime(fullMinMs, fullMaxMs, centerMs));
  }

  let chartBindToken = 0;
  let chartPinnedAt = "";

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
    const minMs = Number(config.minMs);
    const maxMs = Number(config.maxMs);
    const fullMinMs = Number(config.fullMinMs) || minMs;
    const fullMaxMs = Number(config.fullMaxMs) || maxMs;
    const maxV = chartScaleMax(Math.max(...points.map((p) => p.v), 0));
    const { innerH, xAtTime, yViewers: yAt } = chartDualTimeLayout(
      pad,
      w,
      h,
      minMs,
      maxMs,
      maxV,
      maxV
    );
    const valueFmt =
      typeof config.formatValue === "function"
        ? config.formatValue
        : (v) => `${fmtNum(v)}${config.valueSuffix || ""}`;

    function showHit(hit, { persist = true, pointerX = null } = {}) {
      if (String(wrap.dataset.chartToken) !== String(token) || !hit) return;
      const links = replayLinksForPoint(config.replay, hit.at);
      setChartTipHtml(
        wrap,
        `<strong>${esc(chartFullLabel(hit.at))}</strong><span>${esc(valueFmt(hit.v))}</span>${
          links ? `<span class="ending-dev-chart__tip-sub">+ ${esc(links.offsetLabel)}</span>` : ""
        }`
      );
      const cursorX = hit.chartX;
      if (cursor) {
        showChartCursorLine(cursor, cursorX, pad.t, pad.t + innerH);
      }
      if (marker) {
        marker.hidden = false;
        marker.setAttribute("cx", String(hit.chartX));
        marker.setAttribute("cy", String(yAt(hit.v)));
        if (config.lineColor) {
          marker.style.stroke = config.lineColor;
        }
      }
      wrap.dataset.hoverAt = hit.at;
      if (persist) chartPinnedAt = hit.at;
    }

    function pointerHit(clientX, clientY) {
      const pt = chartClientToSvg(svg, clientX, clientY, w, h);
      const hoverMs = chartXToTimeMs(pt.x, pad, w, minMs, maxMs);
      const p = nearestSeriesPointAtTime(points, hoverMs);
      if (!p) return { hit: null, pointerX: pt.x };
      return {
        hit: {
          at: p.at,
          v: p.v,
          chartX: xAtTime(p.at),
        },
        pointerX: pt.x,
      };
    }

    function pinHit(hit, { openTab = true, pointerX = null } = {}) {
      if (!hit) return;
      showHit(hit, { pointerX });
      applyChartReplay(
        wrap,
        config.replay,
        hit.at,
        (links) =>
          `${chartFullLabel(hit.at)} · ${valueFmt(hit.v)} · + ${links.offsetLabel}`,
        { openTab }
      );
    }

    function jumpToAt(at) {
      const p = nearestSeriesPointAtTime(points, at);
      if (!p) return;
      const hit = {
        at: p.at,
        v: p.v,
        chartX: xAtTime(p.at),
      };
      pinHit(hit, { openTab: true });
      scrollChartXIntoView(wrap, hit.chartX, fullMinMs, fullMaxMs, minMs, maxMs);
    }

    overlay.addEventListener("mousemove", (ev) => {
      const { hit, pointerX } = pointerHit(ev.clientX, ev.clientY);
      showHit(hit, { pointerX });
    });
    overlay.addEventListener("click", (ev) => {
      const { hit, pointerX } = pointerHit(ev.clientX, ev.clientY);
      pinHit(hit, { pointerX });
    });
    wrap.addEventListener("ending-chart-jump", (ev) => {
      jumpToAt(ev.detail?.at);
    });

    const restore =
      (chartPinnedAt && nearestSeriesPointAtTime(points, chartPinnedAt)) || points[points.length - 1];
    if (restore) {
      showHit(
        {
          at: restore.at,
          v: restore.v,
          chartX: xAtTime(restore.at),
        },
        { persist: Boolean(chartPinnedAt) }
      );
    }
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
    const fullMinMs = Number(config.fullMinMs) || minMs;
    const fullMaxMs = Number(config.fullMaxMs) || maxMs;
    const { innerH, xAtTime, yViewers, yChats } = chartDualTimeLayout(
      pad,
      w,
      h,
      minMs,
      maxMs,
      maxViewers,
      maxChats
    );

    function showSnap(snap, { persist = true, pointerX = null } = {}) {
      if (String(wrap.dataset.chartToken) !== String(token) || !snap) return;
      const snapAt = snap.at;
      const dataX = xAtTime(snapAt);
      const cursorX = dataX;
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
      setChartTipHtml(
        wrap,
        `<strong>${esc(chartFullLabel(snapAt))}</strong>${rows.join("")}${
          links ? `<span class="ending-dev-chart__tip-sub">+ ${esc(links.offsetLabel)}</span>` : ""
        }`
      );
      if (cursor) {
        showChartCursorLine(cursor, cursorX, pad.t, pad.t + innerH);
      }
      if (markerViewers) {
        if (viewerV != null && Number.isFinite(Number(viewerV))) {
          markerViewers.hidden = false;
          markerViewers.setAttribute("cx", String(dataX));
          markerViewers.setAttribute("cy", String(yViewers(viewerV)));
        } else {
          markerViewers.hidden = true;
        }
      }
      if (markerChats) {
        if (chatV != null && Number.isFinite(Number(chatV))) {
          markerChats.hidden = false;
          markerChats.setAttribute("cx", String(dataX));
          markerChats.setAttribute("cy", String(yChats(chatV)));
        } else {
          markerChats.hidden = true;
        }
      }
      wrap.dataset.hoverAt = snapAt;
      if (persist) chartPinnedAt = snapAt;
    }

    function pointerSnap(clientX, clientY) {
      const pt = chartClientToSvg(svg, clientX, clientY, w, h);
      const hoverMs = chartXToTimeMs(pt.x, pad, w, minMs, maxMs);
      return {
        snap: nearestMergedPointAtTime(merged, hoverMs),
        pointerX: pt.x,
      };
    }

    function pinSnap(snap, { openTab = true, pointerX = null } = {}) {
      if (!snap) return;
      showSnap(snap, { pointerX });
      applyChartReplay(
        wrap,
        config.replay,
        snap.at,
        (links) => {
          const parts = [];
          if (snap.viewers != null && Number.isFinite(Number(snap.viewers))) {
            parts.push(`시청 ${fmtNum(Math.round(snap.viewers))}명`);
          }
          if (snap.chats != null && Number.isFinite(Number(snap.chats))) {
            parts.push(`화력 ${fmtNum(Math.round(snap.chats))}회/분`);
          }
          return `${chartFullLabel(snap.at)} · ${parts.join(" · ")} · + ${links.offsetLabel}`;
        },
        { openTab }
      );
    }

    function jumpToAt(at) {
      const want = parseChartDate(at)?.getTime();
      const snap = nearestMergedPointAtTime(merged, want);
      pinSnap(snap, { openTab: true });
      if (snap) scrollChartXIntoView(wrap, xAtTime(snap.at), fullMinMs, fullMaxMs, minMs, maxMs);
    }

    overlay.addEventListener("mousemove", (ev) => {
      const { snap, pointerX } = pointerSnap(ev.clientX, ev.clientY);
      showSnap(snap, { pointerX });
    });
    overlay.addEventListener("click", (ev) => {
      const { snap, pointerX } = pointerSnap(ev.clientX, ev.clientY);
      pinSnap(snap, { pointerX });
    });
    wrap.addEventListener("ending-chart-jump", (ev) => {
      jumpToAt(ev.detail?.at);
    });

    const restore = chartPinnedAt
      ? nearestMergedPointAtTime(merged, parseChartDate(chartPinnedAt)?.getTime())
      : merged[merged.length - 1];
    if (restore) showSnap(restore, { persist: Boolean(chartPinnedAt) });
  }

  function renderMetricChartPanel(points, opts) {
    const o = opts || {};
    const emptyMsg = o.emptyMsg || "시계열 데이터가 아직 없습니다.";
    if (!points.length) {
      return `<p class="ending-dev-empty ending-dev-data-empty">${esc(emptyMsg)}</p>`;
    }
    const h = CHART_H;
    const pad = CHART_PAD_SINGLE;
    const w = chartLogicalWidth();
    const timeRange = chartTimeRangeFromPoints(points);
    if (!timeRange) {
      return `<p class="ending-dev-empty ending-dev-data-empty">${esc(emptyMsg)}</p>`;
    }
    const { minMs: fullMinMs, maxMs: fullMaxMs } = timeRange;
    const win = chartVisibleWindow(fullMinMs, fullMaxMs);
    const { viewMinMs, viewMaxMs } = win;
    const maxV = chartScaleMax(Math.max(...points.map((p) => p.v), 0));
    const { innerH, xAtTime, yViewers: yAt } = chartDualTimeLayout(
      pad,
      w,
      h,
      viewMinMs,
      viewMaxMs,
      maxV,
      maxV
    );
    const visiblePoints = chartSeriesInWindow(points, viewMinMs, viewMaxMs);
    const linePts = visiblePoints.map((p) => ({
      x: Number(xAtTime(p.at)),
      y: Number(yAt(p.v)),
    }));
    const line = pathSmoothFromXY(linePts);
    const area = `${line} L${xAtTime(new Date(viewMaxMs).toISOString()).toFixed(1)},${(pad.t + innerH).toFixed(1)} L${xAtTime(new Date(viewMinMs).toISOString()).toFixed(1)},${(pad.t + innerH).toFixed(1)} Z`;
    const yTicks = [0, Math.round(maxV / 2), maxV];
    const yLines = yTicks
      .map((v) => {
        const y = yAt(v).toFixed(1);
        return `<line class="ending-dev-chart__grid" x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" />
          <text class="ending-dev-chart__ylabel" x="${pad.l - 8}" y="${y}" text-anchor="end" dominant-baseline="middle">${esc(fmtNum(v))}</text>`;
      })
      .join("");
    const tickTimes = chartTimeTickTimes(viewMinMs, viewMaxMs, w - pad.l - pad.r);
    const xLabels = renderChartTimeAxisDual(tickTimes, xAtTime, pad, w, h);
    const lineColor = o.lineColor || "var(--dev-blue)";
    const areaColor = o.areaColor || "rgba(47, 95, 154, 0.12)";
    const meta = typeof o.meta === "function" ? o.meta(points, maxV) : String(o.meta || "");
    const jumps = Array.isArray(o.jumps) ? o.jumps.filter(Boolean) : [];
    const peakJump = jumps.find((j) => j && j.kind !== "chat") || jumps[0];
    let peakMark = "";
    if (peakJump && chartTimeInWindow(peakJump.at, viewMinMs, viewMaxMs)) {
      let idx = points.findIndex((p) => p.at === peakJump.at);
      if (idx < 0) {
        const want = chartMinuteMs(peakJump.at);
        idx = points.findIndex((p) => chartMinuteMs(p.at) === want);
      }
      if (idx >= 0) {
        const peakV = Math.max(Number(peakJump.v) || 0, Number(points[idx].v) || 0);
        peakMark = renderPeakMark({ v: peakV }, xAtTime(points[idx].at), yAt(peakV), "", {}, {
          pad,
          w,
          h,
        });
      }
    }
    return `<div class="ending-dev-chart">
      ${renderChartToolbar({ jumps, meta: typeof o.meta === "function" ? o.meta(points, maxV) : String(o.meta || "") })}
      ${renderChartZoomControls()}
      <div class="ending-dev-chart__readout" data-chart-readout aria-live="polite">
        <div class="ending-dev-chart__tip" data-chart-tip></div>
      </div>
      <div class="ending-dev-chart__viewport">
      <div class="ending-dev-chart__wrap" data-chart-wrap
        data-chart-width="${w}" data-chart-height="${h}"
        data-chart-full-min="${fullMinMs}" data-chart-full-max="${fullMaxMs}"
        data-chart-pad="${esc(JSON.stringify(pad))}">
        <svg class="ending-dev-chart__svg" data-chart-svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMinYMid meet" role="img" aria-label="${esc(o.ariaLabel || "추이")}">
          ${renderChartClipDef(pad, w, h)}
          ${yLines}
          <g clip-path="url(#ending-dev-chart-clip)">
          <path class="ending-dev-chart__area" style="fill:${esc(areaColor)}" d="${area}" />
          <path class="ending-dev-chart__line" style="stroke:${esc(lineColor)}" d="${line}" />
          </g>
          ${xLabels}
          ${peakMark}
          <circle class="ending-dev-chart__marker" data-chart-marker hidden vector-effect="non-scaling-stroke" cx="0" cy="0" r="3.5" />
          <line class="ending-dev-chart__cursor" data-chart-cursor hidden x1="0" y1="0" x2="0" y2="0" />
        </svg>
        <div class="ending-dev-chart__overlay" data-chart-overlay aria-hidden="true"></div>
      </div>
      </div>
      ${renderChartPanScroll()}
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
    const fullMinMs = Number(wrap.dataset.chartFullMin);
    const fullMaxMs = Number(wrap.dataset.chartFullMax);
    const win = chartVisibleWindow(fullMinMs, fullMaxMs);
    bindInteractiveChart(wrap, {
      points: opts.points,
      replay: opts.replay,
      lineColor: opts.lineColor || "",
      width: Number(wrap.dataset.chartWidth) || CHART_W,
      height: Number(wrap.dataset.chartHeight) || CHART_H,
      pad,
      minMs: win.viewMinMs,
      maxMs: win.viewMaxMs,
      fullMinMs,
      fullMaxMs,
      valueSuffix: opts.valueSuffix || "",
      formatValue: opts.formatValue,
    });
    bindPeakJumpButtons(root, wrap);
  }

  function renderDualMetricChartPanel(viewerPoints, chatPoints, counts, replay) {
    const viewers = applyViewerPeakToPoints(seriesPoints(viewerPoints), counts);
    const chats = seriesPoints(chatPoints);
    const merged = mergeMetricsTimeline(viewers, chats);
    if (!merged.length) {
      return {
        html: `<p class="ending-dev-empty ending-dev-data-empty">시계열 없음</p>`,
        bind: null,
      };
    }
    const h = CHART_H;
    const pad = CHART_PAD_DUAL;
    const timeRange = chartTimeRangeFromPoints(viewers, chats);
    if (!timeRange) {
      return {
        html: `<p class="ending-dev-empty ending-dev-data-empty">시계열 없음</p>`,
        bind: null,
      };
    }
    const { minMs: fullMinMs, maxMs: fullMaxMs } = timeRange;
    const win = chartVisibleWindow(fullMinMs, fullMaxMs);
    const { viewMinMs, viewMaxMs } = win;
    const w = chartLogicalWidth();
    const maxViewers = chartScaleMax(Math.max(...viewers.map((p) => p.v), 0));
    const maxChats = chartScaleMax(Math.max(...chats.map((p) => p.v), 0));
    const { innerH, xAtTime, yViewers, yChats } = chartDualTimeLayout(
      pad,
      w,
      h,
      viewMinMs,
      viewMaxMs,
      maxViewers,
      maxChats
    );
    const visibleViewers = chartSeriesInWindow(viewers, viewMinMs, viewMaxMs);
    const visibleChats = chartSeriesInWindow(chats, viewMinMs, viewMaxMs);
    const viewerLine = pathForSeriesPointsSmooth(visibleViewers, xAtTime, yViewers);
    const chatLine = pathForSeriesPointsSmooth(visibleChats, xAtTime, yChats);
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
    const tickTimes = chartTimeTickTimes(viewMinMs, viewMaxMs, w - pad.l - pad.r);
    const xLabels = renderChartTimeAxisDual(tickTimes, xAtTime, pad, w, h);
    const lastViewers = Number(counts?.lastViewerCount) || viewers[viewers.length - 1]?.v || 0;
    const viewerPeak = resolveViewerPeak(viewers, counts);
    const chatPeak = resolveChatPeak(chats);
    const totalChat = Number(counts?.chatCount) || chats.reduce((n, p) => n + p.v, 0);
    const meta = [
      lastViewers ? `현재 ${fmtNum(lastViewers)}명` : "",
      totalChat ? `누적 ${fmtNum(totalChat)}회` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const peakMarks = renderDualPeakMarks(
      viewerPeak,
      chatPeak,
      xAtTime,
      yViewers,
      yChats,
      viewMinMs,
      viewMaxMs,
      pad,
      w,
      h
    );
    return {
      html: `<div class="ending-dev-chart ending-dev-chart--dual">
      ${renderChartToolbar({ jumps: [viewerPeak, chatPeak], meta, showLegend: true })}
      ${renderChartZoomControls()}
      <div class="ending-dev-chart__readout" data-chart-readout aria-live="polite">
        <div class="ending-dev-chart__tip" data-chart-tip></div>
      </div>
      <div class="ending-dev-chart__viewport">
      <div class="ending-dev-chart__wrap" data-chart-wrap data-chart-dual="1"
        data-chart-width="${w}" data-chart-height="${h}"
        data-chart-full-min="${fullMinMs}" data-chart-full-max="${fullMaxMs}"
        data-chart-pad="${esc(JSON.stringify(pad))}">
        <svg class="ending-dev-chart__svg" data-chart-svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMinYMid meet" role="img" aria-label="시청자·채팅 화력 추이">
          ${renderChartClipDef(pad, w, h)}
          ${yLines}
          ${yRight}
          <g clip-path="url(#ending-dev-chart-clip)">
          ${viewerLine ? `<path class="ending-dev-chart__line ending-dev-chart__line--viewers" d="${viewerLine}" />` : ""}
          ${chatLine ? `<path class="ending-dev-chart__line ending-dev-chart__line--chat" d="${chatLine}" />` : ""}
          </g>
          ${xLabels}
          ${peakMarks}
          <circle class="ending-dev-chart__marker ending-dev-chart__marker--viewers" data-chart-marker-viewers hidden vector-effect="non-scaling-stroke" cx="0" cy="0" r="3.5" />
          <circle class="ending-dev-chart__marker ending-dev-chart__marker--chat" data-chart-marker-chats hidden vector-effect="non-scaling-stroke" cx="0" cy="0" r="3.5" />
          <line class="ending-dev-chart__cursor" data-chart-cursor hidden x1="0" y1="0" x2="0" y2="0" />
        </svg>
        <div class="ending-dev-chart__overlay" data-chart-overlay aria-hidden="true"></div>
      </div>
      </div>
      ${renderChartPanScroll()}
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
        minMs: viewMinMs,
        maxMs: viewMaxMs,
        fullMinMs,
        fullMaxMs,
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
      fullMinMs: opts.fullMinMs,
      fullMaxMs: opts.fullMaxMs,
      maxViewers: opts.maxViewers,
      maxChats: opts.maxChats,
    });
    bindPeakJumpButtons(root, wrap);
  }

  function renderViewersChartPanel(metricsSeries, counts, replay) {
    const points = applyViewerPeakToPoints(seriesPoints(metricsSeries?.viewers), counts);
    const last = Number(counts?.lastViewerCount) || points[points.length - 1]?.v || 0;
    const viewerPeak = resolveViewerPeak(points, counts);
    return {
      html: renderMetricChartPanel(points, {
        emptyMsg: "시청자 시계열 없음",
        ariaLabel: "시청자 추이",
        jumps: [viewerPeak],
        meta: () => (last ? `현재 ${fmtNum(last)}명` : ""),
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
    const total = Number(counts?.chatCount) || points.reduce((n, p) => n + p.v, 0);
    const chatPeak = resolveChatPeak(points);
    return {
      html: renderMetricChartPanel(points, {
        emptyMsg: "화력 시계열 없음",
        ariaLabel: "채팅 화력 추이",
        lineColor: "#c45c26",
        areaColor: "rgba(196, 92, 38, 0.14)",
        jumps: [chatPeak],
        meta: () => (total ? `누적 ${fmtNum(total)}회` : ""),
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

  function metricsChartContext(collected) {
    const c = collected || {};
    const extras = devLiveExtras(c);
    const metricsCat = (dataCatsCache || []).find((cat) => cat.id === "metricsChart") || {};
    return {
      metricsSeries: metricsCat.metricsSeries || extras?.metricsSeries || {},
      counts: metricsCat.counts || c.counts || {},
      replay: extras?.replay || {},
    };
  }

  function refreshMetricsChartView() {
    if (!lastData || !els.dataBody) return false;
    const acc = resolveAccount(lastData, activeTab);
    const collected = (acc.session || {}).collected || {};
    const ctx = metricsChartContext(collected);
    const chart = renderMetricsChartPanel(ctx.metricsSeries, ctx.counts, ctx.replay, metricsChartMode);
    const oldChart = els.dataBody.querySelector(".ending-dev-chart");
    if (!oldChart || !chart?.html) {
      renderDataPanel(acc.sections, collected);
      return true;
    }
    const holder = document.createElement("div");
    holder.innerHTML = chart.html;
    const newChart = holder.firstElementChild;
    if (!newChart) return false;
    oldChart.replaceWith(newChart);
    if (chart.bind?.kind === "dual") mountDualMetricChartInteraction(els.dataBody, chart.bind);
    else if (chart.bind) mountMetricChartInteraction(els.dataBody, chart.bind);
    syncChartPanScroll(els.dataBody);
    return true;
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
      "mission",
      "ssapi",
      "topfan",
      "quickview",
    ];

    for (const sec of Array.isArray(sections) ? sections : []) {
      if (!sec || typeof sec !== "object") continue;
      const id = String(sec.id || "").trim();
      if (!id || id === "thanks") continue;
      const items = normalizeItems(sec.items || []);
      byId.set(id, {
        id,
        title: dataTabTitle(id, sec.title),
        count: Number(sec.itemCount || items.length || 0),
        pending: Boolean(sec.pending) && items.length === 0,
        items,
      });
    }

    // 모니터는 collected 전체 목록을 우선 (크레딧 섹션은 상위 일부만)
    const preferred = [
      ["chat", dataTabTitle("chat"), c.topChatters, "count", counts.chatters],
      ["watch", dataTabTitle("watch"), c.topWatchers, "value", counts.watchers],
      ["donation", dataTabTitle("donation"), c.topDonations, "total", counts.donors],
      ["fanclub", dataTabTitle("fanclub"), c.fanclubJoins, "value", counts.fanclubJoins],
      ["subscribe_gift", dataTabTitle("subscribe_gift"), c.subscriptionGifts, "value", counts.subscriptionGifts],
      ["subscribe", dataTabTitle("subscribe"), c.subscribers, "value", counts.subscribers],
      ["subscribe_renew", dataTabTitle("subscribe_renew"), c.subscriberRenewals, "value", counts.subscriberRenewals],
      ["emoticon", dataTabTitle("emoticon"), c.topEmoticons, "count", counts.emoticons],
      ["topfan", dataTabTitle("topfan"), c.topFans, "value", null],
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
        title: dataTabTitle(id, prev?.title || title),
        count: Number(totalHint) > 0 ? Number(totalHint) : items.length,
        pending: false,
        items,
      });
    }

    const extras = devLiveExtras(c);
    if (extras) {
      const firstChat =
        extras.firstChat && typeof extras.firstChat === "object" ? extras.firstChat : null;
      const firstReady = Boolean(firstChat && String(firstChat.name || "").trim());
      const titleHistory = normalizeTitleHistory(extras.titleHistory);
      const viewerPoints = seriesPoints(extras.metricsSeries?.viewers);
      const chatPoints = seriesPoints(extras.metricsSeries?.chats);
      const viewerN = viewerPoints.length;
      const chatN = chatPoints.length;
      const extraN = (firstReady ? 1 : 0) + titleHistory.length;
      byId.set("metricsChart", {
        id: "metricsChart",
        title: dataTabTitle("metricsChart"),
        panelTitle: "시청 · 화력",
        count: Math.max(viewerN, chatN, extraN),
        countLabel: metricsTabCountLabel(viewerN, chatN),
        pending: viewerN === 0 && chatN === 0 && !firstReady && titleHistory.length === 0,
        kind: "metricsChart",
        metricsSeries: extras.metricsSeries || {},
        firstChat: firstReady ? firstChat : null,
        titleHistory,
        viewerCount: viewerN,
        chatCount: chatN,
        counts: counts,
        items: [],
      });

      const missionRuns = normalizeMissionRuns(extras.missionRuns);
      const prevMission = byId.get("mission");
      byId.set("mission", {
        id: "mission",
        title: dataTabTitle("mission"),
        count: missionRuns.length || Number(prevMission?.count || 0),
        pending: missionRuns.length === 0 && !Number(prevMission?.count || 0),
        kind: "missionRuns",
        missionRuns,
        items: prevMission?.items || [],
      });

      const donationNotes = normalizeDonationNotes(extras.donationNotes);
      const prevDon = byId.get("donation");
      if (prevDon || donationNotes.length) {
        byId.set("donation", {
          id: "donation",
          title: dataTabTitle("donation", prevDon?.title),
          count: Math.max(Number(prevDon?.count || 0), donationNotes.length),
          pending: !Number(prevDon?.count || 0) && donationNotes.length === 0,
          kind: "donationNotes",
          donationNotes,
          items: prevDon?.items || [],
        });
      }

      if (!isMeMonitor()) {
        const ssapi = normalizeSsapiAssist(extras.ssapi);
        byId.set("ssapi", {
          id: "ssapi",
          title: dataTabTitle("ssapi"),
          count: ssapi.eventCount,
          pending: ssapi.eventCount === 0,
          kind: "ssapi",
          ssapi,
          items: [],
        });
      }
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
    return `<div class="ending-dev-chart-mode" role="group" aria-labelledby="dev-chart-mode-label">
      ${METRICS_CHART_MODES.map((opt) => {
        const on = mode === opt.value;
        return `<button type="button" class="ending-dev-chart-mode__btn${on ? " is-on" : ""}" data-chart-mode="${esc(
          opt.value
        )}">${esc(opt.label)}</button>`;
      }).join("")}
    </div>`;
  }

  function renderLimitToggles(total) {
    return `<div class="ending-dev-limit" role="group" aria-labelledby="dev-limit-label">
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

  function renderOverviewStats(counts) {
    const c = counts && typeof counts === "object" ? counts : {};
    const chips = [
      ["peakViewers", "최고 시청", (v) => `${fmtNum(v)}명`],
      ["chatCount", "채팅", (v) => `${fmtNum(v)}회`],
      ["chatters", "채팅 참여", (v) => `${fmtNum(v)}명`],
      ["watchers", "시청 시간", (v) => `${fmtNum(v)}명`],
      ["donors", "후원", (v) => `${fmtNum(v)}명`],
      ["balloonTotal", "별풍", (v) => `${fmtNum(v)}개`],
      ["subscribers", "신규 구독", (v) => `${fmtNum(v)}`],
      ["subscriberRenewals", "연속 구독", (v) => `${fmtNum(v)}`],
      ["subscriptionGifts", "구독 선물", (v) => `${fmtNum(v)}`],
      ["fanclubJoins", "팬클럽", (v) => `${fmtNum(v)}`],
      ["emoticons", "이모티콘", (v) => `${fmtNum(v)}`],
      ["missions", "미션", (v) => `${fmtNum(v)}`],
    ]
      .map(([key, label, fmt]) => {
        const v = Number(c[key] || 0);
        if (!v) return null;
        return `<span class="ending-dev-overview-stat"><span class="ending-dev-overview-stat__k">${esc(
          label
        )}</span><strong class="ending-dev-overview-stat__v">${esc(fmt(v))}</strong></span>`;
      })
      .filter(Boolean);
    if (!chips.length) {
      return `<p class="ending-dev-overview-stats ending-dev-overview-stats--empty">집계 요약 없음</p>`;
    }
    return `<div class="ending-dev-overview-stats" role="list">${chips.join("")}</div>`;
  }

  function categoryHasData(cat) {
    if (!cat || typeof cat !== "object") return false;
    if (Number(cat.count || 0) > 0) return true;
    if ((cat.items?.length || 0) > 0) return true;
    if (cat.kind === "missionRuns" && (cat.missionRuns?.length || 0) > 0) return true;
    if (cat.kind === "ssapi" && (cat.ssapi?.eventCount || 0) > 0) return true;
    if (cat.kind === "donationNotes" && (cat.donationNotes?.length || 0) > 0) return true;
    return false;
  }

  function renderOverviewCategoryBody(cat, limit) {
    if (cat.kind === "missionRuns") {
      const rows = normalizeMissionRuns(cat.missionRuns).slice(0, limit > 0 ? limit : undefined);
      if (!rows.length) {
        return `<p class="ending-dev-empty ending-dev-data-empty">미션 없음</p>`;
      }
      return `<ol class="ending-dev-missions ending-dev-missions--compact">
        ${rows
          .map((row) => {
            const when = row.endedAt || row.startedAt;
            return `<li>
              <span class="ending-dev-missions__status is-${esc(row.status)}">${esc(row.statusLabel)}</span>
              <span class="ending-dev-missions__title" title="${esc(row.title)}">${esc(row.title)}</span>
              ${row.total ? `<span class="ending-dev-missions__total">${esc(fmtNum(row.total))}개</span>` : ""}
              ${when ? `<span class="ending-dev-missions__at">${esc(chartClockLabel(when))}</span>` : ""}
            </li>`;
          })
          .join("")}
      </ol>`;
    }
    if (cat.kind === "ssapi") {
      const data = normalizeSsapiAssist(cat.ssapi);
      const events = data.events.slice(0, limit > 0 ? limit : 8);
      if (!events.length) {
        return `${renderSsapiStatus(data)}<p class="ending-dev-empty ending-dev-data-empty">이벤트 없음</p>`;
      }
      return `${renderSsapiStatus(data)}<ol class="ending-dev-ssapi-list ending-dev-ssapi-list--compact">
        ${events
          .map((row) => {
            const title = row.title || row.text || (row.kind === "donation" ? "별풍" : "미션");
            return `<li>
              <span class="ending-dev-ssapi-list__phase is-${esc(row.phase || "event")}">${esc(
                row.phaseLabel
              )}</span>
              <span class="ending-dev-ssapi-list__title" title="${esc(title)}">${esc(title)}</span>
              ${row.name ? `<span class="ending-dev-ssapi-list__name">${esc(row.name)}</span>` : ""}
              ${row.at ? `<span class="ending-dev-ssapi-list__at">${esc(chartClockLabel(row.at))}</span>` : ""}
            </li>`;
          })
          .join("")}
      </ol>`;
    }
    if (cat.kind === "donationNotes") {
      const shown = sliceItemsForLimit(cat.items, limit);
      const notes = normalizeDonationNotes(cat.donationNotes).slice(0, limit > 0 ? limit : 5);
      const list = renderDataList(shown, { compact: true });
      const noteBlock =
        notes.length > 0
          ? `<div class="ending-dev-overview-card__notes">${renderDonationNotes(notes)}</div>`
          : "";
      return `${list}${noteBlock}`;
    }
    return renderDataList(sliceItemsForLimit(cat.items, limit), { compact: true });
  }

  function overviewCardSpan(cat) {
    if (cat.kind === "ssapi" || cat.kind === "missionRuns") return 2;
    if (cat.id === "emoticon") return 2;
    if (cat.kind === "donationNotes") {
      const n = (cat.items?.length || 0) + (cat.donationNotes?.length || 0);
      return n > 4 ? 2 : 1;
    }
    return 1;
  }

  function overviewBodyScrollable(limit) {
    return limit === 0 || limit > 10;
  }

  function renderOverviewCategoryCard(cat, limit) {
    const span = overviewCardSpan(cat);
    const countLabel =
      cat.count > 0 ? `${fmtNum(cat.count)}건` : cat.pending ? "대기" : "0건";
    const scrollable = overviewBodyScrollable(limit);
    return `<article class="ending-dev-overview-card" data-span="${span}" data-cat="${esc(cat.id)}">
      <header class="ending-dev-overview-card__head">
        <h5 class="ending-dev-overview-card__title">${esc(cat.title)}</h5>
        <span class="ending-dev-overview-card__count">${esc(countLabel)}</span>
      </header>
      <div class="ending-dev-overview-card__body${scrollable ? " is-scrollable" : ""}">${renderOverviewCategoryBody(cat, limit)}</div>
    </article>`;
  }

  function renderOverviewPending(cats) {
    const list = (Array.isArray(cats) ? cats : []).filter((c) => c && !categoryHasData(c));
    if (!list.length) return "";
    return `<div class="ending-dev-overview-pending">
      <span class="ending-dev-overview-pending__label">수집 대기</span>
      ${list
        .map(
          (c) =>
            `<span class="ending-dev-overview-pending__chip">${esc(c.title)}</span>`
        )
        .join("")}
    </div>`;
  }

  function renderOverviewPanel(cats, collected) {
    const metricsCat = (Array.isArray(cats) ? cats : []).find((c) => c.id === "metricsChart") || {};
    const counts = metricsCat.counts || (collected || {}).counts || {};
    const replay = devLiveExtras(collected)?.replay || {};
    const digest = renderMetricsDigest(metricsCat, counts, replay, metricsChartMode);
    const rankCats = (Array.isArray(cats) ? cats : []).filter((c) => c.id !== "metricsChart");
    const readyCats = rankCats.filter((c) => categoryHasData(c));
    const limit = dataLimit > 0 ? dataLimit : 0;
    const totalItems = readyCats.reduce(
      (n, c) => n + Math.max(Number(c.count || 0), c.items?.length || 0),
      0
    );
    const cards = readyCats.map((c) => renderOverviewCategoryCard(c, limit)).join("");
    return {
      html: `<div class="ending-dev-overview-panel">
        <div class="ending-dev-overview-panel__head">
          <div class="ending-dev-overview-panel__lead">
            <h4 class="ending-dev-overview-panel__title">종합</h4>
            <p class="ending-dev-overview-panel__meta">${esc(
              readyCats.length ? `${readyCats.length}개 영역 · ${fmtNum(totalItems)}건` : "데이터 없음"
            )}</p>
          </div>
          <div class="ending-dev-overview-panel__tools">
            <div class="ending-dev-tool-group ending-dev-tool-group--chart">
              <span class="ending-dev-tool-group__label" id="dev-chart-mode-label">그래프</span>
              ${renderChartModeToggles(metricsChartMode)}
            </div>
            <div class="ending-dev-tool-group ending-dev-tool-group--limit">
              <span class="ending-dev-tool-group__label" id="dev-limit-label">목록</span>
              ${renderLimitToggles(totalItems)}
            </div>
          </div>
        </div>
        ${digest.html}
        ${renderOverviewStats(counts)}
        ${
          cards
            ? `<div class="ending-dev-overview-grid">${cards}</div>`
            : `<p class="ending-dev-empty">카테고리별 데이터가 아직 없습니다.</p>`
        }
        ${renderOverviewPending(rankCats)}
      </div>`,
      bind: digest.bind,
    };
  }

  function captureScrollState(root) {
    const state = {
      windowY: window.scrollY || window.pageYOffset || 0,
      cards: {},
      charts: [],
    };
    if (!root) return state;
    root.querySelectorAll(".ending-dev-overview-card").forEach((card) => {
      const cat = card.getAttribute("data-cat");
      const body = card.querySelector(".ending-dev-overview-card__body.is-scrollable");
      if (cat && body) state.cards[cat] = body.scrollTop;
    });
    return state;
  }

  function restoreScrollState(root, state) {
    if (!root || !state) return;
    Object.entries(state.cards || {}).forEach(([cat, top]) => {
      const card = root.querySelector(`.ending-dev-overview-card[data-cat="${cat}"]`);
      const body = card?.querySelector(".ending-dev-overview-card__body.is-scrollable");
      if (body && typeof top === "number") body.scrollTop = top;
    });
    const y = Number(state.windowY);
    if (Number.isFinite(y) && y > 0) {
      requestAnimationFrame(() => {
        window.scrollTo(0, y);
        requestAnimationFrame(() => window.scrollTo(0, y));
      });
    }
  }

  function persistScrollState(state) {
    if (!state) return;
    try {
      sessionStorage.setItem(SCROLL_STATE_KEY, JSON.stringify(state));
    } catch (_) {
      /* ignore */
    }
  }

  function loadPersistedScrollState() {
    try {
      const raw = sessionStorage.getItem(SCROLL_STATE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function scheduleScrollPersist() {
    if (scrollPersistTimer) clearTimeout(scrollPersistTimer);
    scrollPersistTimer = setTimeout(() => {
      if (!els.dataBody) return;
      persistScrollState(captureScrollState(els.dataBody));
    }, 150);
  }

  try {
    scrollRestorePending = loadPersistedScrollState();
  } catch (_) {
    scrollRestorePending = null;
  }

  function renderDataList(items, opts = {}) {
    const compact = Boolean(opts.compact);
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      return `<p class="ending-dev-empty ending-dev-data-empty">이 카테고리에 아직 데이터가 없습니다.</p>`;
    }
    const hasImg = list.some((row) => row.imageUrl);
    const sizeCls = compact ? " ending-dev-rank--compact" : " ending-dev-rank--lg";
    return `<ol class="ending-dev-rank${sizeCls}${hasImg ? " ending-dev-rank--emo" : ""}">
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
    const readyN = cats.filter((c) => categoryHasData(c)).length;
    const totalN = cats.reduce((n, c) => n + (Number(c.count) || 0), 0);
    if (els.dataHint) {
      els.dataHint.textContent = cats.length
        ? `종합 · ${readyN}개 영역 · ${totalN}건`
        : "데이터 없음";
    }
    if (els.dataNav) {
      els.dataNav.innerHTML = "";
      els.dataNav.hidden = true;
    }
    if (!els.dataBody) return;

    if (!cats.length) {
      els.dataBody.innerHTML = `<p class="ending-dev-empty">수집된 데이터가 없습니다.</p>`;
      return;
    }

    const scrollState = scrollRestorePending || captureScrollState(els.dataBody);
    scrollRestorePending = null;

    activeChartLayoutWidth = chartLayoutWidth(els.dataBody);
    chartLayoutWidthCache = activeChartLayoutWidth;

    const overview = renderOverviewPanel(cats, collected);
    els.dataBody.innerHTML = overview.html;
    if (overview.bind?.kind === "dual") mountDualMetricChartInteraction(els.dataBody, overview.bind);
    else if (overview.bind) mountMetricChartInteraction(els.dataBody, overview.bind);

    syncChartPanScroll(els.dataBody);
    restoreScrollState(els.dataBody, scrollState);
    requestAnimationFrame(() => {
      const fittedW = chartLayoutWidth(els.dataBody);
      if (Math.abs(fittedW - activeChartLayoutWidth) >= 8 && lastData) {
        activeChartLayoutWidth = fittedW;
        chartLayoutWidthCache = fittedW;
        scrollRestorePending = scrollState;
        const acc = resolveAccount(lastData, activeTab);
        renderDataPanel(acc.sections, (acc.session || {}).collected || {});
        return;
      }
      syncChartPanScroll(els.dataBody);
      restoreScrollState(els.dataBody, scrollState);
      persistScrollState(captureScrollState(els.dataBody));
    });
  }

  function onChartZoomAction(action, value) {
    const act = String(action || "").trim();
    if (act === "fit") {
      setChartZoomLevel(CHART_ZOOM_DEFAULT);
      return;
    }
    if (act === "in" || act === "out") {
      const cur = chartZoomLevel();
      const next = act === "in" ? cur * 1.25 : cur / 1.25;
      setChartZoomLevel(next);
      return;
    }
    if (act === "range") {
      setChartZoomLevel(chartZoomFromSlider(value));
    }
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

  function setViewModeUi({ broadcastLive = null } = {}) {
    const live = broadcastLive == null ? isBroadcastLive(lastData) : Boolean(broadcastLive);
    const isHist = !live || viewMode === "history";
    if (els.viewmode) {
      els.viewmode.hidden = !live;
      els.viewmode.classList.toggle("is-hidden", !live);
    }
    if (els.viewLive) {
      els.viewLive.hidden = !live;
      els.viewLive.disabled = !live;
      els.viewLive.classList.toggle("is-on", live && !isHist);
      els.viewLive.setAttribute("aria-selected", live && !isHist ? "true" : "false");
    }
    if (els.viewHistory) {
      els.viewHistory.classList.toggle("is-on", isHist);
      els.viewHistory.setAttribute("aria-selected", isHist ? "true" : "false");
    }
    if (els.history) {
      els.history.hidden = !isHist;
      els.history.classList.toggle("is-standalone", !live);
    }
  }

  function syncViewModeForLiveState(data) {
    const live = isBroadcastLive(data);
    if (!live) {
      if (viewMode !== "history") {
        viewMode = "history";
        historyPayload = null;
        try {
          sessionStorage.setItem(VIEW_KEY, viewMode);
        } catch (_) {
          /* ignore */
        }
      }
    }
    setViewModeUi({ broadcastLive: live });
    return live;
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
        `${monitorApiBase()}/archive-dates?stationId=${encodeURIComponent(sid)}&limit=90`,
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
            const label = formatHistoryDateLabel(date, n);
            return `<option value="${esc(date)}"${date === historyDate ? " selected" : ""}>${esc(
              label
            )}</option>`;
          })
          .join("")
      : `<option value="">아카이브 없음</option>`;
    if (els.historyDate) {
      els.historyDate.disabled = !items.length;
    }
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
        `${monitorApiBase()}/archives?stationId=${encodeURIComponent(sid)}&date=${encodeURIComponent(
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
            <span class="ending-dev-history__item-main">
              <span class="ending-dev-history__item-title">${esc(it.title || "(제목 없음)")}</span>
              <span class="ending-dev-history__item-sub">${esc(formatHistoryClock(it.startedAt))} · ${esc(dur)}</span>
            </span>
            <span class="ending-dev-history__item-badges">
              <span class="ending-dev-history__badge">피크 ${esc(peak)}</span>
              <span class="ending-dev-history__badge">채팅 ${esc(chat)}</span>
              <span class="ending-dev-history__badge">별풍 ${esc(balloon)}</span>
            </span>
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
        `${monitorApiBase()}/archive?archiveId=${encodeURIComponent(aid)}`,
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
    if (next === "live" && lastData && !isBroadcastLive(lastData)) return;
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
    activeTab = isMeMonitor() ? "me" : tab === "me" ? "me" : "sirian";
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
    const authFail = Boolean(sess.ingestAuthFailRecent);
    const collectLabel = liveIngest ? "수집 중" : authFail ? "인증 실패" : "대기";
    const collectClass = liveIngest ? "is-live" : authFail ? "is-warn" : "";
    const ssapi = isMeMonitor()
      ? null
      : normalizeSsapiAssist(data.ssapi || devLiveExtras(sess.collected)?.ssapi);
    const ssapiLabel = ssapi
      ? ssapi.connected
        ? "SSAPI 연결"
        : ssapi.lastError
          ? "SSAPI 오류"
          : "SSAPI"
      : "";
    const recent = lastAt ? fmtAge(lastAge) || fmtTime(lastAt) : "";
    const ssapiHtml = ssapi
      ? `<div class="ending-dev-status ${ssapi.connected ? "is-live" : ssapi.lastError ? "is-warn" : ""}">
        <span class="ending-dev-status__dot" aria-hidden="true"></span>
        <span>${esc(ssapiLabel)}</span>
        ${ssapi.eventCount ? `<span class="ending-dev-status__sub">${esc(fmtNum(ssapi.eventCount))}건</span>` : ""}
      </div>`
      : "";
    els.strip.innerHTML = `
      <div class="ending-dev-status ${collectClass}">
        <span class="ending-dev-status__dot" aria-hidden="true"></span>
        <span>${esc(collectLabel)}</span>
        ${recent ? `<span class="ending-dev-status__sub">${esc(recent)}</span>` : ""}
      </div>
      ${ssapiHtml}`;
  }

  function renderAccount(data) {
    const acc = resolveAccount(data, activeTab);
    const sess = acc.session || {};
    const info = acc.info || {};
    const collected = sess.collected || {};

    if (els.title) els.title.textContent = info.title || sess.title || "방송 정보 없음";
    if (els.broadcast) {
      els.broadcast.textContent = acc.stationId || "";
    }
    if (els.meta) {
      els.meta.textContent = acc.meta || (sess.updatedAt ? `세션 갱신 ${fmtTime(sess.updatedAt)}` : "—");
    }
    const live = syncViewModeForLiveState(data);

    if (els.note) {
      if (viewMode === "history" && acc.archiveId && live) {
        els.note.hidden = false;
        els.note.textContent = `날짜별 보기 · ${acc.archiveId}`;
      } else {
        els.note.hidden = true;
        els.note.textContent = "";
      }
    }

    setPanelStatus(acc);
    renderStats(els.stats, [
      ["채팅", `${fmtNum(info.chatters || collected.counts?.chatters || sess.chatterCount)}명 · ${fmtNum(info.chatCount || collected.counts?.chatCount || sess.chatCount)}회`],
      ["별풍", fmtNum(info.balloonTotal || collected.counts?.balloonTotal || sess.balloonTotal)],
      ["팬 / 구독", `팬 ${fmtNum(info.fanclubCount || collected.counts?.fanclubJoins)} · 구독 ${fmtNum(info.subscribeCount || collected.counts?.subscribers)} · 선물 ${fmtNum(collected.counts?.subscriptionGifts)}`],
    ]);
    renderPeakThumb(acc);

    renderDataPanel(acc.sections, collected);
  }

  function paint(data, { animate = false } = {}) {
    lastData = data;
    setTabUi(activeTab);
    renderStrip(data);
    renderAccount(data);
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
    if (isLiveDataPage()) window.__liveDataAuth?.clearOauthBusy?.();
    if (els.app) els.app.hidden = true;
    if (els.gate) els.gate.hidden = false;
    if (els.gateMsg && msg) els.gateMsg.textContent = msg;
    if (els.gateLogin) els.gateLogin.hidden = false;
  }

  function showApp() {
    if (isLiveDataPage()) window.__liveDataAuth?.clearOauthBusy?.();
    if (els.gate) els.gate.hidden = true;
    if (els.app) els.app.hidden = false;
    if (els.gateLogin) els.gateLogin.hidden = true;
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const data = await fetchJson(monitorApiBase(), { headers: authHeaders() });
      if (!data?.ok) throw new Error(data?.error || "monitor_failed");
      showApp();
      paint(data);
      const live = isBroadcastLive(data);
      if (!live || viewMode === "history") {
        await loadHistoryDates(data);
        if (!historyPayload) await loadHistoryList();
      }
    } catch (err) {
      const code = err?.data?.error || err.message;
      if (isLiveDataPage()) {
        if (err.status === 403 || code === "staff_access_required" || code === "overlay_dev_required") {
          showGate("접근 권한이 없습니다. 시리안 또는 허용된 계정으로 숲 로그인해 주세요.");
        } else if (err.status === 401) {
          showGate("숲 로그인이 필요합니다.");
        } else {
          showGate(`데이터를 불러오지 못했습니다: ${code}`);
        }
      } else if (err.status === 403 || code === "overlay_dev_required") {
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
  els.dataBody?.addEventListener("click", (ev) => {
    const zoomBtn = ev.target?.closest?.("[data-chart-zoom]");
    if (zoomBtn) {
      onChartZoomAction(zoomBtn.getAttribute("data-chart-zoom"));
      return;
    }
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
  window.addEventListener("scroll", scheduleScrollPersist, { passive: true });
  els.dataBody?.addEventListener("scroll", (ev) => {
    const scroller = ev.target?.closest?.("[data-chart-pan-scroll]");
    if (scroller) scheduleChartPanFromScroll(scroller);
    scheduleScrollPersist();
  }, { passive: true, capture: true });
  els.dataBody?.addEventListener("wheel", onChartPanWheel, { passive: false, capture: true });
  window.addEventListener(
    "resize",
    () => {
      if (!els.dataBody) return;
      syncChartPanScroll(els.dataBody);
      scheduleChartLayoutRerender();
    },
    { passive: true }
  );

  window.__liveDataRefresh = () => refresh();

  window.__liveDataLogout = () => {
    if (timer) clearInterval(timer);
    timer = null;
    lastData = null;
    historyPayload = null;
    showGate("시리안 또는 허용된 계정으로 숲 로그인해 주세요.");
  };

  (async () => {
    if (isLiveDataPage()) {
      try {
        await (window.__liveDataAuthReady || Promise.resolve(false));
      } catch (_) {
        /* ignore */
      }
      window.__liveDataAuth?.clearOauthBusy?.();
      const gateMsg = String(window.__liveDataGateMsg || "").trim();
      if (gateMsg) {
        window.__liveDataGateMsg = "";
        showGate(gateMsg);
      }
    }
    await refresh();
    schedule();
  })();
})();
