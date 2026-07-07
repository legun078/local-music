"""Structured schedule change audit for recovery."""
from __future__ import annotations

import difflib
import json
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEDULE_SETTING_KEYS = (
    "streamerName",
    "brandColor",
    "debutDate",
    "platformNote",
    "calendarLayout",
    "slotChipStyle",
    "chipColorMode",
    "proportionalMinSlots",
    "hourlyMinSlots",
    "calendarFont",
    "sidebarFont",
    "calendarFontBold",
    "sidebarFontBold",
)

CHANGE_STAT_KEYS = {
    "month_added": "monthsAdded",
    "month_removed": "monthsRemoved",
    "day_added": "daysAdded",
    "day_removed": "daysRemoved",
    "slot_added": "slotsAdded",
    "slot_removed": "slotsRemoved",
    "slot_modified": "slotsModified",
    "highlight_added": "highlightsAdded",
    "highlight_removed": "highlightsRemoved",
    "highlight_modified": "highlightsModified",
    "category_added": "categoriesAdded",
    "category_removed": "categoriesRemoved",
    "category_modified": "categoriesModified",
    "month_title": "monthTitlesChanged",
    "setting": "settingsChanged",
    "bangon_changed": "bangonChanged",
    "part2_bangon_changed": "part2BangonChanged",
}

ACTION_LABELS = {
    "move": "옮기기",
    "add": "추가",
    "delete": "삭제",
    "edit": "수정",
    "copy": "복사",
}


def _stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _compute_stats(changes: list[dict]) -> dict:
    stats: dict[str, int] = {}
    setting_keys: list[str] = []
    for change in changes:
        kind = str(change.get("type") or "")
        stat_key = CHANGE_STAT_KEYS.get(kind)
        if stat_key:
            stats[stat_key] = stats.get(stat_key, 0) + 1
        if kind == "setting":
            key = str(change.get("key") or "").strip()
            if key:
                setting_keys.append(key)
    if setting_keys:
        stats["settingKeys"] = setting_keys
    stats["total"] = len(changes)
    return stats


def _compute_operation_stats(operations: list[dict]) -> dict:
    stats: dict[str, int] = {}
    for op in operations:
        action = str(op.get("action") or "")
        if action:
            stats[action] = stats.get(action, 0) + 1
    stats["total"] = len(operations)
    return stats


def _append_change(changes: list[dict], change: dict) -> None:
    changes.append(change)


def _format_date_short(date_key: str) -> str:
    parts = str(date_key or "").split("-")
    if len(parts) == 3 and parts[1].isdigit() and parts[2].isdigit():
        return f"{int(parts[1])}/{int(parts[2])}"
    return str(date_key or "")


def _section_label(section: str) -> str:
    return "2부" if section == "part2" else ""


def _format_location(loc: dict | None) -> str:
    if not isinstance(loc, dict):
        return ""
    date_key = str(loc.get("date") or "")
    section = _section_label(str(loc.get("section") or "slots"))
    index = loc.get("index")
    parts = [_format_date_short(date_key)]
    if section:
        parts.append(section)
    if index is not None:
        parts.append(f"#{int(index) + 1}")
    return " ".join(p for p in parts if p)


def _slot_label(slot: dict | None) -> str:
    if not isinstance(slot, dict):
        return "(슬롯)"
    text = str(slot.get("text") or "").strip() or "(제목 없음)"
    return text[:80]


def _slot_text_changed(before: dict | None, after: dict | None) -> bool:
    b = before if isinstance(before, dict) else {}
    a = after if isinstance(after, dict) else {}
    return str(b.get("text") or "").strip() != str(a.get("text") or "").strip()


def _highlight_label(highlight: dict | None) -> str:
    if not isinstance(highlight, dict):
        return "(하이라이트)"
    text = str(highlight.get("text") or "").strip() or "(제목 없음)"
    return text[:80]


def _slot_fingerprint(slot: dict | None) -> str:
    return _stable_json(slot or {})


