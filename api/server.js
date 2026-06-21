import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());

// RDS PostgreSQL connection details
// SECURITY: Password must be provided via environment variable
if (!process.env.RDS_PASSWORD) {
  throw new Error('RDS_PASSWORD environment variable is required');
}

const RDS_HOST = process.env.RDS_HOST || 'cwf-dev-postgres.ctmma86ykgeb.us-west-2.rds.amazonaws.com';
const RDS_PORT = process.env.RDS_PORT || '5432';
const RDS_USER = process.env.RDS_USER || 'postgres';
const RDS_PASSWORD = process.env.RDS_PASSWORD;
const RDS_DATABASE = process.env.RDS_DATABASE || 'postgres';

// Helper to execute SQL and return JSON
async function queryJSON(sql) {
  const command = `PGPASSWORD='${RDS_PASSWORD}' psql -h ${RDS_HOST} -p ${RDS_PORT} -U ${RDS_USER} -d ${RDS_DATABASE} -t -c "${sql}"`;
  const { stdout } = await execAsync(command);
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    console.error('JSON parse error:', e, 'Raw output:', trimmed);
    return null;
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Generic query endpoint
app.post('/api/query', async (req, res) => {
  try {
    const { sql, params = [] } = req.body;
    let finalSql = sql;
    params.forEach((param, i) => {
      finalSql = finalSql.replace(`$${i + 1}`, `'${param}'`);
    });
    
    const jsonSql = `SELECT json_agg(row_to_json(t)) FROM (${finalSql}) t;`;
    const result = await queryJSON(jsonSql);
    res.json({ data: result || [] });
  } catch (error) {
    console.error('Query error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Organizations endpoint
app.get('/api/organizations', async (req, res) => {
  try {
    const sql = `SELECT json_agg(row_to_json(t)) FROM (
      SELECT id, name, is_active, subdomain, settings, created_at, updated_at,
             (SELECT COUNT(*) FROM organization_members WHERE organization_id = organizations.id AND is_active = true) as member_count
      FROM organizations
      WHERE (settings->>'deleted' IS NULL OR settings->>'deleted' != 'true')
      ORDER BY name
    ) t;`;
    
    const result = await queryJSON(sql);
    res.json({ data: result || [] });
  } catch (error) {
    console.error('Organizations error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Organization members endpoint
app.get('/api/organization_members', async (req, res) => {
  try {
    const { organization_id = '00000000-0000-0000-0000-000000000001' } = req.query;
    
    const sql = `SELECT json_agg(row_to_json(t)) FROM (
      SELECT user_id, full_name, role, cognito_user_id, is_active
      FROM organization_members
      WHERE full_name IS NOT NULL 
        AND trim(full_name) != ''
        AND organization_id = '${organization_id}'
      ORDER BY full_name
    ) t;`;
    
    const result = await queryJSON(sql);
    res.json({ data: result || [] });
  } catch (error) {
    console.error('Organization members error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Actions endpoint
app.get('/api/actions', async (req, res) => {
  try {
    const { limit, offset = 0, assigned_to, status, view_shared, organization_id = '00000000-0000-0000-0000-000000000001' } = req.query;
    
    let whereConditions = [];
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

    let orgCondition = `a.organization_id = '${organization_id}'`;
    let isSharedSelect = `false as is_shared`;

    if (view_shared) {
      const sharedArray = Array.isArray(view_shared) ? view_shared : view_shared.split(',');
      if (sharedArray.length > 0) {
        const sharedOrgsStr = sharedArray.map(id => `'${id}'`).join(',');
        orgCondition = `(
          a.organization_id = '${organization_id}' 
          OR a.id IN (
            SELECT sl1.entity_id 
            FROM state_links sl1 
            JOIN state_links sl2 ON sl1.state_id = sl2.state_id 
            JOIN states s ON s.id = sl1.state_id
            WHERE sl1.entity_type = 'action' 
              AND sl2.entity_type = 'organization' 
              AND sl2.entity_id = '${organization_id}'
              AND s.organization_id IN (${sharedOrgsStr})
          )
        )`;
        isSharedSelect = `CASE WHEN a.organization_id != '${organization_id}' THEN true ELSE false END as is_shared`;
      }
    }
    whereConditions.push(orgCondition);
    
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    const limitClause = limit ? `LIMIT ${limit} OFFSET ${offset}` : '';
    
    const sql = `SELECT json_agg(row_to_json(t)) FROM (
      SELECT 
        a.*,
        om.full_name as assigned_to_name,
        CASE WHEN scores.action_id IS NOT NULL THEN true ELSE false END as has_score,
        ${isSharedSelect}
      FROM actions a
      LEFT JOIN organization_members om ON a.assigned_to = om.user_id
      LEFT JOIN action_scores scores ON a.id = scores.action_id
      ${whereClause} 
      ORDER BY a.created_at DESC 
      ${limitClause}
    ) t;`;
    
    const result = await queryJSON(sql);
    res.json({ data: result || [] });
  } catch (error) {
    console.error('Actions error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Tools endpoint
app.get('/api/tools', async (req, res) => {
  try {
    const { limit = 50, offset = 0, view_shared, organization_id = '00000000-0000-0000-0000-000000000001' } = req.query;

    let orgCondition = `organization_id = '${organization_id}'`;
    let isSharedSelect = `false as is_shared`;

    if (view_shared) {
      const sharedArray = Array.isArray(view_shared) ? view_shared : view_shared.split(',');
      if (sharedArray.length > 0) {
        const sharedOrgsStr = sharedArray.map(id => `'${id}'`).join(',');
        orgCondition = `(
          organization_id = '${organization_id}' 
          OR id IN (
            SELECT sl1.entity_id 
            FROM state_links sl1 
            JOIN state_links sl2 ON sl1.state_id = sl2.state_id 
            JOIN states s ON s.id = sl1.state_id
            WHERE sl1.entity_type = 'tool' 
              AND sl2.entity_type = 'organization' 
              AND sl2.entity_id = '${organization_id}'
              AND s.organization_id IN (${sharedOrgsStr})
          )
        )`;
        isSharedSelect = `CASE WHEN organization_id != '${organization_id}' THEN true ELSE false END as is_shared`;
      }
    }

    const sql = `SELECT json_agg(row_to_json(t)) FROM (
      SELECT id, name, description, category, status, serial_number, 
             parent_structure_id, storage_location, legacy_storage_vicinity,
             accountable_person_id, 
             CASE 
               WHEN image_url LIKE '%supabase.co%' THEN 
                 REPLACE(image_url, 'https://oskwnlhuuxjfuwnjuavn.supabase.co/storage/v1/object/public/', 'https://cwf-dev-assets.s3.us-west-2.amazonaws.com/')
               ELSE image_url 
             END as image_url,
             created_at, updated_at,
             ${isSharedSelect}
      FROM tools 
      WHERE ${orgCondition}
      ORDER BY name LIMIT ${limit} OFFSET ${offset}
    ) t;`;
    
    const result = await queryJSON(sql);
    res.json({ data: result || [] });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Parts endpoint
app.get('/api/parts', async (req, res) => {
  try {
    const { limit = 50, offset = 0, view_shared, organization_id = '00000000-0000-0000-0000-000000000001' } = req.query;

    let orgCondition = `organization_id = '${organization_id}'`;
    let isSharedSelect = `false as is_shared`;

    if (view_shared) {
      const sharedArray = Array.isArray(view_shared) ? view_shared : view_shared.split(',');
      if (sharedArray.length > 0) {
        const sharedOrgsStr = sharedArray.map(id => `'${id}'`).join(',');
        orgCondition = `(
          organization_id = '${organization_id}' 
          OR id IN (
            SELECT sl1.entity_id 
            FROM state_links sl1 
            JOIN state_links sl2 ON sl1.state_id = sl2.state_id 
            JOIN states s ON s.id = sl1.state_id
            WHERE sl1.entity_type = 'part' 
              AND sl2.entity_type = 'organization' 
              AND sl2.entity_id = '${organization_id}'
              AND s.organization_id IN (${sharedOrgsStr})
          )
        )`;
        isSharedSelect = `CASE WHEN organization_id != '${organization_id}' THEN true ELSE false END as is_shared`;
      }
    }

    const sql = `SELECT json_agg(row_to_json(t)) FROM (
      SELECT id, name, description, category, current_quantity, minimum_quantity, 
             unit, parent_structure_id, storage_location, legacy_storage_vicinity, 
             accountable_person_id, sellable, cost_per_unit,
             CASE 
               WHEN image_url LIKE '%supabase.co%' THEN 
                 REPLACE(image_url, 'https://oskwnlhuuxjfuwnjuavn.supabase.co/storage/v1/object/public/', 'https://cwf-dev-assets.s3.us-west-2.amazonaws.com/')
               ELSE image_url 
             END as image_url,
             created_at, updated_at,
             ${isSharedSelect}
      FROM parts 
      WHERE ${orgCondition}
      ORDER BY name LIMIT ${limit} OFFSET ${offset}
    ) t;`;
    
    const result = await queryJSON(sql);
    res.json({ data: result || [] });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Sellable parts endpoint for sari-sari store
app.get('/api/parts/sellable', async (req, res) => {
  try {
    const sql = `SELECT json_agg(row_to_json(t)) FROM (
      SELECT id, name, description, category, current_quantity, minimum_quantity, 
             unit, cost_per_unit, sellable,
             CASE 
               WHEN image_url LIKE '%supabase.co%' THEN 
                 REPLACE(image_url, 'https://oskwnlhuuxjfuwnjuavn.supabase.co/storage/v1/object/public/', 'https://cwf-dev-assets.s3.us-west-2.amazonaws.com/')
               ELSE image_url 
             END as image_url,
             created_at, updated_at 
      FROM parts 
      WHERE sellable = true 
        AND current_quantity > 0
        AND (cost_per_unit > 0 OR description ILIKE '%free%' OR description ILIKE '%customer%')
      ORDER BY name
    ) t;`;
    
    const result = await queryJSON(sql);
    res.json({ data: result || [] });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Semantic search endpoint removed - use production API endpoint instead
// The production semantic search is available at:
// https://0720au267k.execute-api.us-west-2.amazonaws.com/prod/api/semantic-search
// Use apiService.post('/semantic-search', { query, table, limit }) in frontend code

// Share configuration endpoint
app.post('/api/shares', async (req, res) => {
  try {
    const { entity_type, entity_id, target_org_id, justification, source_org_id, cognito_user_id } = req.body;

    if (!entity_type || !entity_id || !target_org_id || !source_org_id) {
      return res.status(400).json({ error: 'Missing required sharing parameters' });
    }

    const crypto = require('crypto');
    const stateId = crypto.randomUUID();

    // 1. Create the Share State
    const insertStateSql = `
      INSERT INTO states (id, organization_id, state_text, captured_by, captured_at)
      VALUES ('${stateId}', '${source_org_id}', '${justification ? justification.replace(/'/g, "''") : 'Shared entity'}', '${cognito_user_id || '00000000-0000-0000-0000-000000000000'}', NOW())
      RETURNING *;
    `;
    const stateResult = await queryJSON(insertStateSql);

    // 2. Create state link to the entity
    const linkEntitySql = `
      INSERT INTO state_links (id, state_id, entity_type, entity_id)
      VALUES (gen_random_uuid(), '${stateId}', '${entity_type}', '${entity_id}');
    `;
    await queryJSON(linkEntitySql);

    // 3. Create state link to the target organization
    const linkOrgSql = `
      INSERT INTO state_links (id, state_id, entity_type, entity_id)
      VALUES (gen_random_uuid(), '${stateId}', 'organization', '${target_org_id}');
    `;
    await queryJSON(linkOrgSql);

    res.json({ success: true, state: stateResult[0] });
  } catch (error) {
    console.error('Share error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`API server running on port ${port}`);
});