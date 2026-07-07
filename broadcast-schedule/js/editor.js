/** 캘린더 인라인 편집 — 드래그 · 우클릭 · 저장 */

import { apiFetch } from "./auth.js";
import {
  escapeHtml,
  collectDaySlots,
  findHighlightSlot,
  getBangonTime,
  getDayParts,
  highlightMatchesAnySlot,
  isAllDaySlot,
  isOffDaySlots,
  normalizeDay,
  normalizeBangonValue,
  normalizeMatchText,
  normalizeSlotStartTime,
  normalizeSlotUrl,
  packSlotForSave,
  renderDaySlotList,
  renderSlotStartTimePickerMarkup,
  formatBangonTimeDisplay,
  bangonValueFromHour,
  slotLinkUrl,
  slotLinkLabel,
  slotLinkType,
  SLOT_LINK_TYPES,
  SLOT_LINK_LABEL_MAX,
  slotCategory,
  slotHours,
  slotMembers,
  slotStartTime,
  slotStartTimeFromParts,
  snapMinuteToStep,
  FALLBACK_CATEGORY,
} from "./slots.js";
import { getCalendarLayout, slotRenderOptions } from "./calendar-layout.js";
import { isMobileViewport } from "./mobile.js";

let fullSchedule = null;
let monthKey = null;
let canEdit = false;
let categories = {};
let onCalendarRefresh = null;
let saveTimer = null;
let saveInFlight = false;
let saveQueued = false;

export function setEditorSchedule(full, month, cats, refreshFn) {
  fullSchedule = full;
  monthKey = month;
  categories = cats || {};
  onCalendarRefresh = refreshFn;
}

export function setEditorCanEdit(flag) {
  canEdit = flag;
  if (!flag) {
    slotClipboard = null;
    editorFocus = null;
    clearSlotSelection();
  }
  document.body.classList.toggle("edit-mode", flag);
}

function monthKeyFromDate(isoDate) {
  return isoDate.slice(0, 7);
}

function monthDataForDate(isoDate) {
  if (!fullSchedule) return null;
  const key = monthKeyFromDate(isoDate);
  fullSchedule.months = fullSchedule.months || {};
  if (!fullSchedule.months[key]) {
    const m = Number(key.slice(5));
    fullSchedule.months[key] = { title: `${m}월`, highlights: [], days: {} };
  }
  return fullSchedule.months[key];
}

function monthData() {
  if (!fullSchedule || !monthKey) return null;
  fullSchedule.months = fullSchedule.months || {};
  if (!fullSchedule.months[monthKey]) {
    fullSchedule.months[monthKey] = { title: monthKey, highlights: [], days: {} };
  }
  return fullSchedule.months[monthKey];
}

export function getDaySlots(dateKeyStr) {
  const md = monthDataForDate(dateKeyStr);
  if (!md) return [];
  return normalizeDay(md.days[dateKeyStr])?.slots || [];
}

function normalizeSlotsForSave(slots) {
  return (slots || [])
    .map((s) => packSlotForSave(s))
    .filter(Boolean);
}

function packPart2ForSave(part2) {
  if (!part2) return null;
  const normalized = normalizeSlotsForSave(part2.slots || []);
  const time = isOffDaySlots(normalized) ? "" : normalizeBangonValue(part2.bangonTime);
  const out = {};
  if (normalized.length) out.slots = normalized.map((s) => ({ ...s }));
  if (time) out.bangonTime = time;
  return Object.keys(out).length ? out : null;
}

/** 1부가 비었는데 2부만 남으면 2부를 1부로 승격해 일정이 사라지지 않게 한다. */
function coalesceDayParts(slots, bangonTime, part2) {
  let part1Slots = slots || [];
  let part2State = part2;
  let bangon = bangonTime || "";
  if (!part1Slots.length && part2State) {
    const promoted = normalizeSlotsForSave(part2State.slots || []);
    if (promoted.length) {
      part1Slots = promoted.map((s) => ({ ...s }));
      const p2Bangon = isOffDaySlots(promoted)
        ? ""
        : normalizeBangonValue(part2State.bangonTime);
      if (!bangon && p2Bangon) bangon = p2Bangon;
      part2State = null;
    }
  }
  return { slots: part1Slots, bangonTime: bangon, part2: part2State };
}

function packDayPayload(slots, bangonTime, part2) {
  const coalesced = coalesceDayParts(slots, bangonTime, part2);
  const normalized = normalizeSlotsForSave(coalesced.slots);
  const time = isOffDaySlots(normalized) ? "" : normalizeBangonValue(coalesced.bangonTime);
  const day = {};
  if (normalized.length) day.slots = normalized.map((s) => ({ ...s }));
  if (time) day.bangonTime = time;
  // 2부는 1부 일정이 있을 때만 보존 (1부 비우면 2부를 1부로 승격)
  if (normalized.length) {
    const p2 = packPart2ForSave(coalesced.part2);
    if (p2) day.part2 = p2;
  }
  return Object.keys(day).length ? day : null;
}

function buildSchedulePayload(schedule) {
  const data = JSON.parse(JSON.stringify(schedule));
  for (const month of Object.values(data.months || {})) {
    const days = month.days || {};
    for (const [dateKey, day] of Object.entries(days)) {
      const norm = normalizeDay(day);
      const packed = packDayPayload(norm?.slots || [], norm?.bangonTime, norm?.part2);
      if (!packed) delete days[dateKey];
      else days[dateKey] = packed;
    }
    month.days = days;
  }
  return data;
}

export function getDayBangonTime(dateKeyStr) {
  const md = monthDataForDate(dateKeyStr);
  if (!md) return "";
  return getBangonTime(md.days[dateKeyStr]);
}

export function setDayBangonTime(dateKeyStr, bangonTime) {
  const md = monthDataForDate(dateKeyStr);
  if (!md) return;
  const existing = md.days[dateKeyStr] || {};
  const norm = normalizeDay(existing);
  const slots = norm?.slots || [];
  const day = packDayPayload(slots, bangonTime, norm?.part2);
  if (!day) delete md.days[dateKeyStr];
  else md.days[dateKeyStr] = day;
  queueSave();
  onCalendarRefresh?.();
}

export function setDaySlots(dateKeyStr, slots, { skipHighlightPrune = false } = {}) {
  const md = monthDataForDate(dateKeyStr);
  if (!md) return;
  const existing = md.days[dateKeyStr] || {};
  const norm = normalizeDay(existing);
  const part2 = norm?.part2 || null;
  const combined = [...(slots || []), ...(part2?.slots || [])];
  if (!skipHighlightPrune) pruneOrphanHighlightsForDay(dateKeyStr, combined);
  const bangonTime = norm?.bangonTime ?? getBangonTime(existing);
  const day = packDayPayload(slots, bangonTime, part2);
  if (!day) delete md.days[dateKeyStr];
  else md.days[dateKeyStr] = day;
  queueSave();
  onCalendarRefresh?.();
}

