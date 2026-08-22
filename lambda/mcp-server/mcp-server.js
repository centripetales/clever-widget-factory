import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withDbClient } from './db.js';
import { generateEmbedding } from './embeddings.js';

// Stopgap for v1: no auth yet, so there's no authenticated identity to derive
// an organization from. Hardcoded to the single org this has been tested
// against. Once auth is added, this should come from the authenticated
// session instead.
const ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001';

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

function create() {
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
      const effectiveLimit = limit || DEFAULT_LIMIT;

      let resolvedFrom = date_from;
      let resolvedTo = date_to;
      let effectiveRelative = relative;
      if (!effectiveRelative && !date_from && !date_to) {
        effectiveRelative = detectRelativeFromQueryText(query);
        if (effectiveRelative) {
          console.log(`search_claims: detected temporal language in query text ("${query}") -> relative=${effectiveRelative}`);
        }
      }
      if (effectiveRelative) {
        const r = resolveRelativeDate(effectiveRelative);
        resolvedFrom = r.from;
        resolvedTo = r.to;
      }
      const isDateMode = Boolean(resolvedFrom || resolvedTo);

      if (!isDateMode && !query) {
        return {
          content: [{ type: 'text', text: 'Either query (topical search) or relative/date_from/date_to (date-range lookup) is required.' }],
          isError: true,
        };
      }

      try {
        const results = await withDbClient(async (client) => {
          if (isDateMode) {
            const from = resolvedFrom || resolvedTo;
            const to = resolvedTo || resolvedFrom;
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
                AND s.organization_id = $1
                AND s.captured_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Manila')
                AND s.captured_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Manila')
              ORDER BY s.captured_at DESC
              LIMIT $4
            `;
            const res = await client.query(sql, [ORGANIZATION_ID, from, to, effectiveLimit]);
            return res.rows;
          }

          const queryEmbedding = await generateEmbedding(query);
          const embeddingStr = `[${queryEmbedding.join(',')}]`;
          const sql = `
            WITH query_vector AS (SELECT $1::vector AS vec),
            matches AS (
              SELECT entity_id, (1 - (embedding <=> (SELECT vec FROM query_vector))) as similarity
              FROM unified_embeddings
              WHERE organization_id = $2 AND entity_type = 'claim_perspective'
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
          const res = await client.query(sql, [embeddingStr, ORGANIZATION_ID, effectiveLimit, SIMILARITY_THRESHOLD]);
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
        'the observation_id returned by search_claims. Returns actual inline ' +
        'images, not links. Farm photo storage is a public S3 bucket, fetched ' +
        'server-side and returned as image content.',
      inputSchema: {
        observation_id: z.string().describe('The observation_id (state id) from a search_claims result'),
      },
    },
    async ({ observation_id }) => {
      console.log('get_observation_photos called with:', observation_id);
      try {
        const photos = await withDbClient(async (client) => {
          const res = await client.query(
            `SELECT photo_url, photo_description
             FROM state_photos
             WHERE state_id = $1
             ORDER BY photo_order
             LIMIT $2`,
            [observation_id, MAX_PHOTOS_PER_REQUEST]
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

  return server;
}

export default { create };
