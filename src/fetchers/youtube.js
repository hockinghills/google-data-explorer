import { fetchGoogle } from '../helpers/google.js';

export async function getYouTube(token) {
  try {
    const channels = await fetchGoogle('https://www.googleapis.com/youtube/v3/channels', token,
      { part: 'statistics', mine: 'true' });
    const stats = channels.items?.[0]?.statistics || {};
    // Get recent activities with more detail
    const activities = await fetchGoogle('https://www.googleapis.com/youtube/v3/activities', token,
      { part: 'snippet', mine: 'true', maxResults: '10' });
    const recentTitles = (activities.items || []).slice(0, 5)
      .map(a => a.snippet?.title).filter(Boolean);
    const latest = activities.items?.[0]?.snippet?.publishedAt || null;
    // Get subscriptions count
    const subs = await fetchGoogle('https://www.googleapis.com/youtube/v3/subscriptions', token,
      { part: 'snippet', mine: 'true', maxResults: '5' });
    const subTotal = subs.pageInfo?.totalResults || 0;
    const recentSubs = (subs.items || []).slice(0, 3)
      .map(s => s.snippet?.title).filter(Boolean);

    return {
      service: 'YouTube', id: 'youtube', icon: '🎬', 
      total: `${stats.viewCount || 0} views`, latest,
      preview: {
        headline: `${parseInt(stats.viewCount || 0).toLocaleString()} views · ${subTotal} subscriptions`,
        detail: recentTitles.length > 0 ? `recent: ${recentTitles[0]}` : null,
        stat: recentSubs.length > 0 ? `following: ${recentSubs.join(', ')}` : null,
      },
      richness: Math.min(1, (parseInt(stats.viewCount || 0) / 5000) + (subTotal / 100)),
      description: 'what captures your attention, how deep you go, what you keep coming back to',
    };
  } catch (e) { return { service: 'YouTube', id: 'youtube', error: e.message, icon: '🎬' }; }
}
