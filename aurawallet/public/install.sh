#!/usr/bin/env bash
set -euo pipefail

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node.js 20+ from https://nodejs.org/ and rerun." >&2
  exit 1
fi

echo "Installing aurawallet globally..."
npm install -g aurawallet
echo "Done. Run: aurawallet --help"
