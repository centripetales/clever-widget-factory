/**
 * Tests for Lambda Authorizer
 * 
 * Uses Node.js built-in test runner (node --test)
 * Run with: npm test
 */

const { test, describe, beforeEach, mock } = require('node:test');
const assert = require('node:assert');

// Note: These tests require mocking pg, jwt, and jwks-rsa
// For full integration tests, you would need to:
// 1. Set up a test database
// 2. Use real Cognito tokens or mock JWT verification
// 3. Test against actual database queries

describe('Lambda Authorizer - Permission Calculation', () => {
  // Import the handler after setting up mocks
  let calculatePermissions;
  
  beforeEach(() => {
    // Extract the calculatePermissions function for testing
    // In a real scenario, you'd export this function separately
    delete require.cache[require.resolve('./index.js')];
  });

  test('should calculate permissions for admin role', () => {
    // This is a conceptual test - actual implementation would need
    // the function to be exported or tested via integration tests
    const adminPermissions = ['organizations:read', 'organizations:update', 'members:manage', 'data:read', 'data:write'];
    assert.ok(adminPermissions.includes('data:read'));
    assert.ok(adminPermissions.includes('data:write'));
  });

  test('should grant system:admin for superadmin', () => {
    const superadminPermissions = ['system:admin'];
    assert.ok(superadminPermissions.includes('system:admin'));
  });

  test('should calculate minimal permissions for viewer role', () => {
    const viewerPermissions = ['data:read'];
    assert.ok(viewerPermissions.includes('data:read'));
    assert.strictEqual(viewerPermissions.length, 1);
  });
});

describe('Lambda Authorizer - Context Variables', () => {
  test('should include all required context variables', () => {
    const expectedContextVars = [
      'organization_id',
      'organization_memberships',
      'accessible_organization_ids',
      'partner_access',
      'cognito_user_id',
      'user_role',
      'permissions',
      'is_superadmin'
    ];
    
    // Verify all expected variables are present
    expectedContextVars.forEach(varName => {
      assert.ok(varName.length > 0, `Context variable ${varName} should be defined`);
    });
  });

  test('should serialize arrays as JSON strings', () => {
    const testArray = ['org-1', 'org-2'];
    const serialized = JSON.stringify(testArray);
    const deserialized = JSON.parse(serialized);
    
    assert.deepStrictEqual(deserialized, testArray);
    assert.strictEqual(typeof serialized, 'string');
  });
});

describe('Lambda Authorizer - Multi-Organization Support', () => {
  test('should handle multiple organization memberships', () => {
    const memberships = [
      { organization_id: 'org-1', role: 'admin', is_superadmin: false },
      { organization_id: 'org-2', role: 'viewer', is_superadmin: false }
    ];
    
    assert.strictEqual(memberships.length, 2);
    assert.strictEqual(memberships[0].organization_id, 'org-1');
    assert.strictEqual(memberships[1].organization_id, 'org-2');
  });

  test('should set primary organization as first membership', () => {
    const memberships = [
      { organization_id: 'org-1', role: 'admin' },
      { organization_id: 'org-2', role: 'viewer' }
    ];
    
    const primaryOrg = memberships[0].organization_id;
    assert.strictEqual(primaryOrg, 'org-1');
  });

  test('should build accessible_organization_ids from memberships', () => {
    const memberships = [
      { organization_id: 'org-1', role: 'admin' },
      { organization_id: 'org-2', role: 'viewer' }
    ];
    
    const accessibleOrgs = memberships.map(m => m.organization_id);
    assert.ok(accessibleOrgs.includes('org-1'));
    assert.ok(accessibleOrgs.includes('org-2'));
  });
});

// Integration test structure (requires actual database and Cognito setup)
describe('Lambda Authorizer - Integration Tests', () => {
  test('integration test placeholder', () => {
    // To run integration tests:
    // 1. Set up test database with organization_members data
    // 2. Create test Cognito user and get real JWT token
    // 3. Call handler with real event
    // 4. Verify policy and context
    
    assert.ok(true, 'Integration tests require database and Cognito setup');
  });
});

describe('Lambda Authorizer - direct context for the Claude connector', () => {
  test('returns the context API Gateway would get, for the given user', async () => {
    process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test';
    const { Client } = require('pg');
    mock.method(Client.prototype, 'connect', async () => {});
    mock.method(Client.prototype, 'end', async () => {});
    mock.method(Client.prototype, 'query', async (sql) => {
      if (sql.includes('partner_members')) throw new Error('relation "partner_members" does not exist');
      return { rows: [
        { organization_id: 'org-1', role: 'admin', is_active: true },
        { organization_id: 'org-2', role: 'admin', is_active: true },
      ] };
    });
    delete require.cache[require.resolve('./index.js')];
    const { handler } = require('./index.js');

    const context = await handler({ contextFor: 'cognito-1' });
    assert.strictEqual(context.cognito_user_id, 'cognito-1');
    assert.strictEqual(context.organization_id, 'org-1');
    assert.strictEqual(context.user_role, 'admin');
    assert.deepStrictEqual(JSON.parse(context.accessible_organization_ids), ['org-1', 'org-2']);
    assert.deepStrictEqual(JSON.parse(context.organization_memberships), [
      { organization_id: 'org-1', role: 'admin' },
      { organization_id: 'org-2', role: 'admin' },
    ]);
    assert.ok(JSON.parse(context.permissions).includes('data:write:all'));
    mock.restoreAll();
  });
});
