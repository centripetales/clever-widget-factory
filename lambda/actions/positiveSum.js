// Positive Sum routes (goals, policies, options, approvals, opportunities).
// Rules live in positiveSumRules.js; this file is data access + HTTP.
// All SQL here is parameterized.
const { Client } = require('pg');
const {
  STATE_PREFIX,
  STATE_TYPES,
  OPEN_STATUS,
  DAILY_LIST_SIZE,
  stateText,
  parseState,
  implementorIds,
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
  for (const r of ofType(STATE_TYPES.OPTION_CONTEXT)) contexts[r.data.option_id] = r.data;
  const approvals = ofType(STATE_TYPES.APPROVAL).map(r => ({
    approver: r.captured_by, option_id: r.data.option_id, goal_id: r.data.goal_id, basis: r.data.basis,
  }));
  const passes = ofType(STATE_TYPES.PASS).map(r => ({ person: r.captured_by, item_id: r.data.item_id }));
  const lists = ofType(STATE_TYPES.OPPORTUNITY_LIST).map(r => ({ person: r.captured_by, ...r.data, captured_at: r.captured_at }));
  return { contexts, approvals, passes, lists };
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
    policy_ids: contexts[o.id]?.policy_ids || [],
    completed: o.status === 'completed',
    photo_count: photoCount[o.id] || 0,
  }));
}

