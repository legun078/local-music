import { getNickname, setNickname, validateNicknameInput } from "../../js/api.js";
import {
  bindRankNameSubmitGate,
  ensureRankNicknameOrBlock,
  getRankSubmitDisplayName,
  prepareRankNameDialog,
} from "../../js/rank-nickname-gate.js";
import { homePath, hubPath, gamePath, mountBreadcrumb, toast } from "../../js/shell.js";
import { mountAppleGame } from "../../js/games/apple.js?v=19";
import {
  GAME_ID,
  GAME_TITLE,
  describeAppleBoard,
  getDurationMode,
  normalizeDurationKey,
} from "../../js/games/apple-config.js";
import {
  submitAppleRankScore,
  formatAppleRankScore,
} from "../../js/games/apple-leaderboard.js";
import { bindAppleResultDialog, showRankResult, setRankResultLead } from "../../js/games/apple-result.js";
import { formatAppleTimer, setAppleTimerBar, updateApplePlayClock } from "../../js/games/apple-score.js";
import {
  startAppleBgm,
  stopAppleBgm,
  playAppleGameEnd,
  tickAppleTimeWarn,
  resetAppleTimeWarn,
  mountAppleSoundToggle,
  ensureAppleAudio,
} from "../../js/games/apple-audio.js";
import { initMobileLandscapePlay, refreshMobileLandscapeFit } from "../../js/mobile-landscape.js";
import { shouldUsePortraitBoard } from "../../js/mobile-board.js";

const BASE_COLS = 17;
const BASE_ROWS = 10;

const params = new URLSearchParams(location.search);
const rankMode = normalizeDurationKey(params.get("mode") || params.get("durationKey"));
const durationMode = getDurationMode(rankMode);
const durationSec = durationMode.sec;

try {
  sessionStorage.setItem("mg_apple_lobby_tab", "rank");
} catch (_) {}

const mountEl = document.getElementById("game-mount");
const rankSub = document.getElementById("rank-sub");
const rankBadges = document.getElementById("rank-badges");
const scoreEl = document.getElementById("rank-score");
const timerEl = document.getElementById("rank-timer");
const timerBarEl = document.getElementById("rank-timer-bar");
const scorebarActions = document.getElementById("rank-scorebar-actions");
const nameDialog = document.getElementById("rank-name-dialog");
const nameInput = document.getElementById("rank-display-name");
const nameLead = document.getElementById("rank-name-lead");
const nameForm = document.getElementById("rank-name-form");
const resultUi = bindAppleResultDialog(document.getElementById("result-dialog"));

bindRankNameSubmitGate(nameInput, nameForm);

let game = null;
let timerId = null;
let startedAt = 0;
let pendingRank = null;
let rankSubmitted = false;
let resultShown = false;

mountBreadcrumb(document.getElementById("page-nav"), [
  { href: homePath(), label: "홈", home: true },
  { href: hubPath(), label: "미니게임" },
  { href: gamePath(GAME_ID), label: GAME_TITLE },
  { label: "랭킹", current: true },
]);

if (rankSub) rankSub.textContent = `${describeAppleBoard(rankMode)} · 검거 TOP 10`;
if (rankBadges) {
  rankBadges.innerHTML = `
    <span class="mg-tag">${durationMode.label}</span>
    <span class="mg-tag">${durationMode.short}</span>
    <span class="mg-tag mg-tag--live">랭킹</span>
  `;
}

mountAppleSoundToggle(scorebarActions);

function stopTimer() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
  stopAppleBgm();
}

