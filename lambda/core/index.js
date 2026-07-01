const { randomUUID } = require('crypto');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { getAuthorizerContext, buildOrganizationFilter, hasPermission, canAccessOrganization } = require('/opt/nodejs/authorizerContext');
const { composePartEmbeddingSource, composeToolEmbeddingSource, composeIssueEmbeddingSource, composePolicyEmbeddingSource } = require('/opt/nodejs/embedding-composition');
const { getDbClient } = require('/opt/nodejs/db');
const { escapeLiteral, formatSqlValue, buildUpdateClauses } = require('/opt/nodejs/sqlUtils');
const { broadcastInvalidation } = require('/opt/nodejs/broadcastInvalidation');
const { fetchAiConfig, resolveAiConfig, isValidInt, isValidFloat } = require('/opt/nodejs/aiConfigDefaults');
const { SYSTEM_LENSES, MAX_CUSTOM_LENSES, MAX_GAP_BOOST_RULES } = require('/opt/nodejs/lensDefaults');

const sqs = new SQSClient({ region: 'us-west-2' });
const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';

// Helper to execute SQL and return JSON
async function queryJSON(sql, params = []) {
  const client = await getDbClient();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    client.release();
  }
}



exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const { httpMethod, path: rawPath } = event;
  
  // CORS headers (define early for all responses including OPTIONS)
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
  };
  
  // Handle preflight OPTIONS requests immediately - no authorization needed
  if (httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }
  
  // Normalize path - strip /api prefix if present (API Gateway may include it)
  const path = rawPath.startsWith('/api/') ? rawPath.substring(4) : rawPath;
  console.log('🔍 Path received:', path);
  console.log('🔍 HTTP Method:', httpMethod);
  
  // Extract authorizer context (organization_id, permissions, etc.)
  const authContext = getAuthorizerContext(event);
  const organizationId = authContext.organization_id;
  const hasDataReadAll = hasPermission(authContext, 'data:read:all');
  
  // Log auth context for debugging (especially for organization_members endpoint)
  if (path.includes('organization_members') || path.includes('organizations')) {
    console.log('🔍 [CORE LAMBDA] Auth context received:', {
      cognito_user_id: authContext.cognito_user_id,
      organization_id: organizationId,
      accessible_organization_ids: authContext.accessible_organization_ids,
      accessible_organization_ids_count: authContext.accessible_organization_ids?.length || 0,
      organization_memberships: authContext.organization_memberships,
      organization_memberships_count: authContext.organization_memberships?.length || 0,
      permissions: authContext.permissions,
      has_data_read_all: hasDataReadAll,
      user_role: authContext.user_role
    });
  }
  
  // Log error if organization_id is missing - don't use fallback to hide problems
  if (!organizationId) {
    console.error('❌ ERROR: organization_id is missing from authorizer context!');
    console.error('   This indicates a problem with the Lambda authorizer configuration.');
    console.error('   Authorizer context:', JSON.stringify(authContext, null, 2));
    console.error('   Event requestContext:', JSON.stringify(event.requestContext, null, 2));
  }
  
  // Set accessibleOrgIds from authContext (may be empty for some endpoints like profiles)
  const accessibleOrgIds = authContext.accessible_organization_ids || [];
  
  console.log('Authorizer context:', {
    organization_id: organizationId || 'MISSING',
    accessible_orgs: accessibleOrgIds,
    accessible_orgs_count: accessibleOrgIds.length,
    has_data_read_all: hasDataReadAll,
    permissions: authContext.permissions
  });
  
  try {

    // Health check endpoint
    if (httpMethod === 'GET' && path.endsWith('/health')) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() })
      };
    }

    // Schema endpoint
    if (httpMethod === 'GET' && path.endsWith('/schema')) {
      const schema = {
        version: 1,
        tables: {
          actions: ['id', 'title', 'description', 'assigned_to', 'status', 'created_at', 'updated_at'],
          tools: ['id', 'name', 'description', 'category', 'status', 'serial_number', 'storage_location'],
          parts: ['id', 'name', 'description', 'category', 'current_quantity', 'minimum_quantity'],
          organization_members: ['user_id', 'full_name', 'role'],
          missions: ['id', 'title', 'description', 'created_by', 'created_at', 'updated_at']
        },
        last_updated: Date.now()
      };
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(schema)
      };
    }



    // Tools endpoint
    
    // Tools Geolocation endpoint
    if (httpMethod === 'GET' && path.match(/\/tools\/[a-f0-9-]+\/geolocation$/)) {
      const toolId = path.split('/')[2];
      const sql = `
        SELECT 
          pme.gps_latitude as lat, 
          pme.gps_longitude as lon,
          'tool_image' as source
        FROM tools t
        JOIN photo_metadata_extractions pme ON pme.photo_url LIKE '%' || split_part(t.image_url, '/', -1)
        WHERE t.id = '${escapeLiteral(toolId)}'
          AND t.image_url IS NOT NULL 
          AND t.image_url != ''
          AND pme.gps_latitude IS NOT NULL
        UNION ALL
        SELECT 
          pme.gps_latitude as lat, 
          pme.gps_longitude as lon,
          'state_photo' as source
        FROM state_photos sp
        JOIN state_links sl ON sl.state_id = sp.state_id
        JOIN photo_metadata_extractions pme ON pme.photo_url LIKE '%' || split_part(sp.photo_url, '/', -1)
        WHERE sl.entity_id = '${escapeLiteral(toolId)}' 
          AND sl.entity_type = 'tool'
          AND pme.gps_latitude IS NOT NULL
        LIMIT 1;
      `;
      const result = await queryJSON(sql);
      if (result && result.length > 0) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      } else {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Geolocation not found' })
        };
      }
    }

    // Parts Geolocation endpoint
    if (httpMethod === 'GET' && path.match(/\/parts\/[a-f0-9-]+\/geolocation$/)) {
      const partId = path.split('/')[2];
      const sql = `
        SELECT 
          pme.gps_latitude as lat, 
          pme.gps_longitude as lon,
          'part_image' as source
        FROM parts p
        JOIN photo_metadata_extractions pme ON pme.photo_url LIKE '%' || split_part(p.image_url, '/', -1)
        WHERE p.id = '${escapeLiteral(partId)}'
          AND p.image_url IS NOT NULL 
          AND p.image_url != ''
          AND pme.gps_latitude IS NOT NULL
        UNION ALL
        SELECT 
          pme.gps_latitude as lat, 
          pme.gps_longitude as lon,
          'state_photo' as source
        FROM state_photos sp
        JOIN state_links sl ON sl.state_id = sp.state_id
        JOIN photo_metadata_extractions pme ON pme.photo_url LIKE '%' || split_part(sp.photo_url, '/', -1)
        WHERE sl.entity_id = '${escapeLiteral(partId)}' 
          AND sl.entity_type = 'part'
          AND pme.gps_latitude IS NOT NULL
        LIMIT 1;
      `;
      const result = await queryJSON(sql);
      if (result && result.length > 0) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      } else {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Geolocation not found' })
        };
      }
    }

    if (path.endsWith('/tools') || path.match(/\/tools\/[a-f0-9-]+$/)) {
      if (httpMethod === 'POST' && path.endsWith('/tools')) {
        const body = JSON.parse(event.body || '{}');
        if (!body.name) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'name is required' })
          };
        }
        
        const toolId = randomUUID();
        const userId = authContext.cognito_user_id;
        
        const insertSql = `
          INSERT INTO tools (
            id, name, description, category, status, serial_number,
            parent_structure_id, storage_location, legacy_storage_vicinity,
            accountable_person_id, image_url, policy, organization_id, created_at, updated_at
          ) VALUES (
            '${toolId}',
            ${formatSqlValue(body.name)},
            ${formatSqlValue(body.description)},
            ${formatSqlValue(body.category)},
            ${formatSqlValue(body.status || 'available')},
            ${formatSqlValue(body.serial_number)},
            ${formatSqlValue(body.parent_structure_id)},
            ${formatSqlValue(body.storage_location)},
            ${formatSqlValue(body.legacy_storage_vicinity)},
            ${formatSqlValue(body.accountable_person_id)},
            ${formatSqlValue(body.image_url)},
            ${formatSqlValue(body.policy)},
            ${formatSqlValue(organizationId)},
            NOW(),
            NOW()
          ) RETURNING *`;
        
        const result = await queryJSON(insertSql);
        
        // Log creation to asset_history
        if (userId && organizationId) {
          console.log('📝 Logging asset creation:', { toolId, userId, organizationId });
          const historySql = `INSERT INTO asset_history (asset_id, change_type, changed_by, organization_id, changed_at) VALUES ('${toolId}', 'created', '${userId}', '${organizationId}', NOW())`;
          await queryJSON(historySql).catch(e => console.error('History log error:', e));
        }
        
        // Send SQS message for embedding generation
        const tool = result[0];
        const embeddingSource = composeToolEmbeddingSource(tool);
        
        if (embeddingSource && embeddingSource.trim()) {
          try {
            await sqs.send(new SendMessageCommand({
              QueueUrl: EMBEDDINGS_QUEUE_URL,
              MessageBody: JSON.stringify({
                entity_type: 'tool',
                entity_id: toolId,
                embedding_source: embeddingSource,
                organization_id: organizationId
              })
            }));
            console.log('Queued embedding generation for tool', toolId);
          } catch (sqsError) {
            console.error('Failed to queue embedding:', sqsError);
            // Non-fatal - continue with response
          }
        }
        
        // Broadcast cache invalidation to WebSocket clients
        try {
          await broadcastInvalidation({
            entityType: 'tool',
            entityId: toolId,
            mutationType: 'created',
            organizationId,
            excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
          });
        } catch (err) {
          console.error('[CORE] Broadcast failed:', err.message);
        }
        
        return {
          statusCode: 201,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      }
      
      if (httpMethod === 'PUT') {
        const toolId = path.split('/').pop();
        const body = JSON.parse(event.body || '{}');
        
        // Fetch current tool data to compare changes
        const currentToolSql = `SELECT * FROM tools WHERE id = '${toolId}'`;
        const currentToolResult = await queryJSON(currentToolSql);
        const currentTool = currentToolResult[0];
        
        if (!currentTool) {
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Tool not found' })
          };
        }
        
        const updates = buildUpdateClauses(body, [
          'status',
          'actual_location',
          'storage_location',
          'legacy_storage_vicinity',
          'parent_structure_id',
          'name',
          'description',
          'category',
          'serial_number',
          'accountable_person_id',
          'image_url',
          'policy'
        ]);
        if (updates.length === 0) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'No fields to update' })
          };
        }
        updates.push('updated_at = NOW()');
        const sql = `UPDATE tools SET ${updates.join(', ')} WHERE id = '${toolId}' RETURNING *`;
        const result = await queryJSON(sql);
        
        // Log to asset_history - only log fields that actually changed
        const userId = authContext.cognito_user_id;
        if (userId && organizationId) {
          console.log('📝 Logging asset update:', { toolId, userId, organizationId });
          const trackableFields = ['status','actual_location','storage_location','name','description','category','serial_number','policy','parent_structure_id','accountable_person_id'];
          const changedFields = Object.keys(body).filter(k => {
            if (!trackableFields.includes(k)) return false;
            // Compare old and new values - only log if different
            const oldValue = currentTool[k];
            const newValue = body[k];
            // Handle null/undefined/empty string as equivalent
            const normalizedOld = oldValue === null || oldValue === undefined ? '' : String(oldValue);
            const normalizedNew = newValue === null || newValue === undefined ? '' : String(newValue);
            return normalizedOld !== normalizedNew;
          });
          
          for (const field of changedFields) {
            const oldValue = currentTool[field];
            const newValue = body[field];
            // Deduplicate: skip if an identical history entry exists within the last 5 minutes
            // (prevents duplicate entries from rapid saves or concurrent requests)
            const dedupeCheck = await queryJSON(
              `SELECT id FROM asset_history WHERE asset_id = '${toolId}' AND field_changed = '${field}' AND new_value = ${formatSqlValue(newValue)} AND changed_at > NOW() - INTERVAL '5 minutes' LIMIT 1`
            ).catch(() => []);
            if (dedupeCheck.length > 0) continue;
            const historySql = `INSERT INTO asset_history (asset_id, change_type, field_changed, old_value, new_value, changed_by, organization_id, changed_at) VALUES ('${toolId}', 'updated', '${field}', ${formatSqlValue(oldValue)}, ${formatSqlValue(newValue)}, '${userId}', '${organizationId}', NOW())`;
            await queryJSON(historySql).catch(e => console.error('History log error:', e));
          }
        }
        
        // Trigger embedding regeneration if name, description, or policy changed
        if (body.name !== undefined || body.description !== undefined || body.policy !== undefined) {
          const tool = result[0];
          const embeddingSource = composeToolEmbeddingSource(tool);
          
          if (embeddingSource && embeddingSource.trim()) {
            try {
              await sqs.send(new SendMessageCommand({
                QueueUrl: EMBEDDINGS_QUEUE_URL,
                MessageBody: JSON.stringify({
                  entity_type: 'tool',
                  entity_id: toolId,
                  embedding_source: embeddingSource,
                  organization_id: organizationId
                })
              }));
              console.log('Queued embedding generation for tool', toolId);
            } catch (sqsError) {
              console.error('Failed to queue embedding:', sqsError);
              // Non-fatal - continue with response
            }
          }
        }
        
        // Broadcast cache invalidation to WebSocket clients
        try {
          await broadcastInvalidation({
            entityType: 'tool',
            entityId: toolId,
            mutationType: 'updated',
            organizationId,
            excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
          });
        } catch (err) {
          console.error('[CORE] Broadcast failed:', err.message);
        }
        
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      }
      
      if (httpMethod === 'GET' && path.match(/\/tools\/[a-f0-9-]+$/)) {
        const toolId = path.split('/').pop();
        const orgFilter = buildOrganizationFilter(authContext, 'tools');
        let orgCondition = orgFilter.condition ? `AND ${orgFilter.condition}` : '';
        const sql = `SELECT json_agg(row_to_json(result)) FROM (
          SELECT 
            tools.*,
            parent_tool.name as parent_structure_name,
            parent_tool.name as area_display,
            CASE 
              WHEN active_checkouts.id IS NOT NULL THEN 'checked_out'
              ELSE tools.status
            END as status,
            CASE WHEN tools.image_url LIKE '%supabase.co%' THEN 
              REPLACE(
                tools.image_url, 
                'https://oskwnlhuuxjfuwnjuavn.supabase.co/storage/v1/object/public/', 
                'https://cwf-dev-assets.s3.us-west-2.amazonaws.com/'
              )
            ELSE tools.image_url 
            END as image_url,
            CASE WHEN active_checkouts.id IS NOT NULL THEN true ELSE false END as is_checked_out,
            active_checkouts.user_id as checked_out_user_id,
            om_checkout.full_name as checked_out_to,
            active_checkouts.checkout_date as checked_out_date,
            active_checkouts.expected_return_date,
            active_checkouts.intended_usage as checkout_intended_usage,
            active_checkouts.notes as checkout_notes,
            active_checkouts.action_id as checkout_action_id
          FROM tools
          LEFT JOIN tools parent_tool ON tools.parent_structure_id = parent_tool.id
          LEFT JOIN LATERAL (
            SELECT * FROM checkouts
            WHERE checkouts.tool_id = tools.id
              AND checkouts.is_returned = false
            ORDER BY checkouts.checkout_date DESC NULLS LAST, checkouts.created_at DESC
            LIMIT 1
          ) active_checkouts ON true
          LEFT JOIN LATERAL (
            SELECT full_name FROM organization_members
            WHERE cognito_user_id = active_checkouts.user_id
            LIMIT 1
          ) om_checkout ON true
          WHERE tools.id = '${escapeLiteral(toolId)}' ${orgCondition}
        ) result;`;
        
        const result = await queryJSON(sql);
        if (!result || result.length === 0 || !result[0] || !result[0].json_agg || result[0].json_agg.length === 0) {
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Tool not found' })
          };
        }
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result[0].json_agg[0] })
        };
      }
      
      if (httpMethod === 'GET') {
        const { limit = 50, offset = 0, category, status, view_shared } = event.queryStringParameters || {};
        
        // Build WHERE clauses for filtering
        const whereClauses = [];
        
        // Add organization filter
        if (organizationId && view_shared) {
          const sharedArray = Array.isArray(view_shared) ? view_shared : view_shared.split(',');
          const sharedOrgsStr = sharedArray.map(id => `'${escapeLiteral(id)}'`).join(',');
          whereClauses.push(`(
            tools.organization_id::text = '${escapeLiteral(organizationId)}'
            OR tools.id IN (
              SELECT sl1.entity_id
              FROM state_links sl1
              JOIN state_links sl2 ON sl1.state_id = sl2.state_id
              JOIN states s ON s.id = sl1.state_id
              WHERE sl1.entity_type = 'tool'
                AND sl2.entity_type = 'organization'
                AND sl2.entity_id::text = '${escapeLiteral(organizationId)}'
                AND s.organization_id::text IN (${sharedOrgsStr})
            )
          )`);
        } else {
          const orgFilter = buildOrganizationFilter(authContext, 'tools');
          if (orgFilter.condition) {
            whereClauses.push(orgFilter.condition);
          }
        }
        
        // Handle category filter (supports comma-separated values like "Infrastructure,Container")
        if (category) {
          const categories = category.split(',').map(c => c.trim()).filter(c => c.length > 0);
          if (categories.length === 1) {
            whereClauses.push(`tools.category = ${formatSqlValue(categories[0])}`);
          } else if (categories.length > 1) {
            const categoryValues = categories.map(c => formatSqlValue(c)).join(', ');
            whereClauses.push(`tools.category IN (${categoryValues})`);
          }
        }
        
        // Handle status filter (supports "!removed" or "!=removed" syntax)
        if (status) {
          if (status === '!removed' || status === '!=removed') {
            whereClauses.push(`tools.status != 'removed'`);
          } else {
            whereClauses.push(`tools.status = ${formatSqlValue(status)}`);
          }
        }
        
        const whereClause = whereClauses.length > 0 
          ? `WHERE ${whereClauses.join(' AND ')}`
          : '';
        
        const sql = `SELECT json_agg(row_to_json(result)) FROM (
          SELECT DISTINCT ON (tools.id)
            tools.id, tools.name, tools.description, tools.category,
            tools.actual_location, tools.serial_number, tools.last_maintenance,
            tools.manual_url, tools.known_issues, tools.has_motor, tools.policy,
            tools.storage_location, tools.last_audited_at, tools.audit_status,
            tools.parent_structure_id, tools.organization_id, tools.accountable_person_id,
            tools.created_at, tools.updated_at,
            parent_tool.name as parent_structure_name,
            parent_tool.name as area_display,
            CASE 
              WHEN active_checkouts.id IS NOT NULL THEN 'checked_out'
              ELSE tools.status
            END as status,
            CASE WHEN tools.image_url LIKE '%supabase.co%' THEN 
              REPLACE(
                tools.image_url, 
                'https://oskwnlhuuxjfuwnjuavn.supabase.co/storage/v1/object/public/', 
                'https://cwf-dev-assets.s3.us-west-2.amazonaws.com/'
              )
            ELSE tools.image_url 
            END as image_url,
            CASE WHEN active_checkouts.id IS NOT NULL THEN true ELSE false END as is_checked_out,
            active_checkouts.user_id as checked_out_user_id,
            om_checkout.full_name as checked_out_to,
            active_checkouts.checkout_date as checked_out_date,
            active_checkouts.expected_return_date,
            active_checkouts.intended_usage as checkout_intended_usage,
            active_checkouts.notes as checkout_notes,
            active_checkouts.action_id as checkout_action_id,
            tool_gps.gps_latitude, tool_gps.gps_longitude,
            CASE WHEN tools.organization_id::text != '${escapeLiteral(organizationId)}' THEN true ELSE false END as is_shared_inbound,
            COALESCE(tool_share_out.is_shared_outbound, false) as is_shared_outbound
          FROM tools
          LEFT JOIN tools parent_tool ON tools.parent_structure_id = parent_tool.id
          LEFT JOIN LATERAL (
            SELECT * FROM checkouts
            WHERE checkouts.tool_id = tools.id
              AND checkouts.is_returned = false
            ORDER BY checkouts.checkout_date DESC NULLS LAST, checkouts.created_at DESC
            LIMIT 1
          ) active_checkouts ON true
          LEFT JOIN LATERAL (
            SELECT full_name FROM organization_members
            WHERE cognito_user_id = active_checkouts.user_id
            LIMIT 1
          ) om_checkout ON true
          LEFT JOIN LATERAL (
            SELECT pme_sub.gps_latitude, pme_sub.gps_longitude, s_sub.captured_at as sort_time
            FROM state_links sl_sub
            JOIN states s_sub ON sl_sub.state_id = s_sub.id
            JOIN state_photos sp_sub ON s_sub.id = sp_sub.state_id
            JOIN photo_metadata_extractions pme_sub ON pme_sub.photo_url LIKE '%' || split_part(sp_sub.photo_url, '/', -1)
            WHERE sl_sub.entity_id = tools.id
              AND sl_sub.entity_type = 'tool'
              AND pme_sub.gps_latitude IS NOT NULL
            
            UNION ALL
            
            SELECT pme_sub.gps_latitude, pme_sub.gps_longitude, tools.created_at as sort_time
            FROM photo_metadata_extractions pme_sub
            WHERE tools.image_url IS NOT NULL
              AND tools.image_url != ''
              AND pme_sub.photo_url LIKE '%' || split_part(tools.image_url, '/', -1)
              AND pme_sub.gps_latitude IS NOT NULL
              
            ORDER BY sort_time DESC
            LIMIT 1
          ) tool_gps ON true
          LEFT JOIN LATERAL (
            SELECT true as is_shared_outbound
            FROM state_links sl_entity
            JOIN states s_share ON sl_entity.state_id = s_share.id
            WHERE sl_entity.entity_type = 'tool'
              AND sl_entity.entity_id = tools.id
              AND s_share.organization_id = tools.organization_id
              AND EXISTS (
                SELECT 1 FROM state_links sl_org
                WHERE sl_org.state_id = s_share.id
                  AND sl_org.entity_type = 'organization'
                  AND sl_org.entity_id::text != tools.organization_id::text
              )
            LIMIT 1
          ) tool_share_out ON true
          ${whereClause}
          ORDER BY tools.id, tools.name 
          LIMIT ${limit} OFFSET ${offset}
        ) result;`;
        
        console.log('🔍 Tools GET SQL Query:');
        console.log('WHERE clause:', whereClause);
        console.log('SQL:', sql.substring(0, 500) + '...');
        
        const result = await queryJSON(sql);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
        };
      }
    }

    // Parts endpoint
    // POST /parts - Create new part
    if (httpMethod === 'POST' && path.endsWith('/parts')) {
      const body = JSON.parse(event.body || '{}');
      if (!body.name) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'name is required' })
        };
      }
      
      const partId = randomUUID();
      const sql = `
        INSERT INTO parts (
          id, name, description, category, current_quantity, minimum_quantity,
          unit, parent_structure_id, storage_location, legacy_storage_vicinity,
          accountable_person_id, image_url, policy, organization_id, sellable, cost_per_unit,
          created_at, updated_at
        ) VALUES (
          '${partId}',
          ${formatSqlValue(body.name)},
          ${formatSqlValue(body.description)},
          ${formatSqlValue(body.category)},
          ${body.current_quantity || 0},
          ${body.minimum_quantity || 0},
          ${formatSqlValue(body.unit)},
          ${formatSqlValue(body.parent_structure_id)},
          ${formatSqlValue(body.storage_location)},
          ${formatSqlValue(body.legacy_storage_vicinity)},
          ${formatSqlValue(body.accountable_person_id)},
          ${formatSqlValue(body.image_url)},
          ${formatSqlValue(body.policy)},
          ${formatSqlValue(organizationId)},
          ${body.sellable !== undefined ? body.sellable : false},
          ${body.cost_per_unit !== undefined ? body.cost_per_unit : 'NULL'},
          NOW(),
          NOW()
        ) RETURNING *
      `;
      
      const result = await queryJSON(sql);
      
      // Send SQS message for embedding generation
      const part = result[0];
      const embeddingSource = composePartEmbeddingSource(part);
      
      if (embeddingSource && embeddingSource.trim()) {
        try {
          await sqs.send(new SendMessageCommand({
            QueueUrl: EMBEDDINGS_QUEUE_URL,
            MessageBody: JSON.stringify({
              entity_type: 'part',
              entity_id: partId,
              embedding_source: embeddingSource,
              organization_id: organizationId
            })
          }));
          console.log('Queued embedding generation for part', partId);
        } catch (sqsError) {
          console.error('Failed to queue embedding:', sqsError);
          // Non-fatal - continue with response
        }
      }
      
      // Broadcast cache invalidation to WebSocket clients
      try {
        await broadcastInvalidation({
          entityType: 'part',
          entityId: partId,
          mutationType: 'created',
          organizationId,
          excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
        });
      } catch (err) {
        console.error('[CORE] Broadcast failed:', err.message);
      }
      
      return {
        statusCode: 201,
        headers,
        body: JSON.stringify({ data: result[0] })
      };
    }
    
    // DELETE /parts/{id} - Delete part
    if (httpMethod === 'DELETE' && path.match(/\/parts\/[^/]+$/)) {
      const partId = path.split('/').pop();
      
      // Delete dependent records first to avoid FK constraint violations
      await queryJSON(`DELETE FROM parts_history WHERE part_id::text = '${escapeLiteral(partId)}'`);
      await queryJSON(`DELETE FROM parts_orders WHERE part_id::text = '${escapeLiteral(partId)}'`);
      
      const sql = `
        DELETE FROM parts 
        WHERE id::text = '${escapeLiteral(partId)}'
        RETURNING *;
      `;
      
      const result = await queryJSON(sql);
      if (!result || result.length === 0 || !result[0]) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Part not found' })
        };
      }
      
      // Broadcast cache invalidation to WebSocket clients
      try {
        await broadcastInvalidation({
          entityType: 'part',
          entityId: partId,
          mutationType: 'deleted',
          organizationId,
          excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
        });
      } catch (err) {
        console.error('[CORE] Broadcast failed:', err.message);
      }
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: result[0] })
      };
    }
    
    // PUT /parts/{id} - Update part (check this first before the GET /parts)
    if (httpMethod === 'PUT' && path.match(/\/parts\/[^/]+$/)) {
      const partId = path.split('/').pop();
      const body = JSON.parse(event.body || '{}');
      
      const updates = [];
      if (body.current_quantity !== undefined) {
        updates.push(`current_quantity = ${body.current_quantity}`);
      }
      if (body.name !== undefined) {
        updates.push(`name = ${formatSqlValue(body.name)}`);
      }
      if (body.description !== undefined) {
        updates.push(`description = ${formatSqlValue(body.description)}`);
      }
      if (body.category !== undefined) {
        updates.push(`category = ${formatSqlValue(body.category)}`);
      }
      if (body.minimum_quantity !== undefined) {
        updates.push(`minimum_quantity = ${body.minimum_quantity}`);
      }
      if (body.unit !== undefined) {
        updates.push(`unit = ${formatSqlValue(body.unit)}`);
      }
      if (body.cost_per_unit !== undefined) {
        updates.push(`cost_per_unit = ${body.cost_per_unit}`);
      }
      if (body.parent_structure_id !== undefined) {
        updates.push(`parent_structure_id = ${formatSqlValue(body.parent_structure_id)}`);
      }
      if (body.storage_location !== undefined) {
        updates.push(`storage_location = ${formatSqlValue(body.storage_location)}`);
      }
      if (body.accountable_person_id !== undefined) {
        updates.push(`accountable_person_id = ${formatSqlValue(body.accountable_person_id)}`);
      }
      if (body.image_url !== undefined) {
        updates.push(`image_url = ${formatSqlValue(body.image_url)}`);
      }
      if (body.sellable !== undefined) {
        updates.push(`sellable = ${formatSqlValue(body.sellable)}`);
      }
      if (body.policy !== undefined) {
        updates.push(`policy = ${formatSqlValue(body.policy)}`);
      }
      
      if (updates.length === 0) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'No fields to update' })
        };
      }
      
      updates.push('updated_at = NOW()');
      
      const sql = `
        UPDATE parts 
        SET ${updates.join(', ')} 
        WHERE id = '${escapeLiteral(partId)}'
        RETURNING *;
      `;
      
      const result = await queryJSON(sql);
      if (!result || result.length === 0 || !result[0]) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Not found' })
        };
      }
      
      // Trigger embedding regeneration if name, description, or policy changed
      if (body.name !== undefined || body.description !== undefined || body.policy !== undefined) {
        const part = result[0];
        const embeddingSource = composePartEmbeddingSource(part);
        
        if (embeddingSource && embeddingSource.trim()) {
          try {
            await sqs.send(new SendMessageCommand({
              QueueUrl: EMBEDDINGS_QUEUE_URL,
              MessageBody: JSON.stringify({
                entity_type: 'part',
                entity_id: partId,
                embedding_source: embeddingSource,
                organization_id: organizationId
              })
            }));
            console.log('Queued embedding generation for part', partId);
          } catch (sqsError) {
            console.error('Failed to queue embedding:', sqsError);
            // Non-fatal - continue with response
          }
        }
      }
      
      // Broadcast cache invalidation to WebSocket clients
      try {
        await broadcastInvalidation({
          entityType: 'part',
          entityId: partId,
          mutationType: 'updated',
          organizationId,
          excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
        });
      } catch (err) {
        console.error('[CORE] Broadcast failed:', err.message);
      }
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: result[0] })
      };
    }
    
    // GET /parts/sellable - List sellable parts only
    if (path.endsWith('/parts/sellable') && httpMethod === 'GET') {
      const { limit = 50, offset = 0 } = event.queryStringParameters || {};
      const sql = `SELECT json_agg(row_to_json(t)) FROM (
        SELECT 
          parts.id, parts.name, parts.description, parts.policy, parts.category, 
          parts.current_quantity, parts.minimum_quantity, parts.cost_per_unit,
          parts.unit, parts.parent_structure_id, parts.storage_location, 
          parts.accountable_person_id, parts.sellable,
          parent_tool.name as parent_structure_name,
          parent_tool.name as area_display,
          CASE 
            WHEN parts.image_url LIKE '%supabase.co%' THEN 
              REPLACE(parts.image_url, 'https://oskwnlhuuxjfuwnjuavn.supabase.co/storage/v1/object/public/', 'https://cwf-dev-assets.s3.us-west-2.amazonaws.com/')
            ELSE parts.image_url 
          END as image_url,
          parts.created_at, parts.updated_at,
          part_gps.gps_latitude, part_gps.gps_longitude
        FROM parts
        LEFT JOIN tools parent_tool ON parts.parent_structure_id = parent_tool.id
          LEFT JOIN LATERAL (
            SELECT pme_sub.gps_latitude, pme_sub.gps_longitude, s_sub.captured_at as sort_time
            FROM state_links sl_sub
            JOIN states s_sub ON sl_sub.state_id = s_sub.id
            JOIN state_photos sp_sub ON s_sub.id = sp_sub.state_id
            JOIN photo_metadata_extractions pme_sub ON pme_sub.photo_url LIKE '%' || split_part(sp_sub.photo_url, '/', -1)
            WHERE sl_sub.entity_id = parts.id
              AND sl_sub.entity_type = 'part'
              AND pme_sub.gps_latitude IS NOT NULL
            
            UNION ALL
            
            SELECT pme_sub.gps_latitude, pme_sub.gps_longitude, parts.created_at as sort_time
            FROM photo_metadata_extractions pme_sub
            WHERE parts.image_url IS NOT NULL
              AND parts.image_url != ''
              AND pme_sub.photo_url LIKE '%' || split_part(parts.image_url, '/', -1)
              AND pme_sub.gps_latitude IS NOT NULL
              
            ORDER BY sort_time DESC
            LIMIT 1
          ) part_gps ON true
        WHERE parts.sellable = true
        ORDER BY parts.name 
        LIMIT ${limit} OFFSET ${offset}
      ) t;`;
      
      const result = await queryJSON(sql);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
      };
    }
    
    // GET /parts/{id} - Get part by ID
    if (httpMethod === 'GET' && path.match(/\/parts\/[a-f0-9-]+$/)) {
      const partId = path.split('/').pop();
      let whereClause = `WHERE parts.id::text = '${escapeLiteral(partId)}'`;
      if (!hasDataReadAll && organizationId) {
        whereClause += ` AND parts.organization_id::text = '${escapeLiteral(organizationId)}'`;
      }
      
      const sql = `SELECT json_agg(row_to_json(t)) FROM (
        SELECT 
          parts.*,
          parent_tool.name as parent_structure_name,
          parent_tool.name as area_display,
          CASE 
            WHEN parts.image_url LIKE '%supabase.co%' THEN 
              REPLACE(parts.image_url, 'https://oskwnlhuuxjfuwnjuavn.supabase.co/storage/v1/object/public/', 'https://cwf-dev-assets.s3.us-west-2.amazonaws.com/')
            ELSE parts.image_url 
          END as image_url
        FROM parts
        LEFT JOIN tools parent_tool ON parts.parent_structure_id = parent_tool.id
        ${whereClause}
      ) t;`;
      
      const result = await queryJSON(sql);
      if (!result || result.length === 0 || !result[0] || !result[0].json_agg || result[0].json_agg.length === 0) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Part not found' })
        };
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: result[0].json_agg[0] })
      };
    }
    
    // GET /parts - List parts
    if (path.endsWith('/parts') && httpMethod === 'GET') {
      const { limit = 50, offset = 0, view_shared } = event.queryStringParameters || {};
      
      // Build WHERE clause for organization filtering
      let whereClause = '';
      if (organizationId) {
        if (view_shared) {
          const sharedArray = Array.isArray(view_shared) ? view_shared : view_shared.split(',');
          const sharedOrgsStr = sharedArray.map(id => `'${escapeLiteral(id)}'`).join(',');
          whereClause = `WHERE (
            parts.organization_id::text = '${escapeLiteral(organizationId)}'
            OR parts.id IN (
              SELECT sl1.entity_id
              FROM state_links sl1
              JOIN state_links sl2 ON sl1.state_id = sl2.state_id
              JOIN states s ON s.id = sl1.state_id
              WHERE sl1.entity_type = 'part'
                AND sl2.entity_type = 'organization'
                AND sl2.entity_id::text = '${escapeLiteral(organizationId)}'
                AND s.organization_id::text IN (${sharedOrgsStr})
            )
          )`;
        } else {
          whereClause = `WHERE parts.organization_id::text = '${escapeLiteral(organizationId)}'`;
        }
      }
      
      const sql = `SELECT json_agg(row_to_json(t)) FROM (
        SELECT 
          parts.id, parts.name, parts.description, parts.policy, parts.category, 
          parts.current_quantity, parts.minimum_quantity, parts.cost_per_unit,
          parts.unit, parts.parent_structure_id, parts.storage_location, 
          parts.accountable_person_id, parts.sellable, parts.organization_id,
          parent_tool.name as parent_structure_name,
          parent_tool.name as area_display,
          CASE 
            WHEN parts.image_url LIKE '%supabase.co%' THEN 
              REPLACE(parts.image_url, 'https://oskwnlhuuxjfuwnjuavn.supabase.co/storage/v1/object/public/', 'https://cwf-dev-assets.s3.us-west-2.amazonaws.com/')
            ELSE parts.image_url 
          END as image_url,
          parts.created_at, parts.updated_at,
          part_gps.gps_latitude, part_gps.gps_longitude,
          CASE WHEN parts.organization_id::text != '${escapeLiteral(organizationId)}' THEN true ELSE false END as is_shared_inbound,
          COALESCE(part_share_out.is_shared_outbound, false) as is_shared_outbound
        FROM parts
        LEFT JOIN tools parent_tool ON parts.parent_structure_id = parent_tool.id
          LEFT JOIN LATERAL (
            SELECT pme_sub.gps_latitude, pme_sub.gps_longitude, s_sub.captured_at as sort_time
            FROM state_links sl_sub
            JOIN states s_sub ON sl_sub.state_id = s_sub.id
            JOIN state_photos sp_sub ON s_sub.id = sp_sub.state_id
            JOIN photo_metadata_extractions pme_sub ON pme_sub.photo_url LIKE '%' || split_part(sp_sub.photo_url, '/', -1)
            WHERE sl_sub.entity_id = parts.id
              AND sl_sub.entity_type = 'part'
              AND pme_sub.gps_latitude IS NOT NULL
            
            UNION ALL
            
            SELECT pme_sub.gps_latitude, pme_sub.gps_longitude, parts.created_at as sort_time
            FROM photo_metadata_extractions pme_sub
            WHERE parts.image_url IS NOT NULL
              AND parts.image_url != ''
              AND pme_sub.photo_url LIKE '%' || split_part(parts.image_url, '/', -1)
              AND pme_sub.gps_latitude IS NOT NULL
              
            ORDER BY sort_time DESC
            LIMIT 1
          ) part_gps ON true
          LEFT JOIN LATERAL (
            SELECT true as is_shared_outbound
            FROM state_links sl_entity
            JOIN states s_share ON sl_entity.state_id = s_share.id
            WHERE sl_entity.entity_type = 'part'
              AND sl_entity.entity_id = parts.id
              AND s_share.organization_id = parts.organization_id
              AND EXISTS (
                SELECT 1 FROM state_links sl_org
                WHERE sl_org.state_id = s_share.id
                  AND sl_org.entity_type = 'organization'
                  AND sl_org.entity_id::text != parts.organization_id::text
              )
            LIMIT 1
          ) part_share_out ON true
        ${whereClause}
        ORDER BY parts.name 
        LIMIT ${limit} OFFSET ${offset}
      ) t;`;
      
      const result = await queryJSON(sql);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
      };
    }
    
    // Parts history endpoint
    if (path.endsWith('/parts_history')) {
      if (httpMethod === 'GET') {
        const { part_id, change_type, changed_by, limit = 100 } = event.queryStringParameters || {};
        let whereConditions = [];
        
        // Filter by organization if part_id is not specified (to keep list views scoped)
        if (!part_id && organizationId) {
          whereConditions.push(`ph.organization_id::text = '${escapeLiteral(organizationId)}'`);
        }
        
        if (part_id) {
          // Cast both sides to ensure type compatibility
          // If part_id column is UUID, cast the parameter. If it's TEXT, cast the column.
          // Try casting the parameter first: 'value'::uuid
          whereConditions.push(`ph.part_id::text = '${escapeLiteral(part_id)}'`);
        }
        if (change_type) {
          whereConditions.push(`ph.change_type = '${escapeLiteral(change_type)}'`);
        }
        if (changed_by) {
          whereConditions.push(`ph.changed_by = '${escapeLiteral(changed_by)}'`);
        }
        
        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        const limitClause = `LIMIT ${parseInt(limit)}`;
        
        const sql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT 
            ph.*,
            COALESCE(om.full_name, ph.changed_by::text) as changed_by_name
          FROM parts_history ph
          LEFT JOIN LATERAL (
            SELECT full_name FROM organization_members
            WHERE cognito_user_id::text = ph.changed_by::text
            LIMIT 1
          ) om ON true
          ${whereClause} ORDER BY ph.changed_at DESC ${limitClause}
        ) t;`;
        
        const result = await queryJSON(sql);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
        };
      }
      
      if (httpMethod === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { part_id, change_type, old_quantity, new_quantity, quantity_change, change_reason } = body;
        
        if (!part_id || change_type === undefined || old_quantity === undefined || new_quantity === undefined) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'part_id, change_type, old_quantity, and new_quantity are required' })
          };
        }
        
        if (!organizationId) {
          console.error('❌ ERROR: Cannot create parts_history entry - organization_id is missing from authorizer context');
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Server configuration error: organization context not available' })
          };
        }
        
        const userId = authContext.cognito_user_id;
        if (!userId) {
          console.error('❌ ERROR: Cannot create parts_history entry - cognito_user_id is missing from authorizer context');
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Server configuration error: user context not available' })
          };
        }
        
        const sql = `
          INSERT INTO parts_history (
            part_id, change_type, old_quantity, new_quantity, quantity_change, 
            changed_by, change_reason, organization_id, changed_at, created_at
          )
          VALUES (
            ${formatSqlValue(part_id)},
            ${formatSqlValue(change_type)},
            ${old_quantity},
            ${new_quantity},
            ${quantity_change !== undefined ? quantity_change : 'NULL'},
            ${formatSqlValue(userId)},
            ${formatSqlValue(change_reason)},
            ${formatSqlValue(organizationId)},
            NOW(),
            NOW()
          )
          RETURNING *;
        `;
        
        const result = await queryJSON(sql);
        return {
          statusCode: 201,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      }
    }

    // Issues collection endpoint
    if (path.endsWith('/issues')) {
      if (httpMethod === 'GET') {
        const { context_type, context_id, status, fields } = event.queryStringParameters || {};
        let whereConditions = [];
        
        // Always filter by organization
        if (!hasDataReadAll && organizationId) {
          whereConditions.push(`organization_id::text = '${escapeLiteral(organizationId)}'`);
        }
        
        if (context_type) {
          if (context_type.includes(',')) {
            const types = context_type.split(',').map(t => `'${t.trim()}'`).join(',');
            whereConditions.push(`context_type IN (${types})`);
          } else {
            whereConditions.push(`context_type = '${context_type}'`);
          }
        }
        if (context_id) whereConditions.push(`context_id = '${escapeLiteral(context_id)}'`);
        if (status) {
          if (status.includes(',')) {
            const statuses = status.split(',').map(s => `'${s}'`).join(',');
            whereConditions.push(`status IN (${statuses})`);
          } else {
            whereConditions.push(`status = '${status}'`);
          }
        }
        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        
        // Support lightweight field selection (e.g., fields=context_id)
        const allowedFields = ['context_id', 'context_type', 'id', 'status'];
        let selectClause = '*';
        if (fields) {
          const requested = fields.split(',').map(f => f.trim()).filter(f => allowedFields.includes(f));
          if (requested.length > 0) {
            selectClause = `DISTINCT ${requested.join(', ')}`;
          }
        }
        
        const sql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT ${selectClause} FROM issues ${whereClause} ORDER BY ${selectClause === '*' ? 'reported_at DESC' : '1'}
        ) t;`;
        
        const result = await queryJSON(sql);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
        };
      }

      if (httpMethod === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const requiredFields = ['context_id', 'description', 'reported_by'];
        const missing = requiredFields.filter(field => !body[field]);
        if (missing.length > 0) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: `Missing required fields: ${missing.join(', ')}` })
          };
        }

        // Always use organizationId from authorizer context (not from request body)
        if (!organizationId) {
          console.error('❌ ERROR: Cannot create issue - organization_id is missing from authorizer context');
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Server configuration error: organization context not available' })
          };
        }
        const orgId = organizationId;

        const insertData = {
          context_type: body.context_type || 'tool',
          context_id: body.context_id,
          description: body.description,
          issue_type: body.issue_type || 'general',
          status: body.status || 'active',
          workflow_status: body.workflow_status || 'reported',
          reported_by: body.reported_by,
          organization_id: orgId,
          related_checkout_id: body.related_checkout_id || null,
          report_photo_urls: body.report_photo_urls || [],
          issue_metadata: body.issue_metadata || {},
          damage_assessment: body.damage_assessment || null,
          efficiency_loss_percentage: body.efficiency_loss_percentage ?? null,
          is_misuse: body.is_misuse ?? false,
          responsibility_assigned: body.responsibility_assigned ?? false,
          can_self_claim: body.can_self_claim ?? false,
          ready_to_work: body.ready_to_work ?? false,
          next_steps: body.next_steps || null,
          action_required: body.action_required || null,
          assigned_to: body.assigned_to || null,
          materials_needed: body.materials_needed || null,
          work_progress: body.work_progress || null,
          ai_analysis: body.ai_analysis || null
        };

        const columns = Object.keys(insertData);
        const values = columns.map((column) => formatSqlValue(insertData[column]));

        const sql = `
          INSERT INTO issues (${columns.join(', ')}, created_at, reported_at, updated_at)
          VALUES (${values.join(', ')}, NOW(), NOW(), NOW())
          RETURNING *;
        `;

        const result = await queryJSON(sql);
        
        // Send SQS message for embedding generation
        const issue = result[0];
        const embeddingSource = composeIssueEmbeddingSource(issue);
        
        if (embeddingSource && embeddingSource.trim()) {
          try {
            await sqs.send(new SendMessageCommand({
              QueueUrl: EMBEDDINGS_QUEUE_URL,
              MessageBody: JSON.stringify({
                entity_type: 'issue',
                entity_id: issue.id,
                embedding_source: embeddingSource,
                organization_id: orgId
              })
            }));
            console.log('Queued embedding generation for issue', issue.id);
          } catch (sqsError) {
            console.error('Failed to queue embedding:', sqsError);
            // Non-fatal - continue with response
          }
        }
        
        // Broadcast cache invalidation to WebSocket clients
        try {
          await broadcastInvalidation({
            entityType: 'issue',
            entityId: issue.id,
            mutationType: 'created',
            organizationId: orgId,
            excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
          });
        } catch (err) {
          console.error('[CORE] Broadcast failed:', err.message);
        }
        
        return {
          statusCode: 201,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      }
    }

    // Individual issue endpoint
    if (path.match(/\/issues\/[a-f0-9-]+$/)) {
      const issueId = path.split('/').pop();

      if (httpMethod === 'GET') {
        const sql = `SELECT * FROM issues WHERE id = '${issueId}' LIMIT 1;`;
        const result = await queryJSON(sql);
        return {
          statusCode: result?.length ? 200 : 404,
          headers,
          body: JSON.stringify(result?.length ? { data: result[0] } : { error: 'Issue not found' })
        };
      }

      if (httpMethod === 'PUT') {
        const body = JSON.parse(event.body || '{}');
        const updates = buildUpdateClauses(body, [
          'title',
          'status',
          'workflow_status',
          'root_cause',
          'resolution_notes',
          'resolution_photo_urls',
          'issue_metadata',
          'damage_assessment',
          'report_photo_urls',
          'related_checkout_id',
          'description',
          'issue_type',
          'assigned_to',
          'ready_to_work',
          'responsibility_assigned',
          'action_required',
          'next_steps',
          'materials_needed',
          'work_progress',
          'ai_analysis',
          'actual_hours',
          'estimated_hours',
          'efficiency_loss_percentage',
          'is_misuse',
          'can_self_claim',
          'context_id',
          'context_type',
          'reported_by',
          'resolved_at',
          'resolved_by'
        ]);

        if (updates.length === 0) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'No fields to update' })
          };
        }

        updates.push('updated_at = NOW()');

        const sql = `UPDATE issues SET ${updates.join(', ')} WHERE id = '${issueId}' RETURNING *`;
        const result = await queryJSON(sql);
        
        // Trigger embedding regeneration if title, description, or resolution_notes changed
        if (body.title !== undefined || body.description !== undefined || body.resolution_notes !== undefined) {
          const issue = result[0];
          const embeddingSource = composeIssueEmbeddingSource(issue);
          
          if (embeddingSource && embeddingSource.trim()) {
            try {
              await sqs.send(new SendMessageCommand({
                QueueUrl: EMBEDDINGS_QUEUE_URL,
                MessageBody: JSON.stringify({
                  entity_type: 'issue',
                  entity_id: issueId,
                  embedding_source: embeddingSource,
                  organization_id: result[0].organization_id
                })
              }));
              console.log('Queued embedding generation for issue', issueId);
            } catch (sqsError) {
              console.error('Failed to queue embedding:', sqsError);
              // Non-fatal - continue with response
            }
          }
        }
        
        // Broadcast cache invalidation to WebSocket clients
        try {
          await broadcastInvalidation({
            entityType: 'issue',
            entityId: issueId,
            mutationType: 'updated',
            organizationId: result[0].organization_id,
            excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
          });
        } catch (err) {
          console.error('[CORE] Broadcast failed:', err.message);
        }
        
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      }
    }

    // Issue history logging
    if (path.endsWith('/issue_history') && httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { issue_id, new_status } = body;
      if (!issue_id || !new_status) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'issue_id and new_status are required' })
        };
      }

      if (!organizationId) {
        console.error('❌ ERROR: Cannot create issue history - organization_id is missing from authorizer context');
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: 'Server configuration error: organization context not available' })
        };
      }
      
      const userId = authContext.cognito_user_id;
      if (!userId) {
        console.error('❌ ERROR: Cannot create issue history - cognito_user_id is missing from authorizer context');
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: 'Server configuration error: user context not available' })
        };
      }
      
      const oldStatus = body.old_status ? `'${escapeLiteral(body.old_status)}'` : 'NULL';
      const notes = body.notes ? `'${escapeLiteral(body.notes)}'` : 'NULL';

      const sql = `
        INSERT INTO issue_history (issue_id, old_status, new_status, notes, organization_id, changed_by, changed_at, created_at)
        VALUES ('${issue_id}', ${oldStatus}, '${escapeLiteral(new_status)}', ${notes}, '${organizationId}', '${userId}', NOW(), NOW())
        RETURNING *;
      `;

      const result = await queryJSON(sql);
      
      // Send SQS message for embedding generation
      const part = result[0];
      const embeddingSource = composePartEmbeddingSource(part);
      
      if (embeddingSource && embeddingSource.trim()) {
        try {
          await sqs.send(new SendMessageCommand({
            QueueUrl: EMBEDDINGS_QUEUE_URL,
            MessageBody: JSON.stringify({
              entity_type: 'part',
              entity_id: partId,
              embedding_source: embeddingSource,
              organization_id: organizationId
            })
          }));
          console.log('Queued embedding generation for part', partId);
        } catch (sqsError) {
          console.error('Failed to queue embedding:', sqsError);
          // Non-fatal - continue with response
        }
      }
      
      return {
        statusCode: 201,
        headers,
        body: JSON.stringify({ data: result[0] })
      };
    }

    // Parts orders endpoint
    if (httpMethod === 'GET' && path.endsWith('/parts_orders')) {
      const { status } = event.queryStringParameters || {};
      let whereConditions = [];
      
      // Always filter by organization
      if (!hasDataReadAll && organizationId) {
        whereConditions.push(`organization_id::text = '${escapeLiteral(organizationId)}'`);
      }
      
      if (status) {
        if (status.includes(',')) {
          const statuses = status.split(',').map(s => `'${s}'`).join(',');
          whereConditions.push(`status IN (${statuses})`);
        } else {
          whereConditions.push(`status = '${status}'`);
        }
      }
      
      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
      
      const sql = `SELECT json_agg(row_to_json(t)) FROM (
        SELECT * FROM parts_orders ${whereClause} ORDER BY ordered_at DESC
      ) t;`;
      
      const result = await queryJSON(sql);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
      };
    }

    // Organization members endpoint
    if (path.endsWith('/organization_members')) {
      if (httpMethod === 'DELETE') {
        const { id } = event.queryStringParameters || {};
        if (!id) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'id parameter required' })
          };
        }
        
        const sql = `DELETE FROM organization_members WHERE id = '${escapeLiteral(id)}' RETURNING *`;
        const result = await queryJSON(sql);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      }
      
      if (httpMethod === 'PUT') {
        const body = JSON.parse(event.body || '{}');
        const { id, role, is_active } = body;
        
        if (!id) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'id required' })
          };
        }
        
        const updates = [];
        if (role !== undefined) updates.push(`role = '${escapeLiteral(role)}'`);
        if (is_active !== undefined) updates.push(`is_active = ${is_active}`);
        
        if (updates.length === 0) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'No fields to update' })
          };
        }
        
        // Support both id (UUID) and cognito_user_id for backwards compatibility
        const sql = `UPDATE organization_members SET ${updates.join(', ')} WHERE (id = '${escapeLiteral(id)}' OR cognito_user_id = '${escapeLiteral(id)}') RETURNING *`;
        const result = await queryJSON(sql);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      }
      
      if (httpMethod === 'GET') {
        const { cognito_user_id, organization_id } = event.queryStringParameters || {};
        const whereClauses = [];

        // Log user identity and organization context for debugging
        console.log('🔍 [organization_members GET] User identity and context:', {
          cognito_user_id_from_auth: authContext.cognito_user_id,
          cognito_user_id_from_query: cognito_user_id,
          organization_id_from_auth: authContext.organization_id,
          organization_id_from_query: organization_id,
          accessible_organization_ids: authContext.accessible_organization_ids,
          accessible_organization_ids_count: authContext.accessible_organization_ids?.length || 0,
          organization_memberships: authContext.organization_memberships,
          organization_memberships_count: authContext.organization_memberships?.length || 0,
          permissions: authContext.permissions,
          has_data_read_all: hasPermission(authContext, 'data:read:all')
        });

        // If organization_id is provided, check if user has access to it
        if (organization_id) {
          console.log('🔍 [organization_members GET] Checking access to organization:', organization_id);
          // Users with data:read:all can access any organization
          if (hasPermission(authContext, 'data:read:all')) {
            whereClauses.push(`organization_members.organization_id = '${escapeLiteral(organization_id)}'`);
          } 
          // Check if user has access via accessible_organization_ids (active memberships)
          else if (canAccessOrganization(authContext, organization_id)) {
            whereClauses.push(`organization_members.organization_id = '${escapeLiteral(organization_id)}'`);
          }
          // Check if user has ANY membership in this organization (even if inactive)
          // This allows users to see members of orgs they belong to, even if their membership is inactive
          // We need to check the database because organization_memberships only includes active memberships
          else {
            const cognitoUserId = authContext.cognito_user_id;
            console.log('🔍 [organization_members GET] Checking database for membership:', {
              cognito_user_id: cognitoUserId,
              requested_organization_id: organization_id,
              accessible_orgs: authContext.accessible_organization_ids
            });
            
            if (cognitoUserId) {
              // Check for ANY membership (active or inactive) in the requested organization
              const membershipCheckSql = `
                SELECT 
                  id,
                  organization_id,
                  role,
                  is_active,
                  created_at
                FROM organization_members 
                WHERE cognito_user_id = '${escapeLiteral(cognitoUserId)}' 
                  AND organization_id = '${escapeLiteral(organization_id)}'
              `;
              const membershipResult = await queryJSON(membershipCheckSql);
              console.log('🔍 [organization_members GET] Database membership check result:', {
                found_memberships: membershipResult?.length || 0,
                memberships: membershipResult
              });
              
              const hasMembership = membershipResult && membershipResult.length > 0;
              
              if (hasMembership) {
                // User has a membership in this org (even if inactive) - allow access
                console.log('✅ [organization_members GET] User has membership in requested org, allowing access');
                whereClauses.push(`organization_members.organization_id = '${escapeLiteral(organization_id)}'`);
              } else {
                // User doesn't have any membership in this organization
                console.log('❌ [organization_members GET] User has no membership in requested org, denying access');
                return {
                  statusCode: 403,
                  headers,
                  body: JSON.stringify({ error: 'Access denied to this organization' })
                };
              }
            } else {
              console.log('❌ [organization_members GET] No cognito_user_id in auth context');
              return {
                statusCode: 403,
                headers,
                body: JSON.stringify({ error: 'Access denied - user context missing' })
              };
            }
          }
        } else {
          // No organization_id specified - use organization filter from authorizer context
          console.log('🔍 [organization_members GET] No organization_id in query, using authorizer context filter');
          const membersOrgFilter = buildOrganizationFilter(authContext, 'organization_members');
          console.log('🔍 [organization_members GET] Organization filter:', {
            condition: membersOrgFilter.condition,
            has_condition: !!membersOrgFilter.condition
          });
          if (membersOrgFilter.condition) {
            whereClauses.push(membersOrgFilter.condition);
          }
        }

        if (cognito_user_id) {
          whereClauses.push(`organization_members.cognito_user_id = '${escapeLiteral(cognito_user_id)}'`);
        }
        
        const whereClause = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
        const sql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT * FROM organization_members ${whereClause} ORDER BY created_at ASC
        ) t;`;
        
        console.log('🔍 [organization_members GET] Final SQL query:', {
          whereClause,
          sql: sql.substring(0, 500) + (sql.length > 500 ? '...' : '')
        });
        
        const result = await queryJSON(sql);
        const memberCount = result?.[0]?.json_agg?.length || 0;
        console.log('🔍 [organization_members GET] Query result:', {
          result_count: memberCount,
          first_member_org_id: result?.[0]?.json_agg?.[0]?.organization_id
        });
        
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
        };
      }
      
      if (httpMethod === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { cognito_user_id, full_name } = body;
        
        if (!cognito_user_id) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'cognito_user_id required' })
          };
        }
        
        // Update organization member full_name
        const sql = `
          UPDATE organization_members 
          SET full_name = '${full_name || ''}'
          WHERE cognito_user_id = '${cognito_user_id}'
          RETURNING *;
        `;
        
        const result = await queryJSON(sql);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result })
        };
      }
    }

    // Organizations endpoint
    console.log('Checking organizations endpoint:', { path, httpMethod, endsWith: path.endsWith('/organizations') });
    if (path.endsWith('/organizations')) {
      if (httpMethod === 'GET') {
        console.log('✅ Organizations GET endpoint matched');

        // Build WHERE clause manually since organizations table uses 'id' not 'organization_id'
        let whereClause = "WHERE (settings->>'deleted' IS NULL OR settings->>'deleted' != 'true')";
        if (!hasDataReadAll) {
          const orgIdsList = accessibleOrgIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
          whereClause += accessibleOrgIds.length > 0 ? ` AND id IN (${orgIdsList})` : ' AND 1=0';
        }

        const sql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT id, name, subdomain, settings, is_active, created_at, updated_at,
                 (SELECT COUNT(*) FROM organization_members WHERE organization_id = organizations.id AND is_active = true) as member_count
          FROM organizations ${whereClause}
        ) t;`;
        
        console.log('Executing SQL:', sql);
        const result = await queryJSON(sql);
        console.log('Query result:', JSON.stringify(result, null, 2));
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
        };
      }

      if (httpMethod === 'POST') {
        if (!hasPermission(authContext, 'data:read:all')) {
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({ error: 'Forbidden: super-admin permission required to create organizations' })
          };
        }

        const body = JSON.parse(event.body || '{}');
        const { name, subdomain } = body;

        if (!name || !name.trim()) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'name is required' })
          };
        }

        const creatorCognitoId = authContext.cognito_user_id;
        if (!creatorCognitoId) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Cannot determine creating user from auth context' })
          };
        }

        const client = await getDbClient();
        try {
          await client.query('BEGIN');

          // 1. Insert the new organization
          const orgResult = await client.query(
            `INSERT INTO organizations (name, subdomain, is_active, settings, created_at, updated_at)
             VALUES ($1, $2, true, '{}', NOW(), NOW())
             RETURNING id, name, subdomain, settings, is_active, created_at, updated_at`,
            [name.trim(), subdomain || null]
          );
          const newOrg = orgResult.rows[0];

          // 2. Look up the creator's profile from an existing membership to carry over user_id, full_name, email
          const creatorResult = await client.query(
            `SELECT user_id, full_name, email, favorite_color
             FROM organization_members
             WHERE cognito_user_id = $1 AND is_active = true
             LIMIT 1`,
            [creatorCognitoId]
          );
          const creator = creatorResult.rows[0];

          // 3. Seed the creator as a super_admin member of the new org
          await client.query(
            `INSERT INTO organization_members
               (organization_id, user_id, cognito_user_id, role, super_admin, is_active, full_name, email, favorite_color, created_at)
             VALUES ($1, $2, $3, 'admin', true, true, $4, $5, $6, NOW())`,
            [
              newOrg.id,
              creator?.user_id || null,
              creatorCognitoId,
              creator?.full_name || null,
              creator?.email || null,
              creator?.favorite_color || null
            ]
          );

          await client.query('COMMIT');

          console.log(`✅ Created org ${newOrg.id} and seeded membership for ${creatorCognitoId}`);
          return {
            statusCode: 201,
            headers,
            body: JSON.stringify({ data: newOrg })
          };
        } catch (err) {
          await client.query('ROLLBACK');
          console.error('❌ Error creating organization:', err);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: err.message })
          };
        } finally {
          client.release();
        }
      }
    }
    
    // Organizations AI Config endpoint (must be before /organizations/:id catch-all)
    if (path.match(/\/organizations\/[^/]+\/ai-config$/)) {
      const pathParts = path.split('/');
      const orgId = pathParts[pathParts.length - 2]; // e.g. /organizations/{id}/ai-config

      if (httpMethod === 'GET') {
        if (!canAccessOrganization(authContext, orgId)) {
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({ error: 'Forbidden' })
          };
        }

        const client = await getDbClient();
        try {
          const result = await client.query(
            'SELECT ai_config FROM organizations WHERE id = $1',
            [orgId]
          );
          const aiConfig = resolveAiConfig(result.rows?.[0]?.ai_config);
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: aiConfig })
          };
        } finally {
          client.release();
        }
      }

      if (httpMethod === 'PUT') {
        if (!hasPermission(authContext, 'organizations:update')) {
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({ error: 'Forbidden: organizations:update permission required' })
          };
        }

        const body = JSON.parse(event.body || '{}');
        const { max_axes, min_axes, evidence_limit, quiz_temperature, lens_config } = body;

        // Validate input fields
        const errors = [];
        if (max_axes !== undefined && !isValidInt(max_axes, 1, 6)) {
          errors.push('max_axes must be an integer between 1 and 6');
        }
        if (min_axes !== undefined && !isValidInt(min_axes, 1, 6)) {
          errors.push('min_axes must be an integer between 1 and 6');
        }
        if (evidence_limit !== undefined && !isValidInt(evidence_limit, 1, 10)) {
          errors.push('evidence_limit must be an integer between 1 and 10');
        }
        if (quiz_temperature !== undefined && !isValidFloat(quiz_temperature, 0.0, 1.0)) {
          errors.push('quiz_temperature must be a number between 0.0 and 1.0');
        }

        // Validate lens_config if present
        if (lens_config !== undefined) {
          if (typeof lens_config !== 'object' || lens_config === null || Array.isArray(lens_config)) {
            errors.push('lens_config must be an object');
          } else {
            const validSystemKeys = new Set(SYSTEM_LENSES.map(l => l.key));

            // Validate system_lens_weights
            if (lens_config.system_lens_weights !== undefined) {
              if (typeof lens_config.system_lens_weights !== 'object' || lens_config.system_lens_weights === null || Array.isArray(lens_config.system_lens_weights)) {
                errors.push('lens_config.system_lens_weights must be an object');
              } else {
                for (const [key, entry] of Object.entries(lens_config.system_lens_weights)) {
                  if (!validSystemKeys.has(key)) {
                    errors.push(`lens_config.system_lens_weights: unknown system lens key "${key}"`);
                    continue;
                  }
                  if (entry && typeof entry === 'object' && entry.weight !== undefined) {
                    if (!isValidFloat(entry.weight, 0.0, 1.0)) {
                      errors.push(`lens_config.system_lens_weights.${key}.weight must be between 0.0 and 1.0`);
                    }
                  }
                }
              }
            }

            // Validate custom_lenses
            if (lens_config.custom_lenses !== undefined) {
              if (!Array.isArray(lens_config.custom_lenses)) {
                errors.push('lens_config.custom_lenses must be an array');
              } else {
                if (lens_config.custom_lenses.length > MAX_CUSTOM_LENSES) {
                  errors.push(`lens_config.custom_lenses exceeds maximum of ${MAX_CUSTOM_LENSES}`);
                }
                const seenLabels = new Set();
                for (let i = 0; i < lens_config.custom_lenses.length; i++) {
                  const cl = lens_config.custom_lenses[i];
                  if (!cl || typeof cl !== 'object') {
                    errors.push(`lens_config.custom_lenses[${i}] must be an object`);
                    continue;
                  }
                  if (typeof cl.label !== 'string' || cl.label.length < 1 || cl.label.length > 100) {
                    errors.push(`lens_config.custom_lenses[${i}].label must be a string between 1 and 100 characters`);
                  } else {
                    const lowerLabel = cl.label.toLowerCase();
                    if (seenLabels.has(lowerLabel)) {
                      errors.push(`lens_config.custom_lenses[${i}].label "${cl.label}" is a duplicate`);
                    }
                    seenLabels.add(lowerLabel);
                  }
                  if (typeof cl.description !== 'string' || cl.description.length < 1 || cl.description.length > 500) {
                    errors.push(`lens_config.custom_lenses[${i}].description must be a string between 1 and 500 characters`);
                  }
                  if (cl.weight !== undefined && !isValidFloat(cl.weight, 0.0, 1.0)) {
                    errors.push(`lens_config.custom_lenses[${i}].weight must be between 0.0 and 1.0`);
                  }
                }
              }
            }

            // Validate values_lens_weights
            if (lens_config.values_lens_weights !== undefined) {
              if (typeof lens_config.values_lens_weights !== 'object' || lens_config.values_lens_weights === null || Array.isArray(lens_config.values_lens_weights)) {
                errors.push('lens_config.values_lens_weights must be an object');
              } else {
                for (const [key, entry] of Object.entries(lens_config.values_lens_weights)) {
                  if (entry && typeof entry === 'object' && entry.weight !== undefined) {
                    if (!isValidFloat(entry.weight, 0.0, 1.0)) {
                      errors.push(`lens_config.values_lens_weights.${key}.weight must be between 0.0 and 1.0`);
                    }
                  }
                }
              }
            }

            // Validate gap_boost_rules
            if (lens_config.gap_boost_rules !== undefined) {
              if (!Array.isArray(lens_config.gap_boost_rules)) {
                errors.push('lens_config.gap_boost_rules must be an array');
              } else {
                if (lens_config.gap_boost_rules.length > MAX_GAP_BOOST_RULES) {
                  errors.push(`lens_config.gap_boost_rules exceeds maximum of ${MAX_GAP_BOOST_RULES}`);
                }
                for (let i = 0; i < lens_config.gap_boost_rules.length; i++) {
                  const rule = lens_config.gap_boost_rules[i];
                  if (!rule || typeof rule !== 'object') {
                    errors.push(`lens_config.gap_boost_rules[${i}] must be an object`);
                    continue;
                  }
                  if (rule.threshold === undefined || typeof rule.threshold !== 'number' || rule.threshold < 0.5) {
                    errors.push(`lens_config.gap_boost_rules[${i}].threshold must be a number >= 0.5`);
                  }
                  if (rule.multiplier === undefined || !isValidFloat(rule.multiplier, 1.1, 3.0)) {
                    errors.push(`lens_config.gap_boost_rules[${i}].multiplier must be a number between 1.1 and 3.0`);
                  }
                  if (!Array.isArray(rule.lens_keys) || rule.lens_keys.length === 0) {
                    errors.push(`lens_config.gap_boost_rules[${i}].lens_keys must be a non-empty array`);
                  }
                }
              }
            }
          }
        }

        if (errors.length > 0) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: errors.join('; ') })
          };
        }

        // Build the ai_config object from provided fields
        const aiConfigInput = {};
        if (max_axes !== undefined) aiConfigInput.max_axes = max_axes;
        if (min_axes !== undefined) aiConfigInput.min_axes = min_axes;
        if (evidence_limit !== undefined) aiConfigInput.evidence_limit = evidence_limit;
        if (quiz_temperature !== undefined) aiConfigInput.quiz_temperature = quiz_temperature;
        if (lens_config !== undefined) aiConfigInput.lens_config = lens_config;

        const client = await getDbClient();
        try {
          // Write ai_config JSONB to the organizations table
          await client.query(
            `UPDATE organizations SET ai_config = COALESCE(ai_config, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
            [JSON.stringify(aiConfigInput), orgId]
          );

          // Read back and resolve with defaults
          const result = await client.query(
            'SELECT ai_config FROM organizations WHERE id = $1',
            [orgId]
          );
          const resolved = resolveAiConfig(result.rows?.[0]?.ai_config);
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: resolved })
          };
        } finally {
          client.release();
        }
      }
    }

    // Impact preview — direct FK dependent counts (sanity check before delete)
    if (httpMethod === 'GET' && path.match(/\/organizations\/[^/]+\/impact$/)) {
      if (!hasPermission(authContext, 'data:read:all')) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
      }
      const impactOrgId = path.split('/').slice(-2)[0];
      const impact = {};
      const impactQueries = [
        { key: 'members',  sql: 'SELECT COUNT(*) FROM organization_members WHERE organization_id = $1 AND is_active = true' },
        { key: 'actions',  sql: 'SELECT COUNT(*) FROM actions WHERE organization_id = $1' },
        { key: 'missions', sql: 'SELECT COUNT(*) FROM missions WHERE organization_id = $1' },
        { key: 'tools',    sql: 'SELECT COUNT(*) FROM tools WHERE organization_id = $1' },
        { key: 'issues',   sql: 'SELECT COUNT(*) FROM issues WHERE organization_id = $1' },
      ];
      const impactClient = await getDbClient();
      try {
        for (const q of impactQueries) {
          const r = await impactClient.query(q.sql, [impactOrgId]);
          impact[q.key] = parseInt(r.rows[0].count, 10);
        }
      } finally {
        impactClient.release();
      }
      return { statusCode: 200, headers, body: JSON.stringify({ data: impact }) };
    }

    // Organizations by ID endpoint
    if (path.match(/\/organizations\/[^/]+$/)) {
      const orgId = path.split('/').pop();
      
      if (httpMethod === 'PUT') {
        if (!canAccessOrganization(authContext, orgId)) {
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({ error: 'Forbidden' })
          };
        }

        const body = JSON.parse(event.body || '{}');
        const updates = [];

        if (body.name !== undefined) {
          updates.push(`name = ${formatSqlValue(body.name)}`);
        }
        if (body.subdomain !== undefined) {
          updates.push(`subdomain = ${formatSqlValue(body.subdomain)}`);
        }
        if (body.is_active !== undefined) {
          updates.push(`is_active = ${formatSqlValue(body.is_active)}`);
        }

        if (body.strategic_attributes !== undefined || body.settings !== undefined) {
          const getSql = `SELECT settings FROM organizations WHERE id = '${orgId}';`;
          const current = await queryJSON(getSql);
          const currentSettings = current[0]?.settings || {};
          let updatedSettings = { ...currentSettings };
          
          if (body.strategic_attributes !== undefined) {
            updatedSettings.strategic_attributes = body.strategic_attributes;
          }
          if (body.settings !== undefined) {
            updatedSettings = { ...updatedSettings, ...body.settings };
          }
          
          updates.push(`settings = ${formatSqlValue(JSON.stringify(updatedSettings))}::jsonb`);
        }

        if (updates.length === 0) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'No fields to update' })
          };
        }

        updates.push('updated_at = NOW()');
        
        const sql = `
          UPDATE organizations 
          SET ${updates.join(', ')}
          WHERE id = '${orgId}'
          RETURNING *;
        `;
        
        const result = await queryJSON(sql);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      }



      // Soft-delete — only available to super-admins, only on inactive orgs
      if (httpMethod === 'DELETE') {
        if (!hasPermission(authContext, 'data:read:all')) {
          return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden: super-admin permission required' }) };
        }
        const deleteClient = await getDbClient();
        try {
          await deleteClient.query('BEGIN');

          // Fetch current subdomain to append suffix to release the unique constraint
          const orgData = await deleteClient.query('SELECT subdomain FROM organizations WHERE id = $1', [orgId]);
          const currentSubdomain = orgData.rows[0]?.subdomain;
          let newSubdomain = currentSubdomain;
          if (currentSubdomain && !currentSubdomain.includes('-deleted-')) {
            newSubdomain = `${currentSubdomain}-deleted-${Date.now()}`;
          }

          // Mark as deleted in settings, deactivate the org, and update the subdomain to release it
          await deleteClient.query(
            `UPDATE organizations 
             SET is_active = false, 
                 subdomain = $1,
                 settings = COALESCE(settings, '{}'::jsonb) || '{"deleted": true}'::jsonb, 
                 updated_at = NOW() 
             WHERE id = $2`,
            [newSubdomain, orgId]
          );
          // Deactivate rows in tables that have BOTH organization_id AND is_active
          for (const tbl of ['organization_members', 'storage_vicinities', 'suppliers']) {
            await deleteClient.query(`UPDATE ${tbl} SET is_active = false WHERE organization_id = $1`, [orgId]);
          }
          await deleteClient.query('COMMIT');
          console.log(`✅ Soft-deleted org ${orgId}`);
          return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
        } catch (err) {
          await deleteClient.query('ROLLBACK');
          console.error('❌ Soft-delete error:', err);
          return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
        } finally {
          deleteClient.release();
        }
      }
    }

    // Worker strategic attributes endpoint
    if (path.endsWith('/worker_strategic_attributes')) {
      if (httpMethod === 'GET') {
        let whereClause = '';
        if (!hasDataReadAll && organizationId) {
          whereClause = `WHERE organization_id::text = '${escapeLiteral(organizationId)}'`;
        }
        
        const sql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT * FROM worker_strategic_attributes ${whereClause} ORDER BY created_at DESC
        ) t;`;
        
        const result = await queryJSON(sql);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
        };
      }
    }

    // Scoring prompts endpoints
    if (path.endsWith('/scoring_prompts')) {
      if (httpMethod === 'GET') {
        let whereClause = '';
        if (!hasDataReadAll && organizationId) {
          whereClause = `WHERE organization_id::text = '${escapeLiteral(organizationId)}'`;
        }
        
        const sql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT * FROM scoring_prompts ${whereClause} ORDER BY created_at DESC
        ) t;`;
        const result = await queryJSON(sql);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
        };
      }

      if (httpMethod === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { name, prompt_text, is_default = false, created_by } = body;

        if (!name || !prompt_text || !created_by) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'name, prompt_text, and created_by are required' })
          };
        }

        const sql = `
          INSERT INTO scoring_prompts (name, prompt_text, is_default, created_by, created_at, updated_at)
          VALUES (
            ${formatSqlValue(name)},
            ${formatSqlValue(prompt_text)},
            ${is_default},
            ${formatSqlValue(created_by)},
            NOW(),
            NOW()
          )
          RETURNING *
        `;
        const result = await queryJSON(sql);
        return {
          statusCode: 201,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      }
    }

    if (path.match(/\/scoring_prompts\/[^/]+\/set-default$/)) {
      if (httpMethod === 'PUT') {
        const promptId = path.split('/').slice(-2, -1)[0];
        await queryJSON('UPDATE scoring_prompts SET is_default = false');
        await queryJSON(`UPDATE scoring_prompts SET is_default = true, updated_at = NOW() WHERE id = '${escapeLiteral(promptId)}'`);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true })
        };
      }
    }

    if (path.match(/\/scoring_prompts\/[^/]+$/)) {
      const promptId = path.split('/').pop();
      if (httpMethod === 'PUT') {
        const body = JSON.parse(event.body || '{}');
        const updates = buildUpdateClauses(body, ['name', 'prompt_text', 'is_default']);
        if (updates.length === 0) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'No fields to update' })
          };
        }
        updates.push('updated_at = NOW()');
        const sql = `UPDATE scoring_prompts SET ${updates.join(', ')} WHERE id = '${escapeLiteral(promptId)}' RETURNING *`;
        const result = await queryJSON(sql);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      }
    }

    // Action scores endpoint
    // Profiles endpoint
    if (path.endsWith('/profiles')) {
      if (httpMethod === 'GET') {
        try {
          const { user_id } = event.queryStringParameters || {};
          const cognitoUserId = authContext.cognito_user_id;
          
          console.log('🔍 [profiles GET] Request details:', {
            requested_user_id: user_id,
            cognito_user_id: cognitoUserId,
            organization_id: organizationId,
            has_data_read_all: hasDataReadAll
          });
          
          // If querying a specific user_id, allow access if:
          // 1. It's the current user's own profile (always allowed), OR
          // 2. User has data:read:all permission, OR
          // 3. User is in the same organization (via organization_members)
          if (user_id) {
            // Allow users to see their own profile even if not in organization_members
            // Check if user_id matches cognitoUserId OR if there's a profile with that user_id
            // that belongs to the current user (via organization_members lookup)
            let isOwnProfile = false;
            
            if (user_id === cognitoUserId) {
              isOwnProfile = true;
            } else {
              // Check if this user_id belongs to the current user via organization_members
              // This handles cases where user_id is a database UUID but cognitoUserId is an email
              const ownershipCheckSql = `
                SELECT COUNT(*) as count 
                FROM organization_members 
                WHERE cognito_user_id = '${escapeLiteral(cognitoUserId)}' 
                  AND user_id::text = '${escapeLiteral(user_id)}'
              `;
              const ownershipResult = await queryJSON(ownershipCheckSql);
              isOwnProfile = ownershipResult?.[0]?.count > 0;
            }
            
            if (isOwnProfile) {
              const sql = `SELECT json_agg(row_to_json(t)) FROM (
                SELECT * FROM profiles WHERE user_id = ${formatSqlValue(user_id)}
              ) t;`;
              
              const result = await queryJSON(sql);
              return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
              };
            }
            
            // For other users, require organization membership check
            console.log('🔍 [profiles GET] Not own profile - checking organization membership...');
            let whereConditions = [];
            
            if (!hasDataReadAll && organizationId) {
              whereConditions.push(`om.organization_id::text = '${escapeLiteral(organizationId)}'`);
            }
            whereConditions.push(`om.is_active = true`);
            whereConditions.push(`p.user_id = ${formatSqlValue(user_id)}`);
            
            const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
            
            const sql = `SELECT json_agg(row_to_json(t)) FROM (
              SELECT p.* FROM profiles p
              INNER JOIN organization_members om ON p.user_id::text = om.cognito_user_id::text
              ${whereClause}
              ORDER BY p.full_name
            ) t;`;
            
            const result = await queryJSON(sql);
            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
            };
          }
          
          // No user_id specified - return all profiles user has access to
          // Use LEFT JOIN so users without org membership can still see profiles if they have data:read:all
          let joinClause = '';
          let whereConditions = [];
          
          if (hasDataReadAll) {
            // Users with data:read:all can see all profiles
            const sql = `SELECT json_agg(row_to_json(t)) FROM (
              SELECT * FROM profiles
              ORDER BY full_name
            ) t;`;
            
            const result = await queryJSON(sql);
            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
            };
          }
          
          // Filter by organization and only active members
          if (organizationId) {
            whereConditions.push(`om.organization_id::text = '${escapeLiteral(organizationId)}'`);
          }
          whereConditions.push(`om.is_active = true`);
          
          const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
          
          const sql = `SELECT json_agg(row_to_json(t)) FROM (
            SELECT p.* FROM profiles p
            INNER JOIN organization_members om ON p.user_id::text = om.cognito_user_id::text
            ${whereClause}
            ORDER BY p.full_name
          ) t;`;
          
          const result = await queryJSON(sql);
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
          };
        } catch (error) {
          console.error('Error fetching profiles:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal server error', message: error.message })
          };
        }
      }
      
      if (httpMethod === 'POST') {
        try {
          const body = JSON.parse(event.body || '{}');
          const { user_id, full_name, favorite_color } = body;
          
          if (!user_id) {
            return {
              statusCode: 400,
              headers,
              body: JSON.stringify({ error: 'user_id required' })
            };
          }
          
          // Use formatSqlValue to safely escape all values and prevent SQL injection
          const safeUserId = formatSqlValue(user_id);
          const safeFullName = formatSqlValue(full_name || '');
          const safeFavoriteColor = formatSqlValue(favorite_color);
          
          // Upsert profile
          const sql = `
            INSERT INTO profiles (user_id, full_name, favorite_color, updated_at) 
            VALUES (${safeUserId}, ${safeFullName}, ${safeFavoriteColor}, NOW())
            ON CONFLICT (user_id) 
            DO UPDATE SET 
              full_name = EXCLUDED.full_name,
              favorite_color = EXCLUDED.favorite_color,
              updated_at = NOW()
            RETURNING *;
          `;
          
          const result = await queryJSON(sql);
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: result })
          };
        } catch (error) {
          console.error('Error creating/updating profile:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal server error', message: error.message })
          };
        }
      }
    }

    // Checkins endpoint
    if (httpMethod === 'POST' && path.endsWith('/checkins')) {
      try {
        const body = JSON.parse(event.body || '{}');
        const afterImageArray = Array.isArray(body.after_image_urls)
          ? body.after_image_urls
          : body.after_image_urls
            ? [body.after_image_urls]
            : [];

        const insertData = {
          checkout_id: body.checkout_id,
          tool_id: body.tool_id,
          user_id: body.user_id,
          problems_reported: body.problems_reported !== undefined ? body.problems_reported : null,
          notes: body.notes !== undefined ? body.notes : null,
          sop_best_practices: body.sop_best_practices !== undefined ? body.sop_best_practices : '',
          what_did_you_do: body.what_did_you_do !== undefined ? body.what_did_you_do : '',
          checkin_reason: body.checkin_reason !== undefined ? body.checkin_reason : null,
          after_image_urls: afterImageArray,
          organization_id: (() => {
            if (!organizationId) {
              console.error('❌ ERROR: Cannot create checkin - organization_id is missing from authorizer context');
              throw new Error('Server configuration error: organization context not available');
            }
            return organizationId;
          })()
        };

        const requiredFields = ['checkout_id', 'tool_id', 'user_id'];
        const missingFields = requiredFields.filter(field => !insertData[field]);
        if (missingFields.length > 0) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: `Missing required fields: ${missingFields.join(', ')}` })
          };
        }

        const columns = Object.keys(insertData);
        const values = columns.map(col => formatSqlValue(insertData[col]));

        const sql = `
          INSERT INTO checkins (${columns.join(', ')}, checkin_date)
          VALUES (${values.join(', ')}, NOW())
          RETURNING *
        `;
        
        console.log('Checkin SQL:', sql);
        console.log('Checkin data:', JSON.stringify(insertData, null, 2));
        
        const result = await queryJSON(sql);
        
        // Broadcast cache invalidation to WebSocket clients
        try {
          await broadcastInvalidation({
            entityType: 'checkin',
            entityId: result[0].id,
            mutationType: 'created',
            organizationId,
            excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
          });
        } catch (err) {
          console.error('[CORE] Broadcast failed:', err.message);
        }
        
        return {
          statusCode: 201,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      } catch (error) {
        console.error('Error creating checkin:', error);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ 
            error: 'Failed to create checkin',
            details: error.message,
            stack: error.stack
          })
        };
      }
    }

    // Tools history endpoint
    if (path.match(/\/tools\/[a-f0-9-]+\/history$/)) {
      if (httpMethod === 'GET') {
        try {
          const toolId = path.split('/')[2];
          
          // Get asset info
          const assetSql = `SELECT created_at, updated_at FROM tools WHERE id::text = '${escapeLiteral(toolId)}';`;
          const assetResult = await queryJSON(assetSql);
          
          // Get checkouts - cast all UUIDs to text for consistency
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
          
          // Get issues - cast all UUIDs to text
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
          
          // Get actions - cast all UUIDs to text
          const actionsSql = `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) as json_agg FROM (
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
              COALESCE(om.full_name, 'System') as created_by_name
            FROM actions a
            LEFT JOIN LATERAL (
              SELECT full_name FROM organization_members
              WHERE cognito_user_id::text = a.created_by::text
              LIMIT 1
            ) om ON true
            WHERE a.asset_id::text = '${escapeLiteral(toolId)}'
            ORDER BY a.created_at DESC
          ) t;`;
          const actionsResult = await queryJSON(actionsSql);
          
          // Get observations - DEPENDENCIES: observations, observation_photos, observation_links tables
          const observationsSql = `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) as json_agg FROM (
            SELECT 
              o.id::text,
              o.observation_text,
              o.observed_by::text,
              o.observed_at,
              o.created_at,
              COALESCE(om.full_name, o.observed_by::text) as observed_by_name,
              (
                SELECT json_agg(json_build_object(
                  'id', op.id,
                  'photo_url', op.photo_url,
                  'photo_description', op.photo_description,
                  'photo_order', op.photo_order
                ))
                FROM observation_photos op
                WHERE op.observation_id = o.id
                ORDER BY op.photo_order
              ) as photos
            FROM observations o
            JOIN observation_links ol ON ol.observation_id = o.id
            LEFT JOIN LATERAL (
              SELECT full_name FROM organization_members
              WHERE cognito_user_id::text = o.observed_by::text
              LIMIT 1
            ) om ON true
            WHERE ol.entity_type = 'tool' AND ol.entity_id::text = '${escapeLiteral(toolId)}'
            ORDER BY o.observed_at DESC
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
          
          // Build unified timeline
          const asset = assetResult?.[0];
          const checkouts = checkoutsResult?.[0]?.json_agg || [];
          const issues = issuesResult?.[0]?.json_agg || [];
          const actions = actionsResult?.[0]?.json_agg || [];
          const observations = observationsResult?.[0]?.json_agg || [];
          const assetHistory = assetHistoryResult?.[0]?.json_agg || [];
          
          const timeline = [];
          
          // Add asset history events
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
          
          // Add generic asset created event if no history
          if (assetHistory.length === 0 && asset) {
            timeline.push({
              type: 'asset_created',
              timestamp: asset.created_at,
              description: 'Asset created'
            });
          }
          
          // Add checkout events
          checkouts.forEach(c => {
            timeline.push({
              type: 'checkout',
              timestamp: c.checkout_date || c.created_at,
              description: `Checked out by ${c.user_display_name}`,
              data: c
            });
          });
          
          // Add issue events
          issues.forEach(i => {
            timeline.push({
              type: 'issue_reported',
              timestamp: i.reported_at,
              description: `Issue reported by ${i.reported_by_name}`,
              data: i
            });
            if (i.resolved_at) {
              timeline.push({
                type: 'issue_resolved',
                timestamp: i.resolved_at,
                description: 'Issue resolved'
              });
            }
          });
          
          // Add action events
          actions.forEach(a => {
            timeline.push({
              type: 'action_created',
              timestamp: a.created_at,
              description: `Action: ${a.title}`,
              data: a
            });
          });
          
          // Sort timeline by timestamp descending
          timeline.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
              data: {
                asset: asset || null,
                checkouts,
                issues,
                actions,
                observations,
                timeline
              }
            })
          };
        } catch (error) {
          console.error('Error fetching tool history:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
              error: 'Failed to fetch tool history',
              message: error.message 
            })
          };
        }
      }
    }

    // Checkouts endpoint
    if (path.endsWith('/checkouts') || path.match(/\/checkouts\/[a-f0-9-]+$/)) {
      if (httpMethod === 'DELETE') {
        const checkoutId = path.split('/').pop();
        const sql = `DELETE FROM checkouts WHERE id = '${checkoutId}' RETURNING *`;
        const result = await queryJSON(sql);
        
        // Broadcast cache invalidation to WebSocket clients
        try {
          await broadcastInvalidation({
            entityType: 'checkout',
            entityId: checkoutId,
            mutationType: 'deleted',
            organizationId,
            excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
          });
        } catch (err) {
          console.error('[CORE] Broadcast failed:', err.message);
        }
        
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      }
      
      if (httpMethod === 'PUT') {
        const checkoutId = path.split('/').pop();
        const body = JSON.parse(event.body || '{}');
        const updates = [];
        if (body.checkout_date !== undefined) updates.push(`checkout_date = ${body.checkout_date ? `'${body.checkout_date}'` : 'NOW()'}`);
        if (body.is_returned !== undefined) updates.push(`is_returned = ${body.is_returned}`);
        if (updates.length === 0) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'No fields to update' })
          };
        }
        const sql = `UPDATE checkouts SET ${updates.join(', ')} WHERE id = '${checkoutId}' RETURNING *`;
        const result = await queryJSON(sql);
        
        // Broadcast cache invalidation to WebSocket clients
        try {
          await broadcastInvalidation({
            entityType: 'checkout',
            entityId: checkoutId,
            mutationType: 'updated',
            organizationId,
            excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
          });
        } catch (err) {
          console.error('[CORE] Broadcast failed:', err.message);
        }
        
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      }
      
      if (httpMethod === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { tool_id, user_id, intended_usage, notes, action_id, is_returned, checkout_date } = body;
        // Always use organizationId from authorizer context (not from request body)
        if (!organizationId) {
          console.error('❌ ERROR: Cannot create checkout - organization_id is missing from authorizer context');
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Server configuration error: organization context not available' })
          };
        }
        const orgId = organizationId;
        
        // Check for existing active checkout for this tool
        // An active checkout is one where is_returned = false
        const checkActiveCheckoutSql = `
          SELECT id, checkout_date 
          FROM checkouts 
          WHERE tool_id = '${tool_id}' 
            AND is_returned = false
            AND organization_id = '${orgId}'
          LIMIT 1
        `;
        const existingCheckouts = await queryJSON(checkActiveCheckoutSql);
        
        if (existingCheckouts && existingCheckouts.length > 0) {
          const existingCheckout = existingCheckouts[0];
          return {
            statusCode: 409,
            headers,
            body: JSON.stringify({ 
              error: 'Tool already has an active checkout',
              details: 'This tool is currently checked out. Please return the tool before creating a new checkout.',
              existing_checkout: {
                id: existingCheckout.id,
                checkout_date: existingCheckout.checkout_date
              }
            })
          };
        }
        
        const checkoutDateValue = checkout_date ? `'${checkout_date}'` : (is_returned ? 'NOW()' : 'NULL');
        const sql = `
          INSERT INTO checkouts (tool_id, user_id, intended_usage, notes, action_id, organization_id, is_returned, checkout_date)
          VALUES ('${tool_id}', '${user_id}', ${intended_usage ? `'${intended_usage.replace(/'/g, "''")}'` : 'NULL'}, ${notes ? `'${notes.replace(/'/g, "''")}'` : 'NULL'}, ${action_id ? `'${action_id}'` : 'NULL'}, '${orgId}', ${is_returned}, ${checkoutDateValue})
          RETURNING *
        `;
        
        try {
          const result = await queryJSON(sql);
          
          // Broadcast cache invalidation to WebSocket clients
          try {
            await broadcastInvalidation({
              entityType: 'checkout',
              entityId: result[0].id,
              mutationType: 'created',
              organizationId: orgId,
              excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
            });
          } catch (err) {
            console.error('[CORE] Broadcast failed:', err.message);
          }
          
          return {
            statusCode: 201,
            headers,
            body: JSON.stringify({ data: result[0] })
          };
        } catch (error) {
          // Catch duplicate key constraint violation
          if (error.message && error.message.includes('idx_unique_active_checkout_per_tool')) {
            return {
              statusCode: 409,
              headers,
              body: JSON.stringify({ 
                error: 'Tool already has an active checkout',
                details: 'This tool is currently checked out. Please return the tool before creating a new checkout.'
              })
            };
          }
          throw error;
        }
      }
      
      if (httpMethod === 'GET') {
        const { is_returned, action_id, tool_id } = event.queryStringParameters || {};
        let whereConditions = [];
        
        // Always filter by organization
        if (!hasDataReadAll && organizationId) {
          whereConditions.push(`c.organization_id::text = '${escapeLiteral(organizationId)}'`);
        }
        
        if (is_returned === 'false') {
          whereConditions.push('c.is_returned = false');
        } else if (is_returned === 'true') {
          whereConditions.push('c.is_returned = true');
        }
        if (action_id) {
          whereConditions.push(`c.action_id = '${action_id}'`);
        }
        if (tool_id) {
          whereConditions.push(`c.tool_id = '${tool_id}'`);
        }
        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        
        const sql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT 
            c.*,
            t.serial_number as tool_serial_number,
            om.full_name as user_name,
            a.title as action_title
          FROM checkouts c
          LEFT JOIN tools t ON c.tool_id = t.id
          LEFT JOIN LATERAL (
            SELECT full_name FROM organization_members
            WHERE cognito_user_id = c.user_id
            LIMIT 1
          ) om ON true
          LEFT JOIN actions a ON c.action_id = a.id
          ${whereClause} ORDER BY c.checkout_date DESC
        ) t;`;
        
        const result = await queryJSON(sql);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
        };
      }
    }



    // Exploration endpoints
    if (path.endsWith('/explorations') || path.match(/\/explorations\/[0-9]+$/)) {
      if (httpMethod === 'POST' && path.endsWith('/explorations')) {
        const body = JSON.parse(event.body || '{}');
        const { action_id, exploration_code, exploration_notes_text, metrics_text, public_flag } = body;
        
        if (!action_id) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'action_id is required' })
          };
        }
        
        // Check if exploration already exists for this action
        const existingCheckSql = `SELECT id FROM exploration WHERE action_id = '${escapeLiteral(action_id)}' LIMIT 1;`;
        const existing = await queryJSON(existingCheckSql);
        
        if (existing && existing.length > 0) {
          return {
            statusCode: 409,
            headers,
            body: JSON.stringify({ error: 'Exploration already exists for this action' })
          };
        }
        
        // Validate exploration_code uniqueness if provided
        if (exploration_code) {
          const codeCheckSql = `SELECT id FROM exploration WHERE exploration_code = '${escapeLiteral(exploration_code)}' LIMIT 1;`;
          const codeExists = await queryJSON(codeCheckSql);
          
          if (codeExists && codeExists.length > 0) {
            return {
              statusCode: 409,
              headers,
              body: JSON.stringify({ error: 'Exploration code already exists' })
            };
          }
        }
        
        const sql = `
          INSERT INTO exploration (
            action_id, exploration_code, exploration_notes_text, metrics_text, public_flag, created_at, updated_at
          ) VALUES (
            '${escapeLiteral(action_id)}',
            ${exploration_code ? `'${escapeLiteral(exploration_code)}'` : 'NULL'},
            ${exploration_notes_text ? `'${escapeLiteral(exploration_notes_text)}'` : 'NULL'},
            ${metrics_text ? `'${escapeLiteral(metrics_text)}'` : 'NULL'},
            ${public_flag !== undefined ? public_flag : false},
            NOW(),
            NOW()
          )
          RETURNING *;
        `;
        
        try {
          const result = await queryJSON(sql);
          
          // Broadcast cache invalidation to WebSocket clients
          try {
            await broadcastInvalidation({
              entityType: 'exploration',
              entityId: result[0].id.toString(),
              mutationType: 'created',
              organizationId,
              excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
            });
          } catch (err) {
            console.error('[CORE] Broadcast failed:', err.message);
          }
          
          return {
            statusCode: 201,
            headers,
            body: JSON.stringify({ data: result[0] })
          };
        } catch (error) {
          console.error('Error creating exploration:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to create exploration' })
          };
        }
      }
      
      if (httpMethod === 'PUT') {
        const explorationId = path.split('/').pop();
        const body = JSON.parse(event.body || '{}');
        
        const updates = [];
        if (body.exploration_notes_text !== undefined) {
          updates.push(`exploration_notes_text = ${body.exploration_notes_text ? `'${escapeLiteral(body.exploration_notes_text)}'` : 'NULL'}`);
        }
        if (body.metrics_text !== undefined) {
          updates.push(`metrics_text = ${body.metrics_text ? `'${escapeLiteral(body.metrics_text)}'` : 'NULL'}`);
        }
        if (body.public_flag !== undefined) {
          updates.push(`public_flag = ${body.public_flag}`);
        }
        
        if (updates.length === 0) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'No fields to update' })
          };
        }
        
        updates.push('updated_at = NOW()');
        
        const sql = `UPDATE exploration SET ${updates.join(', ')} WHERE id = ${parseInt(explorationId)} RETURNING *;`;
        
        try {
          const result = await queryJSON(sql);
          if (!result || result.length === 0) {
            return {
              statusCode: 404,
              headers,
              body: JSON.stringify({ error: 'Exploration not found' })
            };
          }
          
          // Broadcast cache invalidation to WebSocket clients
          try {
            await broadcastInvalidation({
              entityType: 'exploration',
              entityId: explorationId.toString(),
              mutationType: 'updated',
              organizationId,
              excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
            });
          } catch (err) {
            console.error('[CORE] Broadcast failed:', err.message);
          }
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: result[0] })
          };
        } catch (error) {
          console.error('Error updating exploration:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to update exploration' })
          };
        }
      }
      
      if (httpMethod === 'GET') {
        if (path.match(/\/explorations\/[0-9]+$/)) {
          // Get single exploration by ID
          const explorationId = path.split('/').pop();
          const sql = `SELECT * FROM exploration WHERE id = ${parseInt(explorationId)} LIMIT 1;`;
          
          try {
            const result = await queryJSON(sql);
            if (!result || result.length === 0) {
              return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ error: 'Exploration not found' })
              };
            }
            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({ data: result[0] })
            };
          } catch (error) {
            console.error('Error fetching exploration:', error);
            return {
              statusCode: 500,
              headers,
              body: JSON.stringify({ error: 'Failed to fetch exploration' })
            };
          }
        } else {
          // List explorations with optional filters
          const { action_id, public_flag, limit = 50, offset = 0 } = event.queryStringParameters || {};
          
          const whereConditions = [];
          if (action_id) {
            whereConditions.push(`e.action_id = '${escapeLiteral(action_id)}'`);
          }
          if (public_flag !== undefined) {
            whereConditions.push(`e.public_flag = ${public_flag === 'true'}`);
          }
          
          const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
          
          const sql = `SELECT json_agg(row_to_json(t)) FROM (
            SELECT 
              e.*,
              a.title as action_title,
              a.description as action_description,
              a.status as action_status,
              a.created_at as action_created_at
            FROM exploration e
            LEFT JOIN actions a ON e.action_id = a.id
            ${whereClause}
            ORDER BY e.created_at DESC
            LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
          ) t;`;
          
          try {
            const result = await queryJSON(sql);
            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
            };
          } catch (error) {
            console.error('Error listing explorations:', error);
            return {
              statusCode: 500,
              headers,
              body: JSON.stringify({ error: 'Failed to list explorations' })
            };
          }
        }
      }
      
      if (httpMethod === 'DELETE') {
        const explorationId = path.split('/').pop();
        const sql = `DELETE FROM exploration WHERE id = ${parseInt(explorationId)} RETURNING *;`;
        
        try {
          const result = await queryJSON(sql);
          if (!result || result.length === 0) {
            return {
              statusCode: 404,
              headers,
              body: JSON.stringify({ error: 'Exploration not found' })
            };
          }
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: result[0] })
          };
        } catch (error) {
          console.error('Error deleting exploration:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to delete exploration' })
          };
        }
      }
    }

    // Exploration list endpoint with advanced filtering
    if (path.endsWith('/explorations/list')) {
      if (httpMethod === 'GET') {
        const { 
          start_date, 
          end_date, 
          location, 
          explorer, 
          public_flag, 
          limit = 50, 
          offset = 0 
        } = event.queryStringParameters || {};
        
        const whereConditions = ['a.is_exploration = true'];
        
        // Date range filter
        if (start_date) {
          whereConditions.push(`a.created_at >= '${start_date}'`);
        }
        if (end_date) {
          whereConditions.push(`a.created_at <= '${end_date}'`);
        }
        
        // Location filter
        if (location) {
          whereConditions.push(`a.location = '${escapeLiteral(location)}'`);
        }
        
        // Explorer filter (user who created the action)
        if (explorer) {
          whereConditions.push(`a.created_by = '${escapeLiteral(explorer)}'`);
        }
        
        const whereClause = `WHERE ${whereConditions.join(' AND ')}`;
        
        const sql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT 
            a.id as action_id,
            a.title as action_title,
            a.description as state_text,
            a.policy as policy_text,
            a.attachments as key_photos,
            a.created_at,
            a.created_by as explorer_id,
            om.full_name as explorer_name,
            e.exploration_code,
            e.id as exploration_id,
            e.exploration_notes_text,
            e.metrics_text,
            e.public_flag
          FROM actions a
          LEFT JOIN exploration e ON a.id = e.action_id
          LEFT JOIN LATERAL (
            SELECT full_name FROM organization_members
            WHERE cognito_user_id::text = a.created_by::text
            LIMIT 1
          ) om ON true
          ${whereClause}
          ORDER BY a.created_at DESC
          LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
        ) t;`;
        
        try {
          const result = await queryJSON(sql);
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
          };
        } catch (error) {
          console.error('Error listing explorations with filters:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to list explorations' })
          };
        }
      }
    }

    if (path.match(/\/explorations\/check-code\/(.+)$/)) {
      if (httpMethod === 'GET') {
        const code = decodeURIComponent(path.split('/').pop());
        
        const sql = `SELECT EXISTS(SELECT 1 FROM exploration WHERE exploration_code = '${escapeLiteral(code)}') as exists;`;
        
        try {
          const result = await queryJSON(sql);
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ exists: result[0]?.exists || false })
          };
        } catch (error) {
          console.error('Error checking exploration code:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to check exploration code' })
          };
        }
      }
    }

    if (path.match(/\/explorations\/codes-by-prefix\/(.+)$/)) {
      if (httpMethod === 'GET') {
        const prefix = decodeURIComponent(path.split('/').pop());
        
        const sql = `SELECT exploration_code FROM exploration WHERE exploration_code LIKE '${escapeLiteral(prefix)}%' ORDER BY exploration_code;`;
        
        try {
          const result = await queryJSON(sql);
          const codes = result.map(row => row.exploration_code);
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ codes })
          };
        } catch (error) {
          console.error('Error fetching exploration codes by prefix:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to fetch exploration codes' })
          };
        }
      }
    }

    // Policy endpoints
    if (path.endsWith('/policies') || path.match(/\/policies\/[0-9]+$/)) {
      if (httpMethod === 'POST' && path.endsWith('/policies')) {
        const body = JSON.parse(event.body || '{}');
        const { title, description_text, status, effective_from, effective_to } = body;
        
        if (!title || !description_text) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'title and description_text are required' })
          };
        }
        
        // Validate status
        const validStatuses = ['draft', 'active', 'deprecated'];
        if (status && !validStatuses.includes(status)) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'status must be one of: draft, active, deprecated' })
          };
        }
        
        // Validate date range
        if (effective_from && effective_to && new Date(effective_from) > new Date(effective_to)) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'effective_from must be before effective_to' })
          };
        }
        
        const userId = authContext.cognito_user_id;
        if (!userId) {
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'User context not available' })
          };
        }
        
        const sql = `
          INSERT INTO policy (
            title, description_text, status, effective_from, effective_to, created_by_user_id, created_at, updated_at
          ) VALUES (
            '${escapeLiteral(title)}',
            '${escapeLiteral(description_text)}',
            '${status || 'draft'}',
            ${effective_from ? `'${effective_from}'` : 'NULL'},
            ${effective_to ? `'${effective_to}'` : 'NULL'},
            '${userId}',
            NOW(),
            NOW()
          )
          RETURNING *;
        `;
        
        try {
          const result = await queryJSON(sql);
          
          // Send SQS message for embedding generation
          const policy = result[0];
          const embeddingSource = composePolicyEmbeddingSource(policy);
          
          if (embeddingSource && embeddingSource.trim()) {
            try {
              await sqs.send(new SendMessageCommand({
                QueueUrl: EMBEDDINGS_QUEUE_URL,
                MessageBody: JSON.stringify({
                  entity_type: 'policy',
                  entity_id: policy.id.toString(),
                  embedding_source: embeddingSource,
                  organization_id: organizationId
                })
              }));
              console.log('Queued embedding generation for policy', policy.id);
            } catch (sqsError) {
              console.error('Failed to queue embedding:', sqsError);
              // Non-fatal - continue with response
            }
          }
          
          // Broadcast cache invalidation to WebSocket clients
          try {
            await broadcastInvalidation({
              entityType: 'policy',
              entityId: result[0].id.toString(),
              mutationType: 'created',
              organizationId,
              excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
            });
          } catch (err) {
            console.error('[CORE] Broadcast failed:', err.message);
          }
          
          return {
            statusCode: 201,
            headers,
            body: JSON.stringify({ data: result[0] })
          };
        } catch (error) {
          console.error('Error creating policy:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to create policy' })
          };
        }
      }
      
      if (httpMethod === 'PUT') {
        const policyId = path.split('/').pop();
        const body = JSON.parse(event.body || '{}');
        
        const updates = [];
        if (body.title !== undefined) {
          updates.push(`title = '${escapeLiteral(body.title)}'`);
        }
        if (body.description_text !== undefined) {
          updates.push(`description_text = '${escapeLiteral(body.description_text)}'`);
        }
        if (body.status !== undefined) {
          const validStatuses = ['draft', 'active', 'deprecated'];
          if (!validStatuses.includes(body.status)) {
            return {
              statusCode: 400,
              headers,
              body: JSON.stringify({ error: 'status must be one of: draft, active, deprecated' })
            };
          }
          updates.push(`status = '${body.status}'`);
        }
        if (body.effective_from !== undefined) {
          updates.push(`effective_from = ${body.effective_from ? `'${body.effective_from}'` : 'NULL'}`);
        }
        if (body.effective_to !== undefined) {
          updates.push(`effective_to = ${body.effective_to ? `'${body.effective_to}'` : 'NULL'}`);
        }
        
        if (updates.length === 0) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'No fields to update' })
          };
        }
        
        updates.push('updated_at = NOW()');
        
        const sql = `UPDATE policy SET ${updates.join(', ')} WHERE id = ${parseInt(policyId)} RETURNING *;`;
        
        try {
          const result = await queryJSON(sql);
          if (!result || result.length === 0) {
            return {
              statusCode: 404,
              headers,
              body: JSON.stringify({ error: 'Policy not found' })
            };
          }
          
          // Trigger embedding regeneration if title or description_text changed
          if (body.title !== undefined || body.description_text !== undefined) {
            const policy = result[0];
            const embeddingSource = composePolicyEmbeddingSource(policy);
            
            if (embeddingSource && embeddingSource.trim()) {
              try {
                await sqs.send(new SendMessageCommand({
                  QueueUrl: EMBEDDINGS_QUEUE_URL,
                  MessageBody: JSON.stringify({
                    entity_type: 'policy',
                    entity_id: policy.id.toString(),
                    embedding_source: embeddingSource,
                    organization_id: organizationId
                  })
                }));
                console.log('Queued embedding generation for policy', policy.id);
              } catch (sqsError) {
                console.error('Failed to queue embedding:', sqsError);
                // Non-fatal - continue with response
              }
            }
          }
          
          // Broadcast cache invalidation to WebSocket clients
          try {
            await broadcastInvalidation({
              entityType: 'policy',
              entityId: policyId.toString(),
              mutationType: 'updated',
              organizationId,
              excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
            });
          } catch (err) {
            console.error('[CORE] Broadcast failed:', err.message);
          }
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: result[0] })
          };
        } catch (error) {
          console.error('Error updating policy:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to update policy' })
          };
        }
      }
      
      if (httpMethod === 'GET') {
        if (path.match(/\/policies\/[0-9]+$/)) {
          // Get single policy by ID
          const policyId = path.split('/').pop();
          const sql = `SELECT * FROM policy WHERE id = ${parseInt(policyId)} LIMIT 1;`;
          
          try {
            const result = await queryJSON(sql);
            if (!result || result.length === 0) {
              return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ error: 'Policy not found' })
              };
            }
            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({ data: result[0] })
            };
          } catch (error) {
            console.error('Error fetching policy:', error);
            return {
              statusCode: 500,
              headers,
              body: JSON.stringify({ error: 'Failed to fetch policy' })
            };
          }
        } else {
          // List policies with optional filters
          const { status, created_by, limit = 50, offset = 0 } = event.queryStringParameters || {};
          
          const whereConditions = [];
          if (status) {
            whereConditions.push(`p.status = '${escapeLiteral(status)}'`);
          }
          if (created_by) {
            whereConditions.push(`p.created_by_user_id = '${escapeLiteral(created_by)}'`);
          }
          
          const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
          
          const sql = `SELECT json_agg(row_to_json(t)) FROM (
            SELECT 
              p.*,
              om.full_name as created_by_name
            FROM policy p
            LEFT JOIN LATERAL (
              SELECT full_name FROM organization_members
              WHERE cognito_user_id = p.created_by_user_id
              LIMIT 1
            ) om ON true
            ${whereClause}
            ORDER BY p.created_at DESC
            LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
          ) t;`;
          
          try {
            const result = await queryJSON(sql);
            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
            };
          } catch (error) {
            console.error('Error listing policies:', error);
            return {
              statusCode: 500,
              headers,
              body: JSON.stringify({ error: 'Failed to list policies' })
            };
          }
        }
      }
      
      if (httpMethod === 'DELETE') {
        const policyId = path.split('/').pop();
        
        // Check if policy is linked to any actions
        const linkedCheckSql = `SELECT COUNT(*) as count FROM actions WHERE policy_id = ${parseInt(policyId)};`;
        const linkedResult = await queryJSON(linkedCheckSql);
        
        if (linkedResult && linkedResult[0]?.count > 0) {
          return {
            statusCode: 409,
            headers,
            body: JSON.stringify({ 
              error: `Cannot delete policy: ${linkedResult[0].count} actions are linked to this policy` 
            })
          };
        }
        
        const sql = `DELETE FROM policy WHERE id = ${parseInt(policyId)} RETURNING *;`;
        
        try {
          const result = await queryJSON(sql);
          if (!result || result.length === 0) {
            return {
              statusCode: 404,
              headers,
              body: JSON.stringify({ error: 'Policy not found' })
            };
          }
          
          // Broadcast cache invalidation to WebSocket clients
          try {
            await broadcastInvalidation({
              entityType: 'policy',
              entityId: policyId.toString(),
              mutationType: 'deleted',
              organizationId,
              excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
            });
          } catch (err) {
            console.error('[CORE] Broadcast failed:', err.message);
          }
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: result[0] })
          };
        } catch (error) {
          console.error('Error deleting policy:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to delete policy' })
          };
        }
      }
    }

    // Policy search endpoint
    if (path.endsWith('/policies/search')) {
      if (httpMethod === 'GET') {
        const { q, status, created_by, limit = 50, offset = 0 } = event.queryStringParameters || {};
        
        if (!q) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'q parameter is required for search' })
          };
        }
        
        const whereConditions = [`(p.title ILIKE '%${escapeLiteral(q)}%' OR p.description_text ILIKE '%${escapeLiteral(q)}%')`];
        
        if (status) {
          whereConditions.push(`p.status = '${escapeLiteral(status)}'`);
        }
        if (created_by) {
          whereConditions.push(`p.created_by_user_id = '${escapeLiteral(created_by)}'`);
        }
        
        const whereClause = `WHERE ${whereConditions.join(' AND ')}`;
        
        // Get total count
        const countSql = `SELECT COUNT(*) as total FROM policy p ${whereClause};`;
        
        // Get results
        const resultSql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT 
            p.*,
            om.full_name as created_by_name
          FROM policy p
          LEFT JOIN LATERAL (
            SELECT full_name FROM organization_members
            WHERE cognito_user_id = p.created_by_user_id
            LIMIT 1
          ) om ON true
          ${whereClause}
          ORDER BY p.created_at DESC
          LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
        ) t;`;
        
        try {
          const [countResult, dataResult] = await Promise.all([
            queryJSON(countSql),
            queryJSON(resultSql)
          ]);
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
              data: dataResult?.[0]?.json_agg || [],
              total: countResult?.[0]?.total || 0
            })
          };
        } catch (error) {
          console.error('Error searching policies:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to search policies' })
          };
        }
      }
    }

    // Missions endpoint
    if (path.endsWith('/missions')) {
      if (httpMethod === 'GET') {
        // Use same pattern as actions/parts - build organization filter to return everything user has access to
        const contextForFilter = {
          ...authContext,
          accessible_organization_ids: accessibleOrgIds,
          permissions: authContext.permissions || []
        };
        const orgFilter = buildOrganizationFilter(contextForFilter, 'm');
        
        // Build WHERE clause - empty condition means user has data:read:all permission (return all), 
        // otherwise filter by accessible orgs
        const whereClause = orgFilter.condition ? `WHERE ${orgFilter.condition}` : '';
        
        const sql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT * FROM missions m ${whereClause} ORDER BY m.created_at DESC
        ) t;`;
        
        // Enhanced logging for debugging
        console.log('Missions GET endpoint:', {
          path,
          organization_id: organizationId,
          accessible_orgs: accessibleOrgIds,
          accessible_orgs_count: accessibleOrgIds.length,
          has_data_read_all: hasDataReadAll,
          permissions: authContext.permissions,
          orgFilter_condition: orgFilter.condition,
          whereClause: whereClause,
          sql: sql.substring(0, 300)
        });
        
        try {
          const result = await queryJSON(sql);
          const missions = result?.[0]?.json_agg || [];
          
          console.log('Missions query result:', {
            result_type: typeof result,
            result_length: result?.length,
            json_agg_type: typeof result?.[0]?.json_agg,
            missions_count: missions.length,
            first_mission_org_id: missions[0]?.organization_id || 'none',
            first_mission_title: missions[0]?.title || 'none'
          });
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: missions })
          };
        } catch (error) {
          console.error('❌ ERROR: Failed to query missions:', error);
          console.error('   SQL:', sql);
          console.error('   Error details:', error.message, error.stack);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
              error: 'Failed to fetch missions',
              message: error.message 
            })
          };
        }
      }
      
      if (httpMethod === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { 
          title, 
          problem_statement, 
          created_by, 
          qa_assigned_to,
          template_id,
          template_name,
          template_color,
          template_icon,
          organization_id
        } = body;
        
        if (!title || !created_by) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'title and created_by are required' })
          };
        }
        
        // Map Cognito user ID to database user_id if needed
        let dbUserId = created_by;
        if (created_by.includes('-')) {
          // If it looks like a UUID, assume it's already a database user_id
          dbUserId = created_by;
        } else {
          // If it's a Cognito user ID, look up the database user_id
          const userLookupSql = `SELECT user_id FROM organization_members WHERE cognito_user_id = '${created_by}' LIMIT 1;`;
          const userResult = await queryJSON(userLookupSql);
          if (userResult && userResult.length > 0) {
            dbUserId = userResult[0].user_id;
          } else {
            return {
              statusCode: 400,
              headers,
              body: JSON.stringify({ error: 'User not found in organization' })
            };
          }
        }
        
        // Map qa_assigned_to if provided
        let dbQaUserId = qa_assigned_to;
        if (qa_assigned_to && !qa_assigned_to.includes('-')) {
          const qaUserLookupSql = `SELECT user_id FROM organization_members WHERE cognito_user_id = '${qa_assigned_to}' LIMIT 1;`;
          const qaUserResult = await queryJSON(qaUserLookupSql);
          if (qaUserResult && qaUserResult.length > 0) {
            dbQaUserId = qaUserResult[0].user_id;
          }
        }
        
        // Always use organizationId from authorizer context (not from request body)
        // This ensures security - users can't create resources in organizations they don't belong to
        if (!organizationId) {
          console.error('❌ ERROR: Cannot create mission - organization_id is missing from authorizer context');
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Server configuration error: organization context not available' })
          };
        }
        const orgId = organizationId;
        
        // Include organization_id in INSERT
        const sql = `
          INSERT INTO missions (
            title, 
            problem_statement, 
            created_by, 
            qa_assigned_to,
            organization_id,
            status, 
            template_id,
            template_name,
            template_color,
            template_icon,
            created_at, 
            updated_at
          ) VALUES (
            '${title.replace(/'/g, "''")}', 
            '${(problem_statement || '').replace(/'/g, "''")}', 
            '${dbUserId}', 
            ${dbQaUserId ? `'${dbQaUserId}'` : 'NULL'},
            '${orgId}',
            'planning',
            ${template_id ? `'${template_id}'` : 'NULL'},
            ${template_name ? `'${template_name.replace(/'/g, "''")}'` : 'NULL'},
            ${template_color ? `'${template_color}'` : 'NULL'},
            ${template_icon ? `'${template_icon}'` : 'NULL'},
            NOW(), 
            NOW()
          )
          RETURNING *;
        `;
        
        console.log('SQL:', sql);
        const result = await queryJSON(sql);
        
        // Broadcast cache invalidation to WebSocket clients
        try {
          await broadcastInvalidation({
            entityType: 'mission',
            entityId: result[0].id,
            mutationType: 'created',
            organizationId: orgId,
            excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
          });
        } catch (err) {
          console.error('[CORE] Broadcast failed:', err.message);
        }
        
        return {
          statusCode: 201,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      }
    }

    // Missions by ID endpoint (GET, PUT, DELETE)
    if (path.includes('/missions/') && !path.endsWith('/missions')) {
      const missionId = path.split('/missions/')[1]?.split('/')[0]; // Extract ID, handle trailing paths
      
      if (httpMethod === 'GET') {
        const orgFilter = buildOrganizationFilter(authContext, 'missions');
        const whereClause = orgFilter.condition ? `WHERE missions.id = '${missionId}' AND ${orgFilter.condition}` : `WHERE missions.id = '${missionId}'`;
        
        const sql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT * FROM missions ${whereClause}
        ) t;`;
        
        const result = await queryJSON(sql);
        const mission = result?.[0]?.json_agg?.[0];
        
        if (!mission) {
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Mission not found' })
          };
        }
        
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: mission })
        };
      }
      
      if (httpMethod === 'PUT') {
        const body = JSON.parse(event.body || '{}');
        const { id, created_by, created_at, updated_at, ...missionData } = body;
        
        // Build UPDATE statement
        const updates = [];
        for (const [key, val] of Object.entries(missionData)) {
          if (val === undefined) continue;
          if (val === null) updates.push(`${key} = NULL`);
          else if (typeof val === 'string') updates.push(`${key} = '${val.replace(/'/g, "''")}'`);
          else if (typeof val === 'boolean') updates.push(`${key} = ${val}`);
          else updates.push(`${key} = ${val}`);
        }
        updates.push(`updated_at = NOW()`);
        
        const orgFilter = buildOrganizationFilter(authContext, 'missions');
        const whereClause = orgFilter.condition 
          ? `WHERE id = '${missionId}' AND ${orgFilter.condition}`
          : `WHERE id = '${missionId}'`;
        
        const sql = `UPDATE missions SET ${updates.join(', ')} ${whereClause} RETURNING *;`;
        const result = await queryJSON(sql);
        
        if (!result || result.length === 0) {
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Mission not found' })
          };
        }
        
        // Broadcast cache invalidation to WebSocket clients
        try {
          await broadcastInvalidation({
            entityType: 'mission',
            entityId: missionId,
            mutationType: 'updated',
            organizationId,
            excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
          });
        } catch (err) {
          console.error('[CORE] Broadcast failed:', err.message);
        }
        
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      }
      
      if (httpMethod === 'DELETE') {
        const orgFilter = buildOrganizationFilter(authContext, 'missions');
        const whereClause = orgFilter.condition 
          ? `WHERE id = '${missionId}' AND ${orgFilter.condition}`
          : `WHERE id = '${missionId}'`;
        
        const sql = `DELETE FROM missions ${whereClause} RETURNING id;`;
        const result = await queryJSON(sql);
        
        if (!result || result.length === 0) {
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Mission not found' })
          };
        }
        
        // Broadcast cache invalidation to WebSocket clients
        try {
          await broadcastInvalidation({
            entityType: 'mission',
            entityId: missionId,
            mutationType: 'deleted',
            organizationId,
            excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
          });
        } catch (err) {
          console.error('[CORE] Broadcast failed:', err.message);
        }
        
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: { id: result[0].id } })
        };
      }
    }

    // GET /actions/{id} - Get action by ID
    if (httpMethod === 'GET' && path.match(/\/actions\/[a-f0-9-]+$/)) {
      const actionId = path.split('/').pop();
      const sql = `SELECT json_agg(row_to_json(t)) FROM (
        SELECT 
          a.*,
          COALESCE(om.full_name, p.full_name) as assigned_to_name,
          COALESCE(p.favorite_color, om.favorite_color) as assigned_to_color,
          CASE WHEN scores.context_id IS NOT NULL THEN true ELSE false END as has_score,
          CASE WHEN updates.action_id IS NOT NULL THEN true ELSE false END as has_implementation_updates,
          COALESCE((
            SELECT COUNT(*) 
            FROM state_links sl
            WHERE sl.entity_type = 'action' AND sl.entity_id = a.id
          ), 0) as implementation_update_count,
          e.exploration_code,
          CASE WHEN a.asset_id IS NOT NULL THEN
            json_build_object(
              'id', assets.id,
              'name', assets.name,
              'category', assets.category
            )
          END as asset,
          CASE WHEN a.linked_issue_id IS NOT NULL AND linked_issue.context_type = 'tool' THEN
            json_build_object(
              'id', issue_tools.id,
              'name', issue_tools.name,
              'category', issue_tools.category
            )
          END as issue_tool,
          CASE WHEN a.mission_id IS NOT NULL THEN
            json_build_object(
              'id', missions.id,
              'title', missions.title,
              'mission_number', missions.mission_number
            )
          END as mission
        FROM actions a
        LEFT JOIN LATERAL (
          SELECT full_name, favorite_color FROM organization_members
          WHERE cognito_user_id::text = a.assigned_to::text
          LIMIT 1
        ) om ON true
        LEFT JOIN profiles p ON a.assigned_to::text = p.user_id::text
        LEFT JOIN analysis_contexts scores ON a.id = scores.context_id AND scores.context_service = 'action_score'
        LEFT JOIN (
          SELECT DISTINCT sl.entity_id as action_id
          FROM state_links sl
          WHERE sl.entity_type = 'action'
        ) updates ON a.id = updates.action_id
        LEFT JOIN tools assets ON a.asset_id = assets.id
        LEFT JOIN issues linked_issue ON a.linked_issue_id = linked_issue.id
        LEFT JOIN tools issue_tools ON linked_issue.context_id = issue_tools.id AND linked_issue.context_type = 'tool'
        LEFT JOIN missions ON a.mission_id = missions.id
        LEFT JOIN exploration e ON a.id = e.action_id
        WHERE a.id = '${escapeLiteral(actionId)}'
      ) t;`;
      
      const result = await queryJSON(sql);
      if (!result || result.length === 0 || !result[0] || !result[0].json_agg || result[0].json_agg.length === 0) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Action not found' })
        };
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: result[0].json_agg[0] })
      };
    }

    // Actions endpoint with full details
    if (httpMethod === 'GET' && path.endsWith('/actions')) {
      const { limit, offset = 0, assigned_to, status, id, is_exploration } = event.queryStringParameters || {};
      
      let whereConditions = [];
      if (id) {
        whereConditions.push(`a.id = '${id}'`);
      }
      if (assigned_to) {
        whereConditions.push(`a.assigned_to = '${assigned_to}'`);
      }
      if (status) {
        if (status === 'unresolved') {
          whereConditions.push(`a.status IN ('not_started', 'in_progress', 'blocked')`);
        } else {
          whereConditions.push(`a.status = '${status}'`);
        }
      }
      if (is_exploration !== undefined) {
        // Support filtering by is_exploration flag - explicitly check for true/false to exclude NULLs
        if (is_exploration === 'true' || is_exploration === true) {
          whereConditions.push(`a.is_exploration IS TRUE`);
        } else {
          whereConditions.push(`(a.is_exploration IS FALSE OR a.is_exploration IS NULL)`);
        }
      }
      
      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
      const limitClause = limit ? `LIMIT ${limit} OFFSET ${offset}` : '';
      
      const sql = `SELECT json_agg(row_to_json(t)) FROM (
        SELECT 
          a.*,
          COALESCE(om.full_name, p.full_name) as assigned_to_name,
          COALESCE(p.favorite_color, om.favorite_color) as assigned_to_color,
          CASE WHEN scores.context_id IS NOT NULL THEN true ELSE false END as has_score,
          CASE WHEN updates.action_id IS NOT NULL THEN true ELSE false END as has_implementation_updates,
          COALESCE((
            SELECT COUNT(*) 
            FROM state_links sl
            WHERE sl.entity_type = 'action' AND sl.entity_id = a.id
          ), 0) as implementation_update_count,
          e.exploration_code,
          -- Asset details
          CASE WHEN a.asset_id IS NOT NULL THEN
            json_build_object(
              'id', assets.id,
              'name', assets.name,
              'category', assets.category
            )
          END as asset,
          -- Issue tool details (derived from linked issue's context)
          CASE WHEN a.linked_issue_id IS NOT NULL AND linked_issue.context_type = 'tool' THEN
            json_build_object(
              'id', issue_tools.id,
              'name', issue_tools.name,
              'category', issue_tools.category
            )
          END as issue_tool,
          -- Mission details
          CASE WHEN a.mission_id IS NOT NULL THEN
            json_build_object(
              'id', missions.id,
              'title', missions.title,
              'mission_number', missions.mission_number
            )
          END as mission
        FROM actions a
        LEFT JOIN LATERAL (
          SELECT full_name, favorite_color FROM organization_members
          WHERE cognito_user_id::text = a.assigned_to::text
          LIMIT 1
        ) om ON true
        LEFT JOIN profiles p ON a.assigned_to::text = p.user_id::text
        LEFT JOIN analysis_contexts scores ON a.id = scores.context_id AND scores.context_service = 'action_score'
        LEFT JOIN (
          SELECT DISTINCT sl.entity_id as action_id
          FROM state_links sl
          WHERE sl.entity_type = 'action'
        ) updates ON a.id = updates.action_id
        LEFT JOIN tools assets ON a.asset_id = assets.id
        LEFT JOIN issues linked_issue ON a.linked_issue_id = linked_issue.id
        LEFT JOIN tools issue_tools ON linked_issue.context_id = issue_tools.id AND linked_issue.context_type = 'tool'
        LEFT JOIN missions ON a.mission_id = missions.id
        LEFT JOIN exploration e ON a.id = e.action_id
        ${whereClause} 
        ORDER BY a.updated_at DESC 
        ${limitClause}
      ) t;`;
      
      const result = await queryJSON(sql);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
      };
    }

    // POST /actions - Create new action
    if (httpMethod === 'POST' && path.endsWith('/actions')) {
      const body = JSON.parse(event.body || '{}');
      
      if (!body.title) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'title is required' })
        };
      }

      const actionId = body.id || randomUUID();
      const now = new Date().toISOString();
      
      // Build the INSERT statement
      const insertFields = [
        'id',
        'title',
        'description',
        'policy',
        'assigned_to',
        'status',
        'estimated_duration',
        'required_stock',
        'attachments',
        'mission_id',
        'asset_id',
        'linked_issue_id',
        'issue_reference',
        'plan_commitment',
        'policy_agreed_at',
        'policy_agreed_by',
        'organization_id',
        'created_by',
        'updated_by',
        'created_at',
        'updated_at',
        'is_exploration',
        'summary_policy_text'
      ];

      const insertValues = [
        formatSqlValue(actionId),
        formatSqlValue(body.title),
        formatSqlValue(body.description),
        formatSqlValue(body.policy),
        formatSqlValue(body.assigned_to),
        formatSqlValue(body.status || 'not_started'),
        formatSqlValue(body.estimated_duration),
        formatSqlValue(body.required_stock),
        formatSqlValue(body.attachments || []),
        formatSqlValue(body.mission_id),
        formatSqlValue(body.asset_id),
        formatSqlValue(body.linked_issue_id),
        formatSqlValue(body.issue_reference),
        formatSqlValue(body.plan_commitment),
        formatSqlValue(body.policy_agreed_at),
        formatSqlValue(body.policy_agreed_by),
        (() => {
          if (!organizationId) {
            console.error('❌ ERROR: Cannot create action - organization_id is missing from authorizer context');
            throw new Error('Server configuration error: organization context not available');
          }
          return formatSqlValue(organizationId);
        })(),
        formatSqlValue(body.created_by),
        formatSqlValue(body.updated_by),
        formatSqlValue(now),
        formatSqlValue(now),
        formatSqlValue(Boolean(body.is_exploration)),
        formatSqlValue(body.summary_policy_text)
      ];

      const client = new Client(dbConfig);
      try {
        await client.connect();
        await client.query('BEGIN');

        // Insert the action
        const insertSql = `
          INSERT INTO actions (${insertFields.join(', ')})
          VALUES (${insertValues.join(', ')})
          RETURNING id
        `;
        
        console.log('Insert SQL:', insertSql);
        console.log('Insert values:', JSON.stringify(insertValues, null, 2));
        console.log('Body data:', JSON.stringify(body, null, 2));
        
        let insertResult;
        try {
          insertResult = await client.query(insertSql);
        } catch (sqlError) {
          console.error('SQL Error:', sqlError.message);
          console.error('SQL Query:', insertSql);
          console.error('Insert Fields:', insertFields);
          console.error('Insert Values (raw):', insertValues);
          // Return error with SQL for debugging
          await client.query('ROLLBACK');
          await client.end();
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
              error: sqlError.message,
              sql: insertSql,
              fields: insertFields,
              values: insertValues
            })
          };
        }
        const newActionId = insertResult.rows[0].id;

        // Handle participants if provided
        if (body.participants && Array.isArray(body.participants) && body.participants.length > 0) {
          const participantValues = body.participants.map(userId => 
            `('${escapeLiteral(newActionId)}', '${escapeLiteral(userId)}')`
          ).join(', ');
          
          const participantsSql = `
            INSERT INTO action_participants (action_id, user_id)
            VALUES ${participantValues}
            ON CONFLICT (action_id, user_id) DO NOTHING
          `;
          await client.query(participantsSql);
        }

        await client.query('COMMIT');

        // Fetch the created action with all joins
        const fetchSql = `
          SELECT json_agg(row_to_json(t)) FROM (
            SELECT 
              a.*,
              om.full_name as assigned_to_name,
              om.favorite_color as assigned_to_color,
              e.exploration_code,
              CASE WHEN participants.participants IS NOT NULL THEN
                participants.participants
              END as participants_details
            FROM actions a
            LEFT JOIN profiles om ON a.assigned_to = om.user_id
            LEFT JOIN exploration e ON a.id = e.action_id
            LEFT JOIN (
              SELECT 
                ap.action_id,
                json_agg(
                  json_build_object(
                    'user_id', om_part.user_id,
                    'full_name', om_part.full_name,
                    'favorite_color', om_part.favorite_color
                  )
                ) as participants
              FROM action_participants ap
              LEFT JOIN profiles om_part ON ap.user_id = om_part.user_id
              WHERE ap.action_id = '${escapeLiteral(newActionId)}'
              GROUP BY ap.action_id
            ) participants ON a.id = participants.action_id
            WHERE a.id = '${escapeLiteral(newActionId)}'
          ) t;
        `;
        
        const fetchResult = await queryJSON(fetchSql);
        
        // Broadcast cache invalidation to WebSocket clients
        try {
          await broadcastInvalidation({
            entityType: 'action',
            entityId: newActionId,
            mutationType: 'created',
            organizationId,
            excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
          });
        } catch (err) {
          console.error('[CORE] Broadcast failed:', err.message);
        }
        
        return {
          statusCode: 201,
          headers,
          body: JSON.stringify({ data: fetchResult?.[0]?.json_agg?.[0] || null })
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        await client.end();
      }
    }

    // PUT /actions/{id} - Update action
    if (httpMethod === 'PUT' && path.match(/\/actions\/[a-f0-9-]+$/)) {
      const actionId = path.split('/').pop();
      const body = JSON.parse(event.body || '{}');
      
      // Define allowed fields for update
      const allowedFields = [
        'title', 'description', 'policy', 'assigned_to', 'status',
        'estimated_duration', 'required_stock', 'attachments',
        'mission_id', 'asset_id', 'linked_issue_id', 'issue_reference',
        'plan_commitment', 'policy_agreed_at', 'policy_agreed_by',
        'is_exploration', 'summary_policy_text'
      ];
      
      const updates = buildUpdateClauses(body, allowedFields);
      
      if (updates.length === 0) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'No fields to update' })
        };
      }
      
      // Add updated_at timestamp
      updates.push(`updated_at = '${new Date().toISOString()}'`);
      
      const client = new Client(dbConfig);
      try {
        await client.connect();
        await client.query('BEGIN');
        
        // Update the action
        const updateSql = `
          UPDATE actions 
          SET ${updates.join(', ')}
          WHERE id = '${escapeLiteral(actionId)}'
          RETURNING id
        `;
        
        const updateResult = await client.query(updateSql);
        
        if (updateResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Action not found' })
          };
        }
        
        await client.query('COMMIT');
        
        // Fetch and return the updated action with full details
        const fetchSql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT 
            a.*,
            om.full_name as assigned_to_name,
            om.favorite_color as assigned_to_color,
            CASE WHEN scores.context_id IS NOT NULL THEN true ELSE false END as has_score,
            CASE WHEN updates.action_id IS NOT NULL THEN true ELSE false END as has_implementation_updates,
            COALESCE((
              SELECT COUNT(*) 
              FROM state_links sl
              WHERE sl.entity_type = 'action' AND sl.entity_id = a.id
            ), 0) as implementation_update_count,
            e.exploration_code,
            -- Asset details
            CASE WHEN a.asset_id IS NOT NULL THEN
              json_build_object(
                'id', assets.id,
                'name', assets.name,
                'category', assets.category
              )
            END as asset,
            -- Mission details
            CASE WHEN a.mission_id IS NOT NULL THEN
              json_build_object(
                'id', missions.id,
                'title', missions.title,
                'mission_number', missions.mission_number
              )
            END as mission,
            -- Participants details
            CASE WHEN participants.participants IS NOT NULL THEN
              participants.participants
            END as participants_details
          FROM actions a
          LEFT JOIN profiles om ON a.assigned_to = om.user_id
          LEFT JOIN analysis_contexts scores ON a.id = scores.context_id AND scores.context_service = 'action_score'
          LEFT JOIN (
            SELECT DISTINCT sl.entity_id as action_id
            FROM state_links sl
            WHERE sl.entity_type = 'action'
          ) updates ON a.id = updates.action_id
          LEFT JOIN tools assets ON a.asset_id = assets.id
          LEFT JOIN missions ON a.mission_id = missions.id
          LEFT JOIN exploration e ON a.id = e.action_id
          LEFT JOIN (
            SELECT 
              ap.action_id,
              json_agg(
                json_build_object(
                  'user_id', om_part.user_id,
                  'full_name', om_part.full_name,
                  'favorite_color', om_part.favorite_color
                )
              ) as participants
            FROM action_participants ap
            LEFT JOIN profiles om_part ON ap.user_id = om_part.user_id
            WHERE ap.action_id = '${escapeLiteral(actionId)}'
            GROUP BY ap.action_id
          ) participants ON a.id = participants.action_id
          WHERE a.id = '${escapeLiteral(actionId)}'
        ) t;`;
        
        const fetchResult = await queryJSON(fetchSql);
        
        // Broadcast cache invalidation to WebSocket clients
        try {
          await broadcastInvalidation({
            entityType: 'action',
            entityId: actionId,
            mutationType: 'updated',
            organizationId,
            excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
          });
        } catch (err) {
          console.error('[CORE] Broadcast failed:', err.message);
        }
        
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: fetchResult?.[0]?.json_agg?.[0] || null })
        };
      } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating action:', error);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: error.message })
        };
      } finally {
        await client.end();
      }
    }

    // Admin endpoint for exploration consistency validation
    if (httpMethod === 'GET' && path === '/admin/validate-exploration-consistency') {
      // This endpoint calls the database validation function
      const sql = `SELECT * FROM validate_exploration_consistency()`;
      
      try {
        const result = await queryJSON(sql);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result })
        };
      } catch (error) {
        console.error('Error validating exploration consistency:', error);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: error.message })
        };
      }
    }

    // Action implementation updates endpoint (now using states table)
    if (path.endsWith('/action_implementation_updates') || path.match(/\/action_implementation_updates\/[a-f0-9-]+$/)) {
      // DELETE by ID
      if (httpMethod === 'DELETE' && path.match(/\/action_implementation_updates\/[a-f0-9-]+$/)) {
        const updateId = path.split('/').pop();
        // Delete from states table (state_links will cascade delete)
        const sql = `DELETE FROM states WHERE id = '${escapeLiteral(updateId)}' RETURNING *`;
        const result = await queryJSON(sql);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      }
      
      // PUT by ID
      if (httpMethod === 'PUT' && path.match(/\/action_implementation_updates\/[a-f0-9-]+$/)) {
        const updateId = path.split('/').pop();
        const body = JSON.parse(event.body || '{}');
        // Map update_text to state_text
        const updates = [];
        if (body.update_text !== undefined) {
          updates.push(`state_text = ${formatSqlValue(body.update_text)}`);
        }
        if (updates.length === 0) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'No fields to update' })
          };
        }
        updates.push("updated_at = NOW()");
        const sql = `UPDATE states SET ${updates.join(', ')} WHERE id = '${escapeLiteral(updateId)}' RETURNING *`;
        const result = await queryJSON(sql);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: result[0] })
        };
      }
      
      if (httpMethod === 'POST') {
        const body = JSON.parse(event.body || '{}');
        const { action_id, update_text, updated_by } = body;
        
        if (!action_id || !update_text || !updated_by) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'action_id, update_text, and updated_by are required' })
          };
        }
        
        const stateId = randomUUID();
        
        // Insert into states table
        const stateSql = `
          INSERT INTO states (id, organization_id, state_text, captured_by, captured_at, created_at, updated_at)
          VALUES (
            '${stateId}',
            '${escapeLiteral(organizationId)}',
            ${formatSqlValue(update_text)},
            '${escapeLiteral(updated_by)}',
            NOW(),
            NOW(),
            NOW()
          )
          RETURNING *
        `;
        
        const stateResult = await queryJSON(stateSql);
        
        // Insert into state_links table
        const linkSql = `
          INSERT INTO state_links (state_id, entity_type, entity_id, created_at)
          VALUES (
            '${stateId}',
            'action',
            '${escapeLiteral(action_id)}',
            NOW()
          )
        `;
        
        await queryJSON(linkSql);
        
        // Return state with mapped field names for backward compatibility
        const result = {
          ...stateResult[0],
          action_id: action_id,
          update_text: stateResult[0].state_text,
          updated_by: stateResult[0].captured_by
        };
        
        // Broadcast cache invalidation for the new state/observation
        try {
          await broadcastInvalidation({
            entityType: 'state',
            entityId: stateId,
            mutationType: 'created',
            organizationId,
            excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
          });
        } catch (err) {
          console.error('[CORE] Broadcast failed:', err.message);
        }

        return {
          statusCode: 201,
          headers,
          body: JSON.stringify({ data: result })
        };
      }
      
      if (httpMethod === 'GET') {
        const { action_id, start_date, end_date, user_ids, limit = 50 } = event.queryStringParameters || {};
        
        let whereConditions = [];
        
        // Always filter by organization via actions table
        if (!hasDataReadAll && organizationId) {
          whereConditions.push(`a.organization_id::text = '${escapeLiteral(organizationId)}'`);
        }
        
        if (action_id) {
          whereConditions.push(`sl.entity_id = '${escapeLiteral(action_id)}'`);
        }
        if (start_date) {
          whereConditions.push(`s.created_at >= '${start_date}'`);
        }
        if (end_date) {
          whereConditions.push(`s.created_at <= '${end_date}'`);
        }
        if (user_ids) {
          const ids = user_ids.split(',').map(id => `'${escapeLiteral(id)}'`).join(',');
          whereConditions.push(`s.captured_by IN (${ids})`);
        }
        
        // Always filter by entity_type = 'action'
        whereConditions.push(`sl.entity_type = 'action'`);
        
        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        
        const sql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT 
            s.id,
            sl.entity_id as action_id,
            COALESCE(
              s.state_text,
              (
                SELECT string_agg(sp.photo_description, E'\\n' ORDER BY sp.photo_order)
                FROM state_photos sp
                WHERE sp.state_id = s.id AND sp.photo_description IS NOT NULL AND sp.photo_description != ''
              ),
              ''
            ) as update_text,
            s.captured_by as updated_by,
            s.created_at,
            s.updated_at,
            COALESCE(om.full_name, p.full_name, s.captured_by::text) as updated_by_name,
            COALESCE(p.favorite_color, om.favorite_color) as updated_by_color
          FROM states s
          JOIN state_links sl ON s.id = sl.state_id
          LEFT JOIN actions a ON sl.entity_id = a.id
          LEFT JOIN LATERAL (
            SELECT full_name, favorite_color FROM organization_members
            WHERE cognito_user_id::text = s.captured_by::text
            LIMIT 1
          ) om ON true
          LEFT JOIN profiles p ON s.captured_by::text = p.user_id::text
          ${whereClause}
          ORDER BY s.created_at DESC 
          LIMIT ${parseInt(limit)}
        ) t;`;
        
        console.log('action_implementation_updates GET SQL (now using states):', sql);
        
        try {
          const result = await queryJSON(sql);
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
          };
        } catch (error) {
          console.error('Error fetching action_implementation_updates:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to fetch updates', details: error.message })
          };
        }
      }
    }

    // Analytics endpoints
    if (path.startsWith('/analytics/')) {
      // Exploration percentages
      if (httpMethod === 'GET' && path.endsWith('/analytics/exploration-percentages')) {
        const { 
          start_date, 
          end_date, 
          location, 
          explorer, 
          status, 
          organization_id 
        } = event.queryStringParameters || {};
        
        if (!start_date || !end_date) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'start_date and end_date are required' })
          };
        }
        
        try {
          let whereConditions = [
            `a.created_at >= '${start_date}'`,
            `a.created_at <= '${end_date}'`
          ];
          
          if (location) {
            whereConditions.push(`a.location = '${escapeLiteral(location)}'`);
          }
          if (explorer) {
            whereConditions.push(`a.created_by = '${escapeLiteral(explorer)}'`);
          }
          if (status) {
            whereConditions.push(`a.status = '${escapeLiteral(status)}'`);
          }
          if (organization_id) {
            whereConditions.push(`a.organization_id = '${escapeLiteral(organization_id)}'`);
          }
          
          const whereClause = `WHERE ${whereConditions.join(' AND ')}`;
          
          const sql = `
            SELECT 
              COUNT(*) as total_actions,
              COUNT(e.id) as total_explorations,
              CASE 
                WHEN COUNT(*) > 0 THEN ROUND((COUNT(e.id)::numeric / COUNT(*)::numeric) * 100, 2)
                ELSE 0 
              END as exploration_percentage
            FROM actions a
            LEFT JOIN exploration e ON a.id = e.action_id
            ${whereClause};
          `;
          
          const result = await queryJSON(sql);
          const data = result[0] || { total_actions: 0, total_explorations: 0, exploration_percentage: 0 };
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              data: {
                ...data,
                date_range: {
                  start: start_date,
                  end: end_date
                }
              }
            })
          };
        } catch (error) {
          console.error('Failed to get exploration percentages:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to get exploration percentages' })
          };
        }
      }
      
      // Exploration percentages with breakdown
      if (httpMethod === 'GET' && path.endsWith('/analytics/exploration-percentages-breakdown')) {
        const { 
          start_date, 
          end_date, 
          period = 'week',
          location, 
          explorer, 
          status, 
          organization_id 
        } = event.queryStringParameters || {};
        
        if (!start_date || !end_date) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'start_date and end_date are required' })
          };
        }
        
        try {
          let whereConditions = [
            `a.created_at >= '${start_date}'`,
            `a.created_at <= '${end_date}'`
          ];
          
          if (location) whereConditions.push(`a.location = '${escapeLiteral(location)}'`);
          if (explorer) whereConditions.push(`a.created_by = '${escapeLiteral(explorer)}'`);
          if (status) whereConditions.push(`a.status = '${escapeLiteral(status)}'`);
          if (organization_id) whereConditions.push(`a.organization_id = '${escapeLiteral(organization_id)}'`);
          
          const whereClause = `WHERE ${whereConditions.join(' AND ')}`;
          
          // Determine date truncation based on period
          const dateTrunc = period === 'day' ? 'day' : 
                           period === 'month' ? 'month' : 'week';
          
          const sql = `
            WITH period_data AS (
              SELECT 
                DATE_TRUNC('${dateTrunc}', a.created_at) as period_start,
                COUNT(*) as total_actions,
                COUNT(e.id) as total_explorations
              FROM actions a
              LEFT JOIN exploration e ON a.id = e.action_id
              ${whereClause}
              GROUP BY DATE_TRUNC('${dateTrunc}', a.created_at)
              ORDER BY period_start
            )
            SELECT 
              period_start,
              period_start + INTERVAL '1 ${dateTrunc}' - INTERVAL '1 day' as period_end,
              total_actions,
              total_explorations,
              CASE 
                WHEN total_actions > 0 THEN ROUND((total_explorations::numeric / total_actions::numeric) * 100, 2)
                ELSE 0 
              END as exploration_percentage
            FROM period_data;
          `;
          
          const breakdownResult = await queryJSON(sql);
          
          // Get overall totals
          const totalsSql = `
            SELECT 
              COUNT(*) as total_actions,
              COUNT(e.id) as total_explorations,
              CASE 
                WHEN COUNT(*) > 0 THEN ROUND((COUNT(e.id)::numeric / COUNT(*)::numeric) * 100, 2)
                ELSE 0 
              END as exploration_percentage
            FROM actions a
            LEFT JOIN exploration e ON a.id = e.action_id
            ${whereClause};
          `;
          
          const totalsResult = await queryJSON(totalsSql);
          const totals = totalsResult[0] || { total_actions: 0, total_explorations: 0, exploration_percentage: 0 };
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              data: {
                ...totals,
                date_range: {
                  start: start_date,
                  end: end_date
                },
                breakdown_by_period: {
                  period: period,
                  data: breakdownResult
                }
              }
            })
          };
        } catch (error) {
          console.error('Failed to get exploration percentages breakdown:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to get exploration percentages breakdown' })
          };
        }
      }
      
      // Pattern analysis
      if (httpMethod === 'GET' && path.endsWith('/analytics/pattern-analysis')) {
        const { 
          start_date, 
          end_date, 
          location, 
          explorer, 
          public_flag, 
          organization_id 
        } = event.queryStringParameters || {};
        
        if (!start_date || !end_date) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'start_date and end_date are required' })
          };
        }
        
        try {
          // Exploration code patterns
          let explorationWhereConditions = [`e.created_at >= '${start_date}'`, `e.created_at <= '${end_date}'`];
          if (public_flag !== undefined) {
            explorationWhereConditions.push(`e.public_flag = ${public_flag === 'true'}`);
          }
          
          const explorationTrendsSql = `
            SELECT 
              SUBSTRING(exploration_code FROM '^[A-Z]{2}\\d{6}EX') as exploration_code_pattern,
              COUNT(*) as count,
              MIN(e.created_at) as earliest_date,
              MAX(e.created_at) as latest_date
            FROM exploration e
            WHERE ${explorationWhereConditions.join(' AND ')}
              AND exploration_code IS NOT NULL
            GROUP BY SUBSTRING(exploration_code FROM '^[A-Z]{2}\\d{6}EX')
            ORDER BY count DESC
            LIMIT 10;
          `;
          
          const explorationTrends = await queryJSON(explorationTrendsSql);
          
          // Policy adoption
          const policyAdoptionSql = `
            SELECT 
              p.id as policy_id,
              p.title as policy_title,
              COUNT(a.id) as linked_actions_count,
              ROUND((COUNT(a.id)::numeric / total_actions.count::numeric) * 100, 2) as adoption_percentage
            FROM policy p
            LEFT JOIN actions a ON a.policy_id = p.id 
              AND a.created_at >= '${start_date}' 
              AND a.created_at <= '${end_date}'
            CROSS JOIN (
              SELECT COUNT(*) as count 
              FROM actions 
              WHERE created_at >= '${start_date}' 
                AND created_at <= '${end_date}'
            ) total_actions
            WHERE p.status = 'active'
            GROUP BY p.id, p.title, total_actions.count
            ORDER BY linked_actions_count DESC
            LIMIT 10;
          `;
          
          const policyAdoption = await queryJSON(policyAdoptionSql);
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              data: {
                common_themes: [], // Would require more sophisticated text analysis
                exploration_trends: explorationTrends.map(trend => ({
                  exploration_code_pattern: trend.exploration_code_pattern,
                  count: trend.count,
                  date_range: {
                    start: trend.earliest_date,
                    end: trend.latest_date
                  }
                })),
                policy_adoption: policyAdoption
              }
            })
          };
        } catch (error) {
          console.error('Failed to analyze patterns:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to analyze patterns' })
          };
        }
      }
      
      // Exploration trends
      if (httpMethod === 'GET' && path.endsWith('/analytics/exploration-trends')) {
        const { 
          start_date, 
          end_date, 
          group_by = 'week',
          location, 
          explorer, 
          organization_id 
        } = event.queryStringParameters || {};
        
        if (!start_date || !end_date) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'start_date and end_date are required' })
          };
        }
        
        try {
          let whereConditions = [
            `a.created_at >= '${start_date}'`,
            `a.created_at <= '${end_date}'`
          ];
          
          if (location) whereConditions.push(`a.location = '${escapeLiteral(location)}'`);
          if (explorer) whereConditions.push(`a.created_by = '${escapeLiteral(explorer)}'`);
          if (organization_id) whereConditions.push(`a.organization_id = '${escapeLiteral(organization_id)}'`);
          
          const whereClause = `WHERE ${whereConditions.join(' AND ')}`;
          const dateTrunc = group_by === 'day' ? 'day' : group_by === 'month' ? 'month' : 'week';
          
          const sql = `
            WITH period_data AS (
              SELECT 
                DATE_TRUNC('${dateTrunc}', a.created_at) as period_start,
                COUNT(*) as action_count,
                COUNT(e.id) as exploration_count,
                ARRAY_AGG(e.exploration_code) FILTER (WHERE e.exploration_code IS NOT NULL) as exploration_codes
              FROM actions a
              LEFT JOIN exploration e ON a.id = e.action_id
              ${whereClause}
              GROUP BY DATE_TRUNC('${dateTrunc}', a.created_at)
              ORDER BY period_start
            )
            SELECT 
              period_start,
              period_start + INTERVAL '1 ${dateTrunc}' - INTERVAL '1 day' as period_end,
              action_count,
              exploration_count,
              CASE 
                WHEN action_count > 0 THEN ROUND((exploration_count::numeric / action_count::numeric) * 100, 2)
                ELSE 0 
              END as exploration_percentage,
              COALESCE(exploration_codes, ARRAY[]::text[]) as top_exploration_codes
            FROM period_data;
          `;
          
          const result = await queryJSON(sql);
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: result })
          };
        } catch (error) {
          console.error('Failed to get exploration trends:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to get exploration trends' })
          };
        }
      }
      
      // Policy adoption analysis
      if (httpMethod === 'GET' && path.endsWith('/analytics/policy-adoption')) {
        const { 
          start_date, 
          end_date, 
          status = 'active', 
          organization_id 
        } = event.queryStringParameters || {};
        
        if (!start_date || !end_date) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'start_date and end_date are required' })
          };
        }
        
        try {
          let policyWhereConditions = [`p.status = '${escapeLiteral(status)}'`];
          let actionWhereConditions = [
            `a.created_at >= '${start_date}'`,
            `a.created_at <= '${end_date}'`
          ];
          
          if (organization_id) {
            actionWhereConditions.push(`a.organization_id = '${escapeLiteral(organization_id)}'`);
          }
          
          const sql = `
            WITH policy_stats AS (
              SELECT 
                COUNT(DISTINCT p.id) as total_policies,
                COUNT(DISTINCT CASE WHEN p.status = 'active' THEN p.id END) as active_policies,
                COUNT(DISTINCT a.id) as total_linked_actions
              FROM policy p
              LEFT JOIN actions a ON a.policy_id = p.id 
                AND ${actionWhereConditions.join(' AND ')}
              WHERE ${policyWhereConditions.join(' AND ')}
            ),
            top_policies AS (
              SELECT 
                p.id as policy_id,
                p.title as policy_title,
                COUNT(a.id) as linked_actions_count,
                p.created_at
              FROM policy p
              LEFT JOIN actions a ON a.policy_id = p.id 
                AND ${actionWhereConditions.join(' AND ')}
              WHERE ${policyWhereConditions.join(' AND ')}
              GROUP BY p.id, p.title, p.created_at
              ORDER BY linked_actions_count DESC
              LIMIT 10
            ),
            total_actions AS (
              SELECT COUNT(*) as count 
              FROM actions 
              WHERE ${actionWhereConditions.join(' AND ')}
            )
            SELECT 
              ps.total_policies,
              ps.active_policies,
              ps.total_linked_actions,
              CASE 
                WHEN ta.count > 0 THEN ROUND((ps.total_linked_actions::numeric / ta.count::numeric) * 100, 2)
                ELSE 0 
              END as policy_adoption_rate,
              json_agg(
                json_build_object(
                  'policy_id', tp.policy_id,
                  'policy_title', tp.policy_title,
                  'linked_actions_count', tp.linked_actions_count,
                  'adoption_percentage', CASE 
                    WHEN ta.count > 0 THEN ROUND((tp.linked_actions_count::numeric / ta.count::numeric) * 100, 2)
                    ELSE 0 
                  END,
                  'created_at', tp.created_at
                )
              ) as top_policies
            FROM policy_stats ps
            CROSS JOIN total_actions ta
            CROSS JOIN top_policies tp
            GROUP BY ps.total_policies, ps.active_policies, ps.total_linked_actions, ta.count;
          `;
          
          const result = await queryJSON(sql);
          const data = result[0] || {
            total_policies: 0,
            active_policies: 0,
            total_linked_actions: 0,
            policy_adoption_rate: 0,
            top_policies: []
          };
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data })
          };
        } catch (error) {
          console.error('Failed to analyze policy adoption:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to analyze policy adoption' })
          };
        }
      }
    }

    // Semantic Search endpoints
    if (path.startsWith('/search/')) {
      // Cross-entity semantic search
      if (httpMethod === 'POST' && path.endsWith('/search/semantic')) {
        const body = JSON.parse(event.body || '{}');
        const { query, filters = {} } = body;
        
        if (!query || !query.text) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'query.text is required' })
          };
        }
        
        try {
          // Generate embedding for the query
          const embeddingResponse = await apiService.post('/ai/generate-embedding', {
            text: query.text,
            model: query.model || 'text-embedding-3-small'
          });
          
          const queryEmbedding = embeddingResponse.embedding || embeddingResponse.data?.embedding;
          
          if (!queryEmbedding) {
            throw new Error('Failed to generate query embedding');
          }
          
          const startTime = Date.now();
          const limit = query.limit || 10;
          const threshold = query.threshold || 0.7;
          
          // Search across entity types
          const entityTypes = filters.entity_types || ['actions', 'explorations', 'policies'];
          const searchPromises = [];
          
          if (entityTypes.includes('actions')) {
            const actionSearchParams = new URLSearchParams({
              limit: limit.toString(),
              threshold: threshold.toString()
            });
            
            if (filters.embedding_types) {
              const actionTypes = filters.embedding_types.filter(t => 
                ['state', 'policy_text', 'summary_policy_text'].includes(t)
              );
              if (actionTypes.length > 0) {
                actionSearchParams.append('embedding_types', actionTypes.join(','));
              }
            }
            
            searchPromises.push(
              apiService.post(`/embeddings/action_embedding/search?${actionSearchParams.toString()}`, {
                query_embedding: queryEmbedding
              }).then(response => ({ type: 'actions', results: response.data || [] }))
            );
          }
          
          if (entityTypes.includes('explorations')) {
            const explorationSearchParams = new URLSearchParams({
              limit: limit.toString(),
              threshold: threshold.toString()
            });
            
            if (filters.embedding_types) {
              const explorationTypes = filters.embedding_types.filter(t => 
                ['exploration_notes', 'metrics'].includes(t)
              );
              if (explorationTypes.length > 0) {
                explorationSearchParams.append('embedding_types', explorationTypes.join(','));
              }
            }
            
            searchPromises.push(
              apiService.post(`/embeddings/exploration_embedding/search?${explorationSearchParams.toString()}`, {
                query_embedding: queryEmbedding
              }).then(response => ({ type: 'explorations', results: response.data || [] }))
            );
          }
          
          if (entityTypes.includes('policies')) {
            const policySearchParams = new URLSearchParams({
              limit: limit.toString(),
              threshold: threshold.toString()
            });
            
            if (filters.embedding_types) {
              const policyTypes = filters.embedding_types.filter(t => t === 'policy_description');
              if (policyTypes.length > 0) {
                policySearchParams.append('embedding_types', policyTypes.join(','));
              }
            }
            
            searchPromises.push(
              apiService.post(`/embeddings/policy_embedding/search?${policySearchParams.toString()}`, {
                query_embedding: queryEmbedding
              }).then(response => ({ type: 'policies', results: response.data || [] }))
            );
          }
          
          const searchResults = await Promise.all(searchPromises);
          const searchTime = Date.now() - startTime;
          
          // Organize results by entity type
          const organizedResults = {
            actions: [],
            explorations: [],
            policies: [],
            total_results: 0,
            search_metadata: {
              query_text: query.text,
              model_used: query.model || 'text-embedding-3-small',
              threshold,
              search_time_ms: searchTime
            }
          };
          
          searchResults.forEach(({ type, results }) => {
            organizedResults[type] = results.map(result => ({
              ...result,
              entity_type: type.slice(0, -1) // Remove 's' from plural
            }));
            organizedResults.total_results += results.length;
          });
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: organizedResults })
          };
        } catch (error) {
          console.error('Failed to perform semantic search:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to perform semantic search' })
          };
        }
      }
      
      // Find similar entities
      if (httpMethod === 'GET' && path.match(/\/search\/similar\/(actions|explorations|policies)\/(.+)$/)) {
        const matches = path.match(/\/search\/similar\/(actions|explorations|policies)\/(.+)$/);
        const entityType = matches[1];
        const entityId = matches[2];
        
        const { 
          embedding_type = entityType === 'actions' ? 'state' : 
                          entityType === 'explorations' ? 'exploration_notes' : 
                          'policy_description',
          limit = 10,
          threshold = 0.7,
          exclude_self = 'true'
        } = event.queryStringParameters || {};
        
        try {
          // Get the source entity's embedding
          const embeddingTable = entityType === 'actions' ? 'action_embedding' :
                               entityType === 'explorations' ? 'exploration_embedding' :
                               'policy_embedding';
          
          const embeddingsSql = `
            SELECT embedding FROM ${embeddingTable} 
            WHERE entity_id = '${escapeLiteral(entityId)}' 
              AND embedding_type = '${escapeLiteral(embedding_type)}'
            ORDER BY created_at DESC 
            LIMIT 1;
          `;
          
          const embeddingResult = await queryJSON(embeddingsSql);
          
          if (!embeddingResult || embeddingResult.length === 0) {
            return {
              statusCode: 404,
              headers,
              body: JSON.stringify({ error: `No ${embedding_type} embedding found for ${entityType.slice(0, -1)} ${entityId}` })
            };
          }
          
          const sourceEmbedding = embeddingResult[0].embedding;
          
          // Search for similar entities
          const searchParams = new URLSearchParams({
            limit: (parseInt(limit) + (exclude_self === 'true' ? 1 : 0)).toString(),
            threshold: threshold.toString(),
            embedding_types: embedding_type
          });
          
          const searchResponse = await apiService.post(`/embeddings/${embeddingTable}/search?${searchParams.toString()}`, {
            query_embedding: sourceEmbedding
          });
          
          let results = searchResponse.data || [];
          
          // Exclude the source entity if requested
          if (exclude_self === 'true') {
            results = results.filter(result => result.entity_id !== entityId);
          }
          
          // Limit results
          results = results.slice(0, parseInt(limit));
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: results })
          };
        } catch (error) {
          console.error(`Failed to find similar ${entityType}:`, error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: `Failed to find similar ${entityType}` })
          };
        }
      }
      
      // Search suggestions
      if (httpMethod === 'GET' && path.endsWith('/search/suggestions')) {
        const { q, limit = 5 } = event.queryStringParameters || {};
        
        if (!q || q.length < 2) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: [] })
          };
        }
        
        try {
          // Simple implementation - search across entity titles/descriptions
          const suggestions = new Set();
          
          // Search action titles
          const actionsSql = `
            SELECT DISTINCT title FROM actions 
            WHERE title ILIKE '%${escapeLiteral(q)}%' 
            LIMIT ${parseInt(limit)};
          `;
          const actionsResult = await queryJSON(actionsSql);
          actionsResult.forEach(row => suggestions.add(row.title));
          
          // Search exploration codes
          const explorationsSql = `
            SELECT DISTINCT exploration_code FROM exploration 
            WHERE exploration_code ILIKE '%${escapeLiteral(q)}%' 
            LIMIT ${parseInt(limit)};
          `;
          const explorationsResult = await queryJSON(explorationsSql);
          explorationsResult.forEach(row => suggestions.add(row.exploration_code));
          
          // Search policy titles
          const policiesSql = `
            SELECT DISTINCT title FROM policy 
            WHERE title ILIKE '%${escapeLiteral(q)}%' 
            LIMIT ${parseInt(limit)};
          `;
          const policiesResult = await queryJSON(policiesSql);
          policiesResult.forEach(row => suggestions.add(row.title));
          
          const suggestionsList = Array.from(suggestions).slice(0, parseInt(limit));
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: suggestionsList })
          };
        } catch (error) {
          console.error('Failed to get search suggestions:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to get search suggestions' })
          };
        }
      }
    }

    // Embedding endpoints
    if (path.startsWith('/embeddings/')) {
      // Enqueue embedding job
      if (httpMethod === 'POST' && path.endsWith('/embeddings/enqueue')) {
        const body = JSON.parse(event.body || '{}');
        const { id, table, text, embedding_type, model, delay_seconds, retry_count } = body;
        
        if (!id || !table || !text || !embedding_type) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'id, table, text, and embedding_type are required' })
          };
        }
        
        try {
          const messageBody = JSON.stringify({
            id,
            table,
            text: text.trim(),
            embedding_type,
            model: model || 'text-embedding-3-small',
            retry_count: retry_count || 3,
            enqueued_at: new Date().toISOString()
          });
          
          const sqsParams = {
            QueueUrl: EMBEDDINGS_QUEUE_URL,
            MessageBody: messageBody
          };
          
          if (delay_seconds && delay_seconds > 0) {
            sqsParams.DelaySeconds = Math.min(delay_seconds, 900); // Max 15 minutes
          }
          
          await sqs.send(new SendMessageCommand(sqsParams));
          
          console.log(`Enqueued embedding job: ${table}:${id}:${embedding_type}`);
          
          return {
            statusCode: 201,
            headers,
            body: JSON.stringify({ 
              success: true,
              message: `Embedding job enqueued for ${table}:${id}:${embedding_type}`
            })
          };
        } catch (error) {
          console.error('Failed to enqueue embedding job:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to enqueue embedding job' })
          };
        }
      }
      
      // Store embedding in database
      if (httpMethod === 'POST' && (
        path.endsWith('/embeddings/action_embedding') ||
        path.endsWith('/embeddings/exploration_embedding') ||
        path.endsWith('/embeddings/policy_embedding')
      )) {
        const body = JSON.parse(event.body || '{}');
        const { entity_id, embedding_type, embedding, model, text_length } = body;
        
        if (!entity_id || !embedding_type || !embedding || !Array.isArray(embedding)) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'entity_id, embedding_type, and embedding array are required' })
          };
        }
        
        // Determine table name from path
        const tableName = path.split('/').pop(); // action_embedding, exploration_embedding, or policy_embedding
        
        try {
          // Check if embedding already exists and delete it (upsert behavior)
          const deleteSql = `DELETE FROM ${tableName} WHERE entity_id = '${escapeLiteral(entity_id)}' AND embedding_type = '${escapeLiteral(embedding_type)}';`;
          await queryJSON(deleteSql);
          
          // Insert new embedding
          const insertSql = `
            INSERT INTO ${tableName} (
              entity_id, embedding_type, embedding, model, text_length, created_at, updated_at
            ) VALUES (
              '${escapeLiteral(entity_id)}',
              '${escapeLiteral(embedding_type)}',
              '[${embedding.join(',')}]'::vector,
              '${escapeLiteral(model || 'text-embedding-3-small')}',
              ${text_length || 0},
              NOW(),
              NOW()
            )
            RETURNING *;
          `;
          
          const result = await queryJSON(insertSql);
          
          console.log(`Stored embedding: ${tableName}:${entity_id}:${embedding_type}`);
          
          return {
            statusCode: 201,
            headers,
            body: JSON.stringify({ data: result[0] })
          };
        } catch (error) {
          console.error(`Failed to store embedding in ${tableName}:`, error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to store embedding' })
          };
        }
      }
      
      // Get embeddings for an entity
      if (httpMethod === 'GET' && path.match(/\/embeddings\/(action_embedding|exploration_embedding|policy_embedding)\/(.+)$/)) {
        const matches = path.match(/\/embeddings\/(action_embedding|exploration_embedding|policy_embedding)\/(.+)$/);
        const tableName = matches[1];
        const entityId = matches[2];
        
        try {
          const sql = `SELECT * FROM ${tableName} WHERE entity_id = '${escapeLiteral(entityId)}' ORDER BY created_at DESC;`;
          const result = await queryJSON(sql);
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: result })
          };
        } catch (error) {
          console.error(`Failed to fetch embeddings from ${tableName}:`, error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to fetch embeddings' })
          };
        }
      }
      
      // Search similar embeddings using vector similarity
      if (httpMethod === 'POST' && path.match(/\/embeddings\/(action_embedding|exploration_embedding|policy_embedding)\/search$/)) {
        const matches = path.match(/\/embeddings\/(action_embedding|exploration_embedding|policy_embedding)\/search$/);
        const tableName = matches[1];
        const body = JSON.parse(event.body || '{}');
        const { query_embedding } = body;
        
        if (!query_embedding || !Array.isArray(query_embedding)) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'query_embedding array is required' })
          };
        }
        
        const { 
          limit = 10, 
          threshold = 0.7, 
          embedding_types, 
          models 
        } = event.queryStringParameters || {};
        
        try {
          let whereConditions = [`embedding <=> '[${query_embedding.join(',')}]'::vector < ${1 - parseFloat(threshold)}`];
          
          if (embedding_types) {
            const types = embedding_types.split(',').map(t => `'${escapeLiteral(t.trim())}'`).join(',');
            whereConditions.push(`embedding_type IN (${types})`);
          }
          
          if (models) {
            const modelList = models.split(',').map(m => `'${escapeLiteral(m.trim())}'`).join(',');
            whereConditions.push(`model IN (${modelList})`);
          }
          
          const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
          
          const sql = `
            SELECT 
              entity_id,
              embedding_type,
              model,
              text_length,
              created_at,
              (1 - (embedding <=> '[${query_embedding.join(',')}]'::vector)) as similarity
            FROM ${tableName}
            ${whereClause}
            ORDER BY similarity DESC
            LIMIT ${parseInt(limit)};
          `;
          
          const result = await queryJSON(sql);
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ data: result })
          };
        } catch (error) {
          console.error(`Failed to search embeddings in ${tableName}:`, error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to search embeddings' })
          };
        }
      }
      
      // Delete embeddings
      if (httpMethod === 'DELETE' && path.match(/\/embeddings\/(action_embedding|exploration_embedding|policy_embedding)$/)) {
        const matches = path.match(/\/embeddings\/(action_embedding|exploration_embedding|policy_embedding)$/);
        const tableName = matches[1];
        const { entity_id, embedding_type, model } = event.queryStringParameters || {};
        
        if (!entity_id) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'entity_id parameter is required' })
          };
        }
        
        try {
          let whereConditions = [`entity_id = '${escapeLiteral(entity_id)}'`];
          
          if (embedding_type) {
            whereConditions.push(`embedding_type = '${escapeLiteral(embedding_type)}'`);
          }
          
          if (model) {
            whereConditions.push(`model = '${escapeLiteral(model)}'`);
          }
          
          const whereClause = `WHERE ${whereConditions.join(' AND ')}`;
          const sql = `DELETE FROM ${tableName} ${whereClause} RETURNING *;`;
          
          const result = await queryJSON(sql);
          
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
              deleted_count: result.length,
              deleted_embeddings: result 
            })
          };
        } catch (error) {
          console.error(`Failed to delete embeddings from ${tableName}:`, error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to delete embeddings' })
          };
        }
      }
    }

    // AI Content Generation endpoints
    if (path.startsWith('/ai/')) {
      // AI service health check
      if (httpMethod === 'GET' && path.endsWith('/ai/health')) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ 
            status: 'ok', 
            timestamp: new Date().toISOString(),
            service: 'ai-content-generation'
          })
        };
      }

      // AI service capabilities
      if (httpMethod === 'GET' && path.endsWith('/ai/capabilities')) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            available_models: ['gpt-4', 'gpt-3.5-turbo'],
            features: ['summary_policy_generation', 'exploration_suggestions', 'policy_draft_generation'],
            rate_limits: {
              requests_per_minute: 60,
              tokens_per_minute: 10000
            }
          })
        };
      }

      // Generate summary policy text
      if (httpMethod === 'POST' && path.endsWith('/ai/generate-summary-policy')) {
        const body = JSON.parse(event.body || '{}');
        const { prompt, model = 'gpt-4', max_tokens = 500, temperature = 0.3, context } = body;
        
        if (!prompt) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'prompt is required' })
          };
        }

        try {
          // Mock AI response for now - replace with actual AI service call
          const mockResponse = {
            summary_policy_text: "Follow safety protocols, document all procedures, and report any issues immediately. Use appropriate PPE and ensure proper training before beginning work.",
            key_points: [
              "Follow established safety protocols",
              "Document all procedures and outcomes", 
              "Report issues immediately",
              "Use appropriate PPE"
            ],
            safety_considerations: [
              "Ensure proper training before work begins",
              "Use appropriate personal protective equipment",
              "Follow established safety procedures"
            ]
          };

          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              content: JSON.stringify(mockResponse),
              confidence: 0.85,
              model: model,
              tokens_used: 150,
              context_processed: context ? Object.keys(context).length : 0
            })
          };
        } catch (error) {
          console.error('Failed to generate summary policy:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to generate summary policy' })
          };
        }
      }

      // Generate exploration suggestions
      if (httpMethod === 'POST' && path.endsWith('/ai/generate-exploration-suggestions')) {
        const body = JSON.parse(event.body || '{}');
        const { prompt, model = 'gpt-4', max_tokens = 800, temperature = 0.4, context } = body;
        
        if (!prompt) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'prompt is required' })
          };
        }

        try {
          // Mock AI response for now - replace with actual AI service call
          const mockResponse = {
            exploration_notes_text: "Document the effectiveness of the new irrigation method by comparing water usage, crop yield, and soil moisture levels. Record environmental conditions, timing of application, and any observed differences in plant health or growth patterns.",
            metrics_text: "Water consumption (L/m²), Crop yield (kg/m²), Soil moisture levels (%), Time to completion (hours), Resource efficiency ratio, Plant health score (1-10)",
            suggested_measurements: [
              "Water consumption per square meter",
              "Crop yield comparison",
              "Soil moisture retention",
              "Time efficiency",
              "Cost per unit area"
            ],
            comparison_areas: [
              "Control area with traditional irrigation",
              "Different soil types",
              "Various weather conditions"
            ],
            documentation_tips: [
              "Take before/after photos",
              "Record weather conditions",
              "Document timing and duration",
              "Note any unexpected observations",
              "Measure at consistent intervals"
            ]
          };

          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              content: JSON.stringify(mockResponse),
              confidence: 0.78,
              model: model,
              tokens_used: 250,
              context_processed: context ? Object.keys(context).length : 0
            })
          };
        } catch (error) {
          console.error('Failed to generate exploration suggestions:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to generate exploration suggestions' })
          };
        }
      }

      // Generate policy draft
      if (httpMethod === 'POST' && path.endsWith('/ai/generate-policy-draft')) {
        const body = JSON.parse(event.body || '{}');
        const { prompt, model = 'gpt-4', max_tokens = 1000, temperature = 0.2, context } = body;
        
        if (!prompt) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'prompt is required' })
          };
        }

        try {
          // Mock AI response for now - replace with actual AI service call
          const mockResponse = {
            title: "Efficient Irrigation Implementation Policy",
            description_text: "This policy establishes standard procedures for implementing and evaluating new irrigation methods based on field exploration results. It ensures consistent application of proven techniques while maintaining safety and documentation standards.",
            key_procedures: [
              "Conduct baseline measurements before implementation",
              "Follow established safety protocols during installation",
              "Document all procedures and measurements",
              "Compare results with control areas",
              "Submit detailed reports within 48 hours"
            ],
            safety_requirements: [
              "Use appropriate PPE including gloves and eye protection",
              "Ensure proper training on equipment before use",
              "Maintain safe distances from electrical components",
              "Follow lockout/tagout procedures for equipment maintenance"
            ],
            documentation_requirements: [
              "Record all measurements with timestamps",
              "Take photos of before/during/after conditions",
              "Document weather conditions and environmental factors",
              "Submit reports using standardized forms",
              "Maintain equipment maintenance logs"
            ],
            effective_conditions: [
              "When implementing new irrigation methods",
              "For areas with similar soil and climate conditions",
              "With properly trained personnel",
              "When adequate resources and equipment are available"
            ]
          };

          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              content: JSON.stringify(mockResponse),
              confidence: 0.82,
              model: model,
              tokens_used: 350,
              context_processed: context ? Object.keys(context).length : 0
            })
          };
        } catch (error) {
          console.error('Failed to generate policy draft:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to generate policy draft' })
          };
        }
      }

      // Generate embedding (for AI service integration)
      if (httpMethod === 'POST' && path.endsWith('/ai/generate-embedding')) {
        const body = JSON.parse(event.body || '{}');
        const { text, model = 'text-embedding-3-small' } = body;
        
        if (!text) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'text is required' })
          };
        }

        try {
          // Mock embedding generation - replace with actual AI service call
          const dimensions = model === 'text-embedding-3-large' ? 3072 : 1536;
          const mockEmbedding = Array.from({ length: dimensions }, () => Math.random() * 2 - 1);

          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              embedding: mockEmbedding,
              model: model,
              usage: {
                prompt_tokens: text.length / 4, // Rough estimate
                total_tokens: text.length / 4
              }
            })
          };
        } catch (error) {
          console.error('Failed to generate embedding:', error);
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to generate embedding' })
          };
        }
      }
    }

    // Generic query endpoint
    if (httpMethod === 'POST' && path.endsWith('/query')) {
      const body = JSON.parse(event.body || '{}');
      const { sql, params = [] } = body;
      
      if (!sql) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'SQL query required' })
        };
      }

      // Simple parameter substitution (not production-ready)
      let finalSql = sql;
      params.forEach((param, i) => {
        finalSql = finalSql.replace(`$${i + 1}`, `'${param}'`);
      });
      
      const jsonSql = `SELECT json_agg(row_to_json(t)) FROM (${finalSql}) t;`;
      const result = await queryJSON(jsonSql);
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
      };
    }

    // Member settings endpoint
    if (path.match(/\/members\/[^/]+\/settings$/)) {
      const pathParts = path.split('/');
      const userId = pathParts[pathParts.length - 2]; // e.g. /members/{userId}/settings

      if (httpMethod === 'GET') {
        if (!organizationId) {
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({ error: 'Organization context required' })
          };
        }

        // Verify the user is a member of the organization
        const memberSql = `
          SELECT settings
          FROM organization_members
          WHERE cognito_user_id = '${escapeLiteral(userId)}'
            AND organization_id = '${escapeLiteral(organizationId)}'
          LIMIT 1
        `;
        const memberResult = await queryJSON(memberSql);

        if (!memberResult || memberResult.length === 0) {
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Member not found in organization' })
          };
        }

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: memberResult[0].settings || {} })
        };
      }

      else if (httpMethod === 'PUT') {
        if (!organizationId) {
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({ error: 'Organization context required' })
          };
        }

        // Users can only update their own settings
        const requestingUserId = authContext.cognito_user_id;
        if (!requestingUserId || requestingUserId !== userId) {
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({ error: 'You can only update your own settings' })
          };
        }

        const body = JSON.parse(event.body || '{}');
        const settings = body.settings;

        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'settings object is required' })
          };
        }

        // Validate growth_intents if present
        if (settings.growth_intents !== undefined) {
          if (!Array.isArray(settings.growth_intents)) {
            return {
              statusCode: 400,
              headers,
              body: JSON.stringify({ error: 'growth_intents must be an array of strings' })
            };
          }
          for (const intent of settings.growth_intents) {
            if (typeof intent !== 'string') {
              return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'growth_intents must be an array of strings' })
              };
            }
          }
        }

        const settingsJson = JSON.stringify(settings);
        const updateSql = `
          UPDATE organization_members
          SET settings = '${escapeLiteral(settingsJson)}'::jsonb
          WHERE cognito_user_id = '${escapeLiteral(userId)}'
            AND organization_id = '${escapeLiteral(organizationId)}'
          RETURNING settings
        `;
        const updateResult = await queryJSON(updateSql);

        if (!updateResult || updateResult.length === 0) {
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Member not found in organization' })
          };
        }

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ data: updateResult[0].settings || {} })
        };
      }
    }

    // ==================== SHARES ====================

    // POST /shares — create a share (state + two state_links)
    if (httpMethod === 'POST' && path === '/shares') {
      const body = JSON.parse(event.body || '{}');
      const { entity_type, entity_id, target_org_id, note, source_org_id, cognito_user_id, entity_name, target_org_name } = body;
      if (!entity_type || !entity_id || !target_org_id || !source_org_id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required sharing parameters' }) };
      }
      const stateId = randomUUID();
      const stateText = (note && note.trim())
        || `Shared ${entity_type}${entity_name ? ' "' + entity_name + '"' : ''} with ${target_org_name || 'partner organization'}`;
      const client = await getDbClient();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO states (id, organization_id, state_text, captured_by, captured_at) VALUES ($1, $2, $3, $4, NOW())`,
          [stateId, source_org_id, stateText, cognito_user_id || '00000000-0000-0000-0000-000000000000']
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
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, state_id: stateId }) };
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }

    // GET /shares/{entityType}/{entityId} — list orgs this entity is shared with
    if (httpMethod === 'GET' && path.match(/^\/shares\/[^/]+\/[^/]+$/)) {
      const parts = path.split('/');
      const entityType = parts[2];
      const entityId = parts[3];
      const rows = await queryJSON(
        `SELECT s.id as state_id, sl_org.entity_id::text as target_org_id, o.name as target_org_name,
                s.state_text as note, s.captured_at as shared_at
         FROM states s
         JOIN state_links sl_entity ON sl_entity.state_id = s.id
           AND sl_entity.entity_type = $1 AND sl_entity.entity_id = $2
         JOIN state_links sl_org ON sl_org.state_id = s.id AND sl_org.entity_type = 'organization'
         JOIN organizations o ON o.id = sl_org.entity_id::uuid
         WHERE s.organization_id::text != sl_org.entity_id::text
         ORDER BY s.captured_at DESC`,
        [entityType, entityId]
      );
      return { statusCode: 200, headers, body: JSON.stringify({ shares: rows }) };
    }

    // DELETE /shares/{stateId} — unshare
    if (httpMethod === 'DELETE' && path.match(/^\/shares\/[^/]+$/)) {
      const stateId = path.split('/')[2];
      const client = await getDbClient();
      try {
        await client.query('DELETE FROM state_links WHERE state_id = $1', [stateId]);
        await client.query('DELETE FROM states WHERE id = $1', [stateId]);
        return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
      } finally {
        client.release();
      }
    }

    // GET /shared-with-me?org_id=... — all entities shared with an org
    if (httpMethod === 'GET' && path === '/shared-with-me') {
      const orgId = event.queryStringParameters?.org_id || authContext?.organization_id;
      if (!orgId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'org_id required' }) };
      const rows = await queryJSON(
        `SELECT s.id as state_id, sl_entity.entity_type, sl_entity.entity_id::text,
                s.state_text as note, s.organization_id::text as source_org_id,
                o.name as source_org_name, s.captured_at as shared_at
         FROM states s
         JOIN state_links sl_org ON sl_org.state_id = s.id
           AND sl_org.entity_type = 'organization' AND sl_org.entity_id = $1
         JOIN state_links sl_entity ON sl_entity.state_id = s.id AND sl_entity.entity_type != 'organization'
         JOIN organizations o ON o.id = s.organization_id
         ORDER BY s.captured_at DESC`,
        [orgId]
      );
      return { statusCode: 200, headers, body: JSON.stringify({ shared: rows }) };
    }

    // ========== MAXWELL INTERACTIONS ==========

    if (path === '/maxwell/interactions' || path.match(/\/maxwell\/interactions\/[a-f0-9-]+$/)) {
      const userId = authContext.cognito_user_id;

      // POST /maxwell/interactions — save a new interaction
      if (httpMethod === 'POST' && path === '/maxwell/interactions') {
        const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        const { question, response, model, input_tokens, output_tokens, duration_ms, entity_type, entity_id } = body;

        if (!question || !response) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'question and response are required' }) };
        }

        const stateText = JSON.stringify({
          type: 'maxwell_interaction',
          question,
          response,
          model: model || null,
          input_tokens: input_tokens || null,
          output_tokens: output_tokens || null,
          duration_ms: duration_ms || null,
          deleted_at: null,
        });

        const client = await getDbClient();
        try {
          await client.query('BEGIN');

          const stateResult = await client.query(
            `INSERT INTO states (organization_id, state_text, captured_by, captured_at)
             VALUES ($1, $2, $3::uuid, NOW())
             RETURNING id`,
            [organizationId, stateText, userId]
          );
          const stateId = stateResult.rows[0].id;

          if (entity_type && entity_id) {
            await client.query(
              `INSERT INTO state_links (state_id, entity_type, entity_id)
               VALUES ($1, $2, $3::uuid)`,
              [stateId, entity_type, entity_id]
            );
          }

          await client.query('COMMIT');

          // Queue embedding (fire-and-forget)
          sqs.send(new SendMessageCommand({
            QueueUrl: EMBEDDINGS_QUEUE_URL,
            MessageBody: JSON.stringify({
              entity_type: 'state',
              entity_id: stateId,
              embedding_source: `${question}. ${response}`,
              organization_id: organizationId,
            }),
          })).catch(err => console.error('Failed to queue maxwell interaction embedding:', err.message));

          return { statusCode: 201, headers, body: JSON.stringify({ id: stateId }) };
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }

      // GET /maxwell/interactions — fetch recent starter questions
      if (httpMethod === 'GET' && path === '/maxwell/interactions') {
        const userId = authContext.cognito_user_id;
        const rows = await queryJSON(
          `SELECT s.id, s.state_text, s.captured_at
           FROM states s
           WHERE s.organization_id = $1
             AND s.captured_by = $2::uuid
             AND s.state_text LIKE '%"maxwell_interaction"%'
             AND (s.state_text::jsonb->>'deleted_at') IS NULL
           ORDER BY s.captured_at DESC
           LIMIT 5`,
          [organizationId, userId]
        );

        const questions = rows.map(row => {
          try {
            const parsed = JSON.parse(row.state_text);
            return { id: row.id, question: parsed.question, captured_at: row.captured_at };
          } catch {
            return null;
          }
        }).filter(Boolean);

        return { statusCode: 200, headers, body: JSON.stringify(questions) };
      }

      // DELETE /maxwell/interactions/:id — soft delete
      if (httpMethod === 'DELETE' && path.match(/\/maxwell\/interactions\/[a-f0-9-]+$/)) {
        const interactionId = path.split('/').pop();
        const userId = authContext.cognito_user_id;

        const result = await queryJSON(
          `UPDATE states
           SET state_text = jsonb_set(state_text::jsonb, '{deleted_at}', to_jsonb(NOW()::text))::text,
               updated_at = NOW()
           WHERE id = $1
             AND organization_id = $2
             AND captured_by = $3::uuid
             AND state_text LIKE '%"maxwell_interaction"%'
           RETURNING id`,
          [interactionId, organizationId, userId]
        );

        if (result.length === 0) {
          return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found or not yours' }) };
        }

        return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
      }
    }

    // Default 404
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Not found' })
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ error: error.message })
    };
  }
};