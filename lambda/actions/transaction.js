// The action behind a transaction: rewards belong to actions, so an expense
// gets one only when someone uses the reward flow on it (draft → review →
// save). The expense's observation is linked to the action, not copied; the
// description already says what was traded, so the action carries no states of
// its own. The transaction and the other organization are kept in a TRANSACTION_CONTEXT
// bookkeeping state on the action. See docs/design/POSITIVE_SUM.md §2.6.
// All SQL here is parameterized.
const { STATE_TYPES, stateText, parseState } = require('./positiveSumRules');
const { HttpError, invokeModel, generationConfigId, loadOrgs, withClient } = require('./reward');

const DRAFT_VERSION = 'transaction-draft-v2';
const DRAFT_INFERENCE = { max_tokens: 500, effort: 'low' };

const DRAFT_PROMPT = `You help record one purchase on a farm network. From the transaction, say who was paid. Work only from what is given; never invent names. Where the transaction does not say, use an empty string.

- other_org_name: who was paid, as the person called them. other_org_id: that organization's id when it is in the organization list, otherwise null.

Call record_draft once.`;

const DRAFT_TOOL = {
  name: 'record_draft',
  description: 'Record the other organization in this transaction.',
  input_schema: {
    type: 'object',
    properties: {
      other_org_id: { type: ['string', 'null'] },
      other_org_name: { type: 'string' },
    },
    required: ['other_org_id', 'other_org_name'],
  },
};

// `type` and `financial_record_id` lead the state text, so a transaction's
// context can be found by prefix.
const contextPrefix = recordId => stateText(STATE_TYPES.TRANSACTION_CONTEXT, { financial_record_id: recordId }).slice(0, -1);

// The transaction with its description: the first observation linked to it.
async function loadRecord(client, recordId) {
  const { rows } = await client.query(
    `SELECT fr.id, fr.organization_id, fr.created_by, fr.transaction_date, fr.amount, fr.payment_method,
            o.name AS organization_name, s.id AS state_id, s.state_text AS description,
            (SELECT string_agg(sp.photo_description, E'\\n' ORDER BY sp.photo_order)
               FROM state_photos sp WHERE sp.state_id = s.id AND COALESCE(sp.photo_description, '') <> '') AS photo_text
       FROM financial_records fr
       JOIN organizations o ON o.id = fr.organization_id
       LEFT JOIN LATERAL (
         SELECT s.id, s.state_text FROM state_links sl JOIN states s ON s.id = sl.state_id
          WHERE sl.entity_type = 'financial_record' AND sl.entity_id = fr.id
          ORDER BY s.created_at, s.id LIMIT 1
       ) s ON true
      WHERE fr.id = $1`,
    [recordId]
  );
  return rows[0] || null;
}

// Same rule as the transaction itself: its recorder, or someone who reads the org's data.
function canView(record, { userId, accessibleOrgIds, canReadOrgData }) {
  if (!record || !accessibleOrgIds.includes(record.organization_id)) return false;
  return canReadOrgData || String(record.created_by) === String(userId);
}

async function contextForRecord(client, record) {
  const { rows } = await client.query(
    `SELECT state_text FROM states
      WHERE organization_id = $1 AND state_text LIKE $2
      ORDER BY created_at DESC LIMIT 1`,
    [record.organization_id, `${contextPrefix(record.id)}%`]
  );
  return rows[0] ? parseState(rows[0].state_text) : null;
}

async function orgName(client, orgId) {
  const { rows } = await client.query('SELECT name FROM organizations WHERE id = $1', [orgId]);
  return rows[0]?.name ?? null;
}

async function summarize(client, context) {
  return context && {
    action_id: context.action_id,
    other_org: { id: context.other_org_id, name: await orgName(client, context.other_org_id) },
  };
}

