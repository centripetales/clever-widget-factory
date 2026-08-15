# Partner agency RBAC design

**Status:** partially implemented — the authorizer code below (Phase 2) is
live and deployed. The database tables it depends on (Phase 1) were never
created. In practice this means the feature is currently a **no-op**:
`lambda/authorizer/index.js` queries `partner_members`/`partner_organizations`,
catches the failure when they don't exist, and falls back to primary-org-only
access. Confirm current DB state against
[`docs/architecture/DATABASE_SCHEMA.md`](../architecture/DATABASE_SCHEMA.md)
before assuming any part of this is live for real partner users.
**Last verified:** 2026-08-01.

## Overview

Design for supporting partner agency access with role-based permissions —
partner agencies can access data relevant to specific partnerships while
maintaining data isolation from their own org's non-shared data.

## Current role system (this part is live, unrelated to partner access)

- **superadmin**: full system access across all organizations
- **admin**: full access within their organization
- **leadership**: strategic decision-making access
- **contributor**: content creation and editing
- **viewer**: read-only access

Stored in `organization_members.role`. Frontend checks:
`isLeadership`, `isContributor`, `canEditTools`.

## Partner agency requirements (the unbuilt part)

- Users from external organizations accessing data shared with their
  partnership
- Partnership-specific data tagging (missions, actions, tools, inventory)
- Partner-specific roles (`partner_admin`, `partner_contributor`,
  `partner_viewer`) with limited access
- Partner users only see data explicitly shared with their partnership

Example: a Philippine Agricultural Training Institute (ATI) partnership
where ATI users can view/edit missions and actions related to the
collaboration, without seeing the rest of the org's data.

## Phase 1: database schema — NOT built

```sql
CREATE TABLE partner_organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_a_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  organization_b_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  partnership_name VARCHAR(255),
  partnership_type VARCHAR(50) DEFAULT 'collaboration',
  status VARCHAR(20) DEFAULT 'active',
  created_by UUID REFERENCES organization_members(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(organization_a_id, organization_b_id),
  CHECK (organization_a_id != organization_b_id)
);

CREATE TABLE partner_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_organization_id UUID NOT NULL REFERENCES partner_organizations(id) ON DELETE CASCADE,
  cognito_user_id VARCHAR(255) NOT NULL,
  organization_id UUID NOT NULL,       -- user's home organization
  role VARCHAR(50) NOT NULL,            -- 'partner_admin', 'partner_contributor', 'partner_viewer'
  is_active BOOLEAN DEFAULT true,
  invited_by UUID REFERENCES organization_members(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(partner_organization_id, cognito_user_id)
);

CREATE TABLE partnership_data_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_organization_id UUID NOT NULL REFERENCES partner_organizations(id) ON DELETE CASCADE,
  data_type VARCHAR(50) NOT NULL,       -- 'mission', 'action', 'tool', 'part', 'issue'
  data_id UUID NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(partner_organization_id, data_type, data_id)
);
```

Partner roles: `partner_admin` (full access to tagged data, can invite/tag),
`partner_contributor` (view/edit tagged data, can't tag or manage users),
`partner_viewer` (read-only).

## Phase 2: Lambda authorizer — LIVE

`lambda/authorizer/index.js` already implements this — it queries
`partner_members`/`partner_organizations` for the requesting user and
returns `accessible_organization_ids` and `partner_access` in the authorizer
context, exactly as designed:

```javascript
{
  organization_id: "primary-org-uuid",
  accessible_organization_ids: ["org-1", "org-2"],
  partner_access: [
    { partner_organization_id: "partner-org-uuid", role: "partner_contributor", organization_id: "partner-org-uuid" }
  ],
  is_superadmin: "true" | "false",
  user_role: "admin" | "leadership" | "contributor" | "viewer",
  cognito_user_id: "cognito-user-id"
}
```

Since the Phase 1 tables don't exist, the partner-membership query fails and
the authorizer catches it, continuing with primary-org-only access — so
today, every user effectively gets `accessible_organization_ids: [organization_id]`
and empty `partner_access`.

The frontend already consumes these fields too — `ObservationsList.tsx` uses
`partnerOrgIds`/`view_shared` — so once the tables exist and get populated,
the plumbing on both ends should mostly just start working rather than
needing new integration code.

## Phase 3: Lambda data filtering — status not verified in this pass

The design calls for every Lambda to filter by `accessible_organization_ids`
and apply `partnership_data_tags` for partner-visible data:

```javascript
const accessibleOrgIds = JSON.parse(event.requestContext.authorizer.accessible_organization_ids || '[]');
const partnerAccess = JSON.parse(event.requestContext.authorizer.partner_access || '[]');
// ... build WHERE organization_id IN (accessibleOrgIds) OR id IN (SELECT data_id FROM partnership_data_tags WHERE ...)
```

Since `accessible_organization_ids` currently only ever contains the primary
org (Phase 1 tables missing), this can't be meaningfully tested end-to-end
right now even if implemented.

## Phase 4: Frontend UI for managing partnerships — not verified

No partnership-management UI (create partnership, invite partner user, tag
data for a partnership) was found in a quick pass — likely not built, but
worth a direct check before assuming, same as everything else in this doc.

## Security considerations (unchanged from original design)

1. Partner users can only access explicitly tagged data
2. Partner roles are separate from primary org roles
3. Partner member invitations should be explicit, not open
4. Superadmins override partnership restrictions
5. Audit trail for partner data access — not verified as built

## Next steps if this gets picked back up

1. Create the three Phase 1 tables via a migration.
2. Verify the authorizer's existing partner-membership query actually
   matches the schema above once the tables exist (it was written against
   this design but never tested against real tables).
3. Audit Lambda functions for the `accessible_organization_ids` filtering
   pattern — likely needs to be added broadly, not just for the endpoints
   already known to consume it.
