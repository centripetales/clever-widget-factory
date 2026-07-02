const { Client } = require('pg');
const { getAuthorizerContext } = require('/opt/nodejs/authorizerContext');
const jwt = require('jsonwebtoken');
const { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand, ListUsersCommand } = require('@aws-sdk/client-cognito-identity-provider');
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const cognito = new CognitoIdentityProviderClient({ region: 'us-west-2' });
const ses = new SESClient({ region: 'us-west-2' });

function generateInviteToken(email, organizationId) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is required');
  return jwt.sign({ email, organizationId }, secret, { expiresIn: '24h' });
}

function verifyInviteToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is required');
  return jwt.verify(token, secret); // throws if invalid/expired
}

function generateRandomPassword() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  return Array.from({ length: 24 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

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
  
  // Unauthenticated endpoints (invite flow) — skip org access check
  const publicPaths = ['/validate-invite-token', '/activate-user-password', '/activate-user-account'];
  const isPublicEndpoint = publicPaths.some(p => path.endsWith(p));
  
  if (!isPublicEndpoint && accessibleOrgIds.length === 0) {
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
          SELECT user_id, cognito_user_id, organization_id, full_name, role, favorite_color, is_active, email
          FROM organization_members
          WHERE cognito_user_id = '${targetUserId.replace(/'/g, "''")}'
            AND is_active = true
          ORDER BY created_at ASC
        ) t;`;
      } else if (queryStringParameters?.organization_id) {
        // Specific org: return all members for management (includes id for delete)
        const orgId = queryStringParameters.organization_id.replace(/'/g, "''");
        sql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT id, user_id, full_name, role, is_active, cognito_user_id, favorite_color, email, organization_id
          FROM organization_members
          WHERE organization_id = '${orgId}'
          ORDER BY is_active DESC, full_name NULLS LAST
        ) t;`;
      } else {
        // Default: deduplicated list of all members across accessible orgs
        sql = `SELECT json_agg(row_to_json(t)) FROM (
          SELECT DISTINCT ON (cognito_user_id) cognito_user_id as user_id, full_name, role, cognito_user_id, favorite_color, is_active, email
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
        SELECT id, user_id, full_name, role, is_active, created_at, super_admin, organization_id, email, cognito_user_id, favorite_color
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
    
    // POST /api/invite-user — admin invites a user by email
    if (httpMethod === 'POST' && path.endsWith('/invite-user')) {
      const { email, organizationId, organizationName, role = 'user' } = JSON.parse(event.body || '{}');

      if (!email || !organizationId || !organizationName) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'email, organizationId, and organizationName are required' }) };
      }
      if (!authContext.permissions?.includes('data:write:all') && authContext.user_role !== 'admin') {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin permission required' }) };
      }

      // Create Cognito user (suppress default welcome email — we send our own)
      let cognitoUserId;
      let isExistingUser = false;
      try {
        const createResp = await cognito.send(new AdminCreateUserCommand({
          UserPoolId: process.env.USER_POOL_ID,
          Username: email,
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
          ],
          DesiredDeliveryMediums: [],
          MessageAction: 'SUPPRESS',
        }));
        cognitoUserId = createResp.User.Username;
      } catch (err) {
        if (err.name === 'UsernameExistsException') {
          // User exists in Cognito — look up their ID and proceed to add membership
          isExistingUser = true;
          const listResp = await cognito.send(new ListUsersCommand({
            UserPoolId: process.env.USER_POOL_ID,
            Filter: `email = "${email}"`,
            Limit: 1,
          }));
          cognitoUserId = listResp.Users?.[0]?.Username;
          if (!cognitoUserId) {
            return { statusCode: 404, headers, body: JSON.stringify({ error: 'Could not find existing user' }) };
          }
        } else {
          throw err;
        }
      }

      // Create organization membership
      await queryParams(
        `INSERT INTO organization_members (user_id, cognito_user_id, email, organization_id, role, full_name, is_active)
         VALUES ($1, $2, $3, $4, $5, '', true)
         ON CONFLICT (cognito_user_id, organization_id) DO NOTHING`,
        [cognitoUserId, cognitoUserId, email, organizationId, role]
      );

      // Generate invite token and link
      const token = generateInviteToken(email, organizationId);
      const appUrl = process.env.APP_URL || 'https://stargazer-farm.com';
      const inviteLink = `${appUrl}/accept-invite?token=${token}`;

      // Attempt to send email via SES (best-effort — may fail in sandbox mode)
      let emailSent = false;
      try {
        await ses.send(new SendEmailCommand({
          Source: process.env.SES_FROM_EMAIL || 'noreply@stargazer-farm.com',
          Destination: { ToAddresses: [email] },
          Message: {
            Subject: { Data: `You've been invited to ${organizationName}` },
            Body: {
              Html: {
                Data: `<p>You've been invited to join <strong>${organizationName}</strong>.</p>
                       <p><a href="${inviteLink}">Click here to activate your account</a></p>
                       <p>This link expires in 24 hours.</p>`
              },
              Text: {
                Data: `You've been invited to join ${organizationName}.\n\nActivate your account: ${inviteLink}\n\nThis link expires in 24 hours.`
              }
            }
          }
        }));
        emailSent = true;
      } catch (emailErr) {
        console.warn('Failed to send invite email:', emailErr.message);
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, cognitoUserId, emailSent, inviteLink }) };
    }

    // POST /api/validate-invite-token — validates a JWT invite token
    if (httpMethod === 'POST' && path.endsWith('/validate-invite-token')) {
      const { token } = JSON.parse(event.body || '{}');
      if (!token) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'token is required' }) };
      }

      try {
        const decoded = verifyInviteToken(token);
        // Fetch org name for display
        const orgRows = await queryParams('SELECT name FROM organizations WHERE id = $1', [decoded.organizationId]);
        const organizationName = orgRows[0]?.name || '';
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ valid: true, email: decoded.email, organizationId: decoded.organizationId, organizationName })
        };
      } catch (err) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ valid: false, error: 'This invitation link is invalid or has expired.' })
        };
      }
    }

    // POST /api/activate-user-account — clears FORCE_CHANGE_PASSWORD after Google sign-in
    if (httpMethod === 'POST' && path.endsWith('/activate-user-account')) {
      const { email } = JSON.parse(event.body || '{}');
      if (!email) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'email is required' }) };
      }

      await cognito.send(new AdminSetUserPasswordCommand({
        UserPoolId: process.env.USER_POOL_ID,
        Username: email,
        Password: generateRandomPassword(),
        Permanent: true,
      }));

      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // POST /api/activate-user-password — sets user password from invite flow
    if (httpMethod === 'POST' && path.endsWith('/activate-user-password')) {
      const { email, password, token } = JSON.parse(event.body || '{}');
      if (!email || !password || !token) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'email, password, and token are required' }) };
      }

      let decoded;
      try {
        decoded = verifyInviteToken(token);
      } catch (err) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid or expired invitation token' }) };
      }

      if (decoded.email !== email) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Email does not match invitation' }) };
      }

      await cognito.send(new AdminSetUserPasswordCommand({
        UserPoolId: process.env.USER_POOL_ID,
        Username: email,
        Password: password,
        Permanent: true,
      }));

      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
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