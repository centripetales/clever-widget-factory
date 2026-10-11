// Positive Sum routes (desired states/goals, options, approvals, opportunities).
// Rules live in positiveSumRules.js; this file is data access + HTTP.
// All SQL here is parameterized.
const { Client } = require('pg');
const { deleteAction } = require('./deleteAction');
const {
  STATE_PREFIX,
  STATE_TYPES,
  OPEN_STATUS,
  DAILY_LIST_SIZE,
  stateText,
  parseState,
  implementorIds,
  isGoal,
  isChallenge,
  isProposal,
  isSituation,
  proposalText,
  JOINABLE_STATUSES,
  challengeOwner,
  challengeSummaries,
  addressedChallenges,
  takingPart,
  hasFreeCapacity,
  valueForOthers,
  sortByValue,
  needsImplementorApproval,
  qualifiesForAutoApproval,
  isApproved,
  dayKey,
} = require('./positiveSumRules');

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function withClient(dbConfig, fn) {
  const client = new Client(dbConfig);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const ACTION_FIELDS = ['id', 'organization_id', 'title', 'description', 'policy', 'expected_state', 'status',
  'created_by', 'assigned_to', 'participants', 'required_tools', 'attachments', 'created_at', 'completed_at'];
const ACTION_COLUMNS = ACTION_FIELDS.join(', ');
const actionColumns = alias => ACTION_FIELDS.map(f => `${alias}.${f}`).join(', ');

async function loadActions(client, ids) {
  if (ids.length === 0) return [];
  const { rows } = await client.query(
    `SELECT ${ACTION_COLUMNS} FROM actions WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  return rows;
}

// Every Positive Sum bookkeeping state in these orgs, parsed.
async function loadRecords(client, orgIds) {
  const { rows } = await client.query(
    `SELECT id, organization_id, captured_by, captured_at, state_text
       FROM states
      WHERE organization_id = ANY($1::uuid[]) AND state_text LIKE $2`,
    [orgIds, `${STATE_PREFIX}%`]
  );
  const records = rows.map(r => ({ ...r, captured_by: String(r.captured_by), data: parseState(r.state_text) }))
    .filter(r => r.data);
  const ofType = type => records.filter(r => r.data.type === type);
  const contexts = {};
  for (const r of ofType(STATE_TYPES.OPTION_CONTEXT)) {
    // Options built from other (open) options; early records called these policy_ids.
    contexts[r.data.option_id] = { ...r.data, source_option_ids: r.data.source_option_ids ?? r.data.policy_ids ?? [] };
  }
  const approvals = ofType(STATE_TYPES.APPROVAL).map(r => ({
    approver: r.captured_by, option_id: r.data.option_id, goal_id: r.data.goal_id, basis: r.data.basis,
  }));
  const passes = ofType(STATE_TYPES.PASS).map(r => ({ person: r.captured_by, item_id: r.data.item_id }));
  const lists = ofType(STATE_TYPES.OPPORTUNITY_LIST).map(r => ({ person: r.captured_by, ...r.data, captured_at: r.captured_at }));
  const collaborations = ofType(STATE_TYPES.COLLABORATION).map(r => ({
    state_id: r.id, person: r.captured_by, goal_id: r.data.goal_id, challenge_id: r.data.challenge_id,
  }));
  return { contexts, approvals, passes, lists, collaborations };
}

async function insertRecord(client, { organizationId, userId, type, payload, links }) {
  const { rows } = await client.query(
    `INSERT INTO states (organization_id, state_text, captured_by, captured_at)
     VALUES ($1, $2, $3, NOW()) RETURNING id`,
    [organizationId, stateText(type, payload), userId]
  );
  const stateId = rows[0].id;
  for (const link of links) {
    await client.query(
      `INSERT INTO state_links (state_id, entity_type, entity_id) VALUES ($1, $2, $3)`,
      [stateId, link.entity_type, link.entity_id]
    );
  }
  return stateId;
}

async function insertAction(client, fields) {
  const { rows } = await client.query(
    `INSERT INTO actions (id, organization_id, title, description, policy, expected_state, status,
       created_by, updated_by, assigned_to, participants, required_tools, attachments, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $7, $8, $9::uuid[], $10::text[], $11::text[], NOW(), NOW())
     RETURNING ${ACTION_COLUMNS}`,
    [
      fields.organization_id, fields.title, fields.description || null, fields.policy || null,
      fields.expected_state || null, OPEN_STATUS, fields.created_by, fields.assigned_to || null,
      fields.participants || [], fields.required_tools || [], fields.attachments || [],
    ]
  );
  return rows[0];
}

// What people taking part in these desired states said on them, and their names.
async function loadTakingPart(client, goals) {
  const people = [...new Set(goals.flatMap(g => (g.participants || []).map(String)))];
  if (people.length === 0) return { comments: [], names: {} };
  const { rows: comments } = await client.query(
    `SELECT sl.entity_id AS action_id, s.captured_by::text AS person, s.state_text AS text
       FROM state_links sl JOIN states s ON s.id = sl.state_id
      WHERE sl.entity_type = 'action' AND sl.entity_id = ANY($1::uuid[])
        AND COALESCE(s.state_text, '') <> '' AND s.state_text NOT LIKE $2
      ORDER BY s.captured_at`,
    [goals.map(g => g.id), `${STATE_PREFIX}%`]
  );
  return { comments, names: await loadNames(client, people) };
}

// The people of these orgs, for choosing who a challenge is assigned to.
async function loadMembers(client, orgIds) {
  const { rows } = await client.query(
    `SELECT DISTINCT ON (cognito_user_id) cognito_user_id AS id, full_name AS name FROM organization_members
      WHERE organization_id = ANY($1::uuid[]) AND is_active AND cognito_user_id IS NOT NULL
      ORDER BY cognito_user_id, full_name`,
    [orgIds]
  );
  return rows.map(m => ({ id: String(m.id), name: (m.name || '').trim() || null }));
}

// People's names by user id, from any org they belong to.
async function loadNames(client, userIds) {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return {};
  const { rows } = await client.query(
    `SELECT DISTINCT ON (cognito_user_id) cognito_user_id, full_name FROM organization_members
      WHERE cognito_user_id = ANY($1::text[]) AND COALESCE(full_name, '') <> ''`,
    [ids]
  );
  return Object.fromEntries(rows.map(m => [m.cognito_user_id, m.full_name]));
}

function titleFrom(explicit, text) {
  if (explicit && explicit.trim()) return explicit.trim();
  const t = (text || '').trim();
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
}

// Implementor value for sorting suggestions: the highest value among an
// option's implementors.
function optionValue(option, approvals, implementorsByOption) {
  const ids = implementorIds(option);
  return ids.length ? Math.max(...ids.map(id => valueForOthers(id, approvals, implementorsByOption))) : 0;
}

async function implementorsIndex(client, contexts) {
  const options = await loadActions(client, Object.keys(contexts));
  const index = {};
  for (const o of options) index[o.id] = implementorIds(o);
  return { options, index };
}

// Recipients' experience with similar options, for the association default.
async function pastExperiences(client, personId, contexts, approvals) {
  const mine = approvals.filter(a => a.approver === personId && a.basis === 'recipient').map(a => a.option_id);
  const options = await loadActions(client, [...new Set(mine)]);
  if (options.length === 0) return [];
  const { rows: photos } = await client.query(
    `SELECT sl.entity_id AS action_id, COUNT(sp.id)::int AS photo_count
       FROM state_links sl
       JOIN states s ON s.id = sl.state_id
       JOIN state_photos sp ON sp.state_id = s.id
      WHERE sl.entity_type = 'action' AND sl.entity_id = ANY($1::uuid[])
      GROUP BY sl.entity_id`,
    [options.map(o => o.id)]
  );
  const photoCount = Object.fromEntries(photos.map(p => [p.action_id, p.photo_count]));
  return options.map(o => ({
    id: o.id,
    required_tools: o.required_tools || [],
    source_option_ids: contexts[o.id]?.source_option_ids || [],
    completed: o.status === 'completed',
    photo_count: photoCount[o.id] || 0,
  }));
}

function summarize(a, extra = {}) {
  return {
    id: a.id, organization_id: a.organization_id, title: a.title,
    initial_state: a.description, policy: a.policy, desired_state: a.expected_state,
    status: a.status, created_by: a.created_by, implementors: implementorIds(a),
    required_tools: a.required_tools || [], attachments: a.attachments || [],
    created_at: a.created_at, ...extra,
  };
}

async function handlePositiveSum({ event, authContext, dbConfig, queueEmbedding, notify }) {
  const { httpMethod, path } = event;
  const userId = authContext.cognito_user_id;
  if (!userId) throw new HttpError(401, 'Authenticated user id is required');
  const memberOrgIds = (authContext.organization_memberships || []).map(m => m.organization_id);
  const requireMember = orgId => {
    if (!orgId || !memberOrgIds.includes(orgId)) throw new HttpError(403, 'Not a member of that organization');
  };
  const body = JSON.parse(event.body || '{}');
  const query = event.queryStringParameters || {};
  // Limit reads to the requested orgs (e.g. the Positive Sum page's org, or the
  // orgs with Positive Sum turned on); only ever orgs the person belongs to.
  const scopedOrgIds = raw => {
    const requested = String(raw || '').split(',').map(id => id.trim()).filter(Boolean);
    return requested.length ? memberOrgIds.filter(id => requested.includes(id)) : memberOrgIds;
  };
  const optionRoute = path.match(/\/positive-sum\/options\/([0-9a-f-]{36})\/(join|approve|pass)$/);
  const goalContextRoute = path.match(/\/positive-sum\/goals\/([0-9a-f-]{36})\/context$/);

  return withClient(dbConfig, async client => {
    // People in a member organization of a Positive Sum org take part in it
    // too (member_organizations, one level), not only its own members.
    const { rows: parents } = await client.query(
      'SELECT DISTINCT organization_id::text AS id FROM member_organizations WHERE member_organization_id = ANY($1::uuid[])',
      [memberOrgIds]
    );
    for (const parent of parents) {
      if (!memberOrgIds.includes(parent.id)) memberOrgIds.push(parent.id);
    }

    // POST /positive-sum/goals — a desired state in the person's own words.
    // The initial state is optional here; it's recorded on the action when a
    // real deal happens.
    // With { challenge } instead, it records a challenge: something the person
    // is running into, in their words, for others to vote on and propose
    // collaborations for. With { challenge_id }, the desired state is a
    // collaboration proposed for that challenge.
    if (httpMethod === 'POST' && path.endsWith('/positive-sum/goals')) {
      const { organization_id, initial_state, desired_state, attachments, challenge, challenge_id, link, edit } = body;
      requireMember(organization_id);
      const { collaborations } = await loadRecords(client, [organization_id]);
      const proposalIds = new Set(collaborations.map(l => l.goal_id));
      // Every proposal carries a collaboration record; one with no situation yet has an empty one.
      const markProposal = (goalId, situationId) => insertRecord(client, {
        organizationId: organization_id, userId, type: STATE_TYPES.COLLABORATION,
        payload: { goal_id: goalId, challenge_id: situationId || null },
        links: [{ entity_type: 'action', entity_id: goalId }, ...(situationId ? [{ entity_type: 'action', entity_id: situationId }] : [])],
      });
      const removeRecords = async records => {
        const ids = records.map(l => l.state_id);
        await client.query('DELETE FROM state_links WHERE state_id = ANY($1::uuid[])', [ids]);
        await client.query('DELETE FROM states WHERE id = ANY($1::uuid[])', [ids]);
      };

      // { delete: { id } } — the owner removes their situation, or the author
      // their proposed collaboration, while it is still open (nobody has joined).
      if (body.delete) {
        const [target] = await loadActions(client, [body.delete.id]);
        if (!target || target.organization_id !== organization_id || target.status !== OPEN_STATUS ||
            !(isSituation(target, proposalIds) || isProposal(target, proposalIds))) {
          throw new HttpError(404, 'Not found');
        }
        const owner = isSituation(target, proposalIds) ? challengeOwner(target) : String(target.created_by);
        if (owner !== String(userId)) throw new HttpError(403, 'Only its owner can delete this');
        await deleteAction(client, target.id, null);
        await notify(target);
        return { statusCode: 200, data: { id: target.id } };
      }

      // { edit: { id, text } } — the owner rewords their challenge, or the
      // author their proposed collaboration.
      if (edit) {
        const [target] = await loadActions(client, [edit.id]);
        const text = typeof edit.text === 'string' ? edit.text.trim() : '';
        if (target && target.organization_id === organization_id && isProposal(target, proposalIds)) {
          if (String(target.created_by) !== String(userId)) throw new HttpError(403, 'Only its author can edit this');
          if (!JOINABLE_STATUSES.includes(target.status)) throw new HttpError(409, 'This is already done');
          if (!text) throw new HttpError(400, 'It needs some text');
          // The text is the action's title. An older proposal held it as the
          // desired state; rewording it moves it to the title.
          const wasOldLayout = proposalText(target) !== (target.title || '').trim();
          const { rows } = await client.query(
            `UPDATE actions SET title = $2, expected_state = CASE WHEN $4 THEN NULL ELSE expected_state END,
                    updated_by = $3, updated_at = NOW()
              WHERE id = $1 RETURNING ${ACTION_COLUMNS}`,
            [target.id, text, userId, wasOldLayout]
          );
          if (!proposalIds.has(target.id)) await markProposal(target.id, null);
          await notify(rows[0]);
          return { statusCode: 200, data: summarize(rows[0]) };
        }
        if (!target || target.organization_id !== organization_id || !isSituation(target, proposalIds)) throw new HttpError(404, 'Situation not found');
        if (challengeOwner(target) !== String(userId)) throw new HttpError(403, 'Only its owner can edit a situation');
        if (!text) throw new HttpError(400, 'A situation needs some text');
        // The owner can hand the challenge to anyone in this org or their own
        // orgs, or to anyone who voted for it; it is then theirs to edit.
        const assignee = edit.assigned_to || challengeOwner(target);
        const allowed = [
          challengeOwner(target), ...(target.participants || []).map(String),
          ...(await loadMembers(client, [organization_id, ...memberOrgIds])).map(m => m.id),
        ];
        if (!allowed.includes(assignee)) {
          throw new HttpError(400, 'Assign it to someone in the organization, or someone who voted for it');
        }
        const { rows } = await client.query(
          `UPDATE actions SET description = $2, title = $3, updated_by = $4, assigned_to = $5, updated_at = NOW()
            WHERE id = $1 RETURNING ${ACTION_COLUMNS}`,
          [target.id, text, titleFrom(null, text), userId, assignee]
        );
        await notify(rows[0]);
        return { statusCode: 200, data: summarize(rows[0]) };
      }

      // { link: { goal_id, challenge_id, remove? } } — say which challenge an
      // existing desired state addresses, or take that back. Anyone in the org
      // can link; the one who linked, or the desired state's author, can remove.
      if (link) {
        const [goal, target] = [
          (await loadActions(client, [link.goal_id]))[0], (await loadActions(client, [link.challenge_id]))[0],
        ];
        if (!goal || goal.organization_id !== organization_id || !isProposal(goal, proposalIds)) throw new HttpError(404, 'Proposed collaboration not found');
        if (!target || target.organization_id !== organization_id || !isSituation(target, proposalIds)) throw new HttpError(404, 'Situation not found');
        const ofGoal = collaborations.filter(l => l.goal_id === goal.id);
        const existing = ofGoal.filter(l => l.challenge_id === target.id);
        if (link.remove) {
          const mine = existing.filter(l => l.person === String(userId) || String(goal.created_by) === String(userId));
          if (existing.length && !mine.length) throw new HttpError(403, 'Only whoever linked it, or its author, can remove the link');
          await removeRecords(mine);
          // Still a proposal, just under no situation.
          if (ofGoal.length === mine.length) await markProposal(goal.id, null);
        } else if (!existing.length) {
          await removeRecords(ofGoal.filter(l => !l.challenge_id));
          await markProposal(goal.id, target.id);
          // The situation becomes the action's existing state, unless it already has one.
          await client.query(
            `UPDATE actions SET description = $2, updated_at = NOW() WHERE id = $1 AND COALESCE(description, '') = ''`,
            [goal.id, target.description]
          );
        }
        await notify(goal);
        return { statusCode: 200, data: summarize(goal) };
      }
      if (typeof challenge === 'string' && challenge.trim()) {
        const created = await insertAction(client, {
          organization_id, title: titleFrom(null, challenge), description: challenge.trim(), created_by: userId,
          assigned_to: userId, // its owner
        });
        await notify(created);
        return { statusCode: 201, data: summarize(created) };
      }
      // A proposed collaboration: the text (sent as desired_state) is the
      // action's title, in full; the situation it answers, copied as it reads
      // now, is its existing state; the desired state is left for later. Its
      // author is the assignee.
      if (!desired_state?.trim()) {
        throw new HttpError(400, 'Say what you propose');
      }
      let situation = null;
      if (challenge_id) {
        [situation] = await loadActions(client, [challenge_id]);
        if (!situation || situation.organization_id !== organization_id || !isSituation(situation, proposalIds)) {
          throw new HttpError(404, 'Situation not found');
        }
      }
      const goal = await insertAction(client, {
        organization_id, title: desired_state.trim(), description: situation ? situation.description : initial_state,
        created_by: userId, assigned_to: userId, attachments,
      });
      await markProposal(goal.id, situation?.id);
      await notify(goal);
      return { statusCode: 201, data: summarize(goal) };
    }

    // GET /positive-sum/goals/:id/context — what Maxwell needs to shape options:
    // the goal, options already suggested for it, and other open options in
    // its org that could be built on (information is always free).
    if (httpMethod === 'GET' && goalContextRoute) {
      const [goal] = await loadActions(client, [goalContextRoute[1]]);
      if (!goal || !isGoal(goal)) throw new HttpError(404, 'Desired state not found');
      requireMember(goal.organization_id);
      const records = await loadRecords(client, [goal.organization_id]);
      const contexts = Object.values(records.contexts);
      const forGoal = contexts.filter(c => (c.goal_ids || []).includes(goal.id)).map(c => c.option_id);
      const others = contexts.filter(c => !(c.goal_ids || []).includes(goal.id)).map(c => c.option_id);
      const options = await loadActions(client, forGoal);
      const openOptions = (await loadActions(client, others)).filter(o => o.status === OPEN_STATUS);
      const withCapacity = o => summarize(o, { capacity: records.contexts[o.id]?.capacity });
      return {
        statusCode: 200,
        data: { goal: summarize(goal), options: options.map(withCapacity), open_options: openOptions.map(withCapacity) },
      };
    }

    // POST /positive-sum/options — shaped in a conversation, then saved
    if (httpMethod === 'POST' && path.endsWith('/positive-sum/options')) {
      const {
        goal_ids = [], source_option_ids = [], title, initial_state, policy, final_state,
        capacity = 1, required_tools = [], conversation_state_ids = [], parent_option_id = null,
      } = body;
      if (!policy?.trim() || !final_state?.trim()) {
        throw new HttpError(400, 'An option needs a policy and a final state');
      }
      const goals = await loadActions(client, goal_ids);
      const sources = await loadActions(client, source_option_ids);
      if (goals.length !== goal_ids.length || sources.length !== source_option_ids.length) {
        throw new HttpError(404, 'Desired state or option not found');
      }
      if (goals.some(g => !isGoal(g) || g.status !== OPEN_STATUS)) {
        throw new HttpError(400, 'Options can only be suggested for open desired states');
      }
      const orgIds = [...new Set([...goals, ...sources].map(a => a.organization_id))];
      const organization_id = orgIds[0] || body.organization_id;
      if (orgIds.length > 1) throw new HttpError(400, 'Desired states and options must be in the same organization');
      requireMember(organization_id);

      // Built from someone's open options → their implementors implement it (and
      // must agree unless the association default applies); otherwise the
      // creator suggests it themselves. Nobody else can be named — others join
      // themselves via /join.
      const implementors = sources.length
        ? [...new Set(sources.flatMap(o => implementorIds(o)))]
        : [String(userId)];
      if (implementors.length > capacity) throw new HttpError(400, 'More implementors than capacity');

      const option = await insertAction(client, {
        organization_id, title: titleFrom(title, final_state), description: initial_state, policy,
        expected_state: final_state, created_by: userId, assigned_to: implementors[0],
        participants: implementors.slice(1), required_tools,
      });
      const links = [
        { entity_type: 'action', entity_id: option.id },
        ...goal_ids.map(id => ({ entity_type: 'action', entity_id: id })),
        ...source_option_ids.map(id => ({ entity_type: 'action', entity_id: id })),
        ...(parent_option_id ? [{ entity_type: 'action', entity_id: parent_option_id }] : []),
        ...conversation_state_ids.map(id => ({ entity_type: 'state', entity_id: id })),
      ];
      await insertRecord(client, {
        organizationId: organization_id, userId, type: STATE_TYPES.OPTION_CONTEXT,
        payload: { option_id: option.id, goal_ids, source_option_ids, parent_option_id, capacity, conversation_state_ids },
        links,
      });
      queueEmbedding(option);
      await notify(option);
      return { statusCode: 201, data: summarize(option, { capacity, goal_ids, source_option_ids, parent_option_id }) };
    }

    if (optionRoute && httpMethod === 'POST') {
      const [, optionId, verb] = optionRoute;
      const [option] = await loadActions(client, [optionId]);
      if (!option) throw new HttpError(404, 'Option not found');
      requireMember(option.organization_id);
      const records = await loadRecords(client, [option.organization_id]);
      const context = records.contexts[optionId];

      // POST /positive-sum/options/:id/pass — learning only; never shown to the owner
      if (verb === 'pass') {
        await insertRecord(client, {
          organizationId: option.organization_id, userId, type: STATE_TYPES.PASS,
          payload: { item_id: optionId, date: dayKey() },
          links: [{ entity_type: 'action', entity_id: optionId }],
        });
        return { statusCode: 200, data: { passed: optionId } };
      }

      // POST /positive-sum/options/:id/join on a challenge — vote for it: "this
      // matters to me too". Votes are the people who joined it.
      const proposalIds = new Set(records.collaborations.map(l => l.goal_id));
      if (!context && verb === 'join' && isSituation(option, proposalIds)) {
        if (option.status !== OPEN_STATUS) throw new HttpError(409, 'This is no longer open');
        if ((option.participants || []).map(String).includes(String(userId))) {
          return { statusCode: 200, data: summarize(option) };
        }
        const { rows } = await client.query(
          `UPDATE actions SET participants = array_append(COALESCE(participants, ARRAY[]::uuid[]), $2::uuid),
                  updated_at = NOW()
            WHERE id = $1 RETURNING ${ACTION_COLUMNS}`,
          [optionId, userId]
        );
        await notify(rows[0]);
        return { statusCode: 200, data: summarize(rows[0]) };
      }

      // POST /positive-sum/options/:id/join on a proposed collaboration — join
      // it: you become a participant on the action and an observation goes on
      // it, your comment about your ideas and how you want to be involved, or
      // a short note when you wrote nothing. The first join moves it from an
      // open proposal to "not started", so it shows in action lists. Joining
      // again only adds another comment.
      if (!context && verb === 'join' && isProposal(option, proposalIds)) {
        if (!JOINABLE_STATUSES.includes(option.status)) throw new HttpError(409, 'This is already done');
        const joined = (option.participants || []).map(String).includes(String(userId));
        const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
        if (joined && !comment) return { statusCode: 200, data: summarize(option) };
        const { rows } = joined ? { rows: [option] } : await client.query(
          `UPDATE actions SET participants = array_append(COALESCE(participants, ARRAY[]::uuid[]), $2::uuid),
                  status = CASE WHEN status = $3 THEN 'not_started' ELSE status END, updated_at = NOW()
            WHERE id = $1 RETURNING ${ACTION_COLUMNS}`,
          [optionId, userId, OPEN_STATUS]
        );
        const state = await client.query(
          `INSERT INTO states (organization_id, state_text, captured_by, captured_at)
           VALUES ($1, $2, $3, NOW()) RETURNING id`,
          [option.organization_id, comment || 'Joined', userId]
        );
        await client.query(
          `INSERT INTO state_links (state_id, entity_type, entity_id) VALUES ($1, 'action', $2)`,
          [state.rows[0].id, optionId]
        );
        await notify(rows[0]);
        return { statusCode: 200, data: summarize(rows[0]) };
      }

      if (!context) throw new HttpError(400, 'Not an option');
      const started = ![OPEN_STATUS, 'not_started'].includes(option.status);

      // POST /positive-sum/options/:id/join — join as an implementor
      if (verb === 'join') {
        if (started) throw new HttpError(409, 'This option has already started');
        if (implementorIds(option).includes(String(userId))) return { statusCode: 200, data: summarize(option) };
        if (!hasFreeCapacity(option, context.capacity)) throw new HttpError(409, 'This option is full');
        const { rows } = await client.query(
          `UPDATE actions SET participants = array_append(COALESCE(participants, ARRAY[]::uuid[]), $2::uuid),
                  updated_at = NOW()
            WHERE id = $1 RETURNING ${ACTION_COLUMNS}`,
          [optionId, userId]
        );
        await notify(rows[0]);
        return { statusCode: 200, data: summarize(rows[0], { capacity: context.capacity }) };
      }

      // POST /positive-sum/options/:id/approve — recipient or implementor
      if (verb === 'approve') {
        const goals = await loadActions(client, context.goal_ids || []);
        const myGoal = goals.find(g => String(g.created_by) === String(userId) &&
          (!body.goal_id || g.id === body.goal_id));
        const isImplementor = implementorIds(option).includes(String(userId));
        if (!myGoal && !isImplementor) throw new HttpError(403, 'Only a recipient or implementor can approve');

        const existing = records.approvals.filter(a => a.option_id === optionId);
        const add = async (basis, extra = {}) => {
          if (existing.some(a => a.approver === String(userId) && a.basis === basis)) return;
          await insertRecord(client, {
            organizationId: option.organization_id, userId, type: STATE_TYPES.APPROVAL,
            payload: { option_id: optionId, goal_id: myGoal?.id || null, basis, ...extra },
            links: [
              { entity_type: 'action', entity_id: optionId },
              ...(myGoal ? [{ entity_type: 'action', entity_id: myGoal.id }] : []),
            ],
          });
          existing.push({ approver: String(userId), option_id: optionId, basis });
        };

        if (myGoal) {
          await add('recipient');
          if (needsImplementorApproval(option) && !isApproved(option, existing)) {
            const past = await pastExperiences(client, String(userId), records.contexts, records.approvals);
            if (qualifiesForAutoApproval(option, context.source_option_ids, past)) {
              const evidence = past.find(p => p.completed && p.photo_count > 0);
              await add('association_default', { rule: 'similar_evidenced_experience', evidence_id: evidence?.id || null });
            }
          }
        }
        if (isImplementor) await add('implementor');

        let updated = option;
        if (option.status === OPEN_STATUS && isApproved(option, existing)) {
          const { rows } = await client.query(
            `UPDATE actions SET status = 'not_started',
                    policy_agreed_by = COALESCE(policy_agreed_by, $2), policy_agreed_at = COALESCE(policy_agreed_at, NOW()),
                    updated_at = NOW()
              WHERE id = $1 RETURNING ${ACTION_COLUMNS}`,
            [optionId, String(userId)]
          );
          updated = rows[0];
          await notify(updated);
        }
        return {
          statusCode: 200,
          data: summarize(updated, { approvals: existing.filter(a => a.option_id === optionId) }),
        };
      }
    }

    // GET /positive-sum/opportunities — today's list (refreshes once a day)
    if (httpMethod === 'GET' && path.endsWith('/positive-sum/opportunities')) {
      const orgIds = scopedOrgIds(query.org_ids);
      if (orgIds.length === 0) return { statusCode: 200, data: [] };
      const records = await loadRecords(client, orgIds);
      const today = dayKey();
      const passed = new Set(records.passes.filter(p => p.person === String(userId)).map(p => p.item_id));

      const { rows: open } = await client.query(
        `SELECT ${actionColumns('a')}, o.name AS organization_name, om.full_name AS created_by_name FROM actions a
           JOIN organizations o ON o.id = a.organization_id
           LEFT JOIN organization_members om
             ON om.cognito_user_id = a.created_by::text AND om.organization_id = a.organization_id
          WHERE a.organization_id = ANY($1::uuid[]) AND a.status IN ($2, 'not_started')
          ORDER BY a.created_at DESC`,
        [orgIds, OPEN_STATUS]
      );
      const myGoalIds = new Set(open.filter(a => isGoal(a) && String(a.created_by) === String(userId)).map(a => a.id));
      const available = open.filter(a => {
        if (String(a.created_by) === String(userId) || passed.has(a.id)) return false;
        const context = records.contexts[a.id];
        // Options for my own goals are in "Waiting on me", not opportunities.
        if (context) {
          return hasFreeCapacity(a, context.capacity) && !implementorIds(a).includes(String(userId)) &&
            !(context.goal_ids || []).some(id => myGoalIds.has(id));
        }
        return a.status === OPEN_STATUS && isGoal(a);
      });
      const byId = Object.fromEntries(available.map(a => [a.id, a]));

      const todays = records.lists
        .filter(l => l.person === String(userId) && l.date === today)
        .sort((a, b) => new Date(b.captured_at) - new Date(a.captured_at))[0];
      let ids = todays ? todays.item_ids.filter(id => byId[id]) : null;
      // An empty list (nothing was open yet) doesn't hold for the rest of the day.
      if (!todays || todays.item_ids.length === 0) {
        ids = available.slice(0, DAILY_LIST_SIZE).map(a => a.id);
        await insertRecord(client, {
          organizationId: orgIds[0], userId,
          type: STATE_TYPES.OPPORTUNITY_LIST, payload: { date: today, item_ids: ids }, links: [],
        });
      }
      return {
        statusCode: 200,
        data: ids.map(id => {
          const a = byId[id];
          const context = records.contexts[id];
          return summarize(a, {
            kind: context ? 'option' : 'goal',
            organization_name: a.organization_name,
            created_by_name: a.created_by_name,
            capacity: context?.capacity ?? null,
            goal_ids: context?.goal_ids ?? [],
          });
        }),
      };
    }

    // GET /positive-sum/mine — my desired states (goals) and what's ready for me
    if (httpMethod === 'GET' && path.endsWith('/positive-sum/mine')) {
      const orgIds = scopedOrgIds(query.org_id);
      if (orgIds.length === 0) return { statusCode: 200, data: { goals: [], ready: [], challenges: [], members: [] } };
      const records = await loadRecords(client, orgIds);
      const { options, index } = await implementorsIndex(client, records.contexts);
      const recipientApprovals = records.approvals.filter(a => a.basis === 'recipient');
      const valueOf = o => optionValue(o, recipientApprovals, index);

      const { rows: mineRows } = await client.query(
        `SELECT ${ACTION_COLUMNS} FROM actions
          WHERE organization_id = ANY($1::uuid[]) AND created_by = $2 AND NOT (id = ANY($3::uuid[]))
          ORDER BY created_at DESC`,
        [orgIds, userId, Object.keys(records.contexts)]
      );
      const optionsFor = goalId => options.filter(o => (records.contexts[o.id].goal_ids || []).includes(goalId));
      const approvedBy = (optionId, person, basis) =>
        records.approvals.some(a => a.option_id === optionId && a.approver === person && (!basis || a.basis === basis));

      const proposalIds = new Set(records.collaborations.map(l => l.goal_id));
      const myGoals = mineRows.filter(a => isProposal(a, proposalIds));
      const { comments, names } = await loadTakingPart(client, myGoals);
      const goals = myGoals.map(g => summarize(g, {
        title: proposalText(g),
        participants: (g.participants || []).map(String), // who joined
        taking_part: takingPart(g, comments, names),
        options: sortByValue(optionsFor(g.id), valueOf).map(o => summarize(o, {
          value: valueOf(o), approved_by_me: approvedBy(o.id, String(userId), 'recipient'),
        })),
      }));
      const openGoalIds = new Set(goals.filter(g => g.status === OPEN_STATUS).map(g => g.id));
      const toApproveAsRecipient = options.filter(o => o.status === OPEN_STATUS &&
        (records.contexts[o.id].goal_ids || []).some(id => openGoalIds.has(id)) &&
        !approvedBy(o.id, String(userId), 'recipient'));
      const toApproveAsImplementor = options.filter(o => o.status === OPEN_STATUS &&
        implementorIds(o).includes(String(userId)) && needsImplementorApproval(o) &&
        recipientApprovals.some(a => a.option_id === o.id) &&
        !approvedBy(o.id, String(userId), 'implementor') &&
        !records.approvals.some(a => a.option_id === o.id && a.basis === 'association_default'));
      const ready = [
        ...sortByValue(toApproveAsRecipient, valueOf).map(o => summarize(o, { role: 'recipient', value: valueOf(o) })),
        ...toApproveAsImplementor.map(o => summarize(o, { role: 'implementor' })),
      ];

      // Everyone's open challenges in these orgs, with the collaborations proposed for each.
      const { rows: openRows } = await client.query(
        `SELECT ${ACTION_COLUMNS} FROM actions WHERE organization_id = ANY($1::uuid[]) AND status = $2`,
        [orgIds, OPEN_STATUS]
      );
      const openChallenges = openRows.filter(a => !records.contexts[a.id] && isSituation(a, proposalIds));
      const proposed = await loadActions(client, records.collaborations.map(link => link.goal_id));
      const challenges = challengeSummaries({
        challenges: openChallenges, goals: proposed, collaborations: records.collaborations, userId,
        names: await loadNames(client, [
          ...openChallenges.map(challengeOwner), ...openChallenges.flatMap(c => (c.participants || []).map(String)),
          ...proposed.map(a => String(a.created_by)),
        ]),
      });
      for (const goal of goals) {
        goal.addresses = addressedChallenges(goal.id, records.collaborations, openChallenges);
      }
      // The people of these orgs and of the viewer's own orgs: who a challenge can be assigned to.
      const members = await loadMembers(client, [...new Set([...orgIds, ...memberOrgIds])]);
      return { statusCode: 200, data: { goals, ready, challenges, members } };
    }

    throw new HttpError(404, 'Not found');
  });
}

// When an option's action completes, the goals it served are done.
async function completeGoalsForOption(dbConfig, optionId, organizationId) {
  return withClient(dbConfig, async client => {
    const records = await loadRecords(client, [organizationId]);
    const goalIds = records.contexts[optionId]?.goal_ids || [];
    if (goalIds.length === 0) return;
    await client.query(
      `UPDATE actions SET status = 'completed', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE id = ANY($1::uuid[]) AND status = $2`,
      [goalIds, OPEN_STATUS]
    );
  });
}

module.exports = { handlePositiveSum, completeGoalsForOption, HttpError };