def _highlight_text(highlight: dict | None) -> str:
    if not isinstance(highlight, dict):
        return ""
    return str(highlight.get("text") or "").strip()


def _location_tuple(change: dict) -> tuple:
    return (
        str(change.get("monthId") or ""),
        str(change.get("date") or ""),
        str(change.get("section") or "slots"),
        change.get("index"),
    )


def _make_operation(**fields) -> dict:
    op = dict(fields)
    op["summary"] = _operation_summary(op)
    return op


def _operation_summary(op: dict) -> str:
    action = ACTION_LABELS.get(str(op.get("action") or ""), str(op.get("action") or ""))
    label = str(op.get("label") or "").strip()
    target = str(op.get("target") or "")

    if op.get("action") == "move":
        src = _format_location(op.get("source"))
        dst = _format_location(op.get("destination"))
        return f"{action} · {label} ({src} → {dst})"

    if op.get("action") == "edit" and target == "setting":
        key = str(op.get("key") or "")
        return f"{action} · 설정 {key}" if key else f"{action} · 설정"

    if op.get("action") == "edit" and target == "category":
        cid = str(op.get("id") or "")
        return f"{action} · 카테고리 {cid}" if cid else f"{action} · 카테고리"

    if op.get("action") == "edit" and target == "bangon":
        loc = _format_location(op.get("location"))
        return f"{action} · 뱅온 ({loc})" if loc else f"{action} · 뱅온"

    if op.get("action") == "edit" and target == "month_title":
        month_id = str(op.get("monthId") or "")
        return f"{action} · 월 제목 {month_id}" if month_id else f"{action} · 월 제목"

    loc = _format_location(op.get("location"))
    if label and loc:
        return f"{action} · {label} ({loc})"
    if label:
        return f"{action} · {label}"
    if loc:
        return f"{action} ({loc})"
    return action


def _iter_slot_locations(schedule: dict | None):
    schedule = schedule if isinstance(schedule, dict) else {}
    for month_id, month in (schedule.get("months") or {}).items():
        if not isinstance(month, dict):
            continue
        for date_key, day in (month.get("days") or {}).items():
            if not isinstance(day, dict):
                continue
            for section, slots_key in (("slots", "slots"), ("part2", "part2")):
                if section == "part2":
                    part = day.get("part2") if isinstance(day.get("part2"), dict) else {}
                    slots = part.get("slots") or []
                else:
                    slots = day.get("slots") or []
                for index, slot in enumerate(slots):
                    if isinstance(slot, dict):
                        yield {
                            "monthId": month_id,
                            "date": date_key,
                            "section": section,
                            "index": index,
                            "slot": slot,
                            "fingerprint": _slot_fingerprint(slot),
                        }


def _slot_exists_at(schedule: dict | None, loc: dict, fingerprint: str) -> bool:
    for item in _iter_slot_locations(schedule):
        if item["fingerprint"] != fingerprint:
            continue
        if (
            item["monthId"] == loc.get("monthId")
            and item["date"] == loc.get("date")
            and item["section"] == (loc.get("section") or "slots")
            and item["index"] == loc.get("index")
        ):
            return True
    return False


def _day_key_from_change(change: dict) -> tuple[str, str]:
    return (str(change.get("monthId") or ""), str(change.get("date") or ""))


def _day_key_from_loc(loc: dict | None) -> tuple[str, str]:
    loc = loc if isinstance(loc, dict) else {}
    return (str(loc.get("monthId") or ""), str(loc.get("date") or ""))


