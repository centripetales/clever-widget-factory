# Design: Maxwell Q&A Persistence

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│ SAVE FLOW                                                               │
│                                                                         │
│  Frontend                    ws-message-router         ws-maxwell-worker │
│  ─────────                   ────────────────          ──────────────── │
│  User asks question  ──WS──▸ Extracts auth context ──▸ Invokes Bedrock │
│  (includes page_url          Adds userId to event       Agent           │
│   in payload)                                           │               │
│                                                         ▼               │
│                                                   Response complete     │
│                                                         │               │
│                                                         ├──▸ postToConnection (reply)
│                                                         │               │
│                                                         ▼               │
│                                                   saveInteraction()     │
│                                                   (fire-and-forget)     │
│                                                         │               │
│                                                         ├──▸ INSERT states
│                                                         ├──▸ INSERT state_links (if entity context)
│                                                         └──▸ SQS → embedding queue
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ FETCH FLOW                                                              │
│                                                                         │
│  Frontend                         API Gateway           cwf-core-lambda │
│  ─────────                        ───────────           ────────────── │
│  Maxwell panel opens ──GET──▸ /api/maxwell/questions ──▸ Query states  │
│  (sends page_url)                                       WHERE type =    │
│                                                         maxwell_interaction
│           ◂── JSON array of { id, question } ──────────┘ AND page_url  │
│                                                           AND user_id   │
│                                                           AND !deleted  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ DELETE FLOW                                                             │
│                                                                         │
│  Frontend                         API Gateway           cwf-core-lambda │
│  ─────────                        ───────────           ────────────── │
│  User clicks X ──────DELETE──▸ /api/maxwell/questions/:id ──▸ UPDATE   │
│                                                               state_text│
│                                                         (set deleted_at)│
└─────────────────────────────────────────────────────────────────────────┘
```

### Data Model

Maxwell interactions are stored as rows in the existing `states` table. The `state_text` column contains a JSON string:

```json
{
  "type": "maxwell_interaction",
  "question": "What tools do we have for metalworking?",
  "response": "Based on the inventory, you have...",
  "model": "deep",
  "input_tokens": 1523,
  "output_tokens": 847,
  "duration_ms": 34200,
  "page_url": "/actions/abc-123",
  "deleted_at": null
}
```

The state row uses:
- `captured_by` → user who asked the question (cognito_user_id)
- `organization_id` → user's org (from authorizer)
- `captured_at` → timestamp when the question was asked

If entity context existed (entityType + entityId in sessionAttributes), a `state_links` row links the state to that entity.

---

## 2. Backend: Save Interaction

### Location

The save happens in `lambda/ws-maxwell-worker/index.js` immediately after `postToConnection` sends the `maxwell:response_complete` message. It's wrapped in a try/catch so failures don't affect the user experience.

### Getting user_id into the worker

Currently the `maxwellChatHandler` passes `{ connectionId, payload, endpoint, organizationId }` to the worker. We add `userId` (the `cognito_user_id` from the WebSocket authorizer context):

```javascript
// lambda/ws-message-router/maxwellChatHandler.js
const authContext = event.requestContext.authorizer || {};
const organizationId = authContext.organization_id;
const userId = authContext.cognito_user_id; // ADD THIS

// In the InvokeCommand payload:
Payload: JSON.stringify({
  connectionId,
  payload,
  endpoint,
  organizationId,
  userId,  // ADD THIS
}),
```

### Getting page_url into the worker

The frontend sends `page_url` alongside the existing `sessionAttributes` in the WebSocket message payload:

```javascript
// Frontend sends:
wsSendMessage('maxwell:chat', {
  message: enhancedText,
  sessionId,
  mode,
  history,
  page_url: window.location.pathname,  // ADD THIS
  sessionAttributes: { ... },
});
```

The `page_url` flows through: frontend → ws-message-router → ws-maxwell-worker (via `payload.page_url`).

### Token extraction from trace

Token usage is available in Bedrock Agent trace events. The worker already collects `traceEvents[]`. After the streaming loop completes, extract tokens:

```javascript
function extractTokenUsage(traceEvents) {
  let inputTokens = 0;
  let outputTokens = 0;

  for (const event of traceEvents) {
    const usage = event.trace?.orchestrationTrace?.modelInvocationOutput?.metadata?.usage;
    if (usage) {
      inputTokens += usage.inputTokens || 0;
      outputTokens += usage.outputTokens || 0;
    }
  }

  return { inputTokens, outputTokens };
}
```

### Save implementation

After the `postToConnection` call for `maxwell:response_complete`, add:

```javascript
// Fire-and-forget: save interaction to states table
saveInteraction({
  organizationId,
  userId: event.userId,
  question: message,       // original user message (without mode prefix/instructions)
  response: reply,
  model: mode,
  inputTokens: tokenUsage.inputTokens,
  outputTokens: tokenUsage.outputTokens,
  durationMs: tEnd - t0,
  pageUrl: payload.page_url || null,
  entityType: sessionAttributes.entityType || null,
  entityId: sessionAttributes.entityId || null,
}).catch(err => console.error('[MAXWELL-WORKER] Failed to save interaction:', err.message));
```

### saveInteraction function

```javascript
const { getDbClient } = require('/opt/nodejs/db');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { composeStateEmbeddingSource } = require('/opt/nodejs/embedding-composition');

