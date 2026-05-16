# Implementation Plan: Learning Focus Redesign

## Overview

Add a `description` field to each skill axis across the full stack: shared utility, Lambda prompts and validator, TypeScript interface, and React form/display components. The description becomes the sole embedding source when present, replacing the label-only approach. Six files change; no new tables or endpoints are introduced.

## Tasks

- [x] 1. Update `composeAxisEmbeddingSource` in all three `axisUtils.js` copies
  - In `lambda/layers/cwf-common-nodejs/nodejs/axisUtils.js`, replace the current `parts` array logic with: return `axis.description` (trimmed) when present and non-empty; otherwise fall back to `[axis.label, narrative].filter(Boolean).join('. ')`
  - Apply the identical change to `lambda/skill-profile/axisUtils.js`
  - Apply the identical change to `lambda/shared/axisUtils.js`
  - Update the JSDoc `@param` comment to reflect that `description` is now the sole source when present
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 5.1_

  - [ ]* 1.1 Write property test for `composeAxisEmbeddingSource` — description present
    - **Property 1: Description is sole embedding source when present**
    - Use fast-check `fc.record({ label: fc.string(), description: fc.string({ minLength: 1 }) })` for axis and `fc.option(fc.string())` for narrative
    - Assert `composeAxisEmbeddingSource(axis, narrative) === axis.description` for all non-empty, non-whitespace descriptions
    - Tag: `// Feature: learning-focus-redesign, Property 1: description sole source`
    - _Requirements: 2.1, 2.4_

  - [ ]* 1.2 Write property test for `composeAxisEmbeddingSource` — description absent/empty
    - **Property 2: Fallback embedding source when description absent**
    - Use fast-check with axes where `description` is absent, empty string, or whitespace-only
    - Assert result equals `axis.label` when narrative is absent/empty, and `axis.label + '. ' + narrative` when narrative is present
    - Tag: `// Feature: learning-focus-redesign, Property 2: fallback when description absent`
    - _Requirements: 2.2, 5.1_

- [x] 2. Update `buildSkillProfilePrompt` in `lambda/skill-profile/index.js`
  - In the action-driven path (no `growthIntent`), add `"description"` to the axes array spec in the prompt string, after `"label"` and before `"required_level"`, using the wording from the design document (action-context framing)
  - In the growth-intent path, add `"description"` to the axes array spec using the growth-intent framing from the design document
  - Both paths must include the 2–4 sentence structure, concept/mechanism focus, and the "NOT about specific farm instances" constraint
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 1.7_

- [x] 3. Add `description` validation to `isValidSkillProfile` in `lambda/skill-profile/index.js`
  - Inside the `for (const axis of profile.axes)` loop, add a check: `if (typeof axis.description !== 'string' || !axis.description.trim()) return false;`
  - This aligns the validator with the design document and with `isValidProfileSkillGeneration` (which already validates `axis.description`)
  - _Requirements: 1.5, 3.4_

  - [ ]* 3.1 Write property test for `isValidSkillProfile` — missing axis description
    - **Property 3: Validator rejects profiles with missing axis description**
    - Use fast-check to generate valid profile objects, then set `description` to `''`, `undefined`, or whitespace on a random axis
    - Assert `isValidSkillProfile(profile, aiConfig)` returns `false` for all such inputs
    - Tag: `// Feature: learning-focus-redesign, Property 3: validator rejects missing description`
    - _Requirements: 1.5, 3.4_

- [x] 4. Checkpoint — verify Lambda logic before touching frontend
  - Ensure all Lambda-side tests pass (axisUtils properties 1–3, buildSkillProfilePrompt examples, isValidSkillProfile examples)
  - Ask the user if any questions arise before proceeding to frontend changes.

- [x] 5. Add `description: string` to `SkillAxis` interface in `src/hooks/useSkillProfile.ts`
  - Add `description: string;` after `label: string;` in the `SkillAxis` interface
  - _Requirements: 4.5_

