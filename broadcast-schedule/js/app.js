import { apiFetch, fetchAuthConfig, fetchMe, renderModeControl, consumeAuthErrorFromUrl } from "./auth.js";
import {
  canEditCalendar,
  canEditScheduleDesign,
  canEditScheduleMeta,
  canEditScheduleSlots,
} from "./permissions.js";
import { setupCalendarSubscribe } from "./calendar-subscribe.js?v=gcal-webcal1";
import { startContentSync } from "./content-sync.js";
import { startSongRequestNotificationWatcher } from "./song-request-notifications.js";
import {
  addHighlight,
  addCategory,
  bindCalendarEditor,
  bindHighlightPanel,
  bindHighlightsEditor,
  clearDay,
  closeContextMenu,
  getDayBangonTime,
  getDayPartCount,
  getPartSlots,
  getPartBangonTime,
  setPartSlots,
  setPartBangonTime,
  moveSlot,
  enableSecondPart,
  removeSecondPart,
  getCategories,
  getDaySlots,
  getHighlights,
  highlightExistsForSlot,
  openSlotEdit,
  closeSlotEdit,
  removeCategory,
  renderEditableSlots,
  restoreEditorFocus,
  saveScheduleNow,
  resetScheduleSaveBaseline,
  applyScheduleRevision,
  syncScheduleRevision,
  shouldSuppressCalendarClick,
  setDaySlots,
  setDayBangonTime,
  setEditorCanEdit,
  setEditorSchedule,
  updateCategoryField,
  positionFixedMenu,
} from "./editor.js?v=bangon-hour1";
import { displaySlotText, escapeHtml, collectDaySlots, findHighlightSlot, highlightMatchesAnySlot, formatBangonTimeDisplay, formatBangonAgendaLabel, getAllDaySlot, getBangonTime, getDayParts, dayHasSecondPart, isAllDaySlot, isBangonPresetValue, isOffDaySlots, normalizeDay, normalizeBangonValue, renderBangonTimePickerMarkup, readBangonPickerValue, syncBangonPickerControls, renderDaySlots, renderDaySlotList, renderSlotLinkHtml, renderSlotShortcutLinkHtml, renderSlotBroadcastHtml, renderSlotMembersMarkup, renderStartTimeBadge, SLOT_RENDER_OPTIONS, slotCategory, slotHours, slotMembers, slotGeneralLinkUrl, slotBroadcastStationUrl, slotStartTime, slotStartTimeFromParts, dayTotalHours, resolveChipColors, highlightCardStyleVars, getHighlightDisplayMeta, renderHighlightCardHtml, FALLBACK_CATEGORY } from "./slots.js?v=bangon-hour1";
import {
  applyCalendarLayout,
  applySlotChipStyle,
  applyChipColorMode,
  getChipColorMode,
  getSlotChipStyle,
  applyHourlyMinSlots,
  applyProportionalMinSlots,
  bindLayoutPanel,
  getCalendarLayout,
  getHourlyMinSlots,
  getMinSlotCount,
  getProportionalMinSlots,
  isHourlyLayout,
  renderLayoutPanel,
  slotRenderOptions,
} from "./calendar-layout.js";
import {
  scheduleInlineChipCompactSync,
  syncInlineChipCompactFromHeight,
  syncInlineCompactChips,
  bindInlineCompactChip,
} from "./inline-chip-layout.js";
import {
  applyCalendarBold,
  applyCalendarFont,
  applySidebarBold,
  applySidebarFont,
  bindFontOptions,
  getCalendarBold,
  getCalendarFont,
  getSidebarBold,
  getSidebarFont,
  registerAllFontFaces,
  renderFontCredit,
  renderFontOptions,
  syncFontsFromSchedule,
} from "./calendar-fonts.js";
import { linksPath, musicbookPath } from "./base-path.js";
import { applyBrandTheme } from "./theme.js";
import { calcDebutDayPlus, DEFAULT_DEBUT_DATE, formatDebutDayPlus } from "./debut.js";
import {
  initMobileNav,
  isMobileViewport,
  scrollMobileAgendaToToday,
  scrollMobileAgendaToDate,
  scrollMobileAgendaToTop,
  setMobileTab,
  showMobileCalendarTab,
  syncMobileHeaderOffset,
} from "./mobile.js";

const BASE = window.SCHEDULE_BASE || "";

let currentYear;
let currentMonth;
let scheduleData = null;
let fullSchedule = null;
let userCanEdit = false;
let currentMe = null;
let editMode = false;
let calendarContentSync = null;
let authConfig = null;
let dayModalDate = null;
let part2DraftDate = null;
let modalDragState = null;
let mobileScrollToToday = false;
let mobileScrollToTop = false;
let pendingMobileScrollDate = undefined;

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

function requestMobileScrollToToday() {
  pendingMobileScrollDate = undefined;
  mobileScrollToTop = false;
  mobileScrollToToday = true;
}

function requestMobileScrollToDate(isoDate) {
  pendingMobileScrollDate = isoDate;
  mobileScrollToTop = false;
  mobileScrollToToday = true;
}

function requestMobileScrollToTop() {
  pendingMobileScrollDate = undefined;
  mobileScrollToToday = false;
  mobileScrollToTop = true;
}

function peekDateFromUrl() {
  return parseIsoDateParam(new URLSearchParams(location.search).get("date"));
}

function isNavigationFromHome() {
  const ref = document.referrer;
  if (!ref) return false;
  try {
    const refUrl = new URL(ref);
    if (refUrl.origin !== location.origin) return false;
    const path = refUrl.pathname.replace(/\/$/, "") || "/";
    const home = linksPath().replace(/\/$/, "") || "/home";
    return path === "/" || path === "/home" || path === home || path.endsWith("/home");
  } catch {
    return false;
  }
}

async function goToMobileToday() {
  if (!isMobileViewport()) return;
  showMobileCalendarTab();
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const iso = dateKey(year, month, day);

  if (year !== currentYear || month !== currentMonth) {
    currentYear = year;
    currentMonth = month;
    await fetchScheduleForView();
    applyBrandTheme(scheduleData?.brandColor);
    syncLayoutFromSchedule(scheduleData);
    renderHeader();
    renderCategories();
    renderHighlights();
  }

  requestMobileScrollToDate(iso);
  renderCalendar();
}

function apiUrl(path, params = {}) {
  const url = new URL(`${BASE}${path}`, location.origin);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null) url.searchParams.set(k, v);
  });
  return url.toString();
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function dateKey(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function currentMonthKey() {
  return `${currentYear}-${pad(currentMonth)}`;
}

function formatFullDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${y}년 ${m}월 ${d}일 (${DOW[dt.getDay()]})`;
}

const CALENDAR_UI_PREFS_KEY = "calendar-ui-prefs";

function isEditing() {
  return userCanEdit && editMode;
}

function canEditSlotsNow() {
  return isEditing() && canEditScheduleSlots(currentMe);
}

function canEditMetaNow() {
  return isEditing() && canEditScheduleMeta(currentMe);
}

function canEditDesignNow() {
  return isEditing() && canEditScheduleDesign(currentMe);
}

function loadCalendarUiPrefs() {
  try {
    return JSON.parse(localStorage.getItem(CALENDAR_UI_PREFS_KEY) || "{}");
  } catch (e) {
    return {};
  }
}

function saveCalendarUiPrefs() {
  // Intentionally do not persist edit-mode. Always start in view mode.
}

function updateCalendarEditModeButtons() {
  const wrap = document.getElementById("calendar-edit-mode-wrap");
  if (!wrap) return;
  for (const btn of wrap.querySelectorAll(".calendar-mode-btn")) {
    const wantEdit = btn.dataset.editMode === "true";
    const active = wantEdit ? editMode : !editMode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function setUserCanEdit(me) {
  currentMe = me;
  userCanEdit = canEditCalendar(me);
  if (!userCanEdit) editMode = false;
  document.getElementById("calendar-edit-mode-wrap")?.classList.toggle("hidden", !userCanEdit);
  updateCalendarEditModeButtons();
}

async function setCalendarEditMode(enabled) {
  const wasEditing = isEditing();
  if (!userCanEdit) {
    editMode = false;
  } else {
    if (wasEditing && !enabled) {
      await syncScheduleRevision();
      await saveScheduleNow({ silentIfUnchanged: true });
    }
    editMode = Boolean(enabled);
  }
  if (!editMode) {
    closeContextMenu();
    closeSlotEdit();
  }
  saveCalendarUiPrefs();
  await applyCalendarEditState({ reloadOnEnter: editMode && !wasEditing });
  if (wasEditing && !editMode && calendarContentSync?.hasPendingRemoteSync?.()) {
    await reloadScheduleFromServer();
    calendarContentSync.clearPendingRemoteSync();
  }
  calendarContentSync?.refresh?.();
}

async function applyCalendarEditState({ reloadOnEnter = true } = {}) {
  const editing = isEditing();
  setEditorCanEdit(canEditSlotsNow());
  document.getElementById("layout-panel")?.classList.toggle("hidden", !canEditDesignNow());
  if (editing) {
    if (reloadOnEnter) {
      await fetchFullSchedule();
      syncLayoutFromSchedule(fullSchedule || scheduleData);
    }
  } else {
    document.getElementById("layout-panel")?.classList.add("hidden");
    await fetchScheduleForView();
  }
  renderDesignPanel();
  renderCalendar();
  renderHighlights();
  renderCategories();
  updateCalendarEditModeButtons();
  if (dayModalDate) openDayModal(dayModalDate);
}

function initMonth() {
  const now = new Date();
  currentYear = now.getFullYear();
  currentMonth = now.getMonth() + 1;
}

async function fetchMonthData(year, month) {
  const res = await apiFetch(apiUrl("/api/schedule", { year, month }));
  if (!res.ok) throw new Error("일정을 불러오지 못했습니다.");
  return res.json();
}

async function fetchScheduleForView() {
  const fetched = await fetchMonthData(currentYear, currentMonth);
  if (isEditing() && fullSchedule) {
    mergeFetchedMonthIntoFullSchedule(currentMonthKey(), fetched);
    scheduleData = { ...fetched };
    refreshScheduleFromEditor();
    bindEditorFromFullSchedule();
  } else {
    scheduleData = fetched;
    syncEditorFromView();
  }
}

async function fetchMonthSchedule() {
  await fetchScheduleForView();
}

async function fetchFullSchedule() {
  const res = await apiFetch("/api/schedule");
  if (!res.ok) throw new Error("전체 일정을 불러오지 못했습니다.");
  fullSchedule = await res.json();
  await syncScheduleRevision();
  refreshScheduleFromEditor();
  bindEditorFromFullSchedule();
  resetScheduleSaveBaseline();
}

function mergeFetchedMonthIntoFullSchedule(monthKey, fetched) {
  if (!fullSchedule) return;
  fullSchedule.months = fullSchedule.months || {};
  const incoming = {
    title: fetched.title || `${Number(monthKey.slice(5))}월`,
    highlights: fetched.highlights || [],
    days: fetched.days || {},
  };
  if (!fullSchedule.months[monthKey]) {
    fullSchedule.months[monthKey] = incoming;
    return;
  }
  const existing = fullSchedule.months[monthKey];
  if (!existing.title) existing.title = incoming.title;
  existing.days = existing.days || {};
  for (const [date, day] of Object.entries(incoming.days)) {
    if (!(date in existing.days)) existing.days[date] = day;
  }
  if (!existing.highlights?.length && incoming.highlights.length) {
    existing.highlights = incoming.highlights;
  }
}

function onEditorCalendarRefresh() {
  refreshScheduleFromEditor();
  renderCategories();
  renderCalendar();
  renderHighlights();
  if (dayModalDate) openDayModal(dayModalDate);
}

function bindEditorFromFullSchedule() {
  if (!fullSchedule || !scheduleData) return;
  setEditorSchedule(
    fullSchedule,
    currentMonthKey(),
    scheduleData.categories || fullSchedule.categories || {},
    onEditorCalendarRefresh
  );
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function refreshScheduleFromEditor() {
  if (!isEditing() || !fullSchedule?.months) return;
  const key = currentMonthKey();
  if (fullSchedule.months[key]) {
    scheduleData.days = { ...fullSchedule.months[key].days };
    scheduleData.highlights = [...(fullSchedule.months[key].highlights || [])];
  }
  if (fullSchedule.categories) scheduleData.categories = { ...fullSchedule.categories };
  if (fullSchedule.debutDate) scheduleData.debutDate = fullSchedule.debutDate;
  if (fullSchedule.calendarLayout) scheduleData.calendarLayout = fullSchedule.calendarLayout;
  if (fullSchedule.slotChipStyle) scheduleData.slotChipStyle = fullSchedule.slotChipStyle;
  if (fullSchedule.proportionalMinSlots != null) scheduleData.proportionalMinSlots = fullSchedule.proportionalMinSlots;
  if (fullSchedule.hourlyMinSlots != null) scheduleData.hourlyMinSlots = fullSchedule.hourlyMinSlots;
  if (fullSchedule.calendarFont) scheduleData.calendarFont = fullSchedule.calendarFont;
  if (fullSchedule.sidebarFont) scheduleData.sidebarFont = fullSchedule.sidebarFont;
  if (fullSchedule.calendarFontBold != null) scheduleData.calendarFontBold = fullSchedule.calendarFontBold;
  if (fullSchedule.sidebarFontBold != null) scheduleData.sidebarFontBold = fullSchedule.sidebarFontBold;
}

function syncEditorFromView() {
  if (!fullSchedule || !scheduleData) return;
  fullSchedule.months = fullSchedule.months || {};
  const key = currentMonthKey();
  fullSchedule.months[key] = {
    title: scheduleData.title,
    highlights: scheduleData.highlights || [],
    days: scheduleData.days || {},
  };

  if (fullSchedule.categories) scheduleData.categories = { ...fullSchedule.categories };
  setEditorSchedule(fullSchedule, key, scheduleData.categories, onEditorCalendarRefresh);
}

function isCategoryEditingAllowed() {
  return canEditMetaNow();
}

function renderCategories() {
  const el = document.getElementById("legend");
  const addBtn = document.getElementById("cat-add-btn");
  const editing = isCategoryEditingAllowed();
  const cats = editing ? getCategories() : scheduleData.categories || {};
  addBtn?.classList.toggle("hidden", !editing);

  el.className = "legend legend--view";
  el.innerHTML = Object.entries(cats)
    .map(([id, cat]) => {
      const editableAttr = editing ? ` data-cat-id="${escapeAttr(id)}"` : "";
      const editableClass = editing ? " legend-item--editable" : "";
      return `<span class="legend-item${editableClass}"${editableAttr}><span class="legend-swatch" style="background:${cat.bg}"></span>${escapeHtml(cat.label)}</span>`;
    })
    .join("");
}

let catCtxTarget = null;
let catColorTarget = null;

function resetColorPickerStyle(picker) {
  if (!picker) return;
  picker.style.position = "";
  picker.style.left = "";
  picker.style.top = "";
  picker.style.zIndex = "";
  picker.style.width = "";
  picker.style.height = "";
}

function openCategoryColorPickerSafely(picker) {
  if (!picker) return;

  const margin = 12;
  const popoverW = 268;
  const popoverH = 320;
  let anchorLeft = (window.innerWidth - popoverW) / 2;
  let anchorTop = (window.innerHeight - popoverH) / 2;
  anchorLeft = Math.max(margin, Math.min(anchorLeft, window.innerWidth - popoverW - margin));
  anchorTop = Math.max(margin, Math.min(anchorTop, window.innerHeight - popoverH - margin));

  resetColorPickerStyle(picker);
  Object.assign(picker.style, {
    position: "fixed",
    left: `${anchorLeft + popoverW - 40}px`,
    top: `${anchorTop}px`,
    zIndex: "500",
    width: "32px",
    height: "32px",
  });

  const cleanup = () => {
    resetColorPickerStyle(picker);
    picker.removeEventListener("change", cleanup);
    picker.removeEventListener("blur", cleanup);
  };
  picker.addEventListener("change", cleanup, { once: true });
  picker.addEventListener("blur", cleanup, { once: true });

  if (typeof picker.showPicker === "function") {
    picker.showPicker().catch(() => picker.click());
  } else {
    picker.click();
  }
}

function shouldUseSafeColorPicker(picker) {
  if (!picker) return false;
  const rect = picker.getBoundingClientRect();
  return rect.right > window.innerWidth - 240 || rect.left > window.innerWidth * 0.55;
}

function openCategoryContextMenu(e, catId) {
  closeContextMenu();
  catCtxTarget = catId;
  catColorTarget = catId;
  const cats = getCategories();
  const picker = document.getElementById("cat-color-picker");
  if (picker && cats[catId]) {
    picker.value = cats[catId].bg || "#ffffff";
  }
  const menu = document.getElementById("cat-ctx-menu");
  menu.querySelector('[data-cat-action="delete"]')?.classList.toggle("hidden", catId === FALLBACK_CATEGORY);
  positionFixedMenu(menu, e.clientX, e.clientY);
}

function closeCategoryContextMenu() {
  document.getElementById("cat-ctx-menu")?.classList.add("hidden");
  catCtxTarget = null;
}

function bindCategoryEditor() {
  const panel = document.getElementById("legend-panel");
  if (!panel || panel._bound) return;
  panel._bound = true;

  panel.addEventListener("contextmenu", (e) => {
    if (!isCategoryEditingAllowed()) return;
    const item = e.target.closest("[data-cat-id]");
    if (!item) return;
    e.preventDefault();
    openCategoryContextMenu(e, item.dataset.catId);
  });

  document.getElementById("cat-ctx-menu")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-cat-action]");
    if (!btn || !catCtxTarget) return;
    e.stopPropagation();
    const id = catCtxTarget;
    const cats = getCategories();
    const cat = cats[id];
    if (!cat) return;

    if (btn.dataset.catAction === "rename") {
      const next = prompt("카테고리 이름", cat.label || "");
      if (next != null && next.trim()) updateCategoryField(id, "label", next.trim());
    } else if (btn.dataset.catAction === "delete" && id !== FALLBACK_CATEGORY) {
      removeCategory(id);
    }
    closeCategoryContextMenu();
  });

  document.querySelector(".ctx-menu-color-row")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const picker = document.getElementById("cat-color-picker");
    if (!picker || e.target.closest('input[type="color"]')) return;
    if (shouldUseSafeColorPicker(picker)) {
      e.preventDefault();
      openCategoryColorPickerSafely(picker);
    }
  });

  document.getElementById("cat-color-picker")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const picker = e.currentTarget;
    if (shouldUseSafeColorPicker(picker)) {
      e.preventDefault();
      openCategoryColorPickerSafely(picker);
    }
  });

  document.getElementById("cat-color-picker")?.addEventListener("mousedown", (e) => {
    e.stopPropagation();
  });

  document.getElementById("cat-color-picker")?.addEventListener("input", (e) => {
    if (!catColorTarget) return;
    updateCategoryField(catColorTarget, "bg", e.target.value);
  });

  document.getElementById("cat-color-picker")?.addEventListener("change", () => {
    catColorTarget = null;
    closeCategoryContextMenu();
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest("#cat-ctx-menu")) return;
    closeCategoryContextMenu();
  });
}

function isHighlightInViewedMonth(highlight, monthKey = currentMonthKey()) {
  const date = String(highlight?.date || "").trim();
  return Boolean(date && date.slice(0, 7) === monthKey);
}

/** 방송일정 페이지: 보고 있는 달의 주요 일정 전체(과거 포함). 날짜 필터 없음. */
function getVisibleHighlights() {
  let items;
  const monthKey = currentMonthKey();
  if (isEditing() && fullSchedule?.months) {
    items = [...(fullSchedule.months[monthKey]?.highlights || [])];
  } else {
    items = scheduleData.highlights || [];
  }
  return items
    .filter((h) => isHighlightInViewedMonth(h, monthKey))
    .filter((h) => {
      const dayData = isEditing()
        ? fullSchedule?.months?.[monthKey]?.days?.[h.date]
        : scheduleData.days?.[h.date];
      return highlightMatchesAnySlot(collectDaySlots(dayData), h.text);
    })
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.text).localeCompare(String(b.text)));
}

function renderDebutDay() {
  const box = document.getElementById("debut-day");
  const valueEl = document.getElementById("debut-day-value");
  if (!box || !valueEl) return;

  const debutDate =
    scheduleData?.debutDate || fullSchedule?.debutDate || DEFAULT_DEBUT_DATE;
  const days = calcDebutDayPlus(debutDate);
  if (days == null) {
    box.classList.add("hidden");
    return;
  }

  valueEl.textContent = formatDebutDayPlus(days);
  box.classList.remove("hidden");
}

function renderHeader() {
  document.getElementById("page-title").textContent = "방송일정";
  document.getElementById("month-title").textContent = scheduleData.title || `${currentMonth}월`;
  document.title = "방송일정";
  renderDebutDay();
  syncMobileHeaderOffset();
}

function renderHighlights() {
  const list = document.getElementById("highlights");
  const countEl = document.getElementById("hl-count");
  const items = getVisibleHighlights();
  const todayKey = dateKey(
    new Date().getFullYear(),
    new Date().getMonth() + 1,
    new Date().getDate()
  );

  if (countEl) {
    countEl.textContent = items.length ? String(items.length) : "";
    countEl.classList.toggle("hidden", !items.length);
  }

  if (!items.length) {
    list.innerHTML = isEditing()
      ? `<li class="highlights-empty">
          <span class="highlights-empty-icon" aria-hidden="true">★</span>
          <p class="highlights-empty-title">등록된 주요 일정이 없습니다</p>
          <p class="highlights-empty-hint">캘린더 일정 우클릭 또는 자세히 보기에서 「주요일정에 넣기」</p>
        </li>`
      : `<li class="highlights-empty">
          <span class="highlights-empty-icon" aria-hidden="true">★</span>
          <p class="highlights-empty-title">등록된 주요 일정이 없습니다</p>
        </li>`;
  } else {
    const cats = scheduleData.categories || {};
    list.innerHTML = items
      .map((h, i) => {
        const isToday = h.date === todayKey;
        const [y, m, d] = h.date.split("-").map(Number);
        const dow = DOW[new Date(y, m - 1, d).getDay()];
        const dayData = isEditing()
          ? fullSchedule?.months?.[currentMonthKey()]?.days?.[h.date]
          : scheduleData.days?.[h.date];
        const slot = findHighlightSlot(dayData, h.text, { fallbackFirst: false });
        const cat = slot ? slotCategory(slot, cats) : slotCategory({ category: FALLBACK_CATEGORY }, cats);
        const hlColors = resolveChipColors(getChipColorMode(), cat.bg, cat.text);
        const chipStyle = highlightCardStyleVars(hlColors, cat.bg);
        const metaLabel = getHighlightDisplayMeta(dayData, h.text);
        return `<li class="highlight-item${isToday ? " highlight-item--today" : ""}${
          canEditSlotsNow() ? " highlight-item--editable" : ""
        }" data-highlight-date="${h.date}" data-highlight-idx="${i}" role="button" tabindex="0"${
          isToday ? ' aria-current="date"' : ""
        } aria-label="${escapeAttr(`${isToday ? "오늘 · " : ""}${h.date} ${h.text}`)}">
          ${renderHighlightCardHtml({
            month: m,
            day: d,
            dow,
            isToday,
            catLabel: cat.label || slot?.category || "일반",
            text: h.text,
            chipStyle,
            metaLabel,
          })}
        </li>`;
      })
      .join("");
  }
}

function getBangonTimeForDay(isoDate) {
  if (isEditing()) return getDayBangonTime(isoDate);
  const fromView = getBangonTime(scheduleData.days?.[isoDate]);
  if (fromView) return fromView;
  if (fullSchedule?.months) {
    const mk = isoDate.slice(0, 7);
    return getBangonTime(fullSchedule.months[mk]?.days?.[isoDate]);
  }
  return "";
}

function renderDayBangonBadge(time) {
  if (!time) return "";
  const label = formatBangonTimeDisplay(time);
  return `<span class="day-bangon-time" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

