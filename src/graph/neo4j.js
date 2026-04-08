export async function neo4jQuery(env, statement, parameters = {}) {
  const host = env.NEO4J_URI.replace('neo4j+s://', '');
  const db = env.NEO4J_DATABASE || 'neo4j';
  const url = `https://${host}/db/${db}/query/v2`;
  const auth = btoa(`${env.NEO4J_USERNAME}:${env.NEO4J_PASSWORD}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ statement, parameters }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Neo4j HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const result = await res.json();
  if (result.errors && result.errors.length > 0) {
    throw new Error(`Neo4j query error: ${JSON.stringify(result.errors[0])}`);
  }
  return result;
}