function isGoal(a) {
  return !!(a.expected_state && a.expected_state.trim()) && !(a.policy && a.policy.trim());
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
  const optionRoute = path.match(/\/positive-sum\/options\/([0-9a-f-]{36})\/(join|approve|pass)$/);
  const goalContextRoute = path.match(/\/positive-sum\/goals\/([0-9a-f-]{36})\/context$/);

  return withClient(dbConfig, async client => {
    // POST /positive-sum/goals — recipient states initial and desired state
    if (httpMethod === 'POST' && path.endsWith('/positive-sum/goals')) {
      const { organization_id, title, initial_state, desired_state, attachments } = body;
      requireMember(organization_id);
      if (!initial_state?.trim() || !desired_state?.trim()) {
        throw new HttpError(400, 'A goal needs both an initial state and a desired state');
      }
      const goal = await insertAction(client, {
        organization_id, title: titleFrom(title, desired_state), description: initial_state,
        expected_state: desired_state, created_by: userId, attachments,
      });
      await notify(goal);
      return { statusCode: 201, data: summarize(goal) };
    }

    // GET /positive-sum/goals/:id/context — what Maxwell needs to shape options:
    // the goal, options already suggested, and open offers in its org
    // (information is always free).
    if (httpMethod === 'GET' && goalContextRoute) {
      const [goal] = await loadActions(client, [goalContextRoute[1]]);
      if (!goal || !isGoal(goal)) throw new HttpError(404, 'Goal not found');
      requireMember(goal.organization_id);
      const records = await loadRecords(client, [goal.organization_id]);
      const optionIds = Object.values(records.contexts)
        .filter(c => (c.goal_ids || []).includes(goal.id)).map(c => c.option_id);
      const options = await loadActions(client, optionIds);
      const { rows: offers } = await client.query(
        `SELECT ${actionColumns('a')}, om.full_name AS created_by_name FROM actions a
           LEFT JOIN organization_members om
             ON om.cognito_user_id = a.created_by::text AND om.organization_id = a.organization_id
          WHERE a.organization_id = $1 AND a.status = $2
            AND COALESCE(TRIM(a.policy), '') <> '' AND COALESCE(TRIM(a.expected_state), '') = ''
          ORDER BY a.created_at DESC`,
        [goal.organization_id, OPEN_STATUS]
      );
      return {
        statusCode: 200,
        data: {
          goal: summarize(goal),
          options: options.map(o => summarize(o, { capacity: records.contexts[o.id]?.capacity })),
          offers: offers.map(o => summarize(o, { created_by_name: o.created_by_name })),
        },
      };
    }

    // POST /positive-sum/policies — an implementor's standing suggestion
    if (httpMethod === 'POST' && path.endsWith('/positive-sum/policies')) {
      const { organization_id, title, conditions, policy, required_tools } = body;
      requireMember(organization_id);
      if (!policy?.trim()) throw new HttpError(400, 'A policy needs its terms');
      const created = await insertAction(client, {
        organization_id, title: titleFrom(title, policy), description: conditions, policy,
        created_by: userId, assigned_to: userId, required_tools,
      });
      queueEmbedding(created);
      await notify(created);
      return { statusCode: 201, data: summarize(created) };
    }

    // POST /positive-sum/options — shaped in a conversation, then saved
    if (httpMethod === 'POST' && path.endsWith('/positive-sum/options')) {
      const {
        goal_ids = [], policy_ids = [], title, initial_state, policy, final_state,
        capacity = 1, required_tools = [], conversation_state_ids = [], parent_option_id = null,
      } = body;
      if (!policy?.trim() || !final_state?.trim()) {
        throw new HttpError(400, 'An option needs a policy and a final state');
      }
      const goals = await loadActions(client, goal_ids);
      const policies = await loadActions(client, policy_ids);
      if (goals.length !== goal_ids.length || policies.length !== policy_ids.length) {
        throw new HttpError(404, 'Goal or policy not found');
      }
      if (goals.some(g => !isGoal(g) || g.status !== OPEN_STATUS)) {
        throw new HttpError(400, 'Options can only be suggested for open goals');
      }
      const orgIds = [...new Set([...goals, ...policies].map(a => a.organization_id))];
      const organization_id = orgIds[0] || body.organization_id;
      if (orgIds.length > 1) throw new HttpError(400, 'Goals and policies must be in the same organization');
      requireMember(organization_id);

      // Built from published policies → their creators implement it (and must
      // agree unless the association default applies); otherwise the creator
      // suggests it themselves. Nobody else can be named — others join
      // themselves via /join.
      const implementors = policies.length
        ? [...new Set(policies.map(p => String(p.created_by)))]
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
        ...policy_ids.map(id => ({ entity_type: 'action', entity_id: id })),
        ...(parent_option_id ? [{ entity_type: 'action', entity_id: parent_option_id }] : []),
        ...conversation_state_ids.map(id => ({ entity_type: 'state', entity_id: id })),
      ];
      await insertRecord(client, {
        organizationId: organization_id, userId, type: STATE_TYPES.OPTION_CONTEXT,
        payload: { option_id: option.id, goal_ids, policy_ids, parent_option_id, capacity, conversation_state_ids },
        links,
      });
      queueEmbedding(option);
      await notify(option);
      return { statusCode: 201, data: summarize(option, { capacity, goal_ids, policy_ids, parent_option_id }) };
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
            if (qualifiesForAutoApproval(option, context.policy_ids, past)) {
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
      if (memberOrgIds.length === 0) return { statusCode: 200, data: [] };
      const records = await loadRecords(client, memberOrgIds);
      const today = dayKey();
      const passed = new Set(records.passes.filter(p => p.person === String(userId)).map(p => p.item_id));

      const { rows: open } = await client.query(
        `SELECT ${actionColumns('a')}, o.name AS organization_name, om.full_name AS created_by_name FROM actions a
           JOIN organizations o ON o.id = a.organization_id
           LEFT JOIN organization_members om
             ON om.cognito_user_id = a.created_by::text AND om.organization_id = a.organization_id
          WHERE a.organization_id = ANY($1::uuid[]) AND a.status IN ($2, 'not_started')
          ORDER BY a.created_at DESC`,
        [memberOrgIds, OPEN_STATUS]
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
          organizationId: authContext.organization_id || memberOrgIds[0], userId,
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

    // GET /positive-sum/mine — my goals, my policies, waiting on me
    if (httpMethod === 'GET' && path.endsWith('/positive-sum/mine')) {
      if (memberOrgIds.length === 0) return { statusCode: 200, data: { goals: [], policies: [], waiting: [] } };
      const records = await loadRecords(client, memberOrgIds);
      const { options, index } = await implementorsIndex(client, records.contexts);
      const recipientApprovals = records.approvals.filter(a => a.basis === 'recipient');
      const valueOf = o => optionValue(o, recipientApprovals, index);

      const { rows: mineRows } = await client.query(
        `SELECT ${ACTION_COLUMNS} FROM actions
          WHERE organization_id = ANY($1::uuid[]) AND created_by = $2 AND NOT (id = ANY($3::uuid[]))
          ORDER BY created_at DESC`,
        [memberOrgIds, userId, Object.keys(records.contexts)]
      );
      const optionsFor = goalId => options.filter(o => (records.contexts[o.id].goal_ids || []).includes(goalId));
      const approvedBy = (optionId, person, basis) =>
        records.approvals.some(a => a.option_id === optionId && a.approver === person && (!basis || a.basis === basis));

      const goals = mineRows.filter(isGoal).map(g => summarize(g, {
        options: sortByValue(optionsFor(g.id), valueOf).map(o => summarize(o, {
          value: valueOf(o), approved_by_me: approvedBy(o.id, String(userId), 'recipient'),
        })),
      }));
      const policies = mineRows.filter(a => (a.policy || '').trim() && !(a.expected_state || '').trim()).map(p => {
        const uses = options.filter(o => (records.contexts[o.id].policy_ids || []).includes(p.id));
        return summarize(p, {
          times_used: uses.length,
          accepted: uses.filter(o => recipientApprovals.some(a => a.option_id === o.id)).length,
          experiences: uses.filter(o => o.status === 'completed').map(o => summarize(o)),
        });
      });

      const openGoalIds = new Set(goals.filter(g => g.status === OPEN_STATUS).map(g => g.id));
      const toApproveAsRecipient = options.filter(o => o.status === OPEN_STATUS &&
        (records.contexts[o.id].goal_ids || []).some(id => openGoalIds.has(id)) &&
        !approvedBy(o.id, String(userId), 'recipient'));
      const toApproveAsImplementor = options.filter(o => o.status === OPEN_STATUS &&
        implementorIds(o).includes(String(userId)) && needsImplementorApproval(o) &&
        recipientApprovals.some(a => a.option_id === o.id) &&
        !approvedBy(o.id, String(userId), 'implementor') &&
        !records.approvals.some(a => a.option_id === o.id && a.basis === 'association_default'));
      const waiting = [
        ...sortByValue(toApproveAsRecipient, valueOf).map(o => summarize(o, { role: 'recipient', value: valueOf(o) })),
        ...toApproveAsImplementor.map(o => summarize(o, { role: 'implementor' })),
      ];
      return { statusCode: 200, data: { goals, policies, waiting } };
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
