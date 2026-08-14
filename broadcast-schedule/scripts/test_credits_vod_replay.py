#!/usr/bin/env python3
"""credits_vod_replay — VOD change_second 보정 테스트."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from credits_store import KST
from credits_vod_replay import compute_vod_replay_alignment, raw_event_bounds


class VodReplayAlignmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.raw_dir = Path(self.tmp.name) / "credits-raw"
        self.raw_dir.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def _write_raw(self, session: dict, rows: list[dict]):
        day = "2026-08-14"
        stem = "110029_sirianrain"
        day_dir = self.raw_dir / day
        day_dir.mkdir(parents=True, exist_ok=True)
        path = day_dir / f"{stem}.jsonl"
        with path.open("w", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")

    def test_offset_uses_first_event_before_collector_attach(self):
        session = {
            "active": False,
            "startedAt": "2026-08-14T02:00:29Z",
            "endedAt": "2026-08-14T03:35:41Z",
            "stationId": "sirianrain",
            "broadNo": "296344193",
        }
        self._write_raw(
            session,
            [
                {
                    "kind": "event",
                    "status": "accepted",
                    "action": "IN",
                    "at": "2026-08-14T02:00:01.719Z",
                },
                {
                    "kind": "event",
                    "status": "accepted",
                    "action": "MESSAGE",
                    "at": "2026-08-14T03:34:08.238Z",
                },
            ],
        )
        vod_item = {
            "title_no": 204267443,
            "reg_date": "2026-08-14 12:34:39",
            "ucc": {"total_file_duration": 5647434},
        }
        out = compute_vod_replay_alignment(session, vod_item, raw_dir=self.raw_dir)
        self.assertEqual(out["method"], "vod_reg_end_first_event")
        self.assertEqual(out["replayOffsetSec"], 27)
        first, last = raw_event_bounds(session, self.raw_dir)
        self.assertIsNotNone(first)
        self.assertIsNotNone(last)

    def test_active_session_has_no_offset(self):
        session = {
            "active": True,
            "startedAt": "2026-08-14T02:00:29Z",
            "endedAt": "",
        }
        out = compute_vod_replay_alignment(session, {"ucc": {"total_file_duration": 1000}}, raw_dir=self.raw_dir)
        self.assertEqual(out["replayOffsetSec"], 0)
        self.assertEqual(out["method"], "none")


if __name__ == "__main__":
    unittest.main()
