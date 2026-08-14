"""방종 크레딧 세션 저장·집계.

공식 Chat SDK는 실시간만 제공(소급 조회 없음). 수집기는 방송 중 connect 이후
이벤트를 ingest하고, 이 모듈이 엔딩 순위로 집계한다.

집계 action (실시간 파이프라인 — 소급 API 아님):
  채팅: MESSAGE, MANAGER_MESSAGE, CHAT (+ userStatus 플래그, OGQ 이모티콘)
  구독 시그니처 이모: `/제목/` (BJ signature_emoticon_api.php 등록분만)
  병풍(접속 시간): IN, JOIN, OUT, QUIT → 오버레이에서는 「시청 시간」
  후원: BALLOON_*/STICKER/DONATION (+ fanNumber·becomesTopFan 힌트)
  열혈: userStatus.isTopFan 스티키 보유 + 재확인으로 승급/해제 감지
    (becomesTopFan 단발은 힌트만 — 실제 변화는 연속 관측으로 확정)
  구독: SUBSCRIBED, SUBSCRIPTION_RENEWED, SUBSCRIPTION_GIFTED
  퀵뷰·미션·선물: QUICKVIEW_GIFTED, *_MISSION_GIFTED, OGQ_EMOTICON_GIFTED, GEM_GIFTED
  미션 보조: SSAPI_MISSION (제목·key·결과만. 후원 수량은 SDK가 집계)
  후원 텍스트 보조: SSAPI_DONATION (별풍 메시지. 수량 집계는 SDK)
  메타: station 라이브 폴링(isLive/title/viewerCount)
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

_lock = threading.RLock()
_poller_started = False
_poller_stop = threading.Event()

# OBS+수집기 동시 수집 시 같은 이벤트 이중 집계 방지
INGEST_DEDUP_TTL_MS = 8_000
INGEST_DEDUP_BUCKET_MS = 2_000
_INGEST_DEDUP: dict[str, dict[str, float]] = {}  # station -> {fingerprint: seen_ts_ms}

# 방종 직후 크레딧 재생 중 늦게 도착한 후원·채팅을 버릴지 여부
ENDED_INGEST_GRACE_SEC = 15 * 60
# 한 번에 채울 팬클럽 번호 갭 상한 (오탐 거대 번호 방어)
FANCLUB_GAP_FILL_MAX = 30

# 열혈(isTopFan) 스티키 상태: 단발 노이즈를 버리고 연속 관측으로만 전환
TOPFAN_PROMOTE_CONFIRM = 2  # known False → True (또는 승급 힌트 확정)
TOPFAN_DEMOTE_CONFIRM = 3  # known True → False

# 방제: 연속 N회 + 최소 유지 시간 후 titleHistory 커밋 (폴링·chapi 깜빡임 차단)
TITLE_CONFIRM_N = 3
try:
    TITLE_CONFIRM_MIN_MS = max(0, int(os.environ.get("CREDITS_TITLE_CONFIRM_MIN_MS", "45000")))
except (TypeError, ValueError):
    TITLE_CONFIRM_MIN_MS = 45_000

# chapi broad_title에 섞이는 SOOP BJ 상태 문구 — 방제 타임라인에서 제외
_BJ_STATUS_TITLES = frozenset(
    {
        "업무를 처리하고 있습니다.",
        "식사합니다.",
        "잠시 자리를 비웠습니다.",
        "잠시 자리 비움",
        "휴식 중입니다.",
        "휴식중입니다.",
        "방송 준비 중입니다.",
        "방송 준비중입니다.",
    }
)

# OUT 확정: 킥·(N)슬롯 제외. pending 후 무활동이면 퇴장 확정
PRESENCE_LEAVE_CONFIRM_MS = 60_000

# 채팅 2시간+ 무활동: 시청 시간을 마지막 채팅 시점에서 중단 (재채팅 시 구간 복원)
CHAT_WATCH_GAP_MS = 2 * 60 * 60 * 1000


def effective_watch_end_ms(row: dict[str, Any] | None, end_ms: float) -> float:
    """채팅 공백이 CHAT_WATCH_GAP_MS 이상이면 시청 구간 종료를 마지막 채팅으로."""
    if not isinstance(row, dict):
        return end_ms
    last_chat = float(row.get("lastChatAtMs") or 0)
    if last_chat <= 0:
        return end_ms
    if float(end_ms) - last_chat >= float(CHAT_WATCH_GAP_MS):
        return last_chat
    return end_ms


def dedupe_subscription_lists(session: dict[str, Any]) -> bool:
    """연속 구독자는 신규 구독 목록에서 제거 (수동 보정·이중 이벤트 방어)."""
    subs = session.get("subscribers")
    renewals = session.get("subscriberRenewals")
    if not isinstance(subs, list) or not isinstance(renewals, list):
        return False
    renew_ids = {
        str(r.get("userId") or "").strip()
        for r in renewals
        if isinstance(r, dict) and str(r.get("userId") or "").strip()
    }
    if not renew_ids:
        return False
    kept = [
        s
        for s in subs
        if isinstance(s, dict) and str(s.get("userId") or "").strip() not in renew_ids
    ]
    if len(kept) == len(subs):
        return False
    session["subscribers"] = kept
    return True


def atomic_write_json(path: Path, data: dict) -> None:
    """고유 tmp + 파일 flock. 고정 .tmp 동시 rename/깨짐 방지 (프로세스 간 포함)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(f"{path.name}.lock")
    lock_fd: int | None = None
    tmp_name: str | None = None
    try:
        lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)
        try:
            import fcntl

            fcntl.flock(lock_fd, fcntl.LOCK_EX)
        except (ImportError, OSError):
            pass
        fd, tmp_name = tempfile.mkstemp(
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=str(path.parent),
        )
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        Path(tmp_name).replace(path)
        tmp_name = None
    finally:
        if tmp_name:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
        if lock_fd is not None:
            try:
                import fcntl

                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            except (ImportError, OSError):
                pass
            try:
                os.close(lock_fd)
            except OSError:
                pass

# 디버그용 원본·중간 백업 (오류 추적). 세션 집계와 분리 보관.
try:
    CREDITS_BACKUP_INTERVAL_SEC = max(
        60, int(os.environ.get("CREDITS_BACKUP_INTERVAL_SEC", "300"))
    )
except (TypeError, ValueError):
    CREDITS_BACKUP_INTERVAL_SEC = 300
try:
    CREDITS_BACKUP_RETENTION_DAYS = max(
        1, int(os.environ.get("CREDITS_BACKUP_RETENTION_DAYS", "7"))
    )
except (TypeError, ValueError):
    CREDITS_BACKUP_RETENTION_DAYS = 7
try:
    CREDITS_RAW_RETENTION_DAYS = max(
        1, int(os.environ.get("CREDITS_RAW_RETENTION_DAYS", "14"))
    )
except (TypeError, ValueError):
    CREDITS_RAW_RETENTION_DAYS = 14
CREDITS_RAW_MESSAGE_MAX = 2_000
CREDITS_BACKUP_MAX_PER_DAY = 120


def sanitize_raw_message(msg: Any) -> Any:
    """원본 메시지 보관용 — 과도한 문자열만 자른다."""
    if not isinstance(msg, dict):
        return msg
    out: dict[str, Any] = {}
    for key, val in msg.items():
        if isinstance(val, str) and len(val) > CREDITS_RAW_MESSAGE_MAX:
            out[key] = val[:CREDITS_RAW_MESSAGE_MAX] + "…"
        elif isinstance(val, dict):
            out[key] = sanitize_raw_message(val)
        elif isinstance(val, list) and len(val) > 50:
            out[key] = val[:50]
            out[f"{key}__truncated"] = len(val)
        else:
            out[key] = val
    return out



def _msg_field(msg: dict[str, Any], *keys: str) -> str:
    for key in keys:
        val = msg.get(key)
        if val is None:
            continue
        text = str(val).strip()
        if text:
            return text
    return ""


# Chat SDK가 같은 계정을 naivelia / naivelia(2) 로 나눠 보내는 경우 → 본 ID로 합침
_SOOP_UID_ALIAS_RE = re.compile(r"^(?P<base>.+)\((?P<n>\d+)\)$")


def normalize_soop_user_id(uid: str) -> str:
    """SOOP userId 별칭 접미사 `(N)` 제거."""
    text = str(uid or "").strip()
    if not text:
        return ""
    while True:
        m = _SOOP_UID_ALIAS_RE.match(text)
        if not m:
            break
        base = str(m.group("base") or "").strip()
        if not base or base == text:
            break
        text = base
    return text


def raw_uid_is_refresh_slot(uid: str) -> bool:
    """`userId(N)` 형태 — 새로고침/슬롯 재할당 OUT. 본인 퇴장이 아님."""
    return bool(_SOOP_UID_ALIAS_RE.match(str(uid or "").strip()))


def _merge_count_rows(dst: dict[str, Any], src: dict[str, Any], *, count_keys: tuple[str, ...]) -> dict[str, Any]:
    out = dict(dst)
    src_name = str(src.get("name") or "").strip()
    if src_name:
        out["name"] = src_name
    for key in count_keys:
        out[key] = int(out.get(key) or 0) + int(src.get(key) or 0)
    if "maxSingle" in dst or "maxSingle" in src:
        out["maxSingle"] = max(int(dst.get("maxSingle") or 0), int(src.get("maxSingle") or 0))
    if "total" in dst or "total" in src:
        out["total"] = int(dst.get("total") or 0) + int(src.get("total") or 0)
    joined_vals = [float(x) for x in (dst.get("joinedAt"), src.get("joinedAt")) if float(x or 0) > 0]
    if joined_vals:
        out["joinedAt"] = min(joined_vals)
    last_vals = [float(x) for x in (dst.get("lastSeenAt"), src.get("lastSeenAt")) if float(x or 0) > 0]
    if last_vals:
        out["lastSeenAt"] = max(last_vals)
    # 한쪽이라도 아직 시청 중이면 leftAt=0
    left_d = float(dst.get("leftAt") or 0)
    left_s = float(src.get("leftAt") or 0)
    if left_d <= 0 or left_s <= 0:
        out["leftAt"] = 0
    else:
        out["leftAt"] = max(left_d, left_s)
    if "items" in dst or "items" in src:
        items = list(dst.get("items") or []) if isinstance(dst.get("items"), list) else []
        extra = src.get("items") if isinstance(src.get("items"), list) else []
        for it in extra:
            if it not in items and len(items) < 20:
                items.append(it)
        out["items"] = items
    return out


def _coalesce_user_keyed_dict(
    mapping: dict[str, Any],
    *,
    count_keys: tuple[str, ...] = ("count",),
) -> bool:
    if not isinstance(mapping, dict):
        return False
    changed = False
    for key in list(mapping.keys()):
        base = normalize_soop_user_id(key)
        if not base or base == key:
            continue
        src = mapping.pop(key, None)
        changed = True
        if not isinstance(src, dict):
            continue
        dst = mapping.get(base)
        if isinstance(dst, dict):
            mapping[base] = _merge_count_rows(dst, src, count_keys=count_keys)
        else:
            mapping[base] = src
    return changed


def _coalesce_user_list(rows: list[Any], *, id_key: str = "userId") -> bool:
    if not isinstance(rows, list):
        return False
    changed = False
    seen: set[str] = set()
    out: list[Any] = []
    for row in rows:
        if not isinstance(row, dict):
            out.append(row)
            continue
        raw = str(row.get(id_key) or "").strip()
        uid = normalize_soop_user_id(raw)
        item = row
        if uid and uid != raw:
            item = dict(row)
            item[id_key] = uid
            changed = True
        if uid:
            if uid in seen:
                changed = True
                continue
            seen.add(uid)
        out.append(item)
    if changed:
        rows[:] = out
    return changed


def _coalesce_amount_hit_users(bucket: dict[str, Any]) -> bool:
    changed = False
    for hit in bucket.values():
        if not isinstance(hit, dict):
            continue
        users = hit.get("users")
        if isinstance(users, dict) and _coalesce_user_keyed_dict(users, count_keys=("count",)):
            changed = True
    return changed


def _merge_identity_flag_rows(dst: dict[str, Any], src: dict[str, Any]) -> dict[str, Any]:
    out = dict(dst)
    src_name = str(src.get("name") or "").strip()
    if src_name:
        out["name"] = src_name
    for key in ("isFan", "isTopFan", "isFollower", "isManager", "isSupporter", "isBJ"):
        if bool(dst.get(key)) or bool(src.get(key)):
            out[key] = True
        elif key in dst or key in src:
            out[key] = bool(dst.get(key)) or bool(src.get(key))
    return out


def _topfan_tracker_row(tracker: dict[str, Any], uid: str, uname: str) -> dict[str, Any]:
    row = tracker.get(uid) if isinstance(tracker.get(uid), dict) else None
    if not row:
        row = {
            "name": uname or uid,
            "known": None,
            "pending": None,
            "streak": 0,
            "promoteHint": False,
            "lastAt": "",
        }
        tracker[uid] = row
    if uname:
        row["name"] = uname
    return row


def hydrate_topfan_tracker(
    tracker: dict[str, Any],
    flags: dict[str, Any],
    top_fans: list[Any],
) -> None:
    """기존 identityFlags·topFans로 트래커 시드(재시작 시 전원 재승급 방지)."""
    if not isinstance(tracker, dict):
        return
    for uid, frow in (flags or {}).items():
        if not isinstance(frow, dict) or "isTopFan" not in frow:
            continue
        base = normalize_soop_user_id(str(uid or "").strip())
        if not base:
            continue
        row = _topfan_tracker_row(
            tracker, base, str(frow.get("name") or base).strip()[:40]
        )
        if row.get("known") is None:
            row["known"] = bool(frow.get("isTopFan"))
            row["pending"] = None
            row["streak"] = 0
    for item in top_fans or []:
        if not isinstance(item, dict):
            continue
        base = normalize_soop_user_id(str(item.get("userId") or "").strip())
        if not base:
            continue
        row = _topfan_tracker_row(
            tracker, base, str(item.get("name") or base).strip()[:40]
        )
        # 승급 명단에 있으면 당시엔 열혈이었음 — known 미정이면 True로 시드
        if row.get("known") is None:
            row["known"] = True
            row["pending"] = None
            row["streak"] = 0


def observe_topfan(
    tracker: dict[str, Any],
    flags: dict[str, Any],
    top_fans: list[Any],
    uid: str,
    uname: str,
    *,
    observed: bool | None,
    ts: str,
    promote_hint: bool = False,
) -> None:
    """열혈 등급 스티키 보유 + 재확인으로만 승급/해제.

    핵심: 승급(topFans)은 **이 세션에서 비열혈(known=False)로 확인된 뒤**
    True로 바뀔 때만. 이미 열혈인 사람의 becomesTopFan 오탐·첫 관측 True는
    기준선만 잡고 신규 열혈에 넣지 않는다.
    """
    if not uid:
        return
    if observed is None and not promote_hint:
        return

    row = _topfan_tracker_row(tracker, uid, uname)
    row["lastAt"] = ts or row.get("lastAt") or ""
    if promote_hint:
        row["promoteHint"] = True
        if observed is None:
            observed = True

    assert observed is not None
    known = row.get("known")

    def sync_flag(is_top: bool) -> None:
        frow = flags.get(uid) if isinstance(flags.get(uid), dict) else None
        if not frow:
            frow = {"name": uname or uid}
            flags[uid] = frow
        if uname:
            frow["name"] = uname
        frow["isTopFan"] = bool(is_top)

    def note_promote() -> None:
        if any(isinstance(r, dict) and r.get("userId") == uid for r in top_fans):
            return
        top_fans.append({"userId": uid, "name": uname or uid, "at": ts})

    # known 미정: True(채팅·becomesTopFan 힌트 포함) → 이미 열혈 기준선, 승급 금지
    if known is None:
        if observed is True:
            row["known"] = True
            row["pending"] = None
            row["streak"] = 0
            row["promoteHint"] = False
            sync_flag(True)
            return
        # False는 한 번에 기준선으로 확정하지 않음(깜빡임 → 이후 승급 오탐 방지)
        pending = row.get("pending")
        if pending is False:
            row["streak"] = int(row.get("streak") or 0) + 1
        else:
            row["pending"] = False
            row["streak"] = 1
        if int(row.get("streak") or 0) >= TOPFAN_PROMOTE_CONFIRM:
            row["known"] = False
            row["pending"] = None
            row["streak"] = 0
            row["promoteHint"] = False
            sync_flag(False)
        return

    known_b = bool(known)
    if observed == known_b:
        row["pending"] = None
        row["streak"] = 0
        if known_b:
            row["promoteHint"] = False
        sync_flag(known_b)
        return

    # 관측이 known 과 다름 → 연속 재확인
    pending = row.get("pending")
    if pending is observed:
        row["streak"] = int(row.get("streak") or 0) + 1
    else:
        row["pending"] = observed
        row["streak"] = 1

    need = TOPFAN_PROMOTE_CONFIRM if observed else TOPFAN_DEMOTE_CONFIRM
    # known=False 일 때만 승급 힌트로 확정 가속 (이미 열혈 known=True 에는 무의미)
    effective = int(row.get("streak") or 0)
    if observed and (not known_b) and row.get("promoteHint"):
        effective += 1
    if effective < need:
        return

    row["known"] = bool(observed)
    row["pending"] = None
    row["streak"] = 0
    row["promoteHint"] = False
    sync_flag(bool(observed))
    if observed and not known_b:
        note_promote()


def apply_station_balloon_top(
    session: dict[str, Any],
    rows: list[Any] | None,
) -> bool:
    """방송국 별풍 TOP20 → 열혈 트래커 시드(이미 열혈). 신규 승급 목록에는 넣지 않음.

    user_id 기준으로 맞추므로 구독닉(ø…) 표시 차이와 무관하다.
    반환: 세션이 바뀌었으면 True.
    """
    if not isinstance(session, dict):
        return False
    if not isinstance(rows, list) or not rows:
        return False

    tracker = session.setdefault("topFanTracker", {})
    if not isinstance(tracker, dict):
        tracker = {}
        session["topFanTracker"] = tracker
    flags = session.setdefault("identityFlags", {})
    if not isinstance(flags, dict):
        flags = {}
        session["identityFlags"] = flags

    cleaned: list[dict[str, str]] = []
    changed = False
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        uid = normalize_soop_user_id(
            str(
                raw.get("userId")
                or raw.get("user_id")
                or raw.get("id")
                or ""
            ).strip()
        )
        if not uid:
            continue
        name = str(
            raw.get("name")
            or raw.get("userNickname")
            or raw.get("user_nick")
            or raw.get("nickname")
            or uid
        ).strip()[:40] or uid
        cleaned.append({"userId": uid, "name": name})

        row = _topfan_tracker_row(tracker, uid, name)
        prev_known = row.get("known")
        # TOP20 = 이미 열혈급. False/None 이어도 승급 없이 True로만 맞춘다.
        if prev_known is not True:
            row["known"] = True
            row["pending"] = None
            row["streak"] = 0
            changed = True
        if row.get("promoteHint"):
            row["promoteHint"] = False
            changed = True
        if name and row.get("name") != name:
            row["name"] = name
            changed = True

        frow = flags.get(uid) if isinstance(flags.get(uid), dict) else None
        if not frow:
            frow = {"name": name}
            flags[uid] = frow
            changed = True
        if name and frow.get("name") != name:
            frow["name"] = name
            changed = True
        if not frow.get("isTopFan"):
            frow["isTopFan"] = True
            changed = True

    prev = session.get("stationBalloonTop")
    if cleaned and cleaned != prev:
        session["stationBalloonTop"] = cleaned
        session["stationBalloonTopAt"] = utc_now_iso()
        changed = True
    return changed


def coalesce_session_user_aliases(session: dict[str, Any]) -> bool:
    """세션 안 userId(N) 별칭을 본 ID로 합친다. 변경 있으면 True."""
    if not isinstance(session, dict):
        return False
    changed = False
    for key, count_keys in (
        ("chatters", ("count", "watchedMs")),
        ("donations", ("count",)),
        ("emoticons", ("count", "gifts")),
        ("quickviews", ("count",)),
        ("missions", ("count",)),
        ("gems", ("count",)),
    ):
        mapping = session.get(key)
        if isinstance(mapping, dict) and _coalesce_user_keyed_dict(mapping, count_keys=count_keys):
            changed = True
    flags = session.get("identityFlags")
    if isinstance(flags, dict):
        for key in list(flags.keys()):
            base = normalize_soop_user_id(key)
            if not base or base == key:
                continue
            src = flags.pop(key, None)
            changed = True
            if not isinstance(src, dict):
                continue
            dst = flags.get(base)
            flags[base] = (
                _merge_identity_flag_rows(dst, src) if isinstance(dst, dict) else src
            )
    for key in ("fanclubJoins", "topFans", "subscribers", "subscriberRenewals"):
        rows = session.get(key)
        if isinstance(rows, list) and _coalesce_user_list(rows):
            changed = True
    tracker = session.get("topFanTracker")
    if isinstance(tracker, dict):
        for key in list(tracker.keys()):
            base = normalize_soop_user_id(key)
            if not base or base == key:
                continue
            src = tracker.pop(key, None)
            changed = True
            if not isinstance(src, dict):
                continue
            dst = tracker.get(base)
            if isinstance(dst, dict):
                # known True 우선, promoteHint OR
                if src.get("name") and not dst.get("name"):
                    dst["name"] = src.get("name")
                if dst.get("known") is None and src.get("known") is not None:
                    dst["known"] = src.get("known")
                elif src.get("known") is True:
                    dst["known"] = True
                dst["promoteHint"] = bool(dst.get("promoteHint")) or bool(
                    src.get("promoteHint")
                )
            else:
                tracker[base] = src
    gifts = session.get("subscriptionGifts")
    if isinstance(gifts, list) and _coalesce_user_list(gifts):
        changed = True
    for key in ("amountHits", "signatureHits"):
        bucket = session.get(key)
        if isinstance(bucket, dict) and _coalesce_amount_hit_users(bucket):
            changed = True
    return changed


