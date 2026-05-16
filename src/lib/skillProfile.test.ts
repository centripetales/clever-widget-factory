/**
 * Unit Tests: Skill Profile Generation and Approval Endpoints
 *
 * Tests the validation logic and prompt building for the skill profile
 * generation endpoint (POST /api/skill-profiles/generate) and the
 * approval endpoint (POST /api/skill-profiles/approve).
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5, 2.6, 2.7, 2.8
 */

import { describe, it, expect } from 'vitest';

// --- Mirror of validation function from lambda/skill-profile/index.js ---

function isValidSkillProfile(profile: unknown): boolean {
  if (!profile || typeof profile !== 'object') return false;
  const p = profile as Record<string, unknown>;
  if (typeof p.narrative !== 'string' || !(p.narrative as string).trim()) return false;
  if (typeof p.generated_at !== 'string' || !(p.generated_at as string).trim()) return false;
  if (!Array.isArray(p.axes)) return false;
  if (p.axes.length < 4 || p.axes.length > 6) return false;

  for (const axis of p.axes as Record<string, unknown>[]) {
    if (!axis || typeof axis !== 'object') return false;
    if (typeof axis.key !== 'string' || !(axis.key as string).trim()) return false;
    if (typeof axis.label !== 'string' || !(axis.label as string).trim()) return false;
    if (typeof axis.description !== 'string' || !(axis.description as string).trim()) return false;
    if (typeof axis.required_level !== 'number') return false;
    if ((axis.required_level as number) < 0.0 || (axis.required_level as number) > 1.0) return false;
  }

  return true;
}

// --- Mirror of prompt builder from lambda/skill-profile/index.js ---

interface ActionContext {
  title?: string;
  description?: string;
  expected_state?: string;
  policy?: string;
  asset_name?: string;
  required_tools?: string[];
}

function buildSkillProfilePrompt(ctx: ActionContext, strict = false): string {
  const parts: string[] = [];
  if (ctx.title) parts.push(`Title: ${ctx.title}`);
  if (ctx.description) parts.push(`Description: ${ctx.description}`);
  if (ctx.expected_state) parts.push(`Expected Outcome (S'): ${ctx.expected_state}`);
  if (ctx.policy) parts.push(`Policy: ${ctx.policy}`);
  if (ctx.asset_name) parts.push(`Asset: ${ctx.asset_name}`);
  if (ctx.required_tools && ctx.required_tools.length > 0) {
    parts.push(`Required Tools: ${ctx.required_tools.join(', ')}`);
  }

  const actionContext = parts.join('\n');

  const strictClause = strict
    ? `\nCRITICAL: You MUST return EXACTLY 4 to 6 axes. Each required_level MUST be a number between 0.0 and 1.0 inclusive. Do NOT return fewer than 4 or more than 6 axes. Do NOT return levels outside [0.0, 1.0]. Failure to comply will cause an error.`
    : '';

  return `You are a skill assessment expert. Analyze the following action context and produce a JSON skill requirements profile.

Action Context:
${actionContext}

Produce a JSON object with these fields:
1. "narrative": A 2-4 sentence natural language description of what capabilities this action demands.
2. "axes": An array of 4 to 6 skill axes, each with:
   - "key": A snake_case identifier (e.g., "chemistry_understanding")
   - "label": A human-readable label (e.g., "Chemistry Understanding")
   - "required_level": A number from 0.0 to 1.0 indicating how much of this skill the action requires (0.0 = none, 1.0 = expert)
3. "generated_at": The current UTC timestamp in ISO 8601 format.

The axes should be specific to THIS action — different actions should surface different skill dimensions. For example, a concrete pouring action might have axes like "chemistry_understanding", "physical_technique", "equipment_operation", while an electrical wiring action might have "wiring_knowledge", "safety_protocols", "code_compliance".
${strictClause}
Respond with ONLY the JSON object, no markdown formatting, no code fences, no explanation.`;
}

// --- Helper: check if context has sufficient fields ---

