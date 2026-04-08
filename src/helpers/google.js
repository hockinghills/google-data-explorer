export async function fetchGoogle(endpoint, token, params = {}) {
  const url = new URL(endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { error: res.status, message: await res.text() };
  return res.json();
}
