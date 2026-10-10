// Rewards of an action: claims about what moved between organizations (money,
// goods, time, help), extracted by an LLM from the action's observations and
// stored as the action's REWARD perspective (state_perspectives.action_id).
// Derived only — people change it by editing or adding observations and
// rebuilding. Amounts are only what people stated; totals, credit and net are
// derived elsewhere. See docs/design/POSITIVE_SUM.md.
const { Client } = require('pg');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

// Most capable Claude model this account can invoke on Bedrock (Opus 5 /
// Sonnet 5 are not enabled for it yet).
const MODEL_ID = process.env.REWARD_MODEL_ID || 'us.anthropic.claude-opus-4-6-v1';
const PROMPT_VERSION = 'reward-v10';
const INFERENCE_CONFIG = { max_tokens: 8000, effort: 'low' };

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' });
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-west-2' });

const COST_BASES = ['purchase_price', 'next_best_option_price'];
// What a next-best option is for its party: what the same thing would have
// cost another way, what the party would have had without this action, or
// that there was no other way (capability expanding; no advantage to work out).
const OPTION_KINDS = ['cost_another_way', 'had_otherwise', 'no_other_option'];

const SYSTEM_PROMPT = `You record claims about what moved between organizations during one action on a farm network: money, goods, time and help. Each claim is what someone said, not an established fact. Work only from the action and its observations; never invent people, amounts or outcomes.

Organizations:
- Match the organizations people mention to the organization list by name. Use the org id whenever the organization exists in the list; use null only when it does not, and always give the name as people called it.
- When a name matches more than one listed organization, prefer one connected to the people on the action. If it is still ambiguous, use null and say why in the claim.
- People on the action act for the action's organization unless an observation says otherwise.
- Only involve an association organization when an observation says it was involved.
- A purchase is a claim from the seller (by name if not listed) to the buyer.
- Time spent dealing with another organization — requests, follow-ups, applications, compliance, waiting on an agency — is paid to that organization: a claim from the organization whose people spent it to the organization they dealt with (e.g. 10 hours following up a request with the DA is a claim to the DA).
- Other time or money an organization spent on the action itself (not given to or demanded by anyone else, e.g. travel) is a claim from that organization to itself.

Amounts:
- php and hours are totals only as people stated them. Never estimate and never calculate a total from other numbers. If no total was stated, use null.
- One exception for time: "a whole day" is 8 hours per person; multiply by the number of people stated (e.g. three people for a whole day = 24 hours).
- When separate items each have a stated value (e.g. "the buck is worth 20k and the female 4k"), make one claim per item so each total is stated.
- When only a per-unit figure was stated (e.g. "10 seedlings at 50 each"), leave the total null and keep the figures in the claim.
- cost_basis_method: "purchase_price" when the amount is what was actually paid; "next_best_option_price" when it is what it would cost to get it another way (e.g. a seller's listing); null otherwise.

For each claim:
- name: a short label.
- claim: an information-dense account of what was said, by whom, in their words where possible; keep every number and name, including figures not captured in php or hours.
- source_state_ids: ids of the observations it comes from.

Transaction:
- When the action comes from a transaction, the amount paid is a fact from the record. Record it as exactly one claim from the organization that paid to the organization that was paid, with that php and cost_basis_method "purchase_price"; it needs no source observations. Do not record the same payment again from the observations.

Next-best options (as many as were stated, each for one party):
- Record one only when someone said what the alternative was. Anyone may state one for any party; it is their claim, not an established fact.
- for_org_id and for_name: the party whose alternative it is, matched to the organization list like any other party.
- kind: "cost_another_way" when it is what getting the same thing another way would have cost that party (e.g. hiring a truck instead of the pastor driving; 2 hours of asking around to find the suckers); "had_otherwise" when it is what that party would have had without this action (e.g. the suckers left in the clump, worth about 10); "no_other_option" when someone said that party had no other way to get this — php and hours are then null. Not doing it at all is not an alternative; never record it as one.
- php and hours are as stated. Here only, you may add up stated parts (e.g. "1.5k driver + 4.5k gas" = 6000); show the working in its claim. Never turn hours into pesos: keep hours as hours and keep any stated hourly rate in the claim.
- Hours are the party's own: time belongs to the organization, never to a named person. Do not attribute hours to an individual in the name or the claim ("about 2 hours of asking around", not "2 hours of May's time").
- replaces: the names of the claims above that this alternative stands in place of for that party — only those for the same outcome, and only that party's own side of it: what it paid for "cost_another_way" (e.g. the transport payments, not goods received on the trip), what it received for "had_otherwise" (e.g. for a seller, the payment). Never list both the payment and the goods bought with it.

Call record_claims once with all claims and next-best options. If the observations describe nothing moving between organizations, call it with an empty list.`;