def ingest_event_fingerprint(
    action: str,
    msg: dict[str, Any],
    *,
    ts_ms: float,
) -> str:
    """내용 기반 지문. 클라이언트 at 시각은 소스마다 달라서 버킷만 씀."""
    act = str(action or "").strip().upper()
    bucket = int(ts_ms // INGEST_DEDUP_BUCKET_MS)
    user = normalize_soop_user_id(_msg_field(msg, "userId", "user_id", "id"))
    text = _msg_field(msg, "message", "comment", "text")[:100]
    count = _msg_field(msg, "count", "balloon", "balloonCount", "amount", "value")
    emo = _msg_field(msg, "ogqId", "ogq_id", "ogqNumber", "ogq_number", "itemName", "item_name")
    img = _msg_field(msg, "imageUrl", "image_url")[:80]
    fan = _msg_field(msg, "fanNumber", "fan_number")
    sub = _msg_field(
        msg,
        "subscriptionMonths",
        "accSubscriptionMonths",
        "tier",
        "type",
    )
    recv = normalize_soop_user_id(
        _msg_field(
            msg,
            "receiverId",
            "receiver_id",
            "toUserId",
            "to_user_id",
            "targetUserId",
            "giftedUserId",
        )
    )
    mission_key = _msg_field(msg, "key", "mission_key", "missionKey")
    mission_phase = _msg_field(msg, "mission_phase", "missionPhase", "phase")
    # 입장/퇴장 목록은 정렬해 동일 배치가 같은 키가 되게
    user_list = msg.get("userList") if isinstance(msg.get("userList"), list) else None
    if user_list:
        ids = sorted(
            {
                normalize_soop_user_id(str(u.get("userId") or u.get("id") or "").strip())
                for u in user_list
                if isinstance(u, dict)
            }
            - {""}
        )
        list_key = ",".join(ids[:40])
    else:
        list_key = ""
    return "|".join(
        [
            act,
            user,
            text,
            count,
            emo,
            img,
            fan,
            sub,
            recv,
            list_key,
            mission_key,
            mission_phase,
            str(bucket),
        ]
    )


def _ingest_dedup_check(station_id: str, fingerprint: str, now_ms: float) -> bool:
    """이미 본 지문이면 True (중복)."""
    sid = str(station_id or "").strip().lower() or "_default"
    bucket = _INGEST_DEDUP.setdefault(sid, {})
    cutoff = now_ms - INGEST_DEDUP_TTL_MS
    if len(bucket) > 400:
        stale = [k for k, t in bucket.items() if t < cutoff]
        for k in stale:
            bucket.pop(k, None)
    prev = bucket.get(fingerprint)
    return prev is not None and prev >= cutoff


def _ingest_dedup_mark(station_id: str, fingerprint: str, now_ms: float) -> None:
    sid = str(station_id or "").strip().lower() or "_default"
    _INGEST_DEDUP.setdefault(sid, {})[fingerprint] = now_ms


KST = timezone(timedelta(hours=9))

# 위플랩 alertsign 기본값과 동일 — 등록 개수가 없을 때 이 개수 이상 1회 후원을 시그니처로 집계
try:
    SIGNATURE_MIN = max(1, int(os.environ.get("CREDITS_SIGNATURE_MIN", "100")))
except (TypeError, ValueError):
    SIGNATURE_MIN = 100


def parse_signature_amounts(raw: Any) -> list[int]:
    """시그니처로 등록할 별풍 개수 목록. 빈 목록이면 SIGNATURE_MIN 이상 폴백."""
    out: list[int] = []
    seen: set[int] = set()
    if isinstance(raw, str):
        parts = re.split(r"[,，\s]+", raw.strip()) if raw.strip() else []
        raw_list = parts
    elif isinstance(raw, (list, tuple)):
        raw_list = list(raw)
    else:
        raw_list = []
    for item in raw_list:
        try:
            n = int(item)
        except (TypeError, ValueError):
            continue
        if n < 1 or n > 1_000_000 or n in seen:
            continue
        seen.add(n)
        out.append(n)
    out.sort()
    return out


def _signature_item_hits(item: dict[str, Any]) -> int:
    """시그니처 row의 터진 횟수 — value '12번' 또는 hits 필드."""
    try:
        if item.get("hits") is not None:
            return max(0, int(item.get("hits") or 0))
    except (TypeError, ValueError):
        pass
    raw = str(item.get("value") or "")
    digits = re.sub(r"[^\d]", "", raw)
    try:
        return int(digits) if digits else 0
    except ValueError:
        return 0


def build_signature_items(
    hits: dict[str, Any] | None,
    amounts: list[int] | None = None,
    image_by_amount: dict[int, str] | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """amountHits → 상위 5 + 5위 밖 시그풍 합계 횟수(moreHits)."""
    rows_in = hits if isinstance(hits, dict) else {}
    allowed = set(amounts or [])
    img_map = image_by_amount if isinstance(image_by_amount, dict) else {}
    items: list[dict[str, Any]] = []
    for _key, row in rows_in.items():
        if not isinstance(row, dict):
            continue
        try:
            value = int(row.get("value") or 0)
            hits_n = int(row.get("count") or 0)
        except (TypeError, ValueError):
            continue
        if value < 1 or hits_n <= 0:
            continue
        if allowed:
            if value not in allowed:
                continue
        elif value < SIGNATURE_MIN:
            continue

        donors: list[tuple[int, str]] = []
        users = row.get("users") if isinstance(row.get("users"), dict) else {}
        for _uid, urow in users.items():
            if not isinstance(urow, dict):
                continue
            try:
                ucount = int(urow.get("count") or 0)
            except (TypeError, ValueError):
                ucount = 0
            if ucount <= 0:
                continue
            uname = str(urow.get("name") or "").strip()
            if not uname:
                continue
            donors.append((ucount, uname))
        donors.sort(key=lambda x: (-x[0], x[1]))
        top_donor = donors[0][1] if donors else ""
        top_donor_hits = int(donors[0][0]) if donors else 0
        more_people = max(0, len(donors) - 1) if donors else 0
        image_url = str(img_map.get(value) or row.get("imageUrl") or "").strip()

        items.append(
            {
                "valueNum": value,
                "hits": hits_n,
                "name": f"{value:,}개",
                "value": f"{hits_n}번",
                "topDonor": top_donor,
                "topDonorHits": top_donor_hits,
                "morePeople": more_people,
                "imageUrl": image_url,
            }
        )
    items.sort(key=lambda x: (-x["hits"], -x["valueNum"]))
    more_hits = sum(int(x.get("hits") or 0) for x in items[5:])
    out: list[dict[str, Any]] = []
    for i, item in enumerate(items[:5], start=1):
        row = dict(item)
        row["rank"] = i
        row.pop("valueNum", None)
        row.pop("hits", None)
        out.append(row)
    return out, more_hits


def apply_signature_amounts_to_payload(
    payload: dict[str, Any],
    amounts: list[int] | None,
) -> dict[str, Any]:
    """이미 만들어진 credits payload의 시그니처 섹션만 등록 개수에 맞게 다시 필터."""
    if not isinstance(payload, dict):
        return payload
    out = dict(payload)
    sections = out.get("sections")
    if not isinstance(sections, list):
        return out
    parsed = parse_signature_amounts(amounts) if amounts is not None else []
    allowed = set(parsed)
    new_sections = []
    for sec in sections:
        if not isinstance(sec, dict) or sec.get("id") != "signature":
            new_sections.append(sec)
            continue
        items_in = sec.get("items") if isinstance(sec.get("items"), list) else []
        filtered: list[dict[str, Any]] = []
        for it in items_in:
            if not isinstance(it, dict):
                continue
            name = str(it.get("name") or "")
            digits = re.sub(r"[^\d]", "", name)
            try:
                value = int(digits) if digits else 0
            except ValueError:
                value = 0
            if allowed:
                if value not in allowed:
                    continue
            elif value < SIGNATURE_MIN:
                continue
            filtered.append(dict(it))
        filtered.sort(
            key=lambda it: (
                -_signature_item_hits(it),
                -int(re.sub(r"[^\d]", "", str(it.get("name") or "")) or 0),
            )
        )
        if len(filtered) > 5:
            more_hits = sum(_signature_item_hits(it) for it in filtered[5:])
        elif len(filtered) == len(items_in):
            # 개수 필터로 빠진 행 없음 → 서버가 이미 자른 moreHits 유지
            try:
                more_hits = max(0, int(sec.get("moreHits") or 0))
            except (TypeError, ValueError):
                more_hits = 0
        else:
            # 등록 개수로 일부가 걸러짐 → 5위 밖 합계는 재계산 불가, 표시 안 함
            more_hits = 0
        top = filtered[:5]
        for i, it in enumerate(top, start=1):
            it["rank"] = i
        new_sections.append(
            {
                **sec,
                "items": top,
                "moreHits": more_hits,
                "pending": bool(sec.get("pending")) and not filtered,
            }
        )
    out["sections"] = new_sections
    return out


CHAT_ACTIONS = frozenset({"MESSAGE", "MANAGER_MESSAGE", "CHAT"})
PRESENCE_JOIN = frozenset({"IN", "JOIN"})
PRESENCE_LEAVE = frozenset({"OUT", "QUIT"})
# 채팅 직후 OUT — 새로고침·중복 슬롯(dlpa37(2)) 정리로 보고 퇴장 무시
REFRESH_OUT_GRACE_MS = 120_000
DONATION_ACTIONS = frozenset(
    {
        "BALLOON_GIFTED",
        "ADBALLOON_GIFTED",
        "VIDEOBALLOON_GIFTED",
        "STICKER_GIFTED",
        "DONATION",
    }
)
# 일기장 풍선 시계열 — 별풍/애드벌룬/영상별풍만 (스티커·기타 후원 제외)
BALLOON_SERIES_ACTIONS = frozenset(
    {
        "BALLOON_GIFTED",
        "ADBALLOON_GIFTED",
        "VIDEOBALLOON_GIFTED",
    }
)
_METRICS_SERIES_MAX_POINTS = 800
SUBSCRIBE_NEW = frozenset({"SUBSCRIBED"})
SUBSCRIBE_RENEW = frozenset({"SUBSCRIPTION_RENEWED"})
SUBSCRIBE_GIFT = frozenset({"SUBSCRIPTION_GIFTED"})
QUICKVIEW_ACTIONS = frozenset({"QUICKVIEW_GIFTED"})
MISSION_GIFT_ACTIONS = frozenset(
    {
        "BATTLE_MISSION_GIFTED",
        "CHALLENGE_MISSION_GIFTED",
        "CHALLENGE_GIFT",
    }
)
MISSION_FINISH_ACTIONS = frozenset(
    {
        "BATTLE_MISSION_FINISHED",
        "CHALLENGE_MISSION_FINISHED",
    }
)
MISSION_SETTLE_ACTIONS = frozenset(
    {
        "BATTLE_MISSION_SETTLED",
        "CHALLENGE_MISSION_SETTLED",
    }
)
MISSION_FANLIST_ACTIONS = frozenset(
    {
        "CHALLENGE_MISSION_SETTLED_FANLIST",
        "CHALLENGE_MISSION_SPONSORS",
    }
)
SSAPI_MISSION_ACTION = "SSAPI_MISSION"
SSAPI_DONATION_ACTION = "SSAPI_DONATION"
MISSION_LIFECYCLE_ACTIONS = (
    MISSION_GIFT_ACTIONS
    | MISSION_FINISH_ACTIONS
    | MISSION_SETTLE_ACTIONS
    | MISSION_FANLIST_ACTIONS
    | {SSAPI_MISSION_ACTION}
)
OGQ_GIFT_ACTIONS = frozenset({"OGQ_EMOTICON_GIFTED"})
GEM_ACTIONS = frozenset({"GEM_GIFTED"})

INGEST_TRACKED_ACTIONS = (
    CHAT_ACTIONS
    | PRESENCE_JOIN
    | PRESENCE_LEAVE
    | DONATION_ACTIONS
    | SUBSCRIBE_NEW
    | SUBSCRIBE_RENEW
    | SUBSCRIBE_GIFT
    | QUICKVIEW_ACTIONS
    | MISSION_LIFECYCLE_ACTIONS
    | {SSAPI_DONATION_ACTION}
    | OGQ_GIFT_ACTIONS
    | GEM_ACTIONS
)
DONATION_NOTES_MAX = 800
SSAPI_FEED_MAX = 200

MISSION_STATUS_LABELS = {
    "pending": "보류",
    "success": "성공",
    "fail": "실패",
    "draw": "무승부",
    "unknown": "결과 미수집",
}
MISSION_KIND_LABELS = {
    "challenge": "도전",
    "battle": "대결",
}


def mission_kind_from_action(action: str) -> str:
    key = str(action or "").strip().upper()
    if key.startswith("BATTLE_"):
        return "battle"
    return "challenge"


def mission_status_label(status: str) -> str:
    key = str(status or "").strip().lower()
    return MISSION_STATUS_LABELS.get(key, MISSION_STATUS_LABELS["pending"])


def mission_kind_label(kind: str) -> str:
    key = str(kind or "").strip().lower()
    return MISSION_KIND_LABELS.get(key, "미션")


def _mission_title_from_msg(msg: dict[str, Any] | None) -> str:
    if not isinstance(msg, dict):
        return ""
    for key in ("title", "missionTitle", "missionName", "name"):
        title = str(msg.get(key) or "").strip()
        if title and key != "name":
            return title[:80]
    return ""


def _normalize_mission_status(raw: Any, *, is_draw: Any = None) -> str:
    if is_draw is True:
        return "draw"
    key = str(raw or "").strip().upper()
    if key in {"SUCCESS", "OK", "WIN", "WON"}:
        return "success"
    if key in {"FAIL", "FAILED", "FAILURE", "LOSE", "LOST"}:
        return "fail"
    if key in {"DRAW", "TIE"}:
        return "draw"
    if key in {"PENDING", "OPEN", "PROGRESS"}:
        return "pending"
    if is_draw is False:
        return "success"
    return ""


def ensure_mission_runs(session: dict[str, Any] | None) -> list[dict[str, Any]]:
    session = session if isinstance(session, dict) else {}
    runs = session.get("missionRuns")
    if not isinstance(runs, list):
        runs = []
        session["missionRuns"] = runs
    return runs


def _empty_mission_run(kind: str, seq: int) -> dict[str, Any]:
    return {
        "id": f"{kind[:1]}{seq}",
        "kind": kind,
        "title": "",
        "status": "pending",
        "total": 0,
        "count": 0,
        "startedAt": "",
        "endedAt": "",
        "settledAt": "",
        "settledCount": 0,
        "winner": "",
        "isDraw": False,
        "donors": {},
        "key": "",
    }


def _find_mission_run_by_key(runs: list[dict[str, Any]], key: str) -> dict[str, Any] | None:
    needle = str(key or "").strip()
    if not needle:
        return None
    for row in reversed(runs):
        if isinstance(row, dict) and str(row.get("key") or "").strip() == needle:
            return row
    return None


def _open_mission_run(
    runs: list[dict[str, Any]],
    kind: str,
    key: str = "",
) -> dict[str, Any]:
    found = _find_mission_run_by_key(runs, key)
    if found:
        return found
    for row in reversed(runs):
        if not isinstance(row, dict):
            continue
        if row.get("kind") != kind or row.get("status") != "pending":
            continue
        existing = str(row.get("key") or "").strip()
        if existing and key and existing != key:
            continue
        if key:
            row["key"] = key
        return row
    row = _empty_mission_run(kind, len(runs) + 1)
    if key:
        row["key"] = key
    runs.append(row)
    return row


def _last_mission_run(runs: list[dict[str, Any]], kind: str) -> dict[str, Any] | None:
    for row in reversed(runs):
        if isinstance(row, dict) and row.get("kind") == kind:
            return row
    return None


def _add_mission_donor(run: dict[str, Any], user_id: str, name: str, count: int) -> None:
    uid = str(user_id or "").strip()
    if not uid or count <= 0:
        return
    donors = run.get("donors")
    if not isinstance(donors, dict):
        donors = {}
        run["donors"] = donors
    row = donors.get(uid) if isinstance(donors.get(uid), dict) else None
    if not row:
        row = {"name": name or uid, "total": 0, "count": 0}
        donors[uid] = row
    row["name"] = name or row.get("name") or uid
    row["total"] = int(row.get("total") or 0) + count
    row["count"] = int(row.get("count") or 0) + 1
    run["total"] = int(run.get("total") or 0) + count
    run["count"] = int(run.get("count") or 0) + 1


def note_mission_gift(
    session: dict[str, Any],
    *,
    action: str,
    user_id: str,
    name: str,
    count: int,
    ts: str,
    title: str = "",
    key: str = "",
) -> dict[str, Any]:
    runs = ensure_mission_runs(session)
    run = _open_mission_run(runs, mission_kind_from_action(action), key=key)
    if not run.get("startedAt"):
        run["startedAt"] = ts
    if title and not str(run.get("title") or "").strip():
        run["title"] = title
    if key and not str(run.get("key") or "").strip():
        run["key"] = key
    _add_mission_donor(run, user_id, name, count)
    return run


def note_mission_finished(
    session: dict[str, Any],
    *,
    action: str,
    msg: dict[str, Any],
    ts: str,
) -> dict[str, Any]:
    runs = ensure_mission_runs(session)
    kind = mission_kind_from_action(action)
    key = str((msg or {}).get("key") or (msg or {}).get("missionKey") or "").strip()
    run = _open_mission_run(runs, kind, key=key)
    title = _mission_title_from_msg(msg)
    if title:
        run["title"] = title
    is_draw = msg.get("isDraw")
    status = _normalize_mission_status(msg.get("missionStatus") or msg.get("status"), is_draw=is_draw)
    if not status:
        status = "draw" if is_draw is True else "success"
    run["status"] = status
    run["endedAt"] = ts
    if is_draw is True:
        run["isDraw"] = True
    winner = str(msg.get("winner") or "").strip()
    if winner:
        run["winner"] = winner[:40]
    return run


def note_mission_settled(
    session: dict[str, Any],
    *,
    action: str,
    count: int,
    ts: str,
) -> dict[str, Any]:
    runs = ensure_mission_runs(session)
    kind = mission_kind_from_action(action)
    run = _last_mission_run(runs, kind) or _open_mission_run(runs, kind)
    run["settledAt"] = ts
    if count > 0:
        run["settledCount"] = int(run.get("settledCount") or 0) + count
    return run


def note_mission_fanlist(session: dict[str, Any], msg: dict[str, Any]) -> dict[str, Any] | None:
    runs = ensure_mission_runs(session)
    run = _last_mission_run(runs, "challenge") or _open_mission_run(runs, "challenge")
    users = msg.get("userList") if isinstance(msg.get("userList"), list) else []
    if not users and (msg.get("userId") or msg.get("userNickname")):
        users = [msg]
    for row in users:
        if not isinstance(row, dict):
            continue
        uid = str(row.get("userId") or row.get("id") or "").strip()
        uname = str(row.get("userNickname") or row.get("name") or uid).strip()
        try:
            count = int(row.get("count") or row.get("value") or 0)
        except (TypeError, ValueError):
            count = 0
        if uid and count > 0:
            # fanlist는 정산 명단 — 이미 합산된 후원이면 덮어쓰지 않고 비어 있을 때만 채움
            donors = run.get("donors") if isinstance(run.get("donors"), dict) else {}
            if uid not in donors:
                _add_mission_donor(run, uid, uname, count)
    return run


def ensure_ssapi_feed(session: dict[str, Any] | None) -> list[dict[str, Any]]:
    session = session if isinstance(session, dict) else {}
    feed = session.get("ssapiFeed")
    if not isinstance(feed, list):
        feed = []
        session["ssapiFeed"] = feed
    return feed


def note_ssapi_feed(
    session: dict[str, Any],
    *,
    kind: str,
    ts: str,
    phase: str = "",
    key: str = "",
    title: str = "",
    status: str = "",
    winner: str = "",
    mission_type: str = "",
    name: str = "",
    user_id: str = "",
    count: int | str = 0,
    text: str = "",
    note_id: str = "",
) -> dict[str, Any]:
    """SSAPI가 준 이벤트만 개발자 모니터용으로 남긴다."""
    try:
        amount = int(count or 0)
    except (TypeError, ValueError):
        amount = 0
    feed = ensure_ssapi_feed(session)
    nid = str(note_id or "").strip()
    if nid:
        for row in reversed(feed[-30:]):
            if isinstance(row, dict) and str(row.get("id") or "") == nid:
                return row
    row = {
        "id": nid or f"s{len(feed) + 1}",
        "kind": "donation" if str(kind or "") == "donation" else "mission",
        "at": ts or utc_now_iso(),
        "phase": str(phase or "").strip(),
        "key": str(key or "").strip(),
        "title": str(title or "").strip()[:80],
        "status": str(status or "").strip(),
        "winner": str(winner or "").strip()[:40],
        "missionType": str(mission_type or "").strip(),
        "name": str(name or "").strip(),
        "userId": str(user_id or "").strip(),
        "count": amount,
        "text": str(text or "").strip()[:200],
    }
    feed.append(row)
    if len(feed) > SSAPI_FEED_MAX:
        del feed[: len(feed) - SSAPI_FEED_MAX]
    return row


def serialize_ssapi_assist(session: dict[str, Any] | None) -> dict[str, Any]:
    feed = session.get("ssapiFeed") if isinstance(session, dict) else None
    if not isinstance(feed, list):
        feed = []
    events: list[dict[str, Any]] = []
    missions: list[dict[str, Any]] = []
    donations: list[dict[str, Any]] = []
    for raw in feed:
        if not isinstance(raw, dict):
            continue
        kind = str(raw.get("kind") or "").strip() or "mission"
        try:
            count = int(raw.get("count") or 0)
        except (TypeError, ValueError):
            count = 0
        row = {
            "id": str(raw.get("id") or ""),
            "kind": kind,
            "at": str(raw.get("at") or ""),
            "phase": str(raw.get("phase") or ""),
            "key": str(raw.get("key") or ""),
            "title": str(raw.get("title") or ""),
            "status": str(raw.get("status") or ""),
            "statusLabel": mission_status_label(str(raw.get("status") or ""))
            if raw.get("status")
            else "",
            "winner": str(raw.get("winner") or ""),
            "missionType": str(raw.get("missionType") or ""),
            "name": str(raw.get("name") or raw.get("userId") or ""),
            "userId": str(raw.get("userId") or ""),
            "count": count,
            "value": f"{count:,}개" if count > 0 else "",
            "text": str(raw.get("text") or ""),
        }
        events.append(row)
        if kind == "donation":
            donations.append(row)
        else:
            missions.append(row)
    return {
        "events": events,
        "missions": missions,
        "donations": donations,
        "missionCount": len(missions),
        "donationCount": len(donations),
        "eventCount": len(events),
    }


def mission_kind_from_ssapi(payload: dict[str, Any] | None) -> str:
    raw = payload if isinstance(payload, dict) else {}
    mission_type = str(raw.get("mission_type") or raw.get("missionType") or "").strip().upper()
    if "BATTLE" in mission_type or mission_type in {"GIFT", "SETTLE", "NOTICE"}:
        return "battle"
    return "challenge"


def apply_ssapi_mission(
    session: dict[str, Any],
    payload: dict[str, Any] | None,
    *,
    ts: str = "",
) -> dict[str, Any] | None:
    """SSAPI mission 보조. 제목·key·결과만 반영하고 receive 후원 수량은 더하지 않는다."""
    msg = payload if isinstance(payload, dict) else {}
    if not msg:
        return None
    phase = str(msg.get("mission_phase") or msg.get("phase") or "").strip().lower()
    key = str(msg.get("key") or msg.get("mission_key") or msg.get("missionKey") or "").strip()
    title = str(msg.get("title") or "").strip()[:80]
    kind = mission_kind_from_ssapi(msg)
    at = ts or utc_now_iso()
    runs = ensure_mission_runs(session)
    run = _open_mission_run(runs, kind, key=key)
    if key:
        run["key"] = key
    if title and (phase == "result" or not str(run.get("title") or "").strip()):
        run["title"] = title
    if not run.get("startedAt"):
        run["startedAt"] = at
    run["fromSsapi"] = True
    if title:
        run["ssapiTitle"] = title
    if key:
        run["ssapiKey"] = key
    run["ssapiPhase"] = phase
    run["ssapiAt"] = at

    if phase == "result":
        result = msg.get("result") if isinstance(msg.get("result"), dict) else {}
        status = _normalize_mission_status(
            result.get("mission_status") or msg.get("mission_status") or msg.get("missionStatus"),
            is_draw=result.get("draw"),
        )
        if status:
            run["status"] = status
        run["endedAt"] = at
        if result.get("draw") is True:
            run["isDraw"] = True
        winner = str(result.get("winner") or "").strip()
        if winner:
            run["winner"] = winner[:40]

    elif phase == "settle":
        run["settledAt"] = at
        settle = msg.get("settle") if isinstance(msg.get("settle"), dict) else {}
        donors = settle.get("donors") if isinstance(settle.get("donors"), list) else []
        existing = run.get("donors") if isinstance(run.get("donors"), dict) else {}
        filled = 0
        for row in donors:
            if not isinstance(row, dict):
                continue
            uid = str(row.get("user_id") or row.get("userId") or "").strip()
            if not uid or uid in existing:
                continue
            name = str(row.get("nickname") or row.get("name") or uid).strip()
            try:
                count = int(row.get("cnt") or row.get("count") or 0)
            except (TypeError, ValueError):
                count = 0
            if count <= 0:
                continue
            _add_mission_donor(run, uid, name, count)
            filled += 1
        if filled:
            run["settledCount"] = int(run.get("settledCount") or 0) + filled

    try:
        gift_count = int(msg.get("cnt") or msg.get("count") or 0)
    except (TypeError, ValueError):
        gift_count = 0
    note_ssapi_feed(
        session,
        kind="mission",
        ts=at,
        phase=phase,
        key=key,
        title=title or str(run.get("title") or ""),
        status=str(run.get("status") or "pending"),
        winner=str(run.get("winner") or ""),
        mission_type=str(msg.get("mission_type") or msg.get("missionType") or ""),
        name=str(msg.get("nickname") or msg.get("userNickname") or "").strip(),
        user_id=str(msg.get("user_id") or msg.get("userId") or "").strip(),
        count=gift_count,
    )
    return run


def _donation_text_from_msg(msg: dict[str, Any] | None) -> str:
    if not isinstance(msg, dict):
        return ""
    for key in ("message", "comment", "text", "donationMessage", "msg"):
        text = str(msg.get(key) or "").strip()
        if text:
            return text[:200]
    return ""


def ensure_donation_notes(session: dict[str, Any] | None) -> list[dict[str, Any]]:
    session = session if isinstance(session, dict) else {}
    notes = session.get("donationNotes")
    if not isinstance(notes, list):
        notes = []
        session["donationNotes"] = notes
    return notes


def note_donation_text(
    session: dict[str, Any],
    *,
    user_id: str,
    name: str,
    count: int,
    text: str,
    ts: str,
    note_id: str = "",
    action: str = "",
) -> dict[str, Any] | None:
    """후원 메시지(노래 요청·방셀 등). 빈 텍스트는 저장하지 않는다."""
    body = str(text or "").strip()[:200]
    if not body:
        return None
    uid = str(user_id or "").strip()
    notes = ensure_donation_notes(session)
    nid = str(note_id or "").strip()
    if nid and any(isinstance(row, dict) and str(row.get("id") or "") == nid for row in notes):
        return None
    if not nid:
        for row in reversed(notes[-20:]):
            if not isinstance(row, dict):
                continue
            if (
                str(row.get("userId") or "") == uid
                and str(row.get("text") or "") == body
                and int(row.get("count") or 0) == int(count or 0)
            ):
                return None
    row = {
        "id": nid or f"d{len(notes) + 1}",
        "userId": uid,
        "name": str(name or uid).strip() or uid,
        "count": int(count or 0),
        "text": body,
        "at": ts or utc_now_iso(),
        "action": str(action or "").strip(),
    }
    notes.append(row)
    if len(notes) > DONATION_NOTES_MAX:
        del notes[: len(notes) - DONATION_NOTES_MAX]
    return row


def apply_ssapi_donation(
    session: dict[str, Any],
    payload: dict[str, Any] | None,
    *,
    ts: str = "",
) -> dict[str, Any] | None:
    """SSAPI 별풍 메시지 보조. 후원 수량은 더하지 않는다."""
    msg = payload if isinstance(payload, dict) else {}
    text = _donation_text_from_msg(msg)
    if not text:
        return None
    try:
        count = int(msg.get("cnt") or msg.get("count") or 0)
    except (TypeError, ValueError):
        count = 0
    uid = str(msg.get("user_id") or msg.get("userId") or "").strip()
    name = str(msg.get("nickname") or msg.get("userNickname") or "").strip()
    at = ts or utc_now_iso()
    note_ssapi_feed(
        session,
        kind="donation",
        ts=at,
        phase="donation",
        name=name,
        user_id=uid,
        count=count,
        text=text,
        note_id=str(msg.get("_id") or msg.get("id") or "").strip(),
    )
    return note_donation_text(
        session,
        user_id=uid,
        name=name,
        count=count,
        text=text,
        ts=at,
        note_id=str(msg.get("_id") or msg.get("id") or "").strip(),
        action="SSAPI_DONATION",
    )


def serialize_donation_notes(session: dict[str, Any] | None) -> list[dict[str, Any]]:
    notes = session.get("donationNotes") if isinstance(session, dict) else None
    if not isinstance(notes, list):
        return []
    out: list[dict[str, Any]] = []
    for row in notes:
        if not isinstance(row, dict):
            continue
        text = str(row.get("text") or "").strip()
        if not text:
            continue
        count = int(row.get("count") or 0)
        out.append(
            {
                "id": str(row.get("id") or ""),
                "userId": str(row.get("userId") or ""),
                "name": str(row.get("name") or row.get("userId") or ""),
                "count": count,
                "value": f"{count:,}개" if count > 0 else "",
                "text": text,
                "at": str(row.get("at") or ""),
                "action": str(row.get("action") or ""),
                "fromSsapi": str(row.get("action") or "") == SSAPI_DONATION_ACTION,
            }
        )
    return out


def serialize_mission_runs(session: dict[str, Any] | None) -> list[dict[str, Any]]:
    runs = session.get("missionRuns") if isinstance(session, dict) else None
    if not isinstance(runs, list):
        return []
    out: list[dict[str, Any]] = []
    for row in runs:
        if not isinstance(row, dict):
            continue
        donors_raw = row.get("donors") if isinstance(row.get("donors"), dict) else {}
        donors = []
        for uid, drow in donors_raw.items():
            if not isinstance(drow, dict):
                continue
            total = int(drow.get("total") or 0)
            if total <= 0:
                continue
            donors.append(
                {
                    "id": str(uid),
                    "name": str(drow.get("name") or uid),
                    "total": total,
                    "value": f"{total:,}개",
                }
            )
        donors.sort(key=lambda x: (-int(x["total"]), x["name"]))
        kind = str(row.get("kind") or "challenge")
        status = str(row.get("status") or "pending")
        title = str(row.get("title") or "").strip() or f"{mission_kind_label(kind)} 미션"
        total = int(row.get("total") or 0)
        out.append(
            {
                "id": str(row.get("id") or ""),
                "kind": kind,
                "kindLabel": mission_kind_label(kind),
                "title": title,
                "status": status,
                "statusLabel": mission_status_label(status),
                "total": total,
                "count": int(row.get("count") or 0),
                "startedAt": str(row.get("startedAt") or ""),
                "endedAt": str(row.get("endedAt") or ""),
                "settledCount": int(row.get("settledCount") or 0),
                "winner": str(row.get("winner") or ""),
                "donors": donors[:20],
                "fromSsapi": bool(row.get("fromSsapi")),
                "key": str(row.get("key") or ""),
                "ssapiPhase": str(row.get("ssapiPhase") or ""),
            }
        )
    return out


def close_open_mission_runs(session: dict[str, Any], status: str = "unknown") -> int:
    n = 0
    for row in ensure_mission_runs(session):
        if str(row.get("status") or "") == "pending":
            row["status"] = status
            n += 1
    return n


def backfill_mission_runs_from_gifts(
    session: dict[str, Any],
    events: list[dict[str, Any]] | None,
    *,
    gap_sec: int = 40 * 60,
) -> list[dict[str, Any]]:
    """로우 GIFTED만으로 미션 구간을 복원. 제목·성공/실패는 없음."""
    session = session if isinstance(session, dict) else {}
    session["missionRuns"] = []
    rows = [ev for ev in (events or []) if isinstance(ev, dict)]
    rows.sort(key=lambda ev: str(ev.get("at") or ev.get("receivedAt") or ""))
    last_at: datetime | None = None
    for ev in rows:
        action = str(ev.get("action") or "CHALLENGE_MISSION_GIFTED").strip().upper()
        if action not in MISSION_GIFT_ACTIONS:
            continue
        msg = ev.get("message") if isinstance(ev.get("message"), dict) else ev
        if not isinstance(msg, dict):
            continue
        ts = str(ev.get("at") or msg.get("at") or "")
        at = parse_iso(ts)
        if last_at and at and (at - last_at).total_seconds() > gap_sec:
            close_open_mission_runs(session, "unknown")
        uid = str(msg.get("userId") or "").strip()
        name = str(msg.get("userNickname") or msg.get("name") or uid).strip()
        try:
            count = int(msg.get("count") or msg.get("value") or 0)
        except (TypeError, ValueError):
            count = 0
        if not uid or count <= 0:
            continue
        note_mission_gift(session, action=action, user_id=uid, name=name, count=count, ts=ts)
        last_at = at or last_at
    close_open_mission_runs(session, "unknown")
    for row in ensure_mission_runs(session):
        if not str(row.get("title") or "").strip():
            row["title"] = f"{mission_kind_label(row.get('kind'))} 미션"
        if row.get("status") == "unknown" and not row.get("endedAt"):
            row["endedAt"] = str(row.get("startedAt") or "")
    return ensure_mission_runs(session)


def append_leftover_mission_donors(session: dict[str, Any]) -> dict[str, Any] | None:
    """세션 missions 집계 중 복원 구간에 없는 후원자를 별도 칸으로 남긴다."""
    missions = session.get("missions") if isinstance(session.get("missions"), dict) else {}
    runs = ensure_mission_runs(session)
    seen: set[str] = set()
    accounted: dict[str, int] = {}
    for run in runs:
        donors = run.get("donors") if isinstance(run.get("donors"), dict) else {}
        for uid, drow in donors.items():
            seen.add(str(uid))
            accounted[str(uid)] = accounted.get(str(uid), 0) + int((drow or {}).get("total") or 0)
    leftover: list[tuple[str, str, int]] = []
    for uid, row in missions.items():
        if not isinstance(row, dict):
            continue
        total = int(row.get("total") or 0)
        used = int(accounted.get(str(uid)) or 0)
        extra = total - used
        if extra > 0:
            leftover.append((str(uid), str(row.get("name") or uid), extra))
    if not leftover:
        return None
    run = _empty_mission_run("challenge", len(runs) + 1)
    run["status"] = "unknown"
    run["title"] = "기록된 미션 후원"
    for uid, name, total in leftover:
        _add_mission_donor(run, uid, name, total)
    runs.append(run)
    return run


def mission_section_items_from_runs(session: dict[str, Any] | None) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for i, row in enumerate(serialize_mission_runs(session), start=1):
        bits = [row["statusLabel"]]
        if int(row.get("total") or 0) > 0:
            bits.append(f"{int(row['total']):,}개")
        items.append(
            {
                "rank": i,
                "name": row["title"],
                "value": " · ".join(bits),
                "status": row["status"],
                "kind": row["kind"],
            }
        )
    return items


# 하위 호환 별칭
MVP_CHAT_ACTIONS = CHAT_ACTIONS
MVP_PRESENCE_JOIN = PRESENCE_JOIN
MVP_PRESENCE_LEAVE = PRESENCE_LEAVE
MVP_DONATION_ACTIONS = DONATION_ACTIONS
PHASE2_SUBSCRIBE_ACTIONS = SUBSCRIBE_NEW | SUBSCRIBE_RENEW | SUBSCRIBE_GIFT


def empty_metrics_series() -> dict[str, list]:
    return {"viewers": [], "up": [], "balloons": [], "chats": []}


def ensure_metrics_series(session: dict[str, Any]) -> dict[str, list]:
    raw = session.get("metricsSeries")
    if not isinstance(raw, dict):
        raw = empty_metrics_series()
        session["metricsSeries"] = raw
    for key in ("viewers", "up", "balloons", "chats"):
        if not isinstance(raw.get(key), list):
            raw[key] = []
    return raw


def _minute_bucket_iso(at: datetime | None = None) -> str:
    dt = at or datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc).replace(second=0, microsecond=0)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def upsert_metric_point(
    series: list[Any],
    value: int | float,
    *,
    at: str | None = None,
    max_points: int = _METRICS_SERIES_MAX_POINTS,
) -> bool:
    """분 버킷에 값 upsert. 같은 분이면 덮어씀. 변경 시 True."""
    try:
        v = int(value)
    except (TypeError, ValueError):
        return False
    at_iso = str(at or "").strip() or _minute_bucket_iso()
    parsed = parse_iso(at_iso)
    if parsed:
        at_iso = _minute_bucket_iso(parsed)
    if series and isinstance(series[-1], dict) and str(series[-1].get("at") or "") == at_iso:
        prev = series[-1].get("v")
        try:
            if int(prev) == v:
                return False
        except (TypeError, ValueError):
            pass
        series[-1] = {"at": at_iso, "v": v}
        return True
    series.append({"at": at_iso, "v": v})
    if len(series) > max_points:
        del series[:-max_points]
    return True


def record_live_metrics(
    session: dict[str, Any],
    *,
    viewers: int | None = None,
    up_count: int | None = None,
    at: str | None = None,
) -> bool:
    """라이브 폴링 샘플을 metricsSeries에 기록."""
    series = ensure_metrics_series(session)
    changed = False
    at_iso = str(at or "").strip() or _minute_bucket_iso()
    if viewers is not None:
        if upsert_metric_point(series["viewers"], viewers, at=at_iso):
            changed = True
    if up_count is not None:
        if session.get("upBaseline") is None:
            session["upBaseline"] = int(up_count)
            changed = True
        session["lastUpCount"] = int(up_count)
        try:
            baseline = int(session.get("upBaseline") or 0)
            session["upGain"] = max(0, int(up_count) - baseline)
        except (TypeError, ValueError):
            session["upGain"] = 0
        if upsert_metric_point(series["up"], up_count, at=at_iso):
            changed = True
    return changed


def increment_metric_point(
    series: list[Any],
    delta: int = 1,
    *,
    at: str | None = None,
    max_points: int = _METRICS_SERIES_MAX_POINTS,
) -> bool:
    """분 버킷에 delta 누적. 같은 분이면 더함."""
    try:
        add = int(delta)
    except (TypeError, ValueError):
        return False
    if add <= 0:
        return False
    at_iso = str(at or "").strip() or _minute_bucket_iso()
    parsed = parse_iso(at_iso)
    if parsed:
        at_iso = _minute_bucket_iso(parsed)
    for row in reversed(series):
        if isinstance(row, dict) and str(row.get("at") or "") == at_iso:
            row["v"] = int(row.get("v") or 0) + add
            return True
    series.append({"at": at_iso, "v": add})
    if len(series) > max_points:
        del series[:-max_points]
    return True


def normalize_metric_series(
    series: list[Any] | None,
    *,
    cumulative: bool = False,
) -> list[dict[str, Any]]:
    """분 버킷 정렬·중복 병합. viewers=마지막 값, chats=합산."""
    buckets: dict[str, int] = {}
    for row in series or []:
        if not isinstance(row, dict):
            continue
        at = str(row.get("at") or "").strip()
        parsed = parse_iso(at)
        if not parsed:
            continue
        at_iso = _minute_bucket_iso(parsed)
        try:
            v = int(row.get("v") or 0)
        except (TypeError, ValueError):
            continue
        if cumulative:
            buckets[at_iso] = int(buckets.get(at_iso) or 0) + v
        else:
            buckets[at_iso] = v
    return [{"at": at, "v": buckets[at]} for at in sorted(buckets.keys())]


def align_viewer_chat_metrics(
    viewers: list[Any] | None,
    chats: list[Any] | None,
    *,
    started_at: str | None = None,
    end_at: str | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """시청·화력을 같은 분 그리드에 맞춤 — 빈 분은 시청=직전값, 화력=0."""
    v_norm = normalize_metric_series(viewers, cumulative=False)
    c_norm = normalize_metric_series(chats, cumulative=True)
    if not v_norm and not c_norm:
        return [], []

    v_map = {str(r["at"]): int(r["v"]) for r in v_norm}
    c_map = {str(r["at"]): int(r["v"]) for r in c_norm}
    all_at = sorted(set(v_map) | set(c_map))

    start = parse_iso(started_at) if started_at else parse_iso(all_at[0])
    end = parse_iso(end_at) if end_at else parse_iso(all_at[-1])
    if not start and all_at:
        start = parse_iso(all_at[0])
    if not end and all_at:
        end = parse_iso(all_at[-1])
    if start and end and end >= start:
        grid: list[str] = []
        cur = _minute_bucket_iso(start)
        end_iso = _minute_bucket_iso(end)
        while cur <= end_iso:
            grid.append(cur)
            nxt = parse_iso(cur)
            if not nxt:
                break
            cur = _minute_bucket_iso(nxt + timedelta(minutes=1))
        if grid:
            all_at = grid

    out_v: list[dict[str, Any]] = []
    out_c: list[dict[str, Any]] = []
    last_v = 0
    for at in all_at:
        if at in v_map:
            last_v = v_map[at]
        out_v.append({"at": at, "v": last_v})
        out_c.append({"at": at, "v": c_map.get(at, 0)})
    return out_v, out_c


def compact_metrics_series(session: dict[str, Any]) -> bool:
    """metricsSeries 중복·역순 버킷 정리."""
    series = ensure_metrics_series(session)
    changed = False
    for key, cumulative in (
        ("viewers", False),
        ("up", False),
        ("balloons", False),
        ("chats", True),
    ):
        norm = normalize_metric_series(series.get(key), cumulative=cumulative)
        if norm != series.get(key):
            series[key] = norm
            changed = True
    return changed


def record_chat_metric(session: dict[str, Any], *, at: str | None = None, delta: int = 1) -> bool:
    """accepted 채팅을 metricsSeries.chats에 1분 단위로 실시간 누적."""
    series = ensure_metrics_series(session)
    return increment_metric_point(series["chats"], delta, at=at)


def record_balloon_metric(session: dict[str, Any], amount: int, *, at: str | None = None) -> bool:
    """별풍 누적량을 metricsSeries.balloons에 기록."""
    try:
        add = int(amount)
    except (TypeError, ValueError):
        return False
    if add <= 0:
        return False
    total = int(session.get("balloonTotal") or 0) + add
    session["balloonTotal"] = total
    series = ensure_metrics_series(session)
    return upsert_metric_point(series["balloons"], total, at=at)


# SOOP SUBSCRIPTION_GIFTED.type — 일수 코드 → 구독 개월
_SUB_GIFT_DAYS_TO_MONTHS = {30: 1, 90: 3, 180: 6}


def _parse_gift_type_code(raw: Any) -> tuple[str, bool, int]:
    """type 값에서 (원문, 플러스여부, 일수) 추출. 일수를 모르면 0."""
    code = ""
    if isinstance(raw, dict):
        code = str(raw.get("name") or raw.get("term") or "").strip()
    else:
        code = str(raw or "").strip()
    if not code:
        return "", False, 0
    upper = code.upper()
    is_plus = "PLUS" in upper
    days = 0
    m = re.search(r"(\d+)", upper)
    if m:
        try:
            days = int(m.group(1))
        except (TypeError, ValueError):
            days = 0
    return code, is_plus, days


def format_subscription_gift_label(raw_type: Any, *, tier: Any = None) -> str:
    """GIFT_30 → '구독 1개월', GIFT_90 → '구독 3개월'. tier 2면 구독 플러스."""
    code, is_plus, days = _parse_gift_type_code(raw_type)
    try:
        tier_n = int(tier or 0)
    except (TypeError, ValueError):
        tier_n = 0
    if tier_n >= 2:
        is_plus = True
    kind = "구독 플러스" if is_plus else "구독"
    months = _SUB_GIFT_DAYS_TO_MONTHS.get(days, 0)
    if months <= 0 and days > 0 and days % 30 == 0:
        months = days // 30
    if months > 0:
        return f"{kind} {months}개월"
    if code:
        return f"{kind}권"
    return ""


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_broadcast_title(title: Any) -> str:
    return str(title or "").strip()


def is_bj_status_title(title: Any) -> bool:
    """SOOP BJ 상태 프리셋 — broad_title에 섞여도 방제 변경으로 기록하지 않음."""
    norm = normalize_broadcast_title(title)
    if not norm:
        return False
    if norm in _BJ_STATUS_TITLES:
        return True
    lowered = norm.lower()
    for prefix in (
        "업무를 처리",
        "식사합니다",
        "식사 중",
        "잠시 자리",
        "휴식 중",
        "휴식중",
        "방송 준비 중",
        "방송 준비중",
    ):
        if lowered.startswith(prefix):
            return True
    return False


def collapse_title_history(rows: list[Any] | None, *, limit: int = 40) -> list[dict[str, Any]]:
    """연속 동일 제목만 제거. (시간 flap 덮어쓰기는 하지 않음 — confirm-N이 담당)"""
    out: list[dict[str, Any]] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        title = normalize_broadcast_title(row.get("title"))
        if not title:
            continue
        at = str(row.get("at") or "").strip() or utc_now_iso()
        if out and normalize_broadcast_title(out[-1].get("title")) == title:
            continue
        out.append({"title": title, "at": at})
    if limit > 0 and len(out) > limit:
        out = out[-limit:]
    return out


def append_title_history(
    session: dict[str, Any],
    title: Any,
    *,
    at: str | None = None,
    confirm_n: int = TITLE_CONFIRM_N,
) -> bool:
    """방제는 연속 confirm_n회 + 최소 유지(ms) 후 history/title에 커밋."""
    norm = normalize_broadcast_title(title)
    if not norm:
        return False
    if is_bj_status_title(norm):
        session.pop("titlePending", None)
        return False
    history = session.get("titleHistory")
    if not isinstance(history, list):
        history = []
        session["titleHistory"] = history
    history = collapse_title_history(history)
    session["titleHistory"] = history
    committed = (
        normalize_broadcast_title(history[-1].get("title"))
        if history
        else normalize_broadcast_title(session.get("title"))
    )
    when = str(at or "").strip()
    if not when:
        when = (
            str(session.get("startedAt") or "").strip()
            if not history and session.get("startedAt")
            else utc_now_iso()
        )
    need = max(1, int(confirm_n or 1))

    # 세션 첫 방제: 바로 커밋 (방송 시작 메타)
    if not committed:
        if is_bj_status_title(norm):
            return False
        history.append({"title": norm, "at": when})
        session["titleHistory"] = collapse_title_history(history)
        session["title"] = norm
        session.pop("titlePending", None)
        return True

    if norm == committed:
        if session.get("titlePending"):
            session.pop("titlePending", None)
            return True
        if normalize_broadcast_title(session.get("title")) != norm:
            session["title"] = norm
            return True
        return False

    pending = session.get("titlePending")
    if not isinstance(pending, dict) or normalize_broadcast_title(pending.get("title")) != norm:
        session["titlePending"] = {
            "title": norm,
            "count": 1,
            "firstAt": when,
            "lastAt": when,
        }
        return True  # pending 상태 변경 — 저장 필요

    count = int(pending.get("count") or 0) + 1
    pending["count"] = count
    pending["lastAt"] = when
    session["titlePending"] = pending
    if count < need:
        return True  # 카운트 증가도 저장

    first_dt = parse_iso(str(pending.get("firstAt") or when))
    last_dt = parse_iso(str(pending.get("lastAt") or when))
    dwell_ms = 0.0
    if first_dt and last_dt:
        dwell_ms = max(0.0, (last_dt - first_dt).total_seconds() * 1000)
    min_ms = float(TITLE_CONFIRM_MIN_MS or 0)
    if min_ms > 0 and dwell_ms < min_ms:
        return True  # pending 유지 — 아직 확정 전

    history.append({"title": norm, "at": str(pending.get("firstAt") or when)})
    if len(history) > 40:
        del history[:-40]
    session["titleHistory"] = collapse_title_history(history)
    session["title"] = norm
    session.pop("titlePending", None)
    return True


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def ended_ingest_in_grace(session: dict[str, Any] | None) -> bool:
    """방종 직후 N분 동안은 ingest를 이어 받아 크레딧 이후 후원을 놓치지 않는다."""
    if not isinstance(session, dict):
        return False
    ended = parse_iso(str(session.get("endedAt") or ""))
    if not ended:
        return False
    age = (datetime.now(timezone.utc) - ended).total_seconds()
    return 0 <= age <= ENDED_INGEST_GRACE_SEC


def format_duration(started_at: str | None, ended_at: str | None = None) -> str:
    start = parse_iso(started_at)
    if not start:
        return ""
    end = parse_iso(ended_at) or datetime.now(timezone.utc)
    seconds = max(0, int((end - start).total_seconds()))
    hours, rem = divmod(seconds, 3600)
    minutes, secs = divmod(rem, 60)
    parts = []
    if hours:
        parts.append(f"{hours}시간")
    if minutes or not hours:
        parts.append(f"{minutes}분")
    if not hours and not minutes:
        parts.append(f"{secs}초")
    return " ".join(parts)


def format_watch(ms_or_sec: float, *, seconds_input: bool = False) -> str:
    total = int(ms_or_sec if seconds_input else ms_or_sec / 1000)
    total = max(0, total)
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours}시간 {minutes}분"
    if minutes:
        return f"{minutes}분"
    return f"{secs}초"


def chatter_watch_ms(
    row: dict[str, Any] | None,
    *,
    now_ms: float,
    ended_ms: float = 0.0,
    started_ms: float = 0.0,
) -> float:
    """시청 시간(ms). watchedMs(과거 구간 누적) + 현재 접속 구간.

    started_ms가 있으면 방송 시작 이후를 넘지 않도록 캡한다(병합 이중집계 방어).
    """
    if not isinstance(row, dict):
        return 0.0
    watched = float(row.get("watchedMs") or 0)
    joined = float(row.get("joinedAt") or 0)
    left = float(row.get("leftAt") or 0)
    if joined <= 0:
        total = max(0.0, watched)
    elif left <= 0:
        end = ended_ms if ended_ms > 0 else now_ms
        end = effective_watch_end_ms(row, end)
        total = watched + max(0.0, end - joined)
    elif watched > 0:
        # 퇴장 상태: leave 시 watchedMs에 이미 합산됨. 예전 데이터는 left-joined.
        total = watched
    else:
        total = max(0.0, left - joined)
    if started_ms > 0:
        end = ended_ms if ended_ms > 0 else now_ms
        cap = max(0.0, end - started_ms)
        if cap > 0:
            total = min(total, cap)
    return total


def should_ignore_presence_leave(
    row: dict[str, Any] | None,
    ts_ms: float,
    *,
    is_kick: bool = False,
    grace_ms: int = REFRESH_OUT_GRACE_MS,
) -> bool:
    """킥이 아니고 최근 채팅이 있으면 즉시 퇴장 처리하지 않음."""
    if is_kick:
        return False
    if not isinstance(row, dict):
        return False
    last_chat = float(row.get("lastChatAtMs") or 0)
    if last_chat <= 0:
        return False
    return 0 <= (float(ts_ms) - last_chat) <= float(grace_ms)


def finalize_pending_leaves(
    chatters: dict[str, Any] | None,
    now_ms: float,
    *,
    confirm_ms: int = PRESENCE_LEAVE_CONFIRM_MS,
) -> int:
    """pendingLeaveAt 확정. 무활동이 confirm_ms 이상이면 leftAt 확정."""
    if not isinstance(chatters, dict):
        return 0
    confirmed = 0
    conf = int(confirm_ms) if confirm_ms is not None else PRESENCE_LEAVE_CONFIRM_MS
    conf = max(0, conf)
    for uid, row in list(chatters.items()):
        if not isinstance(row, dict):
            continue
        pending = float(row.get("pendingLeaveAt") or 0)
        if pending <= 0:
            continue
        left = float(row.get("leftAt") or 0)
        if left > 0:
            row["pendingLeaveAt"] = 0
            chatters[uid] = row
            continue
        last_act = max(
            float(row.get("lastChatAtMs") or 0),
            float(row.get("joinedAt") or 0),
        )
        # lastSeenAt은 OUT/하트비트로 오염될 수 있어 quiet 판정에서 제외
        if last_act > pending:
            row["pendingLeaveAt"] = 0
            chatters[uid] = row
            continue
        quiet = float(now_ms) - max(last_act, 0.0)
        pending_age = float(now_ms) - pending
        if conf > 0 and quiet < conf and pending_age < conf:
            continue
        leave_at = pending
        joined = float(row.get("joinedAt") or 0)
        if joined > 0 and left <= 0:
            eff = effective_watch_end_ms(row, leave_at)
            row["watchedMs"] = int(row.get("watchedMs") or 0) + max(
                0, int(eff - joined)
            )
        row["leftAt"] = leave_at
        row["lastSeenAt"] = max(float(row.get("lastSeenAt") or 0), leave_at)
        row["pendingLeaveAt"] = 0
        chatters[uid] = row
        confirmed += 1
    return confirmed


def _chatter_closed_watch_ms(row: dict[str, Any] | None) -> int:
    """확정된(닫힌) 시청 ms. 접속 중이면 watchedMs만(열린 구간 제외)."""
    if not isinstance(row, dict):
        return 0
    watched = int(row.get("watchedMs") or 0)
    joined = float(row.get("joinedAt") or 0)
    left = float(row.get("leftAt") or 0)
    if joined > 0 and left <= 0:
        return max(0, watched)
    if watched > 0:
        return watched
    if joined > 0 and left > 0:
        return max(0, int(left - joined))
    return 0


def _merge_chatter_presence(live: dict[str, Any], prior: dict[str, Any]) -> dict[str, Any]:
    """시청 구간 병합.

    - prior에서 퇴장 후 live에서 재입장: 누적 watchedMs + live 현재 구간
    - 양쪽 다 접속 중(세션 분리): 한 구간으로 이어 joinedAt 유지, watchedMs=0
    """
    out = dict(live)
    p_join = float(prior.get("joinedAt") or 0)
    p_left = float(prior.get("leftAt") or 0)
    l_join = float(live.get("joinedAt") or 0)
    l_left = float(live.get("leftAt") or 0)
    p_w = _chatter_closed_watch_ms(prior)
    l_w = int(live.get("watchedMs") or 0)
    prior_open = p_join > 0 and p_left <= 0
    live_open = l_join > 0 and l_left <= 0

    if live_open and prior_open:
        joins = [j for j in (p_join, l_join) if j > 0]
        out["joinedAt"] = min(joins) if joins else l_join
        out["leftAt"] = 0
        out["watchedMs"] = 0
    elif live_open:
        # prior 퇴장 → live 재입장 (또는 prior 입장 기록 없음)
        out["joinedAt"] = l_join
        out["leftAt"] = 0
        out["watchedMs"] = p_w + max(0, l_w)
    elif prior_open:
        # 분리 직전 접속 중 + thin 쪽만 퇴장 — 연속 시청으로 이어 닫기
        # (thin의 늦은 joinedAt으로 앞구간을 자르지 않음)
        out["joinedAt"] = p_join
        if l_left > p_join:
            out["leftAt"] = l_left
            out["watchedMs"] = p_w + max(0, int(l_left - p_join))
        else:
            out["leftAt"] = l_left
            out["watchedMs"] = p_w + _chatter_closed_watch_ms(live)
    else:
        joins = [j for j in (p_join, l_join) if j > 0]
        lefts = [x for x in (p_left, l_left) if x > 0]
        out["joinedAt"] = min(joins) if joins else 0.0
        out["leftAt"] = max(lefts) if lefts else 0.0
        out["watchedMs"] = p_w + _chatter_closed_watch_ms(live)

    lasts = [
        float(x)
        for x in (live.get("lastSeenAt"), prior.get("lastSeenAt"))
        if float(x or 0) > 0
    ]
    if lasts:
        out["lastSeenAt"] = max(lasts)
    return out


def flush_present_chatters(session: dict[str, Any], *, at_ms: float | None = None) -> int:
    """방종·세션 교체 직전 — 접속 중인 시청 구간을 watchedMs에 확정하고 퇴장 처리."""
    chatters = session.get("chatters") if isinstance(session.get("chatters"), dict) else {}
    if not chatters:
        return 0
    now = float(at_ms if at_ms is not None else time.time() * 1000)
    # pending OUT도 방종 시각으로 확정
    finalize_pending_leaves(chatters, now, confirm_ms=0)
    n = 0
    for row in chatters.values():
        if not isinstance(row, dict):
            continue
        joined = float(row.get("joinedAt") or 0)
        left = float(row.get("leftAt") or 0)
        if joined > 0 and left <= 0:
            eff = effective_watch_end_ms(row, now)
            row["watchedMs"] = int(row.get("watchedMs") or 0) + max(0, int(eff - joined))
            row["leftAt"] = now
            row["lastSeenAt"] = now
            row["pendingLeaveAt"] = 0
            n += 1
        else:
            row["pendingLeaveAt"] = 0
    return n


def prefer_earlier_chatter_joins(session: dict[str, Any], prior: dict[str, Any] | None) -> int:
    """이전 세션에만 있던 접속자·빈 joinedAt을 채운다.

    퇴장 후 재입장 유저의 joinedAt을 이르게 당기지 않는다
    (watchedMs + now-joinedAt 이중 집계 방지).
    """
    if not isinstance(prior, dict):
        return 0
    prev_chatters = prior.get("chatters") if isinstance(prior.get("chatters"), dict) else {}
    chatters = session.get("chatters") if isinstance(session.get("chatters"), dict) else {}
    if not prev_chatters or not isinstance(chatters, dict):
        return 0
    fixed = 0
    for uid, prev in prev_chatters.items():
        if not isinstance(prev, dict):
            continue
        row = chatters.get(uid)
        if not isinstance(row, dict):
            chatters[uid] = dict(prev)
            fixed += 1
            continue
        prev_join = float(prev.get("joinedAt") or 0)
        cur_join = float(row.get("joinedAt") or 0)
        if cur_join <= 0 and prev_join > 0:
            row["joinedAt"] = prev_join
            if not str(row.get("name") or "").strip() and prev.get("name"):
                row["name"] = prev["name"]
            chatters[uid] = row
            fixed += 1
    session["chatters"] = chatters
    return fixed


def _merge_metric_series(
    dst: list[Any], src: list[Any], *, mode: str = "max"
) -> list[dict[str, Any]]:
    by_at: dict[str, int] = {}
    for row in list(src or []) + list(dst or []):
        if not isinstance(row, dict):
            continue
        at = str(row.get("at") or "").strip()
        if not at:
            continue
        try:
            v = int(row.get("v") or 0)
        except (TypeError, ValueError):
            continue
        if mode == "sum":
            by_at[at] = by_at.get(at, 0) + v
        else:
            by_at[at] = max(by_at.get(at, 0), v)
    out = [{"at": at, "v": by_at[at]} for at in sorted(by_at.keys())]
    if len(out) > _METRICS_SERIES_MAX_POINTS:
        out = out[-_METRICS_SERIES_MAX_POINTS:]
    return out


def merge_prior_session_into(session: dict[str, Any], prior: dict[str, Any] | None) -> dict[str, Any]:
    """끊긴 이전 세션(prior)을 현재 라이브 세션에 합친다. startedAt·집계를 보존."""
    session = session if isinstance(session, dict) else {}
    prior = prior if isinstance(prior, dict) else {}
    if not prior.get("startedAt"):
        return session

    # 시작 시각 — 더 이른 쪽
    cur_start = parse_iso(session.get("startedAt"))
    pri_start = parse_iso(prior.get("startedAt"))
    if pri_start and (not cur_start or pri_start < cur_start):
        session["startedAt"] = prior.get("startedAt")

    if not str(session.get("broadNo") or "").strip() and prior.get("broadNo"):
        session["broadNo"] = prior.get("broadNo")
    if not str(session.get("stationId") or "").strip() and prior.get("stationId"):
        session["stationId"] = prior.get("stationId")

    # 방제 이력 — 시각 순 + 연속 동일 제목 제거
    hist: list[dict[str, Any]] = []
    seen_h: set[str] = set()
    for row in list(prior.get("titleHistory") or []) + list(session.get("titleHistory") or []):
        if not isinstance(row, dict):
            continue
        title = normalize_broadcast_title(row.get("title"))
        at = str(row.get("at") or "").strip()
        key = f"{at}|{title}"
        if not title or key in seen_h:
            continue
        seen_h.add(key)
        hist.append({"title": title, "at": at or utc_now_iso()})
    hist.sort(key=lambda r: str(r.get("at") or ""))
    hist = collapse_title_history(hist)
    if hist:
        session["titleHistory"] = hist
    # 현재 방제는 라이브 쪽 유지, 없으면 prior
    if not normalize_broadcast_title(session.get("title")) and prior.get("title"):
        session["title"] = normalize_broadcast_title(prior.get("title"))

    # 피크 — 더 높은 쪽 메타 유지
    try:
        cur_peak = int(session.get("peakViewers") or 0)
    except (TypeError, ValueError):
        cur_peak = 0
    try:
        pri_peak = int(prior.get("peakViewers") or 0)
    except (TypeError, ValueError):
        pri_peak = 0
    if pri_peak > cur_peak:
        session["peakViewers"] = pri_peak
        session["peakViewersAt"] = prior.get("peakViewersAt")
        session["peakTitle"] = prior.get("peakTitle") or prior.get("title") or ""
        if prior.get("peakThumbUrl"):
            session["peakThumbUrl"] = prior.get("peakThumbUrl")
    elif cur_peak <= 0 and pri_peak > 0:
        session["peakViewers"] = pri_peak

    try:
        session["balloonTotal"] = int(session.get("balloonTotal") or 0) + int(
            prior.get("balloonTotal") or 0
        )
    except (TypeError, ValueError):
        pass

    merged_runs: list[dict[str, Any]] = []
    seen_run_ids: set[str] = set()
    for row in list(prior.get("missionRuns") or []) + list(session.get("missionRuns") or []):
        if not isinstance(row, dict):
            continue
        rid = str(row.get("id") or "").strip()
        key = rid or f"{row.get('kind')}|{row.get('startedAt')}|{row.get('title')}"
        if key in seen_run_ids:
            continue
        seen_run_ids.add(key)
        merged_runs.append(row)
    if merged_runs:
        session["missionRuns"] = merged_runs

    merged_notes: list[dict[str, Any]] = []
    seen_notes: set[str] = set()
    for row in list(prior.get("donationNotes") or []) + list(session.get("donationNotes") or []):
        if not isinstance(row, dict):
            continue
        key = str(row.get("id") or "").strip() or f"{row.get('userId')}|{row.get('at')}|{row.get('text')}"
        if key in seen_notes:
            continue
        seen_notes.add(key)
        merged_notes.append(row)
    if merged_notes:
        session["donationNotes"] = merged_notes[-DONATION_NOTES_MAX:]

    merged_feed: list[dict[str, Any]] = []
    seen_feed: set[str] = set()
    for row in list(prior.get("ssapiFeed") or []) + list(session.get("ssapiFeed") or []):
        if not isinstance(row, dict):
            continue
        key = str(row.get("id") or "").strip() or f"{row.get('kind')}|{row.get('at')}|{row.get('text')}|{row.get('title')}"
        if key in seen_feed:
            continue
        seen_feed.add(key)
        merged_feed.append(row)
    if merged_feed:
        session["ssapiFeed"] = merged_feed[-SSAPI_FEED_MAX:]

    # 채팅·후원 등 user-keyed
    for key, count_keys in (
        ("chatters", ("count",)),
        ("donations", ("count", "total")),
        ("signatureHits", ("count",)),
        ("emoticons", ("count",)),
        ("emoticonUsage", ("count",)),
        ("quickviews", ("count",)),
        ("missions", ("count",)),
        ("gems", ("count",)),
    ):
        dst = session.setdefault(key, {})
        src = prior.get(key) if isinstance(prior.get(key), dict) else {}
        if not isinstance(dst, dict):
            dst = {}
            session[key] = dst
        for uid, prow in src.items():
            if not isinstance(prow, dict):
                continue
            uid_s = str(uid or "").strip()
            if not uid_s:
                continue
            if uid_s not in dst or not isinstance(dst.get(uid_s), dict):
                dst[uid_s] = dict(prow)
            else:
                if key == "chatters":
                    # count 등만 합산 후, 시청 구간은 전용 병합(이중 집계 방지)
                    merged = _merge_count_rows(dst[uid_s], prow, count_keys=count_keys)
                    presence = _merge_chatter_presence(dst[uid_s], prow)
                    merged["watchedMs"] = presence.get("watchedMs", 0)
                    merged["joinedAt"] = presence.get("joinedAt", 0)
                    merged["leftAt"] = presence.get("leftAt", 0)
                    if presence.get("lastSeenAt"):
                        merged["lastSeenAt"] = presence["lastSeenAt"]
                    dst[uid_s] = merged
                else:
                    dst[uid_s] = _merge_count_rows(dst[uid_s], prow, count_keys=count_keys)

    # amountHits: {amount: {users: {uid: row}}}
    dst_hits = session.setdefault("amountHits", {})
    src_hits = prior.get("amountHits") if isinstance(prior.get("amountHits"), dict) else {}
    if not isinstance(dst_hits, dict):
        dst_hits = {}
        session["amountHits"] = dst_hits
    for amt, bucket in src_hits.items():
        if not isinstance(bucket, dict):
            continue
        db = dst_hits.setdefault(str(amt), {"users": {}})
        if not isinstance(db, dict):
            db = {"users": {}}
            dst_hits[str(amt)] = db
        dusers = db.setdefault("users", {})
        susers = bucket.get("users") if isinstance(bucket.get("users"), dict) else {}
        if not isinstance(dusers, dict):
            dusers = {}
            db["users"] = dusers
        for uid, prow in susers.items():
            if not isinstance(prow, dict):
                continue
            if uid not in dusers or not isinstance(dusers.get(uid), dict):
                dusers[uid] = dict(prow)
            else:
                dusers[uid] = _merge_count_rows(dusers[uid], prow, count_keys=("count",))

    # 리스트 이벤트 — 뒤에 붙이고 중복 완화
    for key in (
        "subscribers",
        "subscriberRenewals",
        "subscriptionGifts",
        "fanclubJoins",
        "topFans",
    ):
        dst_list = session.get(key) if isinstance(session.get(key), list) else []
        src_list = prior.get(key) if isinstance(prior.get(key), list) else []
        merged_list = list(src_list) + list(dst_list)
        session[key] = merged_list[-500:]

    # 수집 구간
    segs = _normalize_collector_segments(prior.get("collectorSegments")) + _normalize_collector_segments(
        session.get("collectorSegments")
    )
    # 열린 구간은 현재 것만 유지
    open_segs = [s for s in segs if not s.get("endedAt")]
    closed = [s for s in segs if s.get("endedAt")]
    if open_segs:
        session["collectorSegments"] = closed + [open_segs[-1]]
    else:
        session["collectorSegments"] = closed

    # 메트릭
    ms = ensure_metrics_series(session)
    pms = prior.get("metricsSeries") if isinstance(prior.get("metricsSeries"), dict) else {}
    for key, merge_mode in (
        ("viewers", "max"),
        ("up", "max"),
        ("balloons", "max"),
        ("chats", "sum"),
    ):
        ms[key] = _merge_metric_series(
            ms.get(key) or [], pms.get(key) or [], mode=merge_mode
        )

    prefer_earlier_chatter_joins(session, prior)
    coalesce_session_user_aliases(session)
    return session


def format_date_label(started_at: str | None) -> str:
    start = parse_iso(started_at)
    if not start:
        return ""
    kst = start.astimezone(KST)
    return f"{kst.year}년 {kst.month}월 {kst.day}일"


def kst_day_bounds(ref: datetime | None = None) -> tuple[datetime, datetime, str]:
    """KST 달력일 00:00–24:00. dayLabel은 '7월 24일'."""
    now = (ref or datetime.now(timezone.utc)).astimezone(KST)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    label = f"{start.month}월 {start.day}일"
    return start, end, label


def pct_on_range(dt: datetime, range_start: datetime, range_end: datetime) -> float:
    """range_start/end는 동일 tz(권장: KST) 기준."""
    total = (range_end - range_start).total_seconds()
    if total <= 0:
        return 0.0
    local = dt.astimezone(range_start.tzinfo or KST)
    p = (local - range_start).total_seconds() / total * 100.0
    return max(0.0, min(100.0, p))


# 하위 호환 별칭
def pct_on_day(dt: datetime, day_start: datetime, day_end: datetime) -> float:
    return pct_on_range(dt, day_start, day_end)


def format_kst_clock(dt: datetime | None) -> str:
    if not dt:
        return ""
    local = dt.astimezone(KST)
    return f"{local.hour:02d}:{local.minute:02d}"


# BJ 구독 시그니처 이모티콘 — live player signature_emoticon_api.php
# 채팅 사용형: `/제목/` (단글자면 `/시/` 처럼 보여 `//`로 불리기도 함)
_SIGNATURE_EMOTICON_TTL_SEC = 1800.0
_signature_emoticon_cache: dict[str, tuple[float, dict[str, dict[str, str]]]] = {}
_signature_emoticon_cache_lock = threading.Lock()
_SIG_EMOTICON_TOKEN_RE = re.compile(r"/([^/\s]{1,40})/")


def fetch_soop_signature_emoticons(
    station_id: str, *, force: bool = False
) -> dict[str, dict[str, str]]:
    """BJ 등록 시그니처 이모티콘 title → {title, imageUrl, tier}.

    공개 POST `signature_emoticon_api.php` (로그인 불필요). 블랙워드 제외.
    """
    sid = str(station_id or "").strip()
    if not sid:
        return {}
    now = time.time()
    cached: tuple[float, dict[str, dict[str, str]]] | None = None
    with _signature_emoticon_cache_lock:
        cached = _signature_emoticon_cache.get(sid)
        if (
            not force
            and cached
            and (now - cached[0]) < _SIGNATURE_EMOTICON_TTL_SEC
        ):
            return {k: dict(v) for k, v in cached[1].items()}

    api_url = "https://live.sooplive.co.kr/api/signature_emoticon_api.php"
    body = urllib.parse.urlencode(
        {"work": "list", "v": "tier", "szBjId": sid}
    ).encode("utf-8")
    req = urllib.request.Request(
        api_url,
        data=body,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; sirian-credits/1.0)",
            "Accept": "application/json",
            "Referer": "https://play.sooplive.co.kr/",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, ValueError):
        if cached:
            return {k: dict(v) for k, v in cached[1].items()}
        return {}

    if not isinstance(payload, dict) or int(payload.get("result") or 0) != 1:
        if cached:
            return {k: dict(v) for k, v in cached[1].items()}
        return {}

    img_base = str(payload.get("img_path") or "").strip()
    if img_base and not img_base.endswith("/"):
        img_base += "/"
    if img_base.startswith("//"):
        img_base = "https:" + img_base

    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    items: dict[str, dict[str, str]] = {}
    for tier_key in ("tier1", "tier2"):
        rows = data.get(tier_key) if isinstance(data.get(tier_key), list) else []
        for row in rows:
            if not isinstance(row, dict):
                continue
            if str(row.get("black_keyword") or "").upper() == "Y":
                continue
            title = str(row.get("title") or "").strip()
            if not title or len(title) > 40 or "/" in title:
                continue
            img_file = str(
                row.get("mobile_img")
                or row.get("pc_img")
                or row.get("mob_alternate_img")
                or row.get("pc_alternate_img")
                or ""
            ).strip()
            image_url = f"{img_base}{img_file}" if img_base and img_file else ""
            items[title] = {
                "title": title,
                "imageUrl": image_url,
                "tier": tier_key,
            }

    with _signature_emoticon_cache_lock:
        _signature_emoticon_cache[sid] = (now, items)
    return {k: dict(v) for k, v in items.items()}


