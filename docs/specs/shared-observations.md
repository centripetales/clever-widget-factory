# Shared Observations Spec

## Problem

Observations (states) cannot be viewed cross-org. The `shared_with_partners` toggle sets a risk profile (`aggregate_risk = 0.0`) and queues to `rsp_outbox`, but the states GET endpoint strictly scopes to the user's current org via `buildOrganizationFilter`. There is no mechanism for a partner org to read shared observations.

Tools, parts, and actions already support cross-org visibility via `view_shared` + `state_links` (entity + organization link pair). Observations should follow the same pattern.

## Current State

| Concern | Tools/Parts | Actions | Observations |
|---------|-------------|---------|--------------|
| Cross-org read | `view_shared` param + state_links JOIN | `view_shared` param + state_links JOIN | ❌ Not supported |
| Sharing mechanism | `POST /shares` creates state + 2 state_links | `POST /shares` creates state + 2 state_links | Risk profile toggle only |
| Frontend org filter | `useSharedOrgs` + local `selectedOrgs` filter | `useSharedOrgs` + local `selectedOrgs` filter | ❌ No org selector |
| Cache key | `toolsQueryConfig` / `partsQueryConfig` shared configs | `actionsQueryConfig` shared config | `statesQueryKey(orgId)` — org-scoped |

## Design

### Principle: Reuse existing patterns, don't duplicate data loads

Observations shared with a partner org should use the same `state_links` mechanism (entity_type='state' + entity_type='organization') and the same `view_shared` query param pattern. The frontend should reuse `useSharedOrgs` for org filtering.

---

### Backend Changes

#### 1. States Lambda — Add `view_shared` support to GET /states

When `view_shared` query param is present, extend the WHERE clause (same pattern as actions/tools):

```sql
-- Own org observations (if own org is in view_shared)
s.organization_id = '{own_org}'

OR

-- Partner org observations shared with us via state_links
(
  s.organization_id IN ({partner_org_ids})
  AND EXISTS (
    SELECT 1 FROM state_links sl_share
    WHERE sl_share.entity_type = 'state'
      AND sl_share.entity_id = s.id
    AND EXISTS (
      SELECT 1 FROM state_links sl_org
      WHERE sl_org.state_id = sl_share.state_id
        AND sl_org.entity_type = 'organization'
        AND sl_org.entity_id = '{viewer_org_id}'
    )
  )
)
```

Add computed fields to the SELECT:
```sql
CASE WHEN s.organization_id != '{current_org}'::uuid THEN true ELSE false END as is_shared_inbound
```

When `view_shared` is absent, behavior is unchanged (buildOrganizationFilter scopes to current org only).

#### 2. Sharing an observation — `POST /shares`

The existing `POST /shares` endpoint in core lambda already supports generic entity sharing. It creates:
- A `states` row (the sharing record)
- `state_link` with `entity_type = 'state'` + `entity_id = observation.id`
- `state_link` with `entity_type = 'organization'` + `entity_id = target_org.id`

**No new endpoint needed.** The frontend just calls `POST /shares` with `entity_type: 'state'` when sharing an observation with a partner org.

#### 3. Unsharing — `DELETE /shares/{stateId}`

Already generic. Works for observations without changes.

#### 4. Listing shares — `GET /shares/state/{observationId}`

Already generic. Returns which orgs an observation is shared with.

#### 5. `GET /shared-with-me` — include observations

Currently filtered to `entity_type === 'action'` on the frontend only (the backend returns all types). The SharedOrgSelector component should expand its filter to include `'state'` entity types when used on the observations page.

#### 6. Broadcast invalidation

After sharing/unsharing, broadcast to both source AND target org connections. This is a known gap — currently only the mutating org is notified. For this spec, we accept the existing limitation: the target org will see shared observations on next cache refresh (manual refresh or staleTime expiry).

---

### Frontend Changes

#### 1. Add `sharedStatesQueryConfig` to `assetQueryConfigs.ts`

