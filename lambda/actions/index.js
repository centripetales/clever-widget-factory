const { Client } = require('pg');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { getAuthorizerContext, buildOrganizationFilter } = require('/opt/nodejs/authorizerContext');
const { composeActionEmbeddingSource } = require('/opt/nodejs/embedding-composition');
const { broadcastInvalidation } = require('/opt/nodejs/broadcastInvalidation');

const sqs = new SQSClient({ region: 'us-west-2' });
const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';

// Database configuration
// SECURITY: Password must be provided via environment variable
if (!process.env.DB_PASSWORD) {
  throw new Error('DB_PASSWORD environment variable is required');
}

const dbConfig = {
  host: process.env.DB_HOST || 'cwf-dev-postgres.ctmma86ykgeb.us-west-2.rds.amazonaws.com',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: {
    rejectUnauthorized: false
  }
};

// Helper to execute SQL and return JSON
async function queryJSON(sql) {
  const client = new Client(dbConfig);
  try {
    await client.connect();
    const result = await client.query(sql);
    return result.rows;
  } finally {
    await client.end();
  }
}

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const { httpMethod, path, queryStringParameters } = event;
  const authContext = getAuthorizerContext(event);
  const organizationId = authContext.organization_id || (authContext.accessible_organization_ids || [])[0];
  const accessibleOrgIds = authContext.accessible_organization_ids || [];
  
  if (accessibleOrgIds.length === 0) {
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ error: 'Organization access context not available' })
    };
  }
  
  try {
    // CORS headers
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
    };

    // Handle preflight requests for all paths
    if (httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
        },
        body: ''
      };
    }

    // My actions endpoint - filter by Cognito user ID
    if (httpMethod === 'GET' && path.includes('/my-actions')) {
      const { cognitoUserId } = queryStringParameters || {};
      if (!cognitoUserId) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'cognitoUserId parameter required' })
        };
      }

      const sql = `SELECT json_agg(row_to_json(t)) FROM (
        SELECT 
          a.*,
          om.full_name as assigned_to_name,
          CASE WHEN (ac.context_id IS NOT NULL OR old_scores.action_id IS NOT NULL) THEN true ELSE false END as has_score,
          CASE WHEN updates.action_id IS NOT NULL THEN true ELSE false END as has_implementation_updates,
          COALESCE(
            (
              SELECT EXISTS(
                SELECT 1 FROM states s
                JOIN state_links sl ON s.id = sl.state_id
                JOIN state_risk_profiles srp ON s.id = srp.state_id
                WHERE sl.entity_type = 'action'
                  AND sl.entity_id = a.id
                  AND s.state_text = 'Shared narrative and impact overview for action'
                  AND srp.aggregate_risk = 0.0
              )
            ),
            false
          ) as shared_with_partners
        FROM actions a
        LEFT JOIN organization_members om ON a.assigned_to = om.user_id
        LEFT JOIN analysis_contexts ac ON a.id = ac.context_id AND ac.context_service = 'action_score'
        LEFT JOIN action_scores old_scores ON a.id = old_scores.action_id
        LEFT JOIN (
          SELECT DISTINCT entity_id as action_id
          FROM state_links
          WHERE entity_type = 'action'
        ) updates ON a.id = updates.action_id
        WHERE om.cognito_user_id = '${cognitoUserId}'
        ORDER BY a.created_at DESC
      ) t;`;
      
      const result = await queryJSON(sql);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
      };
    }

    // Action implementation updates endpoint (now using states table)
    if (httpMethod === 'GET' && path.endsWith('/action_implementation_updates')) {
      const { action_id, limit = 50 } = queryStringParameters || {};
      
      if (!action_id) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'action_id parameter required' })
        };
      }
      
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
          s.updated_at
        FROM states s
        JOIN state_links sl ON s.id = sl.state_id
        WHERE sl.entity_type = 'action'
          AND sl.entity_id = '${action_id}'
        ORDER BY s.created_at DESC 
        LIMIT ${limit}
      ) t;`;
      
      const result = await queryJSON(sql);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
      };
    }

    // DELETE action
    if (httpMethod === 'DELETE' && path.includes('/actions/')) {
      const actionId = path.split('/actions/')[1];
      const orgFilter = buildOrganizationFilter(authContext, 'actions');
      const sql = `DELETE FROM actions WHERE id = '${actionId}' ${orgFilter.condition ? 'AND ' + orgFilter.condition : ''} RETURNING id`;
      const result = await queryJSON(sql);

      // Broadcast cache invalidation to WebSocket clients
      try {
        await broadcastInvalidation({
          entityType: 'action',
          entityId: actionId,
          mutationType: 'deleted',
          organizationId,
          excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
        });
      } catch (err) {
        console.error('[ACTIONS] Broadcast failed:', err.message);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: result[0] })
      };
    }

    // POST/PUT toggle shared status of action (set state risk profile to 0.0)
    if ((httpMethod === 'POST' || httpMethod === 'PUT') && path.includes('/actions/') && path.endsWith('/toggle_shared_with_partners')) {
      const actionId = path.split('/actions/')[1].split('/')[0];
      const body = JSON.parse(event.body || '{}');
      const { shared_with_partners } = body;
      
      const targetRisk = shared_with_partners ? '0.0' : '0.8';

      // 1. Find or create a state for this action to represent the narrative
      const findStateSql = `
        SELECT s.id 
        FROM states s
        JOIN state_links sl ON s.id = sl.state_id
        WHERE sl.entity_type = 'action' AND sl.entity_id = '${actionId}'
        LIMIT 1
      `;
      const states = await queryJSON(findStateSql);
      
      let stateId;
      if (states && states.length > 0) {
        stateId = states[0].id;
      } else {
        // Create a new default operational/story state for this action
        stateId = require('crypto').randomUUID();
        const createStateSql = `
          INSERT INTO states (id, organization_id, state_text, captured_by, captured_at)
          VALUES ('${stateId}', '${organizationId}', 'Shared narrative and impact overview for action', '${authContext.cognito_user_id || '00000000-0000-0000-0000-000000000000'}', NOW())
        `;
        await queryJSON(createStateSql);
        
        const createLinkSql = `
          INSERT INTO state_links (id, state_id, entity_type, entity_id)
          VALUES (gen_random_uuid(), '${stateId}', 'action', '${actionId}')
        `;
        await queryJSON(createLinkSql);
      }

      // 2. Insert or update the narrative's risk profile to targetRisk (0.0 for shared/public, 0.8 for private)
      const saveRiskSql = `
        INSERT INTO state_risk_profiles (state_id, aggregate_risk)
        VALUES ('${stateId}', ${targetRisk})
        ON CONFLICT (state_id) 
        DO UPDATE SET aggregate_risk = ${targetRisk}, updated_at = NOW()
        RETURNING *
      `;
      const riskProfile = await queryJSON(saveRiskSql);

      // 3. For any photos attached to this action, update their risk to 0.0 (if shared) or 0.8 (if private)
      const getPhotosSql = `
        SELECT photo_url FROM state_photos WHERE state_id = '${stateId}'
      `;
      const photos = await queryJSON(getPhotosSql);
      if (photos && photos.length > 0) {
        for (const p of photos) {
          const savePhotoRiskSql = `
            INSERT INTO photo_metadata_extractions (photo_url, aggregate_risk)
            VALUES ('${p.photo_url}', ${targetRisk})
            ON CONFLICT (photo_url)
            DO UPDATE SET aggregate_risk = ${targetRisk}, updated_at = NOW()
          `;
          await queryJSON(savePhotoRiskSql);
        }
      }

      // 4. Trigger RSP Worker via Outbox pattern if sharing is enabled
      if (shared_with_partners) {
        const idempotencyKey = require('crypto').createHash('sha256').update(stateId + '-' + Date.now()).digest('hex');
        const insertOutboxSql = `
          INSERT INTO rsp_outbox (state_id, idempotency_key, status, triggered_at)
          VALUES ('${stateId}', '${idempotencyKey}', 'PENDING', NOW())
          ON CONFLICT (idempotency_key) DO NOTHING
        `;
        await queryJSON(insertOutboxSql);
      }

      // Broadcast cache invalidation
      try {
        await broadcastInvalidation({
          entityType: 'action',
          entityId: actionId,
          mutationType: 'updated',
          organizationId,
          excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
        });
      } catch (err) {
        console.error('[ACTIONS] Broadcast failed:', err.message);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, shared_with_partners, riskProfile: riskProfile[0] })
      };
    }

    // PUT action by ID (update via path parameter)
    if (httpMethod === 'PUT' && path.includes('/actions/') && !path.endsWith('/toggle_shared_with_partners') && !path.endsWith('/toggle_public')) {
      const actionId = path.split('/actions/')[1].split('/')[0]; // Extract ID, handle trailing slashes
      const body = JSON.parse(event.body || '{}');
      const { created_by, updated_by, updated_at, completed_at, is_exploration, exploration_code, shared_with_partners, ...actionData } = body;
      
      const userId = updated_by || authContext.cognito_user_id || require('crypto').randomUUID();
      const orgId = accessibleOrgIds[0];
      
      // Get current action state before update
      const orgFilter = buildOrganizationFilter(authContext, 'actions');
      const currentActionSql = `SELECT * FROM actions WHERE id = '${actionId}' ${orgFilter.condition ? 'AND ' + orgFilter.condition : ''}`;
      const currentActionResult = await queryJSON(currentActionSql);
      
      if (!currentActionResult || currentActionResult.length === 0) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Action not found' })
        };
      }
      
      const currentAction = currentActionResult[0];
      const oldTools = currentAction.required_tools || [];
      const newTools = actionData.required_tools || oldTools;
      const actionStatus = actionData.status || currentAction.status;
      const assignedTo = actionData.assigned_to || currentAction.assigned_to;
      
      // Execute dynamic sharing updates if shared_with_partners is specified
      if (shared_with_partners !== undefined) {
        const targetRisk = shared_with_partners ? '0.0' : '0.8';

        // 1. Find or create a state for this action to represent the narrative
        const findStateSql = `
          SELECT s.id 
          FROM states s
          JOIN state_links sl ON s.id = sl.state_id
          WHERE sl.entity_type = 'action' 
            AND sl.entity_id = '${actionId}'
            AND s.state_text = 'Shared narrative and impact overview for action'
          LIMIT 1
        `;
        const states = await queryJSON(findStateSql);
        
        let stateId;
        if (states && states.length > 0) {
          stateId = states[0].id;
        } else {
          // Create a new default operational/story state for this action so it can be shared
          stateId = require('crypto').randomUUID();
          const createStateSql = `
            INSERT INTO states (id, organization_id, state_text, captured_by, captured_at)
            VALUES ('${stateId}', '${orgId || organizationId}', 'Shared narrative and impact overview for action', '${authContext.cognito_user_id || '00000000-0000-0000-0000-000000000000'}', NOW())
          `;
          await queryJSON(createStateSql);
          
          const createLinkSql = `
            INSERT INTO state_links (id, state_id, entity_type, entity_id)
            VALUES (gen_random_uuid(), '${stateId}', 'action', '${actionId}')
          `;
          await queryJSON(createLinkSql);
        }

        // 2. Insert or update the narrative's risk profile to targetRisk
        const saveRiskSql = `
          INSERT INTO state_risk_profiles (state_id, aggregate_risk)
          VALUES ('${stateId}', ${targetRisk})
          ON CONFLICT (state_id) 
          DO UPDATE SET aggregate_risk = ${targetRisk}, updated_at = NOW()
        `;
        await queryJSON(saveRiskSql);

        // 3. For any photos attached to this action, update their risk to targetRisk
        const getPhotosSql = `
          SELECT photo_url FROM state_photos WHERE state_id = '${stateId}'
        `;
        const photos = await queryJSON(getPhotosSql);
        if (photos && photos.length > 0) {
          for (const p of photos) {
            const savePhotoRiskSql = `
              INSERT INTO photo_metadata_extractions (photo_url, aggregate_risk)
              VALUES ('${p.photo_url}', ${targetRisk})
              ON CONFLICT (photo_url)
              DO UPDATE SET aggregate_risk = ${targetRisk}, updated_at = NOW()
            `;
            await queryJSON(savePhotoRiskSql);
          }
        }

        // 4. Trigger RSP Worker via Outbox pattern if sharing is enabled
        if (shared_with_partners) {
          const idempotencyKey = require('crypto').createHash('sha256').update(stateId + '-' + Date.now()).digest('hex');
          const insertOutboxSql = `
            INSERT INTO rsp_outbox (state_id, idempotency_key, status, triggered_at)
            VALUES ('${stateId}', '${idempotencyKey}', 'PENDING', NOW())
            ON CONFLICT (idempotency_key) DO NOTHING
          `;
          await queryJSON(insertOutboxSql);
        }
      }

      const updates = [];
      for (const [key, val] of Object.entries(actionData)) {
        if (val === undefined) continue;
        if (val === null) updates.push(`${key} = NULL`);
        else if (typeof val === 'string') updates.push(`${key} = '${val.replace(/'/g, "''")}'`);
        else if (typeof val === 'boolean') updates.push(`${key} = ${val}`);
        else if (Array.isArray(val)) {
          if (key === 'participants') {
            updates.push(`${key} = ARRAY[${val.map(v => `'${v}'`).join(',')}]::uuid[]`);
          } else if (key === 'required_tools' || key === 'attachments') {
            if (val.length === 0) {
              updates.push(`${key} = ARRAY[]::text[]`);
            } else {
              updates.push(`${key} = ARRAY[${val.map(v => `'${v.replace(/'/g, "''")}'`).join(',')}]::text[]`);
            }
          } else {
            updates.push(`${key} = '${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`);
          }
        } else if (typeof val === 'object') updates.push(`${key} = '${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`);
        else updates.push(`${key} = ${val}`);
      }
      
      // Handle is_exploration flag
      if (is_exploration !== undefined) {
        updates.push(`is_exploration = ${is_exploration}`);
      }
      
      let updatedAction = currentAction;
      let result = [];
      
      if (updates.length > 0) {
        updates.push(`updated_by = '${userId}'`);
        if (completed_at) updates.push(`completed_at = '${completed_at}'`);
        
        const sql = `UPDATE actions SET ${updates.join(', ')}, updated_at = NOW() WHERE id = '${actionId}' ${orgFilter.condition ? 'AND ' + orgFilter.condition : ''} RETURNING *`;
        result = await queryJSON(sql);
      }
      
      // Queue embedding generation if embedding-relevant fields were updated
      // Fire-and-forget pattern to avoid blocking the response
      if (result && result.length > 0) {
        const updatedAction = result[0];
        const embeddingRelevantFields = ['description', 'state_text', 'summary_policy_text', 'observations', 'expected_state'];
        const hasEmbeddingUpdate = embeddingRelevantFields.some(field => actionData[field] !== undefined);
        
        if (hasEmbeddingUpdate) {
          // Send embedding messages asynchronously without blocking response
          const embeddingPromises = [];
          
          // Send first message: full context embedding (existing behavior)
          const embeddingSource = composeActionEmbeddingSource(updatedAction);
          if (embeddingSource && embeddingSource.trim()) {
            embeddingPromises.push(
              sqs.send(new SendMessageCommand({
                QueueUrl: EMBEDDINGS_QUEUE_URL,
                MessageBody: JSON.stringify({
                  entity_type: 'action',
                  entity_id: updatedAction.id,
                  embedding_source: embeddingSource,
                  organization_id: updatedAction.organization_id
                })
              }))
              .then(() => console.log('Queued full context embedding for action', updatedAction.id))
              .catch(error => console.error('Failed to queue full context embedding:', error))
            );
          }
          
          // Send second message: action_existing_state embedding (description only)
          if (updatedAction.description && updatedAction.description.trim()) {
            embeddingPromises.push(
              sqs.send(new SendMessageCommand({
                QueueUrl: EMBEDDINGS_QUEUE_URL,
                MessageBody: JSON.stringify({
                  entity_type: 'action_existing_state',
                  entity_id: updatedAction.id,
                  embedding_source: updatedAction.description.trim(),
                  organization_id: updatedAction.organization_id
                })
              }))
              .then(() => console.log('Queued action_existing_state embedding for action', updatedAction.id))
              .catch(error => console.error('Failed to queue action_existing_state embedding:', error))
            );
          }
          
          // Fire and forget - don't await, but log if all complete
          Promise.allSettled(embeddingPromises).then(results => {
            const succeeded = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.filter(r => r.status === 'rejected').length;
            console.log(`Embedding queue results for action ${updatedAction.id}: ${succeeded} succeeded, ${failed} failed`);
          });
        }
      }
      
      // Handle exploration record if is_exploration is true
      // Note: Exploration records are created/updated via separate API endpoint
      // This prevents database constraint violations during action updates
      
      // Manage checkouts based on required_tools changes
      if (actionStatus === 'in_progress') {
        const addedTools = newTools.filter(t => !oldTools.includes(t));
        const removedTools = oldTools.filter(t => !newTools.includes(t));
        
        // Check if status changed to 'in_progress' (need to checkout all tools, not just newly added)
        const statusChangedToInProgress = currentAction.status !== 'in_progress' && actionStatus === 'in_progress';
        
        // If status changed to in_progress, checkout ALL tools in required_tools
        // Otherwise, only checkout newly added tools
        const toolsToCheckout = statusChangedToInProgress ? newTools : addedTools;
        
        // Parallelize checkout creation
        const checkoutPromises = toolsToCheckout.map(async (toolId) => {
          // Check if tool already has active checkout (for any action)
          const existingCheckoutSql = `SELECT id FROM checkouts WHERE tool_id = '${toolId}' AND is_returned = false LIMIT 1`;
          const existingCheckout = await queryJSON(existingCheckoutSql);
          
          if (existingCheckout && existingCheckout.length > 0) {
            // Tool already checked out - check if it's for this action
            const actionCheckoutSql = `SELECT id FROM checkouts WHERE tool_id = '${toolId}' AND action_id = '${actionId}' AND is_returned = false LIMIT 1`;
            const actionCheckout = await queryJSON(actionCheckoutSql);
            
            if (actionCheckout && actionCheckout.length > 0) {
              // Already checked out for this action, skip
              return;
            }
            // Tool checked out for different action - skip (don't create duplicate)
            return;
          }
          
          // Create checkout for this tool
          const checkoutId = require('crypto').randomUUID();
          const checkoutSql = `INSERT INTO checkouts (id, tool_id, user_id, action_id, checkout_date, is_returned, organization_id, created_at) VALUES ('${checkoutId}', '${toolId}', '${assignedTo}', '${actionId}', NOW(), false, '${orgId}', NOW())`;
          await queryJSON(checkoutSql);
        });
        
        // Parallelize checkout deletion for removed tools
        const deletePromises = removedTools.map(async (toolId) => {
          const deleteSql = `DELETE FROM checkouts WHERE tool_id = '${toolId}' AND action_id = '${actionId}' AND is_returned = false`;
          await queryJSON(deleteSql);
        });
        
        // Execute all checkout operations in parallel
        await Promise.all([...checkoutPromises, ...deletePromises]);
      }
      
      // If action completed, create checkins and mark checkouts as returned
      if (actionStatus === 'completed' && currentAction.status !== 'completed') {
        // Get all unreturned checkouts for this action
        const checkoutsSql = `SELECT id, tool_id, user_id FROM checkouts WHERE action_id = '${actionId}' AND is_returned = false`;
        const checkouts = await queryJSON(checkoutsSql);
        
        // Parallelize checkin creation
        const checkinPromises = checkouts.map(async (checkout) => {
          const checkinId = require('crypto').randomUUID();
          const checkinSql = `INSERT INTO checkins (id, checkout_id, tool_id, user_id, checkin_date, checkin_reason, notes, organization_id, created_at) VALUES ('${checkinId}', '${checkout.id}', '${checkout.tool_id}', '${checkout.user_id}', NOW(), 'Action completed', 'Automatically checked in when action was completed', '${orgId}', NOW())`;
          await queryJSON(checkinSql);
        });
        
        // Execute checkin creation and checkout update in parallel
        await Promise.all([
          ...checkinPromises,
          queryJSON(`UPDATE checkouts SET is_returned = true WHERE action_id = '${actionId}' AND is_returned = false`)
        ]);
      }
      
      // Query affected tools with checkout state
      const affectedToolIds = [...new Set([...oldTools, ...newTools])];
      let affectedTools = [];
      if (affectedToolIds.length > 0) {
        const toolsSql = `
          SELECT 
            t.id, t.name,
            CASE 
              WHEN c.id IS NOT NULL THEN 'checked_out'
              ELSE t.status
            END as status,
            CASE WHEN c.id IS NOT NULL THEN true ELSE false END as is_checked_out,
            c.user_id as checked_out_user_id,
            om.full_name as checked_out_to,
            c.checkout_date as checked_out_date
          FROM tools t
          LEFT JOIN LATERAL (
            SELECT * FROM checkouts
            WHERE checkouts.tool_id = t.id AND checkouts.is_returned = false
            ORDER BY checkouts.checkout_date DESC LIMIT 1
          ) c ON true
          LEFT JOIN LATERAL (
            SELECT full_name FROM organization_members
            WHERE cognito_user_id = c.user_id
            LIMIT 1
          ) om ON true
          WHERE t.id IN (${affectedToolIds.map(id => `'${id}'`).join(',')})
        `;
        affectedTools = await queryJSON(toolsSql);
      }
      
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
        console.error('[ACTIONS] Broadcast failed:', err.message);
      }

      return { 
        statusCode: 200, 
        headers, 
        body: JSON.stringify({ 
          data: result && result.length > 0 ? result[0] : updatedAction,
          affectedResources: {
            tools: affectedTools
          }
        }) 
      };
    }

    // POST/PUT action (create/update)
    if ((httpMethod === 'POST' || httpMethod === 'PUT') && path.endsWith('/actions')) {
      const body = JSON.parse(event.body || '{}');
      const { id, created_by, updated_by, updated_at, completed_at, is_exploration, exploration_code, shared_with_partners, ...actionData } = body;
      
      const userId = created_by || updated_by || require('crypto').randomUUID();
      const orgId = accessibleOrgIds[0] || organizationId;
      
      // Helper function to handle companion state and risk assessments
      const handleSharingUpdate = async (targetActionId, isShared) => {
        const targetRisk = isShared ? '0.0' : '0.8';

        // Find or create narrative state
        const findStateSql = `
          SELECT s.id 
          FROM states s
          JOIN state_links sl ON s.id = sl.state_id
          WHERE sl.entity_type = 'action' 
            AND sl.entity_id = '${targetActionId}'
            AND s.state_text = 'Shared narrative and impact overview for action'
          LIMIT 1
        `;
        const states = await queryJSON(findStateSql);
        
        let stateId;
        if (states && states.length > 0) {
          stateId = states[0].id;
        } else {
          stateId = require('crypto').randomUUID();
          const createStateSql = `
            INSERT INTO states (id, organization_id, state_text, captured_by, captured_at)
            VALUES ('${stateId}', '${orgId}', 'Shared narrative and impact overview for action', '${authContext.cognito_user_id || '00000000-0000-0000-0000-000000000000'}', NOW())
          `;
          await queryJSON(createStateSql);
          
          const createLinkSql = `
            INSERT INTO state_links (id, state_id, entity_type, entity_id)
            VALUES (gen_random_uuid(), '${stateId}', 'action', '${targetActionId}')
          `;
          await queryJSON(createLinkSql);
        }

        // Insert or update narrative's risk profile
        const saveRiskSql = `
          INSERT INTO state_risk_profiles (state_id, aggregate_risk)
          VALUES ('${stateId}', ${targetRisk})
          ON CONFLICT (state_id) 
          DO UPDATE SET aggregate_risk = ${targetRisk}, updated_at = NOW()
        `;
        await queryJSON(saveRiskSql);

        // Update photo risk profiles
        const getPhotosSql = `
          SELECT photo_url FROM state_photos WHERE state_id = '${stateId}'
        `;
        const photos = await queryJSON(getPhotosSql);
        if (photos && photos.length > 0) {
          for (const p of photos) {
            const savePhotoRiskSql = `
              INSERT INTO photo_metadata_extractions (photo_url, aggregate_risk)
              VALUES ('${p.photo_url}', ${targetRisk})
              ON CONFLICT (photo_url)
              DO UPDATE SET aggregate_risk = ${targetRisk}, updated_at = NOW()
            `;
            await queryJSON(savePhotoRiskSql);
          }
        }

        // 4. Trigger RSP Worker via Outbox pattern if sharing is enabled
        if (isShared) {
          const idempotencyKey = require('crypto').createHash('sha256').update(stateId + '-' + Date.now()).digest('hex');
          const insertOutboxSql = `
            INSERT INTO rsp_outbox (state_id, idempotency_key, status, triggered_at)
            VALUES ('${stateId}', '${idempotencyKey}', 'PENDING', NOW())
            ON CONFLICT (idempotency_key) DO NOTHING
          `;
          await queryJSON(insertOutboxSql);
        }
      };

      if (id) {
        // Execute companion sharing updates if shared_with_partners is specified
        if (shared_with_partners !== undefined) {
          await handleSharingUpdate(id, shared_with_partners);
        }
        // Update
        const updates = [];
        for (const [key, val] of Object.entries(actionData)) {
          if (val === undefined) continue;
          if (val === null) updates.push(`${key} = NULL`);
          else if (typeof val === 'string') updates.push(`${key} = '${val.replace(/'/g, "''")}'`);
          else if (typeof val === 'boolean') updates.push(`${key} = ${val}`);
          else if (Array.isArray(val)) {
            if (key === 'participants') {
              updates.push(`${key} = ARRAY[${val.map(v => `'${v}'`).join(',')}]::uuid[]`);
            } else if (key === 'required_tools' || key === 'attachments') {
              updates.push(`${key} = ARRAY[${val.map(v => `'${v.replace(/'/g, "''")}'`).join(',')}]::text[]`);
            } else {
              updates.push(`${key} = '${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`);
            }
          } else if (typeof val === 'object') updates.push(`${key} = '${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`);
          else updates.push(`${key} = ${val}`);
        }
        
        // Handle is_exploration flag
        if (is_exploration !== undefined) {
          updates.push(`is_exploration = ${is_exploration}`);
        }
        
        updates.push(`updated_by = '${userId}'`);
        if (completed_at) updates.push(`completed_at = '${completed_at}'`);
        
        const sql = `UPDATE actions SET ${updates.join(', ')}, updated_at = NOW() WHERE id = '${id}' RETURNING *`;
        const result = await queryJSON(sql);
        
        // Broadcast cache invalidation to WebSocket clients
        try {
          await broadcastInvalidation({
            entityType: 'action',
            entityId: id,
            mutationType: 'updated',
            organizationId,
            excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
          });
        } catch (err) {
          console.error('[ACTIONS] Broadcast failed:', err.message);
        }

        return { statusCode: 200, headers, body: JSON.stringify({ data: result[0] }) };
      } else {
        // Create
        const uuid = require('crypto').randomUUID();
        const orgId = accessibleOrgIds[0]; // Use first accessible org
        const fields = ['id', 'created_by', 'updated_by', 'organization_id', ...Object.keys(actionData)];
        const values = [`'${uuid}'`, `'${userId}'`, `'${userId}'`, `'${orgId}'`];
        
        for (const [key, val] of Object.entries(actionData)) {
          if (val === null) {
            values.push('NULL');
          } else if (typeof val === 'string') {
            values.push(`'${val.replace(/'/g, "''")}'`);
          } else if (typeof val === 'boolean') {
            values.push(val);
          } else if (Array.isArray(val)) {
            if (key === 'participants') {
              values.push(`ARRAY[${val.map(v => `'${v}'`).join(',')}]::uuid[]`);
            } else if (key === 'required_tools' || key === 'attachments') {
              if (val.length === 0) {
                values.push(`ARRAY[]::text[]`);
              } else {
                values.push(`ARRAY[${val.map(v => `'${v.replace(/'/g, "''")}'`).join(',')}]::text[]`);
              }
            } else {
              values.push(`'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`);
            }
          } else if (typeof val === 'object') {
            values.push(`'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`);
          } else {
            values.push(val);
          }
        }
        
        // Handle is_exploration flag
        if (is_exploration !== undefined) {
          fields.push('is_exploration');
          values.push(is_exploration);
        }
        
        const sql = `INSERT INTO actions (${fields.join(', ')}, created_at, updated_at) VALUES (${values.join(', ')}, NOW(), NOW()) RETURNING *`;
        const result = await queryJSON(sql);
        const newAction = result[0];
        
        // Execute companion sharing updates if shared_with_partners is specified
        if (shared_with_partners !== undefined) {
          await handleSharingUpdate(newAction.id, shared_with_partners);
        }
        
        // Queue embedding generation for the new action (fire-and-forget)
        const embeddingSource = composeActionEmbeddingSource(newAction);
        if (embeddingSource && embeddingSource.trim()) {
          sqs.send(new SendMessageCommand({
            QueueUrl: EMBEDDINGS_QUEUE_URL,
            MessageBody: JSON.stringify({
              entity_type: 'action',
              entity_id: newAction.id,
              embedding_source: embeddingSource,
              organization_id: orgId
            })
          }))
          .then(() => console.log('Queued embedding generation for action', newAction.id))
          .catch(error => console.error('Failed to queue embedding:', error));
        }
        
        // If action is created with status 'in_progress' and has required_tools, create checkouts
        if (newAction.status === 'in_progress' && newAction.required_tools && newAction.required_tools.length > 0) {
          const assignedTo = newAction.assigned_to || userId;
          const checkoutPromises = newAction.required_tools.map(async (toolId) => {
            // Check if tool already has active checkout
            const existingCheckoutSql = `SELECT id FROM checkouts WHERE tool_id = '${toolId}' AND is_returned = false LIMIT 1`;
            const existingCheckout = await queryJSON(existingCheckoutSql);
            
            if (existingCheckout && existingCheckout.length > 0) {
              // Tool already checked out, skip
              return;
            }
            
            // Create checkout for this tool
            const checkoutId = require('crypto').randomUUID();
            const checkoutSql = `INSERT INTO checkouts (id, tool_id, user_id, action_id, checkout_date, is_returned, organization_id, created_at) VALUES ('${checkoutId}', '${toolId}', '${assignedTo}', '${newAction.id}', NOW(), false, '${orgId}', NOW())`;
            await queryJSON(checkoutSql);
          });
          
          // Execute checkout creation in parallel
          await Promise.all(checkoutPromises);
        }
        
        // Broadcast cache invalidation to WebSocket clients
        try {
          await broadcastInvalidation({
            entityType: 'action',
            entityId: newAction.id,
            mutationType: 'created',
            organizationId,
            excludeConnectionId: event.headers?.['x-connection-id'] || event.headers?.['X-Connection-Id'] || null
          });
        } catch (err) {
          console.error('[ACTIONS] Broadcast failed:', err.message);
        }

        return { statusCode: 201, headers, body: JSON.stringify({ data: newAction }) };
      }
    }

    // List non-integrated explorations
    if (httpMethod === 'GET' && path.endsWith('/explorations/list')) {
      const { status = 'in_progress,ready_for_analysis', limit = 100, offset = 0 } = queryStringParameters || {};
      const requestId = require('crypto').randomUUID();
      
      console.log(`[${requestId}] GET /explorations/list - status: ${status}, limit: ${limit}, offset: ${offset}`);
      
      try {
        // Parse status filter
        const statuses = status.split(',').map(s => s.trim());
        const statusCondition = statuses.map(s => `'${s.replace(/'/g, "''")}'`).join(',');
        
        const sql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT 
            e.id,
            e.action_id,
            e.exploration_code,
            a.description as state_text,
            a.policy as summary_policy_text,
            e.exploration_notes_text,
            e.metrics_text,
            e.public_flag,
            e.status,
            COALESCE((
              SELECT COUNT(*) 
              FROM exploration 
              WHERE action_id IS NOT NULL
            ), 0) as action_count,
            e.created_at,
            e.updated_at
          FROM exploration e
          LEFT JOIN actions a ON e.action_id = a.id
          WHERE e.status IN (${statusCondition})
          ORDER BY e.created_at DESC
          LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
        ) t;`;
        
        console.log(`[${requestId}] Executing SQL for explorations list`);
        const result = await queryJSON(sql);
        const explorations = result?.[0]?.json_agg || [];
        
        console.log(`[${requestId}] Found ${explorations.length} explorations`);
        
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ 
            data: explorations,
            total: explorations.length,
            timestamp: new Date().toISOString(),
            requestId
          })
        };
      } catch (error) {
        console.error(`[${requestId}] Error listing explorations:`, error);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ 
            error: 'Failed to list explorations',
            code: 'LIST_EXPLORATIONS_ERROR',
            requestId
          })
        };
      }
    }

    // Exploration code validation endpoints
    if (httpMethod === 'GET' && path.includes('/explorations/check-code/')) {
      const code = decodeURIComponent(path.split('/explorations/check-code/')[1]);
      const sql = `SELECT EXISTS(SELECT 1 FROM exploration WHERE exploration_code = '${code.replace(/'/g, "''")}'::text) as exists`;
      const result = await queryJSON(sql);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ exists: result[0]?.exists || false })
      };
    }

    // Get exploration codes by prefix
    if (httpMethod === 'GET' && path.includes('/explorations/codes-by-prefix/')) {
      const prefix = decodeURIComponent(path.split('/explorations/codes-by-prefix/')[1]);
      const sql = `SELECT exploration_code FROM exploration WHERE exploration_code LIKE '${prefix.replace(/'/g, "''")}%' ORDER BY exploration_code`;
      const result = await queryJSON(sql);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ codes: result.map(r => r.exploration_code) || [] })
      };
    }

    // Actions endpoint
    if (httpMethod === 'GET' && path.endsWith('/actions')) {
      const { limit, offset = 0, assigned_to, status, linked_issue_id, asset_id, id } = queryStringParameters || {};
      
      const orgFilter = buildOrganizationFilter(authContext, 'a');
      let whereConditions = [];
      if (orgFilter.condition) whereConditions.push(orgFilter.condition);
      if (id) {
        whereConditions.push(`a.id = '${id.replace(/'/g, "''")}'`);
      }
      if (assigned_to) {
        whereConditions.push(`a.assigned_to = '${assigned_to.replace(/'/g, "''")}'`);
      }
      if (status) {
        if (status === 'unresolved') {
          whereConditions.push(`a.status IN ('not_started', 'in_progress', 'blocked')`);
        } else {
          whereConditions.push(`a.status = '${status.replace(/'/g, "''")}'`);
        }
      }
      if (linked_issue_id) {
        whereConditions.push(`a.linked_issue_id = '${linked_issue_id.replace(/'/g, "''")}'`);
      }
      if (asset_id) {
        whereConditions.push(`a.asset_id = '${asset_id.replace(/'/g, "''")}'`);
      }
      
      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
      const limitClause = limit ? `LIMIT ${limit} OFFSET ${offset}` : '';
      
      const sql = `SELECT json_agg(row_to_json(t)) FROM (
        SELECT 
          a.*,
          om.full_name as assigned_to_name,
          om.favorite_color as assigned_to_color,
          CASE WHEN (ac.context_id IS NOT NULL OR old_scores.action_id IS NOT NULL) THEN true ELSE false END as has_score,
          CASE WHEN updates.action_id IS NOT NULL THEN true ELSE false END as has_implementation_updates,
          COALESCE(
            (
              SELECT EXISTS(
                SELECT 1 FROM states s
                JOIN state_links sl ON s.id = sl.state_id
                JOIN state_risk_profiles srp ON s.id = srp.state_id
                WHERE sl.entity_type = 'action'
                  AND sl.entity_id = a.id
                  AND s.state_text = 'Shared narrative and impact overview for action'
                  AND srp.aggregate_risk = 0.0
              )
            ),
            false
          ) as shared_with_partners,
          CASE WHEN a.asset_id IS NOT NULL THEN
            json_build_object('id', t.id, 'name', t.name, 'category', t.category)
          ELSE NULL END as asset
        FROM actions a
        LEFT JOIN profiles om ON a.assigned_to = om.user_id
        LEFT JOIN analysis_contexts ac ON a.id = ac.context_id AND ac.context_service = 'action_score'
        LEFT JOIN action_scores old_scores ON a.id = old_scores.action_id
        LEFT JOIN (
          SELECT DISTINCT entity_id as action_id
          FROM state_links
          WHERE entity_type = 'action'
        ) updates ON a.id = updates.action_id
        LEFT JOIN tools t ON a.asset_id = t.id
        ${whereClause} 
        ORDER BY a.created_at DESC 
        ${limitClause}
      ) t;`;
      
      console.log('Executing SQL:', sql);
      const result = await queryJSON(sql);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
      };
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