/**
 * /live_data 전용 — 숲 OAuth 로그인 (수집기·스튜디오 링크 없음).
 */
(() => {
  const base = () => String(window.CREDITS_BASE || "");

  function apiUrl(path) {
    const p = String(path || "");
    return `${base()}${p.startsWith("/") ? p : `/${p}`}`;
  }

  function token() {
    try {
      return String(localStorage.getItem(window.EndingCollectRuntime?.TOKEN_KEY || "") || "").trim();
    } catch (_) {
      return "";
    }
  }

  function clearOauthBusy() {
    try {
      document.documentElement.classList.remove("ending-oauth-busy");
    } catch (_) {
      /* ignore */
    }
  }

  function hasOauthCodeInUrl() {
    try {
      const q = new URLSearchParams(location.search);
      return Boolean(q.get("code") || q.get("authCode"));
    } catch (_) {
      return false;
    }
  }

  function stripOauthParamsFromUrl() {
    try {
      const url = new URL(location.href);
      const keys = ["code", "authCode", "error", "error_description"];
      if (!keys.some((k) => url.searchParams.get(k))) return;
      keys.forEach((k) => url.searchParams.delete(k));
      history.replaceState({}, "", url.toString());
    } catch (_) {
      /* ignore */
    }
  }

  async function verifyStaffAccess() {
    const tok = token();
    if (!tok) return false;
    try {
      const res = await fetch(apiUrl("/api/credits/me"), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Soop-Access-Token": tok,
        },
        body: "{}",
      });
      const data = await res.json().catch(() => ({}));
      return Boolean(res.ok && data?.ok && data?.staffAccess);
    } catch (_) {
      return false;
    }
  }

  let runtime = null;

  async function ensureRuntime() {
    if (!window.EndingCollectRuntime) return null;
    if (!runtime) {
      runtime = window.EndingCollectRuntime.create({
        base: base(),
        oauthNext: "live_data",
      });
    }
    return runtime;
  }

  async function completeOauthIfNeeded() {
    const rt = await ensureRuntime();
    if (!rt) return false;
    await rt.prepareBoot();
    return rt.completeOauthIfNeeded();
  }

  async function startLogin() {
    clearOauthBusy();
    try {
      sessionStorage.setItem(window.EndingCollectRuntime?.OAUTH_NEXT_KEY || "ending_oauth_next", "live_data");
    } catch (_) {
      /* ignore */
    }
    const rt = await ensureRuntime();
    if (!rt) return false;
    await rt.prepareBoot();
    return rt.startOauth();
  }

  async function bootstrapAuth() {
    const hadCode = hasOauthCodeInUrl();
    try {
      const oauthOk = hadCode ? await completeOauthIfNeeded() : false;
      const ok = await verifyStaffAccess();
      if (hadCode && !oauthOk && !ok) {
        window.__liveDataGateMsg = "숲 로그인에 실패했습니다. 다시 시도해 주세요.";
        stripOauthParamsFromUrl();
      }
      return ok;
    } catch (_) {
      if (hadCode) {
        window.__liveDataGateMsg = "숲 로그인 처리 중 오류가 났습니다.";
        stripOauthParamsFromUrl();
      }
      return false;
    } finally {
      clearOauthBusy();
    }
  }

  async function logout() {
    try {
      await fetch(apiUrl("/api/credits/logout"), {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
    } catch (_) {
      /* ignore */
    }
    const keys = [
      window.EndingCollectRuntime?.TOKEN_KEY || "ending_soop_access_token",
      window.EndingCollectRuntime?.REFRESH_KEY || "ending_soop_refresh_token",
      window.EndingCollectRuntime?.STATION_KEY || "ending_soop_station_id",
    ];
    keys.forEach((key) => {
      try {
        localStorage.removeItem(key);
      } catch (_) {
        /* ignore */
      }
    });
    window.__liveDataLogout?.();
  }

  window.__liveDataAuth = {
    bootstrapAuth,
    startLogin,
    verifyStaffAccess,
    logout,
    clearOauthBusy,
  };

  window.__liveDataAuthReady = bootstrapAuth();

  document.getElementById("btn-live-data-login")?.addEventListener("click", () => {
    startLogin();
  });

  document.getElementById("btn-live-data-logout")?.addEventListener("click", () => {
    logout();
  });

  window.addEventListener("storage", (ev) => {
    const key = window.EndingCollectRuntime?.TOKEN_KEY || "";
    if (key && ev.key === key && token()) {
      window.__liveDataRefresh?.();
    }
  });
})();
