#!/usr/bin/env python3
"""시참용 미니게임 — 메인 server.py와 분리된 방·게임·SSE 서비스."""
from __future__ import annotations

import json
import os
import re
import time
import urllib.request
from pathlib import Path

from flask import Flask, Response, jsonify, redirect, request, send_from_directory, stream_with_context

import ga4_analytics
from nickname_filter import NicknameRejected, resolve_player_nickname
from minigames_nickname_registry import NicknameTaken, NicknameNotSaved, get_nickname_registry
from minigames_hub import GAMES, MinigamesHub, utc_now
from minigames_leaderboard import MinesweeperLeaderboard, leaderboard_period_meta, normalize_month_at, normalize_period, normalize_rank_tier, rank_board_spec
from minigames_leaderboard_apple import AppleLeaderboard, apple_mode_spec, normalize_apple_mode
from minigames_leaderboard_colortiles import (
    ColortilesLeaderboard,
    colortiles_mode_spec,
    is_ranked_colortiles_mode,
    normalize_colortiles_mode,
)
from minigames_leaderboard_hide import HIDE_MODES, HideLeaderboard, hide_mode_spec, normalize_hide_mode
from minigames_leaderboard_2048 import Tile2048Leaderboard, normalize_2048_mode, tile2048_mode_spec
from minigames_leaderboard_events import LeaderboardRevisionHub
from minigames_leaderboard_archive import RankArchive
from minigames_hub_feed import HubFeedBuilder
from minigames_social import inject_social_meta, is_social_crawler, social_meta_for_path

BASE_DIR = Path(__file__).resolve().parent
MINIGAMES_DIR = BASE_DIR / "minigames"
DATA_DIR = BASE_DIR / "data" / "minigames"
LEADERBOARD_PATH = DATA_DIR / "minesweeper-leaderboard.json"
SEED_LEADERBOARD = BASE_DIR / "seed" / "minesweeper-leaderboard.json"
APPLE_LEADERBOARD_PATH = DATA_DIR / "apple-leaderboard.json"
SEED_APPLE_LEADERBOARD = BASE_DIR / "seed" / "apple-leaderboard.json"
COLORTILES_LEADERBOARD_PATH = DATA_DIR / "colortiles-leaderboard.json"
SEED_COLORTILES_LEADERBOARD = BASE_DIR / "seed" / "colortiles-leaderboard.json"
HIDE_LEADERBOARD_PATH = DATA_DIR / "hide-leaderboard.json"
SEED_HIDE_LEADERBOARD = BASE_DIR / "seed" / "hide-leaderboard.json"
TILE2048_LEADERBOARD_PATH = DATA_DIR / "2048-leaderboard.json"
SEED_TILE2048_LEADERBOARD = BASE_DIR / "seed" / "2048-leaderboard.json"
RANK_ARCHIVE_PATH = DATA_DIR / "rank-archive.jsonl"
NICKNAME_REGISTRY_PATH = DATA_DIR / "player-nicknames.json"
HUB_FEED_PATH = DATA_DIR / "minigames-hub.json"
SEED_HUB_FEED = BASE_DIR / "seed" / "minigames-hub.json"
PORT = int(os.environ.get("MINIGAMES_PORT", "8015"))
SCHEDULE_ORIGIN = os.environ.get(
    "SCHEDULE_ORIGIN", os.environ.get("APP_BASE_URL", "http://127.0.0.1:8011")
).rstrip("/")
SESSION_COOKIE_NAME = os.environ.get("SESSION_COOKIE_NAME", "schedule_session")

app = Flask(__name__)
_hub = MinigamesHub()
_leaderboard = MinesweeperLeaderboard(LEADERBOARD_PATH)
_apple_leaderboard = AppleLeaderboard(APPLE_LEADERBOARD_PATH)
_colortiles_leaderboard = ColortilesLeaderboard(COLORTILES_LEADERBOARD_PATH)
_hide_leaderboard = HideLeaderboard(HIDE_LEADERBOARD_PATH)
_tile2048_leaderboard = Tile2048Leaderboard(TILE2048_LEADERBOARD_PATH)
_rank_archive = RankArchive(RANK_ARCHIVE_PATH)
_hub_feed = HubFeedBuilder(
    hub_path=HUB_FEED_PATH,
    hub_seed=SEED_HUB_FEED,
    minesweeper=_leaderboard,
    apple=_apple_leaderboard,
    hide=_hide_leaderboard,
    tile2048=_tile2048_leaderboard,
    colortiles=_colortiles_leaderboard,
)
_lb_events = LeaderboardRevisionHub()
_STARTED_AT = time.time()


