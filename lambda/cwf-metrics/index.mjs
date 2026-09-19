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
          `SELECT a.id::text, a.title, a.description, a.status, a.created_at, a.completed_at, a.scoring_data,
             (SELECT sp.content->>'content' FROM state_perspectives sp
              WHERE sp.action_id = a.id AND sp.perspective_type = 'CLAIM'
              ORDER BY sp.created_at DESC LIMIT 1) as claim
           FROM actions a
           WHERE a.asset_id = $1
           ORDER BY COALESCE(a.completed_at, a.created_at) ASC`,
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
                  -- Fall back to the observation's own submission time when
                  -- the photo has no EXIF/file timestamp (true for roughly
                  -- half of them) — same fallback
                  -- scripts/azolla-coverage-fetch-data.js already uses, so
                  -- every photo shows a time instead of about half going blank.
                  'captured_at', COALESCE(pme.captured_at, s.captured_at)
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
                WHERE ms.state_id = s.id AND m.active
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
        // Each experience's member ids, so the chart can draw it as a band
        // from its initial state to its final state with its actions on it.
        const experiences = await executeQuery(
          `SELECT e.id::text,
             COALESCE(json_agg(ec.state_id::text) FILTER (WHERE ec.component_type = 'initial_state'), '[]'::json) AS initial_state_ids,
             COALESCE(json_agg(ec.state_id::text) FILTER (WHERE ec.component_type = 'final_state'), '[]'::json) AS final_state_ids,
             COALESCE(json_agg(ec.action_id::text) FILTER (WHERE ec.component_type = 'action'), '[]'::json) AS action_ids
           FROM experiences e
           JOIN experience_components ec ON ec.experience_id = e.id
           WHERE e.entity_type = 'tool' AND e.entity_id::text = $1
           GROUP BY e.id`,
          [tool.tool_id]
        );
        containers.push({
          toolId: tool.tool_id,
          toolName: tool.tool_name,
          sourceOrgId: tool.source_org_id,
          sourceOrgName: tool.source_org_name,
          sourcePhone: tool.source_phone,
          observations: obs.rows[0].json_agg,
          actions: actions.rows,
          experiences: experiences.rows
        });
      }

      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ containers }) };
    }

    // GET /api/organizations/{id}/state-transition-graph — the observable-state
    // graph (docs/specs/azolla-impact-power-model.md §9). States are
    // reduced to the simplest possible signal — increasing or decreasing —
    // computed live, in this query, straight from the existing Coverage %
    // metric (metric_snapshots). This is deliberately NOT persisted
    // anywhere: an experience's initial_state and final_state are already
    // linked via experience_components, and each already links to its own
    // Coverage % reading via metric_snapshots, so "did coverage go up or
    // down" is a plain comparison of data that's already joined, not a new
    // fact to classify and store. Persisting it as its own row (an earlier,
    // reverted version of this did, as a STATE_TREND state_perspectives
    // row written by a one-off script) would also drift stale the moment
    // someone hand-corrects a Coverage % value via PUT /states/{id}/coverage
    // below. A chain's first initial_state (or any experience where
    // Coverage % is missing on either side) has no computable trend and
    // renders as an explicit "unclassified" node instead of silently
    // disappearing.
    //
    // Rebuilt around real `experiences` rows 2026-09-06 — each one a
    // deliberately-chained initial_state -> action(s) -> final_state
    // triple, already built by the older experiences/experience_components
    // pipeline. Before this, an intermediate version built edges from
    // "immediately preceding observation + any linked action," which
    // produced a confusing artifact: a self-loop like "struggling ->
    // struggling" showed up identically in both Ways In and Ways Out,
    // since it's simultaneously both to the naive adjacency rule. Using
    // real experiences fixes this at the root: a self-loop here
    // specifically means "a real, closed state-action-state unit whose
    // action didn't change the classified condition," not an arbitrary
    // artifact of which observation happened to come right before
    // another.
    //
    // Earlier still (before 2026-09-06), this was a manually-curated
    // multi-lane model (STATE_LANES) with per-dimension nodes/edges,
    // deleted for introducing dimensions (e.g. manure/compost) that were
    // really just actions, and for confusing "lane" terminology with the
    // system's own domain language.
    if (httpMethod === 'GET' && path.includes('/organizations/') && path.includes('/state-transition-graph')) {
      const targetOrgId = pathParams.id;
      if (!targetOrgId) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Organization id is required' }) };
      }

      const accessibleOrgIds = (() => {
        const raw = event.requestContext?.authorizer?.accessible_organization_ids;
        if (!raw) return [];
        try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return []; }
      })();
      if (!accessibleOrgIds.includes(targetOrgId)) {
        return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Not a member of this organization' }) };
      }

      const sharedTools = await executeQuery(
        `SELECT DISTINCT sl_entity.entity_id::text as tool_id, t.name as tool_name
         FROM state_links sl_entity
         JOIN state_links sl_org ON sl_org.state_id = sl_entity.state_id AND sl_org.entity_type = 'organization'
         JOIN tools t ON t.id = sl_entity.entity_id
         WHERE sl_entity.entity_type = 'tool' AND sl_org.entity_id = $1`,
        [targetOrgId]
      );
      const toolIds = sharedTools.rows.map((r) => r.tool_id);
      const toolNameById = new Map(sharedTools.rows.map((r) => [r.tool_id, r.tool_name]));
      if (toolIds.length === 0) {
        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ nodes: [], edges: [] }) };
      }

      // Every real experience for these containers, with its initial/final
      // states' raw Coverage % reading (trend is computed from these below
      // — not classified/stored), CLAIM text, and photos, plus whatever
      // action(s) are attached to the experience itself (experiences are
      // action-gated by design — §5a — so every experience here has at
      // least one real action, no "no action reported" case needed).
      // final_state is a LEFT JOIN, not inner: an experience with an
      // initial_state and an action but no final_state yet is a normal,
      // intentional in-progress experiment (see POST /api/experiences in
      // lambda/experiences/index.js) — these rows come back with every
      // final_* column NULL rather than being silently excluded.
      const experienceRows = await executeQuery(
        `SELECT
           e.id AS experience_id, e.entity_id::text AS tool_id,
           init_s.id AS initial_state_id, init_s.captured_at AS initial_captured_at,
           init_coverage.value AS initial_coverage,
           (SELECT sp.content->>'content' FROM state_perspectives sp
            WHERE sp.state_id = init_s.id AND sp.perspective_type = 'CLAIM'
            ORDER BY sp.created_at DESC LIMIT 1) AS initial_claim,
           (SELECT json_agg(json_build_object('url', ph.photo_url, 'description', ph.photo_description) ORDER BY ph.photo_order)
            FROM state_photos ph WHERE ph.state_id = init_s.id) AS initial_photos,
           final_s.id AS final_state_id, final_s.captured_at AS final_captured_at,
           final_coverage.value AS final_coverage,
           (SELECT sp.content->>'content' FROM state_perspectives sp
            WHERE sp.state_id = final_s.id AND sp.perspective_type = 'CLAIM'
            ORDER BY sp.created_at DESC LIMIT 1) AS final_claim,
           (SELECT json_agg(json_build_object('url', ph.photo_url, 'description', ph.photo_description) ORDER BY ph.photo_order)
            FROM state_photos ph WHERE ph.state_id = final_s.id) AS final_photos,
           COALESCE(
             json_agg(DISTINCT jsonb_build_object('id', a.id::text, 'title', a.title)) FILTER (WHERE a.id IS NOT NULL),
             '[]'::json
           ) AS actions
         FROM experiences e
         JOIN experience_components ec_init ON ec_init.experience_id = e.id AND ec_init.component_type = 'initial_state'
         JOIN states init_s ON init_s.id = ec_init.state_id
         LEFT JOIN metric_snapshots init_coverage ON init_coverage.state_id = init_s.id
           AND init_coverage.metric_id IN (SELECT metric_id FROM metrics WHERE name = 'Coverage %')
         LEFT JOIN experience_components ec_final ON ec_final.experience_id = e.id AND ec_final.component_type = 'final_state'
         LEFT JOIN states final_s ON final_s.id = ec_final.state_id
         LEFT JOIN metric_snapshots final_coverage ON final_coverage.state_id = final_s.id
           AND final_coverage.metric_id IN (SELECT metric_id FROM metrics WHERE name = 'Coverage %')
         LEFT JOIN experience_components ec_action ON ec_action.experience_id = e.id AND ec_action.component_type = 'action'
         LEFT JOIN actions a ON a.id = ec_action.action_id
         WHERE e.entity_type = 'tool' AND e.entity_id = ANY($1::uuid[])
         GROUP BY e.id, e.entity_id, init_s.id, init_coverage.value, final_s.id, final_coverage.value`,
        [toolIds]
      );

      // A state's trend describes the transition INTO it: compare this
      // experience's own initial/final Coverage % directly (not "this
      // state vs. whatever preceded it elsewhere") — missing or equal
      // values return null, i.e. no directional signal to force.
      const trendOf = (initialCoverage, finalCoverage) => {
        if (initialCoverage === null || finalCoverage === null) return null;
        const init = parseFloat(initialCoverage);
        const final = parseFloat(finalCoverage);
        if (final > init) return 'increasing';
        if (final < init) return 'decreasing';
        return null;
      };

      const nodesByKey = new Map();
      const edgesByKey = new Map();
      const evidenceOf = (stateId, toolId, capturedAt, claim, photos, actions) => ({
        state_id: stateId,
        tool_id: toolId,
        tool_name: toolNameById.get(toolId),
        captured_at: capturedAt,
        claim,
        photos: photos || [],
        actions: actions || [],
      });

      const touchNode = (value, toolId, evidence, daysDelta) => {
        const key = value || 'unclassified';
        if (!nodesByKey.has(key)) {
          nodesByKey.set(key, { key, value: key, state_count: 0, tool_ids: new Set(), total_days: 0, examples: [] });
        }
        const node = nodesByKey.get(key);
        node.state_count += 1;
        node.tool_ids.add(toolId);
        node.total_days += daysDelta;
        node.examples.push(evidence);
      };

      // A chain resolves correctly across experiences: a state's bucket
      // comes from being SOME experience's final_state, so the middle state
      // of e.g. Lesterluna's 60% -> 25% -> 15% chain gets its bucket from
      // experience 1 (where it's the final_state), not from experience 2
      // (where it's the initial_state and has no comparison of its own).
      const trendByStateId = new Map();
      for (const row of experienceRows.rows) {
        if (row.final_state_id) {
          trendByStateId.set(row.final_state_id, trendOf(row.initial_coverage, row.final_coverage));
        }
      }

      for (const row of experienceRows.rows) {
        const toolId = row.tool_id;
        const isInProgress = !row.final_state_id;
        const initialEvidence = evidenceOf(row.initial_state_id, toolId, row.initial_captured_at, row.initial_claim, row.initial_photos, row.actions);
        const finalEvidence = isInProgress
          ? null
          : evidenceOf(row.final_state_id, toolId, row.final_captured_at, row.final_claim, row.final_photos, row.actions);

        // "Days this state represents": how long between this experience's
        // initial and final observation (or, for an in-progress experience
        // with no final observation yet, how long it's been running so
        // far) — scoped to experience-bracketed occurrences only,
        // consistent with what this graph now shows.
        const daysDelta = (isInProgress ? new Date() : new Date(row.final_captured_at)) - new Date(row.initial_captured_at);
        touchNode(trendByStateId.get(row.initial_state_id), toolId, initialEvidence, daysDelta / 86400000);
        if (!isInProgress) touchNode(trendByStateId.get(row.final_state_id), toolId, finalEvidence, 0);

        const fromKey = trendByStateId.get(row.initial_state_id) || 'unclassified';
        const toKey = isInProgress ? 'unclassified' : (trendByStateId.get(row.final_state_id) || 'unclassified');
        const edgeKey = `${fromKey}=>${toKey}`;
        if (!edgesByKey.has(edgeKey)) {
          edgesByKey.set(edgeKey, { from: fromKey, to: toKey, count: 0, tool_ids: new Set(), examples: [] });
        }
        const edge = edgesByKey.get(edgeKey);
        edge.count += 1;
        edge.tool_ids.add(toolId);
        edge.examples.push({ tool_name: toolNameById.get(toolId), from: initialEvidence, to: finalEvidence, actions: row.actions || [], experience_id: row.experience_id });
      }

      const nodes = [...nodesByKey.values()].map((n) => ({
        key: n.key,
        value: n.value,
        state_count: n.state_count,
        tool_ids: [...n.tool_ids],
        tool_names: [...n.tool_ids].map((id) => toolNameById.get(id)),
        distinct_org_count: n.tool_ids.size,
        total_days: Math.round(n.total_days * 10) / 10,
        examples: n.examples,
      }));
      const edges = [...edgesByKey.values()].map((e) => ({
        from: e.from,
        to: e.to,
        count: e.count,
        tool_ids: [...e.tool_ids],
        tool_names: [...e.tool_ids].map((id) => toolNameById.get(id)),
        examples: e.examples,
      }));

      // Raw, unaggregated experience list — every experience feeding the
      // graph above, one row each, for the audit table: a person can see
      // exactly what data produced the graph and jump straight to fixing
      // any experience that looks wrong at /experiences/{id}.
      const experiences = experienceRows.rows.map((row) => ({
        experience_id: row.experience_id,
        tool_id: row.tool_id,
        tool_name: toolNameById.get(row.tool_id),
        initial: {
          state_id: row.initial_state_id,
          captured_at: row.initial_captured_at,
          claim: row.initial_claim,
        },
        final: row.final_state_id
          ? { state_id: row.final_state_id, captured_at: row.final_captured_at, claim: row.final_claim }
          : null,
        actions: row.actions,
      }));

      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ nodes, edges, experiences }) };
    }

    // PUT /api/states/{id}/coverage — lets the observation's owner (or an
    // org admin, same rule as ToolDetails.tsx's canEditObservation: creator
    // OR admin in the currently-active org) hand-correct the Coverage %
    // value shown for that observation. Sets edited_by/edited_at so
    // scripts/azolla-wire-coverage-metric.js's automated rewrite skips this
    // row on future reruns instead of silently overwriting the correction
    // (see migration 024).
    if (httpMethod === 'PUT' && path.includes('/states/') && path.includes('/coverage')) {
      const stateId = pathParams.id;
      const authorizer = event.requestContext?.authorizer || {};
      const userId = authorizer.cognito_user_id || authorizer.context?.cognito_user_id;
      const userRole = authorizer.user_role || authorizer.context?.user_role;

      if (!stateId) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'State id is required' }) };
      }
      const body = JSON.parse(event.body || '{}');
      const value = Number(body.value);
      if (body.value === undefined || body.value === null || Number.isNaN(value) || value < 0 || value > 100) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'value must be a number between 0 and 100' }) };
      }

      const stateRes = await executeQuery(
        `SELECT captured_by::text as captured_by, organization_id::text as organization_id FROM states WHERE id = $1`,
        [stateId]
      );
      if (stateRes.rows.length === 0) {
        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Observation not found' }) };
      }
      const state = stateRes.rows[0];
      const isCreator = state.captured_by === userId;
      const isAdmin = userRole === 'admin' && state.organization_id === organizationId;
      if (!isCreator && !isAdmin) {
        return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Only the observation owner or an org admin can edit this' }) };
      }

      const updated = await executeQuery(
        `UPDATE metric_snapshots ms
         SET value = $1, edited_by = $2, edited_at = NOW(), updated_at = NOW()
         FROM metrics m
         WHERE ms.metric_id = m.metric_id AND m.name = 'Coverage %' AND ms.state_id = $3
         RETURNING ms.snapshot_id, ms.value`,
        [value.toFixed(2), userId, stateId]
      );
      if (updated.rows.length === 0) {
        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'No Coverage % metric on this observation' }) };
      }

      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ value: updated.rows[0].value }) };
    }

    const toolId = pathParams.id; // API Gateway uses {id} not {tool_id}
    const metricId = pathParams.metric_id || pathParams.metricId;

    // GET /api/tools/{id}/metrics - List all metrics for a tool
    if (httpMethod === 'GET' && toolId && !metricId) {
      const result = await executeQuery(
        `SELECT metric_id, tool_id, name, unit, benchmark_value, details, active, created_at, organization_id
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
         RETURNING metric_id, tool_id, name, unit, benchmark_value, details, active, created_at, organization_id`,
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
      const { name, unit, benchmark_value, details, active } = body;

      if (!name || !name.trim()) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'Name is required' })
        };
      }

      const result = await executeQuery(
        `UPDATE metrics
         SET name = $1, unit = $2, benchmark_value = $3, details = $4, active = $5
         WHERE metric_id = $6 AND tool_id = $7 AND organization_id = $8
         RETURNING metric_id, tool_id, name, unit, benchmark_value, details, active, created_at, organization_id`,
        [name.trim(), unit || null, benchmark_value || null, details || null, active !== false, metricId, toolId, organizationId]
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
