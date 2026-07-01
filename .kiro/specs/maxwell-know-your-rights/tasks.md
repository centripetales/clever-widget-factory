# Tasks: Maxwell "Know Your Rights" Skill

## Implementation Tasks

### Task 1: Create rights.txt prompt file ✅
- [x] Create `lambda/ws-maxwell-worker/prompts/sonnet46/rights.txt`
- [x] Prompt covers all three modes: proactive, evaluative, report
- [x] Copy to `lambda/maxwell-chat/prompts/sonnet46/rights.txt`

### Task 2: Update Lambda keyword detection ✅
- [x] Add `RIGHTS_PROMPT = loadPrompt('rights.txt')` to both Lambdas
- [x] Add `RIGHTS_KEYWORDS` regex before storage/quantitative detection
- [x] Update `detectPromptMode()` to check rights first in both Lambdas
- [x] Files modified: `lambda/ws-maxwell-worker/index.js`, `lambda/maxwell-chat/index.js`

### Task 3: Deploy ✅
- [x] Deploy ws-maxwell-worker: `./scripts/deploy/deploy-lambda-fast.sh ws-maxwell-worker cwf-ws-maxwell-worker`
- [x] Deploy maxwell-chat: `./scripts/deploy/deploy-lambda-fast.sh maxwell-chat cwf-maxwell-chat-lambda`

## Testing Checklist

- [ ] **Proactive mode**: "What are my rights at SSS?" → structured rights response without tool calls
- [ ] **Evaluative mode**: Open entity with observations → "Were my rights violated?" → assessment with photos
- [ ] **Report mode**: "Generate a rights violation report" → full report format with evidence
- [ ] **No false positives**: "Where do I store the file cabinet?" → triggers storage, not rights
- [ ] **Rich copy**: Copy a report with photos, paste into Gmail → images render inline
- [ ] **Date filtering**: "Generate a report from last week" → date params passed to GetEntityObservations

## Implementation Notes

- `RIGHTS_KEYWORDS` uses `file a` instead of bare `file` to avoid triggering on storage queries like "where do I file this"
- Rights detection takes priority over storage and quantitative (checked first in `detectPromptMode()`)
- Sub-mode detection (proactive vs evaluative vs report) is handled by the LLM within the prompt, not by separate regexes
- No new infrastructure: no new Lambdas, endpoints, tables, or Bedrock action groups
- `GetEntityObservations` already supports `dateFrom`/`dateTo` parameters — no backend changes needed
