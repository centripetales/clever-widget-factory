/**
 * Lambda Authorizer for API Gateway
 * 
 * Validates Cognito JWT tokens and extracts organization context:
 * - organization_id: User's primary organization UUID
 * - organization_memberships: All direct organization memberships
 * - accessible_organization_ids: All orgs user can access (direct + partners)
 * - partner_access: Partner agency relationships
 * - permissions: System permissions based on role
 * - user_role: User's role in primary organization
 * 
 * Uses caching to reduce database calls (5 minute TTL)
 */

const { Client } = require('pg');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

// Database configuration (matches pattern from other Lambda functions)
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

// Cognito configuration
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const COGNITO_REGION = process.env.COGNITO_REGION || 'us-west-2';
const COGNITO_ISSUER = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`;

// JWKS client for token verification
const client = jwksClient({
  jwksUri: `${COGNITO_ISSUER}/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 86400000 // 24 hours
});

// In-memory cache for user organization data
const userCache = new Map();

/**
 * Get cached user data
 */
function getCachedUser(cognitoUserId) {
  const cached = userCache.get(cognitoUserId);
  if (cached && cached.expires_at > Date.now()) {
    return cached.data;
  }
  userCache.delete(cognitoUserId);
  return null;
}

/**
 * Cache user data with TTL
 */
function setCachedUser(cognitoUserId, data, ttlMinutes = 5) {
  userCache.set(cognitoUserId, {
    data,
    expires_at: Date.now() + (ttlMinutes * 60 * 1000)
  });
}

/**
 * Get signing key for JWT verification
 */
function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
      return;
    }
    const signingKey = key.publicKey || key.rsaPublicKey;
    callback(null, signingKey);
  });
}

/**
 * Verify and decode Cognito JWT token
 */
function verifyToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getKey,
      {
        audience: process.env.COGNITO_CLIENT_ID,
        issuer: COGNITO_ISSUER,
        algorithms: ['RS256']
      },
      (err, decoded) => {
        if (err) {
          reject(err);
        } else {
          resolve(decoded);
        }
      }
    );
  });
}

/**
 * Calculate user permissions based on role and system grants
 */
function calculatePermissions(userRole, organizationMemberships) {
  const permissions = [];
  
  // Role-based permissions
  switch (userRole) {
    case 'admin':
      permissions.push(
        'organizations:read',
        'organizations:update',
        'members:manage',
        'data:read',
        'data:read:all',
        'data:write',
        'data:write:all'
      );
      break;
    case 'leadership':
      permissions.push(
        'organizations:read',
        'data:read',
        'data:read:org',
        'data:write',
        'data:write:org'
      );
      break;
    case 'contributor':
      permissions.push(
        'data:read',
        'data:write'
      );
      break;
    case 'viewer':
      permissions.push('data:read');
      break;
    default:
      permissions.push('data:read'); // Default read-only
  }
  
  // Check if user is admin in multiple orgs (could grant cross-org permissions)
  const adminOrgs = organizationMemberships.filter(m => m.role === 'admin');
  if (adminOrgs.length > 1) {
    permissions.push('organizations:read:multiple');
  }
  
  return permissions;
}

/**
 * Get user organization data from database
 * Includes primary organization and partner organization access
 */