// ── 부(part) 단위 연산 (partIdx: 0=1부, 1=2부) ──
export function getDayPartCount(dateKeyStr) {
  const md = monthDataForDate(dateKeyStr);
  if (!md) return 1;
  return normalizeDay(md.days[dateKeyStr])?.part2 ? 2 : 1;
}

export function getPartSlots(dateKeyStr, partIdx) {
  const md = monthDataForDate(dateKeyStr);
  if (!md) return [];
  const norm = normalizeDay(md.days[dateKeyStr]);
  if (!norm) return [];
  if (partIdx === 1) return norm.part2?.slots ? [...norm.part2.slots] : [];
  return norm.slots ? [...norm.slots] : [];
}

export function getPartBangonTime(dateKeyStr, partIdx) {
  const md = monthDataForDate(dateKeyStr);
  if (!md) return "";
  const norm = normalizeDay(md.days[dateKeyStr]);
  if (!norm) return "";
  if (partIdx === 1) return norm.part2?.bangonTime || "";
  return norm.bangonTime || "";
}

export function setPartSlots(dateKeyStr, partIdx, slots, opts = {}) {
  if (partIdx !== 1) {
    setDaySlots(dateKeyStr, slots, opts);
    return;
  }
  const md = monthDataForDate(dateKeyStr);
  if (!md) return;
  const norm = normalizeDay(md.days[dateKeyStr]) || {};
  const combined = [...(norm.slots || []), ...(slots || [])];
  if (!opts.skipHighlightPrune) pruneOrphanHighlightsForDay(dateKeyStr, combined);
  const part2 = (slots || []).length
    ? { slots, bangonTime: norm.part2?.bangonTime || "" }
    : null;
  const day = packDayPayload(norm.slots || [], norm.bangonTime || "", part2);
  if (!day) delete md.days[dateKeyStr];
  else md.days[dateKeyStr] = day;
  queueSave();
  onCalendarRefresh?.();
}

export function setPartBangonTime(dateKeyStr, partIdx, bangonTime) {
  if (partIdx !== 1) {
    setDayBangonTime(dateKeyStr, bangonTime);
    return;
  }
  const md = monthDataForDate(dateKeyStr);
  if (!md) return;
  const norm = normalizeDay(md.days[dateKeyStr]) || {};
  if (!(norm.slots || []).length) return; // 1부 없으면 2부 불가
  const part2 = {
    slots: norm.part2?.slots || [],
    bangonTime,
  };
  const day = packDayPayload(norm.slots || [], norm.bangonTime || "", part2);
  if (!day) delete md.days[dateKeyStr];
  else md.days[dateKeyStr] = day;
  queueSave();
  onCalendarRefresh?.();
}

/** 2부 편집 시작: 1부가 있을 때만, 빈 뱅온 자리표시로 part2 활성화 */
export function enableSecondPart(dateKeyStr) {
  const md = monthDataForDate(dateKeyStr);
  if (!md) return false;
  const norm = normalizeDay(md.days[dateKeyStr]) || {};
  if (!(norm.slots || []).length) return false;
  if (norm.part2) return true;
  // 슬롯이 없으면 part2가 저장되지 않으므로, 편집 중 표시는 모달의 임시 상태가 담당.
  return true;
}

export function removeSecondPart(dateKeyStr) {
  const md = monthDataForDate(dateKeyStr);
  if (!md) return;
  const norm = normalizeDay(md.days[dateKeyStr]) || {};
  const day = packDayPayload(norm.slots || [], norm.bangonTime || "", null);
  if (!day) delete md.days[dateKeyStr];
  else md.days[dateKeyStr] = day;
  queueSave();
  onCalendarRefresh?.();
}

/** 일정 이동 시 주요일정 날짜도 함께 옮긴다. 복붙은 호출하지 않음(원본만 유지). */
function moveLinkedHighlight(fromDate, text, toDate) {
  const t = String(text || "").trim();
  if (!fromDate || !toDate || !t || fromDate === toDate) return;
  const entry = findHighlightEntry(fromDate, t);
  if (!entry) return;

  const fromMd = monthDataForDate(fromDate);
  const toMd = monthDataForDate(toDate);
  if (!fromMd) return;

  const entryText = String(entry.text || "").trim();
  fromMd.highlights = (fromMd.highlights || []).filter(
    (h) => !(h.date === entry.date && String(h.text || "").trim() === entryText),
  );

  if (!toMd) return;
  const existsOnDest = (toMd.highlights || []).some(
    (h) => h.date === toDate && textsLooselyMatch(h.text, entryText),
  );
  if (!existsOnDest) {
    toMd.highlights = [...(toMd.highlights || []), { date: toDate, text: entryText }].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  }
}

export function moveSlot(fromDate, fromIdx, toDate, toIdx, fromPart = 0, toPart = fromPart) {
  // 2부는 1부 없이 존재할 수 없으므로 1부의 마지막 일정을 다른 부로 빼는 이동은 막는다.
  if (fromPart !== toPart && fromPart === 0 && getPartSlots(fromDate, 0).length <= 1) return;
  const fromSlots = [...getPartSlots(fromDate, fromPart)];
  if (fromIdx < 0 || fromIdx >= fromSlots.length) return;
  const [slot] = fromSlots.splice(fromIdx, 1);
  const slotText = String(slot?.text || "").trim();

  // 날짜가 바뀌는 이동: 주요일정도 목적지로 이전 (중간 prune에 지워지지 않게 먼저 옮김)
  if (slotText && fromDate !== toDate) {
    moveLinkedHighlight(fromDate, slotText, toDate);
  }

  // 같은 날 부 간 이동 시 중간 상태에서 prune 하면 주요일정이 사라지므로 마지막에 한 번만 prune
  const skipPrune = { skipHighlightPrune: true };
  setPartSlots(fromDate, fromPart, fromSlots, skipPrune);

  const toSlots =
    fromDate === toDate && fromPart === toPart
      ? [...fromSlots]
      : [...getPartSlots(toDate, toPart)];
  const insertAt = toIdx == null || toIdx < 0 ? toSlots.length : Math.min(toIdx, toSlots.length);
  toSlots.splice(insertAt, 0, slot);
  setPartSlots(toDate, toPart, toSlots, skipPrune);

  const fromMd = monthDataForDate(fromDate);
  pruneOrphanHighlightsForDay(fromDate, collectDaySlots(fromMd?.days?.[fromDate]));
  if (toDate !== fromDate) {
    const toMd = monthDataForDate(toDate);
    pruneOrphanHighlightsForDay(toDate, collectDaySlots(toMd?.days?.[toDate]));
  }
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSchedule, 600);
}

