import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { decomposeResearchBrief, synthesizeResearch, runResearchWorkflow } from "./research.js";
import { exportDossier } from "./export.js";

const server = new Server(
  {
    name: "research-dossier-mcp",
    version: "0.2.0",
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
    name: "run_research_workflow",
    description:
      "End-to-end research pipeline: decomposes the brief into queries, runs a provider-native web search on each " +
      "query in parallel, aggregates and deduplicates the findings, and synthesizes them into a final dossier. " +
      "Use this instead of chaining decompose_research_brief + synthesize_research by hand.",
    inputSchema: {
      type: "object" as const,
      properties: {
        brief: {
          type: "string",
          description: "The research topic or question",
        },
        depth: {
          type: "string",
          enum: ["surface", "intermediate", "deep"],
          description: "Research depth level",
        },
        format: {
          type: "string",
          enum: ["markdown", "json", "outline"],
          description: "Dossier output format",
        },
        max_results_per_query: {
          type: "number",
          description: "Cap on distinct sources kept per query (1-10, default 6)",
        },
      },
      required: ["brief"],
    },
  },
  {
    name: "export_dossier",
    description:
      "Export synthesized research as markdown, a formatted PDF, or a slide-deck outline (JSON: { slides: [{ title, content, notes }] })",
    inputSchema: {
      type: "object" as const,
      properties: {
        dossier: {
          type: "string",
          description: "The synthesized dossier content (markdown)",
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

  try {
    switch (name) {
      case "decompose_research_brief": {
        const { brief, depth = "intermediate" } = args as { brief: string; depth?: string };
        const result = await decomposeResearchBrief(brief, depth);
        return textResult(result);
      }
      case "synthesize_research": {
        const {
          research_findings,
          brief,
          format = "markdown",
        } = args as { research_findings: string; brief: string; format?: string };
        const result = await synthesizeResearch(research_findings, brief, format);
        return textResult(result);
      }
      case "run_research_workflow": {
        const {
          brief,
          depth = "intermediate",
          format = "markdown",
          max_results_per_query,
        } = args as { brief: string; depth?: string; format?: string; max_results_per_query?: number };

        const workflow = await runResearchWorkflow(brief, depth, format, max_results_per_query);

        let notes = `\n\n---\n_Workflow notes: ${workflow.queriesRun} quer${
          workflow.queriesRun === 1 ? "y" : "ies"
        } run, ${workflow.sourcesGathered} unique source${workflow.sourcesGathered === 1 ? "" : "s"} gathered`;
        if (workflow.emptyQueries.length > 0) {
          notes += `, ${workflow.emptyQueries.length} quer${
            workflow.emptyQueries.length === 1 ? "y" : "ies"
          } returned no results (${workflow.emptyQueries.join("; ")})`;
        }
        notes += `. Citations: ${workflow.citations.valid}/${workflow.citations.total} valid`;
        if (workflow.citations.unmatched.length > 0) {
          notes += `, ${workflow.citations.unmatched.length} could not be matched to a gathered source (${workflow.citations.unmatched
            .slice(0, 5)
            .join("; ")})`;
        }
        notes += "._";

        return textResult(workflow.dossier + notes);
      }
      case "export_dossier": {
        const { dossier, format = "markdown" } = args as { dossier: string; format?: string };
        const exported = await exportDossier(dossier, format);

        if (exported.kind === "pdf") {
          return {
            content: [
              {
                type: "resource" as const,
                resource: {
                  uri: "dossier://export.pdf",
                  mimeType: "application/pdf",
                  blob: exported.buffer.toString("base64"),
                },
              },
            ],
          };
        }
        return textResult(exported.text);
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
});

function textResult(text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
  };
}

const transport = new StdioServerTransport();
server.connect(transport);