function isBangonHiddenForDay(isoDate) {
  return isOffDaySlots(getSlotsForDay(isoDate));
}

let bangonModalDate = null;

function initBangonModalControls() {
  const wrap = document.getElementById("day-modal-bangon-wrap");
  if (!wrap || wrap.dataset.bound) return;
  wrap.dataset.bound = "1";
  wrap.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-bangon]");
    if (!btn || !bangonModalDate || !isEditing()) return;
    e.preventDefault();
    setDayBangonTime(bangonModalDate, btn.dataset.bangon || "");
  });
  wrap.addEventListener("bangontimechange", (e) => {
    if (!bangonModalDate || !isEditing()) return;
    const picker = e.target.closest("[data-bangon-picker]");
    if (!picker) return;
    const value =
      typeof e.detail?.value === "string" ? e.detail.value : readBangonPickerValue(picker);
    setDayBangonTime(bangonModalDate, value);
  });
  wrap.addEventListener("change", (e) => {
    if (!e.target.matches(".bangon-approx-input")) return;
    if (!bangonModalDate || !isEditing()) return;
    const picker = e.target.closest("[data-bangon-picker]");
    syncBangonPickerControls(picker);
    setDayBangonTime(bangonModalDate, readBangonPickerValue(picker));
  });
}

function renderDayModalBangon(isoDate) {
  bangonModalDate = isoDate;
  const wrap = document.getElementById("day-modal-bangon-wrap");
  if (!wrap) return;

  if (isBangonHiddenForDay(isoDate)) {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }

  const bangon = getBangonTimeForDay(isoDate);

  if (!isEditing() && !bangon) {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }

  wrap.classList.remove("hidden");

  if (isEditing()) {
    wrap.innerHTML = `
      <div class="day-modal-bangon">
        <p class="bangon-picker-title">뱅온 시간</p>
        ${renderBangonTimePickerMarkup(bangon)}
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="day-modal-bangon-view">
      <span class="day-modal-bangon-value">${escapeHtml(formatBangonTimeDisplay(bangon))}</span>
    </div>`;
}

function getSlotsForDay(isoDate) {
  if (isEditing()) return getDaySlots(isoDate);
  const fromView = normalizeDay(scheduleData.days?.[isoDate])?.slots || [];
  if (fromView.length) return fromView;
  if (fullSchedule?.months) {
    const mk = isoDate.slice(0, 7);
    return normalizeDay(fullSchedule.months[mk]?.days?.[isoDate])?.slots || [];
  }
  return [];
}

function bindDayClicks() {
  document.querySelectorAll(".day-cell[data-date]").forEach((cell) => {
    const openDetail = () => {
      if (shouldSuppressCalendarClick()) return;
      openDayModal(cell.dataset.date);
    };
    const head = cell.querySelector(".day-head");
    head?.addEventListener("click", (e) => {
      e.stopPropagation();
      openDetail();
    });
    head?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        openDetail();
      }
    });

    if (!isEditing()) {
      const openFromSlotArea = (e) => {
        if (shouldSuppressCalendarClick()) return;
        if (e.target.closest(".slot-drag-handle")) return;
        openDetail();
      };
      const partsWrap = cell.querySelector(".day-parts");
      if (partsWrap) {
        partsWrap.querySelectorAll(".day-part").forEach((part) => {
          part.addEventListener("click", openFromSlotArea);
        });
      } else {
        cell.querySelectorAll(".slot-list").forEach((list) => {
          list.addEventListener("click", openFromSlotArea);
        });
      }
    }
  });
}

function bindMobileAgendaClicks() {
  document.querySelectorAll(".mobile-agenda-day[data-date]").forEach((day) => {
    day.addEventListener("click", () => openDayModal(day.dataset.date));
    day.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDayModal(day.dataset.date);
      }
    });
  });
}

function setMobileAgendaVisible(show) {
  document.querySelector(".calendar-wrap")?.classList.toggle("hidden", show);
  document.getElementById("mobile-agenda")?.classList.toggle("hidden", !show);
}

// ── 모바일 전용 아젠다 (데스크톱 slot-chip 시스템과 완전 분리) ──
function buildMobileEventRow(slot, cats) {
  const cat = slotCategory(slot, cats) || {};
  const allDay = isAllDaySlot(slot);
  const startTime = slotStartTime(slot);
  const members = slotMembers(slot);
  const broadcastHtml = renderSlotBroadcastHtml(slot, { className: "magenda-event-broadcast slot-broadcast" });
  const chipColors = resolveChipColors(getChipColorMode(), cat.bg, cat.text);
  const accent = chipColors.text || "#5b6b8c";
  const tint = chipColors.bg || "rgba(120,140,180,0.12)";
  const catLabel = cat.label || "";
  const linkHtml = slotGeneralLinkUrl(slot)
    ? renderSlotLinkHtml(slot, { className: "magenda-event-link day-detail-link" })
    : "";
  const metaHtml =
    members || broadcastHtml
      ? `<div class="magenda-event-meta">${members ? `<span class="magenda-event-members slot-members" aria-label="멤버 ${escapeAttr(members)}">${renderSlotMembersMarkup(members)}</span>` : ""}${broadcastHtml}</div>`
      : "";
  const sideHtml =
    linkHtml || catLabel
      ? `<div class="magenda-event-side">${linkHtml}${catLabel ? `<span class="magenda-event-tag">${escapeHtml(catLabel)}</span>` : ""}</div>`
      : "";

  const timeLabel = allDay
    ? "종일"
    : startTime
      ? formatBangonTimeDisplay(startTime)
      : "";
  const timeHtml = timeLabel
    ? `<span class="magenda-event-time">${escapeHtml(timeLabel)}</span>`
    : `<span class="magenda-event-time magenda-event-time--none"><span class="magenda-event-dot" aria-hidden="true"></span></span>`;

  return `
    <div class="magenda-event${allDay ? " is-allday" : ""}" style="--ev-color:${accent};--ev-tint:${tint};--ev-border:${chipColors.border || accent};">
      ${timeHtml}
      <div class="magenda-event-main">
        <span class="magenda-event-title">${escapeHtml(slot.text)}</span>
        ${metaHtml}
      </div>
      ${sideHtml}
    </div>`;
}

