// Layer 1: Live API scopes (explorer cards, real-time monitoring)
export const LIVE_SCOPES = [
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/fitness.activity.read',
  'https://www.googleapis.com/auth/fitness.heart_rate.read',
  'https://www.googleapis.com/auth/fitness.body.read',
  'https://www.googleapis.com/auth/fitness.sleep.read',
  'https://www.googleapis.com/auth/fitness.location.read',
  'https://www.googleapis.com/auth/tasks.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
].join(' ');

// Layer 2: Data Portability scopes (bulk historical export)
// CRITICAL: These CANNOT be mixed with Layer 1 scopes in a single OAuth flow
export const PORTABILITY_SCOPES = [
  'https://www.googleapis.com/auth/dataportability.myactivity.youtube',
  'https://www.googleapis.com/auth/dataportability.myactivity.search',
  'https://www.googleapis.com/auth/dataportability.myactivity.maps',
  'https://www.googleapis.com/auth/dataportability.myactivity.shopping',
  'https://www.googleapis.com/auth/dataportability.myactivity.play',
  'https://www.googleapis.com/auth/dataportability.chrome.history',
  'https://www.googleapis.com/auth/dataportability.youtube.subscriptions',
  'https://www.googleapis.com/auth/dataportability.discover.follows',
  'https://www.googleapis.com/auth/dataportability.discover.likes',
  'https://www.googleapis.com/auth/dataportability.saved.collections',
  'https://www.googleapis.com/auth/dataportability.maps.starred_places',
].join(' ');

// Resource groups for portability archive jobs
export const PORTABILITY_RESOURCES = [
  'myactivity.youtube',
  'myactivity.search',
  'myactivity.maps',
  'myactivity.shopping',
  'myactivity.play',
  'chrome.history',
  'youtube.subscriptions',
  'discover.follows',
  'discover.likes',
  'saved.collections',
  'maps.starred_places',
];
