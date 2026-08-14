#!/usr/bin/env python3
"""방종 엔딩 크레딧 — 메인 server.py와 분리 (숲 Chat SDK 전용).

로컬: ./venv/bin/python credits_server.py  → http://127.0.0.1:8017/
서버: ./restart.sh credits
공개: https://sirian-cal.com/ending/  (nginx → 8017)
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, make_response, redirect, request, send_from_directory
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer


from credits_collector_presence import VALID_SOURCES, get_presence_store
from credits_ingest_activity import get_ingest_activity_store
from credits_overlay import OverlayConfigStore
from credits_obs_link import ObsLinkStore
from credits_schedule import build_next_day_schedule
from credits_vod_replay import build_replay_context
from credits_store import (
    CreditsStore,
    apply_signature_amounts_to_payload,
    apply_peak_viewers_to_series,
    chat_metrics_series_for_session,
    align_viewer_chat_metrics,
    normalize_metric_series,
    compact_metrics_series,
    build_demo_credits_payload,
    coalesce_session_user_aliases,
    collector_segments_for_monitor,
    format_duration,
    format_kst_clock,
    format_watch,
    chatter_watch_ms,
    normalize_soop_user_id,
    parse_iso,
    parse_signature_amounts,
    serialize_donation_notes,
    serialize_mission_runs,
    serialize_ssapi_assist,
    session_metrics_end_at,
)

BASE_DIR = Path(__file__).resolve().parent
ENDING_DIR = BASE_DIR / "ending"
DATA_DIR = BASE_DIR / "data"
SEED_CREDITS = BASE_DIR / "seed" / "credits.json"
SEED_OVERLAY = BASE_DIR / "seed" / "credits-overlay.json"
SEED_SCHEDULE = BASE_DIR / "seed" / "schedule.json"
SCHEDULE_PATH = DATA_DIR / "schedule.json"
CREDITS_SESSION_PATH = DATA_DIR / "credits-session.json"
CREDITS_RAW_DIR = DATA_DIR / "credits-raw"
CREDITS_PATH = DATA_DIR / "credits.json"
CREDITS_OVERLAY_DIR = DATA_DIR / "credits-overlay"
CREDITS_OVERLAY_LEGACY = DATA_DIR / "credits-overlay.json"
CREDITS_OBS_LINKS_PATH = DATA_DIR / "credits-obs-links.json"
SSAPI_STATUS_PATH = Path(
    os.environ.get("SSAPI_STATUS_PATH") or (DATA_DIR / "credits-ssapi-status.json")
)

PORT = int(os.environ.get("CREDITS_PORT", "8017"))
STATION_ID = (
    os.environ.get("CREDITS_SOOP_STATION_ID")
    or os.environ.get("LINKS_SOOP_STATION_ID")
    or "sirianrain"
).strip()

SOOP_FETCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; sirian-credits/1.0)",
    "Accept": "application/json",
    "Referer": "https://play.sooplive.co.kr/",
}

# 시그니처 별풍(시그풍) 목록 캐시 — stationId → (fetched_at, items)
_signature_balloon_cache: dict[str, tuple[float, list[dict]]] = {}
_signature_balloon_cache_lock = threading.Lock()
_SIGNATURE_BALLOON_TTL_SEC = 1800.0

# access_token → (fetched_at, station_id) — ingest 연타 시 stationinfo 부담 완화
_soop_identity_cache: dict[str, tuple[float, str]] = {}
_soop_identity_cache_lock = threading.Lock()
_SOOP_IDENTITY_TTL_SEC = 60.0

app = Flask(__name__)


def _load_dotenv() -> None:
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, _, val = text.partition("=")
        key = key.strip()
        if not key or key in os.environ:
            continue
        os.environ[key] = val.strip().strip('"').strip("'")


_load_dotenv()

# 메인 사이트와 동일 SECRET_KEY로 쿠키 서명 (Google 세션과 무관 — 숲 허용 ID 표시용)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-insecure-change-me")
ENDING_SOOP_COOKIE = "ending_soop_station"
ENDING_SOOP_COOKIE_MAX_AGE = int(os.environ.get("CREDITS_SOOP_COOKIE_DAYS", "30") or 30) * 86400


def _soop_cookie_serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(str(app.config["SECRET_KEY"]), salt="ending-soop-station-v1")


def _set_ending_soop_cookie(resp: Response, station_id: str) -> Response:
    sid = str(station_id or "").strip().lower()
    if not sid or not _looks_like_soop_user_id(sid) or not _ending_staff_station(sid):
        return resp
    token = _soop_cookie_serializer().dumps({"stationId": sid})
    secure = os.environ.get("SESSION_COOKIE_SECURE", "").lower() in ("1", "true", "yes")
    resp.set_cookie(
        ENDING_SOOP_COOKIE,
        token,
        max_age=ENDING_SOOP_COOKIE_MAX_AGE,
        httponly=True,
        samesite="Lax",
        secure=secure,
        path="/",
    )
    return resp


def _clear_ending_soop_cookie(resp: Response) -> Response:
    secure = os.environ.get("SESSION_COOKIE_SECURE", "").lower() in ("1", "true", "yes")
    resp.set_cookie(
        ENDING_SOOP_COOKIE,
        "",
        max_age=0,
        expires=0,
        httponly=True,
        samesite="Lax",
        secure=secure,
        path="/",
    )
    return resp


def _ending_soop_cookie_station() -> str:
    raw = (request.cookies.get(ENDING_SOOP_COOKIE) or "").strip()
    if not raw:
        return ""
    try:
        data = _soop_cookie_serializer().loads(raw, max_age=ENDING_SOOP_COOKIE_MAX_AGE)
    except (BadSignature, SignatureExpired, TypeError, ValueError):
        return ""
    if not isinstance(data, dict):
        return ""
    sid = str(data.get("stationId") or "").strip().lower()
    if not _looks_like_soop_user_id(sid) or not _ending_staff_station(sid):
        return ""
    return sid


def _ending_staff_html_forbidden():
    """허용·오버레이 개발 숲 계정 쿠키 없음 → 수집기(로그인)로."""
    base = (os.environ.get("CREDITS_PUBLIC_PATH") or "/ending").rstrip("/") or "/ending"
    return redirect(f"{base}/?need=soop", code=302)


@app.before_request
def _ending_soop_page_gate():
    """스튜디오·일기장·개발자 모니터 HTML 게이트."""
    path = request.path or "/"
    # nginx 가 /ending/ → / 로 프록시하므로 여기선 /studio, /diary, /dev
    if path in ("/studio", "/studio/", "/diary", "/diary/"):
        if _ending_soop_cookie_station():
            return None
        return _ending_staff_html_forbidden()
    if path in ("/dev", "/dev/", "/dev/me", "/dev/me/"):
        sid = _ending_soop_cookie_station()
        if sid and _is_overlay_dev(sid):
            return None
        # 오버레이 개발자만 — 스태프여도 개발자 목록이 아니면 수집기로
        return _ending_staff_html_forbidden()
    if path in ("/live_data", "/live_data/"):
        # 공개 HTML — 숲 로그인·권한은 API·클라이언트 게이트
        return None
    return None


def _looks_like_soop_user_id(value: str) -> bool:
    """SOOP 채널 ID(영문 로그인 id). 한글 닉네임·공백은 라이브 API에 쓸 수 없다."""
    s = str(value or "").strip()
    if not s or len(s) > 64 or " " in s:
        return False
    # 순수 숫자(station_no)는 채널 로그인 id가 아님
    if s.isdigit():
        return False
    return bool(re.fullmatch(r"[A-Za-z0-9_.\-]+", s))


def _station_id_from_jwt(access_token: str) -> str:
    """access_token이 JWT면 payload에서 로그인 id 후보를 뽑는다(서명 검증 없음)."""
    token = str(access_token or "").strip()
    parts = token.split(".")
    if len(parts) < 2:
        return ""
    try:
        import base64

        pad = "=" * (-len(parts[1]) % 4)
        raw = base64.urlsafe_b64decode(parts[1] + pad)
        payload = json.loads(raw.decode("utf-8", "replace"))
    except (ValueError, json.JSONDecodeError, OSError):
        return ""
    if not isinstance(payload, dict):
        return ""
    for key in (
        "user_id",
        "userId",
        "bj_id",
        "bjId",
        "login_id",
        "loginId",
        "streamer_id",
        "streamerId",
        "station_id",
        "stationId",
        "preferred_username",
        "username",
        "sub",
    ):
        cand = str(payload.get(key) or "").strip()
        if _looks_like_soop_user_id(cand):
            return cand
    return ""


def _walk_station_id(obj: Any, *, depth: int = 0) -> str:
    """중첩 JSON에서 로그인 id처럼 보이는 값을 찾는다."""
    if depth > 6:
        return ""
    if isinstance(obj, dict):
        priority_keys = (
            "user_id",
            "userId",
            "bj_id",
            "bjId",
            "login_id",
            "loginId",
            "streamer_id",
            "streamerId",
            "station_id",
            "stationId",
            "channel_id",
            "channelId",
        )
        for key in priority_keys:
            if key in obj:
                cand = str(obj.get(key) or "").strip()
                if _looks_like_soop_user_id(cand):
                    return cand
        for key, val in obj.items():
            kl = str(key).lower()
            if kl in {k.lower() for k in priority_keys} or kl.endswith("_id") or kl.endswith("id"):
                cand = str(val or "").strip() if not isinstance(val, (dict, list)) else ""
                if _looks_like_soop_user_id(cand):
                    return cand
            if isinstance(val, (dict, list)):
                found = _walk_station_id(val, depth=depth + 1)
                if found:
                    return found
    elif isinstance(obj, list):
        for item in obj[:30]:
            found = _walk_station_id(item, depth=depth + 1)
            if found:
                return found
    return ""


def _normalize_soop_image_url(raw: str) -> str:
    url = str(raw or "").strip()
    if not url:
        return ""
    if url.startswith("//"):
        return f"https:{url}"
    if url.startswith("http://"):
        return "https://" + url[len("http://") :]
    return url


def _station_id_from_profile_image(raw: str) -> str:
    """stationinfo가 user_id를 안 줄 때 프로필 이미지 경로에서 로그인 id를 뽑는다.

    예: https://profile.img.sooplive.com/LOGO/dl/dlpa37/dlpa37.jpg → dlpa37
    """
    url = _normalize_soop_image_url(raw)
    if not url:
        return ""
    # /LOGO/{prefix2}/{user_id}/{user_id}.(jpg|png|…)
    m = re.search(
        r"/LOGO/[A-Za-z0-9]{1,4}/([A-Za-z0-9_.\-]+)/\1\.(?:jpe?g|png|gif|webp)(?:\?|$)",
        url,
        re.I,
    )
    if m and _looks_like_soop_user_id(m.group(1)):
        return m.group(1)
    # 폴백: 경로 끝에서 파일명 stem이 직전 세그먼트와 같으면 그 id
    try:
        path = urllib.parse.urlparse(url).path
    except Exception:
        return ""
    parts = [p for p in path.split("/") if p]
    if len(parts) >= 2:
        stem = parts[-1].rsplit(".", 1)[0]
        if stem and stem == parts[-2] and _looks_like_soop_user_id(stem):
            return stem
    return ""


def fetch_soop_signature_balloons(station_id: str, *, force: bool = False) -> list[dict]:
    """BJ 등록 시그니처 별풍 개수·이미지 (공개 API, 로그인 불필요).

    SOOP live player가 쓰는 get_balloon_storytelling_info.php.
    gift_starballoon.php 스테이션 페이지는 로그인 리다이렉트라 서버에서 못 긁음.
    """
    sid = str(station_id or "").strip()
    if not sid or not _looks_like_soop_user_id(sid):
        return []
    now = time.time()
    cached: tuple[float, list[dict]] | None = None
    with _signature_balloon_cache_lock:
        cached = _signature_balloon_cache.get(sid)
        if (
            not force
            and cached
            and (now - cached[0]) < _SIGNATURE_BALLOON_TTL_SEC
        ):
            return [dict(item) for item in cached[1]]

    api_url = (
        "https://live.sooplive.co.kr/api/get_balloon_storytelling_info.php?"
        + urllib.parse.urlencode({"szBjId": sid})
    )
    req = urllib.request.Request(api_url, headers=SOOP_FETCH_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, ValueError):
        if cached:
            return [dict(item) for item in cached[1]]
        return []

    if not isinstance(payload, dict):
        return []
    # jsonp 없이 호출하면 result 가 1, mainBalloons.list 에 시그풍
    main = payload.get("mainBalloons") if isinstance(payload.get("mainBalloons"), dict) else {}
    if not main.get("isSignatureBalloon"):
        items: list[dict] = []
    else:
        raw_list = main.get("list") if isinstance(main.get("list"), list) else []
        items = []
        seen: set[int] = set()
        for row in raw_list:
            if not isinstance(row, dict):
                continue
            try:
                amount = int(row.get("number") or row.get("amount") or 0)
            except (TypeError, ValueError):
                continue
            if amount < 1 or amount > 1_000_000 or amount in seen:
                continue
            img = _normalize_soop_image_url(
                str(row.get("imageUrl") or row.get("image_url") or "")
            )
            seen.add(amount)
            items.append({"amount": amount, "imageUrl": img})
        items.sort(key=lambda x: x["amount"])

    with _signature_balloon_cache_lock:
        _signature_balloon_cache[sid] = (now, items)
    return [dict(item) for item in items]


def _parse_int_field(raw: Any) -> int | None:
    try:
        if raw is None or raw == "":
            return None
        return int(raw)
    except (TypeError, ValueError):
        return None


def fetch_soop_live_status(station_id: str, *, probe: bool = False) -> dict:
    station_id = str(station_id or "").strip()
    empty = {
        "enabled": True,
        "isLive": False,
        "title": "",
        "viewerCount": 0,
        "upCount": None,
        "broadNo": "",
        "thumbnailUrl": "",
        "stationId": station_id,
        "balloonTop": [],
    }
    if not station_id:
        return empty
    api_url = f"https://chapi.sooplive.co.kr/api/{urllib.parse.quote(station_id)}/station"
    req = urllib.request.Request(api_url, headers=SOOP_FETCH_HEADERS)
    timeout = 3 if probe else 5
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return empty
    if not isinstance(payload, dict):
        return empty
    broad_raw = payload.get("broad")
    # 메인 server.py와 동일: broad 객체가 있으면 라이브
    is_live = isinstance(broad_raw, dict)
    broad = broad_raw if is_live else {}
    viewers = 0
    for key in (
        "currentSumViewer",
        "current_sum_viewer",
        "total_view_cnt",
        "viewCnt",
        "view_cnt",
        "viewer",
        "viewerCount",
        "pc_viewer",
        "mobile_viewer",
    ):
        raw = broad.get(key) if is_live else None
        try:
            viewers = max(viewers, int(raw or 0))
        except (TypeError, ValueError):
            continue
    up_count = None
    if is_live and not probe:
        for key in (
            "ok_cnt",
            "okCnt",
            "broad_ok_cnt",
            "broadOkCnt",
            "current_ok_cnt",
            "currentOkCnt",
            "up_cnt",
            "upCnt",
            "recommend_cnt",
            "recommendCnt",
        ):
            parsed = _parse_int_field(broad.get(key))
            if parsed is not None and parsed >= 0:
                up_count = parsed
                break
        if up_count is None:
            station_block = payload.get("station") if isinstance(payload.get("station"), dict) else {}
            upd = station_block.get("upd") if isinstance(station_block.get("upd"), dict) else {}
            if not upd and isinstance(payload.get("upd"), dict):
                upd = payload["upd"]
            for key in ("today0_ok_cnt", "today0OkCnt", "ok_cnt", "okCnt"):
                parsed = _parse_int_field(upd.get(key))
                if parsed is not None and parsed >= 0:
                    up_count = parsed
                    break
    broad_no = str((broad.get("broad_no") or broad.get("broadNo") or "") if is_live else "").strip()
    thumb = ""
    if is_live:
        for key in (
            "thumbnail_image_url",
            "thumbnailImageUrl",
            "broad_thumb",
            "broad_img",
            "thumb",
            "thumbnail",
            "snapshot",
        ):
            raw = broad.get(key)
            if isinstance(raw, str) and raw.strip():
                thumb = raw.strip()
                break
    if not thumb and broad_no:
        thumb = f"https://liveimg.sooplive.co.kr/m/{broad_no}"
    if thumb.startswith("//"):
        thumb = f"https:{thumb}"
    balloon_top: list[dict] = []
    if not probe:
        raw_top = payload.get("starballoon_top")
        if isinstance(raw_top, list):
            for item in raw_top:
                if not isinstance(item, dict):
                    continue
                user_id = str(item.get("user_id") or item.get("userId") or "").strip()
                if not user_id:
                    continue
                nick = str(
                    item.get("user_nick") or item.get("userNickname") or item.get("name") or user_id
                ).strip()[:40]
                balloon_top.append({"userId": user_id, "name": nick or user_id})
    # 라이브 중 방제는 broad_title만 — station_name fallback은 방제 깜빡임/오기록 원인
    title = ""
    if is_live:
        for key in ("broad_title", "broadTitle", "title"):
            raw_title = broad.get(key)
            if isinstance(raw_title, str) and raw_title.strip():
                title = raw_title.strip()
                break
    return {
        "enabled": True,
        "isLive": is_live,
        "title": title,
        "viewerCount": viewers,
        "upCount": up_count,
        "broadNo": broad_no,
        "thumbnailUrl": thumb,
        "stationId": station_id,
        "balloonTop": balloon_top,
    }


_vod_title_cache: dict[str, tuple[float, str]] = {}
_vod_title_cache_lock = threading.Lock()
_VOD_TITLE_HIT_TTL_SEC = 3600.0
_VOD_TITLE_MISS_TTL_SEC = 300.0


def _vod_item_matches_broad(item: dict[str, Any], broad_no: str) -> bool:
    want = str(broad_no or "").strip()
    if not want:
        return False
    ucc = item.get("ucc") if isinstance(item.get("ucc"), dict) else {}
    thumb = str(ucc.get("thumb") or "")
    return f"_{want}_" in thumb or want in thumb


def fetch_vod_title_no_for_broad(station_id: str, broad_no: str, *, max_pages: int = 5) -> str:
    """라이브 broadNo → VOD title_no (chapi review 목록 thumb rowKey 매칭)."""
    sid = str(station_id or "").strip().lower()
    bn = str(broad_no or "").strip()
    if not sid or not bn:
        return ""
    cache_key = f"{sid}:{bn}"
    now = time.time()
    with _vod_title_cache_lock:
        cached = _vod_title_cache.get(cache_key)
        if cached:
            ttl = _VOD_TITLE_HIT_TTL_SEC if cached[1] else _VOD_TITLE_MISS_TTL_SEC
            if now - cached[0] < ttl:
                return cached[1]

    found = ""
    for page in range(1, max(1, int(max_pages)) + 1):
        api_url = (
            f"https://chapi.sooplive.co.kr/api/{urllib.parse.quote(sid)}/vods/review"
            f"?page={page}&per_page=20&orderby=reg_date"
        )
        req = urllib.request.Request(
            api_url,
            headers={
                **SOOP_FETCH_HEADERS,
                "Referer": "https://www.sooplive.co.kr/",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                payload = json.loads(resp.read().decode("utf-8", errors="replace"))
        except (OSError, urllib.error.URLError, json.JSONDecodeError, ValueError):
            break
        rows = payload.get("data") if isinstance(payload.get("data"), list) else []
        if not rows:
            break
        for item in rows:
            if not isinstance(item, dict):
                continue
            if not _vod_item_matches_broad(item, bn):
                continue
            title_no = str(item.get("title_no") or "").strip()
            if title_no:
                found = title_no
                break
        if found or len(rows) < 20:
            break

    with _vod_title_cache_lock:
        _vod_title_cache[cache_key] = (now, found)
        if len(_vod_title_cache) > 128:
            _vod_title_cache.pop(next(iter(_vod_title_cache)))
    return found


_store: CreditsStore | None = None
_overlay_store: OverlayConfigStore | None = None
_obs_link_store: ObsLinkStore | None = None


def get_store() -> CreditsStore:
    global _store
    if _store is None:
        _store = CreditsStore(
            CREDITS_SESSION_PATH,
            CREDITS_PATH,
            station_id=STATION_ID,
            seed_path=SEED_CREDITS,
            live_fetcher=fetch_soop_live_status,
            poll_interval_sec=float(os.environ.get("CREDITS_POLL_INTERVAL_SEC", "10") or 10),
        )
        _store.ensure_files()
        if str(os.environ.get("CREDITS_POLLER", "1")).strip() not in ("0", "false", "no"):
            _store.start_poller()
    return _store


def get_overlay_store() -> OverlayConfigStore:
    global _overlay_store
    if _overlay_store is None:
        _overlay_store = OverlayConfigStore(
            CREDITS_OVERLAY_DIR,
            legacy_path=CREDITS_OVERLAY_LEGACY,
            seed_path=SEED_OVERLAY,
        )
    return _overlay_store


def get_obs_link_store() -> ObsLinkStore:
    global _obs_link_store
    if _obs_link_store is None:
        _obs_link_store = ObsLinkStore(CREDITS_OBS_LINKS_PATH)
    return _obs_link_store


def _obs_public_path(key: str, station_id: str = "") -> str:
    qs = urllib.parse.urlencode(
        {
            "obs": "1",
            "k": key,
            **({"stationId": station_id} if station_id else {}),
        }
    )
    return f"/ending/obs?{qs}"


def _resolve_station_for_obs_link(payload: dict) -> tuple[str, str | None]:
    """(station_id, error). 토큰 identity 우선, body stationId 폴백(allow-any)."""
    token = _extract_soop_access_token()
    if not token:
        token = str(payload.get("accessToken") or payload.get("access_token") or "").strip()
    if not token:
        return "", "token_required"
    station_id, err, _status = _soop_identity_from_token(token)
    if err == "soop_profile_empty" and _allow_any_soop_station():
        body_sid = str(payload.get("stationId") or payload.get("station_id") or "").strip()
        if _looks_like_soop_user_id(body_sid):
            station_id = body_sid.lower()
            err = ""
    if err:
        return "", err
    if not station_id:
        body_sid = str(payload.get("stationId") or payload.get("station_id") or "").strip()
        if _looks_like_soop_user_id(body_sid):
            station_id = body_sid.lower()
    if not station_id or not _looks_like_soop_user_id(station_id):
        return "", "station_id_required"
    if not _station_is_allowed(station_id) and not _is_overlay_dev(station_id):
        return station_id, "forbidden_station"
    return station_id.lower(), None


def _resolve_overlay_station_id(explicit: str | None = None) -> str:
    """오버레이 멘트·순서는 공통(shared). 라이브 집계 채널과 분리."""
    from credits_overlay import SHARED_CONFIG_ID

    return SHARED_CONFIG_ID


def _resolve_live_station_id(explicit: str | None = None) -> str:
    from credits_overlay import normalize_station_id

    sid = normalize_station_id(explicit)
    if sid not in ("default", "shared"):
        return sid
    bound = normalize_station_id(get_store().station_id)
    if bound not in ("default", "shared"):
        return bound
    return normalize_station_id(STATION_ID)


def _ingest_authorized() -> bool:
    """하위 호환 별칭 — 수집/저장은 _collector_authorized 사용."""
    return _collector_authorized()


def _allow_any_soop_station() -> bool:
    """CREDITS_ALLOWED_STATION_IDS=*|any|all → 로그인한 본인 채널 전부 허용."""
    raw = (os.environ.get("CREDITS_ALLOWED_STATION_IDS") or "").strip().lower()
    if not raw:
        return False
    parts = {p.strip() for p in re.split(r"[,，\s]+", raw) if p.strip()}
    return bool(parts & {"*", "any", "all"})


def _allowed_station_ids() -> set[str]:
    """CREDITS_ALLOWED_STATION_IDS (콤마). 비우면 CREDITS_SOOP_STATION_ID만.

    '*' / any / all 은 _allow_any_soop_station()으로 따로 본다(여기 집합에는 안 넣음).
    """
    if _allow_any_soop_station():
        return set()
    raw = (os.environ.get("CREDITS_ALLOWED_STATION_IDS") or "").strip()
    out: set[str] = set()
    if raw:
        for part in re.split(r"[,，\s]+", raw):
            sid = str(part or "").strip().lower()
            if sid and _looks_like_soop_user_id(sid):
                out.add(sid)
    if not out:
        fallback = str(STATION_ID or "").strip().lower()
        if fallback and _looks_like_soop_user_id(fallback):
            out.add(fallback)
    return out


def _station_is_allowed(station_id: str) -> bool:
    sid = str(station_id or "").strip().lower()
    if not sid or not _looks_like_soop_user_id(sid):
        return False
    if _allow_any_soop_station():
        return True
    return sid in _allowed_station_ids()


def _overlay_dev_station_ids() -> set[str]:
    """CREDITS_OVERLAY_DEV_STATION_IDS — 수집 쓰기 없이 상태·시리안 데이터 조회."""
    raw = (os.environ.get("CREDITS_OVERLAY_DEV_STATION_IDS") or "").strip()
    out: set[str] = set()
    if not raw:
        return out
    for part in re.split(r"[,，\s]+", raw):
        sid = str(part or "").strip().lower()
        if sid and _looks_like_soop_user_id(sid):
            out.add(sid)
    return out


def _is_overlay_dev(station_id: str) -> bool:
    sid = str(station_id or "").strip().lower()
    return bool(sid) and sid in _overlay_dev_station_ids()


def _ending_staff_station(station_id: str) -> bool:
    """스튜디오·일기장 접근: 수집 허용 BJ 또는 오버레이 개발자."""
    return _station_is_allowed(station_id) or _is_overlay_dev(station_id)


def _sirian_station_id() -> str:
    sid = str(STATION_ID or os.environ.get("CREDITS_SOOP_STATION_ID") or "sirianrain").strip().lower()
    return sid if _looks_like_soop_user_id(sid) else "sirianrain"


def _session_monitor_summary(session: dict) -> dict[str, Any]:
    chatters = session.get("chatters") if isinstance(session.get("chatters"), dict) else {}
    donations = session.get("donations") if isinstance(session.get("donations"), dict) else {}
    segs = collector_segments_for_monitor(session if isinstance(session, dict) else {})
    open_seg = bool(segs) and isinstance(segs[-1], dict) and not segs[-1].get("endedAt")
    chat_count = 0
    active_chatters = 0
    for row in chatters.values():
        if not isinstance(row, dict):
            continue
        c = int(row.get("count") or 0)
        if c > 0:
            active_chatters += 1
            chat_count += c
    don_users = 0
    for row in donations.values():
        if isinstance(row, dict) and int(row.get("total") or 0) > 0:
            don_users += 1
    sid = str(session.get("stationId") or "").strip().lower()
    presence = get_presence_store().snapshot(sid) if sid else {
        "obs": {"active": False},
        "collector": {"active": False},
    }
    ingest = get_ingest_activity_store().snapshot(sid) if sid else {
        "active": False,
        "lastOkAt": "",
        "lastOkAgeSec": None,
        "lastEventsAt": "",
        "lastSource": "",
        "authFailRecent": False,
        "lastAuthFailAt": "",
        "lastAuthFailSource": "",
    }
    return {
        "stationId": sid,
        "active": bool(session.get("active")),
        "chatSdkConnected": bool(session.get("chatSdkConnected")),
        "pendingChatSdk": bool(session.get("pendingChatSdk")),
        "title": str(session.get("title") or "").strip(),
        "startedAt": session.get("startedAt"),
        "endedAt": session.get("endedAt"),
        "updatedAt": session.get("updatedAt"),
        "peakViewers": int(session.get("peakViewers") or 0),
        "peakViewersAt": session.get("peakViewersAt"),
        "peakAtLabel": format_kst_clock(parse_iso(session.get("peakViewersAt"))),
        "peakThumbUrl": str(session.get("peakThumbUrl") or "").strip(),
        "lastViewerCount": int(session.get("lastViewerCount") or 0),
        "balloonTotal": int(session.get("balloonTotal") or 0),
        "chatterCount": active_chatters,
        "chatCount": chat_count,
        "donationUsers": don_users,
        "collectorOpen": open_seg,
        "collectorSegments": segs[-8:] if isinstance(segs, list) else [],
        "clients": presence,
        "obsBrowserActive": bool((presence.get("obs") or {}).get("active")),
        "collectorTabActive": bool((presence.get("collector") or {}).get("active")),
        "ingest": ingest,
        "ingestActive": bool(ingest.get("active")),
        "lastIngestAt": str(ingest.get("lastOkAt") or ""),
        "lastIngestAgeSec": ingest.get("lastOkAgeSec"),
        "lastIngestSource": str(ingest.get("lastSource") or ""),
        "ingestAuthFailRecent": bool(ingest.get("authFailRecent")),
    }


def _payload_info_preview(payload: dict | None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
    sections = payload.get("sections") if isinstance(payload.get("sections"), list) else []
    section_rows = []
    for sec in sections[:16]:
        if not isinstance(sec, dict):
            continue
        items = sec.get("items") if isinstance(sec.get("items"), list) else []
        top_items = []
        # 모니터는 크레딧 슬라이드(상위 일부)보다 많이 보여 줌
        for it in items[:40]:
            if not isinstance(it, dict):
                continue
            top_items.append(
                {
                    "rank": it.get("rank"),
                    "name": str(it.get("name") or it.get("id") or "").strip(),
                    "value": str(it.get("value") or "").strip(),
                    "count": it.get("count"),
                    "imageUrl": str(it.get("imageUrl") or "").strip(),
                }
            )
        # 이모티콘: 스티커 이미지 순위(topEmoticons)를 모니터 목록에 우선 사용
        if str(sec.get("id") or "") == "emoticon":
            top_emo = sec.get("topEmoticons") if isinstance(sec.get("topEmoticons"), list) else []
            if top_emo:
                top_items = []
                for it in top_emo[:40]:
                    if not isinstance(it, dict):
                        continue
                    top_items.append(
                        {
                            "rank": it.get("rank"),
                            "name": str(it.get("name") or "").strip() or "이모티콘",
                            "value": str(it.get("value") or "").strip(),
                            "count": it.get("count"),
                            "imageUrl": str(it.get("imageUrl") or "").strip(),
                        }
                    )
        section_rows.append(
            {
                "id": sec.get("id"),
                "title": sec.get("title"),
                "pending": bool(sec.get("pending")),
                "itemCount": len(top_items) if top_items else len(items),
                "items": top_items,
                "topEmoticons": [
                    {
                        "rank": it.get("rank"),
                        "name": str(it.get("name") or "").strip(),
                        "value": str(it.get("value") or "").strip(),
                        "imageUrl": str(it.get("imageUrl") or "").strip(),
                    }
                    for it in (sec.get("topEmoticons") or [])
                    if isinstance(it, dict)
                ][:40],
            }
        )
    return {
        "info": {
            "title": info.get("title") or "",
            "dateLabel": info.get("dateLabel") or "",
            "durationLabel": info.get("durationLabel") or "",
            "peakViewers": int(info.get("peakViewers") or 0),
            "peakViewersAt": info.get("peakViewersAt"),
            "peakAtLabel": str(info.get("peakAtLabel") or "").strip(),
            "peakThumbUrl": str(info.get("peakThumbUrl") or "").strip(),
            "chatters": int(info.get("chatters") or 0),
            "chatCount": int(info.get("chatCount") or 0),
            "balloonTotal": int(info.get("balloonTotal") or 0),
            "fanclubCount": int(info.get("fanclubCount") or 0),
            "subscribeCount": int(info.get("subscribeCount") or 0),
        },
        "active": bool(payload.get("active")),
        "pendingChatSdk": bool(payload.get("pendingChatSdk")),
        "sections": section_rows,
        "archiveId": payload.get("archiveId"),
        "source": payload.get("source"),
    }


def _first_chat_collected_preview(session: dict) -> dict[str, Any] | None:
    """dev-monitor liveExtras 전용 — 세션을 변경하지 않음."""
    first = session.get("firstChat") if isinstance(session.get("firstChat"), dict) else None
    if not first or not first.get("name"):
        return None
    at_label = ""
    if first.get("at") and session.get("startedAt"):
        start = parse_iso(session.get("startedAt"))
        at = parse_iso(first.get("at"))
        if start and at:
            delay = max(0, int((at - start).total_seconds()))
            if delay < 60:
                at_label = f"방송 시작 {delay}초"
            else:
                at_label = f"방송 시작 {delay // 60}분 {delay % 60}초"
    return {
        "name": str(first.get("name") or ""),
        "message": str(first.get("message") or ""),
        "atLabel": at_label,
        "at": str(first.get("at") or ""),
        "isEmoticon": bool(first.get("isEmoticon")),
        "emoticonName": str(first.get("emoticonName") or "").strip(),
        "imageUrl": str(first.get("imageUrl") or "").strip(),
    }


def _metrics_series_readonly_preview(session: dict) -> dict[str, list[dict[str, Any]]]:
    """dev-monitor liveExtras 전용 — ensure_metrics_series 호출 없이 읽기만."""
    raw = session.get("metricsSeries")
    if not isinstance(raw, dict):
        raw = {}
    out: dict[str, list[dict[str, Any]]] = {}
    for key in ("up", "balloons"):
        rows = raw.get(key)
        out[key] = normalize_metric_series(rows if isinstance(rows, list) else [])
    chats = chat_metrics_series_for_session(session, raw_dir=CREDITS_RAW_DIR)
    viewers = normalize_metric_series(
        raw.get("viewers") if isinstance(raw.get("viewers"), list) else [],
        keep_max=True,
    )
    aligned_v, aligned_c = align_viewer_chat_metrics(
        viewers,
        chats,
        started_at=str(session.get("startedAt") or ""),
        end_at=session_metrics_end_at(session),
    )
    aligned_v = apply_peak_viewers_to_series(
        aligned_v,
        peak_viewers=session.get("peakViewers"),
        peak_viewers_at=session.get("peakViewersAt"),
    )
    out["viewers"] = aligned_v
    out["chats"] = aligned_c
    return out


def _dev_monitor_replay_context(session: dict) -> dict[str, Any]:
    return build_replay_context(session, raw_dir=CREDITS_RAW_DIR)


def _title_history_preview(session: dict) -> list[dict[str, Any]]:
    """dev-monitor liveExtras 전용 — 방제 변경 이력."""
    history = session.get("titleHistory") if isinstance(session.get("titleHistory"), list) else []
    out: list[dict[str, Any]] = []
    for row in history:
        if not isinstance(row, dict):
            continue
        title = str(row.get("title") or "").strip()
        if not title:
            continue
        at = row.get("at")
        out.append(
            {
                "title": title,
                "at": at,
                "clock": format_kst_clock(parse_iso(at)),
            }
        )
    return out


def read_ssapi_collector_status() -> dict[str, Any]:
    """보조 수집기 상태 파일. 키·토큰은 넣지 않는다."""
    empty = {
        "connected": False,
        "updatedAt": "",
        "stationId": "",
        "lastError": "",
        "lastAction": "",
        "lastPhase": "",
        "lastTitle": "",
        "lastIngestAt": "",
        "hasStatus": False,
    }
    path = SSAPI_STATUS_PATH
    if not path.is_file():
        return empty
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {**empty, "lastError": "status_unreadable"}
    if not isinstance(raw, dict):
        return empty
    err = str(raw.get("lastError") or "").strip()
    if err.lower() in {"missing_api_key", "stopped"}:
        connected = False
    else:
        connected = bool(raw.get("connected"))
    return {
        "connected": connected,
        "updatedAt": str(raw.get("updatedAt") or ""),
        "stationId": str(raw.get("stationId") or "").strip(),
        "lastError": err[:200],
        "lastAction": str(raw.get("lastAction") or ""),
        "lastPhase": str(raw.get("lastPhase") or ""),
        "lastTitle": str(raw.get("lastTitle") or "")[:80],
        "lastIngestAt": str(raw.get("lastIngestAt") or ""),
        "hasStatus": True,
    }


def _ssapi_monitor_payload(session: dict | None) -> dict[str, Any]:
    status = read_ssapi_collector_status()
    assist = serialize_ssapi_assist(session if isinstance(session, dict) else None)
    return {**status, **assist}


def _dev_monitor_live_extras(session: dict | None) -> dict[str, Any]:
    if not isinstance(session, dict):
        return {
            "firstChat": None,
            "titleHistory": [],
            "missionRuns": [],
            "donationNotes": [],
            "ssapi": _ssapi_monitor_payload(None),
            "metricsSeries": {"viewers": [], "up": [], "balloons": [], "chats": []},
            "replay": {},
        }
    return {
        "firstChat": _first_chat_collected_preview(session),
        "titleHistory": _title_history_preview(session),
        "missionRuns": serialize_mission_runs(session),
        "donationNotes": serialize_donation_notes(session),
        "ssapi": _ssapi_monitor_payload(session),
        "metricsSeries": _metrics_series_readonly_preview(session),
        "replay": _dev_monitor_replay_context(session),
    }


def _dev_monitor_collected(session: dict | None, *, limit: int = 0) -> dict[str, Any]:
    """개발자 모니터 전용 collected — 기존 preview + liveExtras."""
    base = _session_collected_preview(session, limit=limit)
    base["liveExtras"] = _dev_monitor_live_extras(session)
    return base


def _session_collected_preview(session: dict | None, *, limit: int = 10) -> dict[str, Any]:
    """모니터용 수집 데이터 (채팅/시청/후원/구독/이모티콘).

    limit <= 0 이면 전체, 아니면 상위 N명.
    """
    empty = {
        "topChatters": [],
        "topWatchers": [],
        "topDonations": [],
        "subscribers": [],
        "subscriberRenewals": [],
        "subscriptionGifts": [],
        "fanclubJoins": [],
        "topFans": [],
        "topEmoticons": [],
        "counts": {},
    }
    if not isinstance(session, dict):
        return empty

    coalesce_session_user_aliases(session)

    if int(limit or 0) <= 0:
        lim: int | None = None
    else:
        lim = max(1, min(5000, int(limit)))

    def _take(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return rows if lim is None else rows[:lim]

    bj_id = normalize_soop_user_id(str(session.get("stationId") or "").strip())

    chatters = session.get("chatters") if isinstance(session.get("chatters"), dict) else {}
    chat_rows: list[dict[str, Any]] = []
    watch_rows: list[dict[str, Any]] = []
    now_ms = time.time() * 1000
    ended_ms = 0.0
    started_ms = 0.0
    if session.get("endedAt"):
        ended = parse_iso(session.get("endedAt"))
        if ended:
            ended_ms = ended.timestamp() * 1000
    started = parse_iso(session.get("startedAt"))
    if started:
        started_ms = started.timestamp() * 1000

    for uid, row in chatters.items():
        if not isinstance(row, dict):
            continue
        uid_norm = normalize_soop_user_id(str(uid))
        name = str(row.get("name") or uid).strip() or str(uid)
        count = int(row.get("count") or 0)
        if count > 0:
            chat_rows.append({"id": uid_norm or str(uid), "name": name, "count": count})

        if bj_id and uid_norm == bj_id:
            continue
        dur = chatter_watch_ms(
            row, now_ms=now_ms, ended_ms=ended_ms, started_ms=started_ms
        )
        if dur < 1000:
            continue
        watch_rows.append(
            {
                "id": uid_norm or str(uid),
                "name": name,
                "ms": dur,
                "value": format_watch(dur),
            }
        )

    chat_rows.sort(key=lambda x: (-int(x["count"]), x["name"]))
    for i, row in enumerate(chat_rows, start=1):
        row["rank"] = i
    watch_rows.sort(key=lambda x: (-float(x["ms"]), x["name"]))
    for i, row in enumerate(watch_rows, start=1):
        row["rank"] = i

    donations = session.get("donations") if isinstance(session.get("donations"), dict) else {}
    don_rows: list[dict[str, Any]] = []
    for uid, row in donations.items():
        if not isinstance(row, dict):
            continue
        total = int(row.get("total") or 0)
        if total <= 0:
            continue
        don_rows.append(
            {
                "id": normalize_soop_user_id(str(uid)) or str(uid),
                "name": str(row.get("name") or uid).strip() or str(uid),
                "total": total,
            }
        )
    don_rows.sort(key=lambda x: (-int(x["total"]), x["name"]))
    for i, row in enumerate(don_rows, start=1):
        row["rank"] = i

    def _list_named(raw: Any, *, amount_key: str = "", extra_keys: tuple[str, ...] = ()) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if not isinstance(raw, list):
            return out
        for it in raw:
            if not isinstance(it, dict):
                continue
            name = str(it.get("name") or it.get("userId") or it.get("id") or "").strip()
            if not name:
                continue
            row: dict[str, Any] = {"name": name}
            if amount_key and it.get(amount_key) is not None:
                row["value"] = it.get(amount_key)
            elif it.get("months") is not None:
                # 연속 구독: 채팅 "N개월 구독중" = subscriptionMonths (누적 value보다 우선)
                try:
                    m = int(it.get("months") or 0)
                except (TypeError, ValueError):
                    m = 0
                row["value"] = f"{m}개월" if m > 0 else (str(it.get("value") or "").strip() or "—")
            elif it.get("value") is not None and str(it.get("value") or "").strip():
                row["value"] = it.get("value")
            elif it.get("type"):
                row["value"] = str(it.get("type"))
            elif it.get("count") is not None:
                row["value"] = it.get("count")
            elif it.get("fanNumber") is not None:
                row["value"] = f"#{it.get('fanNumber')}"
            else:
                row["value"] = "—"
            out.append(row)
        return _take(out)

    def _gift_rows(raw: Any) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if not isinstance(raw, list):
            return out
        for it in raw:
            if not isinstance(it, dict):
                continue
            giver = str(it.get("name") or it.get("userId") or "").strip()
            if not giver:
                continue
            recv = str(it.get("receiverName") or it.get("receiverId") or "").strip()
            gtype = str(it.get("type") or "").strip()
            label = f"→ {recv}" if recv else (gtype or "선물")
            out.append({"name": giver, "value": label, "receiverName": recv, "type": gtype})
        return _take(out)

    emo_usage = (
        session.get("emoticonUsage") if isinstance(session.get("emoticonUsage"), dict) else {}
    )
    from credits_store import build_top_emoticons

    emo_built = build_top_emoticons(
        emo_usage,
        station_id=str(session.get("stationId") or STATION_ID or "").strip(),
        limit=40,
        signature_only=True,
    )
    emo_rows: list[dict[str, Any]] = []
    for row in emo_built:
        emo_rows.append(
            {
                "id": f"sub:{row.get('name')}",
                "name": row.get("name"),
                "count": row.get("count"),
                "imageUrl": row.get("imageUrl") or "",
                "rank": row.get("rank"),
                "value": row.get("value"),
            }
        )
    chat_out = _take(chat_rows)
    watch_out = _take(watch_rows)
    don_out = _take(don_rows)
    emo_out = _take(emo_rows)

    return {
        "topChatters": chat_out,
        "topWatchers": watch_out,
        "topDonations": don_out,
        "subscribers": _list_named(session.get("subscribers")),
        "subscriberRenewals": _list_named(session.get("subscriberRenewals")),
        "subscriptionGifts": _gift_rows(session.get("subscriptionGifts")),
        "fanclubJoins": _list_named(session.get("fanclubJoins")),
        "topFans": _list_named(session.get("topFans")),
        "topEmoticons": emo_out,
        "counts": {
            "chatters": len(chat_rows),
            "watchers": len(watch_rows),
            "chatCount": sum(int(r["count"]) for r in chat_rows),
            "donors": len(don_rows),
            "balloonTotal": int(session.get("balloonTotal") or 0),
            "subscribers": len(session.get("subscribers") or [])
            if isinstance(session.get("subscribers"), list)
            else 0,
            "subscriberRenewals": len(session.get("subscriberRenewals") or [])
            if isinstance(session.get("subscriberRenewals"), list)
            else 0,
            "subscriptionGifts": len(session.get("subscriptionGifts") or [])
            if isinstance(session.get("subscriptionGifts"), list)
            else 0,
            "fanclubJoins": len(session.get("fanclubJoins") or [])
            if isinstance(session.get("fanclubJoins"), list)
            else int(session.get("fanclubCount") or 0),
            "emoticons": len(emo_rows),
            "missions": len(serialize_mission_runs(session)),
            "peakViewers": int(session.get("peakViewers") or 0),
            "peakViewersAt": str(session.get("peakViewersAt") or ""),
            "lastViewerCount": int(session.get("lastViewerCount") or 0),
        },
    }


def _session_is_stub(session: dict | None) -> bool:
    """방종 직후 늦은 채팅으로 생긴 수 초짜리 빈 세션 여부."""
    if not isinstance(session, dict):
        return True
    if session.get("active"):
        return False
    if not session.get("startedAt"):
        return True
    start = parse_iso(session.get("startedAt"))
    end = parse_iso(session.get("endedAt")) or datetime.now(timezone.utc)
    if not start:
        return True
    duration_sec = max(0, int((end - start).total_seconds()))
    if duration_sec >= 60:
        return False
    try:
        peak = int(session.get("peakViewers") or 0)
    except (TypeError, ValueError):
        peak = 0
    try:
        balloons = int(session.get("balloonTotal") or 0)
    except (TypeError, ValueError):
        balloons = 0
    chatters = session.get("chatters") if isinstance(session.get("chatters"), dict) else {}
    chat_n = sum(
        1
        for row in chatters.values()
        if isinstance(row, dict) and int(row.get("count") or 0) > 0
    )
    title = str(session.get("title") or "").strip()
    if peak > 0 or balloons > 0 or title:
        return False
    return chat_n <= 3


def _archive_monitor_payload(store: CreditsStore, archive_id: str) -> dict[str, Any] | None:
    data = store.load_archive(archive_id)
    if not isinstance(data, dict):
        return None
    session = data.get("session") if isinstance(data.get("session"), dict) else {}
    session = dict(session)
    session["active"] = False
    if not session.get("endedAt"):
        inferred = session_metrics_end_at(session)
        if inferred:
            session["endedAt"] = inferred
    credits = data.get("credits") if isinstance(data.get("credits"), dict) else None
    if credits is None:
        try:
            credits = store.build_credits_payload(session) if session else None
        except Exception:
            credits = None
    summary = _session_monitor_summary(session)
    summary["collected"] = _dev_monitor_collected(session, limit=0)
    preview = _payload_info_preview(credits)
    info = dict(preview.get("info") or {})
    aid = str(data.get("archiveId") or archive_id)
    if str(data.get("peakThumbFile") or "").strip() and aid:
        from urllib.parse import quote

        info["peakThumbUrl"] = f"/api/credits/archive-peak-thumb?archiveId={quote(aid)}"
        summary["peakThumbUrl"] = info["peakThumbUrl"]
    duration_label = str(info.get("durationLabel") or "").strip()
    if not duration_label:
        duration_label = format_duration(
            data.get("startedAt") or session.get("startedAt"),
            data.get("endedAt") or session.get("endedAt") or session_metrics_end_at(session),
        )
    return {
        "ok": True,
        "archiveId": aid,
        "source": "archive",
        "stationId": str(data.get("stationId") or session.get("stationId") or ""),
        "session": summary,
        "info": info,
        "sections": preview.get("sections") or [],
        "startedAt": data.get("startedAt") or session.get("startedAt"),
        "endedAt": data.get("endedAt") or session.get("endedAt") or session_metrics_end_at(session),
        "title": data.get("title") or info.get("title") or "",
        "durationLabel": duration_label,
        "peakViewers": int(data.get("peakViewers") or info.get("peakViewers") or 0),
        "balloonTotal": int(info.get("balloonTotal") or session.get("balloonTotal") or 0),
    }
def _require_overlay_dev() -> tuple[str, tuple[Any, int] | None]:
    """오버레이 개발자만. (station_id, (jsonify_body, status)_or_None)."""
    cookie_sid = _ending_soop_cookie_station()
    if cookie_sid and _is_overlay_dev(cookie_sid):
        return cookie_sid, None
    token = _extract_soop_access_token()
    if token:
        sid, err, status = _soop_identity_from_token(token)
        if not err and sid and _is_overlay_dev(sid):
            return str(sid).lower(), None
        if err:
            return "", (jsonify({"ok": False, "error": err}), status)
    return "", (jsonify({"ok": False, "error": "overlay_dev_required"}), 403)


def _require_staff_viewer() -> tuple[str, tuple[Any, int] | None]:
    """시리안(허용 BJ) 또는 오버레이 개발자. (station_id, err_or_None)."""
    cookie_sid = _ending_soop_cookie_station()
    if cookie_sid:
        return cookie_sid, None
    token = _extract_soop_access_token()
    if token:
        sid, err, status = _soop_identity_from_token(token)
        if not err and sid and _ending_staff_station(sid):
            return str(sid).lower(), None
        if err:
            return "", (jsonify({"ok": False, "error": err}), status)
    return "", (jsonify({"ok": False, "error": "staff_access_required"}), 403)


def _request_body_station_id() -> str:
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return ""
    sid = str(payload.get("stationId") or payload.get("station_id") or "").strip()
    return sid if _looks_like_soop_user_id(sid) else ""


def _extract_soop_access_token() -> str:
    header = (request.headers.get("X-Soop-Access-Token") or "").strip()
    if header:
        return header
    payload = request.get_json(silent=True)
    if isinstance(payload, dict):
        tok = str(payload.get("accessToken") or payload.get("access_token") or "").strip()
        if tok:
            return tok
    return ""


def _soop_stationinfo_raw(access_token: str) -> tuple[dict | None, str, int]:
    """(raw_json_or_None, error_code, http_status)."""
    token = str(access_token or "").strip()
    if not token:
        return None, "token_required", 400
    body = urllib.parse.urlencode({"access_token": token}).encode("utf-8")
    req = urllib.request.Request(
        "https://openapi.sooplive.com/user/stationinfo",
        data=body,
        headers={
            **SOOP_FETCH_HEADERS,
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "*/*",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:500]
        except Exception:
            detail = str(exc)
        status = 401 if int(getattr(exc, "code", 0) or 0) in (401, 403) else 502
        return {"_detail": detail}, "soop_stationinfo_failed", status
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        return {"_detail": str(exc)}, "soop_stationinfo_failed", 502
    if not isinstance(raw, dict):
        return None, "soop_stationinfo_invalid", 502
    return raw, "", 200


def _parse_station_id_from_stationinfo(raw: dict, access_token: str = "") -> str:
    data = raw.get("data") if isinstance(raw, dict) else None
    if isinstance(data, list) and data:
        data = data[0] if isinstance(data[0], dict) else {}
    if not isinstance(data, dict):
        data = raw if isinstance(raw, dict) else {}
    nested: dict = {}
    for key in ("station", "user", "station_info", "stationInfo", "channel", "bj"):
        block = data.get(key)
        if isinstance(block, dict):
            nested.update(block)

    def pick(*keys: str) -> str:
        for key in keys:
            for source in (data, nested, raw if isinstance(raw, dict) else {}):
                if not isinstance(source, dict):
                    continue
                val = source.get(key)
                if val is not None and str(val).strip():
                    return str(val).strip()
        return ""

    for key in (
        "user_id",
        "userId",
        "bj_id",
        "bjId",
        "login_id",
        "loginId",
        "streamer_id",
        "streamerId",
        "station_id",
        "stationId",
        "channel_id",
        "channelId",
    ):
        cand = pick(key)
        if _looks_like_soop_user_id(cand):
            return cand

    walked = _walk_station_id(raw) or _walk_station_id(data)
    if walked:
        return walked

    # 일부 계정은 stationinfo가 닉·프로필만 줌 — 프로필 URL에 로그인 id가 있음
    profile = pick("profile_image", "profile_img", "profileImage", "profileImg")
    from_img = _station_id_from_profile_image(profile)
    if from_img:
        return from_img

    jwt_id = _station_id_from_jwt(access_token)
    if jwt_id:
        return jwt_id
    return ""


def _soop_identity_from_token(access_token: str) -> tuple[str | None, str, int]:
    """(station_id_or_None, error_code, http_status). 캐시 사용."""
    token = str(access_token or "").strip()
    if not token:
        return None, "token_required", 400
    now = time.time()
    with _soop_identity_cache_lock:
        cached = _soop_identity_cache.get(token)
        if cached and now - cached[0] < _SOOP_IDENTITY_TTL_SEC:
            return cached[1], "", 200

    raw, err, status = _soop_stationinfo_raw(token)
    if err:
        return None, err, status
    assert isinstance(raw, dict)
    try:
        result_n = int(raw.get("result")) if raw.get("result") is not None else 1
    except (TypeError, ValueError):
        result_n = 1
    if result_n < 0:
        return None, "soop_token_or_api_error", 401
    station_id = _parse_station_id_from_stationinfo(raw, token)
    if not station_id:
        return None, "soop_profile_empty", 502
    with _soop_identity_cache_lock:
        _soop_identity_cache[token] = (now, station_id)
        if len(_soop_identity_cache) > 64:
            # 오래된 항목 정리
            cutoff = now - _SOOP_IDENTITY_TTL_SEC
            stale = [k for k, (ts, _) in _soop_identity_cache.items() if ts < cutoff]
            for k in stale:
                _soop_identity_cache.pop(k, None)
    return station_id, "", 200


def _collector_authorized() -> bool:
    """허용 SOOP 계정·오버레이 개발자 토큰, 또는 (개발) ingest 시크릿 / 로컬."""
    soop_token = _extract_soop_access_token()
    if soop_token:
        station_id, err, _status = _soop_identity_from_token(soop_token)
        if not err and station_id and (
            _station_is_allowed(station_id) or _is_overlay_dev(station_id)
        ):
            return True
        # stationinfo는 성공했는데 id만 비는 경우: allow-any면 body stationId로 통과
        if err == "soop_profile_empty" and _allow_any_soop_station():
            return bool(_request_body_station_id())
        return False

    secret = os.environ.get("CREDITS_INGEST_SECRET", "").strip()
    if not secret:
        remote = (request.remote_addr or "").strip()
        return remote in ("127.0.0.1", "::1")
    header = (request.headers.get("X-Credits-Ingest-Secret") or "").strip()
    auth = (request.headers.get("Authorization") or "").strip()
    if header and header == secret:
        return True
    if auth.lower().startswith("bearer ") and auth[7:].strip() == secret:
        return True
    return False


def _forbidden_collector_response():
    soop_token = _extract_soop_access_token()
    if soop_token:
        station_id, err, status = _soop_identity_from_token(soop_token)
        if err and err != "soop_profile_empty":
            return jsonify({"ok": False, "error": err, "allowed": False}), status
        # allow-any + body stationId 면 _collector_authorized 가 True라 여기 안 옴.
        # body 없이 프로필 id만 비면 클라이언트에 채널 연결 유도.
        if err == "soop_profile_empty" and _allow_any_soop_station():
            return (
                jsonify(
                    {
                        "ok": False,
                        "error": "station_id_unresolved",
                        "allowed": True,
                        "message": "프로필에 채널 ID가 없습니다. 수집기/OBS에서 방송 연결 후 다시 시도하세요.",
                    }
                ),
                502,
            )
        if station_id and not _station_is_allowed(station_id) and not _is_overlay_dev(station_id):
            return (
                jsonify(
                    {
                        "ok": False,
                        "error": "forbidden_station",
                        "allowed": False,
                        "stationId": station_id,
                        "message": "허용된 숲 계정만 수집·저장할 수 있습니다.",
                    }
                ),
                403,
            )
    return jsonify({"ok": False, "error": "unauthorized", "allowed": False}), 401


def _bootstrap_payload() -> dict:
    live_sid = _resolve_live_station_id(None)
    streamer_sid = _sirian_station_id()
    return {
        "ok": True,
        "clientId": os.environ.get("SOOP_CLIENT_ID", "").strip(),
        "clientSecret": os.environ.get("SOOP_CLIENT_SECRET", "").strip(),
        # ingestSecret은 공개 bootstrap에서 제거 — 허용 SOOP 토큰으로 쓰기 API 인증
        "hasClientId": bool(os.environ.get("SOOP_CLIENT_ID", "").strip()),
        "hasClientSecret": bool(os.environ.get("SOOP_CLIENT_SECRET", "").strip()),
        "sdkScriptUrl": "https://static.sooplive.com/asset/app/chat-sdk/sooplive-chat-sdk.js",
        "oauthRedirectPath": "/ending/",
        "liveDataPath": "/ending/live_data",
        "obsPath": f"/ending/obs?obs=1&stationId={urllib.parse.quote(live_sid)}",
        "demoObsPath": f"/ending/obs?obs=1&demo=1&stationId={urllib.parse.quote(live_sid)}",
        "studioPath": "/ending/studio",
        "stationId": live_sid,
        # 시그풍·스트리머 고정 채널 (수집기 바인딩 stationId 와 다를 수 있음)
        "streamerStationId": streamer_sid,
        "overlayShared": True,
        "mode": "logged_in_bj",
        "authMode": "soop_allowlist",
        "pageGate": "soop_station_cookie",
    }


@app.after_request
def _no_store_static(resp: Response):
    """OBS CEF가 HTML/CSS/JS를 붙잡지 않도록. (주소만 바꿔야 반영되던 문제 방지)"""
    ct = (resp.content_type or "").split(";")[0].strip().lower()
    path = request.path or ""
    if (
        ct in ("text/html", "text/css", "application/javascript", "text/javascript")
        or path.endswith((".js", ".css", ".html"))
        or path.startswith("/api/credits/asset-version")
    ):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
    return resp


@app.route("/api/credits/asset-version")
def api_credits_asset_version():
    """오버레이 CSS/JS mtime — OBS가 같은 URL이어도 배포 후 자동 갱신할 때 사용."""
    files = [
        ENDING_DIR / "obs.html",
        ENDING_DIR / "css" / "overlay.css",
        ENDING_DIR / "css" / "overlay-fonts.css",
        ENDING_DIR / "css" / "holo-bridge.css",
        ENDING_DIR / "css" / "holo-panel.css",
        ENDING_DIR / "css" / "overlay-hologram.css",
        ENDING_DIR / "js" / "overlay.js",
        ENDING_DIR / "js" / "overlay-hologram.js",
        ENDING_DIR / "js" / "collect-runtime.js",
    ]
    latest = 0
    for p in files:
        try:
            latest = max(latest, int(p.stat().st_mtime))
        except OSError:
            continue
    resp = jsonify({"ok": True, "v": str(latest or int(time.time()))})
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/health")
def api_health():
    store = get_store()
    return jsonify(
        {
            "ok": True,
            "service": "credits",
            "stationId": store.station_id,
            "mode": "logged_in_bj",
        }
    )


@app.route("/api/credits/bootstrap")
def api_bootstrap():
    """숲 OAuth용 키 — Google 게이트 없음. 채널은 로그인한 BJ 기준."""
    return jsonify(_bootstrap_payload())


@app.route("/api/credits/me", methods=["POST"])
def api_me():
    """숲 access_token으로 로그인 BJ 프로필(닉·스테이션·프로필 이미지) 조회."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400
    token = str(payload.get("accessToken") or payload.get("access_token") or "").strip()
    if not token:
        return jsonify({"error": "token_required"}), 400

    raw, err, status = _soop_stationinfo_raw(token)
    if err:
        detail = ""
        if isinstance(raw, dict):
            detail = str(raw.get("_detail") or "")
        return jsonify({"ok": False, "error": err, "detail": detail, "allowed": False}), status
    assert isinstance(raw, dict)

    try:
        result_n = int(raw.get("result")) if raw.get("result") is not None else 1
    except (TypeError, ValueError):
        result_n = 1
    if result_n < 0:
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "soop_token_or_api_error",
                    "detail": str(raw.get("msg") or "").strip() or f"result={result_n}",
                    "result": result_n,
                    "allowed": False,
                }
            ),
            401,
        )

    data = raw.get("data") if isinstance(raw, dict) else None
    if isinstance(data, list) and data:
        data = data[0] if isinstance(data[0], dict) else {}
    if not isinstance(data, dict):
        data = raw if isinstance(raw, dict) else {}
    nested = {}
    for key in ("station", "user", "station_info", "stationInfo"):
        block = data.get(key)
        if isinstance(block, dict):
            nested.update(block)

    def pick(*keys: str) -> str:
        for key in keys:
            for source in (data, nested, raw if isinstance(raw, dict) else {}):
                if not isinstance(source, dict):
                    continue
                val = source.get(key)
                if val is not None and str(val).strip():
                    return str(val).strip()
        return ""

    nick = pick("user_nick", "userNick", "nickname", "nick")
    station_id = _parse_station_id_from_stationinfo(raw, token)
    if not station_id:
        # nick만 있고 id가 비는 경우 — JWT·깊은 탐색 실패 시에도 빈 문자열로 내려 클라이언트가 캐시/SDK 폴백
        station_id = ""
    station_name = pick("station_name", "stationName") or nick or station_id
    profile = pick("profile_image", "profile_img", "profileImage", "profileImg")
    if profile.startswith("//"):
        profile = "https:" + profile
    elif profile.startswith("/"):
        profile = "https://profile.img.sooplive.com" + profile
    elif profile and not profile.startswith("http"):
        profile = "https://" + profile.lstrip("/")

    if not nick and not station_id and not station_name:
        return jsonify({"ok": False, "error": "soop_profile_empty", "result": result_n, "allowed": False}), 502

    if _allow_any_soop_station():
        # * 모드여도 영문 채널 ID가 있어야 허용 (닉네임만으로는 불가)
        allowed = bool(station_id) and _looks_like_soop_user_id(station_id)
    else:
        allowed = bool(station_id) and _station_is_allowed(station_id)
    overlay_dev = bool(station_id) and _is_overlay_dev(station_id)
    staff = allowed or overlay_dev
    if station_id:
        with _soop_identity_cache_lock:
            _soop_identity_cache[token] = (time.time(), station_id)

    # 수집 허용 계정만 서버 라이브 세션에 바인딩 (오버레이 개발 전용은 조회만 — 시리안 세션 덮지 않음)
    if allowed and station_id:
        store = get_store()
        try:
            store.bind_station(station_id, reset_if_changed=True)
            # 피크 썸네일이 없을 때만 채움 — 재로그인으로 최고시청 순간을 덮지 않음
            store.capture_live_frame(station_id=station_id, force=False)
        except Exception:
            pass

    body = {
        "ok": True,
        "allowed": allowed,
        "overlayDev": overlay_dev,
        "staffAccess": staff,
        "userNick": nick,
        "stationName": station_name,
        "stationId": station_id,
        "profileImage": profile,
        "favoriteCount": data.get("favorite_cnt")
        or data.get("favoriteCount")
        or nested.get("favorite_cnt"),
        "lastBroadDate": data.get("lately_broad_date")
        or data.get("latelyBroadDate")
        or nested.get("lately_broad_date"),
        "rawResult": raw.get("result") if isinstance(raw, dict) else None,
        "message": (
            None
            if staff
            else "허용된 숲 계정만 엔딩·수집을 사용할 수 있습니다."
        ),
        "allowedStationIds": sorted(_allowed_station_ids()) if not _allow_any_soop_station() else ["*"],
        "overlayDevStationIds": sorted(_overlay_dev_station_ids()),
        "sirianStationId": _sirian_station_id(),
    }
    resp = make_response(jsonify(body))
    if staff and station_id:
        _set_ending_soop_cookie(resp, station_id)
    elif not staff:
        _clear_ending_soop_cookie(resp)
    return resp