function buildMobileAgendaDay(key, dayData, cats, todayKey) {
  const parts = getDayParts(dayData);
  const isToday = key === todayKey;
  const [, , dStr] = key.split("-");
  const d = Number(dStr);
  const dow = new Date(key).getDay();
  const dowClass = dow === 0 ? " sun" : dow === 6 ? " sat" : "";
  const multiPart = parts.length > 1;
  const hasEvents = parts.some((p) => (p.slots || []).length > 0);

  const bangonText = (bangon) => {
    const label = formatBangonAgendaLabel(bangon);
    if (!label) return "";
    const presetCls = isBangonPresetValue(bangon) ? " magenda-bangon--preset" : "";
    return `<span class="magenda-bangon${presetCls}">${escapeHtml(label)}</span>`;
  };

  let bodyHtml;
  if (multiPart) {
    bodyHtml = parts
      .map((part, idx) => {
        const slots = part.slots || [];
        const bangon =
          !isOffDaySlots(slots) && part.bangonTime ? part.bangonTime : "";
        const eventsHtml = slots.length
          ? slots.map((s) => buildMobileEventRow(s, cats)).join("")
          : `<div class="magenda-empty-note">일정이 없어요</div>`;
        const partHead = `<div class="magenda-part-head">
            <span class="magenda-part-label">${idx + 1}부</span>
            ${bangon ? bangonText(bangon) : ""}
          </div>`;
        return `
        <div class="magenda-part" data-part="${idx}">
          ${partHead}
          <div class="magenda-events">${eventsHtml}</div>
        </div>`;
      })
      .join("");
  } else {
    const slots = parts[0]?.slots || [];
    const bangon = isBangonHiddenForDay(key) ? "" : getBangonTimeForDay(key);
    const eventsHtml = slots.length
      ? slots.map((s) => buildMobileEventRow(s, cats)).join("")
      : `<div class="magenda-empty-note">일정이 없어요</div>`;
    bodyHtml = `${bangon ? bangonText(bangon) : ""}<div class="magenda-events">${eventsHtml}</div>`;
  }

  const detailLabel = `${formatFullDate(key)} 일정 보기`;

  return `<article class="mobile-agenda-day magenda-day${dowClass}${isToday ? " today" : ""}${hasEvents ? "" : " is-empty"}${multiPart ? " magenda-day--multipart" : ""}" data-date="${key}"${isToday ? ' aria-current="date"' : ""} role="button" tabindex="0" aria-label="${isToday ? "오늘 · " : ""}${detailLabel}">
    <div class="magenda-rail">
      <span class="magenda-dow">${DOW[dow]}</span>
      <span class="magenda-date">${d}</span>
    </div>
    <div class="magenda-body">
      ${bodyHtml}
    </div>
  </article>`;
}

function renderMobileAgenda(days, cats, todayKey) {
  const el = document.getElementById("mobile-agenda");
  if (!el) return;

  // 일정이 있는 날 + 오늘만 표시 (아젠다 스타일로 깔끔하게)
  const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
  const dateKeys = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const key = dateKey(currentYear, currentMonth, day);
    const hasEvents = (normalizeDay(days[key])?.slots || []).length > 0;
    if (hasEvents || key === todayKey) dateKeys.push(key);
  }

  el.className = "mobile-agenda";
  if (!dateKeys.length) {
    el.innerHTML = `<p class="mobile-agenda-empty">이번 달 일정이 없어요</p>`;
    syncMobileHeaderOffset();
    return;
  }

  el.innerHTML = dateKeys.map((key) => buildMobileAgendaDay(key, days[key], cats, todayKey)).join("");
  bindMobileAgendaClicks();
  syncMobileHeaderOffset();
  if (!mobileScrollToTop && (pendingMobileScrollDate || todayKey.slice(0, 7) === currentMonthKey())) {
    mobileScrollToToday = true;
  }
}

function getDaySlotMetrics(dayData) {
  const normalized = normalizeDay(dayData);
  const slots = normalized?.slots || [];
  if (!slots.length) return { hours: 0, count: 0 };
  if (slots.length === 1 && isAllDaySlot(slots[0])) return { hours: 0, count: 0 };
  return {
    hours: slots.reduce((sum, s) => sum + slotHours(s), 0),
    count: slots.length,
  };
}

const OVERFLOW_HINT_ANIM_MS = 320;

const VISIBLE_SLOT_MAX = 3;
const OVERFLOW_HINT_RESERVE = 0;
const SLOT_ABS_MIN = 16;
const SLOT_LAYOUT_MAX = 34;
const TIMELINE_HOUR_UNIT = 34;
const TIMELINE_FONT_DEFAULT = 1;
const TIMELINE_FONT_MAX = 1.12;
const TIMELINE_FONT_MAX_WITH_MEMBERS = 1.08;
const TIMELINE_FONT_MIN = 0.56;
const TIMELINE_FONT_WIDTH_MIN = 0.82;
const TIMELINE_FONT_STEP = 0.025;
const TIMELINE_SLOT_GAP = 4;
const DAY_MODAL_HOUR_UNIT = 76;

function getFixedSlotsAreaHeight() {
  const slotCount = getMinSlotCount();
  const gaps = Math.max(0, slotCount - 1) * TIMELINE_SLOT_GAP;
  return slotCount * TIMELINE_HOUR_UNIT + gaps;
}

function getOneHourSlotHeight() {
  return TIMELINE_HOUR_UNIT;
}

function getDefaultSlotsHeight() {
  return getFixedSlotsAreaHeight();
}

function getMultipartSlotsMinHeight(cell) {
  const parts = [...(cell?.querySelectorAll(".day-part") || [])];
  if (!parts.length) return 0;
  const partsH = parts.reduce((sum, part) => {
    const min = parseFloat(part.style.getPropertyValue("--part-min-height")) || 0;
    return sum + min;
  }, 0);
  const wrap = cell.querySelector(".day-parts");
  const wrapGap = wrap ? parseFloat(getComputedStyle(wrap).rowGap || getComputedStyle(wrap).gap) || 0 : 0;
  // 2부 구분선 padding-top까지 포함
  const dividerPad = parts.slice(1).reduce((sum, part) => {
    const style = getComputedStyle(part);
    return sum + (parseFloat(style.paddingTop) || 0);
  }, 0);
  return partsH + Math.max(0, parts.length - 1) * wrapGap + dividerPad;
}

function getDayCellMinHeight(cell, slotsContentHeight = 0) {
  const style = getComputedStyle(cell);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const gap = parseFloat(style.gap) || 5;
  const headH = cell.querySelector(".day-head")?.offsetHeight ?? 28;
  const multipartH = cell?.classList?.contains("day-cell--multipart")
    ? getMultipartSlotsMinHeight(cell)
    : 0;
  const slotsH = Math.max(slotsContentHeight, multipartH, getDefaultSlotsHeight());
  return headH + padY + gap + slotsH + 2;
}

function getCellSlotAreaHeight(cell, rowHeight) {
  const style = getComputedStyle(cell);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const gap = parseFloat(style.gap) || 5;
  const headH = cell.querySelector(".day-head")?.offsetHeight ?? 28;
  return rowHeight - padY - gap - headH;
}

function countHiddenSlots(list) {
  const chips = list.querySelectorAll(".slot-chip");
  if (chips.length <= VISIBLE_SLOT_MAX) return 0;

  const listRect = list.getBoundingClientRect();
  const visibleBottom = listRect.bottom - 3;
  let hidden = 0;
  chips.forEach((chip) => {
    if (chip.getBoundingClientRect().bottom > visibleBottom) hidden++;
  });
  return hidden;
}

function finishOverflowHintDismiss(hint) {
  if (!hint?.isConnected) return;
  if (hint._dismissTimer) {
    clearTimeout(hint._dismissTimer);
    hint._dismissTimer = null;
  }
  if (hint._dismissOnEnd) {
    hint.removeEventListener("transitionend", hint._dismissOnEnd);
    hint._dismissOnEnd = null;
  }
  hint.remove();
}

function hideSlotOverflowHint(hint) {
  if (!hint || hint.classList.contains("is-collapsed")) return;

  hint.classList.add("is-collapsed");
  hint._dismissTimer = setTimeout(() => finishOverflowHintDismiss(hint), OVERFLOW_HINT_ANIM_MS + 40);

  hint._dismissOnEnd = (e) => {
    if (e.target !== hint || e.propertyName !== "opacity") return;
    finishOverflowHintDismiss(hint);
  };
  hint.addEventListener("transitionend", hint._dismissOnEnd);
}

function showSlotOverflowHint(list, hidden) {
  let hint =
    list.nextElementSibling?.classList?.contains("slot-overflow-hint") ? list.nextElementSibling : null;

  if (hint?._dismissTimer) {
    clearTimeout(hint._dismissTimer);
    hint._dismissTimer = null;
    hint.removeEventListener("transitionend", hint._dismissOnEnd);
    hint._dismissOnEnd = null;
  }

  if (!hint) {
    hint = document.createElement("div");
    hint.className = "slot-overflow-hint is-collapsed";
    hint.setAttribute("aria-hidden", "true");
    list.insertAdjacentElement("afterend", hint);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => hint.classList.remove("is-collapsed"));
    });
  } else {
    hint.classList.remove("is-collapsed");
  }

  hint.textContent = `+${hidden}`;
}

function updateSlotOverflowHintForList(list) {
  if (!list) return;
  const hint =
    list.nextElementSibling?.classList?.contains("slot-overflow-hint") ? list.nextElementSibling : null;
  const hidden = countHiddenSlots(list);

  if (hidden <= 0) {
    if (hint) hideSlotOverflowHint(hint);
    return;
  }

  showSlotOverflowHint(list, hidden);
}

function bindSlotListOverflowScroll(list) {
  if (!list || list._overflowScrollBound) return;
  list._overflowScrollBound = true;
  list.addEventListener("scroll", () => updateSlotOverflowHintForList(list), { passive: true });
}

function initDisplayMode() {
  document.documentElement.classList.add("display-timeline");
  document.body.classList.add("display-timeline");
  bindCalendarWheelPassthrough();
}

let modalScrollLockY = 0;

function getHourPanelScrollBody(target) {
  if (!(target instanceof Element)) return null;
  const panel = target.closest(".slot-start-hour-panel");
  if (!panel) return null;
  if (panel.scrollHeight > panel.clientHeight + 1) return panel;
  return panel;
}

function getModalScrollBody(target) {
  if (!(target instanceof Node)) return null;

  const hourPanel = getHourPanelScrollBody(target instanceof Element ? target : null);
  if (hourPanel) return hourPanel;

  const slotModal = document.getElementById("slot-edit-modal");
  if (slotModal && !slotModal.classList.contains("hidden")) {
    const slotBody = slotModal.querySelector(".slot-edit-body");
    if (slotBody?.contains(target) && slotBody.scrollHeight > slotBody.clientHeight + 1) {
      return slotBody;
    }
  }

  const dayBody = document.getElementById("day-modal-body");
  if (dayBody?.contains(target) && dayBody.scrollHeight > dayBody.clientHeight + 1) {
    return dayBody;
  }

  return null;
}

function preventModalScrollWheelOverscroll(e, body) {
  if (body.scrollHeight <= body.clientHeight + 1) {
    e.preventDefault();
    return;
  }

  const { scrollTop, scrollHeight, clientHeight } = body;
  const atTop = scrollTop <= 0;
  const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
  if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) {
    e.preventDefault();
  }
}

function onModalScrollTouchMove(e) {
  if (getModalScrollBody(e.target)) return;
  e.preventDefault();
}

function onModalScrollWheel(e) {
  /* body로 포탈된 시 선택 패널은 모달 밖이라 별도 허용 */
  const hourPanel = getHourPanelScrollBody(e.target instanceof Element ? e.target : null);
  if (hourPanel) {
    preventModalScrollWheelOverscroll(e, hourPanel);
    return;
  }

  const slotModal = document.getElementById("slot-edit-modal");
  if (slotModal && !slotModal.classList.contains("hidden")) {
    const slotBody = slotModal.querySelector(".slot-edit-body");
    if (!slotBody || !slotBody.contains(e.target)) {
      e.preventDefault();
      return;
    }
    preventModalScrollWheelOverscroll(e, slotBody);
    return;
  }

  const modal = document.getElementById("day-modal");
  if (!modal || modal.classList.contains("hidden")) return;

  const body = document.getElementById("day-modal-body");
  if (!body) {
    e.preventDefault();
    return;
  }

  if (!body.contains(e.target)) {
    e.preventDefault();
    return;
  }

  preventModalScrollWheelOverscroll(e, body);
}

function lockPageScroll() {
  if (document.documentElement.classList.contains("modal-open")) return;
  modalScrollLockY = window.scrollY;
  document.documentElement.classList.add("modal-open");
  document.body.classList.add("modal-open");
  document.body.style.position = "fixed";
  document.body.style.top = `-${modalScrollLockY}px`;
  document.body.style.left = "0";
  document.body.style.right = "0";
  document.body.style.width = "100%";
  document.addEventListener("touchmove", onModalScrollTouchMove, { passive: false });
  document.addEventListener("wheel", onModalScrollWheel, { passive: false, capture: true });
}

function unlockPageScroll() {
  if (!document.documentElement.classList.contains("modal-open")) return;
  document.documentElement.classList.remove("modal-open");
  document.body.classList.remove("modal-open");
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  document.body.style.width = "";
  document.removeEventListener("touchmove", onModalScrollTouchMove, { passive: false });
  document.removeEventListener("wheel", onModalScrollWheel, { capture: true });
  window.scrollTo(0, modalScrollLockY);
}

function bindCalendarWheelPassthrough() {
  const col = document.querySelector(".calendar-column");
  if (!col || col.dataset.wheelPassthrough) return;
  col.dataset.wheelPassthrough = "1";

  col.addEventListener(
    "wheel",
    (e) => {
      if (!document.documentElement.classList.contains("display-timeline")) return;
      if (document.documentElement.classList.contains("modal-open")) return;
      if (isMobileViewport()) return;
      if (!e.target.closest("#calendar, .calendar-wrap")) return;

      // 브라우저 확대/축소(Ctrl/Cmd+휠)와 트랙패드 뒤로/앞으로 제스처는 가로 휠로 전달됨.
      if (e.ctrlKey || e.metaKey) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

      const list = e.target.closest(".slot-list:not(.slot-list--all-day)");
      if (list) {
        const style = getComputedStyle(list);
        const scrollableY = style.overflowY === "auto" || style.overflowY === "scroll";
        if (scrollableY && list.scrollHeight > list.clientHeight + 1) {
          const atTop = list.scrollTop <= 0;
          const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
          if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) return;
        }
      }

      window.scrollBy({ top: e.deltaY, behavior: "auto" });
      e.preventDefault();
    },
    { passive: false }
  );
}

function updateSlotOverflowHints() {
  document.querySelectorAll(".slot-overflow-hint").forEach((hint) => hint.remove());
}

function getSlotHoursFromChip(chip) {
  const h = Number(getComputedStyle(chip).getPropertyValue("--slot-hours"));
  return Number.isFinite(h) && h >= 1 ? h : 1;
}

function isAllDayChip(chip) {
  return chip.classList.contains("slot-chip--all-day");
}

function resetChipTimelineSizing(chip) {
  chip.style.flex = "";
  chip.style.minHeight = "";
  chip.style.height = "";
  chip.style.maxHeight = "";
  chip.style.overflow = "";
  chip.style.alignSelf = "";
}

function isAllDayChipCompact(chip) {
  if (!chip?.classList.contains("slot-chip--all-day")) return false;
  if (chip.classList.contains("slot-chip--all-day-compact")) return true;
  if (chip.classList.contains("slot-chip--inline-compact")) return true;
  return Boolean(chip.parentElement?.querySelector(":scope > .slot-chip:not(.slot-chip--all-day)"));
}

