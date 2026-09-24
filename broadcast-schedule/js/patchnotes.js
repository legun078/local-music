import { detectScheduleBase } from "./base-path.js";
import {
  apiFetch,
  consumeAuthErrorFromUrl,
  fetchAuthConfig,
  fetchMe,
  renderModeControl,
} from "./auth.js";
import { escapeHtml } from "./slots.js";
import { startContentSync } from "./content-sync.js";
import { applyLinksPageFonts } from "./calendar-fonts.js";
import { applyBrandTheme } from "./theme.js";

const BASE = window.SCHEDULE_BASE || detectScheduleBase() || "";
const PATCH_AREA_ORDER = ["홈", "캘린더", "노래책", "사이트"];
const PATCH_IMAGE_SIZES = ["sm", "md", "lg", "full"];
const PATCH_IMAGE_SIZE_LABELS = { sm: "작게", md: "중간", lg: "크게", full: "전체" };
const PATCH_IMAGE_SIZE_DEFAULT = "full";
const PATCHNOTES_PER_PAGE = 5;
const EDITOR_CARET_ANCHOR = "\u200B";

const state = {
  data: null,
  me: null,
  isDeveloper: false,
  editMode: false,
  saving: false,
  pagination: null,
  page: 1,
};

const els = {};
let contentSync = null;
let lightbox = { images: [], index: 0 };

function isEditing() {
  return state.isDeveloper && state.editMode;
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function setStatus(message, kind = "") {
  if (!els.status) return;
  els.status.textContent = message || "";
  els.status.classList.toggle("is-error", kind === "error");
  els.status.classList.toggle("is-ok", kind === "ok");
}

function blockHeading(block) {
  const date = block.date || "";
  const label = String(block.label || "").trim();
  return label ? `${date} · ${label}` : date;
}

function patchAreaRank(area) {
  const idx = PATCH_AREA_ORDER.indexOf(area);
  return idx >= 0 ? idx : PATCH_AREA_ORDER.length;
}

function sortBlockItems(items) {
  return [...items]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const byArea = patchAreaRank(a.item.area) - patchAreaRank(b.item.area);
      return byArea !== 0 ? byArea : a.index - b.index;
    })
    .map(({ item }) => item);
}

function sortPatchnotesData() {
  if (!state.data || !Array.isArray(state.data.blocks)) return;
  for (const block of state.data.blocks) {
    block.items = sortBlockItems(block.items || []);
  }
}

function normalizePatchMultiline(raw) {
  return String(raw || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function resolvePatchImageUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return `${BASE}${raw}`;
  return raw;
}

function patchImageUrlFromSrc(src) {
  const raw = String(src || "").trim();
  if (!raw) return "";
  try {
    const parsed = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(raw, window.location.origin);
    if (parsed.pathname.startsWith("/uploads/patchnote-images/")) {
      return parsed.pathname;
    }
    const basePath = `${BASE}/uploads/patchnote-images/`;
    if (raw.startsWith(basePath)) {
      return raw.slice(BASE.length);
    }
  } catch {
    return "";
  }
  return "";
}

function normalizePatchImageSize(raw) {
  const size = String(raw || "").trim().toLowerCase();
  return PATCH_IMAGE_SIZES.includes(size) ? size : PATCH_IMAGE_SIZE_DEFAULT;
}

function normalizePatchImageCaption(raw) {
  return String(raw || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function readEditorCaptionValue(el) {
  if (!el) return "";
  return normalizePatchImageCaption(el.value ?? el.textContent ?? "");
}

function createEditorCaretAnchor() {
  return document.createTextNode(EDITOR_CARET_ANCHOR);
}

function isEditorCaretAnchor(node) {
  return node?.nodeType === Node.TEXT_NODE && node.textContent === EDITOR_CARET_ANCHOR;
}

function resizeEditorCaption(captionInput) {
  if (!captionInput) return;
  captionInput.style.height = "auto";
  captionInput.style.height = `${Math.max(captionInput.scrollHeight, 40)}px`;
}

function bindEditorCaptionInput(captionInput) {
  if (!captionInput) return;
  captionInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.shiftKey) {
      e.stopPropagation();
      return;
    }
    e.preventDefault();
  });
  captionInput.addEventListener("input", () => resizeEditorCaption(captionInput));
  resizeEditorCaption(captionInput);
}

function patchImageSizeClass(size) {
  return `patch-item-content-image--${normalizePatchImageSize(size)}`;
}

function itemContentBlocks(item) {
  if (Array.isArray(item?.content) && item.content.length) return item.content;
  const blocks = [];
  const details = normalizePatchMultiline(item?.details);
  if (details) blocks.push({ type: "text", text: details });
  const imageUrl = String(item?.imageUrl || "").trim();
  if (imageUrl) {
    const block = { type: "image", url: imageUrl };
    if (item.imageAlt) block.alt = item.imageAlt;
    blocks.push(block);
  }
  return blocks;
}

function patchItemImageBlockHtml(block, item, { zoomable = false } = {}) {
  const src = resolvePatchImageUrl(block.url);
  const alt = escapeHtml(String(block.alt || block.caption || item.text || "").trim() || "안내 이미지");
  const sizeClass = patchImageSizeClass(block.size);
  const caption = escapeHtml(normalizePatchImageCaption(block.caption));
  const img = `<img src="${escapeHtml(src)}" alt="${alt}" loading="lazy" decoding="async" />`;
  const mediaInner = zoomable
    ? `<button type="button" class="patch-item-image-zoom" aria-label="전체 화면으로 보기">${img}</button>`
    : img;
  const captionHtml = caption
    ? `<figcaption class="patch-item-image-caption">${caption}</figcaption>`
    : "";
  return `<figure class="patch-item-content-image ${sizeClass}">
    <div class="patch-item-image-row">
      <div class="patch-item-image-media">${mediaInner}</div>
      ${captionHtml}
    </div>
  </figure>`;
}