@app.route("/api/credits/logout", methods=["POST"])
def api_credits_logout():
    """숲 로그아웃 — 엔딩 접근 쿠키 삭제."""
    resp = make_response(jsonify({"ok": True}))
    _clear_ending_soop_cookie(resp)
    return resp


@app.route("/api/credits/dev-monitor")
def api_credits_dev_monitor():
    """오버레이 개발자: 로그인 계정 세션 + 시리안 세션(계정별) + 수집기 목록."""
    viewer_sid, err = _require_overlay_dev()
    if err:
        return err
    return jsonify(_build_dev_monitor_payload(viewer_sid))


@app.route("/api/credits/live-data")
def api_credits_live_data():
    """시리안·허용 스태프: 시리안 라이브/아카이브 데이터 (전용 페이지)."""
    viewer_sid, err = _require_staff_viewer()
    if err:
        return err
    return jsonify(_build_dev_monitor_payload(viewer_sid))


def _build_dev_monitor_payload(viewer_sid: str) -> dict[str, Any]:
    store = get_store()
    sirian_sid = _sirian_station_id()

    # 라이브 세션 = 지금 로그인한 개발자 계정 기준 (공용 포인터가 아님)
    viewer_session = store.load_session_for(viewer_sid)
    live = _session_monitor_summary(viewer_session if isinstance(viewer_session, dict) else {})
    if not live.get("stationId"):
        live["stationId"] = viewer_sid
    # 빈 세션이어도 브라우저 heartbeat는 stationId 기준으로 붙는다
    presence = get_presence_store().snapshot(viewer_sid)
    live["clients"] = presence
    live["obsBrowserActive"] = bool((presence.get("obs") or {}).get("active"))
    live["collectorTabActive"] = bool((presence.get("collector") or {}).get("active"))

    live_payload = None
    try:
        live_payload = store.build_credits_payload(
            viewer_session if isinstance(viewer_session, dict) else None
        )
    except Exception:
        live_payload = None
    live["collected"] = _dev_monitor_collected(
        viewer_session if isinstance(viewer_session, dict) else None,
        limit=0,
    )
    live_preview = _payload_info_preview(live_payload)
    live["sections"] = live_preview.get("sections") or []

    # 시리안 = 시리안 계정 세션 파일 (다른 계정 로그인과 독립)
    sirian_session = store.load_session_for(sirian_sid)
    sirian_summary = _session_monitor_summary(
        sirian_session if isinstance(sirian_session, dict) else {}
    )
    if not sirian_summary.get("stationId"):
        sirian_summary["stationId"] = sirian_sid
    sirian_presence = get_presence_store().snapshot(sirian_sid)
    sirian_summary["clients"] = sirian_presence
    sirian_summary["obsBrowserActive"] = bool((sirian_presence.get("obs") or {}).get("active"))
    sirian_summary["collectorTabActive"] = bool(
        (sirian_presence.get("collector") or {}).get("active")
    )
    sirian_summary["collected"] = _dev_monitor_collected(
        sirian_session if isinstance(sirian_session, dict) else None,
        limit=0,
    )
    try:
        resolved_peak = store._resolve_peak_thumb_url(
            sirian_session if isinstance(sirian_session, dict) else {}
        )
    except Exception:
        resolved_peak = ""
    if resolved_peak:
        sirian_summary["peakThumbUrl"] = resolved_peak

    sirian: dict[str, Any] = {"stationId": sirian_sid, "session": sirian_summary}
    stub = _session_is_stub(sirian_session if isinstance(sirian_session, dict) else None)
    if (
        not stub
        and (
            sirian_summary.get("startedAt")
            or sirian_summary.get("active")
            or sirian_summary.get("chatCount")
        )
    ):
        try:
            sirian_payload = store.build_credits_payload(sirian_session)
        except Exception:
            sirian_payload = None
        sirian["source"] = "session"
        sirian.update(_payload_info_preview(sirian_payload))
        info = sirian.get("info") if isinstance(sirian.get("info"), dict) else {}
        if resolved_peak and not info.get("peakThumbUrl"):
            info["peakThumbUrl"] = resolved_peak
            sirian["info"] = info
        elif info.get("peakThumbUrl"):
            sirian_summary["peakThumbUrl"] = str(info.get("peakThumbUrl") or "")
    else:
        archives = store.list_archives(limit=8, station_id=sirian_sid)
        sirian["source"] = "archive" if archives else "none"
        sirian["recentArchives"] = archives
        sirian["stubSession"] = stub
        if archives:
            latest = archives[0]
            aid = str(latest.get("archiveId") or "")
            packed = _archive_monitor_payload(store, aid) if aid else None
            sirian["latestArchive"] = latest
            if isinstance(packed, dict):
                sirian["session"] = packed.get("session") or sirian_summary
                sirian["info"] = packed.get("info") or {}
                sirian["sections"] = packed.get("sections") or []
                sirian["archiveId"] = packed.get("archiveId") or aid
                sirian["source"] = "archive"
                if stub:
                    sirian["stubNote"] = (
                        "방종 직후 잔여 채팅으로 생긴 짧은 세션은 숨기고, 직전 방송 아카이브를 표시합니다."
                    )

    sirian["archiveDates"] = store.list_archive_dates(limit=90, station_id=sirian_sid)

    # 서버 활성 포인터(ingest/OBS 기본) — 참고용
    active_session = store.load_session()
    active_bound = _session_monitor_summary(
        active_session if isinstance(active_session, dict) else {}
    )

    collectors: list[dict[str, Any]] = []
    try:
        obs_rows = get_obs_link_store().list_public()
    except Exception:
        obs_rows = []

    # 계정별 세션 상태 맵
    station_summaries: dict[str, dict[str, Any]] = {
        viewer_sid: live,
        sirian_sid: sirian_summary,
    }
    active_sid = active_bound.get("stationId") or ""
    if active_sid and active_sid not in station_summaries:
        station_summaries[active_sid] = active_bound

    for row in obs_rows:
        sid = str(row.get("stationId") or "").strip().lower()
        if not sid:
            continue
        if sid not in station_summaries:
            station_summaries[sid] = _session_monitor_summary(store.load_session_for(sid))
        summ = station_summaries.get(sid) or {}
        presence = get_presence_store().snapshot(sid)
        collectors.append(
            {
                "stationId": sid,
                "obsKeyUpdatedAt": row.get("updatedAt") or "",
                "hasObsKey": bool(row.get("hasKey")),
                "boundLive": bool(sid == active_sid),
                "collecting": bool(summ.get("ingestActive")),
                "segmentOpen": bool(summ.get("collectorOpen")),
                "sessionActive": bool(summ.get("active")),
                "obsBrowserActive": bool((presence.get("obs") or {}).get("active")),
                "collectorTabActive": bool((presence.get("collector") or {}).get("active")),
                "clients": presence,
                "ingest": summ.get("ingest") or {},
                "ingestActive": bool(summ.get("ingestActive")),
                "lastIngestAt": summ.get("lastIngestAt") or "",
                "lastIngestAgeSec": summ.get("lastIngestAgeSec"),
                "lastIngestSource": summ.get("lastIngestSource") or "",
                "ingestAuthFailRecent": bool(summ.get("ingestAuthFailRecent")),
                "role": (
                    "sirian"
                    if sid == sirian_sid
                    else ("overlayDev" if _is_overlay_dev(sid) else "collector")
                ),
            }
        )
    for sid, summ in station_summaries.items():
        if any(c.get("stationId") == sid for c in collectors):
            continue
        presence = get_presence_store().snapshot(sid)
        collectors.append(
            {
                "stationId": sid,
                "obsKeyUpdatedAt": "",
                "hasObsKey": False,
                "boundLive": bool(sid == active_sid),
                "collecting": bool(summ.get("ingestActive")),
                "segmentOpen": bool(summ.get("collectorOpen")),
                "sessionActive": bool(summ.get("active")),
                "obsBrowserActive": bool((presence.get("obs") or {}).get("active")),
                "collectorTabActive": bool((presence.get("collector") or {}).get("active")),
                "clients": presence,
                "ingest": summ.get("ingest") or {},
                "ingestActive": bool(summ.get("ingestActive")),
                "lastIngestAt": summ.get("lastIngestAt") or "",
                "lastIngestAgeSec": summ.get("lastIngestAgeSec"),
                "lastIngestSource": summ.get("lastIngestSource") or "",
                "ingestAuthFailRecent": bool(summ.get("ingestAuthFailRecent")),
                "role": (
                    "sirian"
                    if sid == sirian_sid
                    else ("overlayDev" if _is_overlay_dev(sid) else "collector")
                ),
            }
        )
    collectors.sort(key=lambda c: (0 if c.get("stationId") == sirian_sid else 1, c.get("stationId") or ""))

    return {
        "ok": True,
        "viewerStationId": viewer_sid,
        "sirianStationId": sirian_sid,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "ssapi": read_ssapi_collector_status(),
        "live": live,
        "livePreview": live_preview,
        "activeBound": active_bound,
        "collectors": collectors,
        "sirian": sirian,
        "allowedStationIds": sorted(_allowed_station_ids())
        if not _allow_any_soop_station()
        else ["*"],
        "overlayDevStationIds": sorted(_overlay_dev_station_ids()),
    }