function getVisibleSlotBadge(chip) {
  // 작아진 종일 칩은 왼쪽 시간칸을 쓰지 않음
  if (isAllDayChipCompact(chip)) return null;
  if (chip.classList.contains("slot-chip--inline-compact")) {
    return chip.querySelector(":scope > .slot-duration--inline-fallback");
  }
  if (chip.classList.contains("slot-chip--inline-timed") && !chip.classList.contains("slot-chip--inline-compact")) {
    return null;
  }
  const badge = chip.querySelector(":scope > .slot-duration:not(.slot-duration--inline-fallback)");
  if (!badge) return null;
  const cs = getComputedStyle(badge);
  if (cs.display === "none" || cs.visibility === "hidden") return null;
  return badge;
}

function isSidebarTimelineChip(chip) {
  return (
    chip?.classList.contains("slot-chip--has-start") ||
    chip?.classList.contains("slot-chip--all-day")
  );
}

function getBodyHorizontalInset(body) {
  const style = getComputedStyle(body);
  return {
    left: parseFloat(style.paddingLeft) || 0,
    right: parseFloat(style.paddingRight) || 0,
  };
}

function getBadgeContentInset(chip) {
  const badge = getVisibleSlotBadge(chip);
  if (!badge) return 0;
  const width = badge.getBoundingClientRect().width || badge.offsetWidth || 0;
  if (width <= 0) return 0;
  return Math.max(28, Math.ceil(width));
}

function resetSlotChipTextPosition(text, membersEl) {
  if (!text) return;
  text.style.position = "";
  text.style.top = "";
  text.style.left = "";
  text.style.right = "";
  text.style.transform = "";
  text.style.gridRow = "";
  text.style.alignSelf = "";
  text.style.justifySelf = "";
  if (!membersEl) return;
  membersEl.style.position = "";
  membersEl.style.top = "";
  membersEl.style.left = "";
  membersEl.style.right = "";
  membersEl.style.transform = "";
  membersEl.style.gridRow = "";
  membersEl.style.alignSelf = "";
  membersEl.style.justifySelf = "";
  membersEl.style.marginTop = "";
}

function layoutMembersBelowCenteredTitle(body, text, membersEl, { gap = 2 } = {}) {
  if (!body || !text || !membersEl) return;

  const bodyH = body.clientHeight;
  const textH = text.offsetHeight;
  const membersH = membersEl.offsetHeight;
  if (!bodyH || !textH) return;

  // 제목·멤버를 위→아래로 쌓고, 묶음 전체를 세로 중앙 → 겹침 방지
  const blockH = textH + gap + membersH;
  const titleTop = Math.max(1, (bodyH - blockH) / 2);
  const membersTop = titleTop + textH + gap;

  const { left, right } = getBodyHorizontalInset(body);

  text.style.position = "absolute";
  text.style.left = `${left}px`;
  text.style.right = `${right}px`;
  text.style.top = `${titleTop}px`;
  text.style.transform = "";
  text.style.width = "auto";
  text.style.margin = "0";

  membersEl.style.position = "absolute";
  membersEl.style.left = `${left}px`;
  membersEl.style.right = `${right}px`;
  membersEl.style.top = `${membersTop}px`;
  membersEl.style.transform = "";
  membersEl.style.width = "auto";
  membersEl.style.margin = "0";
}

function membersOverlapTitle(text, membersEl) {
  if (!text || !membersEl) return false;
  const tRect = text.getBoundingClientRect();
  const mRect = membersEl.getBoundingClientRect();
  if (!tRect.height || !mRect.height) return false;
  return mRect.top < tRect.bottom - 1;
}

function applySlotChipBodyLayout(body, text, membersEl, { mobileAgenda = false, chip = null } = {}) {
  if (!body || !text) return;

  resetSlotChipTextPosition(text, membersEl);
  body.style.position = "";
  body.style.gridTemplateRows = "";
  body.style.gridTemplateColumns = "";
  body.style.justifyItems = "";
  body.style.alignContent = "";
  body.style.placeItems = "";

  if (mobileAgenda) {
    body.style.display = "flex";
    body.style.flexDirection = "column";
    body.style.justifyContent = "";
    body.style.alignItems = "flex-start";
    return "mobile";
  }

  // 본문 시간 표시(compact): 멤버 있으면 flex 세로 스택
  const isCompactInlineTimed =
    chip?.classList?.contains("slot-chip--inline-timed") &&
    chip?.classList?.contains("slot-chip--inline-compact");
  if (isCompactInlineTimed && membersEl) {
    body.style.display = "flex";
    body.style.flexDirection = "column";
    body.style.justifyContent = "center";
    body.style.alignItems = "center";
    body.style.position = "relative";
    text.style.textAlign = "center";
    text.style.flex = "0 1 auto";
    membersEl.style.position = "";
    membersEl.style.flex = "0 0 auto";
    membersEl.style.width = "100%";
    membersEl.style.marginTop = "2px";
    return "compact-members-flex";
  }

  // 본문 시간 표시(non-compact inline-timed): 시간 오버레이를 피해 상단 정렬 flex flow
  // 멤버 유무와 무관하게 동일한 레이아웃 → 시간-제목 간격 일관
  const isInlineTimedFlow =
    chip?.classList?.contains("slot-chip--inline-timed") &&
    !chip?.classList?.contains("slot-chip--inline-compact");
  if (isInlineTimedFlow) {
    body.style.display = "flex";
    body.style.flexDirection = "column";
    body.style.justifyContent = "center";
    body.style.alignItems = "center";
    body.style.position = "relative";
    text.style.textAlign = "center";
    if (membersEl) {
      membersEl.style.position = "";
      membersEl.style.width = "100%";
    }
    return "inline-timed-flow";
  }

  if (membersEl && isSidebarTimelineChip(chip)) {
    body.style.display = "grid";
    body.style.gridTemplateRows = "minmax(0, 1fr) auto";
    body.style.gridTemplateColumns = "1fr";
    body.style.flexDirection = "";
    body.style.justifyContent = "";
    body.style.alignItems = "";
    body.style.alignContent = "stretch";
    body.style.placeItems = "";
    body.style.justifyItems = "center";
    body.style.position = "relative";
    text.style.gridRow = "1";
    text.style.alignSelf = "center";
    text.style.justifySelf = "center";
    text.style.textAlign = "center";
    membersEl.style.gridRow = "2";
    membersEl.style.alignSelf = "center";
    membersEl.style.justifySelf = "center";
    return "sidebar-members";
  }

  if (membersEl) {
    body.style.display = "block";
    body.style.position = "relative";
    body.style.flexDirection = "";
    body.style.justifyContent = "";
    body.style.alignItems = "";
    return "inline-members";
  }

  body.style.display = "flex";
  body.style.flexDirection = "column";
  body.style.justifyContent = "center";
  body.style.alignItems = "center";
  return "plain";
}

function getInlineTimeZoneHeight(chip) {
  const timeEl = chip?.querySelector(":scope > .slot-time-text");
  if (timeEl) {
    const chipRect = chip.getBoundingClientRect();
    const timeRect = timeEl.getBoundingClientRect();
    if (chipRect.height > 0 && timeRect.height > 0) {
      return Math.ceil(timeRect.bottom - chipRect.top);
    }
  }
  return 15;
}

function isInlineTimedFlowChip(chip) {
  return (
    chip?.classList?.contains("slot-chip--inline-timed") &&
    !chip?.classList?.contains("slot-chip--inline-compact")
  );
}

/** 본문 시간 표시(non-compact): 여유 있으면 칩 전체 기준 중앙, 겹칠 때만 상단 패딩 확대 */
function syncInlineTimedBodyPadding(chip, body, text, membersEl, { memberGap = 2 } = {}) {
  if (!isInlineTimedFlowChip(chip) || !body) return 4;

  const chipH = chip.clientHeight;
  if (!chipH) return 4;

  const sidePad = 6;
  const minPad = 2;
  const bottomPad = membersEl ? 4 : minPad;
  const timeGap = 1;
  const timeZoneH = getInlineTimeZoneHeight(chip);
  const contentH =
    (text?.offsetHeight || 0) +
    (membersEl ? memberGap + (membersEl.offsetHeight || 0) : 0);
  const idealTop = (chipH - contentH - bottomPad - minPad) / 2;

  let padTop = minPad;
  const needsTimeClearance = idealTop < timeZoneH + timeGap - 1;
  if (needsTimeClearance) {
    padTop = Math.max(minPad, Math.ceil(timeZoneH + timeGap));
  }

  const overflow = padTop + contentH + bottomPad > chipH;
  body.style.justifyContent = overflow || needsTimeClearance ? "flex-start" : "center";

  body.style.paddingLeft = `${sidePad}px`;
  body.style.paddingRight = `${sidePad}px`;
  body.style.paddingTop = `${padTop}px`;
  body.style.paddingBottom = `${bottomPad}px`;
  if (text) text.style.paddingTop = "0";

  return (
    padTop +
    bottomPad +
    (membersEl ? memberGap + (membersEl.offsetHeight || 14) : 0)
  );
}

function syncSlotChipCentering(chip, body, text, { mobileAgenda = false } = {}) {
  if (!body || !text) return;

  const badge = getVisibleSlotBadge(chip);

  if (mobileAgenda) {
    body.style.paddingLeft = "";
    body.style.paddingRight = "";
    body.style.paddingTop = "";
    body.style.paddingBottom = "";
    text.style.paddingTop = "";
    return;
  }

  if (isInlineTimedFlowChip(chip)) {
    syncInlineTimedBodyPadding(chip, body, text, getSlotChipMetaEl(chip));
    return;
  }

  // 작아진 종일 칩: 좌우 동일 패딩 + 중앙 정렬
  if (isAllDayChipCompact(chip)) {
    body.style.display = "flex";
    body.style.flexDirection = "column";
    body.style.justifyContent = "center";
    body.style.alignItems = "center";
    body.style.paddingLeft = "8px";
    body.style.paddingRight = "8px";
    body.style.paddingTop = "0";
    body.style.paddingBottom = "0";
    text.style.paddingTop = "0";
    text.style.textAlign = "center";
    text.style.width = "100%";
    return;
  }

  if (badge || isSidebarTimelineChip(chip)) {
    const badgeW = getBadgeContentInset(chip);
    if (badgeW > 0) {
      // 배지 너비 정확히 측정됨 → inline style로 정밀 패딩 설정
      body.style.paddingLeft = `${badgeW + 2}px`;
      body.style.paddingRight = "8px";
    }
    // badgeW=0: inline style 건드리지 않음 → CSS 기본값(padding: 0 8px 0 30px) 유지
    // (2번째 RAF에서 badgeW>0이 되면 정확한 값으로 업데이트됨)
    body.style.paddingTop = "0";
    body.style.paddingBottom = "0";
    text.style.paddingTop = "1px";
    return;
  }

  body.style.paddingLeft = "";
  body.style.paddingRight = "";
  body.style.paddingTop = "";
  body.style.paddingBottom = "";
  text.style.paddingTop = "1px";
}

function applyTimelineChipBox(chip, chipH) {
  chip.style.setProperty("flex", "0 0 auto", "important");
  chip.style.boxSizing = "border-box";
  chip.style.minHeight = `${chipH}px`;
  chip.style.height = `${chipH}px`;
  chip.style.maxHeight = `${chipH}px`;
  chip.style.overflow = "hidden";
  chip.style.alignSelf = "stretch";
}

function applyAllDayChipBox(chip, chipH) {
  resetChipTimelineSizing(chip);
  chip.style.setProperty("flex", "1 1 auto", "important");
  chip.style.boxSizing = "border-box";
  chip.style.minHeight = `${chipH}px`;
  chip.style.alignSelf = "stretch";
  chip.style.overflow = "hidden";
}

function isMobileAgendaChip(chip) {
  return Boolean(chip?.closest("#mobile-agenda"));
}