const TOOL = {
  name: 'record_claims',
  description: 'Record the claims about what moved between organizations in this action.',
  input_schema: {
    type: 'object',
    properties: {
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            from_org_id: { type: ['string', 'null'] },
            from_name: { type: 'string' },
            to_org_id: { type: ['string', 'null'] },
            to_name: { type: 'string' },
            php: { type: ['number', 'null'] },
            hours: { type: ['number', 'null'] },
            cost_basis_method: { type: ['string', 'null'], enum: [...COST_BASES, null] },
            claim: { type: 'string' },
            source_state_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['name', 'from_org_id', 'from_name', 'to_org_id', 'to_name', 'php', 'hours', 'cost_basis_method', 'claim', 'source_state_ids'],
        },
      },
      next_best_options: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            for_org_id: { type: ['string', 'null'] },
            for_name: { type: 'string' },
            kind: { type: 'string', enum: OPTION_KINDS },
            php: { type: ['number', 'null'] },
            hours: { type: ['number', 'null'] },
            replaces: { type: 'array', items: { type: 'string' } },
            claim: { type: 'string' },
            source_state_ids: { type: 'array', items: { type: 'string' } },
          },
          required: ['name', 'for_org_id', 'for_name', 'kind', 'php', 'hours', 'replaces', 'claim', 'source_state_ids'],
        },
      },
    },
    required: ['claims', 'next_best_options'],
  },
};

