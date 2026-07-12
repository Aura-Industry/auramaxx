# Task Lifecycle — Agent PM System

Manage the task pipeline. All commands use `$TASKCTL` from the project root.

```bash
TASKCTL="node --import tsx scripts/taskctl.ts"
```

---

## How It Works

Agents work in **isolated task folders** — never touching source code directly. Changes flow through automated validation and human approval before landing in the codebase.

```
QUEUED ──→ IN_PROGRESS ──→ REVIEW ──→ DONE
               │               │
          (gate fail)    (reject/test fail)
               │               │
               ▼               ▼
           QUEUED ◄────────────┘   (attempts < 3, retry)
           FROZEN ◄────────────┘   (attempts >= 3, human intervenes)
```

### Pipeline Flow

1. **Provision** — Task transitions to IN_PROGRESS, system copies allowed files into `{project_root}/tasks/task-{id}/changes/` and creates `/new/`
2. **Agent works** — Modifies files in the task folder only, within spec constraints
3. **Gate check** — Validates against allowlists, line limits, forbidden paths, dependency rules
4. **Review** — Human reviews via dashboard or CLI preview
5. **Swap** — Git savepoint → copy to source → run tests → commit or rollback
6. **Conflict resolution** — After swap, other tasks touching same files get invalidated and requeued

---

## Statuses

| Status | Meaning |
|--------|---------|
| `OPEN` | Created, not yet queued for agents |
| `QUEUED` | Ready for agent pickup |
| `IN_PROGRESS` | Agent working in task folder |
| `REVIEW` | Gate check passed, awaiting human approval |
| `DONE` | Approved, swapped into source, archived |
| `FROZEN` | 3+ failures, needs human investigation |
| `HUMAN` | Reserved for human-only work |
| `CANCELED` | Abandoned or superseded |

---

## Task Folder Rules

```
{project_root}/tasks/task-{id}/
  /changes/     ← copies of allowed source files to modify
  /new/         ← new files the agent creates
```

**Agents MUST:**
- Only modify files in `changes/` that are listed in `allowed_modify`
- Only create files in `new/` matching `allowed_create` patterns
- Stay under `max_lines_changed` (default: 200)

**Agents MUST NOT:**
- Touch source code directly
- Modify files outside `allowed_modify`
- Touch `forbidden` paths (global or per-project)
- Add dependencies unless `can_add_dependencies` is true

### Task Spec Fields

| Field | Type | Purpose |
|-------|------|---------|
| `allowed_modify` | JSON array | Files the agent may edit |
| `allowed_create` | JSON array | Glob patterns for new files |
| `max_lines_changed` | integer | Max total line diff |
| `can_add_dependencies` | boolean | Allow package.json changes |
| `module` | string | Module this task touches |
| `attempts` | integer | Rejection count |
| `last_error` | string | Last rejection reason |

---

## Gate Check

Automated validation that runs before a task reaches REVIEW. **Auto-rejects** if:

1. Modified file not in `allowed_modify`
2. Created file not matching `allowed_create` patterns
3. File matches `forbidden` globs (global + per-project merged)
4. Lines changed exceeds `max_lines_changed`
5. package.json/lock file changed and `can_add_dependencies` is false

```bash
$TASKCTL gate-check --task N [--json]     # Exit 0 = pass, Exit 2 = fail
```

API: `POST /api/tasks/{N}/gate-check` → `{ ok, passed, violations[], filesChanged[], filesCreated[], linesChanged }`

---

## Circuit Breaker

On rejection (gate fail, test failure, human reject):

- `attempts` increments by 1, `last_error` records reason
- **attempts < 3** → QUEUED (agent retries)
- **attempts >= 3** → FROZEN (human must investigate)

Frozen tasks require human intervention: rewrite spec + reset attempts, or kill.

---

## Swap

Applies an approved REVIEW task into the source tree:

1. Creates git savepoint
2. Copies `changes/` files into source
3. Copies `new/` files into project
4. Runs test command (per-project `test_command` config, 120s timeout)
5. **Tests pass** → commit, release file locks, archive task folder → DONE
6. **Tests fail** → rollback to savepoint, circuit breaker handles retry/freeze

```bash
$TASKCTL swap --task N [--json]            # Execute swap
$TASKCTL swap --task N --dry-run [--json]  # Preview without committing
```