function fitTimelineSlot(chip, allocatedPx, { allDay = false } = {}) {
  const text = chip.querySelector(".slot-text");
  const body = chip.querySelector(".slot-chip-body");
  const membersEl = getSlotChipMetaEl(chip);
  if (!text) return;

  const multiline = String(text.textContent || "").includes("\n");
  chip.classList.toggle("slot-chip--multiline", multiline);

  const needsExtraRoom =
    !!membersEl &&
    !isMobileAgendaChip(chip) &&
    (multiline || chip.classList.contains("slot-chip--has-members"));

  const chipH = Math.max(SLOT_ABS_MIN + (needsExtraRoom ? 14 : 0), allocatedPx);
  const plain = true;
  const mobileAgenda = isMobileAgendaChip(chip);
  const memberGap = 2;
  const membersEstimate = membersEl && !mobileAgenda ? 14 : 0;

  if (allDay) {
    applyAllDayChipBox(chip, chipH);
    const hasTimedSibling = Boolean(
      chip.parentElement?.querySelector(":scope > .slot-chip:not(.slot-chip--all-day)"),
    );
    // 작아지거나 시간 일정과 섞이면 왼쪽 시간칸 숨김 + 제목 중앙
    const allDayCompact = hasTimedSibling || chipH < TIMELINE_HOUR_UNIT * 1.75;
    chip.classList.toggle("slot-chip--all-day-compact", allDayCompact);
  } else {
    applyTimelineChipBox(chip, chipH);
    chip.classList.remove("slot-chip--all-day-compact");
  }
  void chip.offsetHeight;

  // compact 클래스를 먼저 확정해야 아래 오버레이 패딩 판단이 정확해짐
  if (chip.classList.contains("slot-chip--inline-timed")) {
    if (chip.classList.contains("slot-chip--all-day-compact")) {
      chip.classList.add("slot-chip--inline-compact");
    } else {
      syncInlineChipCompactFromHeight(chip, chipH);
    }
  }

  // 본문 시간 표시(non-compact inline-timed): 상단 시간 오버레이 클리어용 패딩(상16+하4)
  const inlineTimedFlow =
    chip.classList.contains("slot-chip--inline-timed") &&
    !chip.classList.contains("slot-chip--inline-compact") &&
    !mobileAgenda;
  let layoutOverhead;
  if (inlineTimedFlow) {
    // 대칭 소패딩 + 멤버(있으면 gap + 실제 높이)
    layoutOverhead = 4 + (membersEl ? memberGap + (membersEl.offsetHeight || 16) : 0);
  } else {
    layoutOverhead = membersEl && !mobileAgenda
      ? 10 + memberGap + (membersEl.offsetHeight || membersEstimate)
      : plain
        ? 8
        : 4;
  }
  const maxTextH = Math.max(10, chipH - layoutOverhead);

  let layoutKind = "plain";
  if (body) {
    if (plain) {
      layoutKind = applySlotChipBodyLayout(body, text, membersEl, { mobileAgenda, chip }) || "plain";
      body.style.minHeight = "100%";
      body.style.height = "100%";
      body.style.boxSizing = "border-box";
      syncSlotChipCentering(chip, body, text, { mobileAgenda });
    } else {
      body.style.display = "";
      body.style.placeItems = "";
      body.style.alignContent = "";
      body.style.minHeight = "";
      body.style.height = "";
      body.style.padding = "";
    }
  }

  text.style.width = "100%";
  text.style.margin = "0";

  if (mobileAgenda) {
    text.style.display = "block";
    text.style.overflow = "hidden";
    text.style.whiteSpace = "pre-line";
    text.style.wordBreak = "keep-all";
    text.style.overflowWrap = "anywhere";
    text.style.fontSize = "";
    text.style.lineHeight = "1.35";
    text.style.textAlign = "left";
    text.style.paddingTop = "";
    text.style.webkitLineClamp = "";
    text.style.webkitBoxOrient = "";
    text.style.textOverflow = "";
    return;
  }

  // ── line-clamp + 내용이 길면 폰트 축소 ──
  const rootFontPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const lineHeightMult = multiline ? 1.28 : 1.22;

  text.style.display = "-webkit-box";
  text.style.webkitBoxOrient = "vertical";
  text.style.overflow = "hidden";
  text.style.textOverflow = "ellipsis";
  text.style.whiteSpace = multiline ? "pre-line" : "normal";
  text.style.wordBreak = "keep-all";
  text.style.overflowWrap = "anywhere";
  text.style.textAlign = "center";
  text.style.paddingTop = "1px";
  text.style.paddingLeft = "2px";
  text.style.paddingRight = "2px";
  text.style.boxSizing = "border-box";
  text.style.lineHeight = String(lineHeightMult);

  // 제목 폰트 대비 멤버 폰트 비율(제목보다 항상 작게) + 멤버 폰트 하한
  const MEMBERS_RATIO = 0.62;
  const MEMBERS_FONT_MIN = 0.5;

  // 제목이 실제로 쓸 수 있는 세로 높이를 DOM에서 직접 측정 (추정 overhead보다 정확)
  // 멤버 폰트가 바뀌면 멤버 높이도 바뀌므로 매번 다시 측정
  const measureAvailableTextH = () => {
    if (body && body.clientHeight > 0) {
      const bs = getComputedStyle(body);
      const bodyContentH =
        body.clientHeight -
        (parseFloat(bs.paddingTop) || 0) -
        (parseFloat(bs.paddingBottom) || 0);
      if (membersEl && !mobileAgenda) {
        const membersH = membersEl.offsetHeight || 14;
        return Math.max(10, bodyContentH - membersH - memberGap);
      }
      return Math.max(10, bodyContentH);
    }
    return maxTextH;
  };

  let fontSize = TIMELINE_FONT_DEFAULT;

  const applyFontWithClamp = () => {
    text.style.fontSize = `${fontSize}rem`;
    // 멤버 폰트를 제목에 비례시켜 함께 축소
    if (membersEl && !mobileAgenda) {
      const mf = Math.max(MEMBERS_FONT_MIN, fontSize * MEMBERS_RATIO);
      membersEl.style.fontSize = `${mf.toFixed(3)}rem`;
    }
    const availableTextH = measureAvailableTextH();
    const lineHeightPx = fontSize * rootFontPx * lineHeightMult;
    const maxLines = Math.max(1, Math.floor(availableTextH / lineHeightPx));
    text.style.webkitLineClamp = String(maxLines);
  };

  const badgeMeasured = !isSidebarTimelineChip(chip) || getBadgeContentInset(chip) > 0;
  const membersClipMargin = 2;
  const membersOverflow = () => {
    if (!membersEl || mobileAgenda) return false;
    const chipRect = chip.getBoundingClientRect();
    const memRect = membersEl.getBoundingClientRect();
    return memRect.bottom > chipRect.bottom - membersClipMargin;
  };
  const layoutBroken = () => membersOverflow() || membersOverlapTitle(text, membersEl);
  const applyMemberLayout = () => {
    if (!membersEl || mobileAgenda) return;
    if (layoutKind === "inline-members") {
      layoutMembersBelowCenteredTitle(body, text, membersEl, { gap: memberGap });
    } else if (layoutKind === "compact-members-flex" || layoutKind === "inline-timed-flow") {
      membersEl.style.marginTop = `${memberGap}px`;
    }
  };

  applyFontWithClamp();
  applyMemberLayout();

  if (badgeMeasured) {
    while (fontSize > TIMELINE_FONT_MIN && (text.scrollHeight > text.clientHeight + 1 || layoutBroken())) {
      fontSize -= TIMELINE_FONT_STEP;
      applyFontWithClamp();
      applyMemberLayout();
    }
  }

  const fontMax = membersEl && !mobileAgenda ? TIMELINE_FONT_MAX_WITH_MEMBERS : TIMELINE_FONT_MAX;
  while (fontSize + TIMELINE_FONT_STEP <= fontMax) {
    const next = fontSize + TIMELINE_FONT_STEP;
    fontSize = next;
    applyFontWithClamp();
    applyMemberLayout();
    if (text.scrollHeight > text.clientHeight + 1 || layoutBroken()) {
      fontSize -= TIMELINE_FONT_STEP;
      applyFontWithClamp();
      applyMemberLayout();
      break;
    }
  }

  if (membersEl && !mobileAgenda && layoutKind === "inline-members") {
    while (fontSize > TIMELINE_FONT_MIN && layoutBroken()) {
      fontSize -= TIMELINE_FONT_STEP;
      applyFontWithClamp();
      layoutMembersBelowCenteredTitle(body, text, membersEl, { gap: memberGap });
    }
  }

  // 본문 시간 표시: 폰트 확정 후 겹침 여부에 따라 상단 패딩 조정 → 필요 시 폰트 재조정
  if (inlineTimedFlow && body) {
    const prevPadTop = parseFloat(getComputedStyle(body).paddingTop) || 2;
    syncInlineTimedBodyPadding(chip, body, text, membersEl, { memberGap });
    const nextPadTop = parseFloat(getComputedStyle(body).paddingTop) || 2;
    if (nextPadTop > prevPadTop + 2) {
      applyFontWithClamp();
      while (
        fontSize > TIMELINE_FONT_MIN &&
        (text.scrollHeight > text.clientHeight + 1 || layoutBroken())
      ) {
        fontSize -= TIMELINE_FONT_STEP;
        applyFontWithClamp();
      }
      syncInlineTimedBodyPadding(chip, body, text, membersEl, { memberGap });
    }
    if (membersEl) {
      while (fontSize > TIMELINE_FONT_MIN && layoutBroken()) {
        fontSize -= TIMELINE_FONT_STEP;
        applyFontWithClamp();
        syncInlineTimedBodyPadding(chip, body, text, membersEl, { memberGap });
      }
    }
  }
}

function getDefaultDayCellMinHeight(cell) {
  if (cell) return getDayCellMinHeight(cell, 0);
  return 28 + 13 + 5 + getDefaultSlotsHeight() + 2;
}

function slotListGap(list) {
  const style = getComputedStyle(list);
  const gap = parseFloat(style.rowGap || style.gap);
  return Number.isFinite(gap) ? gap : TIMELINE_SLOT_GAP;
}

const MULTIPART_SLOT_MIN = 42;
const MULTIPART_SLOT_MAX = 72;
const MULTIPART_HOUR_UNIT = 18;
const TIMED_CHIP_MIN = 40;

// 2부 분할 셀: 각 칩을 소요 시간 기반(최소/최대 클램프)으로 크기 지정한다.
// 셀이 같은 행의 큰 칸 높이에 맞춰 늘어나도 칩이 과도하게 부풀지 않도록 내용 기준으로 고정한다.
function multipartChipTargetHeight(chip) {
  if (isAllDayChip(chip)) return Math.max(MULTIPART_SLOT_MIN, TIMELINE_HOUR_UNIT);
  const hours = getSlotHoursFromChip(chip);
  let h = Math.min(MULTIPART_SLOT_MAX, Math.max(MULTIPART_SLOT_MIN, hours * MULTIPART_HOUR_UNIT));
  if (chip?.classList?.contains("slot-chip--has-members")) {
    h = Math.max(h, 52);
  }
  return h;
}

function multipartSlotTargetHeight(slot) {
  if (isAllDaySlot(slot)) return Math.max(MULTIPART_SLOT_MIN, TIMELINE_HOUR_UNIT);
  const hours = slotHours(slot);
  return Math.min(MULTIPART_SLOT_MAX, Math.max(MULTIPART_SLOT_MIN, hours * MULTIPART_HOUR_UNIT));
}

function fitMultipartList(list, chips, bandHeight) {
  if (!chips.length) return;
  if (bandHeight != null && bandHeight > 0) {
    fitTimedChipBand(chips, bandHeight);
    return;
  }
  chips.forEach((chip) => {
    fitTimelineSlot(chip, multipartChipTargetHeight(chip), { allDay: isAllDayChip(chip) });
  });
}

/** 2부 분할 셀: 행 여유 높이는 1·2부 박스가 아니라 칩 높이에만 배분 (박스 간격 유지) */
function fitMultipartCell(cell) {
  const partsWrap = cell.querySelector(".day-parts");
  if (!partsWrap) return;

  const parts = [...partsWrap.querySelectorAll(".day-part")];
  if (!parts.length) return;

  parts.forEach((part) => {
    part.style.removeProperty("flex");
    part.style.removeProperty("min-height");
  });

  const cellStyle = getComputedStyle(cell);
  const headH = cell.querySelector(".day-head")?.offsetHeight ?? 28;
  const padY = (parseFloat(cellStyle.paddingTop) || 0) + (parseFloat(cellStyle.paddingBottom) || 0);
  const cellGap = parseFloat(cellStyle.gap) || 5;
  const partsGap = parseFloat(getComputedStyle(partsWrap).rowGap || getComputedStyle(partsWrap).gap) || 4;

  const available = Math.max(0, cell.clientHeight - headH - padY - cellGap);
  const betweenGaps = Math.max(0, parts.length - 1) * partsGap;
  const dividerPad = parts.slice(1).reduce((sum, part) => {
    return sum + (parseFloat(getComputedStyle(part).paddingTop) || 0);
  }, 0);

  const meta = parts.map((part) => {
    const headEl = part.querySelector(".day-part-head");
    const headPartH = headEl?.offsetHeight ?? 0;
    const partInnerGap = parseFloat(getComputedStyle(part).gap) || 4;
    const list = part.querySelector(".slot-list:not(.slot-list--all-day)");
    const chips = list ? [...list.querySelectorAll(".slot-chip")] : [];
    const chipListGap = list ? slotListGap(list) : TIMELINE_SLOT_GAP;
    const chipGaps = Math.max(0, chips.length - 1) * chipListGap;
    const chipFloor = chips.reduce((sum, chip) => sum + multipartChipTargetHeight(chip), 0);
    const hours = Math.max(1, chips.reduce((sum, chip) => sum + getSlotHoursFromChip(chip), 0));
    return { part, list, chips, headPartH, partInnerGap, chipGaps, chipFloor, hours };
  });

  const structureH = betweenGaps + dividerPad + meta.reduce(
    (sum, m) => sum + m.headPartH + m.partInnerGap,
    0
  );
  const chipsFloor = meta.reduce((sum, m) => sum + m.chipFloor + m.chipGaps, 0);
  const totalFloor = structureH + chipsFloor;
  let extra = Math.max(0, available - totalFloor);
  let chipScale = 1;
  if (totalFloor > available && chipsFloor > 0) {
    chipScale = Math.max(0.72, (available - structureH) / chipsFloor);
    extra = 0;
  }
  const weightSum = meta.reduce((sum, m) => sum + m.hours, 0) || 1;

  meta.forEach((m) => {
    if (!m.list || !m.chips.length) return;
    m.list.style.removeProperty("flex");
    m.list.style.removeProperty("min-height");
    const baseBand = (m.chipFloor + m.chipGaps) * chipScale;
    const partExtra = chipScale >= 1 ? (extra * m.hours) / weightSum : 0;
    fitMultipartList(m.list, m.chips, baseBand + partExtra);
  });
}

// 고정 높이 밴드 안에서 칩을 배분하되, 짧은 일정이 글자가 잘릴 만큼 찌그러지지 않도록
// 칩마다 최소 높이를 먼저 확보한 뒤 남는 공간만 소요 시간 비율로 나눠준다.
function fitTimedChipBand(chips, bodyHeight) {
  if (!chips.length) return;
  const space = Math.max(0, bodyHeight);
  const minH = Math.min(TIMED_CHIP_MIN, space / chips.length);
  const remaining = Math.max(0, space - minH * chips.length);
  const totalHours = Math.max(
    1,
    chips.reduce((sum, chip) => sum + getSlotHoursFromChip(chip), 0)
  );
  chips.forEach((chip) => {
    const extra = (remaining * getSlotHoursFromChip(chip)) / totalHours;
    fitTimelineSlot(chip, minH + extra);
  });
}

function maybeSyncInlineCompactChips(root = document) {
  if (getSlotChipStyle() !== "inline") return;
  // compact·패딩 확정 후 글자 맞춤을 다시 실행 (첫 로드에서 ...만 보이는 현상 방지)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      syncInlineCompactChips(root);
      root.querySelectorAll(".slot-chip--inline-timed").forEach((chip) => {
        bindInlineCompactChip(chip);
        const body = chip.querySelector(".slot-chip-body");
        const text = chip.querySelector(".slot-text");
        if (body && text) syncSlotChipCentering(chip, body, text, {});
      });
      const grid = root.id === "calendar" ? root : root.querySelector?.("#calendar");
      if (grid) fitTimelineSlotText(grid, { skipCompactSync: true });
    });
  });
}

function fitTimelineSlotText(
  root = document.getElementById("calendar"),
  { skipCompactSync = false } = {}
) {
  if (!root) return;
  const slotsH = getFixedSlotsAreaHeight();
  document.documentElement.style.setProperty("--hour-unit", `${TIMELINE_HOUR_UNIT}px`);
  document.documentElement.style.setProperty("--day-slots-height", `${slotsH}px`);

  root.querySelectorAll(".day-cell[data-date]").forEach((cell) => {
    if (cell.classList.contains("day-cell--multipart")) {
      fitMultipartCell(cell);
      return;
    }

    cell.querySelectorAll(".slot-list:not(.slot-list--all-day)").forEach((list) => {
      const chips = [...list.querySelectorAll(".slot-chip")];
      if (!chips.length) return;

      const allDayChips = chips.filter(isAllDayChip);
      const timedChips = chips.filter((chip) => !isAllDayChip(chip));
      const listGap = slotListGap(list);
      const flexGaps = Math.max(0, chips.length - 1) * listGap;
      const bodySpace = slotsH - flexGaps;

      let totalHours = 0;
      timedChips.forEach((chip) => {
        totalHours += getSlotHoursFromChip(chip);
      });
      totalHours = Math.max(1, totalHours);

      list.style.setProperty("--day-slots-height", `${slotsH}px`);
      list.style.setProperty("--slot-total-hours", String(totalHours));

      if (!timedChips.length) {
        const chipH = bodySpace / Math.max(1, allDayChips.length);
        allDayChips.forEach((chip) => fitTimelineSlot(chip, chipH, { allDay: true }));
        return;
      }

      let remaining = bodySpace;
      allDayChips.forEach((chip) => {
        fitTimelineSlot(chip, TIMELINE_HOUR_UNIT, { allDay: true });
        remaining -= TIMELINE_HOUR_UNIT;
      });

      fitTimedChipBand(timedChips, remaining);
    });
  });
  if (!skipCompactSync) maybeSyncInlineCompactChips(root);
}