def _dev_monitor_archive_dates_payload(station_id: str, limit: int) -> dict[str, Any]:
    sid = str(station_id or _sirian_station_id()).strip().lower()
    if not _looks_like_soop_user_id(sid):
        sid = _sirian_station_id()
    items = get_store().list_archive_dates(limit=limit, station_id=sid)
    return {"ok": True, "stationId": sid, "items": items, "count": len(items)}


def _dev_monitor_archives_payload(station_id: str, date: str | None, limit: int) -> dict[str, Any]:
    sid = str(station_id or _sirian_station_id()).strip().lower()
    if not _looks_like_soop_user_id(sid):
        sid = _sirian_station_id()
    items = get_store().list_archives(date=date, limit=limit, station_id=sid)
    return {
        "ok": True,
        "stationId": sid,
        "date": date or "",
        "items": items,
        "count": len(items),
    }


@app.route("/api/credits/dev-monitor/archive-dates")
def api_credits_dev_monitor_archive_dates():
    viewer_sid, err = _require_overlay_dev()
    if err:
        return err
    station_id = str(request.args.get("stationId") or _sirian_station_id()).strip().lower()
    try:
        limit = int(request.args.get("limit") or 90)
    except (TypeError, ValueError):
        limit = 90
    return jsonify(_dev_monitor_archive_dates_payload(station_id, limit))


