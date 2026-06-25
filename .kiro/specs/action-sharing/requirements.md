# Action Sharing — Requirements

## Background

Asset sharing (tools and parts) already exists and is the reference implementation. It uses the `states` + `state_links` tables to record share relationships: a share is a `state` row owned by the source org, linked to the entity (`entity_type = 'tool'|'part'`, `entity_id = <id>`) and to the target org (`entity_type = 'organization'`, `entity_id = <target_org_id>`). The `GET /api/shares/{type}/{id}` endpoint in `cwf-core-lambda` already queries this table for any entity type.

The current actions lambda has a `view_shared` code path, but it gates visibility on a completely different mechanism (a specific `state_text` + `state_risk_profiles` record) that no UI creates. This spec replaces that gate with the same state-link pattern used by asset sharing.

---

## Requirements

### REQ-1: Share button behavior (outbound — sharing owner)

When a member of Stargazer Farm views an action list or opens an action detail dialog, they see a Handshake icon button.

- **REQ-1a**: The button is rendered in its default (un-filled) style when the action has not been shared with any organization.
- **REQ-1b**: Clicking the button opens the `ShareConfigurationDialog` where the user can select one or more partner organizations and optionally add a note.
- **REQ-1c**: After at least one organization is saved, the button turns green (`bg-green-100 text-green-600 border-green-300`). The green state is driven by `action.shared_with_partners` returned from the actions query — no extra API call per card.
- **REQ-1d**: Both the list card (`ActionListItemCard`) and the detail dialog (`UnifiedActionDialog`) show the same Handshake icon with the same green/default styling logic.
- **REQ-1e**: Both resolved (completed) and unresolved actions can be shared.

### REQ-2: Sharing data model

Sharing an action reuses the exact same state-link model as asset sharing:

- A `states` row is inserted with `organization_id = source_org_id` (Stargazer Farm), `state_text` = note or a default description.
- A `state_links` row links that state to the action: `entity_type = 'action'`, `entity_id = <action_id>`.
- A second `state_links` row links the same state to the target org: `entity_type = 'organization'`, `entity_id = <target_org_id>`.

This is identical to how `POST /api/shares` already works in `cwf-core-lambda` — no new table or new endpoint is required. The `GET /api/shares/action/{id}` and `DELETE /api/shares/{stateId}` paths in the same handler also work for actions without modification.

### REQ-3: `shared_with_partners` field on actions query

The `GET /api/actions` response must include a `shared_with_partners: boolean` field on each action row. This field is `true` when at least one state exists that links to the action AND to an organization different from the action's owning org. This allows the frontend to derive the green/default button state from cached action data — no per-action `/api/shares` request is needed on render.

The existing `shared_with_partners` subquery in the actions lambda currently checks for `state_text = 'Shared narrative and impact overview for action'` and `srp.aggregate_risk = 0.0`. This must be replaced with the simpler state-link check used by the GET shares endpoint.

### REQ-4: Inbound sharing — viewing partner actions (consumer side)

When a user is logged in under the Department of Agriculture (DA) and selects Stargazer Farm via the `SharedOrgSelector` panel on the Actions page:

- **REQ-4a**: The actions list fetches with `view_shared=<stargazer_farm_org_id>` appended to the query, matching the pattern already used for assets.
- **REQ-4b**: The actions lambda returns both the DA's own actions AND any actions from Stargazer Farm that have been shared with the DA's org, regardless of status (completed or unresolved).
- **REQ-4c**: Shared-inbound actions are visually distinguished with an `is_shared_inbound` flag (analogous to assets), so the DA user can see at a glance which actions are theirs vs. shared from partners.
- **REQ-4d**: The DA user cannot edit or score inbound shared actions (read-only view).

### REQ-5: `view_shared` filter logic in the actions lambda

The `view_shared` SQL gate in the actions lambda must be rewritten to match the tool/part sharing pattern in `cwf-core-lambda`:

- An action from a partner org is visible to the requesting org when a `states` row exists that:
  - links to the action via `state_links (entity_type='action', entity_id=<action_id>)`
  - links to the requesting org via `state_links (entity_type='organization', entity_id=<requesting_org_id>)`
- This replaces the current `state_text` + `state_risk_profiles` check entirely.

### REQ-6: `SharedOrgSelector` on the Actions page

The Actions page already renders `<SharedOrgSelector />` and already passes `view_shared` to the fetch. No new component is needed.

The selector must include the user's own organization as a toggleable entry, pre-checked by default. A user may uncheck their own org to view only partner data (e.g., a DA user who wants to focus entirely on Stargazer Farm's shared actions). All selections — including whether the own org is checked — persist across sessions via `localStorage`, keyed per org as the existing `useSharedOrgs` pattern already does.

When the own org is unchecked, the actions query must still include `view_shared` to pass the partner org IDs, and must exclude `a.organization_id = <own_org_id>` from the base filter. This is handled in the actions lambda by treating the own org as just another entry in the `view_shared` array rather than as a separate always-on condition.

### REQ-7: No new Lambda functions or tables required

All required backend logic fits within:
- `lambda/actions/index.js` — fix `view_shared` filter and `shared_with_partners` subquery
- `cwf-core-lambda` — `POST/GET/DELETE /api/shares` already supports `entity_type = 'action'`; the only issue was a 500 caused by a missing `state_risk_profiles` join that the core lambda does NOT have (it only queries `states` + `state_links`).

> **Note on the 500 error**: The `GET /api/shares/action/{id}` in `cwf-core-lambda` does NOT error — it returns an empty array for actions that haven't been shared via the state-link pattern. The 500 was triggered because the actions lambda's own `shared_with_partners` subquery referenced `state_risk_profiles`, which may not exist for all states. Fixing REQ-3 removes that dependency.
