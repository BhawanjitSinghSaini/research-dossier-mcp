# Research Dossier Synthesizer MCP

Autonomous research synthesis tool for consultants. Decompose research briefs, conduct parallel investigations, synthesize findings into polished dossiers.

## Setup (Week 1)

```bash
npm install
npm run build
npm run dev
```

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

Add to ~/.config/Claude/claude.json (macOS/Linux) or %APPDATA%\Claude\claude.json (Windows):

```json
{
  "mcpServers": {
    "research-dossier": {
      "command": "node",
      "args": ["/path/to/research-dossier-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. MCP tools now available.

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

## This Week's Tasks

- [ ] Build & test locally (npm run dev)
- [ ] Tune synthesis prompt (see synthesizeResearch function)
- [ ] Manual test: "Research DevOps tooling consolidation"
- [ ] Refine output format (add section numbering, headers, etc.)
- [ ] Connect to Claude Desktop MCP config

## Next Week (Week 2)

- Add web_search integration (tools/list → include web_search)
- Build export pipeline (markdown -> PDF via API)
- Test with 3-5 consultant contacts
- Collect feedback on dossier quality/format

## Pricing Anchor

- MVP: Free beta (network)
- Phase 2: $49/mo (10/mo) or $149/mo (unlimited)
- White-label: Custom pricing by consulting firm size

## Notes

- Synthesis quality depends on prompt tuning. Expect 2-3 iterations.
- Citations critical for consultant trust. Test that [Source: URL] appears in output.
- Depth level should scale research time estimate (mention in Claude prompt).
