# Experiments as actions: existing states on actions, experiences to share

**Status:** Ready to build.
**Audience:** the coding agent implementing this. Read the whole spec before starting. Follow
`CLAUDE.md` in the repo root: surgical changes only, no extra fields, no refactoring nearby code.
If anything here conflicts with what you find in the code, stop and ask; do not guess.

## Why

An action already holds most of an experiment: an existing state, a desired state, and
observations with photos (the Implementation tab). What's missing is that nothing marks which of
an action's observations is its existing state, and the existing state can be written twice on
the action form (the "Existing State" text box, and the text and photos saved as an observation).
So turning an action into a learning experience means rebuilding it by hand.

This spec makes the action's existing state one observation, marked as such by an
**`existing_state` link** to the action, and turns an action into an **experience** in
one click: the existing state, the action, and the action's later observations as next states.
No separate experience flow is needed: people record experiments as actions (often created by
Claude, where creating one costs nothing), and the experience falls out of the record.

**Experiences are what others draw on**: for learning, opportunities and group dynamics, and to
replicate. If mani mani planting takes hold, that experience is something a neighbour can try to
repeat (and get mani mani for). An experience is something a person puts forward with their name
on it, so it is created only when they choose to, from a record they can trim. The app does not
ask them to write instructions or a conclusion. A synthesis of what an experience shows is made on
request by Claude, from everything recorded.

Existing states are also worth finding on their own: they are the states that led someone to
act. Marking them with a link makes them searchable as a set, and lets one state be the existing
state of several actions, or the next state of one action and the existing state of the next.

Example to test against: cogon grass on a patch below the learning center terraces is crimped,
then chicken manure is spread on top, to see whether the manure and heavy crimped mulch break
down the cogon roots and leave a fertile, water-holding area. A stake with "C3" written on it
marks the patch. Next states are observed over weeks.

## Vocabulary (use these words in code, UI and tool descriptions)

The words follow the reinforcement-learning transition (s, a, r, s′). A state is only what is
observed, never a judgement of whether it is good (that would be the reward, which is not
recorded here). Observations are rows in `states`; "observation" is what the app calls a state
on screen.

- **Existing state** (s): how things were when the action was taken. Do not call it the
  "situation", "trigger" or "initial state" in the UI or tool descriptions.
- **Next state** (s′): an observation on the action after its existing state, including
  "no change yet". An action can have many next states over time.
- **Experience**: the record of an action (or several) that someone puts forward for others to
  learn from and replicate.
- **Marker**: whatever physically labels an asset in the field: a stake, tape, a number painted
  on a tree. Not a data type. What is written on it is the asset's **serial number**.
- **Conclude (an asset)**: its purpose is complete, or we can no longer or no longer wish to work
  with it. It leaves day-to-day tracking, but it and its history stay, and its experiences can
  be shared. Distinct from **remove** (delete), which means it should not have been there.

## Decisions already made (do not revisit)

1. **The existing state is a state, linked to the action twice.** The observation keeps its
   ordinary link (`state_links.entity_type = 'action'`, `entity_id` = the action), so it shows on
   the action as today, and gets a second link `entity_type = 'existing_state'`,
   `entity_id` = the action. This follows the existing pattern of typed links (`part_of`,
   `ends`). **No new column and no migration.**
2. One state can be the existing state of several actions (one `existing_state` link per action).
   An action normally has one existing state.
3. **The action form has one input for the existing state.** The "Existing State" text box and the
   photo panel together create the existing-state observation when the action is saved. The
   photo panel's own text box is removed. Its hint reads "What is the existing state? Saved as
   this action's existing state once you save the action below." (already changed).
4. **Next states need no marking.** They are the action's other observations captured after its
   existing state, in time order. Whether a later observation shows the work or the result is
   sorted out by the person on the experience page, not recorded on the observation.
5. **Existing observations are not changed.** Nothing is backfilled. Older actions have no
   `existing_state` link; their `description` text stays as it is.
6. **Record everything.** "No change yet" is a next state too (nitrogen having no effect on
   bananas in week 1 matters). Nothing is dropped.
7. **No reflection or conclusion record, and no extra field at Done.** Done completes the action
   as today. Synthesis is Claude's job, on request.
8. **An action is open until it is completed (closed).** Nothing else tracks its progress: no
   status is added to experiences and no follow-up date is stored. An experience can be made
   from an action at any time, open or closed, and making one does not change the action. It is
   created only when a person makes one, and is stored as today
   (`experience_components` pointing at states and actions), so what was put forward does not
   change when later observations are added.
9. **No in-app AI drafting** and no "how would someone repeat this?" prompt.
10. An action needs no asset or marker. When a person does want a trial spot tracked, it is
    added as a **tool** (category `Field`) whose serial number is what is written on its marker
    and whose description says where it is, through the normal add-asset form or Claude's
    `create_asset`. Then the action is on it.
11. Assets get a new tool status **`concluded`**. Parts are unchanged (they have no status). A
    concluded asset is **not locked**: observations and edits still work, and it can be made
    available again. Concluding is never automatic.
12. Serial numbers become **unique per organization among tools that are not `removed` or
    `concluded`**, compared case-insensitively with surrounding spaces ignored. Blank and null
    serials never clash. A concluded marker's number can be reused.
13. The experiences table keeps its leg name `final_state`. Next states go in that leg; on screen
    it is labelled "Observations". Do not rename database fields.

## Out of scope

- A replicate button on experiences (likely later: it would create an action for the person
  replicating, recording which experience it came from). Add no field for it now.
- Moving the material for a replication between farms (e.g. mani mani cuttings).
- Claims, evidence strength, or any stored synthesis on experiences.
- Coordinates, KML polygons, maps.
- The action form's file-upload `attachments`: unchanged.
- Backfilling existing-state links on older actions.
- Choosing an already recorded state as a new action's existing state (a picker). Likely later;
  the `existing_state` link already allows it.
