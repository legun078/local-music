from __future__ import annotations

import html
import re
from typing import Iterable

from .models import SongEntry

# 00:15:35 / 1:18:30 / 15:24 / 7:22:55 등
_TS = re.compile(
    r"(?P<ts>(?:(?P<h>\d{1,2}):)?(?P<m>\d{1,2}):(?P<s>\d{2}))"
)
_LINE_TS = re.compile(
    rf"^\s*{_TS.pattern}\s*(?P<body>.+?)\s*$",
    re.IGNORECASE,
)

_HTML_TAG = re.compile(r"<[^>]+>")
_EMOTE = re.compile(r"/[A-Za-z0-9가-힣_]+/")
_WS = re.compile(r"[ \t\u00a0]+")

# 구간 헤더 / 비서리스트성 이벤트 힌트
_SECTION = re.compile(r"^\s*[-–—\[【]?\s*(?P<label>.+?)\s*[\]】]?[-–—]?\s*$")
_NON_SONG_HINTS = (
    "밴픽",
    "게임시작",
    "결과",
    "디코",
    "방종",
    "마무리",
    "랜덤매칭",
    "튜토리얼",
    "상점",
    "on",
    "off",
    "시작",
    "끝",
    "스크림",
    "경기",
    "오프닝",
    "인트로",
    "엔딩",
    "세레머니",
    "세레모",
)
_SONG_SECTION_HINTS = (
    "노래",
    "셋리",
    "setlist",
    "set list",
    "커버",
    "karaoke",
    "노래방",
    "라디오",
    "라이브",
    "sing",
    "song",
    "타임라인",
    "타임 라인",
)

# "1. 아티스트 - 곡" / "아티스트 - 곡" / "곡명 (아티스트)"
_NUMBERED = re.compile(
    r"^\s*(?P<num>\d{1,3})[.)、]\s*(?P<rest>.+)$"
)
_ARTIST_TITLE = re.compile(
    r"^\s*(?P<artist>.+?)\s*[-–—]\s*(?P<title>.+?)\s*$"
)
_TITLE_ARTIST_PAREN = re.compile(
    r"^\s*(?P<title>.+?)\s*[\(（]\s*(?P<artist>.+?)\s*[\)）]\s*$"
)


def clean_comment_html(raw: str) -> str:
    text = html.unescape(raw or "")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = _HTML_TAG.sub("", text)
    text = _EMOTE.sub("", text)
    lines = [_WS.sub(" ", ln).strip() for ln in text.split("\n")]
    return "\n".join(ln for ln in lines if ln)


def timestamp_to_seconds(ts: str) -> int | None:
    m = _TS.fullmatch(ts.strip())
    if not m:
        return None
    h = int(m.group("h") or 0)
    mi = int(m.group("m"))
    s = int(m.group("s"))
    # MM:SS vs H:MM:SS 모호성: h 그룹이 없고 m>=60이면 잘못됨
    if m.group("h") is None and mi > 59:
        return None
    return h * 3600 + mi * 60 + s


def looks_like_timeline(text: str, *, min_timestamps: int = 3) -> bool:
    cleaned = clean_comment_html(text)
    stamps = _TS.findall(cleaned)
    if len(stamps) >= min_timestamps:
        return True
    lowered = cleaned.lower()
    if any(k in lowered for k in ("타임라인", "셋리스트", "setlist", "타임 라인")):
        return len(stamps) >= 1
    return False


def timeline_score(text: str) -> float:
    cleaned = clean_comment_html(text)
    stamps = len(_TS.findall(cleaned))
    lines = [ln for ln in cleaned.split("\n") if ln.strip()]
    ts_lines = sum(1 for ln in lines if _LINE_TS.match(ln))
    score = stamps * 1.0 + ts_lines * 0.5
    if any(h in cleaned.lower() for h in _SONG_SECTION_HINTS):
        score += 2.0
    if "타임라인" in cleaned or "셋리" in cleaned:
        score += 3.0
    return score