function syncTimelineLayout(grid, wrap) {
  const totalCells = grid.children.length;
  const rows = Math.max(1, Math.ceil(totalCells / 7));
  grid.style.setProperty("--calendar-rows", String(rows));
  grid.dataset.calendarRows = String(rows);

  document.documentElement.style.setProperty("--hour-unit", `${TIMELINE_HOUR_UNIT}px`);
  document.documentElement.style.setProperty("--day-slots-height", `${getFixedSlotsAreaHeight()}px`);

  const sampleCell = grid.querySelector(".day-cell[data-date]") || grid.querySelector(".day-cell:not(.empty)");
  const rowMin = getDefaultDayCellMinHeight(sampleCell);
  grid.style.setProperty("--calendar-row-min", `${rowMin}px`);
  grid.style.gridTemplateRows = `repeat(var(--calendar-rows), minmax(var(--calendar-row-min), auto))`;

  grid.querySelectorAll(".day-cell").forEach((cell) => {
    if (!cell.dataset.date) {
      cell.style.minHeight = `${rowMin}px`;
      return;
    }

    cell.classList.remove("day-cell--scroll");
    cell.style.removeProperty("--cell-slot-min");

    const slotsH = getFixedSlotsAreaHeight();
    cell.style.minHeight = `${getDayCellMinHeight(cell, slotsH)}px`;
  });

  grid.querySelectorAll(".slot-list").forEach((list) => {
    list.style.removeProperty("min-height");
    list.style.removeProperty("height");
    list.style.removeProperty("max-height");
    list.scrollTop = 0;
  });

  updateSlotOverflowHints();

  const runFit = () => {
    requestAnimationFrame(() => {
      fitTimelineSlotText(grid);
      requestAnimationFrame(() => fitTimelineSlotText(grid));
    });
  };
  runFit();
  if (document.fonts?.ready) {
    document.fonts.ready.then(runFit).catch(() => {});
  }
}

function syncHourlyLayout(grid) {
  const totalCells = grid.children.length;
  const rows = Math.max(1, Math.ceil(totalCells / 7));
  grid.style.setProperty("--calendar-rows", String(rows));
  grid.dataset.calendarRows = String(rows);

  document.documentElement.style.setProperty("--hour-unit", `${TIMELINE_HOUR_UNIT}px`);

  const sampleCell = grid.querySelector(".day-cell[data-date]") || grid.querySelector(".day-cell:not(.empty)");
  const rowMin = getDefaultDayCellMinHeight(sampleCell);
  grid.style.setProperty("--calendar-row-min", `${rowMin}px`);
  grid.style.gridTemplateRows = `repeat(var(--calendar-rows), minmax(var(--calendar-row-min), auto))`;

  grid.querySelectorAll(".day-cell").forEach((cell) => {
    if (!cell.dataset.date) {
      cell.style.minHeight = `${rowMin}px`;
      return;
    }

    cell.classList.remove("day-cell--scroll");
    cell.style.removeProperty("--cell-slot-min");

    const list = cell.querySelector(".slot-list:not(.slot-list--all-day)");
    let slotsH = getDefaultSlotsHeight();
    if (list) {
      const chips = [...list.querySelectorAll(".slot-chip")];
      const timedChips = chips.filter((chip) => !chip.classList.contains("slot-chip--all-day"));
      const onlyAllDay = chips.length > 0 && timedChips.length === 0;

      if (!onlyAllDay && timedChips.length) {
        const gaps = Math.max(0, chips.length - 1) * TIMELINE_SLOT_GAP;
        let contentH = 0;
        timedChips.forEach((chip) => {
          contentH += getSlotHoursFromChip(chip) * TIMELINE_HOUR_UNIT;
        });
        slotsH = Math.max(slotsH, contentH + gaps);
      }

      list.style.minHeight = `${slotsH}px`;
      if (onlyAllDay) {
        list.style.height = `${slotsH}px`;
      } else {
        list.style.removeProperty("height");
        list.style.removeProperty("max-height");
      }
    }

    cell.style.minHeight = `${getDayCellMinHeight(cell, slotsH)}px`;
  });

  grid.querySelectorAll(".slot-list").forEach((list) => {
    list.scrollTop = 0;
  });

  updateSlotOverflowHints();

  requestAnimationFrame(() => {
    fitHourlySlotText(grid);
    requestAnimationFrame(() => fitHourlySlotText(grid));
  });
}

function fitHourlySlotText(root = document.getElementById("calendar")) {
  if (!root) return;
  root.querySelectorAll(".slot-list:not(.slot-list--all-day)").forEach((list) => {
    const chips = [...list.querySelectorAll(".slot-chip")];
    if (!chips.length) return;

    const allDayChips = chips.filter(isAllDayChip);
    const timedChips = chips.filter((chip) => !isAllDayChip(chip));
    const onlyAllDay = timedChips.length === 0;

    if (onlyAllDay) {
      const listH = list.clientHeight || getDefaultSlotsHeight();
      const chipH =
        (listH - Math.max(0, allDayChips.length - 1) * TIMELINE_SLOT_GAP) /
        Math.max(1, allDayChips.length);
      allDayChips.forEach((chip) => fitTimelineSlot(chip, chipH, { allDay: true }));
      return;
    }

    allDayChips.forEach((chip) => fitTimelineSlot(chip, TIMELINE_HOUR_UNIT, { allDay: true }));
    timedChips.forEach((chip) => {
      const hours = getSlotHoursFromChip(chip);
      fitTimelineSlot(chip, hours * TIMELINE_HOUR_UNIT);
    });
  });
  maybeSyncInlineCompactChips(root);
}

function syncMobileHourlyLayout(agenda) {
  agenda.querySelectorAll(".mobile-agenda-day[data-date]").forEach((cell) => {
    const list = cell.querySelector(".slot-list:not(.slot-list--all-day)");
    let slotsH = getDefaultSlotsHeight();
    if (list) {
      const chips = [...list.querySelectorAll(".slot-chip")];
      const timedChips = chips.filter((chip) => !chip.classList.contains("slot-chip--all-day"));
      const onlyAllDay = chips.length > 0 && timedChips.length === 0;

      if (!onlyAllDay && timedChips.length) {
        const gaps = Math.max(0, chips.length - 1) * TIMELINE_SLOT_GAP;
        let contentH = 0;
        timedChips.forEach((chip) => {
          contentH += getSlotHoursFromChip(chip) * TIMELINE_HOUR_UNIT;
        });
        slotsH = Math.max(slotsH, contentH + gaps);
      }

      list.style.minHeight = `${slotsH}px`;
      if (onlyAllDay) {
        list.style.height = `${slotsH}px`;
      } else {
        list.style.removeProperty("height");
        list.style.removeProperty("max-height");
      }
    }

    cell.style.minHeight = `${getDayCellMinHeight(cell, slotsH)}px`;
  });

  agenda.querySelectorAll(".slot-list").forEach((list) => {
    list.scrollTop = 0;
  });
}

function syncMobileProportionalLayout(agenda) {
  const slotsH = getFixedSlotsAreaHeight();
  document.documentElement.style.setProperty("--day-slots-height", `${slotsH}px`);

  agenda.querySelectorAll(".mobile-agenda-day[data-date]").forEach((cell) => {
    cell.style.minHeight = `${getDayCellMinHeight(cell, slotsH)}px`;
  });

  agenda.querySelectorAll(".slot-list").forEach((list) => {
    list.style.removeProperty("min-height");
    list.style.removeProperty("height");
    list.style.removeProperty("max-height");
    list.scrollTop = 0;
  });
}

function flushMobileScrollToToday() {
  if (mobileScrollToTop) {
    mobileScrollToTop = false;
    if (!isMobileViewport()) return;
    scrollMobileAgendaToTop();
    return;
  }
  if (!mobileScrollToToday) return;
  if (!isMobileViewport()) {
    mobileScrollToToday = false;
    pendingMobileScrollDate = undefined;
    return;
  }
  if (!document.body.classList.contains("mobile-tab-calendar")) return;
  mobileScrollToToday = false;
  const iso = pendingMobileScrollDate;
  pendingMobileScrollDate = undefined;
  if (iso) scrollMobileAgendaToDate(iso);
  else scrollMobileAgendaToToday();
}

function syncMobileAgendaLayout() {
  // 새 모바일 아젠다는 순수 CSS 레이아웃 → 칩 피팅 불필요. 스크롤 위치만 처리.
  if (!isMobileViewport()) return;
  const agenda = document.getElementById("mobile-agenda");
  if (!agenda) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => flushMobileScrollToToday());
  });
}

function syncCalendarLayout() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (isMobileViewport()) {
        syncMobileAgendaLayout();
        return;
      }
      const wrap = document.querySelector(".calendar-wrap");
      const grid = document.getElementById("calendar");
      if (!wrap || !grid || !scheduleData) return;
      if (isHourlyLayout()) {
        syncHourlyLayout(grid);
        return;
      }
      syncTimelineLayout(grid, wrap);
    });
  });
}

function buildDayCell(key, days, cats, todayKey) {
  const dayData = days[key];
  const [, , dStr] = key.split("-");
  const d = Number(dStr);
  const dt = new Date(key);
  const dow = dt.getDay();
  const dowClass = dow === 0 ? "sun" : dow === 6 ? "sat" : "";
  const isTodayKey = key === todayKey;
  const isToday = isTodayKey ? " today" : "";
  const editClass = canEditSlotsNow() ? " day-cell--editable" : "";
  const detailLabel = `${formatFullDate(key)} 자세히 보기`;

  const parts = getDayParts(dayData);
  const multiPart = parts.length > 1;

  let bodyHtml;
  let bangonBadge = "";

  if (multiPart) {
    // 부 헤더(2부만) + 칩 내용 높이의 합으로 각 부가 필요로 하는 최소 높이를 계산한다.
    const partMinHeight = (part, idx) => {
      const slots = part.slots || [];
      const count = Math.max(1, slots.length);
      const chipGaps = Math.max(0, count - 1) * TIMELINE_SLOT_GAP;
      const chipsH = slots.length
        ? slots.reduce((sum, slot) => sum + multipartSlotTargetHeight(slot), 0)
        : MULTIPART_SLOT_MIN;
      const headH = idx === 0 ? 0 : 18 + 3;
      return headH + chipsH + chipGaps;
    };
    bodyHtml = `<div class="day-parts">${parts
      .map((part, idx) => {
        const isFirstPart = idx === 0;
        const partBangon =
          !isFirstPart && !isOffDaySlots(part.slots)
            ? renderDayBangonBadge(part.bangonTime)
            : "";
        const partHead = isFirstPart
          ? ""
          : `<div class="day-part-head">
            <span class="day-part-label">${idx + 1}부</span>
            ${partBangon}
          </div>`;
        const listHtml =
          isEditing()
            ? renderDaySlotList(part, cats, {
                dateKey: key,
                part: idx,
                ...slotRenderOptions(),
                editable: true,
                editableClass: false,
              })
            : renderDaySlotList(part, cats, {
                dateKey: key,
                part: idx,
                ...slotRenderOptions(),
              });
        return `<div class="day-part" data-part="${idx}" style="--part-min-height:${partMinHeight(part, idx)}px;">
          ${partHead}
          ${listHtml || '<div class="slot-list"></div>'}
        </div>`;
      })
      .join("")}</div>`;
    const part1 = parts[0];
    bangonBadge =
      part1 && !isOffDaySlots(part1.slots)
        ? renderDayBangonBadge(part1.bangonTime)
        : "";
  } else {
    bodyHtml =
      (isEditing()
        ? renderEditableSlots(dayData, key)
        : renderDaySlots(dayData, cats, { dateKey: key, ...slotRenderOptions() })) ||
      '<div class="slot-list"></div>';
    bangonBadge = isBangonHiddenForDay(key)
      ? ""
      : renderDayBangonBadge(getBangonTimeForDay(key));
  }

  return `
    <div class="day-cell ${dowClass}${isToday}${editClass}${
      multiPart ? " day-cell--multipart" : ""
    }" data-date="${key}"${isTodayKey ? ' aria-current="date"' : ""}>
      <div class="day-head day-head--detail" role="button" tabindex="0" title="${isTodayKey ? "오늘 · " : ""}자세히 보기" aria-label="${detailLabel}">
        <div class="day-head-date">
          <div class="day-num">${d}</div>
        </div>
        ${bangonBadge}
      </div>
      ${bodyHtml}
    </div>`;
}

function renderCalendar() {
  if (!scheduleData) {
    if (isMobileViewport()) {
      setMobileAgendaVisible(true);
      const el = document.getElementById("mobile-agenda");
      if (el) el.innerHTML = `<p class="mobile-agenda-empty">일정을 불러오는 중…</p>`;
    }
    return;
  }

  const grid = document.getElementById("calendar");
  const days = scheduleData.days || {};
  const cats = scheduleData.categories || {};
  const todayKey = dateKey(
    new Date().getFullYear(),
    new Date().getMonth() + 1,
    new Date().getDate()
  );

  if (isMobileViewport()) {
    setMobileAgendaVisible(true);
    renderMobileAgenda(days, cats, todayKey);
    syncCalendarLayout();
    return;
  }

  setMobileAgendaVisible(false);

  const first = new Date(currentYear, currentMonth - 1, 1);
  const startPad = first.getDay();
  const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
  const cells = [];

  for (let i = 0; i < startPad; i++) {
    cells.push('<div class="day-cell empty"></div>');
  }

  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(buildDayCell(dateKey(currentYear, currentMonth, d), days, cats, todayKey));
  }

  grid.innerHTML = cells.join("");

  bindDayClicks();
  restoreEditorFocus();
  syncCalendarLayout();
}

function layoutDayModalItems(container) {
  if (!container) return;
  container.querySelectorAll(".day-detail-item").forEach((item) => {
    const foot = item.querySelector(".day-detail-foot");
    const footH = foot?.offsetHeight || 0;
    item.style.setProperty("--day-detail-foot-reserve", `${footH + 10}px`);
    const hasMembers = Boolean(item.querySelector(".day-detail-meta-row, .day-detail-members"));
    item.classList.toggle("day-detail-item--has-members", hasMembers);
  });
}

function fitDayModalItemText(container) {
  if (!container) return;
  layoutDayModalItems(container);
  void container.offsetHeight;
  layoutDayModalItems(container);

  container.querySelectorAll(".day-detail-item").forEach((item) => {
    const text = item.querySelector(".day-detail-text");
    const body = item.querySelector(".day-detail-body");
    const foot = item.querySelector(".day-detail-foot");
    const main = item.querySelector(".day-detail-main");
    if (!text || !body || !main) return;

    const hasMembers = item.classList.contains("day-detail-item--has-members");
    const members = item.querySelector(".day-detail-meta-row, .day-detail-members");
    const membersH = members?.offsetHeight || 0;
    const footH = foot?.offsetHeight || 0;
    const maxH = Math.max(18, body.clientHeight - footH - membersH - 18);

    text.style.fontSize = hasMembers ? "1rem" : "1.08rem";
    if (members) members.style.fontSize = "0.82rem";

    if (text.scrollHeight <= maxH + 1) return;

    let fontSize = hasMembers ? 1 : 1.08;
    const minSize = hasMembers ? 0.8 : 0.92;
    while (fontSize > minSize && text.scrollHeight > maxH + 1) {
      fontSize -= 0.025;
      text.style.fontSize = `${fontSize}rem`;
    }

    // 공간이 충분하면 본문(일정+멤버)을 중앙에, 부족하면 위쪽으로.
    // 줄바꿈이 있는 경우에도 여유가 있으면 중앙 정렬 유지.
    const contentH = (text.scrollHeight || 0) + (members?.offsetHeight || 0);
    const availableMainH = Math.max(0, body.clientHeight - footH - 12);
    main.style.justifyContent = availableMainH - contentH >= 18 ? "center" : "flex-start";
  });
}

