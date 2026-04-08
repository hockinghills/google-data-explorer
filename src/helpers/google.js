export async function fetchGoogle(endpoint, token, params = {}) {
  const url = new URL(endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`Google API ${res.status}: ${message.slice(0, 200)}`);
  }
  return res.json();
}
