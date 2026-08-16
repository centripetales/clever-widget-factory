#!/usr/bin/env node

/**
 * Scoped test: real AZOLLA_STATE (RAW variant, per the raw-vs-claim
 * comparison) and real ACTION_HYPOTHESIS (with photo citation) for
 * Stefan's last-week sequence, plus a state->action->state visual.
 *
 * ACTION_HYPOTHESIS now cites which specific photo(s), by ID, depict the
 * action itself (e.g. a chicken-manure photo) rather than just inferring
 * action text — per the requirement that actions don't have their own
 * photos in this schema, so the visual has to point back at real
 * state_photos rows instead of inventing an "action photo."
 *
 * Usage: node scripts/azolla-stefan-lastweek-sequence.js <output_html>
 */

const { Pool } = require('pg');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx);
    const value = trimmed.substring(eqIdx + 1);
    if (!process.env[key]) process.env[key] = value;
  }
}

const OUT_PATH = process.argv[2];
if (!OUT_PATH) {
  console.error('Usage: node scripts/azolla-stefan-lastweek-sequence.js <output_html>');
  process.exit(1);
}

const REGION = process.env.AWS_REGION || 'us-west-2';
const MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
const TOOL_ID = '7e6bfe0b-afb5-4d00-a38b-3b5d6fa7215f'; // Stefan's canonical container

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});
const bedrock = new BedrockRuntimeClient({ region: REGION });

const AZOLLA_STATE_SYSTEM_PROMPT = `You are a growing-context synthesis system for an azolla/duckweed cultivation pilot in the Philippines. Your only job is to synthesize what is known about one container's current condition, from the participant's own observations recorded since the last human action was taken on that container. You do not evaluate performance, you do not compare against other participants, and you do not give advice.

You will be given a sequence of observations, oldest first, ending with the most recent — all from the same container, all since the last action. Weight the most recent observation as most relevant to the container's current state; earlier ones are background context that may still matter (e.g. an unresolved problem mentioned days ago) but should not override what the most recent observation actually says. Never invent details not present in this material.

Any estimated quantity (phosphorus, pH) must be a rough inference from indirect cues in the text — never a measured value — and must carry its own basis explaining exactly what cue it was inferred from, and which observation (by date) it came from. If there is no cue to infer from, leave the estimate null and say so in uncertainty_flags rather than guessing a plausible-sounding number.`;

const AZOLLA_STATE_TOOL = {
  name: 'record_azolla_state_context',
  description: 'Record the synthesized growing-context for this container',
  input_schema: {
    type: 'object',
    properties: {
      coverage_percent_estimate: { type: 'number', description: 'Rough coverage % if inferable; omit if not.' },
      water_color: { type: 'string', description: 'Described or implied water color/clarity; omit if not mentioned.' },
      vessel_condition: { type: 'string', description: 'Described or implied container condition; omit if not mentioned.' },
      phosphorus_ppm_estimate: { type: 'number', description: 'Rough inferred phosphorus estimate in ppm, only with a real textual cue. Omit otherwise.' },
      phosphorus_estimate_basis: { type: 'string', description: 'Required alongside phosphorus_ppm_estimate: exact cue and which dated observation it came from.' },
      ph_estimate: { type: 'number', description: 'Rough inferred pH estimate, only with a real textual cue. Omit otherwise.' },
      ph_estimate_basis: { type: 'string', description: 'Required alongside ph_estimate: exact cue it was inferred from.' },
      summary: { type: 'string', description: 'The synthesized current growing-context, weighted toward the most recent observation.' },
      uncertainty_flags: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'uncertainty_flags'],
  },
};

