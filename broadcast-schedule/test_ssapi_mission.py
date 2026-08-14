#!/usr/bin/env python3
"""SSAPI 미션 보조 — 제목/결과는 반영하고 후원 수량은 이중 집계하지 않는다."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from credits_store import (  # noqa: E402
    CreditsStore,
    _INGEST_DEDUP,
    apply_ssapi_donation,
    apply_ssapi_mission,
    serialize_donation_notes,
    serialize_mission_runs,
    serialize_ssapi_assist,
)
from ssapi_mission_collector import decode_ssapi_payload  # noqa: E402


class SsapiMissionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.store = CreditsStore(
            root / "credits-session.json",
            root / "credits.json",
            station_id="sirianrain",
            live_fetcher=None,
        )
        _INGEST_DEDUP.clear()
        self.store.apply_live_status(
            {
                "isLive": True,
                "stationId": "sirianrain",
                "title": "테스트",
                "viewerCount": 10,
                "broadNo": "ssapi-test",
            }
        )

    def _session(self) -> dict:
        return self.store.load_session()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_decode_plain_json(self) -> None:
        payload = {"mission_phase": "receive", "title": "히든미션", "key": "k1"}
        self.assertEqual(decode_ssapi_payload(payload), payload)
        self.assertEqual(decode_ssapi_payload(json.dumps(payload)), payload)
        self.assertEqual(decode_ssapi_payload(json.dumps(payload).encode()), payload)

    def test_receive_sets_title_without_donors(self) -> None:
        session = self._session()
        apply_ssapi_mission(
            session,
            {
                "mission_phase": "receive",
                "mission_type": "CHALLENGE_GIFT",
                "key": "m-1",
                "title": "히든미션",
                "user_id": "donor1",
                "nickname": "후원자",
                "cnt": 100,
            },
            ts="2026-08-13T12:00:00Z",
        )
        run = session["missionRuns"][0]
        self.assertEqual(run["title"], "히든미션")
        self.assertEqual(run["key"], "m-1")
        self.assertEqual(run["status"], "pending")
        self.assertEqual(run["total"], 0)
        self.assertEqual(run["donors"], {})
        self.assertTrue(run["fromSsapi"])
        assist = serialize_ssapi_assist(session)
        self.assertEqual(assist["missionCount"], 1)
        self.assertEqual(assist["missions"][0]["title"], "히든미션")
        self.assertEqual(assist["missions"][0]["phase"], "receive")

    def test_sdk_gift_merges_into_ssapi_run(self) -> None:
        session = self._session()
        apply_ssapi_mission(
            session,
            {
                "mission_phase": "receive",
                "mission_type": "CHALLENGE_GIFT",
                "key": "m-1",
                "title": "히든미션",
            },
            ts="2026-08-13T12:00:00Z",
        )
        self.store.save_session(session)
        self.store.ingest_events(
            [
                {
                    "action": "CHALLENGE_MISSION_GIFTED",
                    "at": "2026-08-13T12:00:05Z",
                    "message": {
                        "userId": "donor1",
                        "userNickname": "후원자",
                        "count": 100,
                    },
                }
            ],
            station_id="sirianrain",
            source="collector",
        )
        session = self.store.load_session()
        run = session["missionRuns"][0]
        self.assertEqual(run["title"], "히든미션")
        self.assertEqual(run["total"], 100)
        self.assertEqual(run["donors"]["donor1"]["total"], 100)

    def test_ssapi_gift_does_not_double_count(self) -> None:
        self.store.ingest_events(
            [
                {
                    "action": "CHALLENGE_MISSION_GIFTED",
                    "at": "2026-08-13T12:00:05Z",
                    "message": {
                        "userId": "donor1",
                        "userNickname": "후원자",
                        "count": 100,
                    },
                },
                {
                    "action": "SSAPI_MISSION",
                    "at": "2026-08-13T12:00:06Z",
                    "message": {
                        "mission_phase": "receive",
                        "mission_type": "CHALLENGE_GIFT",
                        "key": "m-1",
                        "title": "히든미션",
                        "user_id": "donor1",
                        "nickname": "후원자",
                        "cnt": 100,
                    },
                },
            ],
            station_id="sirianrain",
            source="ssapi",
            mark_sdk=False,
        )
        session = self.store.load_session()
        run = session["missionRuns"][0]
        self.assertEqual(run["title"], "히든미션")
        self.assertEqual(run["total"], 100)

    def test_result_sets_success(self) -> None:
        session = self._session()
        apply_ssapi_mission(
            session,
            {"mission_phase": "receive", "key": "m-1", "title": "히든미션"},
            ts="2026-08-13T12:00:00Z",
        )
        apply_ssapi_mission(
            session,
            {
                "mission_phase": "result",
                "key": "m-1",
                "title": "히든미션",
                "result": {"mission_status": "SUCCESS", "draw": False},
            },
            ts="2026-08-13T12:10:00Z",
        )
        run = session["missionRuns"][0]
        self.assertEqual(run["status"], "success")
        self.assertEqual(run["endedAt"], "2026-08-13T12:10:00Z")
        rows = serialize_mission_runs(session)
        self.assertEqual(rows[0]["statusLabel"], "성공")
        self.assertTrue(rows[0]["fromSsapi"])
        result_ev = [row for row in serialize_ssapi_assist(session)["missions"] if row["phase"] == "result"]
        self.assertEqual(result_ev[0]["status"], "success")
        self.assertEqual(result_ev[0]["statusLabel"], "성공")

    def test_settle_fills_missing_donors_only(self) -> None:
        session = self._session()
        apply_ssapi_mission(
            session,
            {"mission_phase": "receive", "key": "m-1", "title": "히든미션"},
            ts="2026-08-13T12:00:00Z",
        )
        self.store.save_session(session)
        self.store.ingest_events(
            [
                {
                    "action": "CHALLENGE_MISSION_GIFTED",
                    "at": "2026-08-13T12:00:05Z",
                    "message": {"userId": "donor1", "userNickname": "후원자", "count": 100},
                }
            ],
            station_id="sirianrain",
            source="collector",
        )
        session = self.store.load_session()
        apply_ssapi_mission(
            session,
            {
                "mission_phase": "settle",
                "key": "m-1",
                "settle": {
                    "donors": [
                        {"user_id": "donor1", "nickname": "후원자", "cnt": 100},
                        {"user_id": "donor2", "nickname": "늦은분", "cnt": 50},
                    ]
                },
            },
            ts="2026-08-13T12:11:00Z",
        )
        run = session["missionRuns"][0]
        self.assertEqual(run["donors"]["donor1"]["total"], 100)
        self.assertEqual(run["donors"]["donor2"]["total"], 50)
        self.assertEqual(run["total"], 150)

    def test_keys_keep_concurrent_missions_apart(self) -> None:
        session = self._session()
        apply_ssapi_mission(
            session,
            {"mission_phase": "receive", "key": "a", "title": "미션A"},
            ts="2026-08-13T12:00:00Z",
        )
        apply_ssapi_mission(
            session,
            {"mission_phase": "receive", "key": "b", "title": "미션B"},
            ts="2026-08-13T12:01:00Z",
        )
        apply_ssapi_mission(
            session,
            {
                "mission_phase": "result",
                "key": "b",
                "title": "미션B",
                "result": {"mission_status": "FAILURE"},
            },
            ts="2026-08-13T12:05:00Z",
        )
        runs = session["missionRuns"]
        self.assertEqual(len(runs), 2)
        by_key = {row["key"]: row for row in runs}
        self.assertEqual(by_key["a"]["status"], "pending")
        self.assertEqual(by_key["b"]["status"], "fail")

    def test_ssapi_donation_keeps_text_without_counting(self) -> None:
        self.store.ingest_events(
            [
                {
                    "action": "BALLOON_GIFTED",
                    "at": "2026-08-13T12:20:00Z",
                    "message": {
                        "userId": "donor1",
                        "userNickname": "후원자",
                        "count": 50,
                    },
                },
                {
                    "action": "SSAPI_DONATION",
                    "at": "2026-08-13T12:20:01Z",
                    "message": {
                        "_id": "ssapi-1",
                        "user_id": "donor1",
                        "nickname": "후원자",
                        "cnt": 50,
                        "message": "밤양갱 신청이요",
                    },
                },
            ],
            station_id="sirianrain",
            source="ssapi",
            mark_sdk=False,
        )
        session = self.store.load_session()
        self.assertEqual(session["donations"]["donor1"]["total"], 50)
        notes = serialize_donation_notes(session)
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["text"], "밤양갱 신청이요")
        self.assertEqual(notes[0]["name"], "후원자")
        self.assertTrue(notes[0]["fromSsapi"])
        assist = serialize_ssapi_assist(session)
        self.assertEqual(assist["donationCount"], 1)
        self.assertEqual(assist["donations"][0]["text"], "밤양갱 신청이요")

    def test_empty_donation_message_is_ignored(self) -> None:
        session = self._session()
        self.assertIsNone(
            apply_ssapi_donation(
                session,
                {"user_id": "donor1", "nickname": "후원자", "cnt": 10, "message": ""},
                ts="2026-08-13T12:21:00Z",
            )
        )
        self.assertEqual(serialize_donation_notes(session), [])

    def test_sdk_donation_text_is_kept_if_present(self) -> None:
        self.store.ingest_events(
            [
                {
                    "action": "BALLOON_GIFTED",
                    "at": "2026-08-13T12:22:00Z",
                    "message": {
                        "userId": "donor2",
                        "userNickname": "방셀러",
                        "count": 30,
                        "message": "방셀 스티커",
                    },
                }
            ],
            station_id="sirianrain",
            source="collector",
        )
        notes = serialize_donation_notes(self.store.load_session())
        self.assertEqual(notes[0]["text"], "방셀 스티커")


if __name__ == "__main__":
    unittest.main()
