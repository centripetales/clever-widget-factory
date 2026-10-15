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
> Removed 2026-10-12 (see §2.7): the page no longer has a conversation prompt.
> Kept for the record of what was built.

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
- **Shared tools are browsable by members** (revised 2026-10-11; to be
  refined). A tool shared with a Positive Sum org can be seen by people in
  that org and in its member organizations — in their Assets list and
  wherever a tool is picked. This is how sharing already works in the app.
  It replaces the earlier decision that shared tools are never browsable
  and that there is no Assets "shared items" view.
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
  moved and for next-best options. **A purchase is one claim**: the
  payment, described by what was bought — the goods are not a second
  claim.

Changes to the reward model (apply to every action, not only these):

- **Several next-best options, each for a named party**, each attributed
  to whoever stated it (anyone may state one for either side — it is their
  claim). Replaces the single `next_best_option`.
- **Two kinds:** for the one who paid, what the same thing would have cost
  another way; for the one who received, what they would have had
  otherwise.
- **Hours stay hours, and belong to the org** — never assigned to a named
  person (reducing people to numbers breeds resentment). Pesos appear only
  when someone enters the **opportunity cost of a party's time**: a total
  that stands in for its hours in that action. What is entered is saved
  with the action's rewards (one set per action, kept across rebuilds).
- **Expected advantage** per party, and **value created** (their sum), are
  computed in the app from the claims and next-best options, never stored.

Worked example (the expense that exists): 6 banana suckers from Lester's
parents, ₱200 paid.