function hasInsufficientContext(ctx: ActionContext): boolean {
  const title = (ctx.title || '').trim();
  const description = (ctx.description || '').trim();
  const expectedState = (ctx.expected_state || '').trim();
  return !title && !description && !expectedState;
}

// --- Test Data ---

const validProfile = {
  narrative: 'This action requires understanding of concrete chemistry, physical stamina for mixing and pouring, and precision in measuring water-to-cement ratios.',
  axes: [
    { key: 'chemistry_understanding', label: 'Chemistry Understanding', description: 'Understanding of how cement hydration works and why water-to-cement ratio matters for strength.', required_level: 0.7 },
    { key: 'physical_technique', label: 'Physical Technique', description: 'Ability to mix and pour concrete with consistent motion to avoid air pockets and uneven curing.', required_level: 0.8 },
    { key: 'equipment_operation', label: 'Equipment Operation', description: 'Competence with mixers, screeds, and finishing tools to achieve a level, smooth surface.', required_level: 0.6 },
    { key: 'safety_awareness', label: 'Safety Awareness', description: 'Knowledge of PPE requirements and hazards such as alkaline burns from wet concrete.', required_level: 0.9 },
  ],
  generated_at: '2025-01-15T10:30:00Z',
};

const validProfileSixAxes = {
  narrative: 'Complex action requiring multiple skill dimensions.',
  axes: [
    { key: 'a', label: 'A', description: 'Core concept for axis A and why it matters for this action.', required_level: 0.1 },
    { key: 'b', label: 'B', description: 'Core concept for axis B and why it matters for this action.', required_level: 0.2 },
    { key: 'c', label: 'C', description: 'Core concept for axis C and why it matters for this action.', required_level: 0.3 },
    { key: 'd', label: 'D', description: 'Core concept for axis D and why it matters for this action.', required_level: 0.4 },
    { key: 'e', label: 'E', description: 'Core concept for axis E and why it matters for this action.', required_level: 0.5 },
    { key: 'f', label: 'F', description: 'Core concept for axis F and why it matters for this action.', required_level: 0.6 },
  ],
  generated_at: '2025-01-15T10:30:00Z',
};

// --- Tests ---

