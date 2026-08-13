(() => {
  const TOKEN_KEY = "ending_soop_access_token";
  const REFRESH_KEY = "ending_soop_refresh_token";
  const STATION_KEY = "ending_soop_station_id";
  const OAUTH_NEXT_KEY = "ending_oauth_next";
  const SDK_URL = "https://static.sooplive.com/asset/app/chat-sdk/sooplive-chat-sdk.js";

  const base = () => window.CREDITS_BASE || "";

  function apiUrl(path) {
    const p = String(path || "");
    if (/^https?:\/\//i.test(p)) return p;
    const normalized = p.startsWith("/") ? p : `/${p}`;
    return `${base()}${normalized}`;
  }

  const els = {
    gate: document.getElementById("diary-auth-gate"),
    app: document.getElementById("diary-app"),
    authMsg: document.getElementById("diary-auth-msg"),
    login: document.getElementById("diary-login"),
    logout: document.getElementById("diary-logout"),
    pageTitle: document.getElementById("diary-page-title"),
    pageDesc: document.getElementById("diary-page-desc"),
    nick: document.getElementById("diary-nick"),
    station: document.getElementById("diary-station"),
    indexHint: document.getElementById("diary-index-hint"),
    dateList: document.getElementById("diary-date-list"),
    refresh: document.getElementById("diary-refresh"),
    empty: document.getElementById("diary-empty"),
    detail: document.getElementById("diary-detail"),
    dayWeekday: document.getElementById("diary-day-weekday"),
    dayDate: document.getElementById("diary-day-date"),
    entryTabs: document.getElementById("diary-entry-tabs"),
    obsLink: document.getElementById("diary-obs-link"),
    thumbWrap: document.getElementById("diary-thumb-wrap"),
    thumb: document.getElementById("diary-thumb"),
    thumbCap: document.getElementById("diary-thumb-cap"),
    thumbCapInline: document.getElementById("diary-thumb-cap-inline"),
    stamp: document.getElementById("diary-stamp"),
    detailTitle: document.getElementById("diary-detail-title"),
    readerTime: document.getElementById("diary-reader-time"),
    stats: document.getElementById("diary-stats"),
    chartsHint: document.getElementById("diary-charts-hint"),
    chartsGrid: document.getElementById("diary-charts"),
    chartViewers: document.getElementById("diary-chart-viewers"),
    chartUp: document.getElementById("diary-chart-up"),
    chartBalloons: document.getElementById("diary-chart-balloons"),
    timeline: document.getElementById("diary-timeline"),
    ranks: document.getElementById("diary-ranks"),
  };

  const state = {
    boot: null,
    profile: null,
    stationId: "",
    /** 일기장에 표시하는 방송 채널 — 로그인 계정과 무관, 시리안 고정 */
    diaryStationId: "sirianrain",
    dates: [],
    selectedDate: "",
    entries: [],
    selectedArchiveId: "",
    charts: { viewers: null, up: null, balloons: null },
  };

  let sdkLoadPromise = null;

  const WEEKDAYS = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
  const RANK_IDS = [
    "chat",
    "donation",
    "watch",
    "subscribe",
    "subscribe_renew",
    "fanclub",
    "topfan",
    "emoticon",
    "signature",
    "quickview",
    "mission",
  ];

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatNumber(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return "—";
    return num.toLocaleString("ko-KR");
  }

  function parseDateKey(dateKey) {
    const m = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function formatDateHead(dateKey) {
    const d = parseDateKey(dateKey);
    if (!d) return { weekday: "—", label: dateKey || "—" };
    return {
      weekday: WEEKDAYS[d.getDay()],
      label: `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`,
    };
  }

  function formatClock(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleTimeString("ko-KR", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Seoul",
    });
  }

  function clockFromLabel(label) {
    const s = String(label || "");
    const m = s.match(/(\d{1,2}:\d{2})/);
    return m ? m[1] : "";
  }

  function hasToken() {
    return Boolean(localStorage.getItem(TOKEN_KEY) || "");
  }

  function looksLikeSoopUserId(id) {
    const s = String(id || "").trim();
    if (!s || s.length > 64 || /\s/.test(s) || /^\d+$/.test(s)) return false;
    return /^[A-Za-z0-9_.\-]+$/.test(s);
  }

  function stationIdFromJwt(token) {
    try {
      const parts = String(token || "").split(".");
      if (parts.length < 2) return "";
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const pad = "=".repeat((4 - (b64.length % 4)) % 4);
      const json = JSON.parse(atob(b64 + pad));
      if (!json || typeof json !== "object") return "";
      for (const key of [
        "user_id",
        "userId",
        "bj_id",
        "bjId",
        "login_id",
        "loginId",
        "streamer_id",
        "streamerId",
        "station_id",
        "stationId",
        "preferred_username",
        "username",
        "sub",
      ]) {
        const cand = String(json[key] || "").trim();
        if (looksLikeSoopUserId(cand)) return cand;
      }
    } catch (_) {
      /* ignore */
    }
    return "";
  }

  function setStation(id) {
    const sid = String(id || "").trim();
    if (!looksLikeSoopUserId(sid)) return false;
    state.stationId = sid;
    try {
      localStorage.setItem(STATION_KEY, sid);
    } catch (_) {
      /* ignore */
    }
    return true;
  }

  /** 일기장 데이터는 항상 시리안 채널 */
  function diaryStationId() {
    const fromBoot = String(state.boot?.sirianStationId || "").trim();
    if (looksLikeSoopUserId(fromBoot)) {
      state.diaryStationId = fromBoot.toLowerCase();
      return state.diaryStationId;
    }
    const cur = String(state.diaryStationId || "sirianrain").trim().toLowerCase();
    state.diaryStationId = looksLikeSoopUserId(cur) ? cur : "sirianrain";
    return state.diaryStationId;
  }

  function cachedStationId() {
    try {
      const sid = String(localStorage.getItem(STATION_KEY) || "").trim();
      return looksLikeSoopUserId(sid) ? sid : "";
    } catch (_) {
      return "";
    }
  }

  async function resolveStationId(profile) {
    // 로그인 채널은 유저바용으로만 보관. 일기장 API는 diaryStationId 사용.
    const fromProfile = String(profile?.stationId || "").trim();
    if (setStation(fromProfile)) return state.stationId;
    const cached = cachedStationId();
    if (setStation(cached)) return state.stationId;
    const fromJwt = stationIdFromJwt(localStorage.getItem(TOKEN_KEY) || "");
    if (setStation(fromJwt)) return state.stationId;
    return state.stationId || "";
  }

  async function fetchJson(path, opts = {}) {
    const res = await fetch(apiUrl(path), {
      credentials: "same-origin",
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.detail || `HTTP ${res.status}`);
    return data;
  }

  function withStation(path) {
    const sid = diaryStationId();
    const joiner = String(path).includes("?") ? "&" : "?";
    return `${path}${joiner}stationId=${encodeURIComponent(sid)}`;
  }

  function peakThumbUrl(archiveId) {
    return apiUrl(`/api/credits/archive-peak-thumb?archiveId=${encodeURIComponent(archiveId)}`);
  }

  function getChatSdkCtor() {
    const root = window.SOOP || window;
    return root.ChatSDK || root.SoopChatSDK || null;
  }

  function loadChatSdk() {
    if (getChatSdkCtor()) return Promise.resolve(getChatSdkCtor());
    if (sdkLoadPromise) return sdkLoadPromise;
    sdkLoadPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-ending-sdk="1"]`);
      if (existing) {
        const wait = () => {
          const ctor = getChatSdkCtor();
          if (ctor) return resolve(ctor);
          reject(new Error("Chat SDK가 없습니다."));
        };
        if (existing.dataset.loaded === "1") wait();
        else {
          existing.addEventListener("load", wait, { once: true });
          existing.addEventListener("error", () => reject(new Error("Chat SDK 로드 실패")), {
            once: true,
          });
        }
        return;
      }
      const s = document.createElement("script");
      s.src = SDK_URL;
      s.async = true;
      s.dataset.endingSdk = "1";
      s.onload = () => {
        s.dataset.loaded = "1";
        const ctor = getChatSdkCtor();
        if (ctor) resolve(ctor);
        else reject(new Error("Chat SDK 전역 객체를 찾지 못했습니다."));
      };
      s.onerror = () => reject(new Error("Chat SDK를 불러오지 못했습니다."));
      document.head.appendChild(s);
    }).catch((err) => {
      sdkLoadPromise = null;
      throw err;
    });
    return sdkLoadPromise;
  }

  function makeChat() {
    const Ctor = getChatSdkCtor();
    const clientId = state.boot?.clientId || "";
    const clientSecret = state.boot?.clientSecret || "";
    if (!Ctor || !clientId || !clientSecret) return null;
    const chat = new Ctor(clientId, clientSecret);
    if (typeof chat.init === "function") chat.init();
    return chat;
  }

  function setLoginReady(ready, label) {
    if (!els.login) return;
    els.login.disabled = !ready;
    els.login.textContent = label || (ready ? "숲으로 로그인" : "준비 중…");
  }

  function showGate(message) {
    document.body.dataset.phase = "gate";
    if (els.gate) els.gate.hidden = false;
    if (els.app) els.app.hidden = true;
    if (els.authMsg && message) els.authMsg.textContent = message;
  }

  function showApp() {
    document.body.dataset.phase = "ready";
    if (els.gate) els.gate.hidden = true;
    if (els.app) els.app.hidden = false;
  }

  function applyProfile(profile) {
    state.profile = profile;
    const viewerNick = String(profile?.userNick || profile?.stationName || "").trim() || "스태프";
    const viewerSid = String(profile?.stationId || state.stationId || "").trim();
    if (looksLikeSoopUserId(viewerSid)) setStation(viewerSid);
    const diarySid = diaryStationId();
    if (els.nick) els.nick.textContent = viewerNick;
    if (els.station) els.station.textContent = diarySid;
    if (els.pageTitle) els.pageTitle.textContent = "시리안 방송 일기장";
    if (els.pageDesc) {
      els.pageDesc.textContent =
        `시리안(${diarySid}) 방송을 날짜별로 모아 방제·시청·분석 그래프를 되돌아봅니다.`;
    }
  }

  function isUsableProfile(profile) {
    if (!profile || typeof profile !== "object") return false;
    return Boolean(
      String(profile.userNick || "").trim() ||
        String(profile.stationId || "").trim() ||
        String(profile.stationName || "").trim()
    );
  }

  async function loadProfile() {
    const token = localStorage.getItem(TOKEN_KEY) || "";
    if (!token) return null;
    try {
      const data = await fetchJson("/api/credits/me", {
        method: "POST",
        body: JSON.stringify({ accessToken: token }),
      });
      if (data?.ok && isUsableProfile(data)) {
        applyProfile(data);
        return data;
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  async function tryRefreshToken(chat) {
    const refresh = localStorage.getItem(REFRESH_KEY) || "";
    if (!refresh || !chat || typeof chat.refreshAuth !== "function") return false;
    try {
      const tokens = await chat.refreshAuth(refresh);
      if (tokens?.access_token) {
        localStorage.setItem(TOKEN_KEY, tokens.access_token);
        if (tokens.refresh_token) localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
        await loadProfile();
        return true;
      }
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  async function ensureProfile() {
    let profile = await loadProfile();
    if (isUsableProfile(profile)) return profile;
    const chat = makeChat();
    if (chat) {
      const ok = await tryRefreshToken(chat);
      if (ok) return state.profile;
      profile = await loadProfile();
      if (isUsableProfile(profile)) return profile;
    }
    return null;
  }

  async function startOauth() {
    setLoginReady(false, "여는 중…");
    try {
      await loadChatSdk();
    } catch (err) {
      if (els.authMsg) els.authMsg.textContent = err.message || String(err);
      setLoginReady(Boolean(state.boot?.clientId), "숲으로 로그인");
      return;
    }
    const chat = makeChat();
    if (!chat || typeof chat.openAuth !== "function") {
      if (els.authMsg) {
        els.authMsg.textContent = "이 브라우저에서 숲 로그인을 열 수 없습니다.";
      }
      setLoginReady(true, "숲으로 로그인");
      return;
    }
    try {
      sessionStorage.setItem(OAUTH_NEXT_KEY, "diary");
    } catch (_) {
      /* ignore */
    }
    chat.openAuth();
  }

  function logout() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(STATION_KEY);
    } catch (_) {
      /* ignore */
    }
    state.profile = null;
    state.stationId = "";
    state.dates = [];
    state.entries = [];
    destroyCharts();
    document.getElementById("diary-station-tip")?.remove();
    showGate("스태프 숲 계정으로 로그인하면 시리안 방송 일기장을 볼 수 있습니다.");
    setLoginReady(true, "숲으로 로그인");
    if (els.pageTitle) els.pageTitle.textContent = "시리안 방송 일기장";
    if (els.pageDesc) {
      els.pageDesc.textContent =
        "시리안 방송을 날짜별로 모아 방제·시청·분석 그래프를 되돌아봅니다.";
    }
  }

  function show(view) {
    if (els.empty) els.empty.hidden = view !== "empty";
    if (els.detail) els.detail.hidden = view !== "detail";
  }

  function setHash({ date, archive } = {}) {
    const parts = [];
    if (date) parts.push(`date=${encodeURIComponent(date)}`);
    if (archive) parts.push(`id=${encodeURIComponent(archive)}`);
    const next = parts.length ? `#${parts.join("&")}` : "#";
    if (location.hash !== next) {
      history.replaceState(null, "", next === "#" ? location.pathname + location.search : next);
    }
  }

  function readHash() {
    const raw = String(location.hash || "").replace(/^#/, "");
    const params = new URLSearchParams(raw.includes("=") ? raw : "");
    if (!raw.includes("=") && /^\d{4}-\d{2}-\d{2}\//.test(raw)) {
      return { date: raw.slice(0, 10), archive: raw };
    }
    return {
      date: params.get("date") || "",
      archive: params.get("id") || "",
    };
  }

  function meaningfulEntry(item) {
    const peak = Number(item.peakViewers) || 0;
    const title = String(item.title || "").trim();
    const chatters = Number(item.chatters) || 0;
    return peak > 0 || chatters > 0 || title.length > 0;
  }

  function pickDefaultEntry(entries, preferArchive) {
    if (preferArchive) {
      const hit = entries.find((e) => e.archiveId === preferArchive);
      if (hit) return hit;
    }
    const meaningful = entries.filter(meaningfulEntry);
    const pool = meaningful.length ? meaningful : entries;
    return pool.slice().sort((a, b) => {
      const pa = Number(a.peakViewers) || 0;
      const pb = Number(b.peakViewers) || 0;
      if (pb !== pa) return pb - pa;
      return String(b.startedAt || "").localeCompare(String(a.startedAt || ""));
    })[0];
  }

  function destroyCharts() {
    for (const key of Object.keys(state.charts)) {
      try {
        state.charts[key]?.destroy?.();
      } catch (_) {
        /* ignore */
      }
      state.charts[key] = null;
    }
  }

  function seriesPoints(series) {
    if (!Array.isArray(series)) return [];
    return series
      .filter((p) => p && p.at != null && Number.isFinite(Number(p.v)))
      .map((p) => ({ at: String(p.at), v: Number(p.v) }));
  }

  function chartLabels(points) {
    return points.map((p) =>
      new Date(p.at).toLocaleTimeString("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Seoul",
      })
    );
  }

  function makeLineChart(canvas, points, color, label) {
    if (!canvas || typeof window.Chart !== "function") return null;
    const labels = chartLabels(points);
    const data = points.map((p) => p.v);
    return new window.Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label,
            data,
            borderColor: color,
            backgroundColor: color + "22",
            borderWidth: 2,
            // 선은 부드럽게. 점이 많을 땐 점 숨기고, 적을 때만 실측 점 표시
            pointRadius: points.length > 24 ? 0 : 2.5,
            pointHoverRadius: 4,
            tension: 0.35,
            fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => `${label}: ${Number(ctx.parsed.y).toLocaleString("ko-KR")}`,
            },
          },
        },
        scales: {
          x: {
            ticks: {
              maxTicksLimit: 8,
              color: "#6b7280",
              font: { size: 10 },
            },
            grid: { display: false },
          },
          y: {
            beginAtZero: true,
            ticks: {
              color: "#6b7280",
              font: { size: 10 },
              callback: (v) => Number(v).toLocaleString("ko-KR"),
            },
            grid: { color: "rgba(74, 96, 169, 0.12)" },
          },
        },
      },
    });
  }

  function renderCharts(metrics) {
    destroyCharts();
    const viewers = seriesPoints(metrics?.viewers);
    const up = seriesPoints(metrics?.up);
    const balloons = seriesPoints(metrics?.balloons);
    const any = viewers.length || up.length || balloons.length;

    if (els.chartsHint) {
      if (!any) {
        els.chartsHint.hidden = false;
        els.chartsHint.textContent =
          "이 방송에는 시계열 기록이 없습니다. 배포 이후 방송부터 시청·UP은 자동으로, 풍선은 수집기를 켠 구간에서 쌓입니다.";
      } else {
        els.chartsHint.hidden = true;
        els.chartsHint.textContent = "";
      }
    }
    if (els.chartsGrid) els.chartsGrid.hidden = !any;
    if (!any) return;

    state.charts.viewers = makeLineChart(els.chartViewers, viewers, "#4a60a9", "시청자");
    state.charts.up = makeLineChart(els.chartUp, up, "#c45c26", "UP");
    state.charts.balloons = makeLineChart(els.chartBalloons, balloons, "#2f9e6b", "풍선");
  }

  function renderDates() {
    if (!els.dateList) return;
    if (!state.dates.length) {
      if (els.indexHint) els.indexHint.textContent = "아직 보관된 방송이 없습니다.";
      els.dateList.innerHTML = "";
      show("empty");
      return;
    }
    if (els.indexHint) {
      els.indexHint.textContent = `${state.dates.length}일의 기록이 있어요.`;
    }
    els.dateList.innerHTML = state.dates
      .map((row) => {
        const head = formatDateHead(row.date);
        const peak = Number(row.peakViewers) || 0;
        const title = String(row.title || "").trim();
        const active = row.date === state.selectedDate ? " is-active" : "";
        return `<li>
          <button type="button" data-date="${escapeHtml(row.date)}" class="${active.trim()}">
            <span class="diary-date-list__day">${escapeHtml(head.label.replace(/^\d+년\s*/, ""))}</span>
            <span class="diary-date-list__meta">${escapeHtml(head.weekday)} · ${row.count}회${
          peak ? ` · 최고 ${formatNumber(peak)}명` : ""
        }</span>
            ${title ? `<span class="diary-date-list__title">${escapeHtml(title)}</span>` : ""}
          </button>
        </li>`;
      })
      .join("");
  }

  function renderEntryTabs() {
    if (!els.entryTabs) return;
    if (state.entries.length <= 1) {
      els.entryTabs.hidden = true;
      els.entryTabs.innerHTML = "";
      return;
    }
    els.entryTabs.hidden = false;
    els.entryTabs.innerHTML = state.entries
      .map((item) => {
        const label = formatClock(item.startedAt);
        const active = item.archiveId === state.selectedArchiveId ? " is-active" : "";
        return `<button type="button" data-archive="${escapeHtml(item.archiveId)}" class="${active.trim()}">${escapeHtml(label)}</button>`;
      })
      .join("");
  }

  function renderStats(info) {
    if (!els.stats) return;
    const rows = [
      ["방송 시간", info.durationLabel || "—"],
      ["최고 시청", info.peakViewers ? `${formatNumber(info.peakViewers)}명` : "—"],
      ["피크 시각", info.peakAtLabel || "—"],
      [
        "채팅",
        info.chatters || info.chatCount
          ? `${info.chatters ? `${formatNumber(info.chatters)}명` : "—"}${
              info.chatCount ? ` · ${formatNumber(info.chatCount)}건` : ""
            }`
          : "—",
      ],
    ];
    if (info.upGain != null && Number(info.upGain) > 0) {
      rows.push(["UP 증가", `${formatNumber(info.upGain)}`]);
    } else if (info.lastUpCount != null && info.lastUpCount !== "") {
      rows.push(["UP", formatNumber(info.lastUpCount)]);
    }
    if (info.balloonTotal != null && Number(info.balloonTotal) > 0) {
      rows.push(["풍선", `${formatNumber(info.balloonTotal)}개`]);
    }
    els.stats.innerHTML = rows
      .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
      .join("");
  }

  function renderTimeline(timeline) {
    if (!els.timeline) return;
    const markers = (timeline?.markers || []).filter((m) => m && m.kind !== "now");
    const hasCollector = markers.some(
      (m) => m.kind === "collector_on" || m.kind === "collector_off"
    );
    if (!markers.length) {
      els.timeline.innerHTML = `<li><span class="diary-timeline__dot" aria-hidden="true"></span><p class="diary-timeline__text ending-muted">타임라인 기록이 없습니다.</p></li>`;
      return;
    }
    const note = hasCollector
      ? ""
      : `<li class="diary-timeline__note"><span class="diary-timeline__note-text ending-muted">이 방송에는 수집기 연결 기록이 없습니다. 앞으로 수집기를 켜 두면 여기에 표시됩니다.</span></li>`;
    els.timeline.innerHTML =
      note +
      markers
        .map((m) => {
          const clock = clockFromLabel(m.label) || formatClock(m.at);
          let kindLabel = "방제 변경";
          if (m.kind === "start") kindLabel = "방송 시작";
          else if (m.kind === "end") kindLabel = "방송 종료";
          else if (m.kind === "collector_on") kindLabel = "수집 시작";
          else if (m.kind === "collector_off") kindLabel = "수집 종료";
          const title = String(m.title || "").trim();
          const showTitle =
            title &&
            m.kind !== "end" &&
            m.kind !== "collector_on" &&
            m.kind !== "collector_off";
          const titleBit = showTitle
            ? `<span class="diary-timeline__title">${escapeHtml(title)}</span>`
            : m.estimated || title === "추정"
              ? `<span class="diary-timeline__title">채팅 기록으로 추정</span>`
              : "";
          return `<li data-kind="${escapeHtml(m.kind || "title")}">
          <span class="diary-timeline__dot" aria-hidden="true"></span>
          <div class="diary-timeline__body">
            <p class="diary-timeline__text">
              <span class="diary-timeline__clock">${escapeHtml(clock)}</span>
              <strong>${escapeHtml(kindLabel)}</strong>
            </p>
            ${titleBit}
          </div>
        </li>`;
        })
        .join("");
  }

  function renderRanks(sections) {
    if (!els.ranks) return;
    const byId = new Map((sections || []).map((s) => [s.id, s]));
    const cards = [];
    for (const id of RANK_IDS) {
      const sec = byId.get(id);
      if (!sec) continue;
      const items = (sec.items || []).filter((it) => it && (it.name || it.value));
      if (!items.length) continue;
      const rows = items
        .slice(0, 8)
        .map(
          (it, idx) => `<li>
            <span class="rank">${escapeHtml(it.rank || idx + 1)}</span>
            <span>${escapeHtml(it.name || "—")}</span>
            <span class="val">${escapeHtml(it.value ?? "")}</span>
          </li>`
        )
        .join("");
      cards.push(
        `<article class="diary-rank-card"><h5>${escapeHtml(sec.title || id)}</h5><ol>${rows}</ol></article>`
      );
    }
    if (!cards.length) {
      els.ranks.innerHTML =
        `<p class="diary-rank-empty">채팅·후원 순위는 수집기 탭을 켠 방송에서만 쌓입니다. 방제·시청은 서버가 따로 모아 둡니다.</p>`;
      return;
    }
    els.ranks.innerHTML = cards.join("");
  }

  async function loadDates() {
    const data = await fetchJson(withStation("/api/credits/archive-dates?limit=180"));
    state.dates = Array.isArray(data.items) ? data.items : [];
    renderDates();
  }

  async function openArchive(archiveId) {
    // 일기장은 스태프 전용·시리안 아카이브만 노출. 로그인 계정과 채널 일치 검사는 하지 않음.
    state.selectedArchiveId = archiveId;
    renderEntryTabs();
    show("detail");
    setHash({ date: state.selectedDate || archiveId.slice(0, 10), archive: archiveId });

    if (els.detailTitle) els.detailTitle.textContent = "불러오는 중…";
    if (els.readerTime) els.readerTime.textContent = "";
    if (els.timeline) els.timeline.innerHTML = "";
    if (els.ranks) els.ranks.innerHTML = "";
    if (els.stats) els.stats.innerHTML = "";
    destroyCharts();

    const credits = await fetchJson(`/api/credits?archive=${encodeURIComponent(archiveId)}`);
    const info = credits.info || {};
    const session = credits.session || {};

    const meta = state.entries.find((e) => e.archiveId === archiveId) || {};
    const title = String(info.title || meta.title || "").trim() || "(방제 없음)";
    if (els.detailTitle) els.detailTitle.textContent = title;
    if (els.stamp) els.stamp.textContent = info.dateLabel || "방종";
    if (els.readerTime) {
      const start = formatClock(meta.startedAt || session.startedAt);
      const end = formatClock(meta.endedAt || session.endedAt);
      els.readerTime.textContent = `${start} – ${end}`;
    }
    if (els.obsLink) {
      els.obsLink.href = `${base()}/obs?obs=1&archive=${encodeURIComponent(archiveId)}`;
    }

    const thumbPath = String(info.peakThumbUrl || "").trim();
    const hasThumb = Boolean(thumbPath) || Boolean(meta.hasPeakThumb);
    if (els.thumbWrap && els.thumb) {
      if (hasThumb) {
        els.thumbWrap.hidden = false;
        els.thumb.src = thumbPath.startsWith("http")
          ? thumbPath
          : thumbPath
            ? apiUrl(thumbPath)
            : peakThumbUrl(archiveId);
        const bits = [];
        if (info.peakViewers) bits.push(`최고 ${formatNumber(info.peakViewers)}명`);
        if (info.peakAtLabel) bits.push(info.peakAtLabel);
        const cap = bits.join(" · ") || "최고 시청 순간";
        if (els.thumbCap) els.thumbCap.textContent = cap;
        if (els.thumbCapInline) {
          els.thumbCapInline.hidden = false;
          els.thumbCapInline.textContent = cap;
        }
      } else {
        els.thumbWrap.hidden = true;
        els.thumb.removeAttribute("src");
        if (els.thumbCapInline) {
          els.thumbCapInline.hidden = true;
          els.thumbCapInline.textContent = "";
        }
      }
    }

    renderStats(info);
    renderCharts(credits.metricsSeries || {});
    renderTimeline(credits.timeline || {});
    renderRanks(credits.sections || []);
  }

  async function openDate(dateKey, { preferArchive = "" } = {}) {
    state.selectedDate = dateKey;
    state.selectedArchiveId = "";
    renderDates();

    const head = formatDateHead(dateKey);
    if (els.dayWeekday) els.dayWeekday.textContent = head.weekday;
    if (els.dayDate) els.dayDate.textContent = head.label;
    if (els.detailTitle) els.detailTitle.textContent = "불러오는 중…";
    show("detail");

    const data = await fetchJson(
      withStation(`/api/credits/archives?date=${encodeURIComponent(dateKey)}&limit=80`)
    );
    state.entries = Array.isArray(data.items) ? data.items : [];
    if (!state.entries.length) {
      show("empty");
      if (els.empty) {
        els.empty.querySelector("h2").textContent = "이 날짜에는 기록이 없어요";
      }
      setHash({ date: dateKey });
      return;
    }

    const pick = pickDefaultEntry(state.entries, preferArchive);
    if (!pick) {
      show("empty");
      return;
    }
    await openArchive(pick.archiveId);
  }

  async function bootFromHash() {
    const { date, archive } = readHash();
    if (archive) {
      await openDate(date || archive.slice(0, 10), { preferArchive: archive });
      return;
    }
    if (date) {
      await openDate(date);
      return;
    }
    if (state.dates[0]?.date) {
      await openDate(state.dates[0].date);
      return;
    }
    show("empty");
  }

  async function enterApp() {
    showApp();
    try {
      await loadDates();
      await bootFromHash();
    } catch (err) {
      if (els.indexHint) els.indexHint.textContent = `불러오기 실패: ${err.message || err}`;
      show("empty");
    }
  }

  async function boot() {
    setLoginReady(false, "준비 중…");
    try {
      const [bootData] = await Promise.all([
        fetchJson("/api/credits/bootstrap"),
        loadChatSdk().catch(() => null),
      ]);
      state.boot = bootData;

      if (!state.boot?.hasClientId || !state.boot?.hasClientSecret) {
        showGate("서버에 SOOP 제휴 키가 없습니다.");
        setLoginReady(false, "설정 필요");
        return;
      }

      if (!getChatSdkCtor()) {
        showGate("숲 Chat SDK를 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요.");
        setLoginReady(true, "다시 시도");
        return;
      }

      if (!hasToken()) {
        showGate("스태프 숲 계정으로 로그인하면 시리안 방송 일기장을 볼 수 있습니다.");
        setLoginReady(true, "숲으로 로그인");
        return;
      }

      const profile = await ensureProfile();
      if (!profile) {
        showGate("로그인 세션이 만료되었습니다. 다시 로그인해 주세요.");
        setLoginReady(true, "숲으로 로그인");
        return;
      }
      // bootstrap의 시리안 채널로 일기장 고정 (로그인 계정 아카이브 아님)
      diaryStationId();
      applyProfile(profile);
      await resolveStationId(profile);
      document.getElementById("diary-station-tip")?.remove();

      await enterApp();
    } catch (err) {
      showGate(`초기화 실패: ${err.message || err}`);
      setLoginReady(true, "다시 시도");
    }
  }

  els.dateList?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-date]");
    if (!btn) return;
    openDate(btn.getAttribute("data-date") || "").catch((err) => {
      if (els.indexHint) els.indexHint.textContent = err.message || String(err);
    });
  });

  els.entryTabs?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-archive]");
    if (!btn) return;
    openArchive(btn.getAttribute("data-archive") || "").catch((err) => {
      if (els.detailTitle) els.detailTitle.textContent = err.message || String(err);
    });
  });

  els.refresh?.addEventListener("click", () => {
    loadDates()
      .then(() => bootFromHash())
      .catch((err) => {
        if (els.indexHint) els.indexHint.textContent = err.message || String(err);
      });
  });

  els.login?.addEventListener("click", async () => {
    if (!state.boot || !getChatSdkCtor()) {
      await boot();
      if (hasToken() && state.stationId) return;
    }
    if (!hasToken()) await startOauth();
  });

  els.logout?.addEventListener("click", () => logout());

  window.addEventListener("hashchange", () => {
    if (!state.stationId) return;
    bootFromHash().catch(() => {});
  });

  boot();
})();