export function clearDay(dateKey) {
  const md = monthDataForDate(dateKey);
  if (!md) return;
  if (Array.isArray(md.highlights) && md.highlights.length) {
    md.highlights = md.highlights.filter((h) => h.date !== dateKey);
  }
  delete md.days[dateKey];
  queueSave();
  onCalendarRefresh?.();
}

function pruneOrphanHighlightsForDay(dateKeyStr, slots) {
  const md = monthDataForDate(dateKeyStr);
  if (!md?.highlights?.length) return;
  md.highlights = md.highlights.filter(
    (h) => h.date !== dateKeyStr || highlightMatchesAnySlot(slots, h.text),
  );
}

export function getHighlights() {
  return [...(monthData()?.highlights || [])];
}

export function highlightExists(date, text) {
  return !!findHighlightEntry(date, text);
}

function textsLooselyMatch(a, b) {
  const na = normalizeMatchText(a);
  const nb = normalizeMatchText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const aFirst = String(a || "").split("\n")[0].trim();
  const bFirst = String(b || "").split("\n")[0].trim();
  return (
    na.includes(nb) ||
    nb.includes(na) ||
    (aFirst && nb.includes(normalizeMatchText(aFirst))) ||
    (bFirst && na.includes(normalizeMatchText(bFirst)))
  );
}

export function findHighlightEntry(date, text) {
  const md = monthDataForDate(date);
  if (!md?.highlights?.length) return null;
  const t = String(text || "").trim();
  if (!t) return null;

  const exact = md.highlights.find((h) => h.date === date && h.text.trim() === t);
  if (exact) return exact;

  const loose = md.highlights.find((h) => h.date === date && textsLooselyMatch(h.text, t));
  if (loose) return loose;

  const slots = collectDaySlots(md?.days?.[date]);
  if (!slots.length) return null;

  for (const h of md.highlights) {
    if (h.date !== date) continue;
    const slotForHighlight = findHighlightSlot(md.days[date], h.text, { fallbackFirst: false });
    const slotForText = findHighlightSlot(md.days[date], t, { fallbackFirst: false });
    if (
      slotForHighlight &&
      slotForText &&
      normalizeMatchText(slotForHighlight.text) === normalizeMatchText(slotForText.text)
    ) {
      return h;
    }
  }

  return null;
}

export function highlightExistsForSlot(date, slotText) {
  return !!findHighlightEntry(date, slotText);
}

export function findSlotRefForHighlight(date, highlightText) {
  const md = monthDataForDate(date);
  const dayData = md?.days?.[date];
  const matched = findHighlightSlot(dayData, highlightText, { fallbackFirst: false });
  if (!matched) return null;
  const target = normalizeMatchText(matched.text);
  const parts = getDayParts(dayData);
  for (let part = 0; part < parts.length; part++) {
    const idx = (parts[part].slots || []).findIndex(
      (s) => normalizeMatchText(s.text) === target
    );
    if (idx >= 0) return { part, index: idx, slot: matched };
  }
  return null;
}

export function findSlotIndexForHighlight(date, highlightText) {
  const ref = findSlotRefForHighlight(date, highlightText);
  return ref ? ref.index : -1;
}

export function addHighlight(date, text) {
  const t = String(text || "").trim();
  if (!date || !t || findHighlightEntry(date, t)) return false;
  const md = monthDataForDate(date);
  if (!md) return false;
  md.highlights = [...(md.highlights || []), { date, text: t }].sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  queueSave();
  onCalendarRefresh?.();
  showSaveStatus("주요 일정에 등록됨");
  return true;
}

export function removeHighlight(index) {
  const items = getHighlights();
  if (index < 0 || index >= items.length) return;
  const item = items[index];
  removeHighlightByDate(item.date, item.text);
}

export function removeHighlightByDate(date, text) {
  const md = monthDataForDate(date);
  if (!md) return;
  const entry = findHighlightEntry(date, text);
  if (!entry) return;
  const before = (md.highlights || []).length;
  md.highlights = (md.highlights || []).filter(
    (h) => !(h.date === entry.date && h.text.trim() === entry.text.trim())
  );
  if (md.highlights.length === before) return;
  queueSave();
  onCalendarRefresh?.();
  showSaveStatus("주요 일정에서 제거됨");
}

function updateLinkedHighlight(date, oldText, newText) {
  const oldT = String(oldText || "").trim();
  const newT = String(newText || "").trim();
  if (!date || !oldT || oldT === newT) return;

  const md = monthDataForDate(date);
  if (!md?.highlights?.length) return;

  const entry = findHighlightEntry(date, oldT);
  if (!entry) return;
  const idx = md.highlights.findIndex(
    (h) => h.date === entry.date && h.text.trim() === entry.text.trim()
  );
  if (idx < 0) return;

  if (!newT || highlightExists(date, newT)) {
    md.highlights.splice(idx, 1);
  } else {
    md.highlights[idx] = { date, text: newT };
    md.highlights.sort((a, b) => a.date.localeCompare(b.date));
  }
}

export function getCategories() {
  return { ...categories };
}

function newCategoryId(label) {
  const base =
    String(label || "category")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^\w가-힣]/g, "") || "category";
  let id = base;
  let n = 1;
  while (categories[id]) {
    id = `${base}_${n++}`;
  }
  return id;
}

function remapCategoryInSchedule(fromId, toId = FALLBACK_CATEGORY) {
  if (!fullSchedule?.months) return;
  for (const month of Object.values(fullSchedule.months)) {
    for (const day of Object.values(month.days || {})) {
      for (const slot of day.slots || []) {
        if (slot.category === fromId) slot.category = toId;
      }
    }
  }
}

function syncCategoriesStore(next) {
  categories = { ...next };
  if (fullSchedule) fullSchedule.categories = categories;
}

