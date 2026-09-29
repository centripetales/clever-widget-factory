# Positive Sum — design

**Status:** design/roadmap, 2026-09-29. Part 1 ("Built") describes what PR #166
ships; parts 2–4 are decided but not built, and will drift as they're
implemented — update this doc as pieces land.

Positive Sum is a way for members of a network (starting with a neighbor
farmer co-op) to create more value together than apart: 1+1=3. Value
returns from the network, not from each transaction. The software supports
people coordinating and documenting; it is not about control.

## Vocabulary (use these words)

RL framing: goal-conditioned policies and the options framework.

| Term | Meaning | Stored as |
|---|---|---|
| **Desired state** (internally *goal*) | What someone would like to be different: an initial state and a desired state, stated explicitly. UI: "What would you like to be different?" | an `actions` row: `description` (initial) + `expected_state`, no policy, status `external_proposal` |
| **Policy** | An **org's** rules and values — the template for *how* actions are built (e.g. "We're an organic farm; we seek to increase diversity and the soil microbiome"; "we value people who are on time"). Never personal. | `policy` table (needs `organization_id`, see [TODO-POLICY-ORG-ID](TODO-POLICY-ORG-ID.md)) |
| **Capability** | *Which* actions a person or org can build — their action space, like a résumé. Inferred, not declared. | not stored: a similarity search over their actions and observations (see §3.5) |
| **Option** | A capability applied to a situation: initial state (when it applies / conditions) → how it's done → final state (what counts as done). Either aimed at a desired state or open to anyone who fits. | an `actions` row with status `external_proposal` + an `option_context` record |
| **Action** | A chosen option being carried out. | ordinary action |
| **Experience** | What actually happened, with evidence (observations, photos). | observations on the action |
| **Implementor / recipient** | Who carries out or provides / whose state changes. One action can have several of each. | `assigned_to` + `participants`; recipients via the option's linked desired states |

