import { apiUrl } from "./common.js";
import { isNicknameAllowed, NICKNAME_REJECT_MESSAGE } from "./nickname-filter.js";

const TOKEN_KEY = "mg_player_token";
const NICK_KEY = "mg_nickname";

export const NICKNAME_TAKEN_MESSAGE = "이미 사용 중인 닉네임입니다.";

let accountLoggedIn = false;
let nicknameCheckTimer = 0;
let nicknameCheckSeq = 0;

const NICK_ADJ = [
  "귀여운", "화난", "졸린", "용감한", "수상한", "배고픈", "행복한", "우울한",
  "빠른", "느긋한", "까칠한", "엉뚱한", "조용한", "시끄러운", "똑똑한", "엉망인",
];

const NICK_ANIMAL = [
  "고양이", "강아지", "토끼", "여우", "곰", "펭귄", "다람쥐", "판다",
  "사자", "호랑이", "수달", "부엉이", "참새", "돌고래", "코알라", "햄스터",
];

export function isAccountLoggedIn() {
  return accountLoggedIn;
}

export function defaultRoomLabel(nickname = "") {
  const nick = (nickname || "").trim() || "플레이어";
  return `${nick}의 게임`;
}

export function randomNickname() {
  const adj = NICK_ADJ[Math.floor(Math.random() * NICK_ADJ.length)];
  const animal = NICK_ANIMAL[Math.floor(Math.random() * NICK_ANIMAL.length)];
  return `${adj} ${animal}`;
}