function patchItemContentHtml(item) {
  const blocks = itemContentBlocks(item);
  if (!blocks.length) return "";
  const zoomable = !isEditing();
  const parts = blocks
    .map((block) => {
      if (block.type === "text") {
        return `<div class="patch-item-content-text">${escapeHtml(block.text)}</div>`;
      }
      if (block.type === "image") {
        return patchItemImageBlockHtml(block, item, { zoomable });
      }
      return "";
    })
    .join("");
  return `<div class="patch-item-content">${parts}</div>`;
}

function patchItemBodyHtml(item) {
  const text = escapeHtml(item.text || "");
  const contentHtml = patchItemContentHtml(item);
  return `<div class="patch-item-body">
      <p class="patch-item-text">${text}</p>
      ${contentHtml}
    </div>`;
}

function patchItemHtml(item, blockId) {
  const editing = isEditing();
  const area = escapeHtml(item.area || "사이트");
  const body = patchItemBodyHtml(item);
  if (!editing) {
    return `<li class="patch-item">
      <span class="patch-item-area">${area}</span>
      ${body}
    </li>`;
  }
  return `<li class="patch-item patch-item--editable">
    <button
      type="button"
      class="patch-item-edit-btn"
      data-patch-item-edit="${escapeHtml(item.id)}"
      data-patch-block-id="${escapeHtml(blockId)}"
      aria-label="패치 항목 수정"
    >
      <span class="patch-item-area">${area}</span>
      ${body}
    </button>
  </li>`;
}

function patchBlockHtml(block, index, total) {
  const heading = escapeHtml(blockHeading(block));
  const datetime = escapeHtml(block.date || "");
  const items = sortBlockItems(block.items || []).map((item) => patchItemHtml(item, block.id)).join("");
  const editing = isEditing();
  const actions = editing
    ? `<div class="patch-block-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-patch-block-up="${escapeHtml(block.id)}" ${index === 0 ? "disabled" : ""} aria-label="위로">↑</button>
        <button type="button" class="btn btn-ghost btn-sm" data-patch-block-down="${escapeHtml(block.id)}" ${index >= total - 1 ? "disabled" : ""} aria-label="아래로">↓</button>
        <button type="button" class="btn btn-ghost btn-sm" data-patch-block-edit="${escapeHtml(block.id)}">블록</button>
        <button type="button" class="btn btn-ghost btn-sm patch-block-delete-btn" data-patch-block-delete="${escapeHtml(block.id)}">삭제</button>
      </div>`
    : "";
  const addItem = editing
    ? `<div class="patch-block-foot">
        <button type="button" class="btn btn-ghost btn-sm" data-patch-item-add="${escapeHtml(block.id)}">+ 항목</button>
      </div>`
    : "";
  return `<article class="panel patch-block${editing ? " patch-block--editable" : ""}" data-patch-block="${escapeHtml(block.id)}">
    <header class="patch-block-head">
      <h2 class="patch-block-date"><time datetime="${datetime}">${heading}</time></h2>
      ${actions}
    </header>
    <ul class="patch-block-list">${items || (editing ? `<li class="patch-empty">항목이 없습니다.</li>` : "")}</ul>
    ${addItem}
  </article>`;
}

function renderBlocks() {
  if (!els.blocks) return;
  const blocks = (state.data && state.data.blocks) || [];
  const visible = isEditing() ? blocks : blocks.filter((block) => (block.items || []).length > 0);
  if (!visible.length && !isEditing()) {
    els.blocks.innerHTML = `<p class="patch-empty">등록된 패치가 없습니다.</p>`;
    return;
  }
  els.blocks.innerHTML = visible
    .map((block, index) => patchBlockHtml(block, index, visible.length))
    .join("");
  if (els.addBlockWrap) els.addBlockWrap.classList.toggle("hidden", !isEditing());
}

function renderPagination() {
  const nav = els.pagination;
  if (!nav) return;
  const pag = state.pagination;
  const show = !isEditing() && pag && pag.totalPages > 1;
  nav.classList.toggle("hidden", !show);
  if (!show) return;

  const page = pag.page || 1;
  const total = pag.totalPages || 1;
  if (els.pageInfo) els.pageInfo.textContent = `${page} / ${total}`;
  if (els.pagePrev) els.pagePrev.disabled = page <= 1;
  if (els.pageNext) els.pageNext.disabled = page >= total;
}

function renderAll() {
  sortPatchnotesData();
  renderBlocks();
  renderPagination();
  document.body.classList.toggle("patchnotes-edit-mode", isEditing());
  if (els.editModeWrap) els.editModeWrap.classList.toggle("hidden", !state.isDeveloper);
}

