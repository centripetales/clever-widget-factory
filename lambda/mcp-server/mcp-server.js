import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withDbClient } from './db.js';
import { generateEmbedding } from './embeddings.js';
import {
  createAction, updateAction, createObservation, updateObservation, policyToHtml,
  createSnapshot, updateSnapshot, deleteSnapshot,
  changeStock, createAsset, updateAsset,
  createExperience, updateExperience, deleteExperience,
} from './actions.js';

const SIMILARITY_THRESHOLD = 0.45;
const DEFAULT_LIMIT = 10;
const MAX_PHOTOS_PER_REQUEST = 5;
const S3_BUCKET_URL = 'https://cwf-dev-assets.s3.us-west-2.amazonaws.com';
// Some photo_url values are bare S3 keys; resolve them as the app's getImageUrl does.
const photoUrl = (u) => /^https?:\/\//.test(u) ? u : `${S3_BUCKET_URL}/${u.replace(/^\//, '')}`;

// The DB stores captured_at as a UTC instant. Returning that raw and letting
// the model guess at a timezone is exactly the bug this project already got
// bitten by once this session (UTC read as if it were Asia/Manila local
// time) — format explicitly here instead of trusting the caller to convert.
function formatManilaTime(utcDate) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(utcDate)) + ' PHT';
}

// Same reasoning as formatManilaTime: the caller (an LLM) has no reliable
// way to know "today's date" in the farm's timezone, so relative date words
// must be resolved here against the server's own clock, not guessed by the
// model. Manila has no DST, so subtracting whole days in UTC millis is safe.
function manilaDateString(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

function resolveRelativeDate(relative) {
  const now = new Date();
  const today = manilaDateString(now);
  const daysAgo = (n) => manilaDateString(new Date(now.getTime() - n * 24 * 60 * 60 * 1000));
  switch (relative) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const y = daysAgo(1); return { from: y, to: y }; }
    case 'last_7_days': return { from: daysAgo(6), to: today };
    case 'last_30_days': return { from: daysAgo(29), to: today };
    default: return { from: today, to: today };
  }
}

// Models reliably ignore prose instructions telling them to use `relative`
// instead of writing dates into `query` (observed directly in production
// logs — a call literally arrived as query: "yesterday recent July 31"
// despite the tool description explicitly saying not to do that). Rather
// than keep hoping the caller behaves, detect temporal language in the
// query text itself and route around it server-side.
const TEMPORAL_PATTERNS = [
  [/\byesterday\b/i, 'yesterday'],
  [/\btoday\b/i, 'today'],
  [/\b(this week|last 7 days|past week|past 7 days)\b/i, 'last_7_days'],
  [/\b(this month|last 30 days|past month|past 30 days)\b/i, 'last_30_days'],
];

function detectRelativeFromQueryText(text) {
  if (!text) return null;
  for (const [pattern, relative] of TEMPORAL_PATTERNS) {
    if (pattern.test(text)) return relative;
  }
  return null;
}

// Shared by every search tool: relative words win, then explicit dates, then
// temporal language caught in the query text (see TEMPORAL_PATTERNS).
function resolveWindow(toolName, { query, relative, date_from, date_to }) {
  let resolvedFrom = date_from;
  let resolvedTo = date_to;
  let effectiveRelative = relative;
  if (!effectiveRelative && !date_from && !date_to) {
    effectiveRelative = detectRelativeFromQueryText(query);
    if (effectiveRelative) {
      console.log(`${toolName}: detected temporal language in query text ("${query}") -> relative=${effectiveRelative}`);
    }
  }
  if (effectiveRelative) {
    const r = resolveRelativeDate(effectiveRelative);
    resolvedFrom = r.from;
    resolvedTo = r.to;
  }
  const isDateMode = Boolean(resolvedFrom || resolvedTo);
  return {
    resolvedFrom: resolvedFrom || resolvedTo,
    resolvedTo: resolvedTo || resolvedFrom,
    isDateMode,
  };
}

const NEEDS_QUERY_OR_DATES = {
  content: [{ type: 'text', text: 'Either query (topical search) or relative/date_from/date_to (date-range lookup) is required.' }],
  isError: true,
};

// Same two-mode search inputs for actions and financial records as for claims.
const SEARCH_INPUTS = {
  query: z.string().optional().describe('Natural language topical search. Ignored if relative/date_from/date_to given.'),
  relative: z.enum(['today', 'yesterday', 'last_7_days', 'last_30_days']).optional().describe('Preferred over date_from/date_to for anything phrased relative to today — resolved server-side in the farm\'s timezone (Asia/Manila).'),
  date_from: z.string().optional().describe('Start date YYYY-MM-DD (Asia/Manila, inclusive), for an explicit non-relative date only. Ignored if relative is given.'),
  date_to: z.string().optional().describe('End date YYYY-MM-DD (Asia/Manila, inclusive). Defaults to date_from if omitted. Ignored if relative is given.'),
  limit: z.number().int().min(1).max(25).optional().describe('Max results to return, default 10'),
};

const TWO_MODES =
  'Two modes, like search_claims — pick one:\n' +
  '1. Topical search: give `query` only, ranked by semantic similarity. Do NOT put dates in the query.\n' +
  '2. Date-range lookup: `relative` for anything relative to today, or `date_from`/`date_to` for a specific named date. Returns everything in the window, newest first.';

// Actions the app creates for a financial record (Positive Sum) duplicate the
// record and are hidden in the app too — same filter as lambda/actions.
const NOT_FROM_TRANSACTION = `NOT EXISTS (
  SELECT 1 FROM state_links tl JOIN states ts ON ts.id = tl.state_id
  WHERE tl.entity_type = 'action' AND tl.entity_id = a.id
    AND ts.state_text LIKE '{"type":"positive_sum.transaction_context"%'
)`;

// The actions the caller can see, given their orgs as the SQL parameter `orgs`:
// their orgs' own, and the proposed collaborations of an org one of their orgs
// is a member of (Positive Sum) — same rule as lambda/actions.
const VISIBLE_ACTION = (orgs) => `(a.organization_id = ANY(${orgs}::uuid[]) OR (
  a.organization_id IN (SELECT mo.organization_id FROM member_organizations mo WHERE mo.member_organization_id = ANY(${orgs}::uuid[]))
  AND EXISTS (
    SELECT 1 FROM state_links pl JOIN states ps ON ps.id = pl.state_id
    WHERE pl.entity_type = 'action' AND pl.entity_id = a.id
      AND ps.state_text LIKE '{"type":"positive_sum.collaboration"%'
  )
))`;

// What an observation can be linked to through the connector — the same as
// the observation screen's Link Asset (assets) and linked action.
const LINK = z.object({
  entity_type: z.enum(['action', 'tool', 'part']),
  entity_id: z.string(),
});

// The links that exist in the caller's orgs, with names for the reply.
async function findLinkTargets(client, links, orgIds) {
  if (links.length === 0) return [];
  return (await client.query(
    `SELECT 'action' AS entity_type, a.id::text AS entity_id, a.title AS name FROM actions a
       WHERE a.id::text = ANY($1::text[]) AND ${VISIBLE_ACTION('$2')}
     UNION ALL
     SELECT 'tool', id::text, name FROM tools WHERE id::text = ANY($1::text[]) AND organization_id = ANY($2::uuid[])
     UNION ALL
     SELECT 'part', id::text, name FROM parts WHERE id::text = ANY($1::text[]) AND organization_id = ANY($2::uuid[])`,
    [links.map((l) => l.entity_id), orgIds]
  )).rows;
}

// Metric values for an observation of a tool, like the observation screen's
// Metrics section. Metrics are defined per tool; search_assets lists them.
const METRIC_VALUES = z.array(z.object({
  metric_id: z.string(),
  value: z.union([z.string(), z.number()]).describe('The reading; a number unless the metric is text'),
})).describe('Metric values, for metrics of a tool the observation is linked to (search_assets lists each tool\'s metrics)');

// The active metrics of these tools in the caller's orgs.
async function findToolMetrics(client, toolIds, orgIds) {
  if (toolIds.length === 0) return [];
  return (await client.query(
    `SELECT metric_id::text AS metric_id, tool_id::text AS tool_id, name, unit, value_type, min_value, max_value
     FROM metrics
     WHERE tool_id::text = ANY($1::text[]) AND organization_id = ANY($2::uuid[]) AND active IS NOT FALSE
     ORDER BY created_at`,
    [toolIds, orgIds]
  )).rows;
}

// Saves each value through the snapshots service, as the app does after the
// observation itself: updates a reading already there, adds a new one, and a
// blank value removes it. Each metric reports its own result.
async function saveMetrics({ cognitoUserId, orgId, observationId, metrics, known, existing = [] }) {
  const results = [];
  for (const { metric_id, value } of metrics) {
    const name = known.find((m) => m.metric_id === metric_id).name;
    const text = String(value).trim();
    const snapshot = existing.find((s) => s.metric_id === metric_id);
    try {
      if (snapshot && text === '') await deleteSnapshot({ cognitoUserId, orgId, snapshotId: snapshot.snapshot_id });
      else if (snapshot) await updateSnapshot({ cognitoUserId, orgId, snapshotId: snapshot.snapshot_id, value: text });
      else if (text !== '') await createSnapshot({ cognitoUserId, orgId, observationId, metricId: metric_id, value: text });
      results.push({ metric: name, value: text || null, result: 'saved' });
    } catch (err) {
      results.push({ metric: name, value: text, result: `not saved: ${err.message}` });
    }
  }
  return results;
}

const unknownMetrics = (ids) => ({
  content: [{ type: 'text', text: `These metric_ids are not metrics of a tool the observation is linked to: ${ids.join(', ')}. search_assets lists each tool's metrics.` }],
  isError: true,
});

const sameLink = (a, b) => a.entity_type === b.entity_type && String(a.entity_id) === String(b.entity_id);

const notFound = (missing) => ({
  content: [{ type: 'text', text: `Not found in your organizations: ${missing.map((l) => `${l.entity_type} ${l.entity_id}`).join(', ')} — check the ids with search_actions / search_assets.` }],
  isError: true,
});

const CAPTURED_AT = z.string().datetime({ offset: true })
  .describe('When it was observed, ISO 8601 with offset, e.g. 2026-11-02T08:30:00+08:00. Leave out for now.');

// Turns people's names into the member user_ids the app stores, within one
// org; throws with the member list when a name matches no one or several.
async function memberResolver(orgId, names) {
  const members = names.filter(Boolean).length === 0 ? [] : await withDbClient(async (client) => (await client.query(
    `SELECT user_id::text AS user_id, full_name FROM organization_members
     WHERE organization_id = $1 AND is_active = true AND user_id IS NOT NULL`,
    [orgId]
  )).rows);
  return (name) => {
    const exact = members.filter((m) => m.full_name?.trim().toLowerCase() === name.trim().toLowerCase());
    const partial = members.filter((m) => m.full_name?.toLowerCase().includes(name.trim().toLowerCase()));
    const found = exact.length === 1 ? exact : partial;
    if (found.length === 1) return found[0].user_id;
    throw new Error(found.length === 0
      ? `No active member named "${name}". Members: ${members.map((m) => m.full_name).join(', ')}`
      : `"${name}" matches ${found.map((m) => m.full_name).join(', ')} — ask which one.`);
  };
}

const NOT_A_MEMBER = {
  content: [{ type: 'text', text: 'You are not an active member of any CWF organization, so there is no farm data to show.' }],
  isError: true,
};

// Assets (tools and parts) as the app's forms have them. Container,
// Infrastructure and Field tools are areas other assets can be in; a System
// is made of other assets (and Systems), linked by part_of observations.
const TOOL_CATEGORIES = ['Hand Tools', 'Electric Tool', 'Other', 'Container', 'Infrastructure', 'Biological', 'Field', 'System'];
const AREA_CATEGORIES = ['Container', 'Infrastructure', 'Field'];
const PART_ONLY = ['minimum_quantity', 'unit', 'cost_per_unit', 'sellable'];
const TOOL_ONLY = ['category', 'serial_number'];
const ASSET_FIELDS = {
  description: z.string().nullable().optional().describe('What it is: brand, model, size, condition'),
  category: z.enum(TOOL_CATEGORIES).nullable().optional().describe('Tools only. Container, Infrastructure or Field makes it an area other assets can be in; System makes it something other assets are part of (link_assets)'),
  serial_number: z.string().nullable().optional().describe('Tools only'),
  area_id: z.string().nullable().optional().describe('The area it is in: the asset_id of a Container, Infrastructure or Field tool (search_assets)'),
  storage_location: z.string().nullable().optional().describe('Where exactly within the area, e.g. "top shelf, left"'),
  accountable_person: z.string().nullable().optional().describe('Name of the person accountable for it; only leadership and admins can set it, as in the app'),
  minimum_quantity: z.number().min(0).nullable().optional().describe('Parts only. Below this it shows as low stock'),
  unit: z.string().optional().describe('Parts only, e.g. "pieces", "kg", "liters"'),
  cost_per_unit: z.number().min(0).nullable().optional().describe('Parts only, in pesos'),
  sellable: z.boolean().optional().describe('Parts only. Whether it is sold'),
};
const ASSET_LINK = (id) => `https://stargazer-farm.com/combined-assets/${id}/details`;

// The caller's role in an org; the app lets contributors, leadership and
// admins add and edit assets, and only leadership and admins choose who is
// accountable.
async function memberRole(cognitoUserId, orgId) {
  return withDbClient(async (client) => (await client.query(
    `SELECT role FROM organization_members WHERE cognito_user_id::text = $1 AND organization_id = $2 AND is_active = true`,
    [cognitoUserId, orgId]
  )).rows[0]?.role);
}

