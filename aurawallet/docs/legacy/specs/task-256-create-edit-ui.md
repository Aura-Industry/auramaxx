# Task #256 — Add Management UI to Create and Edit Tasks

## Goal
Add create & edit task capabilities to the Pipeline Dashboard UI (`/pipeline`).

## Current State
- **API**: `src/app/api/pipeline/tasks/route.ts` — GET only (list + detail)
- **UI**: `src/components/pipeline/PipelineDashboardMvp.tsx` — read-only dashboard (360 lines)
- **Backend**: `tasks/src/lib/pipeline-service.ts` — has write functions (transitionTaskState, acquireTaskLock, addTaskTag, removeTaskTag)
- **CLI**: `scripts/taskctl.ts` — has `cmdCreateTask()` with INSERT/upsert SQL
- **Design system**: Modal, TextInput, Button, ConfirmationModal available in `src/components/design-system/`

## Plan

### 1. API: Add POST/PATCH to `src/app/api/pipeline/tasks/route.ts`

**POST** — Create task
- Body: `{ title, slug, priority?, deliveryType?, dispatchAgent?, tags?[] }`
- Auto-assign next task_num
- Return created task

**PATCH** — Update task  
- Body: `{ taskNum, title?, slug?, priority?, status?, stage?, dispatchAgent?, addTags?[], removeTags?[] }`
- Update fields that are provided
- Use `transitionTaskState` for status changes
- Return updated task

Both endpoints open the DB in read-write mode (not readonly like GET).

### 2. UI: Add "Create Task" button + modal

In `PipelineDashboardMvp.tsx`:
- Add a "＋ New Task" button next to Refresh in the filter bar
- Opens a Modal with form fields:
  - Title (TextInput, required)
  - Slug (TextInput, auto-generated from title, editable)
  - Priority (select: P0/P1/P2, default P2)
  - Tags (comma-separated TextInput)
- Submit calls POST `/api/pipeline/tasks`
- On success, refresh task list and select the new task

### 3. UI: Add "Edit" button in TaskDetailPanel

- Add an "Edit" button in the detail panel header
- Opens same modal pre-filled with current values
- Additional fields when editing:
  - Status (select dropdown)
  - Dispatch Agent (TextInput)
- Submit calls PATCH `/api/pipeline/tasks`
- On success, refresh detail + list

### 4. UI: Inline tag management in detail panel

- Add ✕ buttons on existing tag badges to remove
- Add a small "+ tag" input to add new tags
- These call PATCH with addTags/removeTags

## Files to Change
1. `src/app/api/pipeline/tasks/route.ts` — add POST + PATCH handlers
2. `src/components/pipeline/PipelineDashboardMvp.tsx` — add create/edit UI
3. Possibly extract `TaskFormModal.tsx` as a sub-component

## Testing
- Add/extend `src/__tests__/app/pipeline-dashboard-mvp.test.tsx`
- Test create form renders, edit form pre-fills, API calls made correctly
