"""로그인 사용자 닉네임 영구 저장·중복 방지."""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path

from nickname_filter import (
    NicknameRejected,
    nickname_check_key,
    normalize_nickname,
    sanitize_display_name,
)


class NicknameTaken(NicknameRejected):
    code = "nickname_taken"
    message = "이미 사용 중인 닉네임입니다."


class NicknameNotSaved(NicknameRejected):
    code = "nickname_not_saved"
    message = "닉네임을 저장해 주세요."


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class NicknameRegistry:
    def __init__(self, path: Path):
        self._path = path
        self._lock = threading.RLock()
        self._owners: dict[str, dict] = {}
        self._by_email: dict[str, dict] = {}
        self._load()

    def _load(self) -> None:
        if not self._path.is_file():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        self._owners = dict(raw.get("owners") or {})
        self._by_email = dict(raw.get("byEmail") or {})

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "updatedAt": _utc_now(),
            "owners": self._owners,
            "byEmail": self._by_email,
        }
        tmp = self._path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(self._path)

    def _key(self, nickname: str) -> str:
        return nickname_check_key(nickname)

    def get_nickname(self, email: str) -> str:
        email = str(email or "").strip().lower()
        if not email:
            return ""
        with self._lock:
            row = self._by_email.get(email)
            return str(row.get("nickname") or "") if row else ""

    def check(self, nickname: str, email: str = "") -> dict:
        email = str(email or "").strip().lower()
        try:
            nick = sanitize_display_name(nickname)
        except NicknameRejected as exc:
            return {"available": False, "reason": exc.code, "message": exc.message}
        if not nick:
            return {"available": False, "reason": "empty", "message": "닉네임을 입력해 주세요."}
        key = self._key(nick)
        with self._lock:
            owner = self._owners.get(key)
            if owner and owner.get("email") != email:
                return {"available": False, "reason": NicknameTaken.code, "message": NicknameTaken.message}
        return {"available": True, "nickname": nick}

    def assert_can_use(self, nickname: str, email: str = "") -> str:
        email = str(email or "").strip().lower()
        nick = normalize_nickname(nickname)
        if not nick:
            return nick
        key = self._key(nick)
        with self._lock:
            owner = self._owners.get(key)
            if owner and owner.get("email") != email:
                raise NicknameTaken(NicknameTaken.message)
        return nick

    def claim(self, email: str, nickname: str) -> str:
        email = str(email or "").strip().lower()
        if not email:
            raise ValueError("email required")
        nick = sanitize_display_name(nickname)
        if not nick:
            raise NicknameRejected("닉네임을 입력해 주세요.")
        key = self._key(nick)
        now = _utc_now()
        with self._lock:
            owner = self._owners.get(key)
            if owner and owner.get("email") != email:
                raise NicknameTaken(NicknameTaken.message)
            prev = self._by_email.get(email)
            if prev and prev.get("key") and prev["key"] != key:
                self._owners.pop(prev["key"], None)
            self._owners[key] = {"email": email, "nickname": nick, "claimedAt": owner.get("claimedAt", now) if owner and owner.get("email") == email else now, "updatedAt": now}
            self._by_email[email] = {"nickname": nick, "key": key, "updatedAt": now}
            self._save()
        return nick

    def resolve_for_user(self, email: str, requested: str = "", fallback_name: str = "") -> str:
        email = str(email or "").strip().lower()
        if not email:
            return str(requested or "")
        saved = self.get_nickname(email)
        if saved:
            return saved
        raw = str(requested or fallback_name or "").strip()
        if raw:
            return self.claim(email, raw)
        return raw


_registry: NicknameRegistry | None = None


def get_nickname_registry(path: Path | None = None) -> NicknameRegistry:
    global _registry
    if _registry is None:
        if path is None:
            raise ValueError("path required on first init")
        _registry = NicknameRegistry(path)
    return _registry