- [x] 6. Update `SkillProfilePanel.tsx` — Zod schema, defaultValues, and `PreviewState` render
  - In `skillAxisSchema`, add `description: z.string().min(1, 'Description is required')` after the `label` field
  - In `PreviewState`'s `useForm` `defaultValues`, add `description: a.description` to each axis mapping
  - In the `PreviewState` axes render block, change the current `flex items-center gap-2` row layout to a `space-y-2 p-3 border rounded-md` block layout; add a `<Textarea>` for `axes.${index}.description` (rows=3, placeholder="2–4 sentence description of the concept…") between the label `<Input>` and the required_level `<Input>`; add an error message span for `errors.axes?.[index]?.description`
  - _Requirements: 3.1, 3.2, 3.3, 4.1, 4.4_

  - [ ]* 6.1 Write property test for `skillAxisSchema` — missing description
    - **Property 4: Zod schema rejects axis objects missing description**
    - Use fast-check to generate axis objects with `description` absent, empty, or whitespace-only
    - Assert `skillAxisSchema.safeParse(axis).success === false` for all such inputs
    - Tag: `// Feature: learning-focus-redesign, Property 4: Zod schema rejects missing description`
    - _Requirements: 4.4_

  - [ ]* 6.2 Write property test for `PreviewState` — description textarea count
    - **Property 5: PreviewState renders description field for every axis**
    - Use fast-check to generate profiles with N axes (within min/max range)
    - Render `<PreviewState>` with the generated profile and assert exactly N `<textarea>` elements with the description placeholder are present in the output
    - Tag: `// Feature: learning-focus-redesign, Property 5: PreviewState renders N description textareas`
    - _Requirements: 3.1, 3.2, 4.1_

- [x] 7. Update `ApprovedState` in `SkillProfilePanel.tsx` to display axis labels and descriptions
  - Replace the current `ApprovedState` body (which shows only narrative + approved date + Regenerate button) with an axes list rendered before the Regenerate button
  - For each axis, render a `<div className="space-y-0.5">` containing: `<p className="text-sm font-medium">{axis.label}</p>` and, conditionally, `{axis.description && <p className="text-xs text-muted-foreground line-clamp-3">{axis.description}</p>}`
  - The conditional render ensures legacy profiles (no description) display without error
  - _Requirements: 4.2, 4.3, 5.4_

- [x] 8. Update `callBedrockForPerAxisCapability` in `lambda/capability/index.js`
  - Replace the current `axesDescription` mapping with the new form that appends `\n  Concept: ${a.description}` when `a.description` is present (using a template literal conditional)
  - _Requirements: 7.2_

  - [ ]* 8.1 Write property test for `callBedrockForPerAxisCapability` — description in axesDescription
    - **Property 6: Capability scoring prompt includes axis description when present**
    - Extract or unit-test the `axesDescription` composition logic in isolation
    - Use fast-check to generate skill profiles where all axes have non-empty descriptions
    - Assert the composed `axesDescription` string contains each axis's `description` text
    - Tag: `// Feature: learning-focus-redesign, Property 6: axesDescription contains description`
    - _Requirements: 7.2_

- [x] 9. Final checkpoint — full test suite and integration smoke test
  - Run `npm run test:run` and ensure all tests pass
  - Verify TypeScript compiles without errors (`npm run build` or `tsc --noEmit`)
  - Confirm `isValidSkillProfile` now rejects a profile with an axis missing `description`
  - Confirm `composeAxisEmbeddingSource` returns `axis.description` exactly when description is present
  - Ask the user if any questions arise before deployment.

- [x] 10. Deploy updated Lambda artifacts
  - Bump the `cwf-common-nodejs` layer version: run `./scripts/deploy/deploy-lambda-with-layer.sh` or the equivalent layer publish script to publish a new layer version containing the updated `axisUtils.js`
  - Deploy `cwf-skill-profile-lambda` with the new layer version attached (updated `buildSkillProfilePrompt` + `isValidSkillProfile`)
  - Deploy `cwf-capability-lambda` with the new layer version attached (updated `callBedrockForPerAxisCapability`)
  - Note: frontend changes are deployed via the standard Vite build + S3/CloudFront pipeline and do not require Lambda deployment steps
  - _Requirements: 2.5, 7.1_

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Property tests use **fast-check** (already available in the project's Node.js ecosystem), minimum 100 iterations each
- All three `axisUtils.js` copies must be kept byte-for-byte identical after Task 1 — the layer copy is canonical
- The `isValidSkillProfile` change (Task 3) means any profile generated before this deploy that lacks `description` will be rejected on approve; this is intentional — users must regenerate to get descriptions
- Legacy approved profiles (already stored in `actions.skill_profile`) continue to work: `composeAxisEmbeddingSource` falls back gracefully, and `ApprovedState` renders conditionally
- Deployment order matters: publish the layer first, then deploy both Lambdas pointing at the new layer version
