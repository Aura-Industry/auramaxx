# Packaging Policy (npm publish)

Published package should include only runtime-required code and public docs.

## Intentionally excluded
- `pipeline/**` tasking artifacts
- `docs/internal/**` internal-only runbooks
- `docs/specs/**` draft/spec docs not needed at runtime
- test folders/data (`server/tests/**`, `server/test-data/**`, `src/__tests__/**`)
- local/dev DB files under `prisma/**.db*`

## Validation rule
Before release, run:

```bash
npm pack --dry-run --json
```

Review tarball file list for accidental internal/dev leakage.