def match_signature_emoticons(
    msg: dict[str, Any], station_id: str
) -> list[dict[str, str]]:
    """채팅 텍스트에서 BJ 등록 `/제목/` 시그니처 이모만 순서대로 반환."""
    if not isinstance(msg, dict):
        return []
    sid = str(station_id or "").strip()
    if not sid:
        return []
    text = str(msg.get("message") or msg.get("comment") or msg.get("text") or "").strip()
    if not text or "/" not in text:
        return []
    allow = fetch_soop_signature_emoticons(sid)
    if not allow:
        return []
    out: list[dict[str, str]] = []
    for m in _SIG_EMOTICON_TOKEN_RE.finditer(text):
        title = str(m.group(1) or "").strip()
        meta = allow.get(title)
        if not meta:
            continue
        out.append(
            {
                "title": title,
                "imageUrl": str(meta.get("imageUrl") or ""),
                "token": f"/{title}/",
            }
        )
    return out


def subscription_emoticon_token(msg: dict[str, Any], station_id: str = "") -> str:
    """등록된 시그니처 `/제목/` 이면 제목, 아니면 빈 문자열.

    메시지에 매칭이 여러 개면 첫 제목. station_id 없으면 매칭 안 함.
    """
    matches = match_signature_emoticons(msg, station_id)
    return str(matches[0]["title"]) if matches else ""


