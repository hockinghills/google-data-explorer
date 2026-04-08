import { fetchGoogle } from '../helpers/google.js';
import { jsonResponse } from '../helpers/response.js';
import { ingestActivitiesToGraph } from '../graph/ingest.js';
import { unzipSync, Unzip, UnzipInflate } from 'fflate';

// Takeout archive folder patterns in Drive
const TAKEOUT_FOLDER_QUERY = "name contains 'takeout' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
const TAKEOUT_ZIP_QUERY = "name contains 'takeout' and (mimeType = 'application/zip' or mimeType = 'application/x-zip-compressed') and trashed = false";

// Activity files we care about inside the archive — these feed the graph
const ACTIVITY_PATTERNS = [
  /^Takeout\/My Activity\/.*\.json$/i,
  /^Takeout\/Chrome\/BrowsingHistory\.json$/i,
  /^Takeout\/YouTube and YouTube Music\/history\/.*\.json$/i,
  /^Takeout\/YouTube and YouTube Music\/subscriptions\/.*\.json$/i,
  /^Takeout\/Google Fit\/.*\.json$/i,
  /^Takeout\/Maps.*\/.*\.json$/i,
  /^Takeout\/Google Play Store\/.*\.json$/i,
];

function isActivityFile(path) {
  return ACTIVITY_PATTERNS.some(pattern => pattern.test(path));
}

// Derive a resource name from the file path inside the archive
function resourceFromPath(path) {
  if (path.includes('My Activity/YouTube')) return 'myactivity.youtube';
  if (path.includes('My Activity/Search')) return 'myactivity.search';
  if (path.includes('My Activity/Maps')) return 'myactivity.maps';
  if (path.includes('My Activity/Google Play Store')) return 'myactivity.play';
  if (path.includes('My Activity/Shopping')) return 'myactivity.shopping';
  if (path.includes('My Activity/Chrome')) return 'myactivity.chrome';
  if (path.includes('My Activity/Gmail')) return 'myactivity.gmail';
  if (path.includes('My Activity/Google Apps')) return 'myactivity.apps';
  if (path.includes('My Activity/')) return 'myactivity.other';
  if (path.includes('Chrome/BrowsingHistory')) return 'chrome.history';
  if (path.includes('YouTube and YouTube Music/history')) return 'youtube.history';
  if (path.includes('YouTube and YouTube Music/subscriptions')) return 'youtube.subscriptions';
  if (path.includes('Google Fit')) return 'fitness';
  if (path.includes('Maps')) return 'maps';
  if (path.includes('Google Play Store')) return 'play';
  return 'unknown';
}

// Data categories for user-facing selection
const CATEGORIES = {
  activity_youtube:   { label: 'YouTube Activity', icon: '🎬', graphReady: true },
  activity_search:    { label: 'Search Activity', icon: '🔍', graphReady: true },
  activity_maps:      { label: 'Maps Activity', icon: '📍', graphReady: true },
  activity_chrome:    { label: 'Chrome Activity', icon: '🌐', graphReady: true },
  activity_gmail:     { label: 'Gmail Activity', icon: '📧', graphReady: true },
  activity_play:      { label: 'Play Store Activity', icon: '📱', graphReady: true },
  activity_shopping:  { label: 'Shopping Activity', icon: '🛒', graphReady: true },
  activity_other:     { label: 'Other Activity', icon: '📊', graphReady: true },
  chrome_history:     { label: 'Chrome History', icon: '🌐', graphReady: true },
  youtube_history:    { label: 'YouTube Watch History', icon: '▶️', graphReady: true },
  youtube_subs:       { label: 'YouTube Subscriptions', icon: '📺', graphReady: true },
  fitness:            { label: 'Google Fit', icon: '💪', graphReady: true },
  maps_timeline:      { label: 'Maps Timeline', icon: '🗺️', graphReady: true },
  contacts:           { label: 'Contacts', icon: '👥', graphReady: false },
  mail:               { label: 'Gmail Messages', icon: '📧', graphReady: false },
  drive_files:        { label: 'Drive Files', icon: '📁', graphReady: false },
  photos:             { label: 'Photos & Videos', icon: '📷', graphReady: false },
  calendar:           { label: 'Calendar', icon: '📅', graphReady: false },
  tasks:              { label: 'Tasks', icon: '✅', graphReady: false },
  other:              { label: 'Other Data', icon: '📦', graphReady: false },
};

