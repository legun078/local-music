import { calendarPath, detectScheduleBase, musicbookPath } from "./base-path.js";
import {
  apiFetch,
  consumeAuthErrorFromUrl,
  fetchAuthConfig,
  fetchMe,
  loginUrl,
  renderModeControl,
} from "./auth.js";
import { canEditMusicbook } from "./permissions.js";
import { startContentSync, fetchAndRememberRevisions } from "./content-sync.js";
import { createPersistQueue } from "./persist-queue.js";
import { startSongRequestNotificationWatcher } from "./song-request-notifications.js";
import {
  applyMusicbookPageFonts,
  bindTieredFontOptions,
  normalizeMusicbookPageFonts,
  registerAllFontFaces,
  renderMusicbookFontOptions,
} from "./calendar-fonts.js";
import { initPageFontSettings } from "./font-settings-panel.js";
import { escapeHtml } from "./slots.js";
import { applyBrandTheme } from "./theme.js";

const BASE = window.SCHEDULE_BASE || detectScheduleBase() || "";
const LS_KEY = "musicbook-ui";
const MOBILE_LIST_MQ = window.matchMedia("(max-width: 768px)");
const MUSICBOOK_SORT_VERSION = 2;
const LIKE_ICON = `<svg class="musicbook-like-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;

const state = {
  data: null,
  me: null,
  canEdit: false,
  editMode: false,
  mobileListTab: "available",
  scheduleMeta: null,
  fontSettings: null,
  search: "",
  searchScope: "all",
  sortAvailable: "likes-desc",
  sortBanned: "title-asc",
  saving: false,
  statusTimer: null,
  modalDefaultStatus: "available",
  detailTarget: null,
  likedOnly: false,
  filterCapsules: {
    language: new Set(),
    proficiency: new Set(),
  },
};

const comboboxNav = {
  search: { index: -1 },
  artist: { index: -1 },
};

let lastListViewSignature = null;

const els = {};
let musicbookContentSync = null;

function isEditing() {
  return state.canEdit && state.editMode;
}

function loadUiPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    if (prefs.sortVersion !== MUSICBOOK_SORT_VERSION) delete prefs.sortAvailable;
    return prefs;
  } catch (e) {
    return {};
  }
}

function serializeFilterCapsules() {
  const out = {};
  for (const [group, set] of Object.entries(state.filterCapsules)) {
    if (set.size) out[group] = [...set];
  }
  return out;
}

function restoreFilterCapsules(raw) {
  for (const group of Object.keys(state.filterCapsules)) {
    state.filterCapsules[group] = new Set();
  }
  if (!raw || typeof raw !== "object") return;
  for (const [group, ids] of Object.entries(raw)) {
    if (!state.filterCapsules[group] || !Array.isArray(ids)) continue;
    state.filterCapsules[group] = new Set(ids.map((id) => String(id)));
  }
}

function saveUiPrefs() {
  localStorage.setItem(
    LS_KEY,
    JSON.stringify({
      sortAvailable: state.sortAvailable,
      sortBanned: state.sortBanned,
      sortVersion: MUSICBOOK_SORT_VERSION,
      filterCapsules: serializeFilterCapsules(),
      likedOnly: state.likedOnly,
      mobileListTab: state.mobileListTab,
    }),
  );
}

function isMobileMusicbookLayout() {
  return MOBILE_LIST_MQ.matches;
}

function syncMobileStatusTabCounts() {
  if (!els.mobileStatusTabs) return;
  for (const el of els.mobileStatusTabs.querySelectorAll("[data-count-for]")) {
    const source = el.dataset.countFor === "banned" ? els.countBanned : els.countAvailable;
    if (source) el.textContent = source.textContent;
  }
}

function applyMobileListTab() {
  const mobile = isMobileMusicbookLayout();
  document.body.classList.toggle("musicbook-mobile-tab-available", mobile && state.mobileListTab === "available");
  document.body.classList.toggle("musicbook-mobile-tab-banned", mobile && state.mobileListTab === "banned");
  if (!mobile) {
    document.body.classList.remove("musicbook-mobile-tab-available", "musicbook-mobile-tab-banned");
  }

  els.mobileStatusTabs?.querySelectorAll("[data-mobile-status]").forEach((btn) => {
    const active = mobile && btn.dataset.mobileStatus === state.mobileListTab;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
    btn.tabIndex = active ? 0 : -1;
  });

  const availPanel = document.getElementById("musicbook-column-available-panel");
  const bannedPanel = document.getElementById("musicbook-column-banned-panel");
  if (availPanel) availPanel.hidden = mobile && state.mobileListTab !== "available";
  if (bannedPanel) bannedPanel.hidden = mobile && state.mobileListTab !== "banned";
  updateMobileSortTools();
}

function cacheChromeLayout() {
  els.mobileListChrome = document.querySelector(".musicbook-mobile-list-chrome");
  els.mobileSortBar = document.getElementById("musicbook-mobile-sort-bar");
  els.availColumnHead = document.querySelector(".musicbook-column--available .musicbook-column-head");
  els.bannedColumnHead = document.querySelector(".musicbook-column--banned .musicbook-column-head");
  els.toolsAvailable = document.querySelector(".musicbook-column--available .musicbook-column-tools");
  els.toolsBanned = document.querySelector(".musicbook-column--banned .musicbook-column-tools");
}

function updateMobileSortTools() {
  const mobile = isMobileMusicbookLayout();
  if (!mobile || !els.toolsAvailable || !els.toolsBanned) return;
  els.toolsAvailable.classList.toggle("hidden", state.mobileListTab !== "available");
  els.toolsBanned.classList.toggle("hidden", state.mobileListTab !== "banned");
}

function layoutMobileListChrome() {
  const mobile = isMobileMusicbookLayout();
  const { mobileSortBar, availColumnHead, bannedColumnHead, toolsAvailable, toolsBanned } = els;
  if (!mobileSortBar || !availColumnHead || !bannedColumnHead || !toolsAvailable || !toolsBanned) return;

  if (mobile) {
    if (toolsAvailable.parentElement !== mobileSortBar) {
      mobileSortBar.append(toolsAvailable, toolsBanned);
    }
  } else {
    if (toolsAvailable.parentElement !== availColumnHead) {
      availColumnHead.append(toolsAvailable);
    }
    if (toolsBanned.parentElement !== bannedColumnHead) {
      bannedColumnHead.append(toolsBanned);
    }
    toolsAvailable.classList.remove("hidden");
    toolsBanned.classList.remove("hidden");
  }
  updateMobileSortTools();
}

function setMobileListTab(tab) {
  if (tab !== "available" && tab !== "banned") return;
  if (state.mobileListTab === tab) return;
  state.mobileListTab = tab;
  saveUiPrefs();
  applyMobileListTab();
  applyEditMode();
  resetMusicbookScroll();
}

function setStatus(message, kind = "") {
  if (!els.status) return;
  clearTimeout(state.statusTimer);
  els.status.textContent = message || "";
  const base = "links-status";
  const kindClass =
    kind === "error" ? " links-status--error is-error" : kind === "saved" ? " links-status--saved" : "";
  els.status.className = `${base}${kindClass}`;
  if (message) {
    state.statusTimer = setTimeout(() => {
      if (els.status.textContent === message) {
        els.status.textContent = "";
        els.status.className = base;
      }
    }, 2800);
  }
}

function activeFilterCount() {
  const capsuleCount = Object.values(state.filterCapsules).reduce(
    (sum, set) => sum + (set?.size || 0),
    0,
  );
  return capsuleCount + (state.likedOnly ? 1 : 0);
}

function setFiltersPanelCollapsed(collapsed) {
  document.body.classList.toggle("musicbook-filters-collapsed", collapsed);
  els.filtersToggle?.setAttribute("aria-expanded", collapsed ? "false" : "true");
  try {
    localStorage.setItem("musicbook-filters-collapsed", collapsed ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function updateFilterToggleUi() {
  const count = activeFilterCount();
  if (!els.filtersToggleCount) return;
  els.filtersToggleCount.textContent = count > 0 ? String(count) : "";
  els.filtersToggleCount.classList.toggle("hidden", count <= 0);
}

function setEmptyState(emptyEl, { title, hint = "" }) {
  if (!emptyEl) return;
  emptyEl.classList.remove("hidden");
  const titleEl = emptyEl.querySelector(".highlights-empty-title");
  const hintEl = emptyEl.querySelector(".musicbook-empty-hint");
  if (titleEl) titleEl.textContent = title;
  if (hintEl) {
    hintEl.textContent = hint;
    hintEl.classList.toggle("hidden", !hint);
  }
}

function langLabel(langId) {
  const cap = languageCapsuleDef(langId);
  return cap?.label || langId || "—";
}

let capsuleCtxTarget = null;
let capsuleCtxGroup = null;
let capsuleColorTarget = null;

const PROFICIENCY_ORDER = ["highlight", "verse", "full"];
const LANGUAGE_ORDER = ["K", "J", "E"];

const CAPSULE_GROUPS = {
  language: {
    label: "언어",
    taxonomyKey: "languageCapsules",
    songField: "language",
    order: LANGUAGE_ORDER,
    legendEl: () => els.langCapsulesLegend,
  },
  proficiency: {
    label: "숙련도",
    taxonomyKey: "capsules",
    songField: "capsule",
    order: PROFICIENCY_ORDER,
    legendEl: () => els.capsulesLegend,
  },
};

function getCapsuleMap(group) {
  const cfg = CAPSULE_GROUPS[group];
  return cfg ? state.data?.taxonomy?.[cfg.taxonomyKey] || {} : {};
}

function getLanguageCapsules() {
  return getCapsuleMap("language");
}

function orderedCapsuleEntries(group) {
  const cfg = CAPSULE_GROUPS[group];
  if (!cfg) return [];
  const capsules = getCapsuleMap(group);
  const ordered = [];
  const seen = new Set();
  for (const id of cfg.order) {
    if (capsules[id]) {
      ordered.push([id, capsules[id]]);
      seen.add(id);
    }
  }
  for (const [id, cap] of Object.entries(capsules)) {
    if (!seen.has(id)) ordered.push([id, cap]);
  }
  return ordered;
}

function capsuleDef(id, group = "proficiency") {
  return id ? getCapsuleMap(group)[id] : null;
}

function languageCapsuleDef(id) {
  return capsuleDef(id, "language");
}

function capsuleOptionsHtml(group, selected = "", { includeEmpty = true } = {}) {
  const empty = includeEmpty ? `<option value="">없음</option>` : "";
  return `${empty}${orderedCapsuleEntries(group)
    .map(
      ([id, cap]) =>
        `<option value="${escapeHtml(id)}"${id === selected ? " selected" : ""}>${escapeHtml(cap.label || id)}</option>`,
    )
    .join("")}`;
}

function newCapsuleId(label, group) {
  const base =
    String(label || "capsule")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^\w가-힣]/g, "") || "capsule";
  const capsules = getCapsuleMap(group);
  let id = base;
  let n = 1;
  while (capsules[id]) id = `${base}_${n++}`;
  return id;
}

function renderCapsuleBadge(capsuleId, group = "proficiency") {
  const cap = capsuleDef(capsuleId, group);
  if (!cap) return "";
  return `<span class="musicbook-capsule-badge" style="--cap-bg:${escapeHtml(cap.bg)};--cap-text:${escapeHtml(cap.text)}"><span class="musicbook-capsule-badge-swatch" aria-hidden="true"></span><span class="musicbook-capsule-badge-label">${escapeHtml(cap.label || capsuleId)}</span></span>`;
}

function hasActiveCapsuleFilters() {
  return state.likedOnly || Object.values(state.filterCapsules).some((set) => set.size > 0);
}

function songMatchesCapsuleFilters(song) {
  if (state.likedOnly && !song?.likedByMe) return false;
  for (const [group, cfg] of Object.entries(CAPSULE_GROUPS)) {
    const selected = state.filterCapsules[group];
    if (!selected?.size) continue;
    const value = song[cfg.songField];
    if (!value || !selected.has(value)) return false;
  }
  return true;
}

function toggleCapsuleFilter(group, id) {
  const set = state.filterCapsules[group];
  if (!set) return;
  if (set.has(id)) set.delete(id);
  else set.add(id);
  if (set.size > 0 && MOBILE_LIST_MQ.matches) setFiltersPanelCollapsed(false);
  saveUiPrefs();
  renderCapsuleSections();
  renderLists();
}

function toggleLikedFilter() {
  if (!state.me?.loggedIn) {
    window.location.href = loginUrl(`${location.pathname}${location.search}`);
    return;
  }
  state.likedOnly = !state.likedOnly;
  if (state.likedOnly && MOBILE_LIST_MQ.matches) setFiltersPanelCollapsed(false);
  saveUiPrefs();
  renderCapsuleSections();
  renderLists();
}

function renderLikedFilter() {
  if (!els.likedFilter) return;
  els.likedFilter.classList.toggle("legend-item--active", state.likedOnly);
  els.likedFilter.setAttribute("aria-pressed", state.likedOnly ? "true" : "false");
  els.likedFilter.classList.toggle("is-login-required", !state.me?.loggedIn);
}

function renderAppliedFilterChip({ group, id, groupLabel, label, bg, text }) {
  return `<button type="button" class="musicbook-applied-filter" data-capsule-group="${escapeHtml(group)}" data-capsule-filter="${escapeHtml(id)}" style="--cap-bg:${escapeHtml(bg)};--cap-text:${escapeHtml(text)}" aria-label="${escapeHtml(groupLabel)} ${escapeHtml(label)} 필터 해제">
    <span class="musicbook-applied-filter-swatch" aria-hidden="true"></span>
    <span class="musicbook-applied-filter-label">${escapeHtml(label)}</span>
    <span class="musicbook-applied-filter-remove" aria-hidden="true">×</span>
  </button>`;
}

function renderLogicOrJoin() {
  return `<span class="musicbook-applied-or" role="separator" aria-label="또는">/</span>`;
}

function renderLogicAndSep() {
  return `<span class="musicbook-applied-and" role="separator" aria-label="그리고">·</span>`;
}

function updateFilterLogicChrome() {
  const groupEls = {
    language: document.getElementById("musicbook-lang-filter-group"),
    proficiency: document.getElementById("musicbook-prof-filter-group"),
    liked: document.getElementById("musicbook-liked-filter-group"),
  };
  const states = {};
  for (const group of Object.keys(CAPSULE_GROUPS)) {
    const size = state.filterCapsules[group]?.size || 0;
    states[group] = { active: size > 0, multi: size > 1, size };
  }
  states.liked = { active: state.likedOnly, multi: false, size: state.likedOnly ? 1 : 0 };

  for (const [group, el] of Object.entries(groupEls)) {
    if (!el) continue;
    const s = states[group] || { active: false, multi: false };
    el.classList.toggle("is-filter-active", s.active);
    el.classList.toggle("is-filter-multi", s.multi);
  }

  const andJoin = document.getElementById("musicbook-filter-and-join");
  const bothActive = states.language?.active && states.proficiency?.active;
  if (andJoin) {
    andJoin.classList.toggle("is-visible", bothActive);
    andJoin.setAttribute("aria-hidden", bothActive ? "false" : "true");
  }
  const likedJoin = document.getElementById("musicbook-liked-filter-and-join");
  const likedCombined =
    states.liked?.active && (states.language?.active || states.proficiency?.active);
  if (likedJoin) {
    likedJoin.classList.toggle("is-visible", likedCombined);
    likedJoin.setAttribute("aria-hidden", likedCombined ? "false" : "true");
  }
}

function renderAppliedFilters() {
  if (!els.appliedFilters || !els.appliedFiltersList) return;
  const groups = Object.entries(CAPSULE_GROUPS)
    .map(([group, cfg]) => {
      const selected = state.filterCapsules[group];
      if (!selected?.size) return null;
      const chips = [...selected]
        .map((id) => {
          const cap = capsuleDef(id, group);
          if (!cap) return "";
          return renderAppliedFilterChip({
            group,
            id,
            groupLabel: cfg.label,
            label: cap.label || id,
            bg: cap.bg,
            text: cap.text,
          });
        })
        .filter(Boolean);
      if (!chips.length) return null;
      return { group, label: cfg.label, chips, multi: chips.length > 1 };
    })
    .filter(Boolean);
  if (state.likedOnly) {
    groups.push({
      group: "liked",
      label: "좋아요",
      multi: false,
      chips: [
        renderAppliedFilterChip({
          group: "liked",
          id: "mine",
          groupLabel: "좋아요",
          label: "나의 선호곡",
          bg: "#f7c6d5",
          text: "#a41242",
        }),
      ],
    });
  }

  const hasFilters = groups.length > 0;
  els.appliedFilters.classList.toggle("hidden", !hasFilters);
  renderSearchFilterContext();
  if (!hasFilters) {
    els.appliedFiltersList.innerHTML = "";
    updateFilterLogicChrome();
    return;
  }

  const parts = [];
  groups.forEach((g, idx) => {
    if (idx > 0) parts.push(renderLogicAndSep());
    const itemsHtml = g.chips.join(g.multi ? renderLogicOrJoin() : "");
    parts.push(
      `<span class="musicbook-applied-group" data-filter-group="${escapeHtml(g.group)}"><span class="musicbook-applied-group-label">${escapeHtml(g.label)}</span>${itemsHtml}</span>`,
    );
  });

  els.appliedFiltersList.innerHTML = parts.join("");
  updateFilterLogicChrome();
  if (document.activeElement === els.search) renderSuggestions();
}

function renderCapsuleSections() {
  renderCapsuleSection("language");
  renderCapsuleSection("proficiency");
  renderLikedFilter();
  renderAppliedFilters();
}

function clearAllCapsuleFilters() {
  for (const group of Object.keys(state.filterCapsules)) {
    state.filterCapsules[group] = new Set();
  }
  state.likedOnly = false;
  saveUiPrefs();
  renderCapsuleSections();
  renderLists();
}

function autoTextColorForBg(bgHex) {
  const raw = String(bgHex || "#808080").replace("#", "").trim();
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw.padEnd(6, "0").slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.62 ? "#333333" : "#ffffff";
}

const YT_ICON = `<svg class="musicbook-yt-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31.5 31.5 0 0 0 0 12a31.5 31.5 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31.5 31.5 0 0 0 24 12a31.5 31.5 0 0 0-.5-5.8zM9.6 15.5V8.5L15.8 12l-6.2 3.5z"/></svg>`;

function parseYoutubeVideoId(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^[\w-]{11}$/.test(s)) return s;
  let url = s;
  if (!url.startsWith("http")) url = `https://${url.replace(/^\/+/, "")}`;
  const patterns = [
    /youtu\.be\/([\w-]{11})/i,
    /youtube\.com\/shorts\/([\w-]{11})/i,
    /youtube\.com\/embed\/([\w-]{11})/i,
    /youtube\.com\/watch\?[^#]*v=([\w-]{11})/i,
    /youtube\.com\/live\/([\w-]{11})/i,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

function displayYoutubeUrl(raw) {
  const videoId = parseYoutubeVideoId(raw);
  return videoId ? `https://youtu.be/${videoId}` : "";
}

function renderYoutubeLink(url) {
  if (!url) return "";
  const href = displayYoutubeUrl(url) || url;
  return `<a href="${escapeHtml(href)}" class="musicbook-yt-link" target="_blank" rel="noopener noreferrer" aria-label="유튜브 영상" data-stop-edit>${YT_ICON}</a>`;
}

function renderCapsuleField(song) {
  const value = song.capsule || "";
  return `<label class="musicbook-meta-field musicbook-meta-field--capsule" data-stop-edit>
    <span class="musicbook-meta-label">숙련도</span>
    <select class="musicbook-input musicbook-input--sm musicbook-capsule-inline" data-field="capsule" data-id="${escapeHtml(song.id)}" aria-label="숙련도">${capsuleOptionsHtml("proficiency", value)}</select>
  </label>`;
}

function renderCapsuleSection(group) {
  const cfg = CAPSULE_GROUPS[group];
  const legendEl = cfg?.legendEl();
  if (!legendEl || !cfg) return;

  const editing = isEditing();
  const active = state.filterCapsules[group] || new Set();
  legendEl.className = `musicbook-capsules-legend${editing ? " musicbook-capsules-legend--edit" : ""}`;
  legendEl.innerHTML = orderedCapsuleEntries(group)
    .map(([id, cap]) => {
      const editableAttr = editing ? ` data-capsule-id="${escapeHtml(id)}" data-capsule-group="${group}"` : "";
      const editableClass = editing ? " legend-item--editable" : "";
      const activeClass = active.has(id) ? " legend-item--active" : "";
      const pressed = active.has(id) ? ' aria-pressed="true"' : ' aria-pressed="false"';
      const style = `--cap-bg:${escapeHtml(cap.bg)};--cap-text:${escapeHtml(cap.text)}`;
      return `<button type="button" class="legend-item${editableClass}${activeClass}" style="${style}" data-capsule-filter="${escapeHtml(id)}" data-capsule-group="${group}"${editableAttr}${pressed} aria-label="${escapeHtml(cap.label || id)} 필터"><span class="legend-swatch" aria-hidden="true"></span>${escapeHtml(cap.label || id)}</button>`;
    })
    .join("");
}

function renderCapsulesLegend() {
  renderCapsuleSections();
}

function positionFixedMenu(menu, clientX, clientY) {
  if (!menu) return;
  menu.classList.remove("hidden");
  const rect = menu.getBoundingClientRect();
  let x = clientX;
  let y = clientY;
  if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
}

function closeCapsuleContextMenu() {
  els.capsuleCtxMenu?.classList.add("hidden");
  capsuleCtxTarget = null;
  capsuleCtxGroup = null;
}

function openCapsuleContextMenu(e, capsuleId, group) {
  closeCapsuleContextMenu();
  capsuleCtxTarget = capsuleId;
  capsuleCtxGroup = group;
  capsuleColorTarget = capsuleId;
  const cap = getCapsuleMap(group)[capsuleId];
  if (els.capsuleColorPicker && cap) els.capsuleColorPicker.value = cap.bg || "#e8ecf2";
  positionFixedMenu(els.capsuleCtxMenu, e.clientX, e.clientY);
}

async function persistCapsulesChange() {
  renderCapsuleSections();
  fillModalLanguageOptions(els.songLanguage?.value || "K");
  fillModalCapsuleOptions(els.songCapsule?.value || "");
  renderLists();
  try {
    await persistMusicbook();
  } catch {
    /* status shown */
  }
}

async function addCapsule(group, label = "새 캡슐", bg = "#e8ecf2") {
  if (!isEditing() || !state.data || !CAPSULE_GROUPS[group]) return;
  const id = newCapsuleId(label, group);
  const cfg = CAPSULE_GROUPS[group];
  state.data.taxonomy = state.data.taxonomy || {};
  state.data.taxonomy[cfg.taxonomyKey] = {
    ...getCapsuleMap(group),
    [id]: { label, bg, text: autoTextColorForBg(bg) },
  };
  await persistCapsulesChange();
}

function openCapsuleAddModal() {
  if (!isEditing() || !els.capsuleAddModal) return;
  els.capsuleAddGroup.value = "language";
  els.capsuleAddLabel.value = "";
  els.capsuleAddColor.value = "#e8ecf2";
  els.capsuleAddModal.classList.remove("hidden");
  els.capsuleAddModal.setAttribute("aria-hidden", "false");
  syncModalOpenClass();
  els.capsuleAddLabel.focus();
}

function closeCapsuleAddModal() {
  if (!els.capsuleAddModal) return;
  els.capsuleAddModal.classList.add("hidden");
  els.capsuleAddModal.setAttribute("aria-hidden", "true");
  els.capsuleAddForm?.reset();
  if (els.capsuleAddColor) els.capsuleAddColor.value = "#e8ecf2";
  syncModalOpenClass();
}

async function saveCapsuleFromForm(e) {
  e.preventDefault();
  if (!isEditing()) return;
  const group = els.capsuleAddGroup?.value || "language";
  const label = els.capsuleAddLabel?.value.trim() || "";
  if (!label) {
    alert("캡슐 이름을 입력해 주세요.");
    els.capsuleAddLabel.focus();
    return;
  }
  const bg = els.capsuleAddColor?.value || "#e8ecf2";
  closeCapsuleAddModal();
  await addCapsule(group, label, bg);
}

async function updateCapsuleField(group, id, field, value) {
  if (!isEditing() || !state.data || !CAPSULE_GROUPS[group]) return;
  const cfg = CAPSULE_GROUPS[group];
  const capsules = { ...getCapsuleMap(group) };
  const cap = capsules[id];
  if (!cap) return;
  const next = { ...cap, [field]: value };
  if (field === "bg") next.text = autoTextColorForBg(value);
  capsules[id] = next;
  state.data.taxonomy[cfg.taxonomyKey] = capsules;
  await persistCapsulesChange();
}

async function removeCapsule(group, id) {
  if (!isEditing() || !state.data || !CAPSULE_GROUPS[group]) return;
  const capsules = getCapsuleMap(group);
  if (!capsules[id]) return;
  if (!confirm(`「${capsules[id].label || id}」 캡슐을 삭제할까요?`)) return;
  const cfg = CAPSULE_GROUPS[group];
  const next = { ...capsules };
  delete next[id];
  state.data.taxonomy[cfg.taxonomyKey] = next;
  for (const g of Object.keys(state.filterCapsules)) {
    state.filterCapsules[g]?.delete(id);
  }
  state.data.songs = (state.data.songs || []).map((s) => {
    if (s[cfg.songField] !== id) return s;
    const song = { ...s };
    delete song[cfg.songField];
    return song;
  });
  await persistCapsulesChange();
}

function fillModalLanguageOptions(selected = "K") {
  if (!els.songLanguage) return;
  els.songLanguage.innerHTML = capsuleOptionsHtml("language", selected, { includeEmpty: false });
}

function fillModalCapsuleOptions(selected = "") {
  if (!els.songCapsule) return;
  els.songCapsule.innerHTML = capsuleOptionsHtml("proficiency", selected);
}

function formatPitchShift(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "";
  return n > 0 ? `+${n}키` : `${n}키`;
}

const PITCH_MIN = -6;
const PITCH_MAX = 6;

function currentPitchValue(song) {
  const n = Number(song?.pitchShift);
  return Number.isFinite(n) ? n : 0;
}

function pitchSignClass(pitch) {
  if (pitch > 0) return "up";
  if (pitch < 0) return "down";
  return "none";
}

function pitchLabel(pitch) {
  return formatPitchShift(pitch) || "원곡";
}

function parsePitchInput(raw) {
  const pitchRaw = String(raw ?? "").trim();
  if (!pitchRaw) return { ok: true, value: null };
  const n = Number(pitchRaw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, message: "음정은 -6부터 +6 사이 정수로 입력해 주세요." };
  }
  if (n < PITCH_MIN || n > PITCH_MAX) {
    return { ok: false, message: `음정은 ${PITCH_MIN}키부터 +${PITCH_MAX}키 사이로 입력해 주세요.` };
  }
  if (n === 0) return { ok: true, value: null };
  return { ok: true, value: n };
}

function renderPitchDisplay(song) {
  const pitch = currentPitchValue(song);
  const label = pitchLabel(pitch);
  const tone =
    pitch > 0
      ? { bg: "#f59e0b", text: "#7c4a03" }
      : pitch < 0
        ? { bg: "#8b5cf6", text: "#5b3d8f" }
        : { bg: "#cbd5e1", text: "#64748b" };
  return `<span class="musicbook-capsule-badge musicbook-pitch-capsule musicbook-pitch-tag--${pitchSignClass(pitch)}" style="--cap-bg:${tone.bg};--cap-text:${tone.text}" aria-label="음정 ${escapeHtml(label)}">
    <span class="musicbook-capsule-badge-swatch" aria-hidden="true"></span>
    <span class="musicbook-capsule-badge-label">${escapeHtml(label)}</span>
  </span>`;
}

function renderPitchStepper(song) {
  const pitch = currentPitchValue(song);
  const label = pitchLabel(pitch);
  return `<div class="musicbook-pitch-stepper" data-stop-edit>
    <span class="musicbook-meta-label">음정</span>
    <button type="button" class="musicbook-pitch-step" data-pitch-step="down" data-id="${escapeHtml(song.id)}" aria-label="키 한 단계 내리기"${pitch <= PITCH_MIN ? " disabled" : ""}>▼</button>
    <span class="musicbook-pitch-stepper-value musicbook-pitch-tag musicbook-pitch-tag--${pitchSignClass(pitch)}">${escapeHtml(label)}</span>
    <button type="button" class="musicbook-pitch-step" data-pitch-step="up" data-id="${escapeHtml(song.id)}" aria-label="키 한 단계 올리기"${pitch >= PITCH_MAX ? " disabled" : ""}>▲</button>
  </div>`;
}

function renderNoteDisplay(song, { empty = "placeholder" } = {}) {
  const text = (song.note || "").trim();
  if (!text) {
    if (empty === "omit") return "";
    return `<span class="musicbook-note musicbook-note--empty">비고 없음</span>`;
  }
  return `<p class="musicbook-note">${escapeHtml(text)}</p>`;
}

function renderMetaRowEdit(song) {
  if (song.status === "banned") {
    const noteHtml = renderNoteDisplay(song, { empty: "omit" });
    if (!noteHtml) return "";
    return `<div class="musicbook-meta-row musicbook-meta-row--compact">${noteHtml}</div>`;
  }

  const pitchBlock = renderPitchStepper(song);
  const capsuleBlock = renderCapsuleField(song);

  return `<div class="musicbook-meta-row">
    ${pitchBlock}
    ${capsuleBlock}
    <div class="musicbook-meta-view musicbook-meta-view--note">
      <span class="musicbook-meta-label">비고</span>
      ${renderNoteDisplay(song)}
    </div>
  </div>`;
}

function renderMetaRowView(song) {
  if (song.status === "banned") {
    const noteHtml = renderNoteDisplay(song, { empty: "omit" });
    if (!noteHtml) return "";
    return `<div class="musicbook-meta-row musicbook-meta-row--compact">${noteHtml}</div>`;
  }

  const noteHtml = renderNoteDisplay(song, { empty: "omit" });
  if (!noteHtml) return "";
  return `<div class="musicbook-meta-row musicbook-meta-row--compact">${noteHtml}</div>`;
}

function renderMetaRow(song) {
  return isEditing() ? renderMetaRowEdit(song) : renderMetaRowView(song);
}

function compareText(a, b) {
  return String(a || "").localeCompare(String(b || ""), "ko", { sensitivity: "base" });
}

function compareLikes(a, b) {
  return (Number(b?.likeCount) || 0) - (Number(a?.likeCount) || 0);
}

function sortSongs(songs, sortKey) {
  const list = [...songs];
  const langOrder = Object.fromEntries(LANGUAGE_ORDER.map((id, idx) => [id, idx]));
  list.sort((a, b) => {
    let primary = 0;
    switch (sortKey) {
      case "likes-desc":
        primary = compareLikes(a, b);
        break;
      case "title-desc":
        primary = compareText(b.title, a.title);
        break;
      case "artist-asc": {
        const aa = a.artist || "\uffff";
        const bb = b.artist || "\uffff";
        primary = compareText(aa, bb);
        break;
      }
      case "artist-desc": {
        primary = compareText(b.artist || "", a.artist || "");
        break;
      }
      case "lang-asc": {
        const la = langOrder[a.language] ?? 9;
        const lb = langOrder[b.language] ?? 9;
        primary = la - lb;
        break;
      }
      case "capsule-asc": {
        const capOrder = Object.fromEntries(proficiencySortOrder().map((id, idx) => [id, idx]));
        const pa = a.capsule ? (capOrder[a.capsule] ?? 98) : 99;
        const pb = b.capsule ? (capOrder[b.capsule] ?? 98) : 99;
        primary = pa - pb;
        break;
      }
      case "order-asc": {
        const oa = Number(a.sortOrder) || 0;
        const ob = Number(b.sortOrder) || 0;
        primary = oa - ob;
        break;
      }
      case "updated-desc":
        primary = String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
        break;
      case "title-asc":
      default:
        primary = compareText(a.title, b.title);
        break;
    }
    if (primary !== 0) return primary;
    // 최근 수정: 하트(좋아요)는 수정이 아니므로 2차 정렬에 쓰지 않음
    if (sortKey !== "likes-desc" && sortKey !== "updated-desc") {
      const likes = compareLikes(a, b);
      if (likes !== 0) return likes;
    }
    return (
      compareText(a.title, b.title) ||
      compareText(a.artist, b.artist) ||
      compareText(a.id, b.id)
    );
  });
  return list;
}

function filterSongsByStatus(songs, status) {
  const q = state.search.trim().toLowerCase();
  const applyCapsuleFilters = status !== "banned";
  return songs.filter((song) => {
    if (song.status !== status) return false;
    if (applyCapsuleFilters && !songMatchesCapsuleFilters(song)) return false;
    if (!q) return true;

    const title = String(song.title || "").toLowerCase();
    const artist = String(song.artist || "").toLowerCase();
    const note = String(song.note || "").toLowerCase();
    const pitch = formatPitchShift(song.pitchShift).toLowerCase();
    const lang = langLabel(song.language).toLowerCase();
    const prof = (capsuleDef(song.capsule, "proficiency")?.label || "").toLowerCase();

    switch (state.searchScope) {
      case "title":
        return title.includes(q);
      case "artist":
        return artist.includes(q);
      case "all":
      default:
        return [title, artist, note, pitch, lang, prof].join(" ").includes(q);
    }
  });
}

function countByStatus(status) {
  return (state.data?.songs || []).filter((s) => s.status === status).length;
}

function songsForSearchContext() {
  return (state.data?.songs || []).filter((song) => {
    if (song.status === "banned") return true;
    return songMatchesCapsuleFilters(song);
  });
}

function renderSearchFilterContext() {
  if (!els.search) return;
  if (hasActiveCapsuleFilters()) {
    els.search.placeholder = "필터된 목록에서 검색";
    els.search.setAttribute(
      "aria-description",
      "선택한 언어·숙련도·좋아요 필터가 검색과 자동완성에 함께 적용됩니다. 같은 항목은 또는, 항목 사이는 그리고입니다.",
    );
  } else {
    els.search.placeholder = "곡 제목·아티스트 검색";
    els.search.removeAttribute("aria-description");
  }
}

function suggestionItems() {
  const songs = songsForSearchContext();
  if (!songs.length) return [];

  const q = state.search.trim().toLowerCase();
  const scope = state.searchScope || "all";

  const titles = new Map(); // text -> { status, songId }
  const artists = new Map(); // text -> status

  const preferTitle = (prev, song, status) => {
    if (!prev) return { status, songId: song.id };
    if (prev.status === "available") return prev;
    if (status === "available") return { status, songId: song.id };
    return prev;
  };

  const preferAvailable = (prev, next) => {
    if (!prev) return next;
    if (prev === "available") return prev;
    if (next === "available") return next;
    return prev;
  };

  for (const s of songs) {
    const t = String(s.title || "").trim();
    const a = String(s.artist || "").trim();
    const status = s.status === "banned" ? "banned" : "available";
    if (t) titles.set(t, preferTitle(titles.get(t), s, status));
    if (a) artists.set(a, preferAvailable(artists.get(a), status));
  }

  const max = 8;
  const matchTitles = () =>
    [...titles.entries()]
      .filter(([text]) => (!q ? true : String(text).toLowerCase().includes(q)))
      .slice(0, max)
      .map(([text, meta]) => ({ text, status: meta.status, songId: meta.songId }));
  const matchArtists = () =>
    [...artists.entries()]
      .filter(([text]) => (!q ? true : String(text).toLowerCase().includes(q)))
      .slice(0, max)
      .map(([text, status]) => ({ text, status }));

  if (scope === "title")
    return matchTitles().map((it) => ({ kind: "title", ...it }));
  if (scope === "artist")
    return matchArtists().map((it) => ({ kind: "artist", ...it }));

  const mixed = [];
  for (const it of matchTitles()) mixed.push({ kind: "title", ...it });
  for (const it of matchArtists()) mixed.push({ kind: "artist", ...it });
  return mixed.slice(0, max);
}

function closeSearchSuggestions() {
  els.suggestions?.classList.add("hidden");
  els.search?.setAttribute("aria-expanded", "false");
  els.search?.removeAttribute("aria-activedescendant");
  comboboxNav.search.index = -1;
}

function pinComboboxInputValue(inputEl, value, ms = 160) {
  if (!inputEl) return String(value ?? "");
  const text = String(value ?? "");
  inputEl.value = text;
  const pin = { text, until: Date.now() + ms };
  inputEl._comboboxValuePin = pin;
  const enforce = () => {
    const p = inputEl._comboboxValuePin;
    if (!p || p !== pin || Date.now() > pin.until) {
      if (inputEl._comboboxValuePin === pin) inputEl._comboboxValuePin = null;
      return;
    }
    if (inputEl.value !== pin.text) inputEl.value = pin.text;
  };
  enforce();
  requestAnimationFrame(enforce);
  setTimeout(enforce, 0);
  setTimeout(enforce, 30);
  setTimeout(() => {
    enforce();
    if (inputEl._comboboxValuePin === pin) inputEl._comboboxValuePin = null;
  }, ms);
  return text;
}

function enforceComboboxInputPin(inputEl, onCorrected) {
  const pin = inputEl?._comboboxValuePin;
  if (!pin || Date.now() > pin.until) {
    if (inputEl?._comboboxValuePin) inputEl._comboboxValuePin = null;
    return false;
  }
  if (inputEl.value !== pin.text) {
    inputEl.value = pin.text;
    onCorrected?.(pin.text);
    return true;
  }
  return false;
}

function clearComboboxInputPin(inputEl) {
  if (inputEl) inputEl._comboboxValuePin = null;
}

function syncComboboxHighlight(listEl, inputEl, index) {
  if (!listEl || !inputEl) return;
  const options = [...listEl.querySelectorAll(".musicbook-suggestion")];
  options.forEach((el, i) => {
    const active = i === index;
    el.classList.toggle("musicbook-suggestion--active", active);
    el.setAttribute("aria-selected", active ? "true" : "false");
  });
  const activeEl = options[index];
  if (activeEl) {
    inputEl.setAttribute("aria-activedescendant", activeEl.id);
    activeEl.scrollIntoView({ block: "nearest" });
  } else {
    inputEl.removeAttribute("aria-activedescendant");
  }
}

function handleComboboxKeydown(e, navKey, { inputEl, listEl, onSelect, onClose }) {
  if (!inputEl || document.activeElement !== inputEl) return false;
  const open = listEl && !listEl.classList.contains("hidden");
  if (!open) return false;

  const options = [...listEl.querySelectorAll(".musicbook-suggestion")];
  const count = options.length;
  if (!count) return false;

  const nav = comboboxNav[navKey];

  if (e.key === "ArrowDown") {
    e.preventDefault();
    nav.index = nav.index < 0 ? 0 : Math.min(nav.index + 1, count - 1);
    syncComboboxHighlight(listEl, inputEl, nav.index);
    return true;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();
    nav.index = nav.index < 0 ? count - 1 : Math.max(nav.index - 1, 0);
    syncComboboxHighlight(listEl, inputEl, nav.index);
    return true;
  }

  if (e.key === "Enter") {
    const pickIndex = nav.index >= 0 ? nav.index : count === 1 ? 0 : -1;
    if (pickIndex < 0) return false;
    e.preventDefault();
    e.stopPropagation();
    const picked = options[pickIndex];
    const value = picked?.dataset.value;
    if (value != null) {
      nav.index = -1;
      onSelect(value, picked);
    }
    return true;
  }

  if (e.key === "Escape") {
    e.preventDefault();
    nav.index = -1;
    onClose();
    return true;
  }

  return false;
}

function bindComboboxPointerNav(navKey, { listEl, inputEl }) {
  listEl?.addEventListener("mousemove", (e) => {
    const item = e.target.closest(".musicbook-suggestion");
    if (!item || !listEl.contains(item)) return;
    const options = [...listEl.querySelectorAll(".musicbook-suggestion")];
    const idx = options.indexOf(item);
    if (idx < 0 || comboboxNav[navKey].index === idx) return;
    comboboxNav[navKey].index = idx;
    syncComboboxHighlight(listEl, inputEl, idx);
  });
  listEl?.addEventListener("mouseleave", () => {
    if (comboboxNav[navKey].index < 0) return;
    comboboxNav[navKey].index = -1;
    syncComboboxHighlight(listEl, inputEl, -1);
  });
}

function renderSuggestions() {
  if (!els.suggestions) return;
  const items = suggestionItems();
  const focused = document.activeElement === els.search;
  if (!state.search.trim() || !items.length || !focused) {
    closeSearchSuggestions();
    return;
  }

  comboboxNav.search.index = -1;

  els.suggestions.innerHTML = items
    .map((it, idx) => {
      let statusClass = "";
      if (it.status === "banned") {
        statusClass = " musicbook-suggestion--banned";
      } else if (it.kind === "artist") {
        statusClass = " musicbook-suggestion--artist";
      } else {
        statusClass = " musicbook-suggestion--available";
      }
      const songIdAttr = it.songId ? ` data-song-id="${escapeHtml(it.songId)}"` : "";
      return `<li class="musicbook-suggestion${statusClass}" role="option" id="mb-suggest-${idx}" data-value="${escapeHtml(it.text)}" data-kind="${escapeHtml(it.kind)}"${songIdAttr} aria-selected="false" tabindex="-1">
        <span class="musicbook-suggestion-kind">${it.kind === "artist" ? "아티스트" : "제목"}</span>
        <span class="musicbook-suggestion-text">${escapeHtml(it.text)}</span>
      </li>`;
    })
    .join("");
  els.suggestions.classList.remove("hidden");
  els.search?.setAttribute("aria-expanded", "true");
  els.search?.removeAttribute("aria-activedescendant");
}

function applySuggestion(value, optionEl = null) {
  const text = pinComboboxInputValue(els.search, value);
  state.search = text;
  closeSearchSuggestions();
  saveUiPrefs();
  renderLists();

  const kind = optionEl?.dataset?.kind || "";
  const songId = optionEl?.dataset?.songId || "";
  if (kind !== "title" || !songId) return;
  const song = findSong(songId);
  if (!song) return;
  if (isEditing()) openModal(song);
  else openSongDetail(song);
}

function artistNameCounts() {
  const counts = new Map();
  for (const song of state.data?.songs || []) {
    const name = String(song.artist || "").trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

function artistSuggestionItems() {
  const counts = artistNameCounts();
  if (!counts.size) return [];

  const raw = els.songArtist?.value || "";
  const q = raw.trim().toLowerCase();
  let names = [...counts.keys()];
  if (!q) {
    if (raw.trim()) return [];
    names.sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || compareText(a, b));
  } else {
    names = names.filter((name) => name.toLowerCase().includes(q));
    names.sort((a, b) => compareText(a, b));
  }

  return names.slice(0, 8).map((name) => ({ name, count: counts.get(name) || 0 }));
}

function canonicalArtistName(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  for (const name of artistNameCounts().keys()) {
    if (name.toLowerCase() === lower) return name;
  }
  return trimmed;
}

function closeArtistSuggestions() {
  els.artistSuggestions?.classList.add("hidden");
  els.songArtist?.setAttribute("aria-expanded", "false");
  els.songArtist?.removeAttribute("aria-activedescendant");
  comboboxNav.artist.index = -1;
}

function renderArtistSuggestions() {
  if (!els.artistSuggestions || !els.songArtist) return;
  const items = artistSuggestionItems();
  const current = els.songArtist.value.trim();
  if (!items.length || (items.length === 1 && items[0].name === current)) {
    closeArtistSuggestions();
    return;
  }

  comboboxNav.artist.index = -1;

  els.artistSuggestions.innerHTML = items
    .map(
      (it, idx) =>
        `<li class="musicbook-suggestion musicbook-suggestion--artist" role="option" id="mb-artist-suggest-${idx}" data-value="${escapeHtml(it.name)}" aria-selected="false" tabindex="-1">
          <span class="musicbook-suggestion-text">${escapeHtml(it.name)}</span>
          <span class="musicbook-suggestion-meta">${it.count}곡</span>
        </li>`,
    )
    .join("");
  els.artistSuggestions.classList.remove("hidden");
  els.songArtist.setAttribute("aria-expanded", "true");
  els.songArtist.removeAttribute("aria-activedescendant");
}

function applyArtistSuggestion(value) {
  if (!els.songArtist) return;
  pinComboboxInputValue(els.songArtist, value);
  closeArtistSuggestions();
  els.songArtist.focus();
}

function isArtistSort(sortKey) {
  return sortKey === "artist-asc" || sortKey === "artist-desc";
}

function isLangSort(sortKey) {
  return sortKey === "lang-asc";
}

function isCapsuleSort(sortKey) {
  return sortKey === "capsule-asc";
}

function proficiencySortOrder() {
  return orderedCapsuleEntries("proficiency").map(([id]) => id);
}

function groupSongsByArtist(songs) {
  const groups = [];
  let current = null;
  for (const song of songs) {
    const key = String(song.artist || "").trim();
    if (!current || current.key !== key) {
      current = { key, songs: [song] };
      groups.push(current);
    } else {
      current.songs.push(song);
    }
  }
  return groups;
}

function groupSongsByLanguage(songs) {
  const groups = [];
  let current = null;
  for (const song of songs) {
    const key = String(song.language || "").trim().toUpperCase();
    if (!current || current.key !== key) {
      current = { key, songs: [song] };
      groups.push(current);
    } else {
      current.songs.push(song);
    }
  }
  return groups;
}

function groupSongsByCapsule(songs) {
  const groups = [];
  let current = null;
  for (const song of songs) {
    const key = String(song.capsule || "").trim();
    if (!current || current.key !== key) {
      current = { key, songs: [song] };
      groups.push(current);
    } else {
      current.songs.push(song);
    }
  }
  return groups;
}

function languageGroupHeaderClass(langId) {
  const id = String(langId || "").toUpperCase();
  if (id === "K") return "musicbook-group-header--lang-k";
  if (id === "J") return "musicbook-group-header--lang-j";
  if (id === "E") return "musicbook-group-header--lang-e";
  return "musicbook-group-header--lang-none";
}

function renderLanguageGroupHeader(langId, count) {
  const cap = languageCapsuleDef(langId);
  const label = cap?.label || langLabel(langId) || "언어 미지정";
  const langClass = languageGroupHeaderClass(langId);
  const swatch = cap
    ? `<span class="musicbook-group-lang-swatch" style="background:${escapeHtml(cap.bg)}" aria-hidden="true"></span>`
    : "";
  return `<div class="musicbook-group-header musicbook-group-header--lang ${langClass}">
    <span class="musicbook-group-title musicbook-group-title--lang">${swatch}${escapeHtml(label)}</span>
    <span class="musicbook-group-count">${count}곡</span>
  </div>`;
}

function renderCapsuleGroupHeader(capsuleId, count) {
  const cap = capsuleDef(capsuleId, "proficiency");
  const label = cap?.label || (capsuleId ? capsuleId : "숙련도 미지정");
  const style = cap ? `--cap-bg:${escapeHtml(cap.bg)};--cap-text:${escapeHtml(cap.text)}` : "";
  const headerClass = cap
    ? "musicbook-group-header musicbook-group-header--capsule"
    : "musicbook-group-header musicbook-group-header--capsule musicbook-group-header--capsule-none";
  const swatch = cap
    ? `<span class="musicbook-group-capsule-swatch" style="background:${escapeHtml(cap.bg)}" aria-hidden="true"></span>`
    : "";
  return `<div class="${headerClass}"${style ? ` style="${style}"` : ""}>
    <span class="musicbook-group-title musicbook-group-title--capsule">${swatch}${escapeHtml(label)}</span>
    <span class="musicbook-group-count">${count}곡</span>
  </div>`;
}

function renderArtistGroupHeader(artist, count, songIds = []) {
  const label = artist || "아티스트 미상";
  const idsAttr = escapeHtml(songIds.join(","));
  if (isEditing()) {
    return `<div class="musicbook-group-header musicbook-group-header--artist musicbook-group-header--editable" data-stop-edit>
      <form class="musicbook-group-artist-form" data-song-ids="${idsAttr}" data-artist-from="${escapeHtml(artist)}">
        <label class="musicbook-group-artist-label">
          <span class="visually-hidden">아티스트</span>
          <input
            type="text"
            class="musicbook-input musicbook-input--sm musicbook-group-artist-input"
            value="${escapeHtml(artist)}"
            maxlength="200"
            placeholder="아티스트명"
            aria-label="아티스트 일괄 수정"
          />
        </label>
        <button type="submit" class="btn btn-primary btn-sm musicbook-group-artist-save">적용</button>
        <span class="musicbook-group-count">${count}곡</span>
      </form>
    </div>`;
  }
  return `<div class="musicbook-group-header musicbook-group-header--artist">
    <span class="musicbook-group-title">${escapeHtml(label)}</span>
    <span class="musicbook-group-count">${count}곡</span>
  </div>`;
}

async function updateGroupArtist(songIds, newArtist) {
  if (!isEditing() || !state.data || !songIds.length) return;
  const artist = newArtist.trim();
  const idSet = new Set(songIds);
  const now = new Date().toISOString();

  state.data.songs = (state.data.songs || []).map((s) => {
    if (!idSet.has(s.id)) return s;
    const updated = { ...s, updatedAt: now, artist };
    return updated;
  });

  renderLists();
  try {
    await persistMusicbook();
  } catch {
    /* status shown */
  }
}

function renderCardBadges(song, { hideLanguage = false, hideProficiency = false, inline = false } = {}) {
  const lang = !hideLanguage && song.language ? renderCapsuleBadge(song.language, "language") : "";
  const capsule = !hideProficiency && song.capsule ? renderCapsuleBadge(song.capsule, "proficiency") : "";
  const pitch = currentPitchValue(song) !== 0 ? renderPitchDisplay(song) : "";
  const yt = renderYoutubeLink(song.youtubeUrl);
  const inner = `${lang}${capsule}${pitch}${yt}`;
  if (!inner) return "";
  if (inline) return inner;
  return `<div class="musicbook-card-badges">${inner}</div>`;
}

function renderLikeButton(song, { detail = false } = {}) {
  const count = Number(song.likeCount) || 0;
  const liked = Boolean(song.likedByMe);
  const label = liked ? "좋아요 취소" : "좋아요";
  const cls = [
    "musicbook-like-btn",
    liked ? "musicbook-like-btn--active" : "",
    detail ? "musicbook-like-btn--detail" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<button type="button" class="${cls}" data-action="musicbook-like" data-id="${escapeHtml(song.id)}" aria-pressed="${liked ? "true" : "false"}" aria-label="${escapeHtml(label)} ${count}개">
    ${LIKE_ICON}<span class="musicbook-like-count">${count}</span>
  </button>`;
}

function syncModalOpenClass() {
  const open =
    !els.modal?.classList.contains("hidden") ||
    !els.detailModal?.classList.contains("hidden") ||
    !els.capsuleAddModal?.classList.contains("hidden");
  document.body.classList.toggle("modal-open", open);
}

function renderDetailMedia(url) {
  const videoId = parseYoutubeVideoId(url);
  if (!videoId) return "";
  const href = displayYoutubeUrl(url) || url;
  const fallbacks = [
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
  ];
  return `<a href="${escapeHtml(href)}" class="musicbook-detail-media" target="_blank" rel="noopener noreferrer" aria-label="유튜브에서 보기">
    <img
      class="musicbook-detail-media-img"
      src="${escapeHtml(fallbacks[0])}"
      alt=""
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
      data-yt-thumb
      data-yt-fallbacks="${escapeHtml(fallbacks.slice(1).join("|"))}"
    />
    <span class="musicbook-detail-media-badge" aria-hidden="true">${YT_ICON}</span>
  </a>`;
}

function isBlankYoutubeThumbnail(img) {
  if (!img) return true;
  const w = Number(img.naturalWidth) || 0;
  const h = Number(img.naturalHeight) || 0;
  // YouTube's classic unavailable placeholder is 120x90.
  return w < 121 || h < 91;
}

function hideDetailMediaSection(section) {
  if (!section) return;
  section.hidden = true;
  section.classList.add("is-hidden");
}

function bindDetailMediaFallback(root) {
  const scope = root || els.detailBody;
  if (!scope) return;
  scope.querySelectorAll("[data-yt-thumb]").forEach((img) => {
    const section = img.closest("[data-yt-section]");
    const fallbacks = String(img.dataset.ytFallbacks || "")
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean);

    const hide = () => hideDetailMediaSection(section);
    const tryNextOrHide = () => {
      const next = fallbacks.shift();
      if (!next) {
        hide();
        return;
      }
      img.dataset.ytFallbacks = fallbacks.join("|");
      img.src = next;
    };
    const check = () => {
      if (isBlankYoutubeThumbnail(img)) tryNextOrHide();
    };

    img.addEventListener("error", tryNextOrHide);
    if (img.complete) check();
    else img.addEventListener("load", check);
  });
}

function renderSongDetailBody(song) {
  if (!song) return "";
  const isBanned = song.status === "banned";
  const likeBtn = isBanned ? "" : renderLikeButton(song, { detail: true });
  const pitch = currentPitchValue(song);
  const pitchText = pitchLabel(pitch);
  const note = String(song.note || "").trim();
  const youtubeUrl = displayYoutubeUrl(song.youtubeUrl) || String(song.youtubeUrl || "").trim();
  const languageText =
    !isBanned && song.language
      ? languageCapsuleDef(song.language)?.label || langLabel(song.language)
      : "";
  const proficiencyText =
    !isBanned && song.capsule
      ? capsuleDef(song.capsule, "proficiency")?.label || song.capsule
      : "";
  const infoItems = [
    !isBanned && languageText ? { label: "언어", value: languageText } : null,
    !isBanned && proficiencyText ? { label: "숙련도", value: proficiencyText } : null,
    !isBanned ? { label: "음정", value: pitchText } : null,
    !isBanned ? { label: "좋아요", html: likeBtn } : null,
  ].filter(Boolean);
  const infoGrid = infoItems
    .map(
      (item) => `<div class="musicbook-detail-meta-item${item.className || ""}">
        <dt>${escapeHtml(item.label)}</dt>
        <dd>${item.html || escapeHtml(item.value)}</dd>
      </div>`,
    )
    .join("");

  const videoBlock = youtubeUrl
    ? `<section class="musicbook-detail-section musicbook-detail-section--media" data-yt-section aria-label="유튜브">
        ${renderDetailMedia(youtubeUrl)}
      </section>`
    : "";

  const noteBlock = note
    ? `<section class="musicbook-detail-section">
        <div class="musicbook-detail-section-label">비고</div>
        <div class="musicbook-detail-note">${escapeHtml(note)}</div>
      </section>`
    : "";

  return `
    <header class="musicbook-detail-hero${isBanned ? " is-banned" : ""}">
      <div class="musicbook-detail-hero-copy">
        <h4 class="musicbook-detail-title">${escapeHtml(song.title || "")}</h4>
        ${song.artist ? `<p class="musicbook-detail-artist">${escapeHtml(song.artist)}</p>` : ""}
      </div>
    </header>
    ${infoItems.length ? `<dl class="musicbook-detail-meta is-count-${infoItems.length}">${infoGrid}</dl>` : ""}
    ${videoBlock}
    ${noteBlock}`;
}

function openSongDetail(song) {
  if (!song || !els.detailModal) return;
  state.detailTarget = song;
  els.detailModal.classList.toggle("is-banned", song.status === "banned");
  if (els.detailBody) els.detailBody.innerHTML = renderSongDetailBody(song);
  bindDetailMediaFallback(els.detailBody);
  if (els.detailTitle) {
    els.detailTitle.textContent = song.status === "banned" ? "금지곡 정보" : "노래 정보";
  }
  els.detailEditBtn?.classList.toggle("hidden", !(isEditing() && song));
  els.detailModal.classList.remove("hidden");
  els.detailModal.setAttribute("aria-hidden", "false");
  syncModalOpenClass();
}

function closeSongDetail() {
  state.detailTarget = null;
  els.detailModal?.classList.remove("is-banned");
  els.detailModal?.classList.add("hidden");
  els.detailModal?.setAttribute("aria-hidden", "true");
  if (els.detailBody) els.detailBody.innerHTML = "";
  syncModalOpenClass();
}

function refreshSongDetailIfOpen(songId) {
  if (!state.detailTarget || state.detailTarget.id !== songId) return;
  const song = findSong(songId);
  if (!song) {
    closeSongDetail();
    return;
  }
  state.detailTarget = song;
  els.detailModal?.classList.toggle("is-banned", song.status === "banned");
  if (els.detailBody) els.detailBody.innerHTML = renderSongDetailBody(song);
  bindDetailMediaFallback(els.detailBody);
}

async function handleMusicbookLikeClick(btn) {
  const id = btn?.dataset?.id;
  if (!id || btn.disabled) return;
  if (!state.me?.loggedIn) {
    window.location.href = loginUrl(`${location.pathname}${location.search}`);
    return;
  }

  btn.disabled = true;
  try {
    const res = await apiFetch(`/api/musicbook/${encodeURIComponent(id)}/like`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.location.href = loginUrl(`${location.pathname}${location.search}`);
        return;
      }
      throw new Error(err.hint || err.error || "좋아요 처리에 실패했습니다.");
    }
    const result = await res.json();
    const song = findSong(id);
    if (song) {
      song.likeCount = Number(result.likeCount) || 0;
      song.likedByMe = Boolean(result.likedByMe);
    }
    renderLists();
    refreshSongDetailIfOpen(id);
  } catch (err) {
    btn.disabled = false;
    setStatus(err.message, "error");
  }
}

function renderSongItem(song, { status, sortKey, compact = false, hideArtist = false, hideLanguage = false, hideProficiency = false }) {
  const isBanned = status === "banned";
  const badgesHtml = isBanned
    ? ""
    : renderCardBadges(song, { hideLanguage, hideProficiency, inline: true });

  const artistInline =
    !hideArtist && song.artist
      ? `<span class="musicbook-artist-inline"> · ${escapeHtml(song.artist)}</span>`
      : "";

  const likeHtml = isBanned ? "" : renderLikeButton(song);
  const titleLine = `<div class="musicbook-title-line">
      <div class="musicbook-title-main">
        <h3 class="musicbook-song-title">${escapeHtml(song.title)}</h3>${artistInline}
      </div>
    </div>`;

  const metaRow = renderMetaRow(song);

  const cardClass = [
    "hl-card",
    "musicbook-card",
    isBanned ? "musicbook-card--banned" : "",
    likeHtml ? "musicbook-card--has-like" : "",
    isEditing() ? "musicbook-card--has-edit musicbook-card--editable" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<li class="highlight-item musicbook-item" data-id="${escapeHtml(song.id)}" data-status="${status}" data-lang="${escapeHtml(song.language || "")}">
    <div class="${cardClass}">
      <div class="hl-body musicbook-body">
        ${titleLine}
        ${badgesHtml ? `<div class="musicbook-inline-badges musicbook-inline-badges--below">${badgesHtml}</div>` : ""}
        ${metaRow}
      </div>
      ${likeHtml}
      ${isEditing() ? `<button type="button" class="musicbook-edit-btn" data-id="${escapeHtml(song.id)}" aria-label="곡 정보 수정">✎</button>` : ""}
    </div>
  </li>`;
}

function renderSongItemsHtml(songs, itemOptions) {
  return songs.map((song) => renderSongItem(song, itemOptions)).join("");
}

function renderMusicbookGroupBlock(headerHtml, songs, itemOptions) {
  if (!songs.length) return "";
  return `<li class="musicbook-group">
    ${headerHtml}
    <ul class="musicbook-group-list">${renderSongItemsHtml(songs, itemOptions)}</ul>
  </li>`;
}

function renderColumn(status, { listEl, emptyEl, countEl, sortKey, compact = false }) {
  const all = state.data?.songs || [];
  const filtered = filterSongsByStatus(all, status);
  const sorted = sortSongs(filtered, sortKey);

  if (countEl) {
    const total = countByStatus(status);
    const shown = sorted.length;
    const showFilteredCount =
      status === "banned" ? Boolean(state.search.trim()) : hasActiveCapsuleFilters() || state.search.trim();
    countEl.textContent = showFilteredCount ? `${shown}/${total}` : String(total);
  }

  if (!sorted.length) {
    listEl.innerHTML = "";
    const filteredBySearch = Boolean(state.search.trim());
    const filteredByCapsules = status !== "banned" && hasActiveCapsuleFilters();
    const title =
      filteredBySearch || filteredByCapsules
        ? status === "banned"
          ? "검색 조건에 맞는 금지곡이 없습니다."
          : "검색·필터 조건에 맞는 곡이 없습니다."
        : status === "banned"
          ? "등록된 금지곡이 없습니다."
          : "등록된 신청 가능 곡이 없습니다.";
    const hint = filteredBySearch || filteredByCapsules ? "검색어나 필터를 바꿔 보세요." : "";
    setEmptyState(emptyEl, { title, hint });
    return;
  }

  emptyEl.classList.add("hidden");

  if (isArtistSort(sortKey)) {
    const groups = groupSongsByArtist(sorted);
    listEl.innerHTML = groups
      .map(({ key, songs }) =>
        renderMusicbookGroupBlock(
          renderArtistGroupHeader(
            key,
            songs.length,
            songs.map((s) => s.id),
          ),
          songs,
          { status, sortKey, compact, hideArtist: true },
        ),
      )
      .join("");
    return;
  }

  if (isLangSort(sortKey)) {
    const groups = groupSongsByLanguage(sorted);
    listEl.innerHTML = groups
      .map(({ key, songs }) =>
        renderMusicbookGroupBlock(
          renderLanguageGroupHeader(key, songs.length),
          songs,
          { status, sortKey, compact, hideLanguage: true },
        ),
      )
      .join("");
    return;
  }

  if (isCapsuleSort(sortKey)) {
    const groups = groupSongsByCapsule(sorted);
    listEl.innerHTML = groups
      .map(({ key, songs }) =>
        renderMusicbookGroupBlock(
          renderCapsuleGroupHeader(key, songs.length),
          songs,
          { status, sortKey, compact, hideProficiency: true },
        ),
      )
      .join("");
    return;
  }

  listEl.innerHTML = sorted.map((song) => renderSongItem(song, { status, sortKey, compact })).join("");
}

function columnViewKey(status, sortKey) {
  const songs = filterSongsByStatus(state.data?.songs || [], status);
  return sortSongs(songs, sortKey)
    .map((song) => song.id)
    .join("\0");
}

function getListViewSignature() {
  if (!state.data) return null;
  return [
    state.search.trim(),
    state.searchScope || "all",
    JSON.stringify(serializeFilterCapsules()),
    state.sortAvailable,
    state.sortBanned,
    state.editMode ? "1" : "0",
    columnViewKey("available", state.sortAvailable),
    columnViewKey("banned", state.sortBanned),
  ].join("|");
}

function resetMusicbookScroll() {
  document.querySelectorAll(".musicbook-column-body").forEach((el) => {
    el.scrollTop = 0;
  });
  window.scrollTo(0, 0);
}

function renderLists() {
  if (!state.data) return;
  const signature = getListViewSignature();
  const shouldResetScroll = lastListViewSignature !== null && signature !== lastListViewSignature;
  lastListViewSignature = signature;

  renderCapsulesLegend();
  updateFilterToggleUi();
  renderColumn("available", {
    listEl: els.listAvailable,
    emptyEl: els.emptyAvailable,
    countEl: els.countAvailable,
    sortKey: state.sortAvailable,
  });
  renderColumn("banned", {
    listEl: els.listBanned,
    emptyEl: els.emptyBanned,
    countEl: els.countBanned,
    sortKey: state.sortBanned,
    compact: true,
  });

  syncMobileStatusTabCounts();
  applyMobileListTab();

  if (shouldResetScroll) resetMusicbookScroll();
}

async function fetchMusicbook() {
  const res = await fetch(`${BASE}/api/musicbook`, { credentials: "same-origin" });
  if (!res.ok) throw new Error("노래책을 불러오지 못했습니다.");
  return normalizeMusicbookClientPayload(await res.json());
}

async function fetchMyLikedSongIds() {
  if (!state.me?.loggedIn) return [];
  try {
    const res = await fetch(`${BASE}/api/musicbook/my-likes`, { credentials: "same-origin" });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.songIds) ? data.songIds.map((id) => String(id)) : [];
  } catch {
    return [];
  }
}

function applyLikedByMe(songIds = []) {
  const liked = new Set((songIds || []).map((id) => String(id)));
  for (const song of state.data?.songs || []) {
    song.likedByMe = liked.has(String(song.id));
  }
}

async function syncMyLikesIntoState() {
  applyLikedByMe(await fetchMyLikedSongIds());
}

/** 공개 API → 페이지 내부 형태(settings/taxonomy/songs)로 맞춤. 편집자 songs 응답은 그대로. */
function normalizeMusicbookClientPayload(data) {
  if (!data || typeof data !== "object") return data;
  if (Array.isArray(data.songs)) return data;

  const available = Array.isArray(data.availableSongs) ? data.availableSongs : [];
  const banned = Array.isArray(data.bannedSongs) ? data.bannedSongs : [];
  const ui = data.ui && typeof data.ui === "object" ? data.ui : null;
  const settings = ui
    ? {
        defaultTab: ui.defaultTab || "available",
        sortAvailable: ui.sortAvailable || "likes-desc",
        sortBanned: ui.sortBanned || "title-asc",
        fonts: ui.fonts && typeof ui.fonts === "object" ? ui.fonts : {},
      }
    : data.settings && typeof data.settings === "object"
      ? data.settings
      : {};

  const languages =
    (data.languages && typeof data.languages === "object" && data.languages) ||
    data.taxonomy?.languageCapsules ||
    {};
  const capsules =
    (data.capsules && typeof data.capsules === "object" && data.capsules) ||
    data.taxonomy?.capsules ||
    {};

  return {
    version: data.version,
    apiScope: data.apiScope,
    updatedAt: data.updatedAt,
    counts: data.counts,
    settings,
    taxonomy: {
      languageCapsules: languages,
      capsules,
      tags: [],
    },
    availableSongs: available,
    bannedSongs: banned,
    songs: [...available, ...banned],
  };
}

async function reloadMusicbookFromServer() {
  if (isEditing()) return;
  try {
    const musicbook = await fetchMusicbook();
    state.data = musicbook;
    await syncMyLikesIntoState();
    registerAllFontFaces();
    applyMusicbookPageFonts(state.data.settings?.fonts);
    renderLists();
    closeSearchSuggestions();
  } catch {
    /* 다음 주기에 재시도 */
  }
}

async function fetchScheduleMeta() {
  try {
    const res = await fetch(`${BASE}/api/schedule/meta`, { credentials: "same-origin" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function putMusicbookToServer() {
  if (!state.data) return;
  state.saving = true;
  setStatus("저장 중…");
  try {
    const res = await apiFetch("/api/musicbook", {
      method: "PUT",
      body: JSON.stringify({
        version: state.data.version,
        settings: state.data.settings,
        taxonomy: state.data.taxonomy,
        songs: state.data.songs,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.hint || err.error || "저장 실패");
    }
    setStatus("저장됨", "saved");
    void fetchAndRememberRevisions(musicbookContentSync, ["musicbook", "songRequests"]);
  } catch (err) {
    setStatus(err.message, "error");
    throw err;
  } finally {
    state.saving = false;
  }
}

const musicbookPersistQueue = createPersistQueue(putMusicbookToServer);

async function persistMusicbook() {
  if (!isEditing() || !state.data) return;
  await musicbookPersistQueue.persist();
}

function openModal(song = null, defaultStatus = "available") {
  const isEdit = Boolean(song);
  closeSongDetail();
  els.modalTitle.textContent = isEdit ? "곡 수정" : "곡 추가";
  els.songId.value = song?.id || "";
  els.songStatus.value = song?.status || defaultStatus;
  els.songLanguage.value = song?.language || "K";
  fillModalLanguageOptions(song?.language || "K");
  els.songTitle.value = song?.title || "";
  els.songArtist.value = song?.artist || "";
  els.songPitch.value =
    song?.pitchShift != null && song.pitchShift !== 0 ? String(song.pitchShift) : "";
  fillModalCapsuleOptions(song?.capsule || "");
  els.songYoutube.value = song?.youtubeUrl || "";
  els.songNote.value = song?.note || "";
  els.songDelete.classList.toggle("hidden", !isEdit);
  updateLangFieldVisibility();
  closeArtistSuggestions();
  els.modal.classList.remove("hidden");
  els.modal.setAttribute("aria-hidden", "false");
  syncModalOpenClass();
  els.songTitle.focus();
}

function closeModal() {
  els.modal.classList.add("hidden");
  els.modal.setAttribute("aria-hidden", "true");
  closeArtistSuggestions();
  els.form.reset();
  syncModalOpenClass();
}

function updateLangFieldVisibility() {
  const isBanned = els.songStatus.value === "banned";
  els.langWrap.classList.toggle("hidden", isBanned);
  els.pitchWrap?.classList.toggle("hidden", isBanned);
  els.capsuleWrap?.classList.toggle("hidden", isBanned);
  if (els.songNote) {
    els.songNote.placeholder = isBanned
      ? "예: 목이 갈림, 분위기가 안 맞음"
      : "예: ○○ 애니 오프닝, ○○ 방송에서 나온 곡";
  }
}

function findSong(id) {
  return (state.data?.songs || []).find((s) => s.id === id);
}

function nextSortOrder(status) {
  const same = (state.data?.songs || []).filter((s) => s.status === status);
  if (!same.length) return 0;
  return Math.max(...same.map((s) => Number(s.sortOrder) || 0)) + 1;
}

async function saveSongFromForm(e) {
  e.preventDefault();
  if (!isEditing()) return;

  const id = els.songId.value.trim();
  const status = els.songStatus.value;
  const title = els.songTitle.value.trim();
  if (!title) {
    alert("제목을 입력해 주세요.");
    els.songTitle.focus();
    return;
  }
  if (status === "available" && !els.songLanguage.value) {
    alert("언어를 선택해 주세요.");
    els.songLanguage.focus();
    return;
  }

  const now = new Date().toISOString();
  const songs = [...(state.data.songs || [])];
  const idx = id ? songs.findIndex((s) => s.id === id) : -1;
  const existing = idx >= 0 ? songs[idx] : null;
  const pitchParsed = parsePitchInput(els.songPitch.value);
  if (!pitchParsed.ok) {
    alert(pitchParsed.message);
    els.songPitch.focus();
    return;
  }
  const pitchShift = pitchParsed.value;

  const payload = {
    status,
    title,
    artist: canonicalArtistName(els.songArtist.value.trim()),
    note: els.songNote.value.trim(),
    tags: [],
    meta: existing ? { ...(existing.meta || {}) } : {},
  };
  if (status === "available") {
    payload.language = els.songLanguage.value;
  }
  if (pitchShift != null && !Number.isNaN(pitchShift) && pitchShift !== 0) {
    payload.pitchShift = pitchShift;
  }
  const capsuleRaw = els.songCapsule?.value || "";
  if (status === "available" && capsuleRaw) {
    payload.capsule = capsuleRaw;
  }
  const youtubeUrl = els.songYoutube?.value.trim() || "";
  if (youtubeUrl) payload.youtubeUrl = youtubeUrl;

  if (idx >= 0) {
    const updated = { ...songs[idx], ...payload, updatedAt: now };
    if (status === "banned") delete updated.language;
    if (!payload.pitchShift) delete updated.pitchShift;
    if (!payload.capsule) delete updated.capsule;
    if (!payload.youtubeUrl) delete updated.youtubeUrl;
    songs[idx] = updated;
  } else {
    const created = {
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      ...payload,
      sortOrder: nextSortOrder(status),
      createdAt: now,
      updatedAt: now,
    };
    if (!payload.pitchShift) delete created.pitchShift;
    if (!payload.capsule) delete created.capsule;
    if (!payload.youtubeUrl) delete created.youtubeUrl;
    songs.push(created);
  }

  state.data.songs = songs;
  closeModal();
  renderLists();
  try {
    await persistMusicbook();
  } catch {
    /* status shown */
  }
}

async function updateSongField(id, field, rawValue) {
  if (!isEditing() || !state.data) return;
  const songs = state.data.songs || [];
  const idx = songs.findIndex((s) => s.id === id);
  if (idx < 0) return;

  const song = { ...songs[idx] };
  const now = new Date().toISOString();

  if (field === "pitchShift") {
    const parsed = parsePitchInput(rawValue);
    if (!parsed.ok) {
      alert(parsed.message);
      return;
    }
    if (parsed.value != null) {
      song.pitchShift = parsed.value;
    } else {
      delete song.pitchShift;
    }
  } else if (field === "note") {
    song.note = String(rawValue ?? "").trim();
  } else if (field === "capsule") {
    const cap = String(rawValue ?? "").trim();
    if (cap && capsuleDef(cap, "proficiency")) song.capsule = cap;
    else delete song.capsule;
    song.updatedAt = now;
    songs[idx] = song;
    state.data.songs = songs;
    renderLists();
    try {
      await persistMusicbook();
    } catch {
      /* status shown */
    }
    return;
  } else {
    return;
  }

  song.updatedAt = now;
  songs[idx] = song;
  state.data.songs = songs;

  try {
    await persistMusicbook();
  } catch {
    /* status shown */
  }
}

async function adjustPitch(id, delta) {
  if (!isEditing()) return;
  const song = findSong(id);
  if (!song) return;

  const current = currentPitchValue(song);
  const next = Math.max(PITCH_MIN, Math.min(PITCH_MAX, current + delta));
  if (next === current) return;

  await updateSongField(id, "pitchShift", next === 0 ? "" : String(next));
  updatePitchStepperInList(id, next);
}

function updatePitchStepperInList(id, pitch) {
  const item = document.querySelector(`.musicbook-item[data-id="${CSS.escape(id)}"]`);
  if (!item) return;

  const valueEl = item.querySelector(".musicbook-pitch-stepper-value");
  const downBtn = item.querySelector('[data-pitch-step="down"]');
  const upBtn = item.querySelector('[data-pitch-step="up"]');
  if (!valueEl) return;

  const label = pitchLabel(pitch);
  valueEl.textContent = label;
  valueEl.className = `musicbook-pitch-stepper-value musicbook-pitch-tag musicbook-pitch-tag--${pitchSignClass(pitch)}`;
  if (downBtn) downBtn.disabled = pitch <= PITCH_MIN;
  if (upBtn) upBtn.disabled = pitch >= PITCH_MAX;
}

async function deleteSong() {
  const id = els.songId.value.trim();
  if (!id || !isEditing()) return;
  if (!confirm("이 곡을 삭제할까요?")) return;
  state.data.songs = (state.data.songs || []).filter((s) => s.id !== id);
  closeModal();
  renderLists();
  try {
    await persistMusicbook();
  } catch {
    /* status shown */
  }
}

function handleListSubmit(e, listEl) {
  const form = e.target.closest(".musicbook-group-artist-form");
  if (!form || !listEl.contains(form) || !isEditing()) return;
  e.preventDefault();
  const input = form.querySelector(".musicbook-group-artist-input");
  const ids = (form.dataset.songIds || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!ids.length || !input) return;
  updateGroupArtist(ids, input.value);
}

function handleListClick(e, listEl) {
  const likeBtn = e.target.closest('[data-action="musicbook-like"]');
  if (likeBtn && listEl.contains(likeBtn)) {
    e.preventDefault();
    e.stopPropagation();
    void handleMusicbookLikeClick(likeBtn);
    return;
  }

  const stepBtn = e.target.closest("[data-pitch-step]");
  if (stepBtn && listEl.contains(stepBtn)) {
    if (!isEditing() || stepBtn.disabled) return;
    e.stopPropagation();
    const delta = stepBtn.dataset.pitchStep === "up" ? 1 : -1;
    adjustPitch(stepBtn.dataset.id, delta);
    return;
  }

  if (e.target.closest("[data-stop-edit]")) return;
  if (e.target.closest("button, a, select, input, textarea, label")) return;

  const editBtn = e.target.closest(".musicbook-edit-btn");
  if (editBtn && listEl.contains(editBtn)) {
    e.stopPropagation();
    const song = findSong(editBtn.dataset.id);
    if (song) openModal(song);
    return;
  }

  const item = e.target.closest(".musicbook-item[data-id]");
  if (item && listEl.contains(item)) {
    const song = findSong(item.dataset.id);
    if (!song) return;
    if (isEditing()) openModal(song);
    else openSongDetail(song);
  }
}

function handleListChange(e, listEl) {
  if (!isEditing() || !listEl.contains(e.target)) return;
  const select = e.target.closest(".musicbook-capsule-inline");
  if (!select) return;
  const id = select.dataset.id;
  const field = select.dataset.field || "capsule";
  if (!id) return;
  updateSongField(id, field, select.value);
}

function bindCapsuleEditor() {
  if (els.capsulesPanel?._bound) return;
  if (els.capsulesPanel) els.capsulesPanel._bound = true;

  const bindSection = (legendEl) => {
    legendEl?.addEventListener("click", (e) => {
      const item = e.target.closest("[data-capsule-filter]");
      if (!item || !legendEl.contains(item)) return;
      toggleCapsuleFilter(item.dataset.capsuleGroup, item.dataset.capsuleFilter);
    });

    legendEl?.addEventListener("contextmenu", (e) => {
      if (!isEditing()) return;
      const item = e.target.closest("[data-capsule-id]");
      if (!item || !legendEl.contains(item)) return;
      e.preventDefault();
      openCapsuleContextMenu(e, item.dataset.capsuleId, item.dataset.capsuleGroup);
    });
  };

  bindSection(els.langCapsulesLegend);
  bindSection(els.capsulesLegend);
  els.likedFilter?.addEventListener("click", toggleLikedFilter);

  els.capsuleAddBtn?.addEventListener("click", () => openCapsuleAddModal());
  els.capsuleAddForm?.addEventListener("submit", saveCapsuleFromForm);
  els.capsuleAddModal?.querySelector(".capsule-add-backdrop")?.addEventListener("click", closeCapsuleAddModal);
  els.capsuleAddModal?.querySelector(".capsule-add-cancel")?.addEventListener("click", closeCapsuleAddModal);

  els.appliedFiltersList?.addEventListener("click", (e) => {
    const btn = e.target.closest(".musicbook-applied-filter");
    if (!btn) return;
    if (btn.dataset.capsuleGroup === "liked") {
      toggleLikedFilter();
      return;
    }
    toggleCapsuleFilter(btn.dataset.capsuleGroup, btn.dataset.capsuleFilter);
  });
  els.clearFiltersBtn?.addEventListener("click", () => clearAllCapsuleFilters());

  els.capsuleCtxMenu?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-capsule-action]");
    if (!btn || !capsuleCtxTarget || !capsuleCtxGroup) return;
    e.stopPropagation();
    const id = capsuleCtxTarget;
    const group = capsuleCtxGroup;
    const cap = getCapsuleMap(group)[id];
    if (!cap) return;
    if (btn.dataset.capsuleAction === "rename") {
      const next = prompt("캡슐 이름", cap.label || "");
      if (next != null && next.trim()) updateCapsuleField(group, id, "label", next.trim());
    } else if (btn.dataset.capsuleAction === "delete") {
      removeCapsule(group, id);
    }
    closeCapsuleContextMenu();
  });

  els.capsuleColorPicker?.addEventListener("input", (e) => {
    if (!capsuleColorTarget || !capsuleCtxGroup) return;
    updateCapsuleField(capsuleCtxGroup, capsuleColorTarget, "bg", e.target.value);
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest("#capsule-ctx-menu") || e.target.closest("[data-capsule-id]")) return;
    closeCapsuleContextMenu();
  });
}

function bindEvents() {
  els.mobileStatusTabs?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mobile-status]");
    if (!btn) return;
    setMobileListTab(btn.dataset.mobileStatus);
  });

  MOBILE_LIST_MQ.addEventListener("change", () => {
    layoutMobileListChrome();
    applyMobileListTab();
    applyEditMode();
  });

  els.editModeWrap?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-edit-mode]");
    if (!btn || !state.canEdit) return;
    void setMusicbookEditMode(btn.dataset.editMode === "true");
  });

  els.filtersToggle?.addEventListener("click", () => {
    const collapsed = !document.body.classList.contains("musicbook-filters-collapsed");
    setFiltersPanelCollapsed(collapsed);
  });

  els.search.addEventListener("input", () => {
    enforceComboboxInputPin(els.search, (text) => {
      state.search = text;
    });
    state.search = els.search.value;
    saveUiPrefs();
    renderLists();
    renderSuggestions();
  });

  els.search.addEventListener("compositionend", () => {
    if (
      enforceComboboxInputPin(els.search, (text) => {
        state.search = text;
        saveUiPrefs();
        renderLists();
      })
    ) {
      closeSearchSuggestions();
    }
  });

  els.searchScope?.addEventListener("change", () => {
    state.searchScope = els.searchScope.value || "all";
    saveUiPrefs();
    renderLists();
    renderSuggestions();
  });

  els.sortAvailable.addEventListener("change", async () => {
    state.sortAvailable = els.sortAvailable.value;
    const settings = state.data.settings || (state.data.settings = {});
    settings.sortAvailable = state.sortAvailable;
    saveUiPrefs();
    renderLists();
    if (state.canEdit) {
      try {
        await persistMusicbook();
      } catch {
        /* status shown */
      }
    }
  });

  els.sortBanned.addEventListener("change", async () => {
    state.sortBanned = els.sortBanned.value;
    const settings = state.data.settings || (state.data.settings = {});
    settings.sortBanned = state.sortBanned;
    saveUiPrefs();
    renderLists();
    if (state.canEdit) {
      try {
        await persistMusicbook();
      } catch {
        /* status shown */
      }
    }
  });

  els.addAvailable.addEventListener("click", () => openModal(null, "available"));
  els.addBanned.addEventListener("click", () => openModal(null, "banned"));

  els.listAvailable.addEventListener("click", (e) => handleListClick(e, els.listAvailable));
  els.listBanned.addEventListener("click", (e) => handleListClick(e, els.listBanned));
  els.listAvailable.addEventListener("submit", (e) => handleListSubmit(e, els.listAvailable));
  els.listBanned.addEventListener("submit", (e) => handleListSubmit(e, els.listBanned));
  els.listAvailable.addEventListener("change", (e) => handleListChange(e, els.listAvailable));
  els.listBanned.addEventListener("change", (e) => handleListChange(e, els.listBanned));

  bindCapsuleEditor();

  els.suggestions?.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".musicbook-suggestion");
    if (!item) return;
    e.preventDefault();
    comboboxNav.search.index = -1;
    applySuggestion(item.dataset.value || "", item);
  });

  els.search?.addEventListener("keydown", (e) => {
    const handled = handleComboboxKeydown(e, "search", {
      inputEl: els.search,
      listEl: els.suggestions,
      onSelect: (value, optionEl) => applySuggestion(value, optionEl),
      onClose: closeSearchSuggestions,
    });
    if (handled) return;
    if (
      e.key === "Backspace" ||
      e.key === "Delete" ||
      (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)
    ) {
      clearComboboxInputPin(els.search);
    }
  });
  els.search?.addEventListener("focus", () => renderSuggestions());
  els.search?.addEventListener("blur", () => {
    setTimeout(() => closeSearchSuggestions(), 120);
  });

  bindComboboxPointerNav("search", { listEl: els.suggestions, inputEl: els.search });

  els.songArtist?.addEventListener("input", () => renderArtistSuggestions());
  els.songArtist?.addEventListener("keydown", (e) => {
    handleComboboxKeydown(e, "artist", {
      inputEl: els.songArtist,
      listEl: els.artistSuggestions,
      onSelect: applyArtistSuggestion,
      onClose: closeArtistSuggestions,
    });
  });
  els.songArtist?.addEventListener("focus", () => renderArtistSuggestions());
  els.songArtist?.addEventListener("blur", () => {
    setTimeout(() => closeArtistSuggestions(), 120);
  });
  els.artistSuggestions?.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".musicbook-suggestion");
    if (!item) return;
    e.preventDefault();
    comboboxNav.artist.index = -1;
    applyArtistSuggestion(item.dataset.value || "");
  });

  bindComboboxPointerNav("artist", { listEl: els.artistSuggestions, inputEl: els.songArtist });

  els.form.addEventListener("submit", saveSongFromForm);
  els.songDelete.addEventListener("click", deleteSong);
  els.modal.querySelector(".slot-edit-backdrop")?.addEventListener("click", closeModal);
  els.modal.querySelector(".song-modal-cancel")?.addEventListener("click", closeModal);
  els.detailModal?.querySelector(".musicbook-detail-backdrop")?.addEventListener("click", closeSongDetail);
  els.detailModal?.querySelector(".musicbook-detail-close")?.addEventListener("click", closeSongDetail);
  els.detailBody?.addEventListener("click", (e) => {
    const likeBtn = e.target.closest('[data-action="musicbook-like"]');
    if (likeBtn && els.detailBody.contains(likeBtn)) {
      e.preventDefault();
      void handleMusicbookLikeClick(likeBtn);
    }
  });
  els.detailEditBtn?.addEventListener("click", () => {
    const song = state.detailTarget ? findSong(state.detailTarget.id) : null;
    if (song) openModal(song);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!els.capsuleAddModal?.classList.contains("hidden")) {
      closeCapsuleAddModal();
      return;
    }
    if (!els.modal.classList.contains("hidden")) {
      closeModal();
      return;
    }
    if (!els.detailModal?.classList.contains("hidden")) closeSongDetail();
  });
}