const sqs = new SQSClient({ region: 'us-west-2' });
const EMBEDDINGS_QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/131745734428/cwf-embeddings-queue';

async function saveInteraction({ organizationId, userId, question, response, model, inputTokens, outputTokens, durationMs, pageUrl, entityType, entityId }) {
  const client = await getDbClient();
  try {
    await client.query('BEGIN');

    const stateText = JSON.stringify({
      type: 'maxwell_interaction',
      question,
      response,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      duration_ms: durationMs,
      page_url: pageUrl,
      deleted_at: null,
    });

    const stateResult = await client.query(`
      INSERT INTO states (organization_id, state_text, captured_by, captured_at)
      VALUES ($1, $2, $3::uuid, NOW())
      RETURNING id
    `, [organizationId, stateText, userId]);

    const stateId = stateResult.rows[0].id;

    // Link to entity if context exists
    if (entityType && entityId) {
      await client.query(`
        INSERT INTO state_links (state_id, entity_type, entity_id)
        VALUES ($1, $2, $3::uuid)
      `, [stateId, entityType, entityId]);
    }

    await client.query('COMMIT');

    // Queue embedding generation (after commit)
    const embeddingSource = composeStateEmbeddingSource({
      entity_names: [],
      state_text: stateText,
      photo_descriptions: [],
      metrics: [],
    });

    if (embeddingSource && embeddingSource.trim()) {
      await sqs.send(new SendMessageCommand({
        QueueUrl: EMBEDDINGS_QUEUE_URL,
        MessageBody: JSON.stringify({
          entity_type: 'state',
          entity_id: stateId,
          embedding_source: embeddingSource,
          organization_id: organizationId,
        }),
      }));
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
```

### Infrastructure requirement

The `cwf-ws-maxwell-worker` Lambda currently does NOT have the `cwf-common-nodejs` layer attached (it only has `@aws-sdk/client-bedrock-agent-runtime` and `@aws-sdk/client-apigatewaymanagementapi` as local deps). To use `getDbClient()` and `composeStateEmbeddingSource()`, the layer must be attached.

**Action required:** Run deploy with layer:
```bash
./scripts/deploy/deploy-lambda-with-layer.sh ws-maxwell-worker cwf-ws-maxwell-worker
```

The Lambda also needs:
- `DB_PASSWORD` environment variable (for RDS connection via the layer's `db.js`)
- VPC configuration (same subnet/security group as other DB-accessing Lambdas)

---

## 3. Backend: Fetch Starter Questions

### Endpoint

```
GET /api/maxwell/questions?page_url=/actions/abc-123
```

### Handler location

Add a new route in `cwf-core-lambda` (or create a small dedicated `cwf-maxwell-questions` Lambda). Given the simplicity, adding to `cwf-core-lambda` with a route check is preferred.

**Alternative considered:** Adding as a query filter to the existing `GET /api/states` endpoint. Rejected because the states endpoint is heavy (joins photos, perspectives, metrics) and the maxwell query needs only `id` + `question` text.

### Query

```sql
SELECT
  s.id,
  s.state_text,
  s.captured_at
FROM states s
WHERE s.organization_id = $1
  AND s.captured_by = $2::uuid
  AND s.state_text::jsonb->>'type' = 'maxwell_interaction'
  AND s.state_text::jsonb->>'page_url' = $3
  AND (s.state_text::jsonb->>'deleted_at') IS NULL
ORDER BY s.captured_at DESC
LIMIT 5
```

### Response shape

```json
[
  {
    "id": "uuid-of-state",
    "question": "What tools do we have for metalworking?",
    "captured_at": "2026-06-30T10:15:00Z"
  },
  ...
]
```

The handler parses `state_text` JSON and returns only the `question` field (the full response text is not needed for starter display).

### Authorization

Standard: `organization_id` from authorizer context, `user_id` from authorizer (`cognito_user_id`). Only the user's own questions are returned (Requirement 3.5).

---

## 4. Backend: Soft Delete

### Endpoint

```
DELETE /api/maxwell/questions/:id
```

### Implementation

```sql
-- First verify ownership
SELECT state_text FROM states
WHERE id = $1
  AND organization_id = $2
  AND captured_by = $3::uuid

-- Then update the JSON to add deleted_at
UPDATE states
SET state_text = jsonb_set(
  state_text::jsonb,
  '{deleted_at}',
  to_jsonb(NOW()::text)
)::text,
updated_at = NOW()
WHERE id = $1
```

### Response

```json
{ "success": true }
```

### Authorization

Standard org + user check. A user can only soft-delete their own interactions (verified by `captured_by = userId`).

---

## 5. Embedding Composition Change

### Problem

When `composeStateEmbeddingSource` receives a maxwell_interaction state, the `state_text` is a JSON string containing metadata (tokens, model, page_url, duration_ms) that would pollute the semantic search signal.

### Solution

Modify `composeStateEmbeddingSource` in `lambda/layers/cwf-common-nodejs/nodejs/embedding-composition.js` to detect maxwell_interaction JSON and extract only `question` + `response`:

```javascript
function composeStateEmbeddingSource(state) {
  const parts = [];

  if (state.entity_names && state.entity_names.length > 0) {
    parts.push(...state.entity_names);
  }

  if (state.state_text) {
    // Detect maxwell_interaction JSON and extract only Q&A text
    const extracted = extractMaxwellText(state.state_text);
    if (extracted) {
      parts.push(extracted);
    } else {
      parts.push(state.state_text);
    }
  }

  if (state.photo_descriptions && state.photo_descriptions.length > 0) {
    parts.push(...state.photo_descriptions);
  }

  if (state.metrics && state.metrics.length > 0) {
    for (const m of state.metrics) {
      const metricStr = m.unit
        ? `${m.display_name}: ${m.value} ${m.unit}`
        : `${m.display_name}: ${m.value}`;
      parts.push(metricStr);
    }
  }

  return parts.filter(Boolean).join('. ');
}

/**
 * If state_text is a maxwell_interaction JSON string, extract only question + response.
 * Returns the extracted text or null if not a maxwell_interaction.
 */
function extractMaxwellText(stateText) {
  // Quick check before parsing (avoid JSON.parse on every state)
  if (!stateText.includes('"maxwell_interaction"')) return null;

  try {
    const parsed = JSON.parse(stateText);
    if (parsed.type === 'maxwell_interaction') {
      const textParts = [];
      if (parsed.question) textParts.push(parsed.question);
      if (parsed.response) textParts.push(parsed.response);
      return textParts.join('. ') || null;
    }
  } catch {
    // Not valid JSON — treat as plain text
  }
  return null;
}
```

### Why this approach

- **Backward compatible**: Non-JSON `state_text` (normal observations) passes through unchanged.
- **Fast path**: The `includes('"maxwell_interaction"')` check avoids `JSON.parse` on the majority of states that are plain text.
- **Semantic signal**: Only the question and response carry meaning for search. Metadata like `input_tokens: 1523` or `page_url: "/actions/abc"` adds noise.

---

## 6. Frontend Changes

### 6.1 useMaxwell.ts — Pass page_url

In the `sendMessage` callback where `wsSendMessage` is called, add `page_url`:

```typescript
wsSendMessage('maxwell:chat', {
  message: enhancedText,
  sessionId: sessionId ?? undefined,
  mode,
  history,
  page_url: window.location.pathname,  // ADD
  sessionAttributes: { ... },
});
```

No other changes to `useMaxwell.ts`.

### 6.2 New hook: useMaxwellStarterQuestions.ts

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiService } from '@/lib/apiService';

interface SavedQuestion {
  id: string;
  question: string;
  captured_at: string;
}

export function useMaxwellStarterQuestions(pageUrl: string | null) {
  const queryClient = useQueryClient();

  const { data: savedQuestions = [], isLoading } = useQuery({
    queryKey: ['maxwell-questions', pageUrl],
    queryFn: async () => {
      const result = await apiService.get<SavedQuestion[]>(
        `/maxwell/questions?page_url=${encodeURIComponent(pageUrl!)}`
      );
      return result;
    },
    enabled: !!pageUrl,
    staleTime: 60_000, // 1 minute — starter questions don't change fast
  });

  const deleteMutation = useMutation({
    mutationFn: async (questionId: string) => {
      await apiService.delete(`/maxwell/questions/${questionId}`);
    },
    onSuccess: (_, questionId) => {
      // Optimistically remove from cache
      queryClient.setQueryData<SavedQuestion[]>(
        ['maxwell-questions', pageUrl],
        (old) => old?.filter(q => q.id !== questionId) ?? []
      );
    },
  });

  return {
    savedQuestions,
    isLoading,
    deleteQuestion: deleteMutation.mutate,
  };
}
```

### 6.3 GlobalMaxwellPanel.tsx — Starter questions section

Replace the hardcoded starter questions logic with:

```typescript
import { useMaxwellStarterQuestions } from '@/hooks/useMaxwellStarterQuestions';

// Inside the component:
const pageUrl = window.location.pathname;
const { savedQuestions, deleteQuestion } = useMaxwellStarterQuestions(pageUrl);

// Determine which questions to show
const starterQuestions = savedQuestions.length > 0
  ? savedQuestions
  : getHardcodedStarters(activeContext?.entityType);
```

Render saved questions with a delete button:

```tsx
{messages.length === 0 && !isLoading && (
  <div className="space-y-2 pt-2">
    {savedQuestions.length > 0
      ? savedQuestions.map((q) => (
          <div key={q.id} className="relative group/starter">
            <button
              onClick={() => sendMessage(q.question, maxwellMode)}
              disabled={isLoading}
              className="w-full rounded-xl border border-border bg-muted/50 px-4 py-2.5 pr-8 text-left text-sm text-foreground hover:bg-muted transition-colors"
            >
              {q.question}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); deleteQuestion(q.id); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full opacity-0 group-hover/starter:opacity-100 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
              aria-label="Remove saved question"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))
      : hardcodedStarters.map((q) => (
          <button
            key={q}
            onClick={() => sendMessage(q, maxwellMode)}
            disabled={isLoading}
            className="w-full rounded-xl border border-border bg-muted/50 px-4 py-2.5 text-left text-sm text-foreground hover:bg-muted transition-colors"
          >
            {q}
          </button>
        ))
    }
  </div>
)}
```

### 6.4 Fetch timing

The `useMaxwellStarterQuestions` hook fires when `pageUrl` is set (always truthy). TanStack Query handles caching — subsequent opens of the Maxwell panel on the same page use cached data with a 60-second stale time.

---

## 7. Implementation Scope

### Files to modify

| File | Change |
|------|--------|
| `lambda/ws-message-router/maxwellChatHandler.js` | Pass `userId` (from `authContext.cognito_user_id`) in the worker invocation payload |
| `lambda/ws-maxwell-worker/index.js` | Add `saveInteraction()` function, call after response_complete, add token extraction, import DB/SQS from layer |
| `lambda/ws-maxwell-worker/package.json` | No new dependencies needed (DB + SQS come from the layer) |
| `lambda/layers/cwf-common-nodejs/nodejs/embedding-composition.js` | Add `extractMaxwellText()` helper, update `composeStateEmbeddingSource()` |
| `lambda/core/index.js` (or new route handler) | Add `GET /api/maxwell/questions` and `DELETE /api/maxwell/questions/:id` handlers |
| `src/hooks/useMaxwell.ts` | Add `page_url: window.location.pathname` to WebSocket payload |
| `src/hooks/useMaxwellStarterQuestions.ts` | **New file** — hook for fetching/deleting saved questions |
| `src/components/GlobalMaxwellPanel.tsx` | Replace hardcoded starters with saved questions + delete button, fallback to hardcoded |

### Infrastructure / deployment steps

1. Attach `cwf-common-nodejs` layer to `cwf-ws-maxwell-worker` Lambda
2. Add `DB_PASSWORD` env var to `cwf-ws-maxwell-worker`
3. Add VPC config (same subnet/SG as `cwf-core-lambda`) to `cwf-ws-maxwell-worker`
4. Add API Gateway routes: `GET /api/maxwell/questions`, `DELETE /api/maxwell/questions/{id}` with authorizer
5. Deploy API Gateway changes

### What is NOT needed

- No new database tables or columns
- No new Lambda functions (reuse core + worker)
- No schema migrations
- No changes to the SQS queue or embeddings processor
- No changes to the WebSocket authorizer
