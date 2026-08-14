"""방송일정(schedule.json)에서 현재 시각 기준 가장 가까운 미래 부(1부/2부) 일정을 읽는다."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from credits_store import KST
from ics_export import (
    _bangon_anchor_minutes,
    _compute_timed_slot_start_minutes,
    _format_bangon_meridiem,
    _format_bangon_time_display,
    _is_off_day_slots,
    _normalize_bangon_time,
)


def _load_schedule(data_path: Path, seed_path: Path | None = None) -> dict[str, Any]:
    for path in (data_path, seed_path):
        if not path or not path.exists():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(raw, dict):
            return raw
    return {}


def _slot_items(slots: Any, *, bangon: Any = None) -> list[dict[str, Any]]:
    """슬롯 목록 → 표시용 items. 소요시간 대신 일정 시작 시각을 담는다."""
    if not isinstance(slots, list):
        return []
    bangon_n = _normalize_bangon_time(bangon)
    bangon_min = _bangon_anchor_minutes(bangon_n)
    starts = _compute_timed_slot_start_minutes(slots, bangon_n)
    out: list[dict[str, Any]] = []
    for index, slot in enumerate(slots):
        if not isinstance(slot, dict):
            continue
        text = str(slot.get("text") or slot.get("title") or "").strip()
        if not text:
            continue
        start_label = ""
        start_min = starts[index] if index < len(starts) else None
        if start_min is not None:
            # 뱅온과 같은 시각이면 부 헤더의 뱅온만 쓰고 항목에는 중복 표시하지 않음
            if bangon_min is None or int(start_min) != int(bangon_min):
                hour = int(start_min) // 60
                minute = int(start_min) % 60
                start_label = _format_bangon_meridiem(hour, minute)
        out.append(
            {
                "text": text[:80],
                "category": str(slot.get("category") or "").strip(),
                "startLabel": start_label,
            }
        )
    return out


def _date_label(day: datetime) -> str:
    weekdays = "월화수목금토일"
    return f"{day.month}월 {day.day}일 ({weekdays[day.weekday()]})"


def _parse_date_key(date_key: str) -> datetime | None:
    try:
        y, m, d = (int(x) for x in str(date_key).split("-"))
        return datetime(y, m, d, tzinfo=KST)
    except (TypeError, ValueError):
        return None


def _iter_day_parts(day: dict[str, Any]) -> list[dict[str, Any]]:
    """하루를 1부·2부 단위로 분리한다. (표시할 슬롯이 있는 부만)"""
    if not isinstance(day, dict):
        return []
    parts: list[dict[str, Any]] = []

    slots = day.get("slots") if isinstance(day.get("slots"), list) else []
    bangon = day.get("bangonTime")
    items = _slot_items(slots, bangon=bangon)
    if items and not _is_off_day_slots(slots):
        parts.append(
            {
                "part": 1,
                "bangonTime": bangon,
                "slots": slots,
                "items": items,
            }
        )

    part2 = day.get("part2")
    if isinstance(part2, dict):
        p2_slots = part2.get("slots") if isinstance(part2.get("slots"), list) else []
        p2_bangon = part2.get("bangonTime")
        p2_items = _slot_items(p2_slots, bangon=p2_bangon)
        if p2_items and not _is_off_day_slots(p2_slots):
            parts.append(
                {
                    "part": 2,
                    "bangonTime": p2_bangon,
                    "slots": p2_slots,
                    "items": p2_items,
                }
            )

    # 구형: slots 없이 part1/part2만 있는 구조
    if not parts:
        for key, part_n in (("part1", 1), ("part2", 2)):
            block = day.get(key)
            if not isinstance(block, dict):
                continue
            block_slots = block.get("slots") if isinstance(block.get("slots"), list) else []
            block_bangon = block.get("bangonTime")
            block_items = _slot_items(block_slots, bangon=block_bangon)
            if block_items and not _is_off_day_slots(block_slots):
                parts.append(
                    {
                        "part": part_n,
                        "bangonTime": block_bangon,
                        "slots": block_slots,
                        "items": block_items,
                    }
                )
    return parts


def _part_start_dt(date_key: str, part: dict[str, Any]) -> datetime | None:
    """부 시작 시각 = 뱅온·슬롯 시작 시각 중 가장 이른 시각."""
    day0 = _parse_date_key(date_key)
    if day0 is None:
        return None
    slots = part.get("slots") if isinstance(part.get("slots"), list) else []
    bangon = _normalize_bangon_time(part.get("bangonTime"))
    candidates: list[int] = []
    bangon_min = _bangon_anchor_minutes(bangon)
    if bangon_min is not None:
        candidates.append(bangon_min)
    for minutes in _compute_timed_slot_start_minutes(slots, bangon):
        if minutes is not None:
            candidates.append(int(minutes))
    if not candidates:
        # 시간 정보가 없으면 그날 00:00 — 오늘이면 이미 지난 것으로 본다
        return day0
    earliest = min(candidates)
    return day0 + timedelta(minutes=earliest)


def _iter_dated_days(schedule: dict[str, Any]):
    months = schedule.get("months") if isinstance(schedule.get("months"), dict) else {}
    rows: list[tuple[str, dict[str, Any]]] = []
    for month in months.values():
        if not isinstance(month, dict):
            continue
        days = month.get("days") if isinstance(month.get("days"), dict) else {}
        for date_key, day in days.items():
            if isinstance(day, dict) and _parse_date_key(str(date_key)):
                rows.append((str(date_key), day))
    rows.sort(key=lambda row: row[0])
    return rows


def _empty_payload(*, now: datetime) -> dict[str, Any]:
    return {
        "date": "",
        "dateLabel": "",
        "part": None,
        "partLabel": "",
        "bangonLabel": "",
        "timeLabel": "",
        "items": [],
        "parts": [],
        "empty": True,
        "asOf": now.isoformat(),
    }


def _part_payload(
    date_key: str,
    part: dict[str, Any],
    *,
    multi: bool,
    start: datetime,
) -> dict[str, Any]:
    bangon = _normalize_bangon_time(part.get("bangonTime"))
    bangon_disp = _format_bangon_time_display(bangon) if bangon else ""
    bangon_label = bangon_disp if bangon_disp else ""
    part_n = int(part.get("part") or 1)
    part_label = ""
    if multi or part_n >= 2:
        part_label = f"{part_n}부"
    return {
        "part": part_n,
        "partLabel": part_label,
        "bangonLabel": bangon_label,
        "timeLabel": bangon_label,
        "items": part["items"],
        "startsAt": start.isoformat(),
    }


def build_next_day_schedule(
    data_path: Path,
    seed_path: Path | None = None,
    *,
    from_dt: datetime | None = None,
) -> dict[str, Any]:
    """현재(또는 from_dt) 이후, 가장 가까운 방송일의 *남은* 부(1부·2부)를 반환한다.

    - 같은 날 1부·2부가 모두 아직 미래면 parts에 둘 다
    - 1부 시작이 지났으면 2부만
    - 그날 남은 부가 없으면 다음 날짜로
    """
    now = from_dt.astimezone(KST) if from_dt is not None else datetime.now(KST)
    schedule = _load_schedule(data_path, seed_path)

    for date_key, day in _iter_dated_days(schedule):
        day_parts = _iter_day_parts(day)
        if not day_parts:
            continue
        multi = len(day_parts) > 1
        remaining: list[dict[str, Any]] = []
        for part in day_parts:
            start = _part_start_dt(date_key, part)
            if start is None or start <= now:
                continue
            remaining.append(_part_payload(date_key, part, multi=multi, start=start))
        if not remaining:
            continue

        day0 = _parse_date_key(date_key)
        assert day0 is not None
        first = remaining[0]
        return {
            "date": date_key,
            "dateLabel": _date_label(day0),
            "part": first["part"],
            "partLabel": first["partLabel"],
            "bangonLabel": first["bangonLabel"],
            "timeLabel": first["timeLabel"],
            "items": first["items"],
            "startsAt": first["startsAt"],
            "parts": remaining,
            "empty": False,
            "asOf": now.isoformat(),
        }

    return _empty_payload(now=now)

