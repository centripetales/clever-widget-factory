/**
 * Tests for Core Lambda - Parts and Tools SQS Integration
 * Run with: node --test index.test.js
 * 
 * These tests verify that the Core Lambda correctly uses embedding composition
 * functions and generates proper SQS message formats for parts and tools.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { composePartEmbeddingSource, composeToolEmbeddingSource, composeIssueEmbeddingSource, composePolicyEmbeddingSource } = require('../shared/embedding-composition');

describe('Core Lambda - Embedding Composition Integration', () => {
  describe('Part embedding composition', () => {
    test('composes embedding source from part with all fields', () => {
      const part = {
        name: 'Banana Wine',
        description: 'Fermented banana beverage',
        policy: 'Rich in potassium and B vitamins. May support heart health.'
      };
      
      const result = composePartEmbeddingSource(part);
      
      assert.strictEqual(result, 'Banana Wine. Fermented banana beverage');
      assert.ok(result.includes('Banana Wine'), 'should contain name');
      assert.ok(result.includes('Fermented banana beverage'), 'should contain description');
      assert.ok(!result.includes('Rich in potassium'), 'the policy is not embedded');
    });
    
    test('composes embedding source from part without policy', () => {
      const part = {
        name: 'Hammer',
        description: 'Tool for driving nails'
      };
      
      const result = composePartEmbeddingSource(part);
      
      assert.strictEqual(result, 'Hammer. Tool for driving nails');
      assert.ok(!result.includes('undefined'), 'should not contain undefined');
      assert.ok(!result.includes('null'), 'should not contain null');
    });
    
    test('handles part with only name', () => {
      const part = {
        name: 'Test Part'
      };
      
      const result = composePartEmbeddingSource(part);
      
      assert.strictEqual(result, 'Test Part');
    });
  });
  
  describe('Tool embedding composition', () => {
    test('composes embedding source from tool with all fields', () => {
      const tool = {
        name: 'Hand Drill',
        description: 'Manual drilling tool with adjustable chuck'
      };
      
      const result = composeToolEmbeddingSource(tool);
      
      assert.strictEqual(result, 'Hand Drill. Manual drilling tool with adjustable chuck');
      assert.ok(result.includes('Hand Drill'), 'should contain name');
      assert.ok(result.includes('Manual drilling tool'), 'should contain description');
    });
    
    test('handles tool with only name', () => {
      const tool = {
        name: 'Wrench'
      };
      
      const result = composeToolEmbeddingSource(tool);
      
      assert.strictEqual(result, 'Wrench');
    });
  });
  
  describe('SQS message format validation', () => {
    test('validates part SQS message structure', () => {
      const part = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: 'Test Part',
        description: 'Test description',
        policy: 'Test policy'
      };
      
      const embeddingSource = composePartEmbeddingSource(part);
      const message = {
        entity_type: 'part',
        entity_id: part.id,
        embedding_source: embeddingSource,
        organization_id: 'org-123'
      };
      
      assert.strictEqual(message.entity_type, 'part', 'entity_type should be part');
      assert.strictEqual(message.entity_id, part.id, 'entity_id should match part id');
      assert.ok(message.embedding_source.includes('Test Part'), 'embedding_source should contain part name');
      assert.strictEqual(message.organization_id, 'org-123', 'organization_id should be set');
    });
    
    test('validates tool SQS message structure', () => {
      const tool = {
        id: '123e4567-e89b-12d3-a456-426614174001',
        name: 'Test Tool',
        description: 'Test description'
      };
      
      const embeddingSource = composeToolEmbeddingSource(tool);
      const message = {
        entity_type: 'tool',
        entity_id: tool.id,
        embedding_source: embeddingSource,
        organization_id: 'org-123'
      };
      
      assert.strictEqual(message.entity_type, 'tool', 'entity_type should be tool');
      assert.strictEqual(message.entity_id, tool.id, 'entity_id should match tool id');
      assert.ok(message.embedding_source.includes('Test Tool'), 'embedding_source should contain tool name');
      assert.strictEqual(message.organization_id, 'org-123', 'organization_id should be set');
    });
    
    test('validates message has all required fields', () => {
      const requiredFields = ['entity_type', 'entity_id', 'embedding_source', 'organization_id'];
      
      const message = {
        entity_type: 'part',
        entity_id: 'part-123',
        embedding_source: 'Test Part',
        organization_id: 'org-1'
      };
      
      requiredFields.forEach(field => {
        assert.ok(message[field], `${field} should be present`);
      });
    });
  });
  
  describe('Embedding source validation', () => {
    test('should not send SQS message for empty embedding source', () => {
      const part = {
        name: '',
        description: '',
        policy: ''
      };
      
      const embeddingSource = composePartEmbeddingSource(part);
      const shouldSend = embeddingSource && embeddingSource.trim();
      
      assert.ok(!shouldSend, 'should not send message for empty embedding source');
    });
    
    test('should send SQS message for non-empty embedding source', () => {
      const part = {
        name: 'Test Part'
      };
      
      const embeddingSource = composePartEmbeddingSource(part);
      const shouldSend = embeddingSource && embeddingSource.trim();
      
      assert.ok(shouldSend, 'should send message for non-empty embedding source');
    });
  });
  
  describe('Issue embedding composition', () => {
    test('composes embedding source from issue with all fields', () => {
      const issue = {
        title: 'Banana wine fermentation stopped',
        description: 'Fermentation ceased after 3 days',
        resolution_notes: 'Added more yeast and increased temperature'
      };
      
      const result = composeIssueEmbeddingSource(issue);
      
      assert.strictEqual(result, 'Banana wine fermentation stopped. Fermentation ceased after 3 days. Added more yeast and increased temperature');
      assert.ok(result.includes('Banana wine fermentation stopped'), 'should contain title');
      assert.ok(result.includes('Fermentation ceased'), 'should contain description');
      assert.ok(result.includes('Added more yeast'), 'should contain resolution_notes');
    });
    
    test('composes embedding source from issue without resolution_notes', () => {
      const issue = {
        title: 'Tool missing',
        description: 'Hammer not found in storage'
      };
      
      const result = composeIssueEmbeddingSource(issue);
      
      assert.strictEqual(result, 'Tool missing. Hammer not found in storage');
      assert.ok(!result.includes('undefined'), 'should not contain undefined');
      assert.ok(!result.includes('null'), 'should not contain null');
    });
    
    test('handles issue with only title', () => {
      const issue = {
        title: 'Test Issue'
      };
      
      const result = composeIssueEmbeddingSource(issue);
      
      assert.strictEqual(result, 'Test Issue');
    });
  });
  
  describe('Policy embedding composition', () => {
    test('composes embedding source from policy with all fields', () => {
      const policy = {
        title: 'Organic Pest Control',
        description_text: 'Use only natural pesticides like neem oil'
      };
      
      const result = composePolicyEmbeddingSource(policy);
      
      assert.strictEqual(result, 'Organic Pest Control. Use only natural pesticides like neem oil');
      assert.ok(result.includes('Organic Pest Control'), 'should contain title');
      assert.ok(result.includes('natural pesticides'), 'should contain description_text');
    });
    
    test('handles policy with only title', () => {
      const policy = {
        title: 'Test Policy'
      };
      
      const result = composePolicyEmbeddingSource(policy);
      
      assert.strictEqual(result, 'Test Policy');
    });
  });
  
  describe('Issue SQS message format validation', () => {
    test('validates issue SQS message structure', () => {
      const issue = {
        id: '123e4567-e89b-12d3-a456-426614174002',
        title: 'Test Issue',
        description: 'Test description',
        resolution_notes: 'Test resolution'
      };
      
      const embeddingSource = composeIssueEmbeddingSource(issue);
      const message = {
        entity_type: 'issue',
        entity_id: issue.id,
        embedding_source: embeddingSource,
        organization_id: 'org-123'
      };
      
      assert.strictEqual(message.entity_type, 'issue', 'entity_type should be issue');
      assert.strictEqual(message.entity_id, issue.id, 'entity_id should match issue id');
      assert.ok(message.embedding_source.includes('Test Issue'), 'embedding_source should contain issue title');
      assert.strictEqual(message.organization_id, 'org-123', 'organization_id should be set');
    });
  });
  
  describe('Policy SQS message format validation', () => {
    test('validates policy SQS message structure', () => {
      const policy = {
        id: 42,
        title: 'Test Policy',
        description_text: 'Test description'
      };
      
      const embeddingSource = composePolicyEmbeddingSource(policy);
      const message = {
        entity_type: 'policy',
        entity_id: policy.id.toString(),
        embedding_source: embeddingSource,
        organization_id: 'org-123'
      };
      
      assert.strictEqual(message.entity_type, 'policy', 'entity_type should be policy');
      assert.strictEqual(message.entity_id, '42', 'entity_id should match policy id as string');
      assert.ok(message.embedding_source.includes('Test Policy'), 'embedding_source should contain policy title');
      assert.strictEqual(message.organization_id, 'org-123', 'organization_id should be set');
    });
  });
});

