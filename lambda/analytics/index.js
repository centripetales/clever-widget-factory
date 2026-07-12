const { Client } = require('pg');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'us-west-2' });

const getDbConfig = () => ({
  host: process.env.DB_HOST || 'cwf-dev-postgres.ctmma86ykgeb.us-west-2.rds.amazonaws.com',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

exports.handler = async (event) => {
  console.log('Analytics Lambda Event:', JSON.stringify(event, null, 2));
  
  const path = event.path || event.rawPath;
  const method = event.httpMethod || event.requestContext?.http?.method;
  const queryParams = event.queryStringParameters || {};
  
  const authContext = event.requestContext?.authorizer || {};
  const organizationId = authContext.organization_id;
  
  console.log('Auth context:', authContext);
  console.log('Organization ID:', organizationId);
  
  if (!organizationId) {
    console.error('Missing organization_id from authorizer');
    return {
      statusCode: 401,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ error: 'Unauthorized: No organization context' })
    };
  }

  const client = new Client(getDbConfig());
  
  try {
    await client.connect();
    
    // Observations endpoint (states linked to tools or parts)
    if (path.endsWith('/analytics/observations') && method === 'GET') {
      const { start_date, end_date, user_ids } = queryParams;
      
      console.log('Query params:', { start_date, end_date, user_ids });
      
      if (!start_date || !end_date) {
        return {
          statusCode: 400,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: JSON.stringify({ error: 'start_date and end_date required' })
        };
      }
      
      let userFilter = '';
      if (user_ids) {
        const userIdArray = Array.isArray(user_ids) 
          ? user_ids 
          : user_ids.includes(',') 
            ? user_ids.split(',').map(id => id.trim()) 
            : [user_ids];
        if (userIdArray.length > 0) {
          const userIdList = userIdArray.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
          userFilter = `AND s.captured_by IN (${userIdList})`;
        }
      }
      
      const query = `
        SELECT 
          s.created_at,
          s.captured_by
        FROM states s
        JOIN state_links sl ON s.id = sl.state_id
        LEFT JOIN tools t ON sl.entity_type = 'tool' AND sl.entity_id = t.id
        LEFT JOIN parts p ON sl.entity_type = 'part' AND sl.entity_id = p.id
        WHERE sl.entity_type IN ('tool', 'part')
          AND (
            (sl.entity_type = 'tool' AND t.organization_id = $1)
            OR (sl.entity_type = 'part' AND p.organization_id = $1)
          )
          AND s.created_at >= $2::timestamp
          AND s.created_at <= $3::timestamp
          ${userFilter}
        ORDER BY s.created_at
      `;
      
      console.log('Executing observations query:', query);
      console.log('Query params:', [organizationId, start_date, end_date]);
      
      const result = await client.query(query, [organizationId, start_date, end_date]);
      
      console.log('Query result count:', result.rows.length);
      
      return {
        statusCode: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
          'Access-Control-Allow-Methods': 'GET,OPTIONS'
        },
        body: JSON.stringify({ data: result.rows })
      };
    }
    
    if (path.endsWith('/analytics/action_updates') && method === 'GET') {
      const { start_date, end_date, user_ids } = queryParams;
      
      console.log('Query params:', { start_date, end_date, user_ids, user_ids_type: typeof user_ids, user_ids_isArray: Array.isArray(user_ids) });
      
      if (!start_date || !end_date) {
        return {
          statusCode: 400,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: JSON.stringify({ error: 'start_date and end_date required' })
        };
      }
      
      let userFilter = '';
      if (user_ids) {
        // Handle comma-separated string or array
        const userIdArray = Array.isArray(user_ids) 
          ? user_ids 
          : user_ids.includes(',') 
            ? user_ids.split(',').map(id => id.trim()) 
            : [user_ids];
        if (userIdArray.length > 0) {
          const userIdList = userIdArray.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
          userFilter = `AND aiu.updated_by IN (${userIdList})`;
        }
      }
      
      const query = `
        SELECT 
          s.created_at,
          s.captured_by as updated_by
        FROM states s
        JOIN state_links sl ON s.id = sl.state_id
        JOIN actions a ON sl.entity_id = a.id
        WHERE sl.entity_type = 'action'
          AND a.organization_id = $1
          AND s.created_at >= $2::timestamp
          AND s.created_at <= $3::timestamp
          ${userFilter.replace('aiu.updated_by', 's.captured_by')}
        ORDER BY s.created_at
      `;
      
      console.log('Executing query:', query);
      console.log('Query params:', [organizationId, start_date, end_date]);
      
      const result = await client.query(query, [organizationId, start_date, end_date]);
      
      console.log('Query result count:', result.rows.length);
      
      return {
        statusCode: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
          'Access-Control-Allow-Methods': 'GET,OPTIONS'
        },
        body: JSON.stringify({ data: result.rows })
      };
    }
    
    // Time summaries endpoint (daily AI-computed time perspectives)
    if (path.endsWith('/analytics/time-summaries') && method === 'GET') {
      const { start_date, end_date, user_id, tags, boundary_type, confidence } = queryParams;

      if (!start_date || !end_date) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: 'start_date and end_date required' })
        };
      }

      // Query existing summaries (both fresh and stale)
      const summaryQuery = `
        SELECT id, state_text, captured_at
        FROM states
        WHERE organization_id = $1
          AND (state_text LIKE '[summary:day]%' OR state_text LIKE '[stale][summary:day]%')
        ORDER BY captured_at
      `;
      const summaryResult = await client.query(summaryQuery, [organizationId]);

      // Parse summaries and filter by date range
      const summaries = [];
      const staleDates = [];
      const existingDates = new Set();

      for (const row of summaryResult.rows) {
        try {
          const isStale = row.state_text.startsWith('[stale]');
          const jsonStr = row.state_text.replace(/^\[stale\]\[summary:day\]\s*/, '').replace(/^\[summary:day\]\s*/, '');
          const parsed = JSON.parse(jsonStr);

          if (parsed.date >= start_date && parsed.date <= end_date) {
            existingDates.add(parsed.date);
            if (isStale) staleDates.push(parsed.date);

            // Apply filters
            let entries = parsed.entries || [];
            if (user_id) entries = entries.filter(e => e.user_id === user_id);
            if (tags) {
              const tagList = tags.split(',').map(t => t.trim().toLowerCase());
              entries = entries.filter(e => e.tags?.some(t => tagList.includes(t.toLowerCase())));
            }
            if (boundary_type) entries = entries.filter(e => e.boundary_type === boundary_type);
            if (confidence) {
              const levels = ['high', 'medium', 'low', 'unknown'];
              const minIdx = levels.indexOf(confidence);
              entries = entries.filter(e => levels.indexOf(e.confidence) <= minIdx);
            }

            summaries.push({
              date: parsed.date,
              state_id: row.id,
              entries,
              notes: parsed.notes || '',
              is_stale: isStale,
            });
          }
        } catch (parseErr) {
          console.error('Failed to parse summary:', row.id, parseErr.message);
        }
      }

      // Find missing days in the range
      const missingDates = [];
      const startD = new Date(start_date + 'T00:00:00+08:00');
      const endD = new Date(end_date + 'T00:00:00+08:00');
      for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        if (!existingDates.has(dateStr)) missingDates.push(dateStr);
      }

      // Trigger computation for missing + stale days
      const datesToCompute = [...missingDates, ...staleDates];
      let daysComputed = 0;

      if (datesToCompute.length > 0) {
        try {
          console.log(`[ANALYTICS] Triggering time-perspective-worker for ${datesToCompute.length} days`);
          const invokeResult = await lambdaClient.send(new InvokeCommand({
            FunctionName: 'time-perspective-worker',
            InvocationType: 'RequestResponse',
            Payload: JSON.stringify({
              organization_id: organizationId,
              dates: datesToCompute,
              force_recompute: false,
            }),
          }));

          const workerResponse = JSON.parse(new TextDecoder().decode(invokeResult.Payload));
          daysComputed = workerResponse.computed?.filter(c => c.success && !c.skipped).length || 0;

          // Re-query if new summaries were computed
          if (daysComputed > 0) {
            const refreshResult = await client.query(summaryQuery, [organizationId]);
            summaries.length = 0; // Clear and re-parse

            for (const row of refreshResult.rows) {
              try {
                const isStale = row.state_text.startsWith('[stale]');
                const jsonStr = row.state_text.replace(/^\[stale\]\[summary:day\]\s*/, '').replace(/^\[summary:day\]\s*/, '');
                const parsed = JSON.parse(jsonStr);

                if (parsed.date >= start_date && parsed.date <= end_date) {
                  let entries = parsed.entries || [];
                  if (user_id) entries = entries.filter(e => e.user_id === user_id);
                  if (tags) {
                    const tagList = tags.split(',').map(t => t.trim().toLowerCase());
                    entries = entries.filter(e => e.tags?.some(t => tagList.includes(t.toLowerCase())));
                  }
                  if (boundary_type) entries = entries.filter(e => e.boundary_type === boundary_type);
                  if (confidence) {
                    const levels = ['high', 'medium', 'low', 'unknown'];
                    const minIdx = levels.indexOf(confidence);
                    entries = entries.filter(e => levels.indexOf(e.confidence) <= minIdx);
                  }

                  summaries.push({
                    date: parsed.date,
                    state_id: row.id,
                    entries,
                    notes: parsed.notes || '',
                    is_stale: isStale,
                  });
                }
              } catch (parseErr) {
                // skip malformed
              }
            }
          }
        } catch (workerErr) {
          console.error('[ANALYTICS] time-perspective-worker invocation failed:', workerErr.message);
        }
      }

      // Sort by date
      summaries.sort((a, b) => a.date.localeCompare(b.date));

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
          'Access-Control-Allow-Methods': 'GET,OPTIONS'
        },
        body: JSON.stringify({
          summaries,
          computation_status: {
            days_requested: Math.round((endD - startD) / (1000 * 60 * 60 * 24)) + 1,
            days_with_data: summaries.length,
            days_computed: daysComputed,
            stale_count: summaries.filter(s => s.is_stale).length,
          }
        })
      };
    }

    return {
      statusCode: 404,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
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
  } finally {
    await client.end();
  }
};
