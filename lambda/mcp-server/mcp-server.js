import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withDbClient } from './db.js';
import { generateEmbedding } from './embeddings.js';
import { createAction, createObservation, setObservationLinks, policyToHtml } from './actions.js';

const SIMILARITY_THRESHOLD = 0.45;
const DEFAULT_LIMIT = 10;
const MAX_PHOTOS_PER_REQUEST = 5;

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

// What an observation can be linked to through the connector — the same as
// the observation screen's Link Asset (assets) and linked action.
const LINK = z.object({
  entity_type: z.enum(['action', 'tool', 'part']),
  entity_id: z.string(),
});

const NOT_A_MEMBER = {
  content: [{ type: 'text', text: 'You are not an active member of any CWF organization, so there is no farm data to show.' }],
  isError: true,
};

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
        'Only observations linked to an action or general observation entity ' +
        'have a claim; coverage is partial, not every observation.\n\n' +
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
      },
    },
    async ({ query, relative, date_from, date_to, limit }) => {
      console.log('search_claims called with:', JSON.stringify({ query, relative, date_from, date_to, limit }));
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
              ORDER BY s.captured_at DESC
              LIMIT $4
            `;
            const res = await client.query(sql, [accessibleOrgIds, from, to, effectiveLimit]);
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
          const res = await client.query(sql, [embeddingStr, accessibleOrgIds, effectiveLimit, SIMILARITY_THRESHOLD]);
          return res.rows;
        });

        console.log(`search_claims: isDateMode=${isDateMode} resolved(${resolvedFrom},${resolvedTo}) -> ${results.length} results`);

        if (results.length === 0) {
          const msg = isDateMode
            ? 'No claims found in that date range. Coverage is partial — only observations linked to an action or general observation entity have a claim — so there may be raw observations on this date without one.'
            : 'No claims matched that query above the similarity threshold. Coverage is partial (not every observation has a claim), so this may be a coverage gap rather than a real absence — try a broader query or ask about raw observations instead.';
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
        'server-side and returned as image content.',
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
            `SELECT sp.photo_url, sp.photo_description
             FROM state_photos sp
             JOIN states s ON s.id = sp.state_id
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
            const response = await fetch(photo.photo_url);
            if (!response.ok) {
              content.push({ type: 'text', text: `Could not fetch photo (HTTP ${response.status}): ${photo.photo_url}` });
              continue;
            }
            const mimeType = response.headers.get('content-type') || 'image/jpeg';
            const buffer = Buffer.from(await response.arrayBuffer());
            content.push({ type: 'image', data: buffer.toString('base64'), mimeType });
            if (photo.photo_description) {
              content.push({ type: 'text', text: photo.photo_description });
            }
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
      const where = ['a.organization_id = ANY($1::uuid[])', NOT_FROM_TRANSACTION];
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
               SELECT entity_id, 1 - (embedding <=> ${vector}::vector) AS similarity
               FROM unified_embeddings
               WHERE organization_id = ANY($1::uuid[]) AND entity_type = 'action_policy'
               ORDER BY embedding <=> ${vector}::vector
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
        const names = [assigned_to, ...(participants || [])].filter(Boolean);
        const members = names.length === 0 ? [] : await withDbClient(async (client) => (await client.query(
          `SELECT user_id::text AS user_id, full_name FROM organization_members
           WHERE organization_id = $1 AND is_active = true AND user_id IS NOT NULL`,
          [accessibleOrgIds[0]]
        )).rows);
        const resolve = (name) => {
          const exact = members.filter((m) => m.full_name?.trim().toLowerCase() === name.trim().toLowerCase());
          const partial = members.filter((m) => m.full_name?.toLowerCase().includes(name.trim().toLowerCase()));
          const found = exact.length === 1 ? exact : partial;
          if (found.length === 1) return found[0].user_id;
          throw new Error(found.length === 0
            ? `No active member named "${name}". Members: ${members.map((m) => m.full_name).join(', ')}`
            : `"${name}" matches ${found.map((m) => m.full_name).join(', ')} — ask which one.`);
        };

        const created = await createAction({
          cognitoUserId,
          orgIds: accessibleOrgIds,
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
    'add_observation',
    {
      title: 'Add an observation to an action',
      description:
        'Record an observation on an existing action, in the person\'s own words, and get a link ' +
        'to add photos to it. Claude cannot pass photos from the chat to CWF, so when the person ' +
        'wants photos on an action, create the observation here and give them the photo link: it ' +
        'opens the observation in the CWF app, where they can take or pick photos. ' +
        'Find the action_id with search_actions first.',
      inputSchema: {
        action_id: z.string().describe('The action_id from search_actions or create_action'),
        text: z.string().optional().describe('What the person observed, in their own words. Can be left out if they only want to add photos.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ action_id, text }) => {
      console.log('add_observation called with:', JSON.stringify({ action_id, hasText: Boolean(text) }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      if (!canWrite) {
        return {
          content: [{ type: 'text', text: 'This connection can only read. Disconnect and reconnect the CWF connector in Claude to allow adding observations.' }],
          isError: true,
        };
      }

      try {
        const action = await withDbClient(async (client) => (await client.query(
          `SELECT id, title, organization_id FROM actions WHERE id::text = $1 AND organization_id = ANY($2::uuid[])`,
          [action_id, accessibleOrgIds]
        )).rows[0]);
        if (!action) {
          return { content: [{ type: 'text', text: 'No action with that id in your organizations — find it with search_actions.' }], isError: true };
        }

        // Like the app: the observation goes in the caller's primary organization
        // (oldest membership), even on another org's action, e.g. Positive Sum's.
        const created = await createObservation({
          cognitoUserId,
          orgIds: accessibleOrgIds,
          observation: {
            state_text: text?.trim() || null,
            photos: [],
            links: [{ entity_type: 'action', entity_id: action.id }],
          },
        });
        console.log('add_observation: created', created.id, 'on action', action.id);
        return {
          content: [{ type: 'text', text: JSON.stringify({
            observation_id: created.id,
            action: action.title,
            add_photos_link: `https://stargazer-farm.com/observations/edit/${created.id}`,
            action_link: `https://stargazer-farm.com/actions/${action.id}`,
          }, null, 2) }],
        };
      } catch (err) {
        console.log('add_observation failed:', err.message);
        return { content: [{ type: 'text', text: `Could not add the observation: ${err.message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    'search_assets',
    {
      title: 'Search assets',
      description:
        'Find assets — tools (equipment, places, fields, containers) and parts (stock) — by name or ' +
        'topic, to get the asset_id and type to link an observation to with update_observation_links.',
      inputSchema: {
        query: z.string().min(1).describe('Name or topic, e.g. "azolla pond" or "inverter"'),
        limit: z.number().int().min(1).max(25).optional().describe('Max results, default 10'),
      },
    },
    async ({ query, limit }) => {
      console.log('search_assets called with:', JSON.stringify({ query, limit }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
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
          return [...byName, ...byMeaning].filter((r) => r.name && !seen.has(r.id) && seen.add(r.id)).slice(0, effectiveLimit);
        });
        console.log(`search_assets: -> ${results.length} results`);
        if (results.length === 0) return { content: [{ type: 'text', text: 'No assets matched — try another name.' }] };
        return { content: [{ type: 'text', text: JSON.stringify(results.map((r) => ({ asset_id: r.id, type: r.type, name: r.name, category: r.category })), null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error searching assets: ${err.message}` }], isError: true };
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
        'and assets with search_assets; confirm the change with the person first. Only observations ' +
        'the person recorded themselves can be changed.',
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

      const same = (a, b) => a.entity_type === b.entity_type && String(a.entity_id) === String(b.entity_id);
      try {
        const { targets, observations } = await withDbClient(async (client) => ({
          // What can be added must exist in the caller's orgs; names are for the reply.
          targets: add.length === 0 ? [] : (await client.query(
            `SELECT 'action' AS entity_type, id::text AS entity_id, title AS name FROM actions
               WHERE id::text = ANY($1::text[]) AND organization_id = ANY($2::uuid[])
             UNION ALL
             SELECT 'tool', id::text, name FROM tools WHERE id::text = ANY($1::text[]) AND organization_id = ANY($2::uuid[])
             UNION ALL
             SELECT 'part', id::text, name FROM parts WHERE id::text = ANY($1::text[]) AND organization_id = ANY($2::uuid[])`,
            [add.map((l) => l.entity_id), accessibleOrgIds]
          )).rows,
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
        if (missing.length > 0) {
          return { content: [{ type: 'text', text: `Not found in your organizations: ${missing.map((l) => `${l.entity_type} ${l.entity_id}`).join(', ')} — check the ids with search_actions / search_assets.` }], isError: true };
        }

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
            await setObservationLinks({
              cognitoUserId,
              // The states service checks the observation is in this org.
              orgIds: [observation.organization_id, ...accessibleOrgIds.filter((o) => o !== observation.organization_id)],
              observationId: id,
              links,
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