def _load_dotenv() -> None:
    env_path = BASE_DIR / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


def _html_request_path(request_path: str, flask_path: str) -> str:
    raw = str(request_path or flask_path or "").lstrip("/")
    return raw


def _serve_html_file(directory: Path, filename: str, *, request_path: str = "") -> Response:
    html = (directory / filename).read_text(encoding="utf-8")
    meta_path = _html_request_path(request_path, request.path)
    meta = social_meta_for_path(meta_path)
    html = inject_social_meta(
        html,
        title=meta["title"],
        description=meta["description"],
        page_url=meta["page_url"],
        image_url=meta["image_url"],
        site_name=meta["site_name"],
    )
    if "<title>" in html:
        html = re.sub(r"<title>[^<]*</title>", f"<title>{meta['title']}</title>", html, count=1)
    html = ga4_analytics.inject_ga4_snippet(html)
    return Response(html, mimetype="text/html; charset=utf-8")


_load_dotenv()


@app.before_request
def _trailing_slash_redirect():
    """디렉터리 URL은 trailing slash로 — base 태그·정적 경로 일관성."""
    if request.method not in ("GET", "HEAD"):
        return None
    path = request.path
    if not path or path.endswith("/") or path.startswith("/api/"):
        return None
    tail = path.rsplit("/", 1)[-1]
    if "." in tail:
        return None
    return redirect(f"{path}/", code=301)


def _ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not LEADERBOARD_PATH.is_file() and SEED_LEADERBOARD.is_file():
        LEADERBOARD_PATH.write_text(SEED_LEADERBOARD.read_text(encoding="utf-8"), encoding="utf-8")
    if not APPLE_LEADERBOARD_PATH.is_file() and SEED_APPLE_LEADERBOARD.is_file():
        APPLE_LEADERBOARD_PATH.write_text(
            SEED_APPLE_LEADERBOARD.read_text(encoding="utf-8"), encoding="utf-8"
        )
    if not COLORTILES_LEADERBOARD_PATH.is_file() and SEED_COLORTILES_LEADERBOARD.is_file():
        COLORTILES_LEADERBOARD_PATH.write_text(
            SEED_COLORTILES_LEADERBOARD.read_text(encoding="utf-8"), encoding="utf-8"
        )
    if not HIDE_LEADERBOARD_PATH.is_file() and SEED_HIDE_LEADERBOARD.is_file():
        HIDE_LEADERBOARD_PATH.write_text(
            SEED_HIDE_LEADERBOARD.read_text(encoding="utf-8"), encoding="utf-8"
        )
    if not TILE2048_LEADERBOARD_PATH.is_file() and SEED_TILE2048_LEADERBOARD.is_file():
        TILE2048_LEADERBOARD_PATH.write_text(
            SEED_TILE2048_LEADERBOARD.read_text(encoding="utf-8"), encoding="utf-8"
        )
    get_nickname_registry(NICKNAME_REGISTRY_PATH)
    _seed_rank_archive_from_boards()


def _seed_rank_archive_from_boards() -> None:
    snapshots: list[tuple[str, str, list]] = []
    for tier in ("standard", "expert"):
        snapshots.append(("minesweeper", tier, _leaderboard.raw_entries(tier)))
    for mode in ("standard", "speed"):
        snapshots.append(("apple", mode, _apple_leaderboard.raw_entries(mode)))
        snapshots.append(("hide", mode, _hide_leaderboard.raw_entries(mode)))
        snapshots.append(("2048", mode, _tile2048_leaderboard.raw_entries(mode)))
    for mode in ("minute", "speedrun"):
        snapshots.append(("colortiles", mode, _colortiles_leaderboard.raw_entries(mode)))
    _rank_archive.seed_from_boards(snapshots)


_ensure_data_dir()


def _player_token() -> str:
    return (
        request.headers.get("X-Player-Token")
        or request.cookies.get("mg_player")
        or request.args.get("token")
        or ""
    ).strip()


def _session_cookie_header() -> str | None:
    """방송일정 OAuth 세션 쿠키 — 메인 server.py와 이름 일치."""
    val = (request.cookies.get(SESSION_COOKIE_NAME) or request.cookies.get("session") or "").strip()
    if not val:
        return None
    name = SESSION_COOKIE_NAME if request.cookies.get(SESSION_COOKIE_NAME) else "session"
    return f"{name}={val}"


def _proxy_schedule_api(path: str, *, with_cookie: bool = True) -> dict | None:
    headers = {"Accept": "application/json"}
    if with_cookie:
        cookie_hdr = _session_cookie_header()
        if not cookie_hdr:
            return None
        headers["Cookie"] = cookie_hdr
    try:
        req = urllib.request.Request(f"{SCHEDULE_ORIGIN}{path}", headers=headers)
        with urllib.request.urlopen(req, timeout=2.5) as res:
            return json.loads(res.read().decode())
    except Exception:
        return None