| Party | Next-best option (stated by Stefan) | Value created |
|---|---|---|
| Stargazer (paid ₱200) | Asking around: 2 hours | 2 h at the viewer's rate − ₱200 (₱0 at ₱100/h) |
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
  option is extra fields on top (what, ₱ and/or hours, or "no
  other option"), saved as the documenter's own observation. Knowing the
  options expands what the org can do, so **the person who documents a
  next best is credited** ("Documented by").
- **Expected advantage block, always shown** ("expected" for both sides:
  the next best never happened, and the tracker states the other party's
  side from their perspective), one row per party: not asked yet (the
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

### 2.7 Situations and proposed collaborations (2026-10-11, built)
- **A proposed collaboration is an action.** Its **title** is the proposal,
  in full; its **existing state** is the situation it answers, copied as
  text when it is proposed (later rewording of the situation does not
  change it); its desired state is left for later; its author is the
  assignee. Clicking it on the page opens the action. A proposal with no
  situation yet has an empty existing state until it is linked.
- **Joining** makes the person a participant on the action and always puts
  an observation on it: what they wrote about their ideas and how they want
  to be involved, or "Joined". The first join moves the action from open
  proposal to "not started", so it shows in the joiner's Actions list. It
  can be joined until it is done, and deleted only while nobody has joined.
- **Who can open it:** anyone who can see its card — people of the org and
  of its member organizations — and anyone who is on the action.
- Every proposal carries a `positive_sum.collaboration` record (with no
  situation id when unlinked): by its fields alone it would read as a
  situation. Proposals saved earlier, with the text as the desired state,
  are still recognised.
- **The word people see is "situation"**, not challenge: it is close to
  *state* in meaning, and neutral — a situation is where the group thinks a
  higher-advantage option exists, whether it reads as a problem or an
  opening. People state how things are **without a solution**; solutions
  come afterwards, as proposed collaborations. The code and the stored
  records still say `challenge`. On the page the list is headed **"Where
  we could improve"**, and the labels avoid the noun altogether
  (2026-10-12); "situation" remains the word for it in this doc.
- A **challenge** is something a person is running into, in their own
  words: how things are, with nothing proposed yet. Stored as an `actions`
  row with only `description` (no desired state, no policy), status
  `external_proposal`. Everyone in the org sees the open challenges.
- People **vote** for a challenge that matters to them too (the action's
  `participants`), and **propose a collaboration** for it: a desired state
  linked to the challenge by a `positive_sum.collaboration` record.
- The page has one list, **Challenges**; a person's desired states appear
  as **proposed collaborations** under the challenges they address. Anyone
  can **contribute** to one, with a comment about their ideas and how they
  want to be involved (an observation on it); its author sees who is
  contributing and what they said, links it to challenges, and can delete
  it. A person's proposals not yet linked to a challenge are listed last so
  they can be linked. The separate Opportunities, "Ready for you" and "my
  proposed collaborations" sections, and "Plan with Maxwell", are gone
  from the page (2026-10-11).
- **The conversation prompt is removed** (2026-10-12), along with the
  typed form beside it and the rule that held back other people's entries
  until a person had saved a conversation. What people do tells more than
  what they say: the page offers money for observations (§2.8) instead of
  asking people to talk. Everyone sees every entry.
- No new routes: challenges are created through `POST /positive-sum/goals`
  (`{ challenge }`, or `{ challenge_id }` for a collaboration), voting and
  taking part go through `POST /positive-sum/options/{id}/join`, and the
  list comes back from `GET /positive-sum/mine`.

### 2.8 Offered rewards on a shared action (decided 2026-10-12; steps 1–3 built)
RL framing: the network is one shared environment. Someone changes it by
attaching a **reward** to an action; the action stays shared, and what is
individual is the reward each person earns by taking it. An offered reward
is set in advance by its owner. What actually moved (the Rewards section,
expenses) is separate; a payout is an expense. A price on a good is the same
structure: a standing reward on a capability.

First use: under "Evidence of existing state and capabilities is lacking",
₱5 for each observation with a photo and a description. It is payment now
for expected future impact; Stargazer Farm seeds it. No rules on what
people share.

- **Reward:** attached to a proposed collaboration by its author; paid by
  the organization they are working as (Stargazer Farm); earned by a
  **person**. Conditions the owner sets: the amount, requires a photo,
  requires a description, observations private, and a **cap per person**
  (₱500 for the first one). It can be closed, after which new observations
  stop counting. **Terms are fixed once set**: to change them the owner
  closes the reward and adds another.
- **Earned is derived, not stored.** A qualifying observation is the reward
  event; what a person has earned is counted from their observations under
  the reward's terms. Payouts are real expenses; owed is the difference.
  No second ledger, so the figures cannot drift from the evidence, and
  another party can **layer** its own reward on the same action without
  touching the first. A ledger becomes worth having for network credit.
- **Agreement is per reward**, since each reward's owner sees what it pays
  for: a person joins the action once and accepts each reward separately.
- **Content conditions** (e.g. ₱20 for showing how cogon is dealt with):
  the person links an observation to the action, a perspective reads it
  against the owner's condition and says what it saw, and the owner can
  overrule it. One action is one thing to do; rewards on it are the
  parties paying for that thing.
- **Joining is the agreement.** Join shows who sees what is shared and how
  it may be used, and records that the person agreed and when. Wording is
  general on purpose: research and activities that benefit the group, such
  as grant proposals, including with partners outside the Philippines.
  Only observations added after joining count.
- **Private observations on a shared action:** shown only to the person
  who made them and to the paying organization (Stargazer Farm, which
  makes the payouts). Other organizations never see another org's
  observations; this condition adds the same between colleagues.
- **Tallies are public:** everyone sees each person's count and amount.
- **Payment is digital, for traceability.** Each person sets how they are
  paid on their profile (method and account, e.g. a GCash number), seen
  only by whoever pays. A payout records its reference number; the expense
  in Finances carries the same one. Earned amounts wait until the person
  has set a payment method.
- **Findings are shared back** with everyone, without names: counts first,
  AI analysis once there is data to write a prompt against.
- Not in this: the US LLC as funder or owner (too much paperwork for the
  size of the experiment; revisit if the data proves valuable), network
  credit, limits on content, automatic payouts.
- Known limit: photo files open for anyone who has their web address.
  "Private" means not shown to others in the app.

Build order: (1) the reward on an action and its display; (2) joining
with the agreement; (3) the tally, public; (4) payment method, payouts and
closing; (5) private listing of observations, Stargazer's view of all of
them, and findings.

### 2.9 Offers, and the reading that pays them (decided 2026-10-12; built, not yet deployed or tried on real observations)
RL framing: an **offer** is a standing **policy** of the payer ("when an
observation shows X, I pay Y"). Seen from the person acting, another
agent's paying policy is part of the environment, i.e. their reward
function. No separate environment concept is needed: the Positive Sum
network and its shared record are the environment. Policies layer
(organic farming; plant at the start of dry season; an offer) and project
onto an action at the time it is done; offers layer the same way, several
on one action, each with its own payer, condition and cap.

- **The page leads with Offers** (2026-10-12): making an offer is the more
  realistic path when working with farmers than asking where things could
  improve. The section lists every open offer in the organization and has
  "Make an offer": what you want, the price for one observation, the most
  one person can earn, and how an observation is valued. What you want is
  saved as a proposed collaboration (an action) with the reward on it, not
  placed under anything in "Where we could improve".
- **An offer carries its ask**: what the payer is looking for, in plain
  words with examples, and what counts as a repeat. The ask can be reworded
  as the payer learns; price and cap stay fixed once someone has agreed.
- **Two offers to start with** (2026-10-12), each simple; several simple
  offers are preferred over one with many conditions: (1) ₱5 for an
  observation, counted by rule, no reading; (2) farming practices, where
  the AI decides what an observation is worth by how much it adds to what
  that person already shared, up to ₱400 per person. A third, separate
  offer pays for what is new to the whole network: the most valuable
  kind, since that is how the network comes to know more than any one
  member (a "super agent"). Which of the two an offer pays for is said in
  its prompt. The reading works from the person's words only (2026-10-12):
  photos are not sent to the model, as with the other perspectives,
  because image analysis was costly and brought bad data into the record.
  So a different place counts only when the words say so. Offers about
  applying a practice or crop prices come later, as their own offers.
- **An offer is a prompt plus hard limits** (2026-10-12). Its record holds
  an `evaluator` (`{ kind: 'prompt', prompt }`: what the payer wants and
  how they value it, in their own words, shown in full to everyone) and
  the limits the code enforces: `max_php_per_observation`,
  `max_php_per_person` and `budget_php` (the most the offer pays in total).
  All the logic is in the prompt, including what "new" is measured against
  (the reading is always given this person's earlier notes and other
  people's). The limits are data, not prose, so what a payer can lose never
  rests on a model reading a sentence correctly. Value is a matter of
  degree, not a yes-or-no rule.
- **The evaluator can change kind later.** Rewards are expected to need
  code and several queries eventually, which is what a skill is (a
  description, instructions, and tools it can call); a reward function is a
  function. The path: prompt only (built) → prompt with fixed queries the
  code runs for it (counts, lookups) → tools it chooses → code. Only the
  prompt kind exists; nothing else about an offer depends on the kind.
- **One reading per observation**: an `OFFERS` perspective written by the
  worker that already writes claim / significance / entropy. For each offer
  it records `php` and `feedback`. The model fills `shows`, an amount and
  `feedback`; the code rounds the amount to the peso and holds it to the
  three limits, going by earlier readings. The tally is the sum over these
  readings.
- **What was shared shows under the offer** (2026-10-13): a row for each
  observation with the person's words, what the offer credited and the
  feedback. A person sees their own; the offer's owner, who pays, sees
  everyone's; others see only the counts. Its author can add detail in
  place: saving sends it to be read again, the row shows it is being read,
  and the amount can rise but never falls (it shows "₱3 → ₱5" when it
  rose). A re-read compares only with observations made before it, and
  what an observation earned from an offer that has since closed is kept.
- **Changing and showing offers** (2026-10-15): the owner can change an
  offer read by AI at any time while it is open (no lock once others'
  observations are read); what was credited stays and later readings use the
  change. Offers are listed newest first. When the worker starts or finishes
  an OFFERS reading it broadcasts an `action` invalidation for the offer's
  action; a page reloads Positive Sum only for an action it shows, or a new
  one. On an offer: one filled action ("Share an observation" / "Earn this"),
  the owner's Edit and Close in a menu (Close confirms); once a person has
  joined, the header shortens to what one share is worth and who pays (full
  terms in the ⓘ, whose ask is shown as Markdown). The person's progress sits
  top right: "You: n shared · ₱x of ₱cap", a bar, and the offer's optional
  picture, gray until they reach the per-person cap, then in color. A credited
  amount of one's own is stamped in with a coin from the feedback.
- **A reward with no prompt** pays its amount for any photo with a
  description, by rule and without a reading (the first ₱5 offer).
- **Default to trust**: an observation counts unless it clearly shows
  nothing the offer asks for, or repeats what the person already shared.
  Nothing is credited until its reading arrives: the person sees that it is being read, never an amount that later shrinks. The reading describes the
  observation, never the person. The payer can overturn a reading.
- **The contributor sees the reading**: it is the basis for what they are
  paid and points them to what would earn more.
- **Linking is done for them**: where a reading counts, the worker links
  the observation to that offer's action. Nobody picks where it goes.
- **Which observations are read**: one made through Positive Sum is shared
  by default and is read against all open offers. Nothing else a person
  records is scanned. "Share with Positive Sum" for an observation made
  elsewhere is put off: people are expected to go through Positive Sum.
- **How it is built**: an offer is a reward with a prompt (set under "Make
  an offer" or "Add a reward"). "Share an observation" on the offer opens the
  usual add-observation page linked to the offer's action; being linked to
  an action that carries an open reward is what "made through Positive
  Sum" means. `lambda/rsp-worker/offers.js` then reads it against every
  open offer with a prompt in that network and writes the `OFFERS`
  perspective. It works from the person's words only (2026-10-12): photos
  are not sent, as with the other perspectives, because image analysis was
  costly and brought bad data into the record. Positive Sum shows the
  person the reading of their latest observation on each offer.
- **One agreement**: sharing through Positive Sum is the agreement to every
  offer that is read. A person agrees once ("Earn this" on any such offer),
  recorded as `positive_sum.sharing_agreement`; the tally counts their
  observations from then on.
- **Example offers**: document organic and non-organic practices (₱5, new
  for the person); a practice new to the community (compared with
  everyone's); applying an organic practice (shown being done; doing it
  again on another day counts); crop prices (crop, price and unit; a repeat
  is the same crop, place and day). Prices come out structured and can be
  shown back as a price list.
- **Offers already agreed to** under the photo-with-description rule keep
  that rule.
- **An offer for how people operate has no other option** (2026-10-15): for
  the payer, it is the expected-advantage case "no other option"
  (capability expanding, advantage not evaluated), not a next best with a
  price. The data is what a person does when they have flexibility, and the
  only other way to collect it, sending someone to shadow them, would
  change how they operate. Paying also nudges what people share, but less,
  and in the direction the offer chose. When network credit is built, such
  offers count as capability expanding.
- **Open**: whether the payer can overturn a reading both ways or only in the
  contributor's favour; converting offers to `policy` records (an action
  links to one policy today, layering needs many); a way for the payer to
  overturn a reading, the price list from price offers, and a repeat rule
  held as data (today it is whatever the ask says in words) are not built.
- **Unverified**: consistent practice labels from a small model; reading a
  price off a photo; replies in Hiligaynon; cost per reading.

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

### 3.6 Credit for trailblazing and for replicating (idea, 2026-10-12; nothing built)
When something one person introduced is taken up by someone else, both are
credited: the first for blazing the trail, the second for replicating it.
The credit is a collectible character (in the manner of an anime hero with
a weapon and a three-second clip), held by their **organization**, not the
person. Not an NFT: it lives in the app. It marks an event; it is not a
score or a ranking. The trigger would come from the offers reading (§2.9),
which already notices when an observation matches what someone else shared;
it would also need to know who was first and that the new observation shows
the thing being done, not only seen.

Replication is put off (2026-10-12): it is about applying a new
**capability**, and capabilities are not listed yet. What exists are past
actions that stand for them (Stargazer Farm: make VCO, plant bananas,
jackhammer rock). The trailblazing half, an image for what is new to the
network, can go ahead without it.

What gets replicated is a **policy** (2026-10-12): a specific practice
such as an organic farming practice. One organization states it and does
it; another takes that same policy onto an action of its own. That gives
replication something to match on that already exists in the app (`policy`
records, linked from actions), instead of comparing observations. It needs
policies to be visible across organizations in the network, and an action
to be able to carry more than one (see the open item in §2.9).

Revised the same day: this is not a shared list of policies; it is part of
the offer flow, and an offer's conditions are fully visible (§2.9). An
offer can give an image to collect as well as money. The image is held by
the **person**. It shows the **expected value** generated, the figure the
Rewards section already works out ("Value created"). No new concept or
score is introduced for it. For grant funding the same shape applies: a visible prompt that
makes payouts from estimated impact and adoption.

### 3.7 Deferred
Crediting help in the value measure beyond approvals (e.g. observations on
shared tools, amounts saved); anonymized matchmaking; experiences as a source
of policies; lazy-loading and an extension registry; a ChatGPT/Claude
connector (per-person OAuth is blocked by open issues on Claude's side).
