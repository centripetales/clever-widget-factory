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
      const actions = await client.query(`SELECT id, title, description FROM actions WHERE id = ANY($1::uuid[])`, [actionComps.map(c => c.action_id)]);

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
          ${actions.rows.map(a => `
            <div class="action-item">
              <div class="action-title">${esc(a.title)}</div>
              <div class="action-desc">${esc((a.description || '').split('\n\n[action_type:')[0])}</div>
              <div class="action-type-tag">${esc((a.description || '').match(/\[action_type: (\w+)\]/)?.[1] || '')}</div>
            </div>`).join('')}
        </div>
      </div>`;
    }

    const html = `<title>Azolla SASR Experiences — Reward Report</title>
<style>
  :root { --bg:#fff; --ink:#1a2332; --ink-dim:#64748b; --border:#e2e8f0; --surface:#f8fafc; --accent:#2563eb; --pos:#16a34a; --neg:#dc2626; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f172a; --ink:#e2e8f0; --ink-dim:#94a3b8; --border:#1e293b; --surface:#1e293b; } }
  :root[data-theme="dark"] { --bg:#0f172a; --ink:#e2e8f0; --ink-dim:#94a3b8; --border:#1e293b; --surface:#1e293b; }
  :root[data-theme="light"] { --bg:#fff; --ink:#1a2332; --ink-dim:#64748b; --border:#e2e8f0; --surface:#f8fafc; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--bg); margin:0; }
  .wrap { max-width: 640px; margin: 0 auto; padding: 24px 20px 80px; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .subtitle { color: var(--ink-dim); font-size: 13px; margin: 0 0 24px; }
  .experience { border: 1px solid var(--border); border-radius: 10px; padding: 14px; margin-bottom: 14px; background: var(--surface); }
  .exp-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .exp-dates { font-weight: 700; font-size: 13px; }
  .reward-badge { font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 999px; background: var(--border); }
  .reward-badge.positive { background: var(--pos); color: #fff; }
  .reward-badge.negative { background: var(--neg); color: #fff; }
  .coverage-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .coverage-cell { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 10px; text-align: center; }
  .coverage-arrow { font-size: 18px; color: var(--ink-dim); }
  .coverage-value { display: block; font-size: 20px; font-weight: 700; margin-top: 4px; }
  .label { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-dim); font-weight: 650; display: block; }
  .actions-list { border-top: 1px solid var(--border); padding-top: 10px; }
  .action-item { margin-top: 8px; }
  .action-title { font-weight: 700; font-size: 13px; }
  .action-desc { font-size: 12.5px; margin-top: 2px; }
  .action-type-tag { font-size: 10px; color: var(--accent); text-transform: uppercase; letter-spacing: .03em; margin-top: 3px; }
</style>
<div class="wrap">
  <h1>Azolla SASR Experiences — Reward Report</h1>
  <p class="subtitle">${experiences.rows.length} experiences. Reward = Coverage % (a metric) delta between initial and final state, computed on demand — not stored. Coverage is one of potentially several metrics that could feed a reward computation later.</p>
  ${rowsHtml}
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