function renderDayDetailActions(isoDate, index, slot, partIdx = 0) {
  if (!isEditing()) return "";
  const partAttr = ` data-part="${partIdx}"`;
  const highlightBtn =
    slot.text?.trim() && !highlightExistsForSlot(isoDate, slot.text)
      ? `<button type="button" class="day-detail-btn day-detail-btn--highlight" data-day-action="add-highlight" data-index="${index}"${partAttr}>주요일정에 넣기</button>`
      : "";
  return `<div class="day-detail-actions">
    ${highlightBtn}
    <button type="button" class="day-detail-btn" data-day-action="edit" data-index="${index}"${partAttr}>수정</button>
    <button type="button" class="day-detail-btn day-detail-btn--danger" data-day-action="delete" data-index="${index}"${partAttr}>삭제</button>
  </div>`;
}

function getSlotChipMetaEl(chip) {
  return chip?.querySelector(".slot-chip-meta") || chip?.querySelector(".slot-members");
}

function renderDayDetailLink(slot) {
  return renderSlotShortcutLinkHtml(slot, { className: "day-detail-link" });
}

function renderDayDetailMetaRow(slot) {
  const members = slotMembers(slot);
  if (!members) return "";
  return `<div class="day-detail-meta-row"><span class="day-detail-members" aria-label="멤버 ${escapeAttr(members)}">${renderSlotMembersMarkup(members)}</span></div>`;
}

function renderDayDetailFootAside(isoDate, index, slot, partIdx = 0) {
  const linkHtml = renderDayDetailLink(slot);
  const actions = renderDayDetailActions(isoDate, index, slot, partIdx);
  if (!linkHtml && !actions) return "";
  return `<div class="day-detail-foot-aside">${actions}${linkHtml}</div>`;
}

function rawDayDataForView(isoDate) {
  const d = scheduleData.days?.[isoDate];
  if (d) return d;
  const mk = isoDate.slice(0, 7);
  return fullSchedule?.months?.[mk]?.days?.[isoDate] || null;
}

function getModalParts(isoDate) {
  if (isEditing()) {
    const count = Math.max(getDayPartCount(isoDate), part2DraftDate === isoDate ? 2 : 1);
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push({ bangon: getPartBangonTime(isoDate, i), slots: getPartSlots(isoDate, i) });
    }
    return out;
  }
  return getDayParts(rawDayDataForView(isoDate)).map((p) => ({
    bangon: p.bangonTime || "",
    slots: p.slots || [],
  }));
}

function dayDetailColorStyle(cat) {
  const colors = resolveChipColors(getChipColorMode(), cat.bg, cat.text);
  return `--item-accent:${colors.bg};--item-text:${colors.text};--item-border:${colors.border}`;
}

function renderDayDetailItem(isoDate, slot, slotIndex, cats, partIdx = 0) {
  const cat = slotCategory(slot, cats);
  const allDay = isAllDaySlot(slot);
  const hours = allDay ? 1 : slotHours(slot);
  const startTime = slotStartTime(slot);
  const members = slotMembers(slot);
  const footAside = renderDayDetailFootAside(isoDate, slotIndex, slot, partIdx);
  const leftBadge = allDay
    ? `<span class="day-detail-duration day-detail-duration--all-day-label" aria-label="하루종일">종일</span>`
    : startTime
      ? renderStartTimeBadge(startTime, { compact: true, className: "day-detail-duration" })
      : `<span class="day-detail-duration day-detail-duration--empty" aria-hidden="true"></span>`;
  const metaRowHtml = renderDayDetailMetaRow(slot);
  const durationMeta = allDay
    ? `<span class="day-detail-tag day-detail-tag--muted day-detail-tag--all-day">하루종일</span>`
    : `<span class="day-detail-tag day-detail-tag--muted">${escapeHtml(`${hours}시간`)}</span>`;
  const hasLineBreak = String(slot.text || "").includes("\n");
  const visualHours = allDay
    ? Math.max(1, 1 + (members && hasLineBreak ? 0.6 : members || hasLineBreak ? 0.3 : 0))
    : Math.max(
        hours,
        hours + (members && hasLineBreak ? 0.6 : members || hasLineBreak ? 0.3 : 0),
      );
  const itemColors = dayDetailColorStyle(cat);
  const dragAttr = isEditing() ? ' draggable="true"' : "";
  const dragClass = isEditing() ? " day-detail-item--draggable" : "";
  const hasMeta = Boolean(members);
  return `
    <article class="day-detail-item${allDay ? " day-detail-item--all-day" : ""}${hasMeta ? " day-detail-item--has-members" : ""}${hasLineBreak ? " day-detail-item--multiline" : ""}${dragClass}"${dragAttr} data-slot-index="${slotIndex}" data-part="${partIdx}" style="--item-hours:${visualHours};${itemColors}">
      ${leftBadge}
      <div class="day-detail-body">
        <div class="day-detail-main">
          <p class="day-detail-text">${escapeHtml(displaySlotText(slot.text))}</p>
          ${metaRowHtml}
        </div>
        <div class="day-detail-foot">
          <div class="day-detail-meta">
            ${durationMeta}
            <span class="day-detail-tag">${escapeHtml(cat.label || slot.category)}</span>
          </div>
          ${footAside}
        </div>
      </div>
    </article>`;
}

function renderDayModalScheduleBody(isoDate, slots, cats, partIdx = 0) {
  if (!slots.length) {
    return `
      <div class="day-modal-empty">
        <span class="day-modal-empty-icon" aria-hidden="true">📅</span>
        <p class="day-modal-empty-title">등록된 일정이 없습니다</p>
        ${isEditing() ? '<p class="day-modal-empty-hint">아래 「+ 일정 추가」 또는 날짜 칸 우클릭으로 추가하세요.</p>' : ""}
      </div>`;
  }
  return `
    <div class="day-detail-list">
      ${slots
        .map((slot, index) => renderDayDetailItem(isoDate, slot, index, cats, partIdx))
        .join("")}
    </div>`;
}

function renderModalPartBangon(bangon, partIdx) {
  if (isEditing()) {
    return `
      <div class="day-modal-bangon day-modal-part-bangon" data-bangon-part="${partIdx}">
        <p class="bangon-picker-title">${partIdx + 1}부 뱅온 시간</p>
        ${renderBangonTimePickerMarkup(bangon)}
      </div>`;
  }
  if (!bangon) return "";
  return `
    <div class="day-modal-bangon-view">
      <span class="day-modal-bangon-value">${escapeHtml(formatBangonTimeDisplay(bangon))}</span>
    </div>`;
}

function openDayModal(isoDate) {
  if (!isoDate) return;
  closeContextMenu();
  closeCategoryContextMenu();
  closeSlotEdit();
  if (dayModalDate !== isoDate) part2DraftDate = null;
  dayModalDate = isoDate;
  const modal = document.getElementById("day-modal");
  const cats = scheduleData.categories || {};
  const editing = canEditSlotsNow();
  const isToday =
    isoDate ===
    dateKey(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());

  document.getElementById("day-modal-kicker").innerHTML = isToday
    ? '<span class="today-badge day-modal-today-badge">오늘</span>'
    : "";
  document.getElementById("day-modal-title").textContent = formatFullDate(isoDate);
  document.querySelector(".day-modal-card")?.classList.toggle("day-modal-card--today", isToday);

  const modalParts = getModalParts(isoDate);
  const multiPart = modalParts.length > 1;
  const schedule = document.getElementById("day-modal-schedule");
  const bangonWrap = document.getElementById("day-modal-bangon-wrap");
  const globalActions = document.getElementById("day-modal-actions");

  const globalAddBtn = document.getElementById("day-modal-add");
  if (multiPart) {
    // 부별 섹션 렌더 — 전역 뱅온 wrap / 전역 추가 버튼 숨김 (부별로 제공)
    bangonWrap?.classList.add("hidden");
    if (bangonWrap) bangonWrap.innerHTML = "";
    globalActions?.classList.toggle("hidden", !editing);
    globalAddBtn?.classList.add("hidden");

    schedule.innerHTML = modalParts
      .map((part, idx) => {
        const bangonHidden = isOffDaySlots(part.slots);
        const bangonHtml = bangonHidden ? "" : renderModalPartBangon(part.bangon, idx);
        const removeBtn =
          editing && idx === 1
            ? `<button type="button" class="day-modal-part-remove" data-day-action="remove-second-part">2부 삭제</button>`
            : "";
        const addBtn = editing
          ? `<div class="day-modal-part-actions"><button type="button" class="day-modal-add day-modal-add--part" data-day-action="add-part-slot" data-part="${idx}">+ ${idx + 1}부 일정 추가</button></div>`
          : "";
        return `
          <section class="day-modal-part" data-part="${idx}">
            <div class="day-modal-part-head">
              <span class="day-modal-part-label">${idx + 1}부</span>
              ${removeBtn}
            </div>
            ${bangonHtml}
            ${renderDayModalScheduleBody(isoDate, part.slots, cats, idx)}
            ${addBtn}
          </section>`;
      })
      .join("");
  } else {
    renderDayModalBangon(isoDate);
    globalActions?.classList.toggle("hidden", !editing);
    globalAddBtn?.classList.remove("hidden");
    const slots = modalParts[0]?.slots || getSlotsForDay(isoDate);
    schedule.innerHTML = renderDayModalScheduleBody(isoDate, slots, cats, 0);

    // 1부 일정이 있으면 "2부 추가" 버튼 제공
    if (editing && slots.length) {
      schedule.insertAdjacentHTML(
        "beforeend",
        `<div class="day-modal-part-actions day-modal-add-part-wrap"><button type="button" class="day-modal-add day-modal-add--second" data-day-action="add-second-part">＋ 2부 추가</button></div>`
      );
    }
  }

  document.documentElement.style.setProperty("--day-modal-hour-unit", `${DAY_MODAL_HOUR_UNIT}px`);
  requestAnimationFrame(() => {
    if (!isMobileViewport()) fitDayModalItemText(schedule);
  });

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  lockPageScroll();
}

function closeDayModal() {
  dayModalDate = null;
  part2DraftDate = null;
  const modal = document.getElementById("day-modal");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  unlockPageScroll();
}

function layoutPanelState() {
  return {
    disabled: !canEditDesignNow(),
    proportionalMinSlots: getProportionalMinSlots(),
    hourlyMinSlots: getHourlyMinSlots(),
  };
}

function renderDesignPanel() {
  renderLayoutPanel(document.getElementById("layout-options"), getCalendarLayout(), layoutPanelState());
  renderFontOptions(document.getElementById("layout-font-options"), layoutPanelState());
}

async function saveCalendarMeta(patch) {
  const hasMeta = Object.keys(patch).some((k) =>
    ["streamerName", "debutDate", "platformNote", "categories"].includes(k)
  );
  const hasDesign = Object.keys(patch).some((k) =>
    !["streamerName", "debutDate", "platformNote", "categories"].includes(k)
  );
  if (hasMeta && !canEditScheduleMeta(currentMe)) return;
  if (hasDesign && !canEditScheduleDesign(currentMe)) return;
  const prevLayout = getCalendarLayout();
  const prevSlotChipStyle = getSlotChipStyle();
  const prevChipColorMode = getChipColorMode();
  const prevProportionalMinSlots = getProportionalMinSlots();
  const prevHourlyMinSlots = getHourlyMinSlots();
  const prevCalendarFont = getCalendarFont();
  const prevSidebarFont = getSidebarFont();
  const prevCalendarBold = getCalendarBold();
  const prevSidebarBold = getSidebarBold();

  if (patch.calendarLayout != null) applyCalendarLayout(patch.calendarLayout);
  if (patch.slotChipStyle != null) applySlotChipStyle(patch.slotChipStyle);
  if (patch.chipColorMode != null) applyChipColorMode(patch.chipColorMode);
  if (patch.proportionalMinSlots != null) applyProportionalMinSlots(patch.proportionalMinSlots);
  if (patch.hourlyMinSlots != null) applyHourlyMinSlots(patch.hourlyMinSlots);
  if (patch.calendarFont != null) applyCalendarFont(patch.calendarFont);
  if (patch.sidebarFont != null) applySidebarFont(patch.sidebarFont);
  if (patch.calendarFontBold != null) applyCalendarBold(patch.calendarFontBold);
  if (patch.sidebarFontBold != null) applySidebarBold(patch.sidebarFontBold);

  renderDesignPanel();
  renderFontCredit();

  try {
    const res = await apiFetch("/api/schedule/meta", {
      method: "PUT",
      body: JSON.stringify(patch),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.hint || body.error || "디자인 저장 실패");
    }
    if (body.revision != null) {
      applyScheduleRevision(String(body.revision));
    } else {
      await syncScheduleRevision();
    }
    resetScheduleSaveBaseline();
    if (fullSchedule) {
      if (patch.calendarLayout != null) fullSchedule.calendarLayout = patch.calendarLayout;
      if (patch.slotChipStyle != null) fullSchedule.slotChipStyle = patch.slotChipStyle;
      if (patch.chipColorMode != null) fullSchedule.chipColorMode = patch.chipColorMode;
      if (patch.proportionalMinSlots != null) fullSchedule.proportionalMinSlots = patch.proportionalMinSlots;
      if (patch.hourlyMinSlots != null) fullSchedule.hourlyMinSlots = patch.hourlyMinSlots;
      if (patch.calendarFont != null) fullSchedule.calendarFont = patch.calendarFont;
      if (patch.sidebarFont != null) fullSchedule.sidebarFont = patch.sidebarFont;
      if (patch.calendarFontBold != null) fullSchedule.calendarFontBold = patch.calendarFontBold;
      if (patch.sidebarFontBold != null) fullSchedule.sidebarFontBold = patch.sidebarFontBold;
    }
    if (scheduleData) {
      if (patch.calendarLayout != null) scheduleData.calendarLayout = patch.calendarLayout;
      if (patch.slotChipStyle != null) scheduleData.slotChipStyle = patch.slotChipStyle;
      if (patch.chipColorMode != null) scheduleData.chipColorMode = patch.chipColorMode;
      if (patch.proportionalMinSlots != null) scheduleData.proportionalMinSlots = patch.proportionalMinSlots;
      if (patch.hourlyMinSlots != null) scheduleData.hourlyMinSlots = patch.hourlyMinSlots;
      if (patch.calendarFont != null) scheduleData.calendarFont = patch.calendarFont;
      if (patch.sidebarFont != null) scheduleData.sidebarFont = patch.sidebarFont;
      if (patch.calendarFontBold != null) scheduleData.calendarFontBold = patch.calendarFontBold;
      if (patch.sidebarFontBold != null) scheduleData.sidebarFontBold = patch.sidebarFontBold;
    }
    renderCalendar();
  } catch (err) {
    applyCalendarLayout(prevLayout);
    applySlotChipStyle(prevSlotChipStyle);
    applyChipColorMode(prevChipColorMode);
    applyProportionalMinSlots(prevProportionalMinSlots);
    applyHourlyMinSlots(prevHourlyMinSlots);
    applyCalendarFont(prevCalendarFont);
    applySidebarFont(prevSidebarFont);
    applyCalendarBold(prevCalendarBold);
    applySidebarBold(prevSidebarBold);
    renderDesignPanel();
    renderFontCredit();
    alert(err.message);
  }
}