async function withClient(dbConfig, fn) {
  const client = new Client(dbConfig);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function loadAction(client, actionId) {
  const { rows } = await client.query(
    `SELECT id, organization_id, title, description, policy, status, created_by, assigned_to, participants, created_at, completed_at
     FROM actions WHERE id = $1`,
    [actionId]
  );
  return rows[0] || null;
}

// Observations on the action, oldest first, without Positive Sum bookkeeping.
async function loadObservations(client, actionId) {
  const { rows } = await client.query(
    `SELECT s.id, s.captured_by, s.created_at,
            COALESCE(NULLIF(s.state_text, ''),
              (SELECT string_agg(sp.photo_description, E'\\n' ORDER BY sp.photo_order)
               FROM state_photos sp WHERE sp.state_id = s.id AND COALESCE(sp.photo_description, '') <> ''),
              '') AS text
     FROM states s
     JOIN state_links sl ON sl.state_id = s.id
     WHERE sl.entity_type = 'action' AND sl.entity_id = $1
       AND COALESCE(s.state_text, '') NOT LIKE '{"type":"positive_sum.%'
     ORDER BY s.created_at`,
    [actionId]
  );
  return rows.filter(r => r.text.trim());
}

// Everyone on the action, with the organizations they belong to.
async function loadPeople(client, userIds) {
  if (!userIds.length) return [];
  const { rows } = await client.query(
    `SELECT om.cognito_user_id AS user_id, om.full_name, o.id AS org_id, o.name AS org_name,
            COALESCE(o.settings->'enabled_features', '[]'::jsonb) ? 'positive_sum' AS is_association
     FROM organization_members om
     JOIN organizations o ON o.id = om.organization_id
     WHERE om.cognito_user_id = ANY($1) AND om.is_active
     ORDER BY om.full_name, o.name`,
    [userIds]
  );
  const people = new Map();
  for (const r of rows) {
    if (!people.has(r.user_id)) people.set(r.user_id, { user_id: r.user_id, name: (r.full_name || '').trim(), orgs: [] });
    people.get(r.user_id).orgs.push({ id: r.org_id, name: r.org_name, is_association: r.is_association });
  }
  return [...people.values()];
}

// Every active organization, for matching names people mention.
async function loadOrgs(client) {
  const { rows } = await client.query(
    `SELECT id, name, COALESCE(settings->'enabled_features', '[]'::jsonb) ? 'positive_sum' AS is_association
     FROM organizations
     WHERE is_active AND COALESCE(settings->>'deleted', 'false') <> 'true'
     ORDER BY name`
  );
  return rows;
}

function personIds(action, observations) {
  return [...new Set([
    action.created_by, action.assigned_to, ...(action.participants || []), ...observations.map(o => o.captured_by),
  ].filter(Boolean))];
}

function buildContext(action, observations, people, orgs, transaction) {
  const nameOf = id => people.find(p => p.user_id === id)?.name || 'Unknown person';
  const orgName = id => orgs.find(o => o.id === id)?.name || 'Unknown organization';
  const date = d => (d ? new Date(d).toISOString().slice(0, 10) : '');
  const lines = [
    `Action: ${action.title || ''} (organization: ${orgName(action.organization_id)}, org id ${action.organization_id})`,
    action.description && `Description: ${action.description}`,
    action.policy && `Policy: ${action.policy}`,
    `Status: ${action.status}${action.completed_at ? `, completed ${date(action.completed_at)}` : ''}`,
    transaction && `Transaction (a fact from the record): ₱${transaction.php} paid by ${transaction.from_name}${transaction.from_org_id ? ` (org id ${transaction.from_org_id})` : ''} to ${transaction.to_name}${transaction.to_org_id ? ` (org id ${transaction.to_org_id})` : ''} on ${date(transaction.date)}`,
    '',
    'People on the action and the organizations they belong to:',
    ...people.map(p => `- ${p.name}: ${p.orgs.map(o => o.name).join('; ')}`),
    '',
    'Organization list:',
    ...orgs.map(o => `- ${o.name} (org id ${o.id}${o.is_association ? ', association' : ''})`),
    '',
    'Observations:',
    ...observations.map(o => `[observation ${o.id}] ${date(o.created_at)} — ${nameOf(o.captured_by)}: ${o.text.trim()}`),
  ];
  return lines.filter(l => l !== undefined && l !== null && l !== false).join('\n');
}

// Keeps only claims that fit the contract; org ids must be listed organizations.
function validateClaims(input, orgIds, observationIds) {
  const list = Array.isArray(input?.claims) ? input.claims : [];
  const text = v => (typeof v === 'string' ? v.trim() : '');
  const orgId = v => (orgIds.includes(v) ? v : null);
  const amount = v => (v === null || v === undefined || v === '' ? null : Number(v));
  return list
    .map(c => ({
      name: text(c?.name),
      from_org_id: orgId(c?.from_org_id),
      from_name: text(c?.from_name),
      to_org_id: orgId(c?.to_org_id),
      to_name: text(c?.to_name),
      php: amount(c?.php),
      hours: amount(c?.hours),
      cost_basis_method: COST_BASES.includes(c?.cost_basis_method) ? c.cost_basis_method : null,
      claim: text(c?.claim),
      source_state_ids: (Array.isArray(c?.source_state_ids) ? c.source_state_ids : []).filter(id => observationIds.includes(id)),
    }))
    .filter(c =>
      c.name && c.claim && (c.from_org_id || c.from_name) && (c.to_org_id || c.to_name) &&
      [c.php, c.hours].every(n => n === null || (Number.isFinite(n) && n >= 0))
    );
}

// Next-best options that fit the contract; each may only replace claims that exist.
function validateNextBestOptions(input, claimNames, orgIds, observationIds) {
  const list = Array.isArray(input?.next_best_options) ? input.next_best_options : [];
  const text = v => (typeof v === 'string' ? v.trim() : '');
  const amount = v => (v === null || v === undefined || v === '' ? null : Number(v));
  return list
    .map(o => ({
      name: text(o?.name),
      for_org_id: orgIds.includes(o?.for_org_id) ? o.for_org_id : null,
      for_name: text(o?.for_name),
      kind: OPTION_KINDS.includes(o?.kind) ? o.kind : null,
      php: amount(o?.php),
      hours: amount(o?.hours),
      replaces: (Array.isArray(o?.replaces) ? o.replaces : []).filter(n => claimNames.includes(n)),
      claim: text(o?.claim),
      source_state_ids: (Array.isArray(o?.source_state_ids) ? o.source_state_ids : []).filter(id => observationIds.includes(id)),
    }))
    .filter(o =>
      o.name && o.claim && o.kind && (o.for_org_id || o.for_name) &&
      [o.php, o.hours].every(n => n === null || (Number.isFinite(n) && n >= 0))
    );
}

// Who stated an option: the people whose observations it comes from.
function statedBy(option, observations, people) {
  const authors = observations.filter(o => option.source_state_ids.includes(o.id)).map(o => o.captured_by);
  return [...new Set(authors)].map(id => people.find(p => p.user_id === id)?.name).filter(Boolean);
}

async function invokeModel(userPrompt, { system = SYSTEM_PROMPT, tool = TOOL, inference = INFERENCE_CONFIG } = {}) {
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: inference.max_tokens,
    output_config: { effort: inference.effort },
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
    tools: [tool],
    tool_choice: { type: 'auto' },
  };
  const response = await bedrock.send(new InvokeModelCommand({
    modelId: MODEL_ID, contentType: 'application/json', accept: 'application/json', body: JSON.stringify(body),
  }));
  const parsed = JSON.parse(new TextDecoder().decode(response.body));
  const toolUse = (parsed.content || []).find(c => c.type === 'tool_use' && c.name === tool.name);
  if (!toolUse) throw new Error(`The model did not call ${tool.name} (stop_reason ${parsed.stop_reason})`);
  return toolUse.input;
}

