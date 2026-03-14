/**
 * Thin embedding wrapper used by the tRPC codebase router for semantic search.
 * Supports Voyage AI (voyage-code-3) and OpenAI (text-embedding-3-small) models.
 * The heavy embedding SDK is only loaded at query time.
 */

export async function embedQuery(text: string): Promise<number[]> {
  const model = process.env["EMBEDDING_MODEL"] ?? "voyage-code-3";
  const dimensions = parseInt(process.env["EMBEDDING_DIMENSIONS"] ?? "1024", 10);

  if (model.startsWith("voyage")) {
    const voyageKey = process.env["VOYAGE_API_KEY"];
    if (!voyageKey) {
      throw new Error("VOYAGE_API_KEY is required for Voyage embedding models");
    }
    const { VoyageAIClient } = await import("voyageai");
    const client = new VoyageAIClient({ apiKey: voyageKey });
    const result = await client.embed({
      model,
      input: [text],
      inputType: "query",
    });
    const embedding = result.data?.[0]?.embedding;
    if (!embedding) throw new Error("Voyage embedding response was empty");
    return embedding;
  }

  // OpenAI fallback
  const openAiKey = process.env["OPENAI_API_KEY"];
  if (!openAiKey) {
    throw new Error("OPENAI_API_KEY is required for OpenAI embedding models");
  }
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey: openAiKey });
  const result = await client.embeddings.create({
    model,
    input: text,
    dimensions,
  });
  const embedding = result.data[0]?.embedding;
  if (!embedding) throw new Error("OpenAI embedding response was empty");
  return embedding;
}
