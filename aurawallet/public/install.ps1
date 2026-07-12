$ErrorActionPreference = "Stop"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error "npm is required. Install Node.js 20+ from https://nodejs.org/ and rerun."
  exit 1
}

Write-Host "Installing aurawallet globally..."
npm install -g aurawallet
Write-Host "Done. Run: aurawallet --help"