async function getUserOrganizationData(cognitoUserId) {
  const dbClient = new Client(dbConfig);
  
  try {
    await dbClient.connect();
    
    // First, check ALL memberships (active and inactive) for debugging
    const allMembershipsQuery = `
      SELECT 
        organization_id,
        role,
        is_active,
        created_at
      FROM organization_members
      WHERE cognito_user_id = $1
      ORDER BY created_at ASC;
    `;
    const allMembershipsResult = await dbClient.query(allMembershipsQuery, [cognitoUserId]);
    
    console.log('🔍 [AUTHORIZER] ALL memberships (active + inactive) for user:', {
      cognito_user_id: cognitoUserId,
      total_memberships: allMembershipsResult.rows.length,
      memberships: allMembershipsResult.rows.map(m => ({
        organization_id: m.organization_id,
        role: m.role,
        is_active: m.is_active,
        created_at: m.created_at
      }))
    });
    
    // Get ALL organization memberships (user can belong to multiple orgs)
    // Only include ACTIVE memberships for authorization
    const membershipsQuery = `
      SELECT 
        organization_id,
        role
      FROM organization_members
      WHERE cognito_user_id = $1
        AND is_active = true
      ORDER BY created_at ASC;
    `;
    
    console.log('🔍 [AUTHORIZER] Querying ACTIVE organization memberships for:', cognitoUserId);
    const membershipsResult = await dbClient.query(membershipsQuery, [cognitoUserId]);
    
    console.log('🔍 [AUTHORIZER] ACTIVE memberships query result:', {
      cognito_user_id: cognitoUserId,
      rows_found: membershipsResult.rows.length,
      memberships: membershipsResult.rows
    });
    
    if (membershipsResult.rows.length === 0) {
      console.error('❌ ERROR: No active organization memberships found for user:', cognitoUserId);
      console.error('   This user will not be able to access any data!');
      return null;
    }
    
    // Primary organization is the first one (oldest membership)
    const primary = membershipsResult.rows[0];
    const primaryOrgId = primary.organization_id;
    
    console.log('🔍 [AUTHORIZER] Selected PRIMARY organization:', {
      primary_org_id: primaryOrgId,
      primary_role: primary.role,
      note: 'This is the oldest active membership and will be used as the default organization_id'
    });
    
    // All direct organization memberships (user is a direct member of these orgs)
    const directMemberships = membershipsResult.rows.map(row => ({
      organization_id: row.organization_id,
      role: row.role
    }));
    
    // Build accessible org IDs from direct memberships
    const directOrgIds = directMemberships.map(m => m.organization_id);
    
    console.log('🔍 [AUTHORIZER] Building accessible organization IDs:', {
      cognito_user_id: cognitoUserId,
      direct_memberships: directMemberships,
      direct_org_ids: directOrgIds,
      direct_org_ids_count: directOrgIds.length,
      primary_org_id: primaryOrgId
    });
    
    // Validate that we have at least one organization membership
    if (directOrgIds.length === 0) {
      console.error('❌ ERROR: No organization memberships found for user:', cognitoUserId);
      console.error('   This user has no active memberships in organization_members table.');
      console.error('   User will not be able to access any data.');
      throw new Error(`No organization memberships found for user ${cognitoUserId}. User must be added to at least one organization.`);
    }
    
    // Try to get partner organization memberships (gracefully handle if tables don't exist yet)
    let partnerAccess = [];
    let accessibleOrgIds = [...directOrgIds]; // Start with all direct memberships
    
    try {
      const partnerQuery = `
        SELECT 
          po.id as partner_organization_id,
          po.organization_a_id,
          po.organization_b_id,
          pm.role as partner_role,
          CASE 
            WHEN po.organization_a_id = $2 THEN po.organization_b_id
            ELSE po.organization_a_id
          END as accessible_organization_id
        FROM partner_members pm
        JOIN partner_organizations po ON pm.partner_organization_id = po.id
        WHERE pm.cognito_user_id = $1
          AND pm.is_active = true
          AND po.status = 'active'
          AND (
            po.organization_a_id = $2 OR 
            po.organization_b_id = $2
          );
      `;
      
      const partnerResult = await dbClient.query(partnerQuery, [
        cognitoUserId,
        primaryOrgId
      ]);
      
      partnerAccess = partnerResult.rows.map(row => ({
        partner_organization_id: row.partner_organization_id,
        role: row.partner_role,
        organization_id: row.accessible_organization_id
      }));
      
      // Add partner orgs to accessible list (avoid duplicates)
      const partnerOrgIds = partnerAccess.map(p => p.organization_id);
      accessibleOrgIds = [
        ...new Set([...directOrgIds, ...partnerOrgIds]) // Remove duplicates
      ];
    } catch (error) {
      // Partner tables don't exist yet - that's okay, continue with primary org only
      console.log('Partner tables not available yet, using primary organization only');
    }
    
    // Calculate permissions based on role and memberships
    // Removed superadmin concept - access is now based on permissions like 'data:read:all'
    const permissions = calculatePermissions(primary.role || 'member', directMemberships);
    
    // Grant data:read:all if user is admin in multiple organizations (Stefan's case)
    // This replaces the old superadmin concept
    if (directMemberships.length > 1 && directMemberships.every(m => m.role === 'admin')) {
      permissions.push('data:read:all');
      console.log('Granting data:read:all permission - user is admin in multiple organizations');
    }
    
    // Final validation: ensure accessibleOrgIds is not empty (should never happen if directOrgIds check passed)
    if (accessibleOrgIds.length === 0) {
      console.error('❌ CRITICAL ERROR: accessibleOrgIds is empty after building!');
      console.error('   This should never happen if directOrgIds validation passed.');
      console.error('   cognito_user_id:', cognitoUserId);
      console.error('   primary_org_id:', primaryOrgId);
      console.error('   direct_memberships:', directMemberships);
      throw new Error(`Failed to build accessible_organization_ids for user ${cognitoUserId}. This is a system error.`);
    }
    
    // Log for debugging
    console.log('🔍 [AUTHORIZER] Final user organization data being returned:', {
      cognito_user_id: cognitoUserId,
      primary_org_id: primaryOrgId,
      primary_role: primary.role,
      direct_memberships: directMemberships,
      direct_memberships_count: directMemberships.length,
      accessible_org_ids: accessibleOrgIds,
      accessible_org_ids_count: accessibleOrgIds.length,
      permissions: permissions,
      has_data_read_all: permissions.includes('data:read:all'),
      note: 'This data will be available in authContext in Lambda functions'
    });
    
    return {
      organization_id: primaryOrgId, // Primary org (first membership)
      organization_memberships: directMemberships, // All direct memberships with roles
      accessible_organization_ids: accessibleOrgIds, // All accessible orgs (direct + partners)
      partner_access: partnerAccess, // Partner relationships
      role: primary.role || 'member', // Role in primary org
      permissions: permissions // Calculated permissions
    };
  } finally {
    await dbClient.end();
  }
}

