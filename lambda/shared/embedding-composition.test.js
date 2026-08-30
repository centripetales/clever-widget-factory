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
  composePolicyEmbeddingSource,
  composeStateEmbeddingSource,
  composeFinancialRecordEmbeddingSource
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

describe('composeStateEmbeddingSource', () => {
  test('should compose with all fields populated', () => {
    const state = {
      entity_names: ['Banana Plant', 'Pruning Shears'],
      state_text: 'Leaves yellowing at tips, possible nutrient deficiency',
      photo_descriptions: ['Close-up of leaf damage', 'Wide shot of plant'],
      metrics: [
        { display_name: 'Girth', value: 45, unit: 'cm' },
        { display_name: 'Height', value: 2.1, unit: 'm' }
      ]
    };

    const result = composeStateEmbeddingSource(state);

    assert.strictEqual(
      result,
      'Banana Plant. Pruning Shears. Leaves yellowing at tips, possible nutrient deficiency. Close-up of leaf damage. Wide shot of plant. Girth: 45 cm. Height: 2.1 m'
    );
  });

  test('should compose with only state_text', () => {
    const state = {
      entity_names: [],
      state_text: 'General field observation about soil conditions',
      photo_descriptions: [],
      metrics: []
    };

    const result = composeStateEmbeddingSource(state);

    assert.strictEqual(result, 'General field observation about soil conditions');
  });

  test('should return empty string when all fields are empty or null', () => {
    const state = {
      entity_names: [],
      state_text: null,
      photo_descriptions: [],
      metrics: []
    };

    const result = composeStateEmbeddingSource(state);

    assert.strictEqual(result, '');
  });

  test('should return empty string for empty object', () => {
    const result = composeStateEmbeddingSource({});

    assert.strictEqual(result, '');
  });

  test('should return empty string when fields are undefined', () => {
    const state = {
      entity_names: undefined,
      state_text: undefined,
      photo_descriptions: undefined,
      metrics: undefined
    };

    const result = composeStateEmbeddingSource(state);

    assert.strictEqual(result, '');
  });

  test('should not include photo URLs in output', () => {
    const state = {
      entity_names: ['Banana Plant'],
      state_text: 'Observation text',
      photo_descriptions: ['Close-up of leaf damage'],
      metrics: []
    };
    // photo URLs are not part of the input shape — only descriptions are passed
    const result = composeStateEmbeddingSource(state);

    assert.ok(!result.includes('https://'));
    assert.ok(!result.includes('.jpg'));
    assert.ok(!result.includes('s3.amazonaws.com'));
    assert.strictEqual(
      result,
      'Banana Plant. Observation text. Close-up of leaf damage'
    );
  });

  test('should not include entity type prefixes', () => {
    const state = {
      entity_names: ['Banana Plant', 'Hand Drill', 'Applied compost'],
      state_text: 'Observation text',
      photo_descriptions: [],
      metrics: []
    };

    const result = composeStateEmbeddingSource(state);

    // Entity names appear directly without "part:", "tool:", "action:" prefixes
    assert.ok(!result.includes('part:'));
    assert.ok(!result.includes('tool:'));
    assert.ok(!result.includes('action:'));
    assert.strictEqual(
      result,
      'Banana Plant. Hand Drill. Applied compost. Observation text'
    );
  });

  test('should format metric with unit', () => {
    const state = {
      entity_names: [],
      state_text: null,
      photo_descriptions: [],
      metrics: [{ display_name: 'Girth', value: 45, unit: 'cm' }]
    };

    const result = composeStateEmbeddingSource(state);

    assert.strictEqual(result, 'Girth: 45 cm');
  });

  test('should format metric without unit', () => {
    const state = {
      entity_names: [],
      state_text: null,
      photo_descriptions: [],
      metrics: [{ display_name: 'Count', value: 12 }]
    };

    const result = composeStateEmbeddingSource(state);

    assert.strictEqual(result, 'Count: 12');
  });

  test('should handle multiple entity names from different entity types', () => {
    const state = {
      entity_names: ['Banana Plant', 'Hand Drill', 'Applied compost to banana plants'],
      state_text: null,
      photo_descriptions: [],
      metrics: []
    };

    const result = composeStateEmbeddingSource(state);

    assert.strictEqual(
      result,
      'Banana Plant. Hand Drill. Applied compost to banana plants'
    );
  });

  test('should handle mixed metrics with and without units', () => {
    const state = {
      entity_names: [],
      state_text: 'Measurement session',
      photo_descriptions: [],
      metrics: [
        { display_name: 'Girth', value: 45, unit: 'cm' },
        { display_name: 'Leaf Count', value: 8 },
        { display_name: 'Weight', value: 3.5, unit: 'kg' }
      ]
    };

    const result = composeStateEmbeddingSource(state);

    assert.strictEqual(
      result,
      'Measurement session. Girth: 45 cm. Leaf Count: 8. Weight: 3.5 kg'
    );
  });

  test('should handle single entity name with metrics only', () => {
    const state = {
      entity_names: ['Banana Plant'],
      state_text: null,
      photo_descriptions: [],
      metrics: [{ display_name: 'Height', value: 2.1, unit: 'm' }]
    };

    const result = composeStateEmbeddingSource(state);

    assert.strictEqual(result, 'Banana Plant. Height: 2.1 m');
  });
});

