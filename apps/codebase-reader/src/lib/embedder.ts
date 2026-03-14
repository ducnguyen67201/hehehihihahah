/**
 * Batch embedding utility.
 * Supports Voyage AI (voyage-code-3) and OpenAI (text-embedding-3-small/large).
 *
 * Voyage batches up to 128 inputs per request.
 * OpenAI batches up to 2048 inputs per request.
 * Both implementations chunk large arrays into smaller batches.
 */

const VOYAGE_BATCH_SIZE = 128;
const OPENAI_BATCH_SIZE = 512;

export async function embedBatch(
  texts: string[],
  opts: {
    model: string;
    dimensions: number;
    voyageApiKey?: string;
    openAiApiKey?: string;
  },
): Promise<number[][]> {
  if (texts.length === 0) return [];

  if (opts.model.startsWith("voyage")) {
    return embedVoyage(texts, opts.model, opts.voyageApiKey ?? "");
  }
  return embedOpenAI(texts, opts.model, opts.dimensions, opts.openAiApiKey ?? "");
}

async function embedVoyage(
  texts: string[],
  model: string,
  apiKey: string,
): Promise<number[][]> {
  const { VoyageAIClient } = await import("voyageai");
  const client = new VoyageAIClient({ apiKey });

  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += VOYAGE_BATCH_SIZE) {
    const batch = texts.slice(i, i + VOYAGE_BATCH_SIZE);
    const response = await client.embed({
      model,
      input: batch,
      inputType: "document",
    });

    const embeddings = response.data?.map((d) => d.embedding ?? []) ?? [];
    results.push(...embeddings);
  }

  return results;
}

async function embedOpenAI(
  texts: string[],
  model: string,
  dimensions: number,
  apiKey: string,
): Promise<number[][]> {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey });

  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += OPENAI_BATCH_SIZE) {
    const batch = texts.slice(i, i + OPENAI_BATCH_SIZE);
    const response = await client.embeddings.create({
      model,
      input: batch,
      dimensions,
    });

    const embeddings = response.data.map((d) => d.embedding);
    results.push(...embeddings);
  }

  return results;
}
