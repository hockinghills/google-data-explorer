import { jsonResponse } from '../helpers/response.js';

export function vizPage(url) {
  const token = url.searchParams.get('token') || '';
  if (!token) return new Response('No token', { status: 401 });

  return new Response(renderViz(token), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

function renderViz(token) {
  return `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>your mind</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #000; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  #graph { width: 100vw; height: 100vh; }
  #loading {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    background: #000; z-index: 100; transition: opacity 1.5s ease;
  }
  #loading.done { opacity: 0; pointer-events: none; }
  #loading .pulse {
    width: 60px; height: 60px; border-radius: 50%;
    background: radial-gradient(circle, #6c5aae 0%, transparent 70%);
    animation: breathe 2s ease-in-out infinite;
  }
  @keyframes breathe {
    0%, 100% { transform: scale(1); opacity: 0.4; }
    50% { transform: scale(1.8); opacity: 0.8; }
  }
  #loading .status {
    margin-top: 2rem; color: #444; font-size: 0.85rem;
    letter-spacing: 0.05em; text-align: center; max-width: 300px;
  }
  #info {
    position: fixed; bottom: 1.5rem; left: 1.5rem;
    color: #333; font-size: 0.75rem; z-index: 10;
    transition: color 0.3s;
  }
  #info.loaded { color: #555; }
  #tooltip {
    position: fixed; padding: 0.6rem 0.9rem;
    background: rgba(10, 10, 20, 0.9); border: 1px solid #222;
    border-radius: 8px; color: #ddd; font-size: 0.8rem;
    pointer-events: none; z-index: 50; display: none;
    max-width: 320px; line-height: 1.4; backdrop-filter: blur(8px);
  }
  #tooltip .title { font-weight: 600; color: #fff; margin-bottom: 0.2rem; }
  #tooltip .meta { color: #666; font-size: 0.7rem; }
  #controls {
    position: fixed; top: 1.5rem; right: 1.5rem; z-index: 10;
    display: flex; gap: 0.5rem; opacity: 0; transition: opacity 1s ease;
  }
  #controls.visible { opacity: 1; }
  #controls button {
    padding: 0.4rem 0.8rem; background: rgba(20, 20, 40, 0.8);
    border: 1px solid #222; color: #666; border-radius: 6px;
    cursor: pointer; font-size: 0.75rem; transition: all 0.2s;
    backdrop-filter: blur(8px);
  }
  #controls button:hover { border-color: #444; color: #aaa; }
  #controls button.active { border-color: #6c5aae; color: #8b8bce; }
</style>
</head><body>

<div id="loading">
  <div class="pulse"></div>
  <div class="status" id="loadStatus">connecting</div>
</div>

<div id="graph"></div>

<div id="tooltip">
  <div class="title" id="tipTitle"></div>
  <div class="meta" id="tipMeta"></div>
</div>

<div id="info">
  <span id="nodeCount">0</span> nodes · <span id="linkCount">0</span> connections
</div>

<div id="controls">
  <button onclick="toggleLinks('then')" id="btn-then" class="active">chains</button>
  <button onclick="toggleLinks('about')" id="btn-about" class="active">topics</button>
  <button onclick="resetCamera()">reset view</button>
</div>

<script src="https://unpkg.com/three@0.160.0/build/three.min.js"></script>
<script src="https://unpkg.com/three@0.160.0/examples/js/renderers/CSS2DRenderer.js"></script>
<script src="https://unpkg.com/3d-force-graph@1.73.3/dist/3d-force-graph.min.js"></script>

<script>
const token = ${JSON.stringify(token)};
const status = document.getElementById('loadStatus');
const tooltip = document.getElementById('tooltip');
const tipTitle = document.getElementById('tipTitle');
const tipMeta = document.getElementById('tipMeta');

let graphData = { nodes: [], links: [] };
let graph;
let visibleLinkTypes = { then: true, about: true };

function toggleLinks(type) {
  visibleLinkTypes[type] = !visibleLinkTypes[type];
  document.getElementById('btn-' + type).classList.toggle('active');
  graph.graphData({
    nodes: graphData.nodes,
    links: graphData.links.filter(l => visibleLinkTypes[l.type])
  });
}

function resetCamera() {
  graph.cameraPosition({ x: 0, y: 0, z: 600 }, { x: 0, y: 0, z: 0 }, 1500);
}

async function boot() {
  // Step 1: Try to load existing graph data
  status.textContent = 'checking for existing data';
  let data;
  try {
    const res = await fetch('/graph/export?token=' + encodeURIComponent(token));
    data = await res.json();
  } catch (e) {
    status.textContent = 'graph connection failed';
    return;
  }

  // Step 2: If graph is empty, ingest from live APIs
  if (!data.nodes || data.nodes.length === 0) {
    status.textContent = 'pulling your data from google';
    try {
      const ingestRes = await fetch('/ingest/live?token=' + encodeURIComponent(token));
      const ingestData = await ingestRes.json();
      status.textContent = ingestData.total + ' activities ingested — loading graph';

      // Re-fetch the graph
      const res2 = await fetch('/graph/export?token=' + encodeURIComponent(token));
      data = await res2.json();
    } catch (e) {
      status.textContent = 'ingest failed — ' + e.message;
      return;
    }
  }

  if (!data.nodes || data.nodes.length === 0) {
    status.textContent = 'no data found';
    return;
  }

  graphData = data;
  status.textContent = data.meta.nodeCount + ' nodes — rendering';

  // Step 3: Render
  initGraph(data);
}

function initGraph(data) {
  const container = document.getElementById('graph');

  graph = ForceGraph3D()(container)
    .graphData({
      nodes: data.nodes,
      links: data.links.filter(l => visibleLinkTypes[l.type])
    })
    .backgroundColor('#000000')
    .showNavInfo(false)

    // Node appearance
    .nodeVal(n => {
      if (n.type === 'topic') return n.size || 3;
      if (n.type === 'product') return n.size || 5;
      return 1.5;
    })
    .nodeColor(n => n.color || '#8b8bce')
    .nodeOpacity(0.9)
    .nodeResolution(16)

    // Link appearance
    .linkColor(l => {
      if (l.type === 'then') {
        if (l.semanticDistance != null) {
          // Color by semantic distance — blue (close) to magenta (far)
          const d = Math.min(l.semanticDistance / 1.5, 1);
          const r = Math.round(100 + d * 155);
          const b = Math.round(200 - d * 50);
          return 'rgba(' + r + ',80,' + b + ',0.15)';
        }
        return 'rgba(108,90,174,0.08)';
      }
      if (l.type === 'about') return 'rgba(255,255,255,0.04)';
      return 'rgba(100,100,100,0.05)';
    })
    .linkWidth(l => l.type === 'then' ? 0.5 : 0.2)
    .linkDirectionalParticles(l => l.type === 'then' && l.semanticDistance > 0.8 ? 2 : 0)
    .linkDirectionalParticleWidth(1)
    .linkDirectionalParticleSpeed(0.005)
    .linkDirectionalParticleColor(() => 'rgba(200,150,255,0.6)')

    // Forces
    .d3AlphaDecay(0.02)
    .d3VelocityDecay(0.3)

    // Interaction
    .onNodeHover(node => {
      container.style.cursor = node ? 'pointer' : 'default';
      if (node) {
        tipTitle.textContent = node.title || '';
        const parts = [];
        if (node.product) parts.push(node.product);
        if (node.day) parts.push(node.day);
        if (node.hour != null) parts.push(node.hour + ':00');
        if (node.type === 'topic') parts.push(node.weight + ' connections');
        if (node.type === 'product') parts.push(node.weight + ' activities');
        tipMeta.textContent = parts.join(' · ');
        tooltip.style.display = 'block';
      } else {
        tooltip.style.display = 'none';
      }
    })
    .onNodeClick(node => {
      // Fly to node
      const distance = 120;
      const pos = node;
      graph.cameraPosition(
        { x: pos.x + distance, y: pos.y + distance / 2, z: pos.z + distance },
        pos,
        1500
      );
    });

  // Track mouse for tooltip
  container.addEventListener('mousemove', e => {
    tooltip.style.left = (e.clientX + 15) + 'px';
    tooltip.style.top = (e.clientY + 15) + 'px';
  });

  // Custom force to cluster by product
  graph.d3Force('charge').strength(-30);
  graph.d3Force('link').distance(l => {
    if (l.type === 'then') return 20 + (l.semanticDistance || 0.5) * 80;
    if (l.type === 'about') return 40;
    return 60;
  });

  // Update counts
  document.getElementById('nodeCount').textContent = data.nodes.length;
  document.getElementById('linkCount').textContent = data.links.length;

  // Post-processing: add bloom-like glow via Three.js
  const renderer = graph.renderer();
  const scene = graph.scene();

  // Add ambient light for depth
  scene.add(new THREE.AmbientLight(0x222233));

  // Add subtle fog for depth
  scene.fog = new THREE.FogExp2(0x000000, 0.0008);

  // Fade in
  setTimeout(() => {
    document.getElementById('loading').classList.add('done');
    document.getElementById('controls').classList.add('visible');
    document.getElementById('info').classList.add('loaded');
  }, 1500);
}

// Responsive
window.addEventListener('resize', () => {
  if (graph) graph.width(window.innerWidth).height(window.innerHeight);
});

boot();
</script>
</body></html>`;
}
