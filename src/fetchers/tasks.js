import { fetchGoogle } from '../helpers/google.js';

export async function getTasks(token) {
  try {
    const lists = await fetchGoogle('https://tasks.googleapis.com/tasks/v1/users/@me/lists', token);
    const totalLists = lists.items?.length || 0;
    let totalTasks = 0, completed = 0, latest = null;
    const listNames = [];
    for (const list of (lists.items || []).slice(0, 5)) {
      listNames.push(list.title);
      const tasks = await fetchGoogle(`https://tasks.googleapis.com/tasks/v1/lists/${list.id}/tasks`, token,
        { maxResults: '100', showCompleted: 'true' });
      const items = tasks.items || [];
      totalTasks += items.length;
      completed += items.filter(t => t.status === 'completed').length;
      const lt = items[0]?.updated;
      if (lt && (!latest || lt > latest)) latest = lt;
    }
    const completionRate = totalTasks > 0 ? Math.round(completed / totalTasks * 100) : 0;

    return {
      service: 'Tasks', id: 'tasks', icon: '✅',
      total: `${totalTasks} tasks`, latest,
      preview: {
        headline: `${totalTasks} tasks across ${totalLists} lists`,
        detail: `${completionRate}% completion rate — ${completed} done, ${totalTasks - completed} open`,
        stat: listNames.length > 0 ? `lists: ${listNames.join(', ')}` : null,
      },
      richness: Math.min(1, totalTasks / 100),
      description: 'what you intended to do vs what you actually did — the gap tells a story',
    };
  } catch (e) { return { service: 'Tasks', id: 'tasks', error: e.message, icon: '✅' }; }
}
