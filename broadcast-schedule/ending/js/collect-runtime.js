/**
 * 엔딩 Chat SDK 수집 런타임 — 수집기 탭·OBS 엔딩 페이지 공용.
 * window.EndingCollectRuntime.create(opts)
 */
(() => {
  const TOKEN_KEY = "ending_soop_access_token";
  const REFRESH_KEY = "ending_soop_refresh_token";
  const STATION_KEY = "ending_soop_station_id";
  const OAUTH_NEXT_KEY = "ending_oauth_next";
  const SDK_URL = "https://static.sooplive.com/asset/app/chat-sdk/sooplive-chat-sdk.js";
  /** Chat SDK와 동일 OpenAPI (connect 내부 chatinfo 선행 검증용) */
  const CHATINFO_URL = "https://openapi.sooplive.com/broad/access/chatinfo";
  const WATCH_MS = 500; // 수집 중 라이브·방종 감지
  const WATCH_MS_FAST = 100; // 방송 대기 — 뱅온 탐색 주기
  const PRESENCE_MS = 5000;
  /** access token ~8h → 6시간마다 선제 refresh (연결 중에도) */
  const TOKEN_REFRESH_MS = 6 * 60 * 60 * 1000;
  const SILENT_LOG_EVERY = 6;
  /** 방종 직후 SDK disconnect 잔여 · already_connected 완화 */
  const SETTLE_MS = 300;
  const SETTLE_MS_URGENT = 80; // 뱅온 직후 connect 재시도
  /** chat.connect() 무한 대기 방지 (connecting 고착) */
  const CONNECT_TIMEOUT_MS = 8000;
  const CONNECTING_STUCK_MS = 12000;
  /** 재뱅온 직후 chatinfo(143)가 chapi보다 늦는 경우 대기 예산 */
  const CHATINFO_WAIT_MS = 50000;
  /** chatinfo 폴링 초기/상한 간격 — 짧을수록 뱅온 직후 더 빨리 붙음 */
  const CHATINFO_POLL_START_MS = 120;
  const CHATINFO_POLL_MAX_MS = 1400;
  const CHATINFO_POLL_STEP_MS = 180;
  /** ingest 배치 flush — 초반 이벤트 지연 축소 */
  const INGEST_FLUSH_MS = 400;
  /** 라이브 감지 후 즉시 재시도 간격 */
  const LIVE_RETRY_MS = 80;
  const LIVE_EDGE_RETRIES = 3; // chapi 라이브 전환 직후 추가 connect 시도
  /** SDK 실실패가 이 횟수 연속이면 페이지 자동 리로드(OBS 수동 새로고침 대체) */
  const SDK_FAIL_STREAK_BEFORE_RELOAD = 2;
  const AUTO_RELOAD_KEY = "ending_sdk_autoreload_v1";
  const AUTO_RELOAD_WINDOW_MS = 180000;
  const AUTO_RELOAD_MAX = 8;
  /** 자동 리로드 전 짧은 대기 */
  const AUTO_RELOAD_DELAY_MS = 500;

  const TRACKED_ACTIONS = new Set([
    "MESSAGE",
    "MANAGER_MESSAGE",
    "CHAT",
    "IN",
    "JOIN",
    "OUT",
    "QUIT",
    "BALLOON_GIFTED",
    "ADBALLOON_GIFTED",
    "VIDEOBALLOON_GIFTED",
    "STICKER_GIFTED",
    "DONATION",
    "SUBSCRIBED",
    "SUBSCRIPTION_RENEWED",
    "SUBSCRIPTION_GIFTED",
    "QUICKVIEW_GIFTED",
    "BATTLE_MISSION_GIFTED",
    "BATTLE_MISSION_FINISHED",
    "BATTLE_MISSION_SETTLED",
    "CHALLENGE_MISSION_GIFTED",
    "CHALLENGE_MISSION_FINISHED",
    "CHALLENGE_MISSION_SETTLED",
    "CHALLENGE_MISSION_SETTLED_FANLIST",
    "CHALLENGE_MISSION_SPONSORS",
    "CHALLENGE_GIFT",
    "OGQ_EMOTICON_GIFTED",
    "GEM_GIFTED",
  ]);

  function create(opts = {}) {
    const base = () =>
      String(opts.base || window.CREDITS_BASE || window.SCHEDULE_BASE || "");
    const oauthNext = String(opts.oauthNext || "collector");
    /** OBS 표시 전용: Chat SDK·poll 없이 presence heartbeat만 */
    const presenceOnly = Boolean(opts.presenceOnly);
    const clientSource = (() => {
      const explicit = String(opts.clientSource || "").trim().toLowerCase();
      if (explicit === "obs" || explicit === "collector") return explicit;
      if (oauthNext === "obs") return "obs";
      try {
        const p = new URLSearchParams(location.search);
        if (String(p.get("k") || p.get("key") || "").trim()) return "obs";
      } catch (_) {
        /* ignore */
      }
      return "collector";
    })();
    const onStatus = typeof opts.onStatus === "function" ? opts.onStatus : () => {};
    const onNeedLogin = typeof opts.onNeedLogin === "function" ? opts.onNeedLogin : () => {};
    const onLog = typeof opts.onLog === "function" ? opts.onLog : () => {};
    const onPollData = typeof opts.onPollData === "function" ? opts.onPollData : null;
    const onProfile = typeof opts.onProfile === "function" ? opts.onProfile : null;

    const state = {
      boot: null,
      chat: null,
      connected: false,
      connecting: false,
      connectingAt: 0,
      autoEnabled: true,
      stationId: "",
      profile: null,
      queue: [],
      flushTimer: null,
      eventCount: 0,
      watchTimer: null,
      presenceTimer: null,
      tokenTimer: null,
      tokenRefreshing: false,
      lastPresencePhase: "",
      silentFailTicks: 0,
      sdkFailStreak: 0,
      lastDropAt: 0,
      recoverScheduled: false,
      wakeLock: null,
      started: false,
      obsKey: "",
      _wasLive: false,
      _watchLoop: false,
    };

    let sdkLoadPromise = null;

    function apiUrl(path) {
      const p = String(path || "");
      if (/^https?:\/\//i.test(p)) return p;
      const normalized = p.startsWith("/") ? p : `/${p}`;
      return `${base()}${normalized}`;
    }

    function redirectOauthNextIfNeeded() {
      try {
        const next = String(sessionStorage.getItem(OAUTH_NEXT_KEY) || "").trim();
        if (!next || next === "collector") {
          if (next === "collector") sessionStorage.removeItem(OAUTH_NEXT_KEY);
          return false;
        }
        const b = base();
        let target = "";
        if (next === "diary") target = `${b}/diary/`;
        else if (next === "obs") target = `${b}/obs?obs=1`;
        else if (next === "live_data") target = `${b}/live_data`;
        else return false;
        sessionStorage.removeItem(OAUTH_NEXT_KEY);
        const here = String(location.pathname || "").replace(/\/+$/, "") || "/";
        const there = String(new URL(target, location.origin).pathname || "").replace(/\/+$/, "") || "/";
        if (here === there) return false;
        location.replace(target);
        return true;
      } catch (_) {
        return false;
      }
    }

    function hasToken() {
      return Boolean(localStorage.getItem(TOKEN_KEY) || "");
    }

    function looksLikeSoopUserId(id) {
      const s = String(id || "").trim();
      if (!s || s.length > 64 || /\s/.test(s) || /^\d+$/.test(s)) return false;
      if (/^u_[a-f0-9]{10,}$/i.test(s)) return false;
      return /^[A-Za-z0-9_.\-]+$/.test(s);
    }

    function setStation(id) {
      const sid = String(id || "").trim();
      if (!looksLikeSoopUserId(sid)) return;
      state.stationId = sid;
      try {
        localStorage.setItem(STATION_KEY, sid);
      } catch (_) {
        /* ignore */
      }
    }

    function emitStatus(phase, detail) {
      state.lastPresencePhase = String(phase || "");
      onStatus({
        phase,
        detail: detail || "",
        connected: state.connected,
        stationId: state.stationId,
        eventCount: state.eventCount,
        hasToken: hasToken(),
      });
      if (phase && phase !== "stopped" && phase !== "need_login" && phase !== "boot") {
        pingPresence().catch(() => {});
      }
    }

    async function pingPresence({ clear = false } = {}) {
      const sid = String(state.stationId || "").trim();
      if (!sid || !hasToken()) return;
      try {
        await fetchJson("/api/credits/collector-presence", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            stationId: sid,
            source: clientSource,
            phase: state.lastPresencePhase || (state.connected ? "collecting" : "waiting"),
            connected: Boolean(state.connected),
            clear: clear || undefined,
          }),
        });
      } catch (_) {
        /* ignore — 모니터용 */
      }
    }

    function startPresence() {
      stopPresence();
      if (!hasToken() || !state.stationId) return;
      state.presenceTimer = setInterval(() => {
        pingPresence().catch(() => {});
      }, PRESENCE_MS);
      pingPresence().catch(() => {});
    }

    function stopPresence() {
      if (state.presenceTimer) {
        clearInterval(state.presenceTimer);
        state.presenceTimer = null;
      }
    }

    function log(msg) {
      onLog(String(msg || ""));
    }

    function errText(err) {
      if (!err) return "";
      if (typeof err === "string") return err;
      return String(err.message || err.msg || err.error || err.code || err);
    }

    function sleep(ms) {
      return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
    }

    function withTimeout(promise, ms, label) {
      const limit = Math.max(500, Number(ms) || 0);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            Object.assign(new Error(`${label || "timeout"} ${limit}ms`), {
              timeout: true,
              sdkBug: true,
            })
          );
        }, limit);
        Promise.resolve(promise).then(
          (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          (e) => {
            clearTimeout(timer);
            reject(e);
          }
        );
      });
    }

    /** SOOP Chat SDK 버그·토큰 오류를 배지용 짧은 문구로 */
    function friendlyConnectFail(err) {
      const raw = errText(err);
      if (err?.auth || isAuthError(err)) return "토큰만료·수집기 재로그인";
      if (isNoLiveOrOfflineError(err) || err?.offline) return "채팅방 준비중";
      if (err?.sdkBug || /Cannot read properties/i.test(raw)) return "채팅연결 재시도";
      if (/invalid-chat-info|chatinfo|no_chatinfo/i.test(raw)) return "채팅방 준비중";
      return String(raw).slice(0, 28);
    }

    function isAuthError(err) {
      if (err?.auth) return true;
      const raw = errText(err);
      const code = err?.code ?? err?.errorCode ?? err?.status;
      // TypeError·143 메시지를 auth로 오인하지 않음
      if (/Cannot read properties|chatinfo|no_chatinfo|진행중인?\s*방송|no\s*streams|\(143\)/i.test(raw)) {
        return false;
      }
      return (
        /unauthorized|\b401\b|invalid_token|expired_token|not-found-access-token|access token/i.test(
          raw
        ) ||
        code === 401 ||
        code === "401"
      );
    }

    function isSdkChatinfoBug(err) {
      const raw = errText(err);
      return Boolean(err?.sdkBug) || /Cannot read properties/i.test(raw);
    }

    function isNoLiveOrOfflineError(err) {
      if (err?.offline) return true;
      const raw = errText(err);
      const code = err?.code ?? err?.errorCode ?? err?.status;
      const codeStr = String(code ?? "");
      if (code === 143 || codeStr === "143" || code === -1302 || codeStr === "-1302") return true;
      // SOOP Chat SDK: 방송 없을 때 chatinfo 실패 → TypeError 로 터지는 알려진 버그
      if (isSdkChatinfoBug(err)) return true;
      return /진행중인?\s*방송이\s*없습니다|no\s*streams|no\s*broadcast|not\s*live|\(143\)|\b143\b|방송\s*종료|방송이\s*끝|ended|offline|not\s*broadcasting|no\s*room|채팅방|disconnect|closed|연결.*끊|fail(ed)?\s*to\s*connect|invalid-chat-info|no_chatinfo|chatinfo_fail/i.test(
        raw
      );
    }

    /**
     * connect() 전에 chatinfo를 직접 확인.
     * SDK는 chatinfo 401/네트워크 실패 시 내부 배열이 비어 `_()`에서
     * "Cannot read properties of undefined"를 던지는 버그가 있음.
     */
    async function probeChatAccess(token) {
      const access = String(token || "").trim();
      if (!access) return { ok: false, auth: true, msg: "token_required" };
      try {
        const res = await fetch(CHATINFO_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=utf-8;",
          },
          body: new URLSearchParams({ access_token: access }).toString(),
        });
        if (res.status === 401 || res.status === 403) {
          return { ok: false, auth: true, httpStatus: res.status, msg: "invalid_token" };
        }
        const data = await res.json().catch(() => ({}));
        if (data?.error === "invalid_token" || data?.error === "expired_token") {
          return {
            ok: false,
            auth: true,
            msg: data.error_description || data.error,
          };
        }
        const result = Number(data?.result);
        const list = Array.isArray(data?.data) ? data.data : [];
        if (result > 0 && list.length > 0) {
          return { ok: true, data: list, result };
        }
        const msg = String(
          data?.msg || data?.error_description || data?.error || "no_chatinfo"
        );
        const offline =
          result === -1302 || /143|no\s*streams|진행중인?\s*방송/i.test(msg);
        return {
          ok: false,
          auth: false,
          offline,
          code: Number.isFinite(result) ? result : undefined,
          msg,
        };
      } catch (e) {
        return { ok: false, auth: false, msg: errText(e) || "chatinfo_network" };
      }
    }

    function throwProbeError(probe) {
      const err = new Error(probe?.msg || "chatinfo_fail");
      if (probe?.auth) err.auth = true;
      if (probe?.offline) err.offline = true;
      if (probe?.code != null) err.code = probe.code;
      if (probe?.offline) err.code = err.code ?? 143;
      throw err;
    }

    /** 토큰 점검 → 필요 시 refresh → chatinfo 재확인 */
    async function ensureChatAccess(chat) {
      let token = localStorage.getItem(TOKEN_KEY) || "";
      let probe = await probeChatAccess(token);
      if (probe.ok) return token;
      // 143(오프라인)은 토큰 문제가 아님 — refresh/재발급 불필요
      if (probe.offline) throwProbeError(probe);
      if (probe.auth) {
        const refreshed = await tryRefreshToken(chat);
        if (refreshed) {
          token = localStorage.getItem(TOKEN_KEY) || "";
          if (typeof chat.setAuth === "function") chat.setAuth(token);
          probe = await probeChatAccess(token);
          if (probe.ok) return token;
        }
      }
      throwProbeError(probe);
      return token;
    }

    /**
     * 재뱅온 직후: chapi는 라이브인데 chatinfo가 수~수십 초 143인 레이스 대기.
     * SDK connect()는 부르지 않고 chatinfo만 폴링한다.
     */
    async function waitUntilChatinfoReady(chat, { budgetMs = CHATINFO_WAIT_MS } = {}) {
      let token = localStorage.getItem(TOKEN_KEY) || "";
      const started = Date.now();
      let delay = CHATINFO_POLL_START_MS;
      let attempt = 0;
      while (Date.now() - started < budgetMs) {
        if (!state.autoEnabled || state.connected) return token;
        attempt += 1;
        let probe = await probeChatAccess(token);
        if (probe.ok) {
          if (attempt > 1) log(`chatinfo ready after ${Date.now() - started}ms`);
          return token;
        }
        if (probe.auth) {
          const refreshed = await tryRefreshToken(chat);
          if (refreshed) {
            token = localStorage.getItem(TOKEN_KEY) || "";
            if (typeof chat.setAuth === "function") chat.setAuth(token);
            continue;
          }
          throwProbeError(probe);
        }
        const liveOn = Boolean(state._lastSoopLive?.isLive);
        emitStatus(
          "waiting",
          liveOn
            ? `라이브ON · 채팅방 준비중 (${Math.round((Date.now() - started) / 1000)}s)`
            : state.stationId
              ? `숲 오프라인 · ${state.stationId}`
              : "숲 방송 대기"
        );
        await sleep(delay);
        delay = Math.min(delay + CHATINFO_POLL_STEP_MS, CHATINFO_POLL_MAX_MS);
      }
      const last = await probeChatAccess(token);
      if (last.ok) return token;
      throwProbeError(last);
      return token;
    }

    /** SDK connect — TypeError(내부 chatinfo 버그) 시 인스턴스 폐기 후 1회 재시도 */
    async function connectSdkOnce(chat, token, bindHandlers) {
      if (typeof chat.setAuth === "function") chat.setAuth(token);
      try {
        await withTimeout(chat.connect(), CONNECT_TIMEOUT_MS, "chat.connect");
        return chat;
      } catch (err) {
        const raw = errText(err);
        const retryable =
          err?.timeout ||
          /Cannot read properties|already_connected/i.test(raw) ||
          err?.sdkBug;
        if (!retryable) throw err;
        log(`sdk connect retry: ${raw.slice(0, 80)}`);
        dropChat(chat);
        await sleep(SETTLE_MS);
        const chat2 = makeChat();
        if (!chat2) {
          throw Object.assign(new Error("채팅연결실패"), { sdkBug: true });
        }
        bindHandlers(chat2);
        if (typeof chat2.setAuth === "function") chat2.setAuth(token);
        try {
          await withTimeout(chat2.connect(), CONNECT_TIMEOUT_MS, "chat.connect");
          return chat2;
        } catch (err2) {
          dropChat(chat2);
          const offline = isNoLiveOrOfflineError(err2);
          throw Object.assign(new Error(errText(err2) || "채팅연결실패"), {
            sdkBug: !offline,
            offline,
            timeout: Boolean(err2?.timeout),
            code: err2?.code,
          });
        }
      }
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
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return data;
    }

    function authHeaders() {
      const token = localStorage.getItem(TOKEN_KEY) || "";
      return token ? { "X-Soop-Access-Token": token } : {};
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
            reject(new Error("Chat SDK 전역 객체가 없습니다."));
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
        s.onerror = () => reject(new Error("Chat SDK 스크립트 로드 실패"));
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

    function safeDisconnect(chat) {
      if (!chat) return;
      try {
        if (typeof chat.disconnect === "function") chat.disconnect();
      } catch (_) {
        /* ignore */
      }
    }

    /** 방종·실패 인스턴스를 남겨 두면 재뱅온 때 connect가 막힐 수 있음 */
    function dropChat(chat) {
      const target = chat || state.chat;
      if (state.chat && (!chat || state.chat === chat)) state.chat = null;
      state.connected = false;
      safeDisconnect(target);
      state.lastDropAt = Date.now();
    }

    async function settleAfterDrop({ urgent = false } = {}) {
      const settle = urgent ? SETTLE_MS_URGENT : SETTLE_MS;
      const elapsed = Date.now() - (state.lastDropAt || 0);
      if (state.lastDropAt && elapsed < settle) {
        await sleep(settle - elapsed);
      }
    }

    /**
     * 위플랩처럼 URL만 유지한 채 스스로 복구.
     * OBS 수동 새로고침 대신 location.reload() / soft reset.
     */
    function scheduleAutoRecover(reason) {
      if (state.recoverScheduled || !state.autoEnabled) return;
      state.recoverScheduled = true;
      emitStatus("waiting", "자동 재연결 중…");
      log(`auto recover: ${reason}`);
      window.setTimeout(() => {
        try {
          const now = Date.now();
          let info = { n: 0, at: now };
          try {
            info = JSON.parse(sessionStorage.getItem(AUTO_RELOAD_KEY) || "null") || info;
          } catch (_) {
            /* ignore */
          }
          if (now - Number(info.at || 0) > AUTO_RELOAD_WINDOW_MS) {
            info = { n: 0, at: now };
          }
          info.n = Number(info.n || 0) + 1;
          info.at = now;
          try {
            sessionStorage.setItem(AUTO_RELOAD_KEY, JSON.stringify(info));
          } catch (_) {
            /* ignore */
          }
          if (info.n <= AUTO_RELOAD_MAX) {
            // OBS 브라우저 소스 전체 리로드 = 수동 새로고침과 동일 효과
            location.reload();
            return;
          }
          // 리로드 한도 초과: soft reset 후 watch 유지 (무한 새로고침 방지)
          log("auto reload capped — soft reset");
          state.recoverScheduled = false;
          state.sdkFailStreak = 0;
          state.connecting = false;
          dropChat(state.chat);
          emitStatus("waiting", "자동 재연결 대기…");
          startWatch();
        } catch (err) {
          state.recoverScheduled = false;
          log(`auto recover fail: ${errText(err)}`);
          try {
            location.reload();
          } catch (_) {
            /* ignore */
          }
        }
      }, AUTO_RELOAD_DELAY_MS);
    }

    function enqueueEvent(action, message) {
      const key = String(action || "").toUpperCase();
      if (!TRACKED_ACTIONS.has(key)) return;
      state.queue.push({
        action,
        message: message || {},
        at: new Date().toISOString(),
      });
      state.eventCount += 1;
      if (!state.flushTimer) state.flushTimer = setTimeout(flushQueue, INGEST_FLUSH_MS);
      // 상태 문구를 빈 waiting 으로 덮지 않음
      if (state.connected) emitStatus("collecting", "채팅 수집 중");
    }

    async function flushQueue() {
      state.flushTimer = null;
      if (!state.queue.length) return;
      const batch = state.queue.splice(0, 100);
      const post = () =>
        fetchJson("/api/credits/ingest", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            stationId: state.stationId || undefined,
            source: clientSource,
            events: batch,
          }),
        });
      try {
        await post();
        log(`ingest ${batch.length}`);
      } catch (err) {
        if (err?.status === 401 || isAuthError(err)) {
          const refreshed = await tryRefreshToken(state.chat);
          if (refreshed) {
            try {
              await post();
              log(`ingest ${batch.length} (after refresh)`);
              return;
            } catch (err2) {
              state.queue.unshift(...batch);
              log(`ingest fail after refresh: ${err2.message}`);
              if (!state.flushTimer) state.flushTimer = setTimeout(flushQueue, 3000);
              if (state.obsKey || readObsKeyFromUrl()) scheduleAutoRecover("ingest_auth");
              return;
            }
          }
        }
        state.queue.unshift(...batch);
        log(`ingest fail: ${err.message}`);
        if (!state.flushTimer) state.flushTimer = setTimeout(flushQueue, 3000);
      }
    }

    async function beginSessionOnServer() {
      try {
        await fetchJson("/api/credits/session/begin", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ stationId: state.stationId || undefined }),
        });
      } catch (err) {
        log(`session begin: ${err.message || err}`);
      }
    }

    async function pauseCollectorOnServer() {
      try {
        await fetchJson("/api/credits/session/collector-pause", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ stationId: state.stationId || undefined }),
        });
      } catch (_) {
        /* ignore */
      }
    }

    async function tryRefreshToken(chat) {
      const refresh = localStorage.getItem(REFRESH_KEY) || "";
      if (!refresh) return false;
      if (state.tokenRefreshing) return false;
      state.tokenRefreshing = true;
      let created = false;
      let c = chat || state.chat;
      try {
        if (!c || typeof c.refreshAuth !== "function") {
          try {
            await loadChatSdk();
          } catch (_) {
            return false;
          }
          c = makeChat();
          created = Boolean(c);
        }
        if (!c || typeof c.refreshAuth !== "function") return false;
        const tokens = await c.refreshAuth(refresh);
        if (tokens?.access_token) {
          localStorage.setItem(TOKEN_KEY, tokens.access_token);
          if (tokens.refresh_token) localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
          const live = state.chat;
          if (live && typeof live.setAuth === "function") {
            live.setAuth(tokens.access_token);
          } else if (c && typeof c.setAuth === "function") {
            c.setAuth(tokens.access_token);
          }
          await syncObsLinkTokens().catch(() => {});
          log("token refresh ok");
          return true;
        }
      } catch (err) {
        log(`token refresh fail: ${errText(err)}`);
      } finally {
        state.tokenRefreshing = false;
        if (created && c && c !== state.chat) safeDisconnect(c);
      }
      return false;
    }

    function startTokenKeepalive() {
      stopTokenKeepalive();
      if (!hasToken() || !localStorage.getItem(REFRESH_KEY)) return;
      state.tokenTimer = setInterval(() => {
        keepTokenFresh().catch(() => {});
      }, TOKEN_REFRESH_MS);
    }

    function stopTokenKeepalive() {
      if (state.tokenTimer) {
        clearInterval(state.tokenTimer);
        state.tokenTimer = null;
      }
    }

    async function keepTokenFresh() {
      if (!hasToken() || !localStorage.getItem(REFRESH_KEY)) return false;
      return tryRefreshToken(state.chat);
    }

    function readObsKeyFromUrl() {
      try {
        const params = new URLSearchParams(location.search);
        return String(params.get("k") || params.get("key") || "").trim();
      } catch (_) {
        return "";
      }
    }

    async function bootstrapFromObsKey(key) {
      const kid = String(key || "").trim();
      if (!kid) return false;
      const data = await fetchJson(`/api/credits/obs-link/${encodeURIComponent(kid)}`);
      const access = String(data?.accessToken || "").trim();
      if (!access) throw new Error("obs_key_empty_token");
      localStorage.setItem(TOKEN_KEY, access);
      const refresh = String(data?.refreshToken || "").trim();
      if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
      const sid = String(data?.stationId || "").trim();
      if (looksLikeSoopUserId(sid)) setStation(sid);
      state.obsKey = kid;
      log("obs-link bootstrap ok");
      return true;
    }

    async function syncObsLinkTokens() {
      const kid = state.obsKey || readObsKeyFromUrl();
      if (!kid) return false;
      const access = localStorage.getItem(TOKEN_KEY) || "";
      if (!access) return false;
      await fetchJson(`/api/credits/obs-link/${encodeURIComponent(kid)}/tokens`, {
        method: "POST",
        body: JSON.stringify({
          accessToken: access,
          refreshToken: localStorage.getItem(REFRESH_KEY) || "",
        }),
      });
      return true;
    }

    /** 수집기/스튜디오에서 전용 OBS URL 키 발급·갱신 */
    async function ensureObsLink({ rotate = false } = {}) {
      const access = localStorage.getItem(TOKEN_KEY) || "";
      if (!access) throw new Error("token_required");
      const data = await fetchJson("/api/credits/obs-link", {
        method: "POST",
        headers: { "X-Soop-Access-Token": access },
        body: JSON.stringify({
          accessToken: access,
          refreshToken: localStorage.getItem(REFRESH_KEY) || "",
          stationId: state.stationId || localStorage.getItem(STATION_KEY) || "",
          rotate: rotate ? true : undefined,
        }),
      });
      if (data?.key) state.obsKey = String(data.key);
      return data;
    }

    async function bindStationOnServer(stationId) {
      const sid = String(stationId || "").trim();
      if (!looksLikeSoopUserId(sid)) return;
      try {
        await fetchJson("/api/credits/bind", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ stationId: sid }),
        });
      } catch (_) {
        /* ignore */
      }
    }

    async function loadProfile({ bind = false } = {}) {
      const token = localStorage.getItem(TOKEN_KEY) || "";
      if (!token) return null;
      try {
        const data = await fetchJson("/api/credits/me", {
          method: "POST",
          body: JSON.stringify({ accessToken: token }),
        });
        if (data?.ok) {
          state.profile = data;
          const sid = String(data.stationId || "").trim();
          if (looksLikeSoopUserId(sid)) setStation(sid);
          if (typeof onProfile === "function") onProfile(data);
          if (bind && sid) await bindStationOnServer(sid);
          return data;
        }
      } catch (_) {
        /* ignore */
      }
      return null;
    }

    function isUsableProfile(profile) {
      if (!profile || typeof profile !== "object") return false;
      return Boolean(
        String(profile.userNick || "").trim() ||
          String(profile.stationId || "").trim() ||
          String(profile.stationName || "").trim()
      );
    }

    async function ensureProfile({ retries = 3, delayMs = 1200, bind = false } = {}) {
      for (let i = 0; i < retries; i++) {
        const profile = await loadProfile({ bind });
        if (isUsableProfile(profile)) return profile;
        const refresh = localStorage.getItem(REFRESH_KEY) || "";
        if (refresh) {
          if (i === 0) log("profile fail — token refresh");
          else log(`profile retry ${i + 1}/${retries}`);
          const chat = makeChat();
          if (chat && (await tryRefreshToken(chat))) {
            if (isUsableProfile(state.profile)) return state.profile;
            const again = await loadProfile({ bind });
            if (isUsableProfile(again)) return again;
          }
        } else if (i > 0) {
          log(`profile retry ${i + 1}/${retries}`);
        }
        if (i < retries - 1) await sleep(delayMs * (i + 1));
      }
      return null;
    }

    async function readStationFromChat(chat) {
      if (!chat || typeof chat.getRoomInfo !== "function") return state.stationId;
      try {
        const room = await chat.getRoomInfo();
        const candidates = [
          room?.bjId,
          room?.bj_id,
          room?.userId,
          room?.user_id,
          room?.loginId,
          room?.login_id,
          room?.stationId,
          room?.station_id,
        ];
        const bj = candidates.map((v) => String(v || "").trim()).find(looksLikeSoopUserId) || "";
        if (bj) {
          setStation(bj);
          try {
            await fetchJson("/api/credits/bind", {
              method: "POST",
              headers: authHeaders(),
              body: JSON.stringify({ stationId: bj }),
            });
          } catch (_) {
            /* ignore */
          }
        }
      } catch (_) {
        /* ignore */
      }
      return state.stationId;
    }

    async function pollLive({ quiet = false } = {}) {
      try {
        const data = await fetchJson("/api/credits/poll", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ stationId: state.stationId || undefined }),
        });
        if (onPollData) onPollData(data);
        if (!quiet) {
          log(
            `live active=${Boolean(data.session?.active)} peak=${data.session?.peakViewers || 0}`
          );
        }
        return data;
      } catch (err) {
        if (!quiet) log(`poll fail: ${errText(err)}`);
        return null;
      }
    }

    async function resolveLiveStatus({ quiet = true, full = false } = {}) {
      const sid = String(state.stationId || "").trim();
      if (!looksLikeSoopUserId(sid)) return null;
      // 대기 중: chapi만 (poll+rebuild 생략 → 뱅온 탐색 지연 제거)
      if (!full && !state.connected) {
        return fetchSoopLiveFlag({ probe: true });
      }
      if (hasToken()) {
        try {
          const data = await pollLive({ quiet });
          const session = data?.session;
          if (session && typeof session === "object") {
            const soop = {
              ok: true,
              isLive: Boolean(session.active),
              title: String(session.title || "").trim(),
              viewerCount: Number(session.peakViewers || session.viewerCount || 0),
              broadNo: String(session.broadNo || "").trim(),
              stationId: sid,
            };
            state._lastSoopLive = soop;
            return soop;
          }
        } catch (_) {
          /* poll 실패 시 live-status 폴백 */
        }
      }
      return fetchSoopLiveFlag({ probe: true });
    }

    /** chapi 라이브 확인 직후 — 세션 생성·타임라인은 poll 한 번으로만 */
    async function syncSessionOnLive() {
      if (!hasToken()) return null;
      try {
        return await pollLive({ quiet: true });
      } catch (_) {
        return null;
      }
    }

    async function tryConnectLive({ silent = true, waitChatinfo = true, urgent = false, retries = 1 } = {}) {
      let ok = await connectChat({ silent, waitChatinfo, urgent });
      const max = Math.max(1, Number(retries) || 1);
      for (let i = 1; i < max && !ok && !state.connected && !state.connecting && state.autoEnabled; i++) {
        await sleep(urgent ? LIVE_RETRY_MS : LIVE_RETRY_MS * 2);
        ok = await connectChat({ silent, waitChatinfo, urgent });
      }
      return ok;
    }

    async function captureLiveFrame() {
      if (!state.stationId) return;
      try {
        // force=false: 이미 고정된 최고시청 썸네일을 재연결 시 덮지 않음
        await fetchJson("/api/credits/capture", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ stationId: state.stationId, force: false }),
        });
      } catch (_) {
        /* ignore */
      }
    }

    async function connectChat({ silent = true, waitChatinfo = false, urgent = false } = {}) {
      if (state.connected || state.connecting) return false;
      // 이전 실패·방종 인스턴스가 남아 있으면 정리
      if (state.chat && !state.connected) dropChat(state.chat);
      await settleAfterDrop({ urgent });
      const chat = makeChat();
      if (!chat) {
        emitStatus("error", "Chat SDK 없음");
        return false;
      }
      let token = localStorage.getItem(TOKEN_KEY) || "";
      if (!token) {
        emitStatus("need_login", "숲 로그인이 필요합니다");
        onNeedLogin();
        return false;
      }

      state.connecting = true;
      state.connectingAt = Date.now();
      emitStatus("connecting", state.stationId ? `연결 중 · ${state.stationId}` : "연결 중");
      try {
        const bindHandlers = (c) => {
          if (typeof c.handleMessageReceived === "function") {
            c.handleMessageReceived((action, message) => {
              enqueueEvent(action, message);
            });
          }
          if (typeof c.handleError === "function") {
            c.handleError((code, message) => {
              log(`sdk error ${code}: ${message}`);
              if (isAuthError({ code, message })) {
                tryRefreshToken(c).then((ok) => {
                  if (ok) {
                    const tok = localStorage.getItem(TOKEN_KEY) || "";
                    if (typeof c.setAuth === "function") c.setAuth(tok);
                    log("sdk auth recovered");
                    return;
                  }
                  if (state.connected) {
                    dropChat(c);
                    pauseCollectorOnServer().catch(() => {});
                    emitStatus("need_login", "토큰 만료 · 재로그인 필요");
                    onNeedLogin();
                    if (state.obsKey || readObsKeyFromUrl()) scheduleAutoRecover("auth");
                  }
                });
                return;
              }
              if (state.connected && isNoLiveOrOfflineError({ code, message })) {
                dropChat(c);
                pauseCollectorOnServer().catch(() => {});
                if (state.autoEnabled) {
                  emitStatus("waiting", "방송 종료 · 다음 뱅온 대기");
                  pollLive().catch(() => {});
                }
              }
            });
          }
          if (typeof c.handleChatClosed === "function") {
            c.handleChatClosed(() => {
              const was = state.connected;
              dropChat(c);
              if (was) pauseCollectorOnServer().catch(() => {});
              if (state.autoEnabled) {
                emitStatus("waiting", "연결 끊김 · 재연결 대기");
                pollLive().catch(() => {});
              }
            });
          }
        };

        bindHandlers(chat);

        // 라이브 재뱅온: chatinfo가 열릴 때까지 대기 (SDK connect 스팸·TypeError 방지)
        const shouldWait =
          waitChatinfo || Boolean(state._lastSoopLive?.isLive);
        token = shouldWait
          ? await waitUntilChatinfoReady(chat)
          : await ensureChatAccess(chat);
        if (typeof chat.setAuth === "function") chat.setAuth(token);

        let liveChat = chat;
        try {
          liveChat = await connectSdkOnce(chat, token, bindHandlers);
        } catch (firstErr) {
          if (isAuthError(firstErr) && (await tryRefreshToken(chat))) {
            token = localStorage.getItem(TOKEN_KEY) || "";
            const chat3 = makeChat();
            if (!chat3) throw firstErr;
            token = shouldWait
              ? await waitUntilChatinfoReady(chat3)
              : await ensureChatAccess(chat3);
            bindHandlers(chat3);
            liveChat = await connectSdkOnce(chat3, token, bindHandlers);
          } else {
            throw firstErr;
          }
        }

        await readStationFromChat(liveChat);
        await beginSessionOnServer();
        state.chat = liveChat;
        state.connected = true;
        state.silentFailTicks = 0;
        state.sdkFailStreak = 0;
        state.recoverScheduled = false;
        try {
          sessionStorage.removeItem(AUTO_RELOAD_KEY);
        } catch (_) {
          /* ignore */
        }
        emitStatus(
          "collecting",
          state.stationId ? `수집 중 · ${state.stationId}` : "채팅 수집 중"
        );
        log(silent ? "auto connect ok" : "collect start");
        try {
          if ("wakeLock" in navigator) {
            state.wakeLock = await navigator.wakeLock.request("screen");
          }
        } catch (_) {
          /* ignore */
        }
        await pollLive();
        await captureLiveFrame();
        return true;
      } catch (err) {
        dropChat(state.chat || chat);
        const msg = errText(err) || "connect_fail";
        if (isAuthError(err)) {
          // OBS 키는 유지 — 수집기에서 재로그인 후 토큰만 갱신되면 부트스트랩으로 복구
          emitStatus("need_login", "토큰 만료 · 수집기에서 숲 재로그인 후 자동 복구됩니다");
          onNeedLogin();
          // 전용 URL이면 리로드로 서버 토큰 재부트스트랩 시도
          if (state.obsKey || readObsKeyFromUrl()) {
            scheduleAutoRecover("auth");
          }
          return false;
        }
        const liveOn = Boolean(state._lastSoopLive?.isLive);
        const offlineLike =
          isNoLiveOrOfflineError(err) || err?.offline || (isSdkChatinfoBug(err) && !liveOn);
        if (offlineLike && !liveOn) {
          state.sdkFailStreak = 0;
          emitStatus(
            "waiting",
            state.stationId ? `숲 오프라인 · ${state.stationId}` : "숲 방송 대기"
          );
        } else if (liveOn && (err?.offline || isNoLiveOrOfflineError(err)) && !isSdkChatinfoBug(err) && !err?.timeout) {
          // chatinfo 아직 143 — 다음 watch 틱에서 다시 대기
          state.sdkFailStreak = 0;
          emitStatus("waiting", `라이브ON · ${friendlyConnectFail(err)}`);
          log(`live but chatinfo not ready: ${msg}`);
        } else if (liveOn || err?.timeout || isSdkChatinfoBug(err)) {
          state.sdkFailStreak = (state.sdkFailStreak || 0) + 1;
          log(`sdk fail streak ${state.sdkFailStreak}: ${msg}`);
          if (state.sdkFailStreak >= SDK_FAIL_STREAK_BEFORE_RELOAD) {
            // 수동 OBS 새로고침 요구하지 않음 — 페이지가 스스로 리로드
            emitStatus("waiting", "자동 재연결 중…");
            scheduleAutoRecover(msg);
          } else {
            emitStatus(
              "waiting",
              `라이브ON · 채팅 재시도 (${state.sdkFailStreak}/${SDK_FAIL_STREAK_BEFORE_RELOAD})`
            );
          }
        } else {
          emitStatus(
            "waiting",
            state.stationId ? `방송 대기 · ${state.stationId}` : "방송 대기"
          );
        }
        if (silent) {
          state.silentFailTicks = (state.silentFailTicks || 0) + 1;
          if (state.silentFailTicks === 1 || state.silentFailTicks % SILENT_LOG_EVERY === 0) {
            log(liveOn ? `retry while live: ${msg}` : "waiting for live chat");
          }
        } else {
          log(`connect fail: ${msg}`);
        }
        return false;
      } finally {
        state.connecting = false;
        state.connectingAt = 0;
      }
    }

    async function watchTick() {
      if (!hasToken() || !state.autoEnabled) return;
      if (state.connecting) {
        const stuckFor = Date.now() - (state.connectingAt || 0);
        if (state.connectingAt && stuckFor > CONNECTING_STUCK_MS) {
          log(`connect stuck reset (${Math.round(stuckFor / 1000)}s)`);
          state.connecting = false;
          state.connectingAt = 0;
          dropChat(state.chat);
        } else {
          return;
        }
      }
      // 수집 중: poll로 세션·방종 확인
      if (state.connected) {
        const soop = await resolveLiveStatus({ quiet: true, full: true });
        if (soop && soop.isLive === false) {
          dropChat(state.chat);
          pauseCollectorOnServer().catch(() => {});
          state._wasLive = false;
          emitStatus(
            "waiting",
            state.stationId ? `숲 오프라인 · ${state.stationId}` : "숲 방송 대기"
          );
        } else if (soop?.isLive) {
          state._wasLive = true;
        }
        return;
      }
      // 프로필로 채널 ID 확정 (OBS 키가 u_ 임시값이어도 me/프로필에서 복구)
      if (!looksLikeSoopUserId(state.stationId) || !state.profile) {
        await loadProfile();
      }
      const prevLive = Boolean(state._wasLive);
      const soop = await resolveLiveStatus({ quiet: false, full: false });
      const nowLive = Boolean(soop?.isLive);
      const liveEdge = nowLive && !prevLive;
      state._wasLive = nowLive;
      const token = localStorage.getItem(TOKEN_KEY) || "";

      if (nowLive) {
        await syncSessionOnLive();
      }

      // 방종 중 SDK connect()를 반복하면 TypeError·already_connected 로 재뱅온이 깨짐
      if (soop && soop.isLive === false) {
        if (state.chat) dropChat(state.chat);
        state.sdkFailStreak = 0;
        // chapi만 늦은 경우: chatinfo가 이미 열려 있으면 연결
        const probe = token ? await probeChatAccess(token) : { ok: false };
        if (!probe.ok) {
          emitStatus(
            "waiting",
            state.stationId ? `숲 오프라인 · ${state.stationId}` : "숲 방송 대기"
          );
          return;
        }
        log("chapi offline but chatinfo ready — connect");
        await tryConnectLive({ silent: true, waitChatinfo: false, urgent: true, retries: 2 });
        return;
      }

      if (soop && soop.isLive === true) {
        if (liveEdge) log("live edge — fast connect");
        emitStatus(
          "connecting",
          soop.title ? `숲 라이브 · 채팅 연결` : `숲 라이브 · ${state.stationId || ""}`
        );
        await tryConnectLive({
          silent: true,
          waitChatinfo: true,
          urgent: liveEdge,
          retries: liveEdge ? LIVE_EDGE_RETRIES : 2,
        });
        return;
      }

      // live-status 실패·미확인: chatinfo로만 판단 (SDK 스팸 금지)
      const probe = token ? await probeChatAccess(token) : { ok: false };
      if (probe.ok) {
        await tryConnectLive({ silent: true, waitChatinfo: false, urgent: false, retries: 2 });
      } else {
        emitStatus(
          "waiting",
          state.stationId ? `방송 대기 · ${state.stationId}` : "방송 대기"
        );
      }
    }

    function scheduleNextWatch(delayMs) {
      if (!state._watchLoop) return;
      const ms =
        typeof delayMs === "number"
          ? delayMs
          : state.connected
            ? WATCH_MS
            : WATCH_MS_FAST;
      state.watchTimer = setTimeout(() => {
        if (!state._watchLoop) return;
        watchTick()
          .catch(() => {})
          .finally(() => scheduleNextWatch());
      }, ms);
    }

    function startWatch() {
      stopWatch();
      if (!hasToken()) return;
      state._watchLoop = true;
      watchTick()
        .catch(() => {})
        .finally(() => scheduleNextWatch());
      if (!state._visKickBound) {
        state._visKickBound = true;
        const kick = () => {
          if (!state.autoEnabled || state.connected || !hasToken()) return;
          watchTick().catch(() => {});
        };
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") kick();
        });
        window.addEventListener("pageshow", kick);
      }
    }

    function stopWatch() {
      state._watchLoop = false;
      if (state.watchTimer) {
        clearTimeout(state.watchTimer);
        state.watchTimer = null;
      }
    }

    async function fetchSoopLiveFlag({ probe = false } = {}) {
      const sid = String(state.stationId || "").trim();
      if (!looksLikeSoopUserId(sid)) return null;
      try {
        const qs = probe ? "&probe=1" : "";
        const data = await fetchJson(
          `/api/credits/live-status?stationId=${encodeURIComponent(sid)}${qs}`
        );
        state._lastSoopLive = data;
        return data;
      } catch (_) {
        return null;
      }
    }

    async function maybeCompleteOauth() {
      const params = new URLSearchParams(location.search);
      const code = params.get("code") || params.get("authCode");
      if (!code) return false;
      const chat = makeChat();
      if (!chat || typeof chat.getAuth !== "function") return false;
      try {
        const tokens = await chat.getAuth(code);
        if (tokens?.access_token) localStorage.setItem(TOKEN_KEY, tokens.access_token);
        if (tokens?.refresh_token) localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
        if (!tokens?.access_token) return false;
        const url = new URL(location.href);
        ["code", "authCode", "error", "error_description"].forEach((k) =>
          url.searchParams.delete(k)
        );
        history.replaceState({}, "", url.toString());
        log("oauth ok");
        redirectOauthNextIfNeeded();
        return true;
      } catch (err) {
        log(`oauth fail: ${errText(err)}`);
        return false;
      }
    }

    async function startOauth() {
      try {
        sessionStorage.setItem(OAUTH_NEXT_KEY, oauthNext);
      } catch (_) {
        /* ignore */
      }
      await loadChatSdk();
      const chat = makeChat();
      if (!chat || typeof chat.openAuth !== "function") {
        emitStatus("need_login", "로그인 창을 열 수 없습니다");
        return false;
      }
      chat.openAuth();
      return true;
    }

    async function start(options = {}) {
      const skipBootstrap = Boolean(options.skipBootstrap);
      const skipOAuth = Boolean(options.skipOAuth);
      const skipProfile = Boolean(options.skipProfile);
      const skipWatch = Boolean(options.skipWatch);

      if (state.started && !options.restart) return state;
      state.started = true;
      emitStatus("boot");
      try {
        const obsKey = readObsKeyFromUrl();
        state.obsKey = obsKey;

        if (presenceOnly) {
          // OBS 표시 전용 — Chat SDK·수집 없이 presence heartbeat만
          if (obsKey) {
            try {
              await bootstrapFromObsKey(obsKey);
            } catch (err) {
              log(`obs-link presence fail: ${errText(err)}`);
              return state;
            }
          }
          if (!hasToken()) return state;
          const cachedOnly = String(localStorage.getItem(STATION_KEY) || "").trim();
          if (looksLikeSoopUserId(cachedOnly)) setStation(cachedOnly);
          try {
            await loadProfile();
          } catch (_) {
            /* stationId already from obs-link */
          }
          if (!state.stationId) return state;
          state.autoEnabled = true;
          emitStatus("open", "표시 전용");
          startPresence();
          startTokenKeepalive();
          return state;
        }

        if (!skipBootstrap) {
          const [boot] = await Promise.all([
            fetchJson("/api/credits/bootstrap"),
            loadChatSdk().catch((err) => {
              log(err.message || String(err));
              return null;
            }),
          ]);
          state.boot = boot;
          if (!boot?.hasClientId || !boot?.hasClientSecret) {
            emitStatus("error", "SOOP API 키 없음");
            return state;
          }
          if (!getChatSdkCtor()) {
            emitStatus("error", "Chat SDK 로드 실패");
            return state;
          }
        }

        if (!skipOAuth) await maybeCompleteOauth();

        if (obsKey && !hasToken()) {
          try {
            emitStatus("connecting", "전용 URL 연결 중");
            await bootstrapFromObsKey(obsKey);
          } catch (err) {
            log(`obs-link fail: ${errText(err)}`);
            emitStatus(
              "need_login",
              "전용 URL이 만료됐거나 잘못됐습니다. 수집기/스튜디오에서 URL을 다시 복사하세요."
            );
            onNeedLogin();
            return state;
          }
        } else if (obsKey && hasToken()) {
          // URL 키가 있으면 서버 토큰으로 동기화(다른 PC·캐시 비우기 대비)
          try {
            await bootstrapFromObsKey(obsKey);
          } catch (err) {
            log(`obs-link refresh fail: ${errText(err)}`);
          }
        }

        if (!hasToken()) {
          emitStatus("need_login", "숲 로그인 필요");
          onNeedLogin();
          return state;
        }

        const cached = String(localStorage.getItem(STATION_KEY) || "").trim();
        if (looksLikeSoopUserId(cached)) setStation(cached);
        if (!skipProfile) await loadProfile({ bind: true });
        if (skipWatch) return state;

        state.autoEnabled = true;
        // 이전 자동 리로드가 성공 경로로 이어지면 카운터 완화
        try {
          const raw = sessionStorage.getItem(AUTO_RELOAD_KEY);
          if (raw) {
            const info = JSON.parse(raw);
            if (info && Number(info.n) > 0) {
              info.n = Math.max(0, Number(info.n) - 1);
              sessionStorage.setItem(AUTO_RELOAD_KEY, JSON.stringify(info));
            }
          }
        } catch (_) {
          /* ignore */
        }
        emitStatus("waiting", "방송 대기");
        startWatch();
        startPresence();
        startTokenKeepalive();
      } catch (err) {
        emitStatus("error", errText(err));
      }
      return state;
    }

    async function prepareBoot() {
      if (state.boot && getChatSdkCtor()) {
        return { boot: state.boot, sdkReady: true };
      }
      emitStatus("boot");
      const [boot] = await Promise.all([
        fetchJson("/api/credits/bootstrap"),
        loadChatSdk().catch((err) => {
          log(err.message || String(err));
          return null;
        }),
      ]);
      state.boot = boot;
      const sdkReady = Boolean(getChatSdkCtor());
      return { boot, sdkReady };
    }

    async function startCollect() {
      if (!hasToken()) {
        emitStatus("need_login", "숲 로그인 필요");
        onNeedLogin();
        return state;
      }
      const cached = String(localStorage.getItem(STATION_KEY) || "").trim();
      if (looksLikeSoopUserId(cached)) setStation(cached);
      state.autoEnabled = true;
      emitStatus("waiting", "방송 대기");
      startWatch();
      startPresence();
      startTokenKeepalive();
      return state;
    }

    function pauseCollect() {
      state.autoEnabled = false;
      stopWatch();
      const wasConnected = state.connected;
      dropChat(state.chat);
      if (wasConnected) pauseCollectorOnServer().catch(() => {});
      emitStatus("stopped", "수집 일시 중지");
    }

    function resumeCollect() {
      if (!hasToken()) return state;
      state.autoEnabled = true;
      emitStatus("waiting", "방송 대기");
      startWatch();
      startPresence();
      startTokenKeepalive();
      return state;
    }

    async function retryConnect() {
      if (!hasToken()) {
        emitStatus("need_login", "숲 로그인 필요");
        onNeedLogin();
        return false;
      }
      emitStatus("connecting", "재시도 중");
      const profile = await ensureProfile({ bind: true });
      if (!isUsableProfile(profile)) {
        emitStatus("error", "프로필 연결 실패");
        return false;
      }
      state.autoEnabled = true;
      if (!state.watchTimer) startWatch();
      return connectChat({ silent: false, urgent: true });
    }

    function stop() {
      state.autoEnabled = false;
      stopWatch();
      stopPresence();
      stopTokenKeepalive();
      const wasConnected = state.connected;
      dropChat(state.chat);
      if (wasConnected) pauseCollectorOnServer().catch(() => {});
      pingPresence({ clear: true }).catch(() => {});
      emitStatus("stopped");
    }

    return {
      start,
      stop,
      prepareBoot,
      startCollect,
      pauseCollect,
      resumeCollect,
      retryConnect,
      completeOauthIfNeeded: maybeCompleteOauth,
      startOauth,
      hasToken,
      ensureProfile,
      pollLive,
      ensureObsLink,
      syncObsLinkTokens,
      getObsKey: () => state.obsKey || readObsKeyFromUrl(),
      getStationId: () => state.stationId,
      getState: () => ({ ...state }),
      TOKEN_KEY,
      REFRESH_KEY,
      STATION_KEY,
    };
  }

  window.EndingCollectRuntime = { create, TOKEN_KEY, REFRESH_KEY, STATION_KEY, OAUTH_NEXT_KEY };
})();
