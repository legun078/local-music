#!/usr/bin/env python3
"""SSAPI 미션 보조 수집기.

공식 Chat SDK가 채팅·후원·병풍을 집계하고, 이 프로세스는 미션 제목·key·결과와
별풍 메시지만 localhost ingest 로 보강한다. 후원 수량은 더하지 않는다.

필요: .env 의 SSAPI_API_KEY (https://ssapi.kr 대시보드)
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SOCKET_URL = "https://socket.ssapi.kr"
REST_URL = "https://api.ssapi.kr"
STATION_ID = "sirianrain"
INGEST_URL = "http://127.0.0.1:8017/api/credits/ingest"
STATUS_PATH = ROOT / "data" / "credits-ssapi-status.json"
PING_SEC = 60
RECONNECT_SEC = 5


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _log(msg: str) -> None:
    print(f"[ssapi-mission] {msg}", flush=True)


def _load_env_file() -> None:
    env_path = ROOT / ".env"
    if not env_path.is_file():
        return
    for raw in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        os.environ[key] = value.strip().strip("'").strip('"')


def _apply_runtime_config() -> None:
    global SOCKET_URL, REST_URL, STATION_ID, INGEST_URL, STATUS_PATH
    SOCKET_URL = os.environ.get("SSAPI_SOCKET_URL", SOCKET_URL).strip() or SOCKET_URL
    REST_URL = (os.environ.get("SSAPI_REST_URL", REST_URL).strip() or REST_URL).rstrip("/")
    STATION_ID = (
        os.environ.get("SSAPI_STATION_ID")
        or os.environ.get("CREDITS_SOOP_STATION_ID")
        or STATION_ID
    ).strip().lower()
    INGEST_URL = (
        os.environ.get("SSAPI_INGEST_URL", INGEST_URL).strip() or INGEST_URL
    )
    status = os.environ.get("SSAPI_STATUS_PATH", "").strip()
    STATUS_PATH = Path(status) if status else (ROOT / "data" / "credits-ssapi-status.json")


def decode_ssapi_payload(data: Any) -> dict[str, Any] | None:
    if isinstance(data, dict):
        return data
    raw: bytes
    if isinstance(data, str):
        text = data.strip()
        if text.startswith("{") or text.startswith("["):
            parsed = json.loads(text)
            return parsed if isinstance(parsed, dict) else None
        raw = data.encode("latin-1")
    elif isinstance(data, (bytes, bytearray, memoryview)):
        raw = bytes(data)
    else:
        return None
    if raw[:1] in (b"{", b"["):
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    for loader in (_snappy_decompress, _cramjam_decompress):
        try:
            out = loader(raw)
            parsed = json.loads(out)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            continue
    return None


def _snappy_decompress(raw: bytes) -> bytes:
    import snappy

    out = snappy.decompress(raw)
    return out if isinstance(out, bytes) else bytes(out)


def _cramjam_decompress(raw: bytes) -> bytes:
    import cramjam

    return bytes(cramjam.snappy.decompress_raw(raw))


def write_status(**fields: Any) -> None:
    payload = {"updatedAt": _utc_now(), "stationId": STATION_ID, **fields}
    STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATUS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STATUS_PATH)


def _api_key() -> str:
    return str(os.environ.get("SSAPI_API_KEY") or "").strip()


def ensure_streamer(api_key: str) -> None:
    body = json.dumps({"streamerId": STATION_ID, "platform": "soop"}).encode("utf-8")
    req = urllib.request.Request(
        f"{REST_URL}/room/streamer",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            _log(f"streamer register {resp.status}")
            return
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:200]
        except Exception:
            detail = str(exc)
        if int(getattr(exc, "code", 0) or 0) in {400, 409}:
            _log(f"streamer already registered ({exc.code})")
            return
        if int(getattr(exc, "code", 0) or 0) in {400, 404, 422}:
            alt = json.dumps({"streamerId": STATION_ID, "platform": "afreeca"}).encode("utf-8")
            req2 = urllib.request.Request(
                f"{REST_URL}/room/streamer",
                data=alt,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(req2, timeout=15) as resp:
                    _log(f"streamer register afreeca {resp.status}")
                    return
            except Exception as alt_exc:
                _log(f"streamer register fallback FAIL {alt_exc}")
        _log(f"streamer register FAIL {exc.code} {detail}")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        _log(f"streamer register FAIL {exc}")


def _wanted_streamer(payload: dict[str, Any]) -> bool:
    sid = str(payload.get("streamer_id") or payload.get("streamerId") or "").strip().lower()
    platform = str(payload.get("platform") or "soop").strip().lower()
    if sid and sid != STATION_ID:
        return False
    if platform and platform not in {"soop", "afreeca", "afreecatv"}:
        return False
    return True


def ingest_event(action: str, payload: dict[str, Any]) -> bool:
    body = json.dumps(
        {
            "stationId": STATION_ID,
            "source": "ssapi",
            "events": [
                {
                    "action": action,
                    "at": _utc_now(),
                    "message": payload,
                }
            ],
        }
    ).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    secret = str(os.environ.get("CREDITS_INGEST_SECRET") or "").strip()
    if secret:
        headers["X-Credits-Ingest-Secret"] = secret
    req = urllib.request.Request(INGEST_URL, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = json.loads(resp.read().decode("utf-8", "replace"))
    except Exception as exc:
        _log(f"ingest FAIL {action} {exc}")
        write_status(connected=True, lastError=str(exc)[:200], lastAction=action)
        return False
    accepted = int((raw or {}).get("accepted") or 0)
    label = str(payload.get("title") or payload.get("message") or "")[:40]
    _log(f"ingest {action} {label!r} accepted={accepted}")
    write_status(
        connected=True,
        lastError="",
        lastAction=action,
        lastPhase=payload.get("mission_phase"),
        lastKey=payload.get("key"),
        lastTitle=label,
        lastIngestAt=_utc_now(),
        accepted=accepted,
    )
    return True


def run_socket(api_key: str) -> None:
    import socketio

    sio = socketio.Client(reconnection=True, reconnection_delay=RECONNECT_SEC)

    @sio.event
    def connect() -> None:
        _log("socket connected")
        sio.emit("login", api_key)
        sio.emit("setReceiver", "mission,donation")
        write_status(connected=True, lastError="")

    @sio.on("login")
    def on_login(data: Any) -> None:
        payload = decode_ssapi_payload(data) or (data if isinstance(data, dict) else {})
        err = payload.get("error") if isinstance(payload, dict) else None
        _log(f"login error={err}")
        if err not in (None, 0, "0"):
            write_status(connected=False, lastError=f"login {err}")

    @sio.event
    def mission(compressed: Any) -> None:
        payload = decode_ssapi_payload(compressed)
        if not payload:
            _log("mission decode FAIL")
            return
        if not _wanted_streamer(payload):
            return
        ingest_event("SSAPI_MISSION", payload)

    @sio.event
    def donation(compressed: Any) -> None:
        payload = decode_ssapi_payload(compressed)
        if not payload:
            _log("donation decode FAIL")
            return
        if not _wanted_streamer(payload):
            return
        if not str(payload.get("message") or payload.get("comment") or payload.get("text") or "").strip():
            return
        ingest_event("SSAPI_DONATION", payload)

    @sio.event
    def disconnect() -> None:
        _log("socket disconnected")
        write_status(connected=False, lastError="disconnected")

    def ping_loop() -> None:
        while True:
            time.sleep(PING_SEC)
            try:
                if sio.connected:
                    sio.emit("ping")
            except Exception as exc:
                _log(f"ping FAIL {exc}")

    threading.Thread(target=ping_loop, name="ssapi-ping", daemon=True).start()
    write_status(connected=False, lastError="connecting")
    sio.connect(SOCKET_URL, transports=["websocket"], wait_timeout=8)
    sio.wait()


def main() -> int:
    _load_env_file()
    _apply_runtime_config()
    api_key = _api_key()
    if not api_key:
        _log("SSAPI_API_KEY 없음 — 보조 수집기를 건너뜁니다")
        write_status(connected=False, lastError="missing_api_key")
        return 0
    ensure_streamer(api_key)
    while True:
        try:
            run_socket(api_key)
        except KeyboardInterrupt:
            write_status(connected=False, lastError="stopped")
            return 0
        except Exception as exc:
            _log(f"socket FAIL {exc}")
            write_status(connected=False, lastError=str(exc)[:200])
        time.sleep(RECONNECT_SEC)


if __name__ == "__main__":
    raise SystemExit(main())