function elapsedSec() {
  return Math.min(durationSec, Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
}

function showNameDialog(payload) {
  pendingRank = payload;
  nameLead.textContent = `${formatAppleRankScore(payload.score)} — ${payload.rank}위! 리더보드에 표시할 이름을 입력하세요.`;
  prepareRankNameDialog(nameInput, nameForm);
  resultUi?.close();
  nameDialog.showModal();
  nameInput.focus();
  nameInput.select();
}

async function tryRegister(payload, displayName) {
  const res = await submitAppleRankScore({ ...payload, mode: rankMode, displayName });
  if (res.registered) {
    setRankResultLead(resultUi, `${formatAppleRankScore(payload.score)} — ${res.rank}위에 등록되었습니다!`);
    toast(`${formatAppleRankScore(payload.score)} — ${res.rank}위에 등록되었습니다`);
  } else if (res.needsName) {
    showNameDialog({ ...payload, rank: res.rank });
  } else if (res.qualifies === false) {
    setRankResultLead(resultUi, `${formatAppleRankScore(payload.score)} — TOP 10 안에 들지 못했습니다`);
    toast("TOP 10 안에 들지 못했습니다");
  }
}

async function onRankFinish({ score, clears, reason }) {
  if (rankSubmitted) return;
  rankSubmitted = true;

  if (!resultShown) {
    resultShown = true;
    showRankResult(resultUi, { score, clears, reason: reason || "time" });
  }

  const payload = { score, elapsedSec: elapsedSec() };
  try {
    const displayName = getRankSubmitDisplayName();
    const res = await submitAppleRankScore({
      ...payload,
      mode: rankMode,
      ...(displayName ? { displayName } : {}),
    });
    if (res.needsName) {
      setRankResultLead(
        resultUi,
        `${formatAppleRankScore(payload.score)} — ${res.rank}위! 리더보드에 표시할 이름을 확인해 주세요.`,
      );
      showNameDialog({ ...payload, rank: res.rank });
      return;
    }
    if (res.registered) {
      setRankResultLead(resultUi, `${formatAppleRankScore(payload.score)} — ${res.rank}위에 등록되었습니다!`);
      toast(`${formatAppleRankScore(payload.score)} — ${res.rank}위에 등록되었습니다`);
      return;
    }
    if (res.qualifies === false) {
      setRankResultLead(resultUi, `${formatAppleRankScore(payload.score)} — TOP 10 안에 들지 못했습니다`);
      toast("TOP 10 안에 들지 못했습니다");
      return;
    }
    setRankResultLead(resultUi, "이번 판 검거 결과입니다");
  } catch (e) {
    setRankResultLead(resultUi, e.message || "기록 등록에 실패했습니다");
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
    resultUi?.show();
  } catch (err) {
    toast(err.message || "등록 실패");
  }
});

document.getElementById("rank-name-skip")?.addEventListener("click", () => {
  if (pendingRank) {
    setRankResultLead(
      resultUi,
      `${formatAppleRankScore(pendingRank.score)} — ${pendingRank.rank}위! 이름을 등록하지 않아 리더보드에 올라가지 않았습니다`,
    );
    resultUi?.show();
  }
  pendingRank = null;
  nameDialog.close();
});

function randomSeed() {
  return Math.floor(Math.random() * 0xffffffff);
}

function startGame() {
  ensureAppleAudio();
  game?.destroy?.();
  mountEl.innerHTML = "";
  stopTimer();
  rankSubmitted = false;
  resultShown = false;
  pendingRank = null;
  resultUi?.close();
  startedAt = Date.now();

  timerEl.textContent = formatAppleTimer(durationSec * 1000);
  setAppleTimerBar(timerBarEl, 1);

  resetAppleTimeWarn();
  startAppleBgm();
  const endsAt = startedAt + durationSec * 1000;
  const totalMs = durationSec * 1000;
  const tick = () => {
    const left = endsAt - Date.now();
    updateApplePlayClock({ timerEl, timerBarEl, leftMs: left, totalMs });
    tickAppleTimeWarn(left);
    if (left <= 0) {
      stopTimer();
      game?.finish();
    }
  };
  tick();
  timerId = setInterval(tick, 250);

  game = mountAppleGame(mountEl, {
    gameState: { seed: randomSeed(), cols: 17, rows: 10 },
    onScore: ({ score, clears, finished, reason }) => {
      scoreEl.textContent = String(score);
      if (finished) {
        stopTimer();
        playAppleGameEnd();
        void onRankFinish({ score, clears, reason });
      }
    },
  });
  refreshMobileLandscapeFit();
}

function tryStartGame() {
  ensureRankNicknameOrBlock({
    mountEl,
    lobbyHref: "../?tab=rank",
    onReady: startGame,
  });
}

document.getElementById("result-retry-btn")?.addEventListener("click", () => {
  resultUi?.close();
  tryStartGame();
});

document.getElementById("result-lobby-btn")?.addEventListener("click", () => {
  location.href = "../?tab=rank";
});

initMobileLandscapePlay();
let portraitBoardOn = shouldUsePortraitBoard(BASE_COLS, BASE_ROWS);
window.addEventListener("mg-mobile-landscape-sync", () => {
  const next = shouldUsePortraitBoard(BASE_COLS, BASE_ROWS);
  if (next !== portraitBoardOn) {
    portraitBoardOn = next;
    tryStartGame();
  }
});
tryStartGame();