describe('Skill Profile Validation (isValidSkillProfile)', () => {
  it('accepts a valid profile with 4 axes', () => {
    expect(isValidSkillProfile(validProfile)).toBe(true);
  });

  it('accepts a valid profile with 6 axes', () => {
    expect(isValidSkillProfile(validProfileSixAxes)).toBe(true);
  });

  it('accepts a valid profile with 5 axes', () => {
    const fiveAxes = {
      ...validProfile,
      axes: [
        ...validProfile.axes,
        { key: 'quality_assessment', label: 'Quality Assessment', description: 'Ability to assess the quality of the finished concrete surface against project specifications.', required_level: 0.5 },
      ],
    };
    expect(isValidSkillProfile(fiveAxes)).toBe(true);
  });

  it('rejects null/undefined', () => {
    expect(isValidSkillProfile(null)).toBe(false);
    expect(isValidSkillProfile(undefined)).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isValidSkillProfile('string')).toBe(false);
    expect(isValidSkillProfile(42)).toBe(false);
  });

  it('rejects empty narrative', () => {
    expect(isValidSkillProfile({ ...validProfile, narrative: '' })).toBe(false);
    expect(isValidSkillProfile({ ...validProfile, narrative: '   ' })).toBe(false);
  });

  it('rejects missing narrative', () => {
    const { narrative, ...rest } = validProfile;
    expect(isValidSkillProfile(rest)).toBe(false);
  });

  it('rejects empty generated_at', () => {
    expect(isValidSkillProfile({ ...validProfile, generated_at: '' })).toBe(false);
  });

  it('rejects missing generated_at', () => {
    const { generated_at, ...rest } = validProfile;
    expect(isValidSkillProfile(rest)).toBe(false);
  });

  it('rejects fewer than 4 axes', () => {
    expect(isValidSkillProfile({ ...validProfile, axes: validProfile.axes.slice(0, 3) })).toBe(false);
  });

  it('rejects more than 6 axes', () => {
    const sevenAxes = [
      ...validProfileSixAxes.axes,
      { key: 'g', label: 'G', description: 'Core concept for axis G.', required_level: 0.7 },
    ];
    expect(isValidSkillProfile({ ...validProfileSixAxes, axes: sevenAxes })).toBe(false);
  });

  it('rejects axes with empty key', () => {
    const badAxes = validProfile.axes.map((a, i) => (i === 0 ? { ...a, key: '' } : a));
    expect(isValidSkillProfile({ ...validProfile, axes: badAxes })).toBe(false);
  });

  it('rejects axes with empty label', () => {
    const badAxes = validProfile.axes.map((a, i) => (i === 0 ? { ...a, label: '' } : a));
    expect(isValidSkillProfile({ ...validProfile, axes: badAxes })).toBe(false);
  });

  it('rejects axes with empty description', () => {
    const badAxes = validProfile.axes.map((a, i) => (i === 0 ? { ...a, description: '' } : a));
    expect(isValidSkillProfile({ ...validProfile, axes: badAxes })).toBe(false);
  });

  it('rejects axes with whitespace-only description', () => {
    const badAxes = validProfile.axes.map((a, i) => (i === 0 ? { ...a, description: '   ' } : a));
    expect(isValidSkillProfile({ ...validProfile, axes: badAxes })).toBe(false);
  });

  it('rejects axes with missing description', () => {
    const badAxes = validProfile.axes.map((a, i) => {
      if (i === 0) {
        const { description, ...rest } = a;
        return rest;
      }
      return a;
    });
    expect(isValidSkillProfile({ ...validProfile, axes: badAxes })).toBe(false);
  });

  it('rejects required_level below 0.0', () => {
    const badAxes = validProfile.axes.map((a, i) => (i === 0 ? { ...a, required_level: -0.1 } : a));
    expect(isValidSkillProfile({ ...validProfile, axes: badAxes })).toBe(false);
  });

  it('rejects required_level above 1.0', () => {
    const badAxes = validProfile.axes.map((a, i) => (i === 0 ? { ...a, required_level: 1.1 } : a));
    expect(isValidSkillProfile({ ...validProfile, axes: badAxes })).toBe(false);
  });

  it('accepts required_level at boundary 0.0', () => {
    const boundaryAxes = validProfile.axes.map((a, i) => (i === 0 ? { ...a, required_level: 0.0 } : a));
    expect(isValidSkillProfile({ ...validProfile, axes: boundaryAxes })).toBe(true);
  });

  it('accepts required_level at boundary 1.0', () => {
    const boundaryAxes = validProfile.axes.map((a, i) => (i === 0 ? { ...a, required_level: 1.0 } : a));
    expect(isValidSkillProfile({ ...validProfile, axes: boundaryAxes })).toBe(true);
  });

  it('rejects non-numeric required_level', () => {
    const badAxes = validProfile.axes.map((a, i) => (i === 0 ? { ...a, required_level: '0.5' } : a));
    expect(isValidSkillProfile({ ...validProfile, axes: badAxes })).toBe(false);
  });

  it('does not require approved_at or approved_by (preview profile)', () => {
    // Preview profiles should NOT have approved_at/approved_by
    expect(isValidSkillProfile(validProfile)).toBe(true);
    expect(validProfile).not.toHaveProperty('approved_at');
    expect(validProfile).not.toHaveProperty('approved_by');
  });
});

describe('Insufficient Context Validation (Requirement 2.7)', () => {
  it('returns true when all context fields are empty', () => {
    expect(hasInsufficientContext({ title: '', description: '', expected_state: '' })).toBe(true);
  });

  it('returns true when all context fields are whitespace', () => {
    expect(hasInsufficientContext({ title: '  ', description: '  ', expected_state: '  ' })).toBe(true);
  });

  it('returns true when all context fields are undefined', () => {
    expect(hasInsufficientContext({})).toBe(true);
  });

  it('returns false when title is provided', () => {
    expect(hasInsufficientContext({ title: 'Pour concrete' })).toBe(false);
  });

  it('returns false when description is provided', () => {
    expect(hasInsufficientContext({ description: 'Build a foundation' })).toBe(false);
  });

  it('returns false when expected_state is provided', () => {
    expect(hasInsufficientContext({ expected_state: 'Level foundation' })).toBe(false);
  });
});

