import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withDbClient } from './db.js';
import { generateEmbedding } from './embeddings.js';

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

const NOT_A_MEMBER = {
  content: [{ type: 'text', text: 'You are not an active member of any CWF organization, so there is no farm data to show.' }],
  isError: true,
};

// accessibleOrgIds comes from the authenticated caller (see orgs.js); every
// query is limited to it.
function create({ accessibleOrgIds }) {
  const server = new McpServer(
    { name: 'cwf-observations', version: '1.0.0' },
    { capabilities: { tools: {} } }
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
        'Search farm actions — work that was planned or done: title, policy (the plan), ' +
        'expected state, status, who it is assigned to and who took part, and when it ' +
        'was created and completed. Each result lists observation_ids for the observations ' +
        'recorded on the action; pass one to get_observation_photos to see its photos.\n\n' +
        TWO_MODES + ' Date mode matches actions created or completed in the window.',
      inputSchema: SEARCH_INPUTS,
    },
    async ({ query, relative, date_from, date_to, limit }) => {
      console.log('search_actions called with:', JSON.stringify({ query, relative, date_from, date_to, limit }));
      if (accessibleOrgIds.length === 0) return NOT_A_MEMBER;
      const { resolvedFrom, resolvedTo, isDateMode } = resolveWindow('search_actions', { query, relative, date_from, date_to });
      if (!isDateMode && !query) return NEEDS_QUERY_OR_DATES;
      const effectiveLimit = limit || DEFAULT_LIMIT;

      const columns = `
        a.id, a.title, a.policy, a.expected_state, a.status, a.created_at, a.completed_at,
        (SELECT om.full_name FROM organization_members om
          WHERE om.user_id::text = a.assigned_to::text AND om.organization_id = a.organization_id LIMIT 1) AS assigned_to_name,
        (SELECT string_agg(om.full_name, ', ') FROM organization_members om
          WHERE om.user_id::text = ANY(a.participants::text[]) AND om.organization_id = a.organization_id) AS participant_names,
        (SELECT array_agg(sl.state_id ORDER BY s.captured_at) FROM state_links sl JOIN states s ON s.id = sl.state_id
          WHERE sl.entity_type = 'action' AND sl.entity_id = a.id) AS observation_ids`;

      try {
        const results = await withDbClient(async (client) => {
          if (isDateMode) {
            const res = await client.query(
              `SELECT ${columns}
               FROM actions a
               WHERE a.organization_id = ANY($1::uuid[]) AND ${NOT_FROM_TRANSACTION}
                 AND (
                   (a.created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Manila')
                     AND a.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Manila'))
                   OR (a.completed_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Manila')
                     AND a.completed_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Manila'))
                 )
               ORDER BY COALESCE(a.completed_at, a.created_at) DESC
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
               WHERE organization_id = ANY($2::uuid[]) AND entity_type = 'action_policy'
               ORDER BY embedding <=> $1::vector
               LIMIT $3
             )
             SELECT m.similarity, ${columns}
             FROM matches m
             JOIN actions a ON a.id = m.entity_id
             WHERE a.organization_id = ANY($2::uuid[]) AND ${NOT_FROM_TRANSACTION}
               AND m.similarity > $4
             ORDER BY m.similarity DESC`,
            [embeddingStr, accessibleOrgIds, effectiveLimit, SIMILARITY_THRESHOLD]
          );
          return res.rows;
        });

        console.log(`search_actions: isDateMode=${isDateMode} resolved(${resolvedFrom},${resolvedTo}) -> ${results.length} results`);
        if (results.length === 0) {
          return { content: [{ type: 'text', text: isDateMode ? 'No actions were created or completed in that date range.' : 'No actions matched that query above the similarity threshold — try a broader query.' }] };
        }

        const formatted = results.map((r) => ({
          action_id: r.id,
          similarity: isDateMode ? undefined : Number(r.similarity.toFixed(3)),
          title: r.title,
          policy: r.policy,
          expected_state: r.expected_state,
          status: r.status,
          assigned_to: r.assigned_to_name,
          participants: r.participant_names,
          created_at_manila: formatManilaTime(r.created_at),
          completed_at_manila: r.completed_at ? formatManilaTime(r.completed_at) : null,
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

  return server;
}

export default { create };
