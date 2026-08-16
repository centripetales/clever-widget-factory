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

**Renamed twice, 2026-08-15 — `INITIAL_STATE_SYNTHESIS` → `STATE_SYNTHESIS`
→ `AZOLLA_STATE`.** First rename: "initial" was smuggling in a role
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
   generate an `ACTION_HYPOTHESIS` perspective (pair-specific). Either via
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
history of a person's experiences. Has a non-zero floor for honest,
well-reasoned documentation alone (an experience is already internally
relational — cause connected to effect — before it connects to anyone
else's).

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
| `state_perspectives` generalized perspective mechanism | `rsp-worker`, `pending_perspectives`, `cwf-perspectives-queue` | Live in production — add an `AUTHENTICITY` perspective type here (§4) |
| `action_scores`/`scoring_prompts` shape | `lambda/core`, `lambda/analysis` | Live for actions only — mirror its shape into a new `experience_scores` table, don't extend the action-specific table directly |
| Energy classification (dynamis/oikonomia/techne) | `.kiro/specs/energeia-membrane/` | Resolved: a computed report over action embeddings, not a table — coincidental conceptual resemblance only, **not an extension point, do not merge** |
| Evidence-weighted scoring | `.kiro/specs/evidence-weighted-scoring/` | Resolved: a prompt-wording fix inside the unrelated Bloom's/capability scorer — **not a scoring mechanism, not an extension point** |
| Cross-org sharing (actions/assets) | `docs/specs/cross-org-sharing.md`, `.kiro/specs/action-sharing/` | Backend live (`POST /shares`), frontend built for actions/assets only |
| Observation-level sharing | `docs/specs/shared-observations.md` | Spec'd, not built, **and not the model this spec uses** (container-level chosen instead) |
| Coverage % pipeline | `scripts/azolla-coverage-*.{js,py}`, `azolla_duckweed_observation_perspectives`, `metric_snapshots` | Live, real data (97 observations, 10 containers — corrected 2026-08-15, see §7) |
| Vision/text perspective pipeline | `state_perspectives`, `rsp-worker` | Live; CLAIM/SIGNIFICANCE/ENTROPY are text-only today, azolla vision perspective is a separate path |
| `epistemic_links` (state-to-state) | schema only | Unused in any Lambda — reserved for replication/help credit (§3) |
| `energeia_cache` | `lambda/energeia/` | **Not** a group-power metric — it's a PCA/k-means cluster map of actions in embedding space. Don't confuse with §5. |

## 8. Explicitly not yet specified

- **Next concrete piece (highest priority): build the backfill review flow
  (§7)** — pipeline shape is now designed (propose via two new
  `state_perspectives` types → review HTML, container-by-container →
  commit accepted pairs to `actions`/`experiences`). Not yet built. Needed
  before any of the below can run against real data.
- The actual `AZOLLA_STATE` / `ACTION_HYPOTHESIS` prompts
  themselves — pipeline and storage shape are designed, prompt wording is
  not written yet.
- What the AI impact-report agent actually reads per experience (system
  prompt, inputs, output schema) and how often it runs.
- How authenticity gets checked concretely (what signals: internal
  consistency of claim vs. photo evidence, causal specificity of the
  "why," anything else) — the `AUTHENTICITY` `scoring_prompts` row (§4/§7
  point 3), not yet written.
- **Join flow — resolved, no new build needed.** "Joining" Azolla Growing
  is just using the existing Share button + org selector
  (`ShareConfigurationDialog`, §3) on a container, pointed at the Azolla
  Growing org. Nothing new to design here.
- **Metrics/impact-report viewing UI — deliberately deferred.** Don't
  design this until there's real scored data from the backfill pipeline
  (§7) to look at — designing a dashboard around hypothetical numbers
  risks shaping the UI around the wrong things. Revisit once experiences
  are being scored for real.
- Payout mechanics — how a power score converts to PHP/GCash, and the
  mechanics of that conversion (this is Philippines cash/GCash context, not
  yet discussed).
- Anti-gaming review once the above is concrete (self-asserted
  `epistemic_links` in particular need a plausibility check to stop empty
  credit-claiming).