@app.route("/api/credits/live-data/archive-dates")
def api_credits_live_data_archive_dates():
    viewer_sid, err = _require_staff_viewer()
    if err:
        return err
    station_id = str(request.args.get("stationId") or _sirian_station_id()).strip().lower()
    try:
        limit = int(request.args.get("limit") or 90)
    except (TypeError, ValueError):
        limit = 90
    return jsonify(_dev_monitor_archive_dates_payload(station_id, limit))


@app.route("/api/credits/dev-monitor/archives")
def api_credits_dev_monitor_archives():
    viewer_sid, err = _require_overlay_dev()
    if err:
        return err
    station_id = str(request.args.get("stationId") or _sirian_station_id()).strip().lower()
    date = str(request.args.get("date") or "").strip() or None
    try:
        limit = int(request.args.get("limit") or 40)
    except (TypeError, ValueError):
        limit = 40
    return jsonify(_dev_monitor_archives_payload(station_id, date, limit))


@app.route("/api/credits/live-data/archives")
def api_credits_live_data_archives():
    viewer_sid, err = _require_staff_viewer()
    if err:
        return err
    station_id = str(request.args.get("stationId") or _sirian_station_id()).strip().lower()
    date = str(request.args.get("date") or "").strip() or None
    try:
        limit = int(request.args.get("limit") or 40)
    except (TypeError, ValueError):
        limit = 40
    return jsonify(_dev_monitor_archives_payload(station_id, date, limit))


