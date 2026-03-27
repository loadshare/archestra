const GEMINI_DEFAULT_BASE = "https://generativelanguage.googleapis.com";
const GEMINI_API_VERSION = "v1beta";

/**
 * Normalized embedding response — compatible with the shape expected by
 * `buildEmbeddingInteraction` and the rest of the embedding pipeline.
 */
export interface EmbeddingApiResponse {
  object: string;
  data: Array<{ object: string; embedding: number[]; index: number }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

export class GeminiApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GeminiApiError";
  }
}

/**
 * Embed a single text using Google's `embedContent` endpoint.
 * Returns the embedding values array.
 */
async function embedOne(params: {
  text: string;
  modelId: string;
  apiKey: string;
  base: string;
  dimensions?: number;
}): Promise<number[]> {
  const { text, modelId, apiKey, base, dimensions } = params;
  const url = `${base}/${GEMINI_API_VERSION}/${modelId}:embedContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      model: modelId,
      content: { parts: [{ text }] },
      ...(dimensions ? { outputDimensionality: dimensions } : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");

    throw new GeminiApiError(
      response.status,
      `Gemini embedding API error ${response.status}: ${errorText.slice(0, 200)}`,
    );
  }

  const result = (await response.json()) as {
    embedding?: { values: number[] };
  };

  return result.embedding?.values ?? [];
}

/**
 * Embed multiple texts using Google's `embedContent` endpoint (called per text)
 * and return an OpenAI-compatible embedding response.
 *
 * Gemini's native embedding API does not report token usage, so `prompt_tokens`
 * and `total_tokens` are always 0.
 */
export async function callGeminiBatchEmbed(params: {
  texts: string[];
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  dimensions?: number;
}): Promise<EmbeddingApiResponse> {
  const { texts, model, apiKey, baseUrl, dimensions } = params;

  // Always use the canonical Gemini API host for embeddings.
  // The configured baseUrl may point to the OpenAI-compatible layer
  // (e.g. /v1beta/openai) which does not expose embedContent.
  // Strip any path from the configured URL and fall back to the default.
  const base = (() => {
    const raw = baseUrl ?? GEMINI_DEFAULT_BASE;
    try {
      const { protocol, host } = new URL(raw);
      return `${protocol}//${host}`;
    } catch {
      return GEMINI_DEFAULT_BASE;
    }
  })();

  // Normalise to "models/gemini-embedding-001" format
  const modelId = model.startsWith("models/") ? model : `models/${model}`;

  const embeddings = await Promise.all(
    texts.map((text) => embedOne({ text, modelId, apiKey, base, dimensions })),
  );

  return {
    object: "list",
    data: embeddings.map((embedding, index) => ({
      object: "embedding",
      embedding,
      index,
    })),
    model,
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
}