def _mark_part_promotion_pairs(changes: list[dict], used: set[int]) -> set[tuple[str, str]]:
    """2부 슬롯이 1부로 승격할 때 remove(part2)+add(part1)은 내부 구조 변경."""
    promoted: set[tuple[str, str]] = set()
    for ri, rem in enumerate(changes):
        if ri in used:
            continue
        if rem.get("type") != "slot_removed":
            continue
        if (rem.get("section") or "slots") != "part2":
            continue
        fp = _slot_fingerprint(rem.get("slot"))
        key = _day_key_from_change(rem)
        for ai, add in enumerate(changes):
            if ai in used or add.get("type") != "slot_added":
                continue
            if (add.get("section") or "slots") == "part2":
                continue
            if _day_key_from_change(add) != key:
                continue
            if _slot_fingerprint(add.get("slot")) != fp:
                continue
            used.add(ri)
            used.add(ai)
            promoted.add(key)
            break

    for ri, rem in enumerate(changes):
        if ri in used:
            continue
        if rem.get("type") != "slot_removed":
            continue
        if (rem.get("section") or "slots") != "part2":
            continue
        fp = _slot_fingerprint(rem.get("slot"))
        key = _day_key_from_change(rem)
        for mod in changes:
            if mod.get("type") != "slot_modified":
                continue
            if (mod.get("section") or "slots") == "part2":
                continue
            if _day_key_from_change(mod) != key:
                continue
            if _slot_fingerprint(mod.get("after")) != fp:
                continue
            used.add(ri)
            promoted.add(key)
            break
    return promoted


def _absorb_day_side_effects(
    used: set[int],
    changes: list[dict],
    operations: list[dict],
    promoted_days: set[tuple[str, str]] | None = None,
) -> None:
    promoted_days = promoted_days or set()
    move_dates = []
    for op in operations:
        if op.get("action") != "move":
            continue
        if op.get("target") in ("slot", "highlight"):
            src = op.get("source") or {}
            dst = op.get("destination") or {}
            move_dates.append((src, dst))

    # 승격이 있었던 날의 뱅온 변경은 구조 정리 부수 효과
    collateral_days = set(promoted_days)

    for i, change in enumerate(changes):
        if i in used:
            continue
        kind = change.get("type")
        day_key = _day_key_from_change(change)

        if kind in ("bangon_changed", "part2_bangon_changed") and day_key in collateral_days:
            used.add(i)
            continue

        if kind not in ("day_added", "day_removed"):
            continue
        date_key = str(change.get("date") or "")
        for src, dst in move_dates:
            if kind == "day_removed" and date_key == str(src.get("date") or ""):
                used.add(i)
                break
            if kind == "day_added" and date_key == str(dst.get("date") or ""):
                used.add(i)
                break


def _move_date_span(op: dict) -> tuple[str, str, str, str]:
    src = op.get("source") or {}
    dst = op.get("destination") or {}
    return (
        str(src.get("monthId") or ""),
        str(src.get("date") or ""),
        str(dst.get("monthId") or ""),
        str(dst.get("date") or ""),
    )


def _same_event_date(op: dict, other: dict) -> bool:
    if op.get("action") == "move" and other.get("action") == "move":
        return _move_date_span(op) == _move_date_span(other)
    loc = op.get("location") or op.get("source") or {}
    oloc = other.get("location") or other.get("source") or {}
    return (
        str(loc.get("monthId") or "") == str(oloc.get("monthId") or "")
        and str(loc.get("date") or "") == str(oloc.get("date") or "")
    )


def _dedupe_linked_operations(operations: list[dict]) -> list[dict]:
    """슬롯과 연동된 하이라이트는 같은 사용자 작업이므로 슬롯만 남긴다."""
    drop: set[int] = set()
    for i, op in enumerate(operations):
        if op.get("target") != "highlight":
            continue
        if op.get("action") not in ("move", "add", "delete", "edit"):
            continue
        label = str(op.get("label") or "").strip()
        if not label:
            continue
        for j, other in enumerate(operations):
            if i == j or other.get("target") != "slot":
                continue
            if other.get("action") != op.get("action"):
                continue
            if str(other.get("label") or "").strip() != label:
                continue
            if _same_event_date(op, other):
                drop.add(i)
                break
    return [op for i, op in enumerate(operations) if i not in drop]


