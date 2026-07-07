"""서버 CPU·메모리·온도·디스크 — 시간대별 평균 집계."""
from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

METRICS_RETENTION_DAYS = 7
MIN_SAMPLE_INTERVAL_SECONDS = 60
METRICS_PATH: Path | None = None

HISTORY_WINDOWS = {
    "1h": {"hours": 1, "label": "최근 1시간"},
    "6h": {"hours": 6, "label": "최근 6시간"},
    "24h": {"hours": 24, "label": "최근 24시간"},
    "7d": {"hours": 24 * 7, "label": "최근 7일"},
}

_lock = threading.Lock()


def configure_server_metrics(data_dir: Path) -> None:
    global METRICS_PATH
    METRICS_PATH = data_dir / "server-metrics.json"


def _empty_store() -> dict:
    return {"version": 1, "samples": []}


def _load_unlocked() -> dict:
    if not METRICS_PATH or not METRICS_PATH.exists():
        return _empty_store()
    try:
        with METRICS_PATH.open(encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError):
        return _empty_store()
    samples = raw.get("samples") if isinstance(raw.get("samples"), list) else []
    return {"version": 1, "samples": samples}


def _save_unlocked(data: dict) -> None:
    if not METRICS_PATH:
        return
    METRICS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = METRICS_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(METRICS_PATH)


def _parse_ts(raw: str) -> datetime | None:
    try:
        dt = datetime.fromisoformat(str(raw or "").replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


def _prune_samples(samples: list) -> list:
    cutoff = datetime.now(timezone.utc) - timedelta(days=METRICS_RETENTION_DAYS)
    out = []
    for item in samples:
        if not isinstance(item, dict):
            continue
        ts = _parse_ts(item.get("at"))
        if ts and ts >= cutoff:
            out.append(item)
    return out


def _num(value) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _aggregate(values: list[float]) -> dict:
    if not values:
        return {"avg": None, "max": None, "min": None}
    return {
        "avg": round(sum(values) / len(values), 1),
        "max": round(max(values), 1),
        "min": round(min(values), 1),
    }


def record_snapshot(
    *,
    cpu_percent,
    memory_used_percent,
    temperature_c,
    disk_used_percent,
    load1,
) -> None:
    if not METRICS_PATH:
        return
    now = datetime.now(timezone.utc)
    sample = {
        "at": now.isoformat(),
        "cpu": _num(cpu_percent),
        "mem": _num(memory_used_percent),
        "temp": _num(temperature_c),
        "disk": _num(disk_used_percent),
        "load1": _num(load1),
    }

    with _lock:
        store = _load_unlocked()
        samples = store.get("samples") if isinstance(store.get("samples"), list) else []
        if samples:
            last = samples[-1]
            last_ts = _parse_ts(last.get("at") if isinstance(last, dict) else "")
            if last_ts and (now - last_ts).total_seconds() < MIN_SAMPLE_INTERVAL_SECONDS:
                return
        samples.append(sample)
        store["samples"] = _prune_samples(samples)
        _save_unlocked(store)


def history_summary() -> dict:
    if not METRICS_PATH:
        return {"windows": {}, "retentionDays": METRICS_RETENTION_DAYS}

    now = datetime.now(timezone.utc)
    with _lock:
        store = _load_unlocked()
    samples_raw = store.get("samples") if isinstance(store.get("samples"), list) else []

    parsed = []
    for item in samples_raw:
        if not isinstance(item, dict):
            continue
        ts = _parse_ts(item.get("at"))
        if not ts:
            continue
        parsed.append((ts, item))

    windows_out = {}
    for key, meta in HISTORY_WINDOWS.items():
        cutoff = now - timedelta(hours=meta["hours"])
        bucket = [item for ts, item in parsed if ts >= cutoff]
        cpu_vals = [v for v in (_num(x.get("cpu")) for x in bucket) if v is not None]
        mem_vals = [v for v in (_num(x.get("mem")) for x in bucket) if v is not None]
        temp_vals = [v for v in (_num(x.get("temp")) for x in bucket) if v is not None]
        disk_vals = [v for v in (_num(x.get("disk")) for x in bucket) if v is not None]
        load_vals = [v for v in (_num(x.get("load1")) for x in bucket) if v is not None]
        windows_out[key] = {
            "key": key,
            "label": meta["label"],
            "hours": meta["hours"],
            "samples": len(bucket),
            "cpuPercent": _aggregate(cpu_vals),
            "memoryUsedPercent": _aggregate(mem_vals),
            "temperatureC": _aggregate(temp_vals),
            "diskUsedPercent": _aggregate(disk_vals),
            "load1": _aggregate(load_vals),
        }

    return {
        "retentionDays": METRICS_RETENTION_DAYS,
        "sampleIntervalSeconds": MIN_SAMPLE_INTERVAL_SECONDS,
        "windows": windows_out,
    }
