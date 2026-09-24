from __future__ import annotations

import unittest

from soop_setlist.timeline import (
    clean_comment_html,
    looks_like_timeline,
    parse_timeline_heuristic,
    timestamp_to_seconds,
)


SAMPLE_VAUNDY = """
- LCK -<br />
<br />
15:24 T1 vs HLE<br />
22:37 1세트 밴픽<br />
<br />
- VAUNDY 노래자랑 대회 -<br />
<br />
7:03:12 디코 on<br />
7:14:37 VAUNDY 노래자랑 대회<br />
7:22:55 1. 다니엘모스 - 와스레모노<br />
7:31:02 2. 테미 - 주마등<br />
7:41:34 3. 쮸 - 주름 맞추기<br />
8:17:14 7. 김메이 - napori<br />
10:10:55 3등<br />
10:17:24 빠른 방종 (으앙~~)<br />
"""

SAMPLE_LOOSE = """
타임라인
00:10 오프닝
01:22:10 밤양갱
01:30:00 워너원 - 고민중독
02:00:00 방종
"""


class TimelineParseTests(unittest.TestCase):
    def test_clean_html(self):
        t = clean_comment_html("안녕<br />/하트구/세계")
        self.assertEqual(t, "안녕\n세계")

    def test_timestamp(self):
        self.assertEqual(timestamp_to_seconds("7:22:55"), 7 * 3600 + 22 * 60 + 55)
        self.assertEqual(timestamp_to_seconds("15:24"), 15 * 60 + 24)

    def test_looks_like_timeline(self):
        self.assertTrue(looks_like_timeline(SAMPLE_VAUNDY))
        self.assertFalse(looks_like_timeline("오늘 방송 재밌었어요"))

    def test_vaundy_songs(self):
        songs = [s for s in parse_timeline_heuristic(SAMPLE_VAUNDY) if s.is_song]
        titles = [s.title for s in songs]
        self.assertIn("와스레모노", titles)
        self.assertIn("주마등", titles)
        self.assertIn("napori", titles)
        by_title = {s.title: s for s in songs}
        self.assertEqual(by_title["와스레모노"].performer, "다니엘모스")
        # 비노래
        non = [s for s in parse_timeline_heuristic(SAMPLE_VAUNDY) if not s.is_song]
        non_titles = " ".join(s.title for s in non)
        self.assertIn("밴픽", non_titles)
        self.assertIn("디코", non_titles)

    def test_loose_format(self):
        songs = [s for s in parse_timeline_heuristic(SAMPLE_LOOSE) if s.is_song]
        titles = [s.title for s in songs]
        self.assertIn("밤양갱", titles)
        self.assertTrue(any(s.title == "고민중독" and s.artist == "워너원" for s in songs))


if __name__ == "__main__":
    unittest.main()