def is_emoticon_message(msg: dict[str, Any], *, station_id: str = "") -> bool:
    """OGQ 이미지 이모티콘 또는 BJ 등록 구독 시그니처(`/제목/`)."""
    if not isinstance(msg, dict):
        return False
    if (
        msg.get("imageUrl")
        or msg.get("image_url")
        or msg.get("ogqId")
        or msg.get("ogq_id")
        or msg.get("ogqNumber")
        or msg.get("ogq_number")
    ):
        return True
    return bool(match_signature_emoticons(msg, station_id))


def emoticon_usage_key(msg: dict[str, Any], *, station_id: str = "") -> str:
    """같은 이모티콘끼리 묶을 키 (ogqId 우선, 구독 /제목/, 없으면 이미지 URL)."""
    if not isinstance(msg, dict):
        return ""
    ogq = str(msg.get("ogqId") or msg.get("ogq_id") or "").strip()
    num = str(msg.get("ogqNumber") or msg.get("ogq_number") or "").strip()
    if ogq:
        return f"ogq:{ogq}:{num}"
    # 호출측이 signature title을 message에 넣었거나, station으로 매칭
    sig_title = str(msg.get("_sigTitle") or "").strip()
    if not sig_title:
        sig_title = subscription_emoticon_token(msg, station_id)
    if sig_title:
        return f"sub:/{sig_title}/"
    url = str(msg.get("imageUrl") or msg.get("image_url") or "").strip()
    if url:
        return f"img:{url.split('?', 1)[0]}"
    name = str(msg.get("itemName") or msg.get("ogqTitle") or "").strip()
    if name:
        return f"name:{name}"
    return ""


def emoticon_display_name(msg: dict[str, Any], *, station_id: str = "") -> str:
    if not isinstance(msg, dict):
        return "이모티콘"
    for key in ("itemName", "ogqTitle", "title", "emoticonName"):
        val = str(msg.get(key) or "").strip()
        if val:
            return val[:40]
    sig_title = str(msg.get("_sigTitle") or "").strip()
    if not sig_title:
        sig_title = subscription_emoticon_token(msg, station_id)
    if sig_title:
        return f"/{sig_title}/"[:40]
    text = str(msg.get("message") or msg.get("comment") or "").strip()
    if text and len(text) <= 24 and "://" not in text:
        return text[:40]
    url = str(msg.get("imageUrl") or msg.get("image_url") or "").strip()
    if url:
        path = url.split("?", 1)[0].rstrip("/")
        base = path.rsplit("/", 1)[-1]
        if "." in base:
            base = base.rsplit(".", 1)[0]
        if base and base.lower() not in ("ogq", "emoji", "emoticon", "image", "img"):
            try:
                base = urllib.parse.unquote(base)
            except Exception:
                pass
            return base[:40]
    return "이모티콘"


def bump_emoticon_usage(
    usage: dict[str, Any],
    msg: dict[str, Any],
    *,
    amount: int = 1,
    station_id: str = "",
) -> None:
    key = emoticon_usage_key(msg, station_id=station_id)
    if not key or amount <= 0:
        return
    row = usage.get(key) if isinstance(usage.get(key), dict) else None
    if not row:
        row = {
            "name": emoticon_display_name(msg, station_id=station_id),
            "imageUrl": str(msg.get("imageUrl") or msg.get("image_url") or "").strip(),
            "count": 0,
        }
    label = emoticon_display_name(msg, station_id=station_id)
    if label and label != "이모티콘":
        row["name"] = label
    img = str(msg.get("imageUrl") or msg.get("image_url") or "").strip()
    if img:
        row["imageUrl"] = img
    row["count"] = int(row.get("count") or 0) + amount
    usage[key] = row


def bump_signature_emoticon_usage(
    usage: dict[str, Any], matches: list[dict[str, str]]
) -> None:
    """시그니처 `/제목/` 매칭분 — 토큰마다 사용량 +1, 이미지 URL 포함."""
    for hit in matches:
        title = str(hit.get("title") or "").strip()
        if not title:
            continue
        synthetic = {
            "_sigTitle": title,
            "imageUrl": str(hit.get("imageUrl") or ""),
            "message": f"/{title}/",
        }
        bump_emoticon_usage(usage, synthetic, amount=1)


def _title_from_signature_usage_key(key: str) -> str:
    text = str(key or "").strip()
    if text.startswith("sub:/") and text.endswith("/"):
        return text[len("sub:/") : -1]
    return ""


def build_top_emoticons(
    usage: dict[str, Any],
    *,
    station_id: str = "",
    limit: int = 10,
    signature_only: bool = True,
) -> list[dict[str, Any]]:
    """많이 쓴 이모티콘 TOP. 기본은 구독 시그니처(`/제목/`)만, 이미지 보강."""
    if not isinstance(usage, dict):
        return []
    sid = str(station_id or "").strip()
    allow = fetch_soop_signature_emoticons(sid) if sid else {}

    def rows_for(*, signature: bool) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for key, row in usage.items():
            if not isinstance(row, dict):
                continue
            is_sig = str(key).startswith("sub:/")
            if signature and not is_sig:
                continue
            if not signature and is_sig:
                continue
            count = int(row.get("count") or 0)
            if count <= 0:
                continue
            title = _title_from_signature_usage_key(str(key))
            meta = allow.get(title) if title else None
            name = str(row.get("name") or "").strip()
            if title:
                name = f"/{title}/"
            elif not name:
                name = "이모티콘"
            image_url = str(row.get("imageUrl") or "").strip()
            if not image_url and isinstance(meta, dict):
                image_url = str(meta.get("imageUrl") or "").strip()
            out.append(
                {
                    "name": name[:40],
                    "imageUrl": image_url,
                    "count": count,
                    "value": f"{count}회",
                }
            )
        out.sort(key=lambda x: (-x["count"], x["name"]))
        return out

    usage_rows = rows_for(signature=True) if signature_only else []
    if not usage_rows and signature_only:
        # 시그니처 사용이 없으면 OGQ 등으로 폴백
        usage_rows = rows_for(signature=False)
    elif not signature_only:
        usage_rows = rows_for(signature=True) + rows_for(signature=False)
        usage_rows.sort(key=lambda x: (-x["count"], x["name"]))

    top: list[dict[str, Any]] = []
    for i, item in enumerate(usage_rows[: max(1, limit)], start=1):
        top.append(
            {
                "rank": i,
                "name": item["name"],
                "value": item["value"],
                "imageUrl": item["imageUrl"],
                "count": item["count"],
            }
        )
    return top


def demo_signature_top_emoticons(
    station_id: str = "sirianrain", *, limit: int = 6
) -> list[dict[str, Any]]:
    """데모·미리보기용 — 실제 BJ 시그니처 이미지·`/제목/`."""
    items = fetch_soop_signature_emoticons(station_id)
    # 화면에서 잘 보이는 대표 몇 개 우선, 없으면 API 순서
    prefer = ("시", "사랑해요", "따봉", "검거", "팝콘", "화르륵", "하", "바")
    ordered: list[str] = []
    for title in prefer:
        if title in items:
            ordered.append(title)
    for title in items:
        if title not in ordered:
            ordered.append(title)
    counts = (428, 312, 246, 180, 144, 96)
    out: list[dict[str, Any]] = []
    for i, title in enumerate(ordered[: max(1, limit)]):
        meta = items[title]
        out.append(
            {
                "rank": i + 1,
                "name": f"/{title}/",
                "value": f"{counts[i] if i < len(counts) else 60 - i}회",
                "imageUrl": str(meta.get("imageUrl") or ""),
                "count": counts[i] if i < len(counts) else 60 - i,
            }
        )
    return out


def _floor_to_step(dt: datetime, step: timedelta) -> datetime:
    local = dt.astimezone(KST)
    seconds = int(step.total_seconds())
    if seconds <= 0:
        return local.replace(second=0, microsecond=0)
    epoch = int(local.timestamp())
    floored = epoch - (epoch % seconds)
    return datetime.fromtimestamp(floored, tz=KST)


def _ceil_to_step(dt: datetime, step: timedelta) -> datetime:
    floored = _floor_to_step(dt, step)
    local = dt.astimezone(KST)
    if floored >= local:
        return floored
    return floored + step


def _timeline_day_label(start: datetime, end: datetime) -> str:
    a = start.astimezone(KST)
    b = (end - timedelta(seconds=1)).astimezone(KST)
    if a.date() == b.date():
        return f"{a.month}월 {a.day}일"
    if a.month == b.month:
        return f"{a.month}월 {a.day}–{b.day}일"
    return f"{a.month}/{a.day}–{b.month}/{b.day}"


def _timeline_range_note(start: datetime, end: datetime) -> str:
    a = start.astimezone(KST)
    b = end.astimezone(KST)
    left = format_kst_clock(a)
    if a.date() == b.date():
        right = format_kst_clock(b)
    else:
        right = f"다음날 {format_kst_clock(b)}"
    return f"{left} – {right}"


def _build_timeline_ticks(win_start: datetime, win_end: datetime) -> list[dict[str, Any]]:
    """바에 찍을 시각 눈금 (pct + HH:MM). 정시 위주·균등 간격으로 읽기 쉽게."""
    start = win_start.astimezone(KST)
    end = win_end.astimezone(KST)
    total = max(1.0, (end - start).total_seconds())
    hours = total / 3600.0
    # 긴 구간일수록 정시(1~2시간) 눈금 — 30분 촘촘 + 무작위 솎아내기 지양
    if hours >= 10:
        step = timedelta(hours=2)
    elif hours >= 3.5:
        step = timedelta(hours=1)
    elif hours >= 1.75:
        step = timedelta(minutes=30)
    else:
        step = timedelta(minutes=15)

    def make_tick(dt: datetime) -> dict[str, Any]:
        local = dt.astimezone(KST)
        pct = pct_on_range(local, start, end)
        if local.date() != start.date() and hours >= 4:
            label = f"{local.month}/{local.day} {format_kst_clock(local)}"
        else:
            label = format_kst_clock(local)
        return {"pct": round(pct, 2), "label": label}

    edge_start = make_tick(start)
    edge_end = make_tick(end)

    candidates: list[datetime] = []
    cursor = _ceil_to_step(start + timedelta(seconds=1), step)
    while cursor < end - timedelta(seconds=60):
        candidates.append(cursor)
        cursor += step

    # 중간 눈금 최대 4개 — 시간축에서 균등 샘플
    max_mid = 4
    if len(candidates) > max_mid:
        idxs: list[int] = []
        for i in range(max_mid):
            idx = round(i * (len(candidates) - 1) / (max_mid - 1)) if max_mid > 1 else 0
            if not idxs or idxs[-1] != idx:
                idxs.append(idx)
        candidates = [candidates[i] for i in idxs]

    min_gap = 8.0  # pct — 양 끝·서로 겹치면 스킵
    mids: list[dict[str, Any]] = []
    for dt in candidates:
        tick = make_tick(dt)
        if abs(tick["pct"] - edge_start["pct"]) < min_gap:
            continue
        if abs(tick["pct"] - edge_end["pct"]) < min_gap:
            continue
        if mids and abs(tick["pct"] - mids[-1]["pct"]) < min_gap:
            continue
        mids.append(tick)

    return [edge_start, *mids, edge_end]


def build_day_timeline(session: dict[str, Any] | None = None) -> dict[str, Any]:
    """방송 구간에 맞춘 가변 시간 바 (자정 넘김 포함)."""
    session = session if isinstance(session, dict) else {}
    now = datetime.now(timezone.utc)
    started = parse_iso(session.get("startedAt"))
    ended = parse_iso(session.get("endedAt"))
    active = bool(session.get("active"))
    history = session.get("titleHistory") if isinstance(session.get("titleHistory"), list) else []

    points: list[datetime] = []
    if started:
        points.append(started)
    if ended and not active:
        points.append(ended)
    if active or not started:
        points.append(now)
    # 방종 직후면 '지금'이 보이도록 창에 약간 포함
    if not active and ended and (now - ended) <= timedelta(hours=2):
        points.append(now)
    for row in history:
        if not isinstance(row, dict):
            continue
        at = parse_iso(row.get("at"))
        if at:
            points.append(at)
    for seg in collector_segments_for_timeline(session):
        at0 = parse_iso(seg.get("startedAt"))
        at1 = parse_iso(seg.get("endedAt"))
        if at0:
            points.append(at0)
        if at1:
            points.append(at1)
    if not points:
        points = [now]

    anchor_start = min(points)
    anchor_end = max(points)
    content_span = max(timedelta(minutes=25), anchor_end - anchor_start)
    pad = max(timedelta(minutes=12), min(timedelta(minutes=75), content_span * 0.14))
    win_start = anchor_start - pad
    win_end = anchor_end + pad

    min_span = timedelta(hours=2)
    if win_end - win_start < min_span:
        mid = anchor_start + (anchor_end - anchor_start) / 2
        win_start = mid - min_span / 2
        win_end = mid + min_span / 2

    # 눈금에 맞게 살짝 맞춤 (15분)
    step = timedelta(minutes=15)
    win_start = _floor_to_step(win_start, step)
    win_end = _ceil_to_step(win_end, step)
    if win_end <= win_start:
        win_end = win_start + min_span

    day_label = _timeline_day_label(anchor_start, anchor_end)
    range_note = _timeline_range_note(win_start, win_end)
    ticks = _build_timeline_ticks(win_start, win_end)

    now_pct = pct_on_range(now, win_start, win_end)
    markers: list[dict[str, Any]] = []
    live_segments: list[dict[str, Any]] = []

    if started:
        seg_end_src = ended if (ended and not active) else now
        seg_start = started
        seg_end = seg_end_src if seg_end_src >= seg_start else seg_start
        start_pct = pct_on_range(seg_start, win_start, win_end)
        end_pct = pct_on_range(seg_end, win_start, win_end)
        live_segments.append(
            {
                "startPct": round(start_pct, 2),
                "endPct": round(max(end_pct, start_pct), 2),
                "startedAt": session.get("startedAt"),
                "endedAt": None if active else session.get("endedAt"),
            }
        )
        markers.append(
            {
                "kind": "start",
                "at": session.get("startedAt"),
                "pct": round(start_pct, 2),
                "label": f"방송 ON {format_kst_clock(started)}",
                "title": str(
                    (history[0].get("title") if history and isinstance(history[0], dict) else None)
                    or session.get("title")
                    or "방송 시작"
                ),
            }
        )

    if ended and not active:
        markers.append(
            {
                "kind": "end",
                "at": session.get("endedAt"),
                "pct": round(pct_on_range(ended, win_start, win_end), 2),
                "label": f"방송 OFF {format_kst_clock(ended)}",
            }
        )

    for idx, row in enumerate(history):
        if not isinstance(row, dict):
            continue
        at = parse_iso(row.get("at"))
        title = str(row.get("title") or "").strip()
        if not at or not title:
            continue
        # 시작과 함께 찍힌 첫 방제는 start 마커와 중복
        if idx == 0 and started and abs((at - started).total_seconds()) < 5:
            continue
        markers.append(
            {
                "kind": "title",
                "at": row.get("at"),
                "pct": round(pct_on_range(at, win_start, win_end), 2),
                "label": f"방제 {format_kst_clock(at)}",
                "title": title[:80],
            }
        )

    collector_segments: list[dict[str, Any]] = []
    for seg in collector_segments_for_timeline(session):
        seg_start = parse_iso(seg.get("startedAt"))
        if not seg_start:
            continue
        seg_end = parse_iso(seg.get("endedAt"))
        open_seg = not seg.get("endedAt")
        if open_seg:
            seg_end = now if active else (ended or now)
        if not seg_end or seg_end < seg_start:
            seg_end = seg_start
        start_pct = pct_on_range(seg_start, win_start, win_end)
        end_pct = pct_on_range(seg_end, win_start, win_end)
        estimated = bool(seg.get("estimated"))
        collector_segments.append(
            {
                "startPct": round(start_pct, 2),
                "endPct": round(max(end_pct, start_pct), 2),
                "startedAt": seg.get("startedAt"),
                "endedAt": None if open_seg else seg.get("endedAt"),
                "estimated": estimated,
            }
        )
        markers.append(
            {
                "kind": "collector_on",
                "at": seg.get("startedAt"),
                "pct": round(start_pct, 2),
                "label": f"수집 시작 {format_kst_clock(seg_start)}",
                "title": "추정" if estimated else "수집기 연결",
                "estimated": estimated,
            }
        )
        if not open_seg and seg.get("endedAt"):
            markers.append(
                {
                    "kind": "collector_off",
                    "at": seg.get("endedAt"),
                    "pct": round(end_pct, 2),
                    "label": f"수집 종료 {format_kst_clock(seg_end)}",
                    "title": "추정" if estimated else "수집기 연결 해제",
                    "estimated": estimated,
                }
            )

    now_local = now.astimezone(KST)
    if win_start - timedelta(minutes=2) <= now_local <= win_end + timedelta(minutes=2):
        markers.append(
            {
                "kind": "now",
                "at": utc_now_iso(),
                "pct": round(now_pct, 2),
                "label": f"지금 {format_kst_clock(now)}",
            }
        )
    markers.sort(key=lambda m: float(m.get("pct") or 0))

    return {
        "dayLabel": day_label,
        "dayStart": win_start.isoformat(),
        "dayEnd": win_end.isoformat(),
        "rangeNote": range_note,
        "ticks": ticks,
        "timezone": "Asia/Seoul",
        "nowPct": round(now_pct, 2),
        "liveSegments": live_segments,
        "collectorSegments": collector_segments,
        "markers": markers,
        "titleHistory": [
            {
                "title": str(r.get("title") or ""),
                "at": r.get("at"),
                "clock": format_kst_clock(parse_iso(r.get("at"))),
            }
            for r in history
            if isinstance(r, dict) and r.get("title")
        ][-20:],
    }


def timeline_for_viewer(timeline: dict[str, Any] | None) -> dict[str, Any]:
    """시청자 엔딩용 — 수집기 연결 마커·구간 제거 (일기장·수집기는 build_day_timeline 원본 사용)."""
    tl = dict(timeline) if isinstance(timeline, dict) else {}
    markers = [
        m
        for m in (tl.get("markers") or [])
        if isinstance(m, dict)
        and str(m.get("kind") or "") in ("start", "end", "title", "now")
        and "수집기" not in str(m.get("title") or "")
    ]
    tl["markers"] = markers
    tl["collectorSegments"] = []
    return tl


def _normalize_collector_segments(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        started = str(row.get("startedAt") or "").strip()
        if not started:
            continue
        ended = row.get("endedAt")
        ended_s = str(ended).strip() if ended else None
        out.append({"startedAt": started, "endedAt": ended_s or None})
    return out[-40:]


def open_collector_segment(session: dict[str, Any], *, at: str | None = None) -> bool:
    """수집기 연결 시작. 이미 열린 구간이 있으면 False."""
    now = str(at or utc_now_iso())
    segs = _normalize_collector_segments(session.get("collectorSegments"))
    if segs and not segs[-1].get("endedAt"):
        return False
    segs.append({"startedAt": now, "endedAt": None})
    session["collectorSegments"] = segs
    session["chatSdkConnected"] = True
    session["pendingChatSdk"] = False
    return True


def close_collector_segment(session: dict[str, Any], *, at: str | None = None) -> bool:
    """수집기 연결 종료(열린 구간만)."""
    now = str(at or utc_now_iso())
    segs = _normalize_collector_segments(session.get("collectorSegments"))
    if not segs or segs[-1].get("endedAt"):
        session["collectorSegments"] = segs
        session["chatSdkConnected"] = False
        return False
    segs[-1]["endedAt"] = now
    session["collectorSegments"] = segs
    session["chatSdkConnected"] = False
    session["pendingChatSdk"] = True
    return True


def collector_segments_for_timeline(session: dict[str, Any]) -> list[dict[str, Any]]:
    """명시 구간이 없으면 채팅/후원 타임스탬프로 대략 추정."""
    explicit = _normalize_collector_segments(session.get("collectorSegments"))
    if explicit:
        return explicit

    times: list[datetime] = []
    chatters = session.get("chatters") if isinstance(session.get("chatters"), dict) else {}
    for row in chatters.values():
        if not isinstance(row, dict):
            continue
        for key in ("joinedAt", "leftAt", "lastSeenAt"):
            raw = row.get(key)
            try:
                ms = float(raw)
            except (TypeError, ValueError):
                continue
            if ms > 1_000_000_000_000:
                times.append(datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc))
            elif ms > 1_000_000_000:
                times.append(datetime.fromtimestamp(ms, tz=timezone.utc))
    donations = session.get("donations") if isinstance(session.get("donations"), dict) else {}
    for row in donations.values():
        if not isinstance(row, dict):
            continue
        at = parse_iso(row.get("at") or row.get("lastAt"))
        if at:
            times.append(at)
    if not times:
        return []
    start = min(times)
    end = max(times)
    if (end - start).total_seconds() < 5:
        end = start + timedelta(seconds=30)
    return [
        {
            "startedAt": start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "endedAt": end.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "estimated": True,
        }
    ]


def empty_session(station_id: str = "") -> dict[str, Any]:
    return {
        "version": 1,
        "active": False,
        "stationId": str(station_id or "").strip(),
        "title": "",
        "titleHistory": [],
        "startedAt": None,
        "endedAt": None,
        "peakViewers": 0,
        "peakViewersAt": None,
        "peakTitle": "",
        "peakThumbUrl": "",
        "lastViewerCount": 0,
        "lastUpCount": None,
        "upBaseline": None,
        "upGain": 0,
        "balloonTotal": 0,
        "metricsSeries": empty_metrics_series(),
        "broadNo": "",
        "thumbnailUrl": "",
        "updatedAt": utc_now_iso(),
        "chatters": {},
        "firstChat": None,
        "donations": {},
        "signatureHits": {},
        "amountHits": {},
        "emoticons": {},
        "emoticonUsage": {},
        "subscribers": [],
        "subscriberRenewals": [],
        "subscriptionGifts": [],
        "fanclubJoins": [],
        "fanclubCount": 0,
        "topFans": [],
        "topFanTracker": {},
        "identityFlags": {},
        "quickviews": {},
        "missions": {},
        "missionRuns": [],
        "donationNotes": [],
        "ssapiFeed": [],
        "gems": {},
        "chatSdkConnected": False,
        "pendingChatSdk": True,
        "collectorSegments": [],
    }


# 방종을 놓친 채 active로 남은 세션 — 이 시간 이상 갱신 없으면 새 방송으로 본다
_STALE_ACTIVE_SESSION = timedelta(hours=4)
# SOOP 라이브 API가 잠깐 false를 주는 경우 — 연속 N회 확인 후 방종 처리
# (10초 폴링 기준 ≈ 1분; 짧게 잡으면 오탐 방종 → 세션 분실로 이어짐)
_OFFLINE_CONFIRM_POLLS = 6
# 같은 broadNo 방송은 당일 단위로 이어 씀 (크레딧=하루 정리; 45분은 너무 짧음)
_RESUME_SAME_BROADCAST = timedelta(hours=18)


def _credits_log(msg: str) -> None:
    """gunicorn이 logs/app-credits.log 로 받는 stdout 한 줄 로그."""
    try:
        ts = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")
        print(f"[credits {ts}] {msg}", flush=True)
    except Exception:
        pass