export function ensureNickname() {
  let nick = getNickname();
  if (!nick) {
    nick = randomNickname();
    setNickname(nick);
  }
  return nick;
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getNickname() {
  return localStorage.getItem(NICK_KEY) || "";
}

export function validateNicknameInput(name) {
  const n = String(name || "").trim().slice(0, 20);
  if (!n) return { ok: false, message: "닉네임을 입력해 주세요" };
  if (!isNicknameAllowed(n)) return { ok: false, message: NICKNAME_REJECT_MESSAGE };
  return { ok: true, value: n };
}

/** @returns {"empty"|"valid"|"invalid"|"taken"|"checking"} */
export function nicknameInputState(value, { reserved = false, checking = false } = {}) {
  const n = String(value || "").trim().slice(0, 20);
  if (!n) return "empty";
  if (!isNicknameAllowed(n)) return "invalid";
  if (checking) return "checking";
  if (reserved) return "taken";
  return "valid";
}

export function isNicknameUsable(value, opts = {}) {
  return nicknameInputState(value, opts) === "valid";
}

/** @param {HTMLInputElement | null} input @param {{ reserved?: boolean, checking?: boolean }} [opts] */
export function applyNicknameFieldState(input, { reserved = false, checking = false } = {}) {
  if (!input) return nicknameInputState("");
  const state = nicknameInputState(input.value, { reserved, checking });
  input.classList.remove("is-nick-valid", "is-nick-invalid", "is-nick-taken", "is-nick-checking");
  if (state === "valid") input.classList.add("is-nick-valid");
  else if (state === "invalid") input.classList.add("is-nick-invalid");
  else if (state === "taken") input.classList.add("is-nick-taken");
  else if (state === "checking") input.classList.add("is-nick-checking");
  if (state === "invalid" || state === "taken") input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
  return state;
}

/** @param {HTMLInputElement | null} input @param {{ onChange?: (state: string) => void }} [opts] */
export function bindNicknameValidation(input, { onChange } = {}) {
  if (!input) return;
  let reserved = false;
  let checking = false;

  const sync = () => {
    const state = applyNicknameFieldState(input, { reserved, checking });
    onChange?.(state);
  };

  const scheduleCheck = () => {
    const check = validateNicknameInput(input.value);
    if (!check.ok) {
      reserved = false;
      checking = false;
      sync();
      return;
    }
    checking = true;
    reserved = false;
    sync();
    const seq = ++nicknameCheckSeq;
    clearTimeout(nicknameCheckTimer);
    nicknameCheckTimer = window.setTimeout(async () => {
      try {
        const res = await checkNicknameAvailability(check.value);
        if (seq !== nicknameCheckSeq) return;
        reserved = !res.available;
        checking = false;
        sync();
      } catch (_) {
        if (seq !== nicknameCheckSeq) return;
        checking = false;
        sync();
      }
    }, 280);
  };

  input.addEventListener("input", scheduleCheck);
  input.addEventListener("change", scheduleCheck);
  scheduleCheck();
}

export function setNickname(name) {
  const n = String(name || "").trim().slice(0, 20);
  if (n) localStorage.setItem(NICK_KEY, n);
  else localStorage.removeItem(NICK_KEY);
  return n;
}

let saveNickTimer = 0;

async function saveAccountNicknameIfLoggedIn(name) {
  if (!accountLoggedIn) return;
  const check = validateNicknameInput(name);
  if (!check.ok) return;
  try {
    await api("/api/player/nickname", { method: "PUT", body: { nickname: check.value } });
  } catch (_) {
    /* 방·랭킹 요청 시 서버가 다시 검증 */
  }
}

/** 닉네임 입력란 — localStorage 저장 + (로그인 시) 서버 등록 */
export function bindNicknameField(input, { onChange, onStateChange } = {}) {
  if (!input) return;
  const save = () => {
    const n = setNickname(input.value);
    onChange?.(n);
    clearTimeout(saveNickTimer);
    saveNickTimer = window.setTimeout(() => {
      void saveAccountNicknameIfLoggedIn(n);
    }, 500);
  };
  input.addEventListener("input", save);
  input.addEventListener("change", save);
  bindNicknameValidation(input, { onChange: onStateChange });
}

export async function checkNicknameAvailability(name) {
  const check = validateNicknameInput(name);
  if (!check.ok) {
    return { available: false, reason: "invalid", message: check.message };
  }
  const params = new URLSearchParams({ q: check.value });
  const res = await fetch(apiUrl(`/api/player/nickname/check?${params}`), {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  return res.json().catch(() => ({ available: true }));
}

/** 로그인 계정에 저장된 닉네임을 불러옵니다. */
export async function syncAccountNickname() {
  try {
    const data = await api("/api/player/nickname");
    accountLoggedIn = Boolean(data.loggedIn);
    if (data.loggedIn && data.nickname) {
      setNickname(data.nickname);
      return data.nickname;
    }
    return getNickname();
  } catch (_) {
    accountLoggedIn = false;
    return getNickname();
  }
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}), Accept: "application/json" };
  if (!headers["Content-Type"] && options.body) {
    headers["Content-Type"] = "application/json";
  }
  const token = getToken();
  if (token) headers["X-Player-Token"] = token;

  const res = await fetch(apiUrl(path), {
    ...options,
    headers,
    credentials: "same-origin",
    body: options.body != null ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.code = data.error || "http_error";
    err.data = data;
    throw err;
  }
  if (data.playerToken) setToken(data.playerToken);
  return data;
}

export function roomPath(roomId, game = "minesweeper") {
  const base = window.MINIGAMES_BASE || "";
  return `${base}/${game}/room/?id=${encodeURIComponent(roomId)}`;
}

export function joinLink(roomId, code, game = "minesweeper") {
  return roomShareLink(roomId, game, { visibility: code ? "private" : "public", code });
}

/** 공개방: 방 URL · 비밀방: 로비 참가 링크(코드 포함) */
export function roomShareLink(roomId, game = "minesweeper", { visibility = "public", code = "" } = {}) {
  const base = window.MINIGAMES_BASE || "";
  const origin = location.origin;
  if (visibility === "private" && code) {
    const q = new URLSearchParams();
    if (roomId) q.set("id", roomId);
    q.set("code", code);
    return `${origin}${base}/${game}/?${q}`;
  }
  return `${origin}${base}/${game}/room/?id=${encodeURIComponent(roomId)}`;
}
