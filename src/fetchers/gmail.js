import { fetchGoogle } from '../helpers/google.js';

export async function getGmail(token) {
  try {
    const profile = await fetchGoogle('https://gmail.googleapis.com/gmail/v1/users/me/profile', token);
    const total = profile.messagesTotal || 0;
    // Get labels list for user labels
    const labels = await fetchGoogle('https://gmail.googleapis.com/gmail/v1/users/me/labels', token);
    const userLabels = (labels.labels || []).filter(l => l.type === 'user');
    // Fetch INBOX and SENT individually — list endpoint doesn't include counts
    const [inboxLabel, sentLabel] = await Promise.all([
      fetchGoogle('https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX', token).catch(() => ({})),
      fetchGoogle('https://gmail.googleapis.com/gmail/v1/users/me/labels/SENT', token).catch(() => ({})),
    ]);
    const unread = inboxLabel.messagesUnread || 0;
    const sentCount = sentLabel.messagesTotal || 0;
    // Get recent message for recency
    const messages = await fetchGoogle('https://gmail.googleapis.com/gmail/v1/users/me/messages', token, { maxResults: '1' });
    let latest = null;
    if (messages.messages?.[0]?.id) {
      const msg = await fetchGoogle(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messages.messages[0].id}`,
        token, { format: 'metadata', metadataHeaders: 'Date' });
      latest = msg.payload?.headers?.find(h => h.name === 'Date')?.value || null;
    }

    return {
      service: 'Gmail', id: 'gmail', icon: '📧', total, latest,
      preview: {
        headline: `${total.toLocaleString()} messages`,
        detail: `${unread.toLocaleString()} unread · ${sentCount.toLocaleString()} sent · ${userLabels.length} labels`,
        stat: userLabels.length > 0 ? `labels: ${userLabels.slice(0, 5).map(l => l.name).join(', ')}` : null,
      },
      richness: Math.min(1, total / 10000),
      description: 'who gets your attention, who waits, how you respond to the world reaching out',
    };
  } catch (e) { return { service: 'Gmail', id: 'gmail', error: e.message, icon: '📧' }; }
}