def _auth_user() -> dict:
    """메인 사이트 OAuth (선택) — 실패 시 비로그인."""
    data = _proxy_schedule_api("/api/auth/me")
    if data and data.get("loggedIn"):
        return {
            "email": str(data.get("email") or ""),
            "name": str(data.get("name") or data.get("email") or ""),
            "canEdit": bool(data.get("canEdit")),
            "role": str(data.get("role") or "guest"),
        }
    return {"email": "", "name": "", "canEdit": False, "role": "guest"}


def _auth_can_edit() -> bool:
    return bool(_auth_user().get("canEdit"))


def _nickname_registry():
    return get_nickname_registry(NICKNAME_REGISTRY_PATH)


def _resolve_player_nickname(body: dict, user: dict) -> str:
    """로그인 사용자: 저장된 닉네임만 사용."""
    email = str(user.get("email") or "").strip()
    requested = str(body.get("nickname") or "").strip()
    if not email:
        nick = resolve_player_nickname(requested, user_name=str(user.get("name") or ""))
        if nick:
            _nickname_registry().assert_can_use(nick, "")
        return nick
    saved = _nickname_registry().get_nickname(email)
    if saved:
        return saved
    raise NicknameNotSaved(NicknameNotSaved.message)


def _guard_leaderboard_display_name(display_name: str, user: dict) -> str:
    email = str(user.get("email") or "").strip()
    name = str(display_name or "").strip()
    if email:
        saved = _nickname_registry().get_nickname(email)
        if saved:
            _nickname_registry().assert_can_use(saved, email)
            return saved
        raise NicknameNotSaved(NicknameNotSaved.message)
    if name:
        _nickname_registry().assert_can_use(name, "")
    return name


def _leaderboard_display_name_from_body(body: dict) -> tuple[str, NicknameRejected | None]:
    user = _auth_user()
    raw = str(body.get("displayName") or body.get("display_name") or "")
    try:
        return _guard_leaderboard_display_name(raw, user), None
    except NicknameRejected as exc:
        return "", exc


def _nickname_error_response(exc: NicknameRejected):
    status = 409 if isinstance(exc, NicknameTaken) else 400
    return jsonify({"error": exc.code, "message": exc.message}), status


def _notify_leaderboard_change(game: str = "") -> None:
    _lb_events.bump(game)


def _on_rank_registered(game: str, mode: str, result: dict) -> None:
    """랭킹 등록 성공 시 알림 + 백업 아카이브."""
    entry = result.get("entry")
    if isinstance(entry, dict):
        _rank_archive.append(game, mode, entry)
    _notify_leaderboard_change(game)