function parseHexColor(hex) {
  const raw = String(hex || "#808080").replace("#", "").trim();
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw.padEnd(6, "0").slice(0, 6);
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function toHexColor(r, g, b) {
  return `#${[r, g, b]
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
    .join("")}`;
}

function relativeLuminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const channel = c / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

export function autoTextColorForBg(bgHex) {
  const [r, g, b] = parseHexColor(bgHex);
  const lum = relativeLuminance(r, g, b);
  if (lum > 0.42) {
    return toHexColor(r * 0.24 + 20, g * 0.24 + 20, b * 0.24 + 20);
  }
  return "#ffffff";
}

export function updateCategoryField(id, field, value) {
  if (!categories[id] || !canEdit) return;
  const next = { ...categories[id], [field]: value };
  if (field === "bg") {
    next.text = autoTextColorForBg(value);
  }
  syncCategoriesStore({
    ...categories,
    [id]: next,
  });
  queueSave();
  onCalendarRefresh?.();
}

export function addCategory(label = "새 카테고리") {
  if (!canEdit) return null;
  const id = newCategoryId(label);
  const bg = "#e8ecf2";
  syncCategoriesStore({
    ...categories,
    [id]: { label, bg, text: autoTextColorForBg(bg) },
  });
  queueSave();
  onCalendarRefresh?.();
  showSaveStatus("카테고리 추가됨");
  return id;
}

export function removeCategory(id) {
  if (!canEdit || id === FALLBACK_CATEGORY || !categories[id]) return false;
  if (!confirm(`「${categories[id].label || id}」 카테고리를 삭제할까요?\n사용 중인 일정은 「${categories[FALLBACK_CATEGORY]?.label || "일반"}」으로 바뀝니다.`)) {
    return false;
  }
  remapCategoryInSchedule(id, FALLBACK_CATEGORY);
  const next = { ...categories };
  delete next[id];
  syncCategoriesStore(next);
  queueSave();
  onCalendarRefresh?.();
  showSaveStatus("카테고리 삭제됨");
  return true;
}

export function setHighlights(items) {
  const md = monthData();
  if (!md) return;
  md.highlights = items
    .filter((h) => h.date && h.text?.trim())
    .map((h) => ({ date: h.date, text: h.text.trim() }))
    .sort((a, b) => a.date.localeCompare(b.date));
  queueSave();
  onCalendarRefresh?.();
}

export function saveScheduleNow() {
  clearTimeout(saveTimer);
  return saveSchedule();
}

function pruneAllOrphanHighlights() {
  if (!fullSchedule?.months) return;
  for (const month of Object.values(fullSchedule.months)) {
    if (!Array.isArray(month.highlights) || !month.highlights.length) continue;
    const days = month.days || {};
    month.highlights = month.highlights.filter((h) => {
      return highlightMatchesAnySlot(collectDaySlots(days[h.date]), h.text);
    });
  }
}

async function saveSchedule() {
  if (!fullSchedule || !canEdit) return;
  if (saveInFlight) {
    saveQueued = true;
    return;
  }
  saveInFlight = true;
  showSaveStatus("저장 중…");
  try {
    pruneAllOrphanHighlights();
    const payload = buildSchedulePayload(fullSchedule);
    const res = await apiFetch("/api/schedule", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.hint || err.error || `저장 실패 (${res.status})`);
    }
    showSaveStatus("저장됨", false);
  } catch (err) {
    showSaveStatus(err.message || "저장 실패", true);
  } finally {
    saveInFlight = false;
    if (saveQueued) {
      saveQueued = false;
      queueSave();
    }
  }
}