describe('Skill Profile Prompt Builder', () => {
  it('includes title in prompt when provided', () => {
    const prompt = buildSkillProfilePrompt({ title: 'Pour concrete' });
    expect(prompt).toContain('Title: Pour concrete');
  });

  it('includes description in prompt when provided', () => {
    const prompt = buildSkillProfilePrompt({ description: 'Build 10x12 foundation' });
    expect(prompt).toContain('Description: Build 10x12 foundation');
  });

  it('includes expected_state in prompt when provided', () => {
    const prompt = buildSkillProfilePrompt({ expected_state: 'Level, crack-free foundation' });
    expect(prompt).toContain("Expected Outcome (S'): Level, crack-free foundation");
  });

  it('includes policy in prompt when provided', () => {
    const prompt = buildSkillProfilePrompt({ policy: 'Follow standard ratios' });
    expect(prompt).toContain('Policy: Follow standard ratios');
  });

  it('includes asset_name in prompt when provided', () => {
    const prompt = buildSkillProfilePrompt({ asset_name: 'Storage Shed' });
    expect(prompt).toContain('Asset: Storage Shed');
  });

  it('includes required_tools in prompt when provided', () => {
    const prompt = buildSkillProfilePrompt({ required_tools: ['Concrete mixer', 'Level', 'Trowel'] });
    expect(prompt).toContain('Required Tools: Concrete mixer, Level, Trowel');
  });

  it('omits empty fields from prompt', () => {
    const prompt = buildSkillProfilePrompt({ title: 'Test', description: '' });
    expect(prompt).toContain('Title: Test');
    expect(prompt).not.toContain('Description:');
  });

  it('includes strict clause when strict=true', () => {
    const prompt = buildSkillProfilePrompt({ title: 'Test' }, true);
    expect(prompt).toContain('CRITICAL');
    expect(prompt).toContain('EXACTLY 4 to 6 axes');
  });

  it('does not include strict clause when strict=false', () => {
    const prompt = buildSkillProfilePrompt({ title: 'Test' }, false);
    expect(prompt).not.toContain('CRITICAL');
  });

  it('instructs model to return JSON with narrative, axes, and generated_at', () => {
    const prompt = buildSkillProfilePrompt({ title: 'Test' });
    expect(prompt).toContain('"narrative"');
    expect(prompt).toContain('"axes"');
    expect(prompt).toContain('"generated_at"');
    expect(prompt).toContain('"key"');
    expect(prompt).toContain('"label"');
    expect(prompt).toContain('"required_level"');
  });
});


// --- Mirror of approval logic from lambda/skill-profile/index.js ---

interface SkillAxis {
  key: string;
  label: string;
  required_level: number;
}

interface SkillProfile {
  narrative: string;
  axes: SkillAxis[];
  generated_at: string;
  approved_at?: string;
  approved_by?: string;
}

/**
 * Compose embedding source from narrative + axis labels.
 * Mirrors the logic in handleApprove.
 */
function composeSkillProfileEmbeddingSource(profile: SkillProfile): string {
  const axisLabels = profile.axes.map((a) => a.label).join(', ');
  return `${profile.narrative} ${axisLabels}`;
}

/**
 * Add approval metadata to a profile.
 * Mirrors the logic in handleApprove.
 */
function addApprovalMetadata(
  profile: SkillProfile,
  approvedBy: string
): SkillProfile {
  return {
    ...profile,
    approved_at: new Date().toISOString(),
    approved_by: approvedBy,
  };
}

// --- Tests for Approval Endpoint Logic (Requirements 2.5, 2.6, 2.8) ---

