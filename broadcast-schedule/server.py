#!/usr/bin/env python3
"""방송 일정표 — Google OAuth + JSON 저장"""
import json
import imghdr
import fcntl
import os
import re
import xml.etree.ElementTree as ET
import secrets
import shutil
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
from functools import wraps
from html import escape
from pathlib import Path
from urllib.parse import urljoin, urlparse
from zoneinfo import ZoneInfo

import youtube_api as yt_api

import ga4_analytics
import musicbook_audit
import schedule_audit
import server_metrics_store
import system_metrics

from flask import (
    Flask,
    Response,
    jsonify,
    make_response,
    redirect,
    request,
    send_file,
    send_from_directory,
    session,
)

BASE_DIR = Path(__file__).resolve().parent

import sys

if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from ics_export import build_schedule_ics, calendar_webcal_url, _format_bangon_time_display, _format_slot_start_time_display

SEED_PATH = BASE_DIR / "seed" / "schedule.json"
SEED_MUSICBOOK_PATH = BASE_DIR / "seed" / "musicbook.json"
SEED_LINKS_PATH = BASE_DIR / "seed" / "links.json"
SEED_PATCHNOTES_PATH = BASE_DIR / "seed" / "patchnotes.json"
SEED_SONG_REQUESTS_PATH = BASE_DIR / "seed" / "song-requests.json"

PORT = int(os.environ.get("SCHEDULE_PORT", "8011"))
APP_BASE_URL = os.environ.get("APP_BASE_URL", f"http://127.0.0.1:{PORT}").rstrip("/")
SECRET_KEY = os.environ.get("SECRET_KEY", "dev-insecure-change-me")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
SESSION_DAYS = int(os.environ.get("SESSION_DAYS", "30"))
LOAD_TEST_SECRET = os.environ.get("LOAD_TEST_SECRET", "").strip()
LOAD_TEST_EMAIL_RE = re.compile(r"^loadtest\+(\d+)@loadtest\.local$")
APP_MODE = os.environ.get("APP_MODE", "production")
APP_STARTED_AT = time.time()

DATA_DIR = BASE_DIR / "data"
SCHEDULE_PATH = DATA_DIR / "schedule.json"
CALENDAR_ICS_PATH = DATA_DIR / "calendar.ics"
MUSICBOOK_PATH = DATA_DIR / "musicbook.json"
MUSICBOOK_LIKES_PATH = DATA_DIR / "musicbook-likes.json"
MUSICBOOK_LIKES_LOCK_PATH = DATA_DIR / "musicbook-likes.lock"
LINKS_PATH = DATA_DIR / "links.json"
PATCHNOTES_PATH = DATA_DIR / "patchnotes.json"
CONFIG_PATH = DATA_DIR / "config.json"
MANAGERS_PATH = DATA_DIR / "managers.json"
SONG_REQUESTS_PATH = DATA_DIR / "song-requests.json"

# 매니저 세분 권한 (스트리머·개발자는 전체 권한)
MANAGER_PERMISSIONS = frozenset(
    {
        "calendar",
        "home",
        "musicbook",
        "managers",
        "songrequests",
        "songrequests_available",
    }
)
LEGACY_PERMISSION_ALIASES = {
    "schedule.slots": "calendar",
    "schedule.months": "calendar",
    "schedule.meta": "calendar",
    "schedule.design": "calendar",
    "links.edit": "home",
    "links.icons": "home",
    "musicbook.edit": "musicbook",
    "managers.manage": "managers",
    "musicbook.songrequests": "songrequests",
    "songrequests.manage": "songrequests",
    "songrequests.approve": "songrequests_available",
}
PERMISSION_CATALOG = [
    {
        "id": "calendar",
        "label": "방송일정 편집",
        "subtitle": "월별 일정·방송 슬롯",
        "hint": "캘린더 슬롯·하이라이트 편집, 카테고리·디자인 설정",
    },
    {
        "id": "home",
        "label": "홈·링크 관리",
        "subtitle": "홈 문구·링크·아이콘",
        "hint": "홈 페이지 문구, 링크 모음, 아이콘 관리",
    },
    {
        "id": "musicbook",
        "label": "뮤직북 편집",
        "subtitle": "신청·금지 곡 목록",
        "hint": "신청 가능·금지 곡 목록 편집",
    },
    {
        "id": "songrequests",
        "label": "노래책 신청 검토",
        "subtitle": "검토·반려·금지 반영",
        "hint": "노래책 신청 검토·반려, 금지곡 반영",
    },
    {
        "id": "songrequests_available",
        "label": "노래책 신청 승인",
        "subtitle": "승인 후 목록 등록",
        "hint": "검토 후 신청 가능 곡 목록에 추가",
    },
    {
        "id": "managers",
        "label": "매니저 관리",
        "subtitle": "초대·권한 설정",
        "hint": "매니저 초대 및 권한 설정",
    },
]
DEVELOPER_SIMULATABLE_PERMISSIONS = frozenset(p for p in MANAGER_PERMISSIONS if p != "managers")
STAFF_SELF_DISABLE_PERMISSIONS = DEVELOPER_SIMULATABLE_PERMISSIONS
SONG_REQUESTS_LINK_LABEL = "노래책 신청"
SONG_REQUESTS_LINK_DESCRIPTION = "노래책에 없는 곡을 신청합니다. 검토 후 반영됩니다."
SCHEDULE_META_FIELDS = frozenset({"streamerName", "debutDate", "platformNote", "categories"})
SCHEDULE_DESIGN_FIELDS = frozenset(
    {
        "brandColor",
        "calendarLayout",
        "slotChipStyle",
        "chipColorMode",
        "proportionalMinSlots",
        "hourlyMinSlots",
        "calendarFont",
        "sidebarFont",
        "calendarFontBold",
        "sidebarFontBold",
    }
)
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

UPLOADS_DIR = BASE_DIR / "uploads"  # legacy — migrate to data/link-icons
LINK_ICON_UPLOAD_DIR = DATA_DIR / "link-icons"
MAX_LINK_ICON_BYTES = int(os.environ.get("MAX_LINK_ICON_BYTES", str(2 * 1024 * 1024)))
PATCHNOTE_IMAGE_UPLOAD_DIR = DATA_DIR / "patchnote-images"
MAX_PATCHNOTE_IMAGE_BYTES = int(os.environ.get("MAX_PATCHNOTE_IMAGE_BYTES", str(4 * 1024 * 1024)))

PATCHNOTE_AREAS = frozenset({"홈", "캘린더", "노래책", "사이트"})
PATCHNOTE_AREA_ORDER = ("홈", "캘린더", "노래책", "사이트")
PATCHNOTES_PER_PAGE_DEFAULT = 5
PATCHNOTES_PER_PAGE_MAX = 20
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SONG_STATUSES = frozenset({"available", "banned"})
SONG_LANGUAGES = frozenset({"K", "J", "E"})
SONG_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{4,64}$")
MUSICBOOK_SORT_KEYS = frozenset(
    {
        "likes-desc",
        "order-asc",
        "title-asc",
        "title-desc",
        "artist-asc",
        "artist-desc",
        "lang-asc",
        "capsule-asc",
        "updated-desc",
    }
)

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

app = Flask(__name__, static_folder=str(BASE_DIR), static_url_path="")
app.config.update(
    SECRET_KEY=SECRET_KEY,
    SESSION_COOKIE_NAME="schedule_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(days=SESSION_DAYS),
)


OPS_PAGE_LABELS = {
    "home": "홈",
    "calendar": "방송 일정",
    "musicbook": "노래책",
    "song-requests": "노래책 신청",
    "auth": "인증",
    "analytics": "운영 도구",
    "other": "기타",
}

OPS_AUDIENCE_LABELS = {
    "user": "방문자",
    "ops": "운영 도구",
    "all": "전체",
}


def ops_page_key(path: str) -> str:
    """요청 경로를 사이트 페이지 그룹으로 분류."""
    p = str(path or "").split("?", 1)[0]
    if not p.startswith("/"):
        p = f"/{p.lstrip('/')}"
    p = p.rstrip("/") or "/"

    if p.startswith("/api/song-requests") or p.startswith("/song-requests"):
        return "song-requests"
    if p.startswith("/games") or p.startswith("/api/rooms") or p.startswith("/api/lobby") or p.startswith("/api/minesweeper") or p.startswith("/api/apple") or p.startswith("/api/hide") or p.startswith("/api/2048") or p.startswith("/api/colortiles") or p.startswith("/api/hub"):
        return "games"
    if p.startswith("/api/musicbook") or p.startswith("/musicbook"):
        return "musicbook"
    if p.startswith("/api/schedule") or p in ("/calendar", "/schedule"):
        return "calendar"
    if p.startswith("/api/links") or p in ("/", "/home", "/links") or p.endswith("/home"):
        return "home"
    if p.startswith("/api/auth"):
        return "auth"
    if (
        p.startswith("/api/analytics")
        or p.startswith("/api/ops")
        or p.startswith("/api/server-status")
        or p == "/analytics"
    ):
        return "analytics"
    return "other"


def ops_is_developer_traffic(path: str) -> bool:
    """운영 대시보드·서버 상태 등 개발자 전용 요청."""
    return ops_page_key(path) == "analytics"


def _ops_normalize_audience(raw: str) -> str:
    audience = str(raw or "").strip().lower() or "user"
    return audience if audience in OPS_AUDIENCE_LABELS else "user"


def _ops_traffic_summary(events: list) -> dict:
    times = [float(e.get("elapsedMs") or 0) for e in events]
    if not times:
        return {"total": 0, "errors": 0, "p50Ms": None, "p95Ms": None, "maxMs": None}

    def pctl(values: list[float], pct: float) -> float | None:
        ordered = sorted(values)
        k = int(round((pct / 100) * (len(ordered) - 1)))
        k = max(0, min(len(ordered) - 1, k))
        return ordered[k]

    return {
        "total": len(events),
        "errors": sum(1 for e in events if int(e.get("status") or 0) >= 500),
        "p50Ms": pctl(times, 50),
        "p95Ms": pctl(times, 95),
        "maxMs": max(times),
    }


OPS_LIVE_WINDOW_SEC = 60
_OPS_USER_SKIP_PREFIXES = ("/api/ops", "/api/analytics", "/api/server-status", "/analytics")


def _ops_path_counts_for_users(path: str) -> bool:
    p = str(path or "")
    if any(p.startswith(prefix) for prefix in _OPS_USER_SKIP_PREFIXES):
        return False
    if p.endswith((".js", ".css", ".map", ".ico", ".png", ".jpg", ".jpeg", ".svg", ".woff", ".woff2")):
        return False
    return True


def _ops_client_key() -> str:
    try:
        user = session.get("user") or {}
        email = str(user.get("email") or "").strip().lower()
        if email:
            return f"u:{email}"
    except Exception:
        pass
    try:
        forwarded = request.headers.get("X-Forwarded-For", "")
        ip = (forwarded.split(",")[0].strip() if forwarded else "") or (request.remote_addr or "")
        ua = (request.headers.get("User-Agent") or "")[:120]
        return f"g:{ip}|{hash(ua)}"
    except Exception:
        return "g:unknown"


