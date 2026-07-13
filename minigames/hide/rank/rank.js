import { getNickname, setNickname, validateNicknameInput } from "../../js/api.js";
import {
  bindRankNameSubmitGate,
  ensureRankNicknameOrBlock,
  getRankSubmitDisplayName,
  prepareRankNameDialog,
} from "../../js/rank-nickname-gate.js";
import { homePath, hubPath, gamePath, mountBreadcrumb, toast } from "../../js/shell.js";
import { mountHideGame } from "../../js/games/hide-game.js?v=3";
import {
  GAME_ID,
  GAME_TITLE,
  fmtHideScore,
  normalizeHideMode,
  getHideMode,
  getHideRoomMode,
  isHideRankMode,
} from "../../js/games/hide-config.js";
import { submitHideRankScore, formatHideRankScore } from "../../js/games/hide-leaderboard.js";
import { mountHideSoloReview } from "../../js/games/hide-result.js";

try {
  sessionStorage.setItem("mg_hide_lobby_tab", "rank");
} catch (_) {}

const params = new URLSearchParams(location.search);
let rankMode = normalizeHideMode(params.get("mode"));
if (!isHideRankMode(rankMode)) rankMode = "standard";
const modeSpec = getHideMode(rankMode);
const roomModeSpec = getHideRoomMode(rankMode);

const mountEl = document.getElementById("game-mount");
const gamePanel = document.getElementById("game-panel");
const reviewPanel = document.getElementById("review-panel");
const reviewMount = document.getElementById("review-mount");
const rankSub = document.getElementById("rank-sub");
const rankBadges = document.getElementById("rank-badges");
const rankNote = document.querySelector(".mg-rank-play-note");
const resultLeadEl = document.getElementById("result-lead");
const nameDialog = document.getElementById("rank-name-dialog");
const nameInput = document.getElementById("rank-display-name");
const nameLead = document.getElementById("rank-name-lead");
const nameForm = document.getElementById("rank-name-form");

bindRankNameSubmitGate(nameInput, nameForm);

let game = null;
let pendingRank = null;
let rankSubmitted = false;

mountBreadcrumb(document.getElementById("page-nav"), [
  { href: homePath(), label: "홈", home: true },
  { href: hubPath(), label: "미니게임" },
  { href: gamePath(GAME_ID), label: GAME_TITLE },
  { label: "랭킹", current: true },
]);

if (rankSub) rankSub.textContent = `${modeSpec.label} · ${modeSpec.detail} · TOP 10`;
if (rankBadges) {
  rankBadges.innerHTML = `
    <span class="mg-tag">5색</span>
    <span class="mg-tag">${roomModeSpec.label}</span>
    <span class="mg-tag">${roomModeSpec.short}</span>
    <span class="mg-tag mg-tag--live">랭킹</span>
  `;
}
if (rankNote) {
  rankNote.textContent =
    rankMode === "speed"
      ? "3초 기억 · 5초 안 색 선택 · 5색 합산 점수 TOP 10"
      : "5색 합산 점수가 높을수록 상위 · TOP 10 등록";
}

function setResultLead(text) {
  if (!resultLeadEl) return;
  if (text) {
    resultLeadEl.textContent = text;
    resultLeadEl.classList.remove("hidden");
  } else {
    resultLeadEl.textContent = "";
    resultLeadEl.classList.add("hidden");
  }
}

function showReview({ score, hideRounds }) {
  game?.destroy?.();
  game = null;
  gamePanel?.classList.add("hidden");
  reviewPanel?.classList.remove("hidden");
  document.body.classList.add("mg-in-review");
  mountHideSoloReview(reviewMount, { score, hideRounds });
  if (rankSub) rankSub.textContent = `총 ${fmtHideScore(score)}점 · ${modeSpec.detail}`;
}

function showNameDialog(payload) {
  pendingRank = payload;
  nameLead.textContent = `${formatHideRankScore(payload.score)} — ${payload.rank}위! 리더보드에 표시할 이름을 입력하세요.`;
  prepareRankNameDialog(nameInput, nameForm);
  nameDialog.showModal();
  nameInput.focus();
  nameInput.select();
}