@app.route("/api/credits/dev-monitor/archive")
def api_credits_dev_monitor_archive():
    viewer_sid, err = _require_overlay_dev()
    if err:
        return err
    archive_id = str(request.args.get("archiveId") or request.args.get("id") or "").strip()
    if not archive_id:
        return jsonify({"ok": False, "error": "archiveId_required"}), 400
    packed = _archive_monitor_payload(get_store(), archive_id)
    if not packed:
        return jsonify({"ok": False, "error": "archive_not_found", "archiveId": archive_id}), 404
    return jsonify(packed)


@app.route("/api/credits/live-data/archive")
def api_credits_live_data_archive():
    viewer_sid, err = _require_staff_viewer()
    if err:
        return err
    archive_id = str(request.args.get("archiveId") or request.args.get("id") or "").strip()
    if not archive_id:
        return jsonify({"ok": False, "error": "archiveId_required"}), 400
    packed = _archive_monitor_payload(get_store(), archive_id)
    if not packed:
        return jsonify({"ok": False, "error": "archive_not_found", "archiveId": archive_id}), 404
    return jsonify(packed)


def _with_next_day_schedule(payload: dict) -> dict:
    out = dict(payload) if isinstance(payload, dict) else {}
    # 현재 시각 기준 가장 가까운 미래 부(1부/2부) 일정
    out["nextDaySchedule"] = build_next_day_schedule(SCHEDULE_PATH, SEED_SCHEDULE)
    # 시청자 엔딩(?viewer=1): 수집기 연결 마커 제거
    if str(request.args.get("viewer") or "").strip().lower() in ("1", "true", "yes"):
        from credits_store import timeline_for_viewer

        tl = out.get("timeline")
        if isinstance(tl, dict):
            out["timeline"] = timeline_for_viewer(tl)
    return out