describe('Skill Profile Approval Metadata', () => {
  it('adds approved_at and approved_by to the profile', () => {
    const approved = addApprovalMetadata(validProfile, 'user-uuid-123');
    expect(approved.approved_at).toBeDefined();
    expect(approved.approved_by).toBe('user-uuid-123');
  });

  it('approved_at is a valid ISO timestamp', () => {
    const approved = addApprovalMetadata(validProfile, 'user-uuid-123');
    const parsed = new Date(approved.approved_at!);
    expect(parsed.toISOString()).toBe(approved.approved_at);
  });

  it('preserves all original profile fields', () => {
    const approved = addApprovalMetadata(validProfile, 'user-uuid-123');
    expect(approved.narrative).toBe(validProfile.narrative);
    expect(approved.axes).toEqual(validProfile.axes);
    expect(approved.generated_at).toBe(validProfile.generated_at);
  });

  it('does not mutate the original profile', () => {
    const original = { ...validProfile };
    addApprovalMetadata(validProfile, 'user-uuid-123');
    expect(validProfile).toEqual(original);
    expect(validProfile).not.toHaveProperty('approved_at');
    expect(validProfile).not.toHaveProperty('approved_by');
  });
});

describe('Skill Profile Embedding Source Composition (Requirement 2.8)', () => {
  it('includes the narrative in the embedding source', () => {
    const source = composeSkillProfileEmbeddingSource(validProfile);
    expect(source).toContain(validProfile.narrative);
  });

  it('includes all axis labels in the embedding source', () => {
    const source = composeSkillProfileEmbeddingSource(validProfile);
    for (const axis of validProfile.axes) {
      expect(source).toContain(axis.label);
    }
  });

  it('composes narrative followed by comma-separated axis labels', () => {
    const source = composeSkillProfileEmbeddingSource(validProfile);
    const expectedLabels = validProfile.axes.map((a) => a.label).join(', ');
    expect(source).toBe(`${validProfile.narrative} ${expectedLabels}`);
  });

  it('works with 6-axis profiles', () => {
    const source = composeSkillProfileEmbeddingSource(
      validProfileSixAxes as SkillProfile
    );
    expect(source).toContain(validProfileSixAxes.narrative);
    for (const axis of validProfileSixAxes.axes) {
      expect(source).toContain(axis.label);
    }
  });
});

describe('Skill Profile Approval Request Validation', () => {
  it('rejects approval when action_id is missing', () => {
    // Mirrors the handleApprove validation: action_id is required
    const hasActionId = (body: Record<string, unknown>) => !!body.action_id;
    expect(hasActionId({ skill_profile: validProfile, approved_by: 'user-1' })).toBe(false);
    expect(hasActionId({ action_id: 'abc', skill_profile: validProfile, approved_by: 'user-1' })).toBe(true);
  });

  it('rejects approval when approved_by is missing', () => {
    const hasApprovedBy = (body: Record<string, unknown>) => !!body.approved_by;
    expect(hasApprovedBy({ action_id: 'abc', skill_profile: validProfile })).toBe(false);
    expect(hasApprovedBy({ action_id: 'abc', skill_profile: validProfile, approved_by: 'user-1' })).toBe(true);
  });

  it('rejects approval when skill_profile is missing', () => {
    const hasProfile = (body: Record<string, unknown>) =>
      !!body.skill_profile && typeof body.skill_profile === 'object';
    expect(hasProfile({ action_id: 'abc', approved_by: 'user-1' })).toBe(false);
    expect(hasProfile({ action_id: 'abc', skill_profile: validProfile, approved_by: 'user-1' })).toBe(true);
  });

  it('rejects approval when skill_profile is invalid', () => {
    const invalidProfile = { ...validProfile, axes: validProfile.axes.slice(0, 2) };
    expect(isValidSkillProfile(invalidProfile)).toBe(false);
  });

  it('accepts approval when all fields are valid', () => {
    expect(isValidSkillProfile(validProfile)).toBe(true);
  });
});