API: `POST /api/tasks/{N}/swap` (body: `{ dryRun?: boolean }`) → 200 success, 422 test failure, 409 not in REVIEW

---

## File Locks

Tracks file ownership across concurrent tasks. First task to swap wins — conflicting tasks get invalidated and requeued.

- **Acquire** — Atomic all-or-nothing; returns conflicts if file already locked
- **Release** — Marks locks as released after swap
- **Invalidate** — After swap, other tasks on same files get requeued via circuit breaker

```bash
$TASKCTL file-locks --task N [--json]       # List active locks
$TASKCTL file-conflicts --task N [--json]   # Check for overlapping locks
```

API: `GET /api/tasks/{N}/file-locks`, `GET /api/tasks/{N}/file-conflicts`

---

## Preview

Temporarily copy task files into source for visual review. One preview at a time. No git operations — clean restore guaranteed.

```bash
$TASKCTL preview-start --task N [--json]   # Copy task files to source
$TASKCTL preview-stop [--json]             # Restore source to original state
```

---

## Context Builder

Assembles the agent prompt when a task starts. Total must stay under 4000 lines.

Assembly order:
1. **Framing** — Per-project `project_framing` config + task description + allowed files
2. **ARCHITECTURE.md** — Truncated to 100 lines
3. **Modified files** — Full content from task folder
4. **Adjacent interfaces** — Export signatures from related files
5. **Similar feature example** — From completed task with same module (optional)

Truncation order if over limit: example first, then adjacent interfaces.

---

---

## CLI Reference

### Quick Workflow

```bash
# Pick next task, claim it, and start
$TASKCTL pick-and-claim --owner my-agent [--tag TAG] [--json]
$TASKCTL update-task-status --task N --owner my-agent --status IN_PROGRESS [--json]

# Or use the shortcut
$TASKCTL next --owner my-agent [--json]

# When done
$TASKCTL done --task N --owner my-agent [--json]

# Approve a REVIEW task (swap + cascade-unblock)
$TASKCTL approve --task N [--json]

# On failure
$TASKCTL fail --task N --owner my-agent --error "reason" [--json]
```

### Task Management

```bash
# List and view
$TASKCTL list-tasks [--status S] [--tag TAG] [--json]
$TASKCTL show-task --task N [--json]
$TASKCTL my-tasks --owner O [--json]
$TASKCTL stats [--json]

# Create and edit
$TASKCTL create-task --title "..." --slug "..." [--priority P0|P1|P2] [--json]
$TASKCTL quick-create --title "..." [--json]
$TASKCTL update-task --task N --title "..." [--json]

# Status transitions
$TASKCTL update-task-status --task N --owner O --status S [--json]
$TASKCTL pick-task [--tag TAG] [--json]
$TASKCTL pick-and-claim [--tag TAG] --owner O [--json]
$TASKCTL claim-lock --task N --owner O [--json]
$TASKCTL release-lock --task N --owner O [--json]
$TASKCTL reap-stale-locks [--json]

# Tags
$TASKCTL add-tag --task N --tag T [--json]
$TASKCTL remove-tag --task N --tag T [--json]
$TASKCTL list-tags [--task N] [--json]

# Dependencies
$TASKCTL add-dep --task N --depends-on M [--json]
$TASKCTL remove-dep --task N --depends-on M [--json]
$TASKCTL list-deps --task N [--json]

# Hierarchy
$TASKCTL set-parent --task N --parent M [--json]
$TASKCTL remove-parent --task N [--json]
$TASKCTL list-subtasks --task N [--json]

# Comments
$TASKCTL comment --task N --author A --body "..." [--json]
$TASKCTL list-comments --task N [--json]

# Config (global)
$TASKCTL config-get --key K [--json]
$TASKCTL config-set --key K --value V [--json]
$TASKCTL config-list [--json]

# Templates
$TASKCTL list-templates [--json]
$TASKCTL show-template --name N [--json]
```

### Pipeline Commands

```bash
# Gate check
$TASKCTL gate-check --task N [--json]

# Swap
$TASKCTL swap --task N [--dry-run] [--json]

# Approve (swap + cascade-unblock dependents)
$TASKCTL approve --task N [--json]

# File locks
$TASKCTL file-locks --task N [--json]
$TASKCTL file-conflicts --task N [--json]

# Preview
$TASKCTL preview-start --task N [--json]
$TASKCTL preview-stop [--json]

# Backlog
$TASKCTL backlog-status [--json]
```

