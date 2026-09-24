from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any


@dataclass(slots=True)
class SongEntry:
    """타임라인에서 뽑은 한 곡(또는 타임스탬프 이벤트)."""

    timestamp_sec: int | None
    timestamp_raw: str | None
    title: str
    artist: str | None = None
    performer: str | None = None
    note: str | None = None
    is_song: bool = True
    confidence: float = 0.5

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class TimelineComment:
    """노래/구간 타임라인으로 보이는 댓글."""

    comment_no: str
    user_nick: str
    user_id: str
    text: str
    like_cnt: int
    is_best: bool
    reg_date: str | None
    songs: list[SongEntry] = field(default_factory=list)
    parse_method: str = "heuristic"

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d


@dataclass(slots=True)
class BroadcastSetlist:
    """한 VOD(=방송 다시보기)에 대한 정리 결과."""

    title_no: int
    title: str
    bj_id: str
    bj_nick: str | None
    reg_date: str | None
    duration_sec: int | None
    url: str
    comment_cnt: int
    timeline_comments: list[TimelineComment] = field(default_factory=list)
    songs: list[SongEntry] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class PeriodReport:
    """요청 기간 동안의 방송·셋리스트 모음."""

    bj_id: str
    start_date: str
    end_date: str
    broadcasts: list[BroadcastSetlist] = field(default_factory=list)
    generated_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))

    @property
    def all_songs(self) -> list[tuple[BroadcastSetlist, SongEntry]]:
        out: list[tuple[BroadcastSetlist, SongEntry]] = []
        for b in self.broadcasts:
            for s in b.songs:
                if s.is_song:
                    out.append((b, s))
        return out

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_markdown(self) -> str:
        lines = [
            f"# {self.bj_id} 방송 셋리스트 ({self.start_date} ~ {self.end_date})",
            "",
            f"생성: {self.generated_at}",
            f"방송 수: {len(self.broadcasts)} / 곡 수: {len(self.all_songs)}",
            "",
        ]
        for b in self.broadcasts:
            lines.append(f"## {b.reg_date or '?'} — {b.title}")
            lines.append(f"- URL: {b.url}")
            lines.append(f"- title_no: `{b.title_no}`")
            if not b.songs:
                lines.append("- (타임라인에서 곡을 찾지 못함)")
                lines.append("")
                continue
            lines.append("")
            for s in b.songs:
                if not s.is_song:
                    continue
                ts = s.timestamp_raw or ""
                who = s.performer or s.artist
                prefix = f"{who} - " if who else ""
                lines.append(f"- `{ts}` {prefix}{s.title}".rstrip())
            lines.append("")
        return "\n".join(lines)