def classify_operations(changes: list[dict], old: dict | None = None, new: dict | None = None) -> list[dict]:
    operations: list[dict] = []
    used: set[int] = set()

    removes = [(i, c) for i, c in enumerate(changes) if c.get("type") in ("slot_removed", "highlight_removed")]
    adds = [(i, c) for i, c in enumerate(changes) if c.get("type") in ("slot_added", "highlight_added")]

    for ri, rem in removes:
        if ri in used:
            continue
        if rem.get("type") == "slot_removed":
            fp = _slot_fingerprint(rem.get("slot"))
            for ai, add in adds:
                if ai in used or add.get("type") != "slot_added":
                    continue
                if _slot_fingerprint(add.get("slot")) != fp:
                    continue
                if _location_tuple(rem) == _location_tuple(add):
                    continue
                rem_section = rem.get("section") or "slots"
                add_section = add.get("section") or "slots"
                if (
                    rem_section == "part2"
                    and add_section != "part2"
                    and str(rem.get("date") or "") == str(add.get("date") or "")
                    and str(rem.get("monthId") or "") == str(add.get("monthId") or "")
                ):
                    continue
                operations.append(
                    _make_operation(
                        action="move",
                        target="slot",
                        label=_slot_label(rem.get("slot")),
                        source={
                            "monthId": rem.get("monthId"),
                            "date": rem.get("date"),
                            "section": rem.get("section") or "slots",
                            "index": rem.get("index"),
                        },
                        destination={
                            "monthId": add.get("monthId"),
                            "date": add.get("date"),
                            "section": add.get("section") or "slots",
                            "index": add.get("index"),
                        },
                        slot=rem.get("slot"),
                    )
                )
                used.add(ri)
                used.add(ai)
                break
            continue

        if rem.get("type") == "highlight_removed":
            text = _highlight_text(rem.get("highlight"))
            if not text:
                continue
            for ai, add in adds:
                if ai in used or add.get("type") != "highlight_added":
                    continue
                if _highlight_text(add.get("highlight")) != text:
                    continue
                if str(rem.get("date") or "") == str(add.get("date") or ""):
                    continue
                operations.append(
                    _make_operation(
                        action="move",
                        target="highlight",
                        label=_highlight_label(rem.get("highlight")),
                        source={
                            "monthId": rem.get("monthId"),
                            "date": rem.get("date"),
                        },
                        destination={
                            "monthId": add.get("monthId"),
                            "date": add.get("date"),
                        },
                        highlight=rem.get("highlight"),
                    )
                )
                used.add(ri)
                used.add(ai)
                break

    modifies = [(i, c) for i, c in enumerate(changes) if c.get("type") == "slot_modified"]
    for ai, add in adds:
        if ai in used or add.get("type") != "slot_added":
            continue
        fp = _slot_fingerprint(add.get("slot"))
        for mi, mod in modifies:
            if mi in used:
                continue
            if _slot_fingerprint(mod.get("before")) != fp:
                continue
            if not _slot_text_changed(mod.get("before"), mod.get("after")):
                continue
            if _location_tuple(mod) == _location_tuple(add):
                continue
            operations.append(
                _make_operation(
                    action="move",
                    target="slot",
                    label=_slot_label(mod.get("before")),
                    source={
                        "monthId": mod.get("monthId"),
                        "date": mod.get("date"),
                        "section": mod.get("section") or "slots",
                        "index": mod.get("index"),
                    },
                    destination={
                        "monthId": add.get("monthId"),
                        "date": add.get("date"),
                        "section": add.get("section") or "slots",
                        "index": add.get("index"),
                    },
                    slot=mod.get("before"),
                )
            )
            used.add(ai)
            used.add(mi)
            break

    promoted_days = _mark_part_promotion_pairs(changes, used)
    _absorb_day_side_effects(used, changes, operations, promoted_days)

    old_slot_locs = list(_iter_slot_locations(old))
    removed_fps = {
        _slot_fingerprint(ch.get("slot"))
        for i, ch in enumerate(changes)
        if i not in used and ch.get("type") == "slot_removed"
    }

    for i, change in enumerate(changes):
        if i in used:
            continue
        kind = str(change.get("type") or "")

        if kind == "slot_modified":
            operations.append(
                _make_operation(
                    action="edit",
                    target="slot",
                    label=_slot_label(change.get("before")),
                    location={
                        "monthId": change.get("monthId"),
                        "date": change.get("date"),
                        "section": change.get("section") or "slots",
                        "index": change.get("index"),
                    },
                    before=change.get("before"),
                    after=change.get("after"),
                )
            )
            continue

        if kind == "slot_removed":
            operations.append(
                _make_operation(
                    action="delete",
                    target="slot",
                    label=_slot_label(change.get("slot")),
                    location={
                        "monthId": change.get("monthId"),
                        "date": change.get("date"),
                        "section": change.get("section") or "slots",
                        "index": change.get("index"),
                    },
                    slot=change.get("slot"),
                )
            )
            continue

        if kind == "slot_added":
            loc = {
                "monthId": change.get("monthId"),
                "date": change.get("date"),
                "section": change.get("section") or "slots",
                "index": change.get("index"),
            }
            fp = _slot_fingerprint(change.get("slot"))
            is_copy = False
            for old_loc in old_slot_locs:
                if old_loc["fingerprint"] != fp:
                    continue
                if fp in removed_fps:
                    continue
                if _slot_exists_at(new, loc, fp) and not _slot_exists_at(old, loc, fp):
                    # same content already existed elsewhere and wasn't removed
                    if _location_tuple({"monthId": old_loc["monthId"], "date": old_loc["date"], "section": old_loc["section"], "index": old_loc["index"]}) != _location_tuple(loc):
                        is_copy = True
                        break
            operations.append(
                _make_operation(
                    action="copy" if is_copy else "add",
                    target="slot",
                    label=_slot_label(change.get("slot")),
                    location=loc,
                    slot=change.get("slot"),
                )
            )
            continue

        if kind == "highlight_modified":
            operations.append(
                _make_operation(
                    action="edit",
                    target="highlight",
                    label=_highlight_label(change.get("before")),
                    location={"monthId": change.get("monthId"), "date": change.get("date")},
                    before=change.get("before"),
                    after=change.get("after"),
                )
            )
            continue

        if kind == "highlight_removed":
            operations.append(
                _make_operation(
                    action="delete",
                    target="highlight",
                    label=_highlight_label(change.get("highlight")),
                    location={"monthId": change.get("monthId"), "date": change.get("date")},
                    highlight=change.get("highlight"),
                )
            )
            continue

        if kind == "highlight_added":
            operations.append(
                _make_operation(
                    action="add",
                    target="highlight",
                    label=_highlight_label(change.get("highlight")),
                    location={"monthId": change.get("monthId"), "date": change.get("date")},
                    highlight=change.get("highlight"),
                )
            )
            continue

        if kind == "day_removed":
            operations.append(
                _make_operation(
                    action="delete",
                    target="day",
                    label=_format_date_short(str(change.get("date") or "")),
                    location={"monthId": change.get("monthId"), "date": change.get("date")},
                    day=change.get("day"),
                )
            )
            continue

        if kind == "day_added":
            operations.append(
                _make_operation(
                    action="add",
                    target="day",
                    label=_format_date_short(str(change.get("date") or "")),
                    location={"monthId": change.get("monthId"), "date": change.get("date")},
                    day=change.get("day"),
                )
            )
            continue

        if kind == "month_removed":
            operations.append(
                _make_operation(
                    action="delete",
                    target="month",
                    label=str(change.get("monthId") or ""),
                    monthId=change.get("monthId"),
                    month=change.get("month"),
                )
            )
            continue

        if kind == "month_added":
            operations.append(
                _make_operation(
                    action="add",
                    target="month",
                    label=str(change.get("monthId") or ""),
                    monthId=change.get("monthId"),
                    month=change.get("month"),
                )
            )
            continue

        if kind == "month_title":
            operations.append(
                _make_operation(
                    action="edit",
                    target="month_title",
                    label=str(change.get("monthId") or ""),
                    monthId=change.get("monthId"),
                    before=change.get("before"),
                    after=change.get("after"),
                )
            )
            continue

        if kind in ("bangon_changed", "part2_bangon_changed"):
            operations.append(
                _make_operation(
                    action="edit",
                    target="bangon",
                    label="뱅온 시간",
                    location={
                        "monthId": change.get("monthId"),
                        "date": change.get("date"),
                        "section": change.get("section") or "slots",
                    },
                    before=change.get("before"),
                    after=change.get("after"),
                )
            )
            continue

        if kind == "setting":
            operations.append(
                _make_operation(
                    action="edit",
                    target="setting",
                    key=change.get("key"),
                    label=str(change.get("key") or "설정"),
                    before=change.get("before"),
                    after=change.get("after"),
                )
            )
            continue

        if kind == "category_removed":
            operations.append(
                _make_operation(
                    action="delete",
                    target="category",
                    id=change.get("id"),
                    label=str(change.get("id") or ""),
                    category=change.get("category"),
                )
            )
            continue

        if kind == "category_added":
            operations.append(
                _make_operation(
                    action="add",
                    target="category",
                    id=change.get("id"),
                    label=str(change.get("id") or ""),
                    category=change.get("category"),
                )
            )
            continue

        if kind == "category_modified":
            operations.append(
                _make_operation(
                    action="edit",
                    target="category",
                    id=change.get("id"),
                    label=str(change.get("id") or ""),
                    before=change.get("before"),
                    after=change.get("after"),
                )
            )
            continue

    return _dedupe_linked_operations(operations)


