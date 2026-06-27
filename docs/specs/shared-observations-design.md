# Shared Observations — Implementation Design

## Overview

Add cross-org observation visibility using the same `state_links` + `view_shared` pattern as tools/parts/actions. Observations shared with a partner org appear in their ObservationsList when that org is selected in the filter.

---

## Backend

### lambda/states/index.js — `listStates()`

Add `view_shared` query param support. When present, replace the simple `buildOrganizationFilter` WHERE with a compound clause:

```js
// In listStates():
const { entity_type, entity_id, limit: limitParam, view_shared } = queryParams;

let whereClause;
if (view_shared) {
  const sharedArray = view_shared.split(',').map(s => s.trim().replace(/'/g, "''"));
  const ownOrgChecked = sharedArray.includes(organizationId);
  const partnerOrgs = sharedArray.filter(id => id !== organizationId);
  
  const clauses = [];
  if (ownOrgChecked) {
    clauses.push(`s.organization_id = '${organizationId}'::uuid`);
  }
  if (partnerOrgs.length > 0) {
    const partnerList = partnerOrgs.map(id => `'${id}'`).join(',');
    clauses.push(`(
      s.organization_id IN (${partnerList})
      AND EXISTS (
        SELECT 1 FROM state_links sl_e
        JOIN state_links sl_o ON sl_o.state_id = sl_e.state_id
        WHERE sl_e.entity_type = 'state'
          AND sl_e.entity_id = s.id
          AND sl_o.entity_type = 'organization'
          AND sl_o.entity_id = '${organizationId}'::uuid
      )
    )`);
  }
  whereClause = clauses.length > 0 ? `(${clauses.join(' OR ')})` : '1=0';
} else {
  const orgFilter = buildOrganizationFilter(authContext, 's');
  whereClause = orgFilter.condition;
}
```

Add computed field to SELECT:

```sql
CASE WHEN s.organization_id != '${organizationId}'::uuid THEN true ELSE false END as is_shared_inbound
```

No other lambda changes needed — `POST /shares` already supports `entity_type: 'state'`.

---

## Frontend

### 1. src/services/stateService.ts

Add `view_shared` param support:

```ts
async getStates(filters?: { entity_type?: string; entity_id?: string; view_shared?: string }): Promise<Observation[]> {
  const params = new URLSearchParams();
  if (filters?.entity_type) params.append('entity_type', filters.entity_type);
  if (filters?.entity_id) params.append('entity_id', filters.entity_id);
  if (filters?.view_shared) params.append('view_shared', filters.view_shared);
  
  const queryString = params.toString();
  return apiService.get(`/states${queryString ? `?${queryString}` : ''}`);
}
```

### 2. src/lib/queryKeys.ts

Extend `statesQueryKey` to include view_shared in the cache key:

```ts
export const statesQueryKey = (orgId: string, filters?: { entity_type?: string; entity_id?: string; view_shared?: string }) =>
  filters
    ? ['states', orgId, filters.entity_type ?? 'all', filters.entity_id ?? 'all', filters.view_shared ?? '']
    : ['states', orgId];
```

### 3. src/hooks/useStates.ts

Accept `view_shared` in the filters type:

```ts
export function useStates(orgId: string, filters?: { entity_type?: string; entity_id?: string; view_shared?: string }) {
  return useQuery({
    queryKey: statesQueryKey(orgId, filters),
    queryFn: () => stateService.getStates(filters),
    enabled: !!orgId && (!filters || (!filters.entity_type && !filters.entity_id) || !!(filters.entity_type && filters.entity_id)),
  });
}
```

### 4. src/types/observations.ts

Add `is_shared_inbound` and `organization_id` fields:

```ts
export interface Observation {
  // ... existing fields ...
  organization_id: string;
  is_shared_inbound?: boolean;
}
```

### 5. src/components/SharedOrgSelector.tsx

Make the entity type filter configurable (currently hardcoded to `'action'`):

```diff
 interface SharedOrgSelectorProps {
-  actions?: BaseAction[];
+  items?: Array<{ organization_id?: string; is_shared_inbound?: boolean }>;
+  entityTypes?: string[];
 }

-export function SharedOrgSelector({ actions = [] }: SharedOrgSelectorProps) {
+export function SharedOrgSelector({ items = [], entityTypes = ['action'] }: SharedOrgSelectorProps) {
   // ...
   const { data: partnerOrgs = [] } = useQuery({
-    queryKey: ['shared_with_me', currentOrg?.id],
+    queryKey: ['shared_with_me', currentOrg?.id, ...entityTypes],
     queryFn: async () => {
       // ...
-      shared.filter(s => s.entity_type === 'action').forEach(s => {
+      shared.filter(s => entityTypes.includes(s.entity_type)).forEach(s => {
         // ...
       });
     },
   });

   const countForOrg = (orgId: string): number => {
-    if (orgId === currentOrg.id) return actions.filter(a => !a.is_shared_inbound).length;
-    return actions.filter(a => a.is_shared_inbound && (a as any).organization_id === orgId).length;
+    if (orgId === currentOrg.id) return items.filter(a => !a.is_shared_inbound).length;
+    return items.filter(a => a.is_shared_inbound && a.organization_id === orgId).length;
   };
```

