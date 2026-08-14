/**
 * /live_data 전용 — 숲 OAuth 로그인 (수집기·스튜디오 링크 없음).
 */
(() => {
  const base = () => String(window.CREDITS_BASE || "");
  const prefix = () => (base() ? `${base()}/` : "/");
  let runtime = null;

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
    const rt = await ensureRuntime();
    if (!rt) return false;
    await rt.prepareBoot();
    return rt.startOauth();
  }

  async function bootstrapAuth() {
    await completeOauthIfNeeded();
    return verifyStaffAccess();
  }

  window.__liveDataAuth = {
    bootstrapAuth,
    startLogin,
    verifyStaffAccess,
  };

  document.getElementById("btn-live-data-login")?.addEventListener("click", () => {
    startLogin();
  });

  window.addEventListener("storage", (ev) => {
    const key = window.EndingCollectRuntime?.TOKEN_KEY || "";
    if (key && ev.key === key && token()) {
      window.__liveDataRefresh?.();
    }
  });

  bootstrapAuth().then((ok) => {
    if (ok) window.__liveDataRefresh?.();
  });
})();
