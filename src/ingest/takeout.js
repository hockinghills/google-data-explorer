import { fetchGoogle } from '../helpers/google.js';
import { jsonResponse } from '../helpers/response.js';
import { ingestActivitiesToGraph } from '../graph/ingest.js';
import { unzipSync } from 'fflate';

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

// ---- DISCOVER: Find Takeout archives in user's Drive ----

export async function discoverTakeout(url, env) {
  const token = url.searchParams.get('token');
  if (!token) return jsonResponse({ error: 'No token' }, 401);

  try {
    // Search for Takeout ZIP files in Drive
    const zipResults = await fetchGoogle(
      'https://www.googleapis.com/drive/v3/files', token,
      { q: TAKEOUT_ZIP_QUERY, pageSize: '50', fields: 'files(id,name,size,createdTime,modifiedTime,mimeType)', orderBy: 'createdTime desc' }
    );

    // Also check for Takeout folders (in case they extracted)
    const folderResults = await fetchGoogle(
      'https://www.googleapis.com/drive/v3/files', token,
      { q: TAKEOUT_FOLDER_QUERY, pageSize: '10', fields: 'files(id,name,createdTime)', orderBy: 'createdTime desc' }
    );

    const archives = (zipResults.files || []).map(f => ({
      id: f.id,
      name: f.name,
      sizeBytes: parseInt(f.size || '0'),
      sizeMB: (parseInt(f.size || '0') / (1024 * 1024)).toFixed(1),
      created: f.createdTime,
      type: 'zip',
    }));

    const folders = (folderResults.files || []).map(f => ({
      id: f.id,
      name: f.name,
      created: f.createdTime,
      type: 'folder',
    }));

    // Check what's already in R2
    let stored = [];
    try {
      const list = await env.ARCHIVES.list({ prefix: 'takeout/' });
      stored = list.objects.map(o => ({
        key: o.key,
        sizeMB: (o.size / (1024 * 1024)).toFixed(1),
        uploaded: o.uploaded,
      }));
    } catch (e) { /* R2 not available */ }

    return jsonResponse({
      archives,
      folders,
      stored,
      totalArchives: archives.length,
      totalSizeMB: archives.reduce((sum, a) => sum + parseFloat(a.sizeMB), 0).toFixed(1),
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

// ---- PROCESS: Extract activity JSONs from a staged ZIP and ingest to graph ----

export async function processTakeout(url, env) {
  const token = url.searchParams.get('token');
  const key = url.searchParams.get('key');
  if (!token) return jsonResponse({ error: 'No token' }, 401);
  if (!key) return jsonResponse({ error: 'No key' }, 400);

  try {
    // Read the ZIP from R2
    const obj = await env.ARCHIVES.get(key);
    if (!obj) return jsonResponse({ error: 'Archive not found in storage' }, 404);

    const sizeBytes = obj.size;
    const MAX_PROCESS_SIZE = 512 * 1024 * 1024; // 512MB limit for in-memory processing
    if (sizeBytes > MAX_PROCESS_SIZE) {
      return jsonResponse({
        error: `Archive too large for single-pass processing: ${(sizeBytes / (1024 * 1024)).toFixed(0)}MB`,
        hint: 'Re-export with smaller file size setting (1GB or 2GB)',
      }, 413);
    }

    // Read entire ZIP into memory and decompress
    const arrayBuf = await obj.arrayBuffer();
    const zipData = new Uint8Array(arrayBuf);

    let entries;
    try {
      entries = unzipSync(zipData);
    } catch (e) {
      return jsonResponse({ error: 'ZIP decompression failed', details: e.message }, 422);
    }

    // Filter to activity files only
    const activityFiles = Object.keys(entries).filter(isActivityFile);

    const results = [];
    let totalActivities = 0;

    for (const path of activityFiles) {
      const resource = resourceFromPath(path);
      try {
        const text = new TextDecoder().decode(entries[path]);
        let data = JSON.parse(text);
        let activities = Array.isArray(data) ? data : [data];

        // Flatten nested structures (same as portability pipeline)
        if (activities.length === 1 && activities[0] && !activities[0].time && typeof activities[0] === 'object') {
          const inner = Object.values(activities[0]);
          if (Array.isArray(inner[0])) activities = inner[0];
        }

        if (activities.length === 0) continue;

        const result = await ingestActivitiesToGraph(activities, resource, env);
        totalActivities += activities.length;
        results.push({
          path,
          resource,
          activities: activities.length,
          nodesCreated: result.nodesCreated,
          chainsCreated: result.chainsCreated,
          topicsLinked: result.topicsLinked,
        });
      } catch (e) {
        results.push({ path, resource, error: e.message });
      }
    }

    // Store processing metadata in R2
    await env.ARCHIVES.put(`${key}.processed.json`, JSON.stringify({
      processedAt: new Date().toISOString(),
      filesFound: Object.keys(entries).length,
      activityFiles: activityFiles.length,
      totalActivities,
      results,
    }));

    return jsonResponse({
      success: true,
      filesInArchive: Object.keys(entries).length,
      activityFilesFound: activityFiles.length,
      totalActivities,
      results,
    });
  } catch (e) {
    console.error('Process takeout failed:', e.message);
    return jsonResponse({ error: 'Archive processing failed' }, 500);
  }
}
