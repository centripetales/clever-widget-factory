/**
 * Tests for embedding source composition functions
 * Run with: node --test embedding-composition.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  composePartEmbeddingSource,
  composeToolEmbeddingSource,
  composeActionPolicySource,
  composeIssueEmbeddingSource,
  composePolicyEmbeddingSource
} = require('./embedding-composition');

describe('composePartEmbeddingSource', () => {
  test('should compose with all fields populated', () => {
    const part = {
      name: 'Banana Wine',
      description: 'Fermented banana beverage',
      policy: 'Rich in potassium and B vitamins. May support heart health.'
    };

    const result = composePartEmbeddingSource(part);

    assert.strictEqual(
      result,
      'Banana Wine. Fermented banana beverage. Rich in potassium and B vitamins. May support heart health.'
    );
  });

  test('should handle missing optional fields', () => {
    const part = {
      name: 'Banana Wine',
      description: 'Fermented banana beverage'
      // policy is missing
    };

    const result = composePartEmbeddingSource(part);

    assert.strictEqual(result, 'Banana Wine. Fermented banana beverage');
  });

  test('should handle only name field', () => {
    const part = {
      name: 'Banana Wine'
    };

    const result = composePartEmbeddingSource(part);

    assert.strictEqual(result, 'Banana Wine');
  });

  test('should filter out null and undefined values', () => {
    const part = {
      name: 'Banana Wine',
      description: null,
      policy: undefined
    };

    const result = composePartEmbeddingSource(part);

    assert.strictEqual(result, 'Banana Wine');
  });

  test('should filter out empty strings', () => {
    const part = {
      name: 'Banana Wine',
      description: '',
      policy: 'Rich in potassium'
    };

    const result = composePartEmbeddingSource(part);

    assert.strictEqual(result, 'Banana Wine. Rich in potassium');
  });
});

describe('composeToolEmbeddingSource', () => {
  test('should compose with all fields populated', () => {
    const tool = {
      name: 'Hand Drill',
      description: 'Manual drilling tool with adjustable chuck'
    };

    const result = composeToolEmbeddingSource(tool);

    assert.strictEqual(result, 'Hand Drill. Manual drilling tool with adjustable chuck');
  });

  test('should handle missing description', () => {
    const tool = {
      name: 'Hand Drill'
    };

    const result = composeToolEmbeddingSource(tool);

    assert.strictEqual(result, 'Hand Drill');
  });

  test('should filter out null values', () => {
    const tool = {
      name: 'Hand Drill',
      description: null
    };

    const result = composeToolEmbeddingSource(tool);

    assert.strictEqual(result, 'Hand Drill');
  });
});

describe('composeActionPolicySource', () => {
  test('should compose title and policy', () => {
    const action = {
      title: 'Applied compost to banana plants',
      policy: 'Organic matter improves soil structure'
    };

    const result = composeActionPolicySource(action);

    assert.strictEqual(
      result,
      'Applied compost to banana plants. Organic matter improves soil structure'
    );
  });

  test('should handle only title', () => {
    const action = {
      title: 'Applied compost to banana plants'
    };

    const result = composeActionPolicySource(action);

    assert.strictEqual(result, 'Applied compost to banana plants');
  });

  test('should filter out null and undefined policy', () => {
    const action = {
      title: 'Applied compost',
      policy: null
    };

    const result = composeActionPolicySource(action);

    assert.strictEqual(result, 'Applied compost');

    const action2 = { title: 'Applied compost', policy: undefined };
    assert.strictEqual(composeActionPolicySource(action2), 'Applied compost');
  });

  test('should strip HTML tags from policy', () => {
    const action = {
      title: 'Pour concrete foundation',
      policy: '<p>Level, crack-free foundation cured for 7 days</p>'
    };

    const result = composeActionPolicySource(action);

    assert.strictEqual(result, 'Pour concrete foundation. Level, crack-free foundation cured for 7 days');
  });

  test('should strip structured HTML (headings, rules) and decode entities', () => {
    const action = {
      title: 'Create a plant starter soil',
      policy: '<p></p><hr><h2>Protocol: The Fungal Fortress (Chili &amp; Wing Bea)</h2>'
    };

    const result = composeActionPolicySource(action);

    assert.strictEqual(result, 'Create a plant starter soil. Protocol: The Fungal Fortress (Chili & Wing Bea)');
  });

  test('should not include description, expected_state, or evidence_description', () => {
    const action = {
      title: 'Pour concrete foundation',
      description: 'This is state-shaped context, not the action itself',
      evidence_description: 'Should not appear',
      observations: 'Should not appear',
      expected_state: 'Should not appear — state-shaped, belongs to a state, not this vector'
    };

    const result = composeActionPolicySource(action);

    assert.strictEqual(result, 'Pour concrete foundation');
  });

  test('should return empty string when policy is empty/whitespace-only HTML and title is absent', () => {
    const action = {
      policy: '<p></p>'
    };

    const result = composeActionPolicySource(action);

    assert.strictEqual(result, '');
  });
});

describe('composeIssueEmbeddingSource', () => {
  test('should compose with all fields populated', () => {
    const issue = {
      title: 'Banana wine fermentation stopped',
      description: 'Fermentation ceased after 3 days',
      resolution_notes: 'Added more yeast and increased temperature'
    };

    const result = composeIssueEmbeddingSource(issue);

    assert.strictEqual(
      result,
      'Banana wine fermentation stopped. Fermentation ceased after 3 days. Added more yeast and increased temperature'
    );
  });

  test('should handle missing optional fields', () => {
    const issue = {
      title: 'Banana wine fermentation stopped',
      description: 'Fermentation ceased after 3 days'
      // resolution_notes is missing
    };

    const result = composeIssueEmbeddingSource(issue);

    assert.strictEqual(result, 'Banana wine fermentation stopped. Fermentation ceased after 3 days');
  });

  test('should handle only title', () => {
    const issue = {
      title: 'Banana wine fermentation stopped'
    };

    const result = composeIssueEmbeddingSource(issue);

    assert.strictEqual(result, 'Banana wine fermentation stopped');
  });

  test('should filter out null values', () => {
    const issue = {
      title: 'Issue title',
      description: null,
      resolution_notes: 'Fixed'
    };

    const result = composeIssueEmbeddingSource(issue);

    assert.strictEqual(result, 'Issue title. Fixed');
  });
});

describe('composePolicyEmbeddingSource', () => {
  test('should compose with all fields populated', () => {
    const policy = {
      title: 'Organic Pest Control',
      description_text: 'Use only natural pesticides like neem oil'
    };

    const result = composePolicyEmbeddingSource(policy);

    assert.strictEqual(result, 'Organic Pest Control. Use only natural pesticides like neem oil');
  });

  test('should handle missing description_text', () => {
    const policy = {
      title: 'Organic Pest Control'
    };

    const result = composePolicyEmbeddingSource(policy);

    assert.strictEqual(result, 'Organic Pest Control');
  });

  test('should filter out null values', () => {
    const policy = {
      title: 'Organic Pest Control',
      description_text: null
    };

    const result = composePolicyEmbeddingSource(policy);

    assert.strictEqual(result, 'Organic Pest Control');
  });

  test('should filter out empty strings', () => {
    const policy = {
      title: 'Organic Pest Control',
      description_text: ''
    };

    const result = composePolicyEmbeddingSource(policy);

    assert.strictEqual(result, 'Organic Pest Control');
  });
});

describe('Edge cases', () => {
  test('should handle objects with no valid fields', () => {
    const part = {
      name: null,
      description: undefined,
      policy: ''
    };

    const result = composePartEmbeddingSource(part);

    assert.strictEqual(result, '');
  });

  test('should handle empty objects', () => {
    const result = composePartEmbeddingSource({});

    assert.strictEqual(result, '');
  });

  test('should handle objects with extra fields', () => {
    const part = {
      id: 'part-123',
      name: 'Banana Wine',
      description: 'Fermented beverage',
      organization_id: 'org-1',
      created_at: '2024-01-01'
    };

    const result = composePartEmbeddingSource(part);

    assert.strictEqual(result, 'Banana Wine. Fermented beverage');
  });
});
