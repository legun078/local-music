from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from .client import SoopClient
from .interpreter import TimelineInterpreter, build_interpreter
from .models import BroadcastSetlist, PeriodReport, SongEntry, TimelineComment
from .timeline import clean_comment_html, pick_best_timeline_comments


InterpretMode = Literal["auto", "heuristic", "llm"]


def interpret_timeline_text(
    text: str,
    *,
    mode: InterpretMode = "auto",
    interpreter: TimelineInterpreter | None = None,
) -> list[SongEntry]:
    """자유 형식 타임라인 댓글 한 개를 곡 목록으로 해석."""
    eng = interpreter or build_interpreter(mode)
    return eng.interpret(text)


def collect_broadcast_setlists(
    bj_id: str,
    start_date: date | datetime | str,
    end_date: date | datetime | str,
    *,
    client: SoopClient | None = None,
    interpret: InterpretMode = "auto",
    interpreter: TimelineInterpreter | None = None,
    title_keyword: str = "",
    resolve_nick: bool = True,
    timelines_per_vod: int = 2,
    only_with_songs: bool = False,
) -> PeriodReport:
    """
    특정 BJ의 기간 내 다시보기를 모아, 팬 타임라인 댓글에서 노래 리스트를 정리합니다.

    타임라인은 고정 양식이 없으므로 `interpret` 모드로 해석합니다.
    - heuristic: 정규식/규칙 기반 (오프라인)
    - llm: OpenAI 호환 API로 매번 해석 (OPENAI_API_KEY 필요)
    - auto: 휴리스틱으로 곡이 안 잡히면 LLM 시도
    """
    client = client or SoopClient()
    eng = interpreter or build_interpreter(interpret)

    resolved = client.resolve_bj_id(bj_id) if resolve_nick else bj_id
    vods = client.list_vods(resolved, start_date, end_date, keyword=title_keyword)

    start_s = _as_iso_date(start_date)
    end_s = _as_iso_date(end_date)
    report = PeriodReport(bj_id=resolved, start_date=start_s, end_date=end_s)

    for vod in vods:
        title_no = int(vod.get("title_no"))
        title = str(vod.get("title_name") or vod.get("title") or "")
        reg_date = vod.get("reg_date")
        count = vod.get("count") or {}
        comment_cnt = int(count.get("comment_cnt") or 0)
        ucc = vod.get("ucc") or {}
        duration_ms = ucc.get("total_file_duration")
        duration_sec = int(duration_ms) // 1000 if duration_ms else None

        try:
            vod_info = client.get_vod_info(title_no)
        except RuntimeError:
            vod_info = None

        bj_nick = (vod_info or {}).get("writer_nick") or vod.get("user_nick")
        comments: list[dict] = []
        if comment_cnt > 0:
            try:
                comments = client.list_comments(title_no, vod_info=vod_info)
            except RuntimeError:
                comments = []

        best = pick_best_timeline_comments(comments, limit=timelines_per_vod)
        timeline_models: list[TimelineComment] = []
        merged_songs: list[SongEntry] = []

        for c in best:
            raw = c.get("comment") or c.get("memo") or ""
            songs = eng.interpret(raw)
            method = getattr(eng, "__class__", type(eng)).__name__
            tc = TimelineComment(
                comment_no=str(c.get("p_comment_no") or ""),
                user_nick=str(c.get("user_nick") or ""),
                user_id=str(c.get("user_id") or ""),
                text=clean_comment_html(raw),
                like_cnt=int(c.get("like_cnt") or 0),
                is_best=c.get("is_best") in (True, "1", 1),
                reg_date=c.get("reg_date"),
                songs=songs,
                parse_method=method,
            )
            timeline_models.append(tc)

        # 가장 좋은 타임라인(좋아요/베스트 우선으로 이미 정렬)의 곡을 대표 셋리스트로 사용
        if timeline_models:
            primary = max(
                timeline_models,
                key=lambda t: (
                    sum(1 for s in t.songs if s.is_song),
                    t.like_cnt,
                    1 if t.is_best else 0,
                ),
            )
            merged_songs = [s for s in primary.songs if s.is_song]

        broadcast = BroadcastSetlist(
            title_no=title_no,
            title=title,
            bj_id=str((vod_info or {}).get("bj_id") or resolved),
            bj_nick=bj_nick,
            reg_date=reg_date,
            duration_sec=duration_sec,
            url=client.vod_url(title_no),
            comment_cnt=comment_cnt,
            timeline_comments=timeline_models,
            songs=merged_songs,
        )
        if only_with_songs and not merged_songs:
            continue
        report.broadcasts.append(broadcast)

    return report


def _as_iso_date(d: date | datetime | str) -> str:
    if isinstance(d, datetime):
        return d.date().isoformat()
    if isinstance(d, date):
        return d.isoformat()
    s = str(d).strip().replace("/", "-")
    if len(s) == 8 and s.isdigit():
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    return s[:10]
