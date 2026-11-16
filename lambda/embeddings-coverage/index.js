const { query } = require('@cwf/db');
const { getAuthorizerContext } = require('@cwf/authorizerContext');
const { success, error, corsResponse } = require('@cwf/response');

/**
 * Embeddings Coverage Lambda
 * 
 * Provides statistics on embedding coverage across entity types.
 * Reports total embeddings, counts by entity_type and model_version,
 * and coverage percentages (embeddings vs total entities).
 * 
 * Requirements: 7.7, 10.6, 10.7, 11.3
 */

exports.handler = async (event) => {
  console.log('Embeddings coverage handler');
  
  const { httpMethod } = event;
  
  if (httpMethod === 'OPTIONS') {
    return corsResponse();
  }
  
  if (httpMethod !== 'GET') {
    return error('Method not allowed', 405);
  }
  
  try {
    // Get organization context from authorizer
    const authContext = getAuthorizerContext(event);
    const organizationId = authContext.organization_id;
    
    if (!organizationId) {
      console.error('Missing organization_id from authorizer context');
      return error('Unauthorized', 401);
    }
    
    console.log(`Fetching embedding coverage for organization: ${organizationId}`);
    
    // Escape organization_id to prevent SQL injection
    const escapedOrgId = organizationId.replace(/'/g, "''");
    
    // Query 1: Get embedding counts by entity_type and model_version
    const countsSql = `
      SELECT 
        entity_type,
        model_version,
        COUNT(*) as count
      FROM unified_embeddings
      WHERE organization_id = '${escapedOrgId}'
      GROUP BY entity_type, model_version
      ORDER BY entity_type, model_version
    `;
    
    console.log('Querying embedding counts by entity_type and model_version');
    const counts = await query(countsSql);
    console.log(`Found ${counts.length} entity_type/model_version combinations`);
    
    // Query 2: Get total entity counts from source tables
    const totalsSql = `
      SELECT 
        'part' as entity_type, COUNT(*) as total FROM parts WHERE organization_id = '${escapedOrgId}'
      UNION ALL
      SELECT 'tool', COUNT(*) FROM tools WHERE organization_id = '${escapedOrgId}'
      UNION ALL
      SELECT 'action', COUNT(*) FROM actions a WHERE a.organization_id = '${escapedOrgId}' AND NOT EXISTS (SELECT 1 FROM financial_records fr WHERE fr.action_id = a.id)
      UNION ALL
      SELECT 'issue', COUNT(*) FROM issues WHERE organization_id = '${escapedOrgId}'
      UNION ALL
      SELECT 'policy', COUNT(*) FROM policy WHERE organization_id = '${escapedOrgId}'
      UNION ALL
      SELECT 'financial_record', COUNT(*) FROM financial_records WHERE organization_id = '${escapedOrgId}'
    `;
    
    console.log('Querying total entity counts from source tables');
    const totals = await query(totalsSql);
    console.log(`Retrieved totals for ${totals.length} entity types`);
    
    // Calculate coverage percentages
    // For each entity type, find the embedding count and calculate percentage
    const coverage = totals.map(t => {
      // Sum all embeddings for this entity_type across all model_versions
      const embeddingCount = counts
        .filter(c => c.entity_type === t.entity_type)
        .reduce((sum, c) => sum + parseInt(c.count), 0);
      
      const totalEntities = parseInt(t.total);
      const coveragePercentage = totalEntities > 0 
        ? ((embeddingCount / totalEntities) * 100).toFixed(2) 
        : '0.00';
      
      return {
        entity_type: t.entity_type,
        total_entities: totalEntities,
        embeddings_count: embeddingCount,
        coverage_percentage: parseFloat(coveragePercentage)
      };
    });
    
    // Calculate total embeddings across all entity types
    const totalEmbeddings = counts.reduce((sum, c) => sum + parseInt(c.count), 0);
    
    console.log(`Total embeddings: ${totalEmbeddings}`);
    console.log('Coverage summary:', coverage);
    
    // Return formatted response
    return success({ 
      counts: counts.map(c => ({
        entity_type: c.entity_type,
        model_version: c.model_version,
        count: parseInt(c.count)
      })),
      coverage,
      total_embeddings: totalEmbeddings
    });
    
  } catch (err) {
    console.error('Embeddings coverage error:', err);
    
    // Provide more specific error messages for common issues
    if (err.message.includes('relation') && err.message.includes('does not exist')) {
      return error('Embeddings table not found. Please ensure unified_embeddings table is created.', 500);
    }
    
    return error(err.message, 500);
  }
};
