# Experiential Compression Prompt

This prompt is designed to be pasted into the Maxwell chat interface. It forces the agent to synthesize chronological observation logs, actions, and empirical states into a visual timeline optimized for expert review. It enforces strict chronology, prevents hallucinated conclusions, embeds Markdown image thumbnails seamlessly into the text flow, and enforces verifiable citations.

***

Generate a structured Experiential Compression Report from the available context for this entity.

The goal is to preserve chronology, tensions, anomalies, operational context, and state transitions so a collaborator can quickly reconstruct what happened over time.

Favor signal preservation over summarization.

Do not:
* provide advice or recommendations,
* infer root causes,
* make judgment calls,
* elevate hypotheses into conclusions,
* smooth contradictions,
* collapse uncertainty,
* rewrite fragmented history into a coherent narrative.

Treat observations, interpretations, and hypotheses as separate things.

The report should read like:
STATE → ACTION → RESULTING STATE → REMAINING TENSION

Maintain a compact, fact-dense, observational tone. 
**CRITICAL:** For all factual claims, metrics, or anomalies, include footnotes or inline citations that link back to the original observation date and source.

Structure the report exactly as follows:

# 1. Executive Summary & Timeline
Provide a brief executive summary of the operational span. **In this summary, explicitly note if any learning objectives were incorporated or achieved during this timeline.**

Next, create a quick visual chronology using representative images from the context.
Use markdown image syntax: `![description](url)`

Where possible include:
* Initial state
* Major intervention
* Significant transition
* Current state

Captions should briefly describe:
* what changed,
* what action occurred,
* what uncertainty or friction remained afterward.

Do not interpret outcomes beyond what was directly observed.

# 2. Initial Conditions & System Pressures
Describe the starting conditions with minimal interpretation.

Include:
* baseline state,
* environmental conditions,
* resource limitations,
* unstable variables,
* coordination gaps,
* recurring pain points,
* unknowns.

Distinguish clearly between:
* directly observed conditions,
* participant interpretations,
* unresolved questions.

# 3. State Transition Log
Provide a strict chronological sequence using date subheadings (Do not use a table). Under each date or event, clearly structure the transition using bolded bullet points so the timeline is easy to scan:

* **Prior State:** [context]
* **Observation / Signal:** [what was noticed]
* **Action / Intervention:** [what was done]
* **Resulting State:** [outcome]
* **Remaining Friction:** [open questions]

Requirements:
* Preserve chronology strictly.
* Include measurements, quantities, methods, timings, and environmental conditions when available.
* Preserve contradictory observations without reconciling them.
* Treat unexpected outcomes as important signals.
* Clearly label participant hypotheses as hypotheses.
* **CRITICAL:** Embed relevant images naturally between or immediately below the bullet points where they belong using markdown `![description](url)`. This allows the visual evidence to flow seamlessly within the narrative.

# 4. Persistent Patterns & Recurring Signals
Extract recurring observations that appeared across multiple transitions.

Focus on:
* repeated failures,
* bottlenecks,
* unstable variables,
* delayed effects,
* coordination issues,
* recurring intervention patterns,
* unresolved anomalies,
* instrumentation inconsistencies,
* repeated hypotheses raised by participants.

Do not declare assumptions invalidated unless explicitly demonstrated by observations.
Do not infer causality from correlation.

# 5. Current State Snapshot
Describe the most recent known state with maximum specificity.

Include:
* what is currently observable,
* unresolved issues,
* degraded conditions,
* improvements,
* ambiguities,
* unknown variables,
* active hypotheses still unresolved.

# 6. Delta From Original Objective
Contrast:
* the intended trajectory,
  with
* the observed trajectory.

Identify:
* where outcomes diverged from expectations,
* interventions that changed the trajectory,
* unresolved tensions,
* conflicting observations,
* open questions that remain important.

Do not classify outcomes as success/failure.
Do not include inferred causal conclusions unless directly evidenced in the context.