function showSaveStatus(msg, isError = false) {
  const el = document.getElementById("save-toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(showSaveStatus._t);
  showSaveStatus._t = setTimeout(() => el.classList.add("hidden"), 2200);
}

let dragState = null;
let dragJustEnded = false;

export function shouldSuppressCalendarClick() {
  return dragJustEnded;
}
let ctxTarget = null;
let slotClipboard = null;
/** @type {{ kind: "slot", date: string, index: number, part: number } | { kind: "day", date: string } | null} */
let editorFocus = null;

function cloneSlot(slot) {
  if (!slot) return null;
  return packSlotForSave(slot);
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function clearSlotSelection() {
  document.querySelectorAll(".slot-chip--selected").forEach((el) => el.classList.remove("slot-chip--selected"));
}

function partFromElement(el) {
  const raw = el?.dataset?.part;
  const part = raw == null || raw === "" ? 0 : Number(raw);
  return Number.isFinite(part) && part >= 0 ? part : 0;
}

function setSlotFocus(date, index, part = 0) {
  editorFocus = { kind: "slot", date, index, part };
  clearSlotSelection();
  document
    .querySelector(`.slot-chip[data-date="${date}"][data-slot-index="${index}"][data-part="${part}"]`)
    ?.classList.add("slot-chip--selected");
}

function setDayFocus(date) {
  editorFocus = { kind: "day", date };
  clearSlotSelection();
}

export function restoreEditorFocus() {
  if (!canEdit || !editorFocus) return;
  if (editorFocus.kind === "slot") {
    setSlotFocus(editorFocus.date, editorFocus.index, editorFocus.part || 0);
  } else {
    setDayFocus(editorFocus.date);
  }
}

function copySlotAt(date, index, part = 0) {
  const slot = getPartSlots(date, part)[index];
  if (!slot) return false;
  slotClipboard = cloneSlot(slot);
  return true;
}

function pasteClipboard(toDate, afterIndex = null, part = 0) {
  if (!slotClipboard || !toDate) return false;
  const slots = [...getPartSlots(toDate, part)];
  const insertAt =
    afterIndex == null || afterIndex < 0 ? slots.length : Math.min(afterIndex + 1, slots.length);
  slots.splice(insertAt, 0, cloneSlot(slotClipboard));
  setPartSlots(toDate, part, slots);
  setSlotFocus(toDate, insertAt, part);
  return true;
}

function copyFromFocus() {
  if (!editorFocus) return false;
  if (editorFocus.kind === "slot") {
    return copySlotAt(editorFocus.date, editorFocus.index, editorFocus.part || 0);
  }
  return false;
}

function pasteToFocus() {
  if (!slotClipboard || !editorFocus) return false;
  if (editorFocus.kind === "slot") {
    return pasteClipboard(editorFocus.date, editorFocus.index, editorFocus.part || 0);
  }
  if (editorFocus.kind === "day") {
    return pasteClipboard(editorFocus.date, null);
  }
  return false;
}

function onEditorSelect(e) {
  if (!canEdit) return;
  if (e.target.closest(".day-head")) return;

  const chip = e.target.closest(".slot-chip[data-slot-index]");
  if (chip) {
    if (e.target.closest(".slot-drag-handle")) return;
    e.stopPropagation();
    setSlotFocus(chip.dataset.date, Number(chip.dataset.slotIndex), partFromElement(chip));
    return;
  }

  const list = e.target.closest(".slot-list");
  if (list) {
    const cell = list.closest(".day-cell[data-date]");
    if (cell) {
      e.stopPropagation();
      setDayFocus(cell.dataset.date);
    }
  }
}

function deleteFocusedSlot() {
  if (!editorFocus || editorFocus.kind !== "slot") return false;
  const { date, index, part = 0 } = editorFocus;
  const slots = [...getPartSlots(date, part)];
  if (index < 0 || index >= slots.length) return false;
  slots.splice(index, 1);
  editorFocus = slots.length
    ? { kind: "slot", date, index: Math.min(index, slots.length - 1), part }
    : { kind: "day", date };
  setPartSlots(date, part, slots);
  return true;
}

function onEditorKeydown(e) {
  if (!canEdit || isTypingTarget(e.target)) return;

  if (e.key === "Backspace" || e.key === "Delete") {
    if (deleteFocusedSlot()) {
      e.preventDefault();
      showSaveStatus("삭제됨");
    }
    return;
  }

  if (!(e.ctrlKey || e.metaKey)) return;

  const key = e.key.toLowerCase();
  if (key === "c") {
    if (copyFromFocus()) {
      e.preventDefault();
      showSaveStatus("일정 복사됨");
    }
    return;
  }
  if (key === "v") {
    if (pasteToFocus()) {
      e.preventDefault();
      showSaveStatus("붙여넣기 됨");
    }
  }
}

export function bindCalendarEditor(calendarEl) {
  if (!calendarEl) return;

  calendarEl.addEventListener("mousedown", onEditorMouseDown, true);
  calendarEl.addEventListener("dragstart", onDragStart);
  calendarEl.addEventListener("dragend", onDragEnd);
  calendarEl.addEventListener("dragover", onDragOver);
  calendarEl.addEventListener("drop", onDrop);
  calendarEl.addEventListener("contextmenu", onCalendarContextMenu);
  calendarEl.addEventListener("click", onEditorSelect, true);
  document.addEventListener("keydown", onEditorKeydown);

  document.addEventListener("click", closeContextMenu);
  document.getElementById("ctx-menu")?.addEventListener("click", (e) => {
    e.stopPropagation();
    onCtxAction(e);
  });
  document.getElementById("slot-edit-save")?.addEventListener("click", onSlotEditSave);
  document.getElementById("slot-edit-delete")?.addEventListener("click", onSlotEditDelete);
  document.getElementById("slot-edit-hours")?.addEventListener("change", syncSlotEditTimeFields);
  document
    .querySelectorAll('input[name="slot-edit-link-type"]')
    .forEach((input) => input.addEventListener("change", syncSlotEditLinkFields));
  document.getElementById("slot-edit-modal")?.addEventListener("keydown", onSlotEditKeydown);
  initSlotStartPickerControls();
  document.querySelector(".slot-edit-backdrop")?.addEventListener("click", closeSlotEdit);
}

let resolveHighlightItem = null;

export function bindHighlightPanel({ onOpenDay, getHighlightItem } = {}) {
  resolveHighlightItem = getHighlightItem || null;
  const list = document.getElementById("highlights");
  if (!list || list.dataset.highlightBound) return;
  list.dataset.highlightBound = "1";

  list.addEventListener("click", (e) => {
    const item = e.target.closest(".highlight-item[data-highlight-date]");
    if (!item) return;
    const date = item.dataset.highlightDate;
    if (date) onOpenDay?.(date);
  });

  list.addEventListener("keydown", (e) => {
    const item = e.target.closest(".highlight-item[data-highlight-date]");
    if (!item) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const date = item.dataset.highlightDate;
      if (date) onOpenDay?.(date);
    }
  });

  list.addEventListener("contextmenu", (e) => {
    if (!canEdit) return;
    const item = e.target.closest(".highlight-item[data-highlight-date]");
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();

    const hl = getHighlightFromItem(item);
    const date = hl?.date || item.dataset.highlightDate;
    const text = hl?.text || "";
    const ref = findSlotRefForHighlight(date, text);
    openContextMenu(e, {
      type: "highlight",
      date,
      text,
      part: ref?.part ?? 0,
      slotIndex: ref?.index ?? -1,
    });
  });
}

function getHighlightFromItem(el) {
  const idx = Number(el.dataset.highlightIdx);
  if (!Number.isFinite(idx) || idx < 0 || !resolveHighlightItem) return null;
  return resolveHighlightItem(idx) || null;
}

export function bindHighlightsEditor() {
  /* renderHighlights 후 별도 바인딩 불필요 — bindHighlightPanel에서 위임 처리 */
}

function resolveDragChip(e) {
  const handle = e.target.closest(".slot-drag-handle[data-slot-index]");
  const chip = e.target.closest(".slot-chip[data-slot-index]");
  return chip || handle?.closest(".slot-chip[data-slot-index]") || null;
}

function onEditorMouseDown(e) {
  if (!canEdit) return;
  if (e.target.closest(".slot-drag-handle")) {
    e.stopPropagation();
  }
}

function onDragStart(e) {
  if (!canEdit) {
    e.preventDefault();
    return;
  }
  const chip = resolveDragChip(e);
  if (!chip) return;
  dragState = {
    date: chip.dataset.date,
    index: Number(chip.dataset.slotIndex),
    part: partFromElement(chip),
  };
  chip.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", `${dragState.date}:${dragState.index}`);
  e.stopPropagation();
}

function onDragEnd(e) {
  resolveDragChip(e)?.classList.remove("dragging");
  document.querySelectorAll(".slot-chip.dragging").forEach((el) => el.classList.remove("dragging"));
  document.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
  dragState = null;
  dragJustEnded = true;
  requestAnimationFrame(() => {
    dragJustEnded = false;
  });
}

function onDragOver(e) {
  if (!canEdit || !dragState) return;
  const cell = e.target.closest(".day-cell[data-date]");
  const chip = e.target.closest(".slot-chip");
  if (!cell && !chip) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
  (cell || chip?.closest(".day-cell"))?.classList.add("drop-target");
}

function onDrop(e) {
  if (!canEdit || !dragState) return;
  e.preventDefault();
  e.stopPropagation();
  const cell = e.target.closest(".day-cell[data-date]");
  if (!cell) return;
  const toDate = cell.dataset.date;
  const targetList = e.target.closest(".slot-list[data-part]");
  const targetChip = e.target.closest(".slot-chip");
  let toPart = targetChip ? partFromElement(targetChip) : partFromElement(targetList);
  // 다른 날로 1부 일정을 옮길 때는 항상 목적지 1부에 넣는다.
  if (dragState.date !== toDate && (dragState.part || 0) === 0) {
    toPart = 0;
  }
  let toIndex = getPartSlots(toDate, toPart).length;

  if (targetChip && targetChip.dataset.date === toDate) {
    toIndex = Number(targetChip.dataset.slotIndex);
    if (dragState.date === toDate && (dragState.part || 0) === toPart && dragState.index < toIndex)
      toIndex -= 1;
  }

  moveSlot(dragState.date, dragState.index, toDate, toIndex, dragState.part || 0, toPart);
  document.querySelectorAll(".drop-target").forEach((el) => el.classList.remove("drop-target"));
}

function configureCtxMenu(target) {
  const menu = document.getElementById("ctx-menu");
  if (!menu) return;

  const isSlot = target.type === "slot";
  const isDay = target.type === "day";
  const isHighlight = target.type === "highlight";
  const part = target.part || 0;
  const slot = isSlot ? getPartSlots(target.date, part)[target.index] : null;
  const slotInHighlight = isSlot && slot?.text?.trim() && highlightExistsForSlot(target.date, slot.text);

  if (isDay) {
    menu.querySelector('[data-action="add"]')?.classList.add("hidden");
    menu.querySelector('[data-action="edit"]')?.classList.add("hidden");
    menu.querySelector('[data-action="copy"]')?.classList.add("hidden");
    menu.querySelector('[data-action="delete"]')?.classList.add("hidden");
    menu.querySelector('[data-action="up"]')?.classList.add("hidden");
    menu.querySelector('[data-action="down"]')?.classList.add("hidden");
    menu.querySelector('[data-action="add-highlight"]')?.classList.add("hidden");
    menu.querySelector('[data-action="remove-highlight"]')?.classList.add("hidden");
    menu.querySelector('[data-action="paste"]')?.classList.toggle("hidden", !slotClipboard);
    menu.querySelector('[data-action="move-part"]')?.classList.add("hidden");
    menu.querySelector('[data-action="clear-day"]')?.classList.remove("hidden");
    return;
  }

  menu.querySelector('[data-action="add"]')?.classList.toggle("hidden", !isDay);
  menu.querySelector('[data-action="edit"]')?.classList.toggle(
    "hidden",
    !(isSlot || isHighlight)
  );
  menu.querySelector('[data-action="copy"]')?.classList.toggle("hidden", !isSlot);
  menu.querySelector('[data-action="paste"]')?.classList.toggle(
    "hidden",
    !slotClipboard || !(isDay || isSlot)
  );
  menu.querySelector('[data-action="delete"]')?.classList.toggle("hidden", !isSlot);
  menu.querySelector('[data-action="up"]')?.classList.toggle("hidden", !isSlot || isAllDaySlot(slot) || (isSlot ? target.index : -1) <= 0);
  menu.querySelector('[data-action="down"]')?.classList.toggle(
    "hidden",
    !isSlot ||
      isAllDaySlot(slot) ||
      (isSlot ? target.index : -1) < 0 ||
      (isSlot ? target.index : -1) >= (isSlot ? getPartSlots(target.date, part).length - 1 : 0)
  );
  menu.querySelector('[data-action="clear-day"]')?.classList.toggle("hidden", !isDay);
  menu.querySelector('[data-action="add-highlight"]')?.classList.toggle(
    "hidden",
    !isSlot || !slot?.text?.trim() || slotInHighlight
  );
  menu.querySelector('[data-action="remove-highlight"]')?.classList.toggle(
    "hidden",
    !(isHighlight || slotInHighlight)
  );

  const moveBtn = menu.querySelector('[data-action="move-part"]');
  if (moveBtn) {
    let showMove = false;
    if (isSlot) {
      if (part === 1) {
        // 2부 → 1부: 항상 가능 (2부가 비면 단일부로 합쳐짐)
        showMove = true;
        moveBtn.textContent = "1부로 이동";
      } else if (getPartSlots(target.date, 0).length >= 2) {
        // 1부 → 2부: 1부가 비지 않도록 일정이 2개 이상일 때만 (없으면 2부 새로 생성)
        showMove = true;
        moveBtn.textContent = "2부로 이동";
      }
    }
    moveBtn.classList.toggle("hidden", !showMove);
  }

  if (isHighlight) {
    const ref = findSlotRefForHighlight(target.date, target.text);
    target.part = ref?.part ?? 0;
    target.slotIndex = ref?.index ?? -1;
  }
}

export function closeContextMenu() {
  document.getElementById("ctx-menu")?.classList.add("hidden");
  ctxTarget = null;
}

export function positionFixedMenu(menu, clientX, clientY) {
  if (!menu) return;

  const margin = 10;
  const nearRight = clientX > window.innerWidth * 0.58;

  menu.style.visibility = "hidden";
  menu.classList.remove("hidden");

  const w = menu.offsetWidth;
  const h = menu.offsetHeight;

  let left = nearRight ? clientX - w : clientX;
  if (left + w > window.innerWidth - margin) {
    left = window.innerWidth - w - margin;
  }
  left = Math.max(margin, left);

  let top = clientY;
  if (top + h > window.innerHeight - margin) {
    top = window.innerHeight - h - margin;
  }
  top = Math.max(margin, top);

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = "";
  menu.classList.toggle("ctx-menu--anchor-left", nearRight || left + w > window.innerWidth - 220);
}

function openContextMenu(e, target) {
  document.getElementById("cat-ctx-menu")?.classList.add("hidden");
  ctxTarget = target;
  if (target.type === "slot") {
    setSlotFocus(target.date, target.index, target.part || 0);
  } else if (target.type === "day") {
    setDayFocus(target.date);
  }
  configureCtxMenu(target);
  positionFixedMenu(document.getElementById("ctx-menu"), e.clientX, e.clientY);
}

function onCalendarContextMenu(e) {
  if (!canEdit) return;
  const chip = e.target.closest(".slot-chip[data-slot-index]");
  if (chip) {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu(e, {
      type: "slot",
      date: chip.dataset.date,
      index: Number(chip.dataset.slotIndex),
      part: partFromElement(chip),
    });
    return;
  }
  const cell = e.target.closest(".day-cell[data-date]");
  if (!cell) return;
  e.preventDefault();
  e.stopPropagation();

  openContextMenu(e, { type: "day", date: cell.dataset.date });
}

function onCtxAction(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn || !ctxTarget) return;
  const action = btn.dataset.action;
  const { date, index, part = 0 } = ctxTarget;

  if (action === "add" && ctxTarget.type === "day") {
    openSlotEdit(date, null, { text: "", category: FALLBACK_CATEGORY, hours: 1 });
  } else if (action === "edit" && ctxTarget.type === "slot") {
    const slot = getPartSlots(date, part)[index];
    openSlotEdit(date, index, slot, part);
  } else if (action === "copy" && ctxTarget.type === "slot") {
    if (copySlotAt(date, index, part)) showSaveStatus("일정 복사됨");
  } else if (action === "paste" && (ctxTarget.type === "day" || ctxTarget.type === "slot")) {
    if (ctxTarget.type === "slot") pasteClipboard(date, index, part);
    else pasteClipboard(date, null);
    showSaveStatus("붙여넣기 됨");
  } else if (action === "move-part" && ctxTarget.type === "slot") {
    const toPart = part === 0 ? 1 : 0;
    moveSlot(date, index, date, null, part, toPart);
    showSaveStatus(`${toPart + 1}부로 이동됨`);
  } else if (action === "edit" && ctxTarget.type === "highlight") {
    const ref =
      ctxTarget.slotIndex >= 0
        ? {
            part: ctxTarget.part ?? 0,
            index: ctxTarget.slotIndex,
            slot: getPartSlots(ctxTarget.date, ctxTarget.part ?? 0)[ctxTarget.slotIndex],
          }
        : findSlotRefForHighlight(ctxTarget.date, ctxTarget.text);
    if (ref?.slot) openSlotEdit(ctxTarget.date, ref.index, ref.slot, ref.part);
  } else if (action === "delete" && ctxTarget.type === "slot") {
    const slots = [...getPartSlots(date, part)];
    slots.splice(index, 1);
    setPartSlots(date, part, slots);
  } else if (action === "up" && ctxTarget.type === "slot" && index > 0) {
    moveSlot(date, index, date, index - 1, part, part);
  } else if (action === "down" && ctxTarget.type === "slot") {
    const slots = getPartSlots(date, part);
    if (index < slots.length - 1) moveSlot(date, index, date, index + 1, part, part);
  } else if (action === "clear-day" && ctxTarget.type === "day") {
    if (confirm(`${date} 일정을 모두 삭제할까요?`)) clearDay(date);
  } else if (action === "add-highlight" && ctxTarget.type === "slot") {
    const slot = getPartSlots(date, part)[index];
    if (slot) addHighlight(date, slot.text);
  } else if (action === "remove-highlight") {
    if (ctxTarget.type === "highlight") {
      removeHighlightByDate(ctxTarget.date, ctxTarget.text);
    } else if (ctxTarget.type === "slot") {
      const slot = getPartSlots(date, part)[index];
      if (slot?.text?.trim()) removeHighlightByDate(date, slot.text);
    }
  }
  closeContextMenu();
}

