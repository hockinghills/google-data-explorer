import { LIVE_SCOPES, PORTABILITY_SCOPES } from './scopes.js';

export function redirectToGoogle(env, flow) {
  const isPortability = flow === 'portability';
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: isPortability
      ? (env.PORTABILITY_REDIRECT_URI || env.REDIRECT_URI.replace('/callback', '/callback/portability'))
      : env.REDIRECT_URI,
    response_type: 'code',
    scope: isPortability ? PORTABILITY_SCOPES : LIVE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

export async function handleCallback(url, env, flow) {
  const code = url.searchParams.get('code');
  if (!code) return new Response('No code received', { status: 400 });

  const isPortability = flow === 'portability';
  const redirectUri = isPortability
    ? (env.PORTABILITY_REDIRECT_URI || env.REDIRECT_URI.replace('/callback', '/callback/portability'))
    : env.REDIRECT_URI;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await tokenRes.json();
  if (!tokens.access_token) {
    return new Response(`Token error: ${JSON.stringify(tokens)}`, { status: 400 });
  }

  if (isPortability) {
    return Response.redirect(`${url.origin}/explorer?ptoken=${tokens.access_token}`);
  }
  return Response.redirect(`${url.origin}/explorer?token=${tokens.access_token}`);
}
