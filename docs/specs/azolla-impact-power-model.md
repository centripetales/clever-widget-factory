# Azolla Impact — Power & Impact Model Spec

Status: high-level design, agreed conceptually, not yet built. Captures the
result of an extended design conversation grounding the scoring model in
Spinoza's *Ethics* and political writings. Written so the shape survives
even if the conversation that produced it doesn't.

## 1. What this is

Azolla Impact is a farmer-led network (Sapian, Capiz, Philippines) where
participants are compensated for authentic, high-impact contribution to
growing azolla (aquatic fern, chicken/livestock feed, doubles ~every 3 days
under ideal conditions). It runs as a new organization inside the existing
Maxwell/CWF system (`clever-widget-factory`), not a separate build.

Phase 1 (complete): 4-week pilot, 12 people, flat 20 PHP/day baseline, no
imposed method — **97 observations** (corrected 2026-08-15; see §7's
duplicate-container writeup — an earlier version of this spec said 289,
which was link-row count inflated by a now-fixed data bug, not the real
observation count) already captured across 10 named participants'
containers, live in this database.

Phase 2 (this spec): backtest a full individual + group power pipeline
against that real 4-week dataset.

## 2. Philosophical grounding (condensed)

Full reasoning lives in conversation; this is the load-bearing summary.

- **Potentia** (power) is a *snapshot* — the capacity to act from one's own
  understanding, as opposed to *potestas* (domination/imposed power).
  **Conatus** is the underlying striving/process itself, not a metric —
  Spinoza's term for a thing's drive to persevere in and increase its own
  being.
- Individual power = causal clarity of a person's own trajectory: what was
  done, why, what resulted, evidenced (text + photo), precise enough to be
  replicable. A phosphorus reading outranks a visual guess because it's
  better *causal* information, not just more data.
- Group power (*potentia multitudinis*) is explicitly **not a sum of
  average performance**. Spinoza: a body's power comes from how many
  people's reason is actively engaged, not from the average quality of a
  shrinking core. A metric that improves when struggling members are
  dropped is measuring *potestas* (domination via exclusion) dressed up as
  *potentia* — this was caught directly in design and is guarded against
  structurally (see §5).
- **Composite individuals** (Ethics II, physical digression after P13):
  identity is constituted by whatever stable pattern of relations a
  composite thing's parts actually, persistently maintain — not assigned
  from outside. Applied to the group: its real conatus (what it's actually,
  organically becoming) should not be presupposed by us — it should be
  **discovered** by watching what self-perpetuates over time (§6).
- Reward chases **authenticity**, not a literal outcome number. An earlier
  version of this design used "doubling time delta" as the direct reward
  function; this was discarded because it reintroduces Goodhart's law — the
  same failure mode as the member-exclusion problem, just applied to a
  metric instead of a population. The 3-day-doubling biology is kept only
  as an orienting horizon, not the optimized target.

## 3. Core data model

Reuses existing CWF schema — nothing here requires new core tables except
where noted.

