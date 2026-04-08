export function loginPage() {
  return new Response(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Data Explorer</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0a0a; color: #e0e0e0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; }
  .container { text-align: center; padding: 2rem; }
  h1 { font-size: 2rem; margin-bottom: 0.5rem; color: #fff; }
  p { color: #888; margin-bottom: 2rem; font-size: 1.1rem; }
  a.button { display: inline-block; padding: 1rem 2rem; background: #2563eb;
    color: white; text-decoration: none; border-radius: 8px;
    font-size: 1.1rem; transition: background 0.2s; }
  a.button:hover { background: #1d4ed8; }
</style></head><body>
<div class="container">
  <h1>data explorer</h1>
  <p>see what google actually has on you</p>
  <a class="button" href="/login">sign in with google</a>
</div></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
