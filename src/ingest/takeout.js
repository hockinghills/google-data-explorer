import { fetchGoogle } from '../helpers/google.js';
import { jsonResponse } from '../helpers/response.js';
import { ingestActivitiesToGraph } from '../graph/ingest.js';
import { unzipSync, inflateSync, Inflate, Unzip, UnzipInflate } from 'fflate';

// Derive a per-user R2 prefix from the OAuth token (first 16 chars of SHA-256 hex)
async function userPrefix(token) {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 16);
}

// Sanitize a filename for use as an R2 key component
function sanitizeFilename(name) {
  return name.replace(/[\/\\:\x00]/g, '_').replace(/\.\./g, '_').slice(0, 255);
}

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
  if (m.includes('zip') || /\.zip$/i.test(n)) return 'archive';

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
      const prefix = await userPrefix(token);
      const list = await env.ARCHIVES.list({ prefix: `takeout/${prefix}/` });
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
    console.error('Discover takeout failed:', e);
    return jsonResponse({ error: 'Failed to discover Takeout archives' }, 500);
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

    const r2Key = `takeout/${await userPrefix(token)}/${sanitizeFilename(meta.name)}`;

    // R2 needs a known content length for streams — wrap with FixedLengthStream
    const { readable, writable } = new FixedLengthStream(sizeBytes);
    driveRes.body.pipeTo(writable);
    await env.ARCHIVES.put(r2Key, readable, {
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

  // Validate the key belongs to this user
  const prefix = await userPrefix(token);
  if (!key.startsWith(`takeout/${prefix}/`)) {
    return jsonResponse({ error: 'Archive not found' }, 403);
  }

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
    console.error('JSON parse failed:', e);
    return jsonResponse({ error: 'JSON parse failed — file may be corrupted or in an unexpected format' }, 422);
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

// Detect whether a parsed JSON object is Maps Timeline data
function isTimelineData(data) {
  if (data.timelineObjects || data.semanticSegments) return true;
  if (Array.isArray(data) && data.length > 0 && (data[0].placeVisit || data[0].activitySegment)) return true;
  return false;
}

// Normalize Maps Timeline data (any format) into standard activity objects
function normalizeTimelineToActivities(data) {
  let segments = [];

  if (data.timelineObjects) {
    segments = data.timelineObjects;
  } else if (data.semanticSegments) {
    segments = data.semanticSegments;
  } else if (Array.isArray(data)) {
    segments = data;
  }

  const activities = [];

  for (const entry of segments) {
    const visit = entry.placeVisit;
    const segment = entry.activitySegment;

    if (visit) {
      const location = visit.location || {};
      const startTs = visit.duration?.startTimestamp;
      const startMs = visit.duration?.startTimestampMs;
      let time = null;
      if (startTs && typeof startTs === 'string') {
        time = startTs;
      } else if (startMs) {
        time = new Date(parseInt(startMs)).toISOString();
      }
      activities.push({
        time,
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
      activities.push({
        time: start ? (typeof start === 'string' ? start : new Date(parseInt(start)).toISOString()) : null,
        title: `${activityType.replace(/_/g, ' ').toLowerCase()}`,
        products: ['Maps'],
        description: segment.distance ? `${(segment.distance / 1000).toFixed(1)} km` : null,
      });
    }
  }

  return { activities: activities.filter(a => a.time), rawEntries: segments.length };
}

// Normalize any parsed activity data — handles both standard and timeline formats
function normalizeActivities(parsed, path) {
  if (isTimelineData(parsed)) {
    const { activities } = normalizeTimelineToActivities(parsed);
    return { activities, resource: 'maps.timeline' };
  }

  let activities = Array.isArray(parsed) ? parsed : [parsed];
  if (activities.length === 1 && activities[0] && !activities[0].time && typeof activities[0] === 'object') {
    const inner = Object.values(activities[0]);
    if (Array.isArray(inner[0])) activities = inner[0];
  }

  return { activities, resource: resourceFromPath(path) };
}

async function processTimelineData(data, key, env) {
  const { activities: timestamped, rawEntries } = normalizeTimelineToActivities(data);

  if (timestamped.length === 0) {
    return jsonResponse({ success: true, message: 'No timestamped timeline entries found', rawEntries });
  }

  const result = await ingestActivitiesToGraph(timestamped, 'maps.timeline', env);

  await env.ARCHIVES.put(`${key}.processed.json`, JSON.stringify({
    processedAt: new Date().toISOString(),
    rawEntries,
    activitiesCreated: timestamped.length,
    result,
  }));

  return jsonResponse({
    success: true,
    format: 'timeline',
    rawEntries: rawEntries,
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

  return new Promise((resolve, reject) => {
    (async () => {
    const uz = new Unzip();
    uz.register(UnzipInflate);

    // Queue of completed file buffers to process — allows releasing memory per file
    const readyQueue = [];
    let streamDone = false;

    uz.onfile = (file) => {
      filesFound++;
      const path = file.name;

      if (!isActivityFile(path)) {
        file.ondata = () => {};
        file.start();
        return;
      }

      activityFilesFound++;
      const chunks = [];

      file.ondata = (err, data, final) => {
        if (err) {
          results.push({ path, error: 'decompression error' });
          return;
        }
        if (data) chunks.push(data);
        if (final) {
          const totalLen = chunks.reduce((s, c) => s + c.length, 0);
          const full = new Uint8Array(totalLen);
          let offset = 0;
          for (const chunk of chunks) { full.set(chunk, offset); offset += chunk.length; }
          readyQueue.push({ path, data: full });
        }
      };
      file.start();
    };

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
      console.error('Stream read failed:', e);
      resolve(jsonResponse({ error: 'Archive stream read failed' }, 500));
      return;
    }

    // Process each file and release its buffer immediately
    for (const { path, data } of readyQueue) {
      try {
        const text = new TextDecoder().decode(data);
        const parsed = JSON.parse(text);
        const { activities, resource } = normalizeActivities(parsed, path);

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
        console.error(`Failed to process ${path}:`, e);
        results.push({ path, resource: resourceFromPath(path), error: 'Failed to parse or ingest file' });
      }
    }
    readyQueue.length = 0; // Release references

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
    })().catch((e) => {
      console.error('streamProcessZip unhandled:', e);
      resolve(jsonResponse({ error: 'Processing failed' }, 500));
    });
  });
}

// Process a small ZIP that fits in memory (fallback)
async function processSmallZip(zipData, key, env) {
  let entries;
  try {
    entries = unzipSync(zipData);
  } catch (e) {
    console.error('ZIP decompression failed:', e);
    return jsonResponse({ error: 'ZIP decompression failed — archive may be corrupted or invalid' }, 422);
  }

  const activityFiles = Object.keys(entries).filter(isActivityFile);
  const results = [];
  let totalActivities = 0;

  for (const path of activityFiles) {
    try {
      const text = new TextDecoder().decode(entries[path]);
      const parsed = JSON.parse(text);
      const { activities, resource } = normalizeActivities(parsed, path);

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
      console.error(`Failed to process ${path}:`, e);
      results.push({ path, resource: resourceFromPath(path), error: 'Failed to parse or ingest file' });
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

// ---- PEEK: List contents of a staged ZIP without ingesting ----

export async function peekTakeout(url, env) {
  const token = url.searchParams.get('token');
  const key = url.searchParams.get('key');
  if (!token) return jsonResponse({ error: 'No token' }, 401);
  if (!key) return jsonResponse({ error: 'No key' }, 400);

  const prefix = await userPrefix(token);
  if (!key.startsWith(`takeout/${prefix}/`)) {
    return jsonResponse({ error: 'Archive not found' }, 403);
  }

  try {
    const obj = await env.ARCHIVES.get(key);
    if (!obj) return jsonResponse({ error: 'Not found in storage' }, 404);

    const archiveSize = obj.size;

    // For small files, use sync approach
    if (archiveSize < 50 * 1024 * 1024) {
      const arrayBuf = await obj.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4B) {
        return jsonResponse({ error: 'Not a ZIP file', size: bytes.length });
      }
      const entries = unzipSync(bytes);
      const files = Object.keys(entries).map(path => ({
        path, size: entries[path].length,
        category: categorizeFile(path, ''), isActivity: isActivityFile(path),
      }));
      return jsonResponse(buildPeekResponse(files, archiveSize));
    }

    // For large files, read ZIP central directory from the end of the file
    // The EOCD (End of Central Directory) is in the last 64KB max
    const tailSize = Math.min(65536, archiveSize);
    const tailObj = await env.ARCHIVES.get(key, {
      range: { offset: archiveSize - tailSize, length: tailSize },
    });
    const tailBuf = new Uint8Array(await tailObj.arrayBuffer());

    // Find EOCD signature (0x50 0x4B 0x05 0x06) scanning backwards
    let eocdOffset = -1;
    for (let i = tailBuf.length - 22; i >= 0; i--) {
      if (tailBuf[i] === 0x50 && tailBuf[i+1] === 0x4B && tailBuf[i+2] === 0x05 && tailBuf[i+3] === 0x06) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) {
      return jsonResponse({ error: 'Could not find ZIP directory', archiveSize });
    }

    // Parse EOCD
    const view = new DataView(tailBuf.buffer, tailBuf.byteOffset);
    const cdEntries = view.getUint16(eocdOffset + 10, true);
    const cdSize = view.getUint32(eocdOffset + 12, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);

    // Read the central directory
    const cdObj = await env.ARCHIVES.get(key, {
      range: { offset: cdOffset, length: cdSize },
    });
    const cdBuf = new Uint8Array(await cdObj.arrayBuffer());
    const cdView = new DataView(cdBuf.buffer, cdBuf.byteOffset);

    // Parse central directory entries
    const files = [];
    let pos = 0;
    while (pos < cdBuf.length - 46) {
      // Check signature 0x50 0x4B 0x01 0x02
      if (cdBuf[pos] !== 0x50 || cdBuf[pos+1] !== 0x4B || cdBuf[pos+2] !== 0x01 || cdBuf[pos+3] !== 0x02) break;

      const compSize = cdView.getUint32(pos + 20, true);
      const uncompSize = cdView.getUint32(pos + 24, true);
      const nameLen = cdView.getUint16(pos + 28, true);
      const extraLen = cdView.getUint16(pos + 30, true);
      const commentLen = cdView.getUint16(pos + 32, true);

      const nameBytes = cdBuf.slice(pos + 46, pos + 46 + nameLen);
      const path = new TextDecoder().decode(nameBytes);

      if (!path.endsWith('/')) {
        files.push({
          path,
          size: uncompSize,
          compressedSize: compSize,
          category: categorizeFile(path, ''),
          isActivity: isActivityFile(path),
        });
      }

      pos += 46 + nameLen + extraLen + commentLen;
    }

    return jsonResponse(buildPeekResponse(files, archiveSize));
  } catch (e) {
    console.error('Peek failed:', e);
    return jsonResponse({ error: 'Failed to read archive' }, 500);
  }
}

function buildPeekResponse(files, archiveSize) {
  const dirs = {};
  for (const f of files) {
    const parts = f.path.split('/');
    const topDir = parts.length > 1 ? parts.slice(0, 2).join('/') : parts[0];
    if (!dirs[topDir]) dirs[topDir] = { files: 0, totalSize: 0, activityFiles: 0, categories: {} };
    dirs[topDir].files++;
    dirs[topDir].totalSize += f.size;
    if (f.isActivity) dirs[topDir].activityFiles++;
    dirs[topDir].categories[f.category] = (dirs[topDir].categories[f.category] || 0) + 1;
  }
  return {
    totalFiles: files.length,
    archiveSizeBytes: archiveSize,
    activityFiles: files.filter(f => f.isActivity).length,
    directories: dirs,
    allFiles: files.sort((a, b) => b.size - a.size).slice(0, 100),
  };
}

// ---- PEEK FROM DRIVE: Read ZIP central directory directly without staging ----

export async function peekDriveZip(url, env) {
  const token = url.searchParams.get('token');
  const fileId = url.searchParams.get('fileId');
  if (!token) return jsonResponse({ error: 'No token' }, 401);
  if (!fileId) return jsonResponse({ error: 'No fileId' }, 400);

  try {
    // Get file size
    const meta = await fetchGoogle(
      `https://www.googleapis.com/drive/v3/files/${fileId}`, token,
      { fields: 'id,name,size' }
    );
    const fileSize = parseInt(meta.size || '0');
    if (fileSize === 0) return jsonResponse({ error: 'Empty file' }, 400);

    // Read last 64KB to find EOCD
    const tailSize = Math.min(65536, fileSize);
    const rangeStart = fileSize - tailSize;
    const tailRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Range: `bytes=${rangeStart}-${fileSize - 1}`,
        },
      }
    );
    if (!tailRes.ok && tailRes.status !== 206) {
      return jsonResponse({ error: `Drive range request failed: ${tailRes.status}` }, 500);
    }
    const tailBuf = new Uint8Array(await tailRes.arrayBuffer());

    // Find EOCD signature
    let eocdOffset = -1;
    for (let i = tailBuf.length - 22; i >= 0; i--) {
      if (tailBuf[i] === 0x50 && tailBuf[i+1] === 0x4B && tailBuf[i+2] === 0x05 && tailBuf[i+3] === 0x06) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) {
      return jsonResponse({ error: 'Could not find ZIP directory' });
    }

    const view = new DataView(tailBuf.buffer, tailBuf.byteOffset);
    const cdSize = view.getUint32(eocdOffset + 12, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);

    // Read central directory
    const cdRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Range: `bytes=${cdOffset}-${cdOffset + cdSize - 1}`,
        },
      }
    );
    if (!cdRes.ok && cdRes.status !== 206) {
      return jsonResponse({ error: `CD fetch failed: ${cdRes.status}` }, 500);
    }
    const cdBuf = new Uint8Array(await cdRes.arrayBuffer());
    const cdView = new DataView(cdBuf.buffer, cdBuf.byteOffset);

    const files = [];
    let pos = 0;
    while (pos < cdBuf.length - 46) {
      if (cdBuf[pos] !== 0x50 || cdBuf[pos+1] !== 0x4B || cdBuf[pos+2] !== 0x01 || cdBuf[pos+3] !== 0x02) break;
      const uncompSize = cdView.getUint32(pos + 24, true);
      const nameLen = cdView.getUint16(pos + 28, true);
      const extraLen = cdView.getUint16(pos + 30, true);
      const commentLen = cdView.getUint16(pos + 32, true);
      const path = new TextDecoder().decode(cdBuf.slice(pos + 46, pos + 46 + nameLen));
      if (!path.endsWith('/')) {
        files.push({
          path, size: uncompSize,
          category: categorizeFile(path, ''),
          isActivity: isActivityFile(path),
        });
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }

    return jsonResponse({ name: meta.name, ...buildPeekResponse(files, fileSize) });
  } catch (e) {
    console.error('Peek Drive ZIP failed:', e);
    return jsonResponse({ error: 'Failed to peek archive', debug: e.message }, 500);
  }
}

// ---- SAMPLE: Extract a single file from a staged ZIP using range requests ----

export async function sampleTakeout(url, env) {
  const token = url.searchParams.get('token');
  const key = url.searchParams.get('key');
  const filePath = url.searchParams.get('path');
  const maxBytes = parseInt(url.searchParams.get('bytes') || '5000');
  if (!token) return jsonResponse({ error: 'No token' }, 401);
  if (!key || !filePath) return jsonResponse({ error: 'Need key and path' }, 400);

  const prefix = await userPrefix(token);
  if (!key.startsWith(`takeout/${prefix}/`)) return jsonResponse({ error: 'Not found' }, 403);

  try {
    // Get archive size
    const head = await env.ARCHIVES.head(key);
    if (!head) return jsonResponse({ error: 'Not found' }, 404);
    const archiveSize = head.size;

    // Read EOCD from tail
    const tailSize = Math.min(65536, archiveSize);
    const tailObj = await env.ARCHIVES.get(key, {
      range: { offset: archiveSize - tailSize, length: tailSize },
    });
    const tailBuf = new Uint8Array(await tailObj.arrayBuffer());

    let eocdOffset = -1;
    for (let i = tailBuf.length - 22; i >= 0; i--) {
      if (tailBuf[i] === 0x50 && tailBuf[i+1] === 0x4B && tailBuf[i+2] === 0x05 && tailBuf[i+3] === 0x06) {
        eocdOffset = i; break;
      }
    }
    if (eocdOffset === -1) return jsonResponse({ error: 'No ZIP directory found' });

    const tailView = new DataView(tailBuf.buffer, tailBuf.byteOffset);
    const cdSize = tailView.getUint32(eocdOffset + 12, true);
    const cdOffset = tailView.getUint32(eocdOffset + 16, true);

    // Read central directory
    const cdObj = await env.ARCHIVES.get(key, { range: { offset: cdOffset, length: cdSize } });
    const cdBuf = new Uint8Array(await cdObj.arrayBuffer());
    const cdView = new DataView(cdBuf.buffer, cdBuf.byteOffset);

    // Find the target file
    let pos = 0;
    let fileOffset = -1, compSize = 0, uncompSize = 0, compMethod = 0;
    while (pos < cdBuf.length - 46) {
      if (cdBuf[pos] !== 0x50 || cdBuf[pos+1] !== 0x4B || cdBuf[pos+2] !== 0x01 || cdBuf[pos+3] !== 0x02) break;
      compMethod = cdView.getUint16(pos + 10, true);
      compSize = cdView.getUint32(pos + 20, true);
      uncompSize = cdView.getUint32(pos + 24, true);
      const nameLen = cdView.getUint16(pos + 28, true);
      const extraLen = cdView.getUint16(pos + 30, true);
      const commentLen = cdView.getUint16(pos + 32, true);
      const localOffset = cdView.getUint32(pos + 42, true);
      const name = new TextDecoder().decode(cdBuf.slice(pos + 46, pos + 46 + nameLen));

      if (name === filePath) {
        fileOffset = localOffset;
        break;
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }
    if (fileOffset === -1) return jsonResponse({ error: 'File not found', path: filePath }, 404);

    // Read local file header to get actual data offset
    const localObj = await env.ARCHIVES.get(key, { range: { offset: fileOffset, length: 30 } });
    const localBuf = new Uint8Array(await localObj.arrayBuffer());
    const localView = new DataView(localBuf.buffer, localBuf.byteOffset);
    const localNameLen = localView.getUint16(26, true);
    const localExtraLen = localView.getUint16(28, true);
    const dataOffset = fileOffset + 30 + localNameLen + localExtraLen;

    // Read compressed data — for large files, read enough to decompress a useful sample
    const readSize = Math.min(compSize, 256 * 1024); // up to 256KB compressed
    const dataObj = await env.ARCHIVES.get(key, { range: { offset: dataOffset, length: readSize } });
    const dataBuf = new Uint8Array(await dataObj.arrayBuffer());

    let text;
    if (compMethod === 0) {
      text = new TextDecoder().decode(dataBuf.subarray(0, Math.min(dataBuf.length, maxBytes)));
    } else if (compMethod === 8) {
      // Deflate — use streaming inflate for partial data
      try {
        // If we have all compressed data, use sync
        if (readSize >= compSize) {
          const inflated = inflateSync(dataBuf);
          text = new TextDecoder().decode(inflated.subarray(0, Math.min(inflated.length, maxBytes)));
        } else {
          // Partial — use Inflate stream, collect until we have enough
          const chunks = [];
          let total = 0;
          const inf = new Inflate((data) => {
            if (total < maxBytes) {
              chunks.push(data);
              total += data.length;
            }
          });
          inf.push(dataBuf);
          const full = new Uint8Array(Math.min(total, maxBytes));
          let offset = 0;
          for (const chunk of chunks) {
            const take = Math.min(chunk.length, maxBytes - offset);
            full.set(chunk.subarray(0, take), offset);
            offset += take;
            if (offset >= maxBytes) break;
          }
          text = new TextDecoder().decode(full);
        }
      } catch (e) {
        return jsonResponse({ error: 'Decompression failed', debug: e.message, compSize, readSize }, 500);
      }
    } else {
      return jsonResponse({ error: 'Unsupported compression', method: compMethod });
    }

    return new Response(text, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (e) {
    console.error('Sample failed:', e);
    return jsonResponse({ error: 'Failed to sample', debug: e.message }, 500);
  }
}
