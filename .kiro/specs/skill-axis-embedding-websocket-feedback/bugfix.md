# Bugfix Requirements Document

## Introduction

When a user opens the capability assessment immediately after approving a skill profile, `cwf-capability-lambda` calls `ensurePerAxisEmbeddings`, which polls the database up to 4 times with increasing waits (3s, 6s, 9s, 12s = 30s total) waiting for `skill_axis` embeddings to be written by `cwf-embeddings-processor`. If the embeddings are not ready within that window, the Lambda times out with a 504 Gateway Timeout and the frontend shows "Unable to load target growth areas" with no explanation and no recovery path. This is a hard ceiling: the Lambda timeout cannot be extended beyond 30 seconds. The fix replaces the blocking poll with a non-blocking HTTP 202 response and a WebSocket-based progress feedback loop so the user sees real-time embedding progress and the capability assessment loads automatically when embeddings are ready.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a user opens the capability assessment and `skill_axis` embeddings are not yet written to `unified_embeddings` THEN the system blocks the Lambda for up to 30 seconds polling the database

1.2 WHEN the 30-second polling window elapses without all `skill_axis` embeddings appearing THEN the system throws an error and returns a 504 Gateway Timeout to the frontend

1.3 WHEN the capability assessment returns a 504 or network error THEN the system displays "Unable to load target growth areas" with no indication of whether the failure is transient or permanent

1.4 WHEN `cwf-embeddings-processor` successfully writes a `skill_axis` embedding to `unified_embeddings` THEN the system does not notify any connected clients that progress has occurred

1.5 WHEN `cwf-embeddings-processor` finishes all `skill_axis` embeddings for an action THEN the system does not notify any connected clients that the capability assessment is now ready to load

1.6 WHEN `cwf-embeddings-processor` fails to generate a `skill_axis` embedding THEN the system does not notify any connected clients that an error has occurred

### Expected Behavior (Correct)

2.1 WHEN a user opens the capability assessment and `skill_axis` embeddings are not yet written to `unified_embeddings` THEN the system SHALL return HTTP 202 with `{ status: 'embeddings_pending', action_id }` immediately without blocking

2.2 WHEN the frontend receives a 202 `embeddings_pending` response THEN the system SHALL display a "Preparing skill analysis…" state with a progress indicator instead of an error

2.3 WHEN `cwf-embeddings-processor` successfully writes a `skill_axis` embedding to `unified_embeddings` THEN the system SHALL broadcast a `embeddings:skill_axis_ready` WebSocket message with `{ action_id, axis_key, organization_id, axes_complete, axes_total }` to all active connections in the organization

2.4 WHEN the frontend receives an `embeddings:skill_axis_ready` message for the current action THEN the system SHALL update the progress indicator to show per-axis progress (e.g. "2 of 3 axes ready")

2.5 WHEN `cwf-embeddings-processor` finishes all `skill_axis` embeddings for an action THEN the system SHALL broadcast a `embeddings:skill_axis_complete` WebSocket message with `{ action_id, organization_id }` to all active connections in the organization

2.6 WHEN the frontend receives an `embeddings:skill_axis_complete` message for the current action THEN the system SHALL automatically re-trigger the capability query to load the assessment

2.7 WHEN `cwf-embeddings-processor` fails to generate a `skill_axis` embedding THEN the system SHALL broadcast a `embeddings:skill_axis_failed` WebSocket message with `{ action_id, axis_key, error }` to all active connections in the organization

2.8 WHEN the frontend receives an `embeddings:skill_axis_failed` message for the current action THEN the system SHALL display a clear error state with a retry option

### Unchanged Behavior (Regression Prevention)

3.1 WHEN `skill_axis` embeddings already exist in `unified_embeddings` when the capability assessment is requested THEN the system SHALL CONTINUE TO return HTTP 200 with the full capability profile immediately (cache hit or fresh computation path is unaffected)

3.2 WHEN the capability assessment is requested and the action has no approved skill profile THEN the system SHALL CONTINUE TO return HTTP 404 as before

3.3 WHEN the capability assessment is requested and the action does not exist THEN the system SHALL CONTINUE TO return HTTP 404 as before

3.4 WHEN `cwf-embeddings-processor` processes any non-`skill_axis` entity type (part, tool, action, state, etc.) THEN the system SHALL CONTINUE TO write embeddings to `unified_embeddings` without broadcasting any WebSocket messages

3.5 WHEN `cwf-embeddings-processor` processes a `skill_axis` embedding and `WS_API_ENDPOINT` is not configured THEN the system SHALL CONTINUE TO write the embedding to `unified_embeddings` successfully (WebSocket broadcast degrades gracefully)

3.6 WHEN a user triggers a force-rescore via `?force=true` and embeddings already exist THEN the system SHALL CONTINUE TO recompute the capability profile via Bedrock and return HTTP 200

3.7 WHEN the `broadcastInvalidation` utility is used by other Lambda functions for `cache:invalidate` messages THEN the system SHALL CONTINUE TO function without modification

3.8 WHEN the frontend capability query returns HTTP 200 (embeddings ready) THEN the system SHALL CONTINUE TO render the radar chart, gap checklist, and learning objectives sections as before