def _sse_response(stream):
    response = Response(stream_with_context(stream), mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-cache"
    response.headers["Connection"] = "keep-alive"
    response.headers["X-Accel-Buffering"] = "no"
    return response


@app.route("/api/health")
def api_health():
    stats = _hub.stats()
    return jsonify(
        {
            "ok": True,
            "service": "minigames",
            "updatedAt": utc_now(),
            "uptimeSec": round(time.time() - _STARTED_AT, 1),
            **stats,
        }
    )


@app.route("/api/games")
def api_games():
    return jsonify({"games": [{"id": k, **v} for k, v in GAMES.items()]})


@app.route("/api/auth/me")
def api_auth_me():
    data = _proxy_schedule_api("/api/auth/me")
    if data:
        return jsonify(data)
    return jsonify({"loggedIn": False, "email": "", "name": ""})


@app.route("/api/auth/config")
def api_auth_config():
    data = _proxy_schedule_api("/api/auth/config", with_cookie=False)
    if data:
        return jsonify(data)
    return jsonify({"authMode": "google", "googleEnabled": False})


@app.route("/api/player/nickname", methods=["GET"])
def api_player_nickname_get():
    user = _auth_user()
    email = str(user.get("email") or "").strip()
    if not email:
        return jsonify({"loggedIn": False, "nickname": ""})
    nick = _nickname_registry().get_nickname(email)
    return jsonify({"loggedIn": True, "email": email, "nickname": nick})


@app.route("/api/player/nickname", methods=["PUT"])
def api_player_nickname_put():
    user = _auth_user()
    email = str(user.get("email") or "").strip()
    if not email:
        return jsonify({"error": "login_required", "message": "로그인이 필요합니다."}), 401
    body = request.get_json(silent=True) or {}
    try:
        nick = _nickname_registry().claim(email, str(body.get("nickname") or ""))
    except NicknameRejected as exc:
        return _nickname_error_response(exc)
    return jsonify({"ok": True, "nickname": nick})


@app.route("/api/player/nickname/check")
def api_player_nickname_check():
    user = _auth_user()
    email = str(user.get("email") or "").strip()
    q = str(request.args.get("q") or request.args.get("nickname") or "")
    return jsonify(_nickname_registry().check(q, email))


@app.route("/api/lobby")
def api_lobby():
    return jsonify({"rooms": _hub.list_public_rooms(), "updatedAt": utc_now()})


@app.route("/api/lobby/events")
def api_lobby_events():
    return _sse_response(_hub.stream_lobby())


@app.route("/api/leaderboard/events")
def api_leaderboard_events():
    return _sse_response(_lb_events.stream())


@app.route("/api/leaderboard/revisions")
def api_leaderboard_revisions():
    return jsonify(_lb_events.snapshot())


@app.route("/api/rooms", methods=["POST"])
def api_create_room():
    body = request.get_json(silent=True) or {}
    user = _auth_user()
    try:
        nickname = _resolve_player_nickname(body, user)
    except NicknameRejected as exc:
        return _nickname_error_response(exc)
    try:
        room, token, room_id = _hub.create_room(
            game=str(body.get("game") or "minesweeper"),
            visibility=str(body.get("visibility") or "public"),
            label=str(body.get("label") or ""),
            nickname=nickname,
            difficulty=str(body.get("difficulty") or "medium"),
            rows=body.get("rows"),
            cols=body.get("cols"),
            mines=body.get("mines"),
            map_mode=str(body.get("mapMode") or "shared"),
            play_mode=str(body.get("playMode") or "classic"),
            duration_key=str(body.get("durationKey") or "standard"),
            goal_tile=body.get("goalTile"),
            room_mode=str(body.get("roomMode") or "standard"),
            user_email=user["email"],
            user_name=user["name"],
        )
    except NicknameRejected as exc:
        return _nickname_error_response(exc)
    except Exception as exc:
        return jsonify({"error": "create_failed", "message": str(exc)}), 500
    resp = jsonify({"room": room, "playerToken": token, "roomId": room_id, "playerId": room["hostId"]})
    resp.set_cookie("mg_player", token, httponly=True, samesite="Lax", max_age=60 * 60 * 24 * 7)
    return resp, 201


@app.route("/api/rooms/join", methods=["POST"])
def api_join_room():
    body = request.get_json(silent=True) or {}
    user = _auth_user()
    token = str(body.get("playerToken") or _player_token())
    try:
        nickname = _resolve_player_nickname(body, user)
    except NicknameRejected as exc:
        return _nickname_error_response(exc)
    result = _hub.join_room(
        room_id=str(body.get("roomId") or ""),
        code=str(body.get("code") or "").upper(),
        nickname=nickname,
        token=token,
        user_email=user["email"],
        user_name=user["name"],
        spectate=bool(body.get("spectate")),
    )
    if isinstance(result, dict) and result.get("error"):
        return jsonify(result), 400
    room, new_token = result
    ref = _hub.resolve_token(new_token)
    player_id = ref[1] if ref else ""
    resp = jsonify({"room": room, "playerToken": new_token, "playerId": player_id})
    resp.set_cookie("mg_player", new_token, httponly=True, samesite="Lax", max_age=60 * 60 * 24 * 7)
    return resp


@app.route("/api/rooms/<room_id>")
def api_get_room(room_id: str):
    token = _player_token()
    room = _hub.get_room_by_token(room_id, token) if token else None
    player_id = ""
    if token:
        ref = _hub.resolve_token(token)
        if ref and ref[0] == room_id:
            player_id = ref[1]
    if not room:
        internal = _hub.get_room_internal(room_id)
        if not internal:
            return jsonify({"error": "not_found"}), 404
        if internal["visibility"] != "public":
            return jsonify({"error": "forbidden", "message": "비밀방은 코드 또는 초대 링크로 참가하세요."}), 403
        from minigames_hub import _public_room

        room = _public_room(internal)
    payload = {"room": room}
    if player_id:
        payload["playerId"] = player_id
    return jsonify(payload)


@app.route("/api/rooms/<room_id>/events")
def api_room_events(room_id: str):
    if not _hub.get_room_internal(room_id):
        return jsonify({"error": "not_found"}), 404
    token = _player_token()
    return _sse_response(_hub.stream_room(room_id, token=token))


@app.route("/api/rooms/<room_id>/ping", methods=["POST"])
def api_room_ping(room_id: str):
    token = _player_token()
    if not token:
        return jsonify({"error": "unauthorized"}), 401
    result = _hub.ping_room(room_id, token)
    if not result:
        return jsonify({"error": "forbidden"}), 403
    return jsonify({"room": result})


@app.route("/api/rooms/<room_id>/leave", methods=["POST"])
def api_leave_room(room_id: str):
    token = _player_token()
    if not token:
        return jsonify({"error": "unauthorized"}), 401
    result = _hub.leave_room(room_id, token)
    if result is None:
        return jsonify({"error": "not_found"}), 404
    if isinstance(result, dict) and result.get("error"):
        return jsonify(result), 403
    resp = jsonify({"room": result} if not result.get("deleted") else {"deleted": True})
    if result.get("deleted"):
        resp.delete_cookie("mg_player")
    return resp


@app.route("/api/rooms/<room_id>/ready", methods=["POST"])
def api_room_ready(room_id: str):
    token = _player_token()
    body = request.get_json(silent=True) or {}
    result = _hub.set_ready(room_id, token, bool(body.get("ready")))
    if not result:
        return jsonify({"error": "forbidden"}), 403
    return jsonify({"room": result})


@app.route("/api/rooms/<room_id>/settings", methods=["PATCH"])
def api_room_settings(room_id: str):
    token = _player_token()
    body = request.get_json(silent=True) or {}
    result = _hub.update_room_settings(room_id, token, settings=body)
    if not result:
        return jsonify({"error": "forbidden"}), 403
    if isinstance(result, dict) and result.get("error"):
        return jsonify(result), 400
    return jsonify({"room": result})


@app.route("/api/rooms/<room_id>/start", methods=["POST"])
def api_room_start(room_id: str):
    token = _player_token()
    body = request.get_json(silent=True) or {}
    result = _hub.start_game(room_id, token, force=bool(body.get("force")))
    if not result:
        return jsonify({"error": "forbidden"}), 403
    if isinstance(result, dict) and result.get("error"):
        return jsonify(result), 400
    return jsonify({"room": result})


@app.route("/api/rooms/<room_id>/score", methods=["POST"])
def api_room_score(room_id: str):
    token = _player_token()
    body = request.get_json(silent=True) or {}
    result = _hub.post_score(
        room_id,
        token,
        score=int(body.get("score") or 0),
        finished=bool(body.get("finished")),
        won=bool(body.get("won")),
        elapsed_sec=body.get("elapsedSec"),
        max_tile=body.get("maxTile"),
        move_count=body.get("moveCount"),
        board_view=body.get("boardView"),
        round_submit=body.get("roundSubmit"),
        round_submit_draft=body.get("roundSubmitDraft"),
    )
    if not result:
        return jsonify({"error": "forbidden"}), 403
    if isinstance(result, dict) and result.get("error"):
        return jsonify(result), 400
    return jsonify({"room": result})


@app.route("/api/rooms/<room_id>/move", methods=["POST"])
def api_room_move(room_id: str):
    token = _player_token()
    body = request.get_json(silent=True) or {}
    try:
        row = int(body.get("row"))
        col = int(body.get("col"))
    except (TypeError, ValueError):
        return jsonify({"error": "invalid", "message": "row, col이 필요합니다."}), 400
    result = _hub.post_move(room_id, token, row=row, col=col)
    if not result:
        return jsonify({"error": "forbidden"}), 403
    if isinstance(result, dict) and result.get("error"):
        return jsonify(result), 400
    return jsonify({"room": result})


@app.route("/api/gomoku/queue", methods=["GET", "POST", "DELETE"])
def api_gomoku_queue():
    if request.method == "GET":
        return jsonify(_hub.gomoku_queue_status())
    user = _auth_user()
    if request.method == "DELETE":
        body = request.get_json(silent=True) or {}
        queue_token = str(body.get("queueToken") or request.args.get("queueToken") or "")
        return jsonify(_hub.gomoku_queue_leave(queue_token))
    body = request.get_json(silent=True) or {}
    try:
        nickname = _resolve_player_nickname(body, user)
    except NicknameRejected as exc:
        return _nickname_error_response(exc)
    result = _hub.gomoku_queue_join(
        nickname=nickname,
        user_email=user["email"],
        user_name=user["name"],
        queue_token=str(body.get("queueToken") or ""),
    )
    if result.get("error"):
        return jsonify(result), 400
    if result.get("status") == "matched":
        resp = jsonify(result)
        if result.get("playerToken"):
            resp.set_cookie("mg_player", result["playerToken"], httponly=True, samesite="Lax", max_age=60 * 60 * 24 * 7)
        return resp
    return jsonify(result)


@app.route("/api/rooms/<room_id>/lobby", methods=["POST"])
def api_room_lobby(room_id: str):
    token = _player_token()
    result = _hub.return_to_lobby(room_id, token)
    if not result:
        return jsonify({"error": "forbidden"}), 403
    if isinstance(result, dict) and result.get("error"):
        return jsonify(result), 400
    return jsonify({"room": result})


@app.route("/api/rooms/<room_id>/kick", methods=["POST"])
def api_room_kick(room_id: str):
    token = _player_token()
    body = request.get_json(silent=True) or {}
    result = _hub.kick_player(room_id, token, body.get("playerId") or body.get("player_id") or "")
    if not result:
        return jsonify({"error": "forbidden"}), 403
    if isinstance(result, dict) and result.get("error"):
        return jsonify(result), 400
    return jsonify({"room": result})


@app.route("/api/rooms/<room_id>/dismiss", methods=["POST"])
def api_room_dismiss(room_id: str):
    token = _player_token()
    result = _hub.dismiss_all_players(room_id, token)
    if not result:
        return jsonify({"error": "forbidden"}), 403
    if isinstance(result, dict) and result.get("error"):
        return jsonify(result), 400
    return jsonify({"room": result})


def _leaderboard_query_args() -> tuple[str, str | None]:
    period = normalize_period(request.args.get("period") or "all")
    month_at = None
    if period == "month":
        month_at = normalize_month_at(request.args.get("at") or request.args.get("month"))
    return period, month_at


@app.route("/api/hub/feed", methods=["GET"])
def api_hub_feed():
    return jsonify(_hub_feed.build())


@app.route("/api/minesweeper/leaderboard", methods=["GET"])
def api_minesweeper_leaderboard_get():
    tier = normalize_rank_tier(request.args.get("tier") or request.args.get("board") or "standard")
    period, month_at = _leaderboard_query_args()
    meta = rank_board_spec(tier)
    raw = _leaderboard.raw_entries(tier)
    period_meta = leaderboard_period_meta(raw, period, month_at)
    return jsonify(
        {
            **meta,
            **period_meta,
            "entries": _leaderboard.list_top(tier, period, month_at),
            "updatedAt": utc_now(),
        }
    )


@app.route("/api/minesweeper/leaderboard", methods=["POST"])
def api_minesweeper_leaderboard_post():
    body = request.get_json(silent=True) or {}
    tier = normalize_rank_tier(body.get("tier") or body.get("board") or "standard")
    display_name, nick_err = _leaderboard_display_name_from_body(body)
    if nick_err:
        return _nickname_error_response(nick_err)
    result = _leaderboard.submit(
        tier=tier,
        score=int(body.get("score") or 0),
        elapsed_sec=int(body.get("elapsedSec") or body.get("elapsed_sec") or 0),
        revealed=int(body.get("revealed") or 0),
        won=bool(body.get("won")),
        display_name=display_name,
    )
    if result.get("error"):
        return jsonify(result), 400
    if result.get("registered"):
        _on_rank_registered("minesweeper", tier, result)
    return jsonify(result)


@app.route("/api/minesweeper/leaderboard/<entry_id>", methods=["DELETE"])
def api_minesweeper_leaderboard_delete(entry_id: str):
    if not _auth_can_edit():
        return jsonify({"error": "forbidden", "message": "권한이 없습니다."}), 403
    tier = normalize_rank_tier(request.args.get("tier") or request.args.get("board") or "standard")
    result = _leaderboard.delete_entry(tier, entry_id)
    if result.get("error") == "not_found":
        return jsonify(result), 404
    if result.get("error"):
        return jsonify(result), 400
    _notify_leaderboard_change("minesweeper")
    return jsonify(result)


@app.route("/api/apple/leaderboard", methods=["GET"])
def api_apple_leaderboard_get():
    mode = normalize_apple_mode(request.args.get("mode") or request.args.get("durationKey") or "standard")
    period, month_at = _leaderboard_query_args()
    meta = apple_mode_spec(mode)
    raw = _apple_leaderboard.raw_entries(mode)
    period_meta = leaderboard_period_meta(raw, period, month_at)
    return jsonify(
        {
            **meta,
            **period_meta,
            "entries": _apple_leaderboard.list_top(mode, period, month_at),
            "updatedAt": utc_now(),
        }
    )


@app.route("/api/apple/leaderboard", methods=["POST"])
def api_apple_leaderboard_post():
    body = request.get_json(silent=True) or {}
    mode = normalize_apple_mode(body.get("mode") or body.get("durationKey") or "standard")
    display_name, nick_err = _leaderboard_display_name_from_body(body)
    if nick_err:
        return _nickname_error_response(nick_err)
    result = _apple_leaderboard.submit(
        mode=mode,
        score=int(body.get("score") or 0),
        elapsed_sec=int(body.get("elapsedSec") or body.get("elapsed_sec") or 0),
        display_name=display_name,
    )
    if result.get("error"):
        return jsonify(result), 400
    if result.get("registered"):
        _on_rank_registered("apple", mode, result)
    return jsonify(result)


@app.route("/api/apple/leaderboard/<entry_id>", methods=["DELETE"])
def api_apple_leaderboard_delete(entry_id: str):
    if not _auth_can_edit():
        return jsonify({"error": "forbidden", "message": "권한이 없습니다."}), 403
    mode = normalize_apple_mode(request.args.get("mode") or request.args.get("durationKey") or "standard")
    result = _apple_leaderboard.delete_entry(mode, entry_id)
    if result.get("error") == "not_found":
        return jsonify(result), 404
    if result.get("error"):
        return jsonify(result), 400
    _notify_leaderboard_change("apple")
    return jsonify(result)


@app.route("/api/colortiles/leaderboard", methods=["GET"])
def api_colortiles_leaderboard_get():
    mode = normalize_colortiles_mode(
        request.args.get("mode") or request.args.get("durationKey") or "minute"
    )
    period, month_at = _leaderboard_query_args()
    meta = colortiles_mode_spec(mode)
    raw = _colortiles_leaderboard.raw_entries(mode)
    period_meta = leaderboard_period_meta(raw, period, month_at)
    return jsonify(
        {
            **meta,
            **period_meta,
            "entries": _colortiles_leaderboard.list_top(mode, period, month_at),
            "updatedAt": utc_now(),
        }
    )


@app.route("/api/colortiles/leaderboard", methods=["POST"])
def api_colortiles_leaderboard_post():
    body = request.get_json(silent=True) or {}
    raw_mode = body.get("mode") or body.get("durationKey") or "minute"
    if not is_ranked_colortiles_mode(raw_mode):
        return jsonify(
            {
                "error": "not_ranked",
                "message": "기본(2분) 모드는 랭킹에 등록되지 않습니다. 1분 또는 스피드런만 등록됩니다.",
            }
        ), 400
    mode = normalize_colortiles_mode(raw_mode)
    display_name, nick_err = _leaderboard_display_name_from_body(body)
    if nick_err:
        return _nickname_error_response(nick_err)
    result = _colortiles_leaderboard.submit(
        mode=mode,
        score=int(body.get("score") or 0),
        elapsed_sec=int(body.get("elapsedSec") or body.get("elapsed_sec") or 0),
        display_name=display_name,
        cleared=bool(body.get("cleared")),
    )
    if result.get("error"):
        return jsonify(result), 400
    if result.get("registered"):
        _on_rank_registered("colortiles", mode, result)
    return jsonify(result)


@app.route("/api/colortiles/leaderboard/<entry_id>", methods=["DELETE"])
def api_colortiles_leaderboard_delete(entry_id: str):
    if not _auth_can_edit():
        return jsonify({"error": "forbidden", "message": "권한이 없습니다."}), 403
    mode = normalize_colortiles_mode(
        request.args.get("mode") or request.args.get("durationKey") or "minute"
    )
    result = _colortiles_leaderboard.delete_entry(mode, entry_id)
    if result.get("error") == "not_found":
        return jsonify(result), 404
    if result.get("error"):
        return jsonify(result), 400
    _notify_leaderboard_change("colortiles")
    return jsonify(result)


@app.route("/api/hide/leaderboard", methods=["GET"])
def api_hide_leaderboard_get():
    mode = normalize_hide_mode(request.args.get("mode") or "standard")
    period, month_at = _leaderboard_query_args()
    meta = hide_mode_spec(mode)
    raw = _hide_leaderboard.raw_entries(mode)
    period_meta = leaderboard_period_meta(raw, period, month_at)
    return jsonify(
        {
            **meta,
            **period_meta,
            "entries": _hide_leaderboard.list_top(mode, period, month_at),
            "updatedAt": utc_now(),
        }
    )


@app.route("/api/2048/leaderboard", methods=["GET"])
def api_2048_leaderboard_get():
    mode = normalize_2048_mode(request.args.get("mode") or request.args.get("durationKey") or "standard")
    period, month_at = _leaderboard_query_args()
    meta = tile2048_mode_spec(mode)
    raw = _tile2048_leaderboard.raw_entries(mode)
    period_meta = leaderboard_period_meta(raw, period, month_at)
    return jsonify(
        {
            **meta,
            **period_meta,
            "entries": _tile2048_leaderboard.list_top(mode, period, month_at),
            "updatedAt": utc_now(),
        }
    )


@app.route("/api/2048/leaderboard", methods=["POST"])
def api_2048_leaderboard_post():
    body = request.get_json(silent=True) or {}
    mode = normalize_2048_mode(body.get("mode") or body.get("durationKey") or "standard")
    display_name, nick_err = _leaderboard_display_name_from_body(body)
    if nick_err:
        return _nickname_error_response(nick_err)
    result = _tile2048_leaderboard.submit(
        mode=mode,
        max_tile=int(body.get("maxTile") or body.get("max_tile") or 0),
        score=int(body.get("score") or 0),
        move_count=int(body.get("moveCount") or body.get("move_count") or 0),
        display_name=display_name,
    )
    if result.get("error"):
        return jsonify(result), 400
    if result.get("registered"):
        _on_rank_registered("2048", mode, result)
    return jsonify(result)


@app.route("/api/2048/leaderboard/<entry_id>", methods=["DELETE"])
def api_2048_leaderboard_delete(entry_id: str):
    if not _auth_can_edit():
        return jsonify({"error": "forbidden", "message": "권한이 없습니다."}), 403
    mode = normalize_2048_mode(request.args.get("mode") or request.args.get("durationKey") or "standard")
    result = _tile2048_leaderboard.delete_entry(mode, entry_id)
    if result.get("error") == "not_found":
        return jsonify(result), 404
    if result.get("error"):
        return jsonify(result), 400
    _notify_leaderboard_change("2048")
    return jsonify(result)


@app.route("/api/hide/leaderboard", methods=["POST"])
def api_hide_leaderboard_post():
    body = request.get_json(silent=True) or {}
    mode = normalize_hide_mode(body.get("mode") or "standard")
    display_name, nick_err = _leaderboard_display_name_from_body(body)
    if nick_err:
        return _nickname_error_response(nick_err)
    result = _hide_leaderboard.submit(
        mode=mode,
        score=float(body.get("score") or 0),
        display_name=display_name,
    )
    if result.get("error"):
        return jsonify(result), 400
    if result.get("registered"):
        _on_rank_registered("hide", mode, result)
    return jsonify(result)


@app.route("/api/hide/leaderboard/<entry_id>", methods=["DELETE"])
def api_hide_leaderboard_delete(entry_id: str):
    if not _auth_can_edit():
        return jsonify({"error": "forbidden", "message": "권한이 없습니다."}), 403
    mode = normalize_hide_mode(request.args.get("mode") or "standard")
    result = _hide_leaderboard.delete_entry(mode, entry_id)
    if result.get("error") == "not_found":
        return jsonify(result), 404
    if result.get("error"):
        return jsonify(result), 400
    _notify_leaderboard_change("hide")
    return jsonify(result)


_SITE_JS = frozenset({"schedule-base.js", "pwa-head.js"})


@app.route("/css/<path:subpath>")
def site_css(subpath: str):
    mg_css = MINIGAMES_DIR / "css" / subpath
    if mg_css.is_file():
        return send_from_directory(MINIGAMES_DIR / "css", subpath)
    return send_from_directory(BASE_DIR / "css", subpath)


@app.route("/js/<path:subpath>")
def site_js(subpath: str):
    mg_js = MINIGAMES_DIR / "js" / subpath
    if mg_js.is_file():
        return send_from_directory(MINIGAMES_DIR / "js", subpath)
    if subpath in _SITE_JS:
        return send_from_directory(BASE_DIR / "js", subpath)
    return jsonify({"error": "not_found"}), 404


@app.route("/")
def index():
    return _serve_html_file(MINIGAMES_DIR, "index.html", request_path="")


@app.route("/<path:path>")
def static_files(path: str):
    if path.startswith("api/"):
        return jsonify({"error": "not_found"}), 404

    path = path.strip("/")
    root = MINIGAMES_DIR.resolve()
    if not path:
        return _serve_html_file(MINIGAMES_DIR, "index.html", request_path="")

    candidate = (MINIGAMES_DIR / path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return jsonify({"error": "not_found"}), 404

    if candidate.is_file():
        if candidate.suffix.lower() == ".html":
            return _serve_html_file(candidate.parent, candidate.name, request_path=path)
        return send_from_directory(MINIGAMES_DIR, str(candidate.relative_to(root)))

    index = candidate / "index.html"
    if index.is_file():
        return _serve_html_file(candidate, "index.html", request_path=path)

    return jsonify({"error": "not_found"}), 404


if __name__ == "__main__":
    _ensure_data_dir()
    print(f"minigames http://127.0.0.1:{PORT}/")
    app.run(host="127.0.0.1", port=PORT, debug=True)
