# `.aura` File Format

`.aura` maps environment variable names to agent credential fields.

## Syntax

```ini
# comment
ENV_NAME=credentialName/field
OTHER_ENV=@agentName/credentialName/field
```

Rules:

- one mapping per line
- comments start with `#`
- env var names are validated (must be shell-safe)
- `@agent/...` form selects a specific agent mapping

## Examples

```ini
DATABASE_URL=postgres-prod/url
OPENAI_API_KEY=openai-prod/api_key
GITHUB_TOKEN=@agent/github/token
```

## Usage

```bash
aurawallet env check
aurawallet env -- npm run dev
aurawallet env inject
```

Migration helper:

```bash
aurawallet env init --from .env
# or during setup
aurawallet init --from-dotenv
```

## Security notes

- `env inject` writes `.env` with mode `0600`
- `shell-hook` requires explicit allowlist per project
- avoid committing generated `.env`