def _finalize_audit_detail(changes: list[dict], old: dict | None = None, new: dict | None = None) -> dict:
    operations = classify_operations(changes, old, new)
    return {
        "changes": changes,
        "operations": operations,
        "stats": _compute_stats(changes),
        "operationStats": _compute_operation_stats(operations),
    }


def _diff_settings(old: dict, new: dict, changes: list[dict]) -> None:
    for key in SCHEDULE_SETTING_KEYS:
        before = old.get(key)
        after = new.get(key)
        if before != after:
            _append_change(
                changes,
                {"type": "setting", "key": key, "before": before, "after": after},
            )
    diff_categories(old.get("categories") or {}, new.get("categories") or {}, changes)


def diff_categories(old_cats: dict, new_cats: dict, changes: list[dict]) -> None:
    ids = sorted(set(old_cats) | set(new_cats))
    for cid in ids:
        before = old_cats.get(cid)
        after = new_cats.get(cid)
        if cid not in new_cats:
            _append_change(changes, {"type": "category_removed", "id": cid, "category": before})
        elif cid not in old_cats:
            _append_change(changes, {"type": "category_added", "id": cid, "category": after})
        elif before != after:
            _append_change(
                changes,
                {"type": "category_modified", "id": cid, "before": before, "after": after},
            )


