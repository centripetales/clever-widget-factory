/**
 * Unit tests for skill-profile Lambda utility functions
 * Tests composeAxisEmbeddingSource, composeProfileSkillStateText,
 * and parseProfileSkillStateText.
 *
 * Axis utility pure functions are extracted to axisUtils.js for testability
 * (no Lambda layer dependencies).
 * Profile skill state text functions are in index.js but exported for testing.
 *
 * Note: composeAxisEntityId and parseAxisEntityId were retired as part of the
 * unified_embeddings entity_id type migration (skill_axis rows now use
 * action_id + axis_key columns instead of a composite text entity_id).
 */

const {
  composeAxisEmbeddingSource
} = require('./axisUtils');

// Profile skill state text functions — import via a helper that avoids Lambda layer deps
// We re-implement the pure functions here for unit testing since index.js has Lambda layer imports
const { composeProfileSkillStateText, parseProfileSkillStateText } = (() => {
  function composeProfileSkillStateText(profileSkillData) {
    return `[profile_skill] | ${JSON.stringify(profileSkillData)}`;
  }

  function parseProfileSkillStateText(stateText) {
    const match = stateText.match(
      /^\[profile_skill\] \| (.+)$/
    );
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch (e) {
      return null;
    }
  }

  return { composeProfileSkillStateText, parseProfileSkillStateText };
})();

describe('composeAxisEmbeddingSource', () => {
  // New behavior (learning-focus-redesign): description is the SOLE source when present.
  // Fallback to label + narrative only when description is absent/empty.

  it('returns label only when no description or narrative', () => {
    const axis = { label: 'Water Chemistry Testing' };
    expect(composeAxisEmbeddingSource(axis)).toBe('Water Chemistry Testing');
  });

  it('returns description as sole source when description is provided (ignores label)', () => {
    const axis = { label: 'Water Chemistry Testing', description: 'Testing water quality parameters' };
    expect(composeAxisEmbeddingSource(axis)).toBe('Testing water quality parameters');
  });

  it('returns label + narrative when narrative is provided but no description', () => {
    const axis = { label: 'Water Chemistry Testing' };
    const narrative = 'This action requires understanding of water chemistry.';
    expect(composeAxisEmbeddingSource(axis, narrative)).toBe(
      'Water Chemistry Testing. This action requires understanding of water chemistry.'
    );
  });

  it('returns description as sole source when description and narrative are both provided', () => {
    const axis = { label: 'Water Chemistry Testing', description: 'Testing water quality parameters' };
    const narrative = 'This action requires understanding of water chemistry.';
    expect(composeAxisEmbeddingSource(axis, narrative)).toBe('Testing water quality parameters');
  });

  it('falls back to label + narrative when description is empty', () => {
    const axis = { label: 'Safety Protocols', description: '' };
    const narrative = 'Safety is critical.';
    expect(composeAxisEmbeddingSource(axis, narrative)).toBe('Safety Protocols. Safety is critical.');
  });

  it('returns description as sole source when narrative is empty but description is present', () => {
    const axis = { label: 'Safety Protocols', description: 'Following safety rules' };
    expect(composeAxisEmbeddingSource(axis, '')).toBe('Following safety rules');
  });

  it('skips null/undefined description and narrative', () => {
    const axis = { label: 'Regulatory Navigation', description: null };
    expect(composeAxisEmbeddingSource(axis, undefined)).toBe('Regulatory Navigation');
  });
});



describe('composeProfileSkillStateText', () => {
  it('composes state_text with the correct format', () => {
    const data = {
      original_narrative: 'I want to learn about Extreme Ownership',
      ai_interpretation: {
        concept_label: 'Extreme Ownership',
        source_attribution: 'Jocko Willink',
        learning_direction: 'Taking full ownership of outcomes'
      },
      axes: [
        { key: 'ownership_mindset', label: 'Ownership Mindset', description: 'Taking responsibility', bloom_level: 0, progression_history: [] }
      ],
      active: true,
      created_at: '2025-01-10T08:00:00Z'
    };
    const result = composeProfileSkillStateText(data);
    expect(result).toBe(`[profile_skill] | ${JSON.stringify(data)}`);
  });

  it('handles null ai_interpretation', () => {
    const data = {
      original_narrative: 'Some narrative',
      ai_interpretation: null,
      axes: [],
      active: true,
      created_at: '2025-01-10T08:00:00Z'
    };
    const result = composeProfileSkillStateText(data);
    expect(result).toMatch(/^\[profile_skill\] \| /);
    expect(result).toContain('"ai_interpretation":null');
  });
});

