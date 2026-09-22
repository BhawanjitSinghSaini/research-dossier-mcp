# Research Dossier Synthesizer MCP

An MCP server for consultants: decompose research briefs into parallel search queries, synthesize raw findings into a structured dossier with citations, and export it for delivery.

## Setup

```bash
npm install
npm run build
npm run dev
```

The server needs at least one LLM provider configured via environment variables (see below) — it will fail to start without one.

## Configuration

Set these as environment variables (e.g. in a local `.env` file, or in the `env` block of your MCP client config):

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | one of these | Anthropic API key. Takes priority over Gemini if both are set. |
| `GEMINI_API_KEY` | one of these | Google Gemini API key. |
| `LLM_PROVIDER` | no | `anthropic` or `gemini` — forces a provider instead of auto-detecting from which key is present. |
| `ANTHROPIC_MODEL` | no | Defaults to `claude-sonnet-5`. |
| `GEMINI_MODEL` | no | Defaults to `gemini-flash-latest`. |
| `ANTHROPIC_WORKSPACE_ID` | no | Required only if your Anthropic API key is workspace-scoped (sends the `anthropic-workspace-id` header). |

Gemini's free tier has a low daily request quota per model — if you hit `429 RESOURCE_EXHAUSTED`, the server retries with backoff automatically, but a model-wide daily cap needs either waiting for it to reset, switching `GEMINI_MODEL` to one with separate quota, or enabling billing on the Google Cloud project.

## Tools

**decompose_research_brief**
- Input: Research topic, depth level (surface/intermediate/deep)
- Output: 5-7 focused research queries (JSON)
- Use: Break down complex briefs into parallel search tasks

**synthesize_research**
- Input: Raw research findings (web_search output), original brief
- Output: Structured dossier (markdown/JSON/outline)
- Use: Transform findings into exec summary + detailed sections + citations

**export_dossier**
- Input: Dossier content, format (markdown/pdf-outline/slide-outline)
- Output: Formatted export
- Use: Prepare for delivery (PDF slides, markdown, etc.)

## Integration with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "research-dossier": {
      "command": "node",
      "args": ["/path/to/research-dossier-mcp/dist/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Run `npm run build` first so `dist/index.js` exists. Fully quit and reopen Claude Desktop (not just close the window) to pick up config changes.

## Typical Workflow

1. **User** (you): "Research SaaS consolidation trends in APAC"
2. **decompose_research_brief**: Generates 6 queries:
   - SaaS consolidation metrics 2024-2026
   - APAC adoption rates by vertical
   - Cost savings benchmarks
   - Integration & vendor lock-in concerns
   - Regulatory drivers (India, Singapore, etc.)
   - Competitive landscape (Gartner, Forrester reports)
3. **Claude** (with web_search): Runs queries in parallel, collects findings
4. **synthesize_research**: Compiles findings into dossier:
   - Exec summary (200 words)
   - Key findings (3-5 points with citations)
   - Trends by region/vertical
   - Implications for consulting clients
5. **export_dossier**: Output as markdown → PDF slides, or send to client

## Notes

- Synthesis quality depends on prompt tuning — see `synthesizeResearch` in `src/index.ts`.
- Citations are requested inline as `[Source: URL]`; verify they appear when tuning the prompt further.
- `export_dossier` is pure formatting (no LLM call), so it needs no provider key by itself — but the server as a whole still requires one configured to start.