| Concept | Maps to |
|---|---|
| Contribution | an **observation**, one of several types of `states` |
| Container / batch | an **asset** — a `tools` row (`asset_type='tool'`); NOT `parts`, despite azolla behaving conceptually like a weighted stock — `metrics.tool_id` only supports `tools` today, and coverage is currently a photo-estimated %, not a real weight. Revisit as `parts`/stock-with-weight in a later phase once real weight sampling exists. |
| Container ↔ observation | `state_links` (`entity_type='tool'`) |
| **Unit of value** | an **experience**: state → action → state, tied to a container. Maps to the existing (spec'd, not yet built out for this use) `experiences` / `experience_components` tables — see `.kiro/specs/experience-tracking/`, which already defines the S/A/S' tuple with AI-estimated expected state/action (E[S], E[A]) and hypothesis probabilities when not directly observed. **Build on this spec, don't reinvent it.** |
| Reward signal (raw) | existing coverage-estimate pipeline: `azolla_duckweed_observation_perspectives.plant_coverage_percent_estimate`, `growth_color_metrics_perspectives`, surfaced today via `metric_snapshots` (metric `'Coverage %'`) and `scripts/azolla-coverage-*`. Reward is a property of the *pair* of states (a rate of change), not a single state. |
| Person-to-person connection | `epistemic_links` (`source_state_id → target_state_id`) — exists in schema, unused in any Lambda. Reserved for self-asserted "replicated/borrowed from" credit, given at capture time by the person doing the replicating (low friction, honesty-based — not AI-inferred provenance). |
| Group membership | **not** an org migration. Each participant keeps their existing personal organization. Joining "Azolla Growing" = an explicit, opt-in **share grant** at the container level. |

### Sharing mechanism (reuse existing, don't build new)

`POST /shares` (`lambda/core/index.js:6259`) already exists and is fully
generic: any `entity_type` + `entity_id` + `target_org_id` creates a share
(a `state` owned by the source org, with two `state_links` — one to the
shared entity, one to the target org). Read side already has the pattern
too: `view_shared=<org_ids>` unions own-org + explicitly-shared entities,
with `is_shared_inbound` for read-only rendering. See
`docs/specs/cross-org-sharing.md` and `docs/specs/shared-observations.md`
(observation-level sharing is spec'd but not built — **not the model we're
using**, see below).

**Decision: share at the container (`tool`) level, not per-observation.**
One `POST /shares` call per participant (`entity_type: 'tool'`,
`target_org_id` = Azolla Growing org) makes everything linked to that
container — every observation, every action — visible to the group,
transitively. Rejected per-observation sharing deliberately: selective
sharing invites curating away bad days, which is exactly the
performance-over-authenticity failure mode this whole design avoids.

Build work still needed: `view_shared` support exists for tools/parts/
actions; extending it to `states` (so shared containers' *observations* are
actually visible, not just the container row itself) needs the
transitive-via-container join, which is new — the existing
`shared-observations.md` spec assumed per-observation share links, not
cascading-from-container visibility, so its query needs adapting rather
than used as-is.

## 4. Scoring philosophy

- **No write-time scoring.** Raw data (observations, experiences,
  epistemic links) is captured as-is. A separate AI "impact report" process
  runs periodically/on demand and estimates impact retrospectively —
  distinguishing **potential impact** (just shared, nothing's happened yet)
  from **actual impact** (evidence someone acted on it and it worked). A
  diagnostic tip's actual impact may only be visible once the recipient's
  outcome plays out weeks later — scores must be revisable upward over
  time, not fixed at creation.
- **Authenticity is the gate**, evaluated per experience: is this a
  genuine, honestly-reported trajectory (including failure), not
  fabricated or extractive. Existing evidence this value is already live in
  the codebase: the coverage-chart script deliberately plots each day's
  *max* coverage estimate rather than the mean, specifically so that
  someone honestly photographing a sparse corner of their container isn't
  penalized (`scripts/azolla-coverage-chart.py` comment) — encoding
  "don't punish honest documentation of weakness" already, independently.
- **Reward = impact of a shared experience**, assessed retrospectively
  against authenticity-gated experiences only.
- **Capacity building (conatus made visible)** is not separately
  engineered — it's the emergent, longitudinal trace of a person's
  accumulated authentic, impactful experiences. No bespoke formula.

### Resolved: dynamis/oikonomia/techne and evidence-weighted-scoring are not extension points

Checked both in full. Neither is a fundamental concept or table — **do not
merge either into this design**:

- `energeia-membrane` is a computed *report*: a Claude labeling call over
  actions, cached as one JSONB payload per org in `energeia_cache`. It's a
  view, not a table with independent meaning. The dynamis/oikonomia/techne
  split is a superficially resonant parallel to "capacity building vs.
  success" but it's a different feature evaluating a different thing
  (action clusters in embedding space) — coincidental resemblance, not
  shared infrastructure.
- `evidence-weighted-scoring` is thinner still: a prompt-wording correction
  inside the existing Bloom's/capability scorer, fixing how quiz evidence
  gets described to the LLM. Not a scoring mechanism of its own.

### Actual extension points (tables/mechanisms, not reports)

1. **`experiences` / `experience_components`** — the fundamental table for
   the unit of value (§3). Real schema already exists
   (`.kiro/specs/experience-tracking/design.md`): `experiences(entity_type
   CHECK IN ('tool','part'), entity_id, organization_id, created_by)` +
   `experience_components(experience_id, component_type CHECK IN
   ('initial_state','action','final_state'), state_id, action_id)`. Its own
   spec scope is Phase 1 only (manual/UI-triggered, no reward computation,
   no AI inference yet) — this design's scoring work is the next layer on
   top of it, not a competing table.
2. **`state_perspectives`** — the generalized `(prompt, model, response)
   applied to a state` mechanism, already live in production
   (`pending_perspectives` → `cwf-perspectives-queue` → `rsp-worker` →
   `state_perspectives`), currently serving CLAIM/SIGNIFICANCE/ENTROPY plus
   the azolla vision perspective. Explicitly designed to be generalized
   (see `azolla-growth-analysis.txt` lines 1–50 — a prior design
   conversation already concluded new perspective types are "just a row in
   the perspectives config, no code changes"). **An `AUTHENTICITY`
   perspective type is the natural home for the authenticity-gate check**
   (§4) — same worker, same queue, new prompt + child table.
3. **`action_scores` / `scoring_prompts` — reused directly, not mirrored.**
   Corrected after further discussion: no new `experience_scores` table.
   `action_scores` already is the "score against company values" mechanism
   (see `docs/app_design_motivations/rl_experience_learning.md`, step 5,
   "Score Against Company Values" — this document already describes almost
   exactly this design, generalized across asset types, predating this
   spec). Authenticity gets scored as a new `scoring_prompts` row (value =
   authenticity) applied to the **action** component of an experience via
   the existing `action_scores` table. Reward (coverage % delta) is
   separate and is not an AI judgment at all — plain arithmetic over
   existing `metric_snapshots`, no scoring table needed.
4. **`epistemic_links`** — unused, reserved for replication/help credit
   (§3).
5. **`energeia_cache`'s pattern**, not the table — one cached JSONB payload
   per `organization_id`, refreshed via a `POST /refresh` endpoint. Worth
   copying architecturally for a group-power snapshot (a new, separate
   table, e.g. `group_power_cache` — zero coupling to energeia).

### Backfilling actions for the existing 4 weeks (new, unresolved)

**Data correction, 2026-08-15 — duplicate-container bug investigated and
fixed.** Container-by-container pairing initially produced impossible
results: 289 `state_links` rows but only 97 distinct states, 95 of those 97
linked to 2–4 *different* container (`tools`) rows each — the same
observation appearing under several duplicate containers per participant.

Root cause, fully diagnosed (not a mystery, not ongoing): an **unowned
RDS-level trigger** (external infra, not in this codebase) silently
title-cases `tools.name` after insert. An earlier version of
`scripts/azolla-wire-coverage-metric.js` looked up existing tools by
exact-string match; when re-run, the trigger-modified name didn't match
what it searched for, so it created a fresh duplicate container each time
— compounding across two historical bulk runs (Aug 2 and Aug 9, identified
by clustered `state_links.created_at` timestamps, not organic one-at-a-time
user activity). **Already fixed** in the version merged into `main`
(`aef6036`) — `WHERE lower(name) = lower($1)`, immune to the trigger.
Confirmed not ongoing: the single most-recently-captured observation had
exactly one container link, clean, before any cleanup ran.

Fix applied: verified zero other tables (`checkouts`, `checkins`,
`tool_audits`, `asset_history`, `actions`) referenced any of the 20
duplicate `tools` rows, then merged each duplicate group down to one
canonical row (most-recent `created_at` per participant — chosen over
earliest since more recent wiring runs may have corrected earlier data),
repointing `state_links` and `metric_snapshots` and dropping any that would
collide with a link the canonical already had. Result: 10 containers (was
30), 97 states each linked to exactly one container (was up to 4). RDS
snapshot `cwf-manual-20260815` taken beforehand covers rollback if needed.

Separately confirmed the "true" observation count is 97, not 289 or some
larger number: the 192 states with an `AZOLLA_DUCKWEED_OBSERVATION`
perspective but no container link are the vision pipeline's own
AI-generated derived states (one per photo, `state_text` literally
`"[azolla_duckweed_observation] vision LLM structured extraction"`) — not
real human observations, never meant to be linked to a container directly.
Nothing is missing; 97 is correct.

97 existing observations have **zero** linked `actions` (`action_count: 0`
confirmed against the live DB) — action/reasoning currently lives only as
free text in `state_text`/`photo_description`.
Since `action_scores` requires an `action_id` (`NOT NULL`), authenticity
scoring needs a real action row per experience, which means backfilling
one from that free text. This is exactly the "E[A], expected action"
inference `.kiro/specs/experience-tracking/design.md` explicitly scoped
*out* of its Phase 1 — no existing prompt/logic to lean on, needs designing.

- **Pairing rule**: same container, immediately preceding state
  chronologically (states are already sortable per-container by
  `captured_at`, per the coverage script).
- **Minimal action fields**: only `title` and `status` are `NOT NULL`
  besides `organization_id` — mechanically thin. `status='completed'`,
  `completed_at` = final state's `captured_at`, `created_by` = participant,
  `description` carries the extracted what/why.
- **Real risk, not just mechanics**: forcing a single confident action out
  of ambiguous or action-less text fabricates certainty and undermines the
  authenticity gate itself. Some pairs have no real action (pure biological
  growth between check-ins — the Mani Mani example in
  `rl_experience_learning.md`), some have multiple plausible causes with no
  way to isolate which mattered. Reuse the experience-tracking spec's own
  future-phase answer to this — **hypotheses with probabilities**, not a
  forced single action: some pairs get zero actions (nothing to score),
  some get one confident action, some get multiple lower-confidence
  candidates. The authenticity scorer needs the option to say "insufficient
  signal," not be fed a fabricated action to preserve appearances.

**Refined, 2026-08-15 — corrects and sharpens the above:**

- **Actions always correspond to a real human action.** No "time passed,
  natural growth" pseudo-action (the Mani Mani example above is explicitly
  *not* the model to follow here — it was the wrong reference). If there's
  no human action to extract from the text, the experience gets **zero**
  action components, full stop — not a synthesized placeholder.
- **The initial state is not necessarily one raw prior `states` row.** It
  may need to be an LLM-**synthesized summary** across a person's existing
  statements up to that point (multiple prior notes/photos, not just the
  single immediately-preceding observation). That synthesis is itself a
  judgment call, same category of risk as the action extraction — it can
  be wrong or overconfident in the same ways.
- **This needs a human-in-the-loop QA flow, not a one-shot batch job.**
  Given both the initial-state synthesis and the action extraction require
  real LLM judgment (not lookup), and errors here would corrupt every
  downstream authenticity score and reward computation built on top, the
  backfill should run as: propose (initial-state synthesis + action
  hypothesis) → human reviews/edits/rejects → only accepted proposals
  become real `experiences`/`actions` rows. This lets the prompt get dialed
  in against real judgment calls before it's trusted to run unattended —
  matches the experience-tracking spec's own glossary, which already
  defines a `Validation` concept ("human confirmation or rejection of
  AI-expected hypotheses") that Phase 1 never built a UI for.

### Backfill review flow — design (2026-08-15)

**Any LLM synthesis or hypothesis lives as a `state_perspectives` row, not
as a fabricated `states` row and not as throwaway JSON.** Resolves the
initial-state fork cleanly: it reuses the same generalized `(prompt,
model, response)` → `state_perspectives` + child table mechanism already
proposed for `AUTHENTICITY` (§4/§7 point 2), so the whole backfill uses one
consistent pattern instead of inventing a second one.

**Superseded, 2026-08-16 — `AZOLLA_STATE` as its own generated perspective
is dropped.** Tested side by side against the existing `CLAIM` perspective
(already computed automatically via `rsp-worker` for any state that
qualifies, no new call needed) on real Stefan data, and `CLAIM` produced
materially the same content, cleaner — `AZOLLA_STATE`'s prose summary
added nothing but a drift into interpretation (a trailing "this suggests…"
sentence) that blurs exactly the fact/interpretation line the
`CLAIM`/`SIGNIFICANCE` split was designed to preserve. **Use `CLAIM`
directly as a state's text going forward — do not build or run the
`AZOLLA_STATE` generation step.** The structured fields (coverage %,
water color, phosphorus/pH estimate+basis) that only `AZOLLA_STATE` could
have provided are deferred until something concrete actually needs to
query them (YAGNI) — not built preemptively. `azolla_state_perspectives`
(migration 015) and its multi-observation chaining design below are kept
in this doc as a record of the reasoning, not as something to implement.

~~Renamed twice, 2026-08-15 — `INITIAL_STATE_SYNTHESIS` → `STATE_SYNTHESIS`
→ `AZOLLA_STATE`.~~ First rename: "initial" was smuggling in a role
that isn't actually a property of the state itself — experiences chain
(the final state of one experience is the initial state of the next), so a
synthesis belongs to *the state*, not to whichever pairing happens to be
looking at it. Second rename: "state synthesis" was still too broad/domain-
generic. This mirrors a naming decision already made once in this exact
codebase — the `azolla_duckweed_observation_perspectives` migration
comment explicitly rejects a generic "growth" name in favor of a narrow,
azolla-specific one (see `azolla-growth-analysis.txt`). Same call here:
this perspective is specifically azolla growing-context, not a
general-purpose cross-domain state-synthesis mechanism — naming it that
broadly would misrepresent its scope and invite reuse it isn't designed
for. One `AZOLLA_STATE` perspective per state, computed once,
reusable as either endpoint of however many experiences reference that
state.

- **`AZOLLA_STATE`** — an objective-specific synthesis of a state (not a
  generic summary): for Azolla Impact, "objective-specific" means scoped to
  what's causally relevant to the group mission (§2) — growing conditions,
  not an arbitrary recap. Structured like the existing
  `azolla_duckweed_observation_perspectives` child table: known-important
  typed columns (coverage estimate, water color, vessel condition, etc.)
  plus a flexible `content JSONB` for anything else — that table's existing
  convention already gives this the extensibility being asked for here, no
  new pattern needed. Should be able to hold **inferred/estimated**
  quantities beyond what's literally measured — e.g. an LLM's phosphorus
  estimate from visual cues + context, even with no test-kit reading. Any
  estimated field needs a paired basis/confidence, mirroring the existing
  `species_guess_basis` / `uncertainty_flags` convention already in that
  table — an estimate must be clearly marked as inferred, never presented
  indistinguishably from a measured value (this is a direct extension of
  the authenticity principle: the *system's* claims need the same honesty
  bar as a participant's).
- **Built to evolve, not computed once and frozen.** A later state in the
  same container can reveal something that should update how an *earlier*
  state's synthesis reads (e.g. a later die-off recontextualizes an
  earlier "looks healthy" call). Architecturally: allow multiple
  `AZOLLA_STATE` rows over time for the same state (`state_perspectives`
  already supports multiple rows per state+type — `created_at` orders
  them, most recent is current), rather than one-shot-and-done.
  **Recompute trigger, resolved:** manual for now — no automatic
  recomputation while this is still being dialed in through the review
  flow (§7). Once the pipeline is trusted enough to automate, the trigger
  becomes: recompute a state's `AZOLLA_STATE` perspective when the
  `action` linked to it (via `experience_components`) changes — an edited
  or newly-accepted action is the signal that the context around that
  state may no longer be accurate, not a fixed schedule or every new
  downstream state.
- **`ACTION_HYPOTHESIS`** — candidate human action(s) with confidence, or
  an explicit empty result when no real human action is found in the text
  (per the "actions always correspond to a real human action" rule above —
  no synthesized placeholder). Attached to the *action* being hypothesized
  between two specific states — unlike state synthesis, this one is
  inherently pair-specific (an action is always "the thing that happened
  between these two states"), so the naming/role concern that applied to
  the state synthesis doesn't apply here.

  **Renamed, 2026-08-22 — `ACTION_HYPOTHESIS` → `EXPERIENCE_PERSPECTIVE`.**
  The extracted candidates are S,A,S experience tuples, not bare action
  hypotheses — "hypothesis" also undersold that each candidate carries real
  evidence (`report_span`, verbatim-quoted), not a guess. Schema fields
  renamed to match: `no_action_found` → `experience_found` (flipped
  polarity), `hypotheses` → `experiences`. Still perspective-scoped to a
  state per its final state of the pair, same as before.

Consequences of this choice:
- Preserves the existing, explicit codebase value — *"never AI-generated
  text, only what the person actually typed"* (`azolla-coverage-chart.py`)
  — since perspectives are already the established, clearly-labeled
  AI-generated layer, structurally separate from ground-truth human
  `states`.
- The proposals are real, permanent, auditable data from the moment
  they're generated — not a bespoke offline JSON file that could get lost
  or diverge from the DB.
- **No new "validation" status column needed anywhere.** A hypothesis that
  gets accepted is exactly the one that gets a real `actions` row and
  `experience_components` built from it; a rejected one simply remains a
  `state_perspectives` row with nothing built on top of it. The existence
  of the downstream experience/action row *is* the validation signal.

**Pipeline:**

1. **Propose** — per container, walk states chronologically (§7 pairing
   rule). Generate a `AZOLLA_STATE` perspective on each state that
   doesn't already have a current one (per-state, not per-pair — reused as
   whichever endpoint a given experience needs). For each consecutive pair,
   generate an `ACTION_HYPOTHESIS` (now `EXPERIENCE_PERSPECTIVE`, see rename
   above) perspective (pair-specific). Either via
   the existing `rsp-worker`-style mechanism, or an offline script writing
   directly to `state_perspectives` + child tables for this one-time
   backfill — either way, same schema.
2. **Review HTML** — mirrors `azolla-coverage-fetch-data.js` /
   `azolla-coverage-chart.py`: one section per container (reviewed
   container-by-container, confirmed), pairs in chronological sequence
   within each. Queries `state_perspectives` directly (same pattern as the
   coverage script's SQL) rather than a separate JSON file. Shows both
   states' real photos/notes side by side, then the proposed synthesis +
   hypothesis(es) with confidence, with accept/edit/reject controls per
   pair. In-progress decisions held in `localStorage`; an "export
   decisions" button downloads the final set when a review pass is done.
3. **Commit** — reads the exported decisions, and for each accepted pair
   creates the real `actions` row (from the accepted/edited hypothesis) +
   `experiences`/`experience_components` rows. Rejected pairs create
   nothing further — their perspectives stay as a record of what was
   proposed and turned down.
4. **Prompt iteration** — since accepted vs. rejected/edited is visible
   directly by diffing perspectives against what downstream `actions` got
   created (no separate logging needed), rereading that gap periodically
   surfaces systematic failure patterns to fix in the prompt, then rerun
   step 1 on whatever's still unreviewed.

## 5. Individual power & group power

**Individual power** = accumulated, authenticity-gated, impact-weighted
history of a person's experiences.

**Revised, 2026-08-16 — power is strictly action-gated, not a floor for
documentation alone.** This corrects the line above (kept struck-through in
spirit, not deleted, so the reasoning that led here isn't lost): the
original position was "individual power has a non-zero floor for honest,
well-reasoned documentation alone, independent of whether anyone else
engages with it." Stefan's sharper read: a bare observation with no action
attached produces no power change, full stop — checking in and looking is
a real, separate, valuable signal (see below), but it isn't power.

This is actually the *more* rigorous Spinozist position, not a departure
from §2's grounding. Spinoza's *potentia* is specifically the capacity to
**act** (*agere*) from one's own nature — passive affects (registering,
observing, undergoing) are, in his technical vocabulary, definitionally the
low end of the power spectrum, not their own credit-worthy category. Mere
observation without action is closer to *being acted upon* than to
exercising power.

This does not exclude careful reasoning or measurement — `entropy_reduction`
actions (§4-adjacent, see the AZOLLA_STATE/EXPERIENCE_PERSPECTIVE section below)
already count a measurement, a test-kit reading, or consulting AI as a real
action. The bar is "something was done," not "the container was physically
transformed" — but a plain status check with no action attached, transformative
or entropy-reducing, produces zero power change.

**A second, deliberately separate concept — not power, not built yet.**
Someone checking in and documenting current status with no action taken
still shows presence and consideration — they looked, and (implicitly)
chose not to act. Spinoza would call this unactualized *potentia* — capacity
that exists whether or not it's currently being exercised. Its purpose is
explicitly instrumental to the experiment design: aligning the short-term
incentive (check your container today) with the group's longer-term
interest (sustained monitoring compounds into problems caught early, more
data, more continuity) — without conflating "I checked in" with "I did
something," which would reopen the passive-documentation-farming problem
this whole design was built to avoid. **Explicitly out of scope for now**
(2026-08-16) — noted so it isn't lost, not being tracked or built.

**Group power** — the part that had to be designed carefully to avoid a
real failure mode caught mid-design: *"this metric would improve if slow
members were removed."* That's exclusion (potestas) masquerading as power.
Fix, structural not aspirational:

- Group power = a **sum**, not a mean, over a **rolling time window** of
  all members' contribution (so attrition is a visible loss, never a
  hidden gain from an improved average).
- Each member's contribution is their **improvement**, weighted with
  **diminishing returns the further along they already are** — lifting a
  struggling member from "azolla dying" to "azolla surviving" counts for
  more than shaving hours off someone already near-optimal. This makes
  helping the weakest member one of the highest-value moves in the system,
  mathematically, not just narratively — and makes exclusion a strict loss
  under every path through the metric.
- Departure/inactivity = explicit loss of that member's ongoing
  contribution to the rolling sum.

## 5a. SASR experience formation (finalized design, 2026-08-16)

The unit is state → action → state → reward. Finalized shape after
extensive prompt-testing against Stefan's real container history:

- **State text** = the existing `CLAIM` perspective (§5, supersedes
  `AZOLLA_STATE`). No new generation step.
- **Experience boundaries are action-gated, not adjacency-gated.** Walk a
  container's states chronologically. Run action extraction
  (`EXPERIENCE_PERSPECTIVE`, renamed 2026-08-22 from `ACTION_HYPOTHESIS` —
  still needed, this is the one piece `CLAIM` can't replace, since it
  requires photo-level citation `CLAIM` doesn't carry) on each
  **consecutive** pair, exactly as already built and tuned. But an
  `experiences` row only gets created for a pair where a real action was
  extracted (`experience_found=true`, renamed from `no_action_found=false`
  — polarity flipped in the same rename) — a plain-observation pair (no
  action) does not close an experience. Maintain a `pending_initial_state`
  pointer per container: it starts at the first state, and only resets
  (to the current state) after an experience closes. A run of several
  plain observations in a row just gets absorbed as background — the
  eventual experience's `initial_state` is whatever was pending, which may
  be several observations back, not necessarily the immediately preceding
  one.
- **No schema change needed.** `experience_components` already just holds
  `state_id`/`action_id` references with no adjacency constraint — this is
  entirely a change to the pairing *algorithm* in the propose script, not
  the data model.
- **One experience per closed transition, multiple actions allowed.** A
  transition with several distinct confirmed actions (e.g. Stefan's Aug
  9→14: manure application + two separate phosphate readings) becomes one
  `experiences` row with multiple `action` components attached — not
  three separate experiences — since reward is computed once per
  `(initial_state, final_state)` span regardless of how many actions
  contributed to it.
- **Reward is computed on demand, not stored.** Consistent with §4's
  original position ("reward is not an AI judgment, plain arithmetic over
  `metric_snapshots`, no scoring table needed") — a coverage-%-delta (or
  other outcome metric) between `initial_state` and `final_state` can
  always be recomputed from `metric_snapshots`, so no new column or table
  is needed to persist it redundantly.
- **Coverage % is a *perceived* metric, not a measured one — provenance
  matters.** It originates as the vision-LLM's `plant_coverage_percent_estimate`
  (`AZOLLA_DUCKWEED_OBSERVATION` perspective), promoted into
  `metrics`/`metric_snapshots` for time-series convenience. "Metric" is the
  storage abstraction (name, unit, tracked over time), source-agnostic — it
  says nothing about reliability. A **measured** metric (a real test-kit
  reading, like Stefan's phosphate/pH readings — not yet wired into
  `metrics` at all, still just observation text) is more trustworthy than a
  **perceived** one (an AI's interpretive read of a photo). A reward
  computed from a perceived metric carries that same uncertainty forward.
  Not yet decided whether provenance becomes an explicit field on `metrics`
  or stays a documented convention — open question.
- **Score (`action_scores`) is not the reward — it's an input to it,
  "environment"-computed separately.** RL framing, confirmed correct: an
  agent takes an action, lands in a new state, and *the environment*
  computes the reward — the action's intrinsic quality (an AI judgment) and
  the environment's outcome (the actual state transition) are different
  things. `action_scores` holds the former: an AI-judged score (number +
  reasoning) of an action's authenticity, causal clarity, innovativeness,
  and entropy-reduction character — not the reward itself. Reward is
  computed by our logic reading the actual state transition (today: the
  coverage-%-delta above; eventually the richer environment-power synthesis
  discussed below), optionally informed by the action_scores judgment as a
  shaping term — the two stay architecturally distinct, never conflated
  into one number.
- **`action_scores.action_id` was `UNIQUE`** (one row per action, ever —
  re-scoring meant `UPDATE`-in-place, losing the trail of how a score
  evolved). **Dropped in migration 016** (2026-08-16) — action impact is
  explicitly retrospective and revisable (§4), so scoring needs to be able
  to run again later as evidence accumulates, as a new row, not an
  overwrite (same multiple-rows-over-time pattern already used by
  `state_perspectives`, most recent row = current). Confirmed safe to drop:
  `action_scores` is currently only read (`EXISTS` checks in
  `lambda/actions/index.js`), nothing depends on the constraint for an
  `ON CONFLICT` upsert.
- **Open, not yet designed: the actual scoring prompt/schema for
  `action_scores`** — a new `scoring_prompts` row scoring each action on
  authenticity (gate), causal clarity, innovativeness, and entropy-reduction,
  producing a number + reasoning. Two open sub-questions: (1) does
  "innovativeness" need cross-participant context (novel relative to what
  others have tried, not just this person's own history) — real scope
  question, no prompt built for cross-container context yet; (2) impact
  can't be assessed at action-time at all — first pass should flag it
  "not yet assessable" rather than guess, revisited on a later scoring pass.
- **Environment power — proposed, not built.** A `state_perspectives` type
  (not a metric) synthesizing a holistic "how much realized potentia does
  this state show" read across whatever metrics+text exist for it —
  distinct from the participant's own individual power. Every mode has its
  own conatus in Spinoza's system; the azolla population's own vigor is a
  different potentia than the participant's causal clarity, coupled to but
  not reducible to it. Reward would then be the delta in this synthesized
  read between `initial_state` and `final_state`, not a single hardcoded
  metric — coverage stays one input to it, not the reward itself. Naming
  not finalized.
- **Power is strictly action-gated** (§5) — a closed experience is the
  only thing that can produce a power change; plain observations
  contribute to neither an experience nor a reward on their own.
- **Some extraction noise is a documentation-practice problem, not a
  prompt-engineering problem — don't chase it indefinitely.** Two real
  cases surfaced during Stefan-data testing, both resolved the same way:
  (1) coverage/metric readings from physically distinct vessels (blue bin,
  black liner, pond liner area) get conflated because they're all tracked
  under one `tool_id` — the fix is Stefan tracking separate assets per
  container going forward, not smarter location-inference in the prompt;
  historical data is deliberately left unsplit (not worth fragile
  retroactive reconstruction from loose text mentions). (2) An action
  described across two different methods on the same day (e.g. chicken
  manure placed two ways) can get its second method misattributed to a
  *later* transition when the evidence for it only surfaces in a
  retrospective recap in a subsequent observation — same root cause as the
  tense/reference bug fixed earlier (§5a pairing logic), resurfacing on a
  sub-action the first pass didn't split out. Decision: acceptable to leave
  — the real fix is writing about an action closer to when it happened, and
  the human-in-the-loop review step (§7's backfill review flow) is the
  intended backstop for exactly this class of residual error, not a
  reason to keep tuning the prompt indefinitely.

## 5b. Extraction hardening and scale-out (2026-08-22)

Ran `EXPERIENCE_PERSPECTIVE` extraction and SASR materialization for real
across all 10 pilot containers (previously only Stefan's). Results: Stefan 8
experiences/17 actions, Wilfred 5/7, Marvin 3/3, Lesterluna 2/3, Mae 1/2,
John Kenneth 1/3, Jusua/Buboy/Chael/Allan 0 (either genuinely sparse
action-reporting or too few real observations to pair — not yet
distinguished; Jusua and Buboy in particular, at 31 and 10 observations
respectively, are worth a closer look before concluding it's real).

**Prompt fixes, in order (each versioned as a new `llm_generation_configs`
row, not an overwrite — see below):**
- **v3 → most-recent-experience lookback.** The prior design only passed
  the *immediately preceding* pair's result as duplicate-reporting context;
  if that pair absorbed (no action), a real action from further back
  dropped out of context entirely. Fixed to walk backward through all prior
  pairs to the last one that actually found an experience, regardless of
  how many absorbed pairs sit in between, and to pass the resulting
  *state* alongside the action (not just the action text) — closer to what
  the "most recent experience" language in this doc's own §5a pairing
  logic already implied.
- **v4 → v5, technical-density fix.** Real, verified regression: a
  phosphate reading ("closest to 10 ppm") was present in the verbatim
  evidence but dropped from the LLM-generated action description under v3.
  v5 reframes the model's role explicitly ("a precise technical field-log
  transcriber... not a casual summarizer") rather than only listing a
  content rule, and the fix was confirmed against the same real case
  post-fix. `report_span` (the verbatim quote) is now also copied
  unmodified into `actions.scoring_data` as a permanent audit trail
  independent of the generated description, so a future paraphrase
  regression is visible by direct comparison rather than trusted on faith.
- **Excludes system-generated states.** A synthetic state (the org-processor
  share-grant backfill record, `captured_by` = the all-zeros placeholder)
  was being read as a real observation and its own "Shared tool ... with
  Azolla Kapwa" text correctly, but wrongly, extracted as a farmer action —
  confirmed reproducing independently on two containers (Stefan's,
  Wilfred's) before being excluded at the query level.

**Two FK bugs, unrelated to prompt quality, that only surfaced once run
against farmers other than Stefan:** `actions.assigned_to` (→
`profiles.user_id`) and `experiences.created_by` (→
`organization_members.id`) both assumed every observation's author has a
fully set-up account. Several participant accounts don't (created via a
lighter intake flow than Stefan's). Both now degrade gracefully — unassigned,
or fall back to any real member of the org — instead of crashing the whole
per-container materialization batch on one missing row.

**`state_perspectives` generalized to actions (migration 023) — concrete
progress toward §7's proposed `AUTHENTICITY` perspective type.** Each
action now gets its own `CLAIM` perspective (a technically-dense factual
account of what was done, the same conceptual thing a state's `CLAIM`
already is) via a new nullable `state_perspectives.action_id` column,
exactly one of `state_id`/`action_id` set per row (`CHECK` constraint) — the
same discriminated-nullable-FK shape `experience_components` already uses
for `state_id`/`action_id`, not a new `entity_type`/`entity_id` polymorphic
pattern or a separate `action_perspectives` table. This directly answers
§7's "mirror the shape into a new table" framing for the authenticity gate:
the mechanism for scoring an *action* via a real perspective row, with its
own `llm_generation_config_id` provenance, already works end-to-end today
for `CLAIM`; `AUTHENTICITY` is the same pattern with a different prompt,
not new infrastructure.

**Versioning/provenance, settled.** `EXPERIENCE_PERSPECTIVE` and the
action-level `CLAIM` both upsert keyed on `(entity, llm_generation_config_id)`
— not just `(entity, perspective_type)`. A rerun under the *same* active
prompt (e.g. because the underlying observation text was corrected) replaces
its own row in place; a rerun under a *new/tuned* prompt (a version bump)
inserts fresh rather than clobbering the prior version's output, which
stays queryable for contrast. The materialized `actions`/`experiences`
rows carry the same `llm_generation_config_id` (in `scoring_data`/
`metadata`) for the same reason — a full container re-run under an
unchanged prompt replaces its own prior `actions`/`experiences` output
(state_links, embeddings, and the action's own `CLAIM` row all cascade
cleanly via FK), while a genuinely new prompt version's output sits
alongside the old rather than overwriting it.

**Review-flow question (§8) — answered, for now, by direct inspection, not
either extreme originally proposed.** Not the batch review-HTML tool
(`azolla-experience-review-gen.js`, built but still unused), not fully
unattended either. In practice: run for real, render the resulting S,A,S
chain as a shareable artifact, read it end to end. This is how the
technical-density regression, the false-positive share-grant action, and a
legacy state missing a `CLAIM` perspective (pre-dates the current pipeline,
never backfilled) were all actually caught — by looking directly at real
extracted output, not through the built-but-unused review UI. Whether this
scales past 10 containers, or the review-HTML tool becomes worth reviving,
is still open.

**Operational friction, unresolved.** Direct local DB access has never
worked in this environment — every run above required temporarily patching
a live production Lambda (`cwf-rsp-worker`) with debug code, deploying,
invoking, then reverting. Worth a small dedicated permanent Lambda for this
specifically, so running extraction stops requiring surgery on production
code each time.

## 6. Self-perpetuation / discovering the group's actual conatus

Per §2's composite-individual point: don't presuppose the group's telos is
"universal 3-day doubling" (that's *our* imposed frame, useful for
individual motivation/legibility, not necessarily what the group will
organically cohere around). The impact-report process should produce two
distinct outputs, not one:

1. **The power snapshot** — individual/group scores against known criteria
   (§5).
2. **A running observation of what's self-perpetuating** — which
   connections renew without prompting, which practices get picked up by
   new people unprompted, which kinds of exchange (diagnostic help,
   tool-borrowing) recur reliably enough to look like a stable pattern
   rather than a one-off. This is exploratory, not scored — it's how the
   group's real conatus gets discovered over the life of the pilot instead
   of assumed upfront.

## 7. Existing infrastructure inventory (reference before building)

| Piece | Location | Status |
|---|---|---|
| Experience (S→A→S') data model | `.kiro/specs/experience-tracking/` | Spec'd (Phase 1: manual/UI only, no scoring) — **extend this, this design's scoring is the next layer on top** |
| `state_perspectives` generalized perspective mechanism | `rsp-worker`, `pending_perspectives`, `cwf-perspectives-queue` | Live in production. **Generalized to actions 2026-08-22** (migration 023, `state_perspectives.action_id`, see §5b) — actions now get their own `CLAIM` through the same mechanism. Add an `AUTHENTICITY` perspective type the same way (§4). |
| `action_scores`/`scoring_prompts` shape | `lambda/core`, `lambda/analysis` | Live for actions only — mirror its shape into a new `experience_scores` table, don't extend the action-specific table directly |
| Energy classification (dynamis/oikonomia/techne) | `.kiro/specs/energeia-membrane/` | Resolved: a computed report over action embeddings, not a table — coincidental conceptual resemblance only, **not an extension point, do not merge** |
| Evidence-weighted scoring | `.kiro/specs/evidence-weighted-scoring/` | Resolved: a prompt-wording fix inside the unrelated Bloom's/capability scorer — **not a scoring mechanism, not an extension point** |
| Cross-org sharing (actions/assets) | `docs/specs/cross-org-sharing.md`, `.kiro/specs/action-sharing/` | Backend live (`POST /shares`), frontend built for actions/assets only |
| Observation-level sharing | `docs/specs/shared-observations.md` | Spec'd, not built, **and not the model this spec uses** (container-level chosen instead) |
| Coverage % pipeline | `scripts/azolla-coverage-*.{js,py}`, `azolla_duckweed_observation_perspectives`, `metric_snapshots` | Live, real data (97 observations, 10 containers — corrected 2026-08-15, see §7) |
| Vision/text perspective pipeline | `state_perspectives`, `rsp-worker` | Live; CLAIM/SIGNIFICANCE/ENTROPY are text-only today, azolla vision perspective is a separate path |
| `epistemic_links` (state-to-state) | schema only | Unused in any Lambda — reserved for replication/help credit (§3) |
| `energeia_cache` | `lambda/energeia/` | **Not** a group-power metric — it's a PCA/k-means cluster map of actions in embedding space. Don't confuse with §5. |

## 8. Status (updated 2026-08-22 — corrects a stale version of this section)

**Done:**
- `EXPERIENCE_PERSPECTIVE` extraction (renamed 2026-08-22 from
  `ACTION_HYPOTHESIS`, see §5a) — built, extensively tuned against real
  data (tense/reference guidance, most-recent-experience context,
  within-observation photo-sequence evidence, action-vs-outcome-description
  separation, `transformative`/`entropy_reduction` classification,
  `expected_state` + confidence inference, technical-density preservation).
  Live in `scripts/azolla-experience-form.js`.
- `AZOLLA_STATE` as a generated perspective — dropped, superseded by
  reusing `CLAIM` directly (§5a).
- SASR experience formation — action-gated boundaries, real
  `experiences`/`experience_components`/`actions` rows, reward computed
  on demand from `metric_snapshots`, versioned by prompt config (§5b).
  **Run for real across all 10 pilot containers** (2026-08-22, see §5b for
  the per-container tally) — previously only Stefan's had been run.
- Actions have their own `CLAIM` perspective (§5b, migration 023) —
  concrete progress toward the `AUTHENTICITY` perspective type below.
- Container-by-container review HTML tool
  (`azolla-experience-review-gen.js`) — built, but still not what's
  actually being used for validation; §5b records what replaced it in
  practice (direct inspection of rendered per-container SASR chains).
- Join flow — confirmed resolved, existing Share button, nothing to build.

**Still open, and relevant to "finish the pilot, pay people" specifically:**
- **Jusua and Buboy extracted zero experiences** (31 and 10 observations
  respectively) — not yet determined whether that's genuinely sparse
  action-reporting or an extraction gap specific to their writing style.
  Worth a closer look before including them in any tally as "no
  contribution."
- **Low-friction extraction workflow** (§5b) — every run so far has
  required temporarily patching a live production Lambda with debug code.
  A small dedicated permanent Lambda for this is the proposed fix, not yet
  built.
- **Review-flow question — partially answered (§5b), not fully settled**:
  direct inspection of a rendered artifact caught real issues at 10-container
  scale, but whether that keeps working as the pilot grows, or the
  review-HTML tool becomes worth reviving, is still open.
- **Individual power score is not built.** Resolved *how* it should work
  (§4: score the action via the existing `action_scores` mechanism, a
  number + reasoning, criteria = authenticity gate + causal clarity +
  innovativeness + entropy-reduction + impact-when-knowable) but the
  actual `scoring_prompts` row and a run against real actions don't exist
  yet. `action_scores.action_id` also still has a `UNIQUE` constraint that
  needs relaxing first (§4) — agreed, not yet migrated.
- **Group power is not computed.** Formula is specified (§5: sum not
  mean, over a rolling window, diminishing returns weighting) but nothing
  reads real data through it yet.
- **New requirement (2026-08-16, not previously in this doc): anonymized
  cross-participant visibility + a public/grant-facing view.**
  Participants should see others' tracking once they've joined, but
  anonymized; the same (or a related) view should be usable publicly, for
  a grant proposal. Needs to be visible inside the existing app, not a
  one-off exported artifact. Not designed yet — anonymization approach,
  what's shown, and where it lives in the app are all open.
- **Payout mechanics** — how a power score converts to PHP/GCash, and the
  mechanics of that conversion. Not discussed. Needed today.
- Anti-gaming review of `epistemic_links` self-asserted credit — lower
  priority, not blocking today's tally.