// The fields given, as the parts and tools service takes them, in one org.
// Throws when a field doesn't fit the type, the area isn't one, or the
// caller may not do this.
async function assetChanges({ type, fields, orgId, cognitoUserId }) {
  const wrong = Object.keys(fields).filter((k) => fields[k] !== undefined && (type === 'tool' ? PART_ONLY : TOOL_ONLY).includes(k));
  if (wrong.length > 0) throw new Error(`${wrong.join(', ')} ${wrong.length === 1 ? 'is' : 'are'} not for a ${type}.`);
  const role = await memberRole(cognitoUserId, orgId);
  if (!['contributor', 'leadership', 'admin'].includes(role)) throw new Error('Only contributors, leadership and admins can add or edit assets.');
  const { area_id, accountable_person, ...rest } = fields;
  const changes = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  if (area_id) {
    const area = await withDbClient(async (client) => (await client.query(
      `SELECT id FROM tools WHERE id::text = $1 AND organization_id = $2 AND category = ANY($3::text[]) AND COALESCE(status, '') <> 'removed'`,
      [area_id, orgId, AREA_CATEGORIES]
    )).rows[0]);
    if (!area) throw new Error(`${area_id} is not an area in this organization (a Container, Infrastructure or Field tool).`);
  }
  if (area_id !== undefined) changes.parent_structure_id = area_id;
  if (accountable_person !== undefined) {
    if (!['leadership', 'admin'].includes(role)) throw new Error('Only leadership and admins can choose who is accountable.');
    changes.accountable_person_id = accountable_person ? (await memberResolver(orgId, [accountable_person]))(accountable_person) : null;
  }
  return changes;
}

// The Systems an asset is part of, and the assets it is made of: each a
// part_of observation linked to the System (part_of) and the member (tool or
// part), from when it was recorded until a later observation ends it (an
// 'ends' link to it). Ended ones are kept as former.
const ENDED_AT = (startRef) => `LEFT JOIN LATERAL (
  SELECT es.captured_at FROM state_links e JOIN states es ON es.id = e.state_id
  WHERE e.entity_type = 'ends' AND e.entity_id = ${startRef}
  ORDER BY es.captured_at LIMIT 1
) ended ON true`;

async function findMemberships(client, assetId, orgIds) {
  const parents = (await client.query(
    `SELECT DISTINCT t.id::text AS asset_id, t.name, js.captured_at AS since, ended.captured_at AS until
     FROM state_links m
     JOIN state_links p ON p.state_id = m.state_id AND p.entity_type = 'part_of'
     JOIN states js ON js.id = m.state_id AND js.organization_id = ANY($2::uuid[])
     JOIN tools t ON t.id = p.entity_id
     ${ENDED_AT('js.id')}
     WHERE m.entity_type IN ('tool', 'part') AND m.entity_id::text = $1
     ORDER BY since`,
    [assetId, orgIds]
  )).rows;
  const children = (await client.query(
    `SELECT DISTINCT m.entity_id::text AS asset_id, m.entity_type AS type, COALESCE(t.name, pt.name) AS name,
            js.captured_at AS since, ended.captured_at AS until
     FROM state_links p
     JOIN state_links m ON m.state_id = p.state_id AND m.entity_type IN ('tool', 'part')
     JOIN states js ON js.id = p.state_id AND js.organization_id = ANY($2::uuid[])
     LEFT JOIN tools t ON m.entity_type = 'tool' AND t.id = m.entity_id
     LEFT JOIN parts pt ON m.entity_type = 'part' AND pt.id = m.entity_id
     ${ENDED_AT('js.id')}
     WHERE p.entity_type = 'part_of' AND p.entity_id::text = $1
     ORDER BY since`,
    [assetId, orgIds]
  )).rows;
  const dated = ({ since, until, ...rest }) => ({
    ...rest, since: formatManilaTime(since), ...(until && { until: formatManilaTime(until) }),
  });
  return {
    partOf: parents.filter((r) => !r.until).map(dated),
    formerlyPartOf: parents.filter((r) => r.until).map(dated),
    components: children.filter((r) => !r.until).map(dated),
    formerComponents: children.filter((r) => r.until).map(dated),
  };
}

// Experiences: a write-up on one tool or part of initial states, actions
// and final states (S → A → S'), each pointing at an existing observation or
// action. Any leg may be empty. The write-up holds no text of its own.
const LEGS = { initial_state: 'initial_states', action: 'actions', final_state: 'final_states' };
const LEG_ORDER = `CASE ec.component_type WHEN 'initial_state' THEN 1 WHEN 'action' THEN 2 ELSE 3 END`;

// Summaries of the experiences matching the filters, newest first, each
// with a short label per component (claim, start of the note, or action
// title), and how many match in all.
async function findExperiences(client, { orgIds, assetId, observationIds, actionIds, from, to, limit }) {
  const params = [orgIds];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  const where = ['e.organization_id = ANY($1::uuid[])'];
  if (assetId) where.push(`e.entity_id::text = ${add(assetId)}`);
  if (observationIds?.length || actionIds?.length) {
    where.push(`EXISTS (SELECT 1 FROM experience_components fc WHERE fc.experience_id = e.id
      AND (fc.state_id::text = ANY(${add(observationIds || [])}::text[]) OR fc.action_id::text = ANY(${add(actionIds || [])}::text[])))`);
  }
  if (from) {
    where.push(`e.created_at >= (${add(from)}::date::timestamp AT TIME ZONE 'Asia/Manila')
      AND e.created_at < ((${add(to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Manila')`);
  }
  const experiences = (await client.query(
    `SELECT e.id::text AS experience_id, e.entity_type AS type, e.entity_id::text AS asset_id,
            COALESCE(t.name, p.name) AS asset, e.created_at, om.full_name AS written_by,
            COUNT(*) OVER () AS total
     FROM experiences e
     LEFT JOIN tools t ON e.entity_type = 'tool' AND t.id = e.entity_id
     LEFT JOIN parts p ON e.entity_type = 'part' AND p.id = e.entity_id
     LEFT JOIN organization_members om ON om.id = e.created_by
     WHERE ${where.join(' AND ')}
     ORDER BY e.created_at DESC
     LIMIT ${add(limit)}`,
    params
  )).rows;
  if (experiences.length === 0) return { total: 0, experiences: [] };
  const components = (await client.query(
    `SELECT ec.experience_id::text AS experience_id, ec.component_type,
            COALESCE(c.claim, LEFT(s.state_text, 150), a.title) AS label
     FROM experience_components ec
     LEFT JOIN states s ON s.id = ec.state_id
     LEFT JOIN actions a ON a.id = ec.action_id
     LEFT JOIN LATERAL (
       SELECT cp.content->>'content' AS claim FROM state_perspectives cp
       WHERE cp.state_id = s.id AND cp.perspective_type = 'CLAIM' AND cp.status = 'SUCCESS' LIMIT 1
     ) c ON true
     WHERE ec.experience_id::text = ANY($1::text[])
     ORDER BY ${LEG_ORDER}, COALESCE(s.captured_at, a.completed_at, ec.created_at)`,
    [experiences.map((e) => e.experience_id)]
  )).rows;
  return {
    total: Number(experiences[0].total),
    experiences: experiences.map(({ total, created_at, type, asset_id, asset, ...e }) => {
      const mine = components.filter((c) => c.experience_id === e.experience_id);
      return {
        ...e,
        asset: asset_id ? { asset_id, type, name: asset } : null,
        written_at_manila: formatManilaTime(created_at),
        ...Object.fromEntries(Object.entries(LEGS).map(([type, leg]) => [leg, mine.filter((c) => c.component_type === type).map((c) => c.label)])),
      };
    }),
  };
}

// The observations and actions that exist in the caller's orgs, of those given.
async function missingComponents(client, { observationIds, actionIds }, orgIds) {
  const found = (await client.query(
    `SELECT id::text AS id FROM states WHERE id::text = ANY($1::text[]) AND organization_id = ANY($3::uuid[])
     UNION ALL
     SELECT id::text FROM actions WHERE id::text = ANY($2::text[]) AND organization_id = ANY($3::uuid[])`,
    [observationIds, actionIds, orgIds]
  )).rows.map((r) => r.id);
  return [...observationIds, ...actionIds].filter((id) => !found.includes(id));
}

const NOT_AN_EXPERIENCE = (id) => ({
  content: [{ type: 'text', text: `No experience ${id} in your organizations — find it with search_experiences.` }],
  isError: true,
});

const NOT_AN_ASSET = (id) => ({
  content: [{ type: 'text', text: `No tool or part ${id} in your organizations — find it with search_assets.` }],
  isError: true,
});

// When a photo was taken and where, from its own metadata (EXIF, the file,
// or the phone when it was uploaded), as far as they are known.
const PHOTO_METADATA = (photoUrlRef) => `LEFT JOIN LATERAL (
  SELECT pme.captured_at AS taken_at, pme.gps_latitude, pme.gps_longitude
  FROM photo_metadata_extractions pme WHERE pme.photo_url = ${photoUrlRef}
  ORDER BY pme.updated_at DESC NULLS LAST LIMIT 1
) pm ON true`;
// Unlike every other time here, a photo's captured_at holds Manila clock
// digits stored as if UTC (the app's convention for EXIF and file times; see
// manilaLocalDigitsAsUtc in lambda/states), so it is shifted back to the
// real instant before formatting.
const photoTakenWhere = (p) => ({
  ...(p.taken_at && { taken_at_manila: formatManilaTime(new Date(p.taken_at).getTime() - 8 * 3600 * 1000) }),
  ...(p.gps_latitude != null && p.gps_longitude != null && { gps: `${Number(p.gps_latitude)},${Number(p.gps_longitude)}` }),
});