def _highlight_key(item: Any) -> tuple[str, str] | None:
    if not isinstance(item, dict):
        return None
    date_key = str(item.get("date") or "").strip()
    text = str(item.get("text") or "").strip()
    if date_key and text:
        return date_key, text
    return None


def _diff_highlights(month_id: str, old_list: list, new_list: list, changes: list[dict]) -> None:
    old_map = {}
    for item in old_list or []:
        key = _highlight_key(item)
        if key:
            old_map[key] = item
    new_map = {}
    for item in new_list or []:
        key = _highlight_key(item)
        if key:
            new_map[key] = item

    for key, item in old_map.items():
        if key not in new_map:
            _append_change(
                changes,
                {
                    "type": "highlight_removed",
                    "monthId": month_id,
                    "date": key[0],
                    "highlight": item,
                },
            )
    for key, item in new_map.items():
        if key not in old_map:
            _append_change(
                changes,
                {
                    "type": "highlight_added",
                    "monthId": month_id,
                    "date": key[0],
                    "highlight": item,
                },
            )
        elif old_map[key] != item:
            _append_change(
                changes,
                {
                    "type": "highlight_modified",
                    "monthId": month_id,
                    "date": key[0],
                    "before": old_map[key],
                    "after": item,
                },
            )


def _diff_slot_list(
    month_id: str,
    date_key: str,
    old_slots: list,
    new_slots: list,
    changes: list[dict],
    *,
    section: str,
) -> None:
    old_slots = old_slots or []
    new_slots = new_slots or []
    old_repr = [_stable_json(slot) for slot in old_slots]
    new_repr = [_stable_json(slot) for slot in new_slots]
    matcher = difflib.SequenceMatcher(None, old_repr, new_repr)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        if tag == "delete":
            for index in range(i1, i2):
                _append_change(
                    changes,
                    {
                        "type": "slot_removed",
                        "monthId": month_id,
                        "date": date_key,
                        "section": section,
                        "index": index,
                        "slot": old_slots[index],
                    },
                )
        elif tag == "insert":
            for index in range(j1, j2):
                _append_change(
                    changes,
                    {
                        "type": "slot_added",
                        "monthId": month_id,
                        "date": date_key,
                        "section": section,
                        "index": index,
                        "slot": new_slots[index],
                    },
                )
        elif tag == "replace":
            old_chunk = old_slots[i1:i2]
            new_chunk = new_slots[j1:j2]
            if len(old_chunk) == len(new_chunk) == 1:
                _append_change(
                    changes,
                    {
                        "type": "slot_modified",
                        "monthId": month_id,
                        "date": date_key,
                        "section": section,
                        "index": i1,
                        "before": old_chunk[0],
                        "after": new_chunk[0],
                    },
                )
                continue
            for index, slot in zip(range(i1, i2), old_chunk):
                _append_change(
                    changes,
                    {
                        "type": "slot_removed",
                        "monthId": month_id,
                        "date": date_key,
                        "section": section,
                        "index": index,
                        "slot": slot,
                    },
                )
            for index, slot in zip(range(j1, j2), new_chunk):
                _append_change(
                    changes,
                    {
                        "type": "slot_added",
                        "monthId": month_id,
                        "date": date_key,
                        "section": section,
                        "index": index,
                        "slot": slot,
                    },
                )


