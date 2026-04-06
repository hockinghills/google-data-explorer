# Google Data Explorer - Setup

## 1. Google Cloud Project

Go to console.cloud.google.com

- Create a new project (or use existing)
- Go to APIs & Services > Library and enable:
  - People API
  - Google Calendar API
  - Gmail API
  - YouTube Data API v3
  - Fitness API
  - Tasks API
  - Google Drive API

## 2. OAuth Credentials

Go to APIs & Services > Credentials

- Click Create Credentials > OAuth client ID
- Application type: Web application
- Name: whatever you want
- Authorized redirect URIs: add your worker URL + /callback
  - e.g. https://google-data-explorer.your-subdomain.workers.dev/callback
  - for local testing: http://localhost:8787/callback
- Save the Client ID and Client Secret

If you haven't configured the OAuth consent screen yet:
- Go to APIs & Services > OAuth consent screen
- User type: External
- Add your email as a test user
- Fill in the minimum required fields
- Add the scopes for each API above

## 3. Deploy the Worker

```bash
cd google-data-explorer
npx wrangler secret put GOOGLE_CLIENT_ID
# paste your client ID

npx wrangler secret put GOOGLE_CLIENT_SECRET
# paste your client secret

npx wrangler secret put REDIRECT_URI
# paste: https://google-data-explorer.your-subdomain.workers.dev/callback

npx wrangler deploy
```

## 4. Test locally first (optional)

```bash
# Create a .dev.vars file with your secrets
echo 'GOOGLE_CLIENT_ID=your-id-here' > .dev.vars
echo 'GOOGLE_CLIENT_SECRET=your-secret-here' >> .dev.vars
echo 'REDIRECT_URI=http://localhost:8787/callback' >> .dev.vars

npx wrangler dev
```

Then open http://localhost:8787 and sign in.

## Notes

- The token is passed via URL parameter. This is fine for a personal 
  prototype but not production-grade. Later we'd move to encrypted 
  cookies or KV-backed sessions.
- Google OAuth consent screen in "Testing" mode limits to 100 test 
  users and tokens expire in 7 days. That's fine for now.
- Some APIs might return errors if you haven't used that service much.
  That's expected - the card will show the error and you move on.
