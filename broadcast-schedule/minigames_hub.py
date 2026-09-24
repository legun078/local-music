"""시참 미니게임 방·플레이어·SSE 허브."""
from __future__ import annotations

import json
import random
import secrets
import string
import threading
import time
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Iterator

from minigames_plugins.minesweeper import normalize_minesweeper_settings
from minigames_plugins.hide import uses_room_duration
from minigames_plugins.gomoku import check_turn_timeout, finish_forfeit, opponent_id
from minigames_plugins.registry import DEFAULT_GAME_ID, GAMES, get_plugin
from nickname_filter import NicknameRejected, resolve_player_nickname
from minigames_nickname_registry import get_nickname_registry

GOMOKU_MAX_SPECTATORS = 12


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_utc(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def _room_play_elapsed(room: dict) -> bool:
    if room.get("status") != "playing":
        return False
    started = _parse_utc(room.get("startedAt"))
    if not started:
        return False
    duration = int((room.get("gameState") or {}).get("durationSec") or room.get("durationSec") or 300)
    return (datetime.now(timezone.utc) - started).total_seconds() >= duration


def _finish_room_play(room: dict) -> None:
    for p in room["players"].values():
        if p.get("isSpectator"):
            continue
        if not p.get("finished"):
            p["finished"] = True
            p["finishedAt"] = utc_now()
    room["status"] = "finished"


def _active_players(room: dict) -> list[dict]:
    return [p for p in room["players"].values() if not p.get("isSpectator")]


def _spectators(room: dict) -> list[dict]:
    return [p for p in room["players"].values() if p.get("isSpectator")]


def _gomoku_spectatable(room: dict) -> bool:
    """큐 매칭·공개 오목 방 — 진행 중 관전 허용."""
    if room.get("game") != "gomoku" or room.get("status") != "playing":
        return False
    return bool(room.get("fromQueue") or room.get("visibility") == "public")


def _all_active_finished(room: dict) -> bool:
    players = _active_players(room)
    return bool(players) and all(p.get("finished") for p in players)


def _room_2048_goal_tile(room: dict) -> int:
    if room.get("game") != "2048":
        return 2048
    try:
        return int(room.get("goalTile") if room.get("goalTile") is not None else 2048)
    except (TypeError, ValueError):
        return 2048


def _any_2048_player_won(room: dict) -> bool:
    if room.get("game") != "2048":
        return False
    goal = _room_2048_goal_tile(room)
    if goal <= 0:
        return False
    return any(int(p.get("maxTile") or 0) >= goal for p in _active_players(room))


def _all_returned_to_lobby(room: dict) -> bool:
    players = _active_players(room)
    return bool(players) and all(p.get("returnedToLobby") for p in players)


def _mark_room_finished(room: dict) -> None:
    room["status"] = "finished"
    room["finishedAt"] = utc_now()
    room.pop("autoLobbyAt", None)
    for p in room["players"].values():
        if p.get("isSpectator"):
            continue
        p["ready"] = False
        p.pop("returnedToLobby", None)


def _rand_code(length: int = 6) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _rand_room_id() -> str:
    return secrets.token_urlsafe(4).replace("-", "").replace("_", "")[:6]


def _public_player(p: dict) -> dict:
    finished = bool(p.get("finished"))
    won = bool(p.get("won"))
    elapsed = p.get("elapsedSec")
    out = {
        "id": p["id"],
        "nickname": p["nickname"],
        "ready": bool(p.get("ready")),
        "score": int(p.get("score") or 0),
        "finished": finished,
        "won": won,
        "elapsedSec": int(elapsed) if elapsed is not None and (won or finished) else None,
        "isHost": bool(p.get("isHost")),
        "isSpectator": bool(p.get("isSpectator")),
        "loggedIn": bool(p.get("userEmail")),
    }
    if p.get("returnedToLobby"):
        out["returnedToLobby"] = True
    return out


def _public_player_for_game(p: dict, game_id: str) -> dict:
    out = _public_player(p)
    out.update(get_plugin(game_id).public_player_fields(p))
    return out


def _public_room(room: dict, *, include_code: bool = False) -> dict:
    plugin = get_plugin(room["game"])
    players = [_public_player_for_game(p, room["game"]) for p in room["players"].values()]
    players.sort(key=plugin.player_sort_key)
    active_count = sum(1 for p in room["players"].values() if not p.get("isSpectator"))
    meta = GAMES.get(room["game"], {})
    out = {
        "id": room["id"],
        "label": room["label"],
        "game": room["game"],
        "gameLabel": meta.get("label", room["game"]),
        "visibility": room["visibility"],
        "status": room["status"],
        "hostId": room["hostId"],
        "maxPlayers": room["maxPlayers"],
        "playerCount": len(players),
        "activePlayerCount": active_count,
        "players": players,
        "createdAt": room["createdAt"],
        "updatedAt": room["updatedAt"],
        "startedAt": room.get("startedAt"),
        "endsAt": room.get("endsAt"),
        "finishedAt": room.get("finishedAt"),
        "durationSec": room.get("durationSec"),
        "gameState": _public_game_state(room),
    }
    out.update(plugin.public_room_fields(room))
    if include_code and room["visibility"] == "private":
        out["code"] = room["code"]
    return out


def _public_game_state(room: dict) -> dict:
    gs = room.get("gameState") or {}
    return get_plugin(room["game"]).public_game_state(room, gs)


def _maybe_advance_gomoku(room: dict) -> bool:
    if room.get("game") != "gomoku":
        return False
    if check_turn_timeout(room):
        return True
    return False


def _maybe_gomoku_player_left(room: dict, leaving_id: str) -> bool:
    if room.get("game") != "gomoku" or room.get("status") != "playing":
        return False
    gs = room.get("gameState") or {}
    if gs.get("winnerId"):
        return False
    winner = opponent_id(gs, leaving_id)
    if not winner:
        return False
    return finish_forfeit(room, winner, reason="leave")


def _maybe_auto_start_gomoku(room: dict) -> bool:
    if room.get("game") != "gomoku" or room.get("status") != "lobby":
        return False
    players = _active_players(room)
    if len(players) < 2:
        return False
    seed = random.randint(1, 2_000_000_000)
    plugin = get_plugin("gomoku")
    room["gameState"] = plugin.build_start_state(room, seed)
    room["status"] = "playing"
    room["startedAt"] = utc_now()
    room["endsAt"] = None
    room.pop("durationSec", None)
    for p in room["players"].values():
        if p.get("isSpectator"):
            continue
        p["ready"] = True
        p["finished"] = False
        p["finishedAt"] = None
        p["won"] = False
        p["score"] = 0
        plugin.reset_player_start(p)
    room.pop("finishedAt", None)
    room["updatedAt"] = utc_now()
    return True


def _gomoku_queue_stale(entry: dict, *, max_sec: float = 120.0) -> bool:
    joined = _parse_utc(entry.get("queuedAt"))
    if not joined:
        return True
    return (datetime.now(timezone.utc) - joined).total_seconds() > max_sec


def _maybe_advance_hide_room(room: dict) -> bool:
    if room.get("game") != "hide" or room.get("status") != "playing":
        return False
    plugin = get_plugin("hide")
    changed = False

    def finish_hide_room(_room=None) -> None:
        if room.get("status") != "playing":
            return
        _finish_room_play(room)
        _mark_room_finished(room)

    for _ in range(8):
        if not plugin.advance_rounds(room, finish_room_cb=finish_hide_room):
            break
        changed = True
    if (
        room.get("status") == "playing"
        and uses_room_duration(room)
        and _room_play_elapsed(room)
    ):
        finish_hide_room()
    return changed


def _make_player(
    nickname: str,
    *,
    user_email: str = "",
    user_name: str = "",
    is_host: bool = False,
    is_spectator: bool = False,
) -> tuple[str, dict]:
    pid = secrets.token_urlsafe(9)
    token = secrets.token_urlsafe(18)
    nick = resolve_player_nickname(nickname, user_name=user_name)
    get_nickname_registry().assert_can_use(nick, user_email)
    player = {
        "id": pid,
        "token": token,
        "nickname": nick,
        "userEmail": user_email or "",
        "ready": False,
        "score": 0,
        "finished": False,
        "finishedAt": None,
        "won": False,
        "elapsedSec": None,
        "isHost": is_host,
        "isSpectator": bool(is_spectator),
        "joinedAt": utc_now(),
        "lastSeenAt": utc_now(),
    }
    return token, player


def _make_player_or_error(
    nickname: str,
    *,
    user_email: str = "",
    user_name: str = "",
    is_host: bool = False,
    is_spectator: bool = False,
) -> tuple[str, dict] | dict:
    try:
        return _make_player(
            nickname,
            user_email=user_email,
            user_name=user_name,
            is_host=is_host,
            is_spectator=is_spectator,
        )
    except NicknameRejected as exc:
        return {"error": exc.code, "message": exc.message}


class MinigamesHub:
    _STALE_SEC_LOBBY = 30.0
    _STALE_SEC_PLAYING = 120.0

    def __init__(self, *, heartbeat_sec: float = 20.0):
        self._lock = threading.RLock()
        self._rooms: dict[str, dict] = {}
        self._code_index: dict[str, str] = {}
        self._token_index: dict[str, tuple[str, str]] = {}
        self._conds: dict[str, threading.Condition] = {}
        self._heartbeat_sec = heartbeat_sec
        self._revision = 0
        self._global_cond = threading.Condition()
        self._gomoku_queue: list[dict] = []

    def _bump(self, room_id: str | None = None) -> None:
        self._revision += 1
        if room_id:
            cond = self._conds.get(room_id)
            if cond:
                with cond:
                    cond.notify_all()
        with self._global_cond:
            self._global_cond.notify_all()

    def _room_cond(self, room_id: str) -> threading.Condition:
        if room_id not in self._conds:
            self._conds[room_id] = threading.Condition()
        return self._conds[room_id]

    def _register_token(self, room_id: str, player: dict) -> None:
        self._token_index[player["token"]] = (room_id, player["id"])

    def _unregister_token(self, token: str) -> None:
        self._token_index.pop(token, None)

    def _destroy_room(self, room_id: str, room: dict) -> None:
        for p in room["players"].values():
            self._unregister_token(p["token"])
        if room.get("visibility") == "private":
            self._code_index.pop(room.get("code"), None)
        self._rooms.pop(room_id, None)
        self._conds.pop(room_id, None)
        self._bump()

    def _touch_player(self, player: dict) -> None:
        player["lastSeenAt"] = utc_now()

    def _stale_limit_sec(self, room: dict) -> float:
        if room.get("game") == "gomoku" and room.get("status") == "playing":
            return 45.0
        return self._STALE_SEC_PLAYING if room.get("status") == "playing" else self._STALE_SEC_LOBBY

    def _maybe_prune_stale_players(self, room_id: str, room: dict) -> bool:
        from datetime import datetime, timezone

        limit = self._stale_limit_sec(room)
        now = datetime.now(timezone.utc)
        changed = False
        for pid in list(room["players"]):
            player = room["players"].get(pid)
            if not player:
                continue
            raw = player.get("lastSeenAt") or player.get("joinedAt")
            if not raw:
                continue
            seen = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            if (now - seen).total_seconds() <= limit:
                continue
            if pid == room.get("hostId"):
                self._destroy_room(room_id, room)
                return True
            token = player.get("token")
            if room.get("game") == "gomoku" and not player.get("isSpectator"):
                _maybe_gomoku_player_left(room, pid)
            room["players"].pop(pid, None)
            if token:
                self._unregister_token(token)
            changed = True
        if not room["players"]:
            self._destroy_room(room_id, room)
            return True
        if changed:
            if room.get("game") == "gomoku":
                _maybe_advance_gomoku(room)
            room["updatedAt"] = utc_now()
        return changed

    def _include_code_for_token(self, room: dict, token: str) -> bool:
        if not token or room.get("visibility") != "private":
            return False
        ref = self._token_index.get(token)
        return bool(ref and ref[0] == room["id"] and ref[1] == room.get("hostId"))

    def resolve_token(self, token: str) -> tuple[str, str] | None:
        with self._lock:
            return self._token_index.get(token)

    def list_public_rooms(self) -> list[dict]:
        with self._lock:
            for room_id in list(self._rooms.keys()):
                room = self._rooms.get(room_id)
                if room:
                    self._maybe_prune_stale_players(room_id, room)
            rooms = [
                _public_room(r)
                for r in self._rooms.values()
                if r["visibility"] == "public" and r["status"] in ("lobby", "playing")
            ]
            rooms.sort(key=lambda x: x["updatedAt"], reverse=True)
            return rooms

    def get_room_by_token(self, room_id: str, token: str) -> dict | None:
        with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                return None
            ref = self._token_index.get(token)
            if not ref or ref[0] != room_id:
                return None
            include_code = ref[1] == room["hostId"]
            return _public_room(room, include_code=include_code)

    def get_room_internal(self, room_id: str) -> dict | None:
        with self._lock:
            room = self._rooms.get(room_id)
            return deepcopy(room) if room else None

    def create_room(
        self,
        *,
        game: str,
        visibility: str,
        label: str,
        nickname: str,
        difficulty: str = "medium",
        rows: int | None = None,
        cols: int | None = None,
        mines: int | None = None,
        map_mode: str = "shared",
        play_mode: str = "classic",
        duration_key: str = "standard",
        goal_tile: int | None = None,
        room_mode: str = "standard",
        user_email: str = "",
        user_name: str = "",
    ) -> tuple[dict, str, str]:
        from minigames_plugins.registry import PLUGINS

        game = game if game in PLUGINS and PLUGINS[game].multiplayer_enabled else DEFAULT_GAME_ID
        visibility = "private" if visibility == "private" else "public"
        plugin = get_plugin(game)
        meta = PLUGINS[game].meta()
        with self._lock:
            room_id = _rand_room_id()
            while room_id in self._rooms:
                room_id = _rand_room_id()
            code = _rand_code(6)
            while code in self._code_index:
                code = _rand_code(6)
            token, host = _make_player(
                nickname, user_email=user_email, user_name=user_name, is_host=True
            )
            host["ready"] = True
            now = utc_now()
            room = {
                "id": room_id,
                "code": code,
                "visibility": visibility,
                "game": game,
                "label": (label or f"{meta['label']} 방").strip()[:40],
                "status": "lobby",
                "hostId": host["id"],
                "maxPlayers": meta["maxPlayers"],
                "players": {host["id"]: host},
                "gameState": {},
                "createdAt": now,
                "updatedAt": now,
                "startedAt": None,
                "endsAt": None,
            }
            plugin.apply_create(
                room,
                {
                    "difficulty": difficulty,
                    "rows": rows,
                    "cols": cols,
                    "mines": mines,
                    "map_mode": map_mode,
                    "play_mode": play_mode,
                    "duration_key": duration_key,
                    "goal_tile": goal_tile,
                    "room_mode": room_mode,
                },
            )
            self._rooms[room_id] = room
            if visibility == "private":
                self._code_index[code] = room_id
            self._register_token(room_id, host)
            self._bump(room_id)
            return _public_room(room, include_code=True), token, room_id

    def join_room(
        self,
        *,
        room_id: str = "",
        code: str = "",
        nickname: str,
        token: str = "",
        user_email: str = "",
        user_name: str = "",
        spectate: bool = False,
    ) -> tuple[dict, str] | dict:
        with self._lock:
            rid = room_id.strip()
            if not rid and code:
                rid = self._code_index.get(code.strip().upper(), "")
            room = self._rooms.get(rid)
            if not room:
                return {"error": "not_found", "message": "방을 찾을 수 없습니다."}

            if token:
                ref = self._token_index.get(token)
                if ref and ref[0] == rid:
                    player = room["players"].get(ref[1])
                    if player:
                        if nickname:
                            try:
                                nick = resolve_player_nickname(nickname, user_name=user_name)
                                get_nickname_registry().assert_can_use(nick, user_email)
                                player["nickname"] = nick
                            except NicknameRejected as exc:
                                return {"error": exc.code, "message": exc.message}
                        if user_email:
                            player["userEmail"] = user_email
                        room["updatedAt"] = utc_now()
                        self._bump(rid)
                        include = ref[1] == room["hostId"]
                        return _public_room(room, include_code=include), token

            if room["status"] == "playing":
                if spectate and _gomoku_spectatable(room):
                    if len(_spectators(room)) >= GOMOKU_MAX_SPECTATORS:
                        return {"error": "full", "message": "관전석이 가득 찼습니다."}
                    made = _make_player_or_error(
                        nickname,
                        user_email=user_email,
                        user_name=user_name,
                        is_spectator=True,
                    )
                    if isinstance(made, dict):
                        return made
                    new_token, player = made
                    room["players"][player["id"]] = player
                    room["updatedAt"] = utc_now()
                    self._register_token(rid, player)
                    self._bump(rid)
                    return _public_room(room), new_token
                return {"error": "started", "message": "이미 진행 중인 방입니다. 다음 판을 기다려 주세요."}
            elif room["status"] == "finished":
                return {
                    "error": "finished",
                    "message": "게임이 끝난 방입니다. 참가자가 방 로비로 돌아온 뒤 다시 참가할 수 있어요.",
                }
            elif room["status"] != "lobby":
                return {"error": "started", "message": "이미 진행 중인 방입니다."}

            if len(_active_players(room)) >= room["maxPlayers"]:
                return {"error": "full", "message": "방이 가득 찼습니다."}

            made = _make_player_or_error(nickname, user_email=user_email, user_name=user_name)
            if isinstance(made, dict):
                return made
            new_token, player = made
            room["players"][player["id"]] = player
            room["updatedAt"] = utc_now()
            self._register_token(rid, player)
            if _maybe_auto_start_gomoku(room):
                room["updatedAt"] = utc_now()
            self._bump(rid)
            return _public_room(room), new_token

    def _remove_player(self, room_id: str, room: dict, pid: str, token: str) -> dict | None:
        leaving = room["players"].get(pid)
        if leaving and pid == room.get("hostId"):
            self._destroy_room(room_id, room)
            return None
        if room.get("game") == "gomoku" and leaving and not leaving.get("isSpectator"):
            _maybe_gomoku_player_left(room, pid)
        player = room["players"].pop(pid, None)
        if player:
            self._unregister_token(token)
        if not room["players"]:
            self._destroy_room(room_id, room)
            return None
        room["updatedAt"] = utc_now()
        self._bump(room_id)
        return player

    def leave_room(self, room_id: str, token: str) -> dict | None:
        with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                return None
            ref = self._token_index.get(token)
            if not ref or ref[0] != room_id:
                return {"error": "forbidden"}
            pid = ref[1]
            removed = self._remove_player(room_id, room, pid, token)
            if removed is None:
                return {"deleted": True}
            if room_id not in self._rooms:
                return {"deleted": True}
            return _public_room(room)

    def set_ready(self, room_id: str, token: str, ready: bool) -> dict | None:
        with self._lock:
            room, player = self._player_for_token(room_id, token)
            if not room or not player:
                return None
            if player.get("isSpectator"):
                return {"error": "spectator", "message": "관전자는 준비할 수 없습니다."}
            gs = room.get("gameState") or {}
            if room["status"] == "lobby" and gs.get("seed") and not player.get("returnedToLobby"):
                return {
                    "error": "invalid",
                    "message": "결과를 확인한 뒤 방 로bi로 돌아와야 준비할 수 있습니다.",
                }
            player["ready"] = bool(ready)
            room["updatedAt"] = utc_now()
            self._bump(room_id)
            return _public_room(room)

    def start_game(self, room_id: str, token: str, *, force: bool = False) -> dict | None:
        with self._lock:
            room, player = self._player_for_token(room_id, token)
            if not room or not player:
                return None
            if player["id"] != room["hostId"]:
                return {"error": "forbidden", "message": "방장만 시작할 수 있습니다."}
            if room["status"] != "lobby":
                return {"error": "started"}
            if not room["players"]:
                return {"error": "empty"}
            unready = [
                p
                for p in room["players"].values()
                if not p.get("isSpectator")
                and p["id"] != room["hostId"]
                and not p.get("ready")
            ]
            if unready and not force:
                return {
                    "error": "not_ready",
                    "message": "준비하지 않은 플레이어가 있습니다.",
                    "unready": [
                        {"id": p["id"], "nickname": p["nickname"]} for p in unready
                    ],
                }
            seed = random.randint(1, 2_000_000_000)
            plugin = get_plugin(room["game"])
            defaults = plugin.build_start_state(room, seed)
            duration = int(defaults.pop("durationSec", 120))
            room["gameState"] = defaults
            room["status"] = "playing"
            room["durationSec"] = duration
            started = datetime.now(timezone.utc)
            room["startedAt"] = started.strftime("%Y-%m-%dT%H:%M:%SZ")
            room["endsAt"] = (started + timedelta(seconds=duration)).strftime("%Y-%m-%dT%H:%M:%SZ")
            for p in room["players"].values():
                if p.get("isSpectator"):
                    p["score"] = 0
                    p["finished"] = False
                    p["finishedAt"] = None
                    p["won"] = False
                    p["elapsedSec"] = None
                    plugin.reset_player_start(p)
                    continue
                p["ready"] = True
                p["score"] = 0
                p["finished"] = False
                p["finishedAt"] = None
                p["won"] = False
                p["elapsedSec"] = None
                p.pop("returnedToLobby", None)
                plugin.reset_player_start(p)
            room.pop("finishedAt", None)
            room.pop("autoLobbyAt", None)
            room["updatedAt"] = utc_now()
            _maybe_advance_hide_room(room)
            self._bump(room_id)
            return _public_room(room, include_code=True)

    def update_room_settings(
        self,
        room_id: str,
        token: str,
        settings: dict | None = None,
        *,
        difficulty: str | None = None,
        rows: int | None = None,
        cols: int | None = None,
        mines: int | None = None,
        map_mode: str | None = None,
        play_mode: str | None = None,
    ) -> dict | None:
        with self._lock:
            room, player = self._player_for_token(room_id, token)
            if not room or not player:
                return None
            if player["id"] != room["hostId"]:
                return {"error": "forbidden", "message": "방장만 설정을 변경할 수 있습니다."}
            if room["status"] != "lobby":
                return {"error": "started", "message": "이미 시작된 방입니다."}
            plugin = get_plugin(room["game"])
            opts = dict(settings or {})
            if difficulty is not None:
                opts["difficulty"] = difficulty
            if rows is not None:
                opts["rows"] = rows
            if cols is not None:
                opts["cols"] = cols
            if mines is not None:
                opts["mines"] = mines
            if map_mode is not None:
                opts["map_mode"] = map_mode
            if play_mode is not None:
                opts["play_mode"] = play_mode
            err = plugin.update_settings(room, opts)
            if err:
                return err
            room["updatedAt"] = utc_now()
            self._bump(room_id)
            return _public_room(room, include_code=True)

    def post_score(
        self,
        room_id: str,
        token: str,
        *,
        score: int,
        finished: bool = False,
        won: bool = False,
        elapsed_sec: int | None = None,
        max_tile: int | None = None,
        move_count: int | None = None,
        board_view: dict | None = None,
        round_submit: dict | None = None,
        round_submit_draft: dict | None = None,
    ) -> dict | None:
        with self._lock:
            room, player = self._player_for_token(room_id, token)
            if not room or not player:
                return None
            if room["status"] != "playing":
                return {"error": "not_playing"}
            if player.get("isSpectator"):
                return {"error": "spectator"}

            if room.get("game") == "hide" and isinstance(round_submit_draft, dict):
                plugin = get_plugin("hide")
                pick = str(round_submit_draft.get("pick") or "")
                if not plugin.submit_draft_pick(room, player, pick):
                    return {"error": "invalid", "message": "지금은 색을 저장할 수 없습니다."}
                room["updatedAt"] = utc_now()
                self._bump(room_id)
                return _public_room(room)

            if room.get("game") == "hide" and isinstance(round_submit, dict):
                plugin = get_plugin("hide")
                pick = str(round_submit.get("pick") or "")
                if not plugin.submit_round_pick(room, player, pick):
                    return {"error": "invalid", "message": "지금은 색을 제출할 수 없습니다."}
                _maybe_advance_hide_room(room)
                room["updatedAt"] = utc_now()
                self._bump(room_id)
                return _public_room(room)

            prev_score = int(player.get("score") or 0)
            if room.get("game") == "hide":
                new_score = prev_score if finished else int(score)
            else:
                new_score = max(int(score), prev_score)
            if new_score > prev_score:
                player["scoreReachedAt"] = utc_now()
            player["score"] = new_score
            if max_tile is not None:
                prev_tile = int(player.get("maxTile") or 0)
                new_tile = max(int(max_tile), prev_tile)
                if new_tile > prev_tile:
                    player["maxTileReachedAt"] = utc_now()
                player["maxTile"] = new_tile
            if move_count is not None:
                player["moveCount"] = max(0, int(move_count))
            if isinstance(board_view, dict) and board_view.get("rv"):
                player["boardView"] = board_view
            if won:
                player["won"] = True
            if elapsed_sec is not None:
                es = max(0, min(999 * 60, int(elapsed_sec)))
                if won:
                    prev = player.get("elapsedSec")
                    if prev is None or es < prev:
                        player["elapsedSec"] = es
                elif finished:
                    player["elapsedSec"] = es
            if finished:
                player["finished"] = True
                player["finishedAt"] = utc_now()
            if room.get("game") == "2048":
                goal = _room_2048_goal_tile(room)
                if goal > 0 and max_tile is not None and int(max_tile) >= goal:
                    if not player.get("finished"):
                        player["finished"] = True
                        player["finishedAt"] = utc_now()
            room["updatedAt"] = utc_now()
            timed_out = _room_play_elapsed(room)
            if timed_out and (room.get("game") != "hide" or uses_room_duration(room)):
                _finish_room_play(room)
                _mark_room_finished(room)
            elif _any_2048_player_won(room):
                _finish_room_play(room)
                _mark_room_finished(room)
            elif _all_active_finished(room):
                _mark_room_finished(room)
            self._bump(room_id)
            return _public_room(room)

    def post_move(self, room_id: str, token: str, *, row: int, col: int) -> dict | None:
        with self._lock:
            room, player = self._player_for_token(room_id, token)
            if not room or not player:
                return None
            if room.get("game") != "gomoku":
                return {"error": "unsupported", "message": "지원하지 않는 게임입니다."}
            if room["status"] != "playing":
                return {"error": "not_playing", "message": "진행 중인 게임이 아닙니다."}
            if player.get("isSpectator"):
                return {"error": "spectator", "message": "관전자는 착수할 수 없습니다."}
            plugin = get_plugin("gomoku")
            err = plugin.apply_move(room, player["id"], int(row), int(col))
            if err:
                if room.get("status") == "finished":
                    room["finishedAt"] = utc_now()
                    room["updatedAt"] = utc_now()
                    self._bump(room_id)
                    return _public_room(room)
                return err
            if room.get("status") == "finished":
                room["finishedAt"] = utc_now()
            elif _maybe_advance_gomoku(room):
                room["finishedAt"] = utc_now()
            room["updatedAt"] = utc_now()
            self._bump(room_id)
            return _public_room(room)

    def _gomoku_queue_waiting_count(self) -> int:
        return sum(1 for e in self._gomoku_queue if e.get("status") == "waiting")

    def _gomoku_live_match_entry(self, room_id: str, room: dict) -> dict | None:
        if room.get("game") != "gomoku":
            return None
        is_queue = bool(room.get("fromQueue"))
        is_public = room.get("visibility") == "public"
        if not is_queue and not is_public:
            return None
        if is_public:
            if room.get("status") != "playing":
                return None
        elif room.get("status") not in ("lobby", "playing"):
            return None
        gs = room.get("gameState") or {}
        black_id = gs.get("blackId")
        white_id = gs.get("whiteId")
        players = []
        for p in _active_players(room):
            stone = "흑" if p["id"] == black_id else "백" if p["id"] == white_id else ""
            players.append({"nickname": p.get("nickname") or "플레이어", "stone": stone})
        return {
            "roomId": room_id,
            "label": room.get("label") or "대국",
            "status": room.get("status"),
            "visibility": room.get("visibility") or "private",
            "fromQueue": is_queue,
            "players": players,
            "spectatorCount": len(_spectators(room)),
        }

    def gomoku_queue_status(self) -> dict:
        with self._lock:
            self._gomoku_queue = [e for e in self._gomoku_queue if not _gomoku_queue_stale(e)]
            waiting = [e for e in self._gomoku_queue if e.get("status") == "waiting"]
            live_matches = []
            for rid, r in self._rooms.items():
                entry = self._gomoku_live_match_entry(rid, r)
                if entry:
                    live_matches.append(entry)
            live_matches.sort(key=lambda m: (0 if m.get("status") == "playing" else 1, m.get("label") or ""))
            return {
                "waitingCount": len(waiting),
                "waiting": [{"nickname": e.get("nickname") or "플레이어"} for e in waiting],
                "liveMatches": live_matches,
            }

    def gomoku_queue_join(
        self,
        *,
        nickname: str,
        user_email: str = "",
        user_name: str = "",
        queue_token: str = "",
    ) -> dict:
        with self._lock:
            self._gomoku_queue = [e for e in self._gomoku_queue if not _gomoku_queue_stale(e)]
            token = str(queue_token or "").strip()
            if token:
                existing = next((e for e in self._gomoku_queue if e.get("queueToken") == token), None)
                if existing:
                    if existing.get("status") == "matched":
                        return {
                            "status": "matched",
                            "queueToken": token,
                            "roomId": existing.get("roomId"),
                            "playerToken": existing.get("playerToken"),
                            "playerId": existing.get("playerId"),
                            "waitingCount": self._gomoku_queue_waiting_count(),
                        }
                    return {
                        "status": "waiting",
                        "queueToken": token,
                        "waitingCount": self._gomoku_queue_waiting_count(),
                    }

            try:
                nick = resolve_player_nickname(nickname, user_name=user_name)
            except NicknameRejected as exc:
                return {"error": exc.code, "message": exc.message}
            queue_token = secrets.token_urlsafe(16)
            entry = {
                "queueToken": queue_token,
                "nickname": nick,
                "userEmail": user_email or "",
                "userName": user_name or "",
                "status": "waiting",
                "roomId": "",
                "playerToken": "",
                "playerId": "",
                "queuedAt": utc_now(),
            }
            self._gomoku_queue.append(entry)
            matched = self._try_gomoku_queue_match()
            if matched:
                for item in matched:
                    if item["queueToken"] == queue_token:
                        item["waitingCount"] = self._gomoku_queue_waiting_count()
                        return item
            return {
                "status": "waiting",
                "queueToken": queue_token,
                "waitingCount": self._gomoku_queue_waiting_count(),
            }

    def gomoku_queue_leave(self, queue_token: str) -> dict:
        with self._lock:
            token = str(queue_token or "").strip()
            before = len(self._gomoku_queue)
            self._gomoku_queue = [e for e in self._gomoku_queue if e.get("queueToken") != token]
            return {
                "left": len(self._gomoku_queue) < before,
                "waitingCount": self._gomoku_queue_waiting_count(),
            }

    def _try_gomoku_queue_match(self) -> list[dict] | None:
        waiting = [e for e in self._gomoku_queue if e.get("status") == "waiting"]
        if len(waiting) < 2:
            return None
        host_entry, guest_entry = waiting[0], waiting[1]
        room, host_token, room_id = self.create_room(
            game="gomoku",
            visibility="private",
            label=f"{host_entry['nickname']} vs {guest_entry['nickname']}",
            nickname=host_entry["nickname"],
            user_email=host_entry.get("userEmail") or "",
            user_name=host_entry.get("userName") or "",
        )
        join_result = self.join_room(
            room_id=room_id,
            nickname=guest_entry["nickname"],
            user_email=guest_entry.get("userEmail") or "",
            user_name=guest_entry.get("userName") or "",
        )
        if isinstance(join_result, dict) and join_result.get("error"):
            host_entry["status"] = "waiting"
            guest_entry["status"] = "waiting"
            internal = self._rooms.get(room_id)
            if internal:
                self._destroy_room(room_id, internal)
            return None
        internal = self._rooms.get(room_id)
        if internal:
            internal["fromQueue"] = True
        joined_room, guest_token = join_result
        guest_ref = self._token_index.get(guest_token)
        guest_id = guest_ref[1] if guest_ref else ""

        host_entry["status"] = "matched"
        host_entry["roomId"] = room_id
        host_entry["playerToken"] = host_token
        host_entry["playerId"] = room.get("hostId") or joined_room.get("hostId")

        guest_entry["status"] = "matched"
        guest_entry["roomId"] = room_id
        guest_entry["playerToken"] = guest_token
        guest_entry["playerId"] = guest_id

        return [
            {
                "status": "matched",
                "queueToken": host_entry["queueToken"],
                "roomId": room_id,
                "playerToken": host_token,
                "playerId": host_entry["playerId"],
                "waitingCount": self._gomoku_queue_waiting_count(),
            },
            {
                "status": "matched",
                "queueToken": guest_entry["queueToken"],
                "roomId": room_id,
                "playerToken": guest_token,
                "playerId": guest_id,
                "waitingCount": self._gomoku_queue_waiting_count(),
            },
        ]

    def _apply_room_lobby_reset(self, room: dict, *, keep_return_flags: bool = False) -> None:
        plugin = get_plugin(room["game"])
        room["status"] = "lobby"
        room["gameState"] = {}
        room["startedAt"] = None
        room["endsAt"] = None
        room.pop("finishedAt", None)
        room.pop("autoLobbyAt", None)
        for p in room["players"].values():
            p["score"] = 0
            p["finished"] = False
            p["finishedAt"] = None
            p["won"] = False
            p["elapsedSec"] = None
            plugin.reset_player_lobby(p)
            if keep_return_flags:
                if p.get("returnedToLobby"):
                    p["ready"] = p["id"] == room["hostId"]
                else:
                    p["ready"] = False
            else:
                p.pop("returnedToLobby", None)
                p["ready"] = p["id"] == room["hostId"]
            p["isSpectator"] = False

    def _open_lobby_after_game(self, room: dict) -> None:
        """레거시 — 방 전체 status 변경은 하지 않음 (개인 returnedToLobby만 사용)."""
        return

    def _maybe_finish_hide_lobby_reset(self, room: dict) -> None:
        if not _all_returned_to_lobby(room):
            return
        gs = room.get("gameState") or {}
        if room.get("status") == "finished" or gs.get("seed"):
            self._apply_room_lobby_reset(room, keep_return_flags=True)

    def return_to_lobby(self, room_id: str, token: str) -> dict | None:
        with self._lock:
            room, player = self._player_for_token(room_id, token)
            if not room or not player:
                return None
            if player.get("isSpectator"):
                return {"error": "invalid", "message": "관전자는 방 로비로 돌아갈 수 없습니다."}
            include_code = player["id"] == room["hostId"]

            if room["status"] == "lobby":
                if not player.get("returnedToLobby"):
                    player["returnedToLobby"] = True
                    player["ready"] = player["id"] == room["hostId"]
                self._maybe_finish_hide_lobby_reset(room)
                room["updatedAt"] = utc_now()
                self._bump(room_id)
                return _public_room(room, include_code=include_code)

            if room["status"] == "playing":
                if not player.get("finished"):
                    return {
                        "error": "invalid",
                        "message": "아직 게임 중입니다. 내 판이 끝난 뒤에 방 로비로 돌아갈 수 있습니다.",
                    }
                if not player.get("returnedToLobby"):
                    player["returnedToLobby"] = True
                    player["ready"] = player["id"] == room["hostId"]
                room["updatedAt"] = utc_now()
                self._bump(room_id)
                return _public_room(room, include_code=include_code)

            if room["status"] != "finished":
                return {"error": "invalid", "message": "게임이 끝난 뒤에만 방 로비로 돌아갈 수 있습니다."}
            if not player.get("returnedToLobby"):
                player["returnedToLobby"] = True
                player["ready"] = player["id"] == room["hostId"]
                self._maybe_finish_hide_lobby_reset(room)
            room["updatedAt"] = utc_now()
            self._bump(room_id)
            return _public_room(room, include_code=include_code)

    def kick_player(self, room_id: str, token: str, target_id: str) -> dict | None:
        with self._lock:
            room, player = self._player_for_token(room_id, token)
            if not room or not player:
                return None
            if player["id"] != room["hostId"]:
                return {"error": "forbidden", "message": "방장만 강퇴할 수 있습니다."}
            if room["status"] == "playing":
                return {"error": "playing", "message": "게임 중에는 강퇴할 수 없습니다."}
            target_id = (target_id or "").strip()
            if not target_id or target_id == room["hostId"]:
                return {"error": "invalid", "message": "강퇴할 수 없는 플레이어입니다."}
            target = room["players"].pop(target_id, None)
            if not target:
                return {"error": "not_found", "message": "플레이어를 찾을 수 없습니다."}
            self._unregister_token(target["token"])
            room["updatedAt"] = utc_now()
            self._bump(room_id)
            return _public_room(room, include_code=True)

    def dismiss_all_players(self, room_id: str, token: str) -> dict | None:
        with self._lock:
            room, player = self._player_for_token(room_id, token)
            if not room or not player:
                return None
            if player["id"] != room["hostId"]:
                return {"error": "forbidden", "message": "방장만 모두 내보내기를 할 수 있습니다."}
            if room["status"] == "playing":
                return {"error": "playing", "message": "게임 중에는 사용할 수 없습니다."}
            host_id = room["hostId"]
            for pid in list(room["players"]):
                if pid == host_id:
                    continue
                removed = room["players"].pop(pid)
                self._unregister_token(removed["token"])
            room["updatedAt"] = utc_now()
            self._bump(room_id)
            return _public_room(room, include_code=True)

    def _player_for_token(self, room_id: str, token: str) -> tuple[dict | None, dict | None]:
        room = self._rooms.get(room_id)
        if not room:
            return None, None
        ref = self._token_index.get(token)
        if not ref or ref[0] != room_id:
            return room, None
        player = room["players"].get(ref[1])
        if player:
            self._touch_player(player)
        return room, player

    def ping_room(self, room_id: str, token: str) -> dict | None:
        with self._lock:
            room, player = self._player_for_token(room_id, token)
            if not room or not player:
                return None
            player_id = player["id"]
            if self._maybe_prune_stale_players(room_id, room):
                room = self._rooms.get(room_id)
                if not room:
                    return None
                player = room["players"].get(player_id)
                if not player:
                    return None
            if _maybe_advance_hide_room(room):
                room["updatedAt"] = utc_now()
            if _maybe_auto_start_gomoku(room):
                room["updatedAt"] = utc_now()
            if _maybe_advance_gomoku(room):
                room["updatedAt"] = utc_now()
            room["updatedAt"] = utc_now()
            self._bump(room_id)
            return _public_room(room, include_code=self._include_code_for_token(room, token))

    def room_snapshot(self, room_id: str, token: str = "") -> str:
        with self._lock:
            room = self._rooms.get(room_id)
            if room:
                if self._maybe_prune_stale_players(room_id, room):
                    room = self._rooms.get(room_id)
                if room and _maybe_advance_hide_room(room):
                    room["updatedAt"] = utc_now()
                    self._bump(room_id)
                if room and _maybe_advance_gomoku(room):
                    room["updatedAt"] = utc_now()
                    self._bump(room_id)
            include_code = self._include_code_for_token(room, token) if room else False
            evicted = None
            if token:
                ref = self._token_index.get(token)
                if room and (not ref or ref[0] != room_id):
                    evicted = "removed"
                elif room and ref and ref[1] not in room["players"]:
                    evicted = "removed"
            payload = {
                "revision": self._revision,
                "room": _public_room(room, include_code=include_code) if room else None,
            }
            if evicted:
                payload["evicted"] = evicted
            elif not room:
                payload["evicted"] = "room_closed"
            return json.dumps(payload, ensure_ascii=False)

    def stream_room(self, room_id: str, token: str = "") -> Iterator[str]:
        last = ""
        hb = time.monotonic()
        cond = self._room_cond(room_id)
        while True:
            snap = self.room_snapshot(room_id, token)
            event = None
            now = time.monotonic()
            if snap != last:
                last = snap
                event = f"data: {snap}\n\n"
                hb = now
            elif now - hb >= self._heartbeat_sec:
                event = ": heartbeat\n\n"
                hb = now
            if event:
                yield event
            with cond:
                cond.wait(timeout=1.0)

    def stream_lobby(self) -> Iterator[str]:
        last = ""
        hb = time.monotonic()
        while True:
            with self._lock:
                payload = json.dumps(
                    {"revision": self._revision, "rooms": self.list_public_rooms()},
                    ensure_ascii=False,
                )
            event = None
            now = time.monotonic()
            if payload != last:
                last = payload
                event = f"data: {payload}\n\n"
                hb = now
            elif now - hb >= self._heartbeat_sec:
                event = ": heartbeat\n\n"
                hb = now
            if event:
                yield event
            with self._global_cond:
                self._global_cond.wait(timeout=1.5)

    def stats(self) -> dict:
        with self._lock:
            active = sum(1 for r in self._rooms.values() if r["status"] != "finished")
            return {"rooms": len(self._rooms), "active": active, "revision": self._revision}
