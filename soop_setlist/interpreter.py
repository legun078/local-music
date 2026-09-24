from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any, Callable, Protocol

from .models import SongEntry
from .timeline import clean_comment_html, parse_timeline_heuristic, timestamp_to_seconds


INTERPRET_PROMPT = """당신은 숲(SOOP) VOD 다시보기 댓글에 팬이 남긴 '타임라인'을 해석합니다.
타임라인은 양식이 제각각입니다. 시간 표기, 구분선, 이모티콘, 섹션 제목, 오타가 섞여 있어도
방송에서 부른/재생된 노래만 골라 JSON으로 정리하세요.

규칙:
- 게임이슈, 밴픽, 디코 on/off, 방종, 잡담 구간은 is_song=false
- 노래방/노래자랑/커버/라디오/셋리스트 구간의 곡은 is_song=true
- "N. 아티스트 - 곡명", "곡명 - 아티스트", "곡명 (아티스트)", "닉네임이 부른 곡" 모두 인식
- performer는 부른 사람(참가자/BJ), artist는 원곡 아티스트
- timestamp_raw는 원문 그대로, timestamp_sec는 초 단위 정수(없으면 null)
- 확신도 confidence는 0~1
- 설명 문장 없이 JSON만 출력

출력 스키마:
{{"songs":[{{"timestamp_raw":"7:22:55","timestamp_sec":26575,"title":"와스레모노","artist":"다니엘모스","performer":null,"note":null,"is_song":true,"confidence":0.9}}]}}

타임라인 원문:
---
{timeline}
---
"""


class TimelineInterpreter(Protocol):
    def interpret(self, text: str) -> list[SongEntry]: ...


class HeuristicInterpreter:
    def interpret(self, text: str) -> list[SongEntry]:
        return parse_timeline_heuristic(text)


class OpenAICompatibleInterpreter:
    """OPENAI_API_KEY + OPENAI_BASE_URL(선택)로 비정형 타임라인을 해석."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        timeout_sec: float = 60.0,
    ) -> None:
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY") or os.environ.get("SOOP_SETLIST_LLM_KEY")
        self.base_url = (
            base_url
            or os.environ.get("OPENAI_BASE_URL")
            or os.environ.get("SOOP_SETLIST_LLM_BASE")
            or "https://api.openai.com/v1"
        ).rstrip("/")
        self.model = model or os.environ.get("SOOP_SETLIST_LLM_MODEL") or "gpt-4o-mini"
        self.timeout_sec = timeout_sec
        if not self.api_key:
            raise ValueError("LLM 해석에는 OPENAI_API_KEY(또는 SOOP_SETLIST_LLM_KEY)가 필요합니다.")

    def interpret(self, text: str) -> list[SongEntry]:
        cleaned = clean_comment_html(text)
        payload = {
            "model": self.model,
            "temperature": 0.1,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": "Extract song timelines from Korean streaming VOD fan comments. Reply with JSON only.",
                },
                {"role": "user", "content": INTERPRET_PROMPT.format(timeline=cleaned)},
            ],
        }
        req = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_sec) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"LLM HTTP {e.code}: {e.read()[:300]!r}") from e

        content = data["choices"][0]["message"]["content"]
        return songs_from_llm_json(content)


def songs_from_llm_json(content: str) -> list[SongEntry]:
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*", "", content)
        content = re.sub(r"\s*```$", "", content)
    parsed = json.loads(content)
    rows = parsed.get("songs") if isinstance(parsed, dict) else parsed
    out: list[SongEntry] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        ts_raw = row.get("timestamp_raw")
        ts_sec = row.get("timestamp_sec")
        if ts_sec is None and ts_raw:
            ts_sec = timestamp_to_seconds(str(ts_raw))
        title = str(row.get("title") or "").strip()
        if not title:
            continue
        out.append(
            SongEntry(
                timestamp_sec=int(ts_sec) if ts_sec is not None else None,
                timestamp_raw=str(ts_raw) if ts_raw is not None else None,
                title=title,
                artist=(str(row["artist"]) if row.get("artist") else None),
                performer=(str(row["performer"]) if row.get("performer") else None),
                note=(str(row["note"]) if row.get("note") else None),
                is_song=bool(row.get("is_song", True)),
                confidence=float(row.get("confidence") or 0.7),
            )
        )
    return out


class AutoInterpreter:
    """휴리스틱으로 충분히 뽑히면 그대로, 아니면 LLM(가능 시)로 재해석."""

    def __init__(
        self,
        *,
        llm: TimelineInterpreter | None = None,
        min_songs: int = 1,
        prefer_llm: bool = False,
    ) -> None:
        self.heuristic = HeuristicInterpreter()
        self.llm = llm
        self.min_songs = min_songs
        self.prefer_llm = prefer_llm

    def interpret(self, text: str) -> list[SongEntry]:
        if self.prefer_llm and self.llm is not None:
            try:
                return self.llm.interpret(text)
            except Exception:
                return self.heuristic.interpret(text)

        songs = self.heuristic.interpret(text)
        song_hits = [s for s in songs if s.is_song]
        if len(song_hits) >= self.min_songs:
            return songs
        if self.llm is None:
            return songs
        try:
            return self.llm.interpret(text)
        except Exception:
            return songs


def build_interpreter(mode: str = "auto") -> TimelineInterpreter:
    mode = (mode or "auto").lower()
    if mode == "heuristic":
        return HeuristicInterpreter()
    if mode == "llm":
        return OpenAICompatibleInterpreter()
    if mode == "auto":
        llm = None
        try:
            llm = OpenAICompatibleInterpreter()
        except ValueError:
            llm = None
        return AutoInterpreter(llm=llm)
    raise ValueError(f"unknown interpret mode: {mode}")


# 커스텀 콜백형 (에이전트/외부 LLM에 넘길 때)
CallbackInterpreter = Callable[[str], list[SongEntry] | list[dict[str, Any]]]


class FunctionInterpreter:
    def __init__(self, fn: CallbackInterpreter) -> None:
        self.fn = fn

    def interpret(self, text: str) -> list[SongEntry]:
        result = self.fn(text)
        if result and isinstance(result[0], SongEntry):
            return list(result)  # type: ignore[arg-type]
        return songs_from_llm_json(json.dumps({"songs": result}, ensure_ascii=False))