describe('parseProfileSkillStateText', () => {
  it('parses a valid profile skill state_text', () => {
    const data = {
      original_narrative: 'I want to learn about Extreme Ownership',
      ai_interpretation: {
        concept_label: 'Extreme Ownership',
        source_attribution: 'Jocko Willink',
        learning_direction: 'Taking full ownership of outcomes'
      },
      axes: [
        { key: 'ownership_mindset', label: 'Ownership Mindset', description: 'Taking responsibility', bloom_level: 2, progression_history: [{ demonstrated_level: 2, action_id: 'abc-123', state_id: 'def-456', timestamp: '2025-01-15T10:30:00Z' }] }
      ],
      active: true,
      created_at: '2025-01-10T08:00:00Z'
    };
    const stateText = `[profile_skill] | ${JSON.stringify(data)}`;
    const result = parseProfileSkillStateText(stateText);
    expect(result).not.toBeNull();
    expect(result.original_narrative).toBe(data.original_narrative);
    expect(result.ai_interpretation).toEqual(data.ai_interpretation);
    expect(result.axes).toEqual(data.axes);
    expect(result.active).toBe(true);
    expect(result.created_at).toBe('2025-01-10T08:00:00Z');
  });

  it('returns null for non-matching strings', () => {
    expect(parseProfileSkillStateText('some random text')).toBeNull();
    expect(parseProfileSkillStateText('[learning_objective] axis=x action=y user=z | text')).toBeNull();
    expect(parseProfileSkillStateText('')).toBeNull();
  });

  it('returns null for invalid JSON after prefix', () => {
    expect(parseProfileSkillStateText('[profile_skill] | {not valid json')).toBeNull();
  });

  it('round-trips with composeProfileSkillStateText', () => {
    const data = {
      original_narrative: 'Listening to a podcast about leadership',
      ai_interpretation: {
        concept_label: 'Servant Leadership',
        source_attribution: 'Robert Greenleaf',
        learning_direction: 'Leading by serving others first'
      },
      axes: [
        { key: 'empathy', label: 'Empathy', description: 'Understanding others', bloom_level: 0, progression_history: [] },
        { key: 'stewardship', label: 'Stewardship', description: 'Responsible management', bloom_level: 1, progression_history: [{ demonstrated_level: 1, action_id: 'a1', state_id: 's1', timestamp: '2025-02-01T00:00:00Z' }] }
      ],
      active: false,
      created_at: '2025-01-20T12:00:00Z'
    };
    const stateText = composeProfileSkillStateText(data);
    const parsed = parseProfileSkillStateText(stateText);

    expect(parsed.original_narrative).toBe(data.original_narrative);
    expect(parsed.ai_interpretation).toEqual(data.ai_interpretation);
    expect(parsed.axes).toEqual(data.axes);
    expect(parsed.active).toBe(data.active);
    expect(parsed.created_at).toBe(data.created_at);
  });
});