def _diff_day_part(
    month_id: str,
    date_key: str,
    old_part: dict | None,
    new_part: dict | None,
    changes: list[dict],
    *,
    section: str,
) -> None:
    old_part = old_part if isinstance(old_part, dict) else {}
    new_part = new_part if isinstance(new_part, dict) else {}
    old_bangon = old_part.get("bangonTime")
    new_bangon = new_part.get("bangonTime")
    if old_bangon != new_bangon:
        _append_change(
            changes,
            {
                "type": "part2_bangon_changed" if section == "part2" else "bangon_changed",
                "monthId": month_id,
                "date": date_key,
                "section": section,
                "before": old_bangon,
                "after": new_bangon,
            },
        )
    _diff_slot_list(
        month_id,
        date_key,
        old_part.get("slots") or [],
        new_part.get("slots") or [],
        changes,
        section=section,
    )


def _diff_day(month_id: str, date_key: str, old_day: dict | None, new_day: dict | None, changes: list[dict]) -> None:
    if old_day is None and new_day is None:
        return
    if old_day is None:
        _diff_day_part(month_id, date_key, {}, new_day, changes, section="slots")
        _diff_day_part(
            month_id,
            date_key,
            {},
            new_day.get("part2") if isinstance(new_day.get("part2"), dict) else {},
            changes,
            section="part2",
        )
        return
    if new_day is None:
        _diff_day_part(month_id, date_key, old_day, {}, changes, section="slots")
        _diff_day_part(
            month_id,
            date_key,
            old_day.get("part2") if isinstance(old_day.get("part2"), dict) else {},
            {},
            changes,
            section="part2",
        )
        return

    _diff_day_part(month_id, date_key, old_day, new_day, changes, section="slots")
    _diff_day_part(
        month_id,
        date_key,
        old_day.get("part2") if isinstance(old_day.get("part2"), dict) else {},
        new_day.get("part2") if isinstance(new_day.get("part2"), dict) else {},
        changes,
        section="part2",
    )


