"""모니터용 세션 보강 — 방송 초반 raw·복구 세션 병합."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from credits_store import (
    build_chat_metrics_series_from_broadcast_raw,
    chatters_from_broadcast_raw,
    merge_prior_session_into,
    raw_jsonl_paths_for_broadcast,
    session_monitor_effective_start,
)


class MonitorSessionPreviewTests(unittest.TestCase):
    def _write_raw(self, path: Path, broad: str, events: list[tuple[str, str]]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = [
            json.dumps(
                {"kind": "batch", "stationId": "sirianrain", "broadNo": broad},
                ensure_ascii=False,
            )
        ]
        for at, uid in events:
            lines.append(
                json.dumps(
                    {
                        "kind": "event",
                        "status": "accepted",
                        "action": "CHAT",
                        "at": at,
                        "stationId": "sirianrain",
                        "broadNo": broad,
                        "message": {"userId": uid, "userNickname": uid},
                    },
                    ensure_ascii=False,
                )
            )
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def test_effective_start_uses_earliest_raw_event(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw_dir = Path(tmp)
            path = raw_dir / "2026-08-22" / "130024_sirianrain.jsonl"
            self._write_raw(path, "999", [("2026-08-22T04:00:00Z", "u1")])
            session = {
                "stationId": "sirianrain",
                "broadNo": "999",
                "active": True,
                "startedAt": "2026-08-22T05:00:00Z",
            }
            got = session_monitor_effective_start(session, raw_dir=raw_dir)
            self.assertEqual(got, "2026-08-22T04:00:00Z")

    def test_broadcast_raw_paths_include_orphan_and_splits(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw_dir = Path(tmp)
            day_dir = raw_dir / "2026-08-22"
            self._write_raw(day_dir / "130024_sirianrain.jsonl", "999", [])
            self._write_raw(day_dir / "130412_sirianrain.jsonl", "999", [])
            day_dir.joinpath("orphan_sirianrain.jsonl").write_text(
                json.dumps(
                    {
                        "kind": "event",
                        "status": "accepted",
                        "action": "CHAT",
                        "at": "2026-08-22T03:59:00Z",
                        "stationId": "sirianrain",
                        "broadNo": "999",
                        "message": {"userId": "orphan", "userNickname": "orphan"},
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
                "startedAt": "2026-08-22T04:04:12Z",
            }
            names = {p.name for p in raw_jsonl_paths_for_broadcast(session, raw_dir)}
            self.assertIn("130024_sirianrain.jsonl", names)
            self.assertIn("130412_sirianrain.jsonl", names)
            self.assertIn("orphan_sirianrain.jsonl", names)

    def test_chatters_from_broadcast_raw_merges_split_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raw_dir = Path(tmp)
            day = "2026-08-22"
            self._write_raw(
                raw_dir / day / "130024_sirianrain.jsonl",
                "999",
                [("2026-08-22T04:00:00Z", "a"), ("2026-08-22T04:01:00Z", "a")],
            )
            self._write_raw(
                raw_dir / day / "130412_sirianrain.jsonl",
                "999",
                [("2026-08-22T04:05:00Z", "b"), ("2026-08-22T04:06:00Z", "b"), ("2026-08-22T04:07:00Z", "b")],
            )
            session = {
                "stationId": "sirianrain",
                "broadNo": "999",
                "active": True,
                "startedAt": "2026-08-22T04:04:12Z",
            }
            chatters = chatters_from_broadcast_raw(session, raw_dir=raw_dir)
            self.assertEqual(chatters["a"]["count"], 2)
            self.assertEqual(chatters["b"]["count"], 3)
            series = build_chat_metrics_series_from_broadcast_raw(session, raw_dir=raw_dir)
            self.assertGreaterEqual(len(series), 2)

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
            "startedAt": "2026-08-22T04:00:00Z",
            "chatters": {"u2": {"name": "B", "count": 5}},
            "metricsSeries": {"viewers": [], "up": [], "balloons": [], "chats": []},
        }
        merged = merge_prior_session_into(dict(cur), prior)
        self.assertEqual(merged["startedAt"], "2026-08-22T04:00:00Z")
        self.assertIn("u1", merged["chatters"])
        self.assertIn("u2", merged["chatters"])


if __name__ == "__main__":
    unittest.main()