def session_chat_count(session: dict[str, Any] | None) -> int:
    session = session if isinstance(session, dict) else {}
    chatters = session.get("chatters") if isinstance(session.get("chatters"), dict) else {}
    total = 0
    for row in chatters.values():
        if not isinstance(row, dict):
            continue
        try:
            total += int(row.get("count") or 0)
        except (TypeError, ValueError):
            continue
    return total


def session_data_score(session: dict[str, Any] | None) -> int:
    """세션에 쌓인 수집량 점수 — 파일 충돌 시 더 풍부한 쪽을 고를 때 사용."""
    session = session if isinstance(session, dict) else {}
    try:
        peak = int(session.get("peakViewers") or 0)
    except (TypeError, ValueError):
        peak = 0
    chatters = session.get("chatters") if isinstance(session.get("chatters"), dict) else {}
    chats = session_chat_count(session)
    donations = session.get("donations") if isinstance(session.get("donations"), dict) else {}
    return peak * 10 + chats * 5 + len(chatters) + len(donations) * 20


def resume_collector_session(session: dict[str, Any]) -> dict[str, Any]:
    """오탐 방종·재연결 후 같은 세션을 다시 연다 (startedAt·집계 유지)."""
    session["active"] = True
    session["endedAt"] = None
    open_collector_segment(session)
    return session


def session_needs_new_broadcast(session: dict[str, Any] | None) -> bool:
    """종료·미시작·오래 갱신 안 된 active 세션이면 True (어제 데이터에 이어 쓰지 않기)."""
    session = session if isinstance(session, dict) else {}
    if not session.get("startedAt"):
        return True
    if session.get("endedAt") and not session.get("active"):
        return True
    if not session.get("active"):
        return True
    if session.get("endedAt") and session.get("active"):
        return True
    updated = parse_iso(session.get("updatedAt")) or parse_iso(session.get("startedAt"))
    if updated and datetime.now(timezone.utc) - updated > _STALE_ACTIVE_SESSION:
        return True
    return False


def session_can_resume_same_broadcast(
    session: dict[str, Any] | None,
    *,
    broad_no: str = "",
) -> bool:
    """끝난 세션이 같은 방송 번호(또는 당일 동일 채널)면 새 세션 대신 이어서 수집."""
    session = session if isinstance(session, dict) else {}
    if not session.get("startedAt"):
        return False
    if session.get("active") and not session.get("endedAt"):
        return False
    ended = parse_iso(session.get("endedAt"))
    if not ended:
        return False
    if datetime.now(timezone.utc) - ended > _RESUME_SAME_BROADCAST:
        return False
    prev_broad = str(session.get("broadNo") or "").strip()
    want = str(broad_no or "").strip()
    if want and prev_broad and want != prev_broad:
        return False
    if not prev_broad and not want:
        # broad 없어도 이미 쌓인 데이터가 있으면 이어 쓰기 후보
        if session_data_score(session) <= 0 and not str(session.get("title") or "").strip():
            return False
    return True


def session_must_preserve(
    session: dict[str, Any] | None,
    *,
    broad_no: str = "",
) -> bool:
    """데이터가 있는 세션은 broadNo가 바뀌기 전까지 절대 new_session으로 덮지 않음."""
    session = session if isinstance(session, dict) else {}
    if not session.get("startedAt"):
        return False
    want = str(broad_no or "").strip()
    prev = str(session.get("broadNo") or "").strip()
    if want and prev and want != prev:
        return False
    if session_data_score(session) > 0:
        return True
    if session.get("active") and not session.get("endedAt"):
        return True
    return session_can_resume_same_broadcast(session, broad_no=broad_no)


def session_worth_archiving(session: dict[str, Any] | None) -> bool:
    """빈 연결·수 초짜리 테스트는 건너뛰고, 의미 있는 방송만 보관."""
    session = session if isinstance(session, dict) else {}
    if not session.get("startedAt"):
        return False
    start = parse_iso(session.get("startedAt"))
    end = parse_iso(session.get("endedAt")) or datetime.now(timezone.utc)
    if start:
        duration_sec = max(0, int((end - start).total_seconds()))
    else:
        duration_sec = 0
    try:
        peak = int(session.get("peakViewers") or 0)
    except (TypeError, ValueError):
        peak = 0
    chatters = session.get("chatters") if isinstance(session.get("chatters"), dict) else {}
    chat_n = sum(
        1
        for row in chatters.values()
        if isinstance(row, dict) and int(row.get("count") or 0) > 0
    )
    donations = session.get("donations") if isinstance(session.get("donations"), dict) else {}
    don_n = len(donations)
    hits = session.get("amountHits") if isinstance(session.get("amountHits"), dict) else {}
    title = str(session.get("title") or "").strip()
    # 시청·후원·방제가 있으면 방송으로 본다
    if peak > 0 or don_n > 0 or hits or title:
        return True
    # 채팅만 있고 1분 미만이면 연결 테스트로 보고 제외
    if chat_n > 0 and duration_sec >= 60:
        return True
    return duration_sec >= 60


def archive_id_for_session(session: dict[str, Any]) -> str:
    """KST 기준 'YYYY-MM-DD/HHMMSS_stationId'."""
    start = parse_iso(session.get("startedAt")) or datetime.now(timezone.utc)
    local = start.astimezone(KST)
    day = local.strftime("%Y-%m-%d")
    clock = local.strftime("%H%M%S")
    sid = re.sub(r"[^\w.\-]+", "_", str(session.get("stationId") or "unknown").strip()) or "unknown"
    return f"{day}/{clock}_{sid}"


def session_debug_stem(session: dict[str, Any]) -> tuple[str, str]:
    """(YYYY-MM-DD, HHMMSS_station) — archive_id 와 동일 규칙."""
    aid = archive_id_for_session(session)
    day, name = aid.split("/", 1)
    return day, name


def build_raw_ingest_row(
    *,
    status: str,
    action: str,
    msg: dict[str, Any] | None,
    ts: str,
    session: dict[str, Any],
    source: str = "",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "v": 1,
        "kind": "event",
        "receivedAt": utc_now_iso(),
        "status": status,
        "action": str(action or ""),
        "at": ts,
        "stationId": str(session.get("stationId") or "").strip(),
        "broadNo": str(session.get("broadNo") or "").strip(),
        "sessionStartedAt": session.get("startedAt"),
        "source": str(source or "").strip(),
        "message": sanitize_raw_message(msg if isinstance(msg, dict) else {}),
    }
    if extra:
        row.update(extra)
    return row


_chat_raw_series_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}


def raw_jsonl_path_for_session(session: dict[str, Any], raw_dir: Path) -> Path | None:
    """세션 startedAt 기준 credits-raw JSONL 경로."""
    if not isinstance(session, dict) or not session.get("startedAt"):
        return None
    day, stem = session_debug_stem(session)
    path = Path(raw_dir) / day / f"{stem}.jsonl"
    return path if path.is_file() else None


