from __future__ import annotations

import argparse
import json
import sys

from .client import SoopClient
from .service import collect_broadcast_setlists


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="숲(SOOP) VOD 팬 타임라인에서 기간별 노래 리스트를 정리합니다."
    )
    p.add_argument("bj", help="BJ user_id 또는 닉네임")
    p.add_argument("start", help="시작일 YYYY-MM-DD")
    p.add_argument("end", help="종료일 YYYY-MM-DD")
    p.add_argument(
        "--interpret",
        choices=("auto", "heuristic", "llm"),
        default="auto",
        help="타임라인 해석 방식 (기본 auto)",
    )
    p.add_argument("--keyword", default="", help="VOD 제목 검색 키워드 (예: 노래)")
    p.add_argument("--only-songs", action="store_true", help="곡이 잡힌 방송만 출력")
    p.add_argument("--format", choices=("md", "json"), default="md")
    p.add_argument("-o", "--output", help="저장 경로 (없으면 stdout)")
    args = p.parse_args(argv)

    client = SoopClient()
    report = collect_broadcast_setlists(
        args.bj,
        args.start,
        args.end,
        client=client,
        interpret=args.interpret,
        title_keyword=args.keyword,
        only_with_songs=args.only_songs,
    )
    text = report.to_markdown() if args.format == "md" else json.dumps(report.to_dict(), ensure_ascii=False, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(text)
            if not text.endswith("\n"):
                f.write("\n")
    else:
        sys.stdout.write(text if text.endswith("\n") else text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
