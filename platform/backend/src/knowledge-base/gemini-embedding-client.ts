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
 * Call Google's `batchEmbedContents` endpoint and return an OpenAI-compatible
 * embedding response.
 *
 * Gemini's native embedding API does not report token usage, so `prompt_tokens`
 * and `total_tokens` are always 0.
 */
export async function callGeminiBatchEmbed(params: {
  texts: string[];
  model: string;
  apiKey: string;
  baseUrl?: string | null;
}): Promise<EmbeddingApiResponse> {
  const { texts, model, apiKey, baseUrl } = params;
  const base = baseUrl ?? GEMINI_DEFAULT_BASE;

  // Normalise to "models/text-embedding-004" format
  const modelId = model.startsWith("models/") ? model : `models/${model}`;
  const url = `${base}/${GEMINI_API_VERSION}/${modelId}:batchEmbedContents?key=${apiKey}`;

  const body = {
    requests: texts.map((text) => ({
      model: modelId,
      content: { parts: [{ text }] },
    })),
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new GeminiApiError(
      response.status,
      `Gemini embedding API error ${response.status}: ${errorText.slice(0, 200)}`,
    );
  }

  const result = (await response.json()) as {
    embeddings?: Array<{ values: number[] }>;
  };

  const embeddings = result.embeddings ?? [];

  return {
    object: "list",
    data: embeddings.map((e, index) => ({
      object: "embedding",
      embedding: e.values,
      index,
    })),
    model,
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
}
