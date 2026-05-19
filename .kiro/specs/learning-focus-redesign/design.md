# Design Document: Learning Focus Redesign

## Overview

This feature adds a `description` field to each skill axis (learning focus) in the CWF skill profile system. The description is a 2–4 sentence rich text that captures the core concept, why it matters for the action, what understanding looks like, and what questions it raises — grounded in the user's growth intent. The description becomes the primary embedding source for per-axis vector similarity search, replacing the current label-only approach, and is included in Bedrock prompts for capability scoring and quiz generation.

The change is surgical: six files are modified, no new tables or endpoints are introduced, and backward compatibility is preserved for profiles approved before this feature.

### Key Design Decisions

**Description as sole embedding source (not appended to label):** The current `composeAxisEmbeddingSource` appends description after label. The new behavior makes description the *sole* source when present. Rationale: the description already incorporates the growth intent and concept context; appending the label adds noise and dilutes the semantic signal. The label is a short identifier, not a semantic anchor.

**Description generated at profile-generation time (not lazily):** Descriptions are produced in the same Bedrock call that generates axes. This avoids a two-step flow and ensures the description is available when the user reviews the preview. The `isValidSkillProfile` validator already requires `axis.description` — the prompt was simply behind the validator.

**No new database columns or API endpoints:** The `skill_profile` JSONB column already stores the full axis object. Adding `description` to the axis object requires no schema migration. The existing approve/generate endpoints handle the new field transparently.

---

## Architecture

The change touches three layers:

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend (React/TypeScript)                                 │
│  SkillProfilePanel.tsx  ←→  useSkillProfile.ts              │
│  - Add description textarea to PreviewState                  │
│  - Add description to SkillAxis interface                    │
│  - Add description to Zod schema                            │
└──────────────────────┬──────────────────────────────────────┘
                       │ POST /api/skill-profiles/generate
                       │ POST /api/skill-profiles/approve
┌──────────────────────▼──────────────────────────────────────┐
│  Lambda: skill-profile/index.js                             │
│  - buildSkillProfilePrompt: add axes[].description to spec  │
│  - isValidSkillProfile: already validates description ✓     │
│  - handleApprove: uses composeAxisEmbeddingSource → SQS     │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  Shared Utility: axisUtils.js (3 copies)                    │
│  - composeAxisEmbeddingSource: description → sole source    │
└──────────────────────┬──────────────────────────────────────┘
                       │ SQS → cwf-embeddings-processor
┌──────────────────────▼──────────────────────────────────────┐
│  Lambda: capability/index.js                                │
│  - callBedrockForPerAxisCapability: add description to      │
│    axesDescription block sent to Bedrock                    │
│  - ensurePerAxisEmbeddings: uses updated axisUtils ✓        │
└─────────────────────────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  Lambda: learning/index.js                                  │
│  - Already uses skillAxis.description conditionally ✓       │
│  - No changes needed                                        │
└─────────────────────────────────────────────────────────────┘
```

---

## Components and Interfaces

### 1. `axisUtils.js` — Three copies updated identically

**Current behavior:**
```javascript
function composeAxisEmbeddingSource(axis, narrative) {
  const parts = [axis.label];
  if (axis.description) parts.push(axis.description);
  if (narrative) parts.push(narrative);
  return parts.join('. ');
}
```

**New behavior:**
```javascript
function composeAxisEmbeddingSource(axis, narrative) {
  if (axis.description && axis.description.trim()) {
    return axis.description;
  }
  // Fallback: legacy behavior for profiles without description
  return [axis.label, narrative].filter(Boolean).join('. ');
}
```

Files to update (all three must be kept in sync):
- `lambda/layers/cwf-common-nodejs/nodejs/axisUtils.js` (the layer — canonical source)
- `lambda/skill-profile/axisUtils.js` (local copy for skill-profile Lambda tests)
- `lambda/shared/axisUtils.js` (local copy for shared Lambda tests)

### 2. `lambda/skill-profile/index.js` — `buildSkillProfilePrompt`

**Growth-intent path** — add `description` to the axes array spec:

```
"axes": An array of N to M concept axes, each with:
   - "key": A snake_case identifier
   - "label": A human-readable label
   - "required_level": An INTEGER from 0 to 5
   - "description": A 2-4 sentence rich description of the concept.
     Capture: the core concept, why it matters for this action, what
     understanding looks like, and at least one specific question it raises.
     Ground the description in the learner's own growth intent words.
     Write about concepts and mechanisms — NOT about specific farm instances
     (no field names, soil sample IDs, or observation dates).
```

**Action-driven path (no growth intent)** — same `description` field added, but framed around action context:

```
   - "description": A 2-4 sentence rich description of the concept.
     Capture: the core concept, why it matters for this action, what
     understanding looks like, and at least one specific question it raises.
     Derive from the action context (title, description, expected outcome).
     Write about concepts and mechanisms — NOT about specific farm instances.