- Any experience-specific creation page or Dashboard tile.
- Any change to Done: it completes an action exactly as today. Concluding an asset happens only
  from the asset list (or Claude's `update_asset`).
- Extracting markers (numbers on stakes or trees) from photos. A likely later workflow; nothing
  here should depend on markers existing.

---

## Part 1: the existing state as a linked state

### 1.1 States lambda (`lambda/states/index.js`)

1. Create and update accept a link with `entity_type: 'existing_state'` whose `entity_id` is an
   action in the caller's organization. If such a link is sent without an `action` link to the
   same action, add the `action` link too, so the existing state always shows on the action.
2. Every GET that returns an observation's links already returns all link types; confirm
   `existing_state` comes back.
3. Lists of an action's observations (`entity_type = 'action'`) are unchanged: the existing state
   is among them through its ordinary link.

### 1.2 App

1. `src/components/UnifiedActionDialog.tsx`, new action: the "Existing State" text box and the
   photo panel create one observation, with links `action` and `existing_state` to the new action
   (plus the asset's `tool` link, as today). Remove the photo panel's separate text box. If
   neither text nor photos are given, no observation is created.
2. The text is saved only as the existing-state observation, not also to `actions.description`
   (decided). Older actions keep their `description`.
3. `src/components/StatesInline.tsx`, on an action: show a small **"Existing state"** badge on the
   observation that has an `existing_state` link to this action. No other badges, no checkbox.
4. Callers that rebuild an observation's links must keep `existing_state` links:
   `src/pages/AddObservation.tsx` (edit keeps links it doesn't show; confirm it keeps
   `existing_state`), `src/contexts/UploadQueueContext.tsx` (passes all links back; confirm).
   `StatesInline` edits do not send links.

---

## Part 2: making an experience from an action

### 2.1 App

In `src/components/ActionExperiences.tsx` (shown under the Implementation tab), on an action
that has an existing state, open or closed, a button **"Create experience"**. It calls the
existing create-experience request with:

- `entity_type`/`entity_id`: the action's asset, if any (tool assumed, as elsewhere);
- `initial_state_ids`: the action's existing state(s);
- `action_ids`: `[action.id]`;
- `final_state_ids`: the action's other observations captured after its existing state, in time
  order;

then opens the new experience, where the person trims or moves components as today. No AI is
involved.

### 2.2 Experience page

`src/pages/ExperiencePage.tsx`: label the final-state lane **"Observations"**, with no hint text
(the initial state lane has none either). A blank card for a new observation is unlabelled; once it
is removed, **"New observation"** under the lane brings it back.

### 2.3 Replace the AI "Draft experience" buttons

Today three buttons (title "Draft Experience", `Route` icon) open
`/experiences/new?...&draft_action_id=...` or `...&draft_state_id=...`, where the page shows an
AI prompt card ("What do you want captured about this ...?") and drafts the experience with AI.
Replace them; no AI drafting stays in the app.

1. **On actions**: `src/components/ActionListItemCard.tsx` (`handleDraftExperienceClick`,
   ~line 60, button ~line 135) and the action rows in `src/components/tools/ToolDetails.tsx`
   (~line 273). Same place and icon, title and aria-label **"Create experience"**. On click:
   - an action with an existing state → create the experience exactly as Part 2.1 and
     open it;
   - otherwise → open `/experiences/new?entity_type=tool&entity_id=...&action_id=...` (the
     page already preselects `action_id` into the action lane, with no AI), so the person
     builds it by hand as today.
   Keep each button's current visibility conditions.
2. **On observations**: the observation rows in `ToolDetails.tsx` (~line 377). Title and
   aria-label **"Create experience"**; it still opens
   `/experiences/new?entity_type=tool&entity_id=...&draft_state_id=...`, which places that
   observation in the final lane with no AI (existing behaviour of the page).
3. **Remove the AI drafting from the experience page** (`src/pages/ExperiencePage.tsx`): the
   prompt card shown while `draftAnchor && !hasDrafted` (~line 1256), `handleDraftExperience`
   (~line 543), and the state only they use (`draftNote`, `isDrafting`, `hasDrafted`,
   `draftAction` and its save step 5, `draftPerspectiveId`, `draftGenerationConfigId` and the
   fields they add to the create/update calls). Keep the `draft_action_id` / `draft_state_id`
   query parameters' lane preselection, which needs no AI.
4. Remove `draftExperience` and `DraftExperienceProposal` from `src/lib/apiService.ts`
   (~line 681) once nothing imports them.
5. Remove the `POST /api/experiences/draft` route from `lambda/experiences/index.js`
   (~line 353-477) and anything only it uses, after confirming (grep across `src/` and
   `lambda/`) that nothing else calls it. Leave `experience_perspective_id` and
   `llm_generation_config_id` already stored in existing experiences' metadata untouched.

---

## Part 3: `concluded` asset status

### 3.1 Database

`tools.status` is the Postgres enum `tool_status` (values `available`, `checked_out`,
`unavailable`, `needs_attention`, `under_repair`, `removed`; no CHECK constraint).
`migrations/032-add-concluded-tool-status.sql`:

```sql
ALTER TYPE tool_status ADD VALUE IF NOT EXISTS 'concluded';
```

Run it outside a transaction block, and before anything that uses the new value.

### 3.2 Backend

The core lambda (`lambda/core/index.js`) already accepts `status` on `PUT /api/tools/:id` and
writes an `asset_history` row for it. Confirm `concluded` passes through.

Treat `concluded` like `removed` **only** where a list is of things in active use:

| File | Line (approx.) | Change |
|---|---|---|
| `lambda/core/index.js` | 586 | `!removed` filter: also exclude `concluded` |
| `lambda/learning/index.js` | 1388 | inventory for the AI: also exclude `concluded` |
| `lambda/mcp-server/mcp-server.js` | 335 | an area must not be `concluded` either |
| `src/hooks/tools/useToolsData.tsx` | 60 | also hide `concluded` |
| `src/hooks/tools/useParentStructures.tsx` | 43 | also hide `concluded` |
| `src/components/tools/SystemMemberships.tsx` | 141 | also hide `concluded` |
| `src/hooks/useCombinedAssets.tsx` | 228-266 | hide `concluded` wherever `removed` is hidden; show it wherever "show removed" shows `removed` |

Do **not** hide concluded assets from `get_asset`, `search_assets`, actions, experiences, or
history. `search_assets` should include each tool's `status`.

### 3.3 App

1. `src/lib/constants.ts` `getStatusColor` / `getStatusLabel`: add `concluded` (label
   "Concluded", `bg-emerald-50 text-emerald-800`).
2. `src/components/tools/ToolStatusBadge.tsx`: add `concluded` (label "Concluded", variant
   `secondary`, icon `CheckCircle2`).
3. `src/components/CombinedAssetCard.tsx` `getStatusBadge`: show a "Concluded" badge.
4. **Info bubble** next to the Concluded badge (card and asset detail): an info icon with a
   tooltip (`src/components/ui/tooltip.tsx`):
   > Concluded: this asset's purpose is complete, or it can no longer be worked with. It's out of
   > the active lists, but its history and experiences are kept and can be shared.
5. `src/components/CombinedAssetsContainer.tsx`: next to the existing remove action for tools,
   **Conclude** (and **Make available again** on a concluded tool), using the same
   `updateTool.mutateAsync` call, with the info text in its confirm dialog. Do not change the
   remove flow.

---

## Part 4: unique serial numbers

**Status (2026-11-14):** the 25 duplicates the check first found were fixed (renumbered, or
duplicate records removed) and the index is created in the database. Steps 3 and 4 are built
but the core lambda is not yet deployed.

1. Check existing data (must return no rows):
   ```sql
   SELECT organization_id, lower(btrim(serial_number)) AS serial, array_agg(name), count(*)
   FROM tools
   WHERE btrim(coalesce(serial_number, '')) <> '' AND status::text NOT IN ('removed', 'concluded')
   GROUP BY 1, 2 HAVING count(*) > 1;
   ```
2. Once there are none, `migrations/033-unique-active-serial-numbers.sql`. Compare the enum
   directly: `status::text` is not allowed in an index predicate (Postgres: "functions in index
   predicate must be marked IMMUTABLE"), and `'concluded'` must already exist (Part 3.1).
   ```sql
   CREATE UNIQUE INDEX tools_active_serial_unique
     ON tools (organization_id, lower(btrim(serial_number)))
     WHERE btrim(coalesce(serial_number, '')) <> '' AND status NOT IN ('removed', 'concluded');
   ```
3. Core lambda create and update for tools: catch Postgres error `23505` on this index, look up
   the active tool that has the number, and return 400, e.g.
   `Serial number "C3" is already on "Cogon patch C3". Conclude that one or pick another number.`
   This includes making a concluded tool available again when its number has been reused.
4. App add/edit tool forms show that message as the error.

---

## Part 5: Claude (MCP) tools

All in `lambda/mcp-server/mcp-server.js`, through the helpers in `lambda/mcp-server/actions.js`.
No direct database writes, no new lambdas or routes.

1. **`create_action`**: its `existing_state` text (today saved as `description`) creates the
   existing-state observation (links `action` and `existing_state` to the new action, and `tool`
   when an asset is given), as the app does, and its reply gives that observation's
   `existing_state_id` and `add_photos_link`, as `add_observation` does. It gains an optional
   `asset_id` (a tool, from `search_assets`) that the action is on, and an optional
   `completed_at` (YYYY-MM-DD, Asia/Manila) for work already done: the action is created
   completed on that day (midday Manila). Whether the text is also still saved as
   `description`: no, it is saved only as the observation (decided, as in Part 1.2).
2. **`LINK`** (~line 148): `entity_type` also accepts `existing_state`, with `entity_id` an
   action, described as "existing_state: this observation is the action's existing state (how
   things were when it was taken)". `add_observation` and `update_observation_links` pass it
   through; giving `existing_state` also adds the `action` link. `update_observation_links` keeps
   links it does not touch, as today.
3. **`search_actions`**: each result gives `existing_state_ids` (empty for older actions) next to
   `observation_ids`.
4. **`create_experience`** gains
   ```js
   from_action_id: z.string().optional().describe(
     'An action with an existing state, open or closed: builds the experience from it (its existing ' +
     'state → initial, the action, its later observations → next states, in time order). ' +
     'Other legs given are added.'),
   ```
   Same legs as Part 2.1. Error if the action has no existing state. The action is not changed.
5. **`get_experience`**: for each action in it, give its `existing_state_ids`. Also give
   `linked_assets`, the assets linked directly, once each with how (`experience asset`,
   `action asset`, `tool used by an action`, `observation`), and `span`, the days it covers (first
   to last observation or completed action, or to today with `open: true` while an action in it is
   open). Assets inside an area are not included. Add to its
   description: "To say what an experience shows, synthesise from all of it: the existing state,
   what was done, and every next state in time order. Next states are observations, not
   verdicts; 'no change yet' is information."
6. **`update_asset`** gains
   ```js
   concluded: z.boolean().optional().describe(
     'Tools only. true concludes it: its purpose is complete, or it can no longer or will no longer ' +
     'be worked with (a marker whose experiment is done, a pond whose liner failed). It leaves the ' +
     'active asset lists but keeps its history and experiences. false makes it available again.'),
   ```
   mapped to `status: 'concluded'` / `'available'`; error for a part.
7. **`ASSET_FIELDS.serial_number`** description: `'Tools only. What is written on it or its
   marker (a stake, a number painted on a tree); unique among tools in use'`. Duplicate-serial
   errors from the backend pass through unchanged.

---

## Part 6: remove unused AI drafting code (done)

`UnifiedActionDialog.tsx` defined `generateAISummaryPolicy` and `generateAIExpectedState`, which
nothing on screen called. Both are deleted, with the state and import only they used. The backend
endpoints and `src/tests/exploration-data-collection/action-creation-form.test.ts` are untouched.

---

## Implementation status (branch `feat/expected-metric-models`, uncommitted)

An earlier version of this spec marked observations with a `role` on their action link
(`existing_state` / `action` / `next_state`). That was built and is now **replaced** by the
`existing_state` link type. Remove:

- `migrations/031-add-state-link-role.sql` (never applied);
- `role` handling in `lambda/states/index.js` (`LINK_ROLES`, `linkRoleError`, the `role` column in
  inserts and in the GET link objects);
- the `role` type and fields in `src/types/observations.ts`, `AddObservation.tsx`,
  `UploadQueueContext.tsx` and `UnifiedActionDialog.tsx`;
- the "Next state (after the action)" checkbox, `isNextState` and the per-role badges in
  `StatesInline.tsx`;
- the MCP `role` on `LINK`, `roleOnNonAction`, `observation_roles`, and the role-based
  `get_experience` / `from_action_id` code and tests.

Keep (already built and tested): Part 3 (migration 032 not yet applied), the "Observations" label,
the `search_assets` status, the `update_asset` `concluded` option, the serial-number description,
and Part 6. Rework to this spec: "Create experience" (Part 2.1) and `from_action_id` (Part 5.4).
Part 2.3 is not built yet.

---

## Tests (must pass: `npm run test:run`, plus `lambda/mcp-server` tests)

1. States lambda: an `existing_state` link to an action is saved and returned; sent alone, the
   `action` link is added too.
2. New action with existing-state text or photos → one observation with links `action` and
   `existing_state`; with neither → no observation.
3. `StatesInline` on an action shows "Existing state" on that observation only; editing it keeps
   both links.
4. "Create experience" on an action with an existing state, open or closed, builds the legs as in 2.1;
   on an action without one it opens the experience page with the action preselected; on an
   observation it opens the page with the observation in the final lane. No AI request is made
   in any case, and the experience page shows no AI prompt card.
5. MCP: `create_action` with `existing_state` creates the linked observation and returns its
   photo link, on the asset when `asset_id` is given; `add_observation`
   with an `existing_state` link; `search_actions` returns `existing_state_ids`;
   `create_experience` with `from_action_id` on an open action (and its refusal without an
   existing state); `get_experience` gives
   `existing_state_ids`; `update_asset` `concluded`.
6. Asset status: concluded tools hidden from active lists, shown with "show removed"; badge and
   info bubble render.
7. (Part 4, when unblocked) A duplicate active serial → the backend's message reaches the form
   and the MCP caller.

## Done when

The cogon example, in the app with no Claude involved: add "Cogon patch C3" (Field, serial C3,
area Learning Center terraces, where it is). Create an action on it, "Crimp cogon and top with
chicken manure", with existing-state text and a photo: the observation shows the "Existing state"
badge. Start it. Add an observation with photos of the crimping and the manure. Over the
following weeks add "no visible change", "cogon yellowing under the mulch" and "roots soft and
brown, soil dark". Press Done: the action completes as today. "Create experience" makes an
experience with the existing state, the action, and the four later observations as next states;
the person moves the crimping photos out of the next states or leaves them. Conclude
"Cogon patch C3" from the asset list: it leaves the active lists with the Concluded badge.

The same through Claude, as in "The flow through Claude" below, then asking Claude what the
experience shows.

## The flow through Claude

Three moments, one message each from the person. No policy, and no status changes along the way.

1. **Start**, e.g. "Crimping cogon and topping it with chicken manure on C3": Claude calls
   `create_action` with a title, `existing_state` (how things are now) and `asset_id` if an
   asset was named, and gives the person the existing state's photo link for one or two photos.
   The action is open.
2. **Look again**, e.g. "C3: cogon yellowing under the mulch": Claude finds the open action
   (`search_actions`) and calls `add_observation` linked to it, then gives the photo link.
   "No change yet" is recorded too.
3. **Share**, at any time: Claude calls `create_experience` with `from_action_id`. The action
   stays open or closed as it was; closing it is a separate "it's done" (`update_action`
   completed).

**From an asset's observations**, when the work was only recorded in observations (maintenance,
monthly payments): asked to make an experience, Claude finds the asset's observations
(`search_claims` with `asset_id`), picks the one that reports the work, creates its action
(`create_action` with a title, `asset_id` and `completed_at`, no existing-state text), links that
observation to the action and the observation of how things were before as its `existing_state`
(`update_observation_links`), and builds the experience from the action. It also looks at the
observations of the directly linked assets over the same days (`get_experience`'s
`linked_assets` and `span`) and suggests any that belong. The action duplicates the observation
that reports the work; that is accepted, to make a clear experience to share. The steps are in
`create_experience`'s description. Before saving, Claude reads the experience back.

**After closing.** Completing an action does not end its experience: later observations can still
be added as next states (the experience page, or `update_experience`). New observations never join
an experience by themselves.

Remembering to look again is not stored: asked "what needs a look?", Claude lists the open
actions with an existing state, longest since their latest observation first (`search_actions`
already gives each one's latest observation).

---

## Decided

**`actions.description` on new actions.** The "Existing State" text is saved only as the
existing-state observation, not also to `description`. New actions therefore have no
`description`, so anything that reads it shows nothing for them: action cards and the scored
actions list, the Actions page text search, action embeddings, the explorations and history
queries in the core and actions lambdas, the AI summariser, and `rsp-worker`. Older actions are
unchanged.

**Older actions move over time.** There is no backfill. `update_action`'s `existing_state` and the
app's edit form keep writing `description` for older actions. Actions move to the existing-state
observation as they are created or revisited, and `description` can be dropped once nothing
depends on it.

## Also leave alone

Do not change the asset's Experiences tab (`src/components/tools/ExperiencesTab.tsx`): nothing
in this spec needs it to.

## Converting existing records

No data migration. Older actions have no `existing_state` link and keep their `description`.
Existing experiences are unchanged. An older action can still become an experience through the
experience page as today.
