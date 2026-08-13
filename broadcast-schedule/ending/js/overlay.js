(() => {
  const params = new URLSearchParams(location.search);
  const isStudioParam =
    params.get("studio") === "1" || params.get("studio") === "true";
  // studio iframe 미리보기용. OBS Browser Source 에서는 parent 판별로 수집을 끄지 않음.
  const isStudioEmbed = isStudioParam || (window.parent !== window && !params.has("obs"));
  const isPreview =
    params.get("preview") === "1" ||
    params.get("preview") === "true" ||
    !params.has("obs");
  const isObsLive = params.has("obs") && !isPreview && !isStudioParam;
  // OBS 실방송: 기본은 표시만. 수집은 /ending/ 탭. 필요 시에만 ?collect=1
  const collectEnabled =
    isObsLive &&
    (params.get("collect") === "1" || params.get("collect") === "true");
  // 우측 하단 수집 상태 배지: 기본 OFF. ?hud=1 (또는 collectHud/status) 로 다시 켬
  const showCollectHud =
    params.get("hud") === "1" ||
    params.get("hud") === "true" ||
    params.get("collectHud") === "1" ||
    params.get("collectHud") === "true" ||
    params.get("status") === "1" ||
    params.get("status") === "true";
  const collectDebug =
    params.get("collectDebug") === "1" || params.get("collectDebug") === "true";
  const AUTH_GUIDE_DEFAULT =
    "수집은 /ending/ 탭에서 하세요. OBS URL은 표시용입니다 (비상 수집만 ?collect=1).";
    let onlyId = String(params.get("only") || "").trim();
    if (onlyId === "duration") onlyId = "timeline";
    // loop=1 일 때만 전체 반복. 기본은 한 사이클 후 종료.
    let loopPlayback =
      params.get("loop") === "1" || params.get("loop") === "true";
    // 스튜디오에서 한 페이지만 볼 때는 그 페이지만 반복 미리보기
    let singleLoop = Boolean(onlyId);
    let isPlaying = false;

  const HOLO = window.EndingHologram || null;
  const HOLO_THEME_IDS = new Set(["report", "reportProj"]);

  function normalizeThemeId(raw) {
    const id = String(raw || "").trim();
    if (id === "report") return "report";
    if (id === "reportProj") return "reportProj";
    // 수첩(notebook) 폐기 → 홀로그램 투영
    return "reportProj";
  }

  /** URL theme= 이 최우선, 없으면 overlay-config.theme */
  let activeTheme = normalizeThemeId(params.get("theme"));
  let themeFromUrl = Boolean(String(params.get("theme") || "").trim());

  function isHoloTheme() {
    return Boolean(HOLO?.isHologramTheme?.(activeTheme));
  }

  /** 공책·홀로그램 공통 960×1080 고정 디자인 캔버스 */
  function fitCreditsCanvas() {
    const canvas = document.getElementById("credits-canvas");
    const stage = document.getElementById("credits-stage");
    if (!canvas || !stage) return;
    const cw = 960;
    const ch = 1080;
    document.documentElement.style.setProperty("--canvas-w", `${cw}px`);
    document.documentElement.style.setProperty("--canvas-h", `${ch}px`);
    const sw = stage.clientWidth || window.innerWidth || cw;
    const sh = stage.clientHeight || window.innerHeight || ch;
    if (sw < 2 || sh < 2) return;
    const scale = Math.min(sw / cw, sh / ch);
    canvas.style.transform = `translate(-50%, -50%) scale(${scale})`;
    if (typeof scheduleRuleSnap === "function") scheduleRuleSnap();
  }

  function syncThemeShell() {
    if (HOLO?.applyShell) {
      const host = HOLO.applyShell(isHoloTheme() ? activeTheme : "reportProj");
      if (host) els.slides = host;
    } else if (els.slides?.id !== "credits-slides") {
      els.slides = document.getElementById("credits-slides");
    }
    fitCreditsCanvas();
  }

  const CONTROL_CHANNEL = "sirian-credits-overlay";
  let controlBus = null;
  try {
    controlBus = new BroadcastChannel(CONTROL_CHANNEL);
  } catch (_) {
    controlBus = null;
  }

  const els = {
    body: document.body,
    banner: document.getElementById("credits-preview-banner"),
    bannerMsg: document.getElementById("credits-preview-banner-msg"),
    bannerLink: document.getElementById("credits-preview-banner-link"),
    previewPage: document.getElementById("credits-preview-page"),
    previewPageLabel: document.getElementById("credits-preview-page-label"),
    previewPageData: document.getElementById("credits-preview-page-data"),
    obsUrl: document.getElementById("credits-obs-url"),
    slides: document.getElementById("credits-slides"),
    status: document.getElementById("credits-status"),
    pagePos: document.getElementById("credits-page-pos"),
    collectAuth: document.getElementById("obs-collect-auth"),
    collectAuthMsg: document.getElementById("obs-collect-auth-msg"),
    collectLogin: document.getElementById("obs-collect-login"),
    collectDot: document.getElementById("obs-collect-dot"),
    collectStatus: document.getElementById("obs-collect-status"),
    collectStatusLabel: document.getElementById("obs-collect-status-label"),
    collectToast: document.getElementById("obs-collect-toast"),
    collectToastTitle: document.getElementById("obs-collect-toast-title"),
    collectToastSub: document.getElementById("obs-collect-toast-sub"),
  };

  syncThemeShell();

  let collectRuntime = null;
  let lastCollectPhase = "";
  let collectToastTimer = null;
  let collectToastMode = ""; // "" | "waiting" | "collecting"
  const COLLECT_TOAST_MS = 3800;

  let slideTimer = null;
  let closeTimer = null;
  let openTimer = null;
  let entranceTimer = null;
  let slideIndex = 0;
  let slideNodes = [];
  let overlayConfig = null;
  let creditsData = null;
  let creditsDataRaw = null;
  let slideMs = 6500;
  let listSlideMs = 8500;
  /** 등장·표지 연출 중 — 키/수동 넘김이 끼어들면 요약↔표지 깜빡임이 난다 */
  let entrancePending = false;
  /** 방향키로 장을 넘긴 뒤 — 중복 play 신호가 표지부터 다시 시작하지 못하게 막는다 */
  let suppressPlayRestart = false;
  let lastPlaySignalAt = 0;
  const NOTEBOOK_OPEN_MS = 1250;
  const NOTEBOOK_CLOSE_MS = 1100;
  const NOTEBOOK_ENTER_MS = 1200;
  const COVER_IDS = new Set(["coverOpen"]);

  function stationIdFromUrl() {
    return String(params.get("stationId") || "").trim();
  }

  function apiUrl(path) {
    const base = window.CREDITS_BASE || window.SCHEDULE_BASE || "";
    return `${base}${path}`;
  }

  function overlayConfigUrl() {
    const sid = stationIdFromUrl();
    const qs = sid ? `?stationId=${encodeURIComponent(sid)}` : "";
    return apiUrl(`/api/credits/overlay-config${qs}`);
  }

  function obsPageUrl() {
    const url = new URL(location.href);
    url.searchParams.delete("preview");
    url.searchParams.delete("studio");
    url.searchParams.delete("only");
    url.searchParams.delete("loop");
    url.searchParams.set("obs", "1");
    return url.toString();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 닉네임용 — 한 덩어리로 감싸 그리드 깨짐 방지, ø만 별도 폰트 */
  function escapeNickHtml(value) {
    const inner = escapeHtml(value).replace(
      /ø|Ø/g,
      (ch) => `<span class="credits-fan-mark">${ch}</span>`
    );
    return `<span class="credits-nick">${inner}</span>`;
  }

  function formatNumber(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return String(n ?? "");
    return num.toLocaleString("ko-KR");
  }

  /** "48번" → 숫자·단위로 나눠 횟수 표기 HTML */
  function metricHtml(value, className) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    const cls = String(className || "credits-metric").trim();
    const m = raw.match(/^([\d,.\s]+)\s*(.*)$/);
    if (!m || !String(m[1] || "").trim()) {
      return `<span class="${cls}">${escapeHtml(raw)}</span>`;
    }
    const num = String(m[1]).replace(/\s+/g, "").trim();
    const unit = String(m[2] || "").trim();
    return `<span class="${cls}"><b class="${cls}__num">${escapeHtml(
      num
    )}</b>${
      unit ? `<i class="${cls}__unit">${escapeHtml(unit)}</i>` : ""
    }</span>`;
  }

  function clockFromMarkerLabel(label) {
    return String(label || "").replace(/^(방송 ON|방송 OFF|방제)\s*/, "").trim();
  }

  /** 시청자 엔딩용 — 시작·종료·방제만 (수집기 on/off 등 운영 마커 제외) */
  function viewerTimelineMarkers(markers) {
    const allow = new Set(["start", "end", "title"]);
    return (Array.isArray(markers) ? markers : []).filter((m) => {
      if (!m || !allow.has(String(m.kind || ""))) return false;
      const title = String(m.title || "");
      if (/수집기/.test(title)) return false;
      return true;
    });
  }

  /**
   * 방제가 많을 때 시작·종료는 유지하고 중간 방제를 고르게 샘플링한다.
   */
  function pickTimelineListItems(markers, maxVisible = 10) {
    const events = viewerTimelineMarkers(markers);
    const starts = events.filter((m) => m.kind === "start");
    const ends = events.filter((m) => m.kind === "end");
    const titles = events.filter((m) => m.kind !== "start" && m.kind !== "end");
    const titleCount = titles.length;
    if (events.length <= maxVisible) {
      return { items: events, hidden: 0, titleCount, total: events.length };
    }
    const reserved = starts.length + ends.length;
    const titleSlots = Math.max(2, maxVisible - reserved);
    let pickedTitles = titles;
    if (titles.length > titleSlots) {
      const indices = new Set([0, titles.length - 1]);
      const midNeed = Math.max(0, titleSlots - indices.size);
      for (let i = 1; i <= midNeed; i += 1) {
        const idx = Math.round((i * (titles.length - 1)) / (midNeed + 1));
        indices.add(Math.min(titles.length - 1, Math.max(0, idx)));
      }
      for (let i = 0; i < titles.length && indices.size < titleSlots; i += 1) {
        indices.add(i);
      }
      pickedTitles = [...indices]
        .sort((a, b) => a - b)
        .slice(0, titleSlots)
        .map((i) => titles[i]);
    }
    const items = [...starts, ...pickedTitles, ...ends].sort(
      (a, b) => (Number(a.pct) || 0) - (Number(b.pct) || 0)
    );
    return {
      items,
      hidden: Math.max(0, events.length - items.length),
      titleCount,
      total: events.length,
    };
  }

  function mediaUrl(path) {
    const raw = String(path || "").trim();
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw) || raw.startsWith("data:")) return raw;
    if (raw.startsWith("/")) {
      const base = window.CREDITS_BASE || window.SCHEDULE_BASE || "";
      // /api/credits/... 는 엔딩 서비스 루트 기준
      if (raw.startsWith("/api/credits/") && base) {
        return `${base}${raw}`;
      }
      if (base && !raw.startsWith(base + "/") && raw !== base) {
        return `${base}${raw}`;
      }
      return raw;
    }
    return raw;
  }

  function parseSignatureAmounts(raw) {
    const out = [];
    const seen = new Set();
    const list = Array.isArray(raw)
      ? raw
      : String(raw || "")
          .split(/[,，\s]+/)
          .filter(Boolean);
    for (const item of list) {
      const n = Math.floor(Number(item));
      if (!Number.isFinite(n) || n < 1 || n > 1000000 || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out.sort((a, b) => a - b);
  }

  function applySignatureFilter(data) {
    if (!data || typeof data !== "object") return data;
    const balloons = Array.isArray(data.signatureBalloons) ? data.signatureBalloons : [];
    const balloonImgs = new Map();
    const soopAmounts = [];
    for (const b of balloons) {
      const n = Math.floor(Number(b?.amount));
      const img = String(b?.imageUrl || "").trim();
      if (!Number.isFinite(n) || n < 1) continue;
      soopAmounts.push(n);
      if (img) balloonImgs.set(n, img);
    }
    const cfgAmounts = parseSignatureAmounts(slideCfg("signature").amounts);
    let amounts = cfgAmounts;
    if (soopAmounts.length) {
      if (!cfgAmounts.length || (cfgAmounts.length === 1 && cfgAmounts[0] === 100)) {
        amounts = soopAmounts.slice().sort((a, b) => a - b);
      } else {
        amounts = parseSignatureAmounts([...cfgAmounts, ...soopAmounts]);
      }
    }
    const hitCount = (it) => {
      const raw = String(it?.value || "");
      const m = raw.match(/([\d,]+)/);
      if (!m) return 0;
      const n = Number(String(m[1]).replace(/,/g, ""));
      return Number.isFinite(n) ? n : 0;
    };
    const sections = Array.isArray(data.sections) ? data.sections : [];
    const next = sections.map((sec) => {
      if (!sec || sec.id !== "signature" || !Array.isArray(sec.items)) return sec;
      const allowed = new Set(amounts);
      const filtered = sec.items
        .filter((it) => {
          const digits = String(it?.name || "").replace(/[^\d]/g, "");
          const value = digits ? Number(digits) : 0;
          if (allowed.size) return allowed.has(value);
          return value >= 100;
        })
        .slice()
        .sort((a, b) => {
          const dh = hitCount(b) - hitCount(a);
          if (dh) return dh;
          const av = Number(String(a?.name || "").replace(/[^\d]/g, "")) || 0;
          const bv = Number(String(b?.name || "").replace(/[^\d]/g, "")) || 0;
          return bv - av;
        });
      const moreHits =
        filtered.length > 5
          ? filtered.slice(5).reduce((sum, it) => sum + hitCount(it), 0)
          : filtered.length === sec.items.length
            ? Math.max(0, Number(sec.moreHits) || 0)
            : 0;
      const top = filtered.slice(0, 5).map((it, i) => {
        const digits = String(it?.name || "").replace(/[^\d]/g, "");
        const value = digits ? Number(digits) : 0;
        const imageUrl = String(it?.imageUrl || "").trim() || balloonImgs.get(value) || "";
        return { ...it, rank: i + 1, imageUrl };
      });
      return {
        ...sec,
        items: top,
        moreHits,
        pending: Boolean(sec.pending) && !top.length,
      };
    });
    return { ...data, sections: next };
  }

  function setStatus(message, show) {
    if (!els.status) return;
    if (!show) {
      els.status.hidden = true;
      return;
    }
    els.status.hidden = false;
    els.status.textContent = message;
  }

  function findSection(sections, id) {
    return (Array.isArray(sections) ? sections : []).find((s) => s && s.id === id) || null;
  }

  function slideCfg(id) {
    const slides = overlayConfig?.slides || {};
    return slides[id] && typeof slides[id] === "object" ? slides[id] : {};
  }

  function isEnabled(id) {
    if (onlyId && id === onlyId) return true;
    const cfg = slideCfg(id);
    return cfg.enabled !== false;
  }

  function durationFor(id, fallback) {
    const cfg = slideCfg(id);
    const custom = Number(cfg.durationMs);
    if (Number.isFinite(custom) && custom >= 1200) return custom;
    const catalogMs = Number(overlayConfig?.meta?.catalog?.[id]?.defaultMs);
    if (Number.isFinite(catalogMs) && catalogMs >= 1200) return catalogMs;
    return fallback;
  }

  function closedMsFor(id, fallback = 0) {
    const cfg = slideCfg(id);
    const custom = Number(cfg.closedMs);
    if (Number.isFinite(custom) && custom >= 0) return Math.min(60000, custom);
    const catalogMs = Number(overlayConfig?.meta?.catalog?.[id]?.defaultClosedMs);
    if (Number.isFinite(catalogMs) && catalogMs >= 0) return Math.min(60000, catalogMs);
    return fallback;
  }

  function fadeMsFor(id, fallback = 1200) {
    const cfg = slideCfg(id);
    const custom = Number(cfg.fadeMs);
    if (Number.isFinite(custom) && custom >= 0) return Math.min(60000, custom);
    const catalogMs = Number(overlayConfig?.meta?.catalog?.[id]?.defaultFadeMs);
    if (Number.isFinite(catalogMs) && catalogMs >= 0) return Math.min(60000, catalogMs);
    return fallback;
  }

  function textField(id, field, fallback) {
    const cfg = slideCfg(id);
    const val = cfg[field];
    if (val != null && String(val).trim() !== "") return String(val);
    return fallback;
  }

  function applyCoverFace() {
    const set = (sel, value, { hideEmpty = false } = {}) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const next = String(value ?? "").trim();
      el.textContent = next;
      if (hideEmpty) {
        if (next) el.removeAttribute("hidden");
        else el.setAttribute("hidden", "");
      }
    };
    const eyebrow = textField("coverOpen", "eyebrow", "");
    const brand = textField("coverOpen", "value", "SIRIAN RAIN");
    const title = textField("coverOpen", "title", "ENDING CREDITS");
    const sub = textField("coverOpen", "sub", "");
    set(".notebook__flap-eyebrow", eyebrow, { hideEmpty: true });
    set(".notebook__flap-brand", brand || "SIRIAN RAIN");
    set(".notebook__flap-title", title || "ENDING CREDITS");
    set(".notebook__flap-sub", sub, { hideEmpty: true });
  }

  function stageEl() {
    return document.getElementById("credits-stage");
  }

  function resetStageFade() {
    const stage = stageEl();
    if (!stage) return;
    stage.classList.remove("is-fading");
    stage.style.transitionDuration = "";
  }

  function fadeOutStage(fadeMs) {
    const stage = stageEl();
    if (!stage) return;
    const ms = Math.max(0, Number(fadeMs) || 0);
    if (prefersReducedMotion() || ms <= 0) {
      stage.style.transitionDuration = "0ms";
      stage.classList.add("is-fading");
      return;
    }
    stage.style.transitionDuration = `${ms}ms`;
    // force reflow so duration applies before class
    void stage.offsetWidth;
    stage.classList.add("is-fading");
  }

  const LIST_LIMIT = 12;
  const FANCLUB_LIST_LIMIT = 24;
  const RANK_LIMIT = 10;

  function pushNameList(slides, id, title, entries, opts = {}) {
    if (!isEnabled(id)) return false;
    const limit = opts.limit ?? LIST_LIMIT;
    const mapped = (entries || [])
      .map((entry) => {
        if (typeof entry === "string") return entry.trim();
        if (!entry || typeof entry !== "object") return "";
        if (typeof opts.format === "function") return String(opts.format(entry) || "").trim();
        return String(entry.name || "").trim();
      })
      .filter(Boolean);
    const countLabel =
      opts.countLabel != null
        ? String(opts.countLabel)
        : "";
    if (!mapped.length) {
      if (onlyId === id) {
        slides.push({
          id,
          kind: "list",
          title,
          countLabel,
          names: ["(미리보기 · 명단 없음)"],
          more: 0,
          columns: 1,
          duration: durationFor(id, listSlideMs),
        });
        return true;
      }
      return false;
    }
    const total = Math.max(Number(opts.total) || 0, mapped.length);
    const shown = mapped.slice(0, limit);
    const more = Math.max(0, total - shown.length);
    const columns =
      Number(opts.columns) > 1 || (opts.autoColumns && shown.length >= 7) ? 2 : 1;
    slides.push({
      id,
      kind: "list",
      title,
      countLabel: countLabel || (opts.showCount !== false && total > 0 ? `${formatNumber(total)}명` : ""),
      names: shown,
      more,
      columns,
      duration: durationFor(id, listSlideMs),
    });
    return true;
  }

  function pushSignatureBoard(slides, id, section, title) {
    if (!isEnabled(id)) return false;
    const raw = Array.isArray(section?.items) ? section.items : [];
    const moreHits = Math.max(0, Number(section?.moreHits) || 0);
    const items = raw
      .filter((i) => i && i.name)
      .slice(0, 5)
      .map((item, i) => ({
        rank: Number(item.rank) || i + 1,
        name: String(item.name),
        value: item.value ? String(item.value) : "",
        topDonor: String(item.topDonor || "").trim(),
        topDonorHits: Math.max(0, Number(item.topDonorHits) || 0),
        morePeople: Math.max(0, Number(item.morePeople) || 0),
        imageUrl: String(item.imageUrl || "").trim(),
      }));
    const demoSig = [
      {
        rank: 1,
        name: "112개",
        value: "14번",
        topDonor: "유저01",
        topDonorHits: 6,
        morePeople: 5,
        imageUrl: "https://static.file.sooplive.com/starballoon/story_m/sirianrain_112.png",
      },
      {
        rank: 2,
        name: "152개",
        value: "9번",
        topDonor: "유저02",
        topDonorHits: 4,
        morePeople: 3,
        imageUrl: "https://static.file.sooplive.com/starballoon/story_m/sirianrain_152.png",
      },
      {
        rank: 3,
        name: "505개",
        value: "7번",
        topDonor: "유저03",
        topDonorHits: 5,
        morePeople: 2,
        imageUrl: "https://static.file.sooplive.com/starballoon/story_m/sirianrain_505.png",
      },
      {
        rank: 4,
        name: "700개",
        value: "4번",
        topDonor: "유저04",
        topDonorHits: 2,
        morePeople: 1,
        imageUrl: "https://static.file.sooplive.com/starballoon/story_m/sirianrain_700.png",
      },
      {
        rank: 5,
        name: "1724개",
        value: "2번",
        topDonor: "유저05",
        topDonorHits: 2,
        morePeople: 0,
        imageUrl: "https://static.file.sooplive.com/starballoon/story_m/sirianrain_1724.png",
      },
    ];
    if (!items.length) {
      if (onlyId === id) {
        slides.push({
          id,
          kind: "signatureBoard",
          title,
          holoTitle: "시그니처",
          items: demoSig,
          more: 1,
          duration: durationFor(id, slideMs + 600),
        });
        return true;
      }
      return false;
    }
    slides.push({
      id,
      kind: "signatureBoard",
      title,
      holoTitle: "시그니처",
      items,
      more: moreHits,
      duration: durationFor(id, Math.max(slideMs + 400, 4800 + items.length * 500)),
    });
    return true;
  }

  function pushRankCountdown(slides, id, section, title) {
    if (id === "signature") return pushSignatureBoard(slides, id, section, title);
    if (!isEnabled(id)) return false;
    const RANK_UNITS = {
      chat: "횟수",
      emoticon: "횟수",
      donation: "개수",
      watch: "시간",
      quickview: "횟수",
      mission: "후원",
    };
    const unit = RANK_UNITS[id] || "횟수";
    const raw = Array.isArray(section?.items) ? section.items : [];
    const items = raw
      .filter((i) => i && i.name)
      .map((item, i) => ({
        rank: Number(item.rank) || i + 1,
        name: String(item.name),
        value: item.value ? String(item.value) : "",
      }));
    if (!items.length) {
      if (onlyId === id) {
        const previewTop =
          id === "emoticon"
            ? [
                {
                  rank: 1,
                  name: "/시/",
                  value: "128회",
                  imageUrl:
                    "https://static.file.sooplive.com/signature_emoticon/sirianrain/26356911fb049eb05.png",
                },
                {
                  rank: 2,
                  name: "/사랑해요/",
                  value: "87회",
                  imageUrl:
                    "https://static.file.sooplive.com/signature_emoticon/sirianrain/1680696d881fb4d19.png",
                },
                {
                  rank: 3,
                  name: "/따봉/",
                  value: "64회",
                  imageUrl:
                    "https://static.file.sooplive.com/signature_emoticon/sirianrain/7135696d87e3e60dc.png",
                },
              ]
            : [];
        slides.push({
          id,
          kind: "rankBoard",
          title,
          unit,
          champ: { rank: 1, name: "유저01", value: "96회" },
          rest: [
            { rank: 2, name: "유저02", value: "41회" },
            { rank: 3, name: "유저03", value: "28회" },
            { rank: 4, name: "유저04", value: "19회" },
          ],
          more: 0,
          topEmoticons: previewTop,
          topLabel: id === "emoticon" ? textField("emoticon", "topLabel", "구독 시그니처 이모티콘") : "",
          duration: durationFor(id, slideMs + 400),
        });
        return true;
      }
      return false;
    }

    const total = items.length;
    const top = items.slice(0, RANK_LIMIT);
    const byRank = [...top].sort((a, b) => a.rank - b.rank);
    const champ = byRank.find((i) => i.rank === 1) || byRank[0] || null;
    const rest = byRank
      .filter((i) => i !== champ && i.rank >= 2 && i.rank <= RANK_LIMIT)
      .sort((a, b) => a.rank - b.rank);
    const more = Math.max(0, total - top.length);

    const restMs = rest.length ? 900 + rest.length * 480 : 0;
    const topEmoticons = Array.isArray(section?.topEmoticons)
      ? section.topEmoticons.filter((e) => e && e.name).slice(0, 10)
      : [];
    slides.push({
      id,
      kind: "rankBoard",
      title,
      unit,
      champ,
      rest,
      more,
      topEmoticons,
      topLabel: id === "emoticon" ? textField("emoticon", "topLabel", "구독 시그니처 이모티콘") : "",
      duration: durationFor(
        id,
        Math.max(slideMs + 400, 5200 + restMs + (topEmoticons.length ? 900 : 0))
      ),
    });
    return true;
  }

  function resolveSlideOrder() {
    const raw = overlayConfig?.order || overlayConfig?.meta?.order;
    const known = Array.isArray(overlayConfig?.meta?.order)
      ? overlayConfig.meta.order.slice()
      : [
          "coverOpen",
          "summary",
          "highlight",
          "analytics",
          "timeline",
          "firstChat",
          "chat",
          "emoticon",
          "donation",
          "signature",
          "watch",
          "quickview",
          "mission",
          "fanclub",
          "topfan",
          "subscribe",
          "subscribe_renew",
          "subscribe_gift",
          "flags",
          "nextDay",
          "outro",
        ];
    const out = [];
    const seen = new Set();
    const dropIds = new Set(["coverClose", "intro"]);
    if (Array.isArray(raw)) {
      for (const id of raw) {
        let key = String(id || "").trim();
        if (key === "duration") key = "timeline";
        if (!key || seen.has(key) || dropIds.has(key)) continue;
        seen.add(key);
        out.push(key);
      }
    }
    for (const id of known) {
      if (seen.has(id) || dropIds.has(id)) continue;
      /* 기본 순서 기준 앞 페이지 뒤에 끼워 넣기 */
      const ki = known.indexOf(id);
      let insertAt = out.length;
      for (let i = ki - 1; i >= 0; i--) {
        const prev = known[i];
        const pi = out.indexOf(prev);
        if (pi >= 0) {
          insertAt = pi + 1;
          break;
        }
      }
      out.splice(insertAt, 0, id);
      seen.add(id);
    }
    /* 시안 페이지 — 기존 설정에 없어도 요약 다음에 삽입 */
    const ensureAfter = (id, afterId) => {
      if (seen.has(id)) return;
      const ai = out.indexOf(afterId);
      out.splice(ai >= 0 ? ai + 1 : 1, 0, id);
      seen.add(id);
    };
    ensureAfter("highlight", "summary");
    ensureAfter("analytics", "highlight");
    return out;
  }

  function orderSlides(bag) {
    const byId = new Map();
    for (const slide of bag) {
      if (!slide || !slide.id) continue;
      byId.set(slide.id, slide);
    }
    const out = [];
    for (const id of resolveSlideOrder()) {
      if (!byId.has(id)) continue;
      out.push(byId.get(id));
      byId.delete(id);
    }
    for (const slide of byId.values()) out.push(slide);
    return out;
  }

  function buildSlides(data) {
    const info = data.info || {};
    const sections = data.sections || [];
    const slides = [];
    const want = (id) => !onlyId || onlyId === id;

    if (want("coverOpen") && isEnabled("coverOpen")) {
      const coverValue = textField("coverOpen", "value", "SIRIAN RAIN");
      const coverTitle = textField("coverOpen", "title", "ENDING CREDITS");
      const coverSub = textField("coverOpen", "sub", "");
      const dateLabel = stampDateLabel({ info }) || String(info.dateLabel || "").trim();
      const isDemo = Boolean(data?.demo) || onlyId === "coverOpen";
      // 기본 히어로「오늘의 방송 보고서」· 스튜디오 value 커스텀 시 그대로 사용
      let hero = "오늘의 방송 보고서";
      if (coverValue && coverValue !== "SIRIAN RAIN") hero = coverValue;
      const dateCode = (() => {
        const m = dateLabel.match(/(\d+)\s*월\s*(\d+)\s*일/);
        if (!m) return String(info.dateCode || "").trim();
        const yRaw = String(info.startedAt || info.date || "").slice(0, 4);
        const y = /^\d{4}$/.test(yRaw) ? yRaw : String(new Date().getFullYear());
        return `${y}.${String(m[1]).padStart(2, "0")}.${String(m[2]).padStart(2, "0")}`;
      })();
      slides.push({
        id: "coverOpen",
        kind: "coverOpen",
        duration: durationFor("coverOpen", 3200),
        eyebrow: textField("coverOpen", "eyebrow", ""),
        brand: "SIRIAN RAIN",
        hero,
        title: coverTitle,
        sub: coverSub,
        dateLabel,
        dateCode,
        docId: isDemo ? "TEST-0801" : String(info.docId || "").trim(),
      });
    }

    const hasSummaryData =
      (info.durationLabel && info.durationLabel !== "—") ||
      Number(info.peakViewers) > 0 ||
      Number(info.chatCount) > 0 ||
      Number(info.chatters) > 0 ||
      Boolean(String(info.peakThumbUrl || "").trim());
    if (want("summary") && isEnabled("summary") && (hasSummaryData || onlyId === "summary")) {
      const peakViewers = Number(info.peakViewers) || (onlyId === "summary" ? 1284 : 0);
      const donationCount =
        Number(info.donationCount) ||
        Number(info.donorCount) ||
        Number(info.donors) ||
        Number(data?.counts?.donors) ||
        0;
      const subscribeCount =
        Number(info.subscribeCount || 0) +
        Number(info.subscribeRenewCount || 0) +
        Number(info.subscribeGiftCount || 0);
      const startedRaw = String(data?.session?.startedAt || info.startedAt || "").trim();
      const endedRaw = String(data?.session?.endedAt || info.endedAt || "").trim();
      const clock = (iso) => {
        if (!iso) return "";
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return "";
        return d.toLocaleTimeString("ko-KR", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "Asia/Seoul",
        });
      };
      const startClock = clock(startedRaw);
      const endClock = clock(endedRaw);
      const timeRangeLabel =
        startClock && endClock
          ? `${startClock} – ${endClock}`
          : startClock
            ? `${startClock} –`
            : "";
      const isDemoSummary = Boolean(data?.demo) || onlyId === "summary";
      slides.push({
        id: "summary",
        kind: "summary",
        title: textField("summary", "title", "오늘의 방송 요약"),
        holoTitle: "방송 요약",
        peakLabel: textField("summary", "peakLabel", "최고 시청 순간"),
        durationLabel: info.durationLabel || (onlyId === "summary" ? "2시간 15분" : ""),
        peakViewers,
        peakAtLabel: info.peakAtLabel || (onlyId === "summary" ? "22:41" : ""),
        peakTitle: info.peakTitle || "",
        broadcastTitle: String(info.title || info.peakTitle || "").trim(),
        peakThumbUrl: mediaUrl(info.peakThumbUrl || ""),
        chatters: Number(info.chatters) || (onlyId === "summary" ? 456 : 0),
        chatCount: Number(info.chatCount) || (onlyId === "summary" ? 7890 : 0),
        donationCount,
        subscribeCount,
        timeRangeLabel,
        oneLiner: isDemoSummary
          ? String(info.oneLiner || "테스트 데이터입니다").trim()
          : String(info.oneLiner || "").trim(),
        duration: durationFor("summary", listSlideMs),
      });
    }

    if (want("timeline") && isEnabled("timeline")) {
      const rawTl = data.timeline || {};
      const tMarkers = viewerTimelineMarkers(rawTl.markers);
      /* 홀로그램: 시안처럼 짧게(최대 8) · 수첩은 전체 마커 유지 */
      const holoMarkers = isHoloTheme()
        ? pickTimelineListItems(tMarkers, 8).items
        : tMarkers;
      const timeline = { ...rawTl, markers: holoMarkers };
      const hasTl = holoMarkers.length || (timeline.liveSegments && timeline.liveSegments.length);
      if (hasTl || onlyId === "timeline") {
        const baseTitle = textField("timeline", "title", "방송 타임라인");
        const titleN = holoMarkers.filter((m) => m.kind !== "start" && m.kind !== "end").length;
        const tlMs = Math.min(16000, listSlideMs + Math.max(0, titleN - 4) * 350);
        slides.push({
          id: "timeline",
          kind: "timeline",
          title: timeline.dayLabel ? `${timeline.dayLabel} ${baseTitle}` : baseTitle,
          liveLabel: textField("timeline", "liveLabel", "방송 중"),
          timeline,
          duration: durationFor("timeline", tlMs),
        });
      }
    }

    /* 하이라이트·방송분석은 홀로그램 시안 전용 (수첩 레이아웃 없음) */
    if (want("highlight") && isEnabled("highlight") && (isHoloTheme() || onlyId === "highlight")) {
      const peakViewersHl = Number(info.peakViewers) || 0;
      const peakAt = String(info.peakAtLabel || "").trim();
      const peakTitle = String(info.peakTitle || "").trim();
      const peakThumb = mediaUrl(info.peakThumbUrl || "");
      const hasPeak =
        peakViewersHl > 0 || peakAt || peakTitle || peakThumb || onlyId === "highlight";
      if (hasPeak) {
        slides.push({
          id: "highlight",
          kind: "highlight",
          title: textField("highlight", "title", "하이라이트"),
          peakLabel: textField("summary", "peakLabel", "최고 시청 순간"),
          peakViewers: peakViewersHl || (onlyId === "highlight" ? 1234 : 0),
          peakAtLabel: peakAt || (onlyId === "highlight" ? "19:53" : ""),
          peakTitle: peakTitle || (onlyId === "highlight" ? "데모 Q&A 구간" : ""),
          peakThumbUrl: peakThumb,
          duration: durationFor("highlight", slideMs + 400),
        });
      }
    }

    if (want("analytics") && isEnabled("analytics") && (isHoloTheme() || onlyId === "analytics")) {
      const series = data.metricsSeries && typeof data.metricsSeries === "object"
        ? data.metricsSeries
        : {};
      const rawViewers = Array.isArray(series.viewers) ? series.viewers : [];
      const viewerVals = rawViewers
        .map((p) => (p && typeof p === "object" ? Number(p.v) : Number(p)))
        .filter((n) => Number.isFinite(n) && n >= 0);
      const isDemoAn = Boolean(data?.demo) || onlyId === "analytics";
      const demoViewers = [320, 480, 620, 780, 910, 1050, 1234, 1180, 980, 860, 740, 690, 640, 580];
      const viewers = viewerVals.length >= 2 ? viewerVals : isDemoAn ? demoViewers : [];
      const avg =
        viewers.length
          ? Math.round(viewers.reduce((a, b) => a + b, 0) / viewers.length)
          : 0;
      const peak = Number(info.peakViewers) || (viewers.length ? Math.max(...viewers) : 0);
      const upGain = Number(info.upGain);
      const balloonTotal = Number(info.balloonTotal);
      const startedRaw = String(data?.session?.startedAt || info.startedAt || "").trim();
      const endedRaw = String(data?.session?.endedAt || info.endedAt || "").trim();
      const clock = (iso) => {
        if (!iso) return "";
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return "";
        return d.toLocaleTimeString("ko-KR", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "Asia/Seoul",
        });
      };
      const startClock = clock(startedRaw) || (isDemoAn ? "19:00" : "");
      const endClock = clock(endedRaw) || (isDemoAn ? "22:12" : "");
      const timeRangeLabel =
        startClock && endClock
          ? `${startClock} – ${endClock}`
          : startClock
            ? `${startClock} –`
            : "";
      const hasAn =
        viewers.length >= 2 ||
        peak > 0 ||
        upGain > 0 ||
        balloonTotal > 0 ||
        onlyId === "analytics";
      if (hasAn) {
        slides.push({
          id: "analytics",
          kind: "analytics",
          title: textField("analytics", "title", "방송 분석"),
          viewers,
          peakViewers: peak,
          timeRangeLabel,
          avgViewersLabel: avg > 0 ? `${formatNumber(avg)}명` : isDemoAn ? "856명" : "",
          peakViewersLabel: peak > 0 ? `${formatNumber(peak)}명` : isDemoAn ? "1,234명" : "",
          upLabel:
            Number.isFinite(upGain) && upGain > 0
              ? formatNumber(upGain)
              : isDemoAn
                ? "3,420"
                : "",
          balloonLabel:
            Number.isFinite(balloonTotal) && balloonTotal > 0
              ? `${formatNumber(balloonTotal)}개`
              : isDemoAn
                ? "12,480개"
                : "",
          duration: durationFor("analytics", slideMs + 600),
        });
      }
    }

    const first = info.firstChat;
    if (want("firstChat") && isEnabled("firstChat") && first && first.name) {
      let sub = "";
      if (first.isEmoticon && first.imageUrl) {
        sub = first.emoticonName || first.message || "이모티콘";
      } else if (first.message) {
        sub = String(first.message);
      } else {
        sub = "";
      }
      slides.push({
        id: "firstChat",
        kind: first.isEmoticon ? "firstChatEmo" : "stat",
        title: textField("firstChat", "title", "첫 채팅"),
        value: first.name,
        sub,
        imageUrl: first.isEmoticon ? String(first.imageUrl || "").trim() : "",
        atLabel: first.atLabel || "",
        duration: durationFor("firstChat", slideMs),
      });
    } else if (want("firstChat") && onlyId === "firstChat") {
      slides.push({
        id: "firstChat",
        kind: "stat",
        title: textField("firstChat", "title", "첫 채팅"),
        value: first?.name || "(미리보기)",
        sub: "첫 메시지",
        atLabel: "19:00",
        duration: durationFor("firstChat", slideMs),
      });
    }

    const rankIds = [
      ["chat", "채팅 순위"],
      ["emoticon", "이모티콘 순위"],
      ["donation", "후원 순위"],
      ["signature", "시그니처"],
      ["watch", "시청 시간 순위"],
      ["quickview", "퀵뷰 순위"],
      ["mission", "미션 순위"],
    ];
    for (const [id, defaultTitle] of rankIds) {
      if (!want(id)) continue;
      pushRankCountdown(slides, id, findSection(sections, id), textField(id, "title", defaultTitle));
    }

    if (want("fanclub")) {
      const fanclub = findSection(sections, "fanclub");
      const fanItems = fanclub && Array.isArray(fanclub.items) ? fanclub.items : [];
      const fanTotal = Math.max(Number(info.fanclubCount) || 0, fanItems.length);
      const baseTitle = textField("fanclub", "title", "팬클럽 신규");
      pushNameList(slides, "fanclub", baseTitle, fanItems, {
        total: fanTotal,
        limit: FANCLUB_LIST_LIMIT,
        autoColumns: true,
      });
    }

    if (want("topfan")) {
      const topfan = findSection(sections, "topfan");
      const topfanItems = topfan && Array.isArray(topfan.items) ? topfan.items : [];
      const baseTitle = textField("topfan", "title", "열혈팬 승급");
      pushNameList(slides, "topfan", baseTitle, topfanItems, {
        total: topfanItems.length,
      });
    }

    if (want("subscribe")) {
      const subs = findSection(sections, "subscribe");
      const subItems = subs && Array.isArray(subs.items) ? subs.items : [];
      pushNameList(slides, "subscribe", textField("subscribe", "title", "신규 구독"), subItems, {
        total: Number(info.subscribeCount) || subItems.length,
      });
    }

    if (want("subscribe_renew")) {
      const renew = findSection(sections, "subscribe_renew");
      const renewItems = renew && Array.isArray(renew.items) ? renew.items : [];
      pushNameList(
        slides,
        "subscribe_renew",
        textField("subscribe_renew", "title", "연속 구독"),
        renewItems,
        {
          total: Number(info.subscribeRenewCount) || renewItems.length,
          format: (i) => (i.value ? `${i.name} (${i.value})` : i.name),
        }
      );
    }

    if (want("subscribe_gift")) {
      const gifts = findSection(sections, "subscribe_gift");
      const giftItems = gifts && Array.isArray(gifts.items) ? gifts.items : [];
      pushNameList(
        slides,
        "subscribe_gift",
        textField("subscribe_gift", "title", "구독 선물"),
        giftItems,
        {
          total: Number(info.subscribeGiftCount) || giftItems.length,
          format: (i) => {
            // 받은 이 제외 — "선물왕 · 구독 1개월"
            let name = String(i.name || "").trim();
            name = name.replace(/\s*(→|->)\s*.+$/, "").trim() || name;
            const val = String(i.value || "").trim();
            if (!val) return name;
            return `${name} · ${val}`;
          },
        }
      );
    }

    if (want("flags") && isEnabled("flags")) {
      const flags = info.flagCounts || {};
      const items = [];
      if (flags.fan) items.push({ label: "팬", value: `${formatNumber(flags.fan)}` });
      if (flags.topFan) items.push({ label: "열혈", value: `${formatNumber(flags.topFan)}` });
      if (flags.follower) items.push({ label: "팔로워", value: `${formatNumber(flags.follower)}` });
      if (flags.manager) items.push({ label: "매니저", value: `${formatNumber(flags.manager)}` });
      if (items.length || onlyId === "flags") {
        const demoItems =
          items.length > 0
            ? items
            : [
                { label: "팬", value: "38" },
                { label: "열혈", value: "6" },
                { label: "팔로워", value: "52" },
                { label: "매니저", value: "2" },
              ];
        slides.push({
          id: "flags",
          kind: "flags",
          title: textField("flags", "title", "팬·열혈·매니저"),
          items: onlyId === "flags" && !items.length ? demoItems : items,
          duration: durationFor("flags", slideMs),
        });
      }
    }

    if (want("nextDay") && isEnabled("nextDay")) {
      const next = data.nextDaySchedule && typeof data.nextDaySchedule === "object" ? data.nextDaySchedule : {};
      const rawParts = Array.isArray(next.parts) ? next.parts : null;
      const parts = rawParts
        ? rawParts
            .map((p) => {
              if (!p || typeof p !== "object") return null;
              const items = Array.isArray(p.items) ? p.items.filter((i) => i && i.text) : [];
              const bangon = String(p.bangonLabel || p.timeLabel || "").trim();
              const partBits = [p.partLabel, bangon].map((v) => String(v || "").trim()).filter(Boolean);
              return {
                partLabel: String(p.partLabel || "").trim(),
                bangonLabel: bangon,
                headerLabel: partBits.join(" · "),
                items,
              };
            })
            .filter((p) => p && (p.items.length || p.headerLabel))
        : null;
      const items = Array.isArray(next.items) ? next.items.filter((i) => i && i.text) : [];
      const bangon = String(next.bangonLabel || next.timeLabel || "").trim();
      // 날짜만 헤더 — 부 라벨은 parts 섹션에
      const dateLabel = String(next.dateLabel || "").trim();
      const legacyDateBits = [next.dateLabel, next.partLabel, bangon]
        .map((v) => String(v || "").trim())
        .filter(Boolean);
      const totalItems = parts
        ? parts.reduce((n, p) => n + p.items.length, 0)
        : items.length;
      const hasContent =
        totalItems > 0 ||
        onlyId === "nextDay" ||
        (parts && parts.length) ||
        dateLabel ||
        legacyDateBits.length;
      if (hasContent) {
        slides.push({
          id: "nextDay",
          kind: "nextDay",
          title: textField("nextDay", "title", "다음 방송"),
          dateLabel: parts ? dateLabel : legacyDateBits.join(" · "),
          parts: parts && parts.length ? parts : null,
          items,
          empty: totalItems === 0,
          emptyHint: textField("nextDay", "emptyHint", "등록된 일정이 없어요"),
          duration: durationFor("nextDay", listSlideMs),
        });
      }
    }

    if (want("outro") && isEnabled("outro")) {
      const footer = data.footer || {};
      slides.push({
        id: "outro",
        kind: "outro",
        eyebrow: textField("outro", "eyebrow", "엔딩"),
        value: textField("outro", "value", footer.line || "오늘 방송 종료"),
        sub: textField("outro", "sub", footer.sub || "다음 방송에서 또 만나요"),
        duration: durationFor("outro", slideMs),
      });
    }

    /* 홀로그램 시안과 동일: 전 페이지에 날짜·문서번호 헤더 메타 */
    const stampLabel = stampDateLabel({ info }) || String(info.dateLabel || "").trim();
    const stampCode = (() => {
      const m = stampLabel.match(/(\d+)\s*월\s*(\d+)\s*일/);
      if (!m) return String(info.dateCode || "").trim();
      const y = new Date().getFullYear();
      return `${y}.${String(m[1]).padStart(2, "0")}.${String(m[2]).padStart(2, "0")}`;
    })();
    const stampDoc =
      Boolean(data?.demo) || onlyId
        ? String(info.docId || "TEST-0801").trim() || "TEST-0801"
        : String(info.docId || "").trim();
    for (const s of slides) {
      if (!s || typeof s !== "object") continue;
      if (!s.dateLabel) s.dateLabel = stampLabel;
      if (!s.dateCode) s.dateCode = stampCode;
      if (!s.docId) s.docId = stampDoc;
    }

    return orderSlides(slides);
  }

  function slidePageClass(id) {
    const safe = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
    return safe ? ` credits-slide--page-${safe}` : "";
  }

  function renderSlideHtml(slide) {
    if (isHoloTheme() && HOLO?.renderSlideHtml) {
      return HOLO.renderSlideHtml(activeTheme, slide);
    }
    if (slide.kind === "coverOpen") {
      return `
        <div class="credits-slide credits-slide--cover-hold${slidePageClass(
          slide.id
        )}" data-id="${escapeHtml(
          slide.id || ""
        )}" data-duration="${slide.duration}" aria-hidden="true"></div>`;
    }
    if (slide.kind === "summary") {
      const thumb = String(slide.peakThumbUrl || "").trim();
      const peakBadge =
        slide.peakViewers || slide.peakAtLabel
          ? `<span class="credits-summary__badge">
              ${slide.peakAtLabel ? `<em>${escapeHtml(slide.peakAtLabel)}</em>` : ""}
              ${
                slide.peakViewers
                  ? `<strong>최고 ${escapeHtml(formatNumber(slide.peakViewers))}명</strong>`
                  : ""
              }
            </span>`
          : "";
      const shotInner = thumb
        ? `<div class="credits-summary__media">
            <img class="credits-summary__img" src="${escapeHtml(thumb)}" alt="" loading="eager" referrerpolicy="no-referrer" onerror="this.classList.add('is-broken');this.nextElementSibling?.classList.add('is-visible');" />
            <div class="credits-summary__placeholder" aria-hidden="true"><span>방송 캡처 · 16:9</span></div>
          </div>`
        : `<div class="credits-summary__media">
            <div class="credits-summary__placeholder is-visible" aria-hidden="true"><span>방송 캡처 · 16:9</span></div>
          </div>`;
      const captionTitle = slide.peakTitle
        ? `<span class="credits-summary__shot-title">${escapeHtml(slide.peakTitle)}</span>`
        : "";
      const metricRows = [
        ["최고 시청", slide.peakViewers ? `${formatNumber(slide.peakViewers)}명` : ""],
        ["채팅", slide.chatCount ? `${formatNumber(slide.chatCount)}회` : ""],
        ["참여자", slide.chatters ? `${formatNumber(slide.chatters)}명` : ""],
      ].filter(([, v]) => v);
      const metrics = metricRows
        .map(
          ([label, value], i) => `
          <li class="credits-summary__metric" style="--i:${i}">
            <span class="credits-summary__metric-label">${escapeHtml(label)}</span>
            <strong class="credits-summary__metric-value">${escapeHtml(value)}</strong>
          </li>`
        )
        .join("");
      const durationBlock = slide.durationLabel
        ? `<div class="credits-summary__duration">
            <span class="credits-summary__duration-label">방송 시간</span>
            <p class="credits-summary__duration-value">${escapeHtml(slide.durationLabel)}</p>
          </div>`
        : "";
      return `
        <div class="credits-slide credits-slide--summary${slidePageClass(
          slide.id
        )}" data-id="${escapeHtml(
          slide.id || ""
        )}" data-duration="${slide.duration}">
          <h2 class="credits-slide-title">${escapeHtml(slide.title || "오늘의 방송 요약")}</h2>
          <div class="credits-summary">
            <figure class="credits-summary__shot" data-snap-rule-bottom>
              <span class="credits-summary__tape" aria-hidden="true"></span>
              <span class="credits-summary__tape credits-summary__tape--right" aria-hidden="true"></span>
              <div class="credits-summary__frame">
                ${shotInner}
                ${peakBadge}
              </div>
              <figcaption class="credits-summary__caption">
                <span class="credits-summary__caption-main">${escapeHtml(
                  slide.peakLabel || "최고 시청 순간"
                )}</span>
                ${captionTitle}
              </figcaption>
            </figure>
            <div class="credits-summary__aside">
              ${durationBlock}
              ${metrics ? `<ul class="credits-summary__metrics">${metrics}</ul>` : ""}
            </div>
          </div>
        </div>`;
    }
    if (slide.kind === "signatureBoard") {
      const items = Array.isArray(slide.items) ? slide.items : [];
      const byRank = [...items].sort((a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99));
      const first = byRank.find((i) => Number(i.rank) === 1) || byRank[0] || null;
      const rest = byRank.filter((i) => i !== first).slice(0, 2);

      const cardHtml = (item, i, mod) => {
        if (!item) return "";
        const more = Number(item.morePeople) || 0;
        const donor = String(item.topDonor || "").trim();
        const donorHits = Number(item.topDonorHits) || 0;
        const rank = Number(item.rank) || i + 1;
        const img = String(item.imageUrl || "").trim();
        const valueRaw = String(item.value || "").trim();
        const valueMatch = valueRaw.match(/^([\d,.\s]+)\s*(.*)$/);
        const hitsHtml = valueRaw
          ? valueMatch && String(valueMatch[1] || "").trim()
            ? `<span class="credits-sig-podium__hits"><b class="credits-sig-podium__hits-num">${escapeHtml(
                String(valueMatch[1]).replace(/\s+/g, "")
              )}</b><i class="credits-sig-podium__hits-unit">${escapeHtml(
                String(valueMatch[2] || "번").trim() || "번"
              )}</i></span>`
            : `<span class="credits-sig-podium__hits">${escapeHtml(valueRaw)}</span>`
          : "";
        const donorHtml = donor
          ? `<div class="credits-sig-podium__donor-block">
              <p class="credits-sig-podium__donor">
                <span class="credits-sig-podium__donor-name">${escapeNickHtml(donor)}</span>
                ${
                  donorHits > 0
                    ? `<span class="credits-sig-podium__donor-hits">${escapeHtml(
                        formatNumber(donorHits)
                      )}번</span>`
                    : ""
                }
              </p>
              ${
                more > 0
                  ? `<p class="credits-sig-podium__more">그 외 ${escapeHtml(
                      formatNumber(more)
                    )}명</p>`
                  : ""
              }
            </div>`
          : `<div class="credits-sig-podium__donor-block"><p class="credits-sig-podium__donor credits-sig-podium__donor--empty">—</p></div>`;
        return `<article class="credits-sig-podium__card credits-sig-podium__card--${escapeHtml(
          mod
        )}" style="--i:${i}">
          <span class="credits-sig-podium__place">${escapeHtml(String(rank))}위</span>
          ${
            img
              ? `<span class="credits-sig-podium__balloon-wrap"><img class="credits-sig-podium__balloon" src="${escapeHtml(
                  img
                )}" alt="" loading="lazy" decoding="async" /></span>`
              : `<span class="credits-sig-podium__balloon-wrap credits-sig-podium__balloon-wrap--empty" aria-hidden="true"></span>`
          }
          <div class="credits-sig-podium__meta">
            <strong class="credits-sig-podium__amount">${escapeHtml(item.name || "")}</strong>
            ${hitsHtml}
          </div>
          ${donorHtml}
        </article>`;
      };

      return `
        <div class="credits-slide credits-slide--signature-board${slidePageClass(
          slide.id
        )}" data-id="${escapeHtml(slide.id || "")}" data-duration="${slide.duration}">
          <h2 class="credits-slide-title">${escapeHtml(slide.title || "시그니처 순위")}</h2>
          <div class="credits-sig-podium">
            ${first ? cardHtml(first, 0, "first") : ""}
            <div class="credits-sig-podium__sides">
              ${rest[0] ? cardHtml(rest[0], 1, "second") : `<div class="credits-sig-podium__card credits-sig-podium__card--second is-empty" aria-hidden="true"></div>`}
              ${rest[1] ? cardHtml(rest[1], 2, "third") : `<div class="credits-sig-podium__card credits-sig-podium__card--third is-empty" aria-hidden="true"></div>`}
            </div>
          </div>
        </div>`;
    }
    if (slide.kind === "rankBoard") {
      const champ = slide.champ || {};
      const restItems = Array.isArray(slide.rest) ? slide.rest : [];
      const rest = restItems
        .map(
          (item, i) => `
          <li class="credits-rank-board__row" style="--i:${i}">
            <span class="credits-rank-board__place">${escapeHtml(String(item.rank))}위</span>
            <span class="credits-rank-board__main">
              <span class="credits-rank-board__name">${escapeNickHtml(item.name)}</span>
              ${item.value ? metricHtml(item.value, "credits-rank-board__value") : ""}
            </span>
          </li>`
        )
        .join("");
      const topEmo = Array.isArray(slide.topEmoticons) ? slide.topEmoticons : [];
      const topEmoHtml = topEmo.length
        ? `<div class="credits-emo-top">
            <p class="credits-emo-top__label">${escapeHtml(
              slide.topLabel || "많이 쓴 이모티콘"
            )}</p>
            <ol class="credits-emo-top__list">
              ${topEmo
                .map((item, i) => {
                  const img = String(item.imageUrl || "").trim();
                  const imgHtml = img
                    ? `<img class="credits-emo-top__img" src="${escapeHtml(
                        img
                      )}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
                    : `<span class="credits-emo-top__img credits-emo-top__img--fallback" aria-hidden="true">★</span>`;
                  return `<li class="credits-emo-top__item" style="--i:${i}">
                    <span class="credits-emo-top__rank">${escapeHtml(String(item.rank || i + 1))}</span>
                    ${imgHtml}
                    ${
                      item.value
                        ? `<span class="credits-emo-top__value">${escapeHtml(item.value)}</span>`
                        : ""
                    }
                  </li>`;
                })
                .join("")}
            </ol>
          </div>`
        : "";
      const champBlock = `
          <div class="credits-champ">
            <div class="credits-champ__headline">
              <span class="credits-champ__place" aria-label="1위">
                <svg class="credits-champ__crown" viewBox="0 0 40 28" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path fill="none" stroke="#d4a017" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
                    d="M3 20 L7 7 L15 15 L20 4 L25 15 L33 7 L37 20 Z"/>
                  <path fill="none" stroke="#d4a017" stroke-width="2.2" stroke-linecap="round" d="M5 20 H35"/>
                  <circle cx="20" cy="12" r="1.5" fill="#e8b22a"/>
                </svg>
                <span class="credits-champ__label-text">1위</span>
              </span>
              <div class="credits-champ__main">
                <span class="credits-champ__highlight" aria-hidden="true"></span>
                <p class="credits-champ__name">${escapeNickHtml(champ.name || "—")}</p>
                ${champ.value ? metricHtml(champ.value, "credits-champ__sub") : ""}
              </div>
            </div>
          </div>`;
      return `
        <div class="credits-slide credits-slide--rank-board${
          topEmo.length ? " credits-slide--rank-board-emo" : ""
        }${slidePageClass(slide.id)}" data-id="${escapeHtml(
          slide.id || ""
        )}" data-duration="${slide.duration}">
          <h2 class="credits-slide-title">${escapeHtml(slide.title || "순위")}</h2>
          <div data-snap-rule-bottom>${champBlock}</div>
          ${rest ? `<ol class="credits-rank-board">${rest}</ol>` : ""}
          ${
            Number(slide.more) > 0
              ? `<p class="credits-more" style="--more-after:${restItems.length}">외 ${escapeHtml(
                  formatNumber(slide.more)
                )}명</p>`
              : ""
          }
          ${topEmoHtml}
        </div>`;
    }
    if (slide.kind === "list") {
      if (!slide.names || !slide.names.length) return "";
      const cols = Number(slide.columns) > 1 ? 2 : 1;
      const listClass =
        cols > 1 ? "credits-name-list credits-name-list--cols-2" : "credits-name-list";
      const names = `<ul class="${listClass}">${slide.names
        .map((n, i) => `<li style="--i:${i}">${escapeNickHtml(n)}</li>`)
        .join("")}</ul>`;
      const more =
        Number(slide.more) > 0
          ? `<p class="credits-more" style="--more-after:${slide.names.length}">외 ${escapeHtml(
              formatNumber(slide.more)
            )}명</p>`
          : "";
      const count = String(slide.countLabel || "").trim();
      const countHtml = count
        ? `<span class="credits-list-count">${escapeHtml(count)}</span>`
        : "";
      return `
        <div class="credits-slide credits-slide--list${slidePageClass(
          slide.id
        )}" data-id="${escapeHtml(slide.id || "")}" data-duration="${slide.duration}">
          <header class="credits-list-head">
            <h2 class="credits-slide-title">${escapeHtml(slide.title)}</h2>
            ${countHtml}
          </header>
          ${names}
          ${more}
        </div>`;
    }
    if (slide.kind === "timeline") {
      const tl = slide.timeline || {};
      const seg = Array.isArray(tl.liveSegments) ? tl.liveSegments[0] : null;
      const liveLeft = seg ? Number(seg.startPct) || 0 : 0;
      const liveWidth = seg ? Math.max(1.2, (Number(seg.endPct) || 0) - liveLeft) : 0;
      /** 바(형광펜) 진행 0~1 — 방제 핀·목록 등장 타이밍 */
      const barT = (pct) => {
        const p = Number(pct) || 0;
        if (liveWidth <= 0.01) return Math.max(0, Math.min(1, p / 100));
        return Math.max(0, Math.min(1, (p - liveLeft) / liveWidth));
      };
      // 여정 루트: 방송 구간만 형광펜으로 표시하고, 그 위에 핀(시작·방제·지금)을 찍는다
      const liveHtml = seg
        ? `<div class="credits-daybar__tape" style="left:${liveLeft}%;width:${liveWidth}%" aria-hidden="true"></div>`
        : "";
      const eventMarkers = viewerTimelineMarkers(tl.markers);
      const titleChangeCount = eventMarkers.filter(
        (m) => m.kind !== "start" && m.kind !== "end"
      ).length;
      const picked = pickTimelineListItems(eventMarkers, 10);
      const density =
        picked.items.length >= 9 ? "is-tight" : picked.items.length >= 7 ? "is-dense" : "";
      const markersHtml = eventMarkers
        .map((m, i) => {
          const kind = escapeHtml(m.kind || "title");
          const tip = escapeHtml([m.label, m.title].filter(Boolean).join(" · "));
          const pct = Number(m.pct) || 0;
          const t = barT(pct);
          const clock = clockFromMarkerLabel(m.label);
          let labelHtml = "";
          if (m.kind === "start") {
            labelHtml = `<i>시작${clock ? ` ${escapeHtml(clock)}` : ""}</i>`;
          } else if (m.kind === "end") {
            labelHtml = `<i>종료${clock ? ` ${escapeHtml(clock)}` : ""}</i>`;
          }
          return `<span class="credits-daybar__pin credits-daybar__pin--${kind}" style="left:${pct}%;--i:${i};--bar-t:${t}" title="${tip}">${labelHtml}</span>`;
        })
        .join("");
      const nowPct = Number(tl.nowPct) || 0;
      const nowBarT = barT(nowPct);
      const nowLabel = (() => {
        const n = (tl.markers || []).find((m) => m && m.kind === "now");
        return n?.label ? String(n.label).replace(/^지금\s*/, "") : "";
      })();
      const lines = picked.items
        .map((m, i) => {
          const clock = clockFromMarkerLabel(m.label);
          const body =
            m.kind === "start"
              ? m.title || "방송 시작"
              : m.kind === "end"
                ? "방송 종료"
                : m.title || "방제 변경";
          const t = barT(m.pct);
          return `<li class="credits-timeline-list__item credits-timeline-list__item--${escapeHtml(
            m.kind || "title"
          )}" style="--i:${i};--bar-t:${t}">
            <span class="credits-timeline-list__clock">${escapeHtml(clock)}</span>
            <span class="credits-timeline-list__body">${escapeHtml(body)}</span>
          </li>`;
        })
        .join("");
      const ticks = Array.isArray(tl.ticks) && tl.ticks.length
        ? tl.ticks
        : [
            { pct: 0, label: "" },
            { pct: 100, label: "" },
          ];
      // 서버가 균등 눈금을 주므로, 겹칠 때만 최소 간격으로 솎아낸다 (양 끝 유지)
      const MIN_TICK_GAP = 7;
      const labeledTicks = ticks
        .map((t) => ({
          pct: Math.max(0, Math.min(100, Number(t.pct) || 0)),
          label: String(t.label || ""),
        }))
        .filter((t) => t.label);
      const lastTick = labeledTicks[labeledTicks.length - 1];
      const spacedTicks = labeledTicks.reduce((kept, t, i, arr) => {
        if (i === 0 || i === arr.length - 1) {
          kept.push(t);
          return kept;
        }
        const prev = kept[kept.length - 1];
        const farFromPrev = !prev || t.pct - prev.pct >= MIN_TICK_GAP;
        const farFromLast = !lastTick || lastTick.pct - t.pct >= MIN_TICK_GAP;
        if (farFromPrev && farFromLast) kept.push(t);
        return kept;
      }, []);
      const hoursHtml = spacedTicks
        .map(
          (t) =>
            `<span class="credits-daybar__hour" style="left:${t.pct}%"><b aria-hidden="true"></b><em>${escapeHtml(
              t.label
            )}</em></span>`
        )
        .join("");
      const rangeNote = tl.rangeNote || "";
      const metaBits = [];
      if (titleChangeCount > 0) metaBits.push(`방제 ${formatNumber(titleChangeCount)}회`);
      if (rangeNote) metaBits.push(rangeNote);
      const metaHtml = metaBits.length
        ? `<p class="credits-timeline-meta">${metaBits
            .map((b) => `<span>${escapeHtml(b)}</span>`)
            .join("")}</p>`
        : "";
      const moreHtml =
        picked.hidden > 0
          ? `<p class="credits-timeline-more">외 ${escapeHtml(
              formatNumber(picked.hidden)
            )}건 생략 · 막대에 전부 표시</p>`
          : "";
      // 점선 여정 경로 — 공책 줄과 평행한 직선
      const pathSvg = `<svg class="credits-daybar__path" viewBox="0 0 200 12" preserveAspectRatio="none" aria-hidden="true">
            <path d="M2 6 H198" />
          </svg>`;
      return `
        <div class="credits-slide credits-slide--timeline${slidePageClass(
          slide.id
        )}" data-id="${escapeHtml(
          slide.id || ""
        )}" data-duration="${slide.duration}" data-events="${picked.total}">
          <h2 class="credits-slide-title">${escapeHtml(slide.title)}</h2>
          <div class="credits-timeline-headband" data-snap-rule-bottom>
            ${metaHtml}
            <div class="credits-daybar">
              <div class="credits-daybar__rail">
                <div class="credits-daybar__track">
                  ${pathSvg}
                  ${liveHtml}
                  ${markersHtml}
                  <div class="credits-daybar__hours" aria-hidden="true">
                    ${hoursHtml}
                  </div>
                  <div class="credits-daybar__now" style="left:${nowPct}%;--bar-t:${nowBarT}">
                    <span class="credits-daybar__now-flag">지금${
                      nowLabel ? ` ${escapeHtml(nowLabel)}` : ""
                    }</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          ${
            lines
              ? `<ol class="credits-timeline-list ${density}">${lines}</ol>${moreHtml}`
              : `<p class="credits-pending-note">기록이 아직 없어요</p>`
          }
        </div>`;
    }

    if (slide.kind === "outro") {
      return `
        <div class="credits-slide credits-slide--focus credits-slide--outro${slidePageClass(
          slide.id
        )}" data-id="${escapeHtml(slide.id || "")}" data-duration="${slide.duration}">
          ${
            slide.eyebrow
              ? `<p class="credits-slide-eyebrow">${escapeHtml(slide.eyebrow)}</p>`
              : ""
          }
          <p class="credits-slide-value">${escapeHtml(slide.value)}</p>
          ${slide.sub ? `<p class="credits-slide-sub">${escapeHtml(slide.sub)}</p>` : ""}
          <span class="credits-outro-seal" aria-hidden="true">끝</span>
        </div>`;
    }
    if (slide.kind === "coverClose") {
      const closedMs = Number(slide.closedMs);
      const fadeMs = Number(slide.fadeMs);
      const closedAttr = Number.isFinite(closedMs) ? Math.max(0, closedMs) : 2200;
      const fadeAttr = Number.isFinite(fadeMs) ? Math.max(0, fadeMs) : 1200;
      return `
        <div class="credits-slide credits-slide--cover-hold${slidePageClass(
          slide.id
        )}" data-id="${escapeHtml(
          slide.id || ""
        )}" data-duration="${slide.duration}" data-closed="${closedAttr}" data-fade="${fadeAttr}" aria-hidden="true"></div>`;
    }
    if (slide.kind === "nextDay") {
      const renderItems = (items, startIndex) =>
        items
          .map((item, j) => {
            const i = startIndex + j;
            const start = String(item.startLabel || "").trim();
            return `<li class="credits-next-day__item" style="--i:${i}">
                <span class="credits-next-day__mark" aria-hidden="true"></span>
                <span class="credits-next-day__text">${escapeHtml(item.text || "")}</span>
                ${start ? `<span class="credits-next-day__meta">${escapeHtml(start)}</span>` : ""}
              </li>`;
          })
          .join("");
      const parts = Array.isArray(slide.parts) ? slide.parts : null;
      let listHtml;
      if (parts && parts.length) {
        let idx = 0;
        listHtml = parts
          .map((part) => {
            const items = Array.isArray(part.items) ? part.items : [];
            const header = String(part.headerLabel || "").trim();
            const section = `<section class="credits-next-day__part">
              ${
                header
                  ? `<h3 class="credits-next-day__part-title">${escapeHtml(header)}</h3>`
                  : ""
              }
              ${
                items.length
                  ? `<ul class="credits-next-day">${renderItems(items, idx)}</ul>`
                  : ""
              }
            </section>`;
            idx += items.length;
            return section;
          })
          .join("");
      } else {
        const items = Array.isArray(slide.items) ? slide.items : [];
        listHtml = items.length
          ? `<ul class="credits-next-day">${renderItems(items, 0)}</ul>`
          : `<p class="credits-pending-note">${escapeHtml(slide.emptyHint || "등록된 일정이 없어요")}</p>`;
      }
      if (parts && parts.length && !parts.some((p) => (p.items || []).length)) {
        listHtml += `<p class="credits-pending-note">${escapeHtml(slide.emptyHint || "등록된 일정이 없어요")}</p>`;
      }
      return `
        <div class="credits-slide credits-slide--next-day${slidePageClass(
          slide.id
        )}" data-id="${escapeHtml(
          slide.id || ""
        )}" data-duration="${slide.duration}">
          ${
            slide.dateLabel
              ? `<p class="credits-slide-eyebrow credits-next-day__date">${escapeHtml(slide.dateLabel)}</p>`
              : ""
          }
          <h2 class="credits-slide-title">${escapeHtml(slide.title || "다음 방송")}</h2>
          ${listHtml}
        </div>`;
    }
    if (slide.kind === "flags") {
      const items = Array.isArray(slide.items) ? slide.items : [];
      const roleClass = (label) => {
        const t = String(label || "");
        if (t.includes("열혈")) return "topfan";
        if (t.includes("팔로")) return "follower";
        if (t.includes("매니")) return "manager";
        if (t.includes("팬")) return "fan";
        return "etc";
      };
      const grid = items
        .map((item, i) => {
          const label = String(item.label || "");
          const role = roleClass(label);
          const seal = label.slice(0, 1) || "·";
          return `
          <li class="credits-flag-card credits-flag-card--${escapeHtml(role)}" style="--i:${i}">
            <span class="credits-flag-card__seal" aria-hidden="true">${escapeHtml(seal)}</span>
            <span class="credits-flag-card__label">${escapeHtml(label)}</span>
            <strong class="credits-flag-card__value">${escapeHtml(item.value || "—")}<span class="credits-flag-card__unit">명</span></strong>
          </li>`;
        })
        .join("");
      return `
        <div class="credits-slide credits-slide--flags${slidePageClass(
          slide.id
        )}" data-id="${escapeHtml(
          slide.id || ""
        )}" data-duration="${slide.duration}">
          <h2 class="credits-slide-title">${escapeHtml(slide.title || "팬·열혈·매니저")}</h2>
          <ul class="credits-flag-grid">${grid}</ul>
        </div>`;
    }
    if (slide.kind === "firstChatEmo") {
      const img = String(slide.imageUrl || "").trim();
      const imgHtml = img
        ? `<img class="credits-first-emo__img" src="${escapeHtml(
            img
          )}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
        : "";
      return `
        <div class="credits-slide credits-slide--focus credits-slide--first-emo${slidePageClass(
          slide.id
        )}" data-id="${escapeHtml(
          slide.id || ""
        )}" data-duration="${slide.duration}">
          <h2 class="credits-slide-title">${escapeHtml(slide.title || "첫 채팅")}</h2>
          <p class="credits-slide-value">${escapeNickHtml(slide.value)}</p>
          <div class="credits-first-emo">
            ${imgHtml}
            ${slide.sub ? `<p class="credits-slide-sub">${escapeHtml(slide.sub)}</p>` : ""}
          </div>
          ${
            slide.atLabel
              ? `<p class="credits-first-emo__at">${escapeHtml(slide.atLabel)}</p>`
              : ""
          }
        </div>`;
    }
    const firstChatMod =
      slide.id === "firstChat" ? " credits-slide--first-chat" : "";
    return `
      <div class="credits-slide credits-slide--focus${firstChatMod}${slidePageClass(
        slide.id
      )}" data-id="${escapeHtml(slide.id || "")}" data-duration="${slide.duration}">
        <h2 class="credits-slide-title">${escapeHtml(slide.title)}</h2>
        <p class="credits-slide-value">${escapeNickHtml(slide.value)}</p>
        ${
          slide.sub
            ? `<p class="credits-slide-sub credits-first-chat__quote">“${escapeHtml(
                String(slide.sub).replace(/^[“"]|[”"]$/g, "")
              )}”</p>`
            : ""
        }
      </div>`;
  }

  function restartActiveAnimations(node) {
    if (!node) return;
    node.classList.remove("is-active");
    // force reflow so CSS animations replay
    void node.offsetWidth;
    node.classList.add("is-active");
  }

  function clearAllTimers() {
    if (slideTimer) clearTimeout(slideTimer);
    slideTimer = null;
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    clearTimeout(entranceTimer);
    entranceTimer = null;
  }

  function notebookEl() {
    return document.querySelector(".notebook");
  }

  // 손글씨 폰트(Gaegu 등)는 이모지 글리프가 없어 시스템 이모지 폰트로
  // 대체되는데, 두 폰트의 기준선(baseline) 높이가 달라 이모지가 글자보다
  // 아래로 처져 보인다. 이모지만 감싸 vertical-align으로 보정한다.
  const EMOJI_RE =
    /\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F)?(?:\u200D\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F)?)*/gu;

  function wrapEmoji(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        EMOJI_RE.lastIndex = 0;
        return EMOJI_RE.test(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    const targets = [];
    let node;
    while ((node = walker.nextNode())) targets.push(node);
    targets.forEach((textNode) => {
      const text = textNode.nodeValue;
      EMOJI_RE.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      while ((m = EMOJI_RE.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const span = document.createElement("span");
        span.className = "credits-emoji";
        span.textContent = m[0];
        frag.appendChild(span);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode?.replaceChild(frag, textNode);
    });
  }

  // 사진·이미지처럼 --rule의 배수가 아닌 높이를 갖는 요소 아래에
  // 여백을 더해, 다음 텍스트가 항상 줄 위에서 시작하도록 보정한다.
  // 수첩은 살짝 회전(rotate)되어 있어 getBoundingClientRect는 폭이 넓은
  // 요소일수록 회전 때문에 실제보다 부풀려진 높이를 반환한다.
  // transform(회전·스케일) 영향을 받지 않는 offsetTop 누적 방식으로 측정한다.
  function offsetTopRelativeTo(el, ancestor) {
    let top = 0;
    let node = el;
    while (node && node !== ancestor) {
      top += node.offsetTop || 0;
      node = node.offsetParent;
    }
    return top;
  }
  function snapRuleBottoms() {
    const page = document.querySelector(".notebook__page");
    if (!page) return;
    const rule = parseFloat(getComputedStyle(page).getPropertyValue("--rule")) || 56.67;
    document.querySelectorAll("[data-snap-rule-bottom]").forEach((el) => {
      el.style.marginBottom = "0px";
      const bottom = offsetTopRelativeTo(el, page) + el.offsetHeight;
      const remainder = ((bottom % rule) + rule) % rule;
      const pad = remainder < 0.75 || rule - remainder < 0.75 ? 0 : rule - remainder;
      el.style.marginBottom = pad > 0 ? `${pad.toFixed(2)}px` : "";
    });
  }

  // 항목이 적을 때: 남는 세로 공간을 행 높이로 나눠 받아 아래가 휑하지 않게 한다.
  // (일부만 키우면 중간에 빈 줄이 생겨 보이므로, 전 항목을 같은 span으로)
  function applyRoomyRows(list, itemSelector, opts = {}) {
    const page = document.querySelector(".notebook__page");
    if (!page || !list) return 1;
    const items = Array.from(list.querySelectorAll(itemSelector));
    if (!items.length) return 1;
    const rule = parseFloat(getComputedStyle(page).getPropertyValue("--rule")) || 56.67;
    const listTop = offsetTopRelativeTo(list, page);
    const reserveBelow = Number(opts.reserveBelow) || 0;
    const maxSpan = Number(opts.maxSpan) || 2;
    const availablePx = Math.max(0, page.offsetHeight - listTop - reserveBelow);
    const availableLines = Math.max(items.length, Math.floor(availablePx / rule));
    let span = 1;
    for (let s = maxSpan; s >= 2; s -= 1) {
      if (availableLines >= items.length * s) {
        span = s;
        break;
      }
    }
    items.forEach((el) => {
      el.style.gridRow = `span ${span}`;
      el.classList.toggle("is-roomy", span >= 2);
      if (opts.setHeight) {
        el.style.height = span > 1 ? `${span * rule}px` : "";
        el.style.maxHeight = span > 1 ? `${span * rule}px` : "";
        el.style.minHeight = span > 1 ? `${span * rule}px` : "";
      }
    });
    list.classList.toggle("is-sparse", span >= 2 || items.length <= (opts.sparseCount || 4));
    return span;
  }

  // 타임라인 목록: 항목 사이에만 빈 줄을 넣으면 막대↔첫 줄은 붙어 치우쳐 보인다.
  // 순위와 같이 행 span은 쓰지 않고, 적을 때는 위쪽 padding으로만 여백을 잡는다.
  function layoutTimelineList() {
    document.querySelectorAll(".credits-slide--timeline").forEach((slide) => {
      const list = slide.querySelector(".credits-timeline-list");
      if (!list) return;
      const items = list.querySelectorAll(".credits-timeline-list__item");
      items.forEach((el) => {
        el.style.gridRow = "";
        el.style.height = "";
        el.style.maxHeight = "";
        el.style.minHeight = "";
        el.classList.remove("is-roomy");
      });
      const sparse = items.length > 0 && items.length <= 5;
      list.classList.toggle("is-sparse", sparse);
      slide.classList.toggle("is-sparse", sparse);
    });
  }

  // 순위 보드(2위~): 행마다 빈 줄을 넣지 않는다.
  // (1위 블록 직후엔 간격이 없고 2·3위 사이에만 빈 줄이 생기면 어색함)
  // 적을 때는 위쪽 padding(centerSparseSlides)만으로 팬클럽처럼 여백을 잡는다.
  function layoutRankBoardSparse() {
    document.querySelectorAll(".credits-slide--rank-board").forEach((slide) => {
      const board = slide.querySelector(".credits-rank-board");
      const rows = board
        ? Array.from(board.querySelectorAll(".credits-rank-board__row"))
        : [];
      rows.forEach((el) => {
        el.style.gridRow = "";
        el.classList.remove("is-roomy");
      });
      // 1위(champ)까지 포함해 적을 때 sparse — 보드 없어도(1위만) 위 고정 방지
      const total = rows.length + (slide.querySelector(".credits-champ") ? 1 : 0);
      const sparse = total > 0 && total <= 5;
      if (board) board.classList.toggle("is-sparse", sparse);
      slide.classList.toggle("is-sparse", sparse);
    });
  }

  // 팬클럽·구독 등 명단: 적을 때 한 칸을 2줄 높이로
  function layoutNameListSparse() {
    document.querySelectorAll(".credits-slide--list").forEach((slide) => {
      const list = slide.querySelector(".credits-name-list");
      if (!list || list.classList.contains("credits-name-list--cols-2")) {
        slide.classList.remove("is-sparse");
        return;
      }
      const rule =
        parseFloat(
          getComputedStyle(document.querySelector(".notebook__page") || document.documentElement)
            .getPropertyValue("--rule")
        ) || 56.67;
      const moreNote = slide.querySelector(".credits-more");
      applyRoomyRows(list, "li", {
        reserveBelow: moreNote ? rule : 0,
        maxSpan: 2,
        sparseCount: 5,
        setHeight: true,
      });
      slide.classList.toggle("is-sparse", list.classList.contains("is-sparse"));
    });
  }

  function scheduleRuleSnap() {
    requestAnimationFrame(() => {
      // 행 높이를 먼저 잡은 뒤, 남는 공간을 위쪽 padding으로 (팬클럽과 동일 패턴)
      layoutTimelineList();
      layoutRankBoardSparse();
      layoutNameListSparse();
      centerSparseSlides();
      snapRuleBottoms();
    });
  }

  // 첫 채팅·엔딩·명단·순위·타임라인처럼 내용이 짧으면 위로만 쏠려
  // 아래가 휑해 보이므로, 남는 세로 공간의 일부를 위쪽 여백으로 준다.
  // 완전 가운데(1/2)는 어색해서 약 1/3~1/6만 올려 적당히 위쪽에 둔다.
  // (줄 위에 계속 얹혀 있도록 여백은 항상 --rule의 배수로 스냅한다.)
  function centerSparseSlides() {
    const page = document.querySelector(".notebook__page");
    if (!page) return;
    const rule = parseFloat(getComputedStyle(page).getPropertyValue("--rule")) || 56.67;
    const selector = [
      ".credits-slide--focus",
      ".credits-slide--list",
      ".credits-slide--next-day",
      ".credits-slide--flags",
      ".credits-slide--signature-board",
      ".credits-slide--rank-board",
      ".credits-slide--timeline",
    ].join(", ");
    document.querySelectorAll(selector).forEach((slide) => {
      slide.style.paddingTop = "0px";
      let contentBottom = 0;
      Array.from(slide.children).forEach((child) => {
        if (child.classList?.contains("credits-emo-top")) return;
        const pos = getComputedStyle(child).position;
        if (pos === "absolute" || pos === "fixed") return;
        const bottom = child.offsetTop + child.offsetHeight;
        if (bottom > contentBottom) contentBottom = bottom;
      });
      const extra = slide.clientHeight - contentBottom;
      const isList = slide.classList.contains("credits-slide--list");
      const isTimeline = slide.classList.contains("credits-slide--timeline");
      const isRank = slide.classList.contains("credits-slide--rank-board");
      const sparse = slide.classList.contains("is-sparse");
      // 명단·타임라인·순위: 위로 붙이되 적을 때만 살짝 내려준다
      let share = 3;
      let maxSteps = 99;
      if (isList) {
        share = sparse ? 4 : 6;
        maxSteps = sparse ? 4 : 2;
      } else if (isTimeline) {
        share = sparse ? 4 : 5;
        maxSteps = sparse ? 4 : 3;
      } else if (isRank) {
        // 순위 2~3명만 있을 때(이모티콘 등) 위 고정처럼 보이지 않게 더 내림
        share = sparse ? 3 : 5;
        maxSteps = sparse ? 6 : 3;
      }
      const steps = extra > 0 ? Math.min(maxSteps, Math.floor(extra / share / rule)) : 0;
      slide.style.paddingTop = steps > 0 ? `${steps * rule}px` : "";
      if (steps > 0) slide.classList.add("is-sparse");
    });
  }

  function prefersReducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  }

  function armNotebookOffstage() {
    if (isHoloTheme()) return;
    const nb = notebookEl();
    if (!nb) return;
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    clearTimeout(entranceTimer);
    nb.classList.remove("is-entering", "is-opening", "is-open", "is-closing");
    nb.classList.add("is-closed", "is-awaiting");
  }

  function prepareSlideshow(data) {
    if (data) creditsDataRaw = data;
    creditsData = applySignatureFilter(creditsDataRaw || data);
    applyStampDate(creditsData);
    applyCoverFace();
    resetStageFade();
    syncThemeShell();
    const slides = buildSlides(creditsData);
    if (!els.slides) {
      slideNodes = [];
      return false;
    }
    els.slides.innerHTML = slides.map(renderSlideHtml).filter(Boolean).join("");
    wrapEmoji(els.slides);
    scheduleRuleSnap();
    // 썸네일·시그풍 로드 후에도 줄 맞춤 재계산
    els.slides.querySelectorAll("img").forEach((img) => {
      if (img.complete) return;
      img.addEventListener("load", scheduleRuleSnap, { once: true });
      img.addEventListener("error", scheduleRuleSnap, { once: true });
    });
    slideNodes = [...els.slides.querySelectorAll(".credits-slide")];
    slideIndex = 0;
    slideNodes.forEach((node) => node.classList.remove("is-active"));
    updatePagePos();
    return slideNodes.length > 0;
  }

  function notifyControl(type, extra) {
    const extraObj = extra && typeof extra === "object" ? extra : {};
    if (isStudioEmbed) {
      try {
        window.parent.postMessage(
          { type: `credits-studio-${type}`, ...extraObj },
          location.origin
        );
      } catch (_) {
        /* ignore */
      }
    }
    try {
      controlBus?.postMessage({ type, ...extraObj });
    } catch (_) {
      /* ignore */
    }
  }

  function stopPlayback({ silent = false } = {}) {
    clearAllTimers();
    entrancePending = false;
    suppressPlayRestart = false;
    isPlaying = false;
    els.body.classList.remove("is-playing");
    slideNodes.forEach((node) => node.classList.remove("is-active"));
    fadeOutStage(prefersReducedMotion() ? 0 : 700);
    armNotebookOffstage();
    updatePagePos();
    if (!silent) notifyControl("stopped");
    // 재생 종료 후 로그인이 필요하면 다시 표시
    if (collectRuntime?.hasToken && !collectRuntime.hasToken()) {
      setCollectAuthVisible(true);
    }
  }

  function finishCycle() {
    clearAllTimers();
    entrancePending = false;
    suppressPlayRestart = false;
    isPlaying = false;
    els.body.classList.remove("is-playing");
    slideNodes.forEach((node) => node.classList.remove("is-active"));
    // coverClose에서 이미 페이드했을 수 있음
    const stage = stageEl();
    if (!stage?.classList.contains("is-fading")) {
      fadeOutStage(prefersReducedMotion() ? 0 : 900);
    }
    armNotebookOffstage();
    updatePagePos();
    notifyControl("ended");
    if (collectRuntime?.hasToken && !collectRuntime.hasToken()) {
      setCollectAuthVisible(true);
    }
  }

  function beginPlayback(data) {
    onlyId = "";
    singleLoop = false;
    loopPlayback = false;
    isPlaying = true;
    setCollectAuthVisible(false);
    hideCollectToast();
    els.body.classList.add("is-playing");
    // 로드·등장 연출이 끝날 때까지 키 넘김 무시 (Space 키 반복 등)
    entrancePending = true;
    suppressPlayRestart = false;
    resetStageFade();
    notifyControl("playing");
    // 재생 직전에 최신 크레딧을 다시 받아 반영
    const run = (payload) => playEntrance(payload || creditsDataRaw);
    if (data) {
      run(data);
      return;
    }
    loadCredits({ autoStart: false })
      .then((fresh) => run(fresh || creditsDataRaw))
      .catch(() => run(creditsDataRaw));
  }

  /** 수첩이 스르륵 등장한 뒤 첫 페이지부터 재생 */
  function playEntrance(data) {
    clearAllTimers();
    entrancePending = true;
    const ready = prepareSlideshow(data || creditsDataRaw);
    if (!ready) {
      setStatus("표시할 슬라이드가 없습니다 (모두 끄거나 데이터 없음)", true);
      isPlaying = false;
      entrancePending = false;
      return;
    }
    if (isHoloTheme()) {
      entrancePending = false;
      resetStageFade();
      showSlide(0);
      return;
    }
    const nb = notebookEl();
    if (!nb) {
      entrancePending = false;
      showSlide(0);
      return;
    }
    armNotebookOffstage();
    void nb.offsetWidth;
    nb.classList.remove("is-awaiting");
    nb.classList.add("is-entering", "is-closed");
    const enterMs = prefersReducedMotion() ? 0 : NOTEBOOK_ENTER_MS;
    entranceTimer = setTimeout(() => {
      entranceTimer = null;
      nb.classList.remove("is-entering");
      const firstId = String(slideNodes[0]?.dataset?.id || "").trim();
      if (firstId === "coverOpen") {
        closeNotebook({ immediate: true });
      }
      // 표지가 실제로 뜬 뒤에만 키 넘김 허용
      entrancePending = false;
      showSlide(0);
    }, enterMs);
  }

  function openNotebook({ immediate = false } = {}) {
    if (isHoloTheme()) return;
    const nb = notebookEl();
    if (!nb) return;
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    nb.classList.remove("is-awaiting", "is-entering", "is-closing", "is-closed");
    if (immediate || prefersReducedMotion()) {
      nb.classList.remove("is-opening");
      nb.classList.add("is-open");
      return;
    }
    nb.classList.add("is-opening");
    // force reflow so transition from closed runs
    void nb.offsetWidth;
    nb.classList.add("is-open");
    openTimer = setTimeout(() => {
      nb.classList.remove("is-opening");
    }, NOTEBOOK_OPEN_MS);
  }

  function closeNotebook({ immediate = false } = {}) {
    if (isHoloTheme()) return;
    const nb = notebookEl();
    if (!nb) return;
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    nb.classList.remove("is-awaiting", "is-entering", "is-opening", "is-open");
    if (immediate || prefersReducedMotion()) {
      nb.classList.remove("is-closing");
      nb.classList.add("is-closed");
      return;
    }
    nb.classList.add("is-closing", "is-closed");
    closeTimer = setTimeout(() => {
      nb.classList.remove("is-closing");
    }, NOTEBOOK_CLOSE_MS);
  }

  function updatePagePos() {
    if (!els.pagePos) return;
    if (!slideNodes.length) {
      els.pagePos.textContent = "";
      return;
    }
    const active = slideNodes[slideIndex];
    const activeId = String(active?.dataset?.id || "").trim();
    const inner = slideNodes.filter((n) => !COVER_IDS.has(String(n.dataset.id || "")));
    if (COVER_IDS.has(activeId) || !inner.length) {
      els.pagePos.textContent = "";
      return;
    }
    const idx = inner.indexOf(active) + 1;
    els.pagePos.textContent = `${idx} / ${inner.length}`;
  }

  function innerPageMeta() {
    const active = slideNodes[slideIndex];
    const activeId = String(active?.dataset?.id || "").trim();
    const inner = slideNodes.filter((n) => !COVER_IDS.has(String(n.dataset.id || "")));
    if (COVER_IDS.has(activeId) || !inner.length) {
      return { index: 0, total: inner.length, cover: true };
    }
    return { index: inner.indexOf(active) + 1, total: inner.length, cover: false };
  }

  function advanceAfter(ms) {
    if (slideTimer) clearTimeout(slideTimer);
    slideTimer = setTimeout(() => showSlide(slideIndex + 1), Math.max(0, ms));
  }

  function showSlide(index, { manual = false } = {}) {
    if (!slideNodes.length) return;
    if (index >= slideNodes.length) {
      if (loopPlayback) {
        index = index % slideNodes.length;
      } else {
        finishCycle();
        return;
      }
    }
    if (index < 0) {
      index = loopPlayback
        ? ((index % slideNodes.length) + slideNodes.length) % slideNodes.length
        : 0;
    }

    // 수동 넘김이 등장 연출 타이머와 레이스하지 않도록 정리
    if (manual) {
      clearTimeout(entranceTimer);
      entranceTimer = null;
      entrancePending = false;
      suppressPlayRestart = true;
      const entering = notebookEl();
      entering?.classList.remove("is-entering", "is-awaiting");
    }

    slideIndex = index;
    slideNodes.forEach((node, i) => {
      const active = i === slideIndex;
      if (active) restartActiveAnimations(node);
      else node.classList.remove("is-active");
    });
    updatePagePos();
    scheduleRuleSnap();
    const activeNode = slideNodes[slideIndex];
    const activeId = String(activeNode?.dataset?.id || "").trim();
    if (isHoloTheme()) {
      HOLO?.setActivePage?.(activeId);
      HOLO?.pulseEnter?.();
    }
    updatePreviewPageData(activeId);
    const duration = Number(activeNode?.dataset?.duration || slideMs);
    const closedHold = Number(activeNode?.dataset?.closed || 0);
    const nb = notebookEl();
    const pageMeta = innerPageMeta();

    if (isStudioEmbed && activeId) {
      try {
        window.parent.postMessage(
          {
            type: "credits-studio-slide",
            id: activeId,
            index: pageMeta.index,
            total: pageMeta.total,
            cover: pageMeta.cover,
          },
          location.origin
        );
      } catch (_) {
        /* ignore */
      }
    }

    clearTimeout(closeTimer);
    if (slideTimer) clearTimeout(slideTimer);
    slideTimer = null;

    if (activeId === "coverOpen") {
      resetStageFade();
      applyCoverFace();
      if (!isHoloTheme()) closeNotebook({ immediate: true });
      // 화살표로 직접 넘긴 경우엔 자동 넘김 타이머를 걸지 않는다
      // (안 그러면 표지에서 잠깐 멈췄다가 곧바로 다시 펼쳐져 깜빡이는 것처럼 보임)
      if (manual) return;
      if (singleLoop && slideNodes.length === 1) {
        slideTimer = setTimeout(() => showSlide(0), duration);
      } else {
        advanceAfter(duration);
      }
      return;
    }

    resetStageFade();
    if (!isHoloTheme() && nb?.classList.contains("is-closed")) {
      openNotebook();
    }

    if (manual) return;
    if (singleLoop && slideNodes.length === 1) {
      slideTimer = setTimeout(() => showSlide(0), duration);
    } else {
      advanceAfter(duration);
    }
  }

  function startSlideshow(data, { entrance = false } = {}) {
    clearAllTimers();
    if (entrance) {
      playEntrance(data);
      return;
    }
    const ready = prepareSlideshow(data);
    if (!ready) {
      setStatus("표시할 슬라이드가 없습니다 (모두 끄거나 데이터 없음)", true);
      return;
    }
    if (isHoloTheme()) {
      showSlide(0);
      return;
    }
    const nb = notebookEl();
    nb?.classList.remove("is-awaiting", "is-entering");
    const firstId = String(slideNodes[0]?.dataset?.id || "").trim();
    if (firstId === "coverOpen") {
      closeNotebook({ immediate: true });
    } else {
      openNotebook({ immediate: true });
    }
    showSlide(0);
  }

  function applyChrome(cfg) {
    const chrome = cfg?.chrome && typeof cfg.chrome === "object" ? cfg.chrome : {};
    const setText = (sel, value, fallback) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const next = String(value ?? "").trim();
      el.textContent = next || fallback;
    };
    setText(".notebook__spine-brand", chrome.spine, "SIRIAN RAIN");
    setText(".notebook__badge", chrome.badge, "SIRIAN RAIN");
    setText(".notebook__case", chrome.case, "ENDING · CREDITS");
    applyCoverFace();
  }

  function stampDateLabel(data) {
    const label = String(data?.info?.dateLabel || "").trim();
    const m = label.match(/(\d+)\s*월\s*(\d+)\s*일/);
    if (m) return `${Number(m[1])}월 ${Number(m[2])}일`;
    return label;
  }

  function applyStampDate(data) {
    const el = document.querySelector(".notebook__stamp");
    if (!el) return;
    const next = stampDateLabel(data);
    el.textContent = next || "—";
    el.setAttribute("title", String(data?.info?.dateLabel || next || "방송 시작일"));
  }

  function applyConfig(cfg) {
    if (!cfg || typeof cfg !== "object") return;
    overlayConfig = cfg;
    const sm = Number(cfg.slideMs);
    const lm = Number(cfg.listSlideMs);
    if (Number.isFinite(sm) && sm >= 1500) slideMs = sm;
    if (Number.isFinite(lm) && lm >= 1500) listSlideMs = lm;
    if (!themeFromUrl && cfg.theme != null) {
      activeTheme = normalizeThemeId(cfg.theme);
      syncThemeShell();
    }
    applyChrome(cfg);
    if (creditsData) applyStampDate(creditsData);
  }

  async function loadOverlayConfig() {
    try {
      const res = await fetch(overlayConfigUrl(), {
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      applyConfig(await res.json());
    } catch (err) {
      console.warn("overlay-config", err);
      applyConfig({ slideMs: 6500, listSlideMs: 8500, slides: {} });
    }
  }

  function setStudioDataSource({ archive = "", demo = false } = {}) {
    if (demo) {
      params.set("demo", "1");
      params.delete("archive");
    } else if (archive) {
      params.set("archive", String(archive).trim());
      params.delete("demo");
    }
    try {
      const url = new URL(location.href);
      url.search = params.toString();
      history.replaceState({}, "", `${url.pathname}?${url.searchParams.toString()}`);
    } catch (_) {
      /* ignore */
    }
  }

  async function loadCredits({ entrance = !isStudioEmbed, autoStart } = {}) {
    // 실제 OBS(?obs=1): 스튜디오 재생 버튼 전까지 화면을 비워 둔다
    const waitForPlay = !isStudioEmbed && !isPreview;
    if (autoStart === undefined) autoStart = !waitForPlay;

    setStatus(waitForPlay ? "" : "크레딧 불러오는 중…", !waitForPlay);
    try {
      await loadOverlayConfig();
      const archiveId = (params.get("archive") || "").trim();
      const demoFlag =
        params.get("demo") === "1" || params.get("demo") === "true";
      /* 아카이브가 있으면 only/스튜디오여도 데모로 덮지 않음 (페이지 유지·데이터 교체) */
      let creditsQs = "";
      if (archiveId) {
        creditsQs = `?archive=${encodeURIComponent(archiveId)}&viewer=1`;
      } else if (demoFlag || isPreview || isStudioEmbed) {
        creditsQs = "?demo=1&viewer=1";
      } else {
        creditsQs = "?viewer=1";
      }
      const res = await fetch(apiUrl(`/api/credits${creditsQs}`), {
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      creditsDataRaw = data;
      if (autoStart) {
        if (entrance && !isStudioEmbed) {
          isPlaying = true;
          hideCollectToast();
          els.body.classList.add("is-playing");
          startSlideshow(data, { entrance: true });
        } else {
          // 스튜디오 편집: 선택 페이지만 미리보기
          startSlideshow(data, { entrance: false });
        }
      } else {
        prepareSlideshow(data);
        armNotebookOffstage();
        fadeOutStage(0);
      }
      if (isStudioEmbed) {
        setStatus("", false);
      } else if (waitForPlay) {
        setStatus("", false);
      } else if (data.demo) {
        setStatus("더미 데이터 미리보기 · 실방송은 /ending/ 전용 OBS 주소 사용", true);
        setTimeout(() => setStatus("", false), 5000);
      } else if (data.pendingChatSdk) {
        setStatus("방송시간·시청은 실데이터 · 채팅/구독은 수집기·OBS 전용 URL 연동 필요", true);
        setTimeout(() => setStatus("", false), 5500);
      } else {
        setStatus("", false);
      }
      return data;
    } catch (err) {
      console.error(err);
      setStatus("크레딧 데이터를 불러오지 못했습니다", true);
      return null;
    }
  }

  function setupPreviewChrome() {
    if (isStudioEmbed) {
      els.body.classList.add("is-studio-embed");
      els.body.classList.remove("is-preview");
      if (els.banner) {
        els.banner.hidden = true;
        els.banner.classList.add("hidden");
      }
      return;
    }
    if (isPreview) {
      els.body.classList.add("is-preview");
      if (els.banner) {
        els.banner.hidden = false;
        els.banner.classList.remove("hidden");
      }
      if (els.bannerMsg) {
        els.bannerMsg.textContent = dataIsDemoHint();
      }
      // 구 code#credits-obs-url 은 HTML에서 제거됨 — 남아 있으면 숨김
      if (els.obsUrl) {
        els.obsUrl.hidden = true;
        els.obsUrl.textContent = "";
      }
    } else {
      // 실제 OBS: 재생 전까지 투명
      els.body.classList.remove("is-preview");
      els.body.classList.add("is-obs-live");
      if (els.banner) {
        els.banner.hidden = true;
        els.banner.classList.add("hidden");
      }
      fadeOutStage(0);
      armNotebookOffstage();
    }
  }

  function dataIsDemoHint() {
    if (params.get("archive")) {
      return "아카이브 스냅샷 · 과거 방송 기록 확인용";
    }
    return "더미 데이터(유저01…) · 디자인·레이아웃 확인용";
  }

  /** 미리보기 사이드 — 「이런 것도 되나요?」 대답용 (쓸 수 있는 실데이터) */
  const PREVIEW_PAGE_DATA = {
    coverOpen: {
      label: "앞표지",
      items: [
        "표지 문구(스튜디오에서 수정)",
        "방송 수치·시청자 목록은 없음",
      ],
    },
    summary: {
      label: "오늘의 방송 요약",
      items: [
        "오늘 방송 제목",
        "총 방송 시간",
        "최고 동시 시청자 수",
        "최고 시청이 찍힌 시각",
        "그 순간 방제",
        "그 순간 방송 화면 캡처(있으면)",
        "총 채팅 횟수",
        "채팅에 참여한 인원 수",
      ],
    },
    timeline: {
      label: "방송 타임라인",
      items: [
        "방송 날짜",
        "방송 시작·종료 시각",
        "방제가 바뀐 시각과 방제 문구",
        "하루 중 방송이 켜져 있던 구간",
      ],
    },
    firstChat: {
      label: "첫 채팅",
      items: [
        "오늘 방송 첫 채팅 닉네임",
        "첫 채팅 문장(또는 이모티콘 그림)",
        "방송 시작 후 얼마나 지나서 왔는지",
      ],
    },
    chat: {
      label: "채팅 순위",
      items: [
        "시청자별 채팅 횟수",
        "채팅 많은 순 순위",
        "상위 밖 인원 수(외 N명)",
      ],
    },
    emoticon: {
      label: "이모티콘 순위",
      items: [
        "시청자별 이모티콘 사용 횟수",
        "많이 쓰인 구독 시그니처 이모티콘 이미지·횟수 (`/제목/` 텍스트는 표시 안 함)",
        "그 이모티콘 이미지(숲 등록분)",
      ],
    },
    donation: {
      label: "후원 순위",
      items: [
        "시청자별 별풍선 수(합산)",
        "별풍선 많은 순 순위",
        "상위 밖 인원 수(외 N명)",
      ],
    },
    signature: {
      label: "시그니처 순위",
      items: [
        "시그니처 금액별(예: 112개) 보낸 횟수",
        "그 금액을 가장 많이 보낸 닉네임",
        "시그니처 풍선 이미지(있으면)",
      ],
    },
    watch: {
      label: "시청 시간 순위",
      items: [
        "시청자별 방송 체류 시간",
        "오래 본 순 순위",
      ],
    },
    quickview: {
      label: "퀵뷰 순위",
      items: [
        "시청자별 퀵뷰 선물 횟수",
        "퀵뷰 많은 순 순위",
      ],
    },
    mission: {
      label: "미션 순위",
      items: [
        "시청자별 미션 후원량",
        "미션 후원 많은 순 순위",
      ],
    },
    fanclub: {
      label: "팬클럽 신규",
      items: ["오늘 팬클럽에 새로 들어온 닉네임 목록"],
    },
    topfan: {
      label: "열혈팬 승급",
      items: ["오늘 열혈로 승급한 닉네임 목록"],
    },
    subscribe: {
      label: "신규 구독",
      items: ["오늘 새로 구독한 닉네임 목록"],
    },
    subscribe_renew: {
      label: "연속 구독",
      items: [
        "연속 구독한 닉네임",
        "시청자별 연속 구독 개월 수",
      ],
    },
    subscribe_gift: {
      label: "구독 선물",
      items: [
        "구독을 선물한 닉네임",
        "선물한 구독 기간(1개월·3개월 등)",
      ],
    },
    flags: {
      label: "팬·열혈·매니저",
      items: [
        "채팅에 잡힌 팬 인원 수",
        "열혈 인원 수",
        "팔로워 인원 수",
        "매니저 인원 수",
      ],
    },
    nextDay: {
      label: "다음 방송",
      items: [
        "다음 방송 날짜·요일",
        "1부·2부 구분",
        "부별 뱅온 시각",
        "부별 일정 제목(소통·게임 등)",
      ],
    },
    outro: {
      label: "엔딩",
      items: [
        "엔딩 큰 문구(스튜디오에서 수정)",
        "보조 안내 문구",
      ],
    },
  };

  function updatePreviewPageData(pageId) {
    if (!isPreview || !els.previewPage || !els.previewPageData) return;
    const meta = PREVIEW_PAGE_DATA[pageId];
    if (!meta) {
      els.previewPage.hidden = true;
      return;
    }
    els.previewPage.hidden = false;
    if (els.previewPageLabel) els.previewPageLabel.textContent = meta.label;
    els.previewPageData.innerHTML = meta.items
      .map((t) => `<li>${escapeHtml(t)}</li>`)
      .join("");
  }

  function handleControlMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "credits-studio-preview") {
      if (Object.prototype.hasOwnProperty.call(msg, "only")) {
        onlyId = String(msg.only || "").trim();
        if (onlyId === "duration") onlyId = "timeline";
        singleLoop = Boolean(onlyId);
        loopPlayback = false;
      }
      if (msg.config) applyConfig(msg.config);
      isPlaying = false;
      els.body.classList.remove("is-playing");
      if (creditsDataRaw) startSlideshow(creditsDataRaw);
      else loadCredits();
      return;
    }
    if (msg.type === "credits-studio-source") {
      if (Object.prototype.hasOwnProperty.call(msg, "only")) {
        onlyId = String(msg.only || "").trim();
        if (onlyId === "duration") onlyId = "timeline";
        singleLoop = Boolean(onlyId);
        loopPlayback = false;
      }
      if (msg.theme != null && !themeFromUrl) {
        activeTheme = normalizeThemeId(msg.theme);
        syncThemeShell();
      }
      if (msg.config) applyConfig(msg.config);
      setStudioDataSource({
        archive: msg.archive || "",
        demo: Boolean(msg.demo) || !msg.archive,
      });
      isPlaying = false;
      els.body.classList.remove("is-playing");
      loadCredits({ entrance: false, autoStart: true });
      return;
    }
    if (msg.type === "credits-studio-refresh") {
      if (msg.config) applyConfig(msg.config);
      loadCredits({ entrance: false, autoStart: isStudioEmbed });
      return;
    }
    if (msg.type === "credits-studio-play" || msg.type === "play") {
      if (msg.theme != null && !themeFromUrl) {
        activeTheme = normalizeThemeId(msg.theme);
        syncThemeShell();
      }
      if (msg.config) applyConfig(msg.config);
      // BroadcastChannel + 폴링 중복 play → 요약↔표지 깜빡임 방지
      const now = Date.now();
      if (isPlaying || entrancePending) {
        // 방향키로 넘기는 중이면 재생 신호로 리셋하지 않음 (R 키·Stop 후 Play 로 재시작)
        if (suppressPlayRestart) return;
        if (!msg.force) return;
        if (now - lastPlaySignalAt < 2500) return;
      }
      lastPlaySignalAt = now;
      beginPlayback();
      return;
    }
    if (msg.type === "credits-studio-stop" || msg.type === "stop") {
      stopPlayback();
    }
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    handleControlMessage(event.data);
  });

  if (controlBus) {
    controlBus.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      // 스튜디오 embed는 postMessage만 사용. 실제 OBS(?obs=1)만 채널 수신
      if (isStudioEmbed) return;
      if (msg.type === "play" || msg.type === "stop") {
        handleControlMessage(msg);
      }
    };
  }

  // OBS 브라우저 소스: 스튜디오의 재생/정지 명령을 서버에서 폴링
  let controlSeq = 0;
  let controlPollPrimed = false;
  let controlPollTimer = null;
  async function pollOverlayControl() {
    if (isStudioEmbed || isPreview) return;
    try {
      const res = await fetch(
        apiUrl(`/api/credits/overlay-control?since=${encodeURIComponent(controlSeq)}`),
        { credentials: "same-origin" }
      );
      if (!res.ok) return;
      const data = await res.json();
      const seq = Number(data?.seq);
      if (Number.isFinite(seq)) controlSeq = seq;

      // 첫 폴링: 예전에 눌린 play/stop 을 재실행하지 않고 seq 만 맞춘다.
      // (OBS 새로고침·재연결 시 since=0 → 잔여 play 로 즉시 재생되던 문제)
      if (!controlPollPrimed) {
        controlPollPrimed = true;
        return;
      }

      if (!data?.changed || !data.action) return;

      // 새 seq 의 play 는 스튜디오 재시작 의도. BC 와 겹치면 아래 force 디바운스가 막는다.
      handleControlMessage({
        type: data.action,
        force: data.action === "play",
        theme: data.theme,
      });
    } catch (_) {
      /* ignore transient poll errors */
    }
  }

  function startOverlayControlPoll() {
    if (isStudioEmbed || isPreview) return;
    if (controlPollTimer) clearInterval(controlPollTimer);
    controlPollPrimed = false;
    pollOverlayControl();
    controlPollTimer = setInterval(pollOverlayControl, 1000);
  }

  setupPreviewChrome();
  fitCreditsCanvas();
  window.addEventListener("resize", fitCreditsCanvas);
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => fitCreditsCanvas()).catch(() => {});
  }
  loadCredits();
  startOverlayControlPoll();

  /** OBS 같은 URL 유지 중에도 CSS/JS 배포되면 자동 새로고침 */
  if (isObsLive) {
    let assetV = String(window.ENDING_CACHE_V || "");
    const pollAssetVersion = async () => {
      try {
        const res = await fetch(apiUrl("/api/credits/asset-version"), {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const data = await res.json();
        const next = String(data?.v || "");
        if (!next) return;
        if (!assetV) {
          assetV = next;
          return;
        }
        if (next !== assetV) {
          location.reload();
        }
      } catch (_) {
        /* ignore */
      }
    };
    setInterval(pollAssetVersion, 12000);
    setTimeout(pollAssetVersion, 4000);
  }

  window.addEventListener("keydown", (event) => {
    // 입력 필드 타이핑 중이면 무시
    const tag = String(event.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || event.target?.isContentEditable) {
      return;
    }
    if (event.key === "ArrowRight" || event.key === " ") {
      event.preventDefault();
      // 브라우저에서 OBS URL 열었을 때: 재생 전이면 시작, 재생 중이면 다음 장
      if (!isPlaying) {
        beginPlayback();
        return;
      }
      // 등장·표지 연출 중 Space 키반복/방향키가 끼어들면 요약→표지→열림 깜빡임
      if (entrancePending) return;
      showSlide(slideIndex + 1, { manual: true });
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (!isPlaying) {
        beginPlayback();
        return;
      }
      if (entrancePending) return;
      showSlide(slideIndex - 1, { manual: true });
    }
    if (event.key === "r" || event.key === "R") {
      event.preventDefault();
      beginPlayback();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      stopPlayback();
    }
  });

  function setCollectAuthVisible(show) {
    if (!els.collectAuth) return;
    // 크레딧 재생 중에는 로그인 UI를 숨겨 송출을 가리지 않음
    const visible = Boolean(show) && !isPlaying;
    els.collectAuth.hidden = !visible;
    if (visible) els.body.classList.add("has-obs-collect-auth");
    else els.body.classList.remove("has-obs-collect-auth");
  }

  function setCollectAuthGuide({ title, message, showLogin }) {
    if (!els.collectAuth) return;
    const titleEl = els.collectAuth.querySelector(".obs-collect-auth__title");
    if (titleEl && title) titleEl.textContent = title;
    if (els.collectAuthMsg && message) {
      els.collectAuthMsg.textContent = message;
    }
    if (els.collectLogin) {
      els.collectLogin.hidden = !showLogin;
    }
    setCollectAuthVisible(true);
  }

  function setCollectDot(phase) {
    if (!els.collectDot) return;
    if (!collectEnabled) {
      els.collectDot.hidden = true;
      return;
    }
    const show =
      collectDebug ||
      phase === "collecting" ||
      phase === "waiting" ||
      phase === "connecting" ||
      phase === "sdk_fail";
    els.collectDot.hidden = !show;
    els.collectDot.dataset.phase = phase || "";
    els.collectDot.title =
      phase === "collecting"
        ? "수집 중"
        : phase === "waiting"
          ? "방송 대기"
          : phase === "connecting"
            ? "연결 중"
            : phase === "sdk_fail"
              ? "채팅 연결 실패"
              : phase || "수집";
  }

  function setCollectStatusBadge(phase, detail) {
    if (!els.collectStatus) return;
    if (!showCollectHud) {
      els.collectStatus.hidden = true;
      els.collectStatus.style.display = "none";
      return;
    }
    // ?hud=1 일 때만 우측 하단 상태 표시
    els.collectStatus.hidden = false;
    els.collectStatus.removeAttribute("hidden");
    els.collectStatus.style.display = "flex";
    const effectivePhase = collectEnabled ? phase || "boot" : "stopped";
    els.collectStatus.dataset.phase = effectivePhase;
    const labels = {
      boot: "준비 중",
      connecting: "연결 중",
      waiting: "숲 방송 대기",
      collecting: "수집 중",
      need_login: "로그인/키 필요",
      sdk_fail: "채팅 연결 실패",
      error: "오류",
      stopped: collectEnabled ? "중지됨" : "수집 꺼짐",
    };
    let label = labels[effectivePhase] || String(effectivePhase || "대기");
    // waiting/connecting/sdk_fail 은 상세 문구를 배지에 바로 보여 줌
    if (
      (effectivePhase === "waiting" ||
        effectivePhase === "connecting" ||
        effectivePhase === "error" ||
        effectivePhase === "sdk_fail") &&
      detail
    ) {
      label = String(detail).trim().slice(0, 36) || label;
    }
    if (els.collectStatusLabel) els.collectStatusLabel.textContent = label;
    const sid = collectRuntime?.getStationId?.() || "";
    const bits = [detail, sid ? `채널 ${sid}` : ""].filter(Boolean);
    els.collectStatus.title = bits.length ? `${label} · ${bits.join(" · ")}` : label;
  }

  function hideCollectToast() {
    if (collectToastTimer) {
      clearTimeout(collectToastTimer);
      collectToastTimer = null;
    }
    collectToastMode = "";
    const el = els.collectToast;
    if (!el) return;
    el.classList.remove("is-visible", "is-waiting", "is-collecting");
    const finish = () => {
      if (!el.classList.contains("is-visible")) el.hidden = true;
    };
    el.addEventListener("transitionend", finish, { once: true });
    // transition 없을 때 대비
    setTimeout(finish, 500);
  }

  function revealCollectToast() {
    if (!els.collectToast) return;
    els.collectToast.hidden = false;
    requestAnimationFrame(() => {
      els.collectToast?.classList.add("is-visible");
    });
  }

  function showWaitingToast(detail) {
    if (!collectEnabled || !els.collectToast || isPlaying) return;
    if (els.collectToastTitle) els.collectToastTitle.textContent = "대기 중";
    if (els.collectToastSub) {
      els.collectToastSub.textContent =
        String(detail || "").trim() || "숲 방송 시작을 기다리는 중";
    }
    if (collectToastTimer) {
      clearTimeout(collectToastTimer);
      collectToastTimer = null;
    }
    els.collectToast.classList.add("is-waiting");
    els.collectToast.classList.remove("is-collecting");
    collectToastMode = "waiting";
    revealCollectToast();
  }

  function showCollectStartToast(detail) {
    if (!collectEnabled || !els.collectToast || isPlaying) return;
    if (els.collectToastTitle) els.collectToastTitle.textContent = "수집 중";
    if (els.collectToastSub) {
      els.collectToastSub.textContent =
        String(detail || "").trim() || "엔딩 크레딧 수집을 시작합니다";
    }
    if (collectToastTimer) {
      clearTimeout(collectToastTimer);
      collectToastTimer = null;
    }
    els.collectToast.classList.add("is-collecting");
    els.collectToast.classList.remove("is-waiting");
    collectToastMode = "collecting";
    revealCollectToast();
    collectToastTimer = setTimeout(() => {
      collectToastTimer = null;
      hideCollectToast();
    }, COLLECT_TOAST_MS);
  }

  function onCollectPhase(phase, detail) {
    const prev = lastCollectPhase;
    lastCollectPhase = phase || "";
    setCollectDot(phase);
    setCollectStatusBadge(phase, detail);
    // 방송 전 대기: 가운데에 수집 중과 같은 토스트 유지
    if (phase === "waiting" && !isPlaying) {
      showWaitingToast(detail);
      return;
    }
    // waiting/connecting/error → collecting : 방송 ON·재연결 직후 한 번
    if (phase === "collecting" && prev !== "collecting" && prev !== "") {
      showCollectStartToast("채팅·후원 수집을 시작합니다");
      return;
    }
    // 수집 중(유지)이면 대기 토스트만 치움 — 수집 시작 토스트는 타이머로 사라짐
    if (phase === "collecting") {
      if (collectToastMode === "waiting") hideCollectToast();
      return;
    }
    // 로그인/오류/중지 등으로 넘어가면 가운데 안내 숨김
    if (
      phase === "need_login" ||
      phase === "error" ||
      phase === "stopped" ||
      phase === "boot"
    ) {
      if (collectToastMode === "waiting") hideCollectToast();
    }
  }

  function bootCollectRuntime() {
    // HUD 는 런타임보다 먼저 표시 (OBS 캐시·로딩 중에도 보이게)
    if (showCollectHud) {
      setCollectStatusBadge(collectEnabled ? "boot" : "stopped");
    }
    // 수집 OFF OBS: Chat SDK 없이 presence만 — 모니터 OBS 캡슐용
    const presenceOnly = isObsLive && !collectEnabled;
    if (!collectEnabled && !presenceOnly) return;
    if (!window.EndingCollectRuntime || typeof window.EndingCollectRuntime.create !== "function") {
      console.warn("[ending] collect-runtime missing");
      if (collectEnabled) setCollectStatusBadge("error", "collect-runtime 없음");
      return;
    }
    const hasObsKey = (() => {
      try {
        const p = new URLSearchParams(location.search);
        return Boolean(String(p.get("k") || p.get("key") || "").trim());
      } catch (_) {
        return false;
      }
    })();
    collectRuntime = window.EndingCollectRuntime.create({
      oauthNext: "obs",
      clientSource: "obs",
      presenceOnly,
      onNeedLogin: () => {
        if (presenceOnly) return;
        setCollectAuthVisible(true);
        if (els.collectLogin) {
          // 전용 URL 방식: Interact 로그인 버튼은 보조(키 없을 때만)
          if (hasObsKey) {
            els.collectLogin.hidden = true;
          } else {
            els.collectLogin.hidden = false;
            els.collectLogin.disabled = false;
            els.collectLogin.textContent = "숲으로 로그인 (임시)";
          }
        }
      },
      onStatus: ({ phase, detail }) => {
        if (presenceOnly) return;
        onCollectPhase(phase, detail);
        // sdk_fail 레거시: 자동 재연결로 대체 — 수동 새로고침 안내창 없음
        if (phase === "sdk_fail") {
          setCollectAuthVisible(false);
          return;
        }
        if (phase === "need_login" || phase === "error") {
          setCollectAuthGuide({
            title: phase === "error" ? "오류" : "OBS 전용 URL",
            message: String(detail || "").trim() || AUTH_GUIDE_DEFAULT,
            showLogin: !hasObsKey,
          });
          if (els.collectLogin && !hasObsKey) {
            els.collectLogin.disabled = false;
            els.collectLogin.textContent =
              phase === "error" ? "다시 시도" : "숲으로 로그인 (임시)";
          }
          return;
        }
        if (
          phase === "collecting" ||
          phase === "waiting" ||
          phase === "connecting" ||
          phase === "boot"
        ) {
          setCollectAuthVisible(false);
        }
        if (phase === "boot" && els.collectLogin && !hasObsKey) {
          els.collectLogin.hidden = false;
          els.collectLogin.disabled = true;
          els.collectLogin.textContent = "준비 중…";
        }
      },
      onLog: (msg) => {
        if (collectDebug) console.log("[ending-collect]", msg);
      },
    });
    if (!presenceOnly) {
      els.collectLogin?.addEventListener("click", () => {
        if (els.collectLogin) {
          els.collectLogin.disabled = true;
          els.collectLogin.textContent = "여는 중…";
        }
        collectRuntime.startOauth().catch(() => {
          if (els.collectLogin) {
            els.collectLogin.disabled = false;
            els.collectLogin.textContent = "숲으로 로그인 (임시)";
          }
        });
      });
    }
    collectRuntime.start();
  }

  bootCollectRuntime();
})();
