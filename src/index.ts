import Anthropic from "@anthropic-ai/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

type LLMProvider = "anthropic" | "gemini";

function resolveProvider(): LLMProvider {
  const configured = process.env.LLM_PROVIDER?.toLowerCase();
  if (configured === "anthropic" || configured === "gemini") return configured;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GEMINI_API_KEY) return "gemini";
  throw new Error(
    "No LLM configured. Set ANTHROPIC_API_KEY or GEMINI_API_KEY (optionally LLM_PROVIDER to force one)."
  );
}

const provider = resolveProvider();
const anthropicClient =
  provider === "anthropic"
    ? new Anthropic(
        process.env.ANTHROPIC_WORKSPACE_ID
          ? { defaultHeaders: { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } }
          : undefined
      )
    : null;

async function callLLM(
  system: string,
  userMessage: string,
  maxTokens: number
): Promise<string> {
  if (provider === "anthropic") return callAnthropic(system, userMessage, maxTokens);
  return callGemini(system, userMessage, maxTokens);
}

async function callAnthropic(
  system: string,
  userMessage: string,
  maxTokens: number
): Promise<string> {
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

async function callGemini(
  system: string,
  userMessage: string,
  maxTokens: number
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";

  const maxAttempts = 4;
  let lastError: Error | null = null;
  let includeThinkingConfig = true;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const generationConfig: { maxOutputTokens: number; thinkingConfig?: { thinkingBudget: number } } = {
      maxOutputTokens: maxTokens,
    };
    if (includeThinkingConfig) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: userMessage }] }],
          generationConfig,
        }),
      }
    );

    if (res.ok) {
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = data.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? "")
        .join("");
      if (!text) throw new Error("Unexpected response shape from Gemini");
      return text;
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
    const delayMs = retryDelayMatch
      ? Number(retryDelayMatch[1]) * 1000
      : 1000 * 2 ** (attempt - 1);
    await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 60000)));
  }

  throw lastError ?? new Error("Gemini API request failed");
}

const server = new Server(
  {
    name: "research-dossier-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const tools: Tool[] = [
  {
    name: "decompose_research_brief",
    description:
      "Break down a research brief into 5-7 focused research queries for parallel investigation",
    inputSchema: {
      type: "object" as const,
      properties: {
        brief: {
          type: "string",
          description:
            "The research topic or question (e.g., 'Competitive landscape for AI-powered expense reporting in APAC')",
        },
        depth: {
          type: "string",
          enum: ["surface", "intermediate", "deep"],
          description: "Research depth level",
        },
      },
      required: ["brief"],
    },
  },
  {
    name: "synthesize_research",
    description:
      "Synthesize research findings into a structured dossier with exec summary, sections, and citations",
    inputSchema: {
      type: "object" as const,
      properties: {
        research_findings: {
          type: "string",
          description:
            "Raw research data/notes from web_search results (JSON or text)",
        },
        brief: {
          type: "string",
          description: "Original research brief for context",
        },
        format: {
          type: "string",
          enum: ["markdown", "json", "outline"],
          description: "Output format",
        },
      },
      required: ["research_findings", "brief"],
    },
  },
  {
    name: "export_dossier",
    description: "Export synthesized research as markdown, JSON, or slide outline",
    inputSchema: {
      type: "object" as const,
      properties: {
        dossier: {
          type: "string",
          description: "The synthesized dossier content",
        },
        format: {
          type: "string",
          enum: ["markdown", "pdf-outline", "slide-outline"],
          description: "Export format",
        },
      },
      required: ["dossier", "format"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (!args) {
      throw new Error("Tool arguments are required");
    }

    let result: string;

    switch (name) {
      case "decompose_research_brief": {
        const { brief, depth = "intermediate" } = args as {
          brief: string;
          depth?: string;
        };
        result = await decomposeResearchBrief(brief, depth);
        break;
      }
      case "synthesize_research": {
        const { research_findings, brief, format = "markdown" } = args as {
          research_findings: string;
          brief: string;
          format?: string;
        };
        result = await synthesizeResearch(research_findings, brief, format);
        break;
      }
      case "export_dossier": {
        const { dossier, format = "markdown" } = args as {
          dossier: string;
          format?: string;
        };
        result = formatDossier(dossier, format);
        break;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: result,
        },
      ],
    };
});

async function decomposeResearchBrief(
  brief: string,
  depth: string
): Promise<string> {
  const system = `You are a research strategist. Decompose a research brief into 5-7 focused, non-overlapping research queries.

For depth level "${depth}":
- surface: Quick overview queries (3-5 min searches each)
- intermediate: Balanced research (5-10 min each)
- deep: Thorough investigation (10-15 min each, includes academic/proprietary sources)

Return ONLY a JSON array of query objects with "query" and "priority" fields. No markdown, no preamble.`;

  return callLLM(system, `Research brief: "${brief}"`, 1024);
}

async function synthesizeResearch(
  findings: string,
  brief: string,
  format: string
): Promise<string> {
  const system = `You are a research synthesis expert. Transform raw research findings into a polished dossier.

Structure (${format}):
- Executive Summary (200 words max)
- Key Findings (3-5 major points)
- Detailed Analysis (by topic, with citations)
- Trends & Implications
- Recommendations
- Sources

Use citations inline [Source: URL] where applicable.
Be factual. Flag uncertainties. Avoid speculation.`;

  const userMessage = `Research brief: "${brief}"

Raw findings:
${findings}`;

  return callLLM(system, userMessage, 3000);
}

function formatDossier(dossier: string, format: string): string {
  if (format === "pdf-outline" || format === "slide-outline") {
    return (
      dossier +
      "\n\n[Export to PDF/Slides: Use markdown with H1 for slide breaks]"
    );
  }
  return dossier;
}

const transport = new StdioServerTransport();
server.connect(transport);