async function generationConfigId(client, { version = PROMPT_VERSION, system = SYSTEM_PROMPT, inference = INFERENCE_CONFIG } = {}) {
  const existing = await client.query(
    'SELECT id FROM llm_generation_configs WHERE model_id = $1 AND version = $2 LIMIT 1',
    [MODEL_ID, version]
  );
  if (existing.rows.length) return existing.rows[0].id;
  const inserted = await client.query(
    `INSERT INTO llm_generation_configs (model_id, version, system_prompt, inference_config)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [MODEL_ID, version, system, JSON.stringify(inference)]
  );
  return inserted.rows[0].id;
}

async function readReward(client, actionId) {
  const { rows } = await client.query(
    `SELECT content, created_at, status, error_message FROM state_perspectives
     WHERE action_id = $1 AND perspective_type = 'REWARD'
     ORDER BY created_at DESC LIMIT 1`,
    [actionId]
  );
  const row = rows[0];
  return row ? { ...row.content, created_at: row.created_at, status: row.status, error: row.error_message } : null;
}

// One REWARD perspective per action, replaced on each rebuild. A failed
// rebuild keeps the previous rewards and records the error.
async function saveReward(client, actionId, configId, { content, error }) {
  const existing = await client.query(
    `SELECT id FROM state_perspectives WHERE action_id = $1 AND perspective_type = 'REWARD' ORDER BY created_at DESC`,
    [actionId]
  );
  const [keep, ...extra] = existing.rows.map(r => r.id);
  if (extra.length) await client.query('DELETE FROM state_perspectives WHERE id = ANY($1)', [extra]);
  if (keep && error) {
    await client.query(
      `UPDATE state_perspectives SET status = 'FAILED', error_message = $1, created_at = NOW() WHERE id = $2`,
      [error, keep]
    );
  } else if (keep) {
    await client.query(
      `UPDATE state_perspectives SET llm_generation_config_id = $1, status = 'SUCCESS', error_message = NULL,
              content = $2, created_at = NOW() WHERE id = $3`,
      [configId, JSON.stringify(content), keep]
    );
  } else {
    await client.query(
      `INSERT INTO state_perspectives (action_id, perspective_type, llm_generation_config_id, status, error_message, content)
       VALUES ($1, 'REWARD', $2, $3, $4, $5)`,
      [actionId, configId, error ? 'FAILED' : 'SUCCESS', error || null, JSON.stringify(content || { claims: [] })]
    );
  }
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Builds and saves the rewards. Runs in its own (async) invocation because the
// model takes longer than API Gateway's 29s limit. `loadTransaction` gives the
// transaction behind the action, when there is one (transaction.js).
async function buildReward({ actionId, userId, dbConfig, loadTransaction }) {
  return withClient(dbConfig, async client => {
    const action = await loadAction(client, actionId);
    if (!action) return; // deleted since the rebuild was requested
    const configId = await generationConfigId(client);
    try {
      const observations = await loadObservations(client, actionId);
      const people = await loadPeople(client, personIds(action, observations));
      const orgs = await loadOrgs(client);

      const transaction = loadTransaction ? await loadTransaction(client, actionId) : null;

      const input = await invokeModel(buildContext(action, observations, people, orgs, transaction));
      const orgIds = orgs.map(o => o.id);
      const observationIds = observations.map(o => o.id);
      const claims = validateClaims(input, orgIds, observationIds);
      const nextBestOptions = validateNextBestOptions(input, claims.map(c => c.name), orgIds, observationIds)
        .map(o => ({ ...o, stated_by: statedBy(o, observations, people) }));
      const usedOrgIds = new Set([
        ...claims.flatMap(c => [c.from_org_id, c.to_org_id]), ...nextBestOptions.map(o => o.for_org_id),
      ].filter(Boolean));
      const content = {
        claims,
        next_best_options: nextBestOptions,
        org_names: Object.fromEntries(orgs.filter(o => usedOrgIds.has(o.id)).map(o => [o.id, o.name])),
        context_state_ids: observations.map(o => o.id),
        generated_by: userId,
      };
      await saveReward(client, actionId, configId, { content });
    } catch (error) {
      console.error('[REWARD] build failed:', error);
      await saveReward(client, actionId, configId, { error: error.message || 'Rebuild failed' });
    }
  });
}

// GET  /actions/{id}/reward — the latest rewards (or null)
// POST /actions/{id}/reward — start a rebuild from the action's current
//      observations; returns 202 and the caller polls GET for the result.
async function handleReward({ httpMethod, actionId, userId, accessibleOrgIds, dbConfig }) {
  return withClient(dbConfig, async client => {
    const action = await loadAction(client, actionId);
    if (!action || !accessibleOrgIds.includes(action.organization_id)) throw new HttpError(404, 'Action not found');

    if (httpMethod === 'GET') return { statusCode: 200, data: await readReward(client, actionId) };

    const observations = await loadObservations(client, actionId);
    if (!observations.length) throw new HttpError(400, 'Add observations about what happened first');
    await lambda.send(new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: JSON.stringify({ rewardBuild: { actionId, userId } }),
    }));
    return { statusCode: 202, data: { building: true } };
  });
}

module.exports = {
  handleReward, buildReward, HttpError, buildContext, validateClaims, validateNextBestOptions, statedBy, personIds,
  invokeModel, generationConfigId, loadOrgs, withClient, MODEL_ID,
};