```ts
export const sharedStatesQueryConfig = (orgId: string, sharedOrgIds: string[]) => ({
  queryKey: ['states_shared', orgId, ...sharedOrgIds.slice().sort()],
  queryFn: async () => {
    const result = await apiService.get(`/states?view_shared=${sharedOrgIds.join(',')}`);
    return result.data || [];
  },
});
```

However, this introduces a separate cache entry for shared observations. To avoid duplicating data loads:

**Preferred approach:** Modify the existing `stateService.getStates()` to pass `view_shared` when shared orgs are selected, and keep one unified query. The `useStates` hook already accepts filters — extend it:

```ts
// useStates.ts
export function useStates(orgId: string, filters?: StateFilters & { viewShared?: string[] }) {
  const viewSharedParam = filters?.viewShared?.length
    ? `&view_shared=${filters.viewShared.join(',')}`
    : '';
  // ... append to fetch URL
}
```

This keeps a single cache entry per filter combination, same pattern as today.

#### 2. Add SharedOrgSelector to ObservationsList filters card

Place inside the existing `<Card className="mb-6">` filters toolbar, as a third column in the grid (change from `md:grid-cols-2` to `md:grid-cols-3`):

```tsx
{/* Filters Toolbar */}
<Card className="mb-6">
  <CardContent className="pt-6">
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* Text Search */}
      <div className="relative">...</div>
      {/* Timeframe Select */}
      <div>...</div>
      {/* Org Visibility */}
      <SharedOrgSelector
        entityTypes={['state']}
        items={observations}
        orgIdAccessor={(obs) => obs.organization_id}
      />
    </div>
  </CardContent>
</Card>
```

Reuse the existing `SharedOrgSelector` component. Pass it the observations array for per-org counts. The `useSharedOrgs` hook already provides `selectedOrgs`.

#### 3. Local org filtering in ObservationsList

Same as Actions page:
```ts
if (selectedOrgs.length > 0) {
  filtered = filtered.filter(obs => selectedOrgs.includes(obs.organization_id));
}
```

#### 4. Share/Unshare UI on individual observations

Add a sharing dialog (reuse pattern from CombinedAssetCard's share action):
- Lists partner orgs available to share with
- Calls `POST /shares` with `entity_type: 'state'`, `entity_id: observation.id`, `target_org_id`
- Shows existing shares via `GET /shares/state/{id}`
- Remove share via `DELETE /shares/{shareStateId}`

This replaces (or augments) the current `shared_with_partners` toggle which only sets risk profiles.

#### 5. Visual indicators

- `is_shared_inbound` badge: "From [Org Name]" on observations received from partners
- Share icon/count on observations shared outbound
- Consistent with how shared tools/parts/actions are displayed

---

### Migration / Backward Compatibility

The existing `shared_with_partners` toggle (risk profile mechanism) continues to work independently — it controls RSP/risk processing. The new state_links-based sharing controls **visibility to partner orgs**. They can coexist:

- An observation can have `shared_with_partners = true` (risk cleared for RSP) without being shared to any specific org via state_links
- An observation can be shared via state_links without having its risk profile cleared

For simplicity, the UI should unify these: when a user shares an observation with a partner org (state_links), also set `shared_with_partners = true` (risk profile). When all shares are removed, revert to private.

---

### Affected Files

| File | Change |
|------|--------|
| `lambda/states/index.js` | Add `view_shared` param handling to GET /states |
| `src/hooks/useStates.ts` | Accept `viewShared` filter, pass to API |
| `src/services/stateService.ts` | Append `view_shared` query param |
| `src/pages/ObservationsList.tsx` | Add SharedOrgSelector, local org filter, share dialog |
| `src/components/SharedOrgSelector.tsx` | Accept configurable entity_type filter (not hardcoded to 'action') |
| `src/lib/assetQueryConfigs.ts` | No change needed if useStates handles it |

### Not In Scope

- Cross-org WebSocket broadcast (accept existing limitation)
- Changing the risk-profile mechanism (coexists)
- Sharing observations that are linked to actions (existing guard remains)