const ACTION_HYPOTHESIS_SYSTEM_PROMPT = `You are an action-extraction system for an azolla/duckweed cultivation pilot. Given two of the same participant's observations of the same container — an earlier one and a later one, each with its own dated, individually-identified photos, plus the later observation's already-computed ENTROPY analysis for extra context — your only job is to extract what real human action(s), if any, the participant describes taking between them. This is extraction, not prediction: the participant is telling you what they did in their own words. An action must be something a person actually did — never "time passed" or "natural growth," and never something inferred purely from the change in appearance without the person describing having done it. If the text does not describe a human action between the two observations, say so explicitly (no_action_found=true) rather than inventing one to explain an observed change. Absence of a described action is a normal, honest, valid result — not a failure.

Pay close attention to tense and reference. Distinguish text that describes a NEW action taken in the window between these two observations from text that recalls, reflects on, or describes the outcome of an action already taken earlier — including an action already identified for the immediately preceding transition (given to you below, if any). Phrasing like "after putting X on the surface, it looks like..." or "I was curious if Y after doing Z, but..." is commentary on an already-known past action's outcome, not a report of a new one — do not create a new hypothesis for it. Only extract an action as new if the text itself describes it as newly done, not merely referenced in passing while describing a result.

Photos within a single observation are numbered in capture sequence (e.g. "photo 1/4", "photo 3/4") and are typically taken during the same visit. Use that sequence: if an earlier-numbered photo in an observation shows the state before an action and a later-numbered photo in that SAME observation shows the result (e.g. photo 1 "the bin was full", photo 3 "I removed duckweed to make space"), that within-observation progression is same-day, in-window evidence the action was taken during that visit — this applies even when the action's photos are all within the earlier of the two given observations, not just the later one. Do not discount an action as "before the window" just because all its evidence sits within the earlier observation — check whether that observation's own photo sequence shows the action happening during that visit before concluding it predates the window.

If more than one candidate action is plausible from the text, list each separately with its own confidence rather than picking one and hiding the ambiguity. Confidence here reflects extraction clarity (how clearly the text supports this specific reading), not likelihood of occurrence — if the participant describes it, it happened; the question is only how precisely the text pins down what "it" was.

Each hypothesis's description must stay focused on what was done and why — never on describing the resulting or later state, appearance, growth, or outcome. Growing-condition narration (coverage, color, how things look now) belongs to the AZOLLA_STATE synthesis, a separate perspective — not to an action description. You may draw on later-observation text to justify why you believe an action happened, but do not restate that state-descriptive content as part of the action's own description.

For each hypothesis, classify its action_type:
- "transformative": physically changes the container's real condition — adding an input, harvesting, moving the container, changing the water, adjusting the setup. The container is different afterward, not just better understood.
- "entropy_reduction": does NOT change the container's real condition, but reduces uncertainty about it or about how to act on it — taking a measurement or reading, using a test kit, consulting AI, looking up documented best practice or a stated method. The container's condition was already whatever it was; the action just made it (or the right response to it) more known. Consulting AI counts as entropy_reduction even though no instrument was used — it is not a "measurement," but it is still an uncertainty-reducing act, not a transformative one.

For each hypothesis, also cite EVERY photo ID from EITHER observation that documents that action — not just the single best match. A photo counts as documenting the action either if it visually shows the action/input itself (e.g. a photo of a fertilizer bag), OR if the participant's own caption on that specific photo states they took the action (e.g. a caption saying "I removed duckweed to make space" is evidence for a duckweed-removal action, even if the image itself just shows the container afterward) — the caption is part of what that photo documents, not separate from it. If both observations have a photo independently describing the same ongoing or repeated action (e.g. the earlier observation says "I removed duckweed" and the later one says "as I remove duckweed only"), cite both — they corroborate each other, do not pick just one. A photo belonging to the EARLIER observation is not automatically "old news" — the earlier-vs-later distinction (see the tense/reference guidance above) is about whether text refers to an action from BEFORE the earlier observation's own timestamp, not about which of the two given observations a photo happens to belong to. A photo on the earlier observation whose caption describes an action taken as part of that same visit is valid, current evidence for this transition and must be cited, not treated as already-accounted-for background. Only cite a photo ID that was given to you, never invent one. Leave action_photo_ids empty only when truly no photo (image or caption) among those given documents the action.`;

