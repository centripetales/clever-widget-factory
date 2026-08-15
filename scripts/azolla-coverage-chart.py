#!/usr/bin/env python3
"""
Builds the interactive azolla coverage-over-time chart artifact from
coverage_points_by_day.json (see azolla-coverage-fetch-data.js, which
produces that file plus downloads thumbnails into thumbs/).

Each point is one (container, calendar day). Hovering shows every photo
taken that day for that container, each with its own AI-estimated coverage
%, plus the real human-written note from that day's observation (if any) —
never AI-generated text, only what the person actually typed.

Usage: python3 scripts/azolla-coverage-chart.py <scratch_dir> <output_html>
  scratch_dir must contain coverage_points_by_day.json and a thumbs/ dir
  (see azolla-coverage-fetch-data.js for how to produce both).
"""
import json
import base64
import re
import sys
import os
import html
import hashlib
import io
from datetime import datetime, timedelta
from PIL import Image, ImageOps

if len(sys.argv) != 3:
    print("Usage: python3 azolla-coverage-chart.py <scratch_dir> <output_html>")
    sys.exit(1)

SCRATCH_DIR = sys.argv[1]
OUT_PATH = sys.argv[2]
THUMB_DIR = os.path.join(SCRATCH_DIR, 'thumbs')
BASE_URL = "https://stargazer-farm.com"

with open(os.path.join(SCRATCH_DIR, 'coverage_points_by_day.json')) as f:
    points = json.load(f)


def url_hash(url):
    # Stable across processes/languages, unlike Python's built-in hash()
    # which is randomized per-process by default — must match the hashing
    # in azolla-coverage-fetch-data.js exactly.
    return hashlib.md5(url.encode('utf-8')).hexdigest()


def raw_path(url):
    # azolla-coverage-fetch-data.js downloads originals here, unmodified —
    # this script owns downscaling so there's one place that decides the
    # embedded size, not two scripts guessing at each other's output.
    return os.path.join(THUMB_DIR, f"{url_hash(url)}.jpg")


def data_uri_for(url):
    path = raw_path(url)
    if not os.path.exists(path):
        return ''
    with open(path, 'rb') as imgf:
        img = Image.open(io.BytesIO(imgf.read()))
    # PIL reads raw pixel data regardless of the EXIF Orientation tag —
    # phones often store landscape-sensor pixels with a "rotate on display"
    # tag rather than physically rotating them, so without this call photos
    # show up sideways/upside-down here even though most phone galleries
    # and modern browsers render the same file upright.
    img = ImageOps.exif_transpose(img).convert('RGB')
    img.thumbnail((320, 320))
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=55)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')


for p in points:
    p['dt'] = datetime.fromisoformat(p['date'])
    p['name'] = p['container_name'].replace("'S", "'s")
    images = []
    for img in p['images']:
        images.append({
            'src': data_uri_for(img['url']),
            'notes': img['notes'] or '',
            'coverage': round(img['photo_coverage']) if img.get('photo_coverage') is not None else None,
            'edit_url': f"{BASE_URL}/observations/edit/{img['state_id']}",
            'time': img.get('time'),
            'time_source': img.get('time_source'),
        })
    p['images'] = images
    p['asset_url'] = f"{BASE_URL}/combined-assets/{p['tool_id']}"

containers = {}
for p in points:
    containers.setdefault(p['name'], []).append(p)
for name in containers:
    containers[name].sort(key=lambda p: p['dt'])

# Drop anyone with only a single total observation.
excluded = []
for name in list(containers.keys()):
    total_observations = sum(p['num_states'] for p in containers[name])
    if total_observations <= 1:
        excluded.append((name, total_observations))
        del containers[name]
if excluded:
    print("excluded (<=1 observation):", excluded)

points = [p for pts in containers.values() for p in pts]
all_dates = [p['dt'] for p in points]
min_date, max_date = min(all_dates), max(all_dates)
date_span = (max_date - min_date).total_seconds() or 1

W, H = 1000, 560
PAD_L, PAD_R, PAD_T, PAD_B = 60, 30, 30, 60
plot_w = W - PAD_L - PAD_R
plot_h = H - PAD_T - PAD_B


def x_pos(dt):
    return PAD_L + (dt - min_date).total_seconds() / date_span * plot_w


def y_pos(val):
    return PAD_T + (1 - val / 100) * plot_h


