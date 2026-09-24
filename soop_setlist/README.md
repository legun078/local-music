# soop-setlist

숲(SOOP) 방송인의 **다시보기(VOD) 댓글에 팬이 남긴 타임라인**을 모아, 요청한 기간의 방송·노래 리스트를 정리합니다.

타임라인은 BJ/팬마다 형식이 달라서, 규칙 기반 파서 + (선택) LLM 해석을 같이 씁니다.

## 빠른 사용

```bash
# 저장소 루트에서
python -m soop_setlist.cli gosegu2 2026-09-12 2026-09-13 --keyword 노래 --interpret heuristic

# JSON
python -m soop_setlist.cli gosegu2 2026-09-12 2026-09-13 --keyword 노래 -f json -o out.json
```

Python API:

```python
from soop_setlist import collect_broadcast_setlists, interpret_timeline_text

report = collect_broadcast_setlists(
    "gosegu2",
    "2026-09-12",
    "2026-09-13",
    title_keyword="노래",
    interpret="heuristic",  # 또는 auto / llm
)
print(report.to_markdown())

# 댓글 원문만 있을 때
songs = interpret_timeline_text(comment_text, mode="auto")
```

## 해석 모드

| 모드 | 설명 |
|------|------|
| `heuristic` | 정규식·섹션 휴리스틱. API 키 불필요. |
| `llm` | OpenAI 호환 Chat Completions로 **매번** 자유 형식 해석. `OPENAI_API_KEY` 필요. |
| `auto` | 휴리스틱으로 곡이 안 잡히면 LLM 시도. |

LLM 환경변수:

- `OPENAI_API_KEY` 또는 `SOOP_SETLIST_LLM_KEY`
- `OPENAI_BASE_URL` / `SOOP_SETLIST_LLM_BASE` (기본 `https://api.openai.com/v1`)
- `SOOP_SETLIST_LLM_MODEL` (기본 `gpt-4o-mini`)

커스텀 해석(에이전트에게 맡기기):

```python
from soop_setlist.interpreter import FunctionInterpreter
from soop_setlist.service import collect_broadcast_setlists

def my_ai(text: str):
    # 여기서 모델을 호출해 [{"title","artist","timestamp_raw","is_song",...}, ...] 반환
    ...

report = collect_broadcast_setlists(
    "bj_id", "2026-01-01", "2026-01-31",
    interpreter=FunctionInterpreter(my_ai),
)
```

## 동작 개요

1. `chapi`로 기간 내 review VOD 목록 조회  
2. 각 VOD의 `stbbs` 댓글 수집  
3. 타임스탬프가 많은 댓글을 타임라인 후보로 선택  
4. 해석기로 곡 목록 추출  

공식 OAuth 앱이 아니라 웹에서 쓰는 공개 엔드포인트를 사용합니다. 과도한 요청은 자제하세요.

## 테스트

```bash
python -m unittest soop_setlist.tests.test_timeline -v
```
