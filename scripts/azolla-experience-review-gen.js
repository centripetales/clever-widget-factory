#!/usr/bin/env node

/**
 * Review-flow HTML generator (docs/specs/azolla-impact-power-model.md §7).
 *
 * Queries state_perspectives (AZOLLA_STATE + ACTION_HYPOTHESIS) directly —
 * no intermediate JSON file, per the spec decision to keep proposals
 * permanently queryable rather than routed through a throwaway export.
 * Renders one self-contained HTML page, one section per container
 * (reviewed container-by-container per the confirmed review order), pairs
 * in chronological sequence within each. Decisions are held in
 * localStorage as you review (survives reload) and can be exported as
 * JSON via the button at the top — that export is what
 * azolla-experience-commit.js consumes.
 *
 * Usage: node scripts/azolla-experience-review-gen.js <output_html>
 */

const { Pool } = require('pg');
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
  console.error('Usage: node scripts/azolla-experience-review-gen.js <output_html>');
  process.exit(1);
}

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function main() {
  const client = await pool.connect();
  try {
    // Every ACTION_HYPOTHESIS perspective defines one reviewable pair
    // (prior_state -> final_state). AZOLLA_STATE perspectives are fetched
    // separately per state and joined in — a state's context may be
    // referenced by more than one pair (chaining), so it's not joined
    // 1:1 with the hypothesis row.
    const pairsRes = await client.query(`
      SELECT
        t.id AS tool_id, t.name AS container_name,
        sp.id AS hypothesis_perspective_id,
        ahp.prior_state_id, ahp.no_action_found, ahp.hypotheses,
        s_final.id AS final_state_id, s_final.state_text AS final_text, s_final.captured_at AS final_captured_at,
        s_prior.state_text AS prior_text, s_prior.captured_at AS prior_captured_at
      FROM action_hypothesis_perspectives ahp
      JOIN state_perspectives sp ON sp.id = ahp.id
      JOIN states s_final ON s_final.id = sp.state_id
      JOIN states s_prior ON s_prior.id = ahp.prior_state_id
      JOIN state_links sl ON sl.entity_type = 'tool' AND sl.entity_id IN (
        SELECT entity_id FROM state_links WHERE state_id = s_final.id AND entity_type = 'tool'
      )
      JOIN tools t ON t.id = sl.entity_id AND sl.state_id = s_final.id
      ORDER BY t.name, s_final.captured_at
    `);

    const stateIds = new Set();
    for (const r of pairsRes.rows) { stateIds.add(r.final_state_id); stateIds.add(r.prior_state_id); }

    const azollaStateRes = stateIds.size ? await client.query(
      `SELECT asp.*, sp.state_id, sp.created_at AS perspective_created_at
       FROM azolla_state_perspectives asp
       JOIN state_perspectives sp ON sp.id = asp.id
       WHERE sp.state_id = ANY($1::uuid[])
       ORDER BY sp.created_at DESC`,
      [[...stateIds]]
    ) : { rows: [] };
    const azollaStateByStateId = new Map();
    for (const r of azollaStateRes.rows) {
      if (!azollaStateByStateId.has(r.state_id)) azollaStateByStateId.set(r.state_id, r); // most recent first
    }

    const photosRes = stateIds.size ? await client.query(
      `SELECT state_id, photo_url, photo_description, photo_order
       FROM state_photos WHERE state_id = ANY($1::uuid[]) ORDER BY state_id, photo_order`,
      [[...stateIds]]
    ) : { rows: [] };
    const photosByStateId = new Map();
    for (const r of photosRes.rows) {
      if (!photosByStateId.has(r.state_id)) photosByStateId.set(r.state_id, []);
      photosByStateId.get(r.state_id).push(r);
    }

    const containers = new Map();
    for (const row of pairsRes.rows) {
      if (!containers.has(row.tool_id)) containers.set(row.tool_id, { name: row.container_name, pairs: [] });
      containers.get(row.tool_id).pairs.push(row);
    }

    let sectionsHtml = '';
    let totalPairs = 0;

    for (const [toolId, { name, pairs }] of containers) {
      sectionsHtml += `<h2 class="container-name">${esc(name)}</h2>`;
      for (const row of pairs) {
        totalPairs++;
        const pairId = row.hypothesis_perspective_id;
        const priorPhotos = photosByStateId.get(row.prior_state_id) || [];
        const finalPhotos = photosByStateId.get(row.final_state_id) || [];
        const azollaState = azollaStateByStateId.get(row.final_state_id);
        const hypotheses = Array.isArray(row.hypotheses) ? row.hypotheses : [];

        const photosBlock = (photos, label) => `
          <div class="state-block">
            <div class="state-label">${label}</div>
            <div class="photos">
              ${photos.map((p) => `<img src="${esc(p.photo_url)}" loading="lazy" />`).join('') || '<div class="no-photos">No photos</div>'}
            </div>
          </div>`;

        sectionsHtml += `
        <div class="pair" data-pair-id="${esc(pairId)}">
          <div class="pair-header">
            <span class="pair-dates">${new Date(row.prior_captured_at).toLocaleDateString()} &rarr; ${new Date(row.final_captured_at).toLocaleDateString()}</span>
            <span class="decision-badge" data-role="badge">unreviewed</span>
          </div>
          <div class="states-row">
            ${photosBlock(priorPhotos, 'Before')}
            ${photosBlock(finalPhotos, 'After')}
          </div>
          <div class="notes-row">
            <div class="note-col"><span class="note-label">Before note</span><div class="note-text">${esc(row.prior_text) || '<em>none</em>'}</div></div>
            <div class="note-col"><span class="note-label">After note</span><div class="note-text">${esc(row.final_text) || '<em>none</em>'}</div></div>
          </div>
          <div class="proposal">
            <div class="proposal-block">
              <span class="proposal-label">AZOLLA_STATE synthesis (After)</span>
              <div class="proposal-text">${esc(azollaState ? azollaState.summary : '(none generated)')}</div>
            </div>
            <div class="proposal-block">
              <span class="proposal-label">ACTION_HYPOTHESIS</span>
              ${row.no_action_found
                ? '<div class="proposal-text no-action">No human action found in the text.</div>'
                : hypotheses.map((h, idx) => `
                  <div class="hypothesis" data-hyp-idx="${idx}">
                    <label><input type="radio" name="hyp-${esc(pairId)}" value="${idx}" data-role="hyp-radio" /> <strong>${esc(h.title || '(untitled)')}</strong> (confidence: ${esc(h.confidence != null ? h.confidence : '?')})</label>
                    <div class="hyp-desc">${esc(h.description || '')}</div>
                  </div>`).join('') || '<div class="proposal-text">(no hypotheses)</div>'}
            </div>
          </div>
          <div class="edit-row" data-role="edit-row" style="display:none">
            <label>Action title <input type="text" data-role="edit-title" /></label>
            <label>Action description <textarea data-role="edit-desc"></textarea></label>
          </div>
          <div class="controls">
            <button data-role="accept" class="btn accept">Accept</button>
            <button data-role="edit" class="btn edit">Edit</button>
            <button data-role="reject" class="btn reject">Reject</button>
          </div>
        </div>`;
      }
    }

    const html = `<title>Azolla Experience Backfill Review</title>
<style>
  :root { --bg:#fff; --ink:#1a2332; --ink-dim:#64748b; --border:#e2e8f0; --surface:#f8fafc; --accent:#2563eb; --ok:#16a34a; --warn:#dc2626; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f172a; --ink:#e2e8f0; --ink-dim:#94a3b8; --border:#1e293b; --surface:#1e293b; } }
  :root[data-theme="dark"] { --bg:#0f172a; --ink:#e2e8f0; --ink-dim:#94a3b8; --border:#1e293b; --surface:#1e293b; }
  :root[data-theme="light"] { --bg:#fff; --ink:#1a2332; --ink-dim:#64748b; --border:#e2e8f0; --surface:#f8fafc; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--bg); margin:0; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 24px 20px 80px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: var(--ink-dim); font-size: 13px; margin: 0 0 16px; }
  .container-name { font-size: 17px; margin: 36px 0 12px; padding-bottom: 6px; border-bottom: 2px solid var(--border); }
  .pair { border: 1px solid var(--border); border-radius: 10px; padding: 14px; margin-bottom: 16px; background: var(--surface); }
  .pair-header { display:flex; justify-content: space-between; align-items:center; font-size: 12px; color: var(--ink-dim); margin-bottom: 8px; }
  .decision-badge { padding: 2px 8px; border-radius: 999px; background: var(--border); font-weight: 600; text-transform: uppercase; font-size: 10px; }
  .decision-badge[data-decision="accepted"] { background: var(--ok); color: #fff; }
  .decision-badge[data-decision="rejected"] { background: var(--warn); color: #fff; }
  .decision-badge[data-decision="edited"] { background: var(--accent); color: #fff; }
  .states-row, .notes-row, .proposal { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 10px; }
  .state-label, .note-label, .proposal-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-dim); font-weight: 650; display:block; margin-bottom: 4px; }
  .photos { display: flex; gap: 6px; flex-wrap: wrap; }
  .photos img { width: 90px; height: 90px; object-fit: cover; border-radius: 6px; background: var(--border); }
  .no-photos { font-size: 12px; color: var(--ink-dim); }
  .note-text, .proposal-text { font-size: 13px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px; white-space: pre-wrap; }
  .no-action { color: var(--ink-dim); font-style: italic; }
  .hypothesis { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; margin-bottom: 6px; font-size: 13px; background: var(--bg); }
  .hyp-desc { color: var(--ink-dim); font-size: 12px; margin-top: 2px; margin-left: 20px; }
  .edit-row { display: grid; gap: 8px; margin-bottom: 10px; }
  .edit-row input, .edit-row textarea { width: 100%; font-family: inherit; font-size: 13px; padding: 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--ink); }
  .controls { display: flex; gap: 8px; }
  .btn { border: 1px solid var(--border); background: var(--bg); color: var(--ink); border-radius: 6px; padding: 6px 14px; font-size: 13px; cursor: pointer; }
  .btn.accept:hover { border-color: var(--ok); color: var(--ok); }
  .btn.reject:hover { border-color: var(--warn); color: var(--warn); }
  .btn.edit:hover { border-color: var(--accent); color: var(--accent); }
  #toolbar { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--border); padding: 12px 20px; display:flex; justify-content: space-between; align-items:center; z-index: 10; }
  #toolbar .stats { font-size: 12px; color: var(--ink-dim); }
  #export-btn { background: var(--accent); color: #fff; border: none; border-radius: 6px; padding: 8px 16px; font-size: 13px; cursor: pointer; }
</style>
<div id="toolbar">
  <div class="stats" id="stats">0 reviewed / ${totalPairs} total</div>
  <button id="export-btn">Export decisions JSON</button>
</div>
<div class="wrap">
  <h1>Azolla Experience Backfill Review</h1>
  <p class="subtitle">${totalPairs} state pairs across ${containers.size} containers. Decisions saved to localStorage as you go — reload-safe. Click "Export decisions JSON" when done with a pass; feed the downloaded file to azolla-experience-commit.js.</p>
  ${sectionsHtml}
</div>
<script>
  const STORAGE_KEY = 'azolla_backfill_decisions_v1';
  function loadDecisions() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveDecisions(d) { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); }
  let decisions = loadDecisions();

  function updateStats() {
    const total = document.querySelectorAll('.pair').length;
    const reviewed = Object.keys(decisions).length;
    document.getElementById('stats').textContent = reviewed + ' reviewed / ' + total + ' total';
  }

  function applyDecisionToDom(pairEl, pairId) {
    const d = decisions[pairId];
    const badge = pairEl.querySelector('[data-role="badge"]');
    if (!d) { badge.textContent = 'unreviewed'; badge.removeAttribute('data-decision'); return; }
    badge.textContent = d.decision;
    badge.setAttribute('data-decision', d.decision);
    if (d.decision === 'edited') {
      pairEl.querySelector('[data-role="edit-row"]').style.display = 'grid';
      pairEl.querySelector('[data-role="edit-title"]').value = d.title || '';
      pairEl.querySelector('[data-role="edit-desc"]').value = d.description || '';
    }
    if (d.selectedHypIdx != null) {
      const radio = pairEl.querySelector('[data-role="hyp-radio"][value="' + d.selectedHypIdx + '"]');
      if (radio) radio.checked = true;
    }
  }

  document.querySelectorAll('.pair').forEach((pairEl) => {
    const pairId = pairEl.dataset.pairId;
    applyDecisionToDom(pairEl, pairId);

    pairEl.querySelector('[data-role="accept"]').addEventListener('click', () => {
      const checked = pairEl.querySelector('[data-role="hyp-radio"]:checked');
      decisions[pairId] = { decision: 'accepted', selectedHypIdx: checked ? Number(checked.value) : null };
      saveDecisions(decisions);
      applyDecisionToDom(pairEl, pairId);
      updateStats();
    });

    pairEl.querySelector('[data-role="reject"]').addEventListener('click', () => {
      decisions[pairId] = { decision: 'rejected' };
      saveDecisions(decisions);
      applyDecisionToDom(pairEl, pairId);
      updateStats();
    });

    pairEl.querySelector('[data-role="edit"]').addEventListener('click', () => {
      const editRow = pairEl.querySelector('[data-role="edit-row"]');
      editRow.style.display = editRow.style.display === 'none' ? 'grid' : 'none';
    });

    const commitEdit = () => {
      const title = pairEl.querySelector('[data-role="edit-title"]').value;
      const description = pairEl.querySelector('[data-role="edit-desc"]').value;
      if (!title.trim()) return;
      decisions[pairId] = { decision: 'edited', title, description };
      saveDecisions(decisions);
      applyDecisionToDom(pairEl, pairId);
      updateStats();
    };
    pairEl.querySelector('[data-role="edit-title"]').addEventListener('blur', commitEdit);
    pairEl.querySelector('[data-role="edit-desc"]').addEventListener('blur', commitEdit);
  });

  document.getElementById('export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(decisions, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'azolla-backfill-decisions.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  updateStats();
</script>
`;

    fs.writeFileSync(OUT_PATH, html);
    console.log(`Written ${html.length} bytes, ${totalPairs} pairs, ${containers.size} containers -> ${OUT_PATH}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
