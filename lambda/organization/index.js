const { Client } = require('pg');
const { getAuthorizerContext } = require('/opt/nodejs/authorizerContext');

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

// Helper to execute parameterized SQL
async function queryParams(sql, params) {
  const client = new Client(dbConfig);
  try {
    await client.connect();
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  const { httpMethod, path, queryStringParameters } = event;
  const authContext = getAuthorizerContext(event);
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
    
    // Handle preflight requests
    if (httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers,
        body: ''
      };
    }
    
    // Organization members endpoint
    if (httpMethod === 'GET' && path.endsWith('/organization_members')) {
      const orgIdsList = accessibleOrgIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
      const filterUserId = queryStringParameters?.cognito_user_id;
      
      let sql;
      if (filterUserId) {
        // Return all memberships for a specific user across ALL their orgs
        // Don't filter by accessibleOrgIds here — this is needed for org switching
        // Security: user can only query their own memberships (cognito_user_id from authorizer)
        const requestingUserId = authContext.cognito_user_id;
        const targetUserId = filterUserId === requestingUserId ? filterUserId : null;
        
        if (!targetUserId) {
          return {
            statusCode: 403,
            headers,
            body: JSON.stringify({ error: 'Can only query your own memberships' })
          };
        }
        
        sql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT user_id, cognito_user_id, organization_id, full_name, role, favorite_color, is_active
          FROM organization_members
          WHERE cognito_user_id = '${targetUserId.replace(/'/g, "''")}'
            AND is_active = true
          ORDER BY created_at ASC
        ) t;`;
      } else {
        // Default: deduplicated list of all members across accessible orgs
        sql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT DISTINCT ON (cognito_user_id) cognito_user_id as user_id, full_name, role, cognito_user_id, favorite_color, is_active
          FROM organization_members
          WHERE full_name IS NOT NULL 
            AND trim(full_name) != ''
            AND cognito_user_id IS NOT NULL
            AND organization_id IN (${orgIdsList})
          ORDER BY cognito_user_id, full_name
        ) t;`;
      }
      
      const result = await queryJSON(sql);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
      };
    }
    
    // All organization members endpoint (for management)
    if (httpMethod === 'GET' && path.includes('/organization_members/all')) {
      const { organization_id = '00000000-0000-0000-0000-000000000001' } = queryStringParameters || {};
      
      const sql = `SELECT json_agg(row_to_json(t)) FROM (
        SELECT user_id, full_name, role, is_active, created_at, super_admin, organization_id
        FROM organization_members
        WHERE organization_id = '${organization_id}'
        ORDER BY is_active DESC, full_name NULLS LAST
      ) t;`;
      
      const result = await queryJSON(sql);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: result?.[0]?.json_agg || [] })
      };
    }
    
    // Find organization member by email
    if (httpMethod === 'GET' && path.includes('/organization_members/by-email')) {
      const { email } = queryStringParameters || {};
      if (!email) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Email parameter required' })
        };
      }
      
      const sql = `SELECT json_agg(row_to_json(t)) FROM (
        SELECT user_id, full_name, role, email, cognito_user_id
        FROM organization_members
        WHERE email = '${email}' AND is_active = true
        LIMIT 1
      ) t;`;
      
      const result = await queryJSON(sql);
      const member = result?.[0]?.json_agg?.[0] || null;
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: member })
      };
    }
    
    // Impact preview endpoint
    if (httpMethod === 'GET' && path.match(/^\/organizations\/([^/]+)\/impact$/)) {
      const orgId = path.split('/')[2];
      const impact = {};
      // Active members (organization_members has is_active)
      const memberRows = await queryParams('SELECT COUNT(*) FROM organization_members WHERE organization_id = $1 AND is_active = true', [orgId]);
      impact.members = parseInt(memberRows[0].count, 10);
      // Actions (no is_active column — count all)
      const actionRows = await queryParams('SELECT COUNT(*) FROM actions WHERE organization_id = $1', [orgId]);
      impact.actions = parseInt(actionRows[0].count, 10);
      // Missions (no is_active column — count all)
      const missionRows = await queryParams('SELECT COUNT(*) FROM missions WHERE organization_id = $1', [orgId]);
      impact.missions = parseInt(missionRows[0].count, 10);
      // Tools (no is_active column — count all)
      const toolRows = await queryParams('SELECT COUNT(*) FROM tools WHERE organization_id = $1', [orgId]);
      impact.tools = parseInt(toolRows[0].count, 10);
      // Issues (no is_active column — count all)
      const issueRows = await queryParams('SELECT COUNT(*) FROM issues WHERE organization_id = $1', [orgId]);
      impact.issues = parseInt(issueRows[0].count, 10);
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ data: impact })
      };
    }
    
    // Soft‑delete endpoint (manual backup expected before calling this)
    if (httpMethod === 'DELETE' && path.match(/^\/organizations\/([^/]+)$/)) {
      const orgId = path.split('/')[2];
      const backupFlag = queryStringParameters?.backup === 'done';
      if (!backupFlag) {
        console.warn('Soft‑delete invoked without backup flag. Ensure a manual RDS snapshot was taken.');
      }
      const client = new Client(dbConfig);
      try {
        await client.connect();
        await client.query('BEGIN');
        // Deactivate the organization row
        await client.query('UPDATE organizations SET is_active = false, updated_at = NOW() WHERE id = $1', [orgId]);
        // Deactivate related rows — only tables that have BOTH organization_id AND is_active
        const deactivatableTables = ['organization_members', 'storage_vicinities', 'suppliers'];
        for (const tbl of deactivatableTables) {
          await client.query(`UPDATE ${tbl} SET is_active = false WHERE organization_id = $1`, [orgId]);
        }
        await client.query('COMMIT');
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true })
        };
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('Soft‑delete error:', err);
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: err.message })
        };
      } finally {
        await client.end();
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