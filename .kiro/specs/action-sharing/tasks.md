# Action Sharing — Tasks

## Task 1 — Fix `shared_with_partners` subquery in actions lambda

**File**: `lambda/actions/index.js`

Replace the `shared_with_partners` correlated subquery in the SELECT with:

```sql
COALESCE((
  SELECT EXISTS(
    SELECT 1 FROM states s
    JOIN state_links sl_e ON sl_e.state_id = s.id
      AND sl_e.entity_type = 'action' AND sl_e.entity_id = a.id
    JOIN state_links sl_o ON sl_o.state_id = s.id
      AND sl_o.entity_type = 'organization'
      AND sl_o.entity_id::text != s.organization_id::text
  )
), false) as shared_with_partners
```

Also add `is_shared_inbound` to the SELECT:

```sql
CASE WHEN a.organization_id::text != '${escapeLiteral(organizationId)}' THEN true ELSE false END as is_shared_inbound
```

Deploy: `./scripts/deploy/deploy-lambda-fast.sh actions cwf-actions-lambda`

---

## Task 2 — Fix `view_shared` filter in actions lambda

**File**: `lambda/actions/index.js`

Replace the `view_shared` WHERE condition with:

```sql
(
  a.organization_id::text = '${escapeLiteral(organizationId)}'
  OR (
    a.organization_id::text IN (${sharedOrgsStr})
    AND EXISTS (
      SELECT 1 FROM states s
      JOIN state_links sl_e ON sl_e.state_id = s.id
        AND sl_e.entity_type = 'action' AND sl_e.entity_id = a.id
      JOIN state_links sl_o ON sl_o.state_id = s.id
        AND sl_o.entity_type = 'organization'
        AND sl_o.entity_id::text = '${escapeLiteral(organizationId)}'
    )
  )
)
```

Also use `escapeLiteral` (already imported) for the `sharedOrgsStr` entries, matching the style in `cwf-core-lambda`.

Deploy: `./scripts/deploy/deploy-lambda-fast.sh actions cwf-actions-lambda`

> Tasks 1 and 2 can be done in a single deploy.

---

## Task 3 — Add `is_shared_inbound` to `BaseAction` type

**File**: `src/types/actions.ts`

```typescript
is_shared_inbound?: boolean;
```

---

## Task 4 — Update `useSharedOrgs` to include own org and default it checked

**File**: `src/hooks/useSharedOrgs.ts`

- Accept `orgId` as the initial default: when localStorage has no saved value for the current org key, initialise `selectedOrgs` to `[orgId]`.
- No other logic changes — toggle and persist already work.

```typescript
// Replace the else branch in the useEffect:
} else {
  // First visit: default to own org checked
  const defaults = orgId ? [orgId] : [];
  setSelectedOrgs(defaults);
  if (orgId) localStorage.setItem(storageKey(orgId), JSON.stringify(defaults));
}
```

---

## Task 5 — Update `SharedOrgSelector` to include own org

**File**: `src/components/SharedOrgSelector.tsx`

- Remove the `o.id !== currentOrganization?.id` filter.
- Prepend own org as the first entry with a `(You)` label suffix.
- Keep the rest of the rendering unchanged.

```tsx
const ownOrg = currentOrganization
  ? [{ id: currentOrganization.id, name: `${currentOrganization.name} (You)` }]
  : [];
const partnerOrgs = orgs.filter(o => o.id !== currentOrganization?.id);
const allOrgs = [...ownOrg, ...partnerOrgs];
```

---

## Task 6 — Update Actions page fetch to handle own-org deselection

**File**: `src/pages/Actions.tsx`

The fetch URLs already append `view_shared` when `selectedOrgs.length > 0`. With own org now in the list, the existing logic works correctly — no change needed when own org is checked.

Add an empty-state guard: if `selectedOrgs.length === 0`, skip the fetch and show an inline message.

```typescript
// In the query config:
enabled: selectedOrgs.length > 0,
```

And in the render:
```tsx
{selectedOrgs.length === 0 && (
  <p className="text-sm text-muted-foreground">No organizations selected. Check at least one org above to see actions.</p>
)}
```

---

## Task 7 — Show read-only treatment for inbound shared actions

**File**: `src/components/ActionListItemCard.tsx`

When `action.is_shared_inbound` is true:
- Show a small `Shared` badge (similar to `CombinedAssetCard`).
- Hide the Handshake share button (you can't reshare what you don't own).
- Disable the score button if present.

```tsx
{action.is_shared_inbound && (
  <Badge variant="outline" className="text-xs bg-blue-50 text-blue-600 border-blue-200">Shared</Badge>
)}
{!action.is_shared_inbound && (
  <Button /* ... share button ... */ />
)}
```

---

## Task 8 — Deploy actions lambda

After Tasks 1 and 2 are verified locally:

```bash
./scripts/deploy/deploy-lambda-fast.sh actions cwf-actions-lambda
```

Verify with:
```bash
# From Stargazer Farm — should show shared_with_partners: true after sharing
curl 'https://0720au267k.execute-api.us-west-2.amazonaws.com/prod/api/actions?status=completed' \
  -H 'authorization: Bearer <SF_token>' -H 'x-organization-id: <SF_org_id>'

# From DA — should return Stargazer Farm actions when view_shared includes SF org
curl 'https://0720au267k.execute-api.us-west-2.amazonaws.com/prod/api/actions?status=completed&view_shared=<SF_org_id>' \
  -H 'authorization: Bearer <DA_token>' -H 'x-organization-id: <DA_org_id>'
```
