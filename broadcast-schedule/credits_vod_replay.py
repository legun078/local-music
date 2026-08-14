"""VOD change_second 보정 — 수집기 부착 시각 vs 실제 방송/VOD 타임라인."""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from credits_store import KST, iter_raw_jsonl_events, parse_iso, raw_jsonl_path_for_session

SOOP_FETCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; sirian-credits/1.0)",
    "Accept": "application/json",
    "Referer": "https://www.sooplive.co.kr/",
}

_vod_review_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}
_vod_review_cache_lock = threading.Lock()
_VOD_REVIEW_HIT_TTL_SEC = 3600.0
_VOD_REVIEW_MISS_TTL_SEC = 300.0


def _vod_item_matches_broad(item: dict[str, Any], broad_no: str) -> bool:
    want = str(broad_no or "").strip()
    if not want:
        return False
    ucc = item.get("ucc") if isinstance(item.get("ucc"), dict) else {}
    thumb = str(ucc.get("thumb") or "")
    return f"_{want}_" in thumb or want in thumb


def _parse_reg_date_kst(raw: Any) -> datetime | None:
    text = str(raw or "").strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            naive = datetime.strptime(text, fmt)
            return naive.replace(tzinfo=KST)
        except ValueError:
            continue
    return None


def _vod_duration_sec(item: dict[str, Any]) -> float | None:
    ucc = item.get("ucc") if isinstance(item.get("ucc"), dict) else {}
    raw = ucc.get("total_file_duration")
    try:
        ms = float(raw)
    except (TypeError, ValueError):
        return None
    if ms <= 0:
        return None
    return ms / 1000.0


def fetch_vod_review_item(
    station_id: str,
    *,
    title_no: str | None = None,
    broad_no: str | None = None,
    max_pages: int = 5,
) -> dict[str, Any] | None:
    """chapi review 목록에서 VOD 상세(길이·등록 시각)를 가져온다."""
    sid = str(station_id or "").strip().lower()
    want_title = str(title_no or "").strip()
    want_broad = str(broad_no or "").strip()
    if not sid or (not want_title and not want_broad):
        return None

    cache_key = f"{sid}:{want_title or want_broad}"
    now = time.time()
    with _vod_review_cache_lock:
        cached = _vod_review_cache.get(cache_key)
        if cached and now - cached[0] < (_VOD_REVIEW_HIT_TTL_SEC if cached[1] else _VOD_REVIEW_MISS_TTL_SEC):
            return cached[1]

    found: dict[str, Any] | None = None
    for page in range(1, max(1, int(max_pages)) + 1):
        api_url = (
            f"https://chapi.sooplive.co.kr/api/{urllib.parse.quote(sid)}/vods/review"
            f"?page={page}&per_page=20&orderby=reg_date"
        )
        req = urllib.request.Request(api_url, headers=SOOP_FETCH_HEADERS)
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
            item_title = str(item.get("title_no") or "").strip()
            if want_title and item_title == want_title:
                found = item
                break
            if want_broad and _vod_item_matches_broad(item, want_broad):
                found = item
                break
        if found or len(rows) < 20:
            break

    with _vod_review_cache_lock:
        _vod_review_cache[cache_key] = (now, found)
        if len(_vod_review_cache) > 128:
            _vod_review_cache.pop(next(iter(_vod_review_cache)))
    return found


def raw_event_bounds(
    session: dict[str, Any] | None,
    raw_dir: Path,
) -> tuple[datetime | None, datetime | None]:
    """accepted raw 이벤트의 최초·최종 시각."""
    if not isinstance(session, dict):
        return None, None
    path = raw_jsonl_path_for_session(session, raw_dir)
    if path is None:
        return None, None
    first: datetime | None = None
    last: datetime | None = None
    for row in iter_raw_jsonl_events(path):
        if str(row.get("kind") or "").strip().lower() != "event":
            continue
        if str(row.get("status") or "").strip().lower() != "accepted":
            continue
        at = parse_iso(row.get("at"))
        if at is None:
            continue
        if first is None or at < first:
            first = at
        if last is None or at > last:
            last = at
    return first, last


