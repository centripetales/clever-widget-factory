# Implementation Plan: Experience-Based Capability Evidence

## Overview

A surgical change to `lambda/capability/index.js`: remove the `INNER JOIN state_links` from the per-axis evidence query in `handlePerAxisCapability` and add two explicit prefix exclusion clauses. Everything else — caching, Bedrock prompt, response shape, org-level scoring — is untouched.

## Tasks

- [x] 1. Update the per-axis evidence query in `handlePerAxisCapability`
  - In `lambda/capability/index.js`, inside the `for (const axis of skillProfile.axes)` loop, remove the line:
    `INNER JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type = 'learning_objective'`
  - Add two `NOT LIKE` clauses to the `WHERE` block:
    `AND s.state_text NOT LIKE '[capability_profile]%'`
    `AND s.state_text NOT LIKE '[learning_objective]%'`
  - Update the inline comment from "INNER JOIN state_links restricts to learning-objective-linked states only" to reflect that `captured_by` is now the sole eligibility criterion and prefix exclusions are explicit
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1_

  - [x] 1.1 Write property test for evidence pool membership (Property 1)
    - **Property 1: Evidence pool contains all user-authored states regardless of action assignment**
    - Generate states with varying `captured_by`, `organization_id`, and `state_links` configurations (including states with no learning_objective links); verify all `captured_by = userId` states appear in the pool
    - Tag: `// Feature: experience-based-capability-evidence, Property 1`
    - **Validates: Requirements 1.1, 1.5, 2.1**

  - [x] 1.2 Write property test for organisation scoping (Property 2)
    - **Property 2: Evidence pool is scoped to the user's organisation**
    - Generate states across two organisations; verify the pool for org A contains no states from org B
    - Tag: `// Feature: experience-based-capability-evidence, Property 2`
    - **Validates: Requirements 1.2**

  - [x] 1.3 Write property test for prefix exclusion (Property 3)
    - **Property 3: Prefix-excluded states never appear in the evidence pool**
    - Generate states with `state_text` prefixed by `[capability_profile]` or `[learning_objective]` alongside normal states; verify prefixed states are absent from the pool
    - Tag: `// Feature: experience-based-capability-evidence, Property 3`
    - **Validates: Requirements 1.6**

  - [x] 1.4 Write property test for similarity ordering (Property 4)
    - **Property 4: Evidence items are returned in descending similarity order**
    - Generate evidence result lists with arbitrary similarity scores; verify `similarity_score[i] >= similarity_score[i+1]` for all adjacent pairs
    - Tag: `// Feature: experience-based-capability-evidence, Property 4`
    - **Validates: Requirements 1.3**

  - [x] 1.5 Write property test for evidence count limit (Property 5)
    - **Property 5: Evidence count per axis never exceeds the configured limit**
    - Generate arbitrary `evidence_limit` values and pools larger than the limit; verify returned count is always `<= evidence_limit`
    - Tag: `// Feature: experience-based-capability-evidence, Property 5`
    - **Validates: Requirements 1.4**

  - [x] 1.6 Write property test for evidence type classification (Property 6)
    - **Property 6: Evidence type classification is total and consistent**
    - Generate arbitrary strings (recognition pattern, open-form patterns with all question types and evaluation states, random strings); verify `determineEvidenceTypeEnriched` returns a structurally valid result for every input
    - Tag: `// Feature: experience-based-capability-evidence, Property 6`
    - **Validates: Requirements 2.2**

  - [x] 1.7 Write property test for response shape (Property 7)
    - **Property 7: Response shape is structurally complete for any valid input**
    - Generate arbitrary skill profiles and evidence maps with a mocked DB and Bedrock; verify the response always contains `user_id`, `user_name`, `action_id`, `narrative`, `axes`, `total_evidence_count`, `computed_at`, and that each axis has `key`, `label`, `level` (in [0.0, 5.0]), `evidence_count`, `evidence`, `axis_narrative`
    - Tag: `// Feature: experience-based-capability-evidence, Property 7`
    - **Validates: Requirements 5.1**

- [x] 2. Deploy the Lambda
  - Run `./scripts/deploy/deploy-lambda-with-layer.sh capability cwf-capability-lambda` to package and deploy the updated function
  - Verify the deployment succeeds and the function version is updated in AWS
  - _Requirements: 1.1, 1.6_

- [x] 3. Checkpoint — Verify the change is live
  - Ensure all tests pass, ask the user if questions arise.
  - Smoke-test the capability endpoint for a user who has states not linked to any learning objective and confirm those states now appear in the evidence array

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Property tests use [fast-check](https://github.com/dubzzz/fast-check) with a minimum of 100 iterations per property
- `handleOrganizationCapability` is explicitly out of scope — its `INNER JOIN state_links` is not touched
- The cache hash (`fetchEvidenceStateIds`) already uses the same `captured_by` filter and prefix exclusions, so no cache logic changes are needed
