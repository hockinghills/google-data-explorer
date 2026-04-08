import { fetchGoogle } from '../helpers/google.js';

export async function getDrive(token) {
  try {
    const about = await fetchGoogle('https://www.googleapis.com/drive/v3/about', token, { fields: 'storageQuota,user' });
    // Get recent files with types
    const files = await fetchGoogle('https://www.googleapis.com/drive/v3/files', token,
      { pageSize: '20', orderBy: 'modifiedTime desc', fields: 'files(name,mimeType,modifiedTime,createdTime)',
        q: 'trashed=false' });
    const fileList = files.files || [];
    const latest = fileList[0]?.modifiedTime || null;
    const usedGB = about.storageQuota ? (parseInt(about.storageQuota.usage) / (1024**3)).toFixed(2) : '?';

    // Analyze file types
    const types = {};
    for (const f of fileList) {
      const mime = f.mimeType || '';
      let type = 'other';
      if (mime.includes('document')) type = 'docs';
      else if (mime.includes('spreadsheet')) type = 'sheets';
      else if (mime.includes('presentation')) type = 'slides';
      else if (mime.includes('image')) type = 'images';
      else if (mime.includes('pdf')) type = 'pdfs';
      else if (mime.includes('folder')) type = 'folders';
      types[type] = (types[type] || 0) + 1;
    }
    const typeStr = Object.entries(types).filter(([k]) => k !== 'folders')
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${v} ${k}`).join(', ');
    const recentNames = fileList.filter(f => !f.mimeType?.includes('folder')).slice(0, 3).map(f => f.name);

    return {
      service: 'Drive', id: 'drive', icon: '📁',
      total: `${usedGB} GB`, latest,
      preview: {
        headline: `${usedGB} GB used`,
        detail: recentNames.length > 0 ? `recent: ${recentNames.join(', ')}` : null,
        stat: typeStr ? `last 20 files: ${typeStr}` : null,
      },
      richness: Math.min(1, parseFloat(usedGB) / 5),
      description: 'what you created, what you abandoned, where your momentum lives and dies',
    };
  } catch (e) { return { service: 'Drive', id: 'drive', error: e.message, icon: '📁' }; }
}
