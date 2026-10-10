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
| **Desired state** (internally *goal*) | What someone would like to be different, in their own words — no imposed structure, so we learn what they actually want to say. The initial state is recorded on the action when a real deal happens. UI: "What would you like to be different?" | an `actions` row: `expected_state` (their words); `description` (initial state) optional, from older goals; no policy, status `external_proposal` |
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
  (Gemini, ChatGPT, Claude). The AI greets ("Hello, or should I say Maayong aga/hapon/gab-i?",
  by the hour), continues in the language they answer in, explains the
  idea (value you create for others comes back through the network),
  answers questions from background it carries (the Farmer association
  doc's principles; the network supports those who support others,
  offers non-contributors ways to contribute, and excludes people who harm
  the community), then asks about
  their **capabilities** (skills and experience) and what they'd like to be
  different, and
  discusses today's opportunities (a snapshot in the prompt). It returns JSON
  (`src/lib/positiveSumConversation.ts`) that the person pastes back, reviews
  and saves. The form stays under "or type it yourself".
- Desired states → Positive Sum goals in the page's org. Human capital →
  profile skills (narrative only, `source: 'claimed'` — describing a
  capability is not a commitment; we collect, we don't judge). Physical
  assets stay out of the conversation: people add and share them in the app
  as they're ready. The API client can target an org
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

### 2.6 Rewards from a transaction (decided 2026-10-10)
Rewards belong to actions (RL: reward is of an action). A person recording
an expense should not have to create one, so the action is made for them —
and only when they use the reward flow. A plain expense stays a plain
expense.

- **Where:** Transaction Detail gets an expandable **Rewards** section, the
  same as on an action. Opening it creates nothing.
- **First build — draft, review, save.** An LLM drafts from the expense
  (description, photo descriptions, amount, date — a stock adjustment is not
  linked to its expense in the data, so it is not part of the draft): the
  **other organization** (the seller), the **existing state** and the
  **final state** (the inventory change, e.g. "no banana suckers" → "6
  banana suckers for the hillside rows"). The person confirms or edits;
  then the action is created and the rewards build.
- **The action:** in the expense's org; **assignee = the person tracking
  the transaction** (the one who recorded it; they are responsible for
  the record); already
  completed, dated the transaction date; `description` = existing state,
  `expected_state` = final state. It is reached **only via the
  transaction** — not in everyday action lists.
- **One observation, linked to both.** The expense's observation
  (description + photos) is also linked to the action; nothing is copied.
  The Rewards section has a short input for more ("what would you have done
  otherwise?"); each is an observation linked to both the transaction and
  the action. Another party who wants to give their perspective adds
  observations the same way.
- **The other organization is an org, not a person.** If it isn't in the
  app, a **small create-organization flow** runs inside the review:
  similar names from **all orgs, names only**, are shown so the person
  picks an existing one or confirms theirs is new. Anyone can create an
  org this way; the creator is **not** made a member of it (a super-admin
  is seeded as today). The chosen org and the transaction are kept in a
  `positive_sum.` bookkeeping record on the action and given to the reward
  build as context.
- **The paid amount is a fact, not a claim to find.** Amount, date and
  paying org come from the transaction; the LLM only looks for what else
  moved and for next-best options.

Changes to the reward model (apply to every action, not only these):

- **Several next-best options, each for a named party**, each attributed
  to whoever stated it (anyone may state one for either side — it is their
  claim). Replaces the single `next_best_option`.
- **Two kinds:** for the one who paid, what the same thing would have cost
  another way; for the one who received, what they would have had
  otherwise.
- **Hours stay hours**, with who would have done them. Pesos appear only
  on view, through the existing "My hour is worth ₱ / Calc my break-even"
  control. Nothing about rates is stored.
- **Value created** per party and in total is computed in the app from
  the claims and next-best options, never stored — as "Saved" is today.

Worked example (the expense that exists): 6 banana suckers from Lester's
parents, ₱200 paid.

| Party | Next-best option (stated by Stefan) | Value created |
|---|---|---|
| Stargazer (paid ₱200) | May coordinates it: 2 hours | 2 h at the viewer's rate − ₱200 (₱0 at ₱100/h) |
| Lester's parents (received ₱200) | Suckers left in the clump: ~₱10 | ₱200 − ₱10 = ₱190 |

Built from the revision: the Advantage block with next-best fields and
"no other option" (reward prompt `reward-v8`), and the expense review
reduced to the other organization. Not built: neighborhood price, time
perspective.

Code (written 2026-10-10): `lambda/actions/transaction.js`
(routes `/financial-records/{id}/action[/draft]` and
`/positive-sum/organizations`, added by
`scripts/add-transaction-reward-endpoints.sh`), reward prompt `reward-v7`,
`TransactionRewards.tsx` on Transaction Detail. Rewards built before v7
still show; a rebuild moves them to the new shape.

Revised after the first run on a real expense (2026-10-10, not built):

- **Reward vs advantage.** A reward is what moved because of an action;
  a cash transfer is a recorded fact (the expense). **Advantage** is the
  claim: the reward against the party's next-best option, which never
  happened and is always someone's estimate. Advantage is what we are
  after; it is computed, never stored.
- **No existing/final state in the expense review.** The description
  already says what was traded; the review asks only for the other
  organization.
- **Expenses are not forced into the action reward flow.** One person
  (Mae) keeps the expenses; others track actions. A payment someone states
  on an action stays their claim, and an expense stays its recorder's; the
  two are not reconciled or required to match. Not bureaucratic.
- **Keep the auditable path; add next-best fields.** What moved stays as
  claims grounded in what people recorded. Documenting a party's next-best
  option is extra fields on top (what, ₱ and/or hours, whose hours, or "no
  other option"), saved as the documenter's own observation. Knowing the
  options expands what the org can do, so **the person who documents a
  next best is credited** ("Documented by").
- **Advantage block, always shown**, one row per party: not asked yet (the
  row is the prompt — "What would <party> have done otherwise to get
  this?") / next best stated → advantage / **no other option** →
  capability expanding, advantage not evaluated ("not buying" is a
  non-action, not a next best). The tracker states both sides; other
  parties are not expected to comment.
- **Neighborhood price as the next best.** The reward build pulls similar
  transactions (for now mostly the org's own past purchases) and derives a
  price for the same thing; it shows the transactions it used so the
  baseline stays a claim with evidence.
- **Time as a perspective on an observation**: hours spent, by whom, on
  what or whom (e.g. the SEC) — as stated, or estimated when not stated
  and marked as such — so time can be totalled across observations. (The
  existing `time-perspective-worker` estimates whole days and stores
  summary observations; this is per observation.)
- **Later:** after a sale, asking "make this available to others in your
  network?"; **network credit**, which flows from the advantage a person
  provided to others and is simple once advantage can be calculated.

Open:
- Sales (money coming in) — the mirror of this; not in the first slice.
- An org created this way has no people. How its own people later join
  and take it over is not defined.
- What a later edit or delete of the expense does to its action.

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