def _split_song_body(
    body: str,
    *,
    in_song_section: bool = False,
) -> tuple[str, str | None, str | None, bool]:
    """body -> (title, artist, performer, is_song_guess).

    번호 매겨진 ``1. 닉네임 - 곡`` 은 노래자랑에서 흔해서 left를 performer로 둡니다.
    번호 없는 ``아티스트 - 곡`` 은 artist/title로 둡니다.
    """
    body = body.strip()
    numbered = _NUMBERED.match(body)
    rest = numbered.group("rest").strip() if numbered else body
    forced_song = numbered is not None

    artist: str | None = None
    performer: str | None = None
    title = rest

    at = _ARTIST_TITLE.match(rest)
    if at:
        left, right = at.group("artist").strip(), at.group("title").strip()
        if numbered:
            # 노래자랑: "1. 참가자 - 곡명"
            performer, title = left, right
        else:
            # 일반 셋리스트: "아티스트 - 곡명"
            artist, title = left, right
        forced_song = True
    else:
        ta = _TITLE_ARTIST_PAREN.match(rest)
        if ta:
            maybe_artist = ta.group("artist").strip()
            # "세레머니 (까자앙~)" 같은 감탄/효과음 괄호는 아티스트로 보지 않음
            if re.fullmatch(r"[\w가-힣 .,'&+/]{2,40}", maybe_artist) and not re.search(
                r"[~:!|]", maybe_artist
            ):
                title, artist = ta.group("title").strip(), maybe_artist
                forced_song = True

    low = f"{title} {artist or ''} {performer or ''}".lower()
    if any(h in low for h in _NON_SONG_HINTS) and not forced_song:
        return title, artist, performer, False
    if forced_song:
        return title, artist, performer, True
    # 노래 섹션 안에서는 타임스탬프+짧은 본문을 곡 후보로
    if in_song_section and len(title) <= 80:
        return title, artist, performer, True
    return title, artist, performer, False


def parse_timeline_heuristic(text: str) -> list[SongEntry]:
    cleaned = clean_comment_html(text)
    entries: list[SongEntry] = []
    in_song_section = False

    for raw_line in cleaned.split("\n"):
        line = raw_line.strip()
        if not line:
            continue

        m = _LINE_TS.match(line)
        if not m:
            # 섹션 헤더
            if len(line) <= 60 and (_SECTION.match(line) or any(h in line.lower() for h in _SONG_SECTION_HINTS)):
                label = line.strip("-–—[]【】 ").lower()
                if any(h in label for h in _SONG_SECTION_HINTS):
                    in_song_section = True
                elif line.startswith("-") or line.endswith("-") or line.startswith("["):
                    in_song_section = False
            continue

        ts_raw = m.group("ts")
        body = m.group("body").strip()
        if not body:
            continue

        low = body.lower()
        if any(h in low for h in ("디코 on", "디코 off", "방종", "3등", "2등", "1등")) and not _NUMBERED.match(
            body
        ):
            entries.append(
                SongEntry(
                    timestamp_sec=timestamp_to_seconds(ts_raw),
                    timestamp_raw=ts_raw,
                    title=body,
                    is_song=False,
                    confidence=0.2,
                )
            )
            continue
        # 섹션 안내 줄 ("VAUNDY 노래자랑 대회" 등)
        if not _NUMBERED.match(body) and re.search(
            r"(노래자랑|셋리스트|대회|타임라인)\s*$", body, re.I
        ):
            entries.append(
                SongEntry(
                    timestamp_sec=timestamp_to_seconds(ts_raw),
                    timestamp_raw=ts_raw,
                    title=body,
                    is_song=False,
                    confidence=0.2,
                )
            )
            continue

        title, artist, performer, is_song = _split_song_body(
            body, in_song_section=in_song_section
        )
        # 번호 매긴 곡 리스트는 섹션 밖에서도 곡으로 인정
        if _NUMBERED.match(body) and (artist or performer or "-" in body or "–" in body):
            is_song = True

        conf = (
            0.85
            if is_song and (artist or performer or _NUMBERED.match(body))
            else 0.55
            if is_song
            else 0.3
        )
        entries.append(
            SongEntry(
                timestamp_sec=timestamp_to_seconds(ts_raw),
                timestamp_raw=ts_raw,
                title=title,
                artist=artist,
                performer=performer,
                is_song=is_song,
                confidence=conf,
            )
        )
    return entries


def pick_best_timeline_comments(
    comments: Iterable[dict],
    *,
    limit: int = 3,
    min_score: float = 3.0,
) -> list[dict]:
    scored: list[tuple[float, dict]] = []
    for c in comments:
        text = c.get("comment") or c.get("memo") or ""
        if not looks_like_timeline(text):
            continue
        score = timeline_score(text)
        try:
            likes = int(c.get("like_cnt") or 0)
        except (TypeError, ValueError):
            likes = 0
        if c.get("is_best") in (True, "1", 1):
            score += 2.0
        score += min(likes, 100) / 50.0
        if score >= min_score:
            scored.append((score, c))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [c for _, c in scored[:limit]]
