const { randomUUID } = require('crypto');

const ENTITY_TABLES = { tool: 'tools', part: 'parts', action: 'actions' };

// Shares routes. `auth` comes from the authorizer context, never the request:
// { userId, organizationId, accessibleOrgIds, readAll }.
// Returns { statusCode, data }, or null when the route is not a shares route.
async function handleShares({ httpMethod, path, body = {}, query = {}, auth, getDbClient }) {
  const canAccess = orgId => !!orgId && (auth.readAll || auth.accessibleOrgIds.includes(orgId));
  const error = (statusCode, message) => ({ statusCode, data: { error: message } });

  // POST /shares — create a share (state + two state_links)
  if (httpMethod === 'POST' && path === '/shares') {
    const { entity_type, entity_id, target_org_id, note, entity_name, target_org_name } = body;
    if (!entity_type || !entity_id || !target_org_id) return error(400, 'Missing required sharing parameters');
    const table = ENTITY_TABLES[entity_type];
    if (!table) return error(400, 'Unsupported entity_type');
    if (!auth.userId) return error(401, 'Authenticated user id is required');

    const stateId = randomUUID();
    const stateText = (note && note.trim())
      || `Shared ${entity_type}${entity_name ? ' "' + entity_name + '"' : ''} with ${target_org_name || 'partner organization'}`;
    const client = await getDbClient();
    try {
      const entity = await client.query(`SELECT organization_id::text FROM ${table} WHERE id::text = $1`, [entity_id]);
      if (!entity.rows.length) return error(404, 'Entity not found');
      const sourceOrgId = entity.rows[0].organization_id;
      if (!canAccess(sourceOrgId)) return error(403, 'Access denied to this entity');
      const target = await client.query('SELECT 1 FROM organizations WHERE id::text = $1', [target_org_id]);
      if (!target.rows.length) return error(400, 'Target organization not found');

      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO states (id, organization_id, state_text, captured_by, captured_at) VALUES ($1, $2, $3, $4, NOW())`,
          [stateId, sourceOrgId, stateText, auth.userId]
        );
        await client.query(
          `INSERT INTO state_links (id, state_id, entity_type, entity_id) VALUES (gen_random_uuid(), $1, $2, $3)`,
          [stateId, entity_type, entity_id]
        );
        await client.query(
          `INSERT INTO state_links (id, state_id, entity_type, entity_id) VALUES (gen_random_uuid(), $1, 'organization', $2)`,
          [stateId, target_org_id]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
      return { statusCode: 200, data: { success: true, state_id: stateId } };
    } finally {
      client.release();
    }
  }

  // GET /shares/{entityType}/{entityId} — list orgs this entity is shared with.
  // Visible to the sharing org and to the orgs the share reaches.
  if (httpMethod === 'GET' && path.match(/^\/shares\/[^/]+\/[^/]+$/)) {
    const parts = path.split('/');
    const params = [parts[2], parts[3]];
    let accessCondition = '';
    if (!auth.readAll) {
      params.push(auth.accessibleOrgIds);
      accessCondition = `AND (s.organization_id::text = ANY($3::text[])
           OR sl_org.entity_id::text = ANY($3::text[])
           OR sl_org.entity_id::text IN (SELECT mo.organization_id::text FROM member_organizations mo WHERE mo.member_organization_id::text = ANY($3::text[])))`;
    }
    const client = await getDbClient();
    try {
      const { rows } = await client.query(
        `SELECT s.id as state_id, sl_org.entity_id::text as target_org_id, o.name as target_org_name,
                s.state_text as note, s.captured_at as shared_at
         FROM states s
         JOIN state_links sl_entity ON sl_entity.state_id = s.id
           AND sl_entity.entity_type = $1 AND sl_entity.entity_id = $2
         JOIN state_links sl_org ON sl_org.state_id = s.id AND sl_org.entity_type = 'organization'
         JOIN organizations o ON o.id = sl_org.entity_id::uuid
         WHERE s.organization_id::text != sl_org.entity_id::text
         ${accessCondition}
         ORDER BY s.captured_at DESC`,
        params
      );
      return { statusCode: 200, data: { shares: rows } };
    } finally {
      client.release();
    }
  }

  // DELETE /shares/{stateId} — unshare. Only a share state (one with an
  // 'organization' link) owned by an org the caller can access.
  if (httpMethod === 'DELETE' && path.match(/^\/shares\/[^/]+$/)) {
    const stateId = path.split('/')[2];
    const client = await getDbClient();
    try {
      const share = await client.query(
        `SELECT s.organization_id::text FROM states s
         WHERE s.id::text = $1
           AND EXISTS (SELECT 1 FROM state_links sl WHERE sl.state_id = s.id AND sl.entity_type = 'organization')`,
        [stateId]
      );
      if (!share.rows.length) return error(404, 'Share not found');
      if (!canAccess(share.rows[0].organization_id)) return error(403, 'Access denied to this share');
      await client.query('DELETE FROM state_links WHERE state_id = $1', [stateId]);
      await client.query('DELETE FROM states WHERE id = $1', [stateId]);
      return { statusCode: 200, data: { success: true } };
    } finally {
      client.release();
    }
  }

  // GET /shared-with-me?org_id=... — all entities shared with an org
  if (httpMethod === 'GET' && path === '/shared-with-me') {
    const orgId = query.org_id || auth.organizationId;
    if (!orgId) return error(400, 'org_id required');
    if (!canAccess(orgId)) return error(403, 'Access denied to this organization');
    const client = await getDbClient();
    try {
      const { rows } = await client.query(
        `SELECT s.id as state_id, sl_entity.entity_type, sl_entity.entity_id::text,
                s.state_text as note, s.organization_id::text as source_org_id,
                o.name as source_org_name, s.captured_at as shared_at
         FROM states s
         JOIN state_links sl_org ON sl_org.state_id = s.id
           AND sl_org.entity_type = 'organization'
           AND sl_org.entity_id IN (SELECT $1::uuid UNION SELECT mo.organization_id FROM member_organizations mo WHERE mo.member_organization_id = $1::uuid)
         JOIN state_links sl_entity ON sl_entity.state_id = s.id AND sl_entity.entity_type != 'organization'
         JOIN organizations o ON o.id = s.organization_id
         WHERE s.organization_id <> $1::uuid
         ORDER BY s.captured_at DESC`,
        [orgId]
      );
      return { statusCode: 200, data: { shared: rows } };
    } finally {
      client.release();
    }
  }

  return null;
}

module.exports = { handleShares };
