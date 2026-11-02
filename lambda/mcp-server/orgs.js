import { withDbClient } from './db.js';

// Orgs the caller is an active member of. (The authorizer also checks
// partner_members, but that table doesn't exist in this database.)
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export async function getAccessibleOrgIds(cognitoUserId) {
  const cached = cache.get(cognitoUserId);
  if (cached && cached.expires_at > Date.now()) return cached.orgIds;

  const orgIds = await withDbClient(async (client) => {
    const memberships = await client.query(
      `SELECT organization_id
       FROM organization_members
       WHERE cognito_user_id = $1 AND is_active = true`,
      [cognitoUserId]
    );
    return memberships.rows.map((r) => r.organization_id);
  });

  cache.set(cognitoUserId, { orgIds, expires_at: Date.now() + CACHE_TTL_MS });
  return orgIds;
}