class OpsMetrics:
    """In-process request metrics for the 운영 대시보드.

    멀티 프로세스(gunicorn workers) 환경에서는 worker별 값이 분리됩니다.
    운영 화면에서 '대략적인 트래픽/지연/에러'를 빠르게 보기 위한 best-effort 지표입니다.
    """

    def __init__(self, *, max_events: int = 20000):
        from collections import deque
        import threading

        self._lock = threading.Lock()
        self._events = deque(maxlen=max_events)
        self._in_flight = 0

    def begin(self):
        with self._lock:
            self._in_flight += 1

    def end(self, *, path: str, method: str, status: int, elapsed_ms: float, client_key: str = ""):
        evt = {
            "ts": time.time(),
            "path": str(path or ""),
            "method": str(method or ""),
            "status": int(status or 0),
            "elapsedMs": float(elapsed_ms or 0.0),
            "clientKey": str(client_key or ""),
        }
        with self._lock:
            self._events.append(evt)
            self._in_flight = max(0, self._in_flight - 1)

    def snapshot(
        self,
        *,
        window_s: int = 600,
        bucket_s: int = 10,
        page: str | None = None,
        audience: str = "user",
    ) -> dict:
        now = time.time()
        window_s = max(10, int(window_s))
        bucket_s = max(1, int(bucket_s))
        start = now - window_s
        page_filter = str(page or "").strip() or None
        audience = _ops_normalize_audience(audience)

        with self._lock:
            in_flight = self._in_flight
            window_events = [e for e in self._events if float(e.get("ts") or 0) >= start]

        developer_pool = [e for e in window_events if ops_is_developer_traffic(str(e.get("path") or ""))]
        visitor_pool = [e for e in window_events if not ops_is_developer_traffic(str(e.get("path") or ""))]
        if audience == "ops":
            events = developer_pool
        elif audience == "all":
            events = window_events
        else:
            events = visitor_pool

        if page_filter:
            events = [e for e in events if ops_page_key(str(e.get("path") or "")) == page_filter]

        developer_traffic = _ops_traffic_summary(developer_pool) if audience == "user" else None

        bucket_count = int((now - start) // bucket_s) + 1
        buckets = [{"t": start + i * bucket_s, "count": 0, "errors": 0, "p95Ms": None} for i in range(bucket_count)]
        by_bucket_times: list[list[float]] = [[] for _ in buckets]

        per_endpoint: dict[str, dict] = {}
        per_page: dict[str, dict] = {}
        window_clients: set[str] = set()
        live_clients: set[str] = set()
        live_start = now - OPS_LIVE_WINDOW_SEC
        all_times: list[float] = []
        live_times: list[float] = []
        live_total = 0
        live_errors = 0

        for e in events:
            idx = int((float(e.get("ts") or now) - start) // bucket_s)
            elapsed = float(e.get("elapsedMs") or 0)
            all_times.append(elapsed)
            path = str(e.get("path") or "")
            client_key = str(e.get("clientKey") or "")
            if client_key and _ops_path_counts_for_users(path):
                window_clients.add(client_key)
            ts = float(e.get("ts") or now)
            if ts >= live_start:
                live_total += 1
                if int(e.get("status") or 0) >= 500:
                    live_errors += 1
                live_times.append(elapsed)
                if client_key and _ops_path_counts_for_users(path):
                    live_clients.add(client_key)

            if 0 <= idx < len(buckets):
                buckets[idx]["count"] += 1
                if int(e.get("status") or 0) >= 500:
                    buckets[idx]["errors"] += 1
                by_bucket_times[idx].append(elapsed)

            method = str(e.get("method") or "")
            key = f"{method} {path}".strip()
            ep_page = ops_page_key(path)
            slot = per_endpoint.setdefault(
                key,
                {
                    "key": key,
                    "path": path,
                    "method": method,
                    "page": ep_page,
                    "pageLabel": OPS_PAGE_LABELS.get(ep_page, ep_page),
                    "count": 0,
                    "errors": 0,
                    "times": [],
                },
            )
            slot["count"] += 1
            if int(e.get("status") or 0) >= 500:
                slot["errors"] += 1
            slot["times"].append(elapsed)

            page_key = ops_page_key(path)
            page_slot = per_page.setdefault(
                page_key,
                {
                    "key": page_key,
                    "label": OPS_PAGE_LABELS.get(page_key, page_key),
                    "count": 0,
                    "errors": 0,
                    "times": [],
                    "_clients": set(),
                },
            )
            page_slot["count"] += 1
            if int(e.get("status") or 0) >= 500:
                page_slot["errors"] += 1
            page_slot["times"].append(elapsed)
            if client_key and _ops_path_counts_for_users(path):
                page_slot["_clients"].add(client_key)

        def pctl(values: list[float], pct: float) -> float | None:
            if not values:
                return None
            ordered = sorted(values)
            k = int(round((pct / 100) * (len(ordered) - 1)))
            k = max(0, min(len(ordered) - 1, k))
            return ordered[k]

        for i, times in enumerate(by_bucket_times):
            buckets[i]["p95Ms"] = pctl(times, 95)

        endpoints = []
        for slot in per_endpoint.values():
            times = slot.pop("times", [])
            slot["p50Ms"] = pctl(times, 50)
            slot["p95Ms"] = pctl(times, 95)
            slot["maxMs"] = max(times) if times else None
            endpoints.append(slot)
        endpoints.sort(key=lambda r: (r.get("errors", 0), r.get("count", 0)), reverse=True)

        page_order = list(OPS_PAGE_LABELS.keys())
        pages = []
        for slot in per_page.values():
            times = slot.pop("times", [])
            clients = slot.pop("_clients", set())
            slot["p50Ms"] = pctl(times, 50)
            slot["p95Ms"] = pctl(times, 95)
            slot["maxMs"] = max(times) if times else None
            slot["activeUsers"] = len(clients)
            pages.append(slot)
        pages.sort(
            key=lambda r: (
                page_order.index(r.get("key")) if r.get("key") in page_order else 99,
                -(r.get("count") or 0),
            ),
        )

        recent_events = []
        for e in reversed(events[-50:]):
            path = str(e.get("path") or "")
            recent_events.append(
                {
                    "ts": float(e.get("ts") or 0),
                    "method": str(e.get("method") or ""),
                    "path": path,
                    "page": ops_page_key(path),
                    "pageLabel": OPS_PAGE_LABELS.get(ops_page_key(path), ops_page_key(path)),
                    "status": int(e.get("status") or 0),
                    "elapsedMs": float(e.get("elapsedMs") or 0),
                }
            )

        return {
            "windowSec": window_s,
            "bucketSec": bucket_s,
            "page": page_filter,
            "audience": audience,
            "audienceLabel": OPS_AUDIENCE_LABELS.get(audience, audience),
            "pageLabels": OPS_PAGE_LABELS,
            "developerTraffic": developer_traffic,
            "inFlight": int(in_flight),
            "total": len(events),
            "errors": sum(1 for e in events if int(e.get("status") or 0) >= 500),
            "activeUsers": len(window_clients),
            "p50Ms": pctl(all_times, 50),
            "p95Ms": pctl(all_times, 95),
            "avgMs": (sum(all_times) / len(all_times)) if all_times else None,
            "live": {
                "windowSec": OPS_LIVE_WINDOW_SEC,
                "total": live_total,
                "errors": live_errors,
                "activeUsers": len(live_clients),
                "p50Ms": pctl(live_times, 50),
                "p95Ms": pctl(live_times, 95),
                "avgMs": (sum(live_times) / len(live_times)) if live_times else None,
                "rps": live_total / OPS_LIVE_WINDOW_SEC if OPS_LIVE_WINDOW_SEC else 0,
            },
            "buckets": buckets,
            "topPages": pages,
            "topEndpoints": endpoints[:20],
            "recentEvents": recent_events,
            "updatedAt": utc_now(),
        }


OPS_METRICS = OpsMetrics()


@app.before_request
def _ops_metrics_begin():
    try:
        request._ops_started_at = time.perf_counter()
        OPS_METRICS.begin()
    except Exception:
        pass


@app.after_request
def _api_no_cache(response):
    try:
        started = getattr(request, "_ops_started_at", None)
        if started is not None:
            OPS_METRICS.end(
                path=request.path,
                method=request.method,
                status=getattr(response, "status_code", 0) or 0,
                elapsed_ms=(time.perf_counter() - started) * 1000,
                client_key=_ops_client_key(),
            )
    except Exception:
        pass
    if request.path.startswith("/api/") and "Cache-Control" not in response.headers:
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
    return response


_BLOCKED_STATIC_PREFIXES = ("data/", "venv/", "seed/", "logs/", "scripts/")
_BLOCKED_STATIC_NAMES = {
    ".env",
    ".env.beta",
    ".env.example",
    ".env.beta.example",
    "server.py",
    "requirements.txt",
    "analytics.html",
}


def apply_runtime_config():
    global DATA_DIR, SCHEDULE_PATH, CALENDAR_ICS_PATH, MUSICBOOK_PATH, MUSICBOOK_LIKES_PATH, MUSICBOOK_LIKES_LOCK_PATH, LINKS_PATH, PATCHNOTES_PATH, CONFIG_PATH, MANAGERS_PATH, SONG_REQUESTS_PATH
    global SECRET_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_BASE_URL
    global APP_MODE, LINK_ICON_UPLOAD_DIR, PATCHNOTE_IMAGE_UPLOAD_DIR, LOAD_TEST_SECRET

    DATA_DIR = BASE_DIR / os.environ.get("SCHEDULE_DATA_DIR", "data")
    SCHEDULE_PATH = DATA_DIR / "schedule.json"
    CALENDAR_ICS_PATH = DATA_DIR / "calendar.ics"
    MUSICBOOK_PATH = DATA_DIR / "musicbook.json"
    MUSICBOOK_LIKES_PATH = DATA_DIR / "musicbook-likes.json"
    MUSICBOOK_LIKES_LOCK_PATH = DATA_DIR / "musicbook-likes.lock"
    LINKS_PATH = DATA_DIR / "links.json"
    PATCHNOTES_PATH = DATA_DIR / "patchnotes.json"
    CONFIG_PATH = DATA_DIR / "config.json"
    MANAGERS_PATH = DATA_DIR / "managers.json"
    SONG_REQUESTS_PATH = DATA_DIR / "song-requests.json"
    LINK_ICON_UPLOAD_DIR = DATA_DIR / "link-icons"
    PATCHNOTE_IMAGE_UPLOAD_DIR = DATA_DIR / "patchnote-images"
    SECRET_KEY = os.environ.get("SECRET_KEY", SECRET_KEY)
    GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", GOOGLE_CLIENT_ID)
    GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", GOOGLE_CLIENT_SECRET)
    APP_BASE_URL = os.environ.get("APP_BASE_URL", APP_BASE_URL).rstrip("/")
    APP_MODE = os.environ.get("APP_MODE", APP_MODE)
    LOAD_TEST_SECRET = os.environ.get("LOAD_TEST_SECRET", LOAD_TEST_SECRET).strip()

    app.config["SECRET_KEY"] = SECRET_KEY
    cookie_path = os.environ.get("SESSION_COOKIE_PATH", "").strip()
    if cookie_path:
        app.config["SESSION_COOKIE_PATH"] = cookie_path
    if os.environ.get("SESSION_COOKIE_SECURE", "").lower() in ("1", "true", "yes"):
        app.config["SESSION_COOKIE_SECURE"] = True
    cookie_domain = os.environ.get("SESSION_COOKIE_DOMAIN", "").strip()
    if cookie_domain:
        app.config["SESSION_COOKIE_DOMAIN"] = cookie_domain


def is_beta_mode():
    return APP_MODE == "beta"


def auth_mode():
    if is_beta_mode() or google_enabled():
        return "google"
    return "toggle"


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def google_enabled():
    return bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)


def oauth_redirect_uri():
    return urljoin(APP_BASE_URL + "/", "api/auth/google/callback")


def http_post_form(url, data):
    body = urllib.parse.urlencode(data).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_get_json(url, access_token):
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {access_token}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_developer_emails():
    emails = set()
    env_val = os.environ.get("DEVELOPER_EMAILS", "")
    for part in env_val.split(","):
        part = part.strip().lower()
        if part:
            emails.add(part)
    if CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            for e in cfg.get("developerEmails", []):
                if e:
                    emails.add(str(e).strip().lower())
        except (json.JSONDecodeError, OSError):
            pass
    return emails


def load_streamer_emails():
    emails = set()
    env_val = os.environ.get("STREAMER_EMAILS", "")
    for part in env_val.split(","):
        part = part.strip().lower()
        if part:
            emails.add(part)
    if CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            for e in cfg.get("streamerEmails", []):
                if e:
                    emails.add(str(e).strip().lower())
        except (json.JSONDecodeError, OSError):
            pass
    return emails


def _developer_emails_from_env():
    emails = set()
    env_val = os.environ.get("DEVELOPER_EMAILS", "")
    for part in env_val.split(","):
        part = part.strip().lower()
        if part:
            emails.add(part)
    return emails


def _streamer_emails_from_env():
    emails = set()
    env_val = os.environ.get("STREAMER_EMAILS", "")
    for part in env_val.split(","):
        part = part.strip().lower()
        if part:
            emails.add(part)
    return emails


def load_config_dict():
    if not CONFIG_PATH.is_file():
        return {}
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return cfg if isinstance(cfg, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_config_dict(cfg: dict):
    ensure_data_dir()
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _staff_role_locked(email: str, role: str) -> bool:
    normalized = normalize_manager_email(email)
    if role == "developer":
        return normalized in _developer_emails_from_env()
    if role == "streamer":
        return normalized in _streamer_emails_from_env()
    return False


def remove_streamer_from_config(email: str):
    normalized = normalize_manager_email(email)
    if normalized in _streamer_emails_from_env():
        return False, "streamer_locked"
    cfg = load_config_dict()
    raw_list = cfg.get("streamerEmails") or []
    if not isinstance(raw_list, list):
        raw_list = []
    next_list = [e for e in raw_list if normalize_manager_email(e) != normalized]
    if len(next_list) == len(raw_list):
        return False, "not_found"
    cfg["streamerEmails"] = next_list
    save_config_dict(cfg)
    return True, None


def remove_developer_from_config(email: str):
    normalized = normalize_manager_email(email)
    if normalized in _developer_emails_from_env():
        return False, "developer_locked"
    cfg = load_config_dict()
    raw_list = cfg.get("developerEmails") or []
    if not isinstance(raw_list, list):
        raw_list = []
    next_list = [e for e in raw_list if normalize_manager_email(e) != normalized]
    if len(next_list) == len(raw_list):
        return False, "not_found"
    cfg["developerEmails"] = next_list
    save_config_dict(cfg)
    return True, None


def _load_test_secret_ok() -> bool:
    secret = os.environ.get("LOAD_TEST_SECRET", "").strip()
    if not secret:
        return False
    provided = request.headers.get("X-Load-Test-Secret", "")
    return bool(provided) and secrets.compare_digest(provided, secret)


def _load_test_user_from_request():
    if not os.environ.get("LOAD_TEST_SECRET", "").strip():
        return None
    if not _load_test_secret_ok():
        return None
    raw = str(request.headers.get("X-Load-Test-User-Id", "")).strip()
    if not raw:
        return None
    try:
        user_id = int(raw)
    except ValueError:
        return None
    if user_id < 0 or user_id > 9999:
        return None
    email = normalize_manager_email(f"loadtest+{user_id}@loadtest.local")
    return {"email": email, "name": f"LoadTest {user_id}", "picture": ""}


def current_user():
    load_test_user = _load_test_user_from_request()
    if load_test_user:
        return load_test_user
    return session.get("user")


def load_managers_data():
    if not MANAGERS_PATH.is_file():
        return {"managers": []}
    try:
        data = json.loads(MANAGERS_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return {"managers": []}
        managers = data.get("managers")
        if not isinstance(managers, list):
            data["managers"] = []
        else:
            data["managers"] = managers
        names = data.get("displayNames")
        if names is not None and not isinstance(names, dict):
            data["displayNames"] = {}
        staff = data.get("staffDisabledPermissions")
        if staff is not None and not isinstance(staff, dict):
            data["staffDisabledPermissions"] = {}
        return data
    except (json.JSONDecodeError, OSError):
        return {"managers": []}


def save_managers_data(data):
    ensure_data_dir()
    MANAGERS_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_display_names():
    data = load_managers_data()
    names = data.get("displayNames")
    if not isinstance(names, dict):
        return {}
    return {normalize_manager_email(k): str(v or "").strip() for k, v in names.items() if k}


def save_display_name(email: str, name: str):
    normalized = normalize_manager_email(email)
    if not normalized or not name:
        return
    data = load_managers_data()
    names = data.get("displayNames")
    if not isinstance(names, dict):
        names = {}
    names[normalized] = str(name).strip()[:40]
    data["displayNames"] = names
    save_managers_data(data)


def remove_display_name(email: str):
    normalized = normalize_manager_email(email)
    if not normalized:
        return
    data = load_managers_data()
    names = data.get("displayNames")
    if not isinstance(names, dict) or normalized not in names:
        return
    del names[normalized]
    data["displayNames"] = names
    save_managers_data(data)


def normalize_manager_email(email: str) -> str:
    return str(email or "").strip().lower()


def get_manager_record(email: str):
    normalized = normalize_manager_email(email)
    if not normalized:
        return None
    for entry in load_managers_data().get("managers", []):
        if not isinstance(entry, dict):
            continue
        if normalize_manager_email(entry.get("email")) == normalized:
            return entry
    return None


def normalize_manager_permissions(raw) -> list:
    if not isinstance(raw, (list, tuple, set)):
        return []
    out = []
    for item in raw:
        key = str(item or "").strip()
        if key == "full":
            return sorted(MANAGER_PERMISSIONS)
        mapped = LEGACY_PERMISSION_ALIASES.get(key, key)
        if mapped in MANAGER_PERMISSIONS and mapped not in out:
            out.append(mapped)
    return out


def get_user_permission_set(email: str):
    """None = 전체 권한(스트리머·개발자·full 매니저), set = 부여된 권한."""
    normalized = normalize_manager_email(email)
    role = user_role(normalized)
    if role in ("streamer", "developer"):
        return None
    if role != "manager":
        return set()
    record = get_manager_record(normalized)
    if not record:
        return set()
    perms = normalize_manager_permissions(record.get("permissions"))
    return set(perms)


def normalize_staff_disabled_permissions(raw) -> list:
    if not isinstance(raw, (list, tuple, set)):
        return []
    out = []
    for item in raw:
        key = str(item or "").strip()
        mapped = LEGACY_PERMISSION_ALIASES.get(key, key)
        if mapped in STAFF_SELF_DISABLE_PERMISSIONS and mapped not in out:
            out.append(mapped)
    return sorted(out)


def normalize_developer_disabled_permissions(raw) -> list:
    return normalize_staff_disabled_permissions(raw)


def load_staff_disabled_permissions_map() -> dict:
    data = load_managers_data()
    raw = data.get("staffDisabledPermissions")
    if not isinstance(raw, dict):
        return {}
    out = {}
    for email, perms in raw.items():
        key = normalize_manager_email(email)
        if not key:
            continue
        disabled = normalize_staff_disabled_permissions(perms)
        if disabled:
            out[key] = disabled
    return out


def get_staff_disabled_permissions(email: str | None = None) -> set:
    normalized = normalize_manager_email(email or current_user_email())
    if user_role(normalized) not in ("streamer", "developer"):
        return set()
    if is_dev_streamer():
        return set()
    return set(load_staff_disabled_permissions_map().get(normalized, []))


def save_staff_disabled_permissions(email: str, disabled) -> None:
    normalized = normalize_manager_email(email)
    if not normalized:
        return
    data = load_managers_data()
    staff = data.get("staffDisabledPermissions")
    if not isinstance(staff, dict):
        staff = {}
    disabled = normalize_staff_disabled_permissions(disabled)
    if disabled:
        staff[normalized] = disabled
    elif normalized in staff:
        del staff[normalized]
    data["staffDisabledPermissions"] = staff
    save_managers_data(data)


def migrate_session_staff_disabled_permissions(email: str) -> None:
    """예전 세션 기반 권한 시뮬레이션을 managers.json으로 이전."""
    legacy = session.get("developerDisabledPermissions")
    if not legacy:
        return
    if not get_staff_disabled_permissions(email):
        save_staff_disabled_permissions(email, legacy)
    session.pop("developerDisabledPermissions", None)
    session.modified = True


def get_developer_disabled_permissions(email: str | None = None) -> set:
    return get_staff_disabled_permissions(email)


def get_effective_user_permission_set(email: str):
    """프로필에서 끈 권한을 반영한 실제 권한 집합."""
    perms = get_user_permission_set(email)
    if perms is not None:
        return perms
    role = user_role(email)
    if role in ("streamer", "developer"):
        disabled = get_staff_disabled_permissions(email)
        if disabled:
            return set(MANAGER_PERMISSIONS) - disabled
    return None


def staff_permission_overlay_payload(email: str):
    role = user_role(email)
    if role not in ("streamer", "developer"):
        return None
    disabled = sorted(get_staff_disabled_permissions(email))
    available = [item for item in PERMISSION_CATALOG if item["id"] in STAFF_SELF_DISABLE_PERMISSIONS]
    return {
        "available": available,
        "disabled": disabled,
        "active": bool(disabled),
    }


def developer_permission_simulation_payload(email: str):
    return staff_permission_overlay_payload(email)


def user_has_permission(email: str, permission: str) -> bool:
    perms = get_effective_user_permission_set(email)
    if perms is None:
        return True
    return permission in perms


def user_has_any_permission(email: str, *permissions: str) -> bool:
    perms = get_effective_user_permission_set(email)
    if perms is None:
        return True
    return any(p in perms for p in permissions)


def user_can_edit_email(email: str) -> bool:
    perms = get_effective_user_permission_set(email)
    if perms is None:
        return user_role(email) in ("streamer", "developer", "manager")
    return len(perms) > 0


def user_can_manage_managers(email: str) -> bool:
    role = user_role(email)
    if role in ("streamer", "developer"):
        return True
    return user_has_permission(email, "managers")


def current_user_email() -> str:
    user = current_user()
    return normalize_manager_email(user.get("email", "")) if user else ""


def current_user_permissions_list():
    perms = get_effective_user_permission_set(current_user_email())
    if perms is None:
        return sorted(MANAGER_PERMISSIONS)
    return sorted(perms)


def user_role(email: str) -> str:
    normalized = normalize_manager_email(email)
    if normalized in load_developer_emails():
        return "developer"
    if normalized in load_streamer_emails():
        return "streamer"
    if get_manager_record(normalized):
        return "manager"
    return "viewer"


def user_can_edit(role: str) -> bool:
    return role in ("streamer", "developer", "manager")


def is_dev_streamer():
    if is_beta_mode():
        return False
    return not google_enabled() and session.get("dev_streamer") is True


def auth_payload():
    mode = auth_mode()
    base = {
        "authMode": mode,
        "isBeta": is_beta_mode(),
        "googleEnabled": google_enabled(),
    }
    user = current_user()
    if user:
        email = user.get("email", "")
        role = user_role(email)
        can_edit = user_can_edit_email(email)
        payload = {
            **base,
            "loggedIn": True,
            "email": user.get("email"),
            "name": user.get("name"),
            "picture": user.get("picture"),
            "role": role,
            "canEdit": can_edit,
            "permissions": current_user_permissions_list() if can_edit else [],
            "canManageManagers": user_can_manage_managers(email),
            "devMode": False,
        }
        if role in ("streamer", "developer"):
            payload["permissionSimulation"] = staff_permission_overlay_payload(email)
        return payload
    if is_dev_streamer():
        return {
            **base,
            "loggedIn": True,
            "email": None,
            "name": "스트리머",
            "picture": None,
            "role": "streamer",
            "canEdit": True,
            "permissions": sorted(MANAGER_PERMISSIONS),
            "canManageManagers": True,
            "devMode": True,
        }
    return {
        **base,
        "loggedIn": False,
        "role": "guest",
        "canEdit": False,
        "permissions": [],
        "canManageManagers": False,
        "devMode": mode == "toggle",
    }


def require_permission(*permissions):
    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            if is_dev_streamer():
                return f(*args, **kwargs)
            user = current_user()
            if not user:
                return jsonify({"error": "login_required"}), 401
            email = user.get("email", "")
            if not user_has_any_permission(email, *permissions):
                return jsonify({"error": "forbidden", "hint": "이 작업에 대한 권한이 없습니다."}), 403
            return f(*args, **kwargs)

        return decorated

    return decorator


def require_manage_managers(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if is_dev_streamer():
            return f(*args, **kwargs)
        user = current_user()
        if not user:
            return jsonify({"error": "login_required"}), 401
        if not user_can_manage_managers(user.get("email", "")):
            return jsonify({"error": "forbidden", "hint": "매니저 관리 권한이 없습니다."}), 403
        return f(*args, **kwargs)

    return decorated


def require_streamer(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if is_dev_streamer():
            return f(*args, **kwargs)
        user = current_user()
        if not user:
            return jsonify({"error": "login_required"}), 401
        if not user_can_edit_email(user.get("email", "")):
            return jsonify({"error": "forbidden", "hint": "편집 권한이 없습니다."}), 403
        return f(*args, **kwargs)

    return decorated


def require_logged_in(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if is_dev_streamer():
            return f(*args, **kwargs)
        if not current_user():
            return jsonify({"error": "login_required", "hint": "로그인이 필요합니다."}), 401
        return f(*args, **kwargs)

    return decorated


def request_can_edit():
    if is_dev_streamer():
        return True
    user = current_user()
    if not user:
        return False
    return user_can_edit_email(user.get("email", ""))


def is_developer_user():
    if is_dev_streamer():
        return False
    user = current_user()
    if not user:
        return False
    return user_role(user.get("email", "")) == "developer"


def require_developer(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not is_developer_user():
            user = current_user()
            if not user:
                return jsonify({"error": "login_required"}), 401
            return jsonify({"error": "forbidden", "hint": "개발자 권한이 필요합니다."}), 403
        return f(*args, **kwargs)

    return decorated


def _today_iso():
    return datetime.now(ZoneInfo("Asia/Seoul")).date().isoformat()


def _announcement_is_active(ann):
    if not isinstance(ann, dict):
        return False
    expires_at = _normalize_iso_date(ann.get("expiresAt"))
    if expires_at and expires_at < _today_iso():
        return False
    return True


def _public_musicbook_song(song, *, languages=None, capsules=None, likes=None):
    """공개 API용 곡 객체 — 키 고정 + id 옆에 표시용 label."""
    if not isinstance(song, dict):
        return None
    song_id = str(song.get("id") or "").strip()
    title = str(song.get("title") or "").strip()
    if not song_id or not title:
        return None
    status = str(song.get("status") or "available").strip().lower() or "available"
    if status not in SONG_STATUSES:
        status = "available"
    pitch = None
    raw_pitch = song.get("pitchShift")
    if raw_pitch is not None and raw_pitch != "":
        try:
            pitch = int(raw_pitch)
        except (TypeError, ValueError):
            pitch = None
    languages = languages if isinstance(languages, dict) else {}
    capsules = capsules if isinstance(capsules, dict) else {}
    language = str(song.get("language") or "").strip().upper()
    capsule = str(song.get("capsule") or "").strip()
    lang_meta = languages.get(language) if language else None
    cap_meta = capsules.get(capsule) if capsule else None
    language_label = ""
    if isinstance(lang_meta, dict):
        language_label = str(lang_meta.get("label") or language).strip()
    elif language:
        language_label = language
    capsule_label = ""
    if isinstance(cap_meta, dict):
        capsule_label = str(cap_meta.get("label") or capsule).strip()
    elif capsule:
        capsule_label = capsule
    created_at = str(song.get("createdAt") or "").strip()
    updated_at = str(song.get("updatedAt") or created_at).strip()
    out = {
        "id": song_id,
        "status": status,
        "title": title,
        "artist": str(song.get("artist") or "").strip(),
        "note": str(song.get("note") or "").strip(),
        "language": language,
        "languageLabel": language_label,
        "capsule": capsule,
        "capsuleLabel": capsule_label,
        "pitchShift": pitch,
        "youtubeUrl": str(song.get("youtubeUrl") or "").strip(),
    }
    if created_at:
        out["createdAt"] = created_at
    if updated_at:
        out["updatedAt"] = updated_at
    if status == "available":
        like_emails = _normalize_musicbook_like_emails(likes)
        out["likeCount"] = len(like_emails)
    else:
        out["likeCount"] = 0
    return out


def _public_musicbook_sort_key(song):
    return (
        -(int(song.get("likeCount") or 0) if song.get("status") == "available" else 0),
        str(song.get("title") or "").casefold(),
        str(song.get("artist") or "").casefold(),
        str(song.get("id") or ""),
    )


def _public_musicbook_payload(data, *, likes_data=None):
    """API 소비자용 공개 페이로드 — 곡 리스트 + 사전 + UI 설정 분리."""
    src = data if isinstance(data, dict) else {}
    settings = src.get("settings") if isinstance(src.get("settings"), dict) else {}
    taxonomy = src.get("taxonomy") if isinstance(src.get("taxonomy"), dict) else {}
    languages = (
        taxonomy.get("languageCapsules")
        if isinstance(taxonomy.get("languageCapsules"), dict)
        else {}
    )
    capsules = taxonomy.get("capsules") if isinstance(taxonomy.get("capsules"), dict) else {}

    songs_in = src.get("songs") if isinstance(src.get("songs"), list) else []
    likes_by_song = (
        likes_data.get("songs")
        if isinstance(likes_data, dict) and isinstance(likes_data.get("songs"), dict)
        else {}
    )
    available = []
    banned = []
    for raw in songs_in:
        song_id = str(raw.get("id") or "").strip() if isinstance(raw, dict) else ""
        song = _public_musicbook_song(
            raw,
            languages=languages,
            capsules=capsules,
            likes=likes_by_song.get(song_id),
        )
        if not song:
            continue
        if song["status"] == "banned":
            banned.append(song)
        else:
            song["status"] = "available"
            available.append(song)

    available.sort(key=_public_musicbook_sort_key)
    banned.sort(
        key=lambda song: (
            str(song.get("title") or "").casefold(),
            str(song.get("artist") or "").casefold(),
            str(song.get("id") or ""),
        )
    )
    likes_total = sum(int(song.get("likeCount") or 0) for song in available)

    return {
        "version": int(src.get("version") or 1),
        "apiScope": "public",
        "counts": {
            "available": len(available),
            "banned": len(banned),
            "total": len(available) + len(banned),
            "likes": likes_total,
        },
        "availableSongs": available,
        "bannedSongs": banned,
        "languages": languages,
        "capsules": capsules,
        "ui": {
            "defaultTab": settings.get("defaultTab") or "available",
            "sortAvailable": settings.get("sortAvailable") or "likes-desc",
            "sortBanned": settings.get("sortBanned") or "title-asc",
            "fonts": settings.get("fonts") if isinstance(settings.get("fonts"), dict) else {},
        },
    }


def _public_links_payload(
    data,
    *,
    profile_resolved,
    youtube_latest,
    live_status,
    schedule_meta,
    upcoming_highlights,
    manual_video_meta,
):
    links = [
        link
        for link in (data.get("links") or [])
        if isinstance(link, dict) and link.get("enabled", True) is not False
    ]
    announcements = [
        ann for ann in (data.get("announcements") or []) if _announcement_is_active(ann)
    ]
    manual_videos = [
        item
        for item in (data.get("manualVideos") or [])
        if isinstance(item, dict) and item.get("enabled", True) is not False
    ]
    return {
        "version": data.get("version"),
        "profile": data.get("profile") or {},
        "youtube": data.get("youtube") or {},
        "schedule": data.get("schedule") or {},
        "live": data.get("live") or {},
        "columns": data.get("columns") or {},
        "columnSplit": data.get("columnSplit"),
        "fonts": data.get("fonts") or {},
        "announcementCategories": data.get("announcementCategories") or {},
        "announcements": announcements,
        "manualVideos": manual_videos,
        "links": links,
        "profileResolved": profile_resolved,
        "youtubeLatest": youtube_latest,
        "manualVideoMeta": manual_video_meta,
        "liveStatus": live_status,
        "scheduleMeta": schedule_meta,
        "upcomingHighlights": upcoming_highlights,
        "apiScope": "public",
    }


def normalize_broadcast_url(raw):
    s = str(raw or "").strip()
    if not s:
        return None
    if not re.match(r"^https?://", s, re.I):
        if re.match(r"^(www\.|[a-z0-9.-]+\.[a-z]{2,})", s, re.I):
            s = "https://" + s.lstrip("/")
        else:
            return None
    if not re.match(r"^https?://", s, re.I):
        return None
    return s[:500]


SLOT_LINK_LABEL_MAX = 80
SLOT_LINK_TYPES = frozenset({"general", "broadcast"})


def normalize_slot_link_type(item, link_url):
    raw = str(item.get("linkType") or "").strip()
    if raw in SLOT_LINK_TYPES:
        return raw
    if item.get("broadcastUrl") and not item.get("linkUrl"):
        return "broadcast"
    return "general" if link_url else None


def normalize_slot_link_fields(item):
    url = normalize_broadcast_url(item.get("linkUrl") or item.get("broadcastUrl"))
    label = str(item.get("linkLabel") or "").strip()[:SLOT_LINK_LABEL_MAX]
    link_type = normalize_slot_link_type(item, url)
    return url, label, link_type


def apply_slot_link_fields(out, item):
    link_url, link_label, link_type = normalize_slot_link_fields(item)
    if link_url:
        out["linkUrl"] = link_url
    if link_type:
        out["linkType"] = link_type
    if link_label:
        out["linkLabel"] = link_label


def normalize_slot(item, fallback="default"):
    if isinstance(item, str):
        text = item.strip()
        if text:
            return {"text": text, "category": fallback}
        return None
    if isinstance(item, dict):
        text = str(item.get("text", "")).strip()
        if text:
            if item.get("allDay") is True:
                out = {
                    "text": text,
                    "category": item.get("category") or fallback,
                    "allDay": True,
                }
                members = str(item.get("members", "")).strip()
                if members:
                    out["members"] = members
                apply_slot_link_fields(out, item)
                return out
            hours = item.get("hours", 1)
            try:
                hours = max(1, int(hours))
            except (TypeError, ValueError):
                hours = 1
            out = {"text": text, "category": item.get("category") or fallback, "hours": hours}
            start_time = normalize_bangon_time(item.get("startTime"))
            if start_time and start_time not in BANGON_PRESET_KEYS:
                out["startTime"] = start_time
            members = str(item.get("members", "")).strip()
            if members:
                out["members"] = members
            apply_slot_link_fields(out, item)
            return out
    return None


BANGON_PRESET_KEYS = frozenset({"late", "evening", "late_or_off"})


def normalize_bangon_time(raw):
    if raw is None or raw == "":
        return None
    s = str(raw).strip()
    approx = s.endswith("~") and len(s) > 1
    if approx:
        s = s[:-1]
    if s in BANGON_PRESET_KEYS:
        return s
    m = re.match(r"^(\d{1,2}):(\d{2})$", s)
    if not m:
        return None
    h = max(0, min(23, int(m.group(1))))
    minute = max(0, min(59, int(m.group(2))))
    result = f"{h:02d}:{minute:02d}"
    return f"{result}~" if approx else result


def _normalize_slot_list(raw, fallback):
    slots = []
    for item in raw or []:
        slot = normalize_slot(item, fallback)
        if slot:
            slots.append(slot)
    return slots


def _is_off_day_slots(slots, fallback):
    return any(
        slot.get("allDay") is True and (slot.get("category") or fallback) == "off"
        for slot in slots
    )


def normalize_day(day_data):
    if not isinstance(day_data, dict):
        return None
    fallback = day_data.get("category") or "default"
    slots = _normalize_slot_list(day_data.get("slots"), fallback)
    is_off = _is_off_day_slots(slots, fallback) if slots else False

    bangon = None
    if not is_off:
        bangon = normalize_bangon_time(day_data.get("bangonTime"))

    part2_raw = day_data.get("part2")
    part2_for_result = part2_raw

    # 1부가 완전히 비었을 때만 2부 승격 (뱅온만 있는 1부는 승격하지 않음)
    if not slots and not bangon and isinstance(part2_raw, dict):
        promoted = _normalize_slot_list(part2_raw.get("slots"), fallback)
        if promoted:
            slots = promoted
            if not _is_off_day_slots(slots, fallback):
                bangon = normalize_bangon_time(part2_raw.get("bangonTime")) or bangon
            part2_for_result = None

    result = {}
    if slots:
        result["slots"] = slots
    if bangon:
        result["bangonTime"] = bangon

    if (slots or bangon) and isinstance(part2_for_result, dict):
        part2_slots = _normalize_slot_list(part2_for_result.get("slots"), fallback)
        part2_is_off = _is_off_day_slots(part2_slots, fallback) if part2_slots else False
        part2_bangon = None
        if not part2_is_off:
            part2_bangon = normalize_bangon_time(part2_for_result.get("bangonTime"))
        part2 = {}
        if part2_slots:
            part2["slots"] = part2_slots
        if part2_bangon:
            part2["bangonTime"] = part2_bangon
        if part2:
            result["part2"] = part2
    return result if result else None


def normalize_chip_color_mode(raw):
    mode = str(raw or "").strip()
    if mode in ("tinted", "vivid"):
        return "tinted"
    if mode == "original":
        return "original"
    return "default"


def normalize_schedule(data):
    data = json.loads(json.dumps(data))
    months = data.get("months") or {}
    for month_data in months.values():
        days = month_data.get("days") or {}
        normalized_days = {}
        for date_key, day_data in days.items():
            norm = normalize_day(day_data)
            if norm:
                normalized_days[date_key] = norm
        month_data["days"] = normalized_days
    return data


def ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    server_metrics_store.configure_server_metrics(DATA_DIR)
    LINK_ICON_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    PATCHNOTE_IMAGE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    legacy_icon_dir = UPLOADS_DIR / "link-icons"
    if legacy_icon_dir.is_dir():
        for src in legacy_icon_dir.iterdir():
            if not src.is_file():
                continue
            if not re.fullmatch(r"link-icon-[a-f0-9]+\.(png|jpg|jpeg|gif|webp)", src.name, re.I):
                continue
            dest = LINK_ICON_UPLOAD_DIR / src.name
            if not dest.exists():
                try:
                    shutil.copy2(src, dest)
                except OSError:
                    pass
    if not SCHEDULE_PATH.exists():
        if SEED_PATH.exists():
            shutil.copy(SEED_PATH, SCHEDULE_PATH)
        else:
            SCHEDULE_PATH.write_text(
                json.dumps(
                    {
                        "streamerName": "스트리머",
                        "platformNote": "",
                        "categories": {},
                        "months": {},
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )


def load_schedule():
    ensure_data_dir()
    with SCHEDULE_PATH.open(encoding="utf-8") as f:
        return normalize_schedule(json.load(f))


def save_schedule(data):
    ensure_data_dir()
    data = normalize_schedule(data)
    backup = SCHEDULE_PATH.with_suffix(".json.bak")
    if SCHEDULE_PATH.exists():
        shutil.copy(SCHEDULE_PATH, backup)
    tmp = SCHEDULE_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(SCHEDULE_PATH)
    try:
        write_calendar_ics(data)
    except Exception:
        app.logger.exception("calendar ics refresh failed")


AUDIT_LOG_PATH = DATA_DIR / "audit-log.jsonl"
AUDIT_LOG_MAX_BYTES = int(os.environ.get("AUDIT_LOG_MAX_BYTES", str(5 * 1024 * 1024)))  # 5MB
AUDIT_LOG_BACKUPS = int(os.environ.get("AUDIT_LOG_BACKUPS", "2"))


def _safe_json(value, *, max_len=2000):
    """Prevent huge payloads in audit logs."""
    try:
        raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)
    except Exception:
        raw = json.dumps(str(value), ensure_ascii=False, separators=(",", ":"))
    if len(raw) > max_len:
        return raw[:max_len] + "…"
    return raw


def _audit_rotate_if_needed():
    try:
        if not AUDIT_LOG_PATH.exists():
            return
        if AUDIT_LOG_PATH.stat().st_size < AUDIT_LOG_MAX_BYTES:
            return
    except OSError:
        return
    # Rotate: audit-log.jsonl -> audit-log.jsonl.1 -> .2 ...
    try:
        for i in range(max(1, AUDIT_LOG_BACKUPS), 0, -1):
            src = AUDIT_LOG_PATH.with_suffix(f".jsonl.{i}")
            dst = AUDIT_LOG_PATH.with_suffix(f".jsonl.{i + 1}")
            if src.exists():
                if i >= AUDIT_LOG_BACKUPS:
                    try:
                        dst.unlink()
                    except OSError:
                        pass
                src.replace(dst)
        AUDIT_LOG_PATH.replace(AUDIT_LOG_PATH.with_suffix(".jsonl.1"))
    except OSError:
        pass


def audit_log(resource: str, action: str, *, summary: str = "", meta=None):
    """Append an audit event for editor-only operations."""
    try:
        ensure_data_dir()
        _audit_rotate_if_needed()
        user = current_user() or {}
        actor = {
            "email": normalize_manager_email(user.get("email")) if user.get("email") else "",
            "name": str(user.get("name") or "").strip()[:80],
            "role": str(user_role(user.get("email", "")) if user.get("email") else ("streamer" if is_dev_streamer() else "guest")),
        }
        entry = {
            "ts": utc_now(),
            "resource": str(resource or ""),
            "action": str(action or ""),
            "summary": str(summary or "")[:500],
            "actor": actor,
            "ip": request.headers.get("X-Forwarded-For", request.remote_addr) if request else None,
            "path": request.path if request else None,
            "meta": meta if isinstance(meta, dict) else {},
        }
        with AUDIT_LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(_safe_json(entry, max_len=4000) + "\n")
    except Exception:
        # Audit must never break the main operation.
        pass


def _write_structured_audit(resource: str, action: str, detail: dict, *, month_id: str | None = None) -> None:
    operations = detail.get("operations") if isinstance(detail, dict) else None
    if not isinstance(detail, dict) or not operations:
        return
    try:
        detail_id = schedule_audit.persist_audit_detail(DATA_DIR, detail)
        stats = detail.get("stats") or {}
        operation_stats = detail.get("operationStats") or {}
        batch_size = len(operations)
        for index, op in enumerate(operations):
            summary = str(op.get("summary") or "").strip()
            if not summary:
                continue
            op_action = str(op.get("action") or action or "put")
            meta = {
                "detailId": detail_id,
                "stats": stats,
                "operationStats": operation_stats,
                "operation": {
                    "action": op_action,
                    "target": op.get("target"),
                },
            }
            if month_id:
                meta["monthId"] = month_id
            if batch_size > 1:
                meta["batchSize"] = batch_size
                meta["batchIndex"] = index + 1
            song_id = str(op.get("songId") or "").strip()
            if song_id:
                meta["songId"] = song_id
            source_request_id = str(op.get("sourceRequestId") or "").strip()
            if source_request_id:
                meta["sourceRequestId"] = source_request_id
            audit_log(resource, op_action, summary=summary, meta=meta)
    except Exception:
        pass


def _write_schedule_audit(action: str, detail: dict, *, month_id: str | None = None) -> None:
    _write_structured_audit("schedule", action, detail, month_id=month_id)


def _write_musicbook_audit(action: str, detail: dict) -> None:
    _write_structured_audit("musicbook", action, detail)


def _file_revision_token(path):
    try:
        if not path.exists():
            return None
        return str(path.stat().st_mtime_ns)
    except OSError:
        return None


def content_revisions():
    return {
        "schedule": _file_revision_token(SCHEDULE_PATH),
        "musicbook": f"{_file_revision_token(MUSICBOOK_PATH) or ''}:{_file_revision_token(MUSICBOOK_LIKES_PATH) or ''}",
        "links": _file_revision_token(LINKS_PATH),
        "patchnotes": _file_revision_token(PATCHNOTES_PATH),
        "songRequests": _file_revision_token(SONG_REQUESTS_PATH),
        "managers": _file_revision_token(MANAGERS_PATH),
    }


CONTENT_SSE_POLL_SEC = max(0.5, float(os.environ.get("CONTENT_SSE_POLL_SEC", "1")))
CONTENT_SSE_HEARTBEAT_SEC = max(10, int(os.environ.get("CONTENT_SSE_HEARTBEAT_SEC", "25")))


def _content_sse_payload():
    return json.dumps({"revisions": content_revisions()}, ensure_ascii=False)


DEFAULT_LANGUAGE_CAPSULES = {
    "K": {"label": "한국어", "bg": "#d8f0e4", "text": "#1b4332"},
    "J": {"label": "일본어", "bg": "#fde8e8", "text": "#6a040f"},
    "E": {"label": "영어", "bg": "#dbeafe", "text": "#1d3557"},
}

DEFAULT_MUSICBOOK_CAPSULES = {
    "highlight": {"label": "하이라이트", "bg": "#fef3c7", "text": "#7c4a03"},
    "verse": {"label": "1절", "bg": "#dbeafe", "text": "#1d3557"},
    "full": {"label": "완곡", "bg": "#d8f0e4", "text": "#1b4332"},
}

DEFAULT_LANGUAGE_CAPSULE_ORDER = ["K", "J", "E"]

CAPSULE_ID_RE = re.compile(r"^[\w가-힣-]+$")
LINK_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{4,64}$")
ANNOUNCEMENT_STYLES = frozenset({"notice", "guide", "schedule", "post", "alert"})
ANNOUNCEMENT_STYLE_ALIASES = {
    "info": "notice",
    "warn": "alert",
    "default": "post",
}

DEFAULT_ANNOUNCEMENT_CATEGORIES = {
    "notice": {"label": "공지", "bg": "#eef1fb", "text": "#4a60a9"},
    "guide": {"label": "안내", "bg": "#e8f6ef", "text": "#2d8f6f"},
    "schedule": {"label": "일정", "bg": "#f0eaf9", "text": "#7c5cbf"},
    "post": {"label": "게시물", "bg": "#f1f5f9", "text": "#94a3b8"},
    "alert": {"label": "주의", "bg": "#fff4df", "text": "#e9a23b"},
    "default": {"label": "일반", "bg": "#e8ecf2", "text": "#3d4657"},
}
LINK_ICON_PRESETS = frozenset(
    {
        "schedule",
        "musicbook",
        "songRequests",
        "youtube",
        "youtubePlaylist",
        "youtubeMusic",
        "soop",
        "fancim",
        "naverCafe",
        "link",
        "custom",
    }
)
LINK_ICON_PRESET_BY_LOWER = {name.lower(): name for name in LINK_ICON_PRESETS}
LINK_ICON_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
LINK_ICON_SVG_MAX_LEN = 12000
LINK_ICON_SVG_ALLOWED_TAGS = frozenset(
    {
        "svg",
        "path",
        "circle",
        "rect",
        "line",
        "polyline",
        "polygon",
        "g",
        "ellipse",
        "defs",
        "clippath",
        "mask",
        "lineargradient",
        "radialgradient",
        "stop",
    }
)
LINK_ICON_SVG_ALLOWED_ATTRS = frozenset(
    {
        "viewbox",
        "xmlns",
        "width",
        "height",
        "fill",
        "stroke",
        "stroke-width",
        "stroke-linecap",
        "stroke-linejoin",
        "stroke-miterlimit",
        "d",
        "cx",
        "cy",
        "r",
        "rx",
        "ry",
        "x",
        "y",
        "x1",
        "y1",
        "x2",
        "y2",
        "points",
        "transform",
        "opacity",
        "fill-opacity",
        "stroke-opacity",
        "fill-rule",
        "clip-rule",
        "clip-path",
        "mask",
        "id",
        "offset",
        "stop-color",
        "stop-opacity",
        "gradientunits",
        "gradienttransform",
        "aria-hidden",
        "focusable",
        "role",
    }
)
LINK_ICON_SVG_FORBIDDEN_SNIPPETS = (
    "<script",
    "javascript:",
    "<foreignobject",
    "<iframe",
    "<object",
    "<embed",
    "<style",
    "onload=",
    "onclick=",
    "onerror=",
    "onmouseover=",
)
SIDE_BLOCK_STRUCTURAL = ("youtube", "schedule")
LINKS_BLOCK_LINKS = "links"
LINKS_PAGE_BLOCKS = frozenset({LINKS_BLOCK_LINKS, *SIDE_BLOCK_STRUCTURAL})
ANN_BLOCK_PREFIX = "ann:"
MANUAL_VIDEO_BLOCK_PREFIX = "yt:"
DEFAULT_SIDE_BLOCKS = list(SIDE_BLOCK_STRUCTURAL)
DEFAULT_COLUMN_SPLIT = 58
MIN_COLUMN_SPLIT = 30
MAX_COLUMN_SPLIT = 70
YOUTUBE_CHANNEL_ID_RE = re.compile(r"^UC[\w-]{10,}$")
LINKS_STREAMER_DISPLAY_NAME = "시리안 레인"
SOCIAL_SITE_NAME = LINKS_STREAMER_DISPLAY_NAME
SOCIAL_IMAGE_PATH = "og-image.png"


def _social_image_version():
    try:
        path = BASE_DIR / SOCIAL_IMAGE_PATH
        if path.is_file():
            return int(path.stat().st_mtime)
    except OSError:
        pass
    return 1


def _social_image_url():
    version = _social_image_version()
    return absolute_request_url(f"{SOCIAL_IMAGE_PATH}?v={version}")
LINKS_SOOP_STATION_ID = "sirianrain"
DEFAULT_LINKS_YOUTUBE = {
    "enabled": True,
    "channelUrl": "https://www.youtube.com/@spacepolice_security",
    "channelId": "UCmWfxQQQCTUhJ3BHBwdy1zg",
    "label": "최신 업로드",
    "includeShorts": False,
    "thumbSize": "large",
}
DEFAULT_LINKS_SCHEDULE = {
    "enabled": True,
    "label": "주요 일정",
}
DEFAULT_LINKS_LIVE = {
    "enabled": True,
    "platform": "soop",
    "stationId": LINKS_SOOP_STATION_ID,
}
SOOP_FETCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.5",
    "Accept": "application/json,text/plain,*/*",
}
_youtube_latest_cache = {}
_profile_image_cache = {}
_live_status_cache = {}
_manual_video_meta_cache = {}
_soop_refresh_lock = threading.Lock()
_soop_refresh_inflight = set()
YOUTUBE_LATEST_CACHE_TTL_OK = 90  # 90초 — 홈 최신 영상 폴링과 맞춤
YOUTUBE_LATEST_CACHE_TTL_FAIL = 120
YOUTUBE_LATEST_CACHE_TTL_NO_KEY = 300
MANUAL_VIDEO_META_CACHE_TTL = 3600
SOOP_PROFILE_CACHE_TTL = 3600


def _new_song_id():
    return uuid.uuid4().hex[:12]


def _normalize_song_tags(raw):
    if not isinstance(raw, list):
        return []
    tags = []
    for item in raw:
        tag = str(item).strip()
        if tag and tag not in tags:
            tags.append(tag)
    return tags


def _normalize_song_meta(raw):
    if not isinstance(raw, dict):
        return {}
    out = {}
    for key, val in raw.items():
        k = str(key).strip()
        if not k:
            continue
        if isinstance(val, (str, int, float, bool)) or val is None:
            out[k] = val
        elif isinstance(val, list):
            out[k] = [str(v).strip() for v in val if str(v).strip()]
    return out


DEFAULT_CAPSULE_ORDER = ["highlight", "verse", "full"]


def _normalize_capsule_entry(cap_id, cap):
    if not isinstance(cap, dict):
        return None
    cid = str(cap_id).strip()
    if not cid or not CAPSULE_ID_RE.match(cid):
        return None
    label = str(cap.get("label") or cid).strip() or cid
    bg = str(cap.get("bg") or "#e8ecf2").strip()
    text = str(cap.get("text") or "#333333").strip()
    return cid, {"label": label, "bg": bg, "text": text}


def _normalize_capsule_map(raw, defaults, preferred_order):
    if not isinstance(raw, dict) or not raw:
        return {k: dict(v) for k, v in defaults.items()}
    out = {}
    seen = set()
    for cid in preferred_order:
        if cid in raw:
            entry = _normalize_capsule_entry(cid, raw[cid])
            if entry:
                out[entry[0]] = entry[1]
                seen.add(entry[0])
    for cap_id, cap in raw.items():
        if cap_id in seen:
            continue
        entry = _normalize_capsule_entry(cap_id, cap)
        if entry:
            out[entry[0]] = entry[1]
            seen.add(entry[0])
    return out if out else {k: dict(v) for k, v in defaults.items()}


def _normalize_capsules(raw):
    return _normalize_capsule_map(raw, DEFAULT_MUSICBOOK_CAPSULES, DEFAULT_CAPSULE_ORDER)


def _normalize_language_capsules(raw):
    return _normalize_capsule_map(raw, DEFAULT_LANGUAGE_CAPSULES, DEFAULT_LANGUAGE_CAPSULE_ORDER)


def _normalize_youtube_url(raw):
    if raw is None:
        return ""
    vid = yt_api.parse_video_id(raw)
    if not vid:
        return ""
    return f"https://youtu.be/{vid}"


def _normalize_pitch_shift(raw):
    if raw is None or raw == "":
        return None
    if isinstance(raw, str):
        s = raw.strip().replace("키", "").replace(" ", "")
        if not s:
            return None
        raw = s
    try:
        val = int(float(raw))
    except (TypeError, ValueError):
        return None
    if val == 0:
        return None
    return max(-12, min(12, val))


def normalize_song(item, fallback_status="available"):
    if not isinstance(item, dict):
        return None
    status = str(item.get("status") or fallback_status).strip().lower()
    if status not in SONG_STATUSES:
        status = fallback_status
    title = str(item.get("title", "")).strip()
    if not title:
        return None
    song_id = str(item.get("id", "")).strip()
    if not SONG_ID_RE.match(song_id):
        song_id = _new_song_id()
    language = str(item.get("language", "")).strip().upper()
    if language and language not in SONG_LANGUAGES:
        language = ""
    if status == "available" and language not in SONG_LANGUAGES:
        language = "K"
    artist = str(item.get("artist", "")).strip()
    note = str(item.get("note", "")).strip()
    capsule = str(item.get("capsule") or "").strip()
    if capsule and not CAPSULE_ID_RE.match(capsule):
        capsule = ""
    meta_in = item.get("meta") if isinstance(item.get("meta"), dict) else {}
    youtube_url = _normalize_youtube_url(
        item.get("youtubeUrl") or item.get("youtube") or meta_in.get("youtubeUrl")
    )
    pitch = _normalize_pitch_shift(item.get("pitchShift"))
    if pitch is None:
        pitch = _normalize_pitch_shift(meta_in.get("pitchShift") or meta_in.get("songKey"))
    try:
        sort_order = int(item.get("sortOrder", 0))
    except (TypeError, ValueError):
        sort_order = 0
    created_at = str(item.get("createdAt") or utc_now())
    updated_at = str(item.get("updatedAt") or created_at)
    out = {
        "id": song_id,
        "status": status,
        "title": title,
        "artist": artist,
        "note": note,
        "sortOrder": sort_order,
        "tags": [],
        "meta": _normalize_song_meta(item.get("meta")),
        "createdAt": created_at,
        "updatedAt": updated_at,
    }
    if language:
        out["language"] = language
    if pitch is not None:
        out["pitchShift"] = pitch
    if capsule:
        out["capsule"] = capsule
    if youtube_url:
        out["youtubeUrl"] = youtube_url
    return out


def normalize_musicbook(data):
    data = json.loads(json.dumps(data))
    if not isinstance(data, dict):
        data = {}
    settings = data.get("settings") if isinstance(data.get("settings"), dict) else {}
    default_tab = str(settings.get("defaultTab") or "available").strip().lower()
    if default_tab not in SONG_STATUSES:
        default_tab = "available"
    sort_available = str(settings.get("sortAvailable") or "likes-desc").strip()
    sort_banned = str(settings.get("sortBanned") or "title-asc").strip()
    if sort_available not in MUSICBOOK_SORT_KEYS:
        sort_available = "likes-desc"
    if sort_available == "order-asc":
        sort_available = "likes-desc"
    if sort_banned not in MUSICBOOK_SORT_KEYS:
        sort_banned = "title-asc"
    fonts = _normalize_musicbook_fonts(settings.get("fonts"))
    taxonomy = data.get("taxonomy") if isinstance(data.get("taxonomy"), dict) else {}
    lang_caps_in = taxonomy.get("languageCapsules")
    if not isinstance(lang_caps_in, dict) or not lang_caps_in:
        legacy_langs = taxonomy.get("languages")
        if isinstance(legacy_langs, list) and legacy_langs:
            migrated = {}
            for lang in legacy_langs:
                if not isinstance(lang, dict):
                    continue
                lang_id = str(lang.get("id", "")).strip().upper()
                if lang_id not in SONG_LANGUAGES:
                    continue
                base = DEFAULT_LANGUAGE_CAPSULES.get(lang_id, {})
                migrated[lang_id] = {
                    "label": str(lang.get("label") or base.get("label") or lang_id).strip() or lang_id,
                    "bg": base.get("bg", "#e8ecf2"),
                    "text": base.get("text", "#333333"),
                }
            lang_caps_in = migrated or None
    norm_language_capsules = _normalize_language_capsules(lang_caps_in)
    # tags 체계는 폐기 — 숙련도/분량은 capsule(verse/full/highlight) 사용
    norm_capsules = _normalize_capsules(taxonomy.get("capsules"))
    valid_capsule_ids = set(norm_capsules.keys())
    valid_language_ids = set(norm_language_capsules.keys())
    songs_in = data.get("songs") if isinstance(data.get("songs"), list) else []
    songs = []
    seen_ids = set()
    for item in songs_in:
        song = normalize_song(item)
        if not song or song["id"] in seen_ids:
            continue
        lang = song.get("language")
        if lang and lang not in valid_language_ids:
            del song["language"]
        # legacy field cleanup
        if "proficiency" in song:
            del song["proficiency"]
        cap = song.get("capsule")
        if cap and cap not in valid_capsule_ids:
            del song["capsule"]
        seen_ids.add(song["id"])
        songs.append(song)
    return {
        "version": 1,
        "settings": {
            "defaultTab": default_tab,
            "sortAvailable": sort_available,
            "sortBanned": sort_banned,
            "fonts": fonts,
        },
        "taxonomy": {
            "languageCapsules": norm_language_capsules,
            "tags": [],
            "capsules": norm_capsules,
        },
        "songs": songs,
    }


def ensure_musicbook():
    ensure_data_dir()
    if not MUSICBOOK_PATH.exists():
        if SEED_MUSICBOOK_PATH.exists():
            shutil.copy(SEED_MUSICBOOK_PATH, MUSICBOOK_PATH)
        else:
            MUSICBOOK_PATH.write_text(
                json.dumps(normalize_musicbook({"songs": []}), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )


def load_musicbook():
    ensure_musicbook()
    with MUSICBOOK_PATH.open(encoding="utf-8") as f:
        return normalize_musicbook(json.load(f))


def save_musicbook(data):
    ensure_musicbook()
    data = normalize_musicbook(data)
    backup = MUSICBOOK_PATH.with_suffix(".json.bak")
    if MUSICBOOK_PATH.exists():
        shutil.copy(MUSICBOOK_PATH, backup)
    tmp = MUSICBOOK_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(MUSICBOOK_PATH)


def _normalize_musicbook_like_emails(raw):
    if isinstance(raw, dict):
        raw = raw.get("likes")
    if not isinstance(raw, list):
        return []
    emails = []
    for item in raw:
        email = normalize_manager_email(item.get("email") if isinstance(item, dict) else item)
        if email and email not in emails:
            emails.append(email)
    return emails


def normalize_musicbook_likes(data):
    src = data if isinstance(data, dict) else {}
    songs_in = src.get("songs") if isinstance(src.get("songs"), dict) else {}
    songs = {}
    for raw_id, raw_likes in songs_in.items():
        song_id = str(raw_id or "").strip()
        if not SONG_ID_RE.match(song_id):
            continue
        likes = _normalize_musicbook_like_emails(raw_likes)
        if likes:
            songs[song_id] = likes
    return {"version": 1, "songs": songs}


def ensure_musicbook_likes():
    ensure_data_dir()
    if not MUSICBOOK_LIKES_PATH.exists():
        MUSICBOOK_LIKES_PATH.write_text(
            json.dumps({"version": 1, "songs": {}}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


def load_musicbook_likes():
    ensure_musicbook_likes()
    try:
        with MUSICBOOK_LIKES_PATH.open(encoding="utf-8") as f:
            return normalize_musicbook_likes(json.load(f))
    except (OSError, ValueError):
        return {"version": 1, "songs": {}}


def save_musicbook_likes(data):
    ensure_musicbook_likes()
    normalized = normalize_musicbook_likes(data)
    tmp = MUSICBOOK_LIKES_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(normalized, f, ensure_ascii=False, indent=2)
    tmp.replace(MUSICBOOK_LIKES_PATH)


@contextmanager
def musicbook_likes_write_lock():
    ensure_data_dir()
    with MUSICBOOK_LIKES_LOCK_PATH.open("a+", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _musicbook_viewer_email():
    user = current_user()
    if is_dev_streamer() and not user:
        return normalize_manager_email("dev@local")
    if not user:
        return ""
    return normalize_manager_email(user.get("email", ""))


def _musicbook_songs_with_likes(data, likes_data):
    songs = []
    likes_by_song = likes_data.get("songs") if isinstance(likes_data, dict) else {}
    if not isinstance(likes_by_song, dict):
        likes_by_song = {}
    for raw in data.get("songs") or []:
        if not isinstance(raw, dict):
            continue
        song = dict(raw)
        if song.get("status") == "available":
            like_emails = _normalize_musicbook_like_emails(likes_by_song.get(song.get("id")))
            song["likeCount"] = len(like_emails)
        else:
            song["likeCount"] = 0
        songs.append(song)
    return songs


def _musicbook_liked_song_ids(likes_data, viewer_email=""):
    email = normalize_manager_email(viewer_email)
    if not email:
        return []
    likes_by_song = likes_data.get("songs") if isinstance(likes_data, dict) else {}
    if not isinstance(likes_by_song, dict):
        return []
    liked = []
    for song_id, likes in likes_by_song.items():
        sid = str(song_id or "").strip()
        if not sid:
            continue
        if email in _normalize_musicbook_like_emails(likes):
            liked.append(sid)
    liked.sort()
    return liked


def musicbook_like_counts() -> dict[str, int]:
    likes_data = load_musicbook_likes()
    songs = likes_data.get("songs") if isinstance(likes_data, dict) else {}
    if not isinstance(songs, dict):
        return {}
    out = {}
    for song_id, likes in songs.items():
        count = len(_normalize_musicbook_like_emails(likes))
        if count:
            out[str(song_id)] = count
    return out


def prune_musicbook_likes(musicbook_data) -> dict[str, int]:
    """Remove likes for missing/banned songs. Returns pruned songId → likeCount."""
    available_ids = {
        str(song.get("id") or "")
        for song in (musicbook_data.get("songs") or [])
        if isinstance(song, dict) and song.get("status") == "available"
    }
    pruned_counts: dict[str, int] = {}
    with musicbook_likes_write_lock():
        likes_data = load_musicbook_likes()
        songs = likes_data.get("songs") or {}
        kept = {}
        for song_id, likes in songs.items():
            emails = _normalize_musicbook_like_emails(likes)
            if song_id in available_ids:
                if emails:
                    kept[song_id] = emails
            elif emails:
                pruned_counts[str(song_id)] = len(emails)
        if kept != songs:
            save_musicbook_likes({**likes_data, "songs": kept})
    return pruned_counts


SONG_REQUEST_STATUSES = frozenset({"pending"})
SONG_REQUEST_NOTIFICATION_OUTCOMES = frozenset({"dismissed", "available", "banned"})
SONG_REQUEST_NOTIFICATION_MAX = 500
SONG_REQUEST_REVIEW_REASON_MAX = 500
SONG_REQUEST_LIKE_TIER_VIAS = frozenset({"up", "down"})
BLACKLIST_AUTO_DISMISS_REASON = "신청 금지 계정으로 등록되어 반려되었습니다."


def _normalize_song_request_review_reason(raw) -> str:
    reason = str(raw or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not reason:
        return ""
    return reason[:SONG_REQUEST_REVIEW_REASON_MAX]


def _new_song_request_id():
    return f"req-{_new_song_id()}"


def _normalize_song_request_like_tier(item, like_count: int):
    if like_count <= 0:
        return {}
    tier_at = str(item.get("likeTierAt") or "").strip()
    tier_via = str(item.get("likeTierVia") or "").strip().lower()
    if tier_via not in SONG_REQUEST_LIKE_TIER_VIAS:
        tier_via = "up"
    if not tier_at:
        tier_at = str(item.get("createdAt") or "").strip()
    out = {"likeTierVia": tier_via}
    if tier_at:
        out["likeTierAt"] = tier_at
    return out


def _song_request_like_tier_update(old_count: int, new_count: int, now=None):
    if old_count == new_count:
        return {}
    now = now or utc_now()
    via = "down" if new_count < old_count else "up"
    return {"likeTierAt": now, "likeTierVia": via}


def normalize_song_request(item):
    if not isinstance(item, dict):
        return None
    status = str(item.get("status") or "pending").strip().lower()
    if status not in SONG_REQUEST_STATUSES:
        status = "pending"
    title = str(item.get("title", "")).strip()
    artist = str(item.get("artist", "")).strip()
    if not title or not artist:
        return None
    language = str(item.get("language", "")).strip().upper()
    if language not in SONG_LANGUAGES:
        return None
    youtube_url = _normalize_youtube_url(item.get("youtubeUrl") or item.get("youtube"))
    if not youtube_url:
        return None
    note = str(item.get("note", "")).strip()
    req_id = str(item.get("id", "")).strip()
    if not SONG_ID_RE.match(req_id):
        req_id = _new_song_request_id()
    requested_by = item.get("requestedBy") if isinstance(item.get("requestedBy"), dict) else {}
    email = normalize_manager_email(requested_by.get("email"))
    name = str(requested_by.get("name") or "").strip()[:80]
    if not email:
        return None
    created_at = str(item.get("createdAt") or utc_now())
    out = {
        "id": req_id,
        "status": status,
        "title": title[:200],
        "artist": artist[:200],
        "language": language,
        "youtubeUrl": youtube_url,
        "note": note[:500],
        "requestedBy": {"email": email, "name": name or email},
        "createdAt": created_at,
    }
    updated_at = str(item.get("updatedAt") or "").strip()
    if updated_at:
        out["updatedAt"] = updated_at
    out["likes"] = _normalize_song_request_likes(item.get("likes"))
    out.update(_normalize_song_request_like_tier(item, len(out["likes"])))
    return out


def normalize_song_request_blacklist_entry(item):
    if not isinstance(item, dict):
        return None
    email = normalize_manager_email(item.get("email", ""))
    if not email or not EMAIL_RE.match(email):
        return None
    name = str(item.get("name") or "").strip()[:80] or email
    note = str(item.get("note") or "").strip()[:500]
    blocked_by = item.get("blockedBy") if isinstance(item.get("blockedBy"), dict) else {}
    blocker_email = normalize_manager_email(blocked_by.get("email", ""))
    blocker_name = str(blocked_by.get("name") or "").strip()[:80]
    blocked_at = str(item.get("blockedAt") or "").strip()
    out = {"email": email, "name": name}
    if note:
        out["note"] = note
    if blocker_email:
        out["blockedBy"] = {"email": blocker_email, "name": blocker_name or blocker_email}
    if blocked_at:
        out["blockedAt"] = blocked_at
    return out


def normalize_song_request_blacklist(raw):
    if not isinstance(raw, list):
        return []
    seen = set()
    out = []
    for item in raw:
        entry = normalize_song_request_blacklist_entry(item)
        if not entry or entry["email"] in seen:
            continue
        seen.add(entry["email"])
        out.append(entry)
    out.sort(key=lambda e: e.get("blockedAt") or "", reverse=True)
    return out


def normalize_song_request_notification(item):
    if not isinstance(item, dict):
        return None
    notif_id = str(item.get("id") or "").strip()
    if not SONG_ID_RE.match(notif_id):
        notif_id = f"srn-{_new_song_id()}"
    email = normalize_manager_email(item.get("email", ""))
    if not email or not EMAIL_RE.match(email):
        return None
    outcome = str(item.get("outcome") or "").strip().lower()
    if outcome not in SONG_REQUEST_NOTIFICATION_OUTCOMES:
        return None
    title = str(item.get("title") or "").strip()[:200]
    artist = str(item.get("artist") or "").strip()[:200]
    if not title or not artist:
        return None
    request_id = str(item.get("requestId") or "").strip()
    if request_id and not SONG_ID_RE.match(request_id):
        request_id = ""
    created_at = str(item.get("createdAt") or utc_now())
    out = {
        "id": notif_id,
        "email": email,
        "outcome": outcome,
        "title": title,
        "artist": artist,
        "createdAt": created_at,
    }
    if request_id:
        out["requestId"] = request_id
    song_id = str(item.get("songId") or "").strip()
    if song_id and SONG_ID_RE.match(song_id):
        out["songId"] = song_id
    read_at = str(item.get("readAt") or "").strip()
    if read_at:
        out["readAt"] = read_at
    reason = _normalize_song_request_review_reason(item.get("reason"))
    if reason:
        out["reason"] = reason
    return out


def normalize_song_request_notifications(raw):
    if not isinstance(raw, list):
        return []
    seen = set()
    out = []
    for item in raw:
        entry = normalize_song_request_notification(item)
        if not entry or entry["id"] in seen:
            continue
        seen.add(entry["id"])
        out.append(entry)
    out.sort(key=lambda n: n.get("createdAt") or "", reverse=True)
    return out[:SONG_REQUEST_NOTIFICATION_MAX]


def _append_song_request_notification(data, req, outcome, song_id=None, reason=None):
    email = normalize_manager_email(req.get("requestedBy", {}).get("email"))
    if not email:
        return data
    payload = {
        "id": f"srn-{_new_song_id()}",
        "requestId": req.get("id"),
        "email": email,
        "title": req.get("title"),
        "artist": req.get("artist"),
        "outcome": outcome,
        "createdAt": utc_now(),
    }
    if song_id:
        payload["songId"] = song_id
    normalized_reason = _normalize_song_request_review_reason(reason)
    if normalized_reason:
        payload["reason"] = normalized_reason
    entry = normalize_song_request_notification(payload)
    if not entry:
        return data
    notifications = normalize_song_request_notifications([entry, *(data.get("notifications") or [])])
    return {**data, "notifications": notifications}


def _dismiss_pending_song_requests_for_email(data, email: str, reason=None):
    target = normalize_manager_email(email)
    if not target:
        return data, 0
    dismiss_reason = _normalize_song_request_review_reason(reason) or BLACKLIST_AUTO_DISMISS_REASON
    requests = list(data.get("requests", []))
    kept = []
    dismissed = 0
    for req in requests:
        if req.get("status") != "pending":
            kept.append(req)
            continue
        owner = normalize_manager_email(req.get("requestedBy", {}).get("email"))
        if owner == target:
            data = _append_song_request_notification(data, req, "dismissed", reason=dismiss_reason)
            dismissed += 1
        else:
            kept.append(req)
    return {**data, "requests": kept}, dismissed


def _song_request_notifications_for_email(data, email: str, unread_only=True):
    viewer = normalize_manager_email(email)
    if not viewer:
        return []
    notifications = data.get("notifications") if isinstance(data.get("notifications"), list) else []
    out = []
    for item in notifications:
        if not isinstance(item, dict):
            continue
        if normalize_manager_email(item.get("email")) != viewer:
            continue
        if unread_only and item.get("readAt"):
            continue
        entry = normalize_song_request_notification(item)
        if entry:
            out.append(entry)
    out.sort(key=lambda n: n.get("createdAt") or "", reverse=True)
    return out


def normalize_song_requests(data):
    data = json.loads(json.dumps(data))
    if not isinstance(data, dict):
        data = {}
    requests_in = data.get("requests") if isinstance(data.get("requests"), list) else []
    requests = []
    seen_ids = set()
    for item in requests_in:
        if not isinstance(item, dict):
            continue
        req = normalize_song_request(item)
        if not req:
            req_id = str(item.get("id", "")).strip()
            if not req_id or req_id in seen_ids:
                continue
            req = item
        if req["id"] in seen_ids:
            continue
        seen_ids.add(req["id"])
        requests.append(req)
    requests.sort(key=lambda r: r.get("createdAt") or "", reverse=True)
    blacklist = normalize_song_request_blacklist(data.get("blacklist"))
    notifications = normalize_song_request_notifications(data.get("notifications"))
    return {"version": 1, "requests": requests, "blacklist": blacklist, "notifications": notifications}


def ensure_song_requests():
    ensure_data_dir()
    if not SONG_REQUESTS_PATH.exists():
        if SEED_SONG_REQUESTS_PATH.exists():
            shutil.copy(SEED_SONG_REQUESTS_PATH, SONG_REQUESTS_PATH)
        else:
            SONG_REQUESTS_PATH.write_text(
                json.dumps(normalize_song_requests({}), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )


def load_song_requests():
    ensure_song_requests()
    with SONG_REQUESTS_PATH.open(encoding="utf-8") as f:
        return normalize_song_requests(json.load(f))


def save_song_requests(data):
    ensure_song_requests()
    data = normalize_song_requests(data)
    backup = SONG_REQUESTS_PATH.with_suffix(".json.bak")
    if SONG_REQUESTS_PATH.exists():
        shutil.copy(SONG_REQUESTS_PATH, backup)
    tmp = SONG_REQUESTS_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(SONG_REQUESTS_PATH)


def _song_request_audit_label(req) -> str:
    if not isinstance(req, dict):
        return "—"
    title = str(req.get("title") or "").strip()
    artist = str(req.get("artist") or "").strip()
    if title and artist:
        return f"{title} — {artist}"
    return title or artist or "—"


def audit_song_request(action: str, *, summary: str = "", req=None, meta=None):
    """신청곡 운영 대시보드 수정 로그."""
    try:
        base_meta = {}
        if isinstance(req, dict):
            base_meta = {
                "requestId": str(req.get("id") or ""),
                "title": str(req.get("title") or "")[:120],
                "artist": str(req.get("artist") or "")[:80],
            }
        if isinstance(meta, dict):
            base_meta.update(meta)
        audit_log("songRequests", action, summary=summary, meta=base_meta)
    except Exception:
        pass


def audit_auth(action: str, *, summary: str = "", meta=None):
    """로그인·로그아웃 등 인증 이벤트 운영 로그."""
    try:
        audit_log("auth", action, summary=summary, meta=meta if isinstance(meta, dict) else {})
    except Exception:
        pass


def _song_request_submitter(user):
    if is_dev_streamer() and not user:
        return {"email": "dev@local", "name": "스트리머"}
    if not user:
        return None
    email = normalize_manager_email(user.get("email", ""))
    if not email:
        return None
    name = str(user.get("name") or "").strip()[:80]
    return {"email": email, "name": name or email}


def _user_can_manage_song_requests(email: str) -> bool:
    if is_dev_streamer():
        return True
    return user_has_permission(email, "songrequests")


def _user_can_approve_song_request_available(email: str) -> bool:
    if is_dev_streamer():
        return True
    return user_has_permission(email, "songrequests_available")


def _user_can_review_song_requests(email: str) -> bool:
    return _user_can_manage_song_requests(email) or _user_can_approve_song_request_available(email)


def _song_request_review_capabilities(email: str) -> dict:
    can_manage = _user_can_manage_song_requests(email)
    can_available = _user_can_approve_song_request_available(email)
    can_review = can_manage or can_available
    return {
        "canReview": can_review,
        "canDismiss": can_review,
        "canApproveBanned": can_manage,
        "canApproveAvailable": can_available,
        "canManageBlacklist": can_review,
    }


def _song_request_is_own_submission(req, email: str) -> bool:
    owner = normalize_manager_email(req.get("requestedBy", {}).get("email"))
    viewer = normalize_manager_email(email)
    return bool(owner and viewer and owner == viewer)


def _find_pending_duplicate_request(requests, email: str, title: str, artist: str, exclude_id=None):
    viewer = normalize_manager_email(email)
    title_key = _song_lookup_key(title)
    artist_key = _song_lookup_key(artist)
    if not viewer or not title_key or not artist_key:
        return False
    exclude_id = str(exclude_id or "").strip() or None
    for req in requests or []:
        if exclude_id and req.get("id") == exclude_id:
            continue
        if req.get("status") != "pending":
            continue
        owner = normalize_manager_email(req.get("requestedBy", {}).get("email"))
        if owner != viewer:
            continue
        if _song_lookup_key(req.get("title")) == title_key and _song_lookup_key(req.get("artist")) == artist_key:
            return True
    return False


def _song_request_still_pending(req_id: str):
    data = load_song_requests()
    for req in data.get("requests", []):
        if req.get("id") == req_id and req.get("status") == "pending":
            return req
    return None


def _song_request_blacklist_emails(data=None):
    data = data if data is not None else load_song_requests()
    return {
        normalize_manager_email(entry.get("email"))
        for entry in data.get("blacklist", [])
        if normalize_manager_email(entry.get("email"))
    }


def _is_song_request_submitter_blocked(email: str, data=None) -> bool:
    normalized = normalize_manager_email(email)
    if not normalized:
        return False
    return normalized in _song_request_blacklist_emails(data)


def require_song_request_reviewer(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if is_dev_streamer():
            return f(*args, **kwargs)
        user = current_user()
        if not user:
            return jsonify({"error": "login_required", "hint": "로그인이 필요합니다."}), 401
        email = normalize_manager_email(user.get("email", ""))
        caps = _song_request_review_capabilities(email)
        if not caps["canManageBlacklist"]:
            return jsonify({"error": "forbidden", "hint": "노래책 신청 관리 권한이 없습니다."}), 403
        return f(*args, **kwargs)

    return decorated


def _normalize_song_request_likes(raw):
    if not isinstance(raw, list):
        return []
    seen = set()
    out = []
    for item in raw:
        if isinstance(item, str):
            email = normalize_manager_email(item)
        elif isinstance(item, dict):
            email = normalize_manager_email(item.get("email"))
        else:
            continue
        if email and email not in seen:
            seen.add(email)
            out.append(email)
    return out


def _song_request_api_payload(req, viewer_email="", keep_requester=False):
    likes = _normalize_song_request_likes(req.get("likes"))
    hide = {"likes"}
    if not keep_requester:
        hide.add("requestedBy")
    out = {k: v for k, v in req.items() if k not in hide}
    out["likeCount"] = len(likes)
    if viewer_email:
        out["likedByMe"] = viewer_email in likes
    return out


def _public_song_request(req, viewer_email=""):
    return _song_request_api_payload(req, viewer_email=viewer_email, keep_requester=False)


def _current_song_requests_submitter_email():
    user = current_user()
    if is_dev_streamer() and not user:
        return normalize_manager_email("dev@local")
    if not user:
        return ""
    return normalize_manager_email(user.get("email", ""))


def _musicbook_artist_renames(old_data, new_data):
    old_songs = {}
    for s in old_data.get("songs") or []:
        if isinstance(s, dict) and s.get("id"):
            old_songs[s["id"]] = s
    new_songs = {}
    for s in new_data.get("songs") or []:
        if isinstance(s, dict) and s.get("id"):
            new_songs[s["id"]] = s

    candidate = {}
    ambiguous = set()
    for sid, new_s in new_songs.items():
        old_s = old_songs.get(sid)
        if not old_s:
            continue
        old_a = str(old_s.get("artist") or "").strip()
        new_a = str(new_s.get("artist") or "").strip()
        if not old_a or not new_a or old_a == new_a:
            continue
        if old_a in ambiguous:
            continue
        prev = candidate.get(old_a)
        if prev is None:
            candidate[old_a] = new_a
        elif prev != new_a:
            ambiguous.add(old_a)
            candidate.pop(old_a, None)

    new_artists = {
        str(s.get("artist") or "").strip()
        for s in new_data.get("songs") or []
        if isinstance(s, dict)
    }
    return {
        old_a: new_a
        for old_a, new_a in candidate.items()
        if old_a not in ambiguous and old_a not in new_artists
    }


def _sync_song_request_artists(renames):
    if not renames:
        return
    data = load_song_requests()
    changed = False
    now = utc_now()
    for req in data.get("requests", []):
        artist = str(req.get("artist") or "").strip()
        if artist in renames:
            req["artist"] = renames[artist]
            req["updatedAt"] = now
            changed = True
    if changed:
        save_song_requests(data)


def _song_lookup_key(value: str) -> str:
    return str(value or "").strip().lower()


def _find_musicbook_song_by_title_artist(title: str, artist: str):
    t = _song_lookup_key(title)
    a = _song_lookup_key(artist)
    if not t or not a:
        return None
    for song in load_musicbook().get("songs") or []:
        if not isinstance(song, dict):
            continue
        if _song_lookup_key(song.get("title")) == t and _song_lookup_key(song.get("artist")) == a:
            return song
    return None


def _song_request_musicbook_block(title: str, artist: str, existing_req=None):
    """노래책 중복·금지곡 검사. existing_req가 있고 제목·아티스트가 같으면 수정은 허용."""
    song = _find_musicbook_song_by_title_artist(title, artist)
    if not song:
        return None, None
    if existing_req:
        old_title = str(existing_req.get("title") or "").strip()
        old_artist = str(existing_req.get("artist") or "").strip()
        if old_title == str(title or "").strip() and old_artist == str(artist or "").strip():
            return None, None
    status = str(song.get("status") or "available").strip().lower()
    if status == "banned":
        return (
            "song_banned",
            "금지 목록에 있는 곡은 신청할 수 없습니다.",
        )
    return (
        "song_exists",
        "이미 노래책에 등록된 곡입니다. 같은 곡을 다시 신청할 필요가 없습니다.",
    )


def _normalize_song_request_input(payload):
    if not isinstance(payload, dict):
        return None, "invalid_json"
    title = str(payload.get("title", "")).strip()
    artist = str(payload.get("artist", "")).strip()
    language = str(payload.get("language", "")).strip().upper()
    youtube_url = _normalize_youtube_url(payload.get("youtubeUrl") or payload.get("youtube"))
    note = str(payload.get("note", "")).strip()
    if not title:
        return None, "title_required"
    if not artist:
        return None, "artist_required"
    if language not in SONG_LANGUAGES:
        return None, "language_required"
    if not youtube_url:
        return None, "youtube_required"
    return {
        "title": title[:200],
        "artist": artist[:200],
        "language": language,
        "youtubeUrl": youtube_url,
        "note": note[:500],
    }, None


def _normalize_link_url(url):
    url = str(url or "").strip()
    if not url:
        return ""
    if url in ("/", "/schedule", "/schedule/"):
        return "/calendar"
    if url.startswith("/"):
        return url
    parsed = urlparse(url)
    if parsed.scheme in ("http", "https") and parsed.netloc:
        return url
    return ""


LINK_ICON_UPLOAD_URL_PREFIX = "/uploads/link-icons/"
PATCHNOTE_IMAGE_UPLOAD_URL_PREFIX = "/uploads/patchnote-images/"
_IMAGE_EXT_MAP = {"png": "png", "jpeg": "jpg", "gif": "gif", "webp": "webp"}


def _detect_image_extension(data: bytes):
    if not data:
        return None
    if len(data) >= 8 and data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if len(data) >= 6 and data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if len(data) >= 2 and data[:2] == b"\xff\xd8":
        return "jpg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    kind = imghdr.what(None, data)
    return _IMAGE_EXT_MAP.get(kind)


def _normalize_link_icon_preset(raw):
    key = str(raw or "").strip()
    if not key:
        return ""
    return LINK_ICON_PRESET_BY_LOWER.get(key.lower(), "")


def _svg_local_tag(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _sanitize_link_icon_svg(raw) -> str:
    text = str(raw or "").strip()
    if not text:
        return ""
    if len(text) > LINK_ICON_SVG_MAX_LEN:
        text = text[:LINK_ICON_SVG_MAX_LEN]
    lowered = text.lower()
    if "<svg" not in lowered:
        return ""
    for bad in LINK_ICON_SVG_FORBIDDEN_SNIPPETS:
        if bad in lowered:
            return ""
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return ""
    if _svg_local_tag(root.tag) != "svg":
        return ""

    def clean(elem):
        tag = _svg_local_tag(elem.tag)
        if tag not in LINK_ICON_SVG_ALLOWED_TAGS:
            return None
        # Unprefixed tags so saved SVG stays <svg xmlns="..."> (not ns0:svg).
        cleaned = ET.Element(tag)
        for key, value in elem.attrib.items():
            attr = str(key).split("}", 1)[-1].lower()
            if attr not in LINK_ICON_SVG_ALLOWED_ATTRS:
                continue
            val = str(value).strip()
            if not val or "javascript:" in val.lower():
                continue
            cleaned.set(attr, val)
        for child in list(elem):
            cleaned_child = clean(child)
            if cleaned_child is not None:
                cleaned.append(cleaned_child)
        if tag == "svg" and "xmlns" not in cleaned.attrib:
            cleaned.set("xmlns", "http://www.w3.org/2000/svg")
        return cleaned

    cleaned_root = clean(root)
    if cleaned_root is None:
        return ""
    out = ET.tostring(cleaned_root, encoding="unicode")
    return out.strip()


def _normalize_link_icon_color(raw, default="#6b7280") -> str:
    color = str(raw or "").strip()
    if not color:
        return default
    if LINK_ICON_COLOR_RE.match(color):
        return color.lower()
    return default


def _normalize_link_icon_url(url, max_len=500):
    url = str(url or "").strip()
    if not url:
        return ""
    if len(url) > max_len:
        url = url[:max_len]
    parsed = urlparse(url)
    if parsed.scheme in ("http", "https") and parsed.netloc:
        return url
    normalized = url.replace("\\", "/")
    if normalized.startswith(LINK_ICON_UPLOAD_URL_PREFIX):
        rest = normalized[len(LINK_ICON_UPLOAD_URL_PREFIX) :]
        if not rest or ".." in rest or "/" in rest.strip("/"):
            return ""
        name = Path(rest).name
        if not re.fullmatch(r"link-icon-[a-f0-9]+\.(png|jpg|jpeg|gif|webp)", name, re.I):
            return ""
        return f"{LINK_ICON_UPLOAD_URL_PREFIX}{name}"
    return ""


def _normalize_patchnote_image_url(url, max_len=500):
    url = str(url or "").strip()
    if not url:
        return ""
    if len(url) > max_len:
        url = url[:max_len]
    parsed = urlparse(url)
    if parsed.scheme in ("http", "https") and parsed.netloc:
        return url
    normalized = url.replace("\\", "/")
    if normalized.startswith(PATCHNOTE_IMAGE_UPLOAD_URL_PREFIX):
        rest = normalized[len(PATCHNOTE_IMAGE_UPLOAD_URL_PREFIX) :]
        if not rest or ".." in rest or "/" in rest.strip("/"):
            return ""
        name = Path(rest).name
        if not re.fullmatch(r"patchnote-[a-f0-9]+\.(png|jpg|jpeg|gif|webp)", name, re.I):
            return ""
        return f"{PATCHNOTE_IMAGE_UPLOAD_URL_PREFIX}{name}"
    return ""


def _normalize_patchnote_image_alt(raw, max_len=120):
    alt = str(raw or "").strip()
    if not alt:
        return ""
    return alt[:max_len]


def _normalize_patchnote_image_caption(raw, max_len=200):
    caption = str(raw or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not caption:
        return ""
    if len(caption) > max_len:
        caption = caption[:max_len]
    return caption


MAX_PATCHNOTE_CONTENT_BLOCKS = 30
MAX_PATCHNOTE_CONTENT_TEXT = 10000
MAX_PATCHNOTE_CONTENT_IMAGES = 15
PATCHNOTE_IMAGE_SIZES = frozenset({"sm", "md", "lg", "full"})


def _normalize_patchnote_image_size(raw):
    size = str(raw or "").strip().lower()
    if size in PATCHNOTE_IMAGE_SIZES:
        return size
    return "full"


def _normalize_patchnote_content_block(raw):
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("type") or "").strip().lower()
    if kind == "text":
        text = _normalize_patchnote_multiline(raw.get("text"), max_len=MAX_PATCHNOTE_CONTENT_TEXT)
        if not text:
            return None
        return {"type": "text", "text": text}
    if kind == "image":
        url = _normalize_patchnote_image_url(raw.get("url") or raw.get("imageUrl"))
        if not url:
            return None
        alt = _normalize_patchnote_image_alt(raw.get("alt") or raw.get("imageAlt"))
        caption = _normalize_patchnote_image_caption(raw.get("caption"))
        size = _normalize_patchnote_image_size(raw.get("size"))
        block = {"type": "image", "url": url}
        if alt:
            block["alt"] = alt
        if caption:
            block["caption"] = caption
        if size != "full":
            block["size"] = size
        return block
    return None


def _merge_patchnote_content_blocks(blocks):
    merged = []
    for block in blocks:
        if block.get("type") == "text" and merged and merged[-1].get("type") == "text":
            merged[-1]["text"] = _normalize_patchnote_multiline(
                merged[-1]["text"] + "\n" + block["text"],
                max_len=MAX_PATCHNOTE_CONTENT_TEXT,
            )
        else:
            merged.append(dict(block))
    return [block for block in merged if block.get("type") != "text" or block.get("text")]


def _normalize_patchnote_content(raw_content, legacy_details="", legacy_image_url="", legacy_image_alt=""):
    blocks = []
    if isinstance(raw_content, list):
        for item in raw_content:
            block = _normalize_patchnote_content_block(item)
            if block:
                blocks.append(block)

    if not blocks:
        details = _normalize_patchnote_multiline(legacy_details, max_len=MAX_PATCHNOTE_CONTENT_TEXT)
        image_url = _normalize_patchnote_image_url(legacy_image_url)
        image_alt = _normalize_patchnote_image_alt(legacy_image_alt)
        if details:
            blocks.append({"type": "text", "text": details})
        if image_url:
            image_block = {"type": "image", "url": image_url}
            if image_alt:
                image_block["alt"] = image_alt
            blocks.append(image_block)

    blocks = _merge_patchnote_content_blocks(blocks)

    normalized = []
    text_total = 0
    image_count = 0
    for block in blocks:
        if len(normalized) >= MAX_PATCHNOTE_CONTENT_BLOCKS:
            break
        if block["type"] == "text":
            remaining = MAX_PATCHNOTE_CONTENT_TEXT - text_total
            if remaining <= 0:
                continue
            text = block["text"][:remaining]
            if not text:
                continue
            text_total += len(text)
            normalized.append({"type": "text", "text": text})
        elif block["type"] == "image":
            if image_count >= MAX_PATCHNOTE_CONTENT_IMAGES:
                continue
            image_count += 1
            normalized.append(block)

    return normalized


def _normalize_optional_http_url(url, max_len=500):
    url = str(url or "").strip()
    if not url:
        return ""
    if len(url) > max_len:
        url = url[:max_len]
    parsed = urlparse(url)
    if parsed.scheme in ("http", "https") and parsed.netloc:
        return url
    return ""


def _normalize_iso_date(raw):
    raw = str(raw or "").strip()
    if not raw:
        return ""
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        return raw
    return ""


def _normalize_youtube_channel_url(url):
    url = str(url or "").strip()
    if not url:
        return ""
    parsed = urlparse(url)
    host = (parsed.netloc or "").lower()
    if host not in ("www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"):
        return ""
    if not parsed.scheme:
        url = "https://" + url.lstrip("/")
    return url.split("?")[0].rstrip("/")


def resolve_youtube_channel_id(channel_url, channel_id=""):
    return yt_api.resolve_channel_id(channel_url, channel_id)


def fetch_youtube_latest_video(channel_url, channel_id="", include_shorts=False):
    return yt_api.fetch_latest_video(channel_url, channel_id, include_shorts=include_shorts)


def get_youtube_latest_for_config(youtube_cfg, fetch_if_missing=True):
    if not isinstance(youtube_cfg, dict) or not youtube_cfg.get("enabled"):
        return None
    channel_url = youtube_cfg.get("channelUrl") or ""
    channel_id = youtube_cfg.get("channelId") or ""
    include_shorts = bool(youtube_cfg.get("includeShorts"))
    cid = resolve_youtube_channel_id(channel_url, channel_id)
    if not cid:
        return {"error": "channel_not_found"}
    cache_key = f"{cid}:{'all' if include_shorts else 'long'}"
    now = time.time()
    cached = _youtube_latest_cache.get(cache_key)
    if cached and cached.get("expires", 0) > now:
        return cached.get("data")
    if not fetch_if_missing:
        return None
    if not yt_api.enabled():
        result = {"error": "youtube_api_not_configured", "channelId": cid}
        cache_ttl = YOUTUBE_LATEST_CACHE_TTL_NO_KEY
        _youtube_latest_cache[cache_key] = {"data": result, "expires": now + cache_ttl}
        return result
    latest = fetch_youtube_latest_video(channel_url, cid, include_shorts=include_shorts)
    if not latest:
        result = {"error": "fetch_failed", "channelId": cid}
        cache_ttl = YOUTUBE_LATEST_CACHE_TTL_FAIL
    else:
        result = latest
        cache_ttl = YOUTUBE_LATEST_CACHE_TTL_OK
    _youtube_latest_cache[cache_key] = {"data": result, "expires": now + cache_ttl}
    return result


def _bust_youtube_latest_cache(channel_url="", channel_id=""):
    cid = resolve_youtube_channel_id(channel_url, channel_id)
    if not cid:
        return
    keys = [
        key
        for key in _youtube_latest_cache
        if key == cid or str(key).startswith(f"{cid}:")
    ]
    for key in keys:
        _youtube_latest_cache.pop(key, None)


def _normalize_profile_image_url(raw):
    url = str(raw or "").strip()
    if not url:
        return ""
    if url.startswith("//"):
        return "https:" + url
    if url.startswith("http://") or url.startswith("https://"):
        return url
    return ""


def _soop_station_cache_key(station_id):
    return f"soop:{str(station_id or '').strip().lower()}"


def _soop_live_cache_ttl(is_live):
    return 45 if is_live else 90


def _live_status_from_soop_payload(station_id, payload):
    station_id = str(station_id or "").strip()
    if not isinstance(payload, dict):
        return {"isLive": False, "error": "invalid_payload", "stationId": station_id}
    broad = payload.get("broad")
    is_live = broad is not None
    profile = _normalize_profile_image_url(payload.get("profile_image"))
    thumb = ""
    title = ""
    viewer_count = None
    category = ""

    if broad:
        title = str(broad.get("broad_title") or "").strip()
        thumb = _normalize_profile_image_url(
            broad.get("thumbnail_image_url")
            or broad.get("broad_thumb")
            or broad.get("thumbnail")
            or ""
        )
        if not thumb:
            broad_no = broad.get("broad_no") or broad.get("broadNo")
            if broad_no:
                thumb = f"https://liveimg.sooplive.co.kr/m/{broad_no}"
        viewer_count = _parse_soop_viewer_count(broad)

    return {
        "isLive": is_live,
        "platform": "soop",
        "stationId": station_id,
        "title": title,
        "thumbnailURL": thumb or profile or None,
        "profileImageURL": profile or None,
        "liveLink": f"https://play.sooplive.co.kr/{station_id}",
        "stationLink": f"https://www.sooplive.co.kr/station/{station_id}",
        "viewerCount": viewer_count,
        "categoryName": category or None,
    }


def _fetch_soop_station_payload(station_id):
    station_id = str(station_id or "").strip().lower()
    api_url = f"https://chapi.sooplive.co.kr/api/{urllib.parse.quote(station_id)}/station"
    req = urllib.request.Request(api_url, headers=SOOP_FETCH_HEADERS)
    with urllib.request.urlopen(req, timeout=12) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _soop_station_bundle_from_cache(station_id, live_cached=None, profile_cached=None):
    station_id = str(station_id or "").strip()
    stale_live = dict(live_cached.get("data") or {}) if live_cached else {"isLive": False, "stationId": station_id}
    return {
        "profile_url": (profile_cached or {}).get("url") or "",
        "live_status": stale_live,
    }


def _store_soop_station_bundle(station_id, payload):
    station_id = str(station_id or "").strip().lower()
    now = time.time()
    cache_key = _soop_station_cache_key(station_id)
    live_status = _live_status_from_soop_payload(station_id, payload)
    profile_url = _normalize_profile_image_url(payload.get("profile_image"))
    _live_status_cache[cache_key] = {
        "data": live_status,
        "expires": now + _soop_live_cache_ttl(live_status.get("isLive")),
    }
    if profile_url:
        _profile_image_cache[cache_key] = {"url": profile_url, "expires": now + SOOP_PROFILE_CACHE_TTL}
    return {"profile_url": profile_url, "live_status": live_status}


def _refresh_soop_station_bundle_async(station_id):
    station_id = str(station_id or "").strip().lower()
    if not station_id:
        return
    cache_key = _soop_station_cache_key(station_id)
    with _soop_refresh_lock:
        if cache_key in _soop_refresh_inflight:
            return
        _soop_refresh_inflight.add(cache_key)

    def worker():
        try:
            payload = _fetch_soop_station_payload(station_id)
            _store_soop_station_bundle(station_id, payload)
        except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError):
            pass
        finally:
            with _soop_refresh_lock:
                _soop_refresh_inflight.discard(cache_key)

    threading.Thread(target=worker, daemon=True).start()


def _get_soop_station_bundle(station_id, *, allow_network=True, blocking_refresh=False):
    station_id = str(station_id or "").strip().lower()
    if not station_id:
        return {
            "profile_url": "",
            "live_status": {"isLive": False, "error": "missing_station_id"},
        }

    now = time.time()
    cache_key = _soop_station_cache_key(station_id)
    live_cached = _live_status_cache.get(cache_key)
    profile_cached = _profile_image_cache.get(cache_key)
    live_fresh = live_cached and live_cached.get("expires", 0) > now
    profile_fresh = profile_cached and profile_cached.get("expires", 0) > now
    if live_fresh and profile_fresh:
        return _soop_station_bundle_from_cache(station_id, live_cached, profile_cached)

    if not allow_network:
        return _soop_station_bundle_from_cache(station_id, live_cached, profile_cached)

    if live_cached or profile_cached:
        if blocking_refresh:
            try:
                payload = _fetch_soop_station_payload(station_id)
                return _store_soop_station_bundle(station_id, payload)
            except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
                stale_live = dict(live_cached.get("data") or {}) if live_cached else {"isLive": False, "error": str(exc)}
                return {
                    "profile_url": (profile_cached or {}).get("url") or "",
                    "live_status": {**stale_live, "stationId": station_id},
                }
        _refresh_soop_station_bundle_async(station_id)
        return _soop_station_bundle_from_cache(station_id, live_cached, profile_cached)

    try:
        payload = _fetch_soop_station_payload(station_id)
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
        return {
            "profile_url": "",
            "live_status": {"isLive": False, "error": str(exc), "stationId": station_id},
        }

    return _store_soop_station_bundle(station_id, payload)


def fetch_soop_profile_image(station_id):
    return _get_soop_station_bundle(station_id).get("profile_url") or ""


def _parse_soop_viewer_count(data):
    if not isinstance(data, dict):
        return None
    for key in (
        "currentSumViewer",
        "current_sum_viewer",
        "viewCnt",
        "view_cnt",
        "viewer",
        "viewerCount",
    ):
        val = data.get(key)
        if val is None:
            continue
        try:
            n = int(val)
        except (TypeError, ValueError):
            continue
        if n > 0:
            return n
    return None


def fetch_soop_live_status(station_id):
    bundle = _get_soop_station_bundle(station_id, blocking_refresh=True)
    live_status = dict(bundle.get("live_status") or {"isLive": False})
    if station_id and "stationId" not in live_status:
        live_status["stationId"] = str(station_id).strip()
    return live_status


def _resolve_links_live_station_id(live_cfg):
    return LINKS_SOOP_STATION_ID


def _bust_live_status_cache(station_id=""):
    if not station_id:
        _live_status_cache.clear()
        for key in [k for k in _profile_image_cache if str(k).startswith("soop:")]:
            _profile_image_cache.pop(key, None)
        return
    cache_key = _soop_station_cache_key(station_id)
    _live_status_cache.pop(cache_key, None)
    _profile_image_cache.pop(cache_key, None)


def _bust_manual_video_meta_cache():
    _manual_video_meta_cache.clear()


def get_links_live_status(live_cfg, *, fetch_if_missing=True, soop_bundle=None):
    live_cfg = live_cfg if isinstance(live_cfg, dict) else {}
    if not live_cfg.get("enabled", True):
        return {"isLive": False, "enabled": False}
    platform = str(live_cfg.get("platform") or "soop").strip().lower()
    if platform != "soop":
        return {"isLive": False, "enabled": True, "error": "unsupported_platform"}
    station_id = _resolve_links_live_station_id(live_cfg)
    if soop_bundle is not None:
        return {**dict(soop_bundle.get("live_status") or {}), "enabled": True}
    if not fetch_if_missing:
        cached = _live_status_cache.get(_soop_station_cache_key(station_id))
        if cached and cached.get("expires", 0) > time.time():
            return {**dict(cached.get("data") or {}), "enabled": True}
        return {"isLive": False, "enabled": True, "stationId": station_id}
    status = fetch_soop_live_status(station_id)
    return {**status, "enabled": True}


def fetch_youtube_channel_avatar(channel_url, channel_id=""):
    cid = resolve_youtube_channel_id(channel_url, channel_id)
    if not cid:
        return ""
    cache_key = f"youtube:{cid}"
    now = time.time()
    cached = _profile_image_cache.get(cache_key)
    if cached and cached.get("expires", 0) > now:
        return cached.get("url") or ""
    avatar_url = yt_api.fetch_channel_avatar_url(channel_url, channel_id)
    if avatar_url:
        _profile_image_cache[cache_key] = {"url": avatar_url, "expires": now + 3600}
        return avatar_url
    return cached.get("url") if cached else ""


def resolve_links_profile(links_data, *, profile_url=None):
    profile = links_data.get("profile") if isinstance(links_data.get("profile"), dict) else {}
    if profile_url is None:
        live_cfg = links_data.get("live") if isinstance(links_data.get("live"), dict) else {}
        if live_cfg.get("enabled", True):
            station_id = _resolve_links_live_station_id(live_cfg)
        else:
            station_id = LINKS_SOOP_STATION_ID
        profile_url = fetch_soop_profile_image(station_id)
    title_raw = str(profile.get("title") or "").strip()
    return {
        "title": title_raw or LINKS_STREAMER_DISPLAY_NAME,
        "subtitle": str(profile.get("subtitle") or "").strip(),
        "avatarUrl": profile_url or "",
    }


def _normalize_match_text(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _all_day_slots(day_data):
    data = day_data or {}
    slots = list(data.get("slots") or [])
    part2 = data.get("part2")
    if isinstance(part2, dict):
        slots.extend(part2.get("slots") or [])
    return slots


def _highlight_matches_any_slot(day_data, highlight_text):
    slots = _all_day_slots(day_data)
    if not slots:
        return False
    target = _normalize_match_text(highlight_text)
    if not target:
        return False
    for slot in slots:
        if _normalize_match_text(slot.get("text")) == target:
            return True
    for slot in slots:
        slot_text = _normalize_match_text(slot.get("text"))
        first_line = str(slot.get("text") or "").split("\n")[0].strip()
        if target in slot_text or slot_text in target:
            return True
        if first_line and (target in first_line or first_line in target):
            return True
    return False


def _find_highlight_slot(day_data, highlight_text):
    slots = _all_day_slots(day_data)
    if not slots:
        return None
    target = _normalize_match_text(highlight_text)
    if not target:
        return slots[0]
    for slot in slots:
        if _normalize_match_text(slot.get("text")) == target:
            return slot
    for slot in slots:
        slot_text = _normalize_match_text(slot.get("text"))
        first_line = str(slot.get("text") or "").split("\n")[0].strip()
        if target in slot_text or slot_text in target:
            return slot
        if first_line and (target in first_line or first_line in target):
            return slot
    return slots[0]


def _get_day_parts_for_highlight(day_data):
    if not isinstance(day_data, dict):
        return []
    slots = day_data.get("slots") or []
    parts = [{"bangonTime": day_data.get("bangonTime"), "slots": slots}]
    part2 = day_data.get("part2")
    if isinstance(part2, dict) and part2.get("slots"):
        parts.append({"bangonTime": part2.get("bangonTime"), "slots": part2.get("slots") or []})
    return parts


def _find_highlight_part_ref(day_data, highlight_text):
    slot = _find_highlight_slot(day_data, highlight_text)
    if not slot:
        return None, None
    target = _normalize_match_text(slot.get("text"))
    for part in _get_day_parts_for_highlight(day_data):
        for item in part.get("slots") or []:
            if _normalize_match_text(item.get("text")) == target:
                return part, item
    parts = _get_day_parts_for_highlight(day_data)
    return (parts[0] if parts else None), slot


def _highlight_display_meta(day_data, highlight_text):
    part, slot = _find_highlight_part_ref(day_data, highlight_text)
    if not isinstance(slot, dict):
        return ""
    fallback = (day_data or {}).get("category") or "default"
    meta_label = ""
    if slot.get("allDay") is True:
        if part and not _is_off_day_slots(part.get("slots") or [], fallback):
            bangon = normalize_bangon_time(part.get("bangonTime"))
            if bangon:
                meta_label = _format_bangon_time_display(bangon)
    else:
        start_time = normalize_bangon_time(slot.get("startTime"))
        if start_time and start_time not in BANGON_PRESET_KEYS:
            meta_label = _format_slot_start_time_display(start_time)
    return meta_label


def _slot_category(slot, categories):
    cat_key = str((slot or {}).get("category") or "default")
    cat = categories.get(cat_key) or categories.get("default") or {}
    return {
        "label": str(cat.get("label") or cat_key or "일반"),
        "bg": str(cat.get("bg") or "#ffffff"),
        "text": str(cat.get("text") or "#333333"),
    }


def get_schedule_meta_public():
    data = load_schedule()
    return {
        "streamerName": str(data.get("streamerName") or ""),
        "brandColor": str(data.get("brandColor") or ""),
        "chipColorMode": normalize_chip_color_mode(data.get("chipColorMode")),
        "calendarFont": data.get("calendarFont", "gmarketSans"),
        "sidebarFont": data.get("sidebarFont", "nanumGothic"),
        "calendarFontBold": data.get("calendarFontBold", False),
        "sidebarFontBold": data.get("sidebarFontBold", True),
    }


def _schedule_meta_from_schedule(schedule):
    return {
        "streamerName": str(schedule.get("streamerName") or ""),
        "brandColor": str(schedule.get("brandColor") or ""),
        "chipColorMode": normalize_chip_color_mode(schedule.get("chipColorMode")),
    }


def get_links_schedule_meta():
    return _schedule_meta_from_schedule(load_schedule())


def _upcoming_highlights_from_schedule(schedule):
    categories = schedule.get("categories") or {}
    today = _today_iso()
    items = []
    months = schedule.get("months") or {}
    for month_key in sorted(months.keys()):
        month = months.get(month_key)
        if not isinstance(month, dict):
            continue
        days = month.get("days") or {}
        for highlight in month.get("highlights") or []:
            if not isinstance(highlight, dict):
                continue
            date_key = str(highlight.get("date") or "").strip()
            text = str(highlight.get("text") or "").strip()
            if not date_key or not text or date_key < today:
                continue
            day_data = days.get(date_key)
            if not _highlight_matches_any_slot(day_data, text):
                continue
            slot = _find_highlight_slot(day_data, text)
            cat = _slot_category(slot, categories)
            meta_label = _highlight_display_meta(day_data, text)
            item = {
                "date": date_key,
                "text": text,
                "category": cat["label"],
                "categoryBg": cat["bg"],
                "categoryText": cat["text"],
            }
            if meta_label:
                item["metaLabel"] = meta_label
            items.append(item)
    items.sort(key=lambda item: (item["date"], item["text"]))
    return items


def get_upcoming_highlights_enriched():
    return _upcoming_highlights_from_schedule(load_schedule())


def _normalize_announcement_style(raw):
    style = str(raw or "notice").strip().lower()
    if style in ANNOUNCEMENT_STYLES:
        return style
    return ANNOUNCEMENT_STYLE_ALIASES.get(style, "notice")


def _announcement_sort_key(item):
    return (item.get("order", 0), item.get("text", ""))


def _normalize_side_blocks(raw_blocks, announcements, manual_videos):
    ann_ids = {item["id"] for item in announcements}
    manual_video_ids = {item["id"] for item in manual_videos}
    ann_sorted = sorted(announcements, key=_announcement_sort_key)
    manual_sorted = sorted(manual_videos, key=_manual_video_sort_key)
    out = []
    seen = set()
    legacy_ann_idx = None

    if isinstance(raw_blocks, list):
        for raw_block in raw_blocks:
            block_id = str(raw_block or "").strip()
            if not block_id or block_id in seen:
                continue
            if block_id == "announcements":
                legacy_ann_idx = len(out)
                continue
            if block_id in SIDE_BLOCK_STRUCTURAL:
                out.append(block_id)
                seen.add(block_id)
                continue
            if block_id.startswith(ANN_BLOCK_PREFIX):
                ann_id = block_id[len(ANN_BLOCK_PREFIX) :]
                if ann_id in ann_ids:
                    out.append(block_id)
                    seen.add(block_id)
                continue
            if block_id.startswith(MANUAL_VIDEO_BLOCK_PREFIX):
                item_id = block_id[len(MANUAL_VIDEO_BLOCK_PREFIX) :]
                if item_id in manual_video_ids:
                    out.append(block_id)
                    seen.add(block_id)

    for block_id in DEFAULT_SIDE_BLOCKS:
        if block_id not in seen:
            out.append(block_id)
            seen.add(block_id)

    missing_manual_blocks = [
        f"{MANUAL_VIDEO_BLOCK_PREFIX}{item['id']}"
        for item in manual_sorted
        if f"{MANUAL_VIDEO_BLOCK_PREFIX}{item['id']}" not in seen
    ]
    if missing_manual_blocks:
        youtube_idx = out.index("youtube") if "youtube" in out else len(out)
        for idx, block_id in enumerate(missing_manual_blocks):
            out.insert(youtube_idx + 1 + idx, block_id)
            seen.add(block_id)

    missing_ann_blocks = [
        f"{ANN_BLOCK_PREFIX}{item['id']}"
        for item in ann_sorted
        if f"{ANN_BLOCK_PREFIX}{item['id']}" not in seen
    ]
    if missing_ann_blocks:
        if legacy_ann_idx is not None:
            for idx, block_id in enumerate(missing_ann_blocks):
                out.insert(legacy_ann_idx + idx, block_id)
                seen.add(block_id)
        else:
            for block_id in missing_ann_blocks:
                out.append(block_id)
                seen.add(block_id)

    return out


def _normalize_youtube_thumb_size(raw):
    size = str(raw or "large").strip().lower()
    return "small" if size == "small" else "large"


def _manual_video_sort_key(item):
    try:
        order = int(item.get("order", 0))
    except (TypeError, ValueError):
        order = 0
    return (order, str(item.get("id") or ""))


def _normalize_manual_videos(raw_list):
    out = []
    seen_ids = set()
    items_in = raw_list if isinstance(raw_list, list) else []
    for idx, raw in enumerate(items_in):
        if not isinstance(raw, dict):
            continue
        item_id = str(raw.get("id") or "").strip()
        if not LINK_ID_RE.match(item_id) or item_id in seen_ids:
            item_id = f"yt-{_new_song_id()}"
        seen_ids.add(item_id)
        video_id = yt_api.parse_video_id(
            raw.get("videoId") or raw.get("videoUrl") or raw.get("url") or ""
        )
        if not video_id:
            continue
        heading = str(raw.get("heading") or raw.get("label") or "").strip()[:80]
        try:
            order = int(raw.get("order", idx))
        except (TypeError, ValueError):
            order = idx
        out.append(
            {
                "id": item_id,
                "videoId": video_id,
                "heading": heading,
                "enabled": raw.get("enabled", True) is not False,
                "thumbSize": _normalize_youtube_thumb_size(raw.get("thumbSize")),
                "order": order,
            }
        )
    out.sort(key=_manual_video_sort_key)
    return out


def _manual_video_fallback(video_id):
    vid = yt_api.parse_video_id(video_id)
    if not vid:
        return None
    return {
        "videoId": vid,
        "title": "YouTube 영상",
        "url": f"https://www.youtube.com/watch?v={vid}",
        "thumbnailUrl": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
    }


def get_manual_video_meta_for_config(manual_videos, *, fetch_if_missing=True):
    meta = {}
    if not isinstance(manual_videos, list):
        return meta

    now = time.time()
    pending = []
    for item in manual_videos:
        if not isinstance(item, dict):
            continue
        item_id = str(item.get("id") or "").strip()
        video_id = str(item.get("videoId") or "").strip()
        if not item_id or not video_id:
            continue
        cached = _manual_video_meta_cache.get(video_id)
        if cached and cached.get("expires", 0) > now:
            meta[item_id] = cached.get("data")
            continue
        if not fetch_if_missing:
            meta[item_id] = _manual_video_fallback(video_id)
            continue
        pending.append((item_id, video_id))

    if not pending:
        return meta

    fetched = yt_api.fetch_videos_by_ids([video_id for _, video_id in pending])
    for item_id, video_id in pending:
        vid = yt_api.parse_video_id(video_id) or video_id
        payload = fetched.get(vid) or _manual_video_fallback(video_id)
        meta[item_id] = payload
        if payload:
            _manual_video_meta_cache[video_id] = {"data": payload, "expires": now + MANUAL_VIDEO_META_CACHE_TTL}
    return meta


def _links_soop_station_id(links_data):
    live_cfg = links_data.get("live") if isinstance(links_data.get("live"), dict) else {}
    if live_cfg.get("enabled", True):
        return _resolve_links_live_station_id(live_cfg)
    return LINKS_SOOP_STATION_ID


def enrich_links_api_payload(data, *, fetch_external=True):
    schedule = load_schedule()
    schedule_meta = _schedule_meta_from_schedule(schedule)
    upcoming_highlights = _upcoming_highlights_from_schedule(schedule)
    station_id = _links_soop_station_id(data)
    soop_bundle = _get_soop_station_bundle(station_id, allow_network=fetch_external)
    profile_resolved = resolve_links_profile(data, profile_url=soop_bundle.get("profile_url"))
    youtube_latest = get_youtube_latest_for_config(data.get("youtube"), fetch_if_missing=False)
    manual_video_meta = get_manual_video_meta_for_config(
        data.get("manualVideos") or [],
        fetch_if_missing=fetch_external,
    )
    live_status = get_links_live_status(data.get("live"), soop_bundle=soop_bundle)
    return {
        "profileResolved": profile_resolved,
        "youtubeLatest": youtube_latest,
        "manualVideoMeta": manual_video_meta,
        "liveStatus": live_status,
        "scheduleMeta": schedule_meta,
        "upcomingHighlights": upcoming_highlights,
    }


def _is_valid_page_block_id(block_id, ann_ids, manual_video_ids):
    if block_id in LINKS_PAGE_BLOCKS:
        return True
    if block_id.startswith(ANN_BLOCK_PREFIX):
        return block_id[len(ANN_BLOCK_PREFIX) :] in ann_ids
    if block_id.startswith(MANUAL_VIDEO_BLOCK_PREFIX):
        return block_id[len(MANUAL_VIDEO_BLOCK_PREFIX) :] in manual_video_ids
    return False


def _normalize_column_block_list(raw_blocks, ann_ids, manual_video_ids):
    out = []
    seen = set()
    if not isinstance(raw_blocks, list):
        return out
    for raw_block in raw_blocks:
        block_id = str(raw_block or "").strip()
        if not block_id or block_id in seen or block_id == "announcements":
            continue
        if _is_valid_page_block_id(block_id, ann_ids, manual_video_ids):
            out.append(block_id)
            seen.add(block_id)
    return out


def _merge_column_layout(left, right):
    left_out = []
    right_out = []
    seen = set()
    for block_id in left:
        if block_id in seen:
            continue
        seen.add(block_id)
        left_out.append(block_id)
    for block_id in right:
        if block_id in seen:
            continue
        seen.add(block_id)
        right_out.append(block_id)
    return {"left": left_out, "right": right_out}


def _normalize_columns(raw_columns, side_blocks_in, announcements, manual_videos):
    ann_ids = {item["id"] for item in announcements}
    manual_video_ids = {item["id"] for item in manual_videos}
    ann_sorted = sorted(announcements, key=_announcement_sort_key)
    manual_sorted = sorted(manual_videos, key=_manual_video_sort_key)

    if (
        isinstance(raw_columns, dict)
        and isinstance(raw_columns.get("left"), list)
        and isinstance(raw_columns.get("right"), list)
    ):
        left = _normalize_column_block_list(raw_columns["left"], ann_ids, manual_video_ids)
        right = _normalize_column_block_list(raw_columns["right"], ann_ids, manual_video_ids)
    else:
        left = [LINKS_BLOCK_LINKS]
        right = _normalize_side_blocks(side_blocks_in, announcements, manual_videos)

    combined = set(left + right)
    if LINKS_BLOCK_LINKS not in combined:
        left.insert(0, LINKS_BLOCK_LINKS)
        combined.add(LINKS_BLOCK_LINKS)

    for block_id in SIDE_BLOCK_STRUCTURAL:
        if block_id not in combined:
            right.append(block_id)
            combined.add(block_id)

    for item in manual_sorted:
        block_id = f"{MANUAL_VIDEO_BLOCK_PREFIX}{item['id']}"
        if block_id in combined:
            continue
        if "youtube" in right:
            right.insert(right.index("youtube") + 1, block_id)
        else:
            right.append(block_id)
        combined.add(block_id)

    for item in ann_sorted:
        block_id = f"{ANN_BLOCK_PREFIX}{item['id']}"
        if block_id in combined:
            continue
        right.append(block_id)
        combined.add(block_id)

    return _merge_column_layout(left, right)


def _normalize_column_split(raw):
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = DEFAULT_COLUMN_SPLIT
    return max(MIN_COLUMN_SPLIT, min(MAX_COLUMN_SPLIT, value))


def _apply_site_link_defaults(link_item: dict) -> dict:
    """내부 페이지 바로가기 — 표시 이름·설명을 사이트 기준으로 맞춤."""
    if link_item.get("url") == "/song-requests":
        link_item["label"] = SONG_REQUESTS_LINK_LABEL
        link_item["description"] = SONG_REQUESTS_LINK_DESCRIPTION
    return link_item


def normalize_links(data):
    data = json.loads(json.dumps(data))
    if not isinstance(data, dict):
        data = {}

    profile_in = data.get("profile") if isinstance(data.get("profile"), dict) else {}
    profile = {
        "title": str(profile_in.get("title") or "").strip()[:80],
        "subtitle": str(profile_in.get("subtitle") or "").strip()[:200],
    }

    links_out = []
    seen_link_ids = set()
    links_in = data.get("links") if isinstance(data.get("links"), list) else []
    for idx, raw in enumerate(links_in):
        if not isinstance(raw, dict):
            continue
        link_id = str(raw.get("id") or "").strip()
        if not LINK_ID_RE.match(link_id) or link_id in seen_link_ids:
            link_id = f"lnk-{_new_song_id()}"
        seen_link_ids.add(link_id)
        label = str(raw.get("label") or "").strip()[:80]
        url = _normalize_link_url(raw.get("url"))
        if not label or not url:
            continue
        description = str(raw.get("description") or "").strip()[:120]
        icon_svg = _sanitize_link_icon_svg(raw.get("iconSvg"))
        icon_color = _normalize_link_icon_color(raw.get("iconColor"))
        icon = _normalize_link_icon_preset(raw.get("icon"))
        icon_url = _normalize_link_icon_url(raw.get("iconUrl"))
        if icon_svg:
            icon = "custom"
            icon_url = ""
        elif icon == "custom":
            icon = ""
        try:
            order = int(raw.get("order", idx))
        except (TypeError, ValueError):
            order = idx
        link_item = {
            "id": link_id,
            "label": label,
            "url": url,
            "description": description,
            "icon": icon,
            "iconUrl": icon_url,
            "enabled": bool(raw.get("enabled", True)),
            "order": order,
        }
        if icon == "custom" and icon_svg:
            link_item["iconSvg"] = icon_svg
            link_item["iconColor"] = icon_color
        links_out.append(_apply_site_link_defaults(link_item))
    links_out.sort(key=lambda item: (item["order"], item["label"].lower()))

    announcements_out = []
    seen_ann_ids = set()
    announcements_in = data.get("announcements") if isinstance(data.get("announcements"), list) else []
    for idx, raw in enumerate(announcements_in):
        if not isinstance(raw, dict):
            continue
        ann_id = str(raw.get("id") or "").strip()
        if not LINK_ID_RE.match(ann_id) or ann_id in seen_ann_ids:
            ann_id = f"ann-{_new_song_id()}"
        seen_ann_ids.add(ann_id)
        text = str(raw.get("text") or "").strip()[:500]
        if not text:
            continue
        style = _normalize_announcement_style(raw.get("style"))
        try:
            order = int(raw.get("order", idx))
        except (TypeError, ValueError):
            order = idx
        ann_url = _normalize_link_url(raw.get("url"))
        starts_at = _normalize_iso_date(raw.get("startsAt"))
        expires_at = _normalize_iso_date(raw.get("expiresAt"))
        if starts_at and expires_at and starts_at > expires_at:
            starts_at = ""
        ann_item = {
            "id": ann_id,
            "text": text,
            "order": order,
            "startsAt": starts_at,
            "expiresAt": expires_at,
        }
        category = str(raw.get("category") or "").strip()
        if not category:
            # legacy migration: style -> category
            category = style
        if category and CAPSULE_ID_RE.match(category):
            ann_item["category"] = category
        if ann_url:
            ann_item["url"] = ann_url
        announcements_out.append(ann_item)
    announcements_out.sort(key=_announcement_sort_key)

    announcement_categories = DEFAULT_ANNOUNCEMENT_CATEGORIES
    if "announcementCategories" in data:
        ann_cats_in = data.get("announcementCategories") if isinstance(data.get("announcementCategories"), dict) else {}
        # Allow user to delete all categories (empty dict stays empty).
        if ann_cats_in:
            announcement_categories = _normalize_capsule_map(ann_cats_in, {}, [])
        else:
            announcement_categories = {}

    youtube_in = data.get("youtube") if isinstance(data.get("youtube"), dict) else {}
    youtube_in = {**DEFAULT_LINKS_YOUTUBE, **youtube_in}
    channel_url = _normalize_youtube_channel_url(youtube_in.get("channelUrl"))
    channel_id = str(youtube_in.get("channelId") or "").strip()
    if channel_id and not YOUTUBE_CHANNEL_ID_RE.match(channel_id):
        channel_id = ""
    if not channel_id:
        channel_id = DEFAULT_LINKS_YOUTUBE["channelId"]
    if not channel_url:
        channel_url = DEFAULT_LINKS_YOUTUBE["channelUrl"]
    youtube = {
        "enabled": bool(youtube_in.get("enabled", True)),
        "channelUrl": channel_url,
        "channelId": channel_id,
        "label": str(youtube_in.get("label") or "최신 업로드").strip()[:80] or "최신 업로드",
        "includeShorts": bool(youtube_in.get("includeShorts")),
        "thumbSize": _normalize_youtube_thumb_size(youtube_in.get("thumbSize")),
    }
    if youtube["enabled"] and not youtube["channelUrl"] and not youtube["channelId"]:
        youtube["enabled"] = False

    schedule_in = data.get("schedule") if isinstance(data.get("schedule"), dict) else {}
    schedule_in = {**DEFAULT_LINKS_SCHEDULE, **schedule_in}
    schedule = {
        "enabled": bool(schedule_in.get("enabled", True)),
        "label": str(schedule_in.get("label") or "주요 일정").strip()[:80] or "주요 일정",
    }

    live_in = data.get("live") if isinstance(data.get("live"), dict) else {}
    live_in = {**DEFAULT_LINKS_LIVE, **live_in}
    live = {
        "enabled": bool(live_in.get("enabled", True)),
        "platform": "soop",
        "stationId": LINKS_SOOP_STATION_ID,
    }

    side_blocks_in = data.get("sideBlocks") if isinstance(data.get("sideBlocks"), list) else []
    columns_in = data.get("columns") if isinstance(data.get("columns"), dict) else {}
    manual_videos_out = _normalize_manual_videos(data.get("manualVideos"))
    columns = _normalize_columns(columns_in, side_blocks_in, announcements_out, manual_videos_out)
    column_split = _normalize_column_split(data.get("columnSplit"))
    fonts = _normalize_links_fonts(data.get("fonts"))

    return {
        "version": 1,
        "profile": profile,
        "youtube": youtube,
        "schedule": schedule,
        "live": live,
        "columns": columns,
        "columnSplit": column_split,
        "fonts": fonts,
        "announcementCategories": announcement_categories,
        "announcements": announcements_out,
        "manualVideos": manual_videos_out,
        "links": links_out,
    }


def ensure_links():
    ensure_data_dir()
    if not LINKS_PATH.exists():
        if SEED_LINKS_PATH.exists():
            shutil.copy(SEED_LINKS_PATH, LINKS_PATH)
        else:
            LINKS_PATH.write_text(
                json.dumps(normalize_links({"links": [], "announcements": []}), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )


def load_links():
    ensure_links()
    with LINKS_PATH.open(encoding="utf-8") as f:
        return normalize_links(json.load(f))


def save_links(data):
    ensure_links()
    data = normalize_links(data)
    backup = LINKS_PATH.with_suffix(".json.bak")
    if LINKS_PATH.exists():
        shutil.copy(LINKS_PATH, backup)
    tmp = LINKS_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(LINKS_PATH)


def _patchnote_area_rank(area: str) -> int:
    try:
        return PATCHNOTE_AREA_ORDER.index(area)
    except ValueError:
        return len(PATCHNOTE_AREA_ORDER)


def _sort_patchnote_items(items: list) -> list:
    indexed = list(enumerate(items))
    indexed.sort(key=lambda pair: (_patchnote_area_rank(pair[1].get("area", "")), pair[0]))
    return [item for _, item in indexed]


def _normalize_patchnote_multiline(raw, max_len=1000):
    text = str(raw or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return ""
    if len(text) > max_len:
        text = text[:max_len]
    return text


def normalize_patchnotes(data):
    if not isinstance(data, dict):
        data = {}

    blocks_in = data.get("blocks") if isinstance(data.get("blocks"), list) else []
    blocks = []
    for raw in blocks_in:
        if not isinstance(raw, dict):
            continue
        block_id = str(raw.get("id") or "").strip() or secrets.token_urlsafe(8)
        date = str(raw.get("date") or "").strip()
        if not ISO_DATE_RE.match(date):
            date = _today_iso()
        label = str(raw.get("label") or "").strip()[:40]
        items_in = raw.get("items") if isinstance(raw.get("items"), list) else []
        items = []
        for item_raw in items_in:
            if not isinstance(item_raw, dict):
                continue
            area = str(item_raw.get("area") or "사이트").strip()
            if area not in PATCHNOTE_AREAS:
                area = "사이트"
            text = _normalize_patchnote_multiline(item_raw.get("text"))
            if not text:
                continue
            content = _normalize_patchnote_content(
                item_raw.get("content"),
                legacy_details=item_raw.get("details"),
                legacy_image_url=item_raw.get("imageUrl"),
                legacy_image_alt=item_raw.get("imageAlt"),
            )
            item_out = {
                "id": str(item_raw.get("id") or "").strip() or secrets.token_urlsafe(8),
                "area": area,
                "text": text[:1000],
            }
            if content:
                item_out["content"] = content
            items.append(item_out)
        items = _sort_patchnote_items(items)
        blocks.append({"id": block_id, "date": date, "label": label, "items": items})

    return {"blocks": blocks}


def public_patchnotes_payload(data):
    normalized = normalize_patchnotes(data)
    normalized["blocks"] = [block for block in normalized["blocks"] if block.get("items")]
    return normalized


def _paginate_patchnotes_blocks(blocks: list, page: int, per_page: int):
    total = len(blocks)
    if total == 0:
        return [], {"page": 1, "perPage": per_page, "totalBlocks": 0, "totalPages": 1}
    total_pages = max(1, (total + per_page - 1) // per_page)
    page = max(1, min(page, total_pages))
    start = (page - 1) * per_page
    return blocks[start : start + per_page], {
        "page": page,
        "perPage": per_page,
        "totalBlocks": total,
        "totalPages": total_pages,
    }


def ensure_patchnotes():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not PATCHNOTES_PATH.exists():
        if SEED_PATCHNOTES_PATH.exists():
            shutil.copy(SEED_PATCHNOTES_PATH, PATCHNOTES_PATH)
        else:
            PATCHNOTES_PATH.write_text(
                json.dumps(normalize_patchnotes({}), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )


def load_patchnotes():
    ensure_patchnotes()
    with PATCHNOTES_PATH.open(encoding="utf-8") as f:
        raw = json.load(f)
    data = normalize_patchnotes(raw)
    if isinstance(raw, dict) and "intro" in raw:
        save_patchnotes(data)
    return data


def save_patchnotes(data):
    ensure_patchnotes()
    data = normalize_patchnotes(data)
    backup = PATCHNOTES_PATH.with_suffix(".json.bak")
    if PATCHNOTES_PATH.exists():
        shutil.copy(PATCHNOTES_PATH, backup)
    tmp = PATCHNOTES_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(PATCHNOTES_PATH)


def month_key(year: int, month: int) -> str:
    return f"{year:04d}-{month:02d}"


def list_month_keys(data):
    return sorted(data.get("months", {}).keys())


def safe_next_path(raw: str) -> str:
    if not raw:
        return "/calendar"
    parsed = urlparse(raw)
    if parsed.netloc:
        return "/calendar"
    path = parsed.path or "/"
    if not path.startswith("/"):
        path = "/" + path
    if path in ("/", "/schedule", "/schedule/", "/index.html"):
        path = "/calendar"
    suffix = f"?{parsed.query}" if parsed.query else ""
    return f"{path}{suffix}"


def redirect_to_calendar():
    qs = request.query_string.decode()
    suffix = f"?{qs}" if qs else ""
    return redirect(f"/calendar{suffix}", code=302)


def attach_session_cookie_clear(response):
    """세션 쿠키 삭제 — path/domain 불일치·구 경로 잔여 쿠키까지 정리"""
    name = app.config["SESSION_COOKIE_NAME"]
    configured_path = app.config.get("SESSION_COOKIE_PATH") or "/"
    domain = app.config.get("SESSION_COOKIE_DOMAIN")

    paths = {configured_path, "/", "/calendar"}
    for legacy in ("/schedule", "/test", "/schedule/test"):
        paths.add(legacy)

    for path in paths:
        response.delete_cookie(name, path=path)
        if domain:
            response.delete_cookie(name, path=path, domain=domain)
    return response


def absolute_request_url(path=""):
    root = request.url_root
    if str(path).startswith(("http://", "https://")):
        return str(path)
    return urljoin(root, str(path).lstrip("/"))


def current_page_url():
    return request.url.split("?", 1)[0]


def inject_social_meta(html, *, title, description, page_url=None, image_url=None, site_name=SOCIAL_SITE_NAME):
    if 'property="og:image"' in html:
        return html
    page_url = page_url or current_page_url()
    image_url = image_url or _social_image_url()
    safe_title = escape(str(title or SOCIAL_SITE_NAME), quote=True)
    safe_desc = escape(str(description or SOCIAL_SITE_NAME), quote=True)
    safe_site = escape(str(site_name or SOCIAL_SITE_NAME), quote=True)
    safe_page = escape(page_url, quote=True)
    safe_image = escape(image_url, quote=True)
    secure_image = ""
    if str(image_url).startswith("https://"):
        secure_image = f'  <meta property="og:image:secure_url" content="{safe_image}" />\n'
    block = f"""  <meta name="description" content="{safe_desc}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="{safe_site}" />
  <meta property="og:title" content="{safe_title}" />
  <meta property="og:description" content="{safe_desc}" />
  <meta property="og:url" content="{safe_page}" />
  <meta property="og:image" content="{safe_image}" />
{secure_image}  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:type" content="image/png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{safe_title}" />
  <meta name="twitter:description" content="{safe_desc}" />
  <meta name="twitter:image" content="{safe_image}" />
"""
    return html.replace("</head>", block + "</head>", 1)


def send_html_with_social(filename, *, title, description):
    html = (BASE_DIR / filename).read_text(encoding="utf-8")
    html = inject_social_meta(html, title=title, description=description)
    html = ga4_analytics.inject_ga4_snippet(html)
    response = Response(html, mimetype="text/html; charset=utf-8")
    response.headers["Cache-Control"] = "private, max-age=60, stale-while-revalidate=300"
    return response


def send_html_page(filename: str) -> Response:
    html = (BASE_DIR / filename).read_text(encoding="utf-8")
    html = ga4_analytics.inject_ga4_snippet(html)
    response = Response(html, mimetype="text/html; charset=utf-8")
    response.headers["Cache-Control"] = "private, max-age=60, stale-while-revalidate=300"
    return response


def calendar_og_meta():
    data = load_schedule()
    name = str(data.get("streamerName") or SOCIAL_SITE_NAME).strip() or SOCIAL_SITE_NAME
    return "방송일정", f"{name} 방송 일정표"


def home_og_meta():
    data = load_links()
    profile = data.get("profile") if isinstance(data.get("profile"), dict) else {}
    title = str(profile.get("title") or "홈").strip() or "홈"
    title = re.sub(r"^[\s!·|｜\[\]()（）]+|[\s!·|｜\[\]()（）]+$", "", title).strip() or "시리안 레인"
    subtitle = str(profile.get("subtitle") or "").strip()
    desc = subtitle or f"{SOCIAL_SITE_NAME} 홈 · 바로가기"
    return title, desc


def musicbook_og_meta():
    return "노래책", f"{SOCIAL_SITE_NAME} 노래 신청 목록"


def patchnotes_og_meta():
    return "패치노트", f"{SOCIAL_SITE_NAME} 업데이트 내역"


def _data_file_status(path: Path, name: str) -> dict:
    out = {"name": name, "file": path.name, "exists": path.is_file()}
    if not path.is_file():
        return out
    stat = path.stat()
    out["sizeBytes"] = stat.st_size
    out["updatedAt"] = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
    return out


def server_status_payload() -> dict:
    ensure_data_dir()
    uptime_seconds = max(0, int(time.time() - APP_STARTED_AT))
    try:
        disk = shutil.disk_usage(DATA_DIR)
        disk_info = {
            "path": str(DATA_DIR),
            "totalBytes": disk.total,
            "usedBytes": disk.used,
            "freeBytes": disk.free,
            "usedPercent": round(disk.used / disk.total * 100, 1) if disk.total else 0,
        }
    except OSError:
        disk_info = {"path": str(DATA_DIR), "error": "disk_usage_unavailable"}

    schedule = load_schedule()
    musicbook = load_musicbook()
    links = load_links()
    patchnotes = load_patchnotes()
    songs = musicbook.get("songs") if isinstance(musicbook.get("songs"), list) else []
    blocks = patchnotes.get("blocks") if isinstance(patchnotes.get("blocks"), list) else []
    months = schedule.get("months") if isinstance(schedule.get("months"), dict) else {}
    links_items = links.get("links") if isinstance(links.get("links"), list) else []
    announcements = links.get("announcements") if isinstance(links.get("announcements"), list) else []
    system = system_metrics.collect_system_metrics()
    memory = system.get("memory") if isinstance(system.get("memory"), dict) else {}
    load_average = system.get("loadAverage") if isinstance(system.get("loadAverage"), list) else []
    load1 = load_average[0] if load_average else None

    server_metrics_store.record_snapshot(
        cpu_percent=system.get("cpuPercent"),
        memory_used_percent=memory.get("usedPercent"),
        temperature_c=system.get("temperatureC"),
        disk_used_percent=disk_info.get("usedPercent") if isinstance(disk_info, dict) else None,
        load1=load1,
    )

    return {
        "ok": True,
        "updatedAt": utc_now(),
        "uptimeSeconds": uptime_seconds,
        "system": system,
        "systemHistory": server_metrics_store.history_summary(),
        "app": {
            "mode": APP_MODE,
            "isBeta": is_beta_mode(),
            "googleEnabled": google_enabled(),
            "baseUrl": APP_BASE_URL,
            "python": sys.version.split()[0],
        },
        "disk": disk_info,
        "dataFiles": [
            _data_file_status(SCHEDULE_PATH, "schedule"),
            _data_file_status(MUSICBOOK_PATH, "musicbook"),
            _data_file_status(LINKS_PATH, "links"),
            _data_file_status(PATCHNOTES_PATH, "patchnotes"),
            _data_file_status(SONG_REQUESTS_PATH, "songRequests"),
            _data_file_status(CALENDAR_ICS_PATH, "calendarIcs"),
            _data_file_status(CONFIG_PATH, "config"),
            _data_file_status(MANAGERS_PATH, "managers"),
        ],
        "counts": {
            "scheduleMonths": len(months),
            "songsTotal": len(songs),
            "songsAvailable": sum(
                1 for s in songs if isinstance(s, dict) and s.get("status") == "available"
            ),
            "songsBanned": sum(1 for s in songs if isinstance(s, dict) and s.get("status") == "banned"),
            "patchnoteBlocks": len(blocks),
            "linksItems": len(links_items),
            "announcements": len(announcements),
        },
    }


# ─── Auth ───


@app.route("/api/public/ga4-config")
def api_public_ga4_config():
    mid = ga4_analytics.measurement_id()
    if not mid:
        return jsonify({"enabled": False})
    return jsonify({"enabled": True, "measurementId": mid})


@app.route("/api/analytics")
@require_developer
def api_analytics():
    try:
        days = int(request.args.get("days", 30))
    except (TypeError, ValueError):
        days = 30
    return jsonify(ga4_analytics.analytics_report(days))


@app.route("/api/server-status")
@require_developer
def api_server_status():
    try:
        return jsonify(server_status_payload())
    except Exception as exc:
        app.logger.exception("server status failed")
        return jsonify({"ok": False, "error": "server_status_failed", "hint": str(exc)}), 500


@app.route("/api/ops/metrics")
@require_developer
def api_ops_metrics():
    """운영 대시보드용 실시간 트래픽/지연/에러 지표."""
    try:
        window = request.args.get("window", type=int) or 600
        bucket = request.args.get("bucket", type=int) or 10
    except Exception:
        window = 600
        bucket = 10
    window = max(30, min(86400, int(window)))
    bucket = max(1, min(600, int(bucket)))
    page = str(request.args.get("page") or "").strip() or None
    if page and page not in OPS_PAGE_LABELS:
        page = None
    if page == "analytics":
        page = None
    audience = _ops_normalize_audience(request.args.get("audience") or "user")
    metrics = OPS_METRICS.snapshot(window_s=window, bucket_s=bucket, page=page, audience=audience)
    ga4_realtime = ga4_analytics.realtime_summary()
    return jsonify({"ok": True, "metrics": metrics, "ga4Realtime": ga4_realtime})


AUDIT_DETAIL_ID_RE = re.compile(r"^[\w-]+$")
AUDIT_LABEL_ACTION_MAP = {
    "옮기기": "move",
    "추가": "add",
    "삭제": "delete",
    "수정": "edit",
    "복사": "copy",
    "상태 변경": "status_change",
    "좋아요": "like",
    "좋아요 취소": "unlike",
}
BUNDLED_AUDIT_SUMMARY_RE = re.compile(r"(?=(?:옮기기|추가|삭제|수정|복사|상태 변경|좋아요|좋아요 취소) · )")
BUNDLED_AUDIT_EXTRA_RE = re.compile(r" · 외 \d+건$")
BUNDLED_AUDIT_LABEL_RE = re.compile(r"^(?:옮기기|추가|삭제|수정|복사|상태 변경|좋아요|좋아요 취소) · (.+)$")
BUNDLED_SCHEDULE_ACTIONS = frozenset({"put", "month_put", "meta_put"})


def _parse_audit_action_from_label(label: str) -> str:
    text = str(label or "").strip()
    for prefix, action in AUDIT_LABEL_ACTION_MAP.items():
        if text.startswith(prefix + " ·") or text == prefix:
            return action
    return ""


def _audit_summary_detail_only(label: str) -> str:
    text = str(label or "").strip()
    match = BUNDLED_AUDIT_LABEL_RE.match(text)
    return match.group(1).strip() if match else text


def _split_bundled_audit_summary(summary: str) -> list[str]:
    text = str(summary or "").strip()
    if not text:
        return []
    text = BUNDLED_AUDIT_EXTRA_RE.sub("", text).strip()
    if " · " not in text:
        return [text]
    segments = []
    for part in BUNDLED_AUDIT_SUMMARY_RE.split(text):
        part = part.strip().rstrip("·").strip()
        if part:
            segments.append(part)
    return segments if len(segments) > 1 else [text]


def _iter_audit_log_paths() -> list[Path]:
    paths: list[Path] = []
    for i in range(max(1, AUDIT_LOG_BACKUPS), 0, -1):
        p = AUDIT_LOG_PATH.with_suffix(f".jsonl.{i}")
        if p.exists():
            paths.append(p)
    if AUDIT_LOG_PATH.exists():
        paths.append(AUDIT_LOG_PATH)
    return paths


def _iter_audit_log_rows():
    for path in _iter_audit_log_paths():
        try:
            with path.open(encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield json.loads(line)
                    except json.JSONDecodeError:
                        continue
        except OSError:
            continue


def _audit_row_actor(row: dict) -> dict | None:
    a = row.get("actor") if isinstance(row.get("actor"), dict) else {}
    email = str(a.get("email") or "").strip().lower()
    name = str(a.get("name") or "").strip()
    if not email:
        return None
    return {"email": email, "name": name}


def _load_audit_detail_operations(detail_id: str, cache: dict) -> list[dict]:
    detail_id = str(detail_id or "").strip()
    if not detail_id or not AUDIT_DETAIL_ID_RE.match(detail_id):
        return []
    if detail_id in cache:
        return cache[detail_id]
    path = DATA_DIR / "audit-details" / f"{detail_id}.json"
    ops: list[dict] = []
    if path.exists():
        try:
            detail = json.loads(path.read_text(encoding="utf-8"))
            raw = detail.get("operations") or []
            if isinstance(raw, list):
                ops = [op for op in raw if isinstance(op, dict)]
        except (OSError, json.JSONDecodeError):
            ops = []
    cache[detail_id] = ops
    return ops


def _audit_log_sort_key(row: dict) -> tuple:
    meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
    batch_index = int(meta.get("batchIndex") or 0)
    return (str(row.get("ts") or ""), -batch_index if batch_index else 0)


def _expand_audit_log_row(row: dict, *, detail_cache: dict) -> list[dict]:
    meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
    base_action = str(row.get("action") or "put")
    op_meta = meta.get("operation") if isinstance(meta.get("operation"), dict) else {}
    if op_meta.get("action") and base_action in AUDIT_LABEL_ACTION_MAP.values():
        return [row]

    labels: list[str] = []
    op_records: list[dict] = []

    operation_labels = meta.get("operationLabels")
    if isinstance(operation_labels, list) and operation_labels:
        labels = [str(label).strip() for label in operation_labels if str(label).strip()]

    if not labels and base_action in BUNDLED_SCHEDULE_ACTIONS:
        labels = _split_bundled_audit_summary(str(row.get("summary") or ""))

    detail_id = str(meta.get("detailId") or "").strip()
    if not labels and detail_id and base_action in BUNDLED_SCHEDULE_ACTIONS:
        op_records = _load_audit_detail_operations(detail_id, detail_cache)
        if op_records:
            labels = [str(op.get("summary") or "").strip() for op in op_records if str(op.get("summary") or "").strip()]

    if len(labels) <= 1:
        if len(labels) == 1 and base_action in BUNDLED_SCHEDULE_ACTIONS:
            label = labels[0]
            op_action = _parse_audit_action_from_label(label)
            if op_records:
                op_action = str(op_records[0].get("action") or op_action)
            if op_action:
                child_meta = dict(meta)
                child_meta.pop("operationLabels", None)
                if op_records:
                    child_meta["operation"] = {
                        "action": op_action,
                        "target": op_records[0].get("target"),
                    }
                return [
                    {
                        **row,
                        "action": op_action,
                        "summary": _audit_summary_detail_only(label),
                        "meta": child_meta,
                    }
                ]
        return [row]

    out: list[dict] = []
    batch_size = len(labels)
    for index, label in enumerate(labels):
        op_action = _parse_audit_action_from_label(label)
        if not op_action and index < len(op_records):
            op_action = str(op_records[index].get("action") or "")
        if not op_action:
            op_action = base_action
        child_meta = dict(meta)
        child_meta.pop("operationLabels", None)
        child_meta["expandedFromBatch"] = True
        child_meta["batchIndex"] = index + 1
        child_meta["batchSize"] = batch_size
        if index < len(op_records):
            child_meta["operation"] = {
                "action": op_action,
                "target": op_records[index].get("target"),
            }
        else:
            child_meta["operation"] = {"action": op_action}
        out.append(
            {
                **row,
                "action": op_action,
                "summary": _audit_summary_detail_only(label),
                "meta": child_meta,
            }
        )
    return out


def _expand_audit_log_items(items: list[dict]) -> list[dict]:
    detail_cache: dict[str, list[dict]] = {}
    expanded: list[dict] = []
    for row in items:
        expanded.extend(_expand_audit_log_row(row, detail_cache=detail_cache))
    expanded.sort(key=_audit_log_sort_key, reverse=True)
    return expanded


@app.route("/api/ops/audit-log")
@require_developer
def api_ops_audit_log():
    """운영 대시보드용 수정 로그 조회 (JSONL)."""
    limit = request.args.get("limit", default=20, type=int) or 20
    limit = max(1, min(100, int(limit)))
    page = request.args.get("page", default=1, type=int) or 1
    page = max(1, int(page))
    resource = str(request.args.get("resource") or "").strip()
    actor = str(request.args.get("actor") or "").strip().lower()
    q = str(request.args.get("q") or "").strip().lower()

    items = []
    actors_map = {}
    try:
        for row in _iter_audit_log_rows():
            if resource and str(row.get("resource") or "") != resource:
                continue
            if q:
                blob = (
                    str(row.get("summary") or "")
                    + " "
                    + str(row.get("action") or "")
                    + " "
                    + _safe_json(row.get("meta") or {})
                ).lower()
                if q not in blob:
                    continue
            actor_info = _audit_row_actor(row)
            if actor_info:
                email = actor_info["email"]
                prev = actors_map.get(email)
                if not prev or (actor_info.get("name") and not prev.get("name")):
                    actors_map[email] = actor_info
            if actor:
                email = actor_info["email"] if actor_info else ""
                name = str((row.get("actor") or {}).get("name") or "").strip()
                if email != actor and actor not in email and actor not in name.lower():
                    continue
            items.append(row)
        items = _expand_audit_log_items(items)
    except Exception:
        items = []
        actors_map = {}

    total = len(items)
    total_pages = max(1, (total + limit - 1) // limit) if total else 1
    if page > total_pages:
        page = total_pages
    start = (page - 1) * limit
    page_items = items[start : start + limit]
    actors = sorted(
        actors_map.values(),
        key=lambda a: (str(a.get("name") or "").lower(), str(a.get("email") or "")),
    )

    return jsonify(
        {
            "ok": True,
            "items": page_items,
            "total": total,
            "page": page,
            "pageSize": limit,
            "totalPages": total_pages,
            "actors": actors,
            "updatedAt": utc_now(),
        }
    )


@app.route("/api/ops/audit-log/detail/<detail_id>")
@require_developer
def api_ops_audit_detail(detail_id):
    if not AUDIT_DETAIL_ID_RE.match(str(detail_id or "")):
        return jsonify({"error": "invalid_id"}), 400
    path = DATA_DIR / "audit-details" / f"{detail_id}.json"
    if not path.exists():
        return jsonify({"error": "not_found"}), 404
    try:
        detail = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return jsonify({"error": "read_failed"}), 500
    operations = detail.get("operations") if isinstance(detail.get("operations"), list) else []
    resource = str(detail.get("resource") or "").strip().lower()
    if resource == "musicbook":
        formatted_operations = [
            musicbook_audit.format_musicbook_operation_detail(op) for op in operations if isinstance(op, dict)
        ]
    else:
        formatted_operations = [schedule_audit.format_operation_detail(op) for op in operations if isinstance(op, dict)]
    payload = {
        "ok": True,
        "detailId": detail_id,
        "detail": detail,
        "formattedOperations": formatted_operations,
    }
    index = request.args.get("index", type=int)
    if index is not None and index >= 1:
        op_index = index - 1
        if op_index < len(operations):
            payload["operationIndex"] = index
            payload["operation"] = operations[op_index]
            if op_index < len(formatted_operations):
                payload["formatted"] = formatted_operations[op_index]
    return jsonify(payload)


@app.route("/analytics")
def analytics_page():
    # 권한이 부족해도 안내 화면을 보여주기 위해 HTML은 제공한다.
    # 실제 데이터 API는 @require_developer로 보호되며, 프론트에서 "권한 필요" 게이트를 노출한다.
    if not current_user() and not is_dev_streamer():
        return redirect("/home")
    return send_from_directory(BASE_DIR, "analytics.html")


@app.route("/api/auth/config")
def api_auth_config():
    return jsonify(
        {
            "googleEnabled": google_enabled(),
            "authMode": auth_mode(),
            "sessionDays": SESSION_DAYS,
            "devMode": auth_mode() == "toggle",
            "isBeta": is_beta_mode(),
            "googleLoginRequired": is_beta_mode(),
        }
    )


@app.route("/api/auth/me")
def api_auth_me():
    email = current_user_email()
    if email and user_role(email) in ("streamer", "developer"):
        migrate_session_staff_disabled_permissions(email)
    return jsonify(auth_payload())


def _is_load_test_email(email: str) -> bool:
    return bool(LOAD_TEST_EMAIL_RE.match(normalize_manager_email(email)))


@app.route("/api/auth/load-test-login", methods=["POST"])
def api_auth_load_test_login():
    """부하 테스트 전용 로그인 — LOAD_TEST_SECRET 설정 시에만 활성화."""
    if not os.environ.get("LOAD_TEST_SECRET", "").strip():
        return jsonify({"error": "disabled", "hint": "LOAD_TEST_SECRET이 설정되지 않았습니다."}), 404
    if not _load_test_secret_ok():
        return jsonify({"error": "forbidden", "hint": "유효하지 않은 부하 테스트 시크릿입니다."}), 403
    payload = request.get_json(silent=True) or {}
    try:
        user_id = int(payload.get("userId"))
    except (TypeError, ValueError):
        return jsonify({"error": "invalid_user_id", "hint": "userId(정수)가 필요합니다."}), 400
    if user_id < 0 or user_id > 9999:
        return jsonify({"error": "invalid_user_id", "hint": "userId는 0~9999 범위여야 합니다."}), 400
    name = str(payload.get("name") or f"LoadTest {user_id}").strip()[:80] or f"LoadTest {user_id}"
    email = normalize_manager_email(f"loadtest+{user_id}@loadtest.local")
    session.permanent = True
    session["user"] = {"email": email, "name": name, "picture": ""}
    session.pop("dev_streamer", None)
    return jsonify(auth_payload())


@app.route("/api/song-requests/load-test-cleanup", methods=["POST"])
def api_song_requests_load_test_cleanup():
    """부하 테스트 계정(loadtest+*@loadtest.local) 데이터 정리."""
    if not os.environ.get("LOAD_TEST_SECRET", "").strip():
        return jsonify({"error": "disabled"}), 404
    if not _load_test_secret_ok():
        return jsonify({"error": "forbidden"}), 403

    data = load_song_requests()
    requests_before = len(data.get("requests", []))
    notifications_before = len(data.get("notifications", []))
    blacklist_before = len(data.get("blacklist", []))

    requests = [
        r
        for r in data.get("requests", [])
        if not _is_load_test_email((r.get("requestedBy") or {}).get("email", ""))
    ]
    notifications = [
        n
        for n in data.get("notifications", [])
        if not _is_load_test_email(n.get("email", ""))
    ]
    blacklist = [
        e for e in data.get("blacklist", []) if not _is_load_test_email(e.get("email", ""))
    ]
    save_song_requests({**data, "requests": requests, "notifications": notifications, "blacklist": blacklist})
    return jsonify(
        {
            "ok": True,
            "removed": {
                "requests": requests_before - len(requests),
                "notifications": notifications_before - len(notifications),
                "blacklist": blacklist_before - len(blacklist),
            },
            "updatedAt": utc_now(),
        }
    )


@app.route("/api/auth/developer-permissions", methods=["GET", "PUT"])
@require_logged_in
def api_developer_permissions():
    email = current_user_email()
    role = user_role(email)
    if role not in ("streamer", "developer"):
        return jsonify({"error": "forbidden", "hint": "스트리머·개발자만 사용할 수 있습니다."}), 403

    if request.method == "GET":
        return jsonify(
            {
                "permissionSimulation": staff_permission_overlay_payload(email),
                "permissions": current_user_permissions_list(),
            }
        )

    payload = request.get_json(silent=True) or {}
    disabled = normalize_staff_disabled_permissions(payload.get("disabled"))
    save_staff_disabled_permissions(email, disabled)
    session.pop("developerDisabledPermissions", None)
    session.modified = True
    return jsonify({"ok": True, **auth_payload()})


@app.route("/api/auth/login")
def api_auth_login():
    if not google_enabled():
        return jsonify({"error": "google_not_configured"}), 503
    next_path = safe_next_path(request.args.get("next", "/calendar"))
    session["oauth_next"] = next_path
    state = secrets.token_urlsafe(24)
    session["oauth_state"] = state
    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": oauth_redirect_uri(),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "access_type": "online",
        "prompt": "select_account",
    }
    return redirect(GOOGLE_AUTH_URL + "?" + urllib.parse.urlencode(params))


@app.route("/api/auth/google/callback")
def api_auth_google_callback():
    if not google_enabled():
        return redirect("/calendar?auth=disabled")

    err = request.args.get("error")
    if err:
        return redirect("/calendar?auth=error")

    state = request.args.get("state", "")
    if not state or state != session.get("oauth_state"):
        return redirect("/calendar?auth=state")

    code = request.args.get("code")
    if not code:
        return redirect("/calendar?auth=missing_code")

    try:
        token_data = http_post_form(
            GOOGLE_TOKEN_URL,
            {
                "code": code,
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri": oauth_redirect_uri(),
                "grant_type": "authorization_code",
            },
        )
        access_token = token_data.get("access_token")
        if not access_token:
            return redirect("/calendar?auth=token")
        info = http_get_json(GOOGLE_USERINFO_URL, access_token)
    except (urllib.error.URLError, json.JSONDecodeError, KeyError):
        return redirect("/calendar?auth=failed")

    session.pop("oauth_state", None)
    session.permanent = True
    email = normalize_manager_email(info.get("email"))
    session["user"] = {
        "email": info.get("email"),
        "name": info.get("name"),
        "picture": info.get("picture"),
    }
    record = get_manager_record(email)
    if record and info.get("name") and not str(record.get("name") or "").strip():
        record["name"] = str(info.get("name")).strip()
        data = load_managers_data()
        for i, entry in enumerate(data.get("managers", [])):
            if isinstance(entry, dict) and normalize_manager_email(entry.get("email")) == email:
                data["managers"][i] = record
                break
        save_managers_data(data)
    if info.get("name") and user_role(email) in ("developer", "streamer"):
        if not load_display_names().get(email):
            save_display_name(email, str(info.get("name")).strip())
    next_path = safe_next_path(session.pop("oauth_next", "/calendar"))
    display = str(info.get("name") or "").strip() or email
    audit_auth("login", summary=f"로그인 · {display}", meta={"email": email, "next": next_path})
    return redirect(next_path)


@app.route("/api/auth/logout", methods=["POST", "GET"])
def api_auth_logout():
    user = current_user() or {}
    email = normalize_manager_email(user.get("email")) if user.get("email") else ""
    name = str(user.get("name") or "").strip()
    if email or name or is_dev_streamer():
        display = name or email or "스트리머(로컬)"
        audit_auth("logout", summary=f"로그아웃 · {display}", meta={"email": email} if email else {})
    session.pop("dev_streamer", None)
    session.pop("user", None)
    session.clear()
    next_path = safe_next_path(request.args.get("next", "/calendar"))
    if request.method == "GET":
        resp = make_response(redirect(next_path))
    else:
        resp = make_response(jsonify({"ok": True, "next": next_path}))
    return attach_session_cookie_clear(resp)


@app.route("/api/auth/streamer-mode", methods=["POST"])
def api_auth_streamer_mode():
    if is_beta_mode():
        return jsonify({"error": "use_google_login", "hint": "베타에서는 Google 로그인을 사용하세요."}), 400
    if google_enabled():
        return jsonify({"error": "use_google_login", "hint": "Google 로그인을 사용하세요."}), 400
    payload = request.get_json(silent=True) or {}
    enabled = bool(payload.get("enabled"))
    if enabled:
        session.permanent = True
        session["dev_streamer"] = True
    else:
        session.pop("dev_streamer", None)
    return jsonify(auth_payload())


# ─── Managers API ───


def _manager_public_entry(entry: dict) -> dict:
    email = normalize_manager_email(entry.get("email"))
    return {
        "email": email,
        "name": str(entry.get("name") or "").strip(),
        "permissions": normalize_manager_permissions(entry.get("permissions")),
        "addedAt": entry.get("addedAt") or "",
        "addedBy": normalize_manager_email(entry.get("addedBy")),
    }


def _roster_member(email: str, role: str, viewer_email: str) -> dict:
    normalized = normalize_manager_email(email)
    viewer_role = user_role(viewer_email)
    names = load_display_names()
    name = str(names.get(normalized) or "").strip()

    if role == "manager":
        record = get_manager_record(normalized)
        if record and record.get("name"):
            name = str(record.get("name") or "").strip() or name
        permissions = normalize_manager_permissions(record.get("permissions") if record else [])
    else:
        disabled = get_staff_disabled_permissions(normalized)
        permissions = sorted(set(MANAGER_PERMISSIONS) - disabled) if disabled else sorted(MANAGER_PERMISSIONS)

    permissions_locked = role in ("developer", "streamer")
    role_locked = _staff_role_locked(normalized, role)
    can_edit = False
    can_remove = False

    if role == "manager":
        can_edit = user_can_manage_managers(viewer_email)
        can_remove = can_edit and normalized != normalize_manager_email(viewer_email)
    elif role == "streamer":
        can_edit = user_can_manage_managers(viewer_email)
        can_remove = (
            viewer_role == "developer"
            and normalized != normalize_manager_email(viewer_email)
            and not role_locked
        )
    elif role == "developer":
        can_edit = user_can_manage_managers(viewer_email)
        can_remove = (
            viewer_role == "developer"
            and normalized != normalize_manager_email(viewer_email)
            and not role_locked
        )

    locked_hint = ""
    if role_locked:
        locked_hint = "개발자 고정" if role == "developer" else "스트리머 고정"

    return {
        "email": normalized,
        "role": role,
        "name": name,
        "permissions": permissions,
        "permissionsLocked": permissions_locked,
        "roleLocked": role_locked,
        "lockedHint": locked_hint,
        "canEdit": can_edit,
        "canRemove": can_remove,
    }


def _roster_members(viewer_email: str) -> list:
    members = []
    developers = sorted(load_developer_emails())
    streamers = sorted(e for e in load_streamer_emails() if e not in developers)

    for email in streamers:
        members.append(_roster_member(email, "streamer", viewer_email))
    for email in developers:
        members.append(_roster_member(email, "developer", viewer_email))
    for entry in load_managers_data().get("managers", []):
        if not isinstance(entry, dict):
            continue
        email = normalize_manager_email(entry.get("email"))
        if not email or user_role(email) != "manager":
            continue
        members.append(_roster_member(email, "manager", viewer_email))
    return members


def _managers_list_public():
    return [_manager_public_entry(e) for e in load_managers_data().get("managers", []) if isinstance(e, dict)]


@app.route("/api/managers")
@require_manage_managers
def api_managers_list():
    viewer = current_user_email()
    members = _roster_members(viewer)
    viewer_role = user_role(viewer) if viewer else "guest"
    return jsonify(
        {
            "members": members,
            "managers": [m for m in members if m["role"] == "manager"],
            "permissionCatalog": PERMISSION_CATALOG,
            "viewerRole": viewer_role,
            "canManageStreamers": viewer_role == "developer",
            "updatedAt": utc_now(),
        }
    )


@app.route("/api/managers", methods=["POST"])
@require_manage_managers
def api_managers_add():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400

    email = normalize_manager_email(payload.get("email"))
    if not email or not EMAIL_RE.match(email):
        return jsonify({"error": "invalid_email", "hint": "올바른 Gmail 주소를 입력하세요."}), 400
    if email in load_streamer_emails() or email in load_developer_emails():
        return jsonify({"error": "is_streamer", "hint": "스트리머·개발자 계정은 매니저로 추가할 수 없습니다."}), 400
    if get_manager_record(email):
        return jsonify({"error": "already_exists", "hint": "이미 등록된 매니저입니다."}), 409

    permissions = normalize_manager_permissions(payload.get("permissions"))
    if not permissions:
        return jsonify({"error": "no_permissions", "hint": "최소 한 가지 권한을 선택하세요."}), 400

    entry = {
        "email": email,
        "name": str(payload.get("name") or "").strip()[:40],
        "permissions": permissions,
        "addedAt": utc_now(),
        "addedBy": current_user_email(),
    }
    data = load_managers_data()
    data.setdefault("managers", []).append(entry)
    save_managers_data(data)
    return jsonify({"ok": True, "manager": _manager_public_entry(entry), "updatedAt": utc_now()}), 201


@app.route("/api/managers/<path:email>", methods=["PUT"])
@require_manage_managers
def api_managers_update(email):
    normalized = normalize_manager_email(email)
    if not normalized:
        return jsonify({"error": "invalid_email"}), 400

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400

    data = load_managers_data()
    managers = data.setdefault("managers", [])
    idx = next(
        (i for i, e in enumerate(managers) if isinstance(e, dict) and normalize_manager_email(e.get("email")) == normalized),
        None,
    )
    if idx is None:
        return jsonify({"error": "not_found"}), 404
    if user_role(normalized) != "manager":
        return jsonify({"error": "forbidden", "hint": "매니저만 권한을 수정할 수 있습니다."}), 403

    if "permissions" in payload:
        permissions = normalize_manager_permissions(payload.get("permissions"))
        if not permissions:
            return jsonify({"error": "no_permissions", "hint": "최소 한 가지 권한을 선택하세요."}), 400
        managers[idx]["permissions"] = permissions
    if "name" in payload:
        managers[idx]["name"] = str(payload.get("name") or "").strip()[:40]

    save_managers_data(data)
    return jsonify({"ok": True, "manager": _manager_public_entry(managers[idx]), "updatedAt": utc_now()})


@app.route("/api/managers/<path:email>", methods=["DELETE"])
@require_manage_managers
def api_managers_remove(email):
    normalized = normalize_manager_email(email)
    if not normalized:
        return jsonify({"error": "invalid_email"}), 400
    if normalized == current_user_email():
        return jsonify({"error": "cannot_remove_self", "hint": "본인 계정은 여기서 삭제할 수 없습니다."}), 400
    if user_role(normalized) != "manager":
        return jsonify({"error": "forbidden", "hint": "매니저만 삭제할 수 있습니다."}), 403

    data = load_managers_data()
    managers = data.get("managers", [])
    next_managers = [e for e in managers if not (isinstance(e, dict) and normalize_manager_email(e.get("email")) == normalized)]
    if len(next_managers) == len(managers):
        return jsonify({"error": "not_found"}), 404

    data["managers"] = next_managers
    save_managers_data(data)
    return jsonify({"ok": True, "removed": normalized, "updatedAt": utc_now()})


@app.route("/api/staff/display-names/<path:email>", methods=["PUT"])
@require_manage_managers
def api_staff_update_display_name(email):
    normalized = normalize_manager_email(email)
    if not normalized:
        return jsonify({"error": "invalid_email"}), 400

    role = user_role(normalized)
    if role not in ("developer", "streamer"):
        return jsonify({"error": "not_staff", "hint": "개발자·스트리머만 표시 이름을 변경할 수 있습니다."}), 400

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400

    name = str(payload.get("name") or "").strip()[:40]
    if name:
        save_display_name(normalized, name)
    else:
        remove_display_name(normalized)

    return jsonify({"ok": True, "email": normalized, "name": name, "updatedAt": utc_now()})


@app.route("/api/staff/streamers/<path:email>", methods=["DELETE"])
@require_developer
def api_staff_remove_streamer(email):
    normalized = normalize_manager_email(email)
    if not normalized:
        return jsonify({"error": "invalid_email"}), 400
    if user_role(normalized) != "streamer":
        return jsonify({"error": "not_streamer", "hint": "스트리머 계정이 아닙니다."}), 400
    if normalized == current_user_email():
        return jsonify({"error": "cannot_remove_self", "hint": "본인 스트리머 권한은 해제할 수 없습니다."}), 400

    ok, reason = remove_streamer_from_config(normalized)
    if not ok:
        if reason == "streamer_locked":
            return jsonify(
                {
                    "error": "streamer_locked",
                    "hint": "스트리머로 등록된 계정은 해제할 수 없습니다.",
                }
            ), 400
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True, "removed": normalized, "updatedAt": utc_now()})


@app.route("/api/staff/developers/<path:email>", methods=["DELETE"])
@require_developer
def api_staff_remove_developer(email):
    normalized = normalize_manager_email(email)
    if not normalized:
        return jsonify({"error": "invalid_email"}), 400
    if user_role(normalized) != "developer":
        return jsonify({"error": "not_developer", "hint": "개발자 계정이 아닙니다."}), 400
    if normalized == current_user_email():
        return jsonify({"error": "cannot_remove_self", "hint": "본인 개발자 권한은 해제할 수 없습니다."}), 400

    ok, reason = remove_developer_from_config(normalized)
    if not ok:
        if reason == "developer_locked":
            return jsonify(
                {
                    "error": "developer_locked",
                    "hint": "개발자로 등록된 계정은 해제할 수 없습니다.",
                }
            ), 400
        return jsonify({"error": "not_found"}), 404
    return jsonify({"ok": True, "removed": normalized, "updatedAt": utc_now()})


# ─── Schedule API ───


@app.route("/api/health")
def api_health():
    return jsonify(
        {
            "ok": True,
            "updatedAt": utc_now(),
            "googleEnabled": google_enabled(),
            "mode": APP_MODE,
        }
    )


@app.route("/api/content-revisions")
def api_content_revisions():
    return jsonify({"revisions": content_revisions(), "updatedAt": utc_now()})


@app.route("/api/schedule")
def api_schedule():
    data = load_schedule()
    year = request.args.get("year", type=int)
    month = request.args.get("month", type=int)

    if year and month:
        key = month_key(year, month)
        month_data = data.get("months", {}).get(key)
        base = {
            "streamerName": data.get("streamerName", ""),
            "brandColor": data.get("brandColor", ""),
            "debutDate": data.get("debutDate", ""),
            "platformNote": data.get("platformNote", ""),
            "categories": data.get("categories", {}),
            "calendarLayout": data.get("calendarLayout", "proportional"),
            "slotChipStyle": data.get("slotChipStyle", "sidebar"),
            "chipColorMode": normalize_chip_color_mode(data.get("chipColorMode")),
            "proportionalMinSlots": data.get("proportionalMinSlots", 4),
            "hourlyMinSlots": data.get("hourlyMinSlots", 4),
            "calendarFont": data.get("calendarFont", "gmarketSans"),
            "sidebarFont": data.get("sidebarFont", "nanumGothic"),
            "calendarFontBold": data.get("calendarFontBold", False),
            "sidebarFontBold": data.get("sidebarFontBold", True),
            "monthKey": key,
            "availableMonths": list_month_keys(data),
        }
        if not month_data:
            return jsonify({**base, "title": f"{month}월", "highlights": [], "days": {}})
        return jsonify(
            {
                **base,
                "title": month_data.get("title", f"{month}월"),
                "highlights": month_data.get("highlights", []),
                "days": month_data.get("days", {}),
                "apiScope": "public",
            }
        )

    if not request_can_edit():
        return (
            jsonify(
                {
                    "error": "forbidden",
                    "hint": "전체 일정 데이터는 편집 권한이 필요합니다. 월별 조회는 ?year=&month= 를 사용하세요.",
                    "availableMonths": list_month_keys(data),
                    **get_schedule_meta_public(),
                    "apiScope": "public",
                }
            ),
            403,
        )

    return jsonify(data)


def _schedules_equal(left: dict | None, right: dict | None) -> bool:
    return schedule_audit._stable_json(normalize_schedule(left or {})) == schedule_audit._stable_json(
        normalize_schedule(right or {})
    )


@app.route("/api/schedule", methods=["PUT"])
@require_permission("calendar")
def api_schedule_put():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400
    current_revision = _file_revision_token(SCHEDULE_PATH)
    base_revision = request.headers.get("X-Schedule-Revision")
    if base_revision not in (None, "") and str(base_revision) != str(current_revision):
        return (
            jsonify(
                {
                    "error": "conflict",
                    "hint": "다른 곳에서 일정이 변경되었습니다. 수정 모드를 꺼었다 켠 뒤 다시 시도하세요.",
                    "revision": current_revision,
                }
            ),
            409,
        )
    old = load_schedule()
    new = normalize_schedule(payload)
    if _schedules_equal(old, new):
        return jsonify(
            {
                "ok": True,
                "unchanged": True,
                "updatedAt": utc_now(),
                "revision": current_revision,
            }
        )
    try:
        save_schedule(new)
    except (TypeError, ValueError, OSError) as exc:
        return jsonify({"error": "save_failed", "hint": str(exc)}), 500
    try:
        detail = schedule_audit.build_schedule_audit_detail(old, new)
        _write_schedule_audit("put", detail)
    except Exception:
        pass
    return jsonify(
        {
            "ok": True,
            "updatedAt": utc_now(),
            "revision": _file_revision_token(SCHEDULE_PATH),
        }
    )


@app.route("/api/schedule/month/<month_id>", methods=["PUT"])
@require_permission("calendar")
def api_month_put(month_id):
    if not _valid_month_id(month_id):
        return jsonify({"error": "invalid_month", "monthId": month_id}), 400
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400

    data = load_schedule()
    before = data.get("months", {}).get(month_id) if isinstance(data.get("months"), dict) else None
    new_month_raw = {
        "title": payload.get("title", month_id),
        "highlights": payload.get("highlights", []),
        "days": payload.get("days", {}),
    }
    after_month = normalize_schedule({"months": {month_id: new_month_raw}})["months"][month_id]
    before_month = None
    if isinstance(before, dict):
        before_month = normalize_schedule({"months": {month_id: before}})["months"].get(month_id)
    if _schedules_equal({"months": {month_id: before_month}}, {"months": {month_id: after_month}}):
        return jsonify({"ok": True, "unchanged": True, "monthId": month_id, "updatedAt": utc_now()})
    data.setdefault("months", {})[month_id] = {
        "title": after_month.get("title", month_id),
        "highlights": after_month.get("highlights", []),
        "days": after_month.get("days", {}),
    }
    save_schedule(data)
    try:
        detail = schedule_audit.build_month_audit_detail(month_id, before_month, after_month)
        _write_schedule_audit("month_put", detail, month_id=month_id)
    except Exception:
        pass
    return jsonify({"ok": True, "monthId": month_id, "updatedAt": utc_now()})


_FONT_ID_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]{0,31}$")


def _normalize_font_id(value, default: str) -> str:
    fid = str(value or "").strip()
    return fid if _FONT_ID_RE.match(fid) else default


def _normalize_bool(value, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return default


DEFAULT_PAGE_FONTS = {
    "titleFont": "gmarketSans",
    "titleFontBold": False,
    "bodyFont": "nanumGothic",
    "bodyFontBold": True,
}

DEFAULT_LINKS_PAGE_FONTS = {
    "boxTitleFont": "nanumGothic",
    "boxTitleFontBold": True,
    "headingFont": "gmarketSans",
    "headingFontBold": False,
    "bodyFont": "nanumGothic",
    "bodyFontBold": False,
}

DEFAULT_MUSICBOOK_PAGE_FONTS = {
    "titleFont": "gmarketSans",
    "titleFontBold": False,
    "noteFont": "nanumGothic",
    "noteFontBold": False,
    "capsuleFont": "nanumGothic",
    "capsuleFontBold": True,
}


def _normalize_page_fonts(raw):
    src = raw if isinstance(raw, dict) else {}
    return {
        "titleFont": _normalize_font_id(src.get("titleFont"), DEFAULT_PAGE_FONTS["titleFont"]),
        "titleFontBold": _normalize_bool(src.get("titleFontBold"), DEFAULT_PAGE_FONTS["titleFontBold"]),
        "bodyFont": _normalize_font_id(src.get("bodyFont"), DEFAULT_PAGE_FONTS["bodyFont"]),
        "bodyFontBold": _normalize_bool(src.get("bodyFontBold"), DEFAULT_PAGE_FONTS["bodyFontBold"]),
    }


def _normalize_links_fonts(raw):
    src = raw if isinstance(raw, dict) else {}
    if src.get("boxTitleFont") is None and src.get("headingFont") is None:
        if src.get("titleFont") is not None or src.get("bodyFont") is not None:
            title_font = _normalize_font_id(src.get("titleFont"), DEFAULT_LINKS_PAGE_FONTS["boxTitleFont"])
            body_font = _normalize_font_id(src.get("bodyFont"), DEFAULT_LINKS_PAGE_FONTS["bodyFont"])
            return {
                "boxTitleFont": title_font,
                "boxTitleFontBold": _normalize_bool(
                    src.get("titleFontBold"), DEFAULT_LINKS_PAGE_FONTS["boxTitleFontBold"]
                ),
                "headingFont": body_font,
                "headingFontBold": _normalize_bool(
                    src.get("bodyFontBold"), DEFAULT_LINKS_PAGE_FONTS["headingFontBold"]
                ),
                "bodyFont": body_font,
                "bodyFontBold": False,
            }
    return {
        "boxTitleFont": _normalize_font_id(src.get("boxTitleFont"), DEFAULT_LINKS_PAGE_FONTS["boxTitleFont"]),
        "boxTitleFontBold": _normalize_bool(
            src.get("boxTitleFontBold"), DEFAULT_LINKS_PAGE_FONTS["boxTitleFontBold"]
        ),
        "headingFont": _normalize_font_id(src.get("headingFont"), DEFAULT_LINKS_PAGE_FONTS["headingFont"]),
        "headingFontBold": _normalize_bool(
            src.get("headingFontBold"), DEFAULT_LINKS_PAGE_FONTS["headingFontBold"]
        ),
        "bodyFont": _normalize_font_id(src.get("bodyFont"), DEFAULT_LINKS_PAGE_FONTS["bodyFont"]),
        "bodyFontBold": _normalize_bool(src.get("bodyFontBold"), DEFAULT_LINKS_PAGE_FONTS["bodyFontBold"]),
    }


def _normalize_musicbook_fonts(raw):
    src = raw if isinstance(raw, dict) else {}
    if src.get("noteFont") is None and src.get("capsuleFont") is None:
        if src.get("titleFont") is not None or src.get("bodyFont") is not None:
            title_font = _normalize_font_id(src.get("titleFont"), DEFAULT_MUSICBOOK_PAGE_FONTS["titleFont"])
            body_font = _normalize_font_id(src.get("bodyFont"), DEFAULT_MUSICBOOK_PAGE_FONTS["noteFont"])
            return {
                "titleFont": title_font,
                "titleFontBold": _normalize_bool(
                    src.get("titleFontBold"), DEFAULT_MUSICBOOK_PAGE_FONTS["titleFontBold"]
                ),
                "noteFont": body_font,
                "noteFontBold": False,
                "capsuleFont": body_font,
                "capsuleFontBold": _normalize_bool(
                    src.get("bodyFontBold"), DEFAULT_MUSICBOOK_PAGE_FONTS["capsuleFontBold"]
                ),
            }
    return {
        "titleFont": _normalize_font_id(src.get("titleFont"), DEFAULT_MUSICBOOK_PAGE_FONTS["titleFont"]),
        "titleFontBold": _normalize_bool(
            src.get("titleFontBold"), DEFAULT_MUSICBOOK_PAGE_FONTS["titleFontBold"]
        ),
        "noteFont": _normalize_font_id(src.get("noteFont"), DEFAULT_MUSICBOOK_PAGE_FONTS["noteFont"]),
        "noteFontBold": _normalize_bool(src.get("noteFontBold"), DEFAULT_MUSICBOOK_PAGE_FONTS["noteFontBold"]),
        "capsuleFont": _normalize_font_id(src.get("capsuleFont"), DEFAULT_MUSICBOOK_PAGE_FONTS["capsuleFont"]),
        "capsuleFontBold": _normalize_bool(
            src.get("capsuleFontBold"), DEFAULT_MUSICBOOK_PAGE_FONTS["capsuleFontBold"]
        ),
    }


@app.route("/api/schedule/meta", methods=["GET"])
def api_meta_get():
    return jsonify(get_schedule_meta_public())


@app.route("/api/schedule/meta", methods=["PUT"])
@require_streamer
def api_meta_put():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400

    email = current_user_email()
    meta_keys = [k for k in payload if k in SCHEDULE_META_FIELDS]
    design_keys = [k for k in payload if k in SCHEDULE_DESIGN_FIELDS]
    if meta_keys and not user_has_permission(email, "calendar"):
        return jsonify({"error": "forbidden", "hint": "방송일정 변경 권한이 없습니다."}), 403
    if design_keys and not user_has_permission(email, "calendar"):
        return jsonify({"error": "forbidden", "hint": "방송일정 변경 권한이 없습니다."}), 403
    if not meta_keys and not design_keys:
        return jsonify({"error": "bad_request", "hint": "변경할 항목이 없습니다."}), 400

    data = load_schedule()
    before = {k: data.get(k) for k in [*meta_keys, *design_keys]}
    after_preview = dict(before)
    for field in meta_keys:
        after_preview[field] = payload[field]
    for field in design_keys:
        if field == "chipColorMode":
            after_preview["chipColorMode"] = normalize_chip_color_mode(payload["chipColorMode"])
        elif field == "proportionalMinSlots":
            try:
                slots = int(payload["proportionalMinSlots"])
                after_preview["proportionalMinSlots"] = max(2, min(12, slots))
            except (TypeError, ValueError):
                pass
        elif field == "hourlyMinSlots":
            try:
                slots = int(payload["hourlyMinSlots"])
                after_preview["hourlyMinSlots"] = max(2, min(12, slots))
            except (TypeError, ValueError):
                pass
        elif field == "calendarFont":
            after_preview["calendarFont"] = _normalize_font_id(payload["calendarFont"], "gmarketSans")
        elif field == "sidebarFont":
            after_preview["sidebarFont"] = _normalize_font_id(payload["sidebarFont"], "nanumGothic")
        elif field == "calendarFontBold":
            after_preview["calendarFontBold"] = _normalize_bool(payload["calendarFontBold"], False)
        elif field == "sidebarFontBold":
            after_preview["sidebarFontBold"] = _normalize_bool(payload["sidebarFontBold"], True)
        else:
            after_preview[field] = payload[field]
    if all(before.get(k) == after_preview.get(k) for k in [*meta_keys, *design_keys]):
        return jsonify(
            {
                "ok": True,
                "unchanged": True,
                "updatedAt": utc_now(),
                "revision": _file_revision_token(SCHEDULE_PATH),
            }
        )
    for field in meta_keys:
        data[field] = payload[field]
    for field in design_keys:
        if field == "chipColorMode":
            data["chipColorMode"] = normalize_chip_color_mode(payload["chipColorMode"])
        elif field == "proportionalMinSlots":
            try:
                slots = int(payload["proportionalMinSlots"])
                data["proportionalMinSlots"] = max(2, min(12, slots))
            except (TypeError, ValueError):
                pass
        elif field == "hourlyMinSlots":
            try:
                slots = int(payload["hourlyMinSlots"])
                data["hourlyMinSlots"] = max(2, min(12, slots))
            except (TypeError, ValueError):
                pass
        elif field == "calendarFont":
            data["calendarFont"] = _normalize_font_id(payload["calendarFont"], "gmarketSans")
        elif field == "sidebarFont":
            data["sidebarFont"] = _normalize_font_id(payload["sidebarFont"], "nanumGothic")
        elif field == "calendarFontBold":
            data["calendarFontBold"] = _normalize_bool(payload["calendarFontBold"], False)
        elif field == "sidebarFontBold":
            data["sidebarFontBold"] = _normalize_bool(payload["sidebarFontBold"], True)
        else:
            data[field] = payload[field]
    save_schedule(data)
    try:
        changed = []
        for k in [*meta_keys, *design_keys]:
            if before.get(k) != data.get(k):
                changed.append(k)
        after = {k: data.get(k) for k in changed}
        detail = schedule_audit.build_meta_audit_detail(before, after, changed)
        _write_schedule_audit("meta_put", detail)
    except Exception:
        pass
    return jsonify(
        {
            "ok": True,
            "updatedAt": utc_now(),
            "revision": _file_revision_token(SCHEDULE_PATH),
        }
    )


@app.route("/api/schedule/month/<month_id>", methods=["DELETE"])
@require_permission("calendar")
def api_month_delete(month_id):
    if not _valid_month_id(month_id):
        return jsonify({"error": "invalid_month"}), 400
    data = load_schedule()
    months = data.get("months", {})
    if month_id not in months:
        return jsonify({"error": "not_found"}), 404
    removed_month = normalize_schedule({"months": {month_id: months[month_id]}})["months"][month_id]
    del months[month_id]
    save_schedule(data)
    try:
        detail = schedule_audit.build_month_removed_detail(month_id, removed_month)
        _write_schedule_audit("month_delete", detail, month_id=month_id)
    except Exception:
        pass
    return jsonify({"ok": True, "deleted": month_id})


@app.route("/api/musicbook")
def api_musicbook_get():
    data = load_musicbook()
    likes_data = load_musicbook_likes()
    if request_can_edit():
        return jsonify(
            {
                **data,
                "songs": _musicbook_songs_with_likes(data, likes_data),
                "updatedAt": utc_now(),
                "apiScope": "editor",
            }
        )
    return jsonify(
        {
            **_public_musicbook_payload(data, likes_data=likes_data),
            "updatedAt": utc_now(),
        }
    )


@app.route("/api/musicbook/my-likes")
def api_musicbook_my_likes():
    email = _musicbook_viewer_email()
    if not email:
        return jsonify({"songIds": [], "updatedAt": utc_now()})
    likes_data = load_musicbook_likes()
    return jsonify(
        {
            "songIds": _musicbook_liked_song_ids(likes_data, email),
            "updatedAt": utc_now(),
        }
    )


@app.route("/api/musicbook/<song_id>/like", methods=["POST"])
@require_logged_in
def api_musicbook_like_toggle(song_id):
    song_id = str(song_id or "").strip()
    if not SONG_ID_RE.match(song_id):
        return jsonify({"error": "not_found"}), 404

    email = _musicbook_viewer_email()
    if not email:
        return jsonify({"error": "login_required", "hint": "로그인이 필요합니다."}), 401

    musicbook = load_musicbook()
    song = next(
        (
            item
            for item in (musicbook.get("songs") or [])
            if isinstance(item, dict)
            and item.get("id") == song_id
            and item.get("status") == "available"
        ),
        None,
    )
    if not song:
        return jsonify({"error": "not_found"}), 404

    with musicbook_likes_write_lock():
        likes_data = load_musicbook_likes()
        songs = dict(likes_data.get("songs") or {})
        likes = _normalize_musicbook_like_emails(songs.get(song_id))
        old_count = len(likes)
        if email in likes:
            likes = [item for item in likes if item != email]
            liked_by_me = False
        else:
            likes.append(email)
            liked_by_me = True
        new_count = len(likes)
        if likes:
            songs[song_id] = likes
        else:
            songs.pop(song_id, None)
        save_musicbook_likes({**likes_data, "songs": songs})

    try:
        like_action = "like" if liked_by_me else "unlike"
        detail = musicbook_audit.build_musicbook_like_detail(
            song=song,
            action=like_action,
            before_count=old_count,
            after_count=new_count,
        )
        _write_musicbook_audit(like_action, detail)
    except Exception:
        pass
    return jsonify(
        {
            "ok": True,
            "likeCount": new_count,
            "likedByMe": liked_by_me,
            "updatedAt": utc_now(),
        }
    )


@app.route("/api/musicbook", methods=["PUT"])
@require_permission("musicbook")
def api_musicbook_put():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400
    old_data = load_musicbook()
    like_counts_before = musicbook_like_counts()
    data = normalize_musicbook(payload)
    renames = _musicbook_artist_renames(old_data, data)
    save_musicbook(data)
    pruned_likes = prune_musicbook_likes(data)
    _sync_song_request_artists(renames)
    try:
        like_counts = {**like_counts_before, **pruned_likes}
        detail = musicbook_audit.build_musicbook_audit_detail(
            old_data,
            data,
            like_counts=like_counts,
        )
        _write_musicbook_audit("put", detail)
    except Exception:
        pass
    return jsonify({"ok": True, "updatedAt": utc_now(), "songCount": len(data.get("songs", []))})


@app.route("/api/song-requests")
def api_song_requests_get():
    user = current_user()
    dev = is_dev_streamer()
    email = ""
    if user:
        email = normalize_manager_email(user.get("email", ""))
    elif dev:
        email = normalize_manager_email("dev@local")
    caps = _song_request_review_capabilities(email) if (user or dev) else {
        "canReview": False,
        "canDismiss": False,
        "canApproveBanned": False,
        "canApproveAvailable": False,
        "canManageBlacklist": False,
    }
    logged_in = bool(user) or dev

    data = load_song_requests()
    pending_all = [r for r in data.get("requests", []) if r.get("status") == "pending"]

    mine = []
    if logged_in and email:
        mine = [
            _public_song_request(r, email)
            for r in pending_all
            if normalize_manager_email(r.get("requestedBy", {}).get("email")) == email
        ]

    if caps["canReview"]:
        pending = [_song_request_api_payload(r, email, keep_requester=True) for r in pending_all]
    else:
        pending = [_public_song_request(r, email) for r in pending_all]

    body = {
        "loggedIn": logged_in,
        "canReview": caps["canReview"],
        "canDismiss": caps["canDismiss"],
        "canApproveBanned": caps["canApproveBanned"],
        "canApproveAvailable": caps["canApproveAvailable"],
        "canManageBlacklist": caps["canManageBlacklist"],
        "requestBlocked": _is_song_request_submitter_blocked(email, data) if logged_in and email else False,
        "pending": pending,
        "mine": mine,
        "notifications": _song_request_notifications_for_email(data, email) if logged_in and email else [],
        "updatedAt": utc_now(),
    }
    if caps["canReview"]:
        body["apiScope"] = "review"
        body["blacklist"] = list(data.get("blacklist", []))
    return jsonify(body)


@app.route("/api/song-requests/notifications")
@require_logged_in
def api_song_requests_notifications():
    email = _current_song_requests_submitter_email()
    if not email:
        return jsonify({"error": "login_required"}), 401
    data = load_song_requests()
    return jsonify(
        {
            "notifications": _song_request_notifications_for_email(data, email),
            "updatedAt": utc_now(),
        }
    )


@app.route("/api/song-requests/notifications/read", methods=["POST"])
@require_logged_in
def api_song_requests_notifications_read():
    email = _current_song_requests_submitter_email()
    if not email:
        return jsonify({"error": "login_required"}), 401
    payload = request.get_json(silent=True) or {}
    raw_ids = payload.get("ids")
    if not isinstance(raw_ids, list) or not raw_ids:
        return jsonify({"error": "invalid_ids", "hint": "ids 배열이 필요합니다."}), 400
    wanted = {str(item or "").strip() for item in raw_ids}
    wanted.discard("")

    data = load_song_requests()
    notifications = data.get("notifications") if isinstance(data.get("notifications"), list) else []
    now = utc_now()
    marked = 0
    updated = []
    for item in notifications:
        if not isinstance(item, dict):
            continue
        notif_id = str(item.get("id") or "").strip()
        if notif_id in wanted and normalize_manager_email(item.get("email")) == email and not item.get("readAt"):
            item = {**item, "readAt": now}
            marked += 1
        updated.append(item)
    if marked:
        save_song_requests({**data, "notifications": updated})
    return jsonify({"ok": True, "marked": marked, "updatedAt": now})


@app.route("/api/song-requests", methods=["POST"])
@require_logged_in
def api_song_requests_post():
    payload = request.get_json(silent=True)
    fields, err = _normalize_song_request_input(payload)
    if err:
        hints = {
            "title_required": "제목을 입력해 주세요.",
            "artist_required": "아티스트를 입력해 주세요.",
            "language_required": "언어를 선택해 주세요.",
            "youtube_required": "유효한 유튜브 영상 링크를 입력해 주세요. (youtube.com / youtu.be)",
            "invalid_json": "요청 형식이 올바르지 않습니다.",
            "song_banned": "금지 목록에 있는 곡은 신청할 수 없습니다.",
            "song_exists": "이미 노래책에 등록된 곡입니다. 같은 곡을 다시 신청할 필요가 없습니다.",
        }
        return jsonify({"error": err, "hint": hints.get(err, err)}), 400
    block_err, block_hint = _song_request_musicbook_block(fields["title"], fields["artist"])
    if block_err:
        return jsonify({"error": block_err, "hint": block_hint}), 409
    submitter = _song_request_submitter(current_user())
    if not submitter:
        return jsonify({"error": "login_required"}), 401
    if _is_song_request_submitter_blocked(submitter["email"]):
        return jsonify(
            {
                "error": "submitter_blocked",
                "hint": "이 계정은 노래 신청이 제한되어 있습니다.",
            }
        ), 403
    data = load_song_requests()
    requests = list(data.get("requests", []))
    if _find_pending_duplicate_request(requests, submitter["email"], fields["title"], fields["artist"]):
        return jsonify(
            {
                "error": "duplicate_pending",
                "hint": "같은 곡에 대한 대기 중인 신청이 이미 있습니다.",
            }
        ), 409
    now = utc_now()
    new_req = normalize_song_request(
        {
            **fields,
            "id": _new_song_request_id(),
            "status": "pending",
            "requestedBy": submitter,
            "createdAt": now,
        }
    )
    if not new_req:
        return jsonify({"error": "invalid_request"}), 400
    requests.insert(0, new_req)
    save_song_requests({**data, "requests": requests})
    audit_song_request("post", summary=f"신청 · {_song_request_audit_label(new_req)}", req=new_req)
    return jsonify({"ok": True, "request": _public_song_request(new_req, _current_song_requests_submitter_email()), "updatedAt": utc_now()}), 201


@app.route("/api/song-requests/<req_id>/like", methods=["POST"])
@require_logged_in
def api_song_requests_like_toggle(req_id):
    req_id = str(req_id or "").strip()
    if not SONG_ID_RE.match(req_id):
        return jsonify({"error": "not_found"}), 404

    email = _current_song_requests_submitter_email()
    if not email:
        return jsonify({"error": "login_required", "hint": "로그인이 필요합니다."}), 401
    if _is_song_request_submitter_blocked(email):
        return jsonify(
            {
                "error": "submitter_blocked",
                "hint": "이 계정은 노래 신청이 제한되어 있습니다.",
            }
        ), 403

    data = load_song_requests()
    requests = list(data.get("requests", []))
    idx = next((i for i, r in enumerate(requests) if r.get("id") == req_id), -1)
    if idx < 0:
        return jsonify({"error": "not_found"}), 404
    req = requests[idx]
    if req.get("status") != "pending":
        return jsonify({"error": "not_pending", "hint": "검토가 끝난 신청에는 좋아요를 할 수 없습니다."}), 409

    likes = _normalize_song_request_likes(req.get("likes"))
    old_count = len(likes)
    if email in likes:
        likes = [item for item in likes if item != email]
        liked_by_me = False
    else:
        likes = [*likes, email]
        liked_by_me = True
    new_count = len(likes)
    tier_patch = _song_request_like_tier_update(old_count, new_count)

    updated = normalize_song_request({**req, "likes": likes, **tier_patch})
    if not updated:
        return jsonify({"error": "invalid_request"}), 400
    requests[idx] = updated
    save_song_requests({**data, "requests": requests})
    like_action = "like" if liked_by_me else "unlike"
    like_label = "좋아요" if liked_by_me else "좋아요 취소"
    audit_song_request(
        like_action,
        summary=f"{like_label} · {_song_request_audit_label(updated)}",
        req=updated,
        meta={"likeCount": new_count, "likedByMe": liked_by_me},
    )
    return jsonify(
        {
            "ok": True,
            "likeCount": new_count,
            "likedByMe": liked_by_me,
            "likeTierAt": updated.get("likeTierAt"),
            "likeTierVia": updated.get("likeTierVia"),
            "updatedAt": utc_now(),
        }
    )


def _song_request_owner_update(req_id, payload):
    email = _current_song_requests_submitter_email()
    if not email:
        return jsonify({"error": "login_required", "hint": "로그인이 필요합니다."}), 401
    if _is_song_request_submitter_blocked(email):
        return jsonify(
            {
                "error": "submitter_blocked",
                "hint": "이 계정은 노래 신청이 제한되어 있습니다.",
            }
        ), 403

    fields, err = _normalize_song_request_input(payload)
    if err:
        hints = {
            "title_required": "제목을 입력해 주세요.",
            "artist_required": "아티스트를 입력해 주세요.",
            "language_required": "언어를 선택해 주세요.",
            "youtube_required": "유효한 유튜브 영상 링크를 입력해 주세요. (youtube.com / youtu.be)",
            "invalid_json": "요청 형식이 올바르지 않습니다.",
            "song_banned": "금지 목록에 있는 곡은 신청할 수 없습니다.",
            "song_exists": "이미 노래책에 등록된 곡입니다. 같은 곡을 다시 신청할 필요가 없습니다.",
        }
        return jsonify({"error": err, "hint": hints.get(err, err)}), 400

    data = load_song_requests()
    requests = list(data.get("requests", []))
    idx = next((i for i, r in enumerate(requests) if r.get("id") == req_id), -1)
    if idx < 0:
        return jsonify({"error": "not_found"}), 404
    req = requests[idx]
    if req.get("status") != "pending":
        return jsonify({"error": "not_pending", "hint": "검토가 끝난 신청은 수정할 수 없습니다."}), 409

    owner_email = normalize_manager_email(req.get("requestedBy", {}).get("email"))
    if owner_email != email:
        return jsonify({"error": "forbidden", "hint": "본인 신청만 수정할 수 있습니다."}), 403

    block_err, block_hint = _song_request_musicbook_block(
        fields["title"], fields["artist"], existing_req=req
    )
    if block_err:
        return jsonify({"error": block_err, "hint": block_hint}), 409

    if _find_pending_duplicate_request(requests, email, fields["title"], fields["artist"], exclude_id=req_id):
        return jsonify(
            {
                "error": "duplicate_pending",
                "hint": "같은 곡에 대한 대기 중인 신청이 이미 있습니다.",
            }
        ), 409

    now = utc_now()
    updated = normalize_song_request({**req, **fields, "updatedAt": now})
    if not updated:
        return jsonify({"error": "invalid_request"}), 400
    requests[idx] = updated
    save_song_requests({**data, "requests": requests})
    audit_song_request("update", summary=f"신청 수정 · {_song_request_audit_label(updated)}", req=updated)
    return jsonify({"ok": True, "request": _public_song_request(updated, email), "updatedAt": now})


def _song_request_owner_cancel(req_id):
    email = _current_song_requests_submitter_email()
    if not email:
        return jsonify({"error": "login_required", "hint": "로그인이 필요합니다."}), 401

    data = load_song_requests()
    requests = list(data.get("requests", []))
    idx = next((i for i, r in enumerate(requests) if r.get("id") == req_id), -1)
    if idx < 0:
        return jsonify({"error": "not_found"}), 404
    req = requests[idx]
    if req.get("status") != "pending":
        return jsonify({"error": "not_pending", "hint": "검토가 끝난 신청은 취소할 수 없습니다."}), 409

    owner_email = normalize_manager_email(req.get("requestedBy", {}).get("email"))
    if owner_email != normalize_manager_email(email):
        return jsonify({"error": "forbidden", "hint": "본인 신청만 취소할 수 있습니다."}), 403

    requests.pop(idx)
    save_song_requests({**data, "requests": requests})
    audit_song_request("cancel", summary=f"신청 취소 · {_song_request_audit_label(req)}", req=req)
    return jsonify({"ok": True, "action": "cancel", "updatedAt": utc_now()})


@app.route("/api/song-requests/<req_id>", methods=["PATCH"])
def api_song_requests_patch(req_id):
    req_id = str(req_id or "").strip()
    if not SONG_ID_RE.match(req_id):
        return jsonify({"error": "not_found"}), 404
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400
    action = str(payload.get("action") or "").strip().lower()
    if action == "update":
        return _song_request_owner_update(req_id, payload)
    if action == "cancel":
        return _song_request_owner_cancel(req_id)

    if action not in ("dismiss", "approve"):
        return jsonify({"error": "invalid_action", "hint": "action은 update, cancel, dismiss 또는 approve여야 합니다."}), 400

    if not is_dev_streamer() and not _current_song_requests_submitter_email():
        return jsonify({"error": "login_required", "hint": "로그인이 필요합니다."}), 401

    review_email = _current_song_requests_submitter_email()
    caps = _song_request_review_capabilities(review_email)

    data = load_song_requests()
    requests = list(data.get("requests", []))
    idx = next((i for i, r in enumerate(requests) if r.get("id") == req_id), -1)
    if idx < 0:
        return jsonify({"error": "not_found"}), 404
    req = requests[idx]
    if req.get("status") != "pending":
        return jsonify({"error": "not_pending"}), 409

    if _song_request_is_own_submission(req, review_email):
        return jsonify({"error": "forbidden", "hint": "본인 신청은 직접 검토할 수 없습니다."}), 403

    if action == "dismiss":
        if not caps["canDismiss"]:
            return jsonify({"error": "forbidden", "hint": "노래책 신청 반려 권한이 없습니다."}), 403
        reason = _normalize_song_request_review_reason(payload.get("reason"))
        data = _append_song_request_notification(data, req, "dismissed", reason=reason)
        requests.pop(idx)
        save_song_requests({**data, "requests": requests})
        audit_song_request(
            "dismiss",
            summary=f"반려 · {_song_request_audit_label(req)}",
            req=req,
            meta={"reason": reason} if reason else None,
        )
        return jsonify({"ok": True, "action": "dismiss", "updatedAt": utc_now()})

    song_status = str(payload.get("status") or "available").strip().lower()
    if song_status not in SONG_STATUSES:
        return jsonify({"error": "invalid_status", "hint": "status는 available 또는 banned여야 합니다."}), 400

    if song_status == "available" and not caps["canApproveAvailable"]:
        return jsonify({"error": "forbidden", "hint": "신청 가능곡 등록 권한이 없습니다."}), 403
    if song_status == "banned" and not caps["canApproveBanned"]:
        return jsonify({"error": "forbidden", "hint": "노래책 신청 검토 권한이 없습니다."}), 403

    title_override = payload.get("title")
    if song_status == "available" and title_override is not None:
        approve_title = str(title_override).strip()
        if not approve_title:
            return jsonify({"error": "invalid_title", "hint": "제목을 입력해 주세요."}), 400
    else:
        approve_title = str(req.get("title") or "").strip()

    block_err, block_hint = _song_request_musicbook_block(approve_title, req.get("artist"))
    if block_err:
        return jsonify({"error": block_err, "hint": block_hint}), 409

    note_override = payload.get("note")
    review_reason = _normalize_song_request_review_reason(payload.get("reason"))
    if song_status == "banned":
        note = ""
    elif note_override is not None:
        note = str(note_override).strip()
    else:
        note = str(req.get("note") or "").strip()
    capsule = str(payload.get("capsule") or "").strip()
    if capsule and not CAPSULE_ID_RE.match(capsule):
        capsule = ""
    pitch = _normalize_pitch_shift(payload.get("pitchShift"))

    fresh_req = _song_request_still_pending(req_id)
    if not fresh_req:
        return jsonify({"error": "not_pending", "hint": "이미 처리된 신청입니다."}), 409

    musicbook = load_musicbook()
    songs = list(musicbook.get("songs") or [])
    now = utc_now()
    song_payload = {
        "id": _new_song_id(),
        "status": song_status,
        "title": approve_title,
        "artist": fresh_req.get("artist"),
        "youtubeUrl": fresh_req.get("youtubeUrl"),
        "note": note,
        "createdAt": now,
        "updatedAt": now,
    }
    if song_status == "available":
        song_payload["language"] = fresh_req.get("language") or "K"
        if capsule:
            song_payload["capsule"] = capsule
        if pitch is not None:
            song_payload["pitchShift"] = pitch
    song = normalize_song(song_payload, fallback_status=song_status)
    if not song:
        return jsonify({"error": "invalid_song"}), 400
    songs.append(song)
    musicbook = {**musicbook, "songs": songs}
    save_musicbook(musicbook)

    try:
        data = load_song_requests()
        requests = list(data.get("requests", []))
        idx = next((i for i, r in enumerate(requests) if r.get("id") == req_id), -1)
        if idx < 0 or requests[idx].get("status") != "pending":
            songs_rollback = [s for s in songs if s.get("id") != song["id"]]
            save_musicbook({**musicbook, "songs": songs_rollback})
            return jsonify({"error": "not_pending", "hint": "이미 처리된 신청입니다."}), 409
        data = _append_song_request_notification(
            data,
            requests[idx],
            song_status,
            song_id=song["id"],
            reason=review_reason if song_status == "banned" else None,
        )
        requests.pop(idx)
        save_song_requests({**data, "requests": requests})
    except Exception:
        songs_rollback = [s for s in songs if s.get("id") != song["id"]]
        save_musicbook({**musicbook, "songs": songs_rollback})
        raise
    status_label = "신청 가능" if song_status == "available" else "금지"
    audit_meta = {"songId": song["id"], "status": song_status}
    original_title = str(fresh_req.get("title") or "").strip()
    if approve_title != original_title:
        audit_meta["titleOverride"] = approve_title
    audit_song_request(
        "approve",
        summary=f"승인({status_label}) · {_song_request_audit_label(fresh_req)}",
        req=fresh_req,
        meta=audit_meta,
    )
    try:
        musicbook_detail = musicbook_audit.build_musicbook_song_add_detail(
            song,
            source_request_id=str(req_id or ""),
        )
        _write_musicbook_audit("add", musicbook_detail)
    except Exception:
        pass
    return jsonify(
        {
            "ok": True,
            "action": "approve",
            "status": song_status,
            "songId": song["id"],
            "updatedAt": utc_now(),
        }
    )


@app.route("/api/song-requests/blacklist", methods=["POST"])
@require_song_request_reviewer
def api_song_requests_blacklist_post():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400
    email = normalize_manager_email(payload.get("email", ""))
    if not email or not EMAIL_RE.match(email):
        return jsonify({"error": "invalid_email", "hint": "유효한 Google 계정 이메일이 필요합니다."}), 400
    name = str(payload.get("name") or "").strip()[:80] or email
    note = str(payload.get("note") or "").strip()[:500]

    data = load_song_requests()
    blacklist = list(data.get("blacklist", []))
    if any(normalize_manager_email(entry.get("email")) == email for entry in blacklist):
        return jsonify({"error": "already_blocked", "hint": "이미 신청 금지된 계정입니다."}), 409

    blocker = _song_request_submitter(current_user())
    entry_payload = {
        "email": email,
        "name": name,
        "blockedAt": utc_now(),
    }
    if blocker:
        entry_payload["blockedBy"] = blocker
    if note:
        entry_payload["note"] = note
    entry = normalize_song_request_blacklist_entry(entry_payload)
    if not entry:
        return jsonify({"error": "invalid_entry"}), 400
    blacklist.append(entry)
    data = {**data, "blacklist": blacklist}
    data, dismissed_count = _dismiss_pending_song_requests_for_email(data, email)
    save_song_requests(data)
    audit_song_request(
        "blacklist_add",
        summary=f"신청 금지 · {name} ({email})",
        meta={"email": email, "dismissedCount": dismissed_count},
    )
    return jsonify(
        {
            "ok": True,
            "entry": entry,
            "dismissedCount": dismissed_count,
            "updatedAt": utc_now(),
        }
    ), 201


@app.route("/api/song-requests/blacklist", methods=["DELETE"])
@require_song_request_reviewer
def api_song_requests_blacklist_delete():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400
    email = normalize_manager_email(payload.get("email", ""))
    if not email or not EMAIL_RE.match(email):
        return jsonify({"error": "invalid_email", "hint": "유효한 이메일이 필요합니다."}), 400

    data = load_song_requests()
    blacklist = list(data.get("blacklist", []))
    next_blacklist = [
        entry for entry in blacklist if normalize_manager_email(entry.get("email")) != email
    ]
    if len(next_blacklist) == len(blacklist):
        return jsonify({"error": "not_found", "hint": "목록에 없는 계정입니다."}), 404
    save_song_requests({**data, "blacklist": next_blacklist})
    audit_song_request("blacklist_remove", summary=f"신청 금지 해제 · {email}", meta={"email": email})
    return jsonify({"ok": True, "email": email, "updatedAt": utc_now()})


@app.route("/api/links")
def api_links_get():
    data = load_links()
    enriched = enrich_links_api_payload(data, fetch_external=True)
    if request_can_edit():
        return jsonify(
            {
                **data,
                **enriched,
                "updatedAt": utc_now(),
                "apiScope": "editor",
            }
        )
    return jsonify(
        _public_links_payload(
            data,
            profile_resolved=enriched["profileResolved"],
            youtube_latest=enriched["youtubeLatest"],
            live_status=enriched["liveStatus"],
            schedule_meta=enriched["scheduleMeta"],
            upcoming_highlights=enriched["upcomingHighlights"],
            manual_video_meta=enriched["manualVideoMeta"],
        )
        | {"updatedAt": utc_now()}
    )


@app.route("/api/links/live")
def api_links_live():
    data = load_links()
    live_cfg = dict(data.get("live") or {})
    status = get_links_live_status(live_cfg, fetch_if_missing=True)
    return jsonify(status)


@app.route("/api/links/youtube-latest")
def api_links_youtube_latest():
    data = load_links()
    youtube_cfg = dict(data.get("youtube") or {})
    include_shorts_arg = request.args.get("includeShorts")
    if include_shorts_arg is not None:
        youtube_cfg["includeShorts"] = str(include_shorts_arg).strip().lower() in ("1", "true", "yes", "on")
    latest = get_youtube_latest_for_config(youtube_cfg, fetch_if_missing=True)
    if not latest:
        return jsonify({"error": "fetch_failed"}), 502
    if latest.get("error") == "youtube_api_not_configured":
        return jsonify(latest), 503
    return jsonify(latest)


@app.route("/api/links", methods=["PUT"])
@require_permission("home")
def api_links_put():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400
    data = normalize_links(payload)
    prev_live_station = (load_links().get("live") or {}).get("stationId")
    save_links(data)
    yt_cfg = data.get("youtube") or {}
    _bust_youtube_latest_cache(yt_cfg.get("channelUrl"), yt_cfg.get("channelId"))
    live_cfg = data.get("live") or {}
    _bust_live_status_cache(prev_live_station)
    _bust_live_status_cache(live_cfg.get("stationId"))
    _bust_manual_video_meta_cache()
    enriched = enrich_links_api_payload(data, fetch_external=True)
    return jsonify(
        {
            "ok": True,
            "updatedAt": utc_now(),
            "linkCount": len(data.get("links", [])),
            "announcementCount": len(data.get("announcements", [])),
            "profileResolved": enriched["profileResolved"],
            "youtubeLatest": get_youtube_latest_for_config(data.get("youtube")),
            "manualVideoMeta": enriched["manualVideoMeta"],
            "liveStatus": enriched["liveStatus"],
        }
    )


@app.route("/api/links/icon-upload", methods=["POST"])
@require_permission("home")
def api_links_icon_upload():
    if "file" not in request.files:
        return jsonify({"error": "bad_request", "hint": "업로드할 파일이 없습니다."}), 400

    up = request.files["file"]
    if not up:
        return jsonify({"error": "bad_request", "hint": "업로드할 파일이 없습니다."}), 400

    # 붙여넣기 업로드는 filename이 비어 있는 경우가 많음 — 내용으로 검증
    # request.content_length can be None; enforce after read as well.
    if request.content_length and request.content_length > MAX_LINK_ICON_BYTES:
        return jsonify({"error": "too_large", "hint": "파일이 너무 큽니다."}), 413

    data = up.read()
    if not data:
        return jsonify({"error": "bad_request", "hint": "빈 파일은 업로드할 수 없습니다."}), 400
    if len(data) > MAX_LINK_ICON_BYTES:
        return jsonify({"error": "too_large", "hint": "파일이 너무 큽니다."}), 413

    kind = _detect_image_extension(data)
    ext = kind
    if not ext:
        return (
            jsonify(
                {
                    "error": "unsupported_type",
                    "hint": "PNG/JPG/WEBP/GIF 이미지 파일만 업로드할 수 있습니다.",
                }
            ),
            415,
        )

    name = f"link-icon-{uuid.uuid4().hex}.{ext}"
    ensure_data_dir()
    out_path = LINK_ICON_UPLOAD_DIR / name
    try:
        out_path.write_bytes(data)
    except OSError:
        return jsonify({"error": "server_error", "hint": "업로드 저장에 실패했습니다."}), 500

    return jsonify({"url": f"/uploads/link-icons/{name}"})


@app.route("/uploads/link-icons/<path:name>")
def link_icon_file(name):
    if not re.fullmatch(r"link-icon-[a-f0-9]+\.(png|jpg|jpeg|gif|webp)", name, re.I):
        return jsonify({"error": "not_found"}), 404
    path = LINK_ICON_UPLOAD_DIR / name
    if not path.is_file():
        return jsonify({"error": "not_found"}), 404
    return send_from_directory(LINK_ICON_UPLOAD_DIR, name)


@app.route("/api/patchnotes/image-upload", methods=["POST"])
@require_developer
def api_patchnotes_image_upload():
    if "file" not in request.files:
        return jsonify({"error": "bad_request", "hint": "업로드할 파일이 없습니다."}), 400

    up = request.files["file"]
    if not up:
        return jsonify({"error": "bad_request", "hint": "업로드할 파일이 없습니다."}), 400

    # 붙여넣기 업로드는 filename이 비어 있는 경우가 많음 — 내용으로 검증
    if request.content_length and request.content_length > MAX_PATCHNOTE_IMAGE_BYTES:
        return jsonify({"error": "too_large", "hint": "파일이 너무 큽니다."}), 413

    data = up.read()
    if not data:
        return jsonify({"error": "bad_request", "hint": "빈 파일은 업로드할 수 없습니다."}), 400
    if len(data) > MAX_PATCHNOTE_IMAGE_BYTES:
        return jsonify({"error": "too_large", "hint": "파일이 너무 큽니다."}), 413

    kind = _detect_image_extension(data)
    ext = kind
    if not ext:
        return (
            jsonify(
                {
                    "error": "unsupported_type",
                    "hint": "PNG/JPG/WEBP/GIF 이미지 파일만 업로드할 수 있습니다.",
                }
            ),
            415,
        )

    name = f"patchnote-{uuid.uuid4().hex}.{ext}"
    ensure_data_dir()
    out_path = PATCHNOTE_IMAGE_UPLOAD_DIR / name
    try:
        out_path.write_bytes(data)
    except OSError:
        return jsonify({"error": "server_error", "hint": "업로드 저장에 실패했습니다."}), 500

    return jsonify({"url": f"{PATCHNOTE_IMAGE_UPLOAD_URL_PREFIX}{name}"})


@app.route("/uploads/patchnote-images/<path:name>")
def patchnote_image_file(name):
    if not re.fullmatch(r"patchnote-[a-f0-9]+\.(png|jpg|jpeg|gif|webp)", name, re.I):
        return jsonify({"error": "not_found"}), 404
    path = PATCHNOTE_IMAGE_UPLOAD_DIR / name
    if not path.is_file():
        return jsonify({"error": "not_found"}), 404
    return send_from_directory(PATCHNOTE_IMAGE_UPLOAD_DIR, name)


def _valid_month_id(month_id: str) -> bool:
    parts = month_id.split("-")
    if len(parts) != 2:
        return False
    try:
        y, m = int(parts[0]), int(parts[1])
        return 2000 <= y <= 2100 and 1 <= m <= 12
    except ValueError:
        return False


@app.route("/favicon.ico")
def favicon_ico():
    return send_from_directory(BASE_DIR, "favicon.ico")


@app.route("/favicon.png")
def favicon_png():
    return send_from_directory(BASE_DIR, "favicon.png")


@app.route("/favicon.svg")
def favicon_svg():
    return send_from_directory(BASE_DIR, "favicon.svg")


@app.route("/og-image.png")
def og_image():
    resp = send_from_directory(BASE_DIR, "og-image.png", mimetype="image/png")
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


def _request_app_root():
    return (request.script_root or "").rstrip("/")


def _app_path(path):
    path = "/" + str(path or "").lstrip("/")
    root = _request_app_root()
    return f"{root}{path}" if root else path


def _pwa_short_name(title, fallback="시리안", max_len=12):
    cleaned = re.sub(r"^[\s!·|｜\[\]()（）]+|[\s!·|｜\[\]()（）]+$", "", str(title or "").strip())
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        cleaned = fallback
    if len(cleaned) <= max_len:
        return cleaned
    return cleaned[: max_len - 1] + "…"


def build_pwa_manifest():
    try:
        links = load_links()
    except OSError:
        links = {}
    profile = resolve_links_profile(links)
    title = str(profile.get("title") or LINKS_STREAMER_DISPLAY_NAME).strip()[:80]
    short_name = _pwa_short_name(title)[:12]
    subtitle = str(profile.get("subtitle") or "").strip()
    description = subtitle or f"{title} 방송 일정·홈·노래책"
    if len(description) > 120:
        description = "방송 일정·홈·노래책"

    return {
        "name": title,
        "short_name": short_name,
        "description": description,
        "start_url": _app_path("/home"),
        "scope": _app_path("/"),
        "display": "standalone",
        "orientation": "any",
        "background_color": "#eef1f8",
        "theme_color": "#4a60a9",
        "lang": "ko",
        "icons": [
            {
                "src": _app_path("/icons/icon-192.png"),
                "sizes": "192x192",
                "type": "image/png",
                "purpose": "any",
            },
            {
                "src": _app_path("/icons/icon-512.png"),
                "sizes": "512x512",
                "type": "image/png",
                "purpose": "any",
            },
            {
                "src": _app_path("/icons/icon-512.png"),
                "sizes": "512x512",
                "type": "image/png",
                "purpose": "maskable",
            },
        ],
    }


@app.route("/site.webmanifest")
def site_manifest():
    manifest = build_pwa_manifest()
    resp = make_response(json.dumps(manifest, ensure_ascii=False))
    resp.mimetype = "application/manifest+json"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


def _ics_last_modified():
    for path in (CALENDAR_ICS_PATH, SCHEDULE_PATH):
        try:
            if path.exists():
                return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        except OSError:
            continue
    return datetime.now(timezone.utc)


def _calendar_feed_base_url():
    return f"{APP_BASE_URL}/api/calendar/feed"


def _build_calendar_ics_body(schedule, *, feed_url=None):
    streamer = str(schedule.get("streamerName") or LINKS_STREAMER_DISPLAY_NAME).strip()
    calendar_name = f"{streamer} 방송 일정" if streamer else "방송 일정"
    description = str(schedule.get("platformNote") or "").strip() or f"{calendar_name} 구독"
    return build_schedule_ics(
        schedule,
        calendar_name=calendar_name,
        calendar_description=description,
        feed_url=feed_url or _calendar_feed_base_url(),
    )


def write_calendar_ics(schedule=None, *, feed_url=None):
    """schedule.json 저장 직후 캘린더 구독 파일을 즉시 갱신."""
    ensure_data_dir()
    if schedule is None:
        with SCHEDULE_PATH.open(encoding="utf-8") as f:
            schedule = normalize_schedule(json.load(f))
    body = _build_calendar_ics_body(schedule, feed_url=feed_url)
    tmp = CALENDAR_ICS_PATH.with_suffix(".ics.tmp")
    with tmp.open("w", encoding="utf-8", newline="") as f:
        f.write(body)
    tmp.replace(CALENDAR_ICS_PATH)


def ensure_calendar_ics():
    """schedule.json보다 ICS가 오래됐으면 동기화."""
    ensure_data_dir()
    if not SCHEDULE_PATH.exists():
        return
    try:
        if CALENDAR_ICS_PATH.exists() and CALENDAR_ICS_PATH.stat().st_mtime >= SCHEDULE_PATH.stat().st_mtime:
            return
    except OSError:
        pass
    write_calendar_ics()


def _read_calendar_ics_body():
    ensure_calendar_ics()
    try:
        return CALENDAR_ICS_PATH.read_text(encoding="utf-8")
    except OSError:
        schedule = load_schedule()
        return _build_calendar_ics_body(schedule, feed_url=_calendar_feed_url())


def _ics_ascii_filename(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(name or "")).strip("._-")
    return cleaned or "calendar.ics"


def _ics_response(body: str, *, filename: str, subscribe: bool = True):
    payload = body.encode("utf-8")
    response = Response(payload, mimetype="text/calendar; charset=utf-8")
    disposition = "inline" if subscribe else "attachment"
    safe_filename = _ics_ascii_filename(filename)
    if not safe_filename.lower().endswith(".ics"):
        safe_filename = f"{safe_filename}.ics"
    response.headers["Content-Disposition"] = f'{disposition}; filename="{safe_filename}"'
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    response.headers["X-Content-Type-Options"] = "nosniff"
    last_modified = _ics_last_modified()
    response.headers["Last-Modified"] = last_modified.strftime("%a, %d %b %Y %H:%M:%S GMT")
    return response


def _calendar_feed_url():
    return absolute_request_url("api/calendar/feed")


def _calendar_ics_body():
    return _read_calendar_ics_body()


@app.route("/api/calendar/subscribe")
def api_calendar_subscribe():
    https_url = _calendar_feed_url()
    return jsonify(
        {
            "ok": True,
            "icsUrl": https_url,
            "webcalUrl": calendar_webcal_url(https_url),
            "refreshIntervalSec": 900,
            "hint": "Google/Apple 캘린더에서 URL 구독 시 같은 주소를 유지하면 서버 데이터가 갱신될 때 일정이 업데이트됩니다.",
        }
    )


def _render_calendar_ics():
    schedule = load_schedule()
    streamer = str(schedule.get("streamerName") or LINKS_STREAMER_DISPLAY_NAME).strip()
    body = _read_calendar_ics_body()
    safe_name = _ics_ascii_filename(streamer)
    subscribe = request.args.get("download", "0") not in {"1", "true", "yes"}
    return _ics_response(body, filename=safe_name, subscribe=subscribe)


@app.route("/api/calendar/feed")
@app.route("/api/calendar.ics")
@app.route("/calendar.ics")
def api_calendar_ics():
    try:
        return _render_calendar_ics()
    except Exception:
        app.logger.exception("calendar feed generation failed")
        return jsonify({"error": "ics_generation_failed"}), 500


@app.route("/sw.js")
def service_worker():
    resp = send_from_directory(BASE_DIR, "sw.js", mimetype="application/javascript")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp


@app.route("/")
def root_redirect():
    return redirect_to_calendar()


@app.route("/calendar")
def calendar_page():
    title, description = calendar_og_meta()
    return send_html_with_social("index.html", title=title, description=description)


@app.route("/schedule")
@app.route("/schedule/")
def schedule_legacy_redirect():
    return redirect_to_calendar()


@app.route("/index.html")
def index_html_redirect():
    return redirect_to_calendar()


@app.route("/musicbook")
def musicbook_page():
    title, description = musicbook_og_meta()
    return send_html_with_social("musicbook.html", title=title, description=description)


@app.route("/song-requests")
def song_requests_page():
    return send_html_with_social(
        "song-requests.html",
        title="노래책 신청",
        description="노래책에 아직 없는 곡을 신청할 수 있습니다. 검토 후 노래책에 반영됩니다. 로그인 후 제목·아티스트·유튜브 링크·언어를 입력해 주세요.",
    )


@app.route("/links")
def links_page():
    return redirect("/home", code=302)


@app.route("/home")
def home_page():
    title, description = home_og_meta()
    return send_html_with_social("links.html", title=title, description=description)


@app.route("/privacy")
def privacy_page():
    return send_html_page("privacy.html")


@app.route("/terms")
def terms_page():
    return send_html_page("terms.html")


@app.route("/api/patchnotes")
def api_patchnotes_get():
    data = load_patchnotes()
    developer = is_developer_user()
    normalized = normalize_patchnotes(data)
    all_blocks = normalized.get("blocks") or []
    visible_blocks = [block for block in all_blocks if block.get("items")]

    if developer:
        base = {**normalized, "updatedAt": utc_now(), "apiScope": "developer"}
    else:
        base = {"blocks": visible_blocks, "updatedAt": utc_now()}

    if request.args.get("all", "").lower() in ("1", "true", "yes"):
        if not developer:
            return jsonify({"error": "forbidden"}), 403
        return jsonify({**base, "blocks": all_blocks, "pagination": None})

    page = request.args.get("page", default=1, type=int) or 1
    per_page = request.args.get("per_page", default=PATCHNOTES_PER_PAGE_DEFAULT, type=int) or PATCHNOTES_PER_PAGE_DEFAULT
    per_page = max(1, min(per_page, PATCHNOTES_PER_PAGE_MAX))

    visible_blocks = sorted(visible_blocks, key=lambda b: str(b.get("date") or ""), reverse=True)
    page_blocks, pagination = _paginate_patchnotes_blocks(visible_blocks, page, per_page)
    return jsonify({**base, "blocks": page_blocks, "pagination": pagination})


@app.route("/api/patchnotes", methods=["PUT"])
@require_developer
def api_patchnotes_put():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "invalid_json"}), 400
    data = normalize_patchnotes(payload)
    save_patchnotes(data)
    return jsonify(
        {
            "ok": True,
            "updatedAt": utc_now(),
            "blockCount": len(data.get("blocks", [])),
        }
    )


@app.route("/patchnotes")
def patchnotes_page():
    title, description = patchnotes_og_meta()
    return send_html_with_social("patchnotes.html", title=title, description=description)


@app.route("/managers")
def managers_page():
    # 권한이 부족해도 안내 화면(게이트)을 보여주기 위해 HTML은 제공한다.
    # 실제 데이터 API는 @require_manage_managers로 보호되며, 프론트에서 "권한 필요"를 노출한다.
    return send_html_with_social("managers.html", title="매니저 관리", description="방송 일정 사이트 매니저 권한 관리")


@app.route("/admin")
def admin_page():
    return redirect("/calendar")


@app.route("/<path:path>")
def static_files(path):
    if path.startswith("api/"):
        return jsonify({"error": "not_found"}), 404
    normalized = path.replace("\\", "/")
    if "/.." in normalized or normalized.startswith("../"):
        return jsonify({"error": "not_found"}), 404
    if any(normalized.startswith(prefix) for prefix in _BLOCKED_STATIC_PREFIXES):
        return jsonify({"error": "not_found"}), 404
    name = Path(normalized).name
    if name in _BLOCKED_STATIC_NAMES or name.startswith(".env"):
        return jsonify({"error": "not_found"}), 404
    full = BASE_DIR / normalized
    if full.is_file():
        return send_from_directory(BASE_DIR, normalized)
    return jsonify({"error": "not_found"}), 404


def _load_dotenv():
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)


_load_dotenv()
apply_runtime_config()

try:
    ensure_calendar_ics()
except Exception:
    pass

if __name__ == "__main__":
    ensure_data_dir()
    ensure_calendar_ics()
    ensure_musicbook()
    ensure_song_requests()
    ensure_links()
    app.run(host="127.0.0.1", port=PORT, debug=True)
