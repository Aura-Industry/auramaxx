#!/bin/bash

# Start Aura Wallet - both server and UI

MODE="${1:-dev}"  # Default to dev mode if no argument provided

echo "Starting Aura Wallet in ${MODE} mode..."

# Derive all service ports from a single dashboard port to avoid mismatches.
# UI client derives wallet/ws ports from dashboard port at runtime.
DASHBOARD_PORT="${DASHBOARD_PORT:-4747}"
WALLET_PORT="$((DASHBOARD_PORT - 505))"
WS_PORT_DERIVED="$((DASHBOARD_PORT + 1))"

export DASHBOARD_PORT
export WALLET_SERVER_PORT="$WALLET_PORT"
export WS_PORT="$WS_PORT_DERIVED"

# Track child processes for cleanup on failure/shutdown
SERVER_PID=""
CRON_PID=""
UI_PID=""

stop_processes() {
  kill "$SERVER_PID" "$CRON_PID" "$UI_PID" 2>/dev/null
}

wait_for_health() {
  local name="$1"
  local url="$2"
  local pid="$3"
  local retries="${4:-40}"  # 40 * 0.5s = 20s default timeout

  local i
  for ((i=1; i<=retries; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi

    # If process died, fail immediately instead of waiting for timeout
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      echo "✗ ${name} exited before becoming healthy"
      return 1
    fi

    sleep 0.5
  done

  echo "✗ ${name} did not become healthy at ${url}"
  return 1
}

# Kill any existing processes
pkill -f "tsx src/server/index.ts" 2>/dev/null
pkill -f "tsx watch src/server/index.ts" 2>/dev/null
pkill -f "tsx src/server/cron/index.ts" 2>/dev/null
pkill -f "next dev" 2>/dev/null
pkill -f "next start" 2>/dev/null

if [ "$MODE" = "prod" ] || [ "$MODE" = "production" ]; then
  # Production mode
  echo "Building Next.js..."
  npm run build

  echo "Starting agent server on :4242..."
  npm run server &
  SERVER_PID=$!

  if ! wait_for_health "Agent server" "http://127.0.0.1:${WALLET_PORT}/health" "$SERVER_PID" 80; then
    echo "Agent server failed to start. Exiting."
    stop_processes
    exit 1
  fi

  echo "Starting cron server (balance sync, price sync)..."
  npx tsx src/server/cron/index.ts &
  CRON_PID=$!

  echo "Starting Next.js production server on :${DASHBOARD_PORT}..."
  npx next start -p "$DASHBOARD_PORT" &
  UI_PID=$!

  MODE_LABEL="PRODUCTION (API + dashboard)"
else
  # Development mode (default)
  export BYPASS_RATE_LIMIT=true
  # Keep internal docs visible in local dev unless explicitly overridden.
  if [ -z "${NEXT_PUBLIC_SHOW_INTERNAL_DOCS}" ]; then
    export NEXT_PUBLIC_SHOW_INTERNAL_DOCS=true
  fi
  echo "Internal docs visibility: NEXT_PUBLIC_SHOW_INTERNAL_DOCS=${NEXT_PUBLIC_SHOW_INTERNAL_DOCS}"

  echo "Starting agent server (dev) on :${WALLET_PORT}..."
  npm run server:dev &
  SERVER_PID=$!

  if ! wait_for_health "Agent server" "http://127.0.0.1:${WALLET_PORT}/health" "$SERVER_PID" 40; then
    echo "server:dev failed, retrying agent server without watch mode..."
    kill "$SERVER_PID" 2>/dev/null
    BYPASS_RATE_LIMIT=true node --import tsx src/server/index.ts &
    SERVER_PID=$!

    if ! wait_for_health "Agent server" "http://127.0.0.1:${WALLET_PORT}/health" "$SERVER_PID" 40; then
      echo "Agent server failed to start on :${WALLET_PORT}. Exiting."
      stop_processes
      exit 1
    fi
  fi

  echo "Starting cron server (balance sync, price sync)..."
  npx tsx src/server/cron/index.ts &
  CRON_PID=$!

  echo "Starting Next.js dev server on :${DASHBOARD_PORT}..."
  npx next dev -p "$DASHBOARD_PORT" &
  UI_PID=$!

  MODE_LABEL="DEVELOPMENT (API + dashboard)"
fi

# Check if UI process exits immediately (most common startup failure mode)
sleep 2
if ! kill -0 "$UI_PID" 2>/dev/null; then
  echo "✗ Next.js UI failed to start on :${DASHBOARD_PORT}"
  stop_processes
  exit 1
fi

# WebSocket sidecar is started by Next instrumentation. Warn if unavailable.
if ! wait_for_health "WebSocket sidecar" "http://127.0.0.1:${WS_PORT_DERIVED}/health" "$UI_PID" 20; then
  echo "⚠ WebSocket sidecar is not healthy on :${WS_PORT_DERIVED} yet; UI may show [WS] reconnect errors."
fi

# ── Startup summary ────────────────────────────────────────────
if [ -t 1 ] && [ -z "$NO_COLOR" ] && [ "$CI" != "true" ] && [ "$TERM" != "dumb" ]; then
  RST=$'\033[0m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; GRAY=$'\033[90m'; CYAN=$'\033[38;5;154m'
else
  RST=''; BOLD=''; DIM=''; GRAY=''; CYAN=''
fi

PIPE="${GRAY}|${RST}"
TL="${GRAY}.-${RST}"; TR="${GRAY}-.${RST}"
BL="${GRAY}'-${RST}"; BR="${GRAY}-'${RST}"
LP="${GRAY}|${RST}"
LT="${GRAY}.${RST}${DIM}----------${RST}${GRAY}.${RST}"
LB="${GRAY}'${RST}${DIM}----------${RST}${GRAY}'${RST}"
PAD58=$(printf '%58s' '')
PAD43=$(printf '%43s' '')
PAD28=$(printf '%28s' '')

echo ""
echo "  ${TL}${DIM}${PAD58}${RST}${TR}"
echo "  ${PIPE}   ${LT}${PAD43}${PIPE}"
echo "  ${PIPE}   ${LP}${BOLD}\\\\${RST}  ${BOLD}\\\\${RST}  ${BOLD}\\\\${RST}${LP}    ${BOLD}A U R A${RST}${PAD28}${PIPE}"
echo "  ${PIPE}   ${LP}${BOLD}\\\\${RST}  ${BOLD}\\\\${RST}  ${BOLD}\\\\${RST}${LP}    ${DIM}M A X X . S H${RST}                      ${PIPE}"
echo "  ${PIPE}   ${LP}${BOLD}\\\\${RST}  ${BOLD}\\\\${RST}  ${BOLD}\\\\${RST}${LP}    ${CYAN}STARTING${RST}                              ${PIPE}"
echo "  ${PIPE}   ${LB}${PAD43}${PIPE}"
echo "  ${BL}${DIM}${PAD58}${RST}${BR}"

echo ""
echo "    ${DIM}Mode            ${RST}${MODE_LABEL}"
echo "    ${DIM}API (server)    ${RST}http://localhost:${WALLET_PORT}"
echo "    ${DIM}Dashboard       ${RST}http://localhost:${DASHBOARD_PORT}"
echo ""

# Handle Ctrl+C - kill both processes
trap "echo 'Shutting down...'; stop_processes; exit" SIGINT SIGTERM

# Wait for either process to exit
wait