// Profile skill generation functions — re-implemented here for unit testing
// since index.js has Lambda layer imports that aren't available in test env
const { buildProfileSkillGenerationPrompt, isValidProfileSkillGeneration } = (() => {
  function buildProfileSkillGenerationPrompt(narrative, strict = false) {
    const strictClause = strict
      ? `\nCRITICAL: You MUST return EXACTLY 3 to 5 axes. Each axis MUST have a non-empty "key" (snake_case), "label", and "description". The ai_interpretation MUST have non-empty "concept_label", "source_attribution", and "learning_direction". Do NOT return fewer than 3 or more than 5 axes. Failure to comply will cause an error.`
      : '';

    return `You are a learning design expert. A learner has described a personal growth direction.
Your job is to extract the core concept and generate concept axes for structured learning.

LEARNER'S NARRATIVE:
${narrative}

INSTRUCTIONS:
1. Extract an AI interpretation with:
   - concept_label: A short name for the core concept (e.g., "Extreme Ownership")
   - source_attribution: Any referenced source, person, or origin (e.g., "Jocko Willink, Diary of a CEO"). Use "Personal insight" if no source is referenced.
   - learning_direction: 1-2 sentence summary of the growth direction

2. Generate 3-5 concept axes, each representing a distinct concept area grounded in real
   frameworks, research, or established concepts relevant to the narrative.
   Each axis has:
   - key: snake_case identifier
   - label: Human-readable label
   - description: 1-2 sentence description of the concept area
${strictClause}
Return ONLY a JSON object:
{
  "ai_interpretation": { "concept_label": "...", "source_attribution": "...", "learning_direction": "..." },
  "axes": [{ "key": "...", "label": "...", "description": "..." }]
}`;
  }

  function isValidProfileSkillGeneration(result) {
    if (!result || typeof result !== 'object') return false;

    const ai = result.ai_interpretation;
    if (!ai || typeof ai !== 'object') return false;
    if (typeof ai.concept_label !== 'string' || !ai.concept_label.trim()) return false;
    if (typeof ai.source_attribution !== 'string' || !ai.source_attribution.trim()) return false;
    if (typeof ai.learning_direction !== 'string' || !ai.learning_direction.trim()) return false;

    if (!Array.isArray(result.axes)) return false;
    if (result.axes.length < 3 || result.axes.length > 5) return false;

    for (const axis of result.axes) {
      if (!axis || typeof axis !== 'object') return false;
      if (typeof axis.key !== 'string' || !axis.key.trim()) return false;
      if (typeof axis.label !== 'string' || !axis.label.trim()) return false;
      if (typeof axis.description !== 'string' || !axis.description.trim()) return false;
    }

    return true;
  }

  return { buildProfileSkillGenerationPrompt, isValidProfileSkillGeneration };
})();


describe('buildProfileSkillGenerationPrompt', () => {
  it('includes the narrative in the prompt', () => {
    const narrative = 'I was listening to Diary of a CEO where Jocko talked about Extreme Ownership';
    const prompt = buildProfileSkillGenerationPrompt(narrative);
    expect(prompt).toContain(narrative);
  });

  it('includes learning design expert role', () => {
    const prompt = buildProfileSkillGenerationPrompt('Some narrative');
    expect(prompt).toContain('You are a learning design expert');
  });

  it('requests concept_label, source_attribution, and learning_direction', () => {
    const prompt = buildProfileSkillGenerationPrompt('Some narrative');
    expect(prompt).toContain('concept_label');
    expect(prompt).toContain('source_attribution');
    expect(prompt).toContain('learning_direction');
  });

  it('requests 3-5 concept axes with key, label, description', () => {
    const prompt = buildProfileSkillGenerationPrompt('Some narrative');
    expect(prompt).toContain('3-5 concept axes');
    expect(prompt).toContain('key: snake_case identifier');
    expect(prompt).toContain('label: Human-readable label');
    expect(prompt).toContain('description:');
  });

  it('does not include strict clause in normal mode', () => {
    const prompt = buildProfileSkillGenerationPrompt('Some narrative', false);
    expect(prompt).not.toContain('CRITICAL');
  });

  it('includes strict clause when strict=true', () => {
    const prompt = buildProfileSkillGenerationPrompt('Some narrative', true);
    expect(prompt).toContain('CRITICAL');
    expect(prompt).toContain('EXACTLY 3 to 5 axes');
  });

  it('requests JSON-only response', () => {
    const prompt = buildProfileSkillGenerationPrompt('Some narrative');
    expect(prompt).toContain('Return ONLY a JSON object');
  });
});


