import { fetchGoogle } from '../helpers/google.js';

export async function getYouTubeMusic(token) {
  try {
    const playlists = await fetchGoogle('https://www.googleapis.com/youtube/v3/playlists', token,
      { part: 'snippet,contentDetails', mine: 'true', maxResults: '50' });
    const likedVideos = await fetchGoogle('https://www.googleapis.com/youtube/v3/playlistItems', token,
      { part: 'snippet,contentDetails', playlistId: 'LL', maxResults: '10' });
    const likedTotal = likedVideos.pageInfo?.totalResults || 0;
    const recentLiked = (likedVideos.items || []).slice(0, 5).map(item => ({
      title: item.snippet?.title, channel: item.snippet?.videoOwnerChannelTitle }));
    const latest = recentLiked[0]?.addedAt || playlists.items?.[0]?.snippet?.publishedAt || null;
    // Count unique artists
    const artists = [...new Set(recentLiked.map(r => r.channel).filter(Boolean))];
    const playlistNames = (playlists.items || []).slice(0, 3).map(p => p.snippet?.title).filter(Boolean);

    return {
      service: 'Music', id: 'music', icon: '🎵',
      total: `${likedTotal} liked`, latest,
      preview: {
        headline: `${likedTotal} liked tracks · ${playlists.items?.length || 0} playlists`,
        detail: recentLiked.length > 0
          ? recentLiked.slice(0, 2).map(r => `${r.title} — ${r.channel || '?'}`).join(' · ')
          : null,
        stat: playlistNames.length > 0 ? `playlists: ${playlistNames.join(', ')}` : null,
      },
      richness: Math.min(1, likedTotal / 200 + (playlists.items?.length || 0) / 20),
      description: 'what moves you, what you loop, the soundtrack to your focus and your chaos',
    };
  } catch (e) { return { service: 'Music', id: 'music', error: e.message, icon: '🎵' }; }
}
