import { fetchGoogle } from '../helpers/google.js';

export async function getCalendar(token) {
  try {
    const now = new Date();
    const past = new Date(Date.now() - 365 * 86400000).toISOString();
    // Pull a sample of events to analyze time patterns
    const data = await fetchGoogle('https://www.googleapis.com/calendar/v3/calendars/primary/events', token,
      { timeMin: past, timeMax: now.toISOString(), maxResults: '250', singleEvents: 'true', orderBy: 'startTime' });
    const events = data.items || [];
    const total = events.length;
    const latest = events[events.length - 1]?.updated || events[events.length - 1]?.created || null;

    // Time-of-day distribution
    const hourBuckets = { morning: 0, afternoon: 0, evening: 0, night: 0 };
    const dayBuckets = {};
    for (const evt of events) {
      const start = evt.start?.dateTime || evt.start?.date;
      if (!start) continue;
      const d = new Date(start);
      const h = d.getHours();
      if (h >= 6 && h < 12) hourBuckets.morning++;
      else if (h >= 12 && h < 17) hourBuckets.afternoon++;
      else if (h >= 17 && h < 22) hourBuckets.evening++;
      else hourBuckets.night++;
      const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
      dayBuckets[day] = (dayBuckets[day] || 0) + 1;
    }
    const busiestTime = Object.entries(hourBuckets).sort((a, b) => b[1] - a[1])[0];
    const busiestDay = Object.entries(dayBuckets).sort((a, b) => b[1] - a[1])[0];

    return {
      service: 'Calendar', id: 'calendar', icon: '📅', total: `${total}+ events (past year)`, latest,
      preview: {
        headline: `${total}+ events in the past year`,
        detail: busiestTime ? `heaviest in the ${busiestTime[0]} (${busiestTime[1]} events)` : null,
        stat: busiestDay ? `busiest day: ${busiestDay[0]}` : null,
        timeBuckets: hourBuckets,
      },
      richness: Math.min(1, total / 300),
      description: 'when you commit to things, when you actually show up, how you structure time',
    };
  } catch (e) { return { service: 'Calendar', id: 'calendar', error: e.message, icon: '📅' }; }
}
