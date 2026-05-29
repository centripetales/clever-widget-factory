const { getAuthorizerContext, buildOrganizationFilter, hasPermission } = require('/opt/nodejs/authorizerContext');
const { getDbClient } = require('/opt/nodejs/db');
const { escapeLiteral } = require('/opt/nodejs/sqlUtils');

async function queryJSON(sql) {
  const client = await getDbClient();
  try {
    const result = await client.query(sql);
    return result.rows;
  } finally {
    client.release();
  }
}

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const { httpMethod, path: rawPath } = event;
  
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
    'Access-Control-Allow-Methods': 'GET,DELETE,OPTIONS'
  };
  
  if (httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  
  const path = rawPath.startsWith('/api/') ? rawPath.substring(4) : rawPath;
  console.log('🔍 History Lambda - Path:', path, 'Method:', httpMethod);
  
  const authContext = getAuthorizerContext(event);
  const organizationId = authContext.organization_id;
  const hasDataReadAll = hasPermission(authContext, 'data:read:all');
  
  try {
    // GET /history/tools/{id} - Tool history with observations
    if (httpMethod === 'GET' && path.match(/\/history\/tools\/[a-f0-9-]+$/)) {
      const toolId = path.split('/').pop();
      
      // Get asset info
      const assetSql = `SELECT created_at, updated_at FROM tools WHERE id::text = '${escapeLiteral(toolId)}';`;
      const assetResult = await queryJSON(assetSql);
      
      // Get checkouts
      const checkoutsSql = `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) as json_agg FROM (
        SELECT 
          c.id::text,
          c.tool_id::text,
          c.user_id::text,
          c.checkout_date,
          c.expected_return_date,
          c.is_returned,
          c.intended_usage,
          c.notes,
          c.action_id::text,
          c.organization_id::text,
          c.created_at,
          COALESCE(om.full_name, 'Unknown User') as user_display_name
        FROM checkouts c
        LEFT JOIN LATERAL (
          SELECT full_name FROM organization_members
          WHERE cognito_user_id::text = c.user_id::text
          LIMIT 1
        ) om ON true
        WHERE c.tool_id::text = '${escapeLiteral(toolId)}'
        ORDER BY c.checkout_date DESC
      ) t;`;
      const checkoutsResult = await queryJSON(checkoutsSql);
      
      // Get issues
      const issuesSql = `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) as json_agg FROM (
        SELECT 
          i.id::text,
          i.context_type,
          i.context_id::text,
          i.description,
          i.issue_type,
          i.status,
          i.workflow_status,
          i.reported_by::text,
          i.reported_at,
          i.resolved_at,
          i.resolved_by::text,
          i.organization_id::text,
          i.created_at,
          i.updated_at,
          COALESCE(om.full_name, i.reported_by::text) as reported_by_name
        FROM issues i
        LEFT JOIN LATERAL (
          SELECT full_name FROM organization_members
          WHERE cognito_user_id::text = i.reported_by::text
          LIMIT 1
        ) om ON true
        WHERE i.context_type = 'tool' AND i.context_id::text = '${escapeLiteral(toolId)}'
        ORDER BY i.reported_at DESC
      ) t;`;
      const issuesResult = await queryJSON(issuesSql);
      
      // Get actions — includes actions where this tool is the parent asset (asset_id)
      // AND actions where this tool appears in required_tools (by UUID)
      const actionsSql = `SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.created_at DESC), '[]'::json) as json_agg FROM (
        SELECT 
          a.id::text,
          a.title,
          a.description,
          a.status,
          a.assigned_to::text,
          a.asset_id::text,
          a.mission_id::text,
          a.organization_id::text,
          a.created_by::text,
          a.created_at,
          a.updated_at,
          a.completed_at,
          COALESCE(om.full_name, 'System') as created_by_name,
          COALESCE(assignee.full_name, '') as assigned_to_name
        FROM actions a
        LEFT JOIN LATERAL (
          SELECT full_name FROM organization_members
          WHERE cognito_user_id::text = a.created_by::text
          LIMIT 1
        ) om ON true
        LEFT JOIN LATERAL (
          SELECT full_name FROM organization_members
          WHERE user_id::text = a.assigned_to::text
          LIMIT 1
        ) assignee ON true
        WHERE a.asset_id::text = '${escapeLiteral(toolId)}'
           OR a.required_tools @> ARRAY['${escapeLiteral(toolId)}']::text[]
        ORDER BY a.created_at DESC
      ) t;`;
      const actionsResult = await queryJSON(actionsSql);
      
      // Get observations (states)
      const observationsSql = `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) as json_agg FROM (
        SELECT 
          s.id::text,
          s.state_text as observation_text,
          s.captured_by::text as observed_by,
          s.captured_at as observed_at,
          s.created_at,
          COALESCE(om.full_name, s.captured_by::text) as observed_by_name,
          (
            SELECT json_agg(json_build_object(
              'id', sp.id,
              'photo_url', sp.photo_url,
              'photo_description', sp.photo_description,
              'transcription', (
                SELECT s_trans.state_text 
                FROM state_links sl_trans
                JOIN states s_trans ON sl_trans.state_id = s_trans.id
                WHERE sl_trans.entity_type = 'state_photo' 
                  AND sl_trans.entity_id = sp.id 
                  AND s_trans.state_text LIKE '[photo_analysis]%'
                LIMIT 1
              ),
              'model_id', (
                SELECT COALESCE(pap.model_id, lgc.model_id)
                FROM state_links sl_trans
                JOIN states s_trans ON sl_trans.state_id = s_trans.id
                JOIN state_links sl_pap ON sl_pap.state_id = s_trans.id AND sl_pap.entity_type = 'photo_analysis_param'
                LEFT JOIN photo_analysis_params pap ON sl_pap.entity_id = pap.id
                LEFT JOIN llm_generation_configs lgc ON sl_pap.entity_id = lgc.id
                WHERE sl_trans.entity_type = 'state_photo' 
                  AND sl_trans.entity_id = sp.id 
                  AND s_trans.state_text LIKE '[photo_analysis]%'
                LIMIT 1
              ),
              'system_prompt', (
                SELECT COALESCE(pap.system_prompt, lgc.system_prompt)
                FROM state_links sl_trans
                JOIN states s_trans ON sl_trans.state_id = s_trans.id
                JOIN state_links sl_pap ON sl_pap.state_id = s_trans.id AND sl_pap.entity_type = 'photo_analysis_param'
                LEFT JOIN photo_analysis_params pap ON sl_pap.entity_id = pap.id
                LEFT JOIN llm_generation_configs lgc ON sl_pap.entity_id = lgc.id
                WHERE sl_trans.entity_type = 'state_photo' 
                  AND sl_trans.entity_id = sp.id 
                  AND s_trans.state_text LIKE '[photo_analysis]%'
                LIMIT 1
              )
            ) ORDER BY sp.photo_order)
            FROM state_photos sp
            WHERE sp.state_id = s.id
          ) as photos,
          (
            SELECT json_agg(json_build_object(
              'snapshot_id', ms.snapshot_id,
              'metric_id', ms.metric_id,
              'metric_name', m.name,
              'value', ms.value,
              'unit', m.unit,
              'notes', ms.notes
            ))
            FROM metric_snapshots ms
            JOIN metrics m ON ms.metric_id = m.metric_id
            WHERE ms.state_id = s.id
          ) as metrics
        FROM states s
        JOIN state_links sl ON sl.state_id = s.id
        LEFT JOIN LATERAL (
          SELECT full_name FROM organization_members
          WHERE cognito_user_id::text = s.captured_by::text
          LIMIT 1
        ) om ON true
        WHERE sl.entity_type = 'tool' AND sl.entity_id::text = '${escapeLiteral(toolId)}'
        ORDER BY s.captured_at DESC
      ) t;`;
      const observationsResult = await queryJSON(observationsSql);
      
      // Get asset history
      const assetHistorySql = `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) as json_agg FROM (
        SELECT 
          ah.id::text,
          ah.change_type,
          ah.field_changed,
          ah.old_value,
          ah.new_value,
          ah.changed_at,
          ah.notes,
          COALESCE(om.full_name, 'System') as user_name
        FROM asset_history ah
        LEFT JOIN LATERAL (
          SELECT full_name FROM organization_members
          WHERE cognito_user_id::text = ah.changed_by::text
          LIMIT 1
        ) om ON true
        WHERE ah.asset_id::text = '${escapeLiteral(toolId)}'
        ORDER BY ah.changed_at DESC
      ) t;`;
      const assetHistoryResult = await queryJSON(assetHistorySql);
      
      // Build timeline
      const asset = assetResult?.[0];
      const actions = actionsResult?.[0]?.json_agg || [];
      const observations = observationsResult?.[0]?.json_agg || [];
      const assetHistory = assetHistoryResult?.[0]?.json_agg || [];
      
      const timeline = [];
      
      assetHistory.forEach(ah => {
        const desc = ah.field_changed 
          ? `${ah.user_name} updated ${ah.field_changed}${ah.old_value && ah.new_value ? ` (${ah.old_value} → ${ah.new_value})` : ''}`
          : `${ah.user_name} ${ah.change_type === 'created' ? 'created asset' : 'updated asset'}`;
        timeline.push({
          type: 'asset_change',
          timestamp: ah.changed_at,
          description: desc,
          data: ah
        });
      });
      
      if (assetHistory.length === 0 && asset) {
        timeline.push({
          type: 'asset_created',
          timestamp: asset.created_at,
          description: 'Asset created'
        });
      }
      
      actions.forEach(a => {
        timeline.push({
          type: 'action_created',
          timestamp: a.created_at,
          description: `Action: ${a.title}`,
          data: a
        });
      });
      
      observations.forEach(o => {
        timeline.push({
          type: 'observation',
          timestamp: o.observed_at,
          description: `Observation by ${o.observed_by_name}`,
          data: o
        });
      });
      
      timeline.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          data: {
            asset: asset || null,
            actions,
            observations,
            timeline
          }
        })
      };
    }
    
    // GET /history/parts/{id} - Part history with observations
    if (httpMethod === 'GET' && path.match(/\/history\/parts\/[a-f0-9-]+$/)) {
      const partId = path.split('/').pop();
      
      // Get parts history
      let whereConditions = [];
      if (!hasDataReadAll && organizationId) {
        whereConditions.push(`ph.organization_id::text = '${escapeLiteral(organizationId)}'`);
      }
      whereConditions.push(`ph.part_id::text = '${escapeLiteral(partId)}'`);
      
      const whereClause = `WHERE ${whereConditions.join(' AND ')}`;
      
      const partHistorySql = `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) as json_agg FROM (
        SELECT 
          ph.*,
          COALESCE(om.full_name, ph.changed_by::text) as changed_by_name
        FROM parts_history ph
        LEFT JOIN LATERAL (
          SELECT full_name FROM organization_members
          WHERE cognito_user_id::text = ph.changed_by::text
          LIMIT 1
        ) om ON true
        ${whereClause} 
        ORDER BY ph.changed_at DESC 
        LIMIT 100
      ) t;`;
      const partHistoryResult = await queryJSON(partHistorySql);
      
      // Get observations for part (states)
      const observationsSql = `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) as json_agg FROM (
        SELECT 
          s.id::text,
          s.state_text as observation_text,
          s.captured_by::text as observed_by,
          s.captured_at as observed_at,
          s.created_at,
          COALESCE(om.full_name, s.captured_by::text) as observed_by_name,
          (
            SELECT json_agg(json_build_object(
              'id', sp.id,
              'photo_url', sp.photo_url,
              'photo_description', sp.photo_description,
              'transcription', (
                SELECT s_trans.state_text 
                FROM state_links sl_trans
                JOIN states s_trans ON sl_trans.state_id = s_trans.id
                WHERE sl_trans.entity_type = 'state_photo' 
                  AND sl_trans.entity_id = sp.id 
                  AND s_trans.state_text LIKE '[photo_analysis]%'
                LIMIT 1
              ),
              'model_id', (
                SELECT COALESCE(pap.model_id, lgc.model_id)
                FROM state_links sl_trans
                JOIN states s_trans ON sl_trans.state_id = s_trans.id
                JOIN state_links sl_pap ON sl_pap.state_id = s_trans.id AND sl_pap.entity_type = 'photo_analysis_param'
                LEFT JOIN photo_analysis_params pap ON sl_pap.entity_id = pap.id
                LEFT JOIN llm_generation_configs lgc ON sl_pap.entity_id = lgc.id
                WHERE sl_trans.entity_type = 'state_photo' 
                  AND sl_trans.entity_id = sp.id 
                  AND s_trans.state_text LIKE '[photo_analysis]%'
                LIMIT 1
              ),
              'system_prompt', (
                SELECT COALESCE(pap.system_prompt, lgc.system_prompt)
                FROM state_links sl_trans
                JOIN states s_trans ON sl_trans.state_id = s_trans.id
                JOIN state_links sl_pap ON sl_pap.state_id = s_trans.id AND sl_pap.entity_type = 'photo_analysis_param'
                LEFT JOIN photo_analysis_params pap ON sl_pap.entity_id = pap.id
                LEFT JOIN llm_generation_configs lgc ON sl_pap.entity_id = lgc.id
                WHERE sl_trans.entity_type = 'state_photo' 
                  AND sl_trans.entity_id = sp.id 
                  AND s_trans.state_text LIKE '[photo_analysis]%'
                LIMIT 1
              )
            ) ORDER BY sp.photo_order)
            FROM state_photos sp
            WHERE sp.state_id = s.id
          ) as photos,
          (
            SELECT json_agg(json_build_object(
              'snapshot_id', ms.snapshot_id,
              'metric_id', ms.metric_id,
              'metric_name', m.name,
              'value', ms.value,
              'unit', m.unit,
              'notes', ms.notes
            ))
            FROM metric_snapshots ms
            JOIN metrics m ON ms.metric_id = m.metric_id
            WHERE ms.state_id = s.id
          ) as metrics
        FROM states s
        JOIN state_links sl ON sl.state_id = s.id
        LEFT JOIN LATERAL (
          SELECT full_name FROM organization_members
          WHERE cognito_user_id::text = s.captured_by::text
          LIMIT 1
        ) om ON true
        WHERE sl.entity_type = 'part' AND sl.entity_id::text = '${escapeLiteral(partId)}'
        ORDER BY s.captured_at DESC
      ) t;`;
      const observationsResult = await queryJSON(observationsSql);
      
      // Get issues for part
      const issuesSql = `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) as json_agg FROM (
        SELECT 
          i.id::text,
          i.description,
          i.status,
          i.reported_by::text,
          i.reported_at,
          i.resolved_at,
          COALESCE(om.full_name, i.reported_by::text) as reported_by_name
        FROM issues i
        LEFT JOIN LATERAL (
          SELECT full_name FROM organization_members
          WHERE cognito_user_id::text = i.reported_by::text
          LIMIT 1
        ) om ON true
        WHERE i.context_type = 'inventory' AND i.context_id::text = '${escapeLiteral(partId)}'
        ORDER BY i.reported_at DESC
      ) t;`;
      const issuesResult = await queryJSON(issuesSql);
      
      // Get actions for part
      const actionsSql = `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) as json_agg FROM (
        SELECT 
          a.id::text,
          a.title,
          a.status,
          a.created_at,
          COALESCE(om.full_name, 'System') as created_by_name
        FROM actions a
        LEFT JOIN LATERAL (
          SELECT full_name FROM organization_members
          WHERE cognito_user_id::text = a.created_by::text
          LIMIT 1
        ) om ON true
        WHERE a.asset_id::text = '${escapeLiteral(partId)}'
        ORDER BY a.created_at DESC
      ) t;`;
      const actionsResult = await queryJSON(actionsSql);
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          data: {
            history: partHistoryResult?.[0]?.json_agg || [],
            observations: observationsResult?.[0]?.json_agg || [],
            issues: issuesResult?.[0]?.json_agg || [],
            actions: actionsResult?.[0]?.json_agg || []
          }
        })
      };
    }
    
    // DELETE /history/asset-history/{id} - Delete asset history entry
    if (httpMethod === 'DELETE' && path.match(/\/history\/asset-history\/[a-f0-9-]+$/)) {
      const historyId = path.split('/').pop();
      const userId = authContext.cognito_user_id;
      
      // Check if user created this history entry or is admin
      const checkSql = `
        SELECT changed_by, organization_id 
        FROM asset_history 
        WHERE id::text = '${escapeLiteral(historyId)}'
      `;
      const checkResult = await queryJSON(checkSql);
      
      if (checkResult.length === 0) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'History entry not found' })
        };
      }
      
      const historyEntry = checkResult[0];
      
      // Verify organization match
      if (historyEntry.organization_id !== organizationId) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'History entry does not belong to your organization' })
        };
      }
      
      // Check if user is creator or admin
      const isCreator = historyEntry.changed_by === userId;
      const isAdmin = hasPermission(authContext, 'data:write:all');
      
      if (!isCreator && !isAdmin) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'You do not have permission to delete this history entry' })
        };
      }
      
      // Delete the history entry
      const deleteSql = `
        DELETE FROM asset_history 
        WHERE id::text = '${escapeLiteral(historyId)}'
        RETURNING id
      `;
      await queryJSON(deleteSql);
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'History entry deleted', id: historyId })
      };
    }
    
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Not found' })
    };
    
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
