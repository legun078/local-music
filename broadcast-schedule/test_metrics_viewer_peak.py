#!/usr/bin/env python3
"""시청자 분 버킷은 최고값을 남기고, 세션 피크를 시계열에 복구한다."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from credits_store import (  # noqa: E402
    apply_peak_viewers_to_series,
    normalize_metric_series,
    record_live_metrics,
    upsert_metric_point,
)


class ViewerPeakSeriesTests(unittest.TestCase):
    def test_upsert_keep_max_does_not_drop_peak(self) -> None:
        series: list[dict] = []
        self.assertTrue(
            upsert_metric_point(
                series, 2066, at="2026-08-13T13:40:20Z", keep_max=True
            )
        )
        self.assertFalse(
            upsert_metric_point(
                series, 952, at="2026-08-13T13:40:55Z", keep_max=True
            )
        )
        self.assertEqual(series[-1]["v"], 2066)
        self.assertEqual(series[-1]["at"], "2026-08-13T13:40:00Z")

    def test_record_live_metrics_keeps_minute_max(self) -> None:
        session = {"metricsSeries": {"viewers": [], "up": [], "balloons": [], "chats": []}}
        self.assertTrue(
            record_live_metrics(session, viewers=2066, at="2026-08-13T13:40:20Z")
        )
        self.assertFalse(
            record_live_metrics(session, viewers=952, at="2026-08-13T13:40:55Z")
        )
        self.assertEqual(session["metricsSeries"]["viewers"][-1]["v"], 2066)

    def test_normalize_keep_max_merges_duplicates(self) -> None:
        rows = [
            {"at": "2026-08-13T13:40:20Z", "v": 2066},
            {"at": "2026-08-13T13:40:55Z", "v": 952},
        ]
        last = normalize_metric_series(rows, keep_max=False)
        self.assertEqual(last[0]["v"], 952)
        kept = normalize_metric_series(rows, keep_max=True)
        self.assertEqual(kept[0]["v"], 2066)

    def test_apply_peak_restores_overwritten_minute(self) -> None:
        viewers = [
            {"at": "2026-08-13T13:39:00Z", "v": 1872},
            {"at": "2026-08-13T13:40:00Z", "v": 952},
            {"at": "2026-08-13T13:41:00Z", "v": 639},
        ]
        out = apply_peak_viewers_to_series(
            viewers,
            peak_viewers=2066,
            peak_viewers_at="2026-08-13T13:40:22Z",
        )
        by_at = {row["at"]: row["v"] for row in out}
        self.assertEqual(by_at["2026-08-13T13:40:00Z"], 2066)
        self.assertEqual(by_at["2026-08-13T13:41:00Z"], 639)


if __name__ == "__main__":
    unittest.main()
