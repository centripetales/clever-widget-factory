# Cross-Org Sharing: Actions & Assets

## Goal

Allow a user to share a specific action or asset (tool/part) with another organization so that org's members can view it in read-only mode.

**Example use case:** Share a chicken procurement action with the Department of Agriculture so Marvin can see it.

---

## Current State

- `ShareConfigurationDialog` exists and lets you pick orgs + add justification. The backend (`POST /api/shares`) correctly stores the share as a `state` linked to the entity and target org via `state_links` — this is intentional: Maxwell can search and reason about sharing activity like any other state.
- `shared_with_partners` boolean exists on actions (legacy, global flag — not per-org).
- `useSharedOrgs` / `SharedOrgSelector` exist but only persist org selections in `localStorage` — no backend query uses them yet.
- Actions and assets show a "Share" button that opens `ShareConfigurationDialog` on assets; actions use a toggle in `UnifiedActionDialog`.

---

## What Needs to Be Built

### 1. Database — use `states` + `state_links` (existing pattern)

A share is represented as a **state** owned by the source org, with two `state_links`:
- one to the shared entity (`entity_type: 'action'|'tool'|'part'`, `entity_id`)
- one to the target org (`entity_type: 'organization'`, `entity_id: target_org_id`)

This means Maxwell can find, summarize, and reason about sharing activity just like any other state. No new table needed.

The `state_text` should be meaningful, e.g.:
> "Shared chicken procurement action with Department of Agriculture — for visibility on feed sourcing"

To query "what has been shared with org X":
```sql
SELECT sl_entity.entity_type, sl_entity.entity_id, s.*
FROM states s
JOIN state_links sl_org   ON sl_org.state_id   = s.id AND sl_org.entity_type   = 'organization' AND sl_org.entity_id = $target_org_id
JOIN state_links sl_entity ON sl_entity.state_id = s.id AND sl_entity.entity_type != 'organization'
```

The current `POST /api/shares` already does this — it just needs the `state_text` to be more descriptive (use the justification/note field as the state text).

### 2. Backend — Share endpoints (lambda/core or api/server.js)

**POST `/api/shares`** — already exists, already writes to `states`/`state_links`. Improvements needed:
- Use the `note` field as `state_text` (fallback: `"Shared [entityType] with [targetOrgName]"`)
- Return the state `id` so the client can reference or unshare it later

**DELETE `/api/shares/:stateId`** — delete the state + its state_links (unshare)

**GET `/api/shares/:entityType/:entityId`** — returns all active share states for an entity (which orgs it's shared with), used to pre-populate the dialog checkboxes

**GET `/api/shared-with-me`** — returns all entities shared with the current user's org, using the query above. Used by the receiving org's list views.

### 3. Share Dialog — repurpose `ShareConfigurationDialog`

- On open: fetch current shares for the entity (`GET /api/shares/:entityType/:entityId`) and pre-check already-shared orgs
- Checkbox list of other orgs (existing)
- Save: diff old vs new selection → POST new shares, DELETE removed ones
- Show share status per org (shared ✓ / not shared)
- Remove the `justification` field (or make it optional note, keep it simple)

Wire the action "Share" button in `UnifiedActionDialog` to open `ShareConfigurationDialog` instead of the current `shared_with_partners` toggle.

### 4. Receiving org — viewing shared entities

The `SharedOrgSelector` component already renders in the UI. It needs to actually affect queries:

- When an org is checked in `SharedOrgSelector`, the actions/assets list queries should include a `sharedOrgIds` param
- Backend list endpoints (`GET /actions`, `GET /tools`, etc.) check `entity_shares` and include matching records owned by the selected orgs
- Shared entities shown with a visual indicator (e.g. "Shared by [Org Name]" badge) and are read-only

### 5. Actions list — `UnifiedActionDialog` share button

Replace the `shared_with_partners` boolean toggle with a button that opens `ShareConfigurationDialog`:

```tsx
// Replace toggle with:
<Button variant="ghost" size="sm" onClick={() => setShowShareDialog(true)}>
  <Share2 className="w-4 h-4" />
  Share
</Button>
```

---

## Cleanup — Remove Legacy `shared_with_partners` Toggle

The old concept was a global boolean flag per action/state ("share with all trusted partners"). Replace with the new per-org share dialog.

**Remove:**
- `UnifiedActionDialog.tsx` — `sharedWithPartners` state, `isTogglingShared` state, `handleToggleShared`, and the toggle button
- `StatesInline.tsx` — per-state share toggle button and its handler
- `ObservationsList.tsx` — share toggle button and handler
- `lambda/actions/index.js` — `toggle_shared_with_partners` endpoint and all `handleSharingUpdate` calls
- `lambda/states/index.js` — `shared_with_partners` handling in create/update paths
- `src/types/actions.ts` and `src/types/observations.ts` — `shared_with_partners` type fields

**Keep (until DB column is formally dropped):**
- `shared_with_partners` in SQL SELECT queries — harmless, remove when column is dropped

---

## Out of Scope (this spec)

- User authentication for external users (Marvin's login — separate spec)
- Notifications when something is shared with your org
- Sharing states/observations (only actions and assets for now)
- Permission levels (read-only is the only level)

---

## Open Questions

1. ~~Should all members of the target org see shared entities, or only specific members?~~ **Answered: all members of the target org see shared entities** — the `state_link` to the org is the access grant, no per-user config needed.
2. Should the source org be able to see that the target org has viewed the shared entity?
3. Should `SharedOrgSelector` only show orgs that have shared something with you (pull), or all orgs you could look at (push)?
