/** 슬롯 정규화 · 렌더링 공통 */

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 표시용 — 앞뒤 공백만 제거, 줄바꿈 유지 */
export function displaySlotText(str) {
  return String(str || "").trim();
}

export const BANGON_PICKER_START = 10;
export const BANGON_PICKER_END = 18;
export const BANGON_PICKER_HOURS = Array.from(
  { length: BANGON_PICKER_END - BANGON_PICKER_START + 1 },
  (_, i) => BANGON_PICKER_START + i
);

/** 18시(6시) 이후 시작 일정은 칸 아래쪽에 배치 */
export const EVENING_START_HOUR = 18;

export const SLOT_START_MINUTE_OPTIONS = [0, 30];

export function snapMinuteToStep(minute, step = 30) {
  const m = Number(minute);
  if (!Number.isFinite(m)) return 0;
  const snapped = Math.round(m / step) * step;
  return Math.min(59, Math.max(0, snapped));
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
}

export const BANGON_PRESETS = {
  late: { value: "late", label: "늦뱅" },
  evening: { value: "evening", label: "저녁뱅" },
  late_or_off: { value: "late_or_off", label: "늦/휴뱅" },
};

/** ICS보내기와 동일 — 프리셋 뱅온 → 시작 시각(분) */
const BANGON_PRESET_START_MINUTES = {
  late: 15 * 60,
  late_or_off: 15 * 60,
  evening: 18 * 60,
};

/** 뱅온 빠른 선택 (자세히 보기) */
export const BANGON_QUICK_BUTTONS = [
  { value: "13:00", label: "1시" },
  { value: "late", label: "늦뱅" },
  { value: "late_or_off", label: "늦/휴뱅" },
];

const BANGON_PRESET_VALUES = new Set(Object.keys(BANGON_PRESETS));

export const BANGON_APPROX_SUFFIX = "~";

export function isBangonApproxValue(value) {
  const s = String(value || "").trim();
  return s.endsWith(BANGON_APPROX_SUFFIX) && s.length > BANGON_APPROX_SUFFIX.length;
}

export function stripBangonApproxSuffix(value) {
  const s = String(value || "").trim();
  return isBangonApproxValue(s) ? s.slice(0, -BANGON_APPROX_SUFFIX.length) : s;
}

export function isBangonPresetValue(value) {
  return BANGON_PRESET_VALUES.has(stripBangonApproxSuffix(String(value || "").trim()));
}

/** 그리드(10–18시) 밖 시간이거나 분 단위가 있으면 직접 입력 대상 */
export function isBangonCustomTime(value) {
  const v = stripBangonApproxSuffix(String(value || "").trim());
  if (!v || BANGON_PRESET_VALUES.has(v)) return false;
  const [hStr, mStr] = v.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (h < BANGON_PICKER_START || h > BANGON_PICKER_END) return true;
  return m !== 0;
}