palette = ["#2563eb", "#ea580c", "#16a34a", "#dc2626", "#7c3aed", "#0891b2", "#ca8a04", "#db2777", "#4d7c0f", "#0f766e"]
COLORS = {name: palette[i % len(palette)] for i, name in enumerate(sorted(containers.keys()))}

svg_parts = []
svg_parts.append(f'<line x1="{PAD_L}" y1="{PAD_T}" x2="{PAD_L}" y2="{H-PAD_B}" class="axis-line" />')
svg_parts.append(f'<line x1="{PAD_L}" y1="{H-PAD_B}" x2="{W-PAD_R}" y2="{H-PAD_B}" class="axis-line" />')

for pct in [0, 20, 40, 60, 80, 100]:
    y = y_pos(pct)
    svg_parts.append(f'<line x1="{PAD_L}" y1="{y:.1f}" x2="{W-PAD_R}" y2="{y:.1f}" class="grid-line" />')
    svg_parts.append(f'<text x="{PAD_L-10}" y="{y+4:.1f}" class="axis-label" text-anchor="end">{pct}%</text>')

n_ticks = 8
for i in range(n_ticks + 1):
    frac = i / n_ticks
    dt = min_date + timedelta(seconds=date_span * frac)
    x = x_pos(dt)
    svg_parts.append(f'<text x="{x:.1f}" y="{H-PAD_B+22}" class="axis-label" text-anchor="middle">{dt.strftime("%b %d")}</text>')

def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


def marker_svg(marker, x, y, color, common_attrs):
    # Action/destructive shape classification removed for now — the keyword
    # heuristic (see classifyMarker in azolla-coverage-fetch-data.js) had
    # real false positives (e.g. "cover for pest" flagged as destructive)
    # and doing it well needs more than word matching. Every point is a
    # plain dot until that's revisited properly.
    return f'<circle cx="{x:.1f}" cy="{y:.1f}" r="6" fill="{color}" stroke="white" stroke-width="1.5" {common_attrs} />'


for name, pts in containers.items():
    color = COLORS[name]
    # Plotted value is each day's max coverage estimate, not the mean — see
    # azolla-coverage-fetch-data.js for why. Mean is still carried through
    # as data-mean for the tooltip, just not what's plotted.
    path_d = " ".join(f"{'M' if i==0 else 'L'}{x_pos(p['dt']):.1f},{y_pos(p['max_value']):.1f}" for i, p in enumerate(pts))
    svg_parts.append(f'<g class="series" data-series="{slug(name)}">')
    svg_parts.append(f'<path d="{path_d}" fill="none" stroke="{color}" stroke-width="2.5" opacity="0.85" />')
    for p in pts:
        x, y = x_pos(p['dt']), y_pos(p['max_value'])
        date_str = p['dt'].strftime('%b %d, %Y')
        common_attrs = (
            f'class="pt" data-name="{html.escape(name)}" data-date="{date_str}" data-value="{p["max_value"]:.0f}" '
            f'data-mean="{p["avg_value"]:.0f}" '
            f'data-asset="{p["asset_url"]}" data-images=\'{html.escape(json.dumps(p["images"]))}\''
        )
        svg_parts.append(marker_svg('normal', x, y, color, common_attrs))
    svg_parts.append('</g>')

svg_content = "\n".join(svg_parts)

legend_items = ""
for name in sorted(containers.keys()):
    color = COLORS[name]
    legend_items += f'''
    <button type="button" class="legend-item" data-series="{slug(name)}" aria-pressed="true">
      <span class="legend-swatch" style="background:{color}"></span>
      <span>{html.escape(name)}</span>
    </button>'''