```

**`isValidSkillProfile`** — already validates `axis.description` as a required non-empty string. No change needed.

### 3. `lambda/capability/index.js` — `callBedrockForPerAxisCapability`

**Current `axesDescription` block:**
```javascript
const axesDescription = skillProfile.axes.map(a =>
  `- ${a.key} ("${a.label}"): required level ${a.required_level}`
).join('\n');
```

**New `axesDescription` block:**
```javascript
const axesDescription = skillProfile.axes.map(a =>
  `- ${a.key} ("${a.label}"): required level ${a.required_level}${a.description ? `\n  Concept: ${a.description}` : ''}`
).join('\n');
```

This gives the Bedrock model richer context for each axis when scoring evidence, without changing the scoring flow.

### 4. `src/hooks/useSkillProfile.ts` — `SkillAxis` interface

**Current:**
```typescript
export interface SkillAxis {
  key: string;
  label: string;
  required_level: number;
}
```

**New:**
```typescript
export interface SkillAxis {
  key: string;
  label: string;
  required_level: number;
  description: string;
}
```

### 5. `src/components/SkillProfilePanel.tsx` — `PreviewState`

**Zod schema** — add `description` to `skillAxisSchema`:
```typescript
const skillAxisSchema = z.object({
  key: z.string().min(1, 'Key is required'),
  label: z.string().min(1, 'Label is required'),
  description: z.string().min(1, 'Description is required'),
  required_level: z
    .number()
    .int('Must be a whole number')
    .min(0, 'Min 0')
    .max(5, 'Max 5'),
});
```

**`useForm` defaultValues** — include `description`:
```typescript
defaultValues: {
  narrative: profile.narrative,
  axes: profile.axes.map((a) => ({
    key: a.key,
    label: a.label,
    description: a.description,
    required_level: a.required_level,
  })),
},
```

**Axis render block** — add description textarea between label and required_level:
```tsx
{fields.map((field, index) => (
  <div key={field.id} className="space-y-2 p-3 border rounded-md">
    <Input
      {...register(`axes.${index}.label`)}
      className="text-sm"
      placeholder="Axis label"
    />
    <Textarea
      {...register(`axes.${index}.description`)}
      rows={3}
      className="text-sm"
      placeholder="2-4 sentence description of the concept..."
    />
    <Input
      {...register(`axes.${index}.required_level`, { valueAsNumber: true })}
      type="number"
      step="1"
      min="0"
      max="5"
      className="text-sm w-20"
      placeholder="0–5"
    />
    {/* error messages */}
  </div>
))}
```

**`ApprovedState`** — display description per axis (with graceful fallback for legacy profiles):
```tsx
{profile.axes.map((axis) => (
  <div key={axis.key} className="space-y-0.5">
    <p className="text-sm font-medium">{axis.label}</p>
    {axis.description && (
      <p className="text-xs text-muted-foreground line-clamp-3">
        {axis.description}
      </p>
    )}
  </div>
))}
```

The `line-clamp-3` Tailwind utility handles the "truncate at 3 lines" requirement (Requirement 4.3). A "show more" toggle can be added in a follow-up if needed; `line-clamp-3` is the minimal correct implementation.

---

## Data Models

### `SkillAxis` object (within `actions.skill_profile` JSONB)

| Field | Type | Required | Notes |
|---|---|---|---|
| `key` | `string` | Yes | snake_case identifier |
| `label` | `string` | Yes | Human-readable label |
| `description` | `string` | Yes (new) | 2–4 sentence concept description |
| `required_level` | `integer` | Yes | 0–5 Bloom's level |

No database migration required. The `skill_profile` column is JSONB and accepts the new field transparently. Existing profiles without `description` continue to work via the fallback path in `composeAxisEmbeddingSource`.

### Embedding source change

| Condition | Embedding source (before) | Embedding source (after) |
|---|---|---|
| `axis.description` present | `label. description. narrative` | `description` |
| `axis.description` absent | `label. narrative` | `label. narrative` (unchanged) |

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Description is sole embedding source when present

*For any* axis object with a non-empty `description` string, and any narrative string (including empty/absent), `composeAxisEmbeddingSource(axis, narrative)` SHALL return a string equal to `axis.description` exactly — no label prefix, no narrative suffix, no transformation.

**Validates: Requirements 2.1, 2.4**

### Property 2: Fallback embedding source when description absent

*For any* axis object where `description` is absent or empty, `composeAxisEmbeddingSource(axis, narrative)` SHALL return the same string as the pre-feature implementation: `axis.label` when narrative is absent, and `axis.label + '. ' + narrative` when narrative is present.

**Validates: Requirements 2.2, 5.1**

### Property 3: Validator rejects profiles with missing axis description

*For any* skill profile object where at least one axis is missing a non-empty `description` string, `isValidSkillProfile(profile, aiConfig)` SHALL return `false`.

**Validates: Requirements 1.5, 3.4**

### Property 4: Zod schema rejects axis objects missing description

*For any* axis object passed to `skillAxisSchema.safeParse()` that is missing a `description` field or has an empty `description`, the parse result SHALL have `success: false`.

**Validates: Requirements 4.4**

### Property 5: PreviewState renders description field for every axis

*For any* skill profile with N axes (where N is within the configured min/max range), the `PreviewState` component SHALL render exactly N description textarea elements — one per axis — alongside the label input and required_level input for each axis.

**Validates: Requirements 3.1, 3.2, 4.1**

### Property 6: Capability scoring prompt includes axis description when present

*For any* skill profile where all axes have a non-empty `description`, the `axesDescription` string composed in `callBedrockForPerAxisCapability` SHALL contain each axis's `description` text.

**Validates: Requirements 7.2**

---

## Error Handling

### Backward compatibility — legacy profiles without `description`

`composeAxisEmbeddingSource` falls back to `label + narrative` when `description` is absent or empty. This means:
- Existing approved profiles continue to generate valid embeddings via `ensurePerAxisEmbeddings`.
- The capability Lambda does not error on legacy profiles.
- The learning Lambda already uses `skillAxis?.description` with optional chaining — no change needed.

### Frontend — approved profiles without `description`

The `ApprovedState` component renders `axis.description` conditionally (`{axis.description && ...}`). Legacy profiles display without error, simply omitting the description section.

The `PreviewState` form populates `description` from `a.description` in `defaultValues`. If a legacy profile is somehow loaded into preview (e.g., after a failed regeneration), the description field will be empty and the Zod validator will require the user to fill it before approving.

### Bedrock generation failures

The existing retry logic in `handleGenerate` handles malformed profiles. The `isValidSkillProfile` validator now requires `description` on each axis, so a profile returned without descriptions will trigger the strict-prompt retry. If both attempts fail, the existing 500 error path is returned.

### `isValidSkillProfile` — note on current state

The validator in `lambda/skill-profile/index.js` (lines 360–383) does **not** currently validate `axis.description`. The requirements document states it does, but the actual code does not include that check. This feature adds the description validation to the validator as part of the implementation.

---

## Testing Strategy

### Unit tests

**`axisUtils.js`** (property-based + examples):
- Property 1: description present → returns description exactly (100+ iterations with random axis/narrative combinations)
- Property 2: description absent/empty → returns label + narrative fallback (100+ iterations)
- Edge case: `description` is whitespace-only → treated as absent, falls back to label
- Edge case: `narrative` is undefined → returns just `axis.label` in fallback path

**`isValidSkillProfile`** (property-based + examples):
- Property 3: any profile with an axis missing description → returns false (100+ iterations)
- Example: valid profile with all descriptions → returns true
- Example: axis with empty string description → returns false
- Example: axis with whitespace-only description → returns false

**`skillAxisSchema` (Zod)** (property-based + examples):
- Property 4: axis missing description → parse fails (100+ iterations)
- Example: axis with valid description → parse succeeds

**`buildSkillProfilePrompt`** (examples):
- Example: growth_intent present → prompt string contains `"description"` in the axes spec
- Example: growth_intent absent → prompt string contains `"description"` in the axes spec
- Example: strict=true → prompt contains the CRITICAL clause

**`callBedrockForPerAxisCapability`** (property-based):
- Property 6: all axes have descriptions → composed axesDescription contains each description

### Component tests

**`PreviewState`** (property-based + examples):
- Property 5: profile with N axes → renders N description textareas
- Example: submit form with edited description → submitted data includes description
- Example: description field empty → form shows validation error, submit blocked
- Edge case: profile axis has no description (legacy) → description field is empty but renders without error

**`ApprovedState`** (examples):
- Example: profile with descriptions → descriptions are displayed
- Example: profile without descriptions (legacy) → renders without error, no description section shown

### Integration tests

- `POST /api/skill-profiles/approve` with axis missing description → 400 response
- `POST /api/skill-profiles/approve` with valid profile including descriptions → 200, embedding queued with `embedding_source = axis.description`
- `ensurePerAxisEmbeddings` with legacy profile (no description) → embedding queued with `embedding_source = label + narrative`

### Property-based testing library

Use **fast-check** (already available in the project's Node.js ecosystem) for all property tests.

Each property test runs a minimum of **100 iterations**.

Tag format: `// Feature: learning-focus-redesign, Property N: <property_text>`

### What is NOT tested with PBT

- Bedrock prompt content quality (description is conceptual vs. farm-specific) — manual review
- TypeScript interface shape — verified at compile time
- UI visual appearance and line-clamp behavior — visual regression / manual review