def compute_vod_replay_alignment(
    session: dict[str, Any] | None,
    vod_item: dict[str, Any] | None,
    *,
    raw_dir: Path,
) -> dict[str, Any]:
    """종료된 VOD의 길이·등록 시각 + raw 이벤트로 change_second 보정값을 계산한다.

    session 기준 초(rawOffset)에 replayOffsetSec을 더해 VOD change_second로 변환:
      vodSec = sessionSec + replayOffsetSec
    """
    empty = {
        "replayOffsetSec": 0,
        "method": "none",
        "confidence": "none",
    }
    if not isinstance(session, dict) or bool(session.get("active")):
        return empty

    started = parse_iso(session.get("startedAt"))
    ended = parse_iso(session.get("endedAt"))
    if started is None or ended is None or ended <= started:
        return empty

    vod_duration = _vod_duration_sec(vod_item or {})
    if vod_duration is None or vod_duration <= 0:
        return empty

    first_event, last_event = raw_event_bounds(session, raw_dir)
    reg_date = _parse_reg_date_kst((vod_item or {}).get("reg_date"))

    # VOD 종료: 업로드(reg_date)가 세션 종료보다 이르면 VOD 파일 기준으로 사용
    vod_end = ended
    if reg_date is not None and reg_date < ended:
        vod_end = reg_date
    elif reg_date is not None and (reg_date - ended).total_seconds() <= 120:
        # 업로드가 종료 직후면 reg_date 쪽이 VOD 타임라인에 더 가깝다
        vod_end = reg_date

    vod_start = vod_end - timedelta(seconds=vod_duration)

    # 실제 방송 시작 ≈ VOD 시작과 첫 수집 이벤트 중 더 이른 시각
    broadcast_start = vod_start
    if first_event is not None and first_event < broadcast_start:
        broadcast_start = first_event

    replay_offset = int(round((started - broadcast_start).total_seconds()))

    session_dur = (ended - started).total_seconds()
    tail_slack = max(0.0, session_dur - vod_duration - max(0.0, (started - broadcast_start).total_seconds()))
    confidence = "high" if first_event is not None and reg_date is not None else "medium"

    return {
        "replayOffsetSec": replay_offset,
        "vodDurationSec": round(vod_duration, 3),
        "vodStartAt": vod_start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "vodEndAt": vod_end.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "broadcastStartAt": broadcast_start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "collectorStartedAt": started.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "firstEventAt": first_event.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if first_event
        else "",
        "lastEventAt": last_event.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if last_event
        else "",
        "sessionDurationSec": int(round(session_dur)),
        "tailSlackSec": int(round(tail_slack)),
        "method": "vod_reg_end_first_event",
        "confidence": confidence,
    }


def build_replay_context(
    session: dict[str, Any] | None,
    *,
    raw_dir: Path,
    fetch_review: Any = fetch_vod_review_item,
) -> dict[str, Any]:
    """dev-monitor replay 컨텍스트 — VOD title + seek 보정."""
    if not isinstance(session, dict):
        return {
            "stationId": "",
            "broadNo": "",
            "vodTitleNo": "",
            "startedAt": "",
            "endedAt": "",
            "active": False,
            "replayOffsetSec": 0,
        }

    sid = str(session.get("stationId") or "").strip().lower()
    broad_no = str(session.get("broadNo") or "").strip()
    active = bool(session.get("active"))
    vod_title_no = str(session.get("vodTitleNo") or "").strip()
    vod_item: dict[str, Any] | None = None

    cached = session.get("vodReplay")
    if isinstance(cached, dict) and not active:
        cached_title = str(cached.get("titleNo") or "").strip()
        if cached_title:
            vod_title_no = cached_title

    if not active and sid:
        if vod_title_no:
            vod_item = fetch_review(sid, title_no=vod_title_no)
        elif broad_no:
            vod_item = fetch_review(sid, broad_no=broad_no)
            if vod_item:
                vod_title_no = str(vod_item.get("title_no") or "").strip()

    alignment = compute_vod_replay_alignment(session, vod_item, raw_dir=raw_dir)

    ctx: dict[str, Any] = {
        "stationId": sid,
        "broadNo": broad_no,
        "vodTitleNo": vod_title_no,
        "startedAt": str(session.get("startedAt") or ""),
        "endedAt": str(session.get("endedAt") or ""),
        "active": active,
        "replayOffsetSec": int(alignment.get("replayOffsetSec") or 0),
    }
    if not active and alignment.get("method") not in (None, "none"):
        ctx["alignment"] = alignment
    return ctx