let editTarget = null;

function getSlotEditStartTime() {
  return normalizeSlotStartTime(document.getElementById("slot-edit-start-time")?.value || "");
}

function setSlotEditStartTime(value) {
  const hidden = document.getElementById("slot-edit-start-time");
  if (hidden) hidden.value = normalizeSlotStartTime(value) || "";
}

function renderSlotStartPickerUI(value) {
  const picker = document.getElementById("slot-edit-start-picker");
  if (!picker) return;
  picker.innerHTML = renderSlotStartTimePickerMarkup(value);
}

function closeSlotStartHourPanels(exceptPicker = null) {
  document.querySelectorAll("[data-slot-start-picker]").forEach((picker) => {
    if (exceptPicker && picker === exceptPicker) return;
    picker.querySelector(".slot-start-hour-panel")?.classList.add("hidden");
    picker.querySelector(".slot-start-hour-trigger")?.setAttribute("aria-expanded", "false");
  });
}

function applySlotStartPickerValue(picker, value) {
  const normalized = normalizeSlotStartTime(value) || "";
  setSlotEditStartTime(normalized);
  if (!picker) return;

  const hasHour = Boolean(normalized);
  const [hourPart = "", minutePart = "0"] = normalized ? normalized.split(":") : [];
  const hour = hourPart === "" ? "" : Number(hourPart);
  const minute = hasHour ? snapMinuteToStep(minutePart) : 0;

  const triggerLabel = picker.querySelector(".slot-start-hour-trigger-label");
  if (triggerLabel) {
    triggerLabel.textContent = hasHour
      ? formatBangonTimeDisplay(bangonValueFromHour(hour))
      : "선택 안 함";
  }

  picker.querySelectorAll(".slot-start-hour-option").forEach((btn) => {
    const btnHour = btn.dataset.hour ?? "";
    const active =
      (!hasHour && btnHour === "") || (hasHour && String(hour) === btnHour);
    btn.classList.toggle("is-active", active);
  });

  picker.querySelectorAll(".slot-start-minute-option").forEach((btn) => {
    const btnMinute = btn.dataset.minute ?? "0";
    btn.disabled = !hasHour;
    btn.classList.toggle("is-active", hasHour && String(minute) === btnMinute);
  });

  picker.classList.toggle("has-time", hasHour);
}

