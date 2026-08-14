(() => {
  const RT = window.EndingCollectRuntime;
  if (!RT?.create) {
    console.error("[ending-collector] collect-runtime.js required");
    return;
  }

  const TOKEN_KEY = RT.TOKEN_KEY;
  const REFRESH_KEY = RT.REFRESH_KEY;
  const STATION_KEY = RT.STATION_KEY;
  const OAUTH_NEXT_KEY = RT.OAUTH_NEXT_KEY;
  const OBS_SIZE_NOTICE_KEY = "ending_collector_obs_size_notice_v3";
  const CONTROL_CHANNEL = "sirian-credits-overlay";

  let controlBus = null;
  try {
    controlBus = new BroadcastChannel(CONTROL_CHANNEL);
  } catch (_) {
    controlBus = null;
  }

  const base = () => window.CREDITS_BASE || "";

  function apiUrl(path) {
    const p = String(path || "");
    if (/^https?:\/\//i.test(p)) return p;
    const normalized = p.startsWith("/") ? p : `/${p}`;
    return `${base()}${normalized}`;
  }

  const els = {
    gate: document.getElementById("collector-auth-gate"),
    main: document.getElementById("collector-main"),
    login: document.getElementById("collector-login"),
    authMsg: document.getElementById("collector-auth-msg"),
    gateLog: document.getElementById("collector-gate-log"),
    status: document.getElementById("collector-status"),
    station: document.getElementById("collector-station"),
    nick: document.getElementById("collector-nick"),
    avatar: document.getElementById("collector-avatar"),
    avatarFallback: document.getElementById("collector-avatar-fallback"),
    userExtra: document.getElementById("collector-user-extra"),
    eventCount: document.getElementById("collector-event-count"),
    disconnect: document.getElementById("collector-disconnect"),
    logout: document.getElementById("collector-logout"),
    retry: document.getElementById("collector-retry"),
    hint: document.getElementById("collector-hint"),
    log: document.getElementById("collector-log"),
    linkStudio: document.getElementById("link-studio"),
    devLink: document.getElementById("collector-dev-link"),
    creditsPlay: document.getElementById("collector-credits-play"),
    creditsStop: document.getElementById("collector-credits-stop"),
    themeSelect: document.getElementById("collector-theme"),
    copyObs: document.getElementById("collector-copy-obs"),
    timelineDay: document.getElementById("collector-timeline-day"),
    daybarTrack: document.getElementById("collector-daybar-track"),
    daybarLive: document.getElementById("collector-daybar-live"),
    daybarNow: document.getElementById("collector-daybar-now"),
    daybarHours: document.querySelector(".ending-daybar__hours"),
    timelineList: document.getElementById("collector-timeline-list"),
  };

  const state = {
    boot: null,
    stationId: "",
    profile: null,
    allowed: null,
    overlayDev: false,
    connected: false,
    obsKey: "",
    theme: "reportProj",
    timeline: null,
    timelineTimer: null,
  };

  function syncFromRuntime() {
    const rs = runtime.getState();
    state.connected = Boolean(rs.connected);
    state.stationId = String(rs.stationId || state.stationId || "");
    if (rs.profile) state.profile = rs.profile;
    if (els.eventCount) els.eventCount.textContent = String(rs.eventCount || 0);
    if (state.stationId && els.station) els.station.textContent = state.stationId;
  }

  function handleRuntimeStatus({ phase, detail, connected, eventCount, stationId }) {
    if (connected != null) state.connected = Boolean(connected);
    if (stationId) state.stationId = String(stationId);
    if (els.eventCount && eventCount != null) {
      els.eventCount.textContent = String(eventCount);
    }

    const text = String(detail || "").trim();
    switch (phase) {
      case "boot":
        setStatus("준비 중");
        break;
      case "waiting":
        setStatus(text || "방송 대기");
        setPhase("waiting");
        setRetryVisible(false);
        if (els.disconnect) els.disconnect.disabled = true;
        if (!text.includes("오프라인") && document.body.dataset.phase !== "collecting") {
          setHint(
            text ||
              "방송이 켜지면 자동으로 수집을 시작합니다. 이 탭을 방송 중 열어 두세요."
          );
        }
        break;
      case "connecting":
        setStatus(text || "연결 중");
        setPhase("waiting");
        break;
      case "collecting":
        setStatus(text || "수집 중");
        setPhase("collecting");
        setRetryVisible(false);
        if (els.disconnect) els.disconnect.disabled = false;
        setHint("수집 중 · 이 탭을 닫으면 수집이 멈춥니다. OBS는 표시용입니다.");
        break;
      case "need_login":
        showGate(
          text ||
            "로그인이 만료된 것 같습니다. 숲으로 다시 로그인해 주세요."
        );
        setLoginReady(true, "숲으로 로그인");
        break;
      case "error":
        markFailed("오류", text || "다시 시도해 주세요.");
        break;
      case "stopped":
        setStatus("일시 중지");
        setPhase("paused");
        setRetryVisible(true);
        if (els.disconnect) els.disconnect.disabled = true;
        setHint(
          text ||
            "수집을 멈췄습니다. 다시 시도로 재연결하거나, 새로고침하면 자동 연결이 다시 켜집니다."
        );
        break;
      default:
        break;
    }
    syncFromRuntime();
  }

  const runtime = RT.create({
    oauthNext: "collector",
    clientSource: "collector",
    onStatus: handleRuntimeStatus,
    onLog: (msg) => logLine(msg),
    onPollData: (data) => {
      if (data?.credits?.timeline) renderTimeline(data.credits.timeline);
      syncFromRuntime();
    },
    onProfile: (profile) => {
      if (!profile?.ok && profile !== null) return;
      if (profile) {
        state.allowed = profile.allowed !== false;
        state.overlayDev = Boolean(profile.overlayDev);
        syncDevMonitorLink();
        applyProfile(profile);
      }
    },
    onNeedLogin: () => {
      showGate("본인 숲 계정으로 로그인하면 그 방송의 엔딩을 만듭니다.");
      setLoginReady(true, "숲으로 로그인");
    },
  });

  function setPhase(phase) {
    document.body.dataset.phase = phase;
  }

  function logLine(message) {
    const stamp = new Date().toLocaleTimeString("ko-KR");
    const line = `[${stamp}] ${message}\n`;
    if (els.log) els.log.textContent = line + (els.log.textContent || "");
    if (els.gateLog) {
      els.gateLog.hidden = false;
      els.gateLog.textContent = line + (els.gateLog.textContent || "");
    }
    console.log("[ending-collector]", message);
  }

  function setStatus(text) {
    if (els.status) els.status.textContent = text;
  }

  function setHint(text) {
    if (els.hint) els.hint.textContent = text;
  }

  function setRetryVisible(show) {
    if (!els.retry) return;
    els.retry.hidden = !show;
    els.retry.disabled = false;
  }

  function markFailed(statusText, hintText) {
    setStatus(statusText || "연결 실패");
    setPhase("failed");
    setHint(hintText || "다시 시도하거나, 로그아웃 후 재로그인해 보세요.");
    setRetryVisible(true);
    showMain();
  }

  function markWaiting(hintText) {
    setStatus("방송 대기");
    setPhase("waiting");
    setRetryVisible(false);
    setHint(hintText || "방송이 켜지면 자동으로 수집을 시작합니다. 이 탭을 방송 중 열어 두세요.");
    showMain();
    if (els.disconnect) els.disconnect.disabled = true;
  }

  function isUsableProfile(profile) {
    if (!profile || typeof profile !== "object") return false;
    return Boolean(
      String(profile.userNick || "").trim() ||
        String(profile.stationId || "").trim() ||
        String(profile.stationName || "").trim()
    );
  }

  function syncCreditsTransport(playing) {
    els.creditsPlay?.classList.toggle("is-on", Boolean(playing));
    els.creditsStop?.classList.toggle("is-on", playing === false);
  }

  function normalizeThemeId(raw) {
    const id = String(raw || "").trim();
    if (id === "report" || id === "reportProj") return id;
    return "reportProj";
  }

  function currentTheme() {
    return normalizeThemeId(els.themeSelect?.value || state.theme);
  }

  function fillThemeSelect(theme) {
    const id = normalizeThemeId(theme);
    state.theme = id;
    if (els.themeSelect) els.themeSelect.value = id;
  }

  async function loadOverlayTheme() {
    try {
      const cfg = await fetchJson("/api/credits/overlay-config");
      fillThemeSelect(cfg?.theme);
    } catch (_) {
      fillThemeSelect(state.theme || "reportProj");
    }
  }

  async function saveOverlayTheme(theme) {
    const id = normalizeThemeId(theme);
    state.theme = id;
    const cfg = await fetchJson("/api/credits/overlay-config");
    const body = cfg && typeof cfg === "object" ? { ...cfg, theme: id } : { theme: id };
    await fetchJson("/api/credits/overlay-config", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });
  }

  async function sendCreditsControl(action) {
    const theme = currentTheme();
    try {
      controlBus?.postMessage({
        type: action,
        theme: action === "play" ? theme : undefined,
        force: action === "play",
      });
    } catch (_) {
      /* ignore */
    }
    const body = { action };
    if (action === "play") body.theme = theme;
    await fetchJson("/api/credits/overlay-control", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });
  }

  async function playCredits() {
    try {
      const theme = currentTheme();
      fillThemeSelect(theme);
      await saveOverlayTheme(theme);
      await sendCreditsControl("play");
      syncCreditsTransport(true);
      const label = theme === "reportProj" ? "홀로그램 · 글래스" : "홀로그램 · 투영";
      logLine(`엔딩 크레딧 재생 신호 전송 (${label})`);
      setHint(`${label} 테마로 재생했습니다. OBS 브라우저 소스에서 한 사이클 후 종료됩니다.`);
    } catch (err) {
      logLine(`크레딧 재생 실패: ${err.message || err}`);
      setHint("크레딧 재생에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    }
  }

  async function stopCredits() {
    try {
      await sendCreditsControl("stop");
      syncCreditsTransport(false);
      logLine("엔딩 크레딧 종료 신호 전송");
      setHint("크레딧 재생을 중지했습니다.");
    } catch (err) {
      logLine(`크레딧 종료 실패: ${err.message || err}`);
    }
  }

  function overlayUrl({ bust = false } = {}) {
    const key = state.obsKey || runtime.getObsKey() || "";
    const qs = new URLSearchParams({ obs: "1" });
    if (key) qs.set("k", key);
    if (bust) qs.set("_", String(Date.now()));
    return `${location.origin}${base()}/obs?${qs.toString()}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function localNowPctFromTimeline(timeline) {
    if (!timeline?.startAt) return 0;
    const start = Date.parse(timeline.startAt);
    const end = timeline.endAt ? Date.parse(timeline.endAt) : Date.now();
    if (!Number.isFinite(start) || end <= start) return 0;
    const now = Date.now();
    const pct = ((Math.min(now, end) - start) / (end - start)) * 100;
    return Math.max(0, Math.min(100, pct));
  }

  function renderTimeline(timeline) {
    if (!timeline || typeof timeline !== "object") return;
    state.timeline = timeline;
    const startAt = timeline.startAt || "";
    const endAt = timeline.endAt || "";
    if (els.timelineDay) {
      const day = startAt ? startAt.slice(0, 10) : "—";
      els.timelineDay.textContent = day;
    }
    const pct = localNowPctFromTimeline(timeline);
    if (els.daybarLive) {
      els.daybarLive.style.width = `${pct}%`;
    }
    if (els.daybarNow) {
      els.daybarNow.style.left = `${pct}%`;
    }
    if (els.daybarHours && timeline.hours?.length) {
      els.daybarHours.innerHTML = timeline.hours
        .map((h) => `<span>${escapeHtml(h)}</span>`)
        .join("");
    }
    if (els.timelineList && Array.isArray(timeline.events)) {
      els.timelineList.innerHTML = timeline.events
        .slice(-40)
        .reverse()
        .map((ev) => {
          const t = ev.at ? new Date(ev.at).toLocaleTimeString("ko-KR") : "—";
          const label = escapeHtml(ev.label || ev.type || ev.action || "이벤트");
          const sub = ev.detail ? `<span class="ending-timeline__sub">${escapeHtml(ev.detail)}</span>` : "";
          return `<li><time>${t}</time><span>${label}</span>${sub}</li>`;
        })
        .join("");
    }
  }

  function startTimelineClock() {
    if (state.timelineTimer) clearInterval(state.timelineTimer);
    state.timelineTimer = setInterval(() => {
      if (state.timeline) {
        const pct = localNowPctFromTimeline(state.timeline);
        if (els.daybarLive) els.daybarLive.style.width = `${pct}%`;
        if (els.daybarNow) els.daybarNow.style.left = `${pct}%`;
      }
    }, 30000);
  }

  function looksLikeSoopUserId(id) {
    const s = String(id || "").trim();
    if (!s || s.length > 64 || /\s/.test(s) || /^\d+$/.test(s)) return false;
    if (/^u_[a-f0-9]{10,}$/i.test(s)) return false;
    return /^[A-Za-z0-9_.\-]+$/.test(s);
  }

  function syncDevMonitorLink() {
    if (els.devLink) els.devLink.hidden = !state.overlayDev;
  }

  function maskSecretUrl(url) {
    return String(url || "").replace(/([?&](?:k|key|access_token|refresh_token)=)[^&]*/gi, "$1…");
  }

  function setStation(id) {
    const sid = String(id || "").trim();
    if (!sid) return;
    if (!looksLikeSoopUserId(sid)) {
      if (/^u_[a-f0-9]/i.test(sid)) {
        if (els.station && !state.stationId) els.station.textContent = "연결 후 표시";
        return;
      }
      logLine(`채널 ID 무시(닉네임/한글): ${sid}`);
      return;
    }
    state.stationId = sid;
    try {
      localStorage.setItem(STATION_KEY, sid);
    } catch (_) {
      /* ignore */
    }
    if (els.station) els.station.textContent = state.stationId || "—";
  }

  function loadCachedStation() {
    try {
      const sid = String(localStorage.getItem(STATION_KEY) || "").trim();
      if (looksLikeSoopUserId(sid)) {
        state.stationId = sid;
        if (els.station) els.station.textContent = sid;
      } else if (sid) {
        localStorage.removeItem(STATION_KEY);
        if (els.station && !state.stationId) els.station.textContent = "연결 후 표시";
      }
    } catch (_) {
      /* ignore */
    }
  }

  function applyProfile(profile) {
    state.profile = profile && typeof profile === "object" ? profile : null;
    const nick = String(profile?.userNick || profile?.stationName || state.stationId || "—").trim();
    const station = String(profile?.stationId || "").trim();
    if (els.nick) els.nick.textContent = nick || "—";
    if (station) setStation(station);
    else if (els.station && !state.stationId) els.station.textContent = "채널 확인 중…";

    const img = String(profile?.profileImage || "").trim();
    if (els.avatar && img) {
      els.avatar.hidden = false;
      els.avatar.src = img;
      els.avatar.alt = `${nick} 프로필`;
      els.avatar.onerror = () => {
        els.avatar.hidden = true;
      };
    } else if (els.avatar) {
      els.avatar.hidden = true;
      els.avatar.removeAttribute("src");
    }
    if (els.avatarFallback) {
      els.avatarFallback.textContent = (nick || "?").slice(0, 1);
    }

    const bits = [];
    if (profile?.favoriteCount != null && profile.favoriteCount !== "") {
      bits.push(`애청자 ${Number(profile.favoriteCount).toLocaleString("ko-KR")}명`);
    }
    if (profile?.lastBroadDate) {
      bits.push(`최근 방송 ${profile.lastBroadDate}`);
    }
    if (els.userExtra) els.userExtra.textContent = bits.join(" · ");
  }

  function stationIdFromJwt(accessToken) {
    const token = String(accessToken || "").trim();
    const parts = token.split(".");
    if (parts.length < 2) return "";
    try {
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const pad = "=".repeat((4 - (b64.length % 4)) % 4);
      const json = JSON.parse(atob(b64 + pad));
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
        const cand = String(json?.[key] || "").trim();
        if (looksLikeSoopUserId(cand)) return cand;
      }
    } catch (_) {
      /* ignore */
    }
    return "";
  }

  async function ensureDedicatedObsLink({ rotate = false } = {}) {
    const access = localStorage.getItem(TOKEN_KEY) || "";
    if (!access) {
      return { ok: false, error: "token_required", message: "숲 로그인이 필요합니다." };
    }
    if (!state.stationId) {
      const fromJwt = stationIdFromJwt(access);
      if (fromJwt) setStation(fromJwt);
      else {
        const cached = String(localStorage.getItem(STATION_KEY) || "").trim();
        if (looksLikeSoopUserId(cached)) setStation(cached);
      }
    }
    try {
      const data = await fetchJson("/api/credits/obs-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Soop-Access-Token": access,
        },
        body: JSON.stringify({
          accessToken: access,
          refreshToken: localStorage.getItem(REFRESH_KEY) || "",
          stationId: state.stationId || localStorage.getItem(STATION_KEY) || "",
          rotate: rotate ? true : undefined,
        }),
      });
      if (data?.key) state.obsKey = String(data.key);
      if (data?.stationId && looksLikeSoopUserId(data.stationId)) {
        setStation(data.stationId);
      }
      return data;
    } catch (err) {
      const msg = err?.data?.message || err?.data?.error || err.message || String(err);
      logLine(`전용 OBS URL 발급 실패: ${msg}`);
      return {
        ok: false,
        error: err?.data?.error || "obs_link_failed",
        message: msg,
      };
    }
  }

  async function copyOverlayUrl() {
    const issued = state.obsKey ? { key: state.obsKey, ok: true } : await ensureDedicatedObsLink();
    if (!issued?.key) {
      setHint(issued?.message || "전용 URL을 만들지 못했습니다. 다시 로그인한 뒤 복사해 주세요.");
      return;
    }
    if (!state.obsKey && issued.key) state.obsKey = String(issued.key);
    const url = overlayUrl();
    const btn = els.copyObs;
    const prev = btn?.textContent || "오버레이 주소 복사";
    const done = () => {
      if (!btn) return;
      btn.textContent = "복사됨";
      setTimeout(() => {
        btn.textContent = prev;
      }, 2000);
    };
    try {
      await navigator.clipboard.writeText(url);
      done();
      logLine(`OBS URL 복사: ${maskSecretUrl(url)}`);
      setHint("OBS 브라우저 소스에 붙여 넣으세요. 수집은 이 탭에서 합니다.");
    } catch (_) {
      window.prompt("OBS 브라우저 소스 URL (복사해서 붙여넣기)", url);
      done();
    }
  }

  function showGate(message) {
    if (els.authMsg && message) els.authMsg.textContent = message;
    setRetryVisible(false);
    if (els.gate) {
      els.gate.hidden = false;
      els.gate.classList.remove("hidden");
    }
    if (els.main) {
      els.main.hidden = true;
      els.main.classList.add("hidden");
    }
    setPhase("gate");
  }

  function showMain() {
    if (els.gate) {
      els.gate.hidden = true;
      els.gate.classList.add("hidden");
    }
    if (els.main) {
      els.main.hidden = false;
      els.main.classList.remove("hidden");
    }
    loadOverlayTheme().catch(() => {});
  }

  function setLoginReady(ready, label) {
    if (!els.login) return;
    els.login.disabled = !ready;
    els.login.textContent = label || (ready ? "숲으로 로그인" : "준비 중…");
  }

  function hasToken() {
    return runtime.hasToken();
  }

  async function fetchJson(path, options = {}) {
    const res = await fetch(apiUrl(path), {
      credentials: "same-origin",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function authHeaders() {
    const token = localStorage.getItem(TOKEN_KEY) || "";
    return token ? { "X-Soop-Access-Token": token } : {};
  }

  function handleOauthQueryParams() {
    const params = new URLSearchParams(location.search);
    const oauthErr = params.get("error") || params.get("error_description");
    if (params.get("need") === "soop") {
      showGate("스튜디오·일기장은 허용된 숲 계정으로 로그인한 뒤 이용할 수 있습니다.");
      const url = new URL(location.href);
      url.searchParams.delete("need");
      history.replaceState({}, "", url.toString());
    }
    if (oauthErr) {
      logLine(`OAuth 오류: ${oauthErr}`);
      if (els.authMsg) els.authMsg.textContent = `로그인 실패: ${oauthErr}`;
      return false;
    }
    return true;
  }

  async function startOauth() {
    setLoginReady(false, "여는 중…");
    try {
      const { boot, sdkReady } = await runtime.prepareBoot();
      state.boot = boot;
      if (!boot?.hasClientId || !boot?.hasClientSecret || !sdkReady) {
        const msg = !sdkReady
          ? "숲 Chat SDK를 불러오지 못했습니다."
          : "서버에 SOOP API 키가 없습니다.";
        if (els.authMsg) els.authMsg.textContent = msg;
        logLine(msg);
        setLoginReady(Boolean(boot?.hasClientId) && sdkReady, "숲으로 로그인");
        return;
      }
      logLine("숲 로그인으로 이동합니다…");
      await runtime.startOauth();
    } catch (err) {
      logLine(err.message || String(err));
      setLoginReady(true, "숲으로 로그인");
    }
  }

  async function retryConnection() {
    if (!hasToken()) {
      showGate("로그인이 필요합니다. 숲으로 다시 로그인해 주세요.");
      setLoginReady(true, "숲으로 로그인");
      return;
    }
    if (els.retry) els.retry.disabled = true;
    setStatus("재시도 중");
    setHint("프로필과 채팅 연결을 다시 시도합니다…");
    setRetryVisible(true);
    try {
      const profile = await runtime.ensureProfile({ bind: true });
      if (!isUsableProfile(profile)) {
        markFailed(
          "프로필 연결 실패",
          "프로필을 불러오지 못했습니다. 다시 시도하거나 로그아웃 후 재로그인해 주세요."
        );
        return;
      }
      state.allowed = profile.allowed !== false;
      state.overlayDev = Boolean(profile.overlayDev);
      syncDevMonitorLink();
      applyProfile(profile);
      const ok = await runtime.retryConnect();
      if (!ok && document.body.dataset.phase === "waiting") {
        setRetryVisible(false);
      }
    } catch (err) {
      markFailed("연결 실패", err.message || "다시 시도해 주세요.");
      logLine(`재시도 실패: ${err.message || err}`);
    } finally {
      if (els.retry) els.retry.disabled = false;
    }
  }

  function logout() {
    runtime.stop();
    setRetryVisible(false);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(STATION_KEY);
    state.stationId = "";
    state.profile = null;
    state.allowed = null;
    state.overlayDev = false;
    state.connected = false;
    syncDevMonitorLink();
    state.obsKey = "";
    fetch(apiUrl("/api/credits/logout"), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {});
    showGate("로그아웃되었습니다. 필요할 때 다시 숲으로 로그인해 주세요.");
    setLoginReady(true, "숲으로 로그인");
  }

  async function boot() {
    setLoginReady(false, "준비 중…");
    try {
      handleOauthQueryParams();

      const { boot: bootData, sdkReady } = await runtime.prepareBoot();
      state.boot = bootData;

      if (!bootData?.hasClientId || !bootData?.hasClientSecret) {
        showGate("서버에 SOOP 제휴 키가 없습니다.");
        setLoginReady(false, "설정 필요");
        return;
      }

      if (!sdkReady) {
        showGate("숲 Chat SDK를 불러오지 못했습니다. 광고/스크립트 차단을 끄고 새로고침해 보세요.");
        setLoginReady(true, "다시 시도");
        return;
      }

      const oauthOk = await runtime.completeOauthIfNeeded();
      if (oauthOk) logLine("숲 로그인 완료");

      if (!hasToken()) {
        showGate("본인 숲 계정으로 로그인하면 그 방송의 엔딩을 만듭니다.");
        setLoginReady(true, "숲으로 로그인");
        return;
      }

      try {
        const next = sessionStorage.getItem(OAUTH_NEXT_KEY) || "";
        if (next === "diary") {
          sessionStorage.removeItem(OAUTH_NEXT_KEY);
          location.replace(`${base()}/diary/`);
          return;
        }
        if (next === "obs") {
          sessionStorage.removeItem(OAUTH_NEXT_KEY);
          location.replace(`${base()}/obs?obs=1`);
          return;
        }
        if (next === "live_data") {
          sessionStorage.removeItem(OAUTH_NEXT_KEY);
          location.replace(`${base()}/live_data`);
          return;
        }
      } catch (_) {
        /* ignore */
      }

      showMain();
      loadCachedStation();
      setStatus("프로필 확인 중");
      setHint("로그인 상태를 확인하는 중입니다…");

      const profile = await runtime.ensureProfile({ bind: true });
      if (profile && profile.allowed === false && !profile.overlayDev) {
        const sid = String(profile.stationId || "").trim();
        showGate(
          profile.message ||
            `허용된 숲 계정만 사용할 수 있습니다.${sid ? ` (현재: ${sid})` : ""}`
        );
        setLoginReady(true, "다른 계정으로 로그인");
        logLine(`비허용 계정: ${sid || "?"}`);
        return;
      }

      if (profile && profile.overlayDev && profile.allowed === false) {
        state.overlayDev = true;
        syncDevMonitorLink();
        showMain();
        setStatus("오버레이 개발");
        setPhase("idle");
        setHint("수집은 이 탭에서 합니다. OBS 전용 주소는 표시·재생용입니다.");
        logLine("오버레이 개발자 로그인 — 모니터 전용");
        setLoginReady(true, "로그아웃");
        return;
      }

      if (!profile) {
        if (els.nick && (els.nick.textContent === "—" || !els.nick.textContent.trim())) {
          els.nick.textContent = "프로필 없음";
        }
        markFailed(
          "프로필 연결 실패",
          "프로필을 불러오지 못했습니다. 다시 시도하거나 로그아웃 후 재로그인해 주세요."
        );
        return;
      }

      setStatus("방송 대기");
      setPhase("waiting");
      setRetryVisible(false);

      const link = await ensureDedicatedObsLink();
      if (link?.key) {
        setHint(
          "전용 OBS 주소가 준비됐습니다. 「오버레이 주소 복사」→ OBS에 붙이면 표시만 됩니다. 수집은 이 탭을 방송 중 열어 두세요."
        );
        logLine("전용 OBS 주소 발급됨");
      } else {
        setHint(
          link?.message ||
            "전용 URL 발급에 실패했습니다. 「오버레이 주소 복사」를 다시 눌러 보거나 재로그인해 주세요."
        );
      }

      if (!state.stationId && els.station) els.station.textContent = "프로필/연결 후 표시";
      await runtime.startCollect();
      startTimelineClock();
      runtime.pollLive({ quiet: true }).catch(() => {});
    } catch (err) {
      showGate(`초기화 실패: ${err.message || err}`);
      setLoginReady(true, "다시 시도");
    }
  }

  els.login?.addEventListener("click", async () => {
    if (!state.boot) {
      await boot();
      if (hasToken()) return;
    }
    if (!hasToken()) await startOauth();
  });
  els.disconnect?.addEventListener("click", () => runtime.pauseCollect());
  els.logout?.addEventListener("click", () => logout());
  els.retry?.addEventListener("click", () => {
    retryConnection().catch((err) => logLine(`재시도 오류: ${err.message || err}`));
  });
  els.creditsPlay?.addEventListener("click", () => {
    playCredits().catch((err) => logLine(`크레딧 재생 오류: ${err.message || err}`));
  });
  els.creditsStop?.addEventListener("click", () => {
    stopCredits().catch((err) => logLine(`크레딧 종료 오류: ${err.message || err}`));
  });
  els.themeSelect?.addEventListener("change", () => {
    const theme = currentTheme();
    fillThemeSelect(theme);
    saveOverlayTheme(theme)
      .then(() => {
        const label = theme === "reportProj" ? "홀로그램 · 글래스" : "홀로그램 · 투영";
        logLine(`오버레이 테마: ${label}`);
        setHint(`${label}로 저장했습니다. 크레딧 재생 시 OBS에 반영됩니다.`);
      })
      .catch((err) => logLine(`테마 저장 실패: ${err.message || err}`));
  });
  els.copyObs?.addEventListener("click", () => {
    copyOverlayUrl().catch((err) => logLine(`주소 복사 오류: ${err.message || err}`));
  });
  if (els.linkStudio) els.linkStudio.href = `${base()}/studio`;

  if (controlBus) {
    controlBus.onmessage = (event) => {
      const msg = event?.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "playing") syncCreditsTransport(true);
      else if (msg.type === "ended" || msg.type === "stopped" || msg.type === "stop") {
        syncCreditsTransport(false);
      }
    };
  }

  window.addEventListener("beforeunload", (e) => {
    if (!state.connected) return;
    e.preventDefault();
    e.returnValue = "";
  });

  function readObsSizeNoticeDismissed() {
    try {
      return localStorage.getItem(OBS_SIZE_NOTICE_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  function writeObsSizeNoticeDismissed() {
    try {
      localStorage.setItem(OBS_SIZE_NOTICE_KEY, "1");
    } catch (_) {
      /* ignore */
    }
  }

  function closeObsSizeNotice() {
    const root = document.getElementById("collector-obs-size-notice");
    if (!root) return;
    root.classList.add("hidden");
    root.hidden = true;
    root.setAttribute("aria-hidden", "true");
    document.removeEventListener("keydown", onObsSizeNoticeKeydown);
  }

  function onObsSizeNoticeKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeObsSizeNotice();
    }
  }

  function confirmObsSizeNotice() {
    const hide = document.getElementById("collector-obs-size-notice-hide");
    if (hide?.checked) writeObsSizeNoticeDismissed();
    closeObsSizeNotice();
  }

  function openObsSizeNotice() {
    const root = document.getElementById("collector-obs-size-notice");
    if (!root || readObsSizeNoticeDismissed()) return;
    root.hidden = false;
    root.classList.remove("hidden");
    root.setAttribute("aria-hidden", "false");
    document.addEventListener("keydown", onObsSizeNoticeKeydown);
    const ok = document.getElementById("collector-obs-size-notice-ok");
    requestAnimationFrame(() => ok?.focus());
  }

  function bindObsSizeNotice() {
    const root = document.getElementById("collector-obs-size-notice");
    if (!root) return;
    document
      .getElementById("collector-obs-size-notice-ok")
      ?.addEventListener("click", confirmObsSizeNotice);
    root.querySelectorAll("[data-notice-dismiss]").forEach((el) => {
      el.addEventListener("click", () => closeObsSizeNotice());
    });
    openObsSizeNotice();
  }

  bindObsSizeNotice();
  boot();
})();