html_out = f'''<title>Azolla Coverage % Over Time</title>
<style>
  :root {{
    --bg: #ffffff; --ink: #1a2332; --ink-dim: #64748b; --border: #e2e8f0; --surface: #f8fafc; --accent: #2563eb;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg: #0f172a; --ink: #e2e8f0; --ink-dim: #94a3b8; --border: #1e293b; --surface: #1e293b; }}
  }}
  :root[data-theme="dark"] {{ --bg: #0f172a; --ink: #e2e8f0; --ink-dim: #94a3b8; --border: #1e293b; --surface: #1e293b; }}
  :root[data-theme="light"] {{ --bg: #ffffff; --ink: #1a2332; --ink-dim: #64748b; --border: #e2e8f0; --surface: #f8fafc; }}

  * {{ box-sizing: border-box; }}
  body, .wrap {{ font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }}
  .wrap {{ max-width: 1080px; margin: 0 auto; padding: 32px 20px; color: var(--ink); }}
  h1 {{ font-size: 22px; font-weight: 650; margin: 0 0 4px; text-wrap: balance; }}
  .subtitle {{ color: var(--ink-dim); font-size: 14px; margin: 0 0 24px; }}
  .chart-container {{ overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; padding: 16px; background: var(--surface); }}
  svg {{ display: block; min-width: 720px; width: 100%; height: auto; }}
  .axis-line {{ stroke: var(--ink-dim); stroke-width: 1; }}
  .grid-line {{ stroke: var(--border); stroke-width: 1; }}
  .axis-label {{ font-size: 11px; fill: var(--ink-dim); font-variant-numeric: tabular-nums; }}
  .pt {{ cursor: pointer; transition: r 0.1s; }}
  .pt:hover {{ r: 8.5; }}
  .legend {{ display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }}
  .legend-item {{
    display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink);
    background: none; border: 1px solid transparent; border-radius: 8px; padding: 4px 8px;
    cursor: pointer; font-family: inherit; transition: opacity 0.15s, border-color 0.15s;
  }}
  .legend-item:hover {{ border-color: var(--border); }}
  .legend-item[aria-pressed="false"] {{ opacity: 0.4; }}
  .legend-item[aria-pressed="false"] .legend-swatch {{ background: var(--ink-dim) !important; }}
  .series {{ transition: opacity 0.15s; }}
  .series.series-hidden {{ display: none; }}
  .legend-swatch {{ width: 12px; height: 12px; border-radius: 3px; display: inline-block; }}
  .hint {{ color: var(--ink-dim); font-size: 12px; margin-top: 10px; }}

  #tooltip {{
    position: fixed; display: none; background: var(--bg); border: 1px solid var(--border);
    border-radius: 14px; padding: 18px; box-shadow: 0 16px 48px rgba(0,0,0,0.22);
    font-size: 14px; z-index: 100; width: 480px; max-height: 82vh; overflow-y: auto; pointer-events: auto;
  }}
  #tooltip .tt-header {{ padding: 0 2px 12px; }}
  #tooltip .tt-title {{ font-weight: 700; font-size: 16px; }}
  #tooltip .tt-meta {{ color: var(--ink-dim); font-variant-numeric: tabular-nums; font-size: 13px; margin-top: 3px; }}
  #tooltip .tt-shot {{ border-top: 1px solid var(--border); padding-top: 14px; margin-top: 14px; }}
  #tooltip .tt-shot:first-of-type {{ border-top: none; margin-top: 0; padding-top: 0; }}
  #tooltip .tt-shot img {{ width: 100%; height: 260px; object-fit: cover; border-radius: 10px; display: block; background: var(--border); }}
  #tooltip .tt-shot-time {{ font-size: 12px; color: var(--ink-dim); margin-top: 6px; font-variant-numeric: tabular-nums; }}
  #tooltip .tt-shot-notes {{
    font-size: 13px; line-height: 1.5; color: var(--ink); margin-top: 8px; white-space: pre-wrap;
    background: var(--surface); border-radius: 8px; padding: 8px 10px;
  }}
  #tooltip .tt-shot-notes-label {{ font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-dim); font-weight: 650; display: block; margin-bottom: 3px; }}
  #tooltip .tt-links {{ display: flex; gap: 14px; padding-top: 12px; margin-top: 12px; border-top: 1px solid var(--border); }}
  #tooltip a {{ color: var(--accent); text-decoration: none; font-size: 13px; font-weight: 600; }}
  #tooltip a:hover {{ text-decoration: underline; }}
</style>

<div class="wrap">
  <h1>Azolla / Duckweed Coverage % Over Time</h1>
  <p class="subtitle">{len(points)} daily points across {len(containers)} registered containers. Plotted value is each day's max coverage estimate (lower photos are often honest documentation of a sparser spot, not a real drop) — hover a point for the mean, every photo, and notes.</p>

  <div class="chart-container">
    <svg viewBox="0 0 {W} {H}" role="img" aria-label="Coverage percent over time, one line per container">
      {svg_content}
    </svg>
  </div>

  <div class="legend">
    {legend_items}
  </div>
  <p class="hint">
    Points are grouped by when the photo was actually taken (EXIF), not when it was successfully submitted — a delayed or retried upload counts toward the real day, not the day it finally went through. Falls back to submission time when a photo has no usable EXIF.
    Hover a point to see every photo taken that day plus any note the person wrote (never AI-generated text). Click a name above to hide/show that line — useful for pulling apart overlapping points.
    Edit links need you logged into the app in that container's organization.
  </p>
</div>

<div id="tooltip">
  <div class="tt-header">
    <div class="tt-title" id="tt-name"></div>
    <div class="tt-meta" id="tt-meta"></div>
  </div>
  <div id="tt-shots"></div>
  <div class="tt-links">
    <a id="tt-asset" href="#" target="_blank" rel="noopener">View asset &rarr;</a>
  </div>
</div>

<script>
  const tooltip = document.getElementById('tooltip');
  const ttName = document.getElementById('tt-name');
  const ttMeta = document.getElementById('tt-meta');
  const ttShots = document.getElementById('tt-shots');
  const ttAsset = document.getElementById('tt-asset');

  function esc(s) {{
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }}

  let hideTimer = null;
  function cancelHide() {{ if (hideTimer) {{ clearTimeout(hideTimer); hideTimer = null; }} }}
  function scheduleHide(delay) {{ cancelHide(); hideTimer = setTimeout(() => {{ tooltip.style.display = 'none'; }}, delay); }}

  function positionTooltip(clientX, clientY) {{
    const margin = 16;
    const ttWidth = 480, ttHeight = Math.min(tooltip.scrollHeight || 400, window.innerHeight * 0.82);
    let left = clientX + margin;
    let top = clientY + margin;
    if (left + ttWidth > window.innerWidth) left = clientX - ttWidth - margin;
    if (top + ttHeight > window.innerHeight) top = Math.max(8, window.innerHeight - ttHeight - margin);
    tooltip.style.left = Math.max(8, left) + 'px';
    tooltip.style.top = Math.max(8, top) + 'px';
  }}

  function renderShots(images) {{
    return images.map(img => `
      <div class="tt-shot">
        <img src="${{img.src}}" alt="" />
        <div class="tt-shot-time">${{img.time ? img.time + (img.time_source === 'photo' ? ' (from photo EXIF)' : img.time_source === 'file' ? ' (from photo file)' : ' (submitted \\u2014 no reliable photo timestamp)') : ''}}${{img.coverage !== null ? ' \\u00b7 ' + img.coverage + '% in this photo' : ''}} &middot; <a href="${{img.edit_url}}" target="_blank" rel="noopener">edit &rarr;</a></div>
        ${{img.notes ? `<div class="tt-shot-notes"><span class="tt-shot-notes-label">Their note</span>${{esc(img.notes)}}</div>` : ''}}
      </div>
    `).join('');
  }}

  document.querySelectorAll('.pt').forEach(pt => {{
    pt.addEventListener('mouseenter', (e) => {{
      cancelHide();
      const images = JSON.parse(pt.dataset.images);
      ttName.textContent = pt.dataset.name;
      ttMeta.textContent = pt.dataset.date + ' \\u2014 ' + pt.dataset.value + '% max (' + pt.dataset.mean + '% mean) \\u2014 ' + images.length + ' photo' + (images.length === 1 ? '' : 's');
      ttShots.innerHTML = renderShots(images);
      ttAsset.href = pt.dataset.asset;
      tooltip.style.display = 'block';
      positionTooltip(e.clientX, e.clientY);
    }});
    pt.addEventListener('mouseleave', () => {{ scheduleHide(250); }});
  }});

  tooltip.addEventListener('mouseenter', cancelHide);
  tooltip.addEventListener('mouseleave', () => scheduleHide(150));

  // Click a legend entry to hide/show that person's line and points —
  // useful for pulling apart overlapping points on crowded days.
  document.querySelectorAll('.legend-item').forEach(btn => {{
    btn.addEventListener('click', () => {{
      const series = document.querySelector(`.series[data-series="${{btn.dataset.series}}"]`);
      const nowVisible = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', String(nowVisible));
      if (series) series.classList.toggle('series-hidden', !nowVisible);
    }});
  }});
</script>
'''

with open(OUT_PATH, 'w') as f:
    f.write(html_out)

print(f"written {len(html_out)} bytes, {len(points)} points, {sum(len(p['images']) for p in points)} images")
