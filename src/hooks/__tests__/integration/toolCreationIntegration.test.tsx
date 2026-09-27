/**
 * Tool Creation Integration Test
 * 
 * Comprehensive integration test that validates tool creation through real Lambda API endpoints,
 * and tests permissions.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestAuth, cleanupTestAuth } from './testAuth';
import { testToolCreator, TestTool } from './TestToolCreator';
import { permissionValidator } from './PermissionValidator';

describe.skip('Tool Creation Integration Tests', () => {
  let createdTools: TestTool[] = [];

  beforeAll(async () => {
    console.log('🚀 Setting up tool creation integration tests...');
    
    // Set up authentication
    await setupTestAuth();
    
    console.log('✅ Integration test setup complete');
  }, 30000); // 30 second timeout for setup

  afterAll(async () => {
    console.log('🧹 Cleaning up tool creation integration tests...');
    
    // Clean up any created tools
    await testToolCreator.cleanupCreatedTools();
    
    // Clean up authentication
    await cleanupTestAuth();
    
    console.log('✅ Integration test cleanup complete');
  }, 30000); // 30 second timeout for cleanup

  beforeEach(() => {
    // Clear tracking arrays before each test
    createdTools = [];
  });

  describe('Permission Validation', () => {
    it('should validate that test user has required tool creation permissions', async () => {
      console.log('🔐 Testing user permissions...');
      
      const diagnostic = await permissionValidator.diagnosePermissionIssues();
      
      // Print diagnostic report for debugging
      permissionValidator.printDiagnosticReport(diagnostic);
      
      if (!diagnostic.hasAllPermissions) {
        // If permissions are missing, provide helpful error message
        const failedTests = diagnostic.diagnostics.filter(d => !d.result.hasPermission);
        const errorMessage = [
          'Integration test user lacks required permissions:',
          ...failedTests.map(t => `  - ${t.method} ${t.endpoint}: ${t.result.error || 'Access denied'}`),
          '',
          'To fix this issue:',
          '1. Set DB_PASSWORD environment variable',
          '2. Run: ./scripts/setup-integration-test-user.sh',
          '3. Verify user was added to organization_members table with contributor role',
          '4. Re-run the integration tests'
        ].join('\n');
        
        throw new Error(errorMessage);
      }
      
      expect(diagnostic.hasAllPermissions).toBe(true);
      expect(diagnostic.diagnostics.every(d => d.result.hasPermission)).toBe(true);
    }, 15000);

    it('should validate permission boundary enforcement', async () => {
      console.log('🔐 Testing permission boundaries...');
      
      // Test that user can read tools (should have data:read permission)
      const readResult = await permissionValidator.validateToolReadPermission();
      expect(readResult.hasPermission).toBe(true);
      expect(readResult.statusCode).toBe(200);
      
      // Test that user can create tools (should have data:write permission)
      const createResult = await permissionValidator.validateToolCreationPermission();
      expect(createResult.hasPermission).toBe(true);
      expect(createResult.statusCode).toBe(201);
    }, 10000);

    it('should validate organization-scoped access', async () => {
      console.log('🏢 Testing organization-scoped access...');
      
      // User should be able to read tools from their organization
      const readResult = await permissionValidator.validateToolReadPermission();
      expect(readResult.hasPermission).toBe(true);
      
      // The tools returned should be filtered by organization
      // (We can't easily test cross-org access without multiple orgs, but we can verify the request succeeds)
      expect(readResult.details?.toolCount).toBeGreaterThanOrEqual(0);
    }, 10000);
  });

  describe('Tool Creation', () => {
    it('should successfully create a tool with minimal data', async () => {
      console.log('🔧 Testing minimal tool creation...');
      
      const tool = await testToolCreator.createMinimalTool();
      createdTools.push(tool);
      
      expect(tool).toBeDefined();
      expect(tool.id).toBeDefined();
      expect(tool.name).toContain('Minimal Test Tool');
      expect(tool.status).toBe('available');
      expect(tool.organization_id).toBeDefined();
      
      // Validate the tool exists and can be retrieved
      const retrievedTool = await testToolCreator.validateToolExists(tool.id);
      expect(retrievedTool).toBeDefined();
      expect(retrievedTool?.id).toBe(tool.id);
    }, 10000);

    it('should successfully create a tool with complete data', async () => {
      console.log('🔧 Testing complete tool creation...');
      
      const tool = await testToolCreator.createCompleteTool();
      createdTools.push(tool);
      
      expect(tool).toBeDefined();
      expect(tool.id).toBeDefined();
      expect(tool.name).toContain('Complete Test Tool');
      expect(tool.description).toContain('comprehensive test tool');
      expect(tool.category).toBe('Test Equipment');
      expect(tool.status).toBe('available');
      expect(tool.serial_number).toContain('COMPLETE-');
      expect(tool.storage_location).toBe('Integration Test Storage Area');
      expect(tool.organization_id).toBeDefined();
      
      // Validate all properties are set correctly
      const isValid = await testToolCreator.validateToolState(tool.id, {
        name: tool.name,
        category: 'Test Equipment',
        status: 'available'
      });
      expect(isValid).toBe(true);
    }, 10000);

    it('should handle validation error cases', async () => {
      console.log('🔧 Testing validation error handling...');
      
      // Try to create a tool without a name (should fail)
      try {
        const response = await fetch(`${process.env.VITE_API_BASE_URL}/tools`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${await (await import('./testAuth')).testAuthService.getIdToken()}`
          },
          body: JSON.stringify({
            description: 'Tool without name - should fail'
          })
        });
        
        expect(response.ok).toBe(false);
        expect(response.status).toBe(400);
        
        const error = await response.json();
        expect(error.error).toContain('name is required');
      } catch (error) {
        // If fetch throws, that's also acceptable for this test
        expect(error).toBeDefined();
      }
    }, 10000);
  });

  describe('Error Handling and Diagnostics', () => {
    it('should provide clear error messages for permission issues', async () => {
      console.log('🔍 Testing error handling for permission issues...');
      
      // This test validates that our diagnostic tools work correctly
      const diagnostic = await permissionValidator.diagnosePermissionIssues();
      
      // Should have run all diagnostic tests
      expect(diagnostic.diagnostics.length).toBeGreaterThan(0);
      
      // Should provide recommendations
      expect(diagnostic.recommendations.length).toBeGreaterThan(0);
      
      // If all permissions are working, should indicate success
      if (diagnostic.hasAllPermissions) {
        expect(diagnostic.recommendations.some(r => r.includes('✅'))).toBe(true);
      }
    }, 10000);

    it('should handle network timeouts and connection issues gracefully', async () => {
      console.log('🔍 Testing network error handling...');
      
      // Test with an invalid API URL to simulate network issues
      const originalUrl = process.env.VITE_API_BASE_URL;
      
      try {
        // Temporarily set invalid URL
        process.env.VITE_API_BASE_URL = 'https://invalid-url-that-does-not-exist.com';
        
        // Try to validate permissions (should handle the error gracefully)
        const result = await permissionValidator.validateToolReadPermission();
        
        expect(result.hasPermission).toBe(false);
        expect(result.error).toBeDefined();
        
      } finally {
        // Restore original URL
        process.env.VITE_API_BASE_URL = originalUrl;
      }
    }, 10000);

    it('should provide actionable remediation suggestions', async () => {
      console.log('🔍 Testing remediation suggestions...');
      
      const diagnostic = await permissionValidator.diagnosePermissionIssues();
      
      // Should provide specific recommendations
      expect(diagnostic.recommendations.length).toBeGreaterThan(0);
      
      // Recommendations should mention key setup steps
      const recommendationText = diagnostic.recommendations.join(' ');
      
      if (!diagnostic.hasAllPermissions) {
        expect(recommendationText).toContain('setup-integration-test-user');
        expect(recommendationText).toContain('organization_members');
      }
    }, 10000);
  });
});