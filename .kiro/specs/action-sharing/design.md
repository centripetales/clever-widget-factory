# Action Sharing — Design

## Data model (unchanged)

Shares use the existing `states` + `state_links` pattern. No new tables.

```
states
  id, organization_id (source org), state_text, captured_by, captured_at

state_links (two rows per share)
  entity_type='action',       entity_id=<action_id>
  entity_type='organization', entity_id=<target_org_id>
```

`POST /api/shares`, `GET /api/shares/action/{id}`, and `DELETE /api/shares/{stateId}` in `cwf-core-lambda` already work for actions. No backend change needed there.

---

## Backend changes — `lambda/actions/index.js`

### 1. Fix `shared_with_partners` subquery

Replace the current subquery (which checks `state_text` + `state_risk_profiles`) with a plain state-link check:

```sql
-- BEFORE (broken — no UI creates these states)
SELECT EXISTS(
  SELECT 1 FROM states s
  JOIN state_links sl ON s.id = sl.state_id
  JOIN state_risk_profiles srp ON s.id = srp.state_id
  WHERE sl.entity_type = 'action' AND sl.entity_id = a.id
    AND s.state_text = 'Shared narrative and impact overview for action'
    AND srp.aggregate_risk = 0.0
)

-- AFTER (matches state-link model used by asset sharing)
SELECT EXISTS(
  SELECT 1 FROM states s
  JOIN state_links sl_e ON sl_e.state_id = s.id
    AND sl_e.entity_type = 'action' AND sl_e.entity_id = a.id
  JOIN state_links sl_o ON sl_o.state_id = s.id
    AND sl_o.entity_type = 'organization'
    AND sl_o.entity_id::text != s.organization_id::text
)
```

Also add `is_shared_inbound` to the SELECT so the frontend can distinguish partner actions from own actions:

```sql
CASE WHEN a.organization_id::text != '<own_org_id>' THEN true ELSE false END as is_shared_inbound
```

`own_org_id` is `organizationId` from the authorizer context, already available in scope.

### 2. Fix `view_shared` filter

Replace the current `state_risk_profiles` gate with the state-link-to-requesting-org pattern:

```sql
-- BEFORE (broken)
a.organization_id::text IN (${sharedOrgsStr})
AND EXISTS (
  SELECT 1 FROM states s
  JOIN state_links sl ON s.id = sl.state_id
  JOIN state_risk_profiles srp ON s.id = srp.state_id
  WHERE sl.entity_type = 'action' AND sl.entity_id = a.id
    AND s.state_text = 'Shared narrative and impact overview for action'
    AND srp.aggregate_risk = 0.0
)

-- AFTER (matches tool/part sharing pattern)
a.organization_id::text IN (${sharedOrgsStr})
AND EXISTS (
  SELECT 1 FROM states s
  JOIN state_links sl_e ON sl_e.state_id = s.id
    AND sl_e.entity_type = 'action' AND sl_e.entity_id = a.id
  JOIN state_links sl_o ON sl_o.state_id = s.id
    AND sl_o.entity_type = 'organization'
    AND sl_o.entity_id::text = '${organizationId}'
)
```

The outer `WHERE` already handles the requesting org's own actions (`a.organization_id = <requestingOrg>`), so partner actions only need the EXISTS check.

### 3. `view_shared` including own org

When the own org is unchecked in the selector, the frontend sends `view_shared=<partner_org_id>` without the own org. When own org IS checked, it sends `view_shared=<own_org_id>,<partner_org_id>`.

The lambda's existing logic already handles this: when `view_shared` is present, it shows any action whose `organization_id` is in the list AND matches the share condition. The own org's actions trivially satisfy the condition because:

```sql
a.organization_id::text = '<own_org_id>'  -- own-org branch of the OR
```

So no special own-org handling is needed in the lambda — the OR already covers it.

---

## Frontend changes

### 1. `useSharedOrgs` — include own org, persist selections

Currently `useSharedOrgs` stores only partner org IDs. It needs to:

- Initialise `selectedOrgs` with the own org ID pre-checked (first load only — if localStorage is empty for this org key).
- Continue persisting all selections (including own org) via `localStorage` keyed per org.

```typescript
// On first load (no saved value), default to own org checked
if (!saved && orgId) {
  setSelectedOrgs([orgId]);
}
```

### 2. `SharedOrgSelector` — show own org as first entry

Currently the component filters out `o.id !== currentOrganization?.id`. Remove that filter. Add a visual separator or "(You)" label so the own org is clearly identifiable.

```tsx
// Before
const otherOrgs = orgs.filter(o => o.id !== currentOrganization?.id);

// After — own org listed first, others below
const ownOrg = { id: currentOrganization.id, name: currentOrganization.name };
const otherOrgs = orgs.filter(o => o.id !== currentOrganization?.id);
const allOrgs = [ownOrg, ...otherOrgs];
```

Render own org with a `(You)` suffix or distinct style.

### 3. `Actions.tsx` — fetch logic when own org is deselected

Currently the fetch URL is:
```
/actions?status=...&view_shared=<partner_ids>   (when partners selected)
/actions?status=...                              (no partners — own org only)
```

With the new model, the fetch always uses `view_shared` when the selection differs from "just own org":

```typescript
const viewSharedIds = selectedOrgs; // may or may not include own org
const url = `/actions?status=...${viewSharedIds.length > 0 ? `&view_shared=${viewSharedIds.join(',')}` : ''}`;
```

If `selectedOrgs` is empty (user unchecked everything), show an empty list with an informational message ("No organizations selected").

### 4. `ActionListItemCard` — `is_shared_inbound` visual treatment

When `action.is_shared_inbound` is true, show a small "Shared" badge and disable the edit/score interactions (matching how `CombinedAssetCard` handles `is_shared_inbound`). The share button should also be hidden for inbound actions (you can't re-share something you don't own).

---

## Sequence: sharing an action (outbound)

```
Stargazer Farm user
  → clicks Handshake button on action card
  → ShareConfigurationDialog opens, loads partner orgs
  → selects "Department of Agriculture", saves
  → POST /api/shares { entity_type:'action', entity_id, target_org_id:'<DA_id>', source_org_id:'<SF_id>' }
  → cwf-core-lambda inserts states + 2 state_links rows
  → onSaved() fires → invalidates ['actions'] cache
  → actions refetch → shared_with_partners = true → button turns green
```

## Sequence: viewing shared actions (inbound)

```
DA user
  → opens Actions page
  → SharedOrgSelector shows DA (own, pre-checked) + Stargazer Farm
  → DA user checks Stargazer Farm
  → GET /api/actions?status=unresolved&view_shared=<DA_id>,<SF_id>
  → actions lambda returns DA's own actions + SF actions shared with DA
  → SF actions render with is_shared_inbound=true → "Shared" badge, read-only
```