function categorizeFile(name, mimeType) {
  const n = name.toLowerCase();
  const m = (mimeType || '').toLowerCase();

  // Activity JSONs (graph-ready)
  if (n.includes('my activity') && n.includes('youtube')) return 'activity_youtube';
  if (n.includes('my activity') && n.includes('search')) return 'activity_search';
  if (n.includes('my activity') && n.includes('maps')) return 'activity_maps';
  if (n.includes('my activity') && n.includes('chrome')) return 'activity_chrome';
  if (n.includes('my activity') && n.includes('gmail')) return 'activity_gmail';
  if (n.includes('my activity') && n.includes('play')) return 'activity_play';
  if (n.includes('my activity') && n.includes('shopping')) return 'activity_shopping';
  if (n.includes('my activity')) return 'activity_other';
  if (n.includes('browsinghistory')) return 'chrome_history';
  if (n.includes('watch-history') || n.includes('watch history')) return 'youtube_history';
  if (n.includes('subscription')) return 'youtube_subs';
  if (n.includes('fit') || n.includes('fitness')) return 'fitness';
  if (n.includes('timeline') || n.includes('location history') || n.includes('semantic')) return 'maps_timeline';

  // Non-graph-ready (user can opt in later)
  if (n.includes('contact') || n.includes('vcf') || n.includes('vcard')) return 'contacts';
  if (n.includes('mail') && (n.includes('mbox') || m.includes('mbox'))) return 'mail';
  if (m.includes('image') || m.includes('video') || n.includes('photo') || /\.(jpg|jpeg|png|gif|mp4|mov|heic)$/i.test(n)) return 'photos';
  if (n.includes('calendar') || n.includes('ical') || n.includes('.ics')) return 'calendar';
  if (n.includes('task')) return 'tasks';
  if (n.includes('drive')) return 'drive_files';

  // ZIP archives get their own handling
  if (m.includes('zip') || /\.zip$/i.test(n) || /\.tgz$/i.test(n)) return 'archive';

  return 'other';
}

// ---- DISCOVER: Catalog everything in user's Takeout folder ----