// The transaction behind an action, as the fact the reward build starts from;
// null for ordinary actions. Money out is positive on the record.
async function transactionForAction(client, actionId) {
  const { rows } = await client.query(
    `SELECT s.state_text FROM states s JOIN state_links sl ON sl.state_id = s.id
      WHERE sl.entity_type = 'action' AND sl.entity_id = $1 AND s.state_text LIKE $2
      LIMIT 1`,
    [actionId, `${contextPrefix('').slice(0, -1)}%`]
  );
  const context = rows[0] && parseState(rows[0].state_text);
  const record = context && await loadRecord(client, context.financial_record_id);
  if (!record) return null;
  const ours = { id: record.organization_id, name: record.organization_name };
  const theirs = { id: context.other_org_id, name: await orgName(client, context.other_org_id) };
  const [from, to] = Number(record.amount) < 0 ? [theirs, ours] : [ours, theirs];
  return {
    php: Math.abs(Number(record.amount)), date: record.transaction_date,
    from_org_id: from.id, from_name: from.name, to_org_id: to.id, to_name: to.name,
  };
}

function draftContext(record, orgs) {
  return [
    `Paying organization: ${record.organization_name}`,
    `Amount: ₱${Math.abs(Number(record.amount))} (${record.payment_method}) on ${new Date(record.transaction_date).toISOString().slice(0, 10)}`,
    `Description: ${(record.description || '').trim()}`,
    record.photo_text && `Photos: ${record.photo_text}`,
    '',
    'Organization list:',
    ...orgs.filter(o => o.id !== record.organization_id).map(o => `- ${o.name} (org id ${o.id})`),
  ].filter(l => l !== null && l !== undefined && l !== false).join('\n');
}

const text = v => (typeof v === 'string' ? v.trim() : '');

function validateDraft(input, orgs, ownOrgId) {
  const org = orgs.find(o => o.id === input?.other_org_id && o.id !== ownOrgId);
  return { other_org: { id: org?.id ?? null, name: org?.name ?? text(input?.other_org_name) } };
}

