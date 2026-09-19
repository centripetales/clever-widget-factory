const { getAuthorizerContext, buildOrganizationFilter } = require('/opt/nodejs/authorizerContext');
const { successResponse, errorResponse } = require('/opt/nodejs/response');
const { getDbClient } = require('/opt/nodejs/db');
const { formatSqlValue } = require('/opt/nodejs/sqlUtils');

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Organization-Id,X-Connection-Id',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

// Returns an error message when `value` doesn't fit the metric's type and
// range, or null when it does. Mirrors src/lib/metricValue.ts.
function validateMetricValue(metric, value) {
  const text = String(value).trim();
  if (text === '') return 'A value is required';
  if (metric.value_type === 'text') return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return `${metric.name} must be a number`;
  if (metric.min_value !== null && n < Number(metric.min_value)) return `${metric.name} must be at least ${metric.min_value}`;
  if (metric.max_value !== null && n > Number(metric.max_value)) return `${metric.name} must be at most ${metric.max_value}`;
  return null;
}

exports.handler = async (event) => {
  const { httpMethod, pathParameters, path } = event;

  if (httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const authContext = getAuthorizerContext(event);
  const organizationId = authContext.organization_id;

  if (!organizationId) {
    console.error('❌ ERROR: organization_id missing from authorizer context');
    return errorResponse(500, 'Server configuration error', headers);
  }

  try {
    // Route: /api/states/{id}/snapshots
    if (path.includes('/states/') && path.includes('/snapshots')) {
      const stateId = pathParameters?.id; // API Gateway uses {id} not {state_id}
      
      if (httpMethod === 'GET') {
        return await listSnapshots(stateId, authContext, headers);
      } else if (httpMethod === 'POST') {
        return await createSnapshot(event, stateId, authContext, headers);
      }
    }
    
    // Route: /api/snapshots/{snapshot_id}
    if (path.includes('/snapshots/') && pathParameters?.snapshot_id) {
      const snapshotId = pathParameters.snapshot_id;
      
      if (httpMethod === 'PUT') {
        return await updateSnapshot(event, snapshotId, authContext, headers);
      } else if (httpMethod === 'DELETE') {
        return await deleteSnapshot(snapshotId, authContext, headers);
      }
    }

    return errorResponse(404, 'Route not found', headers);
  } catch (error) {
    console.error('❌ ERROR:', error);
    return errorResponse(500, error.message, headers);
  }
};

async function listSnapshots(stateId, authContext, headers) {
  const client = await getDbClient();
  
  try {
    // Verify state belongs to organization
    const stateCheckSql = `
      SELECT organization_id
      FROM states
      WHERE id = ${formatSqlValue(stateId)}::uuid
    `;
    
    const stateResult = await client.query(stateCheckSql);
    
    if (stateResult.rows.length === 0) {
      return errorResponse(404, 'State not found', headers);
    }
    
    if (stateResult.rows[0].organization_id !== authContext.organization_id) {
      return errorResponse(403, 'State does not belong to your organization', headers);
    }

    const sql = `
      SELECT 
        snapshot_id,
        state_id,
        metric_id,
        value,
        notes,
        created_at,
        updated_at
      FROM metric_snapshots
      WHERE state_id = ${formatSqlValue(stateId)}::uuid
      ORDER BY created_at DESC
    `;

    const result = await client.query(sql);
    return successResponse({ snapshots: result.rows }, headers);
  } finally {
    client.release();
  }
}

async function createSnapshot(event, stateId, authContext, headers) {
  const body = JSON.parse(event.body || '{}');
  const { metric_id, value, notes } = body;

  if (!metric_id || !value) {
    return errorResponse(400, 'metric_id and value are required', headers);
  }

  const client = await getDbClient();
  
  try {
    await client.query('BEGIN');

    // Verify state belongs to organization
    const stateCheckSql = `
      SELECT organization_id
      FROM states
      WHERE id = ${formatSqlValue(stateId)}::uuid
    `;
    
    const stateResult = await client.query(stateCheckSql);
    
    if (stateResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return errorResponse(404, 'State not found', headers);
    }
    
    if (stateResult.rows[0].organization_id !== authContext.organization_id) {
      await client.query('ROLLBACK');
      return errorResponse(403, 'State does not belong to your organization', headers);
    }

    // Verify metric belongs to organization
    const metricCheckSql = `
      SELECT organization_id, name, value_type, min_value, max_value
      FROM metrics
      WHERE metric_id = ${formatSqlValue(metric_id)}::uuid
    `;
    
    const metricResult = await client.query(metricCheckSql);
    
    if (metricResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return errorResponse(404, 'Metric not found', headers);
    }
    
    if (metricResult.rows[0].organization_id !== authContext.organization_id) {
      await client.query('ROLLBACK');
      return errorResponse(403, 'Metric does not belong to your organization', headers);
    }

    const valueError = validateMetricValue(metricResult.rows[0], value);
    if (valueError) {
      await client.query('ROLLBACK');
      return errorResponse(400, valueError, headers);
    }

    const sql = `
      INSERT INTO metric_snapshots (
        state_id,
        metric_id,
        value,
        notes
      ) VALUES (
        ${formatSqlValue(stateId)}::uuid,
        ${formatSqlValue(metric_id)}::uuid,
        ${formatSqlValue(value)},
        ${formatSqlValue(notes)}
      )
      RETURNING *
    `;
    
    const result = await client.query(sql);
    await client.query('COMMIT');

    return successResponse({ snapshot: result.rows[0] }, headers);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function updateSnapshot(event, snapshotId, authContext, headers) {
  const body = JSON.parse(event.body || '{}');
  const { value, notes } = body;

  if (!value) {
    return errorResponse(400, 'value is required', headers);
  }

  const client = await getDbClient();
  
  try {
    await client.query('BEGIN');

    // Verify snapshot belongs to organization (via state)
    const checkSql = `
      SELECT ms.snapshot_id, s.organization_id, m.name, m.value_type, m.min_value, m.max_value
      FROM metric_snapshots ms
      JOIN states s ON ms.state_id = s.id
      JOIN metrics m ON ms.metric_id = m.metric_id
      WHERE ms.snapshot_id = ${formatSqlValue(snapshotId)}::uuid
    `;
    
    const checkResult = await client.query(checkSql);
    
    if (checkResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return errorResponse(404, 'Snapshot not found', headers);
    }
    
    if (checkResult.rows[0].organization_id !== authContext.organization_id) {
      await client.query('ROLLBACK');
      return errorResponse(403, 'Snapshot does not belong to your organization', headers);
    }

    const valueError = validateMetricValue(checkResult.rows[0], value);
    if (valueError) {
      await client.query('ROLLBACK');
      return errorResponse(400, valueError, headers);
    }

    const updates = [];
    if (value !== undefined) updates.push(`value = ${formatSqlValue(value)}`);
    if (notes !== undefined) updates.push(`notes = ${formatSqlValue(notes)}`);
    updates.push('updated_at = NOW()');

    const sql = `
      UPDATE metric_snapshots
      SET ${updates.join(', ')}
      WHERE snapshot_id = ${formatSqlValue(snapshotId)}::uuid
      RETURNING *
    `;
    
    const result = await client.query(sql);
    await client.query('COMMIT');

    return successResponse({ snapshot: result.rows[0] }, headers);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function deleteSnapshot(snapshotId, authContext, headers) {
  const client = await getDbClient();
  
  try {
    // Verify snapshot belongs to organization (via state)
    const checkSql = `
      SELECT ms.snapshot_id, s.organization_id
      FROM metric_snapshots ms
      JOIN states s ON ms.state_id = s.id
      WHERE ms.snapshot_id = ${formatSqlValue(snapshotId)}::uuid
    `;
    
    const checkResult = await client.query(checkSql);
    
    if (checkResult.rows.length === 0) {
      return errorResponse(404, 'Snapshot not found', headers);
    }
    
    if (checkResult.rows[0].organization_id !== authContext.organization_id) {
      return errorResponse(403, 'Snapshot does not belong to your organization', headers);
    }

    const sql = `
      DELETE FROM metric_snapshots
      WHERE snapshot_id = ${formatSqlValue(snapshotId)}::uuid
      RETURNING snapshot_id
    `;
    
    const result = await client.query(sql);
    
    return successResponse({ message: 'Snapshot deleted', snapshot_id: snapshotId }, headers);
  } finally {
    client.release();
  }
}