describe('composeFinancialRecordEmbeddingSource', () => {
  // Specific stripping examples from design (Requirements 1.2, 1.3, 1.4, 1.5, 1.8)
  test('should strip purchaser prefix, category+price parenthetical, and photo marker', () => {
    const record = {
      state_text: '[Mae] Nipa 100 pcs — Additional nipa (Category: Construction, ₱10.00/unit) {{photo:https://example.com/photo.jpg}}'
    };

    const result = composeFinancialRecordEmbeddingSource(record);

    assert.strictEqual(result, 'Nipa 100 pcs — Additional nipa');
  });

  test('should strip purchaser prefix only', () => {
    const record = {
      state_text: '[Stefan] GCash reload'
    };

    const result = composeFinancialRecordEmbeddingSource(record);

    assert.strictEqual(result, 'GCash reload');
  });

  test('should strip category parenthetical without purchaser prefix', () => {
    const record = {
      state_text: 'Chicken feed 50kg (Category: Food)'
    };

    const result = composeFinancialRecordEmbeddingSource(record);

    assert.strictEqual(result, 'Chicken feed 50kg');
  });

  test('should return text unchanged when no metadata present', () => {
    const record = {
      state_text: 'Transaction'
    };

    const result = composeFinancialRecordEmbeddingSource(record);

    assert.strictEqual(result, 'Transaction');
  });

  // Edge cases (Requirements 6.5)
  test('should return empty string for empty state_text input', () => {
    const record = {
      state_text: ''
    };

    const result = composeFinancialRecordEmbeddingSource(record);

    assert.strictEqual(result, '');
  });

  test('should return photo descriptions when state_text is null', () => {
    const record = {
      state_text: null,
      photo_descriptions: ['Receipt for nipa purchase']
    };

    const result = composeFinancialRecordEmbeddingSource(record);

    assert.strictEqual(result, 'Receipt for nipa purchase');
  });

  test('should strip multiple photo markers', () => {
    const record = {
      state_text: 'Lumber delivery {{photo:https://example.com/a.jpg}} extra text {{photo:https://example.com/b.jpg}}'
    };

    const result = composeFinancialRecordEmbeddingSource(record);

    assert.strictEqual(result, 'Lumber delivery extra text');
  });

  test('should strip migrated Google Photos URLs', () => {
    const record = {
      state_text: 'Meryenda — Bread, canton, coffee. migrated:https://photos.app.goo.gl/JrSPc98LDVgXyz'
    };

    const result = composeFinancialRecordEmbeddingSource(record);

    assert.strictEqual(result, 'Meryenda — Bread, canton, coffee.');
  });

  test('should strip migrated URL mid-sentence', () => {
    const record = {
      state_text: '9/8 reload. migrated:https://photos.app.goo.gl/yemmaDVfVHe5oHRg8'
    };

    const result = composeFinancialRecordEmbeddingSource(record);

    assert.strictEqual(result, '9/8 reload.');
  });

  test('should fully remove combined category and price parenthetical', () => {
    const record = {
      state_text: 'Nipa 100 pcs (Category: Construction, ₱10.00/unit)'
    };

    const result = composeFinancialRecordEmbeddingSource(record);

    assert.strictEqual(result, 'Nipa 100 pcs');
  });

  // Photo description joining (Requirements 1.7, 6.4)
  test('should join state_text and single photo description with ". "', () => {
    const record = {
      state_text: 'Nipa purchase',
      photo_descriptions: ['Receipt showing nipa purchase']
    };

    const result = composeFinancialRecordEmbeddingSource(record);

    assert.strictEqual(result, 'Nipa purchase. Receipt showing nipa purchase');
  });

  test('should join state_text and multiple photo descriptions with ". "', () => {
    const record = {
      state_text: 'Lumber delivery',
      photo_descriptions: ['Receipt from hardware store', 'Photo of lumber stack']
    };

    const result = composeFinancialRecordEmbeddingSource(record);

    assert.strictEqual(result, 'Lumber delivery. Receipt from hardware store. Photo of lumber stack');
  });

  test('should filter out empty and whitespace-only photo descriptions', () => {
    const record = {
      state_text: 'Feed purchase',
      photo_descriptions: ['Receipt photo', '', '  ', 'Bag of feed']
    };

    const result = composeFinancialRecordEmbeddingSource(record);

    assert.strictEqual(result, 'Feed purchase. Receipt photo. Bag of feed');
  });

  test('should return empty string when state_text is empty and no photo descriptions', () => {
    const record = {
      state_text: '',
      photo_descriptions: []
    };

    const result = composeFinancialRecordEmbeddingSource(record);

    assert.strictEqual(result, '');
  });

  test('should return empty string when state_text is null and photo_descriptions is undefined', () => {
    const record = {
      state_text: null
    };

    const result = composeFinancialRecordEmbeddingSource(record);

    assert.strictEqual(result, '');
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