function normalizeBangonTimeCore(raw) {
  if (raw == null || raw === "") return "";
  const s = String(raw).trim();
  if (BANGON_PRESET_VALUES.has(s)) return s;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "";
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** "HH:MM", "HH:MM~"(쯤), 또는 프리셋 키(late, evening, late_or_off) */
export function normalizeBangonValue(raw) {
  if (raw == null || raw === "") return "";
  const s = String(raw).trim();
  const approx = isBangonApproxValue(s);
  const normalized = normalizeBangonTimeCore(approx ? stripBangonApproxSuffix(s) : s);
  if (!normalized) return "";
  if (approx && !BANGON_PRESET_VALUES.has(normalized)) {
    return normalized + BANGON_APPROX_SUFFIX;
  }
  return normalized;
}

/** @deprecated normalizeBangonValue 사용 */
export function normalizeBangonTime(raw) {
  return normalizeBangonValue(raw);
}

export function getBangonTime(dayData) {
  if (!dayData || typeof dayData !== "object") return "";
  const norm = normalizeDay(dayData);
  return norm?.bangonTime || "";
}

export function formatBangonHourLabel(hour24) {
  const h = Number(hour24);
  if (!Number.isFinite(h)) return "";
  if (h === 0) return "0시";
  if (h === 12) return "12시";
  if (h > 12) return `${h - 12}시`;
  return `${h}시`;
}

function formatBangonMeridiem(hour24, minute = 0) {
  const h = Number(hour24);
  const m = Number(minute);
  if (!Number.isFinite(h)) return "";

  let period = "오전";
  let displayHour = h;

  if (h === 0) {
    displayHour = 12;
  } else if (h === 12) {
    period = "오후";
  } else if (h > 12) {
    displayHour = h - 12;
    period = "오후";
  }

  if (!m) return `${period} ${displayHour}시`;
  return `${period} ${displayHour}:${String(m).padStart(2, "0")}`;
}

/** 캘린더·모달 표시용 (예: 오전 10시, 오후 1시, 오후 4시 쯤) */
export function formatBangonTimeDisplay(value) {
  const v = normalizeBangonValue(value);
  if (!v) return "";
  const approx = isBangonApproxValue(v);
  const core = approx ? stripBangonApproxSuffix(v) : v;
  if (BANGON_PRESETS[core]) return BANGON_PRESETS[core].label;
  const [hStr, mStr] = core.split(":");
  const label = formatBangonMeridiem(Number(hStr), Number(mStr));
  return approx ? `${label} 쯤` : label;
}

/** 모바일 아젠다 — 시간은 "뱅온 오후 1시", 프리셋(늦뱅 등)은 라벨만 */
export function formatBangonAgendaLabel(value) {
  const display = formatBangonTimeDisplay(value);
  if (!display) return "";
  if (isBangonPresetValue(value)) return display;
  return `뱅온 ${display}`;
}

export function isOffDaySlots(slots) {
  return (slots || []).some((s) => isAllDaySlot(s) && s.category === "off");
}

export function bangonValueFromHour(hour) {
  const h = Math.min(23, Math.max(0, Number(hour)));
  if (!Number.isFinite(h)) return "";
  return `${String(h).padStart(2, "0")}:00`;
}

export function slotStartTimeFromParts(hour, minute = 0) {
  const h = Number(hour);
  const m = snapMinuteToStep(minute);
  if (!Number.isFinite(h) || h < 0 || h > 23) return "";
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function bangonTimeFromParts(hour, minute = 0, approx = false) {
  const base = slotStartTimeFromParts(hour, minute);
  if (!base) return "";
  return approx ? base + BANGON_APPROX_SUFFIX : base;
}

export function syncBangonPickerControls(picker) {
  if (!picker) return;
  const hour = picker.querySelector(".bangon-hour-select")?.value;
  const hasHour = hour !== "" && hour != null;
  const minuteSelect = picker.querySelector(".bangon-minute-select");
  const approxInput = picker.querySelector(".bangon-approx-input");
  const approxToggle = picker.querySelector(".bangon-approx-toggle");
  const custom = picker.querySelector(".slot-start-picker-custom");
  if (minuteSelect) minuteSelect.disabled = !hasHour;
  if (approxInput) {
    approxInput.disabled = !hasHour;
    if (!hasHour) approxInput.checked = false;
  }
  approxToggle?.classList.toggle("is-disabled", !hasHour);
  custom?.classList.toggle("has-hour", hasHour);
}

export function readBangonPickerValue(picker) {
  if (!picker) return "";
  const hour = picker.querySelector(".bangon-hour-select")?.value;
  if (hour === "" || hour == null) return "";
  const minute = picker.querySelector(".bangon-minute-select")?.value ?? "0";
  const approx = Boolean(picker.querySelector(".bangon-approx-input")?.checked);
  return bangonTimeFromParts(hour, minute, approx);
}

export function normalizeSlotStartTime(raw) {
  if (raw == null || raw === "") return "";
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return "";
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function timeToMinutes(timeStr) {
  const core =
    normalizeSlotStartTime(timeStr) ||
    stripBangonApproxSuffix(normalizeBangonValue(timeStr));
  if (!core || isBangonPresetValue(core)) return null;
  const [hStr, mStr] = core.split(":");
  return Number(hStr) * 60 + Number(mStr);
}

/** 18시 이후(6시 넘김) 시작이면 저녁 일정 */
export function isEveningStartTime(value) {
  const minutes = timeToMinutes(value);
  if (minutes == null) return false;
  return minutes >= EVENING_START_HOUR * 60;
}

function bangonAnchorMinutes(bangon) {
  const norm = normalizeBangonValue(bangon);
  if (!norm) return null;
  const core = stripBangonApproxSuffix(norm);
  if (isBangonPresetValue(core)) {
    return BANGON_PRESET_START_MINUTES[core] ?? 15 * 60;
  }
  return timeToMinutes(norm);
}

function accumulatedSlotOffsetMinutes(slots, index) {
  let total = 0;
  for (let i = 0; i < index; i++) {
    const slot = slots[i];
    if (slot && !isAllDaySlot(slot)) {
      total += slotHours(slot) * 60;
    }
  }
  return total;
}

/** ICS·캘린더 구독과 동일한 실제 시작 시각(분). 종일·계산 불가면 null */
export function effectiveSlotStartMinutes(
  slot,
  index,
  slots,
  bangon = "",
  minStartMinutes = null
) {
  if (isAllDaySlot(slot)) return null;
  const explicit = timeToMinutes(slotStartTime(slot));
  if (explicit != null) return explicit;
  const anchor = bangonAnchorMinutes(bangon);
  if (anchor == null && minStartMinutes == null) return null;
  let startMinutes = anchor != null ? anchor : minStartMinutes || 0;
  if (minStartMinutes != null) {
    startMinutes = Math.max(startMinutes, minStartMinutes);
  }
  startMinutes += accumulatedSlotOffsetMinutes(slots, index);
  if (startMinutes >= 24 * 60) return null;
  return startMinutes;
}

export function isEveningSlot(slot, context) {
  if (isAllDaySlot(slot)) return false;
  if (context?.slots && context.index != null) {
    const eff = effectiveSlotStartMinutes(
      slot,
      context.index,
      context.slots,
      context.bangon || "",
      context.minStartMinutes ?? null
    );
    if (eff != null) return eff >= EVENING_START_HOUR * 60;
  }
  const explicit = slotStartTime(slot);
  return explicit ? isEveningStartTime(explicit) : false;
}

/** 일정 시작 시간 선택 UI (편집 모달) — 네이티브 select 대신 인라인 목록 */
export function renderSlotStartTimePickerMarkup(activeValue) {
  const active = normalizeSlotStartTime(activeValue);
  const hasHour = Boolean(active);
  const [hourPart = "", minutePart = "0"] = active ? active.split(":") : [];
  const hour = hourPart === "" ? "" : Number(hourPart);
  const minute = hasHour ? snapMinuteToStep(minutePart) : 0;
  const currentHourLabel = hasHour
    ? formatBangonTimeDisplay(bangonValueFromHour(hour))
    : "선택 안 함";

  const hourButtons = [
    `<button type="button" class="slot-start-hour-option${!hasHour ? " is-active" : ""}" data-hour="" role="option">선택 안 함</button>`,
    ...Array.from({ length: 24 }, (_, h) => {
      const isActive = hasHour && hour === h ? " is-active" : "";
      const label = formatBangonTimeDisplay(bangonValueFromHour(h));
      return `<button type="button" class="slot-start-hour-option${isActive}" data-hour="${h}" role="option">${escapeHtml(label)}</button>`;
    }),
  ].join("");

  const minuteButtons = SLOT_START_MINUTE_OPTIONS.map((m) => {
    const isActive = hasHour && minute === m ? " is-active" : "";
    const disabled = hasHour ? "" : " disabled";
    return `<button type="button" class="slot-start-minute-option${isActive}" data-minute="${m}"${disabled}>${String(m).padStart(2, "0")}분</button>`;
  }).join("");

  return `
    <div class="slot-start-picker slot-start-picker--modal${hasHour ? " has-time" : ""}" data-slot-start-picker>
      <div class="slot-edit-time-split">
        <div class="slot-edit-time-part slot-edit-time-part--hour">
          <span class="slot-edit-time-part-label">시</span>
          <div class="slot-start-hour-field">
            <button type="button" class="slot-start-hour-trigger slot-edit-control" aria-expanded="false" aria-haspopup="listbox">
              <span class="slot-start-hour-trigger-label">${escapeHtml(currentHourLabel)}</span>
            </button>
            <div class="slot-start-hour-panel hidden" role="listbox" aria-label="시작 시각">
              <div class="slot-start-hour-list">${hourButtons}</div>
            </div>
          </div>
        </div>
        <div class="slot-edit-time-part slot-edit-time-part--minute">
          <span class="slot-edit-time-part-label">분</span>
          <div class="slot-start-minute-toggle" role="group" aria-label="분">${minuteButtons}</div>
        </div>
      </div>
    </div>`;
}

/** 뱅온 시간 선택 UI (자세히 보기 상단) */
export function renderBangonTimePickerMarkup(activeValue) {
  const active = normalizeBangonValue(activeValue);
  const isPreset = isBangonPresetValue(active);
  const hasHour = Boolean(active) && !isPreset;
  const approx = hasHour && isBangonApproxValue(active);
  const timeCore = hasHour ? stripBangonApproxSuffix(active) : "";
  const [hourPart = "", minutePart = "0"] = hasHour ? timeCore.split(":") : [];
  const hour = hourPart === "" ? "" : Number(hourPart);
  const minute = hasHour ? snapMinuteToStep(minutePart) : 0;

  const quickHtml =
    BANGON_QUICK_BUTTONS.map(({ value, label }) => {
      const isActive = active === normalizeBangonValue(value);
      return `<button type="button" class="bangon-quick-btn${isActive ? " is-active" : ""}" data-bangon="${escapeAttr(value)}">${escapeHtml(label)}</button>`;
    }).join("") +
    `<button type="button" class="bangon-quick-btn bangon-quick-btn--clear${!active ? " is-active" : ""}" data-bangon="">삭제</button>`;

  const hourOptions =
    `<option value="">선택 안 함</option>` +
    Array.from({ length: 24 }, (_, h) => {
      const selected = hasHour && hour === h ? " selected" : "";
      const label = formatBangonTimeDisplay(bangonValueFromHour(h));
      return `<option value="${h}"${selected}>${escapeHtml(label)}</option>`;
    }).join("");

  const minuteOptions = SLOT_START_MINUTE_OPTIONS.map((m) => {
    const selected = hasHour && minute === m ? " selected" : "";
    return `<option value="${m}"${selected}>${String(m).padStart(2, "0")}분</option>`;
  }).join("");

  const minuteBlock = `<span class="slot-start-colon" aria-hidden="true">:</span>
        <select class="bangon-minute-select" aria-label="분"${hasHour ? "" : " disabled"}>${minuteOptions}</select>`;

  const approxToggle = `
        <label class="bangon-approx-toggle${hasHour ? "" : " is-disabled"}">
          <input type="checkbox" class="bangon-approx-input"${approx ? " checked" : ""}${hasHour ? "" : " disabled"} />
          <span>쯤</span>
        </label>`;

  return `
    <div class="bangon-picker" data-bangon-picker>
      <div class="bangon-quick-actions" role="group" aria-label="뱅온 시간">${quickHtml}</div>
      <div class="slot-start-picker-custom slot-start-picker-custom--solo${hasHour ? " has-hour" : ""}">
        <div class="slot-start-picker-selects">
          <select class="bangon-hour-select" aria-label="시">${hourOptions}</select>
          ${minuteBlock}
          ${approxToggle}
        </div>
      </div>
    </div>`;
}

export function formatSlotStartTimeDisplay(value) {
  return formatBangonTimeDisplay(value);
}

export function formatSlotStartTimeCompact(value) {
  const v = normalizeSlotStartTime(value);
  if (!v) return "";
  const [hStr, mStr] = v.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  const hour12 = h % 12 || 12;
  if (!m) return `${hour12}시`;
  return `${hour12}:${String(m).padStart(2, "0")}`;
}

export function slotStartTime(slot) {
  return isAllDaySlot(slot) ? "" : normalizeSlotStartTime(slot?.startTime);
}

export function slotMembers(slot) {
  return String(slot?.members || "").trim();
}

export function normalizeSlotUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s.slice(0, 500);
  if (/^(www\.|[a-z0-9.-]+\.[a-z]{2,})/i.test(s)) {
    return `https://${s.replace(/^\/+/, "")}`.slice(0, 500);
  }
  return "";
}

export function normalizeBroadcastUrl(raw) {
  return normalizeSlotUrl(raw);
}

export const SLOT_LINK_LABEL_MAX = 80;
export const DEFAULT_SLOT_LINK_LABEL = "링크";
export const DEFAULT_SLOT_BROADCAST_LABEL = "방송국";
export const SLOT_LINK_TYPES = Object.freeze({
  GENERAL: "general",
  BROADCAST: "broadcast",
});

export function slotLinkUrl(slot) {
  return normalizeSlotUrl(slot?.linkUrl ?? slot?.broadcastUrl);
}

export function slotLinkType(slot) {
  const raw = String(slot?.linkType || "").trim();
  if (raw === SLOT_LINK_TYPES.BROADCAST || raw === SLOT_LINK_TYPES.GENERAL) return raw;
  if (slot?.broadcastUrl && !slot?.linkUrl) return SLOT_LINK_TYPES.BROADCAST;
  return slotLinkUrl(slot) ? SLOT_LINK_TYPES.GENERAL : "";
}

export function slotGeneralLinkUrl(slot) {
  if (!slotLinkUrl(slot) || slotLinkType(slot) !== SLOT_LINK_TYPES.GENERAL) return "";
  return slotLinkUrl(slot);
}

export function slotBroadcastStationUrl(slot) {
  if (!slotLinkUrl(slot) || slotLinkType(slot) !== SLOT_LINK_TYPES.BROADCAST) return "";
  return slotLinkUrl(slot);
}

export function slotLinkLabel(slot, { fallback = true } = {}) {
  const label = String(slot?.linkLabel ?? "")
    .trim()
    .slice(0, SLOT_LINK_LABEL_MAX);
  if (label) return label;
  if (fallback && slotGeneralLinkUrl(slot)) return DEFAULT_SLOT_LINK_LABEL;
  return "";
}

export function slotBroadcastLabel(slot) {
  const label = String(slot?.linkLabel ?? "")
    .trim()
    .slice(0, SLOT_LINK_LABEL_MAX);
  if (label) return label;
  const url = slotBroadcastStationUrl(slot);
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return DEFAULT_SLOT_BROADCAST_LABEL;
  }
}

/** @deprecated slotGeneralLinkUrl / slotBroadcastStationUrl 사용 */
export function slotBroadcastUrl(slot) {
  return slotBroadcastStationUrl(slot) || slotGeneralLinkUrl(slot);
}

const SLOT_LINK_ICON = `<svg class="slot-link-icon" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8.25 1.5H10.5v6.75H9V3.56L4.06 8.5 3 7.44 7.94 2.5H6.75V1.5h1.5Z"/><path fill="currentColor" d="M2.75 3.25h1.5v1H3.5a1 1 0 0 0-1 1v4.5a1 1 0 0 0 1 1h4.5a1 1 0 0 0 1-1V8.25H9.5v1.25a2.25 2.25 0 0 1-2.25 2.25h-4.5A2.25 2.25 0 0 1 1 9.5V4.5a2.25 2.25 0 0 1 2.25-2.25Z"/></svg>`;
const SLOT_BROADCAST_LINK_ICON = `<span class="slot-broadcast-mark slot-link-broadcast-icon" aria-hidden="true"></span>`;

export function renderSlotLinkHtml(slot, { className = "slot-link", showIcon = true } = {}) {
  const href = slotGeneralLinkUrl(slot);
  if (!href) return "";
  const label = slotLinkLabel(slot);
  const icon = showIcon ? SLOT_LINK_ICON : "";
  return `<a class="${className}" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${icon}<span class="slot-link-label">${escapeHtml(label)}</span></a>`;
}

export function renderSlotShortcutLinkHtml(slot, { className = "slot-link", showIcon = true } = {}) {
  const href = slotLinkUrl(slot);
  if (!href) return "";
  const isBroadcast = slotLinkType(slot) === SLOT_LINK_TYPES.BROADCAST;
  const label = isBroadcast
    ? slotBroadcastLabel(slot) || DEFAULT_SLOT_BROADCAST_LABEL
    : slotLinkLabel(slot);
  const icon = showIcon ? (isBroadcast ? SLOT_BROADCAST_LINK_ICON : SLOT_LINK_ICON) : "";
  const typeClass = isBroadcast ? " slot-link--broadcast" : "";
  return `<a class="${className}${typeClass}" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${icon}<span class="slot-link-label">${escapeHtml(label)}</span></a>`;
}

export function renderSlotBroadcastMarkup(label) {
  if (!label) return "";
  return `<span class="slot-broadcast-mark" aria-hidden="true"></span><span class="slot-broadcast-text">${escapeHtml(label)}</span>`;
}

export function renderSlotBroadcastHtml(
  slot,
  { className = "slot-broadcast", showText = true } = {}
) {
  const href = slotBroadcastStationUrl(slot);
  if (!href) return "";
  const label = slotBroadcastLabel(slot);
  const text = showText && label ? renderSlotBroadcastMarkup(label) : "";
  const aria = label || DEFAULT_SLOT_BROADCAST_LABEL;
  return `<a class="${className}" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" aria-label="방송국 ${escapeAttr(aria)}">${text}</a>`;
}

export function renderSlotChipMetaHtml(slot) {
  const members = slotMembers(slot);
  const membersHtml = members ? renderSlotMembers(members) : "";
  const broadcastHtml = renderSlotBroadcastHtml(slot);
  if (!membersHtml && !broadcastHtml) return "";
  return `<div class="slot-chip-meta">${membersHtml}${broadcastHtml}</div>`;
}

/** @deprecated renderSlotLinkHtml(slot) 사용 */
export function renderSlotBroadcastLinkHtml(urlOrSlot, { className = "slot-link", label, showIcon = true } = {}) {
  if (urlOrSlot && typeof urlOrSlot === "object") {
    return renderSlotLinkHtml(urlOrSlot, { className, showIcon });
  }
  const href = normalizeSlotUrl(urlOrSlot);
  if (!href) return "";
  const text = String(label || "").trim() || DEFAULT_SLOT_LINK_LABEL;
  const icon = showIcon ? SLOT_LINK_ICON : "";
  return `<a class="${className}" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${icon}<span class="slot-link-label">${escapeHtml(text)}</span></a>`;
}

export function findHighlightPartRef(dayData, highlightText) {
  const matched = findHighlightSlot(dayData, highlightText, { fallbackFirst: false });
  if (!matched) return null;
  const matchedNorm = normalizeMatchText(matched.text);
  const parts = getDayParts(dayData);
  for (const part of parts) {
    for (const slot of part.slots || []) {
      if (normalizeMatchText(slot.text) === matchedNorm) {
        return { part, slot };
      }
    }
  }
  return parts.length ? { part: parts[0], slot: matched } : { part: null, slot: matched };
}

export function getHighlightDisplayMeta(dayData, highlightText) {
  const ref = findHighlightPartRef(dayData, highlightText);
  if (!ref?.slot) return "";
  const { part, slot } = ref;
  if (isAllDaySlot(slot)) {
    const bangon =
      part && !isOffDaySlots(part.slots || []) ? normalizeBangonValue(part.bangonTime) : "";
    return bangon ? formatBangonTimeDisplay(bangon) : "";
  }
  const startTime = slotStartTime(slot);
  return startTime ? formatSlotStartTimeDisplay(startTime) : "";
}

export function renderHighlightCardHtml({
  month,
  day,
  dow,
  isToday = false,
  catLabel = "일반",
  text = "",
  chipStyle = "",
  metaLabel = "",
} = {}) {
  const metaHtml = metaLabel
    ? `<span class="hl-meta">${escapeHtml(metaLabel)}</span>`
    : "";
  const headAside = metaHtml ? `<div class="hl-head-aside">${metaHtml}</div>` : "";

  return `<div class="hl-card${isToday ? " hl-card--today" : ""}" style="${chipStyle}">
    <div class="hl-date-col">
      <span class="hl-date-num">${month}/${day}</span>
      <span class="hl-date-dow">${escapeHtml(dow)}</span>
    </div>
    <div class="hl-main">
      <div class="hl-head">
        <div class="hl-head-main">
          <span class="hl-cat">${escapeHtml(catLabel)}</span>
        </div>
        ${headAside}
      </div>
      <p class="hl-text">${escapeHtml(displaySlotText(text))}</p>
    </div>
  </div>`;
}

export function renderSlotMembersMarkup(members) {
  if (!members) return "";
  return `<span class="slot-members-mark" aria-hidden="true"></span><span class="slot-members-label">멤버</span><span class="slot-members-text">${escapeHtml(members)}</span>`;
}

export function renderSlotMembers(members, className = "slot-members") {
  if (!members) return "";
  return `<span class="${className}" aria-label="멤버 ${escapeAttr(members)}">${renderSlotMembersMarkup(members)}</span>`;
}

export function packSlotForSave(slot) {
  const text = String(slot?.text || "").trim();
  if (!text) return null;
  const category = slot?.category || FALLBACK_CATEGORY;
  if (isAllDaySlot(slot)) {
    const packed = { text, category, allDay: true };
    const members = slotMembers(slot);
    if (members) packed.members = members;
    packSlotLinkFields(packed, slot);
    return packed;
  }
  const packed = {
    text,
    category,
    hours: slotHours(slot),
  };
  const startTime = slotStartTime(slot);
  if (startTime) packed.startTime = startTime;
  const members = slotMembers(slot);
  if (members) packed.members = members;
  packSlotLinkFields(packed, slot);
  return packed;
}

function packSlotLinkFields(packed, slot) {
  const linkUrl = slotLinkUrl(slot);
  if (!linkUrl) return;
  packed.linkUrl = linkUrl;
  const linkType = slotLinkType(slot);
  if (linkType) packed.linkType = linkType;
  const linkLabel = String(slot?.linkLabel || "")
    .trim()
    .slice(0, SLOT_LINK_LABEL_MAX);
  if (linkLabel) packed.linkLabel = linkLabel;
}

export function renderStartTimeBadge(
  startTime,
  { compact = true, className = "slot-duration", hours = 1 } = {}
) {
  const label = compact
    ? formatSlotStartTimeCompact(startTime)
    : formatSlotStartTimeDisplay(startTime);
  const aria = formatSlotStartTimeDisplay(startTime);
  const h = slotHours({ hours });
  return `<span class="${className} slot-duration--start" style="--slot-hours:${h}" aria-label="시작 ${escapeHtml(aria)}">${escapeHtml(label)}</span>`;
}

export function isAllDaySlot(slot) {
  return slot?.allDay === true;
}

export const FALLBACK_CATEGORY = "default";
export const ALL_DAY_CONVERT_HOURS = 4;
export const ALL_DAY_FLEX_HOURS = 1;

function normalizeSlotItems(raw, dayCat) {
  return (raw || [])
    .map((item) => {
      if (typeof item === "string") {
        return { text: item.trim(), category: dayCat };
      }
      if (item && typeof item === "object") {
        const allDay = item.allDay === true;
        const slot = {
          text: String(item.text || "").trim(),
          category: item.category || dayCat,
          allDay,
        };
        if (!allDay) slot.hours = slotHours(item);
        const startTime = slotStartTime(item);
        if (startTime) slot.startTime = startTime;
        const members = slotMembers(item);
        if (members) slot.members = members;
        const linkUrl = slotLinkUrl(item);
        if (linkUrl) slot.linkUrl = linkUrl;
        const linkType = slotLinkType(item);
        if (linkType) slot.linkType = linkType;
        const linkLabel = String(item?.linkLabel || "")
          .trim()
          .slice(0, SLOT_LINK_LABEL_MAX);
        if (linkLabel) slot.linkLabel = linkLabel;
        return slot;
      }
      return null;
    })
    .filter((s) => s && s.text);
}

export function normalizeDay(dayData, fallbackCategory = FALLBACK_CATEGORY) {
  if (!dayData) return null;
  const dayCat = dayData.category || fallbackCategory;
  let slots = normalizeSlotItems(dayData.slots, dayCat);
  let bangonTime = isOffDaySlots(slots) ? "" : normalizeBangonValue(dayData.bangonTime);

  const part2Raw =
    dayData.part2 && typeof dayData.part2 === "object" ? dayData.part2 : null;

  // 1부가 비었는데 2부만 남은 저장 상태는 2부를 1부로 승격
  if (!slots.length && part2Raw) {
    const promotedSlots = normalizeSlotItems(part2Raw.slots, dayCat);
    if (promotedSlots.length) {
      slots = promotedSlots;
      bangonTime = isOffDaySlots(slots)
        ? ""
        : normalizeBangonValue(dayData.bangonTime) ||
          normalizeBangonValue(part2Raw.bangonTime);
    }
  }

  // 2부: 1부 일정이 있을 때만 유효
  const part2Slots =
    part2Raw && slots.length ? normalizeSlotItems(part2Raw.slots, dayCat) : [];
  const part2Bangon =
    part2Raw && slots.length && !isOffDaySlots(part2Slots)
      ? normalizeBangonValue(part2Raw.bangonTime)
      : "";

  const result = {};
  if (slots.length) result.slots = slots;
  if (bangonTime) result.bangonTime = bangonTime;

  // 렌더용 parts: 2부는 일정이 1개 이상일 때만 박스로 표시
  const parts = [];
  if (slots.length || bangonTime) parts.push({ bangonTime, slots });
  if (part2Slots.length) parts.push({ bangonTime: part2Bangon, slots: part2Slots });
  if (parts.length) result.parts = parts;

  // 저장용 part2: 뱅온만 설정한 편집 중 상태도 보존 (슬롯 또는 뱅온이 있으면)
  if (part2Slots.length || part2Bangon) {
    result.part2 = {};
    if (part2Slots.length) result.part2.slots = part2Slots;
    if (part2Bangon) result.part2.bangonTime = part2Bangon;
  }

  return Object.keys(result).length ? result : null;
}

/** 정규화된 부(part) 배열 반환. 1부 전용이면 길이 1 */
export function getDayParts(dayData) {
  const norm = normalizeDay(dayData);
  if (!norm) return [];
  if (norm.parts) return norm.parts;
  if (norm.slots) return [{ bangonTime: norm.bangonTime || "", slots: norm.slots }];
  return [];
}

export function dayHasSecondPart(dayData) {
  return getDayParts(dayData).length > 1;
}

export function slotHours(slot) {
  if (isAllDaySlot(slot)) return 0;
  const h = Number(slot?.hours);
  return Number.isFinite(h) && h >= 1 ? Math.round(h) : 1;
}

export function slotFlexWeight(slot) {
  if (isAllDaySlot(slot)) return ALL_DAY_FLEX_HOURS;
  return slotHours(slot);
}

export function dayTotalHours(slots) {
  return (slots || []).reduce((sum, s) => sum + slotHours(s), 0);
}

/** 1·2부 슬롯을 합친 배열 (주요 일정 매칭용) */
export function collectDaySlots(dayData) {
  return getDayParts(dayData).flatMap((part) => part.slots || []);
}

export function findHighlightSlot(dayData, highlightText, { fallbackFirst = true } = {}) {
  const slots = collectDaySlots(dayData);
  const target = normalizeMatchText(highlightText);
  if (!slots.length) return null;
  if (!target) return fallbackFirst ? slots[0] : null;

  const exact = slots.find((s) => normalizeMatchText(s.text) === target);
  if (exact) return exact;

  const loose = slots.find((s) => {
    const slotText = normalizeMatchText(s.text);
    const firstLine = String(s.text || "").split("\n")[0].trim();
    return (
      slotText.includes(target) ||
      target.includes(slotText) ||
      (firstLine && (target.includes(firstLine) || firstLine.includes(target)))
    );
  });
  if (loose) return loose;
  return fallbackFirst ? slots[0] : null;
}

/** 주요 일정이 실제 슬롯과 대응하는지 (첫 슬롯으로 대체하지 않음) */
export function highlightMatchesAnySlot(slots, highlightText) {
  const list = slots || [];
  if (!list.length) return false;
  const target = normalizeMatchText(highlightText);
  if (!target) return false;

  return list.some((s) => {
    const slotText = normalizeMatchText(s.text);
    if (slotText === target) return true;
    const firstLine = String(s.text || "").split("\n")[0].trim();
    return (
      slotText.includes(target) ||
      target.includes(slotText) ||
      (firstLine &&
        (target.includes(firstLine) ||
          firstLine.includes(target) ||
          normalizeMatchText(firstLine) === target))
    );
  });
}

export function normalizeMatchText(str) {
  return String(str || "").replace(/\s+/g, " ").trim();
}

export function slotCategory(slot, categories) {
  return categories[slot.category] || categories[FALLBACK_CATEGORY] || {};
}

export function formatDurationLabel(hours, { compact = false, allDay = false } = {}) {
  if (allDay) return compact ? "종일" : "하루종일";
  const h = slotHours({ hours });
  if (compact) return String(h);
  return h === 1 ? "1시간" : `${h}시간`;
}

export function renderAllDayBadge(className = "slot-duration") {
  return `<span class="${className} slot-duration--all-day" aria-label="하루종일"><span class="slot-duration-dot" aria-hidden="true"></span></span>`;
}

export function renderDurationBadge(hours, { compact = false, className = "slot-duration", allDay = false } = {}) {
  if (allDay) return renderAllDayBadge(className);
  const label = formatDurationLabel(hours, { compact, allDay });
  const aria = formatDurationLabel(hours);
  return `<span class="${className}" aria-label="${aria}">${label}</span>`;
}

export function getAllDaySlot(dayData) {
  return normalizeDay(dayData)?.slots?.find(isAllDaySlot) || null;
}

export function splitDaySlots(slots) {
  const list = slots || [];
  return {
    allDay: list.find(isAllDaySlot) || null,
    timed: list.filter((s) => !isAllDaySlot(s)),
  };
}

export function allDayToTimed(slot, hours = ALL_DAY_CONVERT_HOURS) {
  const next = {
    text: String(slot.text || "").trim(),
    category: slot.category || FALLBACK_CATEGORY,
    hours,
  };
  const members = slotMembers(slot);
  if (members) next.members = members;
  packSlotLinkFields(next, slot);
  return next;
}

export function dayHasTimedSlots(slots) {
  return splitDaySlots(slots).timed.length > 0;
}

function renderInlineTimeText(slot) {
  const allDay = isAllDaySlot(slot);
  const startTime = slotStartTime(slot);
  if (allDay) {
    return `<span class="slot-time-text slot-time-text--all-day" aria-label="하루종일">종일</span>`;
  }
  if (!startTime) return "";
  const label = formatSlotStartTimeDisplay(startTime);
  return `<span class="slot-time-text" aria-label="시작 ${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

function renderInlineFallbackBadge(slot, { compactDuration = true } = {}) {
  const allDay = isAllDaySlot(slot);
  const startTime = slotStartTime(slot);
  const className = "slot-duration slot-duration--inline-fallback";
  if (allDay) {
    return renderAllDayBadge(className);
  }
  if (!startTime) return "";
  return renderStartTimeBadge(startTime, {
    compact: compactDuration,
    className,
    hours: slotHours(slot),
  });
}

// ===== 선명(vivid) 칩 색상: 솔리드 배경 + 자동 대비 글자색 =====
function hexToRgb(hex) {
  let s = String(hex || "").trim().replace(/^#/, "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function rgbToHsl({ r, g, b }) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hue2rgb(p, q, h + 1 / 3) * 255,
    g: hue2rgb(p, q, h) * 255,
    b: hue2rgb(p, q, h - 1 / 3) * 255,
  };
}

function relLuminance({ r, g, b }) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(a, b) {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 카테고리 bg hue에서 읽기 좋은 선명 accent 글자색을 만든다.
 * 무채색 카테고리는 저장된 text 색을 유지한다.
 */
function categoryAccentText(bgHex, textHex) {
  const bg = hexToRgb(bgHex);
  if (!bg) return textHex || "#333333";
  const { h, s, l } = rgbToHsl(bg);
  if (s < 0.12 || (s < 0.2 && l > 0.88)) {
    return textHex || "#444444";
  }
  const stored = hexToRgb(textHex);
  if (stored) {
    const ts = rgbToHsl(stored);
    if (ts.s >= 0.22) {
      const hueDiff = Math.abs(ts.h - h);
      const wrapDiff = Math.min(hueDiff, 1 - hueDiff);
      if (wrapDiff < 0.07) return textHex;
    }
  }
  const accentS = Math.min(0.86, Math.max(s * 1.12, 0.48));
  let accentL = 0.38;
  let accentRgb = hslToRgb(h, accentS, accentL);
  const tintBgRgb = hslToRgb(
    h,
    Math.min(0.68, Math.max(s * 2.1 + 0.14, 0.32)),
    0.9
  );
  if (contrastRatio(accentRgb, tintBgRgb) < 4.5) {
    accentL = 0.3;
    accentRgb = hslToRgb(h, accentS, accentL);
  }
  return rgbToHex(accentRgb);
}

/**
 * 은은한 파스텔: 아주 연한 틴트 배경 + 카테고리색 글자.
 * 선명한 파스텔(tinted)보다 채도·대비가 낮다.
 */
export function subtlePastelChipColors(bgHex, textHex) {
  const baseBg = hexToRgb(bgHex);
  if (!baseBg) {
    return { bg: bgHex || "#fff", text: textHex || "#333", border: `${textHex || "#333"}22` };
  }
  const { h, s, l } = rgbToHsl(baseBg);
  const chromatic = s >= 0.12;
  let tbg;
  let borderRgb;
  if (chromatic) {
    const targetS = Math.min(0.4, Math.max(s * 0.75 + 0.06, 0.1));
    const targetL = 0.945;
    tbg = hslToRgb(h, targetS, targetL);
    borderRgb = hslToRgb(h, targetS * 0.5, 0.88);
  } else {
    tbg = l > 0.9 ? baseBg : hslToRgb(h, Math.max(s, 0.04), 0.94);
    borderRgb = { r: tbg.r * 0.9, g: tbg.g * 0.9, b: tbg.b * 0.9 };
  }
  const text = categoryAccentText(bgHex, textHex);
  return { bg: rgbToHex(tbg), text, border: rgbToHex(borderRgb) };
}

/**
 * 선명한 파스텔: 연한 틴트 배경 + 카테고리색 글자.
 * 은은한 파스텔보다 배경 채도·틴트가 더 선명하다.
 */
export function tintedChipColors(bgHex, textHex) {
  const baseBg = hexToRgb(bgHex);
  if (!baseBg) {
    return { bg: bgHex || "#fff", text: textHex || "#333", border: `${textHex || "#333"}33` };
  }
  const { h, s, l } = rgbToHsl(baseBg);
  const chromatic = s >= 0.12;
  let tbg;
  let borderRgb;
  if (chromatic) {
    const targetS = Math.min(0.68, Math.max(s * 2.1 + 0.14, 0.32));
    const targetL = 0.9;
    tbg = hslToRgb(h, targetS, targetL);
    borderRgb = hslToRgb(h, Math.min(1, targetS * 0.75), 0.78);
  } else {
    tbg = baseBg;
    borderRgb = { r: baseBg.r * 0.88, g: baseBg.g * 0.88, b: baseBg.b * 0.88 };
  }
  const text = categoryAccentText(bgHex, textHex);
  return { bg: rgbToHex(tbg), text, border: rgbToHex(borderRgb) };
}

/** @deprecated tintedChipColors 사용 */
export const vividChipColors = tintedChipColors;

/** 카테고리에 저장된 bg/text/border 그대로 */
export function originalChipColors(bgHex, textHex) {
  const text = textHex || "#333333";
  return { bg: bgHex || "#ffffff", text, border: `${text}33` };
}

export function resolveChipColors(colorMode, bgHex, textHex) {
  const mode = String(colorMode || "default");
  if (mode === "tinted" || mode === "vivid") return tintedChipColors(bgHex, textHex);
  if (mode === "original") return originalChipColors(bgHex, textHex);
  return subtlePastelChipColors(bgHex, textHex);
}

/** 주요일정 카드 — 칩 색 + 오늘 펄스용 카테고리 원색 */
export function highlightCardStyleVars(hlColors, pulseColor) {
  const accent = pulseColor || hlColors.text || hlColors.bg;
  return `--chip-bg:${hlColors.bg};--chip-text:${hlColors.text};--chip-border:${hlColors.border};--highlight:${accent};--today-glow:color-mix(in srgb, ${accent} 42%, transparent);--today-glow-strong:color-mix(in srgb, ${accent} 58%, transparent)`;
}

export function renderSlotChip(
  slot,
  categories,
  {
    compactDuration = true,
    chipStyle = "sidebar",
    colorMode = "default",
    editable = false,
    editableClass = true,
    dateKey = "",
    slotIndex = 0,
    part = 0,
    evening = false,
  } = {}
) {
  const cat = slotCategory(slot, categories);
  const colors = resolveChipColors(colorMode, cat.bg, cat.text);
  const allDay = isAllDaySlot(slot);
  const hours = slotFlexWeight(slot);
  const startTime = slotStartTime(slot);
  const members = slotMembers(slot);
  const hasBroadcast = Boolean(slotBroadcastStationUrl(slot));
  const metaHtml = renderSlotChipMetaHtml(slot);
  const hasMeta = Boolean(members || hasBroadcast);
  const useInlineStyle = chipStyle === "inline";
  const sidebarTimeBadge = allDay
    ? renderAllDayBadge()
    : startTime
      ? renderStartTimeBadge(startTime, { compact: compactDuration, hours: slotHours(slot) })
      : "";
  const hasTimedInfo = allDay || startTime;
  const inlineTimeText = useInlineStyle && hasTimedInfo ? renderInlineTimeText(slot) : "";
  const inlineFallbackBadge =
    useInlineStyle && hasTimedInfo ? renderInlineFallbackBadge(slot, { compactDuration }) : "";
  const badge = useInlineStyle ? "" : sidebarTimeBadge;
  const hasBadgeClass = !useInlineStyle && hasTimedInfo ? " slot-chip--has-start" : "";
  const inlineTimedClass = useInlineStyle && hasTimedInfo ? " slot-chip--inline-timed" : "";
  const eveningClass = evening && !allDay ? " slot-chip--evening" : "";
  const tintedClass =
    colorMode === "tinted" || colorMode === "vivid"
      ? " slot-chip--tinted"
      : colorMode === "original"
        ? " slot-chip--original"
        : "";
  const extraClass = `${allDay ? " slot-chip--all-day" : ""}${hasBadgeClass}${inlineTimedClass}${eveningClass}${tintedClass}${editable && editableClass ? " slot-chip--editable" : ""}`;
  const dragMeta = editable
    ? ` data-date="${dateKey}" data-slot-index="${slotIndex}" data-part="${part}"`
    : "";
  const chipDragAttrs = editable ? `${dragMeta} draggable="true"` : "";
  const metaClass = hasMeta ? " slot-chip--has-members slot-chip--has-meta" : "";
  return `
    <div class="slot-chip${extraClass}${metaClass}"${chipDragAttrs}
         style="--chip-bg:${colors.bg};--chip-text:${colors.text};--chip-border:${colors.border};--slot-hours:${hours};">
      ${badge}
      ${inlineFallbackBadge}
      ${inlineTimeText}
      <div class="slot-chip-body">
        <span class="slot-text">${escapeHtml(slot.text)}</span>
        ${metaHtml}
      </div>
    </div>`;
}

export const SLOT_RENDER_OPTIONS = {
  compactDuration: true,
};

function sortSlotsForDayBand(slots) {
  return slots
    .map((slot, index) => ({ slot, index }))
    .sort((a, b) => {
      const aEvening = isEveningSlot(a.slot);
      const bEvening = isEveningSlot(b.slot);
      if (aEvening !== bEvening) return aEvening ? 1 : -1;
      return a.index - b.index;
    });
}

export function renderDaySlotList(normalized, categories, options = {}) {
  if (!normalized?.slots?.length) return "";
  const ordered = sortSlotsForDayBand(normalized.slots);
  const hasEvening = ordered.some(({ slot }) => isEveningSlot(slot));
  const listClass = `slot-list${hasEvening ? " slot-list--has-evening" : ""}`;

  const chips = ordered
    .map(({ slot, index: i }) =>
      renderSlotChip(slot, categories, {
        ...options,
        slotIndex: i,
        evening: isEveningSlot(slot),
      })
    )
    .join("");

  const partAttr = options.part != null ? ` data-part="${options.part}"` : "";
  return `<div class="${listClass}" data-date="${options.dateKey || ""}"${partAttr}>${chips}</div>`;
}

export function renderDaySlots(dayData, categories, options = {}) {
  const normalized = normalizeDay(dayData);
  if (!normalized) return "";
  return renderDaySlotList(normalized, categories, options);
}

export function dayAccentCategory(dayData, categories) {
  const normalized = normalizeDay(dayData);
  if (!normalized) return null;
  const counts = {};
  normalized.slots.forEach((s) => {
    counts[s.category] = (counts[s.category] || 0) + 1;
  });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? categories[top[0]] : null;
}
