import { api, setNickname, getNickname, bindNicknameField, defaultRoomLabel, roomPath, validateNicknameInput, isNicknameUsable, applyNicknameFieldState, syncAccountNickname, saveAccountNickname, isAccountLoggedIn, isAccountNicknameSaved, getAccountSavedNickname, NICKNAME_TAKEN_MESSAGE } from "./api.js";
import { mountSiteAuthBar } from "./auth.js";
import { connectLobbyEvents } from "./room-client.js";
import { homePath, hubPath, mountBreadcrumb, escapeHtml, toast, consumeFlashToast } from "./shell.js";

const LOBBY_TABS = new Set(["solo", "rank", "join", "create"]);

/**
 * @typedef {object} GameLobbyConfig
 * @property {string} gameId
 * @property {string} gameTitle
 * @property {string} tabStorageKey
 * @property {(root: HTMLElement) => void} mountSolo
 * @property {() => void} onSoloStart
 * @property {(root: HTMLElement) => Promise<void>} loadRank
 * @property {(room: object) => string[]} roomTags
 * @property {() => Record<string, unknown>} [createRoomExtra]
 * @property {(rooms: object[]) => object[]} [filterPublicRooms]
 */

/** @param {GameLobbyConfig} config */
export function mountGameLobby(config) {
  const params = new URLSearchParams(location.search);
  let visibility = "public";

  const nickEl = document.getElementById("nickname");
  const roomsEl = document.getElementById("public-rooms");
  const roomsEmpty = document.getElementById("rooms-empty");
  const roomCount = document.getElementById("room-count");
  const authBar = document.getElementById("auth-bar");
  const panels = {
    solo: document.getElementById("solo-panel"),
    rank: document.getElementById("rank-panel"),
    join: document.getElementById("join-panel"),
    create: document.getElementById("create-panel"),
  };
  const tabs = {
    solo: document.getElementById("tab-solo"),
    rank: document.getElementById("tab-rank"),
    join: document.getElementById("tab-join"),
    create: document.getElementById("tab-create"),
  };
  const lobbyLeaderboard = document.getElementById("lobby-leaderboard");
  const roomLabelEl = document.getElementById("room-label");
  let roomLabelTouched = false;
  let rankLeaderboardMounted = false;
  let nickSaveBtn = null;
  let nickSaveHint = null;

  function mountNicknameSaveUi() {
    const wrap = nickEl?.closest(".mg-lobby-nick");
    if (!wrap || document.getElementById("nickname-save-btn")) return;
    const row = document.createElement("div");
    row.className = "mg-lobby-nick-actions hidden";
    row.id = "nickname-save-row";
    row.innerHTML = `
      <button type="button" class="btn btn-primary btn-sm" id="nickname-save-btn" disabled>닉네임 저장</button>
      <p class="mg-field-hint" id="nickname-save-hint">로그인 계정에 등록하면 다른 사람이 같은 닉네임을 쓸 수 없어요.</p>`;
    wrap.appendChild(row);
    nickSaveBtn = document.getElementById("nickname-save-btn");
    nickSaveHint = document.getElementById("nickname-save-hint");
    nickSaveBtn?.addEventListener("click", () => void handleNicknameSave());
  }

  function syncNicknameSaveUi() {
    const row = document.getElementById("nickname-save-row");
    if (!row) return;
    row.classList.toggle("hidden", !isAccountLoggedIn());
    if (!isAccountLoggedIn() || !nickSaveBtn) return;
    const check = validateNicknameInput(nickEl?.value);
    const taken = nickEl?.classList.contains("is-nick-taken");
    const checking = nickEl?.classList.contains("is-nick-checking");
    const saved = isAccountNicknameSaved(nickEl?.value);
    nickSaveBtn.disabled = !check.ok || taken || checking || saved;
    nickSaveBtn.textContent = saved ? "저장됨" : "닉네임 저장";
    if (nickSaveHint) {
      nickSaveHint.textContent = saved
        ? `등록된 닉네임: ${getAccountSavedNickname()}`
        : "저장 버튼을 눌러야 멀티·랭킹에 사용할 수 있어요.";
    }
  }

  async function handleNicknameSave() {
    if (!nickSaveBtn) return;
    nickSaveBtn.disabled = true;
    try {
      const saved = await saveAccountNickname(nickEl?.value);
      nickEl.value = saved;
      setNickname(saved);
      toast(`「${saved}」 닉네임을 저장했습니다`);
    } catch (e) {
      toast(e.message || "닉네임 저장에 실패했습니다");
    } finally {
      applyNicknameFieldState(nickEl);
      syncNicknameGate();
      syncNicknameSaveUi();
    }
  }

  mountNicknameSaveUi();

  mountBreadcrumb(document.getElementById("page-nav"), [
    { href: homePath(), label: "홈", home: true },
    { href: hubPath(), label: "미니게임" },
    { label: config.gameTitle, current: true },
  ]);

  nickEl.value = getNickname().trim();
  bindNicknameField(nickEl, {
    onChange: () => {
      if (!roomLabelTouched) suggestRoomLabel();
    },
    onStateChange: () => syncNicknameGate(),
  });

  function syncNicknameGate() {
    const state = nickEl?.classList.contains("is-nick-taken") ? "taken" : isNicknameUsable(nickEl?.value) ? "valid" : "invalid";
    const usable = state === "valid" && (!isAccountLoggedIn() || isAccountNicknameSaved(nickEl?.value));
    document.getElementById("create-btn")?.toggleAttribute("disabled", !usable);
    document.getElementById("join-code-btn")?.toggleAttribute("disabled", !usable);
    syncNicknameSaveUi();
  }

  lobbyLeaderboard?.addEventListener("click", (e) => {
    const link = e.target.closest("a.mg-lb-tier-cta");
    if (!link || !lobbyLeaderboard.contains(link)) return;
    if (!isNicknameUsable(nickEl?.value) || (isAccountLoggedIn() && !isAccountNicknameSaved(nickEl?.value))) {
      e.preventDefault();
      requireNickname();
    }
  });
  syncNicknameGate();

  function normalizeLobbyTab(mode) {
    const value = String(mode || "").trim();
    return LOBBY_TABS.has(value) ? value : "rank";
  }

  function setLobbyMode(mode) {
    mode = normalizeLobbyTab(mode);
    for (const [key, panel] of Object.entries(panels)) {
      panel?.classList.toggle("hidden", key !== mode);
    }
    for (const [key, tab] of Object.entries(tabs)) {
      const on = key === mode;
      tab?.classList.toggle("is-on", on);
      tab?.setAttribute("aria-selected", String(on));
    }
    try {
      sessionStorage.setItem(config.tabStorageKey, mode);
    } catch (_) {}
    if (mode === "rank" && lobbyLeaderboard) {
      if (!rankLeaderboardMounted) {
        rankLeaderboardMounted = true;
        void config.loadRank(lobbyLeaderboard);
      }
    }
  }

  tabs.solo?.addEventListener("click", () => setLobbyMode("solo"));
  tabs.rank?.addEventListener("click", () => setLobbyMode("rank"));
  tabs.join?.addEventListener("click", () => setLobbyMode("join"));
  tabs.create?.addEventListener("click", () => {
    if (!roomLabelTouched) suggestRoomLabel();
    setLobbyMode("create");
  });

  function setupVisCards() {
    const group = document.getElementById("vis-group");
    group?.querySelectorAll(".mg-vis-card").forEach((btn) => {
      btn.addEventListener("click", () => {
        group.querySelectorAll(".mg-vis-card").forEach((b) => b.classList.remove("is-on"));
        btn.classList.add("is-on");
        visibility = btn.dataset.value || "public";
      });
    });
  }

  setupVisCards();
  config.mountSolo(document.getElementById("solo-panel"));

  function suggestRoomLabel() {
    if (!roomLabelEl || roomLabelTouched) return;
    roomLabelEl.value = defaultRoomLabel(nickEl.value);
  }

  roomLabelEl?.addEventListener("input", () => {
    roomLabelTouched = roomLabelEl.value.trim().length > 0;
  });

  document.getElementById("room-label-shuffle")?.addEventListener("click", () => {
    roomLabelTouched = false;
    suggestRoomLabel();
  });

  suggestRoomLabel();

  async function initAuth() {
    const savedNick = await syncAccountNickname();
    if (savedNick) nickEl.value = savedNick;
    const me = await mountSiteAuthBar(authBar);
    if (me?.loggedIn && !nickEl.value) {
      nickEl.value = me.name || "";
      if (nickEl.value) setNickname(nickEl.value);
    }
    applyNicknameFieldState(nickEl);
    syncNicknameGate();
    syncNicknameSaveUi();
  }

  function rememberPlayer(playerId) {
    if (playerId) localStorage.setItem("mg_player_id", playerId);
  }

  function renderRooms(rooms) {
    let list = (rooms || []).filter((room) => room.game === config.gameId);
    if (config.filterPublicRooms) list = config.filterPublicRooms(list);
    roomCount.textContent = String(list.length);
    roomsEl.innerHTML = "";
    roomsEmpty.classList.toggle("hidden", list.length > 0);
    list.forEach((room) => {
      const playing = room.status === "playing";
      const countLabel = `${room.activePlayerCount ?? room.playerCount}/${room.maxPlayers}`;
      const tags = config.roomTags(room);
      const host = (room.players || []).find((p) => p.isHost);
      const hostName = host?.nickname || "";
      const row = document.createElement(playing ? "div" : "button");
      if (!playing) row.type = "button";
      row.className = `mg-room-row${playing ? " is-busy" : ""}`;
      row.innerHTML = `
        <div class="mg-room-row-body">
          <div class="mg-room-row-head">
            <strong class="mg-room-row-title">${escapeHtml(room.label)}</strong>
            <span class="mg-room-row-status${playing ? " is-live" : ""}">${playing ? "진행 중" : "대기"}</span>
          </div>
          ${hostName ? `<p class="mg-room-row-host">방장 ${escapeHtml(hostName)}</p>` : ""}
          <div class="mg-room-row-tags">
            ${tags.map((t) => `<span class="mg-room-tag">${escapeHtml(t)}</span>`).join("")}
          </div>
        </div>
        <div class="mg-room-row-aside">
          <span class="mg-room-row-count">${countLabel}</span>
          <span class="mg-room-row-btn${playing ? " is-muted" : ""}">${playing ? "진행 중" : "입장"}</span>
        </div>
      `;
      if (!playing) {
        row.addEventListener("click", () => {
          if (!requireNickname()) return;
          joinRoom({ roomId: room.id });
        });
      }
      roomsEl.appendChild(row);
    });
  }

  function showErr(el, msg) {
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("hidden", !msg);
  }

  function requireNickname() {
    const check = validateNicknameInput(nickEl.value);
    if (!check.ok) {
      toast(check.message);
      nickEl.focus();
      return false;
    }
    if (nickEl?.classList.contains("is-nick-taken")) {
      toast(NICKNAME_TAKEN_MESSAGE);
      nickEl.focus();
      return false;
    }
    if (isAccountLoggedIn() && !isAccountNicknameSaved(nickEl.value)) {
      toast("닉네임 저장 버튼을 눌러 등록해 주세요");
      nickSaveBtn?.focus();
      return false;
    }
    return true;
  }

  async function joinRoom({ roomId = "", code = "" }) {
    if (!requireNickname()) return;
    setNickname(nickEl.value);
    showErr(document.getElementById("join-err"), "");
    try {
      const data = await api("/api/rooms/join", {
        method: "POST",
        body: { roomId, code, nickname: nickEl.value },
      });
      if (data.room?.game && data.room.game !== config.gameId) {
        showErr(document.getElementById("join-err"), "다른 게임 방입니다");
        return;
      }
      rememberPlayer(data.playerId);
      location.href = roomPath(data.room.id, config.gameId);
    } catch (e) {
      showErr(document.getElementById("join-err"), e.message || "참가 실패");
    }
  }

  document.getElementById("solo-start-btn")?.addEventListener("click", () => {
    config.onSoloStart();
  });

  document.getElementById("create-btn")?.addEventListener("click", async () => {
    if (!requireNickname()) return;
    setNickname(nickEl.value);
    showErr(document.getElementById("create-err"), "");
    const btn = document.getElementById("create-btn");
    btn.disabled = true;
    try {
      const data = await api("/api/rooms", {
        method: "POST",
        body: {
          game: config.gameId,
          visibility,
          label: roomLabelEl?.value.trim() || defaultRoomLabel(nickEl.value),
          nickname: nickEl.value,
          ...(config.createRoomExtra?.() || {}),
        },
      });
      rememberPlayer(data.playerId);
      location.href = roomPath(data.roomId, config.gameId);
    } catch (e) {
      showErr(document.getElementById("create-err"), e.message || "방 만들기 실패");
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("join-code-btn")?.addEventListener("click", () => {
    joinRoom({ code: document.getElementById("join-code").value.trim().toUpperCase() });
  });

  document.getElementById("join-code")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("join-code-btn")?.click();
  });

  initAuth();
  consumeFlashToast();
  api("/api/lobby")
    .then((d) => renderRooms(d.rooms))
    .catch(() => {});
  connectLobbyEvents((data) => renderRooms(data.rooms));

  const autoCode = params.get("code");
  const autoId = params.get("id");
  if (autoCode || autoId) {
    setLobbyMode("join");
    if (autoCode) document.getElementById("join-code").value = autoCode.toUpperCase();
    joinRoom({ roomId: autoId || "", code: autoCode || "" });
  } else {
    setLobbyMode(normalizeLobbyTab(params.get("tab") || sessionStorage.getItem(config.tabStorageKey) || "rank"));
  }
}

/** @param {string} groupId @param {(value: string) => void} onPick */
export function setupChipGroup(groupId, onPick) {
  const group = document.getElementById(groupId);
  group?.querySelectorAll(".mg-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      group.querySelectorAll(".mg-chip").forEach((b) => b.classList.remove("is-on"));
      btn.classList.add("is-on");
      onPick(btn.dataset.value || "");
    });
  });
}