function updateEditModeButtons() {
  if (!els.editModeWrap) return;
  for (const btn of els.editModeWrap.querySelectorAll(".links-mode-btn")) {
    const wantEdit = btn.dataset.editMode === "true";
    const active = wantEdit ? state.editMode : !state.editMode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

async function setMusicbookEditMode(enabled) {
  const wasEditing = isEditing();
  const nextEdit = Boolean(state.canEdit && enabled);

  if (wasEditing && !nextEdit) {
    await musicbookPersistQueue.flush();
  }

  if (!state.canEdit) {
    state.editMode = false;
  } else {
    state.editMode = nextEdit;
  }
  if (!state.editMode && els.modal && !els.modal.classList.contains("hidden")) {
    closeModal();
  }
  if (!state.editMode) closeCapsuleAddModal();
  closeCapsuleContextMenu();
  saveUiPrefs();
  applyEditMode();
  renderLists();

  if (nextEdit && !wasEditing) {
    await reloadMusicbookFromServer();
  } else if (wasEditing && !state.editMode) {
    await reloadMusicbookFromServer();
    musicbookContentSync?.clearPendingRemoteSync?.();
  }
  musicbookContentSync?.refresh?.();
}

function applyEditMode() {
  const editing = isEditing();
  const mobile = isMobileMusicbookLayout();
  document.body.classList.toggle("edit-mode", editing);
  els.editModeWrap?.classList.toggle("hidden", !state.canEdit);
  updateEditModeButtons();
  for (const [status, btn] of [
    ["available", els.addAvailable],
    ["banned", els.addBanned],
  ]) {
    if (!btn) continue;
    const show = editing && (!mobile || state.mobileListTab === status);
    btn.hidden = !show;
    btn.classList.toggle("hidden", !show);
  }
  if (els.capsuleAddBtn) {
    els.capsuleAddBtn.hidden = !editing;
    els.capsuleAddBtn.classList.toggle("hidden", !editing);
  }
  els.fontPanel?.classList.toggle("hidden", !editing);
  state.fontSettings?.setCanEdit(editing);
  renderCapsuleSections();
}

async function init() {
  els.status = document.getElementById("musicbook-status");
  els.filtersToggle = document.getElementById("musicbook-filters-toggle");
  els.filtersToggleCount = document.getElementById("musicbook-filters-toggle-count");
  els.listAvailable = document.getElementById("musicbook-list-available");
  els.listBanned = document.getElementById("musicbook-list-banned");
  els.emptyAvailable = document.getElementById("musicbook-empty-available");
  els.emptyBanned = document.getElementById("musicbook-empty-banned");
  els.search = document.getElementById("musicbook-search");
  els.searchScope = document.getElementById("musicbook-search-scope");
  els.suggestions = document.getElementById("musicbook-search-suggestions");
  els.sortAvailable = document.getElementById("musicbook-sort-available");
  els.sortBanned = document.getElementById("musicbook-sort-banned");
  els.addAvailable = document.getElementById("musicbook-add-available");
  els.addBanned = document.getElementById("musicbook-add-banned");
  els.countAvailable = document.getElementById("count-available");
  els.countBanned = document.getElementById("count-banned");
  els.mobileStatusTabs = document.getElementById("musicbook-mobile-status-tabs");
  cacheChromeLayout();
  layoutMobileListChrome();
  els.editModeWrap = document.getElementById("musicbook-edit-mode-wrap");
  els.fontPanel = document.getElementById("musicbook-font-panel");
  els.modal = document.getElementById("song-modal");
  els.modalTitle = document.getElementById("song-modal-title");
  els.detailModal = document.getElementById("musicbook-detail-modal");
  els.detailTitle = document.getElementById("musicbook-detail-title");
  els.detailBody = document.getElementById("musicbook-detail-body");
  els.detailEditBtn = document.getElementById("musicbook-detail-edit");
  els.form = document.getElementById("song-form");
  els.songId = document.getElementById("song-id");
  els.songStatus = document.getElementById("song-status");
  els.songLanguage = document.getElementById("song-language");
  els.langWrap = document.getElementById("song-lang-wrap");
  els.pitchWrap = document.getElementById("song-pitch-wrap");
  els.capsuleWrap = document.getElementById("song-capsule-wrap");
  els.capsulesPanel = document.getElementById("musicbook-capsules-panel");
  els.langCapsulesLegend = document.getElementById("musicbook-lang-capsules");
  els.capsulesLegend = document.getElementById("musicbook-capsules");
  els.likedFilter = document.getElementById("musicbook-liked-filter");
  els.capsuleAddBtn = document.getElementById("capsule-add-btn");
  els.appliedFilters = document.getElementById("musicbook-applied-filters");
  els.appliedFiltersList = document.getElementById("musicbook-applied-filters-list");
  els.clearFiltersBtn = document.getElementById("musicbook-clear-filters");
  els.capsuleAddModal = document.getElementById("capsule-add-modal");
  els.capsuleAddForm = document.getElementById("capsule-add-form");
  els.capsuleAddGroup = document.getElementById("capsule-add-group");
  els.capsuleAddLabel = document.getElementById("capsule-add-label");
  els.capsuleAddColor = document.getElementById("capsule-add-color");
  els.capsuleCtxMenu = document.getElementById("capsule-ctx-menu");
  els.capsuleColorPicker = document.getElementById("capsule-color-picker");
  els.songTitle = document.getElementById("song-title");
  els.songArtist = document.getElementById("song-artist");
  els.artistSuggestions = document.getElementById("song-artist-suggestions");
  els.songPitch = document.getElementById("song-pitch");
  els.songCapsule = document.getElementById("song-capsule");
  els.songYoutube = document.getElementById("song-youtube");
  els.songNote = document.getElementById("song-note");
  els.songDelete = document.getElementById("song-delete-btn");

  const navSchedule = document.getElementById("nav-schedule");
  if (navSchedule) navSchedule.href = calendarPath();

  let filtersCollapsed = false;
  try {
    const stored = localStorage.getItem("musicbook-filters-collapsed");
    if (stored === "1") filtersCollapsed = true;
    else if (stored === "0") filtersCollapsed = false;
    else if (MOBILE_LIST_MQ.matches) filtersCollapsed = true;
  } catch {
    if (MOBILE_LIST_MQ.matches) filtersCollapsed = true;
  }
  setFiltersPanelCollapsed(filtersCollapsed);
  updateFilterToggleUi();

  const authErr = consumeAuthErrorFromUrl();
  if (authErr) setStatus(authErr, "error");

  bindEvents();

  try {
    const [me, config, musicbook, schedule] = await Promise.all([
      fetchMe(),
      fetchAuthConfig(),
      fetchMusicbook(),
      fetchScheduleMeta(),
    ]);

    state.me = me;
    state.canEdit = canEditMusicbook(me);
    state.data = musicbook;
    state.scheduleMeta = schedule;
    await syncMyLikesIntoState();

    document.getElementById("beta-badge")?.classList.toggle("hidden", !config.isBeta);
    document.documentElement.classList.toggle("is-beta", !!config.isBeta);

    registerAllFontFaces();
    applyMusicbookPageFonts(state.data.settings?.fonts);
    if (schedule?.brandColor) applyBrandTheme(schedule.brandColor);

    state.fontSettings = initPageFontSettings({
      container: document.getElementById("musicbook-font-options"),
      creditEl: document.getElementById("musicbook-font-credit"),
      canEdit: state.canEdit && state.editMode,
      prefix: "musicbook",
      labels: {
        title: "곡 제목",
        titleHint: "신청 가능·금지곡 목록의 곡 이름",
        note: "비고",
        noteHint: "곡 카드의 비고 텍스트",
        capsule: "캡슐",
        capsuleHint: "언어·숙련도 뱃지·필터 캡슐",
      },
      normalizeFonts: normalizeMusicbookPageFonts,
      applyFonts: applyMusicbookPageFonts,
      renderOptions: renderMusicbookFontOptions,
      bindOptions: bindTieredFontOptions,
      getCreditFontIds: (fonts) => [fonts.titleFont, fonts.noteFont, fonts.capsuleFont],
      getFonts: () => state.data?.settings?.fonts,
      onFontsChange: async (fonts) => {
        state.data.settings = { ...(state.data.settings || {}), fonts };
        await persistMusicbook();
      },
    });

    renderModeControl(document.getElementById("mode-control"), me, config, {
      onChange: (next) => {
        state.me = next;
        if (!next?.loggedIn && state.likedOnly) {
          state.likedOnly = false;
          saveUiPrefs();
        }
        state.canEdit = canEditMusicbook(next);
        if (!state.canEdit) state.editMode = false;
        state.fontSettings?.setCanEdit(state.canEdit && state.editMode);
        applyEditMode();
        renderLists();
        void reloadMusicbookFromServer();
      },
    });

    const prefs = loadUiPrefs();
    const settings = musicbook.settings || {};
    state.sortAvailable = prefs.sortAvailable || settings.sortAvailable || "likes-desc";
    state.sortBanned = prefs.sortBanned || settings.sortBanned || "title-asc";
    if (state.sortAvailable === "order-asc") state.sortAvailable = "likes-desc";
    if (state.sortBanned === "order-asc") state.sortBanned = "title-asc";
    state.mobileListTab = prefs.mobileListTab === "banned" ? "banned" : "available";
    restoreFilterCapsules(prefs.filterCapsules);
    state.likedOnly = Boolean(me?.loggedIn && prefs.likedOnly);
    state.editMode = false;

    fillModalLanguageOptions("K");
    fillModalCapsuleOptions("");

    els.search.value = "";
    els.sortAvailable.value = state.sortAvailable;
    els.sortBanned.value = state.sortBanned;
    if (els.searchScope) els.searchScope.value = "all";
    applyEditMode();
    renderLists();
    closeSearchSuggestions();

    const notifWatcher = startSongRequestNotificationWatcher({
      isLoggedIn: () => Boolean(state.me?.loggedIn),
    });

    musicbookContentSync = startContentSync({
      resources: ["musicbook", "songRequests"],
      shouldSync: () => !isEditing(),
      authSync: true,
      initialMe: me,
      onAuthChange: (next) => {
        state.me = next;
        if (!next?.loggedIn && state.likedOnly) {
          state.likedOnly = false;
          saveUiPrefs();
        }
        state.canEdit = canEditMusicbook(next);
        if (!state.canEdit) state.editMode = false;
        state.fontSettings?.setCanEdit(state.canEdit && state.editMode);
        renderModeControl(document.getElementById("mode-control"), next, config);
        applyEditMode();
        renderLists();
        void reloadMusicbookFromServer();
        musicbookContentSync?.refresh?.();
        if (next?.loggedIn) void notifWatcher.poll();
      },
      onUpdate: async () => {
        await notifWatcher.poll();
        await reloadMusicbookFromServer();
      },
    });
  } catch (err) {
    setStatus(err.message, "error");
    els.emptyAvailable.classList.remove("hidden");
    const titleEl = els.emptyAvailable.querySelector(".highlights-empty-title");
    if (titleEl) titleEl.textContent = err.message;
    const hintEl = els.emptyAvailable.querySelector(".musicbook-empty-hint");
    if (hintEl) hintEl.classList.add("hidden");
  }
}

init();