def _signature_context_for_request() -> tuple[str, list[int], list[dict]]:
    """(liveStationId, amounts, balloons). 시그풍은 스트리머(BJ) 채널 기준."""
    live_sid = _resolve_live_station_id(request.args.get("stationId"))
    balloon_sid = _sirian_station_id()
    balloons = fetch_soop_signature_balloons(balloon_sid)
    soop_amounts = [int(b["amount"]) for b in balloons if isinstance(b, dict)]
    cfg = get_overlay_store().load(_resolve_overlay_station_id())
    slides = cfg.get("slides") if isinstance(cfg, dict) else {}
    row = slides.get("signature") if isinstance(slides, dict) else {}
    cfg_amounts = (
        parse_signature_amounts(row.get("amounts")) if isinstance(row, dict) else []
    )
    if soop_amounts:
        # 기본값 [100]만 있으면 숲 등록분만 사용. 그 외 수동 등록은 합친다.
        if not cfg_amounts or cfg_amounts == [100]:
            amounts = soop_amounts
        else:
            amounts = sorted(set(soop_amounts) | set(cfg_amounts))
        return live_sid, amounts, balloons
    return live_sid, cfg_amounts, balloons


def _attach_signature_balloons(payload: dict, balloons: list[dict]) -> dict:
    out = dict(payload) if isinstance(payload, dict) else {}
    out["signatureBalloons"] = balloons
    img_by = {
        int(b["amount"]): str(b.get("imageUrl") or "")
        for b in balloons
        if isinstance(b, dict) and b.get("amount") is not None
    }
    if not img_by:
        return out
    sections = out.get("sections")
    if not isinstance(sections, list):
        return out
    new_sections = []
    for sec in sections:
        if not isinstance(sec, dict) or sec.get("id") != "signature":
            new_sections.append(sec)
            continue
        items = []
        for it in sec.get("items") if isinstance(sec.get("items"), list) else []:
            if not isinstance(it, dict):
                continue
            row = dict(it)
            if not row.get("imageUrl"):
                digits = re.sub(r"[^\d]", "", str(row.get("name") or ""))
                try:
                    value = int(digits) if digits else 0
                except ValueError:
                    value = 0
                if value in img_by:
                    row["imageUrl"] = img_by[value]
            items.append(row)
        new_sections.append({**sec, "items": items})
    out["sections"] = new_sections
    return out


