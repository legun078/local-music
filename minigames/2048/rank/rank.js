import { homePath, hubPath, gamePath, mountBreadcrumb, toast } from "../../js/shell.js";
import { getNickname, setNickname, validateNicknameInput } from "../../js/api.js";
import {
  bindRankNameSubmitGate,
  ensureRankNicknameOrBlock,
  getRankSubmitDisplayName,
  prepareRankNameDialog,
} from "../../js/rank-nickname-gate.js";
import { mount2048Game } from "../../js/games/2048.js?v=5";
import { mount2048AlienStage } from "../../js/games/2048-alien-stage.js?v=2";
import {
  GAME_ID,
  GAME_TITLE,
  describe2048Board,
  getDurationMode,
  normalizeDurationKey,
} from "../../js/games/2048-config.js";
import {
  submit2048RankScore,
} from "../../js/games/2048-leaderboard.js";
import { bind2048ResultDialog, showRankResult, setRankResultLead } from "../../js/games/2048-result.js";
import {
  format2048RankLine,
  format2048Score,
  format2048Timer,
  set2048TimerBar,
  update2048PlayClock,
  tile2048RankHelpHtml,
} from "../../js/games/2048-score.js";
import {
  play2048GameOver,
  mount2048SoundToggle,
  ensure2048Audio,
} from "../../js/games/2048-audio.js";

const params = new URLSearchParams(location.search);
const rankMode = normalizeDurationKey(params.get("mode") || params.get("durationKey"));
const durationMode = getDurationMode(rankMode);
const durationSec = durationMode.sec;

try {
  sessionStorage.setItem("mg_2048_lobby_tab", "rank");
} catch (_) {}

const mountEl = document.getElementById("game-mount");
const rankSub = document.getElementById("rank-sub");
const rankBadges = document.getElementById("rank-badges");
const scoreEl = document.getElementById("rank-score");
const tileEl = document.getElementById("rank-tile");
const movesEl = document.getElementById("rank-moves");
const timerEl = document.getElementById("rank-timer");
const timerBarEl = document.getElementById("rank-timer-bar");
const timerWrap = document.getElementById("rank-timer-wrap");
const scorebarActions = document.getElementById("rank-scorebar-actions");
const nameDialog = document.getElementById("rank-name-dialog");
const nameInput = document.getElementById("rank-display-name");
const nameLead = document.getElementById("rank-name-lead");
const nameForm = document.getElementById("rank-name-form");
const resultUi = bind2048ResultDialog(document.getElementById("result-dialog"));

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

if (rankSub) rankSub.textContent = `${describe2048Board(rankMode)} · TOP 10`;
if (rankBadges) {
  rankBadges.innerHTML = `
    <span class="mg-tag">${durationMode.label}</span>
    <span class="mg-tag">${durationMode.short}</span>
    <span class="mg-tag mg-tag--live">랭킹</span>
  `;
}
if (timerWrap) timerWrap.classList.toggle("hidden", durationSec <= 0);
const timerBarWrap = document.getElementById("rank-timer-bar-wrap");
if (timerBarWrap) timerBarWrap.classList.toggle("hidden", durationSec <= 0);

mount2048SoundToggle(scorebarActions);

const rankHelpMount = document.getElementById("rank-help-mount");
if (rankHelpMount) {
  rankHelpMount.innerHTML = tile2048RankHelpHtml({ durationShort: durationMode.short });
}

const alienStage = mount2048AlienStage(document.getElementById("alien-stage"), { variant: "rank" });

function stopTimer() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}