---

## Config

Config is layered: **per-task spec > per-project config > global config**. Per-project can only further restrict, never loosen global rules.

### Global Config

Set once, applies to all projects.

| Key | Default | Purpose |
|-----|---------|---------|
| `global_forbidden` | `["core/*"]` | Glob patterns no agent may touch |
| `max_concurrent_tasks` | `5` | Max tasks in IN_PROGRESS at once |
| `default_max_lines_changed` | `200` | Default line limit per task |
| `default_can_add_dependencies` | `false` | Default dependency policy |

### Per-Project Config

Stored in `project_config` table. Overrides global for tasks scoped to that project. Falls back to global when unset.

| Key | Purpose |
|-----|---------|
| `global_forbidden` | Additional forbidden globs (merged with global) |
| `test_command` | Test runner command (e.g. `npx vitest run`, `npm test`, `pytest`) |
| `project_framing` | Context builder framing text for this project |
| `source_dir` | Source directory name (default: `src`) |
| `dashboard_port` | Dev server port for preview |

```bash
# Set per-project config
$TASKCTL config-set --project P --key test_command --value "npm test"
$TASKCTL config-set --project P --key global_forbidden --value '["core/*","migrations/*"]'

# View merged config for a project
$TASKCTL config-list --project P
```

### Adding a New Project

```bash
# Register project
$TASKCTL create-project --name "my-app" --root /path/to/my-app

# Set project-specific config
$TASKCTL config-set --project 1 --key test_command --value "npm test"
$TASKCTL config-set --project 1 --key global_forbidden --value '["core/*","db/migrations/*"]'
$TASKCTL config-set --project 1 --key project_framing --value "You are modifying a React dashboard app."
```

---

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/tasks` | List tasks (query: `status`, `q`, `limit`, `offset`) |
| GET | `/api/tasks/pick` | Pick next queued task |
| POST | `/api/tasks/create` | Create task |
| GET | `/api/tasks/{N}` | Task detail |
| POST | `/api/tasks/{N}/claim` | Acquire lock |
| POST | `/api/tasks/{N}/release` | Release lock |
| POST | `/api/tasks/{N}/transition` | Transition status |
| POST | `/api/tasks/{N}/gate-check` | Run gate check |
| POST | `/api/tasks/{N}/swap` | Execute swap |
| GET | `/api/tasks/{N}/file-locks` | List active file locks |
| GET | `/api/tasks/{N}/file-conflicts` | Check file conflicts |
| POST | `/api/tasks/{N}/tags` | Add tag |
| DELETE | `/api/tasks/{N}/tags` | Remove tag |
| GET | `/api/tasks/{N}/comments` | List comments |
| POST | `/api/tasks/{N}/comments` | Add comment |
| GET | `/api/config` | List global config |
| POST | `/api/config` | Set global config |

---

## Services Reference

| Service | File | Function |
|---------|------|----------|
| Task Folder | `src/core/task-folder-service.ts` | `provisionTaskFolder(dbFile, taskNum)` |
| Gate Check | `src/core/gate-check-service.ts` | `runGateCheck(dbFile, taskNum)` |
| Circuit Breaker | `src/core/circuit-breaker.ts` | `handleRejection(dbFile, taskNum, reason)` |
| Swap | `src/core/swap-service.ts` | `swapTaskIntoSrc(dbFile, taskNum, opts?)` |
| File Locks | `src/core/file-lock-service.ts` | `acquireFileLocks()`, `releaseFileLocks()`, `invalidateConflicts()` |
| Preview | `src/core/preview-service.ts` | `startPreview(dbFile, taskNum)`, `stopPreview(dbFile)` |
| Context Builder | `src/core/context-builder.ts` | `buildAgentContext(dbFile, taskNum)` |
| Global Config | `src/core/global-config-service.ts` | `getConfig()`, `setConfig()`, `listConfig()` |
| Project Config | `src/core/project-service.ts` | `getProjectConfig()`, `setProjectConfig()`, `listProjectConfig()` |

Full spec: `public/agent-project-management.md`
