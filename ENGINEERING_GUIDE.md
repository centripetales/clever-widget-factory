# Engineering Guide

## TanStack Query Patterns - Offline-First Architecture

## Core Principle
**Optimistic updates for offline support + Invalidation for server-computed data**

## Pattern 1: Simple CRUD (Optimistic Updates)

Use when you control the data and know exactly what will change.

```typescript
const updateResource = useMutation({
  mutationFn: (data) => apiService.put(`/resource/${data.id}`, data.updates),
  
  // Optimistic update (works offline)
  onMutate: async (variables) => {
    await queryClient.cancelQueries({ queryKey: ['resources'] });
    const previous = queryClient.getQueryData(['resources']);
    
    queryClient.setQueryData(['resources'], (old) => 
      old?.map(item => 
        item.id === variables.id 
          ? { ...item, ...variables.updates }
          : item
      )
    );
    
    return { previous };
  },
  
  onError: (err, variables, context) => {
    // Rollback on error
    queryClient.setQueryData(['resources'], context.previous);
  }
});
```

**Use for:** Actions, Tools, Parts - direct updates where you know the result

## Pattern 2: Server-Computed Data (Invalidation)

Use when server generates data you can't predict (IDs, timestamps, computed fields).

```typescript
const updateAction = useMutation({
  mutationFn: (data) => apiService.put(`/actions/${data.id}`, data.updates),
  
  // Optimistic update for primary resource
  onMutate: async (variables) => {
    await queryClient.cancelQueries({ queryKey: ['actions'] });
    const previous = queryClient.getQueryData(['actions']);
    
    queryClient.setQueryData(['actions'], (old) => 
      old?.map(action => 
        action.id === variables.id 
          ? { ...action, ...variables.updates }
          : action
      )
    );
    
    return { previous };
  },
  
  onSuccess: () => {
    // Invalidate related resources with server-computed data
    // Non-blocking - refetches in background when needed
    queryClient.invalidateQueries({ queryKey: ['checkouts'] });
    queryClient.invalidateQueries({ queryKey: ['tools'] });
  },
  
  onError: (err, variables, context) => {
    queryClient.setQueryData(['actions'], context.previous);
  }
});
```

**Use for:** Checkouts (server generates IDs), Tools (server computes `is_checked_out`)

## When to Use Each Pattern

### Optimistic Updates ✅
- You know the exact result
- Simple CRUD operations
- No server-side computation
- Examples: Update action title, change tool status

### Invalidation ✅
- Server generates data (IDs, timestamps)
- Server computes fields (is_checked_out, aggregations)
- Complex side effects
- Examples: Checkouts created by actions, computed checkout status

### Both (Hybrid) ✅
- Optimistic for primary resource
- Invalidate for related computed data
- Example: Update action → optimistic action update + invalidate tools/checkouts

## Offline Behavior

**Optimistic updates:**
- ✅ Work offline immediately
- ✅ Show in UI instantly
- ✅ Rollback on error when online

**Invalidation:**
- ⚠️ Marks data as stale
- ⚠️ Refetches when online
- ✅ Non-blocking (background)
- ✅ Only refetches if component is mounted

## Key Rules

1. **Always use `onMutate` for offline support** - updates cache immediately
2. **Use `invalidateQueries` for server-computed data** - don't duplicate logic
3. **Never use `await` on invalidation** - let it happen in background
4. **Always provide `onError` rollback** - restore previous state
5. **Store previous state in `onMutate`** - needed for rollback

## Anti-Patterns ❌

```typescript
// ❌ BAD: No optimistic update (doesn't work offline)
onSuccess: () => {
  queryClient.invalidateQueries({ queryKey: ['actions'] });
}

// ❌ BAD: Blocking invalidation (slows down UI)
onSuccess: async () => {
  await queryClient.invalidateQueries({ queryKey: ['tools'] });
}

// ❌ BAD: Duplicating server logic (will drift)
onSuccess: () => {
  queryClient.setQueryData(['tools'], (old) => 
    old?.map(tool => ({
      ...tool,
      is_checked_out: /* complex logic duplicated from server */
    }))
  );
}
```

