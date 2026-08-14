# AGENTS.md

## Cursor Cloud specific instructions

### What this repo contains

`broadcast-schedule/` is the real-time SOOP 방종 엔딩 크레딧 (broadcast ending-credits / live donation & mission)
data layer for `sirian-cal.com`. It has a Flask backend plus a vanilla-JS dev-monitor frontend
(`broadcast-schedule/ending/`). The root `README.md` describes an unrelated iOS app and is not
relevant to this codebase.

### Important: this is a partial extract — the full server does NOT run here

`broadcast-schedule/credits_server.py` imports five modules that are **not committed to this repo**:
`credits_collector_presence`, `credits_ingest_activity`, `credits_overlay`, `credits_obs_link`,
`credits_schedule`. Because those source files are missing, `credits_server.py` cannot be imported
or started (`ModuleNotFoundError`). Do not fabricate these modules. The `/api/credits/dev-monitor`
endpoint that `ending/dev.html` fetches also depends on them, so the frontend cannot be served
end-to-end from this repo alone.

The fully runnable, testable surface is the pure-Python data layer:
`broadcast-schedule/credits_store.py` and `broadcast-schedule/ssapi_mission_collector.py`, covered by
`broadcast-schedule/test_ssapi_mission.py`.

### Dependencies

- Python 3.12. The only third-party deps are `flask` + `itsdangerous` (used by `credits_server.py`);
  `credits_store.py`, `ssapi_mission_collector.py`, and the tests are pure standard library.
- The update script creates a venv at `broadcast-schedule/venv/` and installs those two packages.
  Creating the venv needs the system package `python3.12-venv` (already present in the snapshot).

### Test / build / run

Run everything from `broadcast-schedule/` using the venv interpreter:

- Tests: `./venv/bin/python -m unittest test_ssapi_mission` (10 tests). Test runs print
  `[credits ...]` log lines to stdout — this is expected; filter with `grep -v '^\[credits'`.
- Syntax/build check (no linter is configured in this repo): `./venv/bin/python -m py_compile *.py`
  (note `credits_server.py` compiles fine even though it cannot be imported/run).
- The Flask server (`credits_server.py`, port `8017` via `CREDITS_PORT`) cannot start here — see above.