Not used: *match*, *agreement*, *request*, *need*, *offer* (offers are
replaced by capabilities + open options), *board*/*post*.

## Principles

- **Information is always free**; resources are what's coordinated.
- **Low friction, natural language.** Don't define structure for things that
  may go a different direction; let people write naturally and have an LLM
  pull out what's needed when it's needed.
- **Not about control.** No software gates on stewardship (e.g. photos at
  pickup/return are what a good steward chooses to do). People demonstrate
  their own stewardship.
- **Visibility is flexible, not uniform.** Seeing everything can hurt the
  sharer (inventories used against them, jealousy). Membership marks
  eligibility; what surfaces is decided by contribution.
- **Scarcity drives engagement.** Opportunities arrive a few at a time, not
  as a feed or catalog.
- **Reputation is personal; value is relative.** Contribution is tracked per
  person (and org); what counts as value comes from each org's policy.
- **Logic differences are org settings**, not new concepts.
- **Every LLM run records its context** (model + prompt version via
  `llm_generation_configs`, and the exact inputs) so generation can be
  audited and debugged.

## 1. Built (PR #166)

- **Positive Sum is an org feature.** On when an org's
  `settings.enabled_features` includes `positive_sum` (opt-in: orgs without a
  list don't get it). The Dashboard shows a "Positive Sum · <org>" card per
  org the person belongs to that has it on; `/positive-sum/:orgId` works
  within that org.
- **Routes** (`lambda/actions/positiveSum.js`, served by `cwf-actions-lambda`):
  desired states, options, join, approve, pass, opportunities, mine — all
  limited to orgs the person belongs to. Bookkeeping (option context/lineage,
  approvals, passes, daily lists) are JSON states prefixed
  `{"type":"positive_sum.` and hidden from observation feeds.
- **Approval:** options are suggested by implementors; recipients approve for
  their desired state; every implementor must agree unless the association
  default applies (a completed, photographed experience with a similar
  option). An option's action starts at its first observation; completing it
  completes the desired states it served.
- **Opportunities** live inside the Positive Sum page (per org): open desired
  states and options with free capacity, ~5 items, built on the first visit
  of a farm day (Asia/Manila) and the same list for the rest of that day.
- **Ready for you:** options suggested for your desired states, and options
  that build on yours, waiting for your approval.
- **Offers are retired.** An option can build on someone's open options
  (`source_option_ids`); their implementors implement it.
- **Maxwell:** action group `PositiveSum` (`getGoalContext`, `createOption`)
  on agent version 33; a skill prompt when Maxwell is opened on a desired
  state ("Plan with Maxwell"). Options are shaped in conversation and saved
  only on explicit confirmation; no compensation terms.

## 2. Decided, to build next

### 2.1 Positive Sum page as a conversation (branch `positive-sum-conversation`)
- The page's main path is a **copyable prompt** for the person's own AI
  (Gemini, ChatGPT, Claude). The AI presents the mission and vision (stubbed
  until policies hold them), what's expected of members, then asks about
  their **capabilities** — **human capital** (skills, experience) and
  **assets** they want to track — and what they'd like to be different, and
  discusses today's opportunities (a snapshot in the prompt). It returns JSON
  (`src/lib/positiveSumConversation.ts`) that the person pastes back, reviews
  and saves. The form stays under "or type it yourself".
- Desired states → Positive Sum goals in the page's org. Human capital →
  profile skills (narrative only, `source: 'claimed'` — describing a
  capability is not a commitment; we collect, we don't judge). Assets →
  tools or stock in the person's own org. The API client can target an org
  per request (`X-Organization-Id`, validated by the authorizer).
- **Tool availability** is derived: a tool is *in use* while an in-progress
  action (any org) requires it; the first observation on an action with a
  required tool starts it. No checkout links, nothing stored on the tool.

### 2.2 Policies
- `policy` table gains `organization_id` (always an org). A **Policy tile**
  per org; **admins and leadership write, members read**.
- Non-negotiables are just text in the org's policy ("we never lend our
  tools onward"); composing LLMs must respect them.

### 2.3 Borrowing
- Tools are **shared with the org behind the scenes** (never browsable);
  sharing a tool with a Positive Sum org creates an **open option** for it
  (terms from the tool's own policy field). No Assets "shared items" toggle.
- **Request to borrow creates an action**, prefilled from what the requester
  provided (initial and desired state), the tool as required tool,
  requester + lender as participants, and the **composed policy** on it.
  Observations (condition at pickup, return date, extensions, return) attach
  to the action and appear in the tool's history.
- **Policy composition** — no hard tool→policy link. An LLM composes the
  policy for *this person, this tool, this situation* from: the situation
  (incl. the tool's own terms), the relevant org policies (owning org's and
  the association's, by scope + similarity), and the person (their similar
  past actions and observations — §3.5). Novices get explicit steps; trusted
  experts get "use your best practices". The action's `policy` text keeps
  the composed result as of that time; a context record keeps model, prompt
  version, source policy ids and the person context used.
- The lender sees the requester's **most recent transactions** when deciding.
- **"Ready for you"** on the Dashboard shows requests to everyone in the org
  that owns the item.
- **Coordinate in Messenger:** opens the owning org's Messenger **group chat**
  (invite link stored as an org setting; who leads the conversation is a
  human arrangement). Each person can add their Messenger username to their
  profile (member settings), opt-in.

### 2.4 Who helped (cross-org participants)
- Help is recorded as action `participants`, across orgs — not `@mentions`,
  which people forget (partial data would bias rankings).
- Participant picker never lists everyone: own org first → "worked with
  before" → suggested for this action (owners of shared assets it requires;
  names spotted in its observations) → search by **person or org name**,
  matching only orgs you share.
- Participants can see the action they're in (a narrow grant); names resolve
  across orgs.
- Using another org's shared asset in your action counts as help from that
  org automatically.

### 2.5 Org-to-org membership
- A table linking an org to a member org (`organization_id`,
  `member_organization_id`, `status`, `created_by`, `created_at`,
  `ended_at`; one level). Membership marks **eligibility only** — it opens
  nothing by itself.
- One central visibility rule in the shared layer ("is this item mine, or
  visible to me?") replaces the per-lambda `view_shared` copies and the
  missing detail-endpoint checks.
- Replaces the dormant partner code in the authorizers
  ([PARTNER_AGENCY_RBAC](PARTNER_AGENCY_RBAC.md)), which would grant
  whole-org access and never had its tables created.

## 3. Direction (decided in principle, details open)

### 3.1 Reach follows give and receive
Each desired state starts with a default reach (shown to a set number of
people). Reach grows for people who generate value for others; people with
high value to others see each other's desired states first. What counts as
value is read through each org's policy (e.g. Stargazer values being on time
and records how well people honor their word) — no scores or fields.

### 3.2 Group action and leads
"Who wants to grow pineapple with us?" and "where can I find fish guts /
carbonized rice hull / an oil drum?" are desired states and options written
in natural language; responses are natural text. No quantity fields or reply
types — an LLM pulls out totals or leads when needed.

### 3.3 Recording help after the fact
An action (e.g. with the helper's shared vehicle as required tool) plus the
recipient's observation of what it made possible (₱3,000 instead of ₱6,000;
on time), with the helper as participant.

### 3.4 Onboarding without history
A "Get started" prompt the person copies into their own AI (Gemini, Claude,
ChatGPT — free, voice, their language). The AI interviews them and returns
JSON; the app shows a preview to edit/confirm. Seeds: self-described
capabilities and experience (observations, marked self-described),
assets, desired states, and — for someone setting up an org — a draft org
policy. **It should also set up the person's reward** (what they value, so
impact can be read relative to it); the reward's shape is not defined yet,
but this is the right place for it.

### 3.5 Capability as search
No stored profiles and no scores (LLM-built profiles were too expensive and
too much judging). A capability is a similarity search over a person's or
org's actions and observations, grouped by who did them, with counts and
recency; an LLM reasons over a handful of results only at the moment of use
(composing a policy, suggesting an option). Existing per-action capability
assessments and learning objectives are unchanged.

### 3.6 Deferred
Crediting help in the value measure beyond approvals (e.g. observations on
shared tools, amounts saved); anonymized matchmaking; experiences as a source
of policies; lazy-loading and an extension registry; a ChatGPT/Claude
connector (per-person OAuth is blocked by open issues on Claude's side).