function readPageFromUrl() {
  const raw = new URLSearchParams(window.location.search).get("page");
  const page = Number.parseInt(raw || "1", 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function writePageToUrl(page) {
  const url = new URL(window.location.href);
  if (page <= 1) url.searchParams.delete("page");
  else url.searchParams.set("page", String(page));
  history.replaceState(null, "", url);
}

async function loadPatchnotesPage(page = 1) {
  const data = await fetchPatchnotes({ page });
  state.data = data;
  state.pagination = data.pagination || null;
  state.page = data.pagination?.page || page;
  writePageToUrl(state.page);
  renderAll();
}

async function loadAllPatchnotes() {
  const data = await fetchPatchnotes({ all: true });
  state.data = data;
  state.pagination = null;
  renderAll();
}

function findBlock(blockId) {
  return (state.data.blocks || []).find((block) => block.id === blockId) || null;
}

function findItem(blockId, itemId) {
  const block = findBlock(blockId);
  if (!block) return { block: null, item: null, index: -1 };
  const index = (block.items || []).findIndex((item) => item.id === itemId);
  return { block, item: index >= 0 ? block.items[index] : null, index };
}

async function persistPatchnotes() {
  if (!state.isDeveloper || !state.data) return;
  sortPatchnotesData();
  state.saving = true;
  setStatus("저장 중…");
  try {
    const res = await apiFetch("/api/patchnotes", {
      method: "PUT",
      body: JSON.stringify(state.data),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.hint || body.error || "저장 실패");
    setStatus("저장됨", "ok");
  } catch (err) {
    setStatus(err.message || "저장 실패", "error");
  } finally {
    state.saving = false;
  }
}

function openBlockModal(blockId = "") {
  const block = blockId ? findBlock(blockId) : null;
  els.blockModalTitle.textContent = block ? "패치 블록 수정" : "패치 블록 추가";
  els.blockId.value = block ? block.id : "";
  els.blockDate.value = block ? block.date || "" : new Date().toISOString().slice(0, 10);
  els.blockLabel.value = block ? block.label || "" : "";
  els.blockDelete.classList.toggle("hidden", !block);
  els.blockModal.classList.remove("hidden");
  els.blockModal.setAttribute("aria-hidden", "false");
  els.blockDate.focus();
}

function closeBlockModal() {
  els.blockModal.classList.add("hidden");
  els.blockModal.setAttribute("aria-hidden", "true");
}

function openItemModal(blockId, itemId = "") {
  const { item } = findItem(blockId, itemId);
  els.itemModalTitle.textContent = item ? "패치 항목 수정" : "패치 항목 추가";
  els.itemId.value = item ? item.id : "";
  els.itemBlockId.value = blockId;
  els.itemArea.value = item ? item.area || "홈" : "홈";
  els.itemText.value = item ? item.text || "" : "";
  fillContentEditor(item ? itemContentBlocks(item) : []);
  setContentEditorStatus("");
  els.itemDelete.classList.toggle("hidden", !item);
  els.itemModal.classList.remove("hidden");
  els.itemModal.setAttribute("aria-hidden", "false");
  els.itemArea.focus();
}

function closeItemModal() {
  els.itemModal.classList.add("hidden");
  els.itemModal.setAttribute("aria-hidden", "true");
  if (els.itemContentImageFile) els.itemContentImageFile.value = "";
  clearContentEditor();
  setContentEditorStatus("");
}

function setContentEditorStatus(message, kind = "") {
  if (!els.itemContentStatus) return;
  els.itemContentStatus.textContent = message || "";
  els.itemContentStatus.classList.toggle("hidden", !message);
  els.itemContentStatus.classList.toggle("is-error", kind === "error");
}

function clearContentEditor() {
  if (els.itemContentEditor) els.itemContentEditor.innerHTML = "";
}

function wrapEditorImageFigure(figure) {
  const wrapper = document.createElement("div");
  wrapper.className = "patch-editor-image-block";
  wrapper.setAttribute("contenteditable", "false");
  wrapper.appendChild(figure);
  return wrapper;
}

function createEditorImageFigure(url, alt = "", size = PATCH_IMAGE_SIZE_DEFAULT, caption = "") {
  const normalizedSize = normalizePatchImageSize(size);
  const figure = document.createElement("figure");
  figure.className = "patch-editor-figure";
  figure.setAttribute("data-patch-size", normalizedSize);
  figure.setAttribute("contenteditable", "false");

  const row = document.createElement("div");
  row.className = "patch-editor-figure-row";

  const media = document.createElement("div");
  media.className = "patch-editor-figure-media";

  const img = document.createElement("img");
  img.src = resolvePatchImageUrl(url);
  img.alt = alt || "";
  img.className = "patch-content-editor-image";
  img.setAttribute("data-patch-url", url);
  img.setAttribute("draggable", "false");
  media.appendChild(img);

  const captionWrap = document.createElement("div");
  captionWrap.className = "patch-editor-figure-caption-wrap";

  const captionInput = document.createElement("textarea");
  captionInput.className = "patch-editor-figure-caption";
  captionInput.setAttribute("data-patch-caption", "");
  captionInput.setAttribute("maxlength", "400");
  captionInput.setAttribute("rows", "2");
  captionInput.setAttribute("placeholder", "캡션 (선택, Shift+Enter 줄바꿈)");
  captionInput.value = normalizePatchImageCaption(caption);
  bindEditorCaptionInput(captionInput);
  captionWrap.appendChild(captionInput);

  row.appendChild(media);
  row.appendChild(captionWrap);

  const controls = document.createElement("div");
  controls.className = "patch-editor-figure-controls";

  const controlsLabel = document.createElement("span");
  controlsLabel.className = "patch-editor-figure-controls-label";
  controlsLabel.textContent = "크기";

  const sizeGroup = document.createElement("div");
  sizeGroup.className = "patch-editor-figure-size";
  sizeGroup.setAttribute("role", "group");
  sizeGroup.setAttribute("aria-label", "이미지 크기");
  for (const key of PATCH_IMAGE_SIZES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "patch-editor-figure-size-btn";
    btn.setAttribute("data-patch-size-set", key);
    btn.textContent = PATCH_IMAGE_SIZE_LABELS[key];
    if (key === normalizedSize) btn.classList.add("is-active");
    sizeGroup.appendChild(btn);
  }

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "patch-editor-figure-delete";
  removeBtn.setAttribute("data-patch-image-remove", "");
  removeBtn.textContent = "삭제";

  controls.appendChild(controlsLabel);
  controls.appendChild(sizeGroup);
  controls.appendChild(removeBtn);
  figure.appendChild(row);
  figure.appendChild(controls);
  return figure;
}

function readEditorImageBlock(node) {
  const figure = node.tagName === "FIGURE" ? node : node.closest?.(".patch-editor-figure");
  const img =
    node.tagName === "IMG"
      ? node
      : figure
        ? figure.querySelector("img")
        : null;
  if (!img) return null;
  const url = patchImageUrlFromSrc(img.getAttribute("data-patch-url") || img.getAttribute("src") || "");
  if (!url) return null;
  const block = { type: "image", url };
  const alt = String(img.getAttribute("alt") || "").trim();
  if (alt) block.alt = alt;
  const sizeSource = figure ? figure.getAttribute("data-patch-size") : img.getAttribute("data-patch-size");
  const size = normalizePatchImageSize(sizeSource);
  if (size !== PATCH_IMAGE_SIZE_DEFAULT) block.size = size;
  const captionInput = figure?.querySelector(".patch-editor-figure-caption[data-patch-caption]");
  const caption = readEditorCaptionValue(captionInput);
  if (caption) block.caption = caption;
  return block;
}

function isInsideEditorImageBlock(node) {
  if (!node) return false;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return Boolean(el?.closest?.(".patch-editor-image-block, .patch-editor-figure"));
}

function normalizeContentEditorDom() {
  const root = els.itemContentEditor;
  if (!root) return;

  const misplaced = [...root.querySelectorAll(".patch-editor-image-block")].filter(
    (block) => block.parentElement !== root && block.parentElement?.closest(".patch-editor-image-block, .patch-editor-figure")
  );
  for (const block of misplaced) {
    root.appendChild(document.createElement("br"));
    root.appendChild(block);
  }

  const looseFigures = [...root.querySelectorAll(":scope > .patch-editor-figure")];
  for (const figure of looseFigures) {
    root.replaceChild(wrapEditorImageFigure(figure), figure);
  }

  for (const block of root.querySelectorAll(":scope > .patch-editor-image-block")) {
    ensureImageBlockAnchors(block);
  }
}

function ensureImageBlockAnchors(wrapper) {
  const parent = wrapper?.parentElement;
  if (!parent) return;

  if (!isEditorCaretAnchor(wrapper.previousSibling)) {
    parent.insertBefore(createEditorCaretAnchor(), wrapper);
  }

  const next = wrapper.nextSibling;
  if (isEditorCaretAnchor(next)) return;
  if (next?.nodeType === Node.ELEMENT_NODE && next.tagName === "BR") {
    parent.insertBefore(createEditorCaretAnchor(), next);
    return;
  }
  parent.insertBefore(createEditorCaretAnchor(), next);
}

function insertImageNodesAtRange(range, wrapper) {
  const beforeAnchor = createEditorCaretAnchor();
  const afterAnchor = createEditorCaretAnchor();
  const lineBreak = document.createElement("br");

  range.deleteContents();
  range.insertNode(lineBreak);
  range.insertNode(afterAnchor);
  range.insertNode(wrapper);
  range.insertNode(beforeAnchor);
  range.setStartAfter(afterAnchor);
  range.collapse(true);
  return range;
}

function appendImageBlockToEditor(root, wrapper) {
  root.appendChild(createEditorCaretAnchor());
  root.appendChild(wrapper);
  ensureImageBlockAnchors(wrapper);
  root.appendChild(document.createElement("br"));
}

function placeCaretBesideImageBlock(imageBlock, side) {
  const root = els.itemContentEditor;
  if (!root || !imageBlock) return;

  ensureImageBlockAnchors(imageBlock);
  const sel = window.getSelection();
  if (!sel) return;

  const range = document.createRange();
  if (side === "before") {
    const anchor = imageBlock.previousSibling;
    if (isEditorCaretAnchor(anchor)) {
      range.setStart(anchor, anchor.textContent.length);
    } else {
      range.setStartBefore(imageBlock);
    }
  } else {
    const anchor = imageBlock.nextSibling;
    if (isEditorCaretAnchor(anchor)) {
      range.setStart(anchor, anchor.textContent.length);
    } else if (anchor?.nodeType === Node.ELEMENT_NODE && anchor.tagName === "BR") {
      range.setStartBefore(anchor);
    } else {
      range.setStartAfter(imageBlock);
    }
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  root.focus();
}

function insertImageInEditor(url, alt = "", size = PATCH_IMAGE_SIZE_DEFAULT) {
  const root = els.itemContentEditor;
  if (!root) return;

  const wrapper = wrapEditorImageFigure(createEditorImageFigure(url, alt, size));
  const sel = window.getSelection();
  let inserted = false;

  if (sel && sel.rangeCount) {
    const range = sel.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const insideImage = isInsideEditorImageBlock(anchor);

    if (root.contains(anchor) && !insideImage) {
      const nextRange = insertImageNodesAtRange(range, wrapper);
      sel.removeAllRanges();
      sel.addRange(nextRange);
      inserted = true;
    }
  }

  if (!inserted) {
    appendImageBlockToEditor(root, wrapper);
    const selAfter = window.getSelection();
    if (selAfter) {
      const range = document.createRange();
      const caret = wrapper.nextSibling;
      if (isEditorCaretAnchor(caret)) {
        range.setStart(caret, caret.textContent.length);
      } else {
        range.setStartAfter(wrapper);
      }
      range.collapse(true);
      selAfter.removeAllRanges();
      selAfter.addRange(range);
    }
  }

  root.focus();
}

function fillContentEditor(blocks) {
  clearContentEditor();
  const root = els.itemContentEditor;
  if (!root || !blocks.length) return;
  for (const block of blocks) {
    if (block.type === "text") {
      const lines = String(block.text || "").split("\n");
      lines.forEach((line, index) => {
        if (index > 0) root.appendChild(document.createElement("br"));
        if (line) root.appendChild(document.createTextNode(line));
      });
      root.appendChild(document.createElement("br"));
      continue;
    }
    if (block.type === "image") {
      const wrapper = wrapEditorImageFigure(
        createEditorImageFigure(block.url, block.alt, block.size, block.caption)
      );
      root.appendChild(createEditorCaretAnchor());
      root.appendChild(wrapper);
      ensureImageBlockAnchors(wrapper);
      root.appendChild(document.createElement("br"));
    }
  }
}

function mergeAdjacentTextBlocks(blocks) {
  const merged = [];
  for (const block of blocks) {
    if (block.type === "text" && merged.length && merged[merged.length - 1].type === "text") {
      merged[merged.length - 1].text = normalizePatchMultiline(
        `${merged[merged.length - 1].text}\n${block.text}`
      );
    } else {
      merged.push({ ...block });
    }
  }
  return merged.filter((block) => block.type !== "text" || block.text);
}

function extractContentFromEditor() {
  normalizeContentEditorDom();
  const root = els.itemContentEditor;
  if (!root) return [];
  const blocks = [];
  let textParts = [];

  function flushText() {
    const text = normalizePatchMultiline(
      textParts.join("").replace(/\u00a0/g, " ").replace(/\u200B/g, "")
    );
    textParts = [];
    if (text) blocks.push({ type: "text", text });
  }

  function processNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!isInsideEditorImageBlock(node)) {
        textParts.push(node.textContent || "");
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    if (node.matches(".patch-editor-image-block")) {
      flushText();
      const figure = node.querySelector(":scope > .patch-editor-figure") || node.querySelector(".patch-editor-figure");
      const block = figure ? readEditorImageBlock(figure) : null;
      if (block) blocks.push(block);
      return;
    }

    if (node.matches(".patch-editor-figure")) {
      flushText();
      const block = readEditorImageBlock(node);
      if (block) blocks.push(block);
      return;
    }

    if (node.tagName === "BR") {
      if (!isInsideEditorImageBlock(node)) {
        textParts.push("\n");
      }
      return;
    }

    if (node.tagName === "IMG" && node.classList.contains("patch-content-editor-image")) {
      flushText();
      const block = readEditorImageBlock(node);
      if (block) blocks.push(block);
      return;
    }

    if (isInsideEditorImageBlock(node)) return;

    for (const child of node.childNodes) processNode(child);
  }

  for (const child of root.childNodes) processNode(child);
  flushText();
  return mergeAdjacentTextBlocks(blocks);
}

function removeEditorImageFigure(figure) {
  if (!figure || !els.itemContentEditor) return;
  const wrapper = figure.closest(".patch-editor-image-block");
  const target = wrapper || figure;
  if (!els.itemContentEditor.contains(target)) return;

  const prev = target.previousSibling;
  const next = target.nextSibling;
  target.remove();

  if (isEditorCaretAnchor(prev)) prev.remove();
  if (isEditorCaretAnchor(next)) {
    next.remove();
  } else if (next?.nodeType === Node.ELEMENT_NODE && next.tagName === "BR") {
    next.remove();
  } else if (next?.nodeType === Node.TEXT_NODE && !next.textContent?.replace(/\u200B/g, "").trim()) {
    next.remove();
  }

  els.itemContentEditor.focus();
}

function handleContentEditorPointerDown(e) {
  if (!els.itemContentEditor?.contains(e.target)) return;
  if (e.target.closest("button, textarea, input, .patch-editor-figure-controls")) return;

  const imageBlock = e.target.closest(".patch-editor-image-block");
  if (!imageBlock) return;

  e.preventDefault();
  const rect = imageBlock.getBoundingClientRect();
  const placeBefore = e.clientY < rect.top + rect.height / 2;
  placeCaretBesideImageBlock(imageBlock, placeBefore ? "before" : "after");
}

function handleContentEditorKeydown(e) {
  if (!els.itemContentEditor?.contains(e.target) && e.target !== els.itemContentEditor) return;
  if (e.target.closest(".patch-editor-figure-caption")) return;

  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return;

  const root = els.itemContentEditor;
  let node = range.startContainer;
  let offset = range.startOffset;

  if (node.nodeType === Node.TEXT_NODE) {
    if (e.key === "ArrowRight" && offset === node.textContent.length) {
      const next = node.nextSibling;
      if (next?.classList?.contains("patch-editor-image-block")) {
        e.preventDefault();
        placeCaretBesideImageBlock(next, "after");
      }
    } else if (e.key === "ArrowLeft" && offset === 0) {
      const prev = node.previousSibling;
      if (prev?.classList?.contains("patch-editor-image-block")) {
        e.preventDefault();
        placeCaretBesideImageBlock(prev, "before");
      }
    }
    return;
  }

  if (node === root && e.key === "ArrowLeft" && offset > 0) {
    const prev = root.childNodes[offset - 1];
    if (prev?.classList?.contains("patch-editor-image-block")) {
      e.preventDefault();
      placeCaretBesideImageBlock(prev, "before");
    }
  } else if (node === root && e.key === "ArrowRight" && offset < root.childNodes.length) {
    const next = root.childNodes[offset];
    if (next?.classList?.contains("patch-editor-image-block")) {
      e.preventDefault();
      placeCaretBesideImageBlock(next, "after");
    }
  }
}

function handleContentEditorFigureClick(e) {
  if (!els.itemContentEditor?.contains(e.target)) return;

  const removeBtn = e.target.closest("[data-patch-image-remove]");
  if (removeBtn) {
    e.preventDefault();
    const figure = removeBtn.closest(".patch-editor-figure");
    if (figure) removeEditorImageFigure(figure);
    return;
  }

  const sizeBtn = e.target.closest("[data-patch-size-set]");
  if (!sizeBtn) return;
  e.preventDefault();
  const figure = sizeBtn.closest(".patch-editor-figure");
  if (!figure) return;
  const size = normalizePatchImageSize(sizeBtn.getAttribute("data-patch-size-set"));
  figure.setAttribute("data-patch-size", size);
  figure.querySelectorAll(".patch-editor-figure-size-btn").forEach((el) => {
    el.classList.toggle("is-active", el === sizeBtn);
  });
}

function setPatchImageLightboxIndex(nextIndex) {
  if (!els.imageLightbox || !els.imageLightboxImg) return;
  const images = Array.isArray(lightbox.images) ? lightbox.images : [];
  if (!images.length) return;
  const max = images.length;
  const idx = ((Number(nextIndex) || 0) + max) % max;
  lightbox.index = idx;

  const item = images[idx] || {};
  els.imageLightboxImg.src = item.src || "";
  els.imageLightboxImg.alt = item.alt || "안내 이미지";

  const countText = max > 1 ? `${idx + 1} / ${max}` : "";
  if (els.imageLightboxCount) els.imageLightboxCount.textContent = countText;
  if (els.imageLightboxPrev) els.imageLightboxPrev.disabled = max <= 1;
  if (els.imageLightboxNext) els.imageLightboxNext.disabled = max <= 1;
}

function openPatchImageLightboxFromImages(images, startIndex = 0) {
  if (!els.imageLightbox || !els.imageLightboxImg) return;
  lightbox = { images: Array.isArray(images) ? images : [], index: 0 };
  els.imageLightbox.classList.remove("hidden");
  els.imageLightbox.setAttribute("aria-hidden", "false");
  document.body.classList.add("patch-image-lightbox-open");
  setPatchImageLightboxIndex(startIndex);
  els.imageLightboxClose?.focus();
}

function openPatchImageLightboxFromEl(imgEl) {
  const img = imgEl && imgEl.tagName === "IMG" ? imgEl : null;
  if (!img?.src) return;
  const block = img.closest(".patch-block") || document;
  const imgs = [...block.querySelectorAll(".patch-item-image-zoom img")].filter((x) => x && x.src);
  const images = imgs.map((x) => ({ src: x.src, alt: x.alt || "" }));
  const startIndex = Math.max(0, imgs.indexOf(img));
  openPatchImageLightboxFromImages(images.length ? images : [{ src: img.src, alt: img.alt || "" }], startIndex);
}

function closePatchImageLightbox() {
  if (!els.imageLightbox) return;
  els.imageLightbox.classList.add("hidden");
  els.imageLightbox.setAttribute("aria-hidden", "true");
  document.body.classList.remove("patch-image-lightbox-open");
  if (els.imageLightboxImg) {
    els.imageLightboxImg.removeAttribute("src");
    els.imageLightboxImg.alt = "";
  }
  if (els.imageLightboxCount) els.imageLightboxCount.textContent = "";
  lightbox = { images: [], index: 0 };
}

async function uploadPatchnoteImageFile(file) {
  if (!file) throw new Error("파일이 없습니다.");
  const body = new FormData();
  const name = String(file.name || "").trim();
  body.append("file", file, name || "paste.png");
  const res = await fetch(`${BASE}/api/patchnotes/image-upload`, {
    method: "POST",
    credentials: "same-origin",
    body,
  });
  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const hint =
      res.status === 413
        ? "파일이 너무 큽니다 (최대 4MB)"
        : data?.hint ||
          data?.error ||
          (raw && !raw.startsWith("<") ? raw.slice(0, 160) : "") ||
          `업로드 실패 (${res.status})`;
    throw new Error(hint);
  }
  if (!data?.url) throw new Error("업로드 응답이 올바르지 않습니다.");
  return data.url;
}

async function uploadAndInsertImages(files) {
  const list = [...(files || [])].filter((file) => file && file.type.startsWith("image/"));
  if (!list.length) return;
  setContentEditorStatus(`업로드 중… (0/${list.length})`);
  try {
    for (let index = 0; index < list.length; index += 1) {
      setContentEditorStatus(`업로드 중… (${index + 1}/${list.length})`);
      const url = await uploadPatchnoteImageFile(list[index]);
      insertImageInEditor(url);
    }
    setContentEditorStatus(list.length > 1 ? `${list.length}장 추가됨` : "이미지 추가됨");
  } catch (err) {
    setContentEditorStatus(err.message || "업로드 실패", "error");
  }
}

async function handleContentEditorPaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  const imageItems = [...items].filter((item) => item.type.startsWith("image/"));
  if (!imageItems.length) return;
  e.preventDefault();
  const files = imageItems.map((item) => item.getAsFile()).filter(Boolean);
  await uploadAndInsertImages(files);
}

function handleContentEditorDragOver(e) {
  if (!e.dataTransfer?.types?.includes("Files")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
}

async function handleContentEditorDrop(e) {
  const files = [...(e.dataTransfer?.files || [])].filter((file) => file.type.startsWith("image/"));
  if (!files.length) return;
  e.preventDefault();
  await uploadAndInsertImages(files);
}

async function handleContentImageFileChange() {
  const files = els.itemContentImageFile?.files;
  if (!files?.length) return;
  await uploadAndInsertImages(files);
  if (els.itemContentImageFile) els.itemContentImageFile.value = "";
}

async function saveBlockFromForm(e) {
  e.preventDefault();
  if (!isEditing() || !state.data) return;
  const date = els.blockDate.value.trim();
  if (!date) {
    alert("날짜를 입력해 주세요.");
    els.blockDate.focus();
    return;
  }
  const id = els.blockId.value.trim();
  const label = els.blockLabel.value.trim();
  const blocks = [...(state.data.blocks || [])];
  const payload = {
    id: id || newId("patch"),
    date,
    label,
    items: [],
  };
  const idx = id ? blocks.findIndex((block) => block.id === id) : -1;
  if (idx >= 0) {
    payload.items = blocks[idx].items || [];
    blocks[idx] = { ...blocks[idx], ...payload };
  } else {
    blocks.unshift(payload);
  }
  state.data.blocks = blocks;
  closeBlockModal();
  renderAll();
  await persistPatchnotes();
}

async function deleteBlockById(blockId) {
  if (!blockId || !isEditing() || !confirm("이 패치 블록을 삭제할까요?")) return;
  state.data.blocks = (state.data.blocks || []).filter((block) => block.id !== blockId);
  closeBlockModal();
  renderAll();
  await persistPatchnotes();
}

async function saveItemFromForm(e) {
  e.preventDefault();
  if (!isEditing() || !state.data) return;
  const text = normalizePatchMultiline(els.itemText.value);
  if (!text) {
    alert("내용을 입력해 주세요.");
    els.itemText.focus();
    return;
  }
  const blockId = els.itemBlockId.value.trim();
  const itemId = els.itemId.value.trim();
  const block = findBlock(blockId);
  if (!block) return;
  const items = [...(block.items || [])];
  const content = extractContentFromEditor();
  const payload = {
    id: itemId || newId("item"),
    area: els.itemArea.value,
    text,
  };
  if (content.length) payload.content = content;
  const idx = itemId ? items.findIndex((item) => item.id === itemId) : -1;
  if (idx >= 0) {
    const updated = { ...items[idx], ...payload };
    if (!content.length) {
      delete updated.content;
      delete updated.details;
      delete updated.imageUrl;
      delete updated.imageAlt;
    }
    items[idx] = updated;
  } else {
    items.push(payload);
  }
  block.items = items;
  closeItemModal();
  renderAll();
  await persistPatchnotes();
}

async function deleteItemFromForm() {
  const blockId = els.itemBlockId.value.trim();
  const itemId = els.itemId.value.trim();
  if (!itemId || !isEditing() || !confirm("이 항목을 삭제할까요?")) return;
  const block = findBlock(blockId);
  if (!block) return;
  block.items = (block.items || []).filter((item) => item.id !== itemId);
  closeItemModal();
  renderAll();
  await persistPatchnotes();
}

function moveBlock(blockId, delta) {
  if (!isEditing() || !state.data) return;
  const blocks = [...(state.data.blocks || [])];
  const idx = blocks.findIndex((block) => block.id === blockId);
  const next = idx + delta;
  if (idx < 0 || next < 0 || next >= blocks.length) return;
  const [item] = blocks.splice(idx, 1);
  blocks.splice(next, 0, item);
  state.data.blocks = blocks;
  renderAll();
  void persistPatchnotes();
}

function bindEvents() {
  document.querySelectorAll("[data-edit-mode]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!state.isDeveloper) return;
      const nextEdit = btn.getAttribute("data-edit-mode") === "true";
      state.editMode = nextEdit;
      document.querySelectorAll("[data-edit-mode]").forEach((el) => {
        el.classList.toggle("is-active", el.getAttribute("data-edit-mode") === String(state.editMode));
      });
      try {
        if (state.editMode) {
          await loadAllPatchnotes();
        } else {
          await loadPatchnotesPage(state.page || readPageFromUrl());
        }
      } catch (err) {
        setStatus(err.message || "불러오기 실패", "error");
      }
      contentSync?.refresh();
    });
  });

  els.pagePrev?.addEventListener("click", () => {
    const page = state.pagination?.page || 1;
    if (page <= 1 || isEditing()) return;
    void loadPatchnotesPage(page - 1).then(() => {
      els.blocks?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  els.pageNext?.addEventListener("click", () => {
    const page = state.pagination?.page || 1;
    const total = state.pagination?.totalPages || 1;
    if (page >= total || isEditing()) return;
    void loadPatchnotesPage(page + 1).then(() => {
      els.blocks?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  els.addBlock?.addEventListener("click", () => openBlockModal());
  els.blockForm?.addEventListener("submit", saveBlockFromForm);
  els.blockDelete?.addEventListener("click", () => deleteBlockById(els.blockId.value.trim()));
  els.blockModal?.querySelector(".patch-modal-cancel")?.addEventListener("click", closeBlockModal);
  els.blockModal?.querySelector(".patch-modal-backdrop")?.addEventListener("click", closeBlockModal);

  els.itemForm?.addEventListener("submit", saveItemFromForm);
  els.itemDelete?.addEventListener("click", deleteItemFromForm);
  els.itemContentImageBtn?.addEventListener("click", () => {
    els.itemContentEditor?.focus();
    els.itemContentImageFile?.click();
  });
  els.itemContentImageFile?.addEventListener("change", () => void handleContentImageFileChange());
  els.itemContentEditor?.addEventListener("paste", (e) => void handleContentEditorPaste(e));
  els.itemContentEditor?.addEventListener("pointerdown", handleContentEditorPointerDown);
  els.itemContentEditor?.addEventListener("keydown", handleContentEditorKeydown);
  els.itemContentEditor?.addEventListener("click", handleContentEditorFigureClick);
  els.itemContentEditor?.addEventListener("dragover", handleContentEditorDragOver);
  els.itemContentEditor?.addEventListener("drop", (e) => void handleContentEditorDrop(e));
  els.imageLightboxBackdrop?.addEventListener("click", closePatchImageLightbox);
  els.imageLightboxClose?.addEventListener("click", closePatchImageLightbox);
  els.imageLightboxPrev?.addEventListener("click", () => setPatchImageLightboxIndex(lightbox.index - 1));
  els.imageLightboxNext?.addEventListener("click", () => setPatchImageLightboxIndex(lightbox.index + 1));
  els.itemModal?.querySelector(".patch-modal-cancel")?.addEventListener("click", closeItemModal);
  els.itemModal?.querySelector(".patch-modal-backdrop")?.addEventListener("click", closeItemModal);

  els.blocks?.addEventListener("click", (e) => {
    const zoom = e.target.closest(".patch-item-image-zoom");
    if (zoom && !isEditing()) {
      e.preventDefault();
      e.stopPropagation();
      const img = zoom.querySelector("img");
      if (img?.src) openPatchImageLightboxFromEl(img);
      return;
    }
    const up = e.target.closest("[data-patch-block-up]");
    if (up) return moveBlock(up.getAttribute("data-patch-block-up"), -1);
    const down = e.target.closest("[data-patch-block-down]");
    if (down) return moveBlock(down.getAttribute("data-patch-block-down"), 1);
    const editBlock = e.target.closest("[data-patch-block-edit]");
    if (editBlock) return openBlockModal(editBlock.getAttribute("data-patch-block-edit"));
    const delBlock = e.target.closest("[data-patch-block-delete]");
    if (delBlock) return void deleteBlockById(delBlock.getAttribute("data-patch-block-delete"));
    const addItem = e.target.closest("[data-patch-item-add]");
    if (addItem) return openItemModal(addItem.getAttribute("data-patch-item-add"));
    const editItem = e.target.closest("[data-patch-item-edit]");
    if (editItem) {
      return openItemModal(
        editItem.getAttribute("data-patch-block-id"),
        editItem.getAttribute("data-patch-item-edit")
      );
    }
  });

  document.addEventListener("keydown", (e) => {
    if (!els.imageLightbox?.classList.contains("hidden")) {
      if (e.key === "Escape") {
        closePatchImageLightbox();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPatchImageLightboxIndex(lightbox.index - 1);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setPatchImageLightboxIndex(lightbox.index + 1);
        return;
      }
    }
    if (e.key !== "Escape") return;
    if (!els.blockModal?.classList.contains("hidden")) closeBlockModal();
    if (!els.itemModal?.classList.contains("hidden")) closeItemModal();
  });
}

async function applyHomeVisualSettings() {
  try {
    const res = await fetch(`${BASE}/api/links`, { credentials: "same-origin" });
    if (!res.ok) {
      applyLinksPageFonts();
      return;
    }
    const data = await res.json();
    applyLinksPageFonts(data.fonts);
    const brand = data.scheduleMeta && data.scheduleMeta.brandColor;
    if (brand) applyBrandTheme(brand);
  } catch {
    applyLinksPageFonts();
  }
}

async function reloadPatchnotesFromServer() {
  if (!state.data || isEditing()) return;
  try {
    await loadPatchnotesPage(state.page || readPageFromUrl());
  } catch {
    /* 다음 주기에 재시도 */
  }
}

async function fetchPatchnotes({ page, all } = {}) {
  const params = new URLSearchParams();
  if (all) params.set("all", "1");
  else {
    params.set("page", String(page || 1));
    params.set("per_page", String(PATCHNOTES_PER_PAGE));
  }
  const res = await fetch(`${BASE}/api/patchnotes?${params}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error("패치노트를 불러오지 못했습니다.");
  return res.json();
}

function cacheDom() {
  els.status = document.getElementById("patchnotes-status");
  els.blocks = document.getElementById("patchnotes-blocks");
  els.addBlock = document.getElementById("patchnotes-add-block");
  els.addBlockWrap = document.getElementById("patchnotes-add-block-wrap");
  els.editModeWrap = document.getElementById("patchnotes-edit-mode-wrap");
  els.auth = document.getElementById("mode-control");
  els.blockModal = document.getElementById("patch-block-modal");
  els.blockModalTitle = document.getElementById("patch-block-modal-title");
  els.blockForm = document.getElementById("patch-block-form");
  els.blockId = document.getElementById("patch-block-id");
  els.blockDate = document.getElementById("patch-block-date");
  els.blockLabel = document.getElementById("patch-block-label");
  els.blockDelete = document.getElementById("patch-block-delete");
  els.itemModal = document.getElementById("patch-item-modal");
  els.itemModalTitle = document.getElementById("patch-item-modal-title");
  els.itemForm = document.getElementById("patch-item-form");
  els.itemId = document.getElementById("patch-item-id");
  els.itemBlockId = document.getElementById("patch-item-block-id");
  els.itemArea = document.getElementById("patch-item-area");
  els.itemText = document.getElementById("patch-item-text");
  els.itemContentEditor = document.getElementById("patch-item-content-editor");
  els.itemContentImageBtn = document.getElementById("patch-item-content-image-btn");
  els.itemContentImageFile = document.getElementById("patch-item-content-image-file");
  els.itemContentStatus = document.getElementById("patch-item-content-status");
  els.imageLightbox = document.getElementById("patch-image-lightbox");
  els.imageLightboxImg = document.getElementById("patch-image-lightbox-img");
  els.imageLightboxClose = document.getElementById("patch-image-lightbox-close");
  els.imageLightboxBackdrop = els.imageLightbox?.querySelector(".patch-image-lightbox-backdrop");
  els.imageLightboxPrev = document.getElementById("patch-image-lightbox-prev");
  els.imageLightboxNext = document.getElementById("patch-image-lightbox-next");
  els.imageLightboxCount = document.getElementById("patch-image-lightbox-count");
  els.itemDelete = document.getElementById("patch-item-delete");
  els.pagination = document.getElementById("patchnotes-pagination");
  els.pagePrev = document.getElementById("patchnotes-page-prev");
  els.pageNext = document.getElementById("patchnotes-page-next");
  els.pageInfo = document.getElementById("patchnotes-page-info");
}

async function init() {
  cacheDom();

  const authErr = consumeAuthErrorFromUrl();
  if (authErr) setStatus(authErr, "error");

  bindEvents();

  try {
    const initPage = readPageFromUrl();
    const [me, config, data] = await Promise.all([
      fetchMe(),
      fetchAuthConfig(),
      fetchPatchnotes({ page: initPage }),
      applyHomeVisualSettings(),
    ]);
    state.me = me;
    state.isDeveloper = me.role === "developer";
    state.data = data;
    state.pagination = data.pagination || null;
    state.page = data.pagination?.page || initPage;
    renderModeControl(els.auth, me, config, {
      onChange: (next) => {
        state.me = next;
        state.isDeveloper = next.role === "developer";
        if (!state.isDeveloper) state.editMode = false;
        renderAll();
      },
    });
    renderAll();
    contentSync = startContentSync({
      resource: "patchnotes",
      shouldSync: () => !isEditing(),
      onUpdate: reloadPatchnotesFromServer,
    });
    startContentSync({
      resource: "links",
      shouldSync: () => true,
      onUpdate: applyHomeVisualSettings,
    });
  } catch (err) {
    setStatus(err.message || "불러오기 실패", "error");
  }
}

void init();
