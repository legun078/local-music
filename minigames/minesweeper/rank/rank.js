import { getNickname, setNickname, validateNicknameInput } from "../../js/api.js";
import {
  bindRankNameSubmitGate,
  ensureRankNicknameOrBlock,
  getRankSubmitDisplayName,
  prepareRankNameDialog,
} from "../../js/rank-nickname-gate.js";
import { homePath, hubPath, gamePath, mountBreadcrumb, toast } from "../../js/shell.js";
import { mountMinesweeper } from "../../js/games/minesweeper.js";
import { getRankTier, normalizeRankTier, describeBoard, GAME_TITLE } from "../../js/games/minesweeper-config.js";
import {
  submitRankScore,
  formatRankTime,
} from "../../js/games/minesweeper-leaderboard.js";
import { initMobileLandscapePlay, refreshMobileLandscapeFit } from "../../js/mobile-landscape.js";
import { shouldUsePortraitBoard } from "../../js/mobile-board.js";

const params = new URLSearchParams(location.search);
const rankTier = normalizeRankTier(params.get("tier"));
const rankCfg = getRankTier(rankTier);
try {
  sessionStorage.setItem("mg_ms_lobby_tab", "rank");
} catch (_) {}

function syncWideBoardClass() {
  const wide =
    (rankCfg.cols >= 20 || rankCfg.cols > rankCfg.rows) &&
    !shouldUsePortraitBoard(rankCfg.cols, rankCfg.rows);
  document.body.classList.toggle("mg-page--wide-board", wide);
}

syncWideBoardClass();

const mountEl = document.getElementById("game-mount");
const rankSub = document.getElementById("rank-sub");
const rankBadges = document.getElementById("rank-badges");
const nameDialog = document.getElementById("rank-name-dialog");
const nameInput = document.getElementById("rank-display-name");
const nameLead = document.getElementById("rank-name-lead");
const nameForm = document.getElementById("rank-name-form");

bindRankNameSubmitGate(nameInput, nameForm);

let cleanup = null;
let pendingRank = null;

mountBreadcrumb(document.getElementById("page-nav"), [
  { href: homePath(), label: "홈", home: true },
  { href: hubPath(), label: "미니게임" },
  { href: gamePath("minesweeper"), label: GAME_TITLE },
  { label: "랭킹", current: true },
]);

if (rankSub) {
  rankSub.textContent = `${describeBoard(rankCfg)} · 클리어 기록 TOP 10`;
}
if (rankBadges) {
  rankBadges.innerHTML = `
    <span class="mg-tag">${rankCfg.tierLabel}</span>
    <span class="mg-tag mg-tag--live">랭킹</span>
  `;
}

function randomSeed() {
  return Math.floor(Math.random() * 0xffffffff);
}

function showNameDialog(payload) {
  pendingRank = payload;
  nameLead.textContent = `${formatRankTime(payload.elapsedSec)} — ${payload.rank}위! 리더보드에 표시할 이름을 입력하세요.`;
  prepareRankNameDialog(nameInput, nameForm);
  nameDialog.showModal();
  nameInput.focus();
  nameInput.select();
}

async function tryRegister(payload, displayName) {
  const res = await submitRankScore({ ...payload, tier: rankTier, displayName });
  if (res.registered) {
    toast(`${formatRankTime(payload.elapsedSec)} — ${res.rank}위에 등록되었습니다`);
  } else if (res.needsName) {
    showNameDialog({ ...payload, rank: res.rank });
  } else if (res.qualifies === false) {
    toast("TOP 10 안에 들지 못했습니다");
  }
}

async function onRankFinish({ score, won, breakdown }) {
  if (!won || !breakdown) return;
  const payload = {
    score,
    elapsedSec: breakdown.elapsedSec,
    revealed: breakdown.revealed,
    won: true,
  };
  try {
    const displayName = getRankSubmitDisplayName();
    const res = await submitRankScore({
      ...payload,
      tier: rankTier,
      ...(displayName ? { displayName } : {}),
    });
    if (res.registered) {
      toast(`${formatRankTime(payload.elapsedSec)} — ${res.rank}위에 등록되었습니다`);
      return;
    }
    if (res.needsName) {
      showNameDialog({ ...payload, rank: res.rank });
      return;
    }
    if (res.qualifies === false) {
      toast("TOP 10 안에 들지 못했습니다");
    }
  } catch (e) {
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
  pendingRank = null;
  nameDialog.close();
});

function startGame() {
  if (cleanup) cleanup();
  mountEl.innerHTML = "";
  pendingRank = null;

  mountMinesweeper(mountEl, {
    rankMode: true,
    gameState: {
      seed: randomSeed(),
      rows: rankCfg.rows,
      cols: rankCfg.cols,
      mines: rankCfg.mines,
    },
    onRetry: startGame,
    onScore: ({ finished, won, score, breakdown }) => {
      if (finished) onRankFinish({ score, won, breakdown });
    },
  });
  cleanup = mountEl._cleanup;
  refreshMobileLandscapeFit();
}

function tryStartGame() {
  ensureRankNicknameOrBlock({
    mountEl,
    lobbyHref: "../?tab=rank",
    onReady: startGame,
  });
}

initMobileLandscapePlay();
let portraitBoardOn = shouldUsePortraitBoard(rankCfg.cols, rankCfg.rows);
window.addEventListener("mg-mobile-landscape-sync", () => {
  const next = shouldUsePortraitBoard(rankCfg.cols, rankCfg.rows);
  if (next !== portraitBoardOn) {
    portraitBoardOn = next;
    syncWideBoardClass();
    tryStartGame();
  }
});
tryStartGame();
