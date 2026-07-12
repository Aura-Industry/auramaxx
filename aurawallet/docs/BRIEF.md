# AuraOS Desktop Homepage

## Goal

Make the AuraWallet Next.js app the web shell for AuraOS: `/` is a production-grade, responsive OS-style desktop and the complete existing AuraWallet unlock/dashboard experience lives at `/wallet` without losing any prior entry flow.

## Scope

- Work only in `aurawallet/`.
- Keep `prisma/`, `bin/`, and `src/server/` unchanged unless a browser unlock route is hard-coded there.
- Add no runtime dependencies and do not rename existing shared exports.

## Acceptance criteria

1. Visiting `/` without a wallet-intent query renders a full-viewport AuraOS desktop with a wallpaper, an `AuraOS` top bar, a live clock, and six labeled app icons.
2. AuraWallet is visually primary and opens `/wallet` with a keyboard-accessible link; AuraJS opens `https://github.com/Aura-Industry/aurajs` in a new tab; AuraChess, AuraLauncher, AuraRegistry, and AuraPM are visibly disabled and marked `SOON`.
3. The desktop reflows for mobile and uses the existing light/dark theme tokens, with visible hover and focus states.
4. `/` has AuraOS title/description/canonical/Open Graph/Twitter metadata and keeps `/opengraph.webp`.
5. `/wallet` renders the unchanged `UnlockPageClient` experience and owns the existing AuraWallet SEO title/description, `/wallet` canonical, and `/wallet` Open Graph URL.
6. Wallet-intent query links that still land on `/` redirect to `/wallet` while preserving all query keys and values.
7. Existing wallet entry points no longer accidentally land on AuraOS: approval/share returns, legacy `/app/*`, health-agent navigation, and the Electron dashboard target point to `/wallet`; the old Vercel `/` to `/yo` redirect is removed.
8. Existing unlock-focused UI tests target the wallet component/route, and a new UI test covers the AuraOS app states and primary links.
9. From `aurawallet/`, `npm run typecheck`, `npm run test:ui`, and `npm run build` all pass.

## Non-goals

- Changing wallet authentication, session, lock, or API behavior.
- Changing the CLI, server routes, database, AuraHub internals, or adding real implementations for coming-soon apps.
- Replacing the current Open Graph image.