function elapsedSec() {
  if (durationSec <= 0) return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  return Math.min(durationSec, Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
}

function syncHud(payload) {
  if (scoreEl) scoreEl.textContent = format2048Score(payload.score);
  if (tileEl) tileEl.textContent = String(payload.maxTile || 0);
  if (movesEl) movesEl.textContent = String(payload.moveCount || 0);
}

function showNameDialog(payload) {
  pendingRank = payload;
  nameLead.textContent = `${format2048RankLine(payload)} — ${payload.rank}위! 리더보드에 표시할 이름을 입력하세요.`;
  prepareRankNameDialog(nameInput, nameForm);
  resultUi?.close();
  nameDialog.showModal();
  nameInput.focus();
  nameInput.select();
}

async function tryRegister(payload, displayName) {
  const res = await submit2048RankScore({ ...payload, mode: rankMode, displayName });
  if (res.registered) {
    setRankResultLead(resultUi, `${format2048RankLine(payload)} — ${res.rank}위에 등록되었습니다!`);
    toast(`${format2048RankLine(payload)} — ${res.rank}위에 등록되었습니다`);
  } else if (res.needsName) {
    showNameDialog({ ...payload, rank: res.rank });
  } else if (res.qualifies === false) {
    setRankResultLead(resultUi, `${format2048RankLine(payload)} — TOP 10 안에 들지 못했습니다`);
    toast("TOP 10 안에 들지 못했습니다");
  }
}

async function onRankFinish(payload) {
  if (rankSubmitted) return;
  rankSubmitted = true;

  if (!resultShown) {
    resultShown = true;
    showRankResult(resultUi, payload);
  }

  const body = {
    maxTile: payload.maxTile,
    score: payload.score,
    moveCount: payload.moveCount,
  };

  try {
    const displayName = getRankSubmitDisplayName();
    const res = await submit2048RankScore({
      ...body,
      mode: rankMode,
      ...(displayName ? { displayName } : {}),
    });
    if (res.needsName) {
      setRankResultLead(
        resultUi,
        `${format2048RankLine(payload)} — ${res.rank}위! 리더보드에 표시할 이름을 확인해 주세요.`,
      );
      showNameDialog({ ...body, rank: res.rank });
      return;
    }
    if (res.registered) {
      setRankResultLead(resultUi, `${format2048RankLine(payload)} — ${res.rank}위에 등록되었습니다!`);
      toast(`${format2048RankLine(payload)} — ${res.rank}위에 등록되었습니다`);
      return;
    }
    if (res.qualifies === false) {
      setRankResultLead(resultUi, `${format2048RankLine(payload)} — TOP 10 안에 들지 못했습니다`);
      toast("TOP 10 안에 들지 못했습니다");
      return;
    }
    setRankResultLead(resultUi, "이번 판 결과입니다");
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
      `${format2048RankLine(pendingRank)} — ${pendingRank.rank}위! 이름을 등록하지 않아 리더보드에 올라가지 않았습니다`,
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
  ensure2048Audio();
  game?.destroy?.();
  mountEl.innerHTML = "";
  stopTimer();
  rankSubmitted = false;
  resultShown = false;
  pendingRank = null;
  resultUi?.close();
  alienStage.reset();
  startedAt = Date.now();

  if (durationSec > 0) {
    timerEl.textContent = format2048Timer(durationSec * 1000);
    set2048TimerBar(timerBarEl, 1);
    const endsAt = startedAt + durationSec * 1000;
    const totalMs = durationSec * 1000;
    const tick = () => {
      const left = endsAt - Date.now();
      update2048PlayClock({ timerEl, timerBarEl, leftMs: left, totalMs });
      if (left <= 0) {
        stopTimer();
        game?.finish("time");
      }
    };
    tick();
    timerId = setInterval(tick, 250);
  } else if (timerEl) {
    timerEl.textContent = "무제한";
  }

  game = mount2048Game(mountEl, {
    gameState: { seed: randomSeed() },
    onScore: (payload) => {
      syncHud(payload);
      alienStage.reactToMaxTile(payload.maxTile);
      if (payload.finished) {
        stopTimer();
        play2048GameOver();
        alienStage.onGameEnd(payload.reason === "win" ? "win" : "lose");
        void onRankFinish(payload);
      }
    },
  });
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

tryStartGame();
