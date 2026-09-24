from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime
from typing import Any


DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; soop-setlist/0.1; +https://github.com/legun078/local-music)"
    ),
    "Accept": "application/json, text/plain, */*",
}


class SoopClient:
    """숲(SOOP) 공개 엔드포인트 래퍼. 공식 OAuth 없이 동작하는 채널/댓글 API."""

    def __init__(
        self,
        *,
        chapi_origin: str = "https://chapi.sooplive.co.kr",
        api_m_origin: str = "https://api.m.sooplive.co.kr",
        stbbs_origin: str = "https://stbbs.sooplive.com",
        sch_origin: str = "https://sch.sooplive.co.kr",
        vod_origin: str = "https://vod.sooplive.co.kr",
        request_pause_sec: float = 0.25,
        timeout_sec: float = 30.0,
    ) -> None:
        self.chapi_origin = chapi_origin.rstrip("/")
        self.api_m_origin = api_m_origin.rstrip("/")
        self.stbbs_origin = stbbs_origin.rstrip("/")
        self.sch_origin = sch_origin.rstrip("/")
        self.vod_origin = vod_origin.rstrip("/")
        self.request_pause_sec = request_pause_sec
        self.timeout_sec = timeout_sec

    def _request(
        self,
        url: str,
        *,
        method: str = "GET",
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        hdrs = {**DEFAULT_HEADERS, **(headers or {})}
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_sec) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {e.code} for {url}: {body[:300]}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"Network error for {url}: {e}") from e
        finally:
            if self.request_pause_sec:
                time.sleep(self.request_pause_sec)

        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as e:
            raise RuntimeError(f"Invalid JSON from {url}: {raw[:200]!r}") from e

    def search_bj(self, keyword: str) -> list[dict[str, Any]]:
        qs = urllib.parse.urlencode(
            {"m": "bjSearch", "v": "3.0", "szOrder": "score", "szKeyword": keyword}
        )
        data = self._request(f"{self.sch_origin}/api.php?{qs}")
        return list((data or {}).get("DATA") or [])

    def resolve_bj_id(self, nickname_or_id: str) -> str:
        """닉네임이면 검색해 user_id로 바꾸고, 이미 id면 그대로 반환."""
        hits = self.search_bj(nickname_or_id)
        if not hits:
            return nickname_or_id
        for h in hits:
            if str(h.get("user_id", "")).lower() == nickname_or_id.lower():
                return str(h["user_id"])
            if str(h.get("user_nick", "")) == nickname_or_id:
                return str(h["user_id"])
        return str(hits[0].get("user_id") or nickname_or_id)

    @staticmethod
    def _ymd(d: date | datetime | str) -> str:
        if isinstance(d, datetime):
            return d.date().strftime("%Y%m%d")
        if isinstance(d, date):
            return d.strftime("%Y%m%d")
        s = str(d).strip().replace("-", "")
        if len(s) != 8 or not s.isdigit():
            raise ValueError(f"날짜는 YYYY-MM-DD 또는 YYYYMMDD: {d!r}")
        return s

    def list_vods(
        self,
        bj_id: str,
        start_date: date | datetime | str,
        end_date: date | datetime | str,
        *,
        keyword: str = "",
        per_page: int = 60,
        max_pages: int = 50,
    ) -> list[dict[str, Any]]:
        start = self._ymd(start_date)
        end = self._ymd(end_date)
        items: list[dict[str, Any]] = []
        page = 1
        while page <= max_pages:
            params = {
                "page": page,
                "per_page": per_page,
                "orderby": "reg_date",
                "field": "title,contents,user_nick,user_id",
                "start_date": start,
                "end_date": end,
                "keyword": keyword,
            }
            qs = urllib.parse.urlencode(params)
            url = f"{self.chapi_origin}/api/{urllib.parse.quote(bj_id)}/vods/review?{qs}"
            payload = self._request(
                url,
                headers={"Referer": "https://www.sooplive.co.kr/", "Origin": "https://www.sooplive.co.kr"},
            )
            batch = list((payload or {}).get("data") or [])
            items.extend(batch)
            meta = (payload or {}).get("meta") or {}
            last_page = int(meta.get("last_page") or page)
            if page >= last_page or not batch:
                break
            page += 1
        return items

    def get_vod_info(self, title_no: int | str) -> dict[str, Any]:
        tn = str(title_no)
        body = urllib.parse.urlencode(
            {"nTitleNo": tn, "nApiLevel": "11", "nPlaylistIdx": "0"}
        ).encode()
        payload = self._request(
            f"{self.api_m_origin}/station/video/a/view",
            method="POST",
            data=body,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": f"{self.vod_origin}/player/{tn}",
            },
        )
        if not payload or payload.get("result") != 1:
            msg = ((payload or {}).get("data") or {}).get("message") or payload
            raise RuntimeError(f"VOD 정보 조회 실패 ({tn}): {msg}")
        return payload["data"]

    def list_comments(
        self,
        title_no: int | str,
        *,
        vod_info: dict[str, Any] | None = None,
        max_pages: int = 100,
    ) -> list[dict[str, Any]]:
        tn = str(title_no)
        data = vod_info or self.get_vod_info(tn)
        station_no = data.get("station_no")
        bbs_no = data.get("bbs_no")
        bj_id = data.get("bj_id")
        board_type = data.get("board_type") or 105
        if station_no is None or bbs_no is None or not bj_id:
            raise RuntimeError(f"댓글 조회에 필요한 메타 부족: {tn}")

        all_comments: list[dict[str, Any]] = []
        page_no = 1
        last_no = 0
        for _ in range(max_pages):
            body = urllib.parse.urlencode(
                {
                    "nStationNo": station_no,
                    "nBbsNo": bbs_no,
                    "nTitleNo": tn,
                    "bj_id": bj_id,
                    "nPageNo": page_no,
                    "nOrderNo": 1,
                    "nBoardType": board_type,
                    "szAction": "get",
                    "nVod": 1,
                    "nLastNo": last_no,
                }
            ).encode()
            payload = self._request(
                f"{self.stbbs_origin}/api/bbs_memo_action.php",
                method="POST",
                data=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Referer": f"{self.vod_origin}/player/{tn}",
                    "Accept-Language": "ko",
                },
            )
            channel = (payload or {}).get("CHANNEL") or {}
            ok = channel.get("RESULT") in (1, True, "1") or channel.get("result") in (1, True, "1")
            if not ok:
                if page_no == 1:
                    raise RuntimeError(f"댓글 조회 실패: {tn} / {payload}")
                break
            lst = list((channel.get("DATA") or {}).get("list_data") or [])
            all_comments.extend(lst)
            if (channel.get("DATA") or {}).get("has_more") is not True or not lst:
                break
            try:
                next_last = int(lst[-1].get("p_comment_no"))
            except (TypeError, ValueError):
                break
            if next_last == last_no:
                break
            last_no = next_last
            page_no += 1
        return all_comments

    def vod_url(self, title_no: int | str) -> str:
        return f"{self.vod_origin}/player/{title_no}"
