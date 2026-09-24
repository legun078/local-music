import {
  getNickname,
  validateNicknameInput,
  bindNicknameValidation,
  applyNicknameFieldState,
} from "./api.js";
import { escapeHtml } from "./shell.js";

/** @param {HTMLElement | null} input @param {HTMLFormElement | null} form */
export function syncRankNameSubmitGate(input, form) {
  const submit = form?.querySelector('[type="submit"]');
  const state = applyNicknameFieldState(input);
  if (submit) submit.disabled = state !== "valid";
  return state;
}

/** @param {HTMLElement | null} input @param {HTMLFormElement | null} form */
export function bindRankNameSubmitGate(input, form) {
  const submit = form?.querySelector('[type="submit"]');
  bindNicknameValidation(input, {
    onChange: (state) => {
      if (submit) submit.disabled = state !== "valid";
    },
  });
  syncRankNameSubmitGate(input, form);
}

/** 로비에서 확인한 닉네임을 첫 등록 요청에 함께 보냅니다. */
export function getRankSubmitDisplayName() {
  const check = validateNicknameInput(getNickname());
  return check.ok ? check.value : "";
}

/** 이름 확인 다이얼로그를 열기 전에 입력값·등록 버튼 상태를 맞춥니다. */
export function prepareRankNameDialog(input, form, { value = "" } = {}) {
  if (!input) return "empty";
  input.value = value || getNickname().trim();
  return syncRankNameSubmitGate(input, form);
}

/**
 * @param {{ mountEl?: HTMLElement | null, lobbyHref?: string, onReady: () => void }} opts
 * @returns {boolean}
 */
export function ensureRankNicknameOrBlock({ mountEl, lobbyHref = "../?tab=rank", onReady }) {
  const check = validateNicknameInput(getNickname());
  if (check.ok) {
    onReady();
    return true;
  }
  if (mountEl) {
    mountEl.innerHTML = `
      <div class="mg-rank-nick-block panel">
        <p class="mg-rank-nick-block-title">랭킹을 시작할 수 없어요</p>
        <p class="mg-rank-nick-block-lead">${escapeHtml(check.message)}</p>
        <a class="btn btn-primary" href="${escapeHtml(lobbyHref)}">로비에서 닉네임 수정</a>
      </div>`;
  }
  return false;
}