Keep backward compat: `actions` prop still works (mapped internally to `items`).

### 6. src/pages/ObservationsList.tsx

Wire up SharedOrgSelector and pass `view_shared` to useStates:

```diff
+import { SharedOrgSelector } from '@/components/SharedOrgSelector';
+import { useSharedOrgs } from '@/hooks/useSharedOrgs';
+import { useOrganization } from '@/hooks/useOrganization';

 export default function ObservationsList() {
+  const { selectedOrgs } = useSharedOrgs();
+  const { organization, accessibleOrganizations } = useOrganization();
+  const partnerOrgIds = accessibleOrganizations
+    .filter(o => o.id !== organization?.id)
+    .map(o => o.id);
+  const hasPartners = partnerOrgIds.length > 0;
+
+  // Build view_shared param: all selected org IDs joined
+  const viewShared = hasPartners && selectedOrgs.length > 0
+    ? selectedOrgs.join(',')
+    : undefined;

-  const { data: observations = [], isLoading: loadingObs, isError } = useStates(orgId);
+  const { data: observations = [], isLoading: loadingObs, isError } = useStates(orgId, viewShared ? { view_shared: viewShared } : undefined);
```

Add to filters toolbar (third column):

```diff
-<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
+<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
   {/* Text Search */}
   <div className="relative">...</div>
   {/* Timeframe Select */}
   <div>...</div>
+  {/* Org Visibility Filter */}
+  {hasPartners && (
+    <SharedOrgSelector
+      items={observations}
+      entityTypes={['state']}
+    />
+  )}
 </div>
```

Add inbound badge to observation cards:

```diff
+{obs.is_shared_inbound && (
+  <Badge variant="outline" className="text-[10px] py-0 px-1.5 bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-900/50">
+    Shared
+  </Badge>
+)}
```

---

## Data Flow Diagram

```
┌─────────────────────────────────────┐
│ ObservationsList                     │
│                                     │
│  useSharedOrgs() → selectedOrgs     │
│         │                           │
│         ▼                           │
│  useStates(orgId, {view_shared})    │
│         │                           │
│         ▼                           │
│  stateService.getStates({           │
│    view_shared: "org1,org2"         │
│  })                                 │
│         │                           │
│         ▼                           │
│  GET /states?view_shared=org1,org2  │
└─────────┬───────────────────────────┘
          │
          ▼
┌─────────────────────────────────────┐
│ States Lambda                        │
│                                     │
│  Own org: WHERE org_id = currentOrg │
│  Partner: WHERE org_id IN (...)     │
│    AND EXISTS (state_links share)    │
│                                     │
│  Returns: [...ownObs, ...sharedObs] │
│    with is_shared_inbound flag      │
└─────────────────────────────────────┘
```

---

## Cache Strategy

- **Single query per filter combination**: `['states', orgId, 'all', 'all', 'org1,org2']`
- When `selectedOrgs` changes → new cache key → fresh fetch (but staleTime keeps old entries warm for back-navigation)
- WS `cache:invalidate` for entity type `state` uses prefix matching → invalidates all states caches regardless of view_shared suffix
- Optimistic updates in `useStateMutations` target `statesQueryKey(orgId)` (the base key with no view_shared) — this is fine since shared obs will be from partner orgs and mutations are only on own-org observations
- Mutation responses still update the correct cache entry because mutations re-call with the active filters

---

## What NOT to change

- `POST /shares` endpoint — already generic, works for `entity_type: 'state'`
- `DELETE /shares/{id}` — already generic
- `GET /shares/state/{id}` — already works
- `useCacheInvalidation` — prefix matching covers new cache keys
- `shared_with_partners` risk profile mechanism — coexists, not replaced
- Sharing guard for action-linked observations — remains enforced

---

## File Change Summary

| File | Type | Change |
|------|------|--------|
| `lambda/states/index.js` | Backend | Add `view_shared` WHERE clause + `is_shared_inbound` field |
| `src/services/stateService.ts` | Frontend | Add `view_shared` param to `getStates` |
| `src/lib/queryKeys.ts` | Frontend | Include `view_shared` in `statesQueryKey` |
| `src/hooks/useStates.ts` | Frontend | Accept `view_shared` in filters type |
| `src/types/observations.ts` | Frontend | Add `is_shared_inbound` field |
| `src/components/SharedOrgSelector.tsx` | Frontend | Make entity type filter configurable |
| `src/pages/ObservationsList.tsx` | Frontend | Add org selector filter + inbound badge |