## Best Practices ✅

```typescript
// ✅ GOOD: Optimistic + invalidation hybrid
onMutate: async (variables) => {
  // Immediate update for offline
  const previous = queryClient.getQueryData(['actions']);
  queryClient.setQueryData(['actions'], (old) => /* update */);
  return { previous };
},
onSuccess: () => {
  // Background refetch for computed data
  queryClient.invalidateQueries({ queryKey: ['checkouts'] });
},
onError: (err, variables, context) => {
  // Rollback on error
  queryClient.setQueryData(['actions'], context.previous);
}
```

## Reference Implementation

See `src/hooks/useActionMutations.ts` for the canonical example of this pattern.

## Environment Variables & Configuration

### Rule: No Implicit Fallbacks

**Do not use inline fallbacks for environment variables or critical configuration unless there is a strong, documented business case.**

```typescript
// ❌ BAD: Implicit fallback hides configuration errors
const PROMPT_SET = process.env.PROMPT_SET || 'haiku';

// ✅ GOOD: Fail fast if configuration is missing
if (!process.env.PROMPT_SET) {
  throw new Error('PROMPT_SET environment variable is required');
}
const PROMPT_SET = process.env.PROMPT_SET;
```

**Why?**
Using fallbacks (like `|| 'default'`) masks configuration errors. If an environment variable is accidentally omitted during deployment, the system will silently fall back to a default value, leading to confusing bugs in production that are extremely difficult to track down. Always enforce explicit configuration.

## Code Quality & Continuous Improvement

### Rule: Proactive Refactoring (The "See Something, Say Something" Rule)

**As we navigate and write code, we must constantly evaluate the existing code against industry best practices.**

If you encounter code that is a "hack", an anti-pattern, or simply does not make sense:
1. **Check for comments:** Is there a comment explaining *why* it was done this way? (e.g., a known upstream bug, a temporary workaround).
2. **Flag it:** If there is no explanatory comment, bring it to attention immediately.
3. **Refactor:** Consider proposing a refactor to bring the code up to best practices before moving on.

**Why?**
Technical debt accumulates silently. By proactively flagging uncommented hacks as we work, we ensure the codebase continuously improves and stays aligned with best practices, rather than letting anti-patterns rot in the background.

## Data Security & Access Control

### Decision: Agentic Security over Database RLS
We intentionally use **Agentic Security (AWS Bedrock Guardrails)** rather than PostgreSQL Row-Level Security (RLS) to restrict entity data access.

*   **Why not RLS?** RLS is clunky, inflexible, and introduces a hidden layer of debugging overhead that slows down iteration speed.
*   **Why not the System Prompt?** Relying solely on the primary agent's system prompt to hide sensitive data is an anti-pattern highly vulnerable to prompt injection.
*   **The Solution:** We use a secondary, adversarial "Guardrail" agent (via AWS Bedrock Guardrails) that monitors all inputs and outputs to aggressively block restricted topics (like Finances) and redact PII. This keeps our database schema simple and our iteration speed high.

## Error Handling & Telemetry

### Rule: Always Surface Errors (No Silent Catches)

**Never catch errors silently without reporting/surfacing them to log telemetry or the user interface.**

```typescript
// ❌ BAD: Silent catch blocks mask system and network failures
try {
  const result = JSON.parse(payload);
} catch (err) {
  // Safe fallback
}

// ✅ GOOD: Surface the error explicitly to telemetry/logs
try {
  const result = JSON.parse(payload);
} catch (err) {
  console.error('[TELEMETRY] JSON parsing failed:', err);
}
```

**Why?**
Silent catch blocks hide system errors, parsing glitches, and latency degradation from APM logs and CloudWatch. Surfacing errors guarantees full system observability, enabling proactive debugging and preventing hard-to-trace failures.
