import { fetchGoogle } from '../helpers/google.js';

export async function getFit(token) {
  try {
    const sources = await fetchGoogle('https://www.googleapis.com/fitness/v1/users/me/dataSources', token);
    const dataSourceList = sources.dataSource || [];
    const total = dataSourceList.length;
    const typeNames = [...new Set(dataSourceList.map(ds => (ds.dataType?.name || '').replace('com.google.', '')))].slice(0, 8);

    const now = Date.now(), dayAgo = now - 86400000;
    const aggRes = await fetch('https://www.googleapis.com/fitness/v1/users/me/dataset:aggregate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aggregateBy: [{ dataTypeName: 'com.google.heart_rate.bpm' }, { dataTypeName: 'com.google.step_count.delta' },
          { dataTypeName: 'com.google.calories.expended' }],
        bucketByTime: { durationMillis: 3600000 }, startTimeMillis: dayAgo, endTimeMillis: now }),
    });
    const aggData = await aggRes.json();
    let latestTs = null, hr = 0, steps = 0, cal = 0;
    for (const b of (aggData.bucket || []).reverse()) {
      for (const ds of (b.dataset || [])) {
        for (const pt of (ds.point || [])) {
          const end = parseInt(pt.endTimeNanos) / 1000000;
          if (!latestTs || end > latestTs) latestTs = end;
          const tn = pt.dataTypeName || ds.dataSourceId || '';
          if (tn.includes('heart_rate')) hr++;
          if (tn.includes('step_count')) steps++;
          if (tn.includes('calories')) cal++;
        }
      }
    }

    const bodyParts = [];
    if (hr > 0) bodyParts.push(`${hr} heart rate readings`);
    if (steps > 0) bodyParts.push(`${steps} step records`);
    if (cal > 0) bodyParts.push(`${cal} calorie records`);

    return {
      service: 'Body', id: 'fitness', icon: '💪',
      total: `${total} data sources`, latest: latestTs ? new Date(latestTs).toISOString() : null,
      preview: {
        headline: `${total} data sources streaming`,
        detail: bodyParts.length > 0 ? `last 24h: ${bodyParts.join(' · ')}` : 'no data in last 24h',
        stat: typeNames.length > 0 ? `tracking: ${typeNames.join(', ')}` : null,
      },
      richness: Math.min(1, total / 10 + (hr + steps + cal) / 50),
      description: 'when your body is activated, when it crashes, the rhythms underneath everything',
    };
  } catch (e) { return { service: 'Body', id: 'fitness', error: e.message, icon: '💪' }; }
}
