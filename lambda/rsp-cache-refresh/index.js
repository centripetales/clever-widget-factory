const { Client } = require('pg');

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || 'cwf-dev-postgres.ctmma86ykgeb.us-west-2.rds.amazonaws.com',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
};

// Standard learning decay model: subsequent iterations are faster
function applyLearningDecay(baseHours, encounterIteration) {
  // Simple exponential decay bounded at 10% of base time
  const minFloor = baseHours * 0.1;
  const decayed = baseHours * Math.exp(-0.2 * (encounterIteration - 1));
  return Math.max(decayed, minFloor);
}

exports.handler = async (event) => {
  const client = new Client(dbConfig);
  try {
    await client.connect();

    // 1. Identify all active assets (tools/parts) bound to an open or compounding entropy gap
    // This query finds the latest ENTROPY stratum for a given asset
    const activeAssetsSql = `
      SELECT DISTINCT 
        sl.entity_type as asset_type, 
        sl.entity_id as asset_id,
        CASE WHEN sl.entity_type = 'tool' THEN t.target_population_scale ELSE p.target_population_scale END as population_scale
      FROM state_links sl
      JOIN state_strata ss ON sl.state_id = ss.state_id
      LEFT JOIN tools t ON sl.entity_type = 'tool' AND sl.entity_id = t.id
      LEFT JOIN parts p ON sl.entity_type = 'part' AND sl.entity_id = p.id
      WHERE sl.entity_type IN ('tool', 'part')
        AND ss.stratum_type = 'ENTROPY'
    `;
    const assets = (await client.query(activeAssetsSql)).rows;

    let updatedCount = 0;

    for (const asset of assets) {
      if (!asset.population_scale) continue;

      // 2. Fetch the latest entropy stratum for this asset
      const latestEntropySql = `
        SELECT ss.id, ss.payload, ss.created_at
        FROM state_strata ss
        JOIN state_links sl ON ss.state_id = sl.state_id
        WHERE sl.entity_type = $1 AND sl.entity_id = $2 AND ss.stratum_type = 'ENTROPY'
        ORDER BY ss.created_at DESC
        LIMIT 1
      `;
      const entropyResult = await client.query(latestEntropySql, [asset.asset_type, asset.asset_id]);
      
      if (entropyResult.rows.length === 0) continue;
      const stratum = entropyResult.rows[0];
      const payload = typeof stratum.payload === 'string' ? JSON.parse(stratum.payload) : stratum.payload;

      const h_e_raw = parseFloat(payload.estimated_hours_consumed) || 0;
      const status = payload.status || 'OPEN';
      const delta = payload.entropy_delta || 0;

      // 3. Macro-estimation parameters
      // Calculate how many times this issue has been encountered globally (mock replication factor)
      // We look at number of linked states as a proxy for encounters
      const encountersSql = `
        SELECT COUNT(ss.id) as count
        FROM state_strata ss
        JOIN state_links sl ON ss.state_id = sl.state_id
        WHERE sl.entity_type = $1 AND sl.entity_id = $2 AND ss.stratum_type = 'ENTROPY'
      `;
      const encountersRes = await client.query(encountersSql, [asset.asset_type, asset.asset_id]);
      const encounterIteration = parseInt(encountersRes.rows[0].count, 10);

      const decayedAvgHours = applyLearningDecay(h_e_raw, encounterIteration);
      
      // Calculate C_friction (reporting discount coefficient)
      // Hypothetical: 15% of the population encounters the friction wall
      const C_friction = 0.15; 
      
      const H_ext = decayedAvgHours * asset.population_scale * C_friction;

      // 4. Upsert into telemetry_dashboard_cache
      const upsertSql = `
        INSERT INTO telemetry_dashboard_cache (
          asset_type, asset_id, entropy_stratum_id, h_e_raw, c_friction, h_ext, 
          decay_curve_applied, population_scale_at_calc, entropy_status, entropy_delta_pct,
          calculated_at, cache_version
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), 1
        )
        ON CONFLICT (asset_type, asset_id) 
        DO UPDATE SET 
          entropy_stratum_id = EXCLUDED.entropy_stratum_id,
          h_e_raw = EXCLUDED.h_e_raw,
          c_friction = EXCLUDED.c_friction,
          h_ext = EXCLUDED.h_ext,
          decay_curve_applied = EXCLUDED.decay_curve_applied,
          population_scale_at_calc = EXCLUDED.population_scale_at_calc,
          entropy_status = EXCLUDED.entropy_status,
          entropy_delta_pct = EXCLUDED.entropy_delta_pct,
          calculated_at = NOW(),
          cache_version = telemetry_dashboard_cache.cache_version + 1
      `;
      
      await client.query(upsertSql, [
        asset.asset_type,
        asset.asset_id,
        stratum.id,
        h_e_raw,
        C_friction,
        H_ext,
        'standard_exponential_0.2',
        asset.population_scale,
        status,
        delta
      ]);

      updatedCount++;
    }

    return { statusCode: 200, body: JSON.stringify({ refreshed_assets: updatedCount }) };
  } catch (error) {
    console.error('RSP Cache Refresh Worker error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  } finally {
    await client.end();
  }
};
