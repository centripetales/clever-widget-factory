import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || 'cwf-dev-postgres.ctmma86ykgeb.us-west-2.rds.amazonaws.com',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

async function executeQuery(query, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(query, params);
    return result;
  } finally {
    client.release();
  }
}

export const handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  const httpMethod = event.httpMethod || event.requestContext?.http?.method;
  const path = event.path || event.rawPath || '';
  const pathParams = event.pathParameters || {};
  
  // CORS headers for all responses
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  };
  
  // Extract organization_id from authorizer context
  const organizationId = event.requestContext?.authorizer?.organization_id;
  
  if (!organizationId) {
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Unauthorized: No organization context' })
    };
  }

  try {
    // GET /api/organizations/{id}/coverage-snapshots — every container shared
    // into org {id} (via the existing generic sharing mechanism, POST /shares),
    // bundled with each observation's photos/text/metrics — the same shape
    // lambda/history/index.js already returns per tool, so a group chart and
    // the "see that day's observation" click-through both come from this one
    // response, no second fetch needed.
    if (httpMethod === 'GET' && path.includes('/organizations/') && path.includes('/coverage-snapshots')) {
      const targetOrgId = pathParams.id;
      if (!targetOrgId) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Organization id is required' }) };
      }

      // Membership check: caller must have access to the target org — same
      // accessible_organization_ids the authorizer already computes from
      // organization_members for every other org-scoped endpoint.
      const accessibleOrgIds = (() => {
        const raw = event.requestContext?.authorizer?.accessible_organization_ids;
        if (!raw) return [];
        try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return []; }
      })();
      if (!accessibleOrgIds.includes(targetOrgId)) {
        return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Not a member of this organization' }) };
      }

      const sharedTools = await executeQuery(
        `SELECT DISTINCT sl_entity.entity_id::text as tool_id, t.name as tool_name,
                t.organization_id::text as source_org_id, so.name as source_org_name,
                (
                  SELECT om.settings ->> 'phone'
                  FROM organization_members om
                  WHERE om.organization_id = t.organization_id AND om.settings ->> 'phone' IS NOT NULL
                  LIMIT 1
                ) as source_phone
         FROM state_links sl_entity
         JOIN state_links sl_org ON sl_org.state_id = sl_entity.state_id AND sl_org.entity_type = 'organization'
         JOIN tools t ON t.id = sl_entity.entity_id
         JOIN organizations so ON so.id = t.organization_id
         WHERE sl_entity.entity_type = 'tool' AND sl_org.entity_id = $1`,
        [targetOrgId]
      );

      const containers = [];
      for (const tool of sharedTools.rows) {
        const actions = await executeQuery(
          `SELECT id::text, title, description, status, created_at, completed_at, scoring_data
           FROM actions
           WHERE asset_id = $1
           ORDER BY COALESCE(completed_at, created_at) ASC`,
          [tool.tool_id]
        );
        const obs = await executeQuery(
          `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) as json_agg FROM (
            SELECT
              s.id::text,
              s.state_text as observation_text,
              s.captured_by::text as observed_by,
              s.captured_at as observed_at,
              COALESCE(om.full_name, s.captured_by::text) as observed_by_name,
              (
                SELECT json_agg(json_build_object(
                  'id', sp.id, 'photo_url', sp.photo_url, 'photo_description', sp.photo_description,
                  'captured_at', pme.captured_at
                ) ORDER BY sp.photo_order)
                FROM state_photos sp
                LEFT JOIN photo_metadata_extractions pme ON pme.photo_url = sp.photo_url
                WHERE sp.state_id = s.id
              ) as photos,
              (
                SELECT json_agg(json_build_object(
                  'metric_id', ms.metric_id, 'metric_name', m.name, 'value', ms.value, 'unit', m.unit
                ))
                FROM metric_snapshots ms JOIN metrics m ON ms.metric_id = m.metric_id
                WHERE ms.state_id = s.id
              ) as metrics
            FROM states s
            JOIN state_links sl ON sl.state_id = s.id
            LEFT JOIN LATERAL (
              SELECT full_name FROM organization_members WHERE cognito_user_id::text = s.captured_by::text LIMIT 1
            ) om ON true
            WHERE sl.entity_type = 'tool' AND sl.entity_id::text = $1
            ORDER BY s.captured_at ASC
          ) t`,
          [tool.tool_id]
        );
        containers.push({
          toolId: tool.tool_id,
          toolName: tool.tool_name,
          sourceOrgId: tool.source_org_id,
          sourceOrgName: tool.source_org_name,
          sourcePhone: tool.source_phone,
          observations: obs.rows[0].json_agg,
          actions: actions.rows
        });
      }

      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ containers }) };
    }

    const toolId = pathParams.id; // API Gateway uses {id} not {tool_id}
    const metricId = pathParams.metric_id || pathParams.metricId;

    // GET /api/tools/{id}/metrics - List all metrics for a tool
    if (httpMethod === 'GET' && toolId && !metricId) {
      const result = await executeQuery(
        `SELECT metric_id, tool_id, name, unit, benchmark_value, details, created_at, organization_id
         FROM metrics
         WHERE tool_id = $1 AND organization_id = $2
         ORDER BY created_at DESC`,
        [toolId, organizationId]
      );

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ metrics: result.rows })
      };
    }

    // POST /api/tools/{id}/metrics - Create a new metric
    if (httpMethod === 'POST' && toolId) {
      const body = JSON.parse(event.body || '{}');
      const { name, unit, benchmark_value, details } = body;

      if (!name || !name.trim()) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'Name is required' })
        };
      }

      const result = await executeQuery(
        `INSERT INTO metrics (tool_id, name, unit, benchmark_value, details, organization_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING metric_id, tool_id, name, unit, benchmark_value, details, created_at, organization_id`,
        [toolId, name.trim(), unit || null, benchmark_value || null, details || null, organizationId]
      );

      return {
        statusCode: 201,
        headers: corsHeaders,
        body: JSON.stringify({ metric: result.rows[0] })
      };
    }

    // PUT /api/tools/{id}/metrics/{metric_id} - Update a metric
    if (httpMethod === 'PUT' && toolId && metricId) {
      const body = JSON.parse(event.body || '{}');
      const { name, unit, benchmark_value, details } = body;

      if (!name || !name.trim()) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'Name is required' })
        };
      }

      const result = await executeQuery(
        `UPDATE metrics
         SET name = $1, unit = $2, benchmark_value = $3, details = $4
         WHERE metric_id = $5 AND tool_id = $6 AND organization_id = $7
         RETURNING metric_id, tool_id, name, unit, benchmark_value, details, created_at, organization_id`,
        [name.trim(), unit || null, benchmark_value || null, details || null, metricId, toolId, organizationId]
      );

      if (result.rows.length === 0) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'Metric not found' })
        };
      }

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ metric: result.rows[0] })
      };
    }

    // DELETE /api/tools/{id}/metrics/{metric_id} - Delete a metric
    if (httpMethod === 'DELETE' && toolId && metricId) {
      const result = await executeQuery(
        `DELETE FROM metrics
         WHERE metric_id = $1 AND tool_id = $2 AND organization_id = $3
         RETURNING metric_id`,
        [metricId, toolId, organizationId]
      );

      if (result.rows.length === 0) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'Metric not found' })
        };
      }

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ success: true })
      };
    }

    // Route not found
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Route not found' })
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
};