// accessibleOrgIds, callerName, cognitoUserId and canWrite come from the
// authenticated caller (see orgs.js, auth.js); every query is limited to
// accessibleOrgIds.
function create({ accessibleOrgIds, callerName, cognitoUserId, canWrite = false }) {
  const server = new McpServer(
    { name: 'cwf-observations', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: callerName
        ? `You are talking with ${callerName}. Everyone's work is visible here; filter by person when the conversation is about one person.`
        : undefined,
    }
  );

  server.registerTool(
    'search_claims',
    {
      title: 'Search observation claims',
      description:
        'Search farm observation claims — dense, self-contained summaries of ' +
        'what each observation asserts (not the raw field note or photos). ' +
        'Observations get one whatever they are linked to; some older ones may not have one. ' +
        'Give asset_id (from search_assets) to search only one asset\'s observations.\n\n' +
        'Two modes, and they don\'t combine well — pick one:\n' +
        '1. Topical search: give `query` only. Ranks by semantic similarity. ' +
        'Do NOT put dates or "yesterday"/"this week" in the query text — ' +
        'similarity search cannot match on time, only on content.\n' +
        '2. Date-range lookup ("what happened yesterday/this week/on July 31"): ' +
        'use `relative` for anything relative to today ("yesterday", "today", ' +
        '"last_7_days", "last_30_days") — the server resolves the actual date ' +
        'using its own clock in the farm\'s timezone (Asia/Manila), since you ' +
        'don\'t reliably know today\'s date there. Only use `date_from`/`date_to` ' +
        '(YYYY-MM-DD) for an explicit, specific date the user names (e.g. "July 31" ' +
        'when it isn\'t relative to today). This mode ignores semantic ranking and ' +
        'returns everything in the window chronologically; `query` is not needed.',
      inputSchema: {
        query: z.string().optional().describe('Natural language topical search, e.g. "cogon suppression". Ignored if relative/date_from/date_to given.'),
        relative: z.enum(['today', 'yesterday', 'last_7_days', 'last_30_days']).optional().describe('Preferred over date_from/date_to for anything phrased relative to today — resolved server-side against the farm\'s actual timezone, not the caller\'s guess at today\'s date.'),
        date_from: z.string().optional().describe('Start date YYYY-MM-DD (Asia/Manila calendar date, inclusive), for an explicit non-relative date only. Ignored if relative is given.'),
        date_to: z.string().optional().describe('End date YYYY-MM-DD (Asia/Manila calendar date, inclusive). Defaults to date_from if omitted. Ignored if relative is given.'),
        limit: z.number().int().min(1).max(25).optional().describe('Max results to return, default 10'),
        asset_id: z.string().optional().describe('Only observations linked to this tool or part'),
      },
    },
    async ({ query, relative, date_from, date_to, limit, asset_id }) => {
      console.log('search_claims called with:', JSON.stringify({ query, relative, date_from, date_to, limit, asset_id }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      const effectiveLimit = limit || DEFAULT_LIMIT;

      const { resolvedFrom, resolvedTo, isDateMode } = resolveWindow('search_claims', { query, relative, date_from, date_to });
      if (!isDateMode && !query) return NEEDS_QUERY_OR_DATES;

      try {
        const results = await withDbClient(async (client) => {
          if (isDateMode) {
            const from = resolvedFrom;
            const to = resolvedTo;
            const sql = `
              SELECT
                1 as similarity,
                s.id as state_id,
                sp.content->>'content' as claim_text,
                s.captured_at,
                COALESCE(om.full_name, s.captured_by::text) as captured_by_name,
                EXISTS(SELECT 1 FROM state_photos sp2 WHERE sp2.state_id = s.id) as has_photos,
                (
                  SELECT string_agg(sl.entity_type || ':' || sl.entity_id::text, ', ')
                  FROM state_links sl WHERE sl.state_id = s.id
                ) as links
              FROM state_perspectives sp
              JOIN states s ON s.id = sp.state_id
              LEFT JOIN organization_members om
                ON s.captured_by::text = om.cognito_user_id::text AND s.organization_id = om.organization_id
              WHERE sp.perspective_type = 'CLAIM' AND sp.status = 'SUCCESS'
                AND s.organization_id = ANY($1::uuid[])
                AND s.captured_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Manila')
                AND s.captured_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Manila')
                AND ($5::text IS NULL OR EXISTS (
                  SELECT 1 FROM state_links al WHERE al.state_id = s.id
                    AND al.entity_type IN ('tool', 'part') AND al.entity_id::text = $5))
              ORDER BY s.captured_at DESC
              LIMIT $4
            `;
            const res = await client.query(sql, [accessibleOrgIds, from, to, effectiveLimit, asset_id || null]);
            return res.rows;
          }

          const queryEmbedding = await generateEmbedding(query);
          const embeddingStr = `[${queryEmbedding.join(',')}]`;
          const sql = `
            WITH query_vector AS (SELECT $1::vector AS vec),
            matches AS (
              SELECT entity_id, (1 - (embedding <=> (SELECT vec FROM query_vector))) as similarity
              FROM unified_embeddings
              WHERE organization_id = ANY($2::uuid[]) AND entity_type = 'claim_perspective'
                AND ($5::text IS NULL OR entity_id IN (
                  SELECT cp.id FROM state_perspectives cp
                  JOIN state_links al ON al.state_id = cp.state_id
                  WHERE al.entity_type IN ('tool', 'part') AND al.entity_id::text = $5))
              ORDER BY embedding <=> (SELECT vec FROM query_vector)
              LIMIT $3
            )
            SELECT
              m.similarity,
              s.id as state_id,
              sp.content->>'content' as claim_text,
              s.captured_at,
              COALESCE(om.full_name, s.captured_by::text) as captured_by_name,
              EXISTS(SELECT 1 FROM state_photos sp2 WHERE sp2.state_id = s.id) as has_photos,
              (
                SELECT string_agg(sl.entity_type || ':' || sl.entity_id::text, ', ')
                FROM state_links sl WHERE sl.state_id = s.id
              ) as links
            FROM matches m
            JOIN state_perspectives sp ON sp.id = m.entity_id
            JOIN states s ON s.id = sp.state_id
            LEFT JOIN organization_members om
              ON s.captured_by::text = om.cognito_user_id::text AND s.organization_id = om.organization_id
            WHERE m.similarity > $4
            ORDER BY m.similarity DESC
          `;
          const res = await client.query(sql, [embeddingStr, accessibleOrgIds, effectiveLimit, SIMILARITY_THRESHOLD, asset_id || null]);
          return res.rows;
        });

        console.log(`search_claims: isDateMode=${isDateMode} resolved(${resolvedFrom},${resolvedTo}) -> ${results.length} results`);

        if (results.length === 0) {
          const msg = isDateMode
            ? 'No claims found in that date range. Some older observations have no claim, so there may be raw observations on this date without one.'
            : 'No claims matched that query above the similarity threshold. Some older observations have no claim, so this may be a coverage gap rather than a real absence — try a broader query or ask about raw observations instead.';
          return { content: [{ type: 'text', text: msg }] };
        }

        const formatted = results.map((r) => ({
          observation_id: r.state_id,
          similarity: isDateMode ? undefined : Number(r.similarity.toFixed(3)),
          claim: r.claim_text,
          captured_at_manila: formatManilaTime(r.captured_at),
          captured_by: r.captured_by_name,
          links: r.links || null,
          has_photos: r.has_photos,
        }));

        return {
          content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error searching claims: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_observation_photos',
    {
      title: 'Get photos for an observation',
      description:
        'Fetch and display the photos attached to a specific observation, given ' +
        'an observation_id from search_claims, search_actions or ' +
        'search_financial_records. Returns actual inline ' +
        'images, not links. Farm photo storage is a public S3 bucket, fetched ' +
        'server-side and returned as image content. Each photo comes with its photo_url ' +
        'and, when known, when it was taken and its GPS position (latitude,longitude) — ' +
        'the photo\'s own date can differ from the observation\'s, e.g. when it was uploaded later.',
      inputSchema: {
        observation_id: z.string().describe('An observation_id (state id) from a search result'),
      },
    },
    async ({ observation_id }) => {
      console.log('get_observation_photos called with:', observation_id);
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      try {
        const photos = await withDbClient(async (client) => {
          const res = await client.query(
            `SELECT sp.photo_url, sp.photo_description, pm.taken_at, pm.gps_latitude, pm.gps_longitude
             FROM state_photos sp
             JOIN states s ON s.id = sp.state_id
             ${PHOTO_METADATA('sp.photo_url')}
             WHERE sp.state_id = $1
               AND s.organization_id = ANY($3::uuid[])
             ORDER BY sp.photo_order
             LIMIT $2`,
            [observation_id, MAX_PHOTOS_PER_REQUEST, accessibleOrgIds]
          );
          return res.rows;
        });

        if (photos.length === 0) {
          return { content: [{ type: 'text', text: 'No photos are attached to this observation.' }] };
        }

        const content = [];
        for (const photo of photos) {
          try {
            const url = photoUrl(photo.photo_url);
            const response = await fetch(url);
            if (!response.ok) {
              content.push({ type: 'text', text: `Could not fetch photo (HTTP ${response.status}): ${url}` });
              continue;
            }
            const mimeType = response.headers.get('content-type') || 'image/jpeg';
            const buffer = Buffer.from(await response.arrayBuffer());
            content.push({ type: 'image', data: buffer.toString('base64'), mimeType });
            // The photo_url names it, e.g. to pick it for an experience.
            const { taken_at_manila, gps } = photoTakenWhere(photo);
            content.push({ type: 'text', text: [
              `photo_url: ${photo.photo_url}`,
              taken_at_manila && `taken: ${taken_at_manila}`,
              gps && `gps: ${gps}`,
              photo.photo_description,
            ].filter(Boolean).join('\n') });
          } catch (fetchErr) {
            content.push({ type: 'text', text: `Failed to fetch photo: ${fetchErr.message}` });
          }
        }

        return { content };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error fetching photos: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'search_actions',
    {
      title: 'Search actions',
      description:
        'Search farm actions — work that was planned or done: title, status, who it is ' +
        'assigned to and who took part, the asset it is on, when it was created and ' +
        'completed, and its latest observation (date and claim) to show where it stands. ' +
        'Each result lists observation_ids; pass one to get_observation_photos to see its photos.\n\n' +
        'Three ways to search — pick one:\n' +
        '1. List: give only `status` and/or `person` to get every matching action, most recently ' +
        'active first, e.g. status ["not_started","in_progress"] for what is open when planning a day. ' +
        'Listed actions leave out policy and expected_state; search by topic for those.\n' +
        '2. Topical search: give `query`, ranked by semantic similarity. Do NOT put dates in the query.\n' +
        '3. Date-range lookup: `relative` or `date_from`/`date_to` for actions created or completed in the window.\n' +
        '`status` and `person` also narrow modes 2 and 3. Status external_proposal is a Positive Sum offer.',
      inputSchema: {
        ...SEARCH_INPUTS,
        status: z.array(z.enum(['not_started', 'in_progress', 'completed', 'external_proposal'])).optional().describe('Only actions with one of these statuses.'),
        person: z.string().optional().describe('Only actions assigned to, or with as a participant, someone whose name contains this.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results, default 10 (100 when listing by status/person)'),
      },
    },
    async ({ query, relative, date_from, date_to, limit, status, person }) => {
      console.log('search_actions called with:', JSON.stringify({ query, relative, date_from, date_to, limit, status, person }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      const { resolvedFrom, resolvedTo, isDateMode } = resolveWindow('search_actions', { query, relative, date_from, date_to });
      const isListMode = !isDateMode && !query && Boolean(status?.length || person);
      if (!isDateMode && !query && !isListMode) return NEEDS_QUERY_OR_DATES;
      const effectiveLimit = limit || (isListMode ? 100 : DEFAULT_LIMIT);

      const params = [accessibleOrgIds];
      const add = (value) => { params.push(value); return `$${params.length}`; };
      const where = [VISIBLE_ACTION('$1'), NOT_FROM_TRANSACTION];
      if (status?.length) where.push(`a.status::text = ANY(${add(status)}::text[])`);
      if (person) {
        where.push(`EXISTS (SELECT 1 FROM organization_members om
          WHERE om.organization_id = a.organization_id AND om.full_name ILIKE '%' || ${add(person)} || '%'
            AND (om.user_id::text = a.assigned_to::text OR om.user_id::text = ANY(a.participants::text[])))`);
      }

      // The latest observation skips Positive Sum's own records (JSON states).
      const columns = `
        a.id, a.title, a.policy, a.expected_state, a.status, a.created_at, a.completed_at,
        t.name AS asset_name,
        lo.captured_at AS latest_observation_at, lo.claim AS latest_observation_claim,
        (SELECT om.full_name FROM organization_members om
          WHERE om.user_id::text = a.assigned_to::text AND om.organization_id = a.organization_id LIMIT 1) AS assigned_to_name,
        (SELECT string_agg(om.full_name, ', ') FROM organization_members om
          WHERE om.user_id::text = ANY(a.participants::text[]) AND om.organization_id = a.organization_id) AS participant_names,
        (SELECT array_agg(sl.state_id ORDER BY s.captured_at) FROM state_links sl JOIN states s ON s.id = sl.state_id
          WHERE sl.entity_type = 'action' AND sl.entity_id = a.id) AS observation_ids`;
      const joins = `
        LEFT JOIN tools t ON t.id = a.asset_id
        LEFT JOIN LATERAL (
          SELECT s.captured_at, cp.content->>'content' AS claim
          FROM state_links sl
          JOIN states s ON s.id = sl.state_id
          LEFT JOIN state_perspectives cp ON cp.state_id = s.id AND cp.perspective_type = 'CLAIM' AND cp.status = 'SUCCESS'
          WHERE sl.entity_type = 'action' AND sl.entity_id = a.id
            AND COALESCE(s.state_text, '') NOT LIKE '{"type":"positive_sum.%'
          ORDER BY s.captured_at DESC
          LIMIT 1
        ) lo ON true`;

      try {
        const results = await withDbClient(async (client) => {
          if (isListMode) {
            const res = await client.query(
              `SELECT ${columns}
               FROM actions a ${joins}
               WHERE ${where.join(' AND ')}
               ORDER BY COALESCE(lo.captured_at, a.updated_at) DESC
               LIMIT ${add(effectiveLimit)}`,
              params
            );
            return res.rows;
          }

          if (isDateMode) {
            const from = add(resolvedFrom);
            const to = add(resolvedTo);
            const res = await client.query(
              `SELECT ${columns}
               FROM actions a ${joins}
               WHERE ${where.join(' AND ')}
                 AND (
                   (a.created_at >= (${from}::date::timestamp AT TIME ZONE 'Asia/Manila')
                     AND a.created_at < ((${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Manila'))
                   OR (a.completed_at >= (${from}::date::timestamp AT TIME ZONE 'Asia/Manila')
                     AND a.completed_at < ((${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Manila'))
                 )
               ORDER BY COALESCE(a.completed_at, a.created_at) DESC
               LIMIT ${add(effectiveLimit)}`,
              params
            );
            return res.rows;
          }

          const vector = add(`[${(await generateEmbedding(query)).join(',')}]`);
          const res = await client.query(
            `WITH matches AS (
               SELECT ue.entity_id, 1 - (ue.embedding <=> ${vector}::vector) AS similarity
               FROM unified_embeddings ue
               JOIN actions a ON a.id = ue.entity_id
               WHERE ue.entity_type = 'action_policy' AND ${VISIBLE_ACTION('$1')}
               ORDER BY ue.embedding <=> ${vector}::vector
               LIMIT ${add(effectiveLimit)}
             )
             SELECT m.similarity, ${columns}
             FROM matches m
             JOIN actions a ON a.id = m.entity_id ${joins}
             WHERE ${where.join(' AND ')}
               AND m.similarity > ${add(SIMILARITY_THRESHOLD)}
             ORDER BY m.similarity DESC`,
            params
          );
          return res.rows;
        });

        console.log(`search_actions: mode=${isListMode ? 'list' : isDateMode ? 'date' : 'topic'} resolved(${resolvedFrom},${resolvedTo}) -> ${results.length} results`);
        if (results.length === 0) {
          return { content: [{ type: 'text', text: isListMode ? 'No actions match that status/person.' : isDateMode ? 'No actions were created or completed in that date range.' : 'No actions matched that query above the similarity threshold — try a broader query.' }] };
        }

        const formatted = results.map((r) => ({
          action_id: r.id,
          similarity: r.similarity === undefined ? undefined : Number(r.similarity.toFixed(3)),
          title: r.title,
          status: r.status,
          policy: isListMode ? undefined : r.policy,
          expected_state: isListMode ? undefined : r.expected_state,
          asset: r.asset_name,
          assigned_to: r.assigned_to_name,
          participants: r.participant_names,
          created_at_manila: formatManilaTime(r.created_at),
          completed_at_manila: r.completed_at ? formatManilaTime(r.completed_at) : null,
          latest_observation: r.latest_observation_at
            ? { at_manila: formatManilaTime(r.latest_observation_at), claim: r.latest_observation_claim }
            : null,
          observation_ids: r.observation_ids || [],
        }));
        return { content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error searching actions: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'search_financial_records',
    {
      title: 'Search financial records',
      description:
        'Search farm financial records: transaction date, amount in pesos, payment method, ' +
        'description and who recorded it. Records are mixed: direction "out" is money paid ' +
        'out (an expense), "in" is money received (income, or a reload of that payment ' +
        'method). Each result has an observation_id for its description; pass it to ' +
        'get_observation_photos to see any receipt photos.\n\n' + TWO_MODES,
      inputSchema: SEARCH_INPUTS,
    },
    async ({ query, relative, date_from, date_to, limit }) => {
      console.log('search_financial_records called with:', JSON.stringify({ query, relative, date_from, date_to, limit }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      const { resolvedFrom, resolvedTo, isDateMode } = resolveWindow('search_financial_records', { query, relative, date_from, date_to });
      if (!isDateMode && !query) return NEEDS_QUERY_OR_DATES;
      const effectiveLimit = limit || DEFAULT_LIMIT;

      // A record's description is its first linked observation (same rule as
      // lambda/financial-records).
      const columns = `
        fr.id, fr.transaction_date::text AS transaction_date, fr.amount, fr.payment_method,
        d.id AS description_state_id, d.state_text AS description,
        (SELECT om.full_name FROM organization_members om
          WHERE om.cognito_user_id::text = fr.created_by::text AND om.organization_id = fr.organization_id LIMIT 1) AS recorded_by`;
      const descriptionJoin = `
        LEFT JOIN LATERAL (
          SELECT ds.id, ds.state_text FROM state_links sl JOIN states ds ON ds.id = sl.state_id
          WHERE sl.entity_id = fr.id AND sl.entity_type = 'financial_record'
          ORDER BY ds.created_at, ds.id LIMIT 1
        ) d ON true`;

      try {
        const results = await withDbClient(async (client) => {
          if (isDateMode) {
            const res = await client.query(
              `SELECT ${columns}
               FROM financial_records fr ${descriptionJoin}
               WHERE fr.organization_id = ANY($1::uuid[])
                 AND fr.transaction_date >= $2::date AND fr.transaction_date <= $3::date
               ORDER BY fr.transaction_date DESC, fr.created_at DESC
               LIMIT $4`,
              [accessibleOrgIds, resolvedFrom, resolvedTo, effectiveLimit]
            );
            return res.rows;
          }

          const embeddingStr = `[${(await generateEmbedding(query)).join(',')}]`;
          const res = await client.query(
            `WITH matches AS (
               SELECT entity_id, 1 - (embedding <=> $1::vector) AS similarity
               FROM unified_embeddings
               WHERE organization_id = ANY($2::uuid[]) AND entity_type = 'financial_record'
               ORDER BY embedding <=> $1::vector
               LIMIT $3
             )
             SELECT m.similarity, ${columns}
             FROM matches m
             JOIN financial_records fr ON fr.id = m.entity_id ${descriptionJoin}
             WHERE fr.organization_id = ANY($2::uuid[])
               AND m.similarity > $4
             ORDER BY m.similarity DESC`,
            [embeddingStr, accessibleOrgIds, effectiveLimit, SIMILARITY_THRESHOLD]
          );
          return res.rows;
        });

        console.log(`search_financial_records: isDateMode=${isDateMode} resolved(${resolvedFrom},${resolvedTo}) -> ${results.length} results`);
        if (results.length === 0) {
          return { content: [{ type: 'text', text: isDateMode ? 'No financial records in that date range.' : 'No financial records matched that query above the similarity threshold — try a broader query.' }] };
        }

        const formatted = results.map((r) => {
          const amount = Number(r.amount);
          return {
            financial_record_id: r.id,
            similarity: isDateMode ? undefined : Number(r.similarity.toFixed(3)),
            transaction_date: r.transaction_date,
            direction: amount < 0 ? 'in' : 'out',
            amount_php: Math.abs(amount),
            payment_method: r.payment_method,
            description: r.description,
            observation_id: r.description_state_id,
            recorded_by: r.recorded_by,
          };
        });
        return { content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error searching financial records: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'create_action',
    {
      title: 'Create an action',
      description:
        'Create a new action (planned work) in CWF, as not started. Draft all of these from what ' +
        'the person said, using search_actions / search_claims for context where it helps: ' +
        'title, existing_state (where things are now), expected_state (where we want to get to) ' +
        'and policy (how to do it). They are optional, but fill them by default. ' +
        'Before calling this, read the draft back to the person (title, existing state, expected ' +
        'state, policy, who it is assigned to) and only call it once they say yes.',
      inputSchema: {
        title: z.string().min(1).describe('Short name for the work, e.g. "Waterproof the bamboo treatment bins"'),
        existing_state: z.string().optional().describe('Where things are now'),
        expected_state: z.string().optional().describe('Where we want to get to'),
        policy: z.string().optional().describe('How to do it; plain text, blank lines between paragraphs'),
        assigned_to: z.string().optional().describe('Name of the person it is assigned to'),
        participants: z.array(z.string()).optional().describe('Names of other people taking part'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ title, existing_state, expected_state, policy, assigned_to, participants }) => {
      console.log('create_action called with:', JSON.stringify({ title, assigned_to, participants }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      if (!canWrite) {
        return {
          content: [{ type: 'text', text: 'This connection can only read. Disconnect and reconnect the CWF connector in Claude to allow creating actions.' }],
          isError: true,
        };
      }

      try {
        // Names become the member user_ids the app stores, within the org
        // the action is created in (the first one, as the app does).
        const resolve = await memberResolver(accessibleOrgIds[0], [assigned_to, ...(participants || [])]);

        const created = await createAction({
          cognitoUserId,
          action: {
            title,
            description: existing_state || null,
            expected_state: expected_state || null,
            policy: policy ? policyToHtml(policy) : null,
            status: 'not_started',
            assigned_to: assigned_to ? resolve(assigned_to) : null,
            participants: (participants || []).map(resolve),
            required_tools: [],
            attachments: [],
          },
        });
        console.log('create_action: created', created.id);
        return {
          content: [{ type: 'text', text: JSON.stringify({
            action_id: created.id,
            title: created.title,
            status: created.status,
            link: `https://stargazer-farm.com/actions/${created.id}`,
          }, null, 2) }],
        };
      } catch (err) {
        console.log('create_action failed:', err.message);
        return { content: [{ type: 'text', text: `Could not create the action: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'update_action',
    {
      title: 'Edit an action',
      description:
        'Change an existing action, like its screen in the app. Only the fields given change. ' +
        'Lists (participants, required_tools, required_stock) replace the whole list, and a new ' +
        'policy replaces the whole policy, so start from the current values (search_actions) when ' +
        'changing part of one. status starts an action (in_progress), puts it back (not_started) or ' +
        'completes it (completed), which uses up its required stock, as in the app. ' +
        'Find the action_id with search_actions, tools and parts with search_assets. Before calling ' +
        'this, read the change back to the person and only call it once they say yes.',
      inputSchema: {
        action_id: z.string().describe('The action_id from search_actions or create_action'),
        title: z.string().min(1).optional().describe('New title'),
        existing_state: z.string().optional().describe('New existing state (where things are now)'),
        expected_state: z.string().optional().describe('New expected state (where we want to get to)'),
        policy: z.string().optional().describe('New policy; plain text, blank lines between paragraphs'),
        assigned_to: z.string().nullable().optional().describe('Name of the person it is assigned to; null to unassign'),
        participants: z.array(z.string()).optional().describe('Names of everyone else taking part (the whole list)'),
        asset_id: z.string().nullable().optional().describe('The tool (asset) the action is about, from search_assets; null to clear'),
        required_tools: z.array(z.string()).optional().describe('Tool asset_ids needed (the whole list)'),
        required_stock: z.array(z.object({ part_id: z.string(), quantity: z.number() })).optional()
          .describe('Parts used and how many (the whole list); a negative quantity is produced'),
        status: z.enum(['not_started', 'in_progress', 'completed']).optional().describe('Start, put back to not started, or complete the action'),
        shared_with_partners: z.boolean().optional().describe('Share the action with partner organizations'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ action_id, title, existing_state, expected_state, policy, assigned_to, participants, asset_id, required_tools, required_stock, status, shared_with_partners }) => {
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      if (!canWrite) {
        return {
          content: [{ type: 'text', text: 'This connection can only read. Disconnect and reconnect the CWF connector in Claude to allow editing actions.' }],
          isError: true,
        };
      }
      const changes = {
        ...(title !== undefined && { title }),
        ...(existing_state !== undefined && { description: existing_state || null }),
        ...(expected_state !== undefined && { expected_state: expected_state || null }),
        ...(policy !== undefined && { policy: policy ? policyToHtml(policy) : null }),
        ...(status !== undefined && { status }),
        ...(status === 'completed' && { completed_at: new Date().toISOString() }),
        ...(shared_with_partners !== undefined && { shared_with_partners }),
      };
      const fields = [...Object.keys(changes), ...Object.entries({ assigned_to, participants, asset_id, required_tools, required_stock })
        .filter(([, v]) => v !== undefined).map(([k]) => k)];
      console.log('update_action called with:', JSON.stringify({ action_id, fields }));
      if (fields.length === 0) {
        return { content: [{ type: 'text', text: 'Nothing to change.' }], isError: true };
      }

      try {
        const action = await withDbClient(async (client) => (await client.query(
          `SELECT id, organization_id FROM actions WHERE id::text = $1 AND organization_id = ANY($2::uuid[])`,
          [action_id, accessibleOrgIds]
        )).rows[0]);
        if (!action) {
          return { content: [{ type: 'text', text: 'No action with that id in your organizations — find it with search_actions.' }], isError: true };
        }

        // People are members of the action's org; tools and parts are in the
        // caller's orgs. Parts carry their names, as the app stores them.
        if (assigned_to !== undefined || participants) {
          const resolve = await memberResolver(action.organization_id, [assigned_to, ...(participants || [])]);
          if (assigned_to !== undefined) changes.assigned_to = assigned_to ? resolve(assigned_to) : null;
          if (participants) changes.participants = participants.map(resolve);
        }
        const toolIds = [...(asset_id ? [asset_id] : []), ...(required_tools || [])];
        const partIds = (required_stock || []).map((p) => p.part_id);
        const { tools, parts } = await withDbClient(async (client) => ({
          tools: toolIds.length === 0 ? [] : (await client.query(
            `SELECT id::text AS id FROM tools WHERE id::text = ANY($1::text[]) AND organization_id = ANY($2::uuid[])`,
            [toolIds, accessibleOrgIds]
          )).rows,
          parts: partIds.length === 0 ? [] : (await client.query(
            `SELECT id::text AS id, name FROM parts WHERE id::text = ANY($1::text[]) AND organization_id = ANY($2::uuid[])`,
            [partIds, accessibleOrgIds]
          )).rows,
        }));
        const missing = [
          ...toolIds.filter((id) => !tools.some((t) => t.id === id)).map((id) => ({ entity_type: 'tool', entity_id: id })),
          ...partIds.filter((id) => !parts.some((p) => p.id === id)).map((id) => ({ entity_type: 'part', entity_id: id })),
        ];
        if (missing.length > 0) return notFound(missing);
        if (asset_id !== undefined) changes.asset_id = asset_id;
        if (required_tools) changes.required_tools = required_tools;
        if (required_stock) {
          changes.required_stock = required_stock.map(({ part_id, quantity }) => ({
            part_id, quantity, part_name: parts.find((p) => p.id === part_id).name,
          }));
        }

        // Edited where the action lives, as when the app has that org active.
        const updated = await updateAction({
          cognitoUserId,
          orgId: action.organization_id,
          actionId: action.id,
          changes,
        });
        console.log('update_action: updated', action.id);
        return {
          content: [{ type: 'text', text: JSON.stringify({
            action_id: action.id,
            title: updated.title,
            status: updated.status,
            changed: fields,
            link: `https://stargazer-farm.com/actions/${action.id}`,
          }, null, 2) }],
        };
      } catch (err) {
        console.log('update_action failed:', err.message);
        return { content: [{ type: 'text', text: `Could not edit the action: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'add_observation',
    {
      title: 'Add an observation',
      description:
        'Record an observation in the person\'s own words, and get a link to add photos to it. It ' +
        'can stand on its own or be linked to an action and/or assets (tools and parts), like the ' +
        'app\'s observation screen. Find actions with search_actions and assets with search_assets. ' +
        'Claude cannot pass photos from the chat to CWF, so when the person wants photos, create the ' +
        'observation here and give them the photo link: it opens the observation in the CWF app, ' +
        'where they can take or pick photos. A tool can have metrics (search_assets lists them); ' +
        'when the observation is of such a tool, ask for the readings and give them in metrics.',
      inputSchema: {
        text: z.string().optional().describe('What the person observed, in their own words. Can be left out if they only want to add photos.'),
        links: z.array(LINK).optional().describe('What it is about: an action and/or tools and parts. Leave out for a standalone observation.'),
        metrics: METRIC_VALUES.optional(),
        captured_at: CAPTURED_AT.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ text, links = [], metrics = [], captured_at }) => {
      console.log('add_observation called with:', JSON.stringify({ hasText: Boolean(text), links, metrics, captured_at }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      if (!canWrite) {
        return {
          content: [{ type: 'text', text: 'This connection can only read. Disconnect and reconnect the CWF connector in Claude to allow adding observations.' }],
          isError: true,
        };
      }

      try {
        const { targets, known } = await withDbClient(async (client) => ({
          targets: await findLinkTargets(client, links, accessibleOrgIds),
          known: metrics.length === 0 ? [] : await findToolMetrics(
            client, links.filter((l) => l.entity_type === 'tool').map((l) => l.entity_id), accessibleOrgIds),
        }));
        const missing = links.filter((l) => !targets.some((t) => sameLink(t, l)));
        if (missing.length > 0) return notFound(missing);
        const unknown = metrics.filter((m) => !known.some((k) => k.metric_id === m.metric_id)).map((m) => m.metric_id);
        if (unknown.length > 0) return unknownMetrics(unknown);

        // Like the app: the observation goes in the caller's primary organization
        // (oldest membership), even on another org's action, e.g. Positive Sum's.
        const created = await createObservation({
          cognitoUserId,
          observation: {
            state_text: text?.trim() || null,
            ...(captured_at && { captured_at }),
            photos: [],
            links: targets.map(({ entity_type, entity_id }) => ({ entity_type, entity_id })),
          },
        });
        console.log('add_observation: created', created.id);
        // In the primary org, like the observation.
        const metricResults = await saveMetrics({ cognitoUserId, observationId: created.id, metrics, known });
        const action = targets.find((t) => t.entity_type === 'action');
        return {
          content: [{ type: 'text', text: JSON.stringify({
            observation_id: created.id,
            linked_to: targets.map((t) => `${t.entity_type}: ${t.name}`),
            ...(metricResults.length > 0 && { metrics: metricResults }),
            add_photos_link: `https://stargazer-farm.com/observations/edit/${created.id}`,
            ...(action && { action_link: `https://stargazer-farm.com/actions/${action.entity_id}` }),
          }, null, 2) }],
        };
      } catch (err) {
        console.log('add_observation failed:', err.message);
        return { content: [{ type: 'text', text: `Could not add the observation: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'update_observation',
    {
      title: 'Edit an observation',
      description:
        'Change an observation\'s text or when it was observed. Only the fields given change. ' +
        'Find observation_ids with search_claims or search_actions. Read the change back to the ' +
        'person and only call this once they say yes. The same people can edit it as in the app ' +
        '(whoever recorded it, or an admin). Use update_observation_links for links. metrics sets ' +
        'readings for the metrics of a tool it is linked to (search_assets lists them); other ' +
        'readings are kept, and a blank value removes one.',
      inputSchema: {
        observation_id: z.string().describe('The observation to change'),
        text: z.string().optional().describe('New text, in the person\'s own words'),
        captured_at: CAPTURED_AT.optional(),
        metrics: METRIC_VALUES.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ observation_id, text, captured_at, metrics = [] }) => {
      const changes = {
        ...(text !== undefined && { state_text: text.trim() || null }),
        ...(captured_at !== undefined && { captured_at }),
      };
      console.log('update_observation called with:', JSON.stringify({ observation_id, fields: Object.keys(changes), metrics }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      if (!canWrite) {
        return {
          content: [{ type: 'text', text: 'This connection can only read. Disconnect and reconnect the CWF connector in Claude to allow editing observations.' }],
          isError: true,
        };
      }
      if (Object.keys(changes).length === 0 && metrics.length === 0) {
        return { content: [{ type: 'text', text: 'Nothing to change — give text, captured_at or metrics.' }], isError: true };
      }

      try {
        const { observation, known, existing } = await withDbClient(async (client) => {
          const observation = (await client.query(
            `SELECT s.id::text AS id, s.organization_id,
                    COALESCE(array_agg(sl.entity_id::text) FILTER (WHERE sl.entity_type = 'tool'), '{}') AS tool_ids
             FROM states s LEFT JOIN state_links sl ON sl.state_id = s.id
             WHERE s.id::text = $1 AND s.organization_id = ANY($2::uuid[])
             GROUP BY s.id`,
            [observation_id, accessibleOrgIds]
          )).rows[0];
          if (!observation || metrics.length === 0) return { observation, known: [], existing: [] };
          return {
            observation,
            known: await findToolMetrics(client, observation.tool_ids, accessibleOrgIds),
            existing: (await client.query(
              `SELECT snapshot_id::text AS snapshot_id, metric_id::text AS metric_id FROM metric_snapshots WHERE state_id = $1::uuid`,
              [observation.id]
            )).rows,
          };
        });
        if (!observation) {
          return { content: [{ type: 'text', text: 'No observation with that id in your organizations.' }], isError: true };
        }
        const unknown = metrics.filter((m) => !known.some((k) => k.metric_id === m.metric_id)).map((m) => m.metric_id);
        if (unknown.length > 0) return unknownMetrics(unknown);
        // Sent even with only metrics to change: the states service decides who may edit it.
        await updateObservation({ cognitoUserId, orgId: observation.organization_id, observationId: observation.id, changes });
        const metricResults = await saveMetrics({
          cognitoUserId, orgId: observation.organization_id, observationId: observation.id, metrics, known, existing,
        });
        console.log('update_observation: updated', observation.id);
        return { content: [{ type: 'text', text: JSON.stringify({
          observation_id: observation.id,
          ...(metricResults.length > 0 && { metrics: metricResults }),
          edit_link: `https://stargazer-farm.com/observations/edit/${observation.id}`,
        }, null, 2) }] };
      } catch (err) {
        console.log('update_observation failed:', err.message);
        return { content: [{ type: 'text', text: `Could not edit the observation: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'search_assets',
    {
      title: 'Search assets',
      description:
        'Find assets — tools (equipment, places, fields, containers) and parts (stock) — by name or ' +
        'topic, to get the asset_id and type to link an observation to (add_observation, update_observation_links), ' +
        'or to look at (get_asset) or edit (update_asset). ' +
        'Tools list their metrics — the readings an observation of that tool can record. ' +
        'low_stock lists the parts below their minimum quantity, like the app\'s Low Stock filter, with ' +
        'quantities, unit cost and supplier — use it to plan purchases.',
      inputSchema: {
        query: z.string().min(1).optional().describe('Name or topic, e.g. "azolla pond" or "inverter". Required unless low_stock; with low_stock it narrows by name.'),
        low_stock: z.boolean().optional().describe('Only parts below their minimum quantity'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results, default 10 (100 with low_stock)'),
      },
    },
    async ({ query, low_stock, limit }) => {
      console.log('search_assets called with:', JSON.stringify({ query, low_stock, limit }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      if (low_stock) {
        try {
          // The app's rule: both quantities set and current below minimum.
          const parts = await withDbClient(async (client) => (await client.query(
            `SELECT p.id::text AS asset_id, p.name, p.category, p.current_quantity, p.minimum_quantity, p.unit,
                    p.cost_per_unit, p.supplier, p.storage_location
             FROM parts p
             WHERE p.organization_id = ANY($1::uuid[])
               AND p.current_quantity IS NOT NULL AND p.minimum_quantity IS NOT NULL
               AND p.current_quantity < p.minimum_quantity
               AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%')
             ORDER BY p.current_quantity / NULLIF(p.minimum_quantity, 0) NULLS FIRST, p.name
             LIMIT $3`,
            [accessibleOrgIds, query || null, limit || 100]
          )).rows);
          console.log(`search_assets low_stock: -> ${parts.length} parts`);
          if (parts.length === 0) return { content: [{ type: 'text', text: 'No parts are below their minimum quantity.' }] };
          return { content: [{ type: 'text', text: JSON.stringify(parts.map((p) => ({ type: 'part', ...p })), null, 2) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error listing low stock: ${err.message}` }], isError: true };
        }
      }
      if (!query) return { content: [{ type: 'text', text: 'Give a query, or low_stock: true.' }], isError: true };
      const effectiveLimit = limit || DEFAULT_LIMIT;
      try {
        const results = await withDbClient(async (client) => {
          // Name matches first, then the closest by meaning.
          const byName = (await client.query(
            `SELECT 'tool' AS type, id::text AS id, name, category FROM tools
               WHERE organization_id = ANY($1::uuid[]) AND name ILIKE '%' || $2 || '%'
             UNION ALL
             SELECT 'part', id::text, name, category FROM parts
               WHERE organization_id = ANY($1::uuid[]) AND name ILIKE '%' || $2 || '%'
             LIMIT $3`,
            [accessibleOrgIds, query, effectiveLimit]
          )).rows;
          const vector = `[${(await generateEmbedding(query)).join(',')}]`;
          const byMeaning = (await client.query(
            `SELECT ue.entity_type AS type, ue.entity_id::text AS id, COALESCE(t.name, p.name) AS name, COALESCE(t.category, p.category) AS category
             FROM unified_embeddings ue
             LEFT JOIN tools t ON ue.entity_type = 'tool' AND t.id = ue.entity_id
             LEFT JOIN parts p ON ue.entity_type = 'part' AND p.id = ue.entity_id
             WHERE ue.organization_id = ANY($1::uuid[]) AND ue.entity_type IN ('tool', 'part')
               AND 1 - (ue.embedding <=> $2::vector) > $4
             ORDER BY ue.embedding <=> $2::vector
             LIMIT $3`,
            [accessibleOrgIds, vector, effectiveLimit, SIMILARITY_THRESHOLD]
          )).rows;
          const seen = new Set();
          const assets = [...byName, ...byMeaning].filter((r) => r.name && !seen.has(r.id) && seen.add(r.id)).slice(0, effectiveLimit);
          const metrics = await findToolMetrics(client, assets.filter((a) => a.type === 'tool').map((a) => a.id), accessibleOrgIds);
          return assets.map((a) => ({ ...a, metrics: metrics.filter((m) => m.tool_id === a.id) }));
        });
        console.log(`search_assets: -> ${results.length} results`);
        if (results.length === 0) return { content: [{ type: 'text', text: 'No assets matched — try another name.' }] };
        return { content: [{ type: 'text', text: JSON.stringify(results.map((r) => ({
          asset_id: r.id, type: r.type, name: r.name, category: r.category,
          ...(r.metrics.length > 0 && { metrics: r.metrics.map(({ tool_id, ...m }) => m) }),
        })), null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error searching assets: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'adjust_stock',
    {
      title: 'Add or remove stock',
      description:
        'Add to or remove from a part\'s stock, like the app\'s add/remove quantity, with a reason. ' +
        'The change applies to the current stock (never below zero) and is logged in the part\'s ' +
        'history. Find the part with search_assets. Read the change back to the person and only ' +
        'call this once they say yes.',
      inputSchema: {
        part_id: z.string().describe('The part asset_id from search_assets'),
        change: z.number().refine((n) => n !== 0, 'must not be zero').describe('How much to add (positive) or remove (negative), in the part\'s unit'),
        reason: z.string().min(1).describe('Why, e.g. "Bought at the hardware store" or "Used on the eggplants"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ part_id, change, reason }) => {
      console.log('adjust_stock called with:', JSON.stringify({ part_id, change }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      if (!canWrite) {
        return {
          content: [{ type: 'text', text: 'This connection can only read. Disconnect and reconnect the CWF connector in Claude to allow changing stock.' }],
          isError: true,
        };
      }
      try {
        const part = await withDbClient(async (client) => (await client.query(
          `SELECT id::text AS id, name, unit, organization_id FROM parts WHERE id::text = $1 AND organization_id = ANY($2::uuid[])`,
          [part_id, accessibleOrgIds]
        )).rows[0]);
        if (!part) return notFound([{ entity_type: 'part', entity_id: part_id }]);
        const { part: updated } = await changeStock({ cognitoUserId, orgId: part.organization_id, partId: part.id, change, reason });
        console.log('adjust_stock: changed', part.id);
        return { content: [{ type: 'text', text: JSON.stringify({
          part: part.name,
          change,
          current_quantity: Number(updated.current_quantity),
          unit: part.unit,
        }, null, 2) }] };
      } catch (err) {
        console.log('adjust_stock failed:', err.message);
        return { content: [{ type: 'text', text: `Could not change the stock: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'get_asset',
    {
      title: 'Get an asset',
      description:
        'Everything about one tool or part, as its page in the app shows it: details (description, ' +
        'area and exact location, who is accountable, serial number or quantities, cost, supplier), ' +
        'a tool\'s metrics and actions, recent edits or stock changes, the Systems it is (and was) part of and ' +
        'the components it is (and was) made of, with dates, and the most recent observations as claims (short ' +
        'summaries) with how many there are in all. A System\'s observations include those of everything it is ' +
        'made of, at any depth, from while each was part of it, labelled with the component (from_components; ' +
        'former components marked), so problems with a replaced component stay in view. Its most recent ' +
        'experiences (get_experience for one in full) and how many it has. For older or specific observations ' +
        'use search_claims with asset_id; for a full observation or its photos use get_observation_photos.',
      inputSchema: {
        asset_id: z.string().describe('The asset_id from search_assets'),
      },
    },
    async ({ asset_id }) => {
      console.log('get_asset called with:', JSON.stringify({ asset_id }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      try {
        const found = await withDbClient(async (client) => {
          const asset = (await client.query(
            `SELECT 'tool' AS type, row_to_json(t) AS fields, area.name AS area, om.full_name AS accountable_person
             FROM tools t
             LEFT JOIN tools area ON area.id = t.parent_structure_id
             LEFT JOIN organization_members om ON om.user_id::text = t.accountable_person_id::text AND om.organization_id = t.organization_id
             WHERE t.id::text = $1 AND t.organization_id = ANY($2::uuid[])
             UNION ALL
             SELECT 'part', row_to_json(p), area.name, om.full_name
             FROM parts p
             LEFT JOIN tools area ON area.id = p.parent_structure_id
             LEFT JOIN organization_members om ON om.user_id::text = p.accountable_person_id::text AND om.organization_id = p.organization_id
             WHERE p.id::text = $1 AND p.organization_id = ANY($2::uuid[])`,
            [asset_id, accessibleOrgIds]
          )).rows[0];
          if (!asset) return null;
          const memberships = await findMemberships(client, asset_id, accessibleOrgIds);
          // Its own observations and those of everything it is made of, at
          // any depth, from while each was part of it, each once, labelled
          // with the components they are on (former ones marked).
          const observations = (await client.query(
            `WITH RECURSIVE members(id, from_at, to_at, former) AS (
               SELECT $1::text, '-infinity'::timestamptz, 'infinity'::timestamptz, false
               UNION
               SELECT m.entity_id::text, GREATEST(members.from_at, js.captured_at::timestamptz),
                      LEAST(members.to_at, COALESCE(ended.captured_at::timestamptz, 'infinity'::timestamptz)),
                      members.former OR ended.captured_at IS NOT NULL
               FROM members
               JOIN state_links p ON p.entity_type = 'part_of' AND p.entity_id::text = members.id
               JOIN state_links m ON m.state_id = p.state_id AND m.entity_type IN ('tool', 'part')
               JOIN states js ON js.id = p.state_id AND js.organization_id = ANY($2::uuid[])
               ${ENDED_AT('js.id')}
             )
             SELECT s.id::text AS observation_id, s.captured_at, COALESCE(om.full_name, s.captured_by::text) AS captured_by,
                    c.claim, LEFT(s.state_text, 300) AS text_start,
                    EXISTS(SELECT 1 FROM state_photos ph WHERE ph.state_id = s.id) AS has_photos,
                    array_agg(DISTINCT COALESCE(t.name, pt.name) || CASE WHEN mb.former THEN ' (former component)' ELSE '' END)
                      FILTER (WHERE mb.id <> $1) AS from_components,
                    COUNT(*) OVER () AS total
             FROM state_links sl
             JOIN states s ON s.id = sl.state_id
             JOIN members mb ON mb.id = sl.entity_id::text AND s.captured_at BETWEEN mb.from_at AND mb.to_at
             LEFT JOIN tools t ON sl.entity_type = 'tool' AND t.id = sl.entity_id
             LEFT JOIN parts pt ON sl.entity_type = 'part' AND pt.id = sl.entity_id
             LEFT JOIN LATERAL (
               SELECT cp.content->>'content' AS claim FROM state_perspectives cp
               WHERE cp.state_id = s.id AND cp.perspective_type = 'CLAIM' AND cp.status = 'SUCCESS' LIMIT 1
             ) c ON true
             LEFT JOIN organization_members om
               ON s.captured_by::text = om.cognito_user_id::text AND s.organization_id = om.organization_id
             WHERE sl.entity_type IN ('tool', 'part')
               AND s.organization_id = ANY($2::uuid[])
               AND COALESCE(s.state_text, '') NOT LIKE '{"type":"positive_sum.%'
             GROUP BY s.id, c.claim, om.full_name
             ORDER BY s.captured_at DESC
             LIMIT 5`,
            [asset_id, accessibleOrgIds]
          )).rows;
          if (asset.type === 'part') {
            const stockChanges = (await client.query(
              `SELECT ph.quantity_change, ph.new_quantity, ph.change_reason, ph.changed_at, COALESCE(om.full_name, ph.changed_by::text) AS changed_by
               FROM parts_history ph
               LEFT JOIN LATERAL (SELECT full_name FROM organization_members WHERE cognito_user_id::text = ph.changed_by::text LIMIT 1) om ON true
               WHERE ph.part_id::text = $1
               ORDER BY ph.changed_at DESC
               LIMIT 5`,
              [asset_id]
            )).rows;
            const experiences = await findExperiences(client, { orgIds: accessibleOrgIds, assetId: asset_id, limit: 3 });
            return { asset, observations, stockChanges, memberships, experiences };
          }
          const actions = (await client.query(
            `SELECT a.id::text AS action_id, a.title, a.status, a.updated_at
             FROM actions a
             WHERE a.organization_id = ANY($2::uuid[]) AND (a.asset_id::text = $1 OR $1 = ANY(a.required_tools::text[]))
             ORDER BY a.status = 'in_progress' DESC, a.updated_at DESC
             LIMIT 5`,
            [asset_id, accessibleOrgIds]
          )).rows;
          const edits = (await client.query(
            `SELECT ah.change_type, ah.field_changed, ah.old_value, ah.new_value, ah.changed_at, COALESCE(om.full_name, ah.changed_by::text) AS changed_by
             FROM asset_history ah
             LEFT JOIN LATERAL (SELECT full_name FROM organization_members WHERE cognito_user_id::text = ah.changed_by::text LIMIT 1) om ON true
             WHERE ah.asset_id::text = $1
             ORDER BY ah.changed_at DESC
             LIMIT 5`,
            [asset_id]
          )).rows;
          const metrics = await findToolMetrics(client, [asset_id], accessibleOrgIds);
          const experiences = await findExperiences(client, { orgIds: accessibleOrgIds, assetId: asset_id, limit: 3 });
          return { asset, observations, actions, edits, metrics, memberships, experiences };
        });
        if (!found) return NOT_AN_ASSET(asset_id);
        const { asset, observations, stockChanges, actions, edits, metrics, memberships: ms, experiences } = found;
        const f = asset.fields;
        const keys = asset.type === 'tool'
          ? ['name', 'category', 'description', 'serial_number', 'status', 'storage_location', 'actual_location', 'last_maintenance', 'manual_url']
          : ['name', 'category', 'description', 'current_quantity', 'minimum_quantity', 'unit', 'cost_per_unit', 'supplier', 'storage_location', 'sellable'];
        const details = Object.fromEntries(keys.filter((k) => f[k] !== null && f[k] !== undefined && f[k] !== '').map((k) => [k, f[k]]));
        console.log(`get_asset: ${asset.type} ${asset_id}, ${observations.length} observations`);
        return { content: [{ type: 'text', text: JSON.stringify({
          asset_id,
          type: asset.type,
          ...details,
          ...(f.legacy_storage_vicinity && { storage_vicinity: f.legacy_storage_vicinity }),
          ...(asset.area && { area: asset.area, area_id: f.parent_structure_id }),
          ...(asset.accountable_person && { accountable_person: asset.accountable_person }),
          ...(f.gps_latitude && f.gps_longitude && { gps: `${f.gps_latitude},${f.gps_longitude}` }),
          ...(f.image_url && { photo: photoUrl(f.image_url) }),
          ...(f.created_at && { created_at_manila: formatManilaTime(f.created_at) }),
          link: ASSET_LINK(asset_id),
          ...(ms.partOf.length > 0 && { part_of: ms.partOf }),
          ...(ms.formerlyPartOf.length > 0 && { formerly_part_of: ms.formerlyPartOf }),
          ...(ms.components.length > 0 && { components: ms.components }),
          ...(ms.formerComponents.length > 0 && { former_components: ms.formerComponents }),
          ...(metrics?.length > 0 && { metrics: metrics.map(({ tool_id, ...m }) => m) }),
          ...(actions?.length > 0 && { actions: actions.map((a) => ({ ...a, updated_at: formatManilaTime(a.updated_at) })) }),
          ...(edits?.length > 0 && { recent_edits: edits.map((e) => ({ ...e, changed_at: formatManilaTime(e.changed_at) })) }),
          ...(stockChanges?.length > 0 && { recent_stock_changes: stockChanges.map((c) => ({
            ...c, quantity_change: Number(c.quantity_change), new_quantity: Number(c.new_quantity), changed_at: formatManilaTime(c.changed_at),
          })) }),
          ...(experiences.total > 0 && {
            experience_count: experiences.total,
            recent_experiences: experiences.experiences.map(({ asset, ...e }) => e),
          }),
          observation_count: Number(observations[0]?.total || 0),
          recent_observations: observations.map((o) => ({
            observation_id: o.observation_id,
            captured_at_manila: formatManilaTime(o.captured_at),
            captured_by: o.captured_by,
            ...(o.claim ? { claim: o.claim } : { text_start: o.text_start }),
            ...(o.from_components && { from_components: o.from_components }),
            has_photos: o.has_photos,
          })),
        }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error getting the asset: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'create_asset',
    {
      title: 'Add an asset',
      description:
        'Add a new tool (equipment, a place, a field, a container) or part (stock counted in units) to ' +
        'CWF, as the app\'s add form does. Check with search_assets that it isn\'t there already. ' +
        'Read the draft back to the person (type, name, each field) and only call this once they say yes.',
      inputSchema: {
        type: z.enum(['tool', 'part']).describe('tool: one tracked item or place; part: stock counted in units'),
        name: z.string().min(1),
        current_quantity: z.number().min(0).optional().describe('Parts only. How many there are now; later changes go through adjust_stock'),
        ...ASSET_FIELDS,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ type, name, current_quantity, ...fields }) => {
      console.log('create_asset called with:', JSON.stringify({ type, name }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      if (!canWrite) {
        return {
          content: [{ type: 'text', text: 'This connection can only read. Disconnect and reconnect the CWF connector in Claude to allow adding assets.' }],
          isError: true,
        };
      }
      try {
        if (type === 'tool' && current_quantity !== undefined) throw new Error('current_quantity is not for a tool.');
        // New assets go in the primary org, as new actions do.
        const changes = await assetChanges({ type, fields, orgId: accessibleOrgIds[0], cognitoUserId });
        const created = await createAsset({
          cognitoUserId,
          type,
          asset: { name, ...changes, ...(current_quantity !== undefined && { current_quantity }) },
        });
        console.log('create_asset: created', type, created.id);
        return { content: [{ type: 'text', text: JSON.stringify({
          asset_id: created.id, type, name: created.name, link: ASSET_LINK(created.id),
        }, null, 2) }] };
      } catch (err) {
        console.log('create_asset failed:', err.message);
        return { content: [{ type: 'text', text: `Could not add the asset: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'update_asset',
    {
      title: 'Edit an asset',
      description:
        'Change a tool\'s or part\'s details, as the app\'s edit form does. Only the fields given change; ' +
        'null clears one. Stock goes through adjust_stock, not here, so every change is logged. Find the ' +
        'asset with search_assets and see its current details with get_asset. Read the changes back to ' +
        'the person and only call this once they say yes.',
      inputSchema: {
        asset_id: z.string().describe('The asset_id from search_assets'),
        name: z.string().min(1).optional(),
        ...ASSET_FIELDS,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ asset_id, ...fields }) => {
      console.log('update_asset called with:', JSON.stringify({ asset_id, fields: Object.keys(fields) }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      if (!canWrite) {
        return {
          content: [{ type: 'text', text: 'This connection can only read. Disconnect and reconnect the CWF connector in Claude to allow editing assets.' }],
          isError: true,
        };
      }
      if (Object.values(fields).every((v) => v === undefined)) {
        return { content: [{ type: 'text', text: 'Give at least one field to change.' }], isError: true };
      }
      try {
        const asset = await withDbClient(async (client) => (await client.query(
          `SELECT 'tool' AS type, id::text AS id, organization_id FROM tools WHERE id::text = $1 AND organization_id = ANY($2::uuid[])
           UNION ALL
           SELECT 'part', id::text, organization_id FROM parts WHERE id::text = $1 AND organization_id = ANY($2::uuid[])`,
          [asset_id, accessibleOrgIds]
        )).rows[0]);
        if (!asset) return NOT_AN_ASSET(asset_id);
        const changes = await assetChanges({ type: asset.type, fields, orgId: asset.organization_id, cognitoUserId });
        const updated = await updateAsset({ cognitoUserId, orgId: asset.organization_id, type: asset.type, assetId: asset.id, changes });
        console.log('update_asset: updated', asset.type, asset.id);
        return { content: [{ type: 'text', text: JSON.stringify({
          asset_id: asset.id, type: asset.type, name: updated.name, changed: Object.keys(fields).filter((k) => fields[k] !== undefined),
          link: ASSET_LINK(asset.id),
        }, null, 2) }] };
      } catch (err) {
        console.log('update_asset failed:', err.message);
        return { content: [{ type: 'text', text: `Could not edit the asset: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'link_assets',
    {
      title: 'Make assets part of a System',
      description:
        'Make tools or parts components of a System (a tool whose category is System; set it with ' +
        'update_asset), e.g. the inverter and batteries part of the Solar System. A System can be part of ' +
        'another System. Each link is recorded as an observation on the component, linked to the System, ' +
        'so it shows in both histories. Find assets with search_assets; confirm with the person first.',
      inputSchema: {
        system_id: z.string().describe('The System\'s asset_id'),
        member_ids: z.array(z.string()).min(1).max(25).describe('asset_ids of the tools or parts that are part of it'),
        note: z.string().optional().describe('Anything worth saying about how it fits in, added to each observation'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ system_id, member_ids, note }) => {
      console.log('link_assets called with:', JSON.stringify({ system_id, member_ids }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      if (!canWrite) {
        return {
          content: [{ type: 'text', text: 'This connection can only read. Disconnect and reconnect the CWF connector in Claude to allow linking assets.' }],
          isError: true,
        };
      }
      try {
        const { system, members, above, current } = await withDbClient(async (client) => {
          const system = (await client.query(
            `SELECT id::text AS id, name, category FROM tools WHERE id::text = $1 AND organization_id = ANY($2::uuid[])`,
            [system_id, accessibleOrgIds]
          )).rows[0];
          if (!system) return {};
          const members = (await client.query(
            `SELECT 'tool' AS type, id::text AS id, name FROM tools WHERE id::text = ANY($1::text[]) AND organization_id = ANY($2::uuid[])
             UNION ALL
             SELECT 'part', id::text, name FROM parts WHERE id::text = ANY($1::text[]) AND organization_id = ANY($2::uuid[])`,
            [member_ids, accessibleOrgIds]
          )).rows;
          // The System and every System it is part of, at any depth: none of
          // these can become its component.
          const above = (await client.query(
            `WITH RECURSIVE up(id) AS (
               SELECT $1::text
               UNION
               SELECT p.entity_id::text FROM up
               JOIN state_links m ON m.entity_type IN ('tool', 'part') AND m.entity_id::text = up.id
               JOIN state_links p ON p.state_id = m.state_id AND p.entity_type = 'part_of'
               JOIN states s ON s.id = m.state_id AND s.organization_id = ANY($2::uuid[])
               WHERE NOT EXISTS (SELECT 1 FROM state_links e WHERE e.entity_type = 'ends' AND e.entity_id = s.id)
             )
             SELECT id FROM up`,
            [system_id, accessibleOrgIds]
          )).rows.map((r) => r.id);
          const { components } = await findMemberships(client, system_id, accessibleOrgIds);
          return { system, members, above, current: components.map((c) => c.asset_id) };
        });
        if (!system) return NOT_AN_ASSET(system_id);
        if (system.category !== 'System') {
          return { content: [{ type: 'text', text: `${system.name} is not a System (its category is ${system.category || 'not set'}). Set its category to System with update_asset first.` }], isError: true };
        }
        const missing = member_ids.filter((id) => !members.some((m) => m.id === id));
        if (missing.length > 0) return NOT_AN_ASSET(missing.join(', '));

        const results = [];
        for (const member of members) {
          if (above.includes(member.id)) { results.push({ asset: member.name, result: `not linked: ${system.name} is part of it` }); continue; }
          if (current.includes(member.id)) { results.push({ asset: member.name, result: 'already part of it' }); continue; }
          try {
            await createObservation({
              cognitoUserId,
              observation: {
                state_text: `${member.name} is part of ${system.name}.${note?.trim() ? ` ${note.trim()}` : ''}`,
                photos: [],
                links: [{ entity_type: member.type, entity_id: member.id }, { entity_type: 'part_of', entity_id: system.id }],
              },
            });
            results.push({ asset: member.name, result: 'linked' });
          } catch (err) {
            results.push({ asset: member.name, result: `not linked: ${err.message}` });
          }
        }
        console.log('link_assets:', JSON.stringify(results));
        return { content: [{ type: 'text', text: JSON.stringify({ system: system.name, results }, null, 2) }] };
      } catch (err) {
        console.log('link_assets failed:', err.message);
        return { content: [{ type: 'text', text: `Could not link the assets: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'unlink_assets',
    {
      title: 'Take assets out of a System',
      description:
        'Take components out of a System, e.g. when the inverter is replaced. Records an observation on ' +
        'each component that it was removed (with the reason, if given), ending its membership; nothing is ' +
        'deleted, so the System keeps showing what was observed while it was part of it, marked as a former ' +
        'component. Confirm with the person first.',
      inputSchema: {
        system_id: z.string().describe('The System\'s asset_id'),
        member_ids: z.array(z.string()).min(1).max(25).describe('asset_ids of the components to take out'),
        reason: z.string().optional().describe('Why it was taken out, e.g. "Replaced; it showed panel voltage at night"'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ system_id, member_ids, reason }) => {
      console.log('unlink_assets called with:', JSON.stringify({ system_id, member_ids }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      if (!canWrite) {
        return {
          content: [{ type: 'text', text: 'This connection can only read. Disconnect and reconnect the CWF connector in Claude to allow unlinking assets.' }],
          isError: true,
        };
      }
      try {
        // Current memberships only: the part_of observations not yet ended.
        const links = await withDbClient(async (client) => (await client.query(
          `SELECT s.id::text AS observation_id, m.entity_type AS type, m.entity_id::text AS member_id,
                  COALESCE(t.name, pt.name) AS name, sys.name AS system
           FROM state_links p
           JOIN state_links m ON m.state_id = p.state_id AND m.entity_type IN ('tool', 'part')
           JOIN states s ON s.id = p.state_id
           JOIN tools sys ON sys.id = p.entity_id
           LEFT JOIN tools t ON m.entity_type = 'tool' AND t.id = m.entity_id
           LEFT JOIN parts pt ON m.entity_type = 'part' AND pt.id = m.entity_id
           WHERE p.entity_type = 'part_of' AND p.entity_id::text = $1
             AND m.entity_id::text = ANY($2::text[]) AND s.organization_id = ANY($3::uuid[])
             AND NOT EXISTS (SELECT 1 FROM state_links e WHERE e.entity_type = 'ends' AND e.entity_id = s.id)`,
          [system_id, member_ids, accessibleOrgIds]
        )).rows);
        const results = [];
        for (const id of member_ids) {
          const mine = links.filter((l) => l.member_id === id);
          if (mine.length === 0) { results.push({ asset_id: id, result: 'is not part of it' }); continue; }
          const { type, name, system } = mine[0];
          try {
            await createObservation({
              cognitoUserId,
              observation: {
                state_text: `${name} removed from ${system}.${reason?.trim() ? ` ${reason.trim()}` : ''}`,
                photos: [],
                links: [
                  { entity_type: type, entity_id: id },
                  ...mine.map((l) => ({ entity_type: 'ends', entity_id: l.observation_id })),
                ],
              },
            });
            results.push({ asset: name, result: 'taken out' });
          } catch (err) {
            results.push({ asset: name, result: `not taken out: ${err.message}` });
          }
        }
        console.log('unlink_assets:', JSON.stringify(results));
        return { content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }] };
      } catch (err) {
        console.log('unlink_assets failed:', err.message);
        return { content: [{ type: 'text', text: `Could not unlink the assets: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'search_experiences',
    {
      title: 'Search experiences',
      description:
        'Find experiences: write-ups, on a tool or part or on nothing in particular, of initial states (how things were), actions (what ' +
        'was done) and final states (how they turned out), each an existing observation or action. Filter by ' +
        'asset_id, by when they were written up (relative or date_from/date_to), or by the observations and ' +
        'actions in them. Experiences have no text of their own, so to find them by topic, search_claims or ' +
        'search_actions first and pass the ids found. Newest first, each with a short label per component. ' +
        'Open one in full with get_experience.',
      inputSchema: {
        asset_id: z.string().optional().describe('Only experiences on this tool or part'),
        observation_ids: z.array(z.string()).max(50).optional().describe('Only experiences that include any of these observations'),
        action_ids: z.array(z.string()).max(50).optional().describe('Only experiences that include any of these actions'),
        relative: SEARCH_INPUTS.relative,
        date_from: SEARCH_INPUTS.date_from,
        date_to: SEARCH_INPUTS.date_to,
        limit: z.number().int().min(1).max(50).optional().describe('Max results, default 10'),
      },
    },
    async ({ asset_id, observation_ids, action_ids, relative, date_from, date_to, limit }) => {
      console.log('search_experiences called with:', JSON.stringify({ asset_id, observation_ids, action_ids, relative, date_from, date_to, limit }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      const { resolvedFrom, resolvedTo } = resolveWindow('search_experiences', { relative, date_from, date_to });
      try {
        const found = await withDbClient((client) => findExperiences(client, {
          orgIds: accessibleOrgIds, assetId: asset_id, observationIds: observation_ids, actionIds: action_ids,
          from: resolvedFrom, to: resolvedTo, limit: limit || DEFAULT_LIMIT,
        }));
        console.log(`search_experiences: -> ${found.experiences.length} of ${found.total}`);
        if (found.total === 0) return { content: [{ type: 'text', text: 'No experiences matched.' }] };
        return { content: [{ type: 'text', text: JSON.stringify(found, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error searching experiences: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'get_experience',
    {
      title: 'Get an experience',
      description:
        'One experience in full, as its page in the app shows it: the tool or part it is on (if any), who wrote it ' +
        'up, and each initial state, action and final state in order. Observations come with their note, ' +
        'claim, readings and whether they have photos (get_observation_photos to see them); actions with ' +
        'their title, type, status, completion date and claim (the account of what was done), plus the ' +
        'person\'s own rewrite of that claim for this experience if there is one, and the photos on the ' +
        'action\'s observations with whether each is included in this write-up (action_photos on ' +
        'update_experience picks them). An experience need not be on an asset.',
      inputSchema: {
        experience_id: z.string().describe('The experience_id from search_experiences or get_asset'),
      },
    },
    async ({ experience_id }) => {
      console.log('get_experience called with:', JSON.stringify({ experience_id }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      try {
        const found = await withDbClient(async (client) => {
          const experience = (await client.query(
            `SELECT e.id::text AS id, e.entity_type AS type, e.entity_id::text AS asset_id, COALESCE(t.name, p.name) AS asset,
                    e.created_at, e.metadata, om.full_name AS written_by
             FROM experiences e
             LEFT JOIN tools t ON e.entity_type = 'tool' AND t.id = e.entity_id
             LEFT JOIN parts p ON e.entity_type = 'part' AND p.id = e.entity_id
             LEFT JOIN organization_members om ON om.id = e.created_by
             WHERE e.id::text = $1 AND e.organization_id = ANY($2::uuid[])`,
            [experience_id, accessibleOrgIds]
          )).rows[0];
          if (!experience) return null;
          const components = (await client.query(
            `SELECT ec.component_type, ec.state_id::text AS observation_id, ec.action_id::text AS action_id,
                    s.captured_at, LEFT(s.state_text, 1000) AS text, sc.claim AS observation_claim,
                    EXISTS(SELECT 1 FROM state_photos ph WHERE ph.state_id = s.id) AS has_photos,
                    a.title, a.status, a.completed_at, a.scoring_data->>'action_type' AS action_type, ac.claim AS action_claim
             FROM experience_components ec
             LEFT JOIN states s ON s.id = ec.state_id
             LEFT JOIN actions a ON a.id = ec.action_id
             LEFT JOIN LATERAL (
               SELECT cp.content->>'content' AS claim FROM state_perspectives cp
               WHERE cp.state_id = s.id AND cp.perspective_type = 'CLAIM' AND cp.status = 'SUCCESS' LIMIT 1
             ) sc ON true
             LEFT JOIN LATERAL (
               SELECT cp.content->>'content' AS claim FROM state_perspectives cp
               WHERE cp.action_id = a.id AND cp.perspective_type = 'CLAIM' LIMIT 1
             ) ac ON true
             WHERE ec.experience_id::text = $1
             ORDER BY ${LEG_ORDER}, COALESCE(s.captured_at, a.completed_at, ec.created_at)`,
            [experience_id]
          )).rows;
          // Each action's photos: those on observations linked to it. Which
          // belong in this write-up is picked per experience (default none).
          const actionIds = components.map((c) => c.action_id).filter(Boolean);
          const actionPhotos = actionIds.length === 0 ? [] : (await client.query(
            `SELECT sl.entity_id::text AS action_id, sp.state_id::text AS observation_id, sp.photo_url, sp.photo_description,
                    pm.taken_at, pm.gps_latitude, pm.gps_longitude
             FROM state_links sl
             JOIN states s ON s.id = sl.state_id
             JOIN state_photos sp ON sp.state_id = s.id
             ${PHOTO_METADATA('sp.photo_url')}
             WHERE sl.entity_type = 'action' AND sl.entity_id::text = ANY($1::text[])
             ORDER BY s.captured_at, sp.photo_order`,
            [actionIds]
          )).rows;
          const stateIds = components.map((c) => c.observation_id).filter(Boolean);
          const readings = stateIds.length === 0 ? [] : (await client.query(
            `SELECT ms.state_id::text AS observation_id, m.name, ms.value, m.unit
             FROM metric_snapshots ms JOIN metrics m ON m.metric_id = ms.metric_id
             WHERE ms.state_id::text = ANY($1::text[])`,
            [stateIds]
          )).rows;
          return { experience, components, readings, actionPhotos };
        });
        if (!found) return NOT_AN_EXPERIENCE(experience_id);
        const { experience: e, components, readings, actionPhotos } = found;
        const edits = e.metadata?.action_claim_edits || {};
        const included = e.metadata?.action_photo_inclusions || {};
        const describe = (c) => c.action_id
          ? {
            action_id: c.action_id, title: c.title, ...(c.action_type && { type: c.action_type }), status: c.status,
            ...(c.completed_at && { completed_at_manila: formatManilaTime(c.completed_at) }),
            ...(c.action_claim && { claim: c.action_claim }),
            ...(edits[c.action_id] && { claim_as_rewritten_here: edits[c.action_id] }),
            ...(actionPhotos.some((ph) => ph.action_id === c.action_id) && {
              photos: actionPhotos.filter((ph) => ph.action_id === c.action_id).map(({ action_id, photo_description, taken_at, gps_latitude, gps_longitude, ...ph }) => ({
                ...ph,
                ...(photo_description && { description: photo_description }),
                ...photoTakenWhere({ taken_at, gps_latitude, gps_longitude }),
                included: (included[c.action_id] || []).includes(ph.photo_url),
              })),
            }),
          }
          : {
            observation_id: c.observation_id,
            captured_at_manila: formatManilaTime(c.captured_at),
            ...(c.text && { text: c.text }),
            ...(c.observation_claim && { claim: c.observation_claim }),
            ...(readings.some((r) => r.observation_id === c.observation_id) && {
              readings: readings.filter((r) => r.observation_id === c.observation_id).map(({ observation_id, ...r }) => r),
            }),
            has_photos: c.has_photos,
          };
        console.log(`get_experience: ${e.id}, ${components.length} components`);
        return { content: [{ type: 'text', text: JSON.stringify({
          experience_id: e.id,
          asset: e.asset_id ? { asset_id: e.asset_id, type: e.type, name: e.asset } : null,
          written_by: e.written_by,
          written_at_manila: formatManilaTime(e.created_at),
          link: `https://stargazer-farm.com/experiences/${e.id}`,
          ...Object.fromEntries(Object.entries(LEGS).map(([type, leg]) => [leg, components.filter((c) => c.component_type === type).map(describe)])),
        }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error getting the experience: ${err.message}` }], isError: true };
      }
    }
  );

  const LEG_INPUTS = {
    initial_state_ids: z.array(z.string()).max(25).optional().describe('Observations of how things were before'),
    action_ids: z.array(z.string()).max(25).optional().describe('Actions: what was done'),
    final_state_ids: z.array(z.string()).max(25).optional().describe('Observations of how things turned out; none yet is fine for something still under way'),
    action_photos: z.record(z.string(), z.array(z.string()).max(50)).optional().describe(
      'action_id → the photo_urls, from photos on that action\'s observations, that belong in this write-up (get_observation_photos ' +
      'shows each photo with its photo_url). Replaces that action\'s pick; an empty list includes none.'),
  };

  // Photo picks must be photos on the action's own observations.
  async function photosNotOnActions(client, actionPhotos) {
    const picks = Object.entries(actionPhotos || {}).flatMap(([actionId, urls]) => urls.map((url) => [actionId, url]));
    if (picks.length === 0) return [];
    const on = (await client.query(
      `SELECT sl.entity_id::text AS action_id, sp.photo_url
       FROM state_links sl JOIN state_photos sp ON sp.state_id = sl.state_id
       WHERE sl.entity_type = 'action' AND sl.entity_id::text = ANY($1::text[])`,
      [Object.keys(actionPhotos)]
    )).rows;
    return picks.filter(([actionId, url]) => !on.some((r) => r.action_id === actionId && r.photo_url === url)).map(([, url]) => url);
  }

  server.registerTool(
    'create_experience',
    {
      title: 'Write up an experience',
      description:
        'Write up an experience: the initial states (how things were), the actions (what was done) and the ' +
        'final states (how it turned out), as existing observations and actions. Find them with search_claims ' +
        'and search_actions, and look at their photos with get_observation_photos to pick the ones that show ' +
        'the change; an observation that doesn\'t exist yet can be recorded first with add_observation. It can be ' +
        'on a tool or part, or on nothing in particular (e.g. a trial marked by a stake that isn\'t an asset). ' +
        'Any leg may be empty. Read the write-up back to the person (each leg, and the photos picked) and only ' +
        'call this once they say yes.',
      inputSchema: {
        asset_id: z.string().optional().describe('The tool or part it is about (search_assets), if any'),
        ...LEG_INPUTS,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ asset_id, initial_state_ids = [], action_ids = [], final_state_ids = [], action_photos }) => {
      console.log('create_experience called with:', JSON.stringify({ asset_id, initial_state_ids, action_ids, final_state_ids, action_photos }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      if (!canWrite) {
        return {
          content: [{ type: 'text', text: 'This connection can only read. Disconnect and reconnect the CWF connector in Claude to allow writing up experiences.' }],
          isError: true,
        };
      }
      try {
        const { asset, missing, strayPhotos } = await withDbClient(async (client) => ({
          asset: asset_id && (await client.query(
            `SELECT 'tool' AS type, id::text AS id, name FROM tools WHERE id::text = $1 AND organization_id = ANY($2::uuid[])
             UNION ALL
             SELECT 'part', id::text, name FROM parts WHERE id::text = $1 AND organization_id = ANY($2::uuid[])`,
            [asset_id, accessibleOrgIds]
          )).rows[0],
          missing: await missingComponents(client, { observationIds: [...initial_state_ids, ...final_state_ids], actionIds: action_ids }, accessibleOrgIds),
          strayPhotos: await photosNotOnActions(client, action_photos),
        }));
        if (asset_id && !asset) return NOT_AN_ASSET(asset_id);
        if (missing.length > 0) {
          return { content: [{ type: 'text', text: `Not found in your organizations: ${missing.join(', ')}. Nothing was written up.` }], isError: true };
        }
        const notInIt = Object.keys(action_photos || {}).filter((id) => !action_ids.includes(id));
        if (notInIt.length > 0 || strayPhotos.length > 0) {
          return { content: [{ type: 'text', text: `Photos can only be picked from the photos on an action in it${notInIt.length ? ` (not in it: ${notInIt.join(', ')})` : ''}${strayPhotos.length ? ` (not on that action: ${strayPhotos.join(', ')})` : ''}. Nothing was written up.` }], isError: true };
        }
        const created = await createExperience({
          cognitoUserId,
          experience: {
            ...(asset && { entity_type: asset.type, entity_id: asset.id }),
            initial_state_ids, action_ids, final_state_ids,
            ...(action_photos && { action_photo_inclusions: action_photos }),
          },
        });
        console.log('create_experience: created', created.id);
        return { content: [{ type: 'text', text: JSON.stringify({
          experience_id: created.id, asset: asset?.name ?? null, link: `https://stargazer-farm.com/experiences/${created.id}`,
        }, null, 2) }] };
      } catch (err) {
        console.log('create_experience failed:', err.message);
        return { content: [{ type: 'text', text: `Could not write up the experience: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'update_experience',
    {
      title: 'Edit an experience',
      description:
        'Change an experience, as its page in the app does. Each leg given replaces that leg (an empty list ' +
        'clears it); legs left out stay as they are, so get_experience first and pass the full list you want. ' +
        'action_claim_rewrites rewrites the account of what an action did for this experience only; the ' +
        'action\'s own claim is kept. action_photos picks which of an action\'s photos belong in it. To change ' +
        'an observation\'s note, use update_observation. Only whoever ' +
        'wrote it up, or an admin, can edit it. Confirm the change with the person first.',
      inputSchema: {
        experience_id: z.string(),
        ...LEG_INPUTS,
        action_claim_rewrites: z.record(z.string(), z.string().min(1)).optional().describe('action_id → the person\'s account of what that action did, for this experience'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ experience_id, initial_state_ids, action_ids, final_state_ids, action_claim_rewrites, action_photos }) => {
      console.log('update_experience called with:', JSON.stringify({ experience_id, initial_state_ids, action_ids, final_state_ids, rewrites: Object.keys(action_claim_rewrites || {}) }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      if (!canWrite) {
        return {
          content: [{ type: 'text', text: 'This connection can only read. Disconnect and reconnect the CWF connector in Claude to allow editing experiences.' }],
          isError: true,
        };
      }
      if ([initial_state_ids, action_ids, final_state_ids, action_claim_rewrites, action_photos].every((v) => v === undefined)) {
        return { content: [{ type: 'text', text: 'Give a leg, a claim rewrite or photos to change.' }], isError: true };
      }
      try {
        const { experience, missing, notAttached, strayPhotos } = await withDbClient(async (client) => {
          const experience = (await client.query(
            `SELECT e.id::text AS id, e.organization_id,
                    ARRAY(SELECT ec.action_id::text FROM experience_components ec WHERE ec.experience_id = e.id AND ec.action_id IS NOT NULL) AS action_ids
             FROM experiences e WHERE e.id::text = $1 AND e.organization_id = ANY($2::uuid[])`,
            [experience_id, accessibleOrgIds]
          )).rows[0];
          if (!experience) return {};
          const missing = await missingComponents(client, {
            observationIds: [...(initial_state_ids || []), ...(final_state_ids || [])], actionIds: action_ids || [],
          }, accessibleOrgIds);
          // A rewrite is of an action in this experience, as it will be after this change.
          const actionsAfter = action_ids || experience.action_ids;
          const notAttached = [...Object.keys(action_claim_rewrites || {}), ...Object.keys(action_photos || {})]
            .filter((id) => !actionsAfter.includes(id));
          return { experience, missing, notAttached, strayPhotos: await photosNotOnActions(client, action_photos) };
        });
        if (!experience) return NOT_AN_EXPERIENCE(experience_id);
        if (missing.length > 0) {
          return { content: [{ type: 'text', text: `Not found in your organizations: ${missing.join(', ')}. Nothing was changed.` }], isError: true };
        }
        if (notAttached.length > 0) {
          return { content: [{ type: 'text', text: `Not an action in this experience: ${[...new Set(notAttached)].join(', ')}. Nothing was changed.` }], isError: true };
        }
        if (strayPhotos.length > 0) {
          return { content: [{ type: 'text', text: `Not a photo on that action's observations: ${strayPhotos.join(', ')}. Nothing was changed.` }], isError: true };
        }
        await updateExperience({
          cognitoUserId,
          orgId: experience.organization_id,
          experienceId: experience.id,
          changes: {
            ...(initial_state_ids && { initial_state_ids }),
            ...(action_ids && { action_ids }),
            ...(final_state_ids && { final_state_ids }),
            ...(action_claim_rewrites && { action_claim_edits: action_claim_rewrites }),
            ...(action_photos && { action_photo_inclusions: action_photos }),
          },
        });
        console.log('update_experience: updated', experience.id);
        return { content: [{ type: 'text', text: JSON.stringify({
          experience_id: experience.id,
          changed: [
            ...['initial_state_ids', 'action_ids', 'final_state_ids'].filter((k) => ({ initial_state_ids, action_ids, final_state_ids })[k]),
            ...(action_claim_rewrites ? ['action_claim_rewrites'] : []),
            ...(action_photos ? ['action_photos'] : []),
          ],
          link: `https://stargazer-farm.com/experiences/${experience.id}`,
        }, null, 2) }] };
      } catch (err) {
        console.log('update_experience failed:', err.message);
        return { content: [{ type: 'text', text: `Could not edit the experience: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'delete_experience',
    {
      title: 'Delete an experience',
      description:
        'Delete an experience write-up, as the app\'s delete does. Only the write-up goes: its observations ' +
        'and actions stay. Only whoever wrote it up, or an admin, can delete it. This cannot be undone, so ' +
        'tell the person which experience it is (asset, date, what it covers) and only call this once they say yes.',
      inputSchema: {
        experience_id: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ experience_id }) => {
      console.log('delete_experience called with:', JSON.stringify({ experience_id }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      if (!canWrite) {
        return {
          content: [{ type: 'text', text: 'This connection can only read. Disconnect and reconnect the CWF connector in Claude to allow deleting experiences.' }],
          isError: true,
        };
      }
      try {
        const experience = await withDbClient(async (client) => (await client.query(
          `SELECT id::text AS id, organization_id FROM experiences WHERE id::text = $1 AND organization_id = ANY($2::uuid[])`,
          [experience_id, accessibleOrgIds]
        )).rows[0]);
        if (!experience) return NOT_AN_EXPERIENCE(experience_id);
        await deleteExperience({ cognitoUserId, orgId: experience.organization_id, experienceId: experience.id });
        console.log('delete_experience: deleted', experience.id);
        return { content: [{ type: 'text', text: JSON.stringify({ experience_id: experience.id, deleted: true }, null, 2) }] };
      } catch (err) {
        console.log('delete_experience failed:', err.message);
        return { content: [{ type: 'text', text: `Could not delete the experience: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'update_observation_links',
    {
      title: 'Link or unlink observations',
      description:
        'Add or remove what observations are linked to — actions and assets (tools and parts), the ' +
        'same links the observation screen allows. Other links are kept. Works on several ' +
        'observations at once. Find observation_ids with search_claims, actions with search_actions ' +
        'and assets with search_assets; confirm the change with the person first. The same people ' +
        'can change an observation as in the app (whoever recorded it, or an admin).',
      inputSchema: {
        observation_ids: z.array(z.string()).min(1).max(25).describe('Observations to change'),
        add: z.array(LINK).optional().describe('Links to add'),
        remove: z.array(LINK).optional().describe('Links to remove'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ observation_ids, add = [], remove = [] }) => {
      console.log('update_observation_links called with:', JSON.stringify({ observation_ids, add, remove }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      if (!canWrite) {
        return {
          content: [{ type: 'text', text: 'This connection can only read. Disconnect and reconnect the CWF connector in Claude to allow editing observations.' }],
          isError: true,
        };
      }
      if (add.length === 0 && remove.length === 0) {
        return { content: [{ type: 'text', text: 'Give links to add or remove.' }], isError: true };
      }

      const same = sameLink;
      try {
        const { targets, observations } = await withDbClient(async (client) => ({
          // What can be added must exist in the caller's orgs; names are for the reply.
          targets: await findLinkTargets(client, add, accessibleOrgIds),
          observations: (await client.query(
            `SELECT s.id::text AS id, s.organization_id,
                    COALESCE(json_agg(json_build_object('entity_type', sl.entity_type, 'entity_id', sl.entity_id))
                      FILTER (WHERE sl.state_id IS NOT NULL), '[]') AS links
             FROM states s LEFT JOIN state_links sl ON sl.state_id = s.id
             WHERE s.id::text = ANY($1::text[]) AND s.organization_id = ANY($2::uuid[])
             GROUP BY s.id`,
            [observation_ids, accessibleOrgIds]
          )).rows,
        }));
        const missing = add.filter((l) => !targets.some((t) => same(t, l)));
        if (missing.length > 0) return notFound(missing);

        const results = [];
        for (const id of observation_ids) {
          const observation = observations.find((o) => o.id === id);
          if (!observation) { results.push({ observation_id: id, result: 'not found in your organizations' }); continue; }
          const kept = observation.links.filter((l) => !remove.some((r) => same(r, l)));
          const links = [...kept, ...add.filter((l) => !kept.some((k) => same(k, l)))];
          if (links.length === observation.links.length && links.every((l) => observation.links.some((o) => same(o, l)))) {
            results.push({ observation_id: id, result: 'no change' });
            continue;
          }
          try {
            await updateObservation({
              cognitoUserId,
              // The states service checks the observation is in this org.
              orgId: observation.organization_id,
              observationId: id,
              changes: { links },
            });
            results.push({ observation_id: id, result: 'updated' });
          } catch (err) {
            results.push({ observation_id: id, result: `not changed: ${err.message}` });
          }
        }
        console.log('update_observation_links:', JSON.stringify(results));
        return { content: [{ type: 'text', text: JSON.stringify({
          added: targets.map((t) => `${t.entity_type}: ${t.name}`),
          removed: remove.map((l) => `${l.entity_type} ${l.entity_id}`),
          results,
        }, null, 2) }] };
      } catch (err) {
        console.log('update_observation_links failed:', err.message);
        return { content: [{ type: 'text', text: `Could not update the observations: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}

export default { create };
