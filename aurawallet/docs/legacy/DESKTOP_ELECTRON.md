# Aura Desktop (Electron)

## Overview
Aura Desktop wraps the existing Aura web app in an Electron shell (no duplicate UI fork).

## Security defaults
- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- preload-only API bridge (`window.auraDesktop`)

## Run (dev)
1. Install deps: `npm install`
2. Start desktop shell: `AURA_ELECTRON_DEV=1 electron apps/desktop-electron/main.js`

This launches the web runtime and opens Electron against `http://localhost:4747`.

## Build + package (local artifact)
1. Build web app: `npx prisma generate && npx next build`
2. Package desktop app: `npx electron-builder --config apps/desktop-electron/electron-builder.yml`

Artifacts are generated under `dist/electron/`.

## Signing notes
- macOS notarization / Windows code signing are environment-specific and not enabled by default in this baseline.
- Configure signing credentials in CI/local env before publishing distributables.