async function saveCalendarLayout(layout) {
  await saveCalendarMeta({ calendarLayout: layout });
}

function syncLayoutFromSchedule(data) {
  applyCalendarLayout(data?.calendarLayout || "proportional");
  applySlotChipStyle(data?.slotChipStyle || "sidebar");
  applyChipColorMode(data?.chipColorMode || "default");
  applyProportionalMinSlots(data?.proportionalMinSlots);
  applyHourlyMinSlots(data?.hourlyMinSlots);
  syncFontsFromSchedule(data);
  renderDesignPanel();
}

function shiftPeriod(delta) {
  currentMonth += delta;
  if (currentMonth > 12) {
    currentMonth = 1;
    currentYear += 1;
  } else if (currentMonth < 1) {
    currentMonth = 12;
    currentYear -= 1;
  }
  if (isMobileViewport()) {
    requestMobileScrollToTop();
  }
  load({ skipMobileScrollRequest: isMobileViewport() });
}

function parseIsoDateParam(raw) {
  const value = String(raw || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return value;
}

function consumeDateFromUrl() {
  const params = new URLSearchParams(location.search);
  const isoDate = parseIsoDateParam(params.get("date"));
  if (!isoDate) return null;
  const url = new URL(location.href);
  url.searchParams.delete("date");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return isoDate;
}

async function openDayFromUrl(isoDate) {
  const [year, month] = isoDate.split("-").map(Number);
  if (isMobileViewport()) {
    showMobileCalendarTab();
  }
  if (year !== currentYear || month !== currentMonth) {
    currentYear = year;
    currentMonth = month;
    await fetchScheduleForView();
    applyBrandTheme(scheduleData?.brandColor);
    syncLayoutFromSchedule(scheduleData);
    renderHeader();
    renderCategories();
    renderHighlights();
  }
  if (isMobileViewport()) {
    requestMobileScrollToDate(isoDate);
  }
  renderCalendar();
  openDayModal(isoDate);
}

async function load({ deepLinkDate = null, skipMobileScrollRequest = false } = {}) {
  if (!skipMobileScrollRequest) {
    const scrollDate = deepLinkDate ?? peekDateFromUrl();
    if (isMobileViewport() && scrollDate) {
      requestMobileScrollToDate(scrollDate);
    } else if (!mobileScrollToTop) {
      requestMobileScrollToToday();
    }
  }
  try {
    await fetchScheduleForView();
    applyBrandTheme(scheduleData?.brandColor);
    syncLayoutFromSchedule(scheduleData);
    renderHeader();
    renderCategories();
    renderHighlights();
    renderCalendar();
  } catch (err) {
    if (isMobileViewport()) {
      setMobileAgendaVisible(true);
      const el = document.getElementById("mobile-agenda");
      if (el) {
        el.innerHTML = `<p class="mobile-agenda-empty mobile-agenda-empty--error">${escapeHtml(err.message)}</p>`;
      }
    } else {
      document.getElementById("calendar").innerHTML =
        `<p style="padding:20px;color:#c0392b">${escapeHtml(err.message)}</p>`;
    }
  }
}

async function reloadScheduleFromServer() {
  if (isEditing()) return;
  const openDate = dayModalDate;
  await load();
  if (openDate) openDayModal(openDate);
}

async function init() {
  initMonth();
  setupCalendarSubscribe();
  const deepLinkDate = peekDateFromUrl();
  if (deepLinkDate) {
    const [year, month] = deepLinkDate.split("-").map(Number);
    currentYear = year;
    currentMonth = month;
  }
  const mobileNavHome = document.getElementById("mobile-nav-home");
  if (mobileNavHome) mobileNavHome.href = linksPath();
  document.getElementById("mobile-scroll-today")?.addEventListener("click", () => {
    void goToMobileToday();
  });
  const navMusicbook = document.getElementById("nav-musicbook");
  if (navMusicbook) navMusicbook.href = musicbookPath();
  const authError = consumeAuthErrorFromUrl();
  const [me, config] = await Promise.all([fetchMe(), fetchAuthConfig()]);
  authConfig = config;
  document.getElementById("beta-badge")?.classList.toggle("hidden", !config.isBeta);
  document.documentElement.classList.toggle("is-beta", !!config.isBeta);
  renderModeControl(document.getElementById("mode-control"), me, config, {
    onChange: async (next) => {
      setUserCanEdit(next);
      await applyCalendarEditState();
      syncMobileHeaderOffset();
    },
  });
  document.getElementById("calendar-edit-mode-wrap")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-edit-mode]");
    if (!btn) return;
    void setCalendarEditMode(btn.dataset.editMode === "true");
  });
  if (authError) {
    const toast = document.getElementById("save-toast");
    if (toast) {
      toast.textContent = authError;
      toast.classList.add("error");
      toast.classList.remove("hidden");
    } else {
      alert(authError);
    }
  }
  bindCalendarEditor(document.getElementById("calendar"));
  initBangonModalControls();
  bindHighlightPanel({
    onOpenDay: openDayModal,
    getHighlightItem: (idx) => getVisibleHighlights()[idx],
  });
  bindCategoryEditor();
  initDisplayMode();
  registerAllFontFaces();
  applyCalendarLayout("proportional");
  applySlotChipStyle("sidebar");
  applyProportionalMinSlots(4);
  applyHourlyMinSlots(4);
  bindLayoutPanel(document.getElementById("layout-options"), (patch) => {
    saveCalendarMeta(patch);
  });
  bindFontOptions(document.getElementById("layout-font-options"), (patch) => {
    saveCalendarMeta(patch);
  });
  syncMobileHeaderOffset();
  document.getElementById("cat-add-btn")?.addEventListener("click", () => {
    if (!isCategoryEditingAllowed()) return;
    addCategory("새 카테고리");
  });
  if (isMobileViewport() && (deepLinkDate || isNavigationFromHome())) {
    setMobileTab("calendar", { persist: true });
  }
  initMobileNav({
    onTabChange: (tab) => {
      if (tab === "calendar") renderCalendar();
    },
    onViewportChange: () => {
      if (isMobileViewport()) requestMobileScrollToToday();
      renderCalendar();
    },
  });
  await load({ deepLinkDate });

  const consumedDate = consumeDateFromUrl();
  if (consumedDate && !(isMobileViewport() && isNavigationFromHome())) {
    await openDayFromUrl(consumedDate);
  }

  setUserCanEdit(me);
  editMode = false;
  await applyCalendarEditState();

  let resizeTimer;
  let lastMobileWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (isMobileViewport()) {
        syncMobileHeaderOffset();
        if (Math.abs(window.innerWidth - lastMobileWidth) > 48) {
          lastMobileWidth = window.innerWidth;
          syncMobileAgendaLayout();
        }
        return;
      }
      lastMobileWidth = window.innerWidth;
      syncCalendarLayout();
    }, 120);
  });

  const notifWatcher = startSongRequestNotificationWatcher({
    isLoggedIn: () => Boolean(me?.loggedIn),
  });

  calendarContentSync = startContentSync({
    resources: ["schedule", "songRequests"],
    shouldSync: () => !isEditing(),
    authSync: true,
    initialMe: me,
    onAuthChange: async (next) => {
      setUserCanEdit(next);
      renderModeControl(document.getElementById("mode-control"), next, authConfig);
      await applyCalendarEditState({ reloadOnEnter: false });
      syncMobileHeaderOffset();
      if (next?.loggedIn) await notifWatcher.poll();
    },
    onUpdate: async () => {
      await notifWatcher.poll();
      await reloadScheduleFromServer();
    },
  });
}

document.getElementById("prev-month").addEventListener("click", () => shiftPeriod(-1));
document.getElementById("next-month").addEventListener("click", () => shiftPeriod(1));
document.querySelector(".day-modal-backdrop")?.addEventListener("click", closeDayModal);
document.querySelector(".day-modal-close")?.addEventListener("click", closeDayModal);
document.getElementById("day-modal-body")?.addEventListener("click", (e) => {
  if (!isEditing() || !dayModalDate) return;
  const btn = e.target.closest("[data-day-action]");
  if (!btn) return;
  const action = btn.dataset.dayAction;
  const index = Number(btn.dataset.index);
  const part = Number(btn.dataset.part || 0);

  if (action === "edit") {
    const slot = getPartSlots(dayModalDate, part)[index];
    if (slot) openSlotEdit(dayModalDate, index, slot, part);
  } else if (action === "delete") {
    const slots = [...getPartSlots(dayModalDate, part)];
    slots.splice(index, 1);
    setPartSlots(dayModalDate, part, slots);
  } else if (action === "add-highlight") {
    const slot = getPartSlots(dayModalDate, part)[index];
    if (slot) addHighlight(dayModalDate, slot.text);
  } else if (action === "add-part-slot") {
    openSlotEdit(dayModalDate, null, { text: "", category: FALLBACK_CATEGORY, hours: 1 }, part);
  } else if (action === "add-second-part") {
    if (enableSecondPart(dayModalDate)) {
      part2DraftDate = dayModalDate;
      openDayModal(dayModalDate);
    }
  } else if (action === "remove-second-part") {
    if (confirm("2부 일정을 삭제할까요?")) {
      part2DraftDate = null;
      removeSecondPart(dayModalDate);
    }
  }
});
// 모달 내 일정 드래그&드롭 (부 간/부 내 이동) — moveSlot이 주요일정도 함께 유지
function moveModalSlot(isoDate, fromPart, fromIdx, toPart, toIdx, placement = "end") {
  if (fromPart === toPart && fromIdx === toIdx && placement !== "end") return;
  moveSlot(isoDate, fromIdx, isoDate, toIdx, fromPart, toPart, { placement });
}

function clearModalDropHints(root) {
  root
    ?.querySelectorAll(".day-detail-item--dragging, .day-modal-part--drop, .day-detail-item--drop-before")
    .forEach((el) =>
      el.classList.remove(
        "day-detail-item--dragging",
        "day-modal-part--drop",
        "day-detail-item--drop-before"
      )
    );
}

(() => {
  const modalSchedule = document.getElementById("day-modal-schedule");
  if (!modalSchedule) return;

  modalSchedule.addEventListener("dragstart", (e) => {
    if (!isEditing() || !dayModalDate) return;
    const item = e.target.closest('.day-detail-item[draggable="true"]');
    if (!item) return;
    modalDragState = {
      part: Number(item.dataset.part || 0),
      index: Number(item.dataset.slotIndex),
    };
    item.classList.add("day-detail-item--dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", String(modalDragState.index));
      } catch (_) {}
    }
  });

  modalSchedule.addEventListener("dragend", () => {
    clearModalDropHints(modalSchedule);
    modalDragState = null;
  });

  modalSchedule.addEventListener("dragover", (e) => {
    if (!modalDragState) return;
    const part = e.target.closest(".day-modal-part[data-part]");
    if (!part) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    modalSchedule
      .querySelectorAll(".day-modal-part--drop, .day-detail-item--drop-before")
      .forEach((el) => el.classList.remove("day-modal-part--drop", "day-detail-item--drop-before"));
    part.classList.add("day-modal-part--drop");
    const overItem = e.target.closest(".day-detail-item");
    if (overItem && overItem.dataset.part === part.dataset.part) {
      overItem.classList.add("day-detail-item--drop-before");
    }
  });

  modalSchedule.addEventListener("drop", (e) => {
    if (!modalDragState || !dayModalDate) return;
    const part = e.target.closest(".day-modal-part[data-part]");
    if (!part) return;
    e.preventDefault();
    const toPart = Number(part.dataset.part || 0);
    const overItem = e.target.closest(".day-detail-item");
    let toIdx = null;
    let placement = "end";
    if (overItem && overItem.dataset.part === part.dataset.part) {
      toIdx = Number(overItem.dataset.slotIndex);
      placement = "before";
    }
    const { part: fromPart, index: fromIdx } = modalDragState;
    modalDragState = null;
    clearModalDropHints(modalSchedule);
    moveModalSlot(dayModalDate, fromPart, fromIdx, toPart, toIdx, placement);
  });
})();

// 부별 뱅온 picker (모달 본문 내 data-bangon-part)
document.getElementById("day-modal-body")?.addEventListener("click", (e) => {
  if (!isEditing() || !dayModalDate) return;
  const quick = e.target.closest(".day-modal-part-bangon [data-bangon]");
  if (!quick) return;
  const wrap = quick.closest("[data-bangon-part]");
  const partIdx = Number(wrap?.dataset.bangonPart || 0);
  e.preventDefault();
  setPartBangonTime(dayModalDate, partIdx, quick.dataset.bangon || "");
});
document.getElementById("day-modal-body")?.addEventListener("bangontimechange", (e) => {
  if (!isEditing() || !dayModalDate) return;
  const picker = e.target.closest("[data-bangon-picker]");
  if (!picker || !e.target.closest(".day-modal-part-bangon")) return;
  const wrap = picker.closest("[data-bangon-part]");
  const partIdx = Number(wrap?.dataset.bangonPart || 0);
  const value =
    typeof e.detail?.value === "string" ? e.detail.value : readBangonPickerValue(picker);
  setPartBangonTime(dayModalDate, partIdx, value);
});
document.getElementById("day-modal-body")?.addEventListener("change", (e) => {
  if (!isEditing() || !dayModalDate) return;
  const picker = e.target.closest("[data-bangon-picker]");
  if (!picker || !e.target.closest(".day-modal-part-bangon")) return;
  if (!e.target.matches(".bangon-approx-input")) return;
  const wrap = picker.closest("[data-bangon-part]");
  const partIdx = Number(wrap?.dataset.bangonPart || 0);
  syncBangonPickerControls(picker);
  setPartBangonTime(dayModalDate, partIdx, readBangonPickerValue(picker));
});
document.getElementById("day-modal-add")?.addEventListener("click", () => {
  if (!isEditing() || !dayModalDate) return;
  openSlotEdit(dayModalDate, null, { text: "", category: FALLBACK_CATEGORY, hours: 1 });
});
document.getElementById("day-modal-clear")?.addEventListener("click", () => {
  if (!isEditing() || !dayModalDate) return;
  if (confirm(`${dayModalDate} 일정을 모두 삭제할까요?`)) clearDay(dayModalDate);
});
document.querySelector(".slot-edit-cancel")?.addEventListener("click", closeSlotEdit);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeDayModal();
    closeSlotEdit();
    closeContextMenu();
    closeCategoryContextMenu();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.isComposing || e.repeat) return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;

  // 입력 중에는 방향키를 원래 동작(커서 이동)으로 둠
  const tag = (e.target?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) return;

  // 모달/메뉴가 열려있을 때는 월 이동을 막음 (의도치 않은 이동 방지)
  if (document.documentElement.classList.contains("modal-open")) return;
  if (!document.getElementById("slot-edit-modal")?.classList.contains("hidden")) return;
  if (!document.getElementById("ctx-menu")?.classList.contains("hidden")) return;
  if (!document.getElementById("cat-ctx-menu")?.classList.contains("hidden")) return;

  e.preventDefault();
  shiftPeriod(e.key === "ArrowLeft" ? -1 : 1);
});

init();