export async function discoverTakeout(url, env) {
  const token = url.searchParams.get('token');
  if (!token) return jsonResponse({ error: 'No token' }, 401);

  try {
    // Find Takeout folders
    const folderResults = await fetchGoogle(
      'https://www.googleapis.com/drive/v3/files', token,
      { q: TAKEOUT_FOLDER_QUERY, pageSize: '10', fields: 'files(id,name,createdTime)', orderBy: 'createdTime desc' }
    );
    const folders = folderResults.files || [];

    // Also find top-level Takeout ZIPs (not in a folder)
    const topZips = await fetchGoogle(
      'https://www.googleapis.com/drive/v3/files', token,
      { q: TAKEOUT_ZIP_QUERY, pageSize: '50', fields: 'files(id,name,size,createdTime,mimeType)', orderBy: 'createdTime desc' }
    );

    // Collect all files from Takeout folders
    let allFiles = [];

    for (const folder of folders) {
      let pageToken = null;
      do {
        const params = {
          q: `'${folder.id}' in parents and trashed = false`,
          pageSize: '100',
          fields: 'files(id,name,size,createdTime,mimeType),nextPageToken',
          orderBy: 'name',
        };
        if (pageToken) params.pageToken = pageToken;

        const page = await fetchGoogle(
          'https://www.googleapis.com/drive/v3/files', token, params
        );
        const files = (page.files || []).map(f => ({
          ...f,
          folder: folder.name,
          folderId: folder.id,
        }));
        allFiles = allFiles.concat(files);
        pageToken = page.nextPageToken || null;
      } while (pageToken);
    }

    // Add top-level ZIPs
    for (const zip of (topZips.files || [])) {
      if (!allFiles.find(f => f.id === zip.id)) {
        allFiles.push({ ...zip, folder: 'root' });
      }
    }

    // Categorize everything
    const catalog = {};
    for (const [key, meta] of Object.entries(CATEGORIES)) {
      catalog[key] = { ...meta, files: [], totalSizeMB: 0, fileCount: 0 };
    }
    // Add archive category
    catalog.archive = { label: 'ZIP Archives (activity data inside)', icon: '📦', graphReady: true, files: [], totalSizeMB: 0, fileCount: 0 };

    for (const f of allFiles) {
      const cat = categorizeFile(f.name, f.mimeType);
      const sizeBytes = parseInt(f.size || '0');
      const entry = {
        id: f.id,
        name: f.name,
        sizeMB: (sizeBytes / (1024 * 1024)).toFixed(1),
        created: f.createdTime,
        folder: f.folder,
      };
      if (catalog[cat]) {
        catalog[cat].files.push(entry);
        catalog[cat].totalSizeMB += sizeBytes / (1024 * 1024);
        catalog[cat].fileCount++;
      } else {
        catalog.other.files.push(entry);
        catalog.other.totalSizeMB += sizeBytes / (1024 * 1024);
        catalog.other.fileCount++;
      }
    }

    // Round totals
    for (const cat of Object.values(catalog)) {
      cat.totalSizeMB = parseFloat(cat.totalSizeMB.toFixed(1));
    }

    // Build summary — only include categories that have files
    const summary = {};
    for (const [key, cat] of Object.entries(catalog)) {
      if (cat.fileCount > 0) {
        summary[key] = {
          label: cat.label,
          icon: cat.icon,
          graphReady: cat.graphReady,
          fileCount: cat.fileCount,
          totalSizeMB: cat.totalSizeMB,
        };
      }
    }

    // Check R2 for already-staged files
    let staged = [];
    try {
      const list = await env.ARCHIVES.list({ prefix: 'takeout/' });
      staged = list.objects.map(o => ({
        key: o.key,
        sizeMB: (o.size / (1024 * 1024)).toFixed(1),
        uploaded: o.uploaded,
      }));
    } catch (e) { /* R2 not available */ }

    return jsonResponse({
      summary,
      catalog,
      totalFiles: allFiles.length,
      totalSizeMB: parseFloat(allFiles.reduce((sum, f) => sum + parseInt(f.size || '0'), 0) / (1024 * 1024)).toFixed(1),
      folders: folders.map(f => ({ id: f.id, name: f.name, created: f.createdTime })),
      staged,
    });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// ---- STAGE: Stream a Drive file to R2 ----

export async function stageTakeout(url, env) {
  const token = url.searchParams.get('token');
  const fileId = url.searchParams.get('fileId');
  if (!token) return jsonResponse({ error: 'No token' }, 401);
  if (!fileId) return jsonResponse({ error: 'No fileId' }, 400);

  try {
    // Get file metadata first
    const meta = await fetchGoogle(
      `https://www.googleapis.com/drive/v3/files/${fileId}`, token,
      { fields: 'id,name,size,mimeType' }
    );

    const sizeBytes = parseInt(meta.size || '0');
    const sizeMB = sizeBytes / (1024 * 1024);

    // Stream the file from Drive to R2
    const driveRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!driveRes.ok) {
      return jsonResponse({ error: `Drive download failed: ${driveRes.status}` }, 500);
    }

    const r2Key = `takeout/${meta.name}`;
    await env.ARCHIVES.put(r2Key, driveRes.body, {
      httpMetadata: { contentType: meta.mimeType },
      customMetadata: { driveFileId: fileId, originalSize: String(sizeBytes) },
    });

    return jsonResponse({
      success: true,
      key: r2Key,
      name: meta.name,
      sizeMB: sizeMB.toFixed(1),
    });
  } catch (e) {
    console.error('Stage takeout failed:', e.message);
    return jsonResponse({ error: 'Failed to stage archive' }, 500);
  }
}

// ---- PROCESS: Extract and ingest from a staged file (ZIP or JSON) ----

export async function processTakeout(url, env) {
  const token = url.searchParams.get('token');
  const key = url.searchParams.get('key');
  if (!token) return jsonResponse({ error: 'No token' }, 401);
  if (!key) return jsonResponse({ error: 'No key' }, 400);

  try {
    const obj = await env.ARCHIVES.get(key);
    if (!obj) return jsonResponse({ error: 'Archive not found in storage' }, 404);

    // Peek at first 2 bytes to detect format
    // For JSON files: read fully (they're small enough)
    // For ZIPs: stream (they can be 2GB+)
    const isZipName = key.endsWith('.zip') || key.endsWith('.tgz');

    if (isZipName) {
      return streamProcessZip(obj, key, env);
    }

    // JSON file — read into memory (timeline files are ~50MB max, well within limits)
    const arrayBuf = await obj.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    const firstChar = String.fromCharCode(bytes[0]);

    if (firstChar === '[' || firstChar === '{') {
      const resource = resourceFromPath(key);
      return processJsonFile(arrayBuf, key, resource, env);
    }

    // Check if it's actually a ZIP despite the name
    if (bytes[0] === 0x50 && bytes[1] === 0x4B) {
      return processSmallZip(bytes, key, env);
    }

    return jsonResponse({
      error: 'Unknown file format',
      magic: Array.from(bytes.slice(0, 4)).map(b => b.toString(16)).join(' '),
    }, 422);
  } catch (e) {
    console.error('Process takeout failed:', e.message);
    return jsonResponse({ error: 'Processing failed' }, 500);
  }
}

async function processJsonFile(arrayBuf, key, resource, env) {
  const text = new TextDecoder().decode(arrayBuf);
  let data;
  try { data = JSON.parse(text); } catch (e) {
    return jsonResponse({ error: 'JSON parse failed', details: e.message }, 422);
  }

  // Handle Maps Timeline format (has timelineObjects or semanticSegments)
  if (data.timelineObjects || data.semanticSegments || (Array.isArray(data) && data[0]?.placeVisit)) {
    return processTimelineData(data, key, env);
  }

  // Standard activity format
  let activities = Array.isArray(data) ? data : [data];

  // Flatten nested structures
  if (activities.length === 1 && activities[0] && !activities[0].time && typeof activities[0] === 'object') {
    const inner = Object.values(activities[0]);
    if (Array.isArray(inner[0])) activities = inner[0];
  }

  if (activities.length === 0) {
    return jsonResponse({ success: true, message: 'No activities found', key });
  }

  const result = await ingestActivitiesToGraph(activities, resource, env);

  await env.ARCHIVES.put(`${key}.processed.json`, JSON.stringify({
    processedAt: new Date().toISOString(),
    totalActivities: activities.length,
    result,
  }));

  return jsonResponse({
    success: true,
    format: 'json',
    resource,
    activitiesProcessed: activities.length,
    graphResult: result,
  });
}

async function processTimelineData(data, key, env) {
  // Maps Timeline can come in different formats depending on export date
  let segments = [];

  if (data.timelineObjects) {
    // Older format: array of { placeVisit } or { activitySegment }
    segments = data.timelineObjects;
  } else if (data.semanticSegments) {
    // Newer format
    segments = data.semanticSegments;
  } else if (Array.isArray(data)) {
    segments = data;
  }

  // Convert timeline entries to activity format for graph ingest
  const activities = [];

  for (const entry of segments) {
    const visit = entry.placeVisit;
    const segment = entry.activitySegment;

    if (visit) {
      const location = visit.location || {};
      activities.push({
        time: visit.duration?.startTimestamp || visit.duration?.startTimestampMs
          ? new Date(parseInt(visit.duration.startTimestampMs || 0)).toISOString()
          : null,
        title: `Visited ${location.name || location.address || 'unknown location'}`,
        products: ['Maps'],
        description: [
          location.address,
          location.semanticType,
          visit.placeConfidence,
        ].filter(Boolean).join(' · '),
        locationInfos: [{
          name: location.name,
          lat: location.latitudeE7 ? location.latitudeE7 / 1e7 : null,
          lng: location.longitudeE7 ? location.longitudeE7 / 1e7 : null,
        }],
      });
    }

    if (segment) {
      const activityType = segment.activityType || segment.activities?.[0]?.activityType || 'UNKNOWN';
      const start = segment.duration?.startTimestamp || segment.duration?.startTimestampMs;
      const end = segment.duration?.endTimestamp || segment.duration?.endTimestampMs;
      activities.push({
        time: start ? (typeof start === 'string' ? start : new Date(parseInt(start)).toISOString()) : null,
        title: `${activityType.replace(/_/g, ' ').toLowerCase()}`,
        products: ['Maps'],
        description: segment.distance ? `${(segment.distance / 1000).toFixed(1)} km` : null,
      });
    }
  }

  const timestamped = activities.filter(a => a.time);
  if (timestamped.length === 0) {
    return jsonResponse({ success: true, message: 'No timestamped timeline entries found', rawEntries: segments.length });
  }

  const result = await ingestActivitiesToGraph(timestamped, 'maps.timeline', env);

  await env.ARCHIVES.put(`${key}.processed.json`, JSON.stringify({
    processedAt: new Date().toISOString(),
    rawEntries: segments.length,
    activitiesCreated: timestamped.length,
    result,
  }));

  return jsonResponse({
    success: true,
    format: 'timeline',
    rawEntries: segments.length,
    activitiesProcessed: timestamped.length,
    graphResult: result,
  });
}

// Stream a large ZIP from R2, extracting only activity JSONs
async function streamProcessZip(r2Object, key, env) {
  const results = [];
  let totalActivities = 0;
  let filesFound = 0;
  let activityFilesFound = 0;

  return new Promise(async (resolve) => {
    const uz = new Unzip();
    uz.register(UnzipInflate);

    const pendingFiles = [];

    uz.onfile = (file) => {
      filesFound++;
      const path = file.name;

      // Skip non-activity files (photos, videos, mbox, etc.)
      if (!isActivityFile(path)) {
        // Must still drain the file to keep the stream flowing
        file.ondata = () => {};
        file.start();
        return;
      }

      activityFilesFound++;
      const chunks = [];

      file.ondata = (err, data, final) => {
        if (err) {
          results.push({ path, error: err.message || 'decompression error' });
          return;
        }
        if (data) chunks.push(data);
        if (final) {
          // Combine chunks into full file
          const totalLen = chunks.reduce((s, c) => s + c.length, 0);
          const full = new Uint8Array(totalLen);
          let offset = 0;
          for (const chunk of chunks) { full.set(chunk, offset); offset += chunk.length; }

          pendingFiles.push({ path, data: full });
        }
      };
      file.start();
    };

    // Read the R2 stream in chunks and feed to Unzip
    const reader = r2Object.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          uz.push(new Uint8Array(0), true);
          break;
        }
        uz.push(value);
      }
    } catch (e) {
      resolve(jsonResponse({ error: 'Stream read failed: ' + e.message }, 500));
      return;
    }

    // Now process all collected activity files
    for (const { path, data } of pendingFiles) {
      const resource = resourceFromPath(path);
      try {
        const text = new TextDecoder().decode(data);
        let parsed = JSON.parse(text);
        let activities = Array.isArray(parsed) ? parsed : [parsed];

        if (activities.length === 1 && activities[0] && !activities[0].time && typeof activities[0] === 'object') {
          const inner = Object.values(activities[0]);
          if (Array.isArray(inner[0])) activities = inner[0];
        }

        if (activities.length === 0) continue;

        const result = await ingestActivitiesToGraph(activities, resource, env);
        totalActivities += activities.length;
        results.push({
          path, resource,
          activities: activities.length,
          nodesCreated: result.nodesCreated,
          chainsCreated: result.chainsCreated,
          topicsLinked: result.topicsLinked,
        });
      } catch (e) {
        results.push({ path, resource, error: e.message });
      }
    }

    await env.ARCHIVES.put(`${key}.processed.json`, JSON.stringify({
      processedAt: new Date().toISOString(),
      filesFound,
      activityFilesFound,
      totalActivities,
      results,
    }));

    resolve(jsonResponse({
      success: true,
      format: 'zip-streamed',
      filesInArchive: filesFound,
      activityFilesFound,
      totalActivities,
      results,
    }));
  });
}