function readSlotStartPickerValue(picker) {
  if (!picker) return "";
  const hourBtn = picker.querySelector(".slot-start-hour-option.is-active");
  const hour = hourBtn?.dataset.hour ?? "";
  if (hour === "") return "";
  const minute = picker.querySelector(".slot-start-minute-option.is-active")?.dataset.minute ?? "0";
  return slotStartTimeFromParts(hour, minute);
}

function initSlotStartPickerControls() {
  const wrap = document.getElementById("slot-edit-start-wrap");
  if (!wrap || wrap.dataset.bound) return;
  wrap.dataset.bound = "1";

  wrap.addEventListener("click", (e) => {
    const trigger = e.target.closest(".slot-start-hour-trigger");
    if (trigger) {
      const picker = trigger.closest("[data-slot-start-picker]");
      const panel = picker?.querySelector(".slot-start-hour-panel");
      if (!picker || !panel) return;
      const willOpen = panel.classList.contains("hidden");
      closeSlotStartHourPanels(picker);
      panel.classList.toggle("hidden", !willOpen);
      trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
      if (willOpen) {
        panel.querySelector(".slot-start-hour-option.is-active")?.scrollIntoView({ block: "nearest" });
      }
      return;
    }

    const hourBtn = e.target.closest(".slot-start-hour-option");
    if (hourBtn) {
      e.preventDefault();
      e.stopPropagation();
      const picker = hourBtn.closest("[data-slot-start-picker]");
      if (!picker) return;
      const hour = hourBtn.dataset.hour ?? "";
      if (hour === "") {
        applySlotStartPickerValue(picker, "");
      } else {
        const minute =
          picker.querySelector(".slot-start-minute-option.is-active")?.dataset.minute ?? "0";
        applySlotStartPickerValue(picker, slotStartTimeFromParts(hour, minute));
      }
      closeSlotStartHourPanels();
      return;
    }

    const minuteBtn = e.target.closest(".slot-start-minute-option");
    if (minuteBtn && !minuteBtn.disabled) {
      e.preventDefault();
      e.stopPropagation();
      const picker = minuteBtn.closest("[data-slot-start-picker]");
      const hourBtnActive = picker?.querySelector(".slot-start-hour-option.is-active");
      const hour = hourBtnActive?.dataset.hour ?? "";
      if (!picker || hour === "") return;
      applySlotStartPickerValue(
        picker,
        slotStartTimeFromParts(hour, minuteBtn.dataset.minute ?? "0")
      );
    }
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest(".slot-start-hour-field")) return;
    closeSlotStartHourPanels();
  });
}

