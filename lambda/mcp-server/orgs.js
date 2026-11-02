import { withDbClient } from './db.js';

// Orgs the caller is an active member of, oldest first like the authorizer
// (the first is their primary org, where new actions go), and their name. (The authorizer also
// checks partner_members, but that table doesn't exist in this database.)
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export async function getCaller(cognitoUserId) {
  const cached = cache.get(cognitoUserId);
  if (cached && cached.expires_at > Date.now()) return cached.caller;

  const caller = await withDbClient(async (client) => {
    const memberships = await client.query(
      `SELECT organization_id, full_name
       FROM organization_members
       WHERE cognito_user_id = $1 AND is_active = true
       ORDER BY created_at ASC`,
      [cognitoUserId]
    );
    return {
      orgIds: memberships.rows.map((r) => r.organization_id),
      name: memberships.rows.map((r) => r.full_name).find(Boolean) || null,
    };
  });

  cache.set(cognitoUserId, { caller, expires_at: Date.now() + CACHE_TTL_MS });
  return caller;
}