def _diff_month(month_id: str, old_month: dict | None, new_month: dict | None, changes: list[dict]) -> None:
    old_month = old_month if isinstance(old_month, dict) else None
    new_month = new_month if isinstance(new_month, dict) else None
    if old_month is None and new_month is None:
        return
    if old_month is None:
        _append_change(
            changes,
            {"type": "month_added", "monthId": month_id, "month": new_month},
        )
        return
    if new_month is None:
        _append_change(
            changes,
            {"type": "month_removed", "monthId": month_id, "month": old_month},
        )
        return

    if old_month.get("title") != new_month.get("title"):
        _append_change(
            changes,
            {
                "type": "month_title",
                "monthId": month_id,
                "before": old_month.get("title"),
                "after": new_month.get("title"),
            },
        )

    _diff_highlights(month_id, old_month.get("highlights") or [], new_month.get("highlights") or [], changes)

    old_days = old_month.get("days") or {}
    new_days = new_month.get("days") or {}
    for date_key in sorted(set(old_days) | set(new_days)):
        _diff_day(
            month_id,
            date_key,
            old_days.get(date_key),
            new_days.get(date_key),
            changes,
        )


def build_schedule_audit_detail(old: dict, new: dict) -> dict:
    old = old if isinstance(old, dict) else {}
    new = new if isinstance(new, dict) else {}
    changes: list[dict] = []
    _diff_settings(old, new, changes)

    old_months = old.get("months") or {}
    new_months = new.get("months") or {}
    for month_id in sorted(set(old_months) | set(new_months)):
        _diff_month(month_id, old_months.get(month_id), new_months.get(month_id), changes)

    return _finalize_audit_detail(changes, old, new)


def build_month_audit_detail(month_id: str, before: dict | None, after: dict | None) -> dict:
    changes: list[dict] = []
    _diff_month(month_id, before, after, changes)
    old = {"months": {month_id: before}} if before else {"months": {}}
    new = {"months": {month_id: after}} if after else {"months": {}}
    detail = _finalize_audit_detail(changes, old, new)
    detail["monthId"] = month_id
    return detail


def build_meta_audit_detail(before: dict, after: dict, changed_keys: list[str]) -> dict:
    changes: list[dict] = []
    for key in changed_keys:
        changes.append(
            {
                "type": "setting",
                "key": key,
                "before": before.get(key),
                "after": after.get(key),
            }
        )
    return _finalize_audit_detail(changes, before, after)


def build_month_removed_detail(month_id: str, month: dict) -> dict:
    changes = [{"type": "month_removed", "monthId": month_id, "month": month}]
    old = {"months": {month_id: month}}
    return _finalize_audit_detail(changes, old, {"months": {}})


def format_schedule_audit_summary(detail: dict) -> str:
    operations = detail.get("operations") or []
    if operations:
        lines = [str(op.get("summary") or "") for op in operations[:6] if op.get("summary")]
        extra = len(operations) - len(lines)
        if extra > 0:
            lines.append(f"외 {extra}건")
        return " · ".join(lines)
    return "내용 변경"


def persist_audit_detail(data_dir: Path, detail: dict) -> str:
    detail_dir = data_dir / "audit-details"
    detail_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    detail_id = f"{ts}-{secrets.token_hex(4)}"
    path = detail_dir / f"{detail_id}.json"
    with path.open("w", encoding="utf-8") as f:
        json.dump(detail, f, ensure_ascii=False, indent=2)
    return detail_id
