#!/usr/bin/env bash
# LLM Council — start backend + frontend (frees ports if already in use)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

BACKEND_PORT="${BACKEND_PORT:-8001}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

pids_on_port() {
  local port="$1"

  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
    return
  fi

  if command -v ss >/dev/null 2>&1; then
    ss -lptn "sport = :$port" 2>/dev/null \
      | grep -oE 'pid=[0-9]+' \
      | cut -d= -f2 \
      | sort -u \
      || true
    return
  fi

  # Git Bash / Windows: netstat -ano
  if command -v netstat >/dev/null 2>&1; then
    netstat -ano 2>/dev/null \
      | awk -v port="$port" '
          /LISTENING/ {
            for (i = 1; i < NF; i++) {
              if ($i ~ (":" port "$")) {
                pid = $NF
                if (pid ~ /^[0-9]+$/ && pid != "0") print pid
                break
              }
            }
          }
        ' \
      | sort -u \
      || true
  fi
}

kill_pids() {
  local signal="${1:-}"
  shift
  local pid
  for pid in "$@"; do
    [[ -z "$pid" ]] && continue
    if command -v taskkill.exe >/dev/null 2>&1; then
      if [[ "$signal" == "9" ]]; then
        taskkill.exe //F //PID "$pid" >/dev/null 2>&1 || true
      else
        taskkill.exe //PID "$pid" >/dev/null 2>&1 || true
      fi
    else
      if [[ "$signal" == "9" ]]; then
        kill -9 "$pid" 2>/dev/null || true
      else
        kill "$pid" 2>/dev/null || true
      fi
    fi
  done
}

free_port() {
  local port="$1"
  local pids=""

  if command -v fuser >/dev/null 2>&1 && ! command -v lsof >/dev/null 2>&1; then
    if fuser "${port}/tcp" >/dev/null 2>&1; then
      echo "Port $port is in use — freeing it..."
      fuser -k "${port}/tcp" >/dev/null 2>&1 || true
      sleep 0.5
    fi
    return
  fi

  pids="$(pids_on_port "$port")"
  if [[ -z "${pids//[$' \t\n']/}" ]]; then
    return
  fi

  echo "Port $port is in use (PID: $(echo "$pids" | tr '\n' ' ')) — freeing it..."
  # shellcheck disable=SC2086
  kill_pids "" $pids
  sleep 0.5

  local still
  still="$(pids_on_port "$port")"
  if [[ -n "${still//[$' \t\n']/}" ]]; then
    # shellcheck disable=SC2086
    kill_pids "9" $still
    sleep 0.3
  fi
}

run_backend() {
  if command -v uv >/dev/null 2>&1; then
    uv run python -m backend.main
  elif [[ -x "$ROOT/.venv/bin/python" ]]; then
    "$ROOT/.venv/bin/python" -m backend.main
  elif [[ -x "$ROOT/.venv/Scripts/python.exe" ]]; then
    "$ROOT/.venv/Scripts/python.exe" -m backend.main
  else
    python -m backend.main
  fi
}

echo "Starting LLM Council..."
echo ""

free_port "$BACKEND_PORT"
free_port "$FRONTEND_PORT"

echo "Starting backend on http://localhost:${BACKEND_PORT}..."
run_backend &
BACKEND_PID=$!

# Give the API a moment before the UI boots
sleep 2

echo "Starting frontend on http://localhost:${FRONTEND_PORT}..."
(
  cd "$ROOT/frontend"
  npm run dev -- --port "$FRONTEND_PORT" --strictPort
) &
FRONTEND_PID=$!

cleanup() {
  echo ""
  echo "Stopping servers..."
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  exit 0
}

trap cleanup SIGINT SIGTERM

echo ""
echo "LLM Council is running!"
echo "  Backend:  http://localhost:${BACKEND_PORT}"
echo "  Frontend: http://localhost:${FRONTEND_PORT}"
echo ""
echo "Press Ctrl+C to stop both servers"

wait
