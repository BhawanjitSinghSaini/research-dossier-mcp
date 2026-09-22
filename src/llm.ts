import Anthropic from "@anthropic-ai/sdk";

export type LLMProvider = "anthropic" | "gemini";

export interface SearchSource {
  url: string;
  title: string;
}

export interface QueryFindings {
  query: string;
  text: string;
  sources: SearchSource[];
  error?: string;
}

function resolveProvider(): LLMProvider {
  const configured = process.env.LLM_PROVIDER?.toLowerCase();
  if (configured === "anthropic" || configured === "gemini") return configured;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GEMINI_API_KEY) return "gemini";
  throw new Error(
    "No LLM configured. Set ANTHROPIC_API_KEY or GEMINI_API_KEY (optionally LLM_PROVIDER to force one)."
  );
}

export const provider = resolveProvider();

const anthropicClient =
  provider === "anthropic"
    ? new Anthropic(
        process.env.ANTHROPIC_WORKSPACE_ID
          ? { defaultHeaders: { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } }
          : undefined
      )
    : null;

export async function callLLM(system: string, userMessage: string, maxTokens: number): Promise<string> {
  if (provider === "anthropic") return callAnthropic(system, userMessage, maxTokens);
  return callGemini(system, userMessage, maxTokens);
}

async function callAnthropic(system: string, userMessage: string, maxTokens: number): Promise<string> {
  const response = await anthropicClient!.messages.create({
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find(
    (block): block is Extract<typeof block, { type: "text" }> => block.type === "text"
  );
  if (textBlock) return textBlock.text;
  throw new Error(
    `Unexpected response from Claude: no text block (got types: ${response.content.map((b) => b.type).join(", ")})`
  );
}

interface GeminiRequestBody {
  systemInstruction?: { parts: { text: string }[] };
  contents: { role: string; parts: { text: string }[] }[];
  tools?: Record<string, unknown>[];
  generationConfig: { maxOutputTokens: number; thinkingConfig?: { thinkingBudget: number } };
}

interface GeminiGroundingChunk {
  web?: { uri?: string; title?: string };
  uri?: string;
  title?: string;
}

interface GeminiGroundingSupport {
  segment?: { startIndex?: number; endIndex?: number; text?: string };
  groundingChunkIndices?: number[];
}

interface GeminiCandidate {
  content?: { parts?: { text?: string }[] };
  groundingMetadata?: {
    groundingChunks?: GeminiGroundingChunk[];
    groundingSupports?: GeminiGroundingSupport[];
  };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
}

/** Posts to Gemini's generateContent endpoint with retry/backoff and the thinkingConfig-unsupported fallback. */
async function geminiRequest(
  buildBody: (includeThinkingConfig: boolean) => GeminiRequestBody
): Promise<GeminiResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";

  const maxAttempts = 4;
  let lastError: Error | null = null;
  let includeThinkingConfig = true;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(includeThinkingConfig)),
      }
    );

    if (res.ok) {
      return (await res.json()) as GeminiResponse;
    }

    const body = await res.text();
    lastError = new Error(`Gemini API error (${res.status}): ${body}`);

    // Some models (e.g. lite variants) reject thinkingConfig outright; drop it and retry.
    if (res.status === 400 && includeThinkingConfig) {
      includeThinkingConfig = false;
      continue;
    }

    const retryable = res.status === 429 || res.status === 503;
    if (!retryable || attempt === maxAttempts) throw lastError;

    const retryDelayMatch = body.match(/"retryDelay":\s*"(\d+)s"/);
    const delayMs = retryDelayMatch ? Number(retryDelayMatch[1]) * 1000 : 1000 * 2 ** (attempt - 1);
    await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 60000)));
  }

  throw lastError ?? new Error("Gemini API request failed");
}

function extractGeminiText(response: GeminiResponse): string {
  const text = response.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
  if (!text) throw new Error("Unexpected response shape from Gemini");
  return text;
}

async function callGemini(system: string, userMessage: string, maxTokens: number): Promise<string> {
  const response = await geminiRequest((includeThinkingConfig) => ({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      ...(includeThinkingConfig ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  }));
  return extractGeminiText(response);
}

/** Runs a provider-native web search for one query and returns a citation-carrying summary plus the raw source list. */
export async function webSearch(query: string, maxResults: number): Promise<QueryFindings> {
  if (provider === "anthropic") return webSearchAnthropic(query, maxResults);
  return webSearchGemini(query, maxResults);
}

async function webSearchAnthropic(query: string, maxResults: number): Promise<QueryFindings> {
  const response = await anthropicClient!.messages.create({
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
    max_tokens: 1200,
    system:
      "You are a research assistant. Use the web_search tool to investigate the user's query, then write a " +
      "concise, factual summary (150-300 words) of what you found. Cite every specific claim inline, " +
      "immediately after it, as [Source: URL] using only URLs returned by web_search. Never invent a URL. " +
      "If search turns up nothing useful, say so plainly instead of speculating.",
    messages: [{ role: "user", content: `Research query: "${query}"` }],
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: Math.max(1, Math.min(maxResults, 5)),
      },
    ],
  });

  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  let text = "";

  for (const block of response.content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "web_search_tool_result") {
      const content = block.content;
      if (Array.isArray(content)) {
        for (const result of content) {
          if (!seen.has(result.url)) {
            seen.add(result.url);
            sources.push({ url: result.url, title: result.title });
          }
        }
      }
    }
  }

  return {
    query,
    text: text.trim() || "No summary was generated for this query.",
    sources: sources.slice(0, maxResults),
  };
}

async function webSearchGemini(query: string, maxResults: number): Promise<QueryFindings> {
  const response = await geminiRequest((includeThinkingConfig) => ({
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Research query: "${query}". Provide a concise, factual summary (150-300 words) of current, relevant information.`,
          },
        ],
      },
    ],
    tools: [{ google_search: {} }],
    generationConfig: {
      maxOutputTokens: 1200,
      ...(includeThinkingConfig ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
  }));

  const text = extractGeminiText(response);
  const metadata = response.candidates?.[0]?.groundingMetadata;
  const chunks = metadata?.groundingChunks ?? [];

  const sources: SearchSource[] = chunks
    .map((c) => ({ url: c.web?.uri ?? c.uri ?? "", title: c.web?.title ?? c.title ?? "" }))
    .filter((s) => s.url)
    .slice(0, maxResults);

  const cited = insertGeminiCitations(text, chunks, metadata?.groundingSupports ?? []);

  return { query, text: cited.trim() || "No summary was generated for this query.", sources };
}

/** Inserts [Source: URL] markers after the text spans Gemini's groundingSupports attribute to each search chunk. */
function insertGeminiCitations(
  text: string,
  chunks: GeminiGroundingChunk[],
  supports: GeminiGroundingSupport[]
): string {
  let result = text;
  let searchFrom = 0;

  for (const support of supports) {
    const segmentText = support.segment?.text;
    const chunkIndex = support.groundingChunkIndices?.[0];
    if (!segmentText || chunkIndex === undefined) continue;
    const url = chunks[chunkIndex]?.web?.uri ?? chunks[chunkIndex]?.uri;
    if (!url) continue;

    const pos = result.indexOf(segmentText, searchFrom);
    if (pos === -1) continue;

    const insertAt = pos + segmentText.length;
    const marker = ` [Source: ${url}]`;
    result = result.slice(0, insertAt) + marker + result.slice(insertAt);
    searchFrom = insertAt + marker.length;
  }

  return result;
}