def _signature_amounts_for_request() -> list[int]:
    _sid, amounts, _balloons = _signature_context_for_request()
    return amounts


@app.route("/api/credits")
def api_credits():
    _sid, amounts, balloons = _signature_context_for_request()
    archive_id = str(request.args.get("archive") or "").strip()
    if archive_id:
        archived = get_store().load_archive_credits(archive_id)
        if not archived:
            return jsonify({"error": "archive_not_found", "archiveId": archive_id}), 404
        return jsonify(
            _attach_signature_balloons(
                _with_next_day_schedule(
                    apply_signature_amounts_to_payload(archived, amounts)
                ),
                balloons,
            )
        )
    if str(request.args.get("demo") or "").strip().lower() in ("1", "true", "yes"):
        # 풍부한 테스트 페이로드(타임라인 바늘은 요청 시점 기준)
        demo = build_demo_credits_payload()
        # seed 파일이 있으면 info.title 등 일부만 덮어쓸 수 있게 병합(선택)
        if SEED_CREDITS.exists():
            try:
                seed = json.loads(SEED_CREDITS.read_text(encoding="utf-8"))
                if isinstance(seed, dict) and seed.get("useGeneratedDemo") is False:
                    seed = dict(seed)
                    seed["demo"] = True
                    seed["source"] = "seed"
                    if not isinstance(seed.get("timeline"), dict):
                        seed["timeline"] = demo["timeline"]
                    return jsonify(
                        _attach_signature_balloons(
                            _with_next_day_schedule(
                                apply_signature_amounts_to_payload(seed, amounts)
                            ),
                            balloons,
                        )
                    )
            except (OSError, json.JSONDecodeError):
                pass
        return jsonify(
            _attach_signature_balloons(
                _with_next_day_schedule(apply_signature_amounts_to_payload(demo, amounts)),
                balloons,
            )
        )
    return jsonify(
        _attach_signature_balloons(
            _with_next_day_schedule(
                get_store().load_credits(signature_amounts=amounts or None)
            ),
            balloons,
        )
    )


@app.route("/api/credits/archives")
def api_credits_archives():
    """날짜별 아카이브 목록 (최신순). 일기장은 시리안 채널만.

    ?date=YYYY-MM-DD &limit=60
    """
    date = str(request.args.get("date") or "").strip() or None
    station_id = _sirian_station_id()
    try:
        limit = int(request.args.get("limit") or 60)
    except (TypeError, ValueError):
        limit = 60
    items = get_store().list_archives(date=date, limit=limit, station_id=station_id)
    return jsonify(
        {
            "ok": True,
            "items": items,
            "count": len(items),
            "stationId": station_id or "",
        }
    )


@app.route("/api/credits/archive-dates")
def api_credits_archive_dates():
    """일기장 인덱스 — 시리안 아카이브 날짜 목록."""
    station_id = _sirian_station_id()
    try:
        limit = int(request.args.get("limit") or 120)
    except (TypeError, ValueError):
        limit = 120
    items = get_store().list_archive_dates(limit=limit, station_id=station_id)
    return jsonify(
        {
            "ok": True,
            "items": items,
            "count": len(items),
            "stationId": station_id or "",
        }
    )


@app.route("/api/credits/archive-peak-thumb")
def api_credits_archive_peak_thumb():
    archive_id = str(request.args.get("archiveId") or request.args.get("archive") or "").strip()
    path = get_store().archive_peak_thumb_file(archive_id)
    if not path:
        return Response(status=404)
    data = path.read_bytes()
    ctype = "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        ctype = "image/png"
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        ctype = "image/webp"
    resp = Response(data, mimetype=ctype)
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


@app.route("/api/credits/signature-balloons")
def api_signature_balloons():
    """시그풍은 스트리머 채널 기준. 수집기 바인딩 id(dlpa37 등)로 조회하면 빈 목록이 됨."""
    streamer = _sirian_station_id()
    force = str(request.args.get("refresh") or "").strip().lower() in ("1", "true", "yes")
    items = fetch_soop_signature_balloons(streamer, force=force)
    return jsonify(
        {
            "ok": True,
            "stationId": streamer,
            "streamerStationId": streamer,
            "items": items,
            "amounts": [int(i["amount"]) for i in items],
            "source": "soop" if items else "empty",
        }
    )


@app.route("/api/credits/peak-thumb")
def api_credits_peak_thumb():
    store = get_store()
    path = store.peak_thumb_file()
    if not path.exists() or path.stat().st_size < 200:
        # 로컬 파일이 없으면 세션의 원격 URL로 한 번 더 받아 본다
        session = store.load_session()
        remote = str(session.get("peakThumbUrl") or session.get("thumbnailUrl") or "").strip()
        broad_no = str(session.get("broadNo") or "").strip()
        candidates = store.peak_thumb_candidates(remote, broad_no)
        if candidates:
            local = store.cache_peak_thumbnail_any(candidates)
            if local.startswith("/api/credits/peak-thumb"):
                session = store.load_session()
                if session.get("peakThumbUrl") != local:
                    session["peakThumbUrl"] = local
                    store.save_session(session, rebuild=True)
    if not path.exists() or path.stat().st_size < 200:
        return Response(status=404)
    data = path.read_bytes()
    ctype = "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        ctype = "image/png"
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        ctype = "image/webp"
    resp = Response(data, mimetype=ctype)
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


@app.route("/api/credits/overlay-config", methods=["GET"])
def api_overlay_config_get():
    station_id = _resolve_overlay_station_id(request.args.get("stationId"))
    cfg = get_overlay_store().load(station_id)
    out = dict(cfg) if isinstance(cfg, dict) else {}
    live_sid = _resolve_live_station_id(request.args.get("stationId"))
    streamer = _sirian_station_id()
    out["signatureBalloons"] = fetch_soop_signature_balloons(streamer)
    out["liveStationId"] = live_sid
    out["streamerStationId"] = streamer
    return jsonify(out)


@app.route("/api/credits/overlay-config", methods=["POST"])
def api_overlay_config_post():
    if not _collector_authorized():
        return _forbidden_collector_response()
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "invalid_json"}), 400
    station_id = _resolve_overlay_station_id(body.get("stationId") or request.args.get("stationId"))
    saved = get_overlay_store().save(body, station_id=station_id)
    out = dict(saved) if isinstance(saved, dict) else {}
    streamer = _sirian_station_id()
    out["signatureBalloons"] = fetch_soop_signature_balloons(streamer)
    out["streamerStationId"] = streamer
    out["liveStationId"] = _resolve_live_station_id(None)
    return jsonify(out)


# 스튜디오 → OBS 오버레이 재생/정지 명령 (OBS는 GET 폴링)
_overlay_control_lock = threading.Lock()
_overlay_control: dict = {"seq": 0, "action": None, "at": None}


@app.route("/api/credits/overlay-control", methods=["GET", "POST"])
def api_overlay_control():
    global _overlay_control
    if request.method == "POST":
        if not _collector_authorized():
            return _forbidden_collector_response()
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"error": "invalid_json"}), 400
        action = str(body.get("action") or "").strip().lower()
        if action not in ("play", "stop"):
            return jsonify({"error": "invalid_action"}), 400
        theme = str(body.get("theme") or "").strip()
        allowed_theme = {"report", "reportProj", "notebook", "default"}
        theme_out = None
        if action == "play" and theme in allowed_theme:
            if theme in ("notebook", "default"):
                theme_out = "reportProj"
            else:
                theme_out = theme
        with _overlay_control_lock:
            _overlay_control = {
                "seq": int(_overlay_control.get("seq") or 0) + 1,
                "action": action,
                "at": time.time(),
                "theme": theme_out,
            }
            out = dict(_overlay_control)
        return jsonify({"ok": True, **out})

    try:
        since = int(request.args.get("since") or 0)
    except (TypeError, ValueError):
        since = 0
    with _overlay_control_lock:
        cur = dict(_overlay_control)
    seq = int(cur.get("seq") or 0)
    if seq > since and cur.get("action"):
        return jsonify({"ok": True, "changed": True, **cur})
    return jsonify({"ok": True, "changed": False, "seq": seq})


@app.route("/api/credits/bind", methods=["POST"])
def api_bind():
    """로그인한 BJ 채널에 세션을 맞춘다."""
    if not _collector_authorized():
        return _forbidden_collector_response()
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400
    station_id = str(payload.get("stationId") or "").strip()
    if not station_id:
        return jsonify({"error": "stationId_required"}), 400
    if not _looks_like_soop_user_id(station_id):
        return jsonify(
            {
                "error": "invalid_station_id",
                "detail": "SOOP 채널 ID(영문 로그인 id)가 필요합니다. 닉네임은 사용할 수 없습니다.",
                "stationId": station_id,
            }
        ), 400
    if not _station_is_allowed(station_id) and not _is_overlay_dev(station_id):
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "forbidden_station",
                    "allowed": False,
                    "stationId": station_id,
                    "message": "허용된 숲 계정만 수집·저장할 수 있습니다.",
                }
            ),
            403,
        )
    store = get_store()
    session = store.bind_station(station_id, reset_if_changed=True)
    # 바인딩 직후 — 피크 썸네일 미존재 시에만 채움
    try:
        store.capture_live_frame(station_id=station_id, force=False)
        session = store.load_session()
    except Exception:
        pass
    resp = make_response(
        jsonify({"ok": True, "session": session, "credits": store.build_credits_payload(session)})
    )
    _set_ending_soop_cookie(resp, station_id)
    return resp