function syncSlotEditTimeFields() {
  const isAllDay = document.getElementById("slot-edit-hours")?.value === "all-day";
  document.getElementById("slot-edit-start-wrap")?.classList.toggle("hidden", !!isAllDay);
}

function syncSlotEditLinkFields() {
  const type = getSlotEditLinkType();
  const isBroadcast = type === SLOT_LINK_TYPES.BROADCAST;
  const labelInput = document.getElementById("slot-edit-link-label");
  if (labelInput) {
    labelInput.placeholder = isBroadcast ? "채널명" : "표시 이름";
  }
}

function getSlotEditLinkType() {
  const checked = document.querySelector('input[name="slot-edit-link-type"]:checked');
  const value = String(checked?.value || SLOT_LINK_TYPES.GENERAL).trim();
  return value === SLOT_LINK_TYPES.BROADCAST ? SLOT_LINK_TYPES.BROADCAST : SLOT_LINK_TYPES.GENERAL;
}

function setSlotEditLinkType(value) {
  const type =
    value === SLOT_LINK_TYPES.BROADCAST ? SLOT_LINK_TYPES.BROADCAST : SLOT_LINK_TYPES.GENERAL;
  document
    .querySelectorAll('input[name="slot-edit-link-type"]')
    .forEach((input) => {
      input.checked = input.value === type;
    });
  syncSlotEditLinkFields();
}

export function openSlotEdit(date, index, slot, partIdx = 0) {
  closeContextMenu();
  editTarget = { date, index, partIdx };
  const modal = document.getElementById("slot-edit-modal");
  document.getElementById("slot-edit-title").textContent =
    index == null ? "일정 추가" : "일정 수정";
  document.getElementById("slot-edit-text").value = slot?.text || "";
  document.getElementById("slot-edit-members").value = slotMembers(slot);
  document.getElementById("slot-edit-link-url").value = slotLinkUrl(slot);
  document.getElementById("slot-edit-link-label").value = String(slot?.linkLabel || "").trim();
  setSlotEditLinkType(slotLinkType(slot) || SLOT_LINK_TYPES.GENERAL);
  const startTime = slotStartTime(slot);
  setSlotEditStartTime(startTime);
  renderSlotStartPickerUI(startTime);

  const sel = document.getElementById("slot-edit-category");
  sel.innerHTML = Object.entries(categories)
    .map(
      ([id, cat]) =>
        `<option value="${id}"${id === (slot?.category || FALLBACK_CATEGORY) ? " selected" : ""}>${escapeHtml(cat.label)}</option>`
    )
    .join("");

  const hoursSel = document.getElementById("slot-edit-hours");
  const isAllDay = isAllDaySlot(slot);
  const currentHours = isAllDay ? "all-day" : String(slotHours(slot));
  hoursSel.innerHTML =
    `<option value="all-day"${isAllDay ? " selected" : ""}>하루종일</option>` +
    Array.from({ length: 8 }, (_, i) => {
      const n = i + 1;
      return `<option value="${n}"${String(n) === currentHours ? " selected" : ""}>${n}시간</option>`;
    }).join("");
  hoursSel.value = isAllDay ? "all-day" : currentHours;
  syncSlotEditTimeFields();

  document.getElementById("slot-edit-delete").classList.toggle("hidden", index == null);
  modal.classList.remove("hidden");
  document.body.classList.add("slot-edit-open");
  if (!isMobileViewport()) {
    document.getElementById("slot-edit-text").focus();
  }
}

export function closeSlotEdit() {
  closeSlotStartHourPanels();
  document.getElementById("slot-edit-modal")?.classList.add("hidden");
  document.body.classList.remove("slot-edit-open");
  editTarget = null;
}

function onSlotEditKeydown(e) {
  if (e.key !== "Enter" || e.isComposing || e.repeat) return;
  if (e.shiftKey) return;
  const modal = document.getElementById("slot-edit-modal");
  if (!modal || modal.classList.contains("hidden")) return;
  if (e.target.closest("button")) return;
  e.preventDefault();
  onSlotEditSave();
}

function onSlotEditSave() {
  if (!editTarget) return;
  const text = document.getElementById("slot-edit-text").value.trim();
  if (!text) {
    alert("내용을 입력하세요.");
    return;
  }
  const category = document.getElementById("slot-edit-category").value;
  const hoursVal = document.getElementById("slot-edit-hours").value;
  const isAllDay = hoursVal === "all-day";
  const members = document.getElementById("slot-edit-members").value.trim();
  const linkUrl = normalizeSlotUrl(document.getElementById("slot-edit-link-url").value);
  const linkLabel = document
    .getElementById("slot-edit-link-label")
    .value.trim()
    .slice(0, SLOT_LINK_LABEL_MAX);
  const linkType = getSlotEditLinkType();
  const linkFields = linkUrl
    ? {
        linkUrl,
        linkType,
        ...(linkLabel ? { linkLabel } : {}),
      }
    : {};
  const startTime = isAllDay ? "" : getSlotEditStartTime();
  const { date, index, partIdx = 0 } = editTarget;
  const prevSlots = getPartSlots(date, partIdx);
  const oldText = index != null ? prevSlots[index]?.text : null;

  if (index != null && oldText) updateLinkedHighlight(date, oldText, text);

  const slot = isAllDay
    ? {
        text,
        category,
        allDay: true,
        ...(members ? { members } : {}),
        ...linkFields,
      }
    : {
        text,
        category,
        hours: Number(hoursVal) || 1,
        ...(startTime ? { startTime } : {}),
        ...(members ? { members } : {}),
        ...linkFields,
      };

  const slots = [...prevSlots];
  if (index == null) slots.push(slot);
  else slots[index] = slot;

  setPartSlots(date, partIdx, slots);
  void saveScheduleNow();
  closeSlotEdit();
}

function onSlotEditDelete() {
  if (!editTarget || editTarget.index == null) return;
  const { date, index, partIdx = 0 } = editTarget;
  const slots = [...getPartSlots(date, partIdx)];
  slots.splice(index, 1);
  setPartSlots(date, partIdx, slots);
  closeSlotEdit();
}

export function renderEditableSlots(dayData, dateKey) {
  const normalized = normalizeDay(dayData);
  if (!normalized) return "";
  return renderDaySlotList(normalized, categories, {
    dateKey,
    part: 0,
    ...slotRenderOptions(getCalendarLayout()),
    editable: canEdit,
  });
}
