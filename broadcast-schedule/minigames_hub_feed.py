"""미니게임 허브 알림 피드 — 공지·월간 랭킹."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from minigames_leaderboard import (
    RANK_BOARDS,
    MinesweeperLeaderboard,
    _entry_in_period,
    backfill_registered_ranks,
    format_month_label,
    leaderboard_period_meta,
    normalize_month_at,
    normalize_rank_tier,
)
from minigames_leaderboard_apple import APPLE_MODES, AppleLeaderboard, apple_mode_spec, normalize_apple_mode
from minigames_leaderboard_colortiles import (
    COLORTILES_MODES,
    ColortilesLeaderboard,
    colortiles_mode_spec,
    normalize_colortiles_mode,
)
from minigames_leaderboard_hide import HIDE_MODES, HideLeaderboard, hide_mode_spec, normalize_hide_mode
from minigames_leaderboard_2048 import TILE2048_MODES, Tile2048Leaderboard, tile2048_mode_spec, normalize_2048_mode

KST = timezone(timedelta(hours=9))

GAME_TITLES = {
    "minesweeper": "외계인 찾기",
    "apple": "외계인 검거하기",
    "colortiles": "외계인 매칭",
    "hide": "외계인 숨기기",
    "2048": "2048",
}

GAME_EMOJI = {
    "minesweeper": "👽",
    "apple": "👾",
    "colortiles": "🧩",
    "hide": "🎨",
    "2048": "🔢",
}

MINESWEEPER_TIER_LABELS = {
    "standard": "어려움",
    "expert": "전문가",
}


def _parse_date(raw: str | None) -> datetime | None:
    if not raw or not str(raw).strip():
        return None
    text = str(raw).strip()
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00")) if "T" in text else datetime.strptime(text, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=KST)
            return dt.astimezone(KST)
        except ValueError:
            continue
    return None


def _notice_active(notice: dict, now: datetime) -> bool:
    starts = _parse_date(notice.get("startsAt"))
    expires = _parse_date(notice.get("expiresAt"))
    if starts and now < starts:
        return False
    if expires and now >= expires:
        return False
    return True


def _format_ms_time(sec: int) -> str:
    sec = max(0, int(sec or 0))
    m, s = divmod(sec, 60)
    return f"{m}:{s:02d}"


def _format_score(game: str, entry: dict, *, mode: str = "") -> str:
    if game == "minesweeper":
        return _format_ms_time(int(entry.get("elapsedSec") or 0))
    if game == "hide":
        return f"{round(float(entry.get('score') or 0))}점"
    if game == "2048":
        return f"{int(entry.get('score') or 0):,}점"
    if game == "colortiles":
        if mode == "speedrun":
            return _format_ms_time(int(entry.get("elapsedSec") or 0))
        return f"{int(entry.get('score') or 0)}점"
    return f"{int(entry.get('score') or 0)}점"


def _format_when(dt: datetime) -> str:
    return dt.astimezone(KST).strftime("%m/%d %H:%M")


def _rank_medal(rank: int) -> str:
    return {1: "🥇", 2: "🥈", 3: "🥉"}.get(rank, "🏅")


def _rank_feed_title(name: str, rank: int) -> str:
    return f"{name} · {rank}위 달성"


def _load_hub_config(path: Path, seed_path: Path) -> dict:
    for candidate in (path, seed_path):
        if candidate.is_file():
            try:
                raw = json.loads(candidate.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    return raw
            except (OSError, json.JSONDecodeError):
                pass
    return {"notices": []}


def _entry_sort_at(entry: dict) -> datetime:
    return _parse_date(entry.get("achievedAt")) or datetime.min.replace(tzinfo=KST)


def _month_start_at(month_at: str) -> datetime:
    year, month = (int(x) for x in normalize_month_at(month_at).split("-"))
    return datetime(year, month, 1, tzinfo=KST)


def _sort_feed_items(items: list[dict]) -> list[dict]:
    return sorted(
        items,
        key=lambda item: (
            item.get("sortAt") or "",
            str(item.get("kind") or ""),
        ),
        reverse=True,
    )


def _board_specs() -> list[dict]:
    specs: list[dict] = []
    for tier in RANK_BOARDS:
        specs.append(
            {
                "game": "minesweeper",
                "gameTitle": GAME_TITLES["minesweeper"],
                "emoji": GAME_EMOJI["minesweeper"],
                "modeKey": tier,
                "modeLabel": MINESWEEPER_TIER_LABELS.get(tier, tier),
                "href": f"minesweeper/?tab=rank",
                "kind": "minesweeper",
                "tier": tier,
            }
        )
    for mode in APPLE_MODES:
        meta = apple_mode_spec(mode)
        specs.append(
            {
                "game": "apple",
                "gameTitle": GAME_TITLES["apple"],
                "emoji": GAME_EMOJI["apple"],
                "modeKey": mode,
                "modeLabel": meta.get("label") or mode,
                "href": f"apple/?tab=rank",
                "kind": "apple",
                "mode": mode,
            }
        )
    for mode in COLORTILES_MODES:
        meta = colortiles_mode_spec(mode)
        specs.append(
            {
                "game": "colortiles",
                "gameTitle": GAME_TITLES["colortiles"],
                "emoji": GAME_EMOJI["colortiles"],
                "modeKey": mode,
                "modeLabel": meta.get("label") or mode,
                "href": "colortiles/?tab=rank",
                "kind": "colortiles",
                "mode": mode,
            }
        )
    for mode in HIDE_MODES:
        meta = hide_mode_spec(mode)
        specs.append(
            {
                "game": "hide",
                "gameTitle": GAME_TITLES["hide"],
                "emoji": GAME_EMOJI["hide"],
                "modeKey": mode,
                "modeLabel": meta.get("label") or mode,
                "href": f"hide/?tab=rank",
                "kind": "hide",
                "mode": mode,
            }
        )
    for mode in TILE2048_MODES:
        meta = tile2048_mode_spec(mode)
        specs.append(
            {
                "game": "2048",
                "gameTitle": GAME_TITLES["2048"],
                "emoji": GAME_EMOJI["2048"],
                "modeKey": mode,
                "modeLabel": meta.get("label") or mode,
                "href": f"2048/?tab=rank",
                "kind": "2048",
                "mode": mode,
            }
        )
    return specs


class HubFeedBuilder:
    def __init__(
        self,
        *,
        hub_path: Path,
        hub_seed: Path,
        minesweeper: MinesweeperLeaderboard,
        apple: AppleLeaderboard,
        hide: HideLeaderboard,
        tile2048: Tile2048Leaderboard,
        colortiles: ColortilesLeaderboard | None = None,
    ):
        self._hub_path = hub_path
        self._hub_seed = hub_seed
        self._minesweeper = minesweeper
        self._apple = apple
        self._hide = hide
        self._tile2048 = tile2048
        self._colortiles = colortiles
        self._boards = [
            spec
            for spec in _board_specs()
            if spec["kind"] != "colortiles" or colortiles is not None
        ]

    def _entries(self, spec: dict, month_at: str) -> list[dict]:
        if spec["kind"] == "minesweeper":
            tier = normalize_rank_tier(spec["tier"])
            return self._minesweeper.list_top(tier, "month", month_at)
        if spec["kind"] == "apple":
            mode = normalize_apple_mode(spec["mode"])
            return self._apple.list_top(mode, "month", month_at)
        if spec["kind"] == "colortiles":
            if not self._colortiles:
                return []
            mode = normalize_colortiles_mode(spec["mode"])
            return self._colortiles.list_top(mode, "month", month_at)
        if spec["kind"] == "hide":
            mode = normalize_hide_mode(spec["mode"])
            return self._hide.list_top(mode, "month", month_at)
        mode = normalize_2048_mode(spec["mode"])
        return self._tile2048.list_top(mode, "month", month_at)

    def _raw_entries(self, spec: dict) -> list[dict]:
        if spec["kind"] == "minesweeper":
            return self._minesweeper.raw_entries(spec["tier"])
        if spec["kind"] == "apple":
            return self._apple.raw_entries(spec["mode"])
        if spec["kind"] == "colortiles":
            if not self._colortiles:
                return []
            return self._colortiles.raw_entries(spec["mode"])
        if spec["kind"] == "hide":
            return self._hide.raw_entries(spec["mode"])
        return self._tile2048.raw_entries(spec["mode"])

    def _sort_key_for(self, spec: dict):
        if spec["kind"] == "minesweeper":
            from minigames_leaderboard import _sort_key as ms_sort_key

            return ms_sort_key
        if spec["kind"] == "apple":
            from minigames_leaderboard_apple import _sort_key as apple_sort_key

            return apple_sort_key
        if spec["kind"] == "colortiles":
            from minigames_leaderboard_colortiles import _sort_key_for_mode

            return _sort_key_for_mode(spec["mode"])
        if spec["kind"] == "hide":
            from minigames_leaderboard_hide import _sort_key as hide_sort_key

            return hide_sort_key
        from minigames_leaderboard_2048 import _sort_key as tile2048_sort_key

        return tile2048_sort_key

    def build(self, *, now: datetime | None = None) -> dict:
        now = (now or datetime.now(KST)).astimezone(KST)
        month_at = normalize_month_at(None, now)
        month_label = format_month_label(month_at, now)
        config = _load_hub_config(self._hub_path, self._hub_seed)
        items: list[dict] = []

        for notice in config.get("notices") or []:
            if not isinstance(notice, dict) or not _notice_active(notice, now):
                continue
            notice_id = str(notice.get("id") or "").strip()
            if not notice_id:
                continue
            items.append(
                {
                    "id": f"notice:{notice_id}",
                    "kind": "notice",
                    "emoji": str(notice.get("emoji") or "📢"),
                    "title": str(notice.get("title") or "공지"),
                    "body": str(notice.get("body") or "").strip(),
                    "href": str(notice.get("href") or "").strip(),
                    "tone": "info",
                    "sortAt": (_parse_date(notice.get("startsAt")) or datetime.min.replace(tzinfo=KST)).isoformat(),
                }
            )

        items.append(
            {
                "id": f"month:{month_at}",
                "kind": "month",
                "emoji": "📅",
                "title": f"{month_label} 월간 랭킹",
                "body": "이번 달 기록으로 순위가 집계됩니다.",
                "href": "",
                "tone": "month",
                "sortAt": _month_start_at(month_at).isoformat(),
            }
        )

        for spec in self._boards:
            raw = self._raw_entries(spec)
            backfill_registered_ranks(raw, self._sort_key_for(spec))
            entries = [
                e for e in raw if _entry_in_period(e, "month", now=now, month_at=month_at)
            ]
            for entry in entries:
                registered_rank = int(entry.get("registeredRank") or 0)
                if registered_rank < 1 or registered_rank > 3:
                    continue
                name = str(entry.get("displayName") or "익명").strip() or "익명"
                at = _entry_sort_at(entry)
                if at <= datetime.min.replace(tzinfo=KST):
                    continue
                achieved_key = str(entry.get("achievedAt") or at.isoformat())
                entry_id = str(entry.get("id") or f"{name}:{achieved_key}")
                score = _format_score(spec["game"], entry, mode=str(spec.get("mode") or ""))
                when = _format_when(at)
                items.append(
                    {
                        "id": f"rank-up:{month_at}:{spec['game']}:{spec['modeKey']}:{entry_id}",
                        "kind": "rank_update",
                        "emoji": _rank_medal(registered_rank),
                        "title": _rank_feed_title(name, registered_rank),
                        "body": f"{spec['gameTitle']} {spec['modeLabel']} · {score}",
                        "when": when,
                        "href": spec["href"],
                        "tone": "rank",
                        "sortAt": at.isoformat(),
                    }
                )

        items = _sort_feed_items(items)

        sample_entries: list[dict] = []
        for spec in self._boards:
            sample_entries.extend(self._raw_entries(spec))
        period_meta = leaderboard_period_meta(sample_entries, "month", month_at, now)

        return {
            "monthAt": month_at,
            "monthLabel": month_label,
            "items": items[:25],
            **period_meta,
        }
