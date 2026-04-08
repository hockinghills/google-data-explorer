import { getAllCards } from '../fetchers/index.js';
import { formatDate, recencyColor, richnessBars, escapeHtml } from '../helpers/format.js';

export async function explorerPage(url, env) {
  const token = url.searchParams.get('token');
  const ptoken = url.searchParams.get('ptoken');
  if (!token && !ptoken) return new Response('No token', { status: 401 });

  let cards = [];
  if (token) {
    cards = await getAllCards(token);
  }

  return new Response(renderExplorer(cards, token, ptoken), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function renderExplorer(cards, token, ptoken) {
  const esc = escapeHtml;
  const cardHtml = cards.map(card => {
    if (card.error && !card.service) return '';
    const color = recencyColor(card.latest);
    const recency = formatDate(card.latest);
    const p = card.preview || {};
    const id = card.id || card.service.toLowerCase().replace(/[^a-z0-9_]/g, '_');

    if (card.error) {
      return `<div class="card unavailable" data-id="${esc(id)}">
        <div class="card-header">
          <span class="icon">${card.icon || '📊'}</span>
          <span class="service-name">${esc(card.service)}</span>
        </div>
        <div class="card-error">unavailable</div>
      </div>`;
    }

    return `<div class="card" data-id="${esc(id)}">
      <div class="card-header">
        <span class="icon">${card.icon || '📊'}</span>
        <span class="service-name">${esc(card.service)}</span>
        <span class="recency-dot" style="background:${color}" title="${esc(recency)}"></span>
      </div>
      <div class="card-headline">${esc(p.headline || card.total || '')}</div>
      ${p.detail ? `<div class="card-detail">${esc(p.detail)}</div>` : ''}
      ${p.stat ? `<div class="card-stat">${esc(p.stat)}</div>` : ''}
      <div class="card-footer">
        <span class="card-recency">${esc(recency)}</span>
        <span class="card-richness">${richnessBars(card.richness)}</span>
      </div>
      ${card.description ? `<div class="card-desc">${esc(card.description)}</div>` : ''}
      <button class="add-btn" id="btn-${esc(id)}" onclick="addToGraph('${esc(id)}', this)">add to graph</button>
      <div class="card-status" id="status-${esc(id)}"></div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>your data</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0a0a; color: #e0e0e0; min-height: 100vh; padding: 2rem; }
  h1 { font-size: 2rem; margin-bottom: 0.3rem; color: #fff; }
  .subtitle { color: #666; margin-bottom: 2rem; font-size: 0.95rem; max-width: 700px; line-height: 1.5; }

  .graph-viz {
    max-width: 1100px; margin-bottom: 2rem; background: #0d0d12;
    border: 1px solid #1a1a2a; border-radius: 14px; padding: 1.25rem;
    min-height: 80px; display: none;
  }
  .graph-viz.has-data { display: block; }
  .graph-viz-label { font-size: 0.75rem; color: #555; margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .graph-bubbles { display: flex; align-items: flex-end; gap: 1.25rem; flex-wrap: wrap; }
  .graph-bubble { display: flex; flex-direction: column; align-items: center; gap: 0.3rem; transition: all 0.5s ease; }
  .graph-bubble .circle {
    border-radius: 50%; transition: all 0.5s ease;
    display: flex; align-items: center; justify-content: center;
    font-size: 0.7rem; font-weight: 600;
  }
  .graph-bubble .label { font-size: 0.7rem; color: #666; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 1rem; max-width: 1100px; }
  .card {
    background: #111; border: 2px solid #1a1a1a; border-radius: 14px;
    padding: 1.5rem; transition: all 0.3s ease; position: relative; overflow: hidden;
  }
  .card:hover { border-color: #282828; }
  .card.added { border-color: #2d5a2d; }
  .card.unavailable { opacity: 0.3; }
  .card-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
  .icon { font-size: 1.5rem; }
  .service-name { font-weight: 600; font-size: 1.1rem; flex: 1; color: #fff; }
  .recency-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .card-headline { font-size: 1.1rem; color: #ddd; margin-bottom: 0.5rem; line-height: 1.3; }
  .card-detail { font-size: 0.85rem; color: #888; margin-bottom: 0.35rem; line-height: 1.4;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-stat { font-size: 0.8rem; color: #666; margin-bottom: 0.5rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-error { font-size: 0.85rem; color: #555; }
  .card-footer { display: flex; justify-content: space-between; align-items: center;
    margin-top: 0.75rem; padding-top: 0.5rem; border-top: 1px solid #1a1a1a; }
  .card-recency { font-size: 0.8rem; color: #555; }
  .card-richness { display: flex; gap: 3px; }
  .bar { width: 4px; height: 14px; border-radius: 2px; background: #222; }
  .bar.filled { background: #6c5aae; }
  .card-desc { font-size: 0.8rem; color: #444; margin-top: 0.6rem; font-style: italic; line-height: 1.4; }
  .add-btn {
    margin-top: 0.75rem; padding: 0.5rem 1rem; background: #1a1a2e;
    border: 1px solid #333; color: #8b8bce; border-radius: 6px;
    cursor: pointer; font-size: 0.85rem; transition: all 0.2s; width: 100%;
  }
  .add-btn:hover { background: #222244; border-color: #555; color: #aaaaee; }
  .add-btn.running { background: #1a2e1a; border-color: #2d5a2d; color: #88cc88; cursor: wait; }
  .add-btn.done { background: #1a2e1a; border-color: #22c55e; color: #22c55e; cursor: default; }
  .add-btn.error { background: #2e1a1a; border-color: #ef4444; color: #ef4444; }
  .card-status { font-size: 0.75rem; color: #666; margin-top: 0.4rem; min-height: 1em; }

  .takeout-section { max-width: 1100px; margin-top: 2.5rem; padding-top: 2rem; border-top: 1px solid #1a1a1a; }
  .takeout-title { font-size: 1.4rem; color: #fff; margin-bottom: 0.3rem; }
  .takeout-subtitle { font-size: 0.85rem; color: #555; margin-bottom: 1.25rem; }
  .takeout-scan-btn {
    padding: 0.6rem 1.2rem; background: #1a1a2e; border: 1px solid #333;
    color: #8b8bce; border-radius: 8px; cursor: pointer; font-size: 0.9rem; transition: all 0.2s;
  }
  .takeout-scan-btn:hover { background: #222244; border-color: #555; color: #aaaaee; }
  .takeout-scan-btn.running { cursor: wait; color: #88cc88; border-color: #2d5a2d; }
  .takeout-status { font-size: 0.8rem; color: #666; margin-top: 0.6rem; min-height: 1.2em; }
  .takeout-catalog { margin-top: 1rem; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0.75rem; }
  .takeout-cat {
    background: #111; border: 1px solid #1a1a1a; border-radius: 10px;
    padding: 1rem; transition: all 0.2s;
  }
  .takeout-cat:hover { border-color: #282828; }
  .takeout-cat.ready { border-color: #222244; }
  .takeout-cat-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
  .takeout-cat-icon { font-size: 1.2rem; }
  .takeout-cat-label { font-weight: 600; font-size: 0.95rem; flex: 1; color: #ccc; }
  .takeout-cat-badge {
    font-size: 0.7rem; padding: 0.15rem 0.5rem; border-radius: 4px;
    background: #1a2e1a; color: #66bb6a; border: 1px solid #2d5a2d;
  }
  .takeout-cat-badge.not-ready { background: #1a1a1a; color: #555; border-color: #222; }
  .takeout-cat-info { font-size: 0.8rem; color: #666; margin-bottom: 0.6rem; }
  .takeout-cat-files { font-size: 0.75rem; color: #444; max-height: 80px; overflow-y: auto; margin-bottom: 0.5rem; }
  .takeout-cat-file { padding: 0.15rem 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .takeout-ingest-btn {
    width: 100%; padding: 0.4rem; background: #1a1a2e; border: 1px solid #333;
    color: #8b8bce; border-radius: 6px; cursor: pointer; font-size: 0.8rem; transition: all 0.2s;
  }
  .takeout-ingest-btn:hover { background: #222244; border-color: #555; }
  .takeout-ingest-btn:disabled { opacity: 0.3; cursor: default; }
  .takeout-ingest-btn.running { color: #88cc88; border-color: #2d5a2d; cursor: wait; }
  .takeout-ingest-btn.done { color: #22c55e; border-color: #22c55e; }
  .takeout-ingest-btn.error { color: #ef4444; border-color: #ef4444; }
</style></head><body>

<h1>this is yours</h1>
<div class="subtitle">this is what google has been watching. add the parts you want to understand — one at a time. watch the graph grow.</div>

<div class="graph-viz" id="graphViz">
  <div class="graph-viz-label">your graph</div>
  <div class="graph-bubbles" id="graphBubbles"></div>
</div>

${cards.length > 0 ? '<div class="grid">' + cardHtml + '</div>' : ''}

<div class="takeout-section" id="takeoutSection">
  <h2 class="takeout-title">your archive</h2>
  <div class="takeout-subtitle">google takeout data sitting in your drive — scan it, pick what goes into the graph</div>
  <button class="takeout-scan-btn" id="takeoutScanBtn" onclick="scanTakeout()">scan drive for takeout data</button>
  <div class="takeout-status" id="takeoutStatus"></div>
  <div class="takeout-catalog" id="takeoutCatalog"></div>
</div>

<script>
const token = ${JSON.stringify(token || '')};
const ptoken = ${JSON.stringify(ptoken || '')};

const BUBBLE_COLORS = {
  songs: '#8b5cf6', artists: '#a78bfa', activities: '#6366f1',
  topics: '#818cf8', products: '#c084fc', chains: '#7c3aed'
};

function renderGraphViz(data) {
  const viz = document.getElementById('graphViz');
  const container = document.getElementById('graphBubbles');
  const entries = [];
  if (data.songs > 0) entries.push({ label: 'songs', count: data.songs, color: BUBBLE_COLORS.songs });
  if (data.artists > 0) entries.push({ label: 'artists', count: data.artists, color: BUBBLE_COLORS.artists });
  if (data.activities > 0) entries.push({ label: 'activities', count: data.activities, color: BUBBLE_COLORS.activities });
  if (data.topics > 0) entries.push({ label: 'topics', count: data.topics, color: BUBBLE_COLORS.topics });
  if (data.products > 0) entries.push({ label: 'sources', count: data.products, color: BUBBLE_COLORS.products });
  if (data.chains > 0) entries.push({ label: 'chains', count: data.chains, color: BUBBLE_COLORS.chains });
  if (entries.length === 0) { viz.classList.remove('has-data'); return; }
  viz.classList.add('has-data');
  const maxCount = Math.max(...entries.map(e => e.count));
  container.innerHTML = entries.map(e => {
    const size = Math.max(40, Math.min(100, 40 + Math.sqrt(e.count / maxCount) * 60));
    return '<div class="graph-bubble">'
      + '<div class="circle" style="width:'+size+'px;height:'+size+'px;background:'+e.color+'18;border:2px solid '+e.color+'">'
      + '<span style="color:'+e.color+'">'+(e.count > 999 ? (e.count/1000).toFixed(1)+'k' : e.count)+'</span>'
      + '</div><span class="label">'+e.label+'</span></div>';
  }).join('');
}

async function loadGraphStats() {
  try {
    const [g, s] = await Promise.all([
      fetch('/graph/stats?token='+(token||ptoken)).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/ingest/status?token='+(token||ptoken)).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    renderGraphViz({
      songs: s?.songs||0, artists: s?.artists||0,
      activities: g?.activities||0, topics: g?.topics||0,
      products: g?.products||0, chains: g?.chains||0,
    });
  } catch(e) {}
}

async function addToGraph(cardId, btn) {
  if (btn.classList.contains('running') || btn.classList.contains('done')) return;
  btn.classList.add('running');
  btn.textContent = 'adding...';
  const status = document.getElementById('status-' + cardId);

  if (cardId === 'music') {
    status.textContent = 'pulling liked songs from youtube...';
    try {
      const res = await fetch('/ingest/music?token=' + token);
      const data = await res.json();
      if (data.success) {
        btn.classList.remove('running'); btn.classList.add('done');
        btn.textContent = 'added \u2014 ' + data.totalSongs + ' songs';
        btn.closest('.card').classList.add('added');
        status.textContent = data.sampleArtists?.slice(0,5).join(', ');
        loadGraphStats();
      } else {
        btn.classList.remove('running'); btn.classList.add('error');
        btn.textContent = 'error'; status.textContent = data.error || 'unknown';
      }
    } catch(e) {
      btn.classList.remove('running'); btn.classList.add('error');
      btn.textContent = 'error'; status.textContent = e.message;
    }
    return;
  }

  // Other cards need portability auth
  if (!ptoken) {
    btn.classList.remove('running');
    btn.textContent = 'needs deep access';
    status.textContent = 'redirecting to authorize...';
    try { sessionStorage.setItem('pendingAdd', cardId); } catch(e) {}
    setTimeout(() => { window.location.href = '/login/portability'; }, 1500);
    return;
  }

  const resourceMap = {
    youtube: 'myactivity.youtube', gmail: 'myactivity.search',
    calendar: 'myactivity.maps', contacts: 'saved.collections',
    fitness: 'myactivity.play', tasks: 'myactivity.shopping',
    drive: 'chrome.history',
  };
  const resource = resourceMap[cardId];
  if (!resource) {
    btn.classList.remove('running'); btn.classList.add('error');
    btn.textContent = 'not available yet'; return;
  }

  status.textContent = 'requesting archive from google...';
  try {
    const initRes = await fetch('/portability/initiate?ptoken='+encodeURIComponent(ptoken));
    const initData = await initRes.json();
    const job = initData.jobs?.find(j => j.resource === resource);
    if (!job?.jobId) {
      btn.classList.remove('running'); btn.classList.add('error');
      btn.textContent = 'failed'; status.textContent = 'archive unavailable';
      return;
    }
    status.textContent = 'google is preparing your data...';
    pollSingleJob(job, resource, btn, status);
  } catch(e) {
    btn.classList.remove('running'); btn.classList.add('error');
    btn.textContent = 'error'; status.textContent = e.message;
  }
}

async function pollSingleJob(job, resource, btn, status) {
  try {
    const jobsParam = encodeURIComponent(JSON.stringify([job]));
    const res = await fetch('/portability/status?ptoken='+encodeURIComponent(ptoken)+'&jobs='+jobsParam);
    const data = await res.json();
    const s = data.statuses?.[0];
    if (!s) { status.textContent = 'no status'; return; }
    if (s.state === 'COMPLETE') {
      status.textContent = 'ingesting into graph...';
      let ok = false;
      for (const u of (s.urls || [])) {
        const r = await fetch('/portability/process?ptoken='+encodeURIComponent(ptoken)
          +'&resource='+encodeURIComponent(resource)+'&url='+encodeURIComponent(u));
        const d = await r.json();
        if (d.success) ok = true;
      }
      if (ok) {
        btn.classList.remove('running'); btn.classList.add('done');
        btn.textContent = 'added'; btn.closest('.card').classList.add('added');
        status.textContent = 'in your graph'; loadGraphStats();
      } else {
        btn.classList.remove('running'); btn.classList.add('error');
        btn.textContent = 'ingest failed';
      }
    } else if (s.state === 'FAILED' || s.state === 'ERROR') {
      btn.classList.remove('running'); btn.classList.add('error');
      btn.textContent = 'failed'; status.textContent = s.error || s.state.toLowerCase();
    } else {
      status.textContent = s.state.toLowerCase() + '... checking in 15s';
      setTimeout(() => pollSingleJob(job, resource, btn, status), 15000);
    }
  } catch(e) {
    status.textContent = 'retrying...';
    setTimeout(() => pollSingleJob(job, resource, btn, status), 15000);
  }
}

try {
  const pending = sessionStorage.getItem('pendingAdd');
  if (pending && ptoken) {
    sessionStorage.removeItem('pendingAdd');
    const btn = document.getElementById('btn-' + pending);
    if (btn) setTimeout(() => addToGraph(pending, btn), 500);
  }
} catch(e) {}

loadGraphStats();

async function scanTakeout() {
  const btn = document.getElementById('takeoutScanBtn');
  const status = document.getElementById('takeoutStatus');
  const catalog = document.getElementById('takeoutCatalog');
  if (btn.classList.contains('running')) return;
  btn.classList.add('running');
  btn.textContent = 'scanning drive...';
  status.textContent = '';
  catalog.innerHTML = '';

  try {
    const res = await fetch('/takeout/discover?token=' + encodeURIComponent(token));
    const data = await res.json();
    if (data.error) { status.textContent = data.error; btn.classList.remove('running'); btn.textContent = 'scan again'; return; }

    btn.classList.remove('running');
    btn.textContent = 'scan again';
    status.textContent = data.totalFiles + ' files found \\u00b7 ' + data.totalSizeMB + ' MB total';

    const summary = data.summary || {};
    const cats = data.catalog || {};
    const keys = Object.keys(summary).sort(function(a, b) {
      if (summary[a].graphReady && !summary[b].graphReady) return -1;
      if (!summary[a].graphReady && summary[b].graphReady) return 1;
      return summary[b].fileCount - summary[a].fileCount;
    });

    catalog.innerHTML = keys.map(function(key) {
      var s = summary[key];
      var c = cats[key];
      var files = (c && c.files || []).slice(0, 5);
      var badge = s.graphReady
        ? '<span class="takeout-cat-badge">graph ready</span>'
        : '<span class="takeout-cat-badge not-ready">coming soon</span>';
      var fileList = files.map(function(f) {
        return '<div class="takeout-cat-file" title="' + f.name + '">' + f.name + ' (' + f.sizeMB + ' MB)</div>';
      }).join('') + (s.fileCount > 5 ? '<div class="takeout-cat-file">... +' + (s.fileCount - 5) + ' more</div>' : '');
      var ingestBtn = s.graphReady && key !== 'archive'
        ? '<button class="takeout-ingest-btn" onclick="ingestCategory(\\'' + key + '\\', this)">add to graph</button>'
        : '<button class="takeout-ingest-btn" disabled>not yet available</button>';
      return '<div class="takeout-cat' + (s.graphReady ? ' ready' : '') + '" data-cat="' + key + '">'
        + '<div class="takeout-cat-header">'
        + '<span class="takeout-cat-icon">' + s.icon + '</span>'
        + '<span class="takeout-cat-label">' + s.label + '</span>'
        + badge + '</div>'
        + '<div class="takeout-cat-info">' + s.fileCount + ' files \\u00b7 ' + s.totalSizeMB.toFixed(1) + ' MB</div>'
        + '<div class="takeout-cat-files">' + fileList + '</div>'
        + ingestBtn + '</div>';
    }).join('');

    window._takeoutCatalog = cats;
  } catch(e) {
    status.textContent = 'scan failed: ' + e.message;
    btn.classList.remove('running');
    btn.textContent = 'scan again';
  }
}

async function ingestCategory(catKey, btn) {
  if (btn.classList.contains('running') || btn.classList.contains('done')) return;
  var cat = window._takeoutCatalog && window._takeoutCatalog[catKey];
  if (!cat || !cat.files || !cat.files.length) return;
  btn.classList.add('running');
  btn.textContent = 'staging...';

  try {
    var ingested = 0;
    for (var i = 0; i < cat.files.length; i++) {
      var file = cat.files[i];
      btn.textContent = 'staging ' + (i + 1) + '/' + cat.files.length + '...';
      var stageRes = await fetch('/takeout/stage?token=' + encodeURIComponent(token) + '&fileId=' + encodeURIComponent(file.id));
      var stageData = await stageRes.json();
      if (!stageData.success) { btn.textContent = 'stage failed'; btn.classList.add('error'); return; }

      btn.textContent = 'processing ' + (i + 1) + '/' + cat.files.length + '...';
      var processRes = await fetch('/takeout/process?token=' + encodeURIComponent(token) + '&key=' + encodeURIComponent(stageData.key));
      var processData = await processRes.json();
      if (processData.success) ingested++;
    }

    btn.classList.remove('running');
    if (ingested > 0) {
      btn.classList.add('done');
      btn.textContent = 'added \\u2014 ' + ingested + ' files processed';
      loadGraphStats();
    } else {
      btn.classList.add('error');
      btn.textContent = 'no data found';
    }
  } catch(e) {
    btn.classList.remove('running');
    btn.classList.add('error');
    btn.textContent = 'error: ' + e.message;
  }
}
</script></body></html>`;

}