const ACTION_HYPOTHESIS_TOOL = {
  name: 'record_action_hypotheses',
  description: 'Record candidate human action(s) between two observations, or that none was found',
  input_schema: {
    type: 'object',
    properties: {
      no_action_found: { type: 'boolean' },
      hypotheses: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string', description: 'What was done and why (the participant\'s stated or implied reasoning). Do NOT describe the resulting or later state, appearance, or outcome — that belongs to AZOLLA_STATE, not here. State evidence may be used to justify WHY you believe this action occurred, but the description text itself must stay about the act, not what things looked like afterward.' },
            action_type: { type: 'string', enum: ['transformative', 'entropy_reduction'] },
            confidence: { type: 'number', description: '0.0-1.0' },
            action_photo_ids: { type: 'array', items: { type: 'string' }, description: 'Photo ID(s) (from those given) that depict the action itself, not just the resulting state. Empty if none.' },
          },
          required: ['title', 'description', 'action_type', 'confidence', 'action_photo_ids'],
        },
      },
    },
    required: ['no_action_found', 'hypotheses'],
  },
};

async function invokeBedrock(systemPrompt, userPrompt, tool) {
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1200,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
    tools: [{ name: tool.name, description: tool.description, input_schema: tool.input_schema }],
    tool_choice: { type: 'tool', name: tool.name },
  };
  const command = new InvokeModelCommand({ modelId: MODEL_ID, contentType: 'application/json', accept: 'application/json', body: JSON.stringify(body) });
  const response = await bedrock.send(command);
  const parsed = JSON.parse(new TextDecoder().decode(response.body));
  const toolUse = parsed.content.find(c => c.type === 'tool_use');
  return toolUse ? toolUse.input : null;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function main() {
  const client = await pool.connect();
  try {
    const states = await client.query(`
      SELECT s.id, s.captured_at
      FROM states s JOIN state_links sl ON sl.state_id = s.id AND sl.entity_type = 'tool' AND sl.entity_id = $1
      ORDER BY s.captured_at DESC LIMIT 4
    `, [TOOL_ID]);
    const stateRows = states.rows.reverse(); // oldest first: Aug4, Aug9, Aug14, Aug15

    const withPhotos = [];
    for (const s of stateRows) {
      const photos = await client.query(`SELECT id, photo_url, photo_description FROM state_photos WHERE state_id = $1 ORDER BY photo_order`, [s.id]);
      const claim = await client.query(`SELECT cp.content FROM state_perspectives sp JOIN claim_perspectives cp ON cp.id = sp.id WHERE sp.state_id = $1`, [s.id]);
      const sig = await client.query(`SELECT sig.content FROM state_perspectives sp JOIN significance_perspectives sig ON sig.id = sp.id WHERE sp.state_id = $1`, [s.id]);
      const ent = await client.query(`SELECT ep.content FROM state_perspectives sp JOIN entropy_perspectives ep ON ep.id = sp.id WHERE sp.state_id = $1`, [s.id]);
      withPhotos.push({
        id: s.id,
        capturedAt: s.captured_at,
        photos: photos.rows,
        claim: claim.rows[0]?.content || null,
        significance: sig.rows[0]?.content || null,
        entropy: ent.rows[0]?.content || null,
      });
    }

    console.log(`Generating AZOLLA_STATE (RAW) for ${withPhotos.length} states...`);
    const azollaStates = [];
    for (let i = 0; i < withPhotos.length; i++) {
      const priorEntries = withPhotos.slice(0, i + 1).map(s => ({
        date: s.capturedAt.toISOString().slice(0, 10),
        text: s.photos.map(p => p.photo_description).filter(Boolean).join(' / ') || '(no text)',
      }));
      const lines = priorEntries.map(e => `[${e.date}] ${e.text}`).join('\n\n');
      const userPrompt = `Container: Stefan's Azolla Container\nSource: raw photo/observation notes\n\nObservations (oldest first, most recent last):\n\n${lines}\n\nSynthesize the current growing-context for this container.`;
      const result = await invokeBedrock(AZOLLA_STATE_SYSTEM_PROMPT, userPrompt, AZOLLA_STATE_TOOL);
      azollaStates.push(result);
      console.log(`  [${withPhotos[i].capturedAt.toISOString().slice(0, 10)}] ${result.summary.slice(0, 80)}...`);
    }

    console.log(`\nGenerating ACTION_HYPOTHESIS for ${withPhotos.length - 1} pairs...`);
    const actionHypotheses = [];
    for (let i = 1; i < withPhotos.length; i++) {
      const prior = withPhotos[i - 1];
      const final = withPhotos[i];
      const photoList = (label, s) => s.photos.map((p, idx) => `  [photo ${idx + 1}/${s.photos.length}, id ${p.id}] ${p.photo_description || '(no description)'}`).join('\n') || '  (no photos)';
      const entropyContext = final.entropy ? `\n\nLater observation's already-computed ENTROPY analysis (for context, not to be treated as ground truth about actions): ${final.entropy}` : '';
      const priorAction = actionHypotheses[i - 2]; // the transition immediately before this one, if any
      const priorActionContext = (priorAction && !priorAction.no_action_found && priorAction.hypotheses.length)
        ? `\n\nAction(s) already identified for the immediately preceding transition (do NOT re-report these as new if the later observation is merely recalling or describing their outcome):\n${priorAction.hypotheses.map(h => `  - ${h.title}: ${h.description}`).join('\n')}`
        : '';
      const userPrompt = `Earlier observation [${prior.capturedAt.toISOString().slice(0, 10)}], photos:\n${photoList('prior', prior)}\n\nLater observation [${final.capturedAt.toISOString().slice(0, 10)}], photos:\n${photoList('final', final)}${entropyContext}${priorActionContext}\n\nIdentify any human action(s) described as having happened between these two observations.`;
      const result = await invokeBedrock(ACTION_HYPOTHESIS_SYSTEM_PROMPT, userPrompt, ACTION_HYPOTHESIS_TOOL);
      actionHypotheses.push(result);
      console.log(`  [${prior.capturedAt.toISOString().slice(0, 10)} -> ${final.capturedAt.toISOString().slice(0, 10)}] no_action_found=${result.no_action_found}, ${result.hypotheses.length} hypothesis(es)`);
      result.hypotheses.forEach(h => console.log(`    "${h.title}" [${h.action_type}] (conf ${h.confidence}) photos: ${h.action_photo_ids.join(', ') || 'none'}`));
    }

    // Build the visual as a strict top-to-bottom timeline:
    // [State card] -> [full-width Action band below it, with its own cited photos] -> [State card] -> ...
    const photoById = new Map();
    for (const s of withPhotos) {
      s.photos.forEach((p, idx) => photoById.set(p.id, { ...p, stateDate: s.capturedAt, photoOrder: idx }));
    }

    let blocksHtml = '';
    for (let i = 0; i < withPhotos.length; i++) {
      const s = withPhotos[i];
      const az = azollaStates[i];

      blocksHtml += `
      <div class="timeline-item">
        <div class="state-block">
          <div class="state-date">STATE — ${s.capturedAt.toISOString().slice(0, 10)}</div>
          <div class="photos">
            ${s.photos.map(p => `
              <div class="photo">
                <img src="${esc(p.photo_url)}" loading="lazy" />
                <div class="photo-desc">${esc(p.photo_description || '(no description)')}</div>
              </div>`).join('')}
          </div>
          <div class="synthesis">
            <span class="label">AZOLLA_STATE synthesis (new, raw-text based)</span>
            <div class="synthesis-text">${esc(az.summary)}</div>
            ${az.phosphorus_ppm_estimate != null ? `<div class="estimate">Phosphorus: ~${az.phosphorus_ppm_estimate} ppm — <em>${esc(az.phosphorus_estimate_basis)}</em></div>` : ''}
            ${az.ph_estimate != null ? `<div class="estimate">pH: ~${az.ph_estimate} — <em>${esc(az.ph_estimate_basis)}</em></div>` : ''}
          </div>
          <div class="existing-perspectives">
            <span class="label">Existing CLAIM / ENTROPY (already computed, for comparison)</span>
            ${s.claim ? `<div class="persp"><b>CLAIM</b> ${esc(s.claim)}</div>` : ''}
            ${s.entropy ? `<div class="persp persp-entropy"><b>ENTROPY</b> ${esc(s.entropy)}</div>` : ''}
            ${!s.claim && !s.entropy ? '<div class="persp none">(none computed for this state)</div>' : ''}
          </div>
        </div>
        ${i < withPhotos.length - 1 ? (() => {
          const ah = actionHypotheses[i];
          const priorDate = withPhotos[i].capturedAt.getTime();
          const nextDate = withPhotos[i + 1].capturedAt.getTime();
          return `
        <div class="action-band">
          <div class="action-band-label">ACTION</div>
          ${ah.no_action_found
            ? '<div class="no-action">No human action found in the text</div>'
            : ah.hypotheses.map(h => {
              const citedPhotos = h.action_photo_ids.map(id => photoById.get(id)).filter(Boolean);
              // Only show photos from the PRIOR state as images here — a photo
              // belonging to the NEXT state is that state's own evidence and
              // will render in full in the STATE block immediately below;
              // showing it again here (with a state-like date label) makes the
              // action band look like it IS a state, which it isn't.
              const priorPhotos = citedPhotos.filter(p => p.stateDate.getTime() === priorDate).sort((a, b) => a.photoOrder - b.photoOrder);
              const nextPhotos = citedPhotos.filter(p => p.stateDate.getTime() === nextDate);
              return `
              <div class="hypothesis ${h.action_type}">
                <div class="hyp-title">${esc(h.title)} <span class="type-badge ${h.action_type}">${h.action_type === 'entropy_reduction' ? 'entropy reduction' : 'transformative'}</span> <span class="conf">confidence ${h.confidence}</span></div>
                <div class="hyp-desc">${esc(h.description)}</div>
                ${priorPhotos.length ? `<div class="hyp-photos">
                  ${priorPhotos.map(p => `
                    <div class="photo">
                      <img src="${esc(p.photo_url)}" loading="lazy" />
                      <div class="photo-desc">${esc(p.photo_description || '(no description)')}</div>
                    </div>`).join('')}
                </div>` : ''}
                ${nextPhotos.length ? `<div class="hyp-photos-note">also corroborated by ${nextPhotos.length} photo(s) in the following observation, shown in the state below</div>` : ''}
              </div>`;
            }).join('')}
        </div>`;
        })() : ''}
      </div>`;
    }

    const html = `<title>Stefan's Azolla Container — Last Week Sequence</title>
<style>
  :root { --bg:#fff; --ink:#1a2332; --ink-dim:#64748b; --border:#e2e8f0; --surface:#f8fafc; --accent:#2563eb; --cited:#fef3c7; --cited-border:#f59e0b; --transform:#16a34a; --entropy:#7c3aed; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f172a; --ink:#e2e8f0; --ink-dim:#94a3b8; --border:#1e293b; --surface:#1e293b; --cited:#422006; --cited-border:#f59e0b; } }
  :root[data-theme="dark"] { --bg:#0f172a; --ink:#e2e8f0; --ink-dim:#94a3b8; --border:#1e293b; --surface:#1e293b; --cited:#422006; --cited-border:#f59e0b; }
  :root[data-theme="light"] { --bg:#fff; --ink:#1a2332; --ink-dim:#64748b; --border:#e2e8f0; --surface:#f8fafc; --cited:#fef3c7; --cited-border:#f59e0b; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--bg); margin:0; }
  .wrap { max-width: 640px; margin: 0 auto; padding: 24px 20px 80px; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .subtitle { color: var(--ink-dim); font-size: 13px; margin: 0 0 24px; }
  .timeline-item { border-left: 3px solid var(--border); padding-left: 16px; margin-left: 6px; }
  .timeline-item:last-child { border-left-color: transparent; }
  .state-block { border: 1px solid var(--border); border-radius: 10px; padding: 14px; background: var(--surface); margin-bottom: 0; }
  .state-date { font-weight: 700; font-size: 13px; margin-bottom: 8px; color: var(--ink-dim); letter-spacing: .03em; }
  .photos { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; margin-bottom: 10px; }
  .photo { border: 1px solid var(--border); border-radius: 6px; padding: 6px; font-size: 11px; background: var(--bg); position: relative; }
  .photo img { width: 100%; height: 110px; object-fit: cover; border-radius: 4px; display: block; background: var(--border); margin-bottom: 4px; }
  .photo-desc { color: var(--ink); line-height: 1.3; }
  .photo-date { font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: var(--accent); margin-bottom: 3px; }
  .synthesis, .existing-perspectives { border-top: 1px solid var(--border); padding-top: 8px; margin-top: 8px; }
  .label { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-dim); font-weight: 650; display: block; margin-bottom: 4px; }
  .synthesis-text { font-size: 13px; margin-top: 4px; }
  .estimate { font-size: 12px; color: var(--accent); margin-top: 6px; }
  .persp { font-size: 12px; margin-top: 6px; line-height: 1.4; }
  .persp b { font-size: 10px; text-transform: uppercase; letter-spacing: .03em; color: var(--ink-dim); margin-right: 4px; }
  .persp.none { color: var(--ink-dim); font-style: italic; }
  .persp-entropy b { color: var(--entropy); }
  .action-band { margin: 0 0 20px -19px; padding: 14px 14px 14px 22px; border-left: 3px solid var(--accent); background: var(--bg); }
  .action-band-label { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--accent); font-weight: 700; margin-bottom: 8px; }
  .hypothesis { border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; margin-bottom: 6px; background: var(--surface); }
  .hypothesis.transformative { border-left: 4px solid var(--transform); }
  .hypothesis.entropy_reduction { border-left: 4px solid var(--entropy); }
  .hyp-title { font-weight: 700; font-size: 13px; }
  .type-badge { font-weight: 700; font-size: 9.5px; text-transform: uppercase; letter-spacing: .03em; padding: 2px 6px; border-radius: 999px; margin: 0 4px; }
  .type-badge.transformative { background: var(--transform); color: #fff; }
  .type-badge.entropy_reduction { background: var(--entropy); color: #fff; }
  .conf { font-weight: 400; color: var(--ink-dim); font-size: 11px; }
  .hyp-desc { font-size: 12.5px; margin-top: 4px; }
  .hyp-photos { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 6px; margin-top: 8px; }
  .hyp-photos-note { font-size: 11.5px; color: var(--ink-dim); font-style: italic; margin-top: 8px; }
  .hyp-photos .photo img { height: 85px; }
  .no-action { color: var(--ink-dim); font-style: italic; font-size: 13px; }
</style>
<div class="wrap">
  <h1>Stefan's Azolla Container — State &rarr; Action &rarr; State</h1>
  <p class="subtitle">${withPhotos.length} observations, ${withPhotos.length - 1} inferred transitions, top to bottom chronologically. Each action is classified transformative (red) or entropy reduction (green) — measurement, AI consultation, or best-practice lookup all count as entropy reduction. Existing CLAIM/SIGNIFICANCE/ENTROPY shown per state for comparison against the new AZOLLA_STATE synthesis.</p>
  ${blocksHtml}
</div>
`;

    fs.writeFileSync(OUT_PATH, html);
    console.log(`\nWritten to ${OUT_PATH}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
