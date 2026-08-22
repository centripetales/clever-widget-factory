#!/usr/bin/env node

/**
 * Renders the real SASR experiences for a container as an HTML report:
 * initial state -> action(s) -> final state -> reward (coverage % delta,
 * computed on demand from metric_snapshots per docs/specs/azolla-impact-power-model.md
 * §5a — coverage is one metric among potentially several that could feed a
 * reward computation; this report only knows about coverage today).
 *
 * Usage: node scripts/azolla-experience-report.js <tool_id> <output_html>
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

const [TOOL_ID, OUT_PATH] = process.argv.slice(2);
if (!TOOL_ID || !OUT_PATH) {
  console.error('Usage: node scripts/azolla-experience-report.js <tool_id> <output_html>');
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
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function coverageFor(client, stateId) {
  const res = await client.query(`
    SELECT ms.value FROM metric_snapshots ms
    JOIN metrics m ON m.metric_id = ms.metric_id
    WHERE ms.state_id = $1 AND m.tool_id = $2 AND m.name = 'Coverage %'
  `, [stateId, TOOL_ID]);
  return res.rows[0] ? Number(res.rows[0].value) : null;
}

async function main() {
  const client = await pool.connect();
  try {
    const experiences = await client.query(`
      SELECT id, created_at FROM experiences WHERE entity_id = $1 ORDER BY created_at
    `, [TOOL_ID]);

    let rowsHtml = '';
    for (const exp of experiences.rows) {
      const comps = await client.query(`
        SELECT component_type, state_id, action_id FROM experience_components WHERE experience_id = $1
      `, [exp.id]);
      const initialComp = comps.rows.find(c => c.component_type === 'initial_state');
      const finalComp = comps.rows.find(c => c.component_type === 'final_state');
      const actionComps = comps.rows.filter(c => c.component_type === 'action');

      const initialState = await client.query(`SELECT captured_at FROM states WHERE id = $1`, [initialComp.state_id]);
      const finalState = await client.query(`SELECT captured_at FROM states WHERE id = $1`, [finalComp.state_id]);
      const actions = await client.query(`SELECT id, title, description, expected_state, scoring_data FROM actions WHERE id = ANY($1::uuid[])`, [actionComps.map(c => c.action_id)]);

      const initialCoverage = await coverageFor(client, initialComp.state_id);
      const finalCoverage = await coverageFor(client, finalComp.state_id);
      const reward = (initialCoverage != null && finalCoverage != null) ? (finalCoverage - initialCoverage) : null;
      const rewardClass = reward == null ? '' : reward >= 0 ? 'positive' : 'negative';
      const rewardSign = reward != null && reward >= 0 ? '+' : '';

      rowsHtml += `
      <div class="experience">
        <div class="exp-header">
          <span class="exp-dates">${initialState.rows[0].captured_at.toISOString().slice(0, 10)} &rarr; ${finalState.rows[0].captured_at.toISOString().slice(0, 10)}</span>
          <span class="reward-badge ${rewardClass}">${reward != null ? `${rewardSign}${reward.toFixed(1)} pts coverage` : 'reward unknown'}</span>
        </div>
        <div class="coverage-row">
          <div class="coverage-cell">
            <span class="label">Initial coverage (metric)</span>
            <span class="coverage-value">${initialCoverage != null ? initialCoverage.toFixed(1) + '%' : 'unknown'}</span>
          </div>
          <div class="coverage-arrow">&rarr;</div>
          <div class="coverage-cell">
            <span class="label">Final coverage (metric)</span>
            <span class="coverage-value">${finalCoverage != null ? finalCoverage.toFixed(1) + '%' : 'unknown'}</span>
          </div>
        </div>
        <div class="actions-list">
          <span class="label">Action(s)</span>
          ${actions.rows.map(a => {
            const sd = a.scoring_data || {};
            return `
            <div class="action-item">
              <div class="action-title">${esc(a.title)} ${sd.action_type ? `<span class="action-type-tag">${esc(sd.action_type)}</span>` : ''}</div>
              ${sd.what_was_done ? `<div class="action-desc">${esc(sd.what_was_done)}</div>` : ''}
              ${a.expected_state ? `<div class="expected-state">&rarr; ${esc(a.expected_state)}${sd.expected_state_confidence != null ? ` <span class="conf">(confidence ${sd.expected_state_confidence})</span>` : ''}</div>` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }

    const html = `<title>Stefan's SASR Log</title>
<style>
  :root {
    --paper: #F6F7F1; --ink: #1B2118; --ink-dim: #5B6355; --line: #DDE2D3;
    --surface: #ECEEE4; --moss: #4A7C2E; --water: #2C6E76; --clay: #B5502E; --sun: #C98A1F;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --paper: #12160F; --ink: #E8ECE0; --ink-dim: #9AA48C; --line: #2A3122;
      --surface: #1A1F15; --moss: #7FB55A; --water: #5FB0BA; --clay: #E08159; --sun: #E0AF52;
    }
  }
  :root[data-theme="dark"] {
    --paper: #12160F; --ink: #E8ECE0; --ink-dim: #9AA48C; --line: #2A3122;
    --surface: #1A1F15; --moss: #7FB55A; --water: #5FB0BA; --clay: #E08159; --sun: #E0AF52;
  }
  :root[data-theme="light"] {
    --paper: #F6F7F1; --ink: #1B2118; --ink-dim: #5B6355; --line: #DDE2D3;
    --surface: #ECEEE4; --moss: #4A7C2E; --water: #2C6E76; --clay: #B5502E; --sun: #C98A1F;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    color: var(--ink); background: var(--paper); margin: 0;
    font-variant-numeric: tabular-nums;
  }
  .wrap { max-width: 680px; margin: 0 auto; padding: 40px 24px 100px; }
  h1 {
    font-family: Georgia, "Iowan Old Style", "Palatino Linotype", ui-serif, serif;
    font-size: 26px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em;
    text-wrap: balance;
  }
  .subtitle { color: var(--ink-dim); font-size: 13.5px; line-height: 1.5; margin: 0 0 36px; max-width: 60ch; }
  .timeline { display: flex; flex-direction: column; gap: 16px; }
  .experience {
    border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px;
    background: var(--surface);
  }
  .exp-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; gap: 12px; }
  .exp-dates {
    font-family: Georgia, "Iowan Old Style", ui-serif, serif;
    font-weight: 600; font-size: 15px; letter-spacing: -0.005em;
  }
  .reward-badge {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 12.5px; font-weight: 600; padding: 3px 10px; border-radius: 999px;
    background: var(--line); color: var(--ink-dim); white-space: nowrap;
  }
  .reward-badge.positive { background: var(--moss); color: var(--paper); }
  .reward-badge.negative { background: var(--clay); color: var(--paper); }
  .coverage-row { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
  .coverage-cell {
    flex: 1; background: var(--paper); border: 1px solid var(--line); border-radius: 8px;
    padding: 10px 12px; text-align: center;
  }
  .coverage-arrow { font-size: 16px; color: var(--ink-dim); flex-shrink: 0; }
  .coverage-value {
    display: block; font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 19px; font-weight: 600; margin-top: 3px;
  }
  .label {
    font-size: 10px; text-transform: uppercase; letter-spacing: .07em;
    color: var(--ink-dim); font-weight: 650; display: block;
  }
  .actions-list { border-top: 1px solid var(--line); padding-top: 12px; display: flex; flex-direction: column; gap: 10px; }
  .action-item { }
  .action-title { font-weight: 650; font-size: 13.5px; }
  .action-desc { font-size: 12.5px; color: var(--ink-dim); margin-top: 3px; line-height: 1.45; }
  .action-type-tag {
    font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
    padding: 2px 7px; border-radius: 999px; background: var(--water); color: var(--paper);
    margin-left: 6px; vertical-align: middle;
  }
  .expected-state { font-size: 12.5px; color: var(--water); margin-top: 5px; line-height: 1.4; }
  .conf { color: var(--ink-dim); font-weight: 400; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11.5px; }
</style>
<div class="wrap">
  <h1>SASR Experience Log — Stefan's Container</h1>
  <p class="subtitle">${experiences.rows.length} experiences, state &rarr; action &rarr; state &rarr; reward. Reward is the Coverage % metric's delta between initial and final state, computed on demand from <code>metric_snapshots</code> — never stored. Coverage is one metric among potentially several a future reward computation could draw on.</p>
  <div class="timeline">
    ${rowsHtml}
  </div>
</div>
`;

    fs.writeFileSync(OUT_PATH, html);
    console.log(`Written ${experiences.rows.length} experiences to ${OUT_PATH}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
