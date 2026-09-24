#!/usr/bin/env bash
# Cloud Agent install for the broadcast-schedule Python data layer.
#
# Safe to run on any branch/revision: it no-ops when broadcast-schedule/ is
# absent (e.g. the docs-only `main` branch) and is idempotent, so it can run
# repeatedly against cached state.
set -euo pipefail

APP_DIR="broadcast-schedule"

if [ ! -d "$APP_DIR" ]; then
  echo "[install] '$APP_DIR/' not present on this branch — nothing to set up."
  exit 0
fi

# The default image ships python3.12 but not the venv/ensurepip stdlib module,
# which is required to create the virtualenv below.
if ! python3.12 -c 'import ensurepip' >/dev/null 2>&1; then
  echo "[install] Installing python3.12-venv…"
  sudo apt-get update -qq
  sudo apt-get install -y -qq python3.12-venv
fi

cd "$APP_DIR"

if [ ! -x venv/bin/python ]; then
  echo "[install] Creating virtualenv at $APP_DIR/venv…"
  python3.12 -m venv venv
fi

# credits_store.py, ssapi_mission_collector.py and the tests are pure standard
# library; flask + itsdangerous are only needed by credits_server.py.
echo "[install] Installing Python dependencies (flask, itsdangerous)…"
./venv/bin/python -m pip install --quiet --upgrade pip
./venv/bin/python -m pip install --quiet flask itsdangerous

echo "[install] Done. Test with: cd $APP_DIR && ./venv/bin/python -m unittest test_ssapi_mission"
