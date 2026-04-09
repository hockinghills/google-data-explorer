// Voyage AI embedding client
// Model: voyage-4-large at 2048 dimensions
// Every Activity node gets a semantic coordinate in meaning-space

const VOYAGE_MODEL = 'voyage-4-large';
const VOYAGE_DIMENSIONS = 2048;
const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const BATCH_SIZE = 128; // Stay well under 120K token limit

export { VOYAGE_DIMENSIONS };

// Build the embedding text for an activity node
export function embeddingText(node) {
  const parts = [node.title || ''];
  if (node.subtitles) parts.push(node.subtitles);
  if (node.description) parts.push(node.description);
  return parts.filter(Boolean).join(' — ').slice(0, 1000);
}

// Embed a batch of texts, returns array of 2048d float arrays
async function embedBatch(texts, apiKey) {
  const res = await fetch(VOYAGE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: texts,
      input_type: 'document',
      output_dimension: VOYAGE_DIMENSIONS,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Voyage API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.data.map(d => d.embedding);
}

// Embed all nodes in batches, returns Map<nodeId, float[]>
export async function embedNodes(nodes, apiKey) {
  if (!apiKey) return new Map();

  const texts = nodes.map(n => embeddingText(n));
  const embeddings = new Map();
  let embedded = 0;

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batchTexts = texts.slice(i, i + BATCH_SIZE);
    const batchNodes = nodes.slice(i, i + BATCH_SIZE);

    // Skip empty texts
    const validIndices = [];
    const validTexts = [];
    for (let j = 0; j < batchTexts.length; j++) {
      if (batchTexts[j].trim().length > 0) {
        validIndices.push(j);
        validTexts.push(batchTexts[j]);
      }
    }

    if (validTexts.length === 0) continue;

    try {
      const vectors = await embedBatch(validTexts, apiKey);
      for (let j = 0; j < validIndices.length; j++) {
        const node = batchNodes[validIndices[j]];
        embeddings.set(node.id, vectors[j]);
      }
      embedded += validTexts.length;
    } catch (e) {
      console.error(`Voyage batch ${i}-${i + BATCH_SIZE} failed:`, e.message);
      // Continue with remaining batches — partial embeddings are better than none
    }
  }

  console.log(`Embedded ${embedded}/${nodes.length} nodes`);
  return embeddings;
}

// Compute cosine distance between two vectors (0 = identical, 2 = opposite)
// Voyage vectors are already normalized to unit length, so cosine distance = 1 - dot product
export function cosineDistance(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return 1 - dot;
}
