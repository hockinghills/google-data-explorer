import { fetchGoogle } from '../helpers/google.js';

export async function getContacts(token) {
  try {
    const data = await fetchGoogle('https://people.googleapis.com/v1/people/me/connections', token,
      { personFields: 'names,emailAddresses,metadata', pageSize: '10', sortOrder: 'LAST_MODIFIED_DESCENDING' });
    const total = data.totalPeople || data.totalItems || 0;
    const latest = data.connections?.[0]?.metadata?.sources?.[0]?.updateTime || null;
    const recentNames = (data.connections || []).slice(0, 5)
      .map(c => c.names?.[0]?.displayName).filter(Boolean);
    const hasEmail = (data.connections || []).filter(c => c.emailAddresses?.length > 0).length;
    return {
      service: 'People', id: 'contacts', icon: '\u{1F465}', total, latest,
      preview: {
        headline: `${total} people in your world`,
        detail: recentNames.length > 0 ? `recently touched: ${recentNames.join(', ')}` : null,
        stat: hasEmail > 0 ? `${hasEmail} of last 10 have email` : null,
      },
      richness: Math.min(1, total / 500),
      description: 'who you know, who you actually interact with, who you\'ve forgotten about',
    };
  } catch (e) { return { service: 'People', id: 'contacts', error: e.message, icon: '\u{1F465}' }; }
}