def iter_raw_jsonl_events(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return rows
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        if row.get("kind") == "batch":
            continue
        rows.append(row)
    return rows


def build_chat_metrics_series_from_raw_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """accepted 채팅 raw 이벤트 → 1분 버킷 시계열."""
    buckets: dict[str, int] = {}
    for row in rows:
        if str(row.get("status") or "").strip().lower() != "accepted":
            continue
        action = str(row.get("action") or "").strip().upper()
        if action not in CHAT_ACTIONS:
            continue
        at_raw = str(row.get("at") or "").strip()
        if not at_raw:
            continue
        parsed = parse_iso(at_raw)
        if not parsed:
            continue
        at_iso = _minute_bucket_iso(parsed)
        buckets[at_iso] = int(buckets.get(at_iso) or 0) + 1
    out = [{"at": at, "v": buckets[at]} for at in sorted(buckets.keys())]
    if len(out) > _METRICS_SERIES_MAX_POINTS:
        out = out[-_METRICS_SERIES_MAX_POINTS:]
    return out


def merge_chat_metrics_with_raw_backfill(
    stored: list[Any] | None,
    raw: list[Any] | None,
) -> list[dict[str, Any]]:
    """실시간 metricsSeries.chats 우선. 기능 도입 전 누락 분만 raw로 보충."""
    stored_map: dict[str, int] = {}
    for row in stored or []:
        if not isinstance(row, dict):
            continue
        at = str(row.get("at") or "").strip()
        if not at:
            continue
        try:
            stored_map[at] = int(row.get("v") or 0)
        except (TypeError, ValueError):
            continue

    if not stored_map:
        out = [{"at": str(r.get("at") or ""), "v": int(r.get("v") or 0)} for r in raw or [] if isinstance(r, dict) and r.get("at")]
        if len(out) > _METRICS_SERIES_MAX_POINTS:
            out = out[-_METRICS_SERIES_MAX_POINTS:]
        return out

    fill: dict[str, int] = {}
    for row in raw or []:
        if not isinstance(row, dict):
            continue
        at = str(row.get("at") or "").strip()
        if not at or at in stored_map:
            continue
        try:
            fill[at] = int(row.get("v") or 0)
        except (TypeError, ValueError):
            continue

    combined = {**fill, **stored_map}
    out = [{"at": at, "v": combined[at]} for at in sorted(combined.keys())]
    if len(out) > _METRICS_SERIES_MAX_POINTS:
        out = out[-_METRICS_SERIES_MAX_POINTS:]
    return out


def chat_metrics_series_for_session(
    session: dict[str, Any] | None,
    *,
    raw_dir: Path,
) -> list[dict[str, Any]]:
    """세션 chats 시계열 — 실시간 저장 우선, 빈 구간만 raw 보충."""
    if not isinstance(session, dict):
        return []
    ms = session.get("metricsSeries")
    stored: list[Any] = []
    if isinstance(ms, dict) and isinstance(ms.get("chats"), list):
        stored = ms["chats"]
    raw = build_chat_metrics_series_from_session_raw(session, raw_dir=raw_dir)
    return merge_chat_metrics_with_raw_backfill(stored, raw)


def build_chat_metrics_series_from_session_raw(
    session: dict[str, Any] | None,
    *,
    raw_dir: Path,
) -> list[dict[str, Any]]:
    """저장된 credits-raw JSONL에서 채팅 화력 시계열 생성."""
    if not isinstance(session, dict):
        return []
    path = raw_jsonl_path_for_session(session, raw_dir)
    if not path:
        return []
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return []
    cache_key = str(path)
    cached = _chat_raw_series_cache.get(cache_key)
    if cached and cached[0] == mtime:
        return list(cached[1])
    series = build_chat_metrics_series_from_raw_rows(iter_raw_jsonl_events(path))
    _chat_raw_series_cache[cache_key] = (mtime, series)
    if len(_chat_raw_series_cache) > 32:
        _chat_raw_series_cache.pop(next(iter(_chat_raw_series_cache)))
    return series


def empty_credits_payload() -> dict[str, Any]:
    return {
        "version": 1,
        "demo": False,
        "source": "live",
        "pendingChatSdk": True,
        "info": {
            "title": "오늘의 방송",
            "dateLabel": "",
            "durationLabel": "",
            "peakViewers": 0,
            "peakViewersAt": None,
            "peakAtLabel": "",
            "peakTitle": "",
            "peakThumbUrl": "",
            "chatters": 0,
            "chatCount": 0,
            "firstChat": None,
        },
        "sections": [
            {"id": "chat", "title": "채팅 순위", "pending": True, "items": []},
            {"id": "watch", "title": "시청 시간 순위", "pending": True, "items": []},
            {"id": "donation", "title": "후원 순위", "pending": True, "items": []},
            {"id": "signature", "title": "시그니처 순위", "pending": True, "items": [], "moreHits": 0},
            {"id": "emoticon", "title": "이모티콘 순위", "pending": True, "items": [], "topEmoticons": []},
            {"id": "subscribe", "title": "신규 구독", "pending": True, "items": []},
            {"id": "subscribe_renew", "title": "연속 구독", "pending": True, "items": []},
            {"id": "subscribe_gift", "title": "구독 선물", "pending": True, "items": []},
            {"id": "fanclub", "title": "팬클럽 가입", "pending": True, "items": []},
            {"id": "topfan", "title": "열혈팬 승급", "pending": True, "items": []},
            {"id": "quickview", "title": "퀵뷰 순위", "pending": True, "items": []},
            {"id": "mission", "title": "미션 순위", "pending": True, "items": []},
        ],
        "timeline": build_day_timeline({}),
        "footer": {
            "line": "오늘 방송 종료",
            "sub": "다음 방송에서 또 만나요",
        },
    }


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def build_demo_credits_payload() -> dict[str, Any]:
    """미리보기용 테스트 데이터. 닉·방제·멘트는 실방송처럼 보이지 않게 명시적 더미."""
    now = datetime.now(timezone.utc)
    now_kst = now.astimezone(KST)

    # 레이아웃·타임라인 분량만 실방송에 가깝게 (약 3시간)
    start_kst = (now_kst - timedelta(hours=3, minutes=12)).replace(second=0, microsecond=0)

    def at_offset(minutes: int) -> datetime:
        return start_kst + timedelta(minutes=minutes)

    def ranked(pairs: list[tuple[str, str]]) -> list[dict[str, Any]]:
        return [
            {"rank": i, "name": name, "value": value}
            for i, (name, value) in enumerate(pairs, start=1)
        ]

    def named(names: list[str]) -> list[dict[str, str]]:
        return [{"name": n} for n in names]

    def nick(_kind: str, n: int) -> str:
        """사람 닉 — 실닉처럼 보이지 않게 유저01…"""
        return f"유저{n:02d}"

    elapsed_min = max(40, int((now_kst - start_kst).total_seconds() // 60))
    title_plan = [
        (0, "데모 방송 시작"),
        (9, "데모 방제 A"),
        (28, "데모 방제 B"),
        (55, "데모 미션 구간"),
        (88, "데모 후원 구간"),
        (125, "데모 신청곡 구간"),
        (158, "데모 Q&A 구간"),
        (min(elapsed_min - 6, 185), "데모 엔딩 직전"),
    ]
    history: list[dict[str, str]] = []
    seen_titles: set[str] = set()
    last_mins = -999
    for mins, title in title_plan:
        if mins < 0 or mins > elapsed_min:
            continue
        if mins - last_mins < 2 and mins > 0:
            continue
        if title in seen_titles and mins > 0:
            continue
        seen_titles.add(title)
        t = at_offset(mins)
        if t > now_kst:
            continue
        history.append({"title": title, "at": _iso_z(t)})
        last_mins = mins

    if not history:
        history = [{"title": "데모 방송", "at": _iso_z(start_kst)}]

    started_at = history[0]["at"]
    current_title = str(history[-1]["title"])
    duration = format_duration(started_at, None)
    peak_mins = min(max(elapsed_min - 35, 40), 158)

    session = {
        "active": True,
        "title": current_title,
        "startedAt": started_at,
        "endedAt": None,
        "titleHistory": history,
    }
    timeline = build_day_timeline(session)

    fanclub_names = [nick("팬클럽", i) for i in range(1, 33)]

    return {
        "version": 1,
        "demo": True,
        "source": "demo",
        "pendingChatSdk": False,
        "active": True,
        "session": {
            "startedAt": started_at,
            "endedAt": None,
            "stationId": None,
        },
        "info": {
            "title": current_title,
            "dateLabel": format_date_label(started_at),
            "durationLabel": duration or "3시간 12분",
            "peakViewers": 1234,
            "peakViewersAt": _iso_z(at_offset(peak_mins)),
            "peakAtLabel": format_kst_clock(at_offset(peak_mins)),
            "peakTitle": "데모 Q&A 구간",
            "peakThumbUrl": "",
            "chatters": 100,
            "chatCount": 9999,
            "fanclubCount": 32,
            "subscribeCount": 14,
            "subscribeRenewCount": 11,
            "subscribeGiftCount": 6,
            "topFanCount": 5,
            "flagCounts": {"fan": 40, "topFan": 10, "follower": 50, "manager": 3},
            "firstChat": {
                "name": nick("첫채팅", 1),
                "message": "테스트 데이터입니다",
                "atLabel": "방송 시작 12초",
            },
            "upGain": 3420,
            "balloonTotal": 12480,
            "donationCount": 14,
        },
        "metricsSeries": {
            "viewers": [
                {"at": _iso_z(at_offset(m)), "v": v}
                for m, v in (
                    (0, 320),
                    (15, 480),
                    (30, 620),
                    (45, 780),
                    (60, 910),
                    (80, 1050),
                    (peak_mins, 1234),
                    (peak_mins + 10, 1180),
                    (peak_mins + 25, 980),
                    (peak_mins + 40, 860),
                    (peak_mins + 55, 740),
                    (peak_mins + 70, 690),
                    (peak_mins + 90, 640),
                    (max(peak_mins + 100, elapsed_min - 5), 580),
                )
                if m <= elapsed_min
            ],
            "up": [],
            "balloons": [],
        },
        "sections": [
            {
                "id": "chat",
                "title": "채팅 순위",
                "pending": False,
                "items": ranked(
                    [(nick("채팅", i), f"{250 - i * 12}번") for i in range(1, 16)]
                ),
            },
            {
                "id": "watch",
                "title": "시청 시간 순위",
                "pending": False,
                "items": ranked(
                    [
                        (nick("시청", 1), "3시간 08분"),
                        (nick("시청", 2), "3시간 02분"),
                        (nick("시청", 3), "2시간 55분"),
                        (nick("시청", 4), "2시간 41분"),
                        (nick("시청", 5), "2시간 28분"),
                        (nick("시청", 6), "2시간 12분"),
                        (nick("시청", 7), "1시간 58분"),
                        (nick("시청", 8), "1시간 44분"),
                        (nick("시청", 9), "1시간 31분"),
                        (nick("시청", 10), "1시간 18분"),
                        (nick("시청", 11), "1시간 05분"),
                        (nick("시청", 12), "52분"),
                    ]
                ),
            },
            {
                "id": "donation",
                "title": "후원 순위",
                "pending": False,
                "items": ranked(
                    [
                        (nick("후원", 1), "4,820개"),
                        (nick("후원", 2), "2,450개"),
                        (nick("후원", 3), "1,180개"),
                        (nick("후원", 4), "860개"),
                        (nick("후원", 5), "640개"),
                        (nick("후원", 6), "480개"),
                        (nick("후원", 7), "350개"),
                        (nick("후원", 8), "280개"),
                        (nick("후원", 9), "210개"),
                        (nick("후원", 10), "160개"),
                        (nick("후원", 11), "120개"),
                        (nick("후원", 12), "90개"),
                        (nick("후원", 13), "70개"),
                        (nick("후원", 14), "50개"),
                    ]
                ),
            },
            {
                "id": "signature",
                "title": "시그니처 순위",
                "pending": False,
                "items": [
                    {
                        "rank": 1,
                        "name": "112개",
                        "value": "28번",
                        "topDonor": nick("후원", 1),
                        "topDonorHits": 11,
                        "morePeople": 14,
                        "imageUrl": "",
                    },
                    {
                        "rank": 2,
                        "name": "152개",
                        "value": "19번",
                        "topDonor": nick("후원", 2),
                        "topDonorHits": 8,
                        "morePeople": 9,
                        "imageUrl": "",
                    },
                    {
                        "rank": 3,
                        "name": "505개",
                        "value": "12번",
                        "topDonor": nick("후원", 3),
                        "topDonorHits": 7,
                        "morePeople": 6,
                        "imageUrl": "",
                    },
                    {
                        "rank": 4,
                        "name": "700개",
                        "value": "9번",
                        "topDonor": nick("후원", 4),
                        "topDonorHits": 5,
                        "morePeople": 4,
                        "imageUrl": "",
                    },
                    {
                        "rank": 5,
                        "name": "1,724개",
                        "value": "6번",
                        "topDonor": nick("후원", 5),
                        "topDonorHits": 3,
                        "morePeople": 3,
                        "imageUrl": "",
                    },
                    {
                        "rank": 6,
                        "name": "10,000개",
                        "value": "3번",
                        "topDonor": nick("후원", 6),
                        "topDonorHits": 2,
                        "morePeople": 1,
                        "imageUrl": "",
                    },
                ],
                "moreHits": 3,
            },
            {
                "id": "emoticon",
                "title": "이모티콘 순위",
                "pending": False,
                "items": ranked(
                    [(nick("이모티콘", i), f"{190 - i * 12}회") for i in range(1, 13)]
                ),
                "topEmoticons": demo_signature_top_emoticons("sirianrain", limit=6),
            },
            {
                "id": "subscribe",
                "title": "신규 구독",
                "pending": False,
                "items": named([nick("신규구독", i) for i in range(1, 15)]),
            },
            {
                "id": "subscribe_renew",
                "title": "연속 구독",
                "pending": False,
                "items": [
                    {"name": nick("연속구독", i), "value": f"{25 - i}개월"}
                    for i in range(1, 12)
                ],
            },
            {
                "id": "subscribe_gift",
                "title": "구독 선물",
                "pending": False,
                "items": [
                    {"name": nick("구독선물", 1), "value": "구독 1개월"},
                    {"name": nick("구독선물", 2), "value": "구독 1개월"},
                    {"name": nick("구독선물", 3), "value": "구독 3개월"},
                    {"name": nick("구독선물", 4), "value": "구독 1개월"},
                    {"name": nick("구독선물", 5), "value": "구독 플러스 1개월"},
                    {"name": nick("구독선물", 6), "value": "구독 6개월"},
                ],
            },
            {
                "id": "fanclub",
                "title": "팬클럽 가입",
                "pending": False,
                "items": named(fanclub_names),
            },
            {
                "id": "topfan",
                "title": "열혈팬 승급",
                "pending": False,
                "items": named([nick("열혈", i) for i in range(1, 6)]),
            },
            {
                "id": "quickview",
                "title": "퀵뷰 순위",
                "pending": False,
                "items": ranked(
                    [(nick("퀵뷰", i), f"{10 - i}회") for i in range(1, 11)]
                ),
            },
            {
                "id": "mission",
                "title": "미션 순위",
                "pending": False,
                "items": ranked(
                    [
                        (nick("미션", 1), "420개"),
                        (nick("미션", 2), "280개"),
                        (nick("미션", 3), "190개"),
                        (nick("미션", 4), "150개"),
                        (nick("미션", 5), "120개"),
                        (nick("미션", 6), "90개"),
                        (nick("미션", 7), "70개"),
                        (nick("미션", 8), "55개"),
                        (nick("미션", 9), "40개"),
                        (nick("미션", 10), "30개"),
                        (nick("미션", 11), "20개"),
                        (nick("미션", 12), "15개"),
                    ]
                ),
            },
        ],
        "timeline": timeline,
        "footer": {
            "line": "데모 방송 종료",
            "sub": "테스트 데이터입니다",
        },
    }


class CreditsStore:
    def __init__(
        self,
        session_path: Path,
        credits_path: Path,
        *,
        station_id: str = "sirianrain",
        seed_path: Path | None = None,
        live_fetcher: Callable[[str], dict] | None = None,
        poll_interval_sec: float = 30.0,
    ):
        self.session_path = Path(session_path)
        self.credits_path = Path(credits_path)
        self.seed_path = Path(seed_path) if seed_path else None
        self.station_id = str(station_id or "sirianrain").strip()
        self.live_fetcher = live_fetcher
        self.poll_interval_sec = max(2.0, float(poll_interval_sec))
        self.peak_thumb_path = self.session_path.parent / "credits-peak-thumb.jpg"
        self.archive_dir = self.session_path.parent / "credits-archive"
        self.sessions_dir = self.session_path.parent / "credits-sessions"
        self.backup_dir = self.session_path.parent / "credits-backup"
        self.raw_dir = self.session_path.parent / "credits-raw"
        self._offline_streak = 0
        self._prune_counter = 0

    def peak_thumb_file(self) -> Path:
        return self.peak_thumb_path

    @staticmethod
    def _norm_station_id(station_id: str) -> str:
        return str(station_id or "").strip().lower()

    def _station_session_path(self, station_id: str) -> Path:
        sid = self._norm_station_id(station_id)
        safe = re.sub(r"[^a-z0-9_.\-]+", "_", sid) or "unknown"
        return self.sessions_dir / f"{safe}.json"

    def _hydrate_session(self, data: dict[str, Any], *, fallback_station: str = "") -> dict[str, Any]:
        if not isinstance(data, dict):
            data = empty_session(fallback_station or self.station_id)
        data.setdefault("chatters", {})
        data.setdefault("donations", {})
        data.setdefault("signatureHits", {})
        data.setdefault("amountHits", {})
        data.setdefault("emoticons", {})
        data.setdefault("emoticonUsage", {})
        # 리스트 필드가 dict로 깨지면 append 시 구독·팬클럽 집계가 통째로 실패한다
        for key in (
            "subscribers",
            "subscriberRenewals",
            "subscriptionGifts",
            "fanclubJoins",
            "topFans",
            "titleHistory",
            "collectorSegments",
            "missionRuns",
            "donationNotes",
            "ssapiFeed",
        ):
            if not isinstance(data.get(key), list):
                data[key] = []
        data.setdefault("identityFlags", {})
        data.setdefault("topFanTracker", {})
        if not isinstance(data.get("topFanTracker"), dict):
            data["topFanTracker"] = {}
        data.setdefault("quickviews", {})
        data.setdefault("missions", {})
        data.setdefault("missionRuns", [])
        if not isinstance(data.get("missionRuns"), list):
            data["missionRuns"] = []
        data.setdefault("donationNotes", [])
        if not isinstance(data.get("donationNotes"), list):
            data["donationNotes"] = []
        data.setdefault("ssapiFeed", [])
        if not isinstance(data.get("ssapiFeed"), list):
            data["ssapiFeed"] = []
        data.setdefault("gems", {})
        data.setdefault("balloonTotal", 0)
        data.setdefault("upGain", 0)
        ensure_metrics_series(data)
        hydrate_topfan_tracker(
            data["topFanTracker"],
            data.get("identityFlags") if isinstance(data.get("identityFlags"), dict) else {},
            data.get("topFans") if isinstance(data.get("topFans"), list) else [],
        )
        return data

    def _read_session_file(self, path: Path, *, fallback_station: str = "") -> dict[str, Any]:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = empty_session(fallback_station or self.station_id)
        return self._hydrate_session(data, fallback_station=fallback_station)

    def _mirror_station_session(self, session: dict[str, Any]) -> None:
        """계정별 세션 파일에도 같이 저장 — 로그인 전환 시 서로 덮지 않음."""
        sid = self._norm_station_id(session.get("stationId") or self.station_id)
        if not sid:
            return
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self._write_json(self._station_session_path(sid), session)

    def load_session_for(self, station_id: str) -> dict[str, Any]:
        """특정 계정의 세션(활성 포인터와 무관). 없으면 빈 세션."""
        sid = self._norm_station_id(station_id)
        if not sid:
            return empty_session("")
        path = self._station_session_path(sid)
        if path.exists():
            return self._read_session_file(path, fallback_station=sid)
        # 활성 파일이 그 계정이면 그걸 사용
        active = self.load_session()
        if self._norm_station_id(active.get("stationId")) == sid:
            return active
        return empty_session(sid)

    def clear_local_peak_thumb(self) -> None:
        try:
            if self.peak_thumb_path.exists():
                self.peak_thumb_path.unlink()
        except OSError:
            pass

    def archive_session(
        self,
        session: dict[str, Any] | None,
        *,
        force: bool = False,
    ) -> str | None:
        """세션을 날짜별 아카이브로 저장. 성공 시 archive id, 스킵/실패 시 None.

        경로: data/credits-archive/YYYY-MM-DD/HHMMSS_stationId.json
        """
        session = dict(session) if isinstance(session, dict) else {}
        if not force and not session_worth_archiving(session):
            return None
        if not session.get("startedAt"):
            return None
        archive_id = archive_id_for_session(session)
        day, name = archive_id.split("/", 1)
        day_dir = self.archive_dir / day
        day_dir.mkdir(parents=True, exist_ok=True)
        json_path = day_dir / f"{name}.json"
        # 이미 같은 startedAt 아카이브가 있고 force 아니면, 종료 시각이 더 최신이면 덮어씀
        credits = self.build_credits_payload(session)
        peak_name = ""
        if self.has_local_peak_thumb():
            peak_name = f"{name}.jpg"
            try:
                import shutil

                shutil.copy2(self.peak_thumb_path, day_dir / peak_name)
            except OSError:
                peak_name = ""
        payload = {
            "version": 1,
            "archiveId": archive_id,
            "archivedAt": utc_now_iso(),
            "stationId": str(session.get("stationId") or "").strip(),
            "startedAt": session.get("startedAt"),
            "endedAt": session.get("endedAt"),
            "title": str(session.get("title") or "").strip(),
            "peakViewers": int(session.get("peakViewers") or 0),
            "peakThumbFile": peak_name,
            "session": session,
            "credits": credits,
        }
        self._write_json(json_path, payload)
        # 방종 아카이브와 별도로 디버그 백업도 남김
        try:
            self.write_session_backup(session, reason="archive")
        except OSError as exc:
            _credits_log(f"backup on archive FAIL {exc}")
        return archive_id

    def _prune_debug_tree(self, root: Path, *, retention_days: int) -> None:
        if not root.is_dir():
            return
        cutoff = datetime.now(KST).date() - timedelta(days=max(1, retention_days))
        try:
            children = list(root.iterdir())
        except OSError:
            return
        for child in children:
            if not child.is_dir():
                continue
            try:
                day = datetime.strptime(child.name, "%Y-%m-%d").date()
            except ValueError:
                continue
            if day >= cutoff:
                continue
            try:
                import shutil

                shutil.rmtree(child, ignore_errors=True)
            except OSError:
                pass

    def _prune_backup_day(self, day_dir: Path) -> None:
        if not day_dir.is_dir():
            return
        try:
            files = sorted(
                [p for p in day_dir.glob("*.json") if p.is_file()],
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
        except OSError:
            return
        for old in files[CREDITS_BACKUP_MAX_PER_DAY:]:
            try:
                old.unlink()
            except OSError:
                pass

    def maybe_prune_debug_stores(self) -> None:
        """가끔만 정리 — ingest/backup 때마다 전수 스캔하지 않음."""
        self._prune_counter = int(getattr(self, "_prune_counter", 0) or 0) + 1
        if self._prune_counter % 40 != 1:
            return
        self._prune_debug_tree(self.backup_dir, retention_days=CREDITS_BACKUP_RETENTION_DAYS)
        self._prune_debug_tree(self.raw_dir, retention_days=CREDITS_RAW_RETENTION_DAYS)

    def write_session_backup(
        self,
        session: dict[str, Any] | None,
        *,
        reason: str = "interval",
    ) -> str | None:
        """중간 세션 스냅샷. 경로: data/credits-backup/YYYY-MM-DD/HHMMSS_reason_station.json"""
        session = dict(session) if isinstance(session, dict) else {}
        if not session.get("startedAt"):
            return None
        if session_data_score(session) <= 0 and reason == "interval":
            return None
        day, stem = session_debug_stem(session)
        now_local = datetime.now(KST)
        stamp = now_local.strftime("%H%M%S")
        safe_reason = re.sub(r"[^\w.\-]+", "_", str(reason or "interval"))[:32] or "interval"
        day_dir = self.backup_dir / day
        day_dir.mkdir(parents=True, exist_ok=True)
        name = f"{stamp}_{safe_reason}_{stem}.json"
        path = day_dir / name
        payload = {
            "version": 1,
            "backupAt": utc_now_iso(),
            "reason": safe_reason,
            "stationId": str(session.get("stationId") or "").strip(),
            "broadNo": str(session.get("broadNo") or "").strip(),
            "startedAt": session.get("startedAt"),
            "endedAt": session.get("endedAt"),
            "active": bool(session.get("active")),
            "title": str(session.get("title") or "").strip(),
            "peakViewers": int(session.get("peakViewers") or 0),
            "score": session_data_score(session),
            "chatCount": session_chat_count(session),
            "topFanCount": len(session.get("topFans") or [])
            if isinstance(session.get("topFans"), list)
            else 0,
            "session": session,
        }
        self._write_json(path, payload)
        self._prune_backup_day(day_dir)
        self.maybe_prune_debug_stores()
        return f"{day}/{name}"

    def maybe_backup_session(
        self,
        session: dict[str, Any],
        *,
        reason: str = "interval",
        force: bool = False,
    ) -> str | None:
        if not force and reason == "interval":
            last = parse_iso(session.get("lastBackupAt"))
            if last is not None:
                age = (datetime.now(timezone.utc) - last).total_seconds()
                if age < CREDITS_BACKUP_INTERVAL_SEC:
                    return None
        path = self.write_session_backup(session, reason=reason)
        if path:
            session["lastBackupAt"] = utc_now_iso()
        return path

    def append_raw_events(
        self,
        rows: list[dict[str, Any]],
        *,
        session: dict[str, Any],
        source: str = "",
    ) -> Path | None:
        """ingest 원본을 JSONL로 append. 방송 세션당 1파일."""
        if not rows:
            return None
        if not session.get("startedAt"):
            # 세션 시작 전이면 당일 orphan 파일
            day = datetime.now(KST).strftime("%Y-%m-%d")
            stem = "orphan_" + re.sub(
                r"[^\w.\-]+",
                "_",
                str(session.get("stationId") or self.station_id or "unknown"),
            )
        else:
            day, stem = session_debug_stem(session)
        day_dir = self.raw_dir / day
        day_dir.mkdir(parents=True, exist_ok=True)
        path = day_dir / f"{stem}.jsonl"
        batch = {
            "v": 1,
            "kind": "batch",
            "receivedAt": utc_now_iso(),
            "source": str(source or "").strip(),
            "count": len(rows),
            "stationId": str(session.get("stationId") or "").strip(),
            "broadNo": str(session.get("broadNo") or "").strip(),
            "sessionStartedAt": session.get("startedAt"),
        }
        try:
            with path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(batch, ensure_ascii=False) + "\n")
                for row in rows:
                    fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError as exc:
            _credits_log(f"raw append FAIL {exc}")
            return None
        self.maybe_prune_debug_stores()
        return path

    def _archive_before_replace(self, session: dict[str, Any] | None) -> None:
        """새 세션으로 덮기 직전에 현재 세션을 보관. 데이터가 있으면 force."""
        try:
            if isinstance(session, dict):
                flush_present_chatters(session)
            force = bool(isinstance(session, dict) and session_data_score(session) > 0)
            aid = self.archive_session(session, force=force)
            if isinstance(session, dict):
                _credits_log(
                    "archive_before_replace "
                    f"aid={aid or '-'} start={session.get('startedAt')} "
                    f"broad={session.get('broadNo')} "
                    f"chatters={len(session.get('chatters') or {})} "
                    f"chats={session_chat_count(session)} "
                    f"peak={session.get('peakViewers')}"
                )
        except OSError as exc:
            _credits_log(f"archive_before_replace FAIL {exc}")

    @staticmethod
    def _archive_start_date(data: dict[str, Any], *, folder_name: str = "") -> str:
        """날짜 표기·필터는 방송 시작 시각(KST) 기준."""
        dt = parse_iso(data.get("startedAt"))
        if dt:
            return dt.astimezone(KST).strftime("%Y-%m-%d")
        folder = str(folder_name or "").strip()
        if folder and re.fullmatch(r"\d{4}-\d{2}-\d{2}", folder):
            return folder
        return ""

    def _iter_archive_files(self) -> list[tuple[Path, str]]:
        """(json_path, folder_date) 최신 폴더·파일 우선."""
        root = self.archive_dir
        if not root.exists():
            return []
        folders = sorted(
            (p for p in root.iterdir() if p.is_dir() and re.fullmatch(r"\d{4}-\d{2}-\d{2}", p.name)),
            key=lambda p: p.name,
            reverse=True,
        )
        out: list[tuple[Path, str]] = []
        for folder in folders:
            for fp in sorted(folder.glob("*.json"), key=lambda p: p.name, reverse=True):
                out.append((fp, folder.name))
        return out

    def _archive_meta_row(
        self, data: dict[str, Any], *, folder_name: str, stem: str
    ) -> dict[str, Any] | None:
        aid = str(data.get("archiveId") or f"{folder_name}/{stem}")
        sid = str(data.get("stationId") or "").strip().lower()
        if not sid and "_" in stem:
            sid = stem.split("_", 1)[-1].strip().lower()
        credits = data.get("credits") if isinstance(data.get("credits"), dict) else {}
        info = credits.get("info") if isinstance(credits.get("info"), dict) else {}
        start_day = self._archive_start_date(data, folder_name=folder_name) or folder_name
        return {
            "archiveId": aid,
            "date": start_day,
            "stationId": sid or data.get("stationId") or "",
            "startedAt": data.get("startedAt"),
            "endedAt": data.get("endedAt"),
            "title": data.get("title") or info.get("title") or "",
            "peakViewers": int(data.get("peakViewers") or info.get("peakViewers") or 0),
            "peakAtLabel": str(info.get("peakAtLabel") or "").strip(),
            "durationLabel": str(info.get("durationLabel") or "").strip(),
            "chatters": int(info.get("chatters") or 0),
            "chatCount": int(info.get("chatCount") or 0),
            "balloonTotal": int(
                info.get("balloonTotal")
                or (data.get("session") or {}).get("balloonTotal")
                or 0
            ),
            "archivedAt": data.get("archivedAt"),
            "hasPeakThumb": bool(data.get("peakThumbFile")),
        }

    def list_archives(
        self,
        *,
        date: str | None = None,
        limit: int = 60,
        station_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """최신순 아카이브 메타 목록. station_id가 있으면 해당 채널만.

        date 필터·표기는 방송 시작일(startedAt KST) 기준.
        """
        want = str(station_id or "").strip().lower()
        day = str(date or "").strip()
        if day and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            return []
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for fp, folder_name in self._iter_archive_files():
            try:
                data = json.loads(fp.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(data, dict):
                continue
            row = self._archive_meta_row(data, folder_name=folder_name, stem=fp.stem)
            if not row:
                continue
            sid = str(row.get("stationId") or "").strip().lower()
            if want and sid != want:
                continue
            if day and str(row.get("date") or "") != day:
                continue
            aid = str(row.get("archiveId") or "")
            if not aid or aid in seen:
                continue
            seen.add(aid)
            out.append(row)
            if len(out) >= max(1, min(200, int(limit))):
                break
        out.sort(key=lambda r: str(r.get("startedAt") or ""), reverse=True)
        return out

    def list_archive_dates(
        self,
        *,
        limit: int = 120,
        station_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """날짜별 방송 수·대표 방제 (일기장 인덱스용, 최신순). 시작일 기준."""
        want = str(station_id or "").strip().lower()
        by_day: dict[str, dict[str, Any]] = {}
        for fp, folder_name in self._iter_archive_files():
            try:
                data = json.loads(fp.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(data, dict):
                continue
            sid = str(data.get("stationId") or "").strip().lower()
            if not sid and "_" in fp.stem:
                sid = fp.stem.split("_", 1)[-1].strip().lower()
            if want and sid != want:
                continue
            day = self._archive_start_date(data, folder_name=folder_name)
            if not day:
                continue
            peak = int(data.get("peakViewers") or 0)
            title = str(data.get("title") or "").strip()
            aid = str(data.get("archiveId") or f"{folder_name}/{fp.stem}")
            bucket = by_day.setdefault(
                day,
                {
                    "date": day,
                    "count": 0,
                    "peakViewers": 0,
                    "title": "",
                    "stationId": want or "",
                    "_aids": set(),
                },
            )
            aids = bucket["_aids"]
            if aid in aids:
                continue
            aids.add(aid)
            bucket["count"] = int(bucket["count"]) + 1
            if peak > int(bucket["peakViewers"] or 0):
                bucket["peakViewers"] = peak
                if title:
                    bucket["title"] = title
            elif not bucket.get("title") and title:
                bucket["title"] = title
        out: list[dict[str, Any]] = []
        for day in sorted(by_day.keys(), reverse=True):
            if len(out) >= max(1, min(366, int(limit))):
                break
            row = dict(by_day[day])
            row.pop("_aids", None)
            out.append(row)
        return out

    def load_archive(self, archive_id: str) -> dict[str, Any] | None:
        """archiveId('YYYY-MM-DD/HHMMSS_station') → 아카이브 전체 dict."""
        aid = str(archive_id or "").strip().strip("/")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}/[\w.\-]+", aid):
            return None
        path = self.archive_dir / f"{aid}.json"
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return data if isinstance(data, dict) else None

    def merge_archive_into_live(
        self,
        archive_id: str,
        *,
        remove_archive: bool = True,
    ) -> dict[str, Any]:
        """아카이브 세션을 현재 라이브 세션에 합친다 (오탐 방종 조각 복구용)."""
        packed = self.load_archive(archive_id)
        if not packed:
            raise ValueError("archive_not_found")
        prior = packed.get("session") if isinstance(packed.get("session"), dict) else None
        if not prior:
            raise ValueError("archive_session_missing")
        with _lock:
            session = self.load_session()
            before_start = session.get("startedAt")
            before_chats = session_chat_count(session)
            merge_prior_session_into(session, prior)
            self.save_session(session, rebuild=True)
            after_chats = session_chat_count(session)
            _credits_log(
                f"merge_archive_into_live aid={archive_id} "
                f"prev_start={before_start} → {session.get('startedAt')} "
                f"chats {before_chats}→{after_chats}"
            )
        if remove_archive:
            aid = str(archive_id or "").strip().strip("/")
            json_path = self.archive_dir / f"{aid}.json"
            peak_name = str(packed.get("peakThumbFile") or "").strip()
            try:
                if json_path.is_file():
                    json_path.unlink()
            except OSError as exc:
                _credits_log(f"merge_archive remove json FAIL {exc}")
            if peak_name and "/" not in peak_name and ".." not in peak_name:
                try:
                    day = aid.split("/", 1)[0]
                    jpg = self.archive_dir / day / peak_name
                    if jpg.is_file():
                        jpg.unlink()
                except OSError:
                    pass
        return self.load_session()

    def load_archive_credits(self, archive_id: str) -> dict[str, Any] | None:
        data = self.load_archive(archive_id)
        if not data:
            return None
        credits = data.get("credits")
        if isinstance(credits, dict):
            out = dict(credits)
        else:
            session = data.get("session") if isinstance(data.get("session"), dict) else {}
            out = self.build_credits_payload(session)
        out["archiveId"] = data.get("archiveId") or archive_id
        out["source"] = "archive"
        out["demo"] = False
        session = data.get("session") if isinstance(data.get("session"), dict) else {}
        if session:
            ms = session.get("metricsSeries")
            if isinstance(ms, dict):
                out["metricsSeries"] = ensure_metrics_series({"metricsSeries": ms})
            elif not isinstance(out.get("metricsSeries"), dict):
                out["metricsSeries"] = empty_metrics_series()
            info = out.setdefault("info", {})
            if isinstance(info, dict):
                if not int(info.get("donationCount") or 0):
                    donations = (
                        session.get("donations")
                        if isinstance(session.get("donations"), dict)
                        else {}
                    )
                    donor_n = sum(
                        1
                        for row in donations.values()
                        if isinstance(row, dict) and int(row.get("total") or 0) > 0
                    )
                    if donor_n:
                        info["donationCount"] = donor_n
                if info.get("balloonTotal") is None and session.get("balloonTotal") is not None:
                    info["balloonTotal"] = int(session.get("balloonTotal") or 0)
                if info.get("upGain") is None and session.get("upGain") is not None:
                    info["upGain"] = int(session.get("upGain") or 0)
                if info.get("lastUpCount") is None and session.get("lastUpCount") is not None:
                    info["lastUpCount"] = session.get("lastUpCount")
        elif not isinstance(out.get("metricsSeries"), dict):
            out["metricsSeries"] = empty_metrics_series()
        # 피크 썸네일: 아카이브 파일이 있으면 전용 URL
        peak_file = str(data.get("peakThumbFile") or "").strip()
        if peak_file:
            out.setdefault("info", {})
            if isinstance(out["info"], dict):
                out["info"]["peakThumbUrl"] = (
                    f"/api/credits/archive-peak-thumb?archiveId={urllib.parse.quote(str(archive_id))}"
                )
        return out

    def archive_peak_thumb_file(self, archive_id: str) -> Path | None:
        data = self.load_archive(archive_id)
        if not data:
            return None
        name = str(data.get("peakThumbFile") or "").strip()
        if not name or "/" in name or "\\" in name or ".." in name:
            return None
        day = str(archive_id).split("/", 1)[0]
        path = self.archive_dir / day / name
        if path.is_file() and path.stat().st_size >= 200:
            return path
        return None

    def new_session(self, station_id: str = "") -> dict[str, Any]:
        """빈 세션 + 이전 방송 캡처 파일 제거."""
        self.clear_local_peak_thumb()
        return empty_session(station_id or self.station_id)

    def has_local_peak_thumb(self) -> bool:
        try:
            return self.peak_thumb_path.exists() and self.peak_thumb_path.stat().st_size >= 200
        except OSError:
            return False


    def _resolve_peak_thumb_url(self, session: dict[str, Any] | None = None) -> str:
        """세션에 피크 캡처가 있을 때만 로컬 파일을 쓴다. (리셋 후 옛 파일 고착 방지)"""
        session = session if isinstance(session, dict) else {}
        peak_url = str(session.get("peakThumbUrl") or "").strip()
        peak_viewers = int(session.get("peakViewers") or 0)
        # 새/빈 세션인데 디스크에 옛 jpg만 남은 경우 무시
        if peak_viewers <= 0 and not peak_url:
            return ""
        if self.has_local_peak_thumb() and (
            peak_url.startswith("/api/credits/peak-thumb") or peak_viewers > 0
        ):
            try:
                bust = int(self.peak_thumb_path.stat().st_mtime)
            except OSError:
                bust = int(time.time())
            return f"/api/credits/peak-thumb?t={bust}"
        return peak_url


    @staticmethod
    def peak_thumb_candidates(source_url: str = "", broad_no: str = "") -> list[str]:
        """라이브 썸네일 후보 URL (SOOP 필드·liveimg 변형)."""
        out: list[str] = []
        seen: set[str] = set()

        def add(raw: str) -> None:
            url = str(raw or "").strip()
            if not url or url.startswith("/"):
                return
            if url.startswith("//"):
                url = f"https:{url}"
            if url in seen:
                return
            seen.add(url)
            out.append(url)

        add(source_url)
        bn = str(broad_no or "").strip()
        if bn:
            add(f"https://liveimg.sooplive.co.kr/m/{bn}")
            add(f"https://liveimg.sooplive.co.kr/s/{bn}")
            add(f"https://liveimg.sooplive.co.kr/{bn}")
        return out

    def cache_peak_thumbnail(self, source_url: str) -> str:
        """최고 시청 순간의 라이브 썸네일을 로컬에 고정 저장. 실패 시 원본 URL 유지."""
        url = str(source_url or "").strip()
        if not url or url.startswith("/"):
            return url
        if url.startswith("//"):
            url = f"https:{url}"
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            "Referer": "https://www.sooplive.co.kr/",
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        }
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = resp.read()
                ctype = str(resp.headers.get("Content-Type") or "").lower()
            if not data or len(data) < 200:
                return url
            is_jpeg = data[:2] == b"\xff\xd8"
            is_png = data[:8] == b"\x89PNG\r\n\x1a\n"
            is_webp = data[:4] == b"RIFF" and data[8:12] == b"WEBP"
            if "image" not in ctype and not is_jpeg and not is_png and not is_webp:
                return url
            self.peak_thumb_path.parent.mkdir(parents=True, exist_ok=True)
            # webp도 jpg 경로에 저장하되 content-type은 서빙 시 판별
            self.peak_thumb_path.write_bytes(data)
            bust = int(time.time())
            return f"/api/credits/peak-thumb?t={bust}"
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            return url

    def cache_peak_thumbnail_any(self, urls: list[str]) -> str:
        """후보 URL을 순서대로 시도해 로컬 캐시에 성공한 경로를 반환."""
        first = ""
        for url in urls:
            if not first:
                first = url
            local = self.cache_peak_thumbnail(url)
            if local.startswith("/api/credits/peak-thumb"):
                return local
        return first

    def ensure_files(self) -> None:
        self.session_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.session_path.exists():
            self._write_json(self.session_path, empty_session(self.station_id))
        if not self.credits_path.exists():
            if self.seed_path and self.seed_path.exists():
                self.credits_path.write_text(
                    self.seed_path.read_text(encoding="utf-8"), encoding="utf-8"
                )
            else:
                self._write_json(self.credits_path, empty_credits_payload())

    @staticmethod
    def _write_json(path: Path, data: dict) -> None:
        """원자적 저장 (고유 tmp + flock)."""
        atomic_write_json(path, data)

    def load_session(self) -> dict[str, Any]:
        self.ensure_files()
        with _lock:
            session = self._read_session_file(
                self.session_path, fallback_station=self.station_id
            )
            # 포인터가 비었는데 계정 미러·백업에 데이터가 있으면 복구
            if not session.get("startedAt") and session_data_score(session) <= 0:
                sid = self._norm_station_id(session.get("stationId") or self.station_id)
                recovered = self._find_recoverable_session(sid)
                if recovered:
                    _credits_log(
                        f"load_session recover sid={sid} "
                        f"score={session_data_score(recovered)} "
                        f"start={recovered.get('startedAt')} "
                        f"broad={recovered.get('broadNo')}"
                    )
                    return recovered
            return session

    def _find_recoverable_session(
        self,
        station_id: str,
        *,
        broad_no: str = "",
    ) -> dict[str, Any] | None:
        """빈 포인터일 때 미러·최근 백업에서 같은 채널(가능하면 같은 broad) 세션 복구."""
        sid = self._norm_station_id(station_id)
        want_broad = str(broad_no or "").strip()
        candidates: list[dict[str, Any]] = []

        if sid:
            mirror = self._station_session_path(sid)
            if mirror.exists():
                alt = self._read_session_file(mirror, fallback_station=sid)
                if alt.get("startedAt") or session_data_score(alt) > 0:
                    candidates.append(alt)

        # 최근 2일 백업
        try:
            day_dirs = sorted(
                [p for p in self.backup_dir.iterdir() if p.is_dir()],
                key=lambda p: p.name,
                reverse=True,
            )[:2]
        except OSError:
            day_dirs = []
        for day_dir in day_dirs:
            try:
                files = sorted(
                    [p for p in day_dir.glob("*.json") if p.is_file()],
                    key=lambda p: p.stat().st_mtime,
                    reverse=True,
                )[:40]
            except OSError:
                continue
            for path in files:
                try:
                    packed = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                if not isinstance(packed, dict):
                    continue
                sess = packed.get("session") if isinstance(packed.get("session"), dict) else None
                if not sess:
                    continue
                sess = self._hydrate_session(dict(sess), fallback_station=sid)
                file_sid = self._norm_station_id(
                    sess.get("stationId") or packed.get("stationId") or ""
                )
                if sid and file_sid and file_sid != sid:
                    continue
                if not sess.get("startedAt") and session_data_score(sess) <= 0:
                    continue
                candidates.append(sess)

        if not candidates:
            return None

        def rank(s: dict[str, Any]) -> tuple:
            b = str(s.get("broadNo") or "").strip()
            broad_match = 1 if want_broad and b == want_broad else (0 if want_broad else 1)
            return (broad_match, session_data_score(s), str(s.get("updatedAt") or ""))

        best = max(candidates, key=rank)
        if want_broad:
            b = str(best.get("broadNo") or "").strip()
            # broad가 다르면 점수가 아주 높을 때만 (같은 날 끊긴 포인터 복구)
            if b and b != want_broad and session_data_score(best) < 50:
                return None
        if session_data_score(best) <= 0 and not best.get("startedAt"):
            return None
        return best

    def _recover_or_keep_session(
        self,
        session: dict[str, Any],
        *,
        station_id: str = "",
        broad_no: str = "",
    ) -> dict[str, Any]:
        """new_session 전에 빈/깨진 포인터를 복구. 복구 실패 시 원본 반환."""
        if session.get("startedAt") and session_data_score(session) > 0:
            return session
        sid = self._norm_station_id(station_id or session.get("stationId") or self.station_id)
        recovered = self._find_recoverable_session(sid, broad_no=broad_no)
        if not recovered:
            return session
        resume_collector_session(recovered)
        _credits_log(
            "recover before new_session "
            f"sid={sid} broad={broad_no or recovered.get('broadNo')} "
            f"score={session_data_score(recovered)} start={recovered.get('startedAt')}"
        )
        return recovered

    def save_session(self, session: dict[str, Any], *, rebuild: bool = True) -> dict[str, Any]:
        session = dict(session)
        dedupe_subscription_lists(session)
        compact_metrics_series(session)
        session["updatedAt"] = utc_now_iso()
        sid = self._norm_station_id(session.get("stationId") or self.station_id)
        if sid:
            session["stationId"] = sid
            self.station_id = sid
        with _lock:
            self._write_json(self.session_path, session)
            self._mirror_station_session(session)
            if rebuild:
                payload = self.build_credits_payload(session)
                self._write_json(self.credits_path, payload)
        return session

    def load_credits(self, *, signature_amounts: list[int] | None = None) -> dict[str, Any]:
        self.ensure_files()
        with _lock:
            try:
                data = json.loads(self.credits_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                data = empty_credits_payload()
        if not isinstance(data, dict):
            return empty_credits_payload()
        # Prefer live session rebuild when available
        session = self.load_session()
        if session.get("startedAt"):
            return self.build_credits_payload(session, signature_amounts=signature_amounts)
        return apply_signature_amounts_to_payload(data, signature_amounts)

    def build_credits_payload(
        self,
        session: dict[str, Any] | None = None,
        *,
        signature_amounts: list[int] | None = None,
    ) -> dict[str, Any]:
        session = session or self.load_session()
        coalesce_session_user_aliases(session)
        dedupe_subscription_lists(session)
        chatters = session.get("chatters") if isinstance(session.get("chatters"), dict) else {}
        donations = session.get("donations") if isinstance(session.get("donations"), dict) else {}
        chat_sdk = bool(session.get("chatSdkConnected")) or any(
            (u.get("count") or 0) > 0 for u in chatters.values() if isinstance(u, dict)
        )
        pending = not chat_sdk and bool(session.get("pendingChatSdk", True))

        chat_items = []
        for uid, row in chatters.items():
            if not isinstance(row, dict):
                continue
            count = int(row.get("count") or 0)
            if count <= 0:
                continue
            chat_items.append(
                {
                    "id": uid,
                    "name": str(row.get("name") or uid),
                    "count": count,
                    "value": f"{count}번",
                }
            )
        chat_items.sort(key=lambda x: (-x["count"], x["name"]))
        for i, item in enumerate(chat_items[:10], start=1):
            item["rank"] = i

        watch_items = []
        now_ms = time.time() * 1000
        bj_id = normalize_soop_user_id(
            str(session.get("stationId") or self.station_id or "").strip()
        )
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
            # 본인(BJ) 방송 — 시청 시간 순위에서 제외
            if bj_id and uid_norm == bj_id:
                continue
            dur = chatter_watch_ms(
                row, now_ms=now_ms, ended_ms=ended_ms, started_ms=started_ms
            )
            if dur < 1000:
                continue
            watch_items.append(
                {
                    "id": uid_norm or str(uid),
                    "name": str(row.get("name") or uid),
                    "ms": dur,
                    "value": format_watch(dur),
                }
            )
        watch_items.sort(key=lambda x: (-x["ms"], x["name"]))
        for i, item in enumerate(watch_items[:10], start=1):
            item["rank"] = i

        donation_items = []
        for uid, row in donations.items():
            if not isinstance(row, dict):
                continue
            total = int(row.get("total") or 0)
            if total <= 0:
                continue
            donation_items.append(
                {
                    "id": uid,
                    "name": str(row.get("name") or uid),
                    "total": total,
                    "value": f"{total:,}개",
                }
            )
        donation_items.sort(key=lambda x: (-x["total"], x["name"]))
        for i, item in enumerate(donation_items[:10], start=1):
            item["rank"] = i

        chat_count = sum(int(i["count"]) for i in chat_items)
        title = str(session.get("title") or "").strip() or "오늘의 방송"
        active = bool(session.get("active"))
        duration = format_duration(session.get("startedAt"), None if active else session.get("endedAt"))

        first = session.get("firstChat") if isinstance(session.get("firstChat"), dict) else None
        first_out = None
        if first and first.get("name"):
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
            first_out = {
                "name": str(first.get("name") or ""),
                "message": str(first.get("message") or ""),
                "atLabel": at_label,
                "isEmoticon": bool(first.get("isEmoticon")),
                "emoticonName": str(first.get("emoticonName") or "").strip(),
                "imageUrl": str(first.get("imageUrl") or "").strip(),
            }

        thanks_names = []
        for item in chat_items[:20]:
            thanks_names.append({"name": item["name"]})
        for item in donation_items[:10]:
            if item["name"] not in {t["name"] for t in thanks_names}:
                thanks_names.append({"name": item["name"]})
        if thanks_names:
            thanks_names.append({"name": "그리고 모든 시청자"})

        sections = [
            {
                "id": "chat",
                "title": "채팅 순위",
                "pending": pending and not chat_items,
                "total": len(chat_items),
                "items": [
                    {"rank": i["rank"], "name": i["name"], "value": i["value"]}
                    for i in chat_items[:10]
                ],
            },
            {
                "id": "watch",
                "title": "시청 시간 순위",
                "pending": pending and not watch_items,
                "total": len(watch_items),
                "items": [
                    {"rank": i["rank"], "name": i["name"], "value": i["value"]}
                    for i in watch_items[:10]
                ],
            },
            {
                "id": "donation",
                "title": "후원 순위",
                "pending": pending and not donation_items,
                "total": len(donation_items),
                "items": [
                    {"rank": i["rank"], "name": i["name"], "value": i["value"]}
                    for i in donation_items[:10]
                ],
            },
        ]

        signature_items, signature_more_hits = build_signature_items(
            (session.get("amountHits") if isinstance(session.get("amountHits"), dict) else None)
            or (session.get("signatureHits") if isinstance(session.get("signatureHits"), dict) else None),
            signature_amounts,
        )

        sections.append(
            {
                "id": "signature",
                "title": "시그니처 순위",
                "pending": pending and not signature_items,
                "moreHits": int(signature_more_hits or 0),
                "items": [
                    {
                        "rank": i["rank"],
                        "name": i["name"],
                        "value": i["value"],
                        "topDonor": i.get("topDonor") or "",
                        "topDonorHits": int(i.get("topDonorHits") or 0),
                        "morePeople": int(i.get("morePeople") or 0),
                        "imageUrl": str(i.get("imageUrl") or "").strip(),
                    }
                    for i in signature_items
                ],
            }
        )

        emoticon_items = []
        emoticons = session.get("emoticons") if isinstance(session.get("emoticons"), dict) else {}
        for uid, row in emoticons.items():
            if not isinstance(row, dict):
                continue
            count = int(row.get("count") or 0)
            if count <= 0:
                continue
            emoticon_items.append(
                {
                    "rank": 0,
                    "name": str(row.get("name") or uid),
                    "value": f"{count}회",
                    "count": count,
                }
            )
        emoticon_items.sort(key=lambda x: (-x["count"], x["name"]))
        for i, item in enumerate(emoticon_items[:10], start=1):
            item["rank"] = i
            item.pop("count", None)

        usage = session.get("emoticonUsage") if isinstance(session.get("emoticonUsage"), dict) else {}
        top_emoticons = build_top_emoticons(
            usage,
            station_id=str(session.get("stationId") or self.station_id or "").strip(),
            limit=10,
            signature_only=True,
        )

        sections.append(
            {
                "id": "emoticon",
                "title": "이모티콘 순위",
                "pending": pending and not emoticon_items,
                "items": emoticon_items[:10],
                "topEmoticons": top_emoticons,
            }
        )

        def _name_items(raw_list, *, value_key: str | None = None, limit: int = 40):
            out = []
            seen = set()
            for row in raw_list if isinstance(raw_list, list) else []:
                if isinstance(row, dict):
                    name = str(row.get("name") or "").strip()
                    if not name or name in seen:
                        continue
                    seen.add(name)
                    item = {"name": name}
                    if value_key and row.get(value_key) not in (None, ""):
                        item["value"] = str(row.get(value_key))
                    elif row.get("value"):
                        item["value"] = str(row.get("value"))
                    out.append(item)
                elif isinstance(row, str) and row.strip() and row.strip() not in seen:
                    seen.add(row.strip())
                    out.append({"name": row.strip()})
                if len(out) >= limit:
                    break
            return out

        subscribe_raw = (
            session.get("subscribers") if isinstance(session.get("subscribers"), list) else []
        )
        subscribe_items = _name_items(subscribe_raw)
        sections.append(
            {
                "id": "subscribe",
                "title": "신규 구독",
                "pending": pending and not subscribe_items,
                "total": len(subscribe_raw),
                "items": subscribe_items,
            }
        )

        renew_raw = session.get("subscriberRenewals") if isinstance(session.get("subscriberRenewals"), list) else []
        renew_items = []
        renew_seen = set()
        for row in renew_raw:
            if not isinstance(row, dict):
                continue
            name = str(row.get("name") or "").strip()
            if not name or name in renew_seen:
                continue
            renew_seen.add(name)
            # 채팅 알림과 동일: subscriptionMonths(months). 누적(accMonths)은 fallback.
            try:
                months = int(row.get("months") or 0)
            except (TypeError, ValueError):
                months = 0
            if months <= 0:
                try:
                    months = int(row.get("accMonths") or 0)
                except (TypeError, ValueError):
                    months = 0
            value = f"{months}개월" if months > 0 else ""
            item = {"name": name}
            if value:
                item["value"] = value
            renew_items.append(item)
            if len(renew_items) >= 40:
                break
        sections.append(
            {
                "id": "subscribe_renew",
                "title": "연속 구독",
                "pending": pending and not renew_items,
                "total": len(renew_raw),
                "items": renew_items,
            }
        )

        gift_raw = session.get("subscriptionGifts") if isinstance(session.get("subscriptionGifts"), list) else []
        gift_items = []
        for row in gift_raw:
            if not isinstance(row, dict):
                continue
            giver = str(row.get("name") or "").strip()
            if not giver:
                continue
            # 받은 이 정보는 숨김 — 선물한 사람 + 구독권 종류만
            gift_label = format_subscription_gift_label(
                row.get("type"), tier=row.get("tier")
            )
            item = {"name": giver}
            if gift_label:
                item["value"] = gift_label
            gift_items.append(item)
            if len(gift_items) >= 40:
                break
        sections.append(
            {
                "id": "subscribe_gift",
                "title": "구독 선물",
                "pending": pending and not gift_items,
                "total": len(gift_raw),
                "items": gift_items,
            }
        )

        fanclub_raw = (
            session.get("fanclubJoins") if isinstance(session.get("fanclubJoins"), list) else []
        )
        fanclub_items = _name_items(fanclub_raw)
        fanclub_count = int(session.get("fanclubCount") or len(fanclub_raw) or 0)
        sections.append(
            {
                "id": "fanclub",
                "title": "팬클럽 가입",
                "pending": pending and not fanclub_items and fanclub_count <= 0,
                "total": fanclub_count,
                "items": fanclub_items,
            }
        )

        topfan_raw = session.get("topFans") if isinstance(session.get("topFans"), list) else []
        topfan_items = _name_items(topfan_raw)
        sections.append(
            {
                "id": "topfan",
                "title": "열혈팬 승급",
                "pending": pending and not topfan_items,
                "total": len(topfan_raw),
                "items": topfan_items,
            }
        )

        quick_items = []
        quickviews = session.get("quickviews") if isinstance(session.get("quickviews"), dict) else {}
        for uid, row in quickviews.items():
            if not isinstance(row, dict):
                continue
            count = int(row.get("count") or 0)
            if count <= 0:
                continue
            quick_items.append(
                {
                    "rank": 0,
                    "name": str(row.get("name") or uid),
                    "value": f"{count}회",
                    "count": count,
                }
            )
        quick_items.sort(key=lambda x: (-x["count"], x["name"]))
        for i, item in enumerate(quick_items[:10], start=1):
            item["rank"] = i
            item.pop("count", None)
        sections.append(
            {
                "id": "quickview",
                "title": "퀵뷰 순위",
                "pending": pending and not quick_items,
                "items": quick_items[:10],
            }
        )

        mission_items = []
        missions = session.get("missions") if isinstance(session.get("missions"), dict) else {}
        for uid, row in missions.items():
            if not isinstance(row, dict):
                continue
            total = int(row.get("total") or 0)
            if total <= 0:
                continue
            mission_items.append(
                {
                    "rank": 0,
                    "name": str(row.get("name") or uid),
                    "value": f"{total:,}개",
                    "total": total,
                }
            )
        mission_items.sort(key=lambda x: (-x["total"], x["name"]))
        for i, item in enumerate(mission_items[:10], start=1):
            item["rank"] = i
            item.pop("total", None)
        sections.append(
            {
                "id": "mission",
                "title": "미션 순위",
                "pending": pending and not mission_items,
                "items": mission_items[:10],
            }
        )

        flags = session.get("identityFlags") if isinstance(session.get("identityFlags"), dict) else {}
        flag_counts = {"fan": 0, "topFan": 0, "follower": 0, "manager": 0}
        for row in flags.values():
            if not isinstance(row, dict):
                continue
            if row.get("isFan"):
                flag_counts["fan"] += 1
            if row.get("isTopFan"):
                flag_counts["topFan"] += 1
            if row.get("isFollower"):
                flag_counts["follower"] += 1
            if row.get("isManager"):
                flag_counts["manager"] += 1

        if thanks_names and not pending:
            sections.append(
                {
                    "id": "thanks",
                    "title": "함께해 주신 분들",
                    "pending": False,
                    "items": thanks_names,
                }
            )

        return {
            "version": 1,
            "demo": False,
            "source": "live",
            "active": active,
            "pendingChatSdk": pending,
            "session": {
                "startedAt": session.get("startedAt"),
                "endedAt": session.get("endedAt"),
                "stationId": session.get("stationId") or self.station_id,
            },
            "info": {
                "title": title,
                "dateLabel": format_date_label(session.get("startedAt")),
                "durationLabel": duration,
                "peakViewers": int(session.get("peakViewers") or 0),
                "peakViewersAt": session.get("peakViewersAt"),
                "peakAtLabel": format_kst_clock(parse_iso(session.get("peakViewersAt"))),
                "peakTitle": str(session.get("peakTitle") or "").strip(),
                "peakThumbUrl": self._resolve_peak_thumb_url(session),
                "chatters": len(chat_items),
                "chatCount": chat_count,
                "firstChat": first_out,
                "fanclubCount": fanclub_count,
                "subscribeCount": len(subscribe_raw),
                "subscribeRenewCount": len(renew_raw),
                "subscribeGiftCount": len(gift_raw),
                "topFanCount": len(topfan_raw),
                "flagCounts": flag_counts,
                "lastUpCount": session.get("lastUpCount"),
                "upGain": int(session.get("upGain") or 0),
                "balloonTotal": int(session.get("balloonTotal") or 0),
                "donationCount": len(donation_items),
            },
            "metricsSeries": ensure_metrics_series(session),
            "sections": sections,
            "timeline": build_day_timeline(session),
            "footer": {
                "line": "오늘 방송 종료",
                "sub": "다음 방송에서 또 만나요",
            },
        }

    def apply_live_status(
        self, live_status: dict[str, Any] | None, *, update_title: bool = True
    ) -> dict[str, Any]:
        live_status = live_status if isinstance(live_status, dict) else {}
        is_live = bool(live_status.get("isLive"))
        station_id = str(live_status.get("stationId") or self.station_id).strip()
        title = str(live_status.get("title") or "").strip()
        thumb = str(live_status.get("thumbnailUrl") or "").strip()
        broad_no = str(live_status.get("broadNo") or "").strip()
        viewers = live_status.get("viewerCount")
        try:
            viewers_n = int(viewers) if viewers is not None else None
        except (TypeError, ValueError):
            viewers_n = None
        up_raw = live_status.get("upCount")
        try:
            up_n = int(up_raw) if up_raw is not None else None
        except (TypeError, ValueError):
            up_n = None
        balloon_top = live_status.get("balloonTop")

        with _lock:
            session = self.load_session()
            changed = False
            snap_url = ""

            if is_live:
                self._offline_streak = 0
                session = self._recover_or_keep_session(
                    session, station_id=station_id, broad_no=broad_no
                )
                prev_broad = str(session.get("broadNo") or "").strip()
                broad_changed = bool(broad_no and prev_broad and broad_no != prev_broad)
                # 종료된 세션·다른 방송 번호·오래된 active → 새 세션
                # 단, 같은 broadNo(또는 데이터 있는 당일 세션)는 이어 씀 — 크레딧 분실 방지
                needs_new = session_needs_new_broadcast(session) or broad_changed
                if needs_new and not broad_changed and (
                    session_can_resume_same_broadcast(session, broad_no=broad_no or prev_broad)
                    or session_must_preserve(session, broad_no=broad_no or prev_broad)
                ):
                    resume_collector_session(session)
                    changed = True
                    needs_new = False
                    _credits_log(
                        f"live resume/keep broad={broad_no or prev_broad} "
                        f"start={session.get('startedAt')} chats={session_chat_count(session)}"
                    )
                if needs_new and not broad_changed and session.get("startedAt"):
                    # broad 변경 없이 새 세션을 열면 하루 집계가 쪼개짐 → 금지
                    resume_collector_session(session)
                    changed = True
                    needs_new = False
                    _credits_log(
                        "live refuse new_session without broad change "
                        f"start={session.get('startedAt')} score={session_data_score(session)}"
                    )
                # 포인터만 비고 같은 broad 백업이 있으면 절대 새 세션 금지
                if needs_new and not broad_changed:
                    again = self._find_recoverable_session(station_id, broad_no=broad_no or prev_broad)
                    if again and (
                        not broad_no
                        or not str(again.get("broadNo") or "").strip()
                        or str(again.get("broadNo") or "").strip() == broad_no
                        or session_data_score(again) > 0
                    ):
                        session = again
                        resume_collector_session(session)
                        changed = True
                        needs_new = False
                        _credits_log(
                            "live refuse empty→recover "
                            f"broad={broad_no or again.get('broadNo')} "
                            f"score={session_data_score(session)}"
                        )
                if needs_new:
                    prev_start = session.get("startedAt")
                    self._archive_before_replace(session)
                    session = self.new_session(station_id)
                    session["active"] = True
                    session["startedAt"] = utc_now_iso()
                    session["endedAt"] = None
                    session["pendingChatSdk"] = True
                    if broad_no:
                        session["broadNo"] = broad_no
                    if update_title and title:
                        append_title_history(
                            session, title, at=session.get("startedAt")
                        )
                    changed = True
                    _credits_log(
                        "new session reason=needs_new_broadcast "
                        f"prev_broad={prev_broad} next_broad={broad_no} prev_start={prev_start}"
                    )
                session["stationId"] = station_id
                if broad_no and broad_no != str(session.get("broadNo") or "").strip():
                    session["broadNo"] = broad_no
                    changed = True
                if thumb and thumb != session.get("thumbnailUrl"):
                    session["thumbnailUrl"] = thumb
                    changed = True
                if update_title and title:
                    if append_title_history(session, title):
                        changed = True
                if viewers_n is not None:
                    if viewers_n != int(session.get("lastViewerCount") or -1):
                        session["lastViewerCount"] = viewers_n
                        changed = True
                    if viewers_n > int(session.get("peakViewers") or 0):
                        session["peakViewers"] = viewers_n
                        session["peakViewersAt"] = utc_now_iso()
                        session["peakTitle"] = title or str(session.get("title") or "").strip()
                        peak_thumb = thumb or str(session.get("thumbnailUrl") or "").strip()
                        if not peak_thumb and broad_no:
                            peak_thumb = f"https://liveimg.sooplive.co.kr/m/{broad_no}"
                        session["peakThumbUrl"] = peak_thumb
                        snap_url = peak_thumb
                        changed = True
                if record_live_metrics(session, viewers=viewers_n, up_count=up_n):
                    changed = True
                # 로컬 캡처가 아직 없으면(최고치 미갱신·캐시 실패) 라이브 중 재시도
                peak_url = str(session.get("peakThumbUrl") or "").strip()
                if not snap_url and (thumb or broad_no) and not peak_url.startswith(
                    "/api/credits/peak-thumb"
                ):
                    snap_url = (
                        peak_url
                        or thumb
                        or str(session.get("thumbnailUrl") or "").strip()
                        or (f"https://liveimg.sooplive.co.kr/m/{broad_no}" if broad_no else "")
                    )
                    if snap_url and not peak_url:
                        session["peakThumbUrl"] = snap_url
                        changed = True
                session["active"] = True
            else:
                if session.get("active") and session.get("startedAt"):
                    self._offline_streak = int(self._offline_streak or 0) + 1
                    if self._offline_streak < _OFFLINE_CONFIRM_POLLS:
                        # API 순간 false — 세션 유지, 다음 폴링에서 재확인
                        return self.load_session()
                    close_collector_segment(session)
                    flush_present_chatters(session)
                    session["active"] = False
                    session["endedAt"] = utc_now_iso()
                    changed = True
                    self._offline_streak = 0
                    # 방종 감지 시 바로 아카이브 (미러 포함 저장 — 파일 불일치로 데이터 유실 방지)
                    try:
                        self.maybe_backup_session(session, reason="offline", force=True)
                        self.save_session(session, rebuild=True)
                        aid = self.archive_session(session, force=session_data_score(session) > 0)
                        _credits_log(
                            f"offline confirmed → archive aid={aid or '-'} "
                            f"broad={session.get('broadNo')} "
                            f"chats={session_chat_count(session)} peak={session.get('peakViewers')}"
                        )
                        changed = False  # 이미 save_session 함
                    except OSError as exc:
                        _credits_log(f"offline archive FAIL {exc}")
                else:
                    self._offline_streak = 0

            # 방송국 별풍 TOP20 → 최종 세션에 열혈 기준선 시드 (new_session 이후)
            if isinstance(balloon_top, list) and balloon_top:
                if apply_station_balloon_top(session, balloon_top):
                    changed = True

            if changed:
                self.save_session(session, rebuild=True)

        # 락 밖에서 썸네일 스냅샷 (라이브 이미지는 시간이 지나면 바뀜)
        if snap_url and not snap_url.startswith("/"):
            candidates = self.peak_thumb_candidates(snap_url, broad_no)
            local = self.cache_peak_thumbnail_any(candidates)
            if local and local.startswith("/api/credits/peak-thumb"):
                with _lock:
                    session = self.load_session()
                    session["peakThumbUrl"] = local
                    self.save_session(session, rebuild=True)

        with _lock:
            return self.load_session()

    def ingest_events(
        self,
        events: list[dict[str, Any]],
        *,
        mark_sdk: bool = True,
        station_id: str | None = None,
        source: str = "",
    ) -> dict[str, Any]:
        if not isinstance(events, list):
            raise ValueError("events must be a list")

        sid = str(station_id or "").strip()
        src = str(source or "").strip().lower()

        # 1) raw 우선 기록 — 세션 저장 실패해도 원본은 남김
        pre_rows: list[dict[str, Any]] = []
        for raw in events:
            if not isinstance(raw, dict):
                continue
            action = str(raw.get("action") or raw.get("type") or "").strip().upper()
            msg = raw.get("message") if isinstance(raw.get("message"), dict) else raw
            if not isinstance(msg, dict):
                msg = {}
            ts = str(raw.get("at") or msg.get("at") or utc_now_iso())
            pre_rows.append(
                build_raw_ingest_row(
                    status="received",
                    action=action,
                    msg=msg,
                    ts=ts,
                    session={"stationId": sid, "startedAt": None, "broadNo": ""},
                    source=src or "pre",
                )
            )
        if pre_rows:
            try:
                self.append_raw_events(
                    pre_rows,
                    session={"stationId": sid, "startedAt": None, "broadNo": ""},
                    source=src or "pre",
                )
            except OSError as exc:
                _credits_log(f"raw pre-append FAIL {exc}")

        if sid:
            try:
                self.bind_station(sid, reset_if_changed=True)
            except Exception as exc:  # noqa: BLE001 — 수집 지속
                _credits_log(f"bind_station FAIL {exc}")

        accepted = 0
        duplicates = 0
        raw_rows: list[dict[str, Any]] = []

        with _lock:
            session = self.load_session()
            session = self._recover_or_keep_session(session, station_id=sid)
            # 방종 후·오래된 세션 처리.
            # 정상 방종(endedAt) 뒤 늦은 채팅만으로는 재개/새 세션을 만들지 않음
            # → 오탐 복구는 apply_live_status(isLive) / begin_collecting 이 담당.
            if session_needs_new_broadcast(session):
                ended_clean = bool(session.get("endedAt")) and not session.get("active")
                prev_broad = str(session.get("broadNo") or "").strip()
                in_end_grace = ended_clean and ended_ingest_in_grace(session)
                if ended_clean and not in_end_grace:
                    for raw in events:
                        if not isinstance(raw, dict):
                            continue
                        action = str(raw.get("action") or raw.get("type") or "").strip().upper()
                        msg = raw.get("message") if isinstance(raw.get("message"), dict) else raw
                        if not isinstance(msg, dict):
                            msg = {}
                        ts = str(raw.get("at") or msg.get("at") or utc_now_iso())
                        raw_rows.append(
                            build_raw_ingest_row(
                                status="ignored_session_ended",
                                action=action,
                                msg=msg,
                                ts=ts,
                                session=session,
                                source=src,
                            )
                        )
                    try:
                        self.append_raw_events(raw_rows, session=session, source=src)
                    except OSError:
                        pass
                    self._last_ingest_stats = {
                        "accepted": 0,
                        "duplicates": 0,
                        "received": len(events),
                        "ignored": "session_ended",
                    }
                    return session
                if in_end_grace:
                    _credits_log(
                        "ingest end-grace keep session "
                        f"ended={session.get('endedAt')} received={len(events)}"
                    )
                elif session_must_preserve(session, broad_no=prev_broad):
                    # stale active 등 — 데이터 있는 세션은 ingest로 덮지 않음
                    resume_collector_session(session)
                    _credits_log(
                        "ingest keep existing session "
                        f"start={session.get('startedAt')} score={session_data_score(session)}"
                    )
                else:
                    # 빈 포인터면 복구 재시도 후, 그래도 없을 때만 new
                    session = self._recover_or_keep_session(
                        session, station_id=sid or prev_broad, broad_no=prev_broad
                    )
                    if session_must_preserve(session, broad_no=prev_broad) or (
                        session.get("startedAt") and session_data_score(session) > 0
                    ):
                        resume_collector_session(session)
                        _credits_log(
                            "ingest recover instead of new "
                            f"start={session.get('startedAt')} score={session_data_score(session)}"
                        )
                    else:
                        keep = sid or str(session.get("stationId") or self.station_id or "").strip()
                        self._archive_before_replace(session)
                        session = self.new_session(keep)
                        session["active"] = True
                        session["startedAt"] = utc_now_iso()
                        session["endedAt"] = None
                        _credits_log(f"ingest new session station={keep}")
            if mark_sdk:
                open_collector_segment(session)

            coalesce_session_user_aliases(session)

            chatters = session.setdefault("chatters", {})
            donations = session.setdefault("donations", {})
            emoticons = session.setdefault("emoticons", {})
            emoticon_usage = session.setdefault("emoticonUsage", {})
            subscribers = session.setdefault("subscribers", [])
            renewals = session.setdefault("subscriberRenewals", [])
            if not isinstance(subscribers, list):
                subscribers = []
                session["subscribers"] = subscribers
            if not isinstance(renewals, list):
                renewals = []
                session["subscriberRenewals"] = renewals
            sub_gifts = session.setdefault("subscriptionGifts", [])
            if not isinstance(sub_gifts, list):
                sub_gifts = []
                session["subscriptionGifts"] = sub_gifts
            fanclub_joins = session.setdefault("fanclubJoins", [])
            if not isinstance(fanclub_joins, list):
                fanclub_joins = []
                session["fanclubJoins"] = fanclub_joins
            top_fans = session.setdefault("topFans", [])
            if not isinstance(top_fans, list):
                top_fans = []
                session["topFans"] = top_fans
            flags = session.setdefault("identityFlags", {})
            if not isinstance(flags, dict):
                flags = {}
                session["identityFlags"] = flags
            tracker = session.setdefault("topFanTracker", {})
            if not isinstance(tracker, dict):
                tracker = {}
                session["topFanTracker"] = tracker
            hydrate_topfan_tracker(tracker, flags, top_fans)
            quickviews = session.setdefault("quickviews", {})
            missions = session.setdefault("missions", {})
            mission_runs = ensure_mission_runs(session)
            ensure_donation_notes(session)
            gems = session.setdefault("gems", {})

            dedup_station = self._norm_station_id(
                sid or session.get("stationId") or self.station_id
            )

            def touch_chatter(uid: str, uname: str, ts_ms: float) -> dict:
                row = chatters.get(uid) or {
                    "name": uname,
                    "count": 0,
                    "joinedAt": ts_ms,
                    "leftAt": 0,
                    "lastSeenAt": ts_ms,
                    "watchedMs": 0,
                }
                row["name"] = uname or row.get("name") or uid
                row["lastSeenAt"] = ts_ms
                if not row.get("joinedAt"):
                    row["joinedAt"] = ts_ms
                chatters[uid] = row
                return row

            def mark_present(uid: str, uname: str, ts_ms: float) -> dict:
                """입장(IN) 또는 채팅 — 나가 있어도 다시 접속으로 취급. 이전 구간은 watchedMs에 보존."""
                row = touch_chatter(uid, uname, ts_ms)
                left = float(row.get("leftAt") or 0)
                joined = float(row.get("joinedAt") or 0)
                pending = float(row.get("pendingLeaveAt") or 0)
                # pending OUT 후 재등장: 그 시점에 퇴장 확정 후 새 구간
                if pending > 0 and left <= 0:
                    if joined > 0 and pending >= joined:
                        eff = effective_watch_end_ms(row, pending)
                        row["watchedMs"] = int(row.get("watchedMs") or 0) + max(
                            0, int(eff - joined)
                        )
                    row["pendingLeaveAt"] = 0
                    row["joinedAt"] = ts_ms
                    row["leftAt"] = 0
                    chatters[uid] = row
                    return row
                if left > 0:
                    # 퇴장 후 재입장/채팅: 새 시청 구간 시작 (누적은 leave 때 이미 반영)
                    row["joinedAt"] = ts_ms
                    row["leftAt"] = 0
                elif joined <= 0:
                    row["joinedAt"] = ts_ms
                    row["leftAt"] = 0
                else:
                    row["leftAt"] = 0
                row["pendingLeaveAt"] = 0
                chatters[uid] = row
                return row

            def mark_absent(uid: str, ts_ms: float) -> None:
                row = chatters.get(uid)
                if not isinstance(row, dict):
                    return
                joined = float(row.get("joinedAt") or 0)
                left = float(row.get("leftAt") or 0)
                if joined > 0 and left <= 0:
                    eff = effective_watch_end_ms(row, ts_ms)
                    row["watchedMs"] = int(row.get("watchedMs") or 0) + max(
                        0, int(eff - joined)
                    )
                row["leftAt"] = ts_ms
                row["lastSeenAt"] = ts_ms
                row["pendingLeaveAt"] = 0
                chatters[uid] = row

            def soft_leave(uid: str, ts_ms: float) -> None:
                """즉시 퇴장 대신 pending — 확정은 finalize_pending_leaves."""
                row = chatters.get(uid)
                if not isinstance(row, dict):
                    return
                if float(row.get("leftAt") or 0) > 0:
                    return
                row["pendingLeaveAt"] = ts_ms
                # lastSeenAt은 올리지 않음 — OUT 시각으로 quiet 시계가 리셋되면 확정이 안 됨
                chatters[uid] = row

            def merge_flags(uid: str, uname: str, status: Any, ts: str = "") -> None:
                if not uid or not isinstance(status, dict):
                    return
                row = flags.get(uid) or {"name": uname}
                row["name"] = uname or row.get("name") or uid
                for key in ("isFan", "isFollower", "isManager", "isSupporter", "isBJ"):
                    if key in status:
                        row[key] = bool(status.get(key))
                flags[uid] = row
                if "isTopFan" in status:
                    observe_topfan(
                        tracker,
                        flags,
                        top_fans,
                        uid,
                        uname,
                        observed=bool(status.get("isTopFan")),
                        ts=ts or utc_now_iso(),
                    )

            def note_fanclub(uid: str, uname: str, fan_number: int, ts: str) -> None:
                if not uid or fan_number <= 0:
                    return
                excluded = session.get("fanclubExcludedUserIds")
                if isinstance(excluded, list) and uid in excluded:
                    return
                if any(isinstance(r, dict) and r.get("userId") == uid for r in fanclub_joins):
                    return
                taken: set[int] = set()
                for row in fanclub_joins:
                    if not isinstance(row, dict):
                        continue
                    try:
                        existing_n = int(row.get("fanNumber") or 0)
                    except (TypeError, ValueError):
                        existing_n = 0
                    if existing_n > 0:
                        taken.add(existing_n)
                if fan_number in taken:
                    return
                fanclub_joins.append(
                    {"userId": uid, "name": uname, "fanNumber": fan_number, "at": ts}
                )
                taken.add(fan_number)
                nums = sorted(taken)
                if len(nums) >= 2:
                    missing = [n for n in range(nums[0], nums[-1] + 1) if n not in taken]
                    if 0 < len(missing) <= FANCLUB_GAP_FILL_MAX:
                        for n in missing:
                            fanclub_joins.append(
                                {
                                    "userId": f"__missed__{n}",
                                    "name": f"(수집 실패) #{n}",
                                    "fanNumber": n,
                                    "at": ts,
                                    "synthetic": True,
                                    "missed": True,
                                }
                            )
                fanclub_joins.sort(
                    key=lambda r: int(r.get("fanNumber") or 0) if isinstance(r, dict) else 0
                )
                session["fanclubJoins"] = fanclub_joins
                session["fanclubCount"] = len(fanclub_joins)

            def note_topfan(uid: str, uname: str, ts: str) -> None:
                """becomesTopFan은 힌트만 — 재확인 후에 승급 확정."""
                if not uid:
                    return
                observe_topfan(
                    tracker,
                    flags,
                    top_fans,
                    uid,
                    uname,
                    observed=True,
                    ts=ts,
                    promote_hint=True,
                )

            for raw in events:
                if not isinstance(raw, dict):
                    raw_rows.append(
                        build_raw_ingest_row(
                            status="invalid",
                            action="",
                            msg={},
                            ts=utc_now_iso(),
                            session=session,
                            source=src,
                        )
                    )
                    continue
                action = str(raw.get("action") or raw.get("type") or "").strip().upper()
                msg = raw.get("message") if isinstance(raw.get("message"), dict) else raw
                if not isinstance(msg, dict):
                    msg = {}
                ts = str(raw.get("at") or msg.get("at") or utc_now_iso())
                if action not in INGEST_TRACKED_ACTIONS:
                    raw_rows.append(
                        build_raw_ingest_row(
                            status="ignored_action",
                            action=action,
                            msg=msg,
                            ts=ts,
                            session=session,
                            source=src,
                        )
                    )
                    continue
                ts_ms = (parse_iso(ts) or datetime.now(timezone.utc)).timestamp() * 1000

                fp = ingest_event_fingerprint(action, msg, ts_ms=ts_ms)
                if _ingest_dedup_check(dedup_station, fp, ts_ms):
                    duplicates += 1
                    raw_rows.append(
                        build_raw_ingest_row(
                            status="duplicate",
                            action=action,
                            msg=msg,
                            ts=ts,
                            session=session,
                            source=src,
                        )
                    )
                    continue
                _ingest_dedup_mark(dedup_station, fp, ts_ms)
                accepted += 1
                raw_rows.append(
                    build_raw_ingest_row(
                        status="accepted",
                        action=action,
                        msg=msg,
                        ts=ts,
                        session=session,
                        source=src,
                    )
                )

                user_id = normalize_soop_user_id(
                    str(
                        msg.get("userId")
                        or msg.get("user_id")
                        or msg.get("id")
                        or ""
                    ).strip()
                )
                name = str(
                    msg.get("userNickname")
                    or msg.get("nickname")
                    or msg.get("name")
                    or user_id
                    or "익명"
                ).strip()[:40]

                if action in CHAT_ACTIONS:
                    if not user_id:
                        continue
                    # 채팅 = 입장으로 취급 (나가 있어도 다시 IN)
                    row = mark_present(user_id, name, ts_ms)
                    row["count"] = int(row.get("count") or 0) + 1
                    row["lastChatAtMs"] = ts_ms
                    record_chat_metric(session, at=ts)
                    merge_flags(user_id, name, msg.get("userStatus"), ts)
                    sig_station = str(
                        session.get("stationId") or sid or self.station_id or ""
                    ).strip()
                    sig_hits = match_signature_emoticons(msg, sig_station)
                    is_emo = is_emoticon_message(msg, station_id=sig_station)
                    if is_emo:
                        emo = emoticons.get(user_id) or {"name": name, "count": 0}
                        emo["name"] = name or emo.get("name") or user_id
                        emo["count"] = int(emo.get("count") or 0) + 1
                        emoticons[user_id] = emo
                        if sig_hits:
                            bump_signature_emoticon_usage(emoticon_usage, sig_hits)
                        else:
                            bump_emoticon_usage(
                                emoticon_usage, msg, station_id=sig_station
                            )
                    if not session.get("firstChat"):
                        # 수집기가 받은 첫 MESSAGE 그대로 (구독티콘·시그니처 포함).
                        # SDK는 접속 전 채팅을 못 받음 — 연결이 늦으면 앞 인사가 빠질 수 있음.
                        text = str(
                            msg.get("message") or msg.get("comment") or msg.get("text") or ""
                        ).strip()
                        emo_name = (
                            emoticon_display_name(msg, station_id=sig_station)
                            if is_emo
                            else ""
                        )
                        if sig_hits and (not emo_name or emo_name == "이모티콘"):
                            emo_name = str(sig_hits[0].get("token") or emo_name)
                        if not text and is_emo:
                            text = emo_name if emo_name and emo_name != "이모티콘" else "이모티콘"
                        first_img = str(
                            msg.get("imageUrl") or msg.get("image_url") or ""
                        ).strip()
                        if not first_img and sig_hits:
                            first_img = str(sig_hits[0].get("imageUrl") or "")
                        if text:
                            session["firstChat"] = {
                                "userId": user_id,
                                "name": row["name"],
                                "message": text[:120],
                                "isEmoticon": is_emo,
                                "emoticonName": (emo_name[:40] if emo_name else ""),
                                "imageUrl": first_img,
                                "at": ts,
                            }

                elif action in PRESENCE_JOIN:
                    user_list = msg.get("userList") if isinstance(msg.get("userList"), list) else None
                    targets = user_list or (
                        [{"userId": user_id, "userNickname": name}] if user_id else []
                    )
                    for u in targets:
                        if not isinstance(u, dict):
                            continue
                        uid = normalize_soop_user_id(
                            str(u.get("userId") or u.get("id") or "").strip()
                        )
                        if not uid:
                            continue
                        uname = str(u.get("userNickname") or u.get("nickname") or uid).strip()[:40]
                        mark_present(uid, uname, ts_ms)
                        merge_flags(uid, uname, u.get("userStatus"), ts)

                elif action in PRESENCE_LEAVE:
                    user_list = msg.get("userList") if isinstance(msg.get("userList"), list) else None
                    targets = user_list or (
                        [{"userId": user_id, "userNickname": name}] if user_id else []
                    )
                    for u in targets:
                        if not isinstance(u, dict):
                            continue
                        raw_uid = str(u.get("userId") or u.get("id") or "").strip()
                        uid = normalize_soop_user_id(raw_uid)
                        if not uid:
                            continue
                        is_kick = bool(u.get("isKick"))
                        row = chatters.get(uid) if isinstance(chatters.get(uid), dict) else None
                        # 1) userId(N) OUT = 슬롯 새로고침 — 퇴장 아님
                        if not is_kick and raw_uid_is_refresh_slot(raw_uid):
                            if isinstance(row, dict):
                                row["lastSeenAt"] = max(
                                    float(row.get("lastSeenAt") or 0), ts_ms
                                )
                                chatters[uid] = row
                            continue
                        # 2) 킥 → 즉시 퇴장
                        if is_kick:
                            mark_absent(uid, ts_ms)
                            continue
                        # 3) 최근 채팅 있으면 pending만/무시 (확정은 finalize)
                        if should_ignore_presence_leave(row, ts_ms, is_kick=False):
                            if isinstance(row, dict):
                                row["lastSeenAt"] = max(
                                    float(row.get("lastSeenAt") or 0), ts_ms
                                )
                                # 최근 활동 중 OUT은 pending도 두지 않음
                                chatters[uid] = row
                            continue
                        soft_leave(uid, ts_ms)

                elif action in DONATION_ACTIONS:
                    if not user_id:
                        continue
                    try:
                        count = int(msg.get("count") or msg.get("value") or 0)
                    except (TypeError, ValueError):
                        count = 0
                    if count <= 0:
                        continue
                    row = donations.get(user_id) or {
                        "name": name,
                        "total": 0,
                        "count": 0,
                        "maxSingle": 0,
                    }
                    row["name"] = name or row.get("name") or user_id
                    row["total"] = int(row.get("total") or 0) + count
                    row["count"] = int(row.get("count") or 0) + 1
                    row["maxSingle"] = max(int(row.get("maxSingle") or 0), count)
                    donations[user_id] = row
                    note_donation_text(
                        session,
                        user_id=user_id,
                        name=name,
                        count=count,
                        text=_donation_text_from_msg(msg),
                        ts=ts,
                        action=action,
                    )
                    if action in BALLOON_SERIES_ACTIONS:
                        record_balloon_metric(session, count, at=ts)
                    # 개수별 횟수 — 시그니처 필터는 오버레이 등록 목록으로 나중에 적용
                    amt = session.setdefault("amountHits", {})
                    if not isinstance(amt, dict):
                        amt = {}
                        session["amountHits"] = amt
                    key = str(count)
                    hit = amt.get(key) if isinstance(amt.get(key), dict) else None
                    if not hit:
                        hit = {"value": count, "count": 0, "users": {}}
                    hit["value"] = count
                    hit["count"] = int(hit.get("count") or 0) + 1
                    users = hit.get("users") if isinstance(hit.get("users"), dict) else {}
                    urow = users.get(user_id) if isinstance(users.get(user_id), dict) else None
                    if not urow:
                        urow = {"name": name, "count": 0}
                    urow["name"] = name or urow.get("name") or user_id
                    urow["count"] = int(urow.get("count") or 0) + 1
                    users[user_id] = urow
                    hit["users"] = users
                    amt[key] = hit
                    # 하위 호환: 예전 signatureHits도 같이 갱신
                    if count >= SIGNATURE_MIN:
                        sigs = session.setdefault("signatureHits", {})
                        if not isinstance(sigs, dict):
                            sigs = {}
                            session["signatureHits"] = sigs
                        sig_hit = sigs.get(key) if isinstance(sigs.get(key), dict) else None
                        if not sig_hit:
                            sig_hit = {"value": count, "count": 0, "users": {}}
                        sig_hit["value"] = count
                        sig_hit["count"] = int(sig_hit.get("count") or 0) + 1
                        sig_users = (
                            sig_hit.get("users") if isinstance(sig_hit.get("users"), dict) else {}
                        )
                        sig_urow = (
                            sig_users.get(user_id)
                            if isinstance(sig_users.get(user_id), dict)
                            else None
                        )
                        if not sig_urow:
                            sig_urow = {"name": name, "count": 0}
                        sig_urow["name"] = name or sig_urow.get("name") or user_id
                        sig_urow["count"] = int(sig_urow.get("count") or 0) + 1
                        sig_users[user_id] = sig_urow
                        sig_hit["users"] = sig_users
                        sigs[key] = sig_hit
                    mark_present(user_id, name, ts_ms)
                    try:
                        fan_number = int(msg.get("fanNumber") or 0)
                    except (TypeError, ValueError):
                        fan_number = 0
                    note_fanclub(user_id, name, fan_number, ts)
                    if msg.get("becomesTopFan"):
                        note_topfan(user_id, name, ts)

                elif action in SUBSCRIBE_NEW:
                    if not user_id:
                        continue
                    if any(isinstance(r, dict) and r.get("userId") == user_id for r in renewals):
                        continue
                    if any(isinstance(r, dict) and r.get("userId") == user_id for r in subscribers):
                        continue
                    try:
                        tier = int(msg.get("tier") or 0)
                    except (TypeError, ValueError):
                        tier = 0
                    sub_type = str(msg.get("type") or "NORMAL").strip() or "NORMAL"
                    subscribers.append(
                        {
                            "userId": user_id,
                            "name": name,
                            "kind": "new",
                            "type": sub_type,
                            "tier": tier,
                            "at": ts,
                        }
                    )
                    touch_chatter(user_id, name, ts_ms)

                elif action in SUBSCRIBE_RENEW:
                    if not user_id:
                        continue
                    try:
                        months = int(msg.get("subscriptionMonths") or 0)
                    except (TypeError, ValueError):
                        months = 0
                    try:
                        acc = int(msg.get("accSubscriptionMonths") or months or 0)
                    except (TypeError, ValueError):
                        acc = months
                    try:
                        tier = int(msg.get("tier") or 0)
                    except (TypeError, ValueError):
                        tier = 0
                    # 같은 유저는 최신(누적 개월 큰 쪽)으로 갱신
                    existing = next(
                        (r for r in renewals if isinstance(r, dict) and r.get("userId") == user_id),
                        None,
                    )
                    # value/표시는 채팅 "N개월 구독중"과 같은 subscriptionMonths.
                    # accSubscriptionMonths는 누적(평생)이라 채팅과 다를 수 있음 → 보관만.
                    entry = {
                        "userId": user_id,
                        "name": name,
                        "kind": "renew",
                        "months": months,
                        "accMonths": acc,
                        "tier": tier,
                        "at": ts,
                        "value": f"{months}개월" if months else (f"{acc}개월" if acc else ""),
                    }
                    if existing:
                        prev_m = int(existing.get("months") or 0)
                        prev_acc = int(existing.get("accMonths") or 0)
                        if months >= prev_m or acc >= prev_acc:
                            existing.update(entry)
                    else:
                        renewals.append(entry)
                    subscribers[:] = [
                        r
                        for r in subscribers
                        if not (isinstance(r, dict) and r.get("userId") == user_id)
                    ]
                    touch_chatter(user_id, name, ts_ms)

                elif action in SUBSCRIBE_GIFT:
                    if not user_id:
                        continue
                    receiver_id = normalize_soop_user_id(
                        str(msg.get("receiverId") or "").strip()
                    )
                    receiver_name = str(
                        msg.get("receiverNickname") or msg.get("receiverName") or receiver_id or ""
                    ).strip()[:40]
                    gift_type = msg.get("type")
                    if isinstance(gift_type, dict):
                        gift_type = gift_type.get("name") or gift_type.get("term") or ""
                    gift_type = str(gift_type or "").strip()
                    try:
                        gift_tier = int(msg.get("tier") or 0)
                    except (TypeError, ValueError):
                        gift_tier = 0
                    sub_gifts.append(
                        {
                            "userId": user_id,
                            "name": name,
                            "receiverId": receiver_id,
                            "receiverName": receiver_name,
                            "type": gift_type,
                            "tier": gift_tier,
                            "at": ts,
                        }
                    )
                    touch_chatter(user_id, name, ts_ms)
                    if receiver_id:
                        touch_chatter(receiver_id, receiver_name or receiver_id, ts_ms)

                elif action in QUICKVIEW_ACTIONS:
                    if not user_id:
                        continue
                    row = quickviews.get(user_id) or {"name": name, "count": 0}
                    row["name"] = name or row.get("name") or user_id
                    row["count"] = int(row.get("count") or 0) + 1
                    receiver_id = str(msg.get("receiverId") or "").strip()
                    if receiver_id:
                        receivers = row.setdefault("receivers", {})
                        receivers[receiver_id] = str(
                            msg.get("receiverNickname") or receiver_id
                        ).strip()[:40]
                    term = msg.get("term")
                    type_obj = msg.get("type")
                    if not term and isinstance(type_obj, dict):
                        term = type_obj.get("term") or type_obj.get("name")
                    if term:
                        row["lastTerm"] = str(term)
                    quickviews[user_id] = row
                    touch_chatter(user_id, name, ts_ms)

                elif action in MISSION_GIFT_ACTIONS:
                    if not user_id:
                        continue
                    try:
                        count = int(msg.get("count") or msg.get("value") or 1)
                    except (TypeError, ValueError):
                        count = 1
                    if count <= 0:
                        count = 1
                    row = missions.get(user_id) or {"name": name, "total": 0, "count": 0}
                    row["name"] = name or row.get("name") or user_id
                    row["total"] = int(row.get("total") or 0) + count
                    row["count"] = int(row.get("count") or 0) + 1
                    missions[user_id] = row
                    note_mission_gift(
                        session,
                        action=action,
                        user_id=user_id,
                        name=name,
                        count=count,
                        ts=ts,
                        title=_mission_title_from_msg(msg),
                        key=str(msg.get("key") or msg.get("missionKey") or "").strip(),
                    )
                    mark_present(user_id, name, ts_ms)
                    try:
                        fan_number = int(msg.get("fanNumber") or 0)
                    except (TypeError, ValueError):
                        fan_number = 0
                    note_fanclub(user_id, name, fan_number, ts)

                elif action in MISSION_FINISH_ACTIONS:
                    note_mission_finished(session, action=action, msg=msg, ts=ts)

                elif action in MISSION_SETTLE_ACTIONS:
                    try:
                        settle_count = int(msg.get("count") or msg.get("value") or 0)
                    except (TypeError, ValueError):
                        settle_count = 0
                    note_mission_settled(session, action=action, count=settle_count, ts=ts)

                elif action in MISSION_FANLIST_ACTIONS:
                    note_mission_fanlist(session, msg)
                    for row in (msg.get("userList") if isinstance(msg.get("userList"), list) else []):
                        if not isinstance(row, dict):
                            continue
                        uid = str(row.get("userId") or "").strip()
                        uname = str(row.get("userNickname") or uid).strip()
                        if uid:
                            mark_present(uid, uname, ts_ms)

                elif action == SSAPI_MISSION_ACTION:
                    apply_ssapi_mission(session, msg, ts=ts)

                elif action == SSAPI_DONATION_ACTION:
                    apply_ssapi_donation(session, msg, ts=ts)

                elif action in OGQ_GIFT_ACTIONS:
                    if not user_id:
                        continue
                    emo = emoticons.get(user_id) or {"name": name, "count": 0, "gifts": 0}
                    emo["name"] = name or emo.get("name") or user_id
                    emo["count"] = int(emo.get("count") or 0) + 1
                    emo["gifts"] = int(emo.get("gifts") or 0) + 1
                    emoticons[user_id] = emo
                    bump_emoticon_usage(emoticon_usage, msg)
                    touch_chatter(user_id, name, ts_ms)

                elif action in GEM_ACTIONS:
                    if not user_id:
                        continue
                    row = gems.get(user_id) or {"name": name, "count": 0, "items": []}
                    row["name"] = name or row.get("name") or user_id
                    row["count"] = int(row.get("count") or 0) + 1
                    item_name = str(msg.get("itemName") or "").strip()
                    if item_name and len(row.get("items") or []) < 20:
                        row.setdefault("items", []).append(item_name)
                    gems[user_id] = row
                    touch_chatter(user_id, name, ts_ms)

            session["chatters"] = chatters
            session["donations"] = donations
            session["emoticons"] = emoticons
            session["emoticonUsage"] = emoticon_usage
            session["subscribers"] = subscribers
            session["subscriberRenewals"] = renewals
            session["subscriptionGifts"] = sub_gifts
            session["fanclubJoins"] = fanclub_joins
            session["topFans"] = top_fans
            session["identityFlags"] = flags
            session["topFanTracker"] = tracker
            session["quickviews"] = quickviews
            session["missions"] = missions
            session["missionRuns"] = mission_runs
            session["gems"] = gems
            # pending OUT 확정 (배치 마지막 시각 기준)
            try:
                last_ms = 0.0
                for raw in events:
                    if not isinstance(raw, dict):
                        continue
                    msg = raw.get("message") if isinstance(raw.get("message"), dict) else raw
                    ts = str(raw.get("at") or (msg or {}).get("at") or "")
                    dt = parse_iso(ts)
                    if dt:
                        last_ms = max(last_ms, dt.timestamp() * 1000)
                if last_ms <= 0:
                    last_ms = time.time() * 1000
                finalize_pending_leaves(chatters, last_ms)
                session["chatters"] = chatters
            except Exception as exc:  # noqa: BLE001
                _credits_log(f"finalize_pending_leaves FAIL {exc}")
            # 주기 백업 시각을 같은 save에 묶음
            try:
                self.maybe_backup_session(session, reason="interval")
            except OSError as exc:
                _credits_log(f"backup interval FAIL {exc}")
            self.save_session(session, rebuild=True)
            try:
                self.append_raw_events(raw_rows, session=session, source=src)
            except OSError as exc:
                _credits_log(f"raw ingest FAIL {exc}")
            self._last_ingest_stats = {
                "accepted": accepted,
                "duplicates": duplicates,
                "received": len(events),
            }
            return session

    def last_ingest_stats(self) -> dict[str, int]:
        stats = getattr(self, "_last_ingest_stats", None)
        if isinstance(stats, dict):
            return {
                "accepted": int(stats.get("accepted") or 0),
                "duplicates": int(stats.get("duplicates") or 0),
                "received": int(stats.get("received") or 0),
            }
        return {"accepted": 0, "duplicates": 0, "received": 0}

    def bind_station(self, station_id: str, *, reset_if_changed: bool = True) -> dict[str, Any]:
        """로그인 BJ 채널 세션으로 전환. 계정별 파일을 쓰므로 다른 계정 데이터를 덮지 않는다.

        같은 계정이면 활성 포인터·계정 파일 중 더 풍부한 쪽을 고른다.
        (미러 누락으로 얇은 파일이 풍부한 세션을 덮어쓰는 사고 방지)
        """
        station_id = self._norm_station_id(station_id)
        if not station_id:
            raise ValueError("stationId required")
        _ = reset_if_changed  # 호환 유지 — 계정 전환 시 타 계정 세션은 아카이브하지 않음
        with _lock:
            current = self._read_session_file(
                self.session_path, fallback_station=self.station_id
            )
            cur_sid = self._norm_station_id(current.get("stationId") or self.station_id)

            # 다른 계정으로 전환 시에만 현재 포인터를 그 계정 파일에 보존
            if cur_sid and cur_sid != station_id:
                try:
                    self._mirror_station_session({**current, "stationId": cur_sid})
                except Exception:
                    pass

            self.station_id = station_id
            path = self._station_session_path(station_id)
            if path.exists():
                station_session = self._read_session_file(path, fallback_station=station_id)
            else:
                station_session = empty_session(station_id)

            prev = self._norm_station_id(station_session.get("stationId"))
            if prev and prev != station_id:
                station_session = empty_session(station_id)
            else:
                station_session["stationId"] = station_id

            if cur_sid == station_id:
                # 같은 계정: 점수 높은 쪽 유지 (동점이면 updatedAt 최신)
                cur_score = session_data_score(current)
                st_score = session_data_score(station_session)
                if cur_score > st_score:
                    session = {**current, "stationId": station_id}
                elif st_score > cur_score:
                    session = station_session
                else:
                    cur_u = parse_iso(current.get("updatedAt")) or datetime.min.replace(
                        tzinfo=timezone.utc
                    )
                    st_u = parse_iso(station_session.get("updatedAt")) or datetime.min.replace(
                        tzinfo=timezone.utc
                    )
                    session = (
                        {**current, "stationId": station_id}
                        if cur_u >= st_u
                        else station_session
                    )
                if cur_score != st_score:
                    _credits_log(
                        f"bind_station pick richer sid={station_id} "
                        f"pointer={cur_score} file={st_score}"
                    )
            else:
                session = station_session

            session["stationId"] = station_id
            self._write_json(self.session_path, session)
            self._mirror_station_session(session)
            payload = self.build_credits_payload(session)
            self._write_json(self.credits_path, payload)
            return session

    def begin_collecting(self, station_id: str | None = None) -> dict[str, Any]:
        """채팅 SDK 연결 성공 시. 같은 방송·데이터 있는 세션은 이어 받고, 새 broad만 교체."""
        sid = self._norm_station_id(station_id or self.station_id or "")
        if sid:
            # 계정 세션으로 전환(타 계정 파일은 보존)
            self.bind_station(sid, reset_if_changed=False)
        with _lock:
            session = self._read_session_file(self.session_path, fallback_station=sid or self.station_id)
            keep = sid or self._norm_station_id(session.get("stationId") or self.station_id)
            prev_broad = str(session.get("broadNo") or "").strip()
            if session_needs_new_broadcast(session):
                if session_can_resume_same_broadcast(session, broad_no=prev_broad) or session_must_preserve(
                    session, broad_no=prev_broad
                ):
                    resume_collector_session(session)
                    self._write_json(self.session_path, session)
                    self._mirror_station_session(session)
                    payload = self.build_credits_payload(session)
                    self._write_json(self.credits_path, payload)
                    _credits_log(
                        f"begin resume/keep broad={prev_broad} "
                        f"start={session.get('startedAt')} chats={session_chat_count(session)}"
                    )
                elif session.get("startedAt") and session_data_score(session) > 0:
                    # broad 변경 확인 없이 데이터 있는 세션을 버리지 않음
                    resume_collector_session(session)
                    self._write_json(self.session_path, session)
                    self._mirror_station_session(session)
                    payload = self.build_credits_payload(session)
                    self._write_json(self.credits_path, payload)
                    _credits_log(
                        "begin refuse new_session (has data) "
                        f"start={session.get('startedAt')} score={session_data_score(session)}"
                    )
                else:
                    self._archive_before_replace(session)
                    session = self.new_session(keep)
                    session["active"] = True
                    session["startedAt"] = utc_now_iso()
                    session["endedAt"] = None
                    open_collector_segment(session)
                    self._write_json(self.session_path, session)
                    self._mirror_station_session(session)
                    payload = self.build_credits_payload(session)
                    self._write_json(self.credits_path, payload)
                    _credits_log(f"begin new session station={keep}")
            else:
                if keep and self._norm_station_id(session.get("stationId")) != keep:
                    session["stationId"] = keep
                open_collector_segment(session)
                self._write_json(self.session_path, session)
                self._mirror_station_session(session)
                payload = self.build_credits_payload(session)
                self._write_json(self.credits_path, payload)
        # 로그인 BJ 방송 — 썸네일 없으면 바로 캡처
        try:
            self.capture_live_frame(station_id=sid or None, force=False)
        except Exception:
            pass
        return self.load_session()

    def pause_collecting(self, station_id: str | None = None) -> dict[str, Any]:
        """수집기 연결만 종료(방송 세션은 유지)."""
        sid = str(station_id or "").strip()
        with _lock:
            if sid:
                self.station_id = sid
            session = self.load_session()
            if sid and str(session.get("stationId") or "") != sid:
                session["stationId"] = sid
            if close_collector_segment(session):
                self.save_session(session, rebuild=True)
            else:
                session["chatSdkConnected"] = False
                self.save_session(session, rebuild=False)
            return session

    def mark_session_ended(self, station_id: str | None = None) -> dict[str, Any]:
        """폴러/명시적 종료 시 세션을 종료 표시한다. (잠깐의 채팅 재연결로는 호출하지 말 것)"""
        sid = str(station_id or "").strip()
        with _lock:
            if sid:
                self.station_id = sid
            session = self.load_session()
            if sid and str(session.get("stationId") or "") != sid:
                session["stationId"] = sid
            if session.get("startedAt") and (session.get("active") or not session.get("endedAt")):
                close_collector_segment(session)
                flush_present_chatters(session)
                session["active"] = False
                if not session.get("endedAt"):
                    session["endedAt"] = utc_now_iso()
                self.save_session(session, rebuild=True)
                try:
                    self.archive_session(session)
                except OSError:
                    pass
            return session

    def poll_once(
        self, station_id: str | None = None, *, update_title: bool = True
    ) -> dict[str, Any] | None:
        if not self.live_fetcher:
            return None
        session_hint = self.load_session()
        sid = str(
            station_id
            or session_hint.get("stationId")
            or self.station_id
            or ""
        ).strip()
        if not sid:
            return session_hint
        if sid != self.station_id:
            self.station_id = sid
        try:
            status = self.live_fetcher(sid)
        except Exception:
            return None
        session = self.apply_live_status(status, update_title=update_title)
        # 뱅온 직후 connect 지연 방지 — 썸네일 캡처는 poll 응답 뒤 백그라운드
        if bool(status.get("isLive")) and not self.has_local_peak_thumb():
            broad_no = str(status.get("broadNo") or "")
            thumb_url = str(status.get("thumbnailUrl") or "")

            def _bg_capture() -> None:
                try:
                    self.capture_live_frame(
                        station_id=sid,
                        broad_no=broad_no,
                        thumb_url=thumb_url,
                        force=True,
                    )
                except Exception:
                    pass

            threading.Thread(target=_bg_capture, daemon=True).start()
        return session

    def capture_live_frame(
        self,
        *,
        station_id: str | None = None,
        broad_no: str = "",
        thumb_url: str = "",
        force: bool = False,
        replace_peak: bool = False,
    ) -> dict[str, Any]:
        """로그인 BJ 방송 기준으로 라이브 썸네일을 로컬에 캡처한다.

        썸네일 필드가 비어 있어도 broadNo → liveimg 로 시도한다.

        - force: 원격 URL 조회를 강행 (소스가 비어도 liveimg 시도)
        - replace_peak: True일 때만 이미 고정된 최고시청 썸네일을 덮어씀
          (새 peak 갱신 경로 전용). 수집기 재연결·/me·capture API는 False.
        """
        sid = str(station_id or self.station_id or "").strip()
        if sid:
            self.station_id = sid
        session = self.load_session()
        peak_url = str(session.get("peakThumbUrl") or "").strip()
        has_locked_peak = self.has_local_peak_thumb() and (
            peak_url.startswith("/api/credits/peak-thumb")
            or int(session.get("peakViewers") or 0) > 0
        )
        # 이미 최고시청 순간이 고정돼 있으면 재연결/강제 캡처로 덮지 않음
        if has_locked_peak and not replace_peak:
            url = self._resolve_peak_thumb_url(session)
            if url:
                return {
                    "ok": True,
                    "cached": True,
                    "skipped": "peak_locked",
                    "peakThumbUrl": url,
                    "session": session,
                }
        if not force and self.has_local_peak_thumb():
            url = self._resolve_peak_thumb_url(session)
            if url:
                return {"ok": True, "cached": True, "peakThumbUrl": url, "session": session}

        bn = str(broad_no or session.get("broadNo") or "").strip()
        thumb = str(thumb_url or session.get("thumbnailUrl") or session.get("peakThumbUrl") or "").strip()

        status: dict[str, Any] | None = None
        if self.live_fetcher and sid:
            try:
                status = self.live_fetcher(sid)
            except Exception:
                status = None
        if isinstance(status, dict):
            if status.get("isLive"):
                self.apply_live_status(status)
                session = self.load_session()
                # apply_live_status가 새 peak로 로컬 고정했을 수 있음
                peak_url = str(session.get("peakThumbUrl") or "").strip()
                if (
                    self.has_local_peak_thumb()
                    and peak_url.startswith("/api/credits/peak-thumb")
                    and not replace_peak
                ):
                    return {
                        "ok": True,
                        "cached": True,
                        "skipped": "peak_locked_after_poll",
                        "peakThumbUrl": peak_url,
                        "session": session,
                    }
            bn = str(status.get("broadNo") or bn or "").strip()
            thumb = str(status.get("thumbnailUrl") or thumb or "").strip()

        candidates = self.peak_thumb_candidates(thumb, bn)
        if not candidates:
            return {
                "ok": False,
                "error": "no_thumb_source",
                "stationId": sid,
                "broadNo": bn,
                "session": session,
            }

        local = self.cache_peak_thumbnail_any(candidates)
        if local.startswith("/api/credits/peak-thumb"):
            with _lock:
                session = self.load_session()
                # 레이스: 캡처 중에 피크가 이미 고정됐으면 덮지 않음
                cur_peak_url = str(session.get("peakThumbUrl") or "").strip()
                if (
                    not replace_peak
                    and self.has_local_peak_thumb()
                    and cur_peak_url.startswith("/api/credits/peak-thumb")
                    and int(session.get("peakViewers") or 0) > 0
                ):
                    return {
                        "ok": True,
                        "cached": True,
                        "skipped": "peak_locked_race",
                        "peakThumbUrl": cur_peak_url,
                        "session": session,
                    }
                session["stationId"] = sid or str(session.get("stationId") or "")
                if bn:
                    session["broadNo"] = bn
                if thumb and not str(session.get("thumbnailUrl") or "").strip():
                    session["thumbnailUrl"] = thumb
                session["peakThumbUrl"] = local
                if not session.get("peakViewersAt"):
                    session["peakViewersAt"] = utc_now_iso()
                if not session.get("peakTitle"):
                    session["peakTitle"] = str(session.get("title") or "").strip()
                self.save_session(session, rebuild=True)
            return {"ok": True, "cached": False, "peakThumbUrl": local, "session": session}

        return {
            "ok": False,
            "error": "cache_failed",
            "stationId": sid,
            "broadNo": bn,
            "tried": candidates,
            "session": session,
        }

    def start_poller(self) -> bool:
        """Start background live poller. Only one process wins via lock file."""
        global _poller_started
        if _poller_started:
            return False
        if not self.live_fetcher:
            return False
        if os.environ.get("CREDITS_POLLER", "1").strip() in ("0", "false", "no"):
            return False

        lock_path = self.session_path.parent / "credits-poller.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR)
            try:
                import fcntl

                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(lock_fd)
                return False
            except ImportError:
                # Windows / no fcntl — best effort single start in this process
                pass
        except OSError:
            return False

        _poller_started = True
        _poller_stop.clear()

        def loop():
            while not _poller_stop.is_set():
                try:
                    self.poll_once()
                except Exception:
                    pass
                _poller_stop.wait(self.poll_interval_sec)

        threading.Thread(target=loop, name="credits-poller", daemon=True).start()
        return True
