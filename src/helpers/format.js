export function formatDate(dateStr) {
  if (!dateStr) return 'unknown';
  try {
    const d = new Date(dateStr);
    const ms = Date.now() - d;
    const mins = Math.floor(ms / 60000), hrs = Math.floor(ms / 3600000), days = Math.floor(ms / 86400000);
    if (mins < 60) return `${mins}m ago`;
    if (hrs < 24) return `${hrs}h ago`;
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  } catch { return dateStr; }
}

export function recencyColor(dateStr) {
  if (!dateStr) return '#333';
  try {
    const days = (Date.now() - new Date(dateStr)) / 86400000;
    if (days < 1) return '#22c55e';
    if (days < 7) return '#84cc16';
    if (days < 30) return '#eab308';
    if (days < 90) return '#f97316';
    return '#ef4444';
  } catch { return '#333'; }
}

export function richnessBars(richness) {
  const filled = Math.round((richness || 0) * 5);
  return Array.from({ length: 5 }, (_, i) =>
    `<span class="bar ${i < filled ? 'filled' : ''}"></span>`
  ).join('');
}

export function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash |= 0; }
  return Math.abs(hash).toString(36);
}
