import { getContacts } from './contacts.js';
import { getCalendar } from './calendar.js';
import { getGmail } from './gmail.js';
import { getYouTube } from './youtube.js';
import { getYouTubeMusic } from './youtube-music.js';
import { getFit } from './fit.js';
import { getTasks } from './tasks.js';
import { getDrive } from './drive.js';

export async function getAllCards(token) {
  const results = await Promise.allSettled([
    getContacts(token),
    getCalendar(token),
    getGmail(token),
    getYouTube(token),
    getYouTubeMusic(token),
    getFit(token),
    getTasks(token),
    getDrive(token),
  ]);
  return results.map(r => r.status === 'fulfilled' ? r.value : { service: 'Unknown', error: r.reason });
}

export { getContacts, getCalendar, getGmail, getYouTube, getYouTubeMusic, getFit, getTasks, getDrive };