async function tryRegister(payload, displayName) {
  const res = await submitHideRankScore({ ...payload, mode: rankMode, displayName });
  if (res.registered) {
    setResultLead(`${formatHideRankScore(payload.score)} — ${res.rank}위에 등록되었습니다!`);
    toast(`${formatHideRankScore(payload.score)} — ${res.rank}위에 등록되었습니다`);
  } else if (res.needsName) {
    showNameDialog({ ...payload, rank: res.rank });
  } else if (res.qualifies === false) {
    setResultLead(`${formatHideRankScore(payload.score)} — TOP 10 안에 들지 못했습니다`);
    toast("TOP 10 안에 들지 못했습니다");
  }
}

async function onRankFinish({ score, hideRounds }) {
  if (rankSubmitted) return;
  rankSubmitted = true;
  showReview({ score, hideRounds });
  setResultLead("리더보드 등록 확인 중…");

  const payload = { score, mode: rankMode };
  const displayName = getRankSubmitDisplayName();
  try {
    const res = await submitHideRankScore({
      ...payload,
      ...(displayName ? { displayName } : {}),
    });
    if (res.needsName) {
      setResultLead(`${formatHideRankScore(payload.score)} — ${res.rank}위! 리더보드에 표시할 이름을 확인해 주세요.`);
      showNameDialog({ ...payload, rank: res.rank });
      return;
    }
    if (res.registered) {
      setResultLead(`${formatHideRankScore(payload.score)} — ${res.rank}위에 등록되었습니다!`);
      toast(`${formatHideRankScore(payload.score)} — ${res.rank}위에 등록되었습니다`);
      return;
    }
    if (res.qualifies === false) {
      setResultLead(`${formatHideRankScore(payload.score)} — TOP 10 안에 들지 못했습니다`);
      toast("TOP 10 안에 들지 못했습니다");
      return;
    }
    setResultLead("");
  } catch (e) {
    setResultLead(e.message || "기록 등록에 실패했습니다");
    toast(e.message || "기록 등록 실패");
  }
}

nameForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!pendingRank) {
    nameDialog.close();
    return;
  }
  const check = validateNicknameInput(nameInput.value);
  if (!check.ok) {
    toast(check.message);
    nameInput.focus();
    return;
  }
  const name = check.value;
  try {
    await tryRegister(pendingRank, name);
    setNickname(name);
    pendingRank = null;
    nameDialog.close();
  } catch (err) {
    toast(err.message || "등록 실패");
  }
});

document.getElementById("rank-name-skip")?.addEventListener("click", () => {
  if (pendingRank) {
    setResultLead(`${formatHideRankScore(pendingRank.score)} — ${pendingRank.rank}위! 이름을 등록하지 않아 리더보드에 올라가지 않았습니다`);
  }
  pendingRank = null;
  nameDialog.close();
});

function startGame() {
  game?.destroy?.();
  rankSubmitted = false;
  pendingRank = null;
  nameDialog?.close();
  gamePanel?.classList.remove("hidden");
  reviewPanel?.classList.add("hidden");
  document.body.classList.remove("mg-in-review");
  if (reviewMount) reviewMount.innerHTML = "";
  setResultLead("");
  if (rankSub) rankSub.textContent = `${modeSpec.label} · ${modeSpec.detail} · TOP 10`;

  game = mountHideGame(mountEl, {
    mode: rankMode,
    onScore: (payload) => {
      if (payload.finished) void onRankFinish(payload);
    },
  });
}

function tryStartGame() {
  ensureRankNicknameOrBlock({
    mountEl,
    lobbyHref: `${gamePath(GAME_ID)}?tab=rank`,
    onReady: startGame,
  });
}

document.getElementById("result-retry-btn")?.addEventListener("click", () => {
  tryStartGame();
});

document.getElementById("result-lobby-btn")?.addEventListener("click", () => {
  location.href = `${gamePath(GAME_ID)}?tab=rank`;
});

tryStartGame();