@app.route("/api/credits/obs-link", methods=["POST"])
def api_obs_link_ensure():
    """숲 로그인 후 OBS 전용 URL 키 발급/갱신 (위플랩식 안정 URL).

    stationinfo 가 닉만 주고 id 가 비어도(JWT/본문/토큰해시 폴백) 발급한다.
    """
    import hashlib

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400

    access = str(payload.get("accessToken") or payload.get("access_token") or "").strip()
    if not access:
        access = _extract_soop_access_token()
    if not access:
        return jsonify({"ok": False, "error": "token_required", "message": "숲 로그인이 필요합니다."}), 401

    refresh = str(payload.get("refreshToken") or payload.get("refresh_token") or "").strip()
    rotate = str(payload.get("rotate") or "").strip().lower() in ("1", "true", "yes")

    body_sid = str(payload.get("stationId") or payload.get("station_id") or "").strip()
    if body_sid and not _looks_like_soop_user_id(body_sid):
        body_sid = ""

    identity_sid, err, status = _soop_identity_from_token(access)
    if err and err not in ("", "soop_profile_empty"):
        # 만료·잘못된 토큰
        return (
            jsonify(
                {
                    "ok": False,
                    "error": err,
                    "allowed": False,
                    "message": "숲 토큰이 만료됐거나 유효하지 않습니다. 수집기에서 다시 로그인해 주세요.",
                }
            ),
            status if status in (401, 403) else 401,
        )

    station_id = ""
    if identity_sid and _looks_like_soop_user_id(identity_sid):
        station_id = identity_sid.lower()
    elif body_sid:
        station_id = body_sid.lower()
    else:
        jwt_sid = _station_id_from_jwt(access)
        if jwt_sid:
            station_id = jwt_sid.lower()

    if not station_id:
        # 닉만 있는 프로필: 토큰 기준 안정 키 (Chat SDK 는 access_token 으로 본인 방 연결)
        if _allow_any_soop_station():
            station_id = "u_" + hashlib.sha256(access.encode("utf-8")).hexdigest()[:20]
        else:
            return (
                jsonify(
                    {
                        "ok": False,
                        "error": "station_id_required",
                        "message": "채널 ID를 확인하지 못했습니다. 방송 연결 후 다시 시도하거나 다시 로그인해 주세요.",
                    }
                ),
                400,
            )

    if (
        not _station_is_allowed(station_id)
        and not _is_overlay_dev(station_id)
        and not station_id.startswith("u_")
    ):
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "forbidden_station",
                    "allowed": False,
                    "stationId": station_id,
                    "message": "허용된 숲 계정만 전용 URL을 만들 수 있습니다.",
                }
            ),
            403,
        )
    # allow-any 의 u_ 플레이스홀더는 통과
    if station_id.startswith("u_") and not _allow_any_soop_station():
        return jsonify({"ok": False, "error": "station_id_required"}), 400

    try:
        row = get_obs_link_store().ensure(
            station_id=station_id,
            access_token=access,
            refresh_token=refresh,
            rotate=rotate,
        )
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400

    key = row["key"]
    path = _obs_public_path(key, station_id if not station_id.startswith("u_") else "")
    resp = make_response(
        jsonify(
            {
                "ok": True,
                "key": key,
                "stationId": station_id,
                "obsPath": path,
                "updatedAt": row.get("updatedAt"),
                "stationResolved": not station_id.startswith("u_"),
            }
        )
    )
    if not station_id.startswith("u_") and (
        _station_is_allowed(station_id) or _is_overlay_dev(station_id)
    ):
        _set_ending_soop_cookie(resp, station_id)
    return resp


@app.route("/api/credits/obs-link/<key>", methods=["GET"])
def api_obs_link_bootstrap(key: str):
    """OBS 전용 URL이 로드될 때 토큰을 내려준다 (Interact 로그인 대체)."""
    row = get_obs_link_store().get(key)
    if not row:
        return jsonify({"ok": False, "error": "invalid_obs_key"}), 404
    return jsonify(
        {
            "ok": True,
            "stationId": row["stationId"],
            "accessToken": row["accessToken"],
            "refreshToken": row["refreshToken"],
            "updatedAt": row.get("updatedAt"),
        }
    )


@app.route("/api/credits/obs-link/<key>/tokens", methods=["POST"])
def api_obs_link_update_tokens(key: str):
    """OBS/수집기가 refresh 한 뒤 전용 키에 토큰을 다시 저장."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400
    access = str(payload.get("accessToken") or payload.get("access_token") or "").strip()
    refresh = str(payload.get("refreshToken") or payload.get("refresh_token") or "").strip()
    if not access:
        return jsonify({"ok": False, "error": "token_required"}), 400
    if not get_obs_link_store().get(key):
        return jsonify({"ok": False, "error": "invalid_obs_key"}), 404
    ok = get_obs_link_store().update_tokens(key, access_token=access, refresh_token=refresh)
    if not ok:
        return jsonify({"ok": False, "error": "update_failed"}), 500
    return jsonify({"ok": True})


@app.route("/api/credits/live-status")
def api_live_status():
    """숲 채널 라이브 여부 (수집 인증 없이 조회 — OBS 배지·뱅온 탐색용)."""
    sid = str(request.args.get("stationId") or "").strip()
    if not _looks_like_soop_user_id(sid):
        return jsonify({"ok": False, "error": "station_id_required", "isLive": False}), 400
    probe = str(request.args.get("probe") or "").strip().lower() in ("1", "true", "yes")
    status = fetch_soop_live_status(sid, probe=probe)
    return jsonify(
        {
            "ok": True,
            "stationId": sid.lower(),
            "isLive": bool(status.get("isLive")),
            "title": status.get("title") or "",
            "viewerCount": int(status.get("viewerCount") or 0),
            "broadNo": status.get("broadNo") or "",
        }
    )


@app.route("/api/credits/poll", methods=["POST"])
def api_poll():
    if not _collector_authorized():
        return _forbidden_collector_response()
    payload = request.get_json(silent=True)
    station_id = None
    update_title = False
    if isinstance(payload, dict):
        station_id = str(payload.get("stationId") or "").strip() or None
        # 수집기 500ms poll은 방제 비교 생략 — 서버 백그라운드 폴러(~10s)만 title 갱신
        update_title = str(payload.get("titlePoll") or "").strip().lower() in (
            "1",
            "true",
            "yes",
        )
    store = get_store()
    session = store.poll_once(station_id, update_title=update_title)
    if session is None:
        session = store.load_session()
    return jsonify({"ok": True, "session": session, "credits": store.build_credits_payload(session)})


@app.route("/api/credits/capture", methods=["POST"])
def api_capture():
    """로그인 BJ 방송 라이브 화면을 캡처(썸네일 고정). 썸네일 필드가 없어도 broadNo로 시도."""
    if not _collector_authorized():
        return _forbidden_collector_response()
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    station_id = str(payload.get("stationId") or "").strip() or None
    broad_no = str(payload.get("broadNo") or payload.get("broad_no") or "").strip()
    thumb_url = str(payload.get("thumbnailUrl") or payload.get("thumbUrl") or "").strip()
    force = str(payload.get("force") or "").strip().lower() in ("1", "true", "yes")
    store = get_store()
    if station_id:
        store.bind_station(station_id, reset_if_changed=True)
    # force=true 라도 이미 고정된 피크 썸네일은 덮지 않음 (replace_peak는 새 최고시청 경로만)
    result = store.capture_live_frame(
        station_id=station_id,
        broad_no=broad_no,
        thumb_url=thumb_url,
        force=force,
        replace_peak=False,
    )
    session = result.get("session") or store.load_session()
    return jsonify(
        {
            "ok": bool(result.get("ok")),
            "error": result.get("error"),
            "peakThumbUrl": result.get("peakThumbUrl") or session.get("peakThumbUrl"),
            "session": session,
            "credits": store.build_credits_payload(session),
        }
    )


@app.route("/api/credits/collector-presence", methods=["POST"])
def api_collector_presence():
    """OBS 브라우저·수집기 탭 heartbeat — 개발자 모니터 활성 표시용."""
    if not _collector_authorized():
        return _forbidden_collector_response()
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "invalid_json"}), 400
    station_id = str(payload.get("stationId") or payload.get("station_id") or "").strip().lower()
    if not station_id or not _looks_like_soop_user_id(station_id):
        return jsonify({"ok": False, "error": "station_id_required"}), 400
    source = str(payload.get("source") or "").strip().lower()
    if source not in VALID_SOURCES:
        return jsonify(
            {"ok": False, "error": "source_required", "allowed": sorted(VALID_SOURCES)}
        ), 400
    if payload.get("clear") in (True, 1, "1", "true", "yes"):
        snap = get_presence_store().clear(station_id, source)
        return jsonify({"ok": True, "clients": snap})
    phase = str(payload.get("phase") or "").strip()
    connected = bool(payload.get("connected"))
    try:
        snap = get_presence_store().touch(
            station_id, source, phase=phase, connected=connected
        )
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    return jsonify({"ok": True, "clients": snap})


@app.route("/api/credits/session/begin", methods=["POST"])
def api_session_begin():
    """채팅 SDK 연결 성공 — 종료된 세션이면 새 방송으로 연다."""
    if not _collector_authorized():
        return _forbidden_collector_response()
    payload = request.get_json(silent=True)
    station_id = None
    if isinstance(payload, dict):
        station_id = str(payload.get("stationId") or "").strip() or None
    store = get_store()
    session = store.begin_collecting(station_id)
    return jsonify({"ok": True, "session": session, "credits": store.build_credits_payload(session)})


@app.route("/api/credits/session/collector-pause", methods=["POST"])
def api_session_collector_pause():
    """수집기 탭 연결 해제 — 방송 중이면 세션·구간 유지, 방종 후에만 구간 종료."""
    if not _collector_authorized():
        return _forbidden_collector_response()
    payload = request.get_json(silent=True)
    station_id = None
    if isinstance(payload, dict):
        station_id = str(payload.get("stationId") or "").strip() or None
    store = get_store()
    session = store.pause_collecting(station_id)
    return jsonify({"ok": True, "session": session, "credits": store.build_credits_payload(session)})


@app.route("/api/credits/session/end", methods=["POST"])
def api_session_end():
    """채팅 연결 종료(방종) — 세션을 종료 표시해 다음 뱅온 때 새 데이터가 쌓이게 한다."""
    if not _collector_authorized():
        return _forbidden_collector_response()
    payload = request.get_json(silent=True)
    station_id = None
    if isinstance(payload, dict):
        station_id = str(payload.get("stationId") or "").strip() or None
    store = get_store()
    session = store.mark_session_ended(station_id)
    return jsonify({"ok": True, "session": session, "credits": store.build_credits_payload(session)})


@app.route("/api/credits/ingest", methods=["POST"])
def api_ingest():
    payload = request.get_json(silent=True)
    station_id = None
    source = ""
    if isinstance(payload, dict):
        station_id = str(payload.get("stationId") or "").strip() or None
        source = str(payload.get("source") or "").strip().lower()
    if not _collector_authorized():
        if station_id:
            try:
                get_ingest_activity_store().mark_auth_fail(station_id, source=source)
            except Exception:
                pass
        return _forbidden_collector_response()
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400
    events = payload.get("events")
    if not isinstance(events, list):
        return jsonify({"error": "events_required"}), 400
    # OBS·수집기 둘 다 채팅 연결 중이면 OBS만 반영 (이중 집계 방지)
    skipped_secondary = False
    if station_id and source in VALID_SOURCES:
        snap = get_presence_store().snapshot(station_id)
        obs_on = bool((snap.get("obs") or {}).get("connected"))
        col_on = bool((snap.get("collector") or {}).get("connected"))
        if obs_on and col_on and source == "collector":
            skipped_secondary = True
            events = []
    store = get_store()
    # SSAPI는 미션 제목·결과 보조. 수집기 연결 구간으로 치지 않음.
    mark_sdk = source not in {"ssapi"}
    session = store.ingest_events(
        events, station_id=station_id, source=source, mark_sdk=mark_sdk
    )
    stats = store.last_ingest_stats()
    sid = station_id or str((session or {}).get("stationId") or "").strip()
    if sid:
        try:
            get_ingest_activity_store().touch(
                sid,
                source=source,
                accepted=int(stats.get("accepted") or 0),
                received=int(
                    stats.get("received")
                    or (len(events) if isinstance(events, list) else 0)
                ),
                skipped_secondary=skipped_secondary,
            )
        except Exception:
            pass
    return jsonify(
        {
            "ok": True,
            "accepted": stats.get("accepted", 0),
            "duplicates": stats.get("duplicates", 0),
            "received": stats.get("received", len(events) if isinstance(events, list) else 0),
            "skippedSecondary": skipped_secondary,
            "credits": store.build_credits_payload(session),
        }
    )


@app.route("/")
def ending_home():
    return send_from_directory(ENDING_DIR, "index.html")


@app.route("/studio")
@app.route("/studio/")
def ending_studio():
    return send_from_directory(ENDING_DIR, "studio.html")


@app.route("/dev")
@app.route("/dev/")
def ending_dev_monitor():
    return send_from_directory(ENDING_DIR, "dev.html")


@app.route("/dev/me")
@app.route("/dev/me/")
def ending_dev_monitor_me():
    return send_from_directory(ENDING_DIR, "me.html")


@app.route("/live_data")
@app.route("/live_data/")
def ending_live_data():
    return send_from_directory(ENDING_DIR, "live_data.html")


@app.route("/diary")
@app.route("/diary/")
def ending_diary():
    return send_from_directory(ENDING_DIR, "diary.html")


@app.route("/obs")
@app.route("/obs/")
def ending_obs():
    return send_from_directory(ENDING_DIR, "obs.html")


@app.route("/designer")
@app.route("/designer/")
def ending_designer_index():
    """디자이너용 페이지 캡처·데이터 가이드 (로그인 불필요)."""
    return send_from_directory(ENDING_DIR / "designer", "index.html")


@app.route("/designer/<path:filename>")
def ending_designer_static(filename: str):
    return send_from_directory(ENDING_DIR / "designer", filename)


@app.route("/js/<path:filename>")
def ending_js(filename: str):
    return send_from_directory(ENDING_DIR / "js", filename)


@app.route("/css/<path:filename>")
def ending_css(filename: str):
    return send_from_directory(ENDING_DIR / "css", filename)


@app.route("/fonts/<path:filename>")
def ending_fonts(filename: str):
    """로컬 개발용. 운영은 nginx /fonts → 저장소 fonts/."""
    return send_from_directory(BASE_DIR / "fonts", filename)


@app.route("/favicon.ico")
def favicon():
    return redirect("/ending/", code=302)


# gunicorn 워커 기동 시에도 폴러·데이터 파일 준비
get_store()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT, debug=False)