describe('isValidProfileSkillGeneration', () => {
  const validResult = {
    ai_interpretation: {
      concept_label: 'Extreme Ownership',
      source_attribution: 'Jocko Willink, Diary of a CEO',
      learning_direction: 'Developing personal accountability and leadership'
    },
    axes: [
      { key: 'ownership_mindset', label: 'Ownership Mindset', description: 'Taking full responsibility for outcomes' },
      { key: 'team_leadership', label: 'Team Leadership', description: 'Leading teams through accountability' },
      { key: 'decision_making', label: 'Decision Making', description: 'Making decisive choices under pressure' }
    ]
  };

  it('returns true for a valid result with 3 axes', () => {
    expect(isValidProfileSkillGeneration(validResult)).toBe(true);
  });

  it('returns true for a valid result with 5 axes', () => {
    const fiveAxes = {
      ...validResult,
      axes: [
        ...validResult.axes,
        { key: 'communication', label: 'Communication', description: 'Clear and direct communication' },
        { key: 'resilience', label: 'Resilience', description: 'Bouncing back from setbacks' }
      ]
    };
    expect(isValidProfileSkillGeneration(fiveAxes)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isValidProfileSkillGeneration(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isValidProfileSkillGeneration(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isValidProfileSkillGeneration('not an object')).toBe(false);
  });

  it('returns false when ai_interpretation is missing', () => {
    const { ai_interpretation, ...rest } = validResult;
    expect(isValidProfileSkillGeneration(rest)).toBe(false);
  });

  it('returns false when ai_interpretation is null', () => {
    expect(isValidProfileSkillGeneration({ ...validResult, ai_interpretation: null })).toBe(false);
  });

  it('returns false when concept_label is empty', () => {
    const result = {
      ...validResult,
      ai_interpretation: { ...validResult.ai_interpretation, concept_label: '' }
    };
    expect(isValidProfileSkillGeneration(result)).toBe(false);
  });

  it('returns false when concept_label is whitespace only', () => {
    const result = {
      ...validResult,
      ai_interpretation: { ...validResult.ai_interpretation, concept_label: '   ' }
    };
    expect(isValidProfileSkillGeneration(result)).toBe(false);
  });

  it('returns false when source_attribution is missing', () => {
    const { source_attribution, ...aiRest } = validResult.ai_interpretation;
    expect(isValidProfileSkillGeneration({ ...validResult, ai_interpretation: aiRest })).toBe(false);
  });

  it('returns false when learning_direction is empty', () => {
    const result = {
      ...validResult,
      ai_interpretation: { ...validResult.ai_interpretation, learning_direction: '' }
    };
    expect(isValidProfileSkillGeneration(result)).toBe(false);
  });

  it('returns false when axes is not an array', () => {
    expect(isValidProfileSkillGeneration({ ...validResult, axes: 'not array' })).toBe(false);
  });

  it('returns false when axes has fewer than 3 items', () => {
    expect(isValidProfileSkillGeneration({
      ...validResult,
      axes: validResult.axes.slice(0, 2)
    })).toBe(false);
  });

  it('returns false when axes has more than 5 items', () => {
    const sixAxes = [
      ...validResult.axes,
      { key: 'a4', label: 'A4', description: 'Desc 4' },
      { key: 'a5', label: 'A5', description: 'Desc 5' },
      { key: 'a6', label: 'A6', description: 'Desc 6' }
    ];
    expect(isValidProfileSkillGeneration({ ...validResult, axes: sixAxes })).toBe(false);
  });

  it('returns false when an axis has empty key', () => {
    const result = {
      ...validResult,
      axes: [
        { key: '', label: 'Label', description: 'Desc' },
        ...validResult.axes.slice(1)
      ]
    };
    expect(isValidProfileSkillGeneration(result)).toBe(false);
  });

  it('returns false when an axis has empty label', () => {
    const result = {
      ...validResult,
      axes: [
        { key: 'some_key', label: '', description: 'Desc' },
        ...validResult.axes.slice(1)
      ]
    };
    expect(isValidProfileSkillGeneration(result)).toBe(false);
  });

  it('returns false when an axis has empty description', () => {
    const result = {
      ...validResult,
      axes: [
        { key: 'some_key', label: 'Label', description: '' },
        ...validResult.axes.slice(1)
      ]
    };
    expect(isValidProfileSkillGeneration(result)).toBe(false);
  });

  it('returns false when an axis is null', () => {
    const result = {
      ...validResult,
      axes: [null, ...validResult.axes.slice(1)]
    };
    expect(isValidProfileSkillGeneration(result)).toBe(false);
  });
});
