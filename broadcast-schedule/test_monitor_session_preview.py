"""모니터용 세션 보강 — 방송 초반 raw·복구 세션 병합."""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from credits_store import (
    CreditsStore,
    enrich_session_for_monitor_preview,
    merge_prior_session_into,
    session_monitor_effective_start,
    build_chat_metrics_series_from_broadcast_raw,
    raw_jsonl_paths_for_broadcast,
)


class MonitorSessionPreviewTests(unittest.TestCase):
    def test_effective_start_uses_earliest_raw_event(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw_dir = Path(tmp)
            day = "2026-08-22"
            (raw_dir / day).mkdir(parents=True)
            path = raw_dir / day / "120000_sirianrain.jsonl"
            path.write_text(
                json.dumps(
                    {
                        "kind": "batch",
                        "stationId": "sirianrain",
                        "broadNo": "12345",
                    },
                    ensure_ascii=False,
                )
                + "\n"
                + json.dumps(
                    {
                        "kind": "event",
                        "status": "accepted",
                        "action": "CHAT",
                        "at": "2026-08-22T03:00:00Z",
                        "stationId": "sirianrain",
                        "broadNo": "12345",
                    },
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )
            session = {
                "stationId": "sirianrain",
                "broadNo": "12345",
                "active": True,
                "startedAt": "2026-08-22T04:00:00Z",
            }
            got = session_monitor_effective_start(session, raw_dir=raw_dir)
            self.assertEqual(got, "2026-08-22T03:00:00Z")

    def test_broadcast_raw_paths_merge_same_broad(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw_dir = Path(tmp)
            day = "2026-08-22"
            (raw_dir / day).mkdir(parents=True)
            for stem in ("120000_sirianrain", "130000_sirianrain"):
                path = raw_dir / day / f"{stem}.jsonl"
                path.write_text(
                    json.dumps(
                        {
                            "kind": "batch",
                            "stationId": "sirianrain",
                            "broadNo": "999",
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                    + json.dumps(
                        {
                            "kind": "event",
                            "status": "accepted",
                            "action": "CHAT",
                            "at": f"2026-08-22T{stem[:2]}:{stem[2:4]}:00Z",
                            "stationId": "sirianrain",
                            "broadNo": "999",
                        },
                        ensure_ascii=False,
                    )
                    + "\n",
                    encoding="utf-8",
                )
            session = {
                "stationId": "sirianrain",
                "broadNo": "999",
                "active": True,
                "startedAt": "2026-08-22T13:00:00Z",
            }
            paths = raw_jsonl_paths_for_broadcast(session, raw_dir)
            self.assertEqual(len(paths), 2)
            series = build_chat_metrics_series_from_broadcast_raw(session, raw_dir=raw_dir)
            self.assertEqual(len(series), 2)

    def test_merge_prior_preserves_earlier_start(self) -> None:
        cur = {
            "stationId": "sirianrain",
            "broadNo": "1",
            "startedAt": "2026-08-22T05:00:00Z",
            "chatters": {"u1": {"name": "A", "count": 2}},
            "metricsSeries": {"viewers": [], "up": [], "balloons": [], "chats": []},
        }
        prior = {
            "stationId": "sirianrain",
            "broadNo": "1",
            "startedAt": "2026-08-22T03:00:00Z",
            "chatters": {"u2": {"name": "B", "count": 5}},
            "metricsSeries": {"viewers": [], "up": [], "balloons": [], "chats": []},
        }
        merged = merge_prior_session_into(dict(cur), prior)
        self.assertEqual(merged["startedAt"], "2026-08-22T03:00:00Z")
        self.assertIn("u1", merged["chatters"])
        self.assertIn("u2", merged["chatters"])


if __name__ == "__main__":
    unittest.main()