/**
 * Generate IAM policy for API Gateway
 */
function generatePolicy(principalId, effect, resource, context) {
  const policy = {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: resource
        }
      ]
    },
    context: context || {}
  };
  
  return policy;
}

/**
 * The context the API's Lambdas read (see the cwf-common-nodejs layer's
 * getAuthorizerContext), for a signed-in Cognito user.
 */
async function getContext(cognitoUserId) {
  // Check cache first
  let userData = getCachedUser(cognitoUserId);
  
  if (!userData) {
    // Fetch from database
    userData = await getUserOrganizationData(cognitoUserId);
    
    if (!userData) {
      throw new Error('Forbidden: User not found in any organization');
    }
    
    // Cache the result
    setCachedUser(cognitoUserId, userData, 5);
  }
  
  // Include all organization memberships and partner access for multi-tenant data filtering
  // Validate that accessible_organization_ids is present and not empty
  if (!userData.accessible_organization_ids || userData.accessible_organization_ids.length === 0) {
    console.error('❌ ERROR: accessible_organization_ids is missing or empty in userData!');
    console.error('   cognito_user_id:', cognitoUserId);
    console.error('   userData:', JSON.stringify(userData, null, 2));
    throw new Error(`User ${cognitoUserId} has no accessible organizations. User must be added to at least one organization.`);
  }
  
  const accessibleOrgIds = userData.accessible_organization_ids;
  
  const context = {
    organization_id: userData.organization_id,
    organization_memberships: JSON.stringify(userData.organization_memberships || []),
    accessible_organization_ids: JSON.stringify(accessibleOrgIds),
    partner_access: JSON.stringify(userData.partner_access || []),
    cognito_user_id: cognitoUserId,
    user_role: userData.role,
    permissions: JSON.stringify(userData.permissions || [])
  };
  
  console.log('Authorizer context being set:', {
    cognito_user_id: cognitoUserId,
    organization_id: userData.organization_id,
    accessible_organization_ids: accessibleOrgIds,
    accessible_orgs_count: accessibleOrgIds.length,
    accessible_orgs_json: JSON.stringify(accessibleOrgIds),
    permissions: userData.permissions,
    has_data_read_all: userData.permissions?.includes('data:read:all') || false
  });
  return context;
}

/**
 * Main authorizer handler
 */
exports.handler = async (event) => {
  // Direct invocation by the Claude connector (cwf-mcp-server), which has
  // already verified the person's own token: the same context, so their
  // writes through the app's Lambdas are allowed exactly what the app allows.
  // Only callers with IAM invoke rights get here; API Gateway always sends a
  // token.
  if (event.contextFor && !event.authorizationToken) {
    return getContext(event.contextFor);
  }

  console.log('Authorizer event:', JSON.stringify(event, null, 2));
  
  try {
    // Extract token from Authorization header
    const token = event.authorizationToken;
    
    if (!token) {
      throw new Error('Unauthorized: No token provided');
    }
    
    // Remove 'Bearer ' prefix if present
    const cleanToken = token.replace(/^Bearer /, '');
    
    // Verify and decode token
    let decoded;
    try {
      decoded = await verifyToken(cleanToken);
    } catch (error) {
      console.error('Token verification failed:', error);
      throw new Error('Unauthorized: Invalid token');
    }
    
    const cognitoUserId = decoded.sub;
    const context = await getContext(cognitoUserId);

    // Allow access to all API Gateway resources
    const resource = event.methodArn.split('/').slice(0, 2).join('/') + '/*/*';
    
    const policy = generatePolicy(cognitoUserId, 'Allow', resource, context);
    
    console.log('Generated policy:', JSON.stringify(policy, null, 2));
    
    return policy;
    
  } catch (error) {
    console.error('Authorizer error:', error);
    
    // Return deny policy
    const resource = event.methodArn.split('/').slice(0, 2).join('/') + '/*/*';
    return generatePolicy('user', 'Deny', resource);
  }
};

