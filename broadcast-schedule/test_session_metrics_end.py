#!/usr/bin/env python3
"""session_metrics_end_at — 잘못된 updatedAt으로 차트가 늘어나는 문제."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from credits_store import (  # noqa: E402
    align_viewer_chat_metrics,
    format_duration,
    session_metrics_end_at,
)


class SessionMetricsEndAtTests(unittest.TestCase):
    def test_ignores_next_day_updated_at(self) -> None:
        session = {
            "startedAt": "2026-08-13T09:04:39Z",
            "endedAt": None,
            "updatedAt": "2026-08-14T02:00:28Z",
            "metricsSeries": {
                "viewers": [
                    {"at": "2026-08-13T09:04:00Z", "v": 57},
                    {"at": "2026-08-13T14:29:00Z", "v": 151},
                ],
                "chats": [{"at": "2026-08-13T13:39:00Z", "v": 273}],
            },
        }
        end_at = session_metrics_end_at(session)
        self.assertEqual(end_at, "2026-08-13T14:29:00Z")
        duration = format_duration(session["startedAt"], end_at)
        self.assertIn("5시간", duration)

    def test_align_grid_uses_inferred_end(self) -> None:
        session = {
            "startedAt": "2026-08-13T09:04:39Z",
            "updatedAt": "2026-08-14T02:00:28Z",
            "metricsSeries": {
                "viewers": [
                    {"at": "2026-08-13T09:04:00Z", "v": 100},
                    {"at": "2026-08-13T10:04:00Z", "v": 200},
                ],
                "chats": [],
            },
        }
        viewers, chats = align_viewer_chat_metrics(
            session["metricsSeries"]["viewers"],
            [],
            started_at=session["startedAt"],
            end_at=session_metrics_end_at(session),
        )
        self.assertEqual(len(viewers), 61)
        self.assertEqual(viewers[-1]["at"], "2026-08-13T10:04:00Z")


if __name__ == "__main__":
    unittest.main()