// Words that tell organizations apart; "the Lester's Farm" → ["lester"].
const FILLER = new Set(['the', 'and', 'farm', 'family', 'store', 'inc', 'corp']);
const nameKey = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');
// A final "s" is dropped so "Lesters" and "Lester's" both read as "lester".
const nameWords = name => name.toLowerCase().replace(/['’]s\b/g, '').split(/[^a-z0-9]+/)
  .map(w => (w.length > 3 ? w.replace(/s$/, '') : w))
  .filter(w => w.length >= 3 && !FILLER.has(w));

// Organizations whose name could be the same one: one name inside the other,
// or a telling word in common.
function similarOrgs(name, orgs) {
  const key = nameKey(name);
  const words = nameWords(name);
  if (key.length < 3) return [];
  return orgs.filter(o => {
    const other = nameKey(o.name);
    if (other.length >= 3 && (other.includes(key) || key.includes(other))) return true;
    return nameWords(o.name).some(w => words.some(q => w.startsWith(q) || q.startsWith(w)));
  });
}

const isSameName = (a, b) => nameKey(a) === nameKey(b);

async function createAction(client, { record, userId, otherOrgId, configId }) {
  const title = text(record.description) || `Transaction ${new Date(record.transaction_date).toISOString().slice(0, 10)}`;
  await client.query('BEGIN');
  try {
    const { rows } = await client.query(
      `INSERT INTO actions (id, organization_id, title, status,
         created_by, updated_by, assigned_to, participants, required_tools, attachments,
         created_at, updated_at, completed_at)
       VALUES (gen_random_uuid(), $1, $2, 'completed', $3, $3, $4, '{}'::uuid[], '{}'::text[], '{}'::text[],
         NOW(), NOW(), $5)
       RETURNING id`,
      [
        record.organization_id, title.length > 80 ? `${title.slice(0, 77)}...` : title,
        userId, record.created_by || userId, record.transaction_date,
      ]
    );
    const actionId = rows[0].id;
    if (record.state_id) {
      await client.query(
        `INSERT INTO state_links (state_id, entity_type, entity_id) VALUES ($1, 'action', $2)`,
        [record.state_id, actionId]
      );
    }
    const context = {
      financial_record_id: record.id, action_id: actionId, other_org_id: otherOrgId,
      llm_generation_config_id: configId || null,
    };
    const state = await client.query(
      `INSERT INTO states (organization_id, state_text, captured_by, captured_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id`,
      [record.organization_id, stateText(STATE_TYPES.TRANSACTION_CONTEXT, context), userId]
    );
    await client.query(
      `INSERT INTO state_links (state_id, entity_type, entity_id) VALUES ($1, 'action', $2)`,
      [state.rows[0].id, actionId]
    );
    await client.query('COMMIT');
    return context;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

// GET  /financial-records/{id}/action        — the action behind it (or null)
// POST /financial-records/{id}/action/draft  — LLM draft for the review
// POST /financial-records/{id}/action        — create it from the reviewed draft
async function handleTransactionAction({ httpMethod, recordId, isDraft, body, auth, dbConfig }) {
  return withClient(dbConfig, async client => {
    const record = await loadRecord(client, recordId);
    if (!canView(record, auth)) throw new HttpError(404, 'Transaction not found');
    const existing = await contextForRecord(client, record);

    if (httpMethod === 'GET') return { statusCode: 200, data: await summarize(client, existing) };
    if (existing) return { statusCode: 200, data: await summarize(client, existing) };

    if (isDraft) {
      const orgs = await loadOrgs(client);
      const options = { system: DRAFT_PROMPT, tool: DRAFT_TOOL, inference: DRAFT_INFERENCE };
      const input = await invokeModel(draftContext(record, orgs), options);
      const configId = await generationConfigId(client, { version: DRAFT_VERSION, ...options });
      return { statusCode: 200, data: { ...validateDraft(input, orgs, record.organization_id), llm_generation_config_id: configId } };
    }

    const otherOrgId = body.other_org_id;
    const orgs = await loadOrgs(client);
    if (!orgs.some(o => o.id === otherOrgId) || otherOrgId === record.organization_id) {
      throw new HttpError(400, 'Choose the other organization in this transaction');
    }
    const context = await createAction(client, {
      record, userId: auth.userId, otherOrgId, configId: body.llm_generation_config_id,
    });
    return { statusCode: 201, data: await summarize(client, context) };
  });
}

// GET  /positive-sum/organizations?name= — similar names from all organizations, names only
// POST /positive-sum/organizations       — create one that does not exist yet
async function handleOrganizations({ httpMethod, name, auth, dbConfig }) {
  const wanted = text(name);
  if (!wanted) throw new HttpError(400, 'name is required');
  return withClient(dbConfig, async client => {
    const orgs = await loadOrgs(client);
    if (httpMethod === 'GET') {
      return { statusCode: 200, data: similarOrgs(wanted, orgs).map(o => ({ id: o.id, name: o.name })) };
    }

    const same = orgs.find(o => isSameName(o.name, wanted));
    if (same) throw new HttpError(409, `${same.name} already exists`);

    await client.query('BEGIN');
    try {
      const { rows } = await client.query(
        `INSERT INTO organizations (name, subdomain, is_active, settings, created_at, updated_at)
         VALUES ($1, NULL, true, $2, NOW(), NOW()) RETURNING id, name`,
        [wanted, JSON.stringify({ created_by: auth.userId })]
      );
      // The creator is not made a member; a super-admin is seeded as in the admin flow.
      if (auth.isSuperAdmin) {
        await client.query(
          `INSERT INTO organization_members
             (organization_id, user_id, cognito_user_id, role, super_admin, is_active, full_name, email, favorite_color, created_at)
           SELECT $1, user_id, cognito_user_id, 'admin', true, true, full_name, email, favorite_color, NOW()
             FROM organization_members WHERE cognito_user_id = $2 AND is_active LIMIT 1`,
          [rows[0].id, auth.userId]
        );
      }
      await client.query('COMMIT');
      return { statusCode: 201, data: rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

module.exports = {
  handleTransactionAction, handleOrganizations, transactionForAction,
  canView, validateDraft, draftContext, similarOrgs, isSameName, contextPrefix,
};