// Process a small ZIP that fits in memory (fallback)
async function processSmallZip(zipData, key, env) {
  let entries;
  try {
    entries = unzipSync(zipData);
  } catch (e) {
    return jsonResponse({ error: 'ZIP decompression failed', details: e.message }, 422);
  }

  const activityFiles = Object.keys(entries).filter(isActivityFile);
  const results = [];
  let totalActivities = 0;

  for (const path of activityFiles) {
    const resource = resourceFromPath(path);
    try {
      const text = new TextDecoder().decode(entries[path]);
      let data = JSON.parse(text);
      let activities = Array.isArray(data) ? data : [data];

      if (activities.length === 1 && activities[0] && !activities[0].time && typeof activities[0] === 'object') {
        const inner = Object.values(activities[0]);
        if (Array.isArray(inner[0])) activities = inner[0];
      }

      if (activities.length === 0) continue;

      const result = await ingestActivitiesToGraph(activities, resource, env);
      totalActivities += activities.length;
      results.push({
        path, resource,
        activities: activities.length,
        nodesCreated: result.nodesCreated,
        chainsCreated: result.chainsCreated,
        topicsLinked: result.topicsLinked,
      });
    } catch (e) {
      results.push({ path, resource, error: e.message });
    }
  }

  await env.ARCHIVES.put(`${key}.processed.json`, JSON.stringify({
    processedAt: new Date().toISOString(),
    filesFound: Object.keys(entries).length,
    activityFiles: activityFiles.length,
    totalActivities,
    results,
  }));

  return jsonResponse({
    success: true,
    format: 'zip',
    filesInArchive: Object.keys(entries).length,
    activityFilesFound: activityFiles.length,
    totalActivities,
    results,
  });
}
