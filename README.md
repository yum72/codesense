# CodeSense

Your codebase's local brain.

CodeSense indexes a repository into a graph plus a vector store, then exposes it
over [MCP](https://modelcontextprotocol.io/) so an AI assistant can understand
the project before it writes anything. It runs entirely on your machine.

> [!WARNING]
> **Work in progress.** The pipeline runs end to end and the MCP tools work, but
> APIs and configuration keys still change between commits.

**Status:** work in progress · Node 20+ · needs Memgraph

## Why

Most AI coding tools focus on generating code. CodeSense focuses on what happens
before that: working out where a change belongs, what patterns the codebase
already follows, and what else breaks if you touch a given function.

That is a retrieval problem, not a generation problem, so CodeSense answers it
with a graph rather than a model. Call graphs, dependency edges and PageRank
answer "what is affected if I change this?" — a question plain text search
cannot. Vector embeddings handle the other half, where you know what you want in
words but not what it is called.

## Progressive indexing

Indexing never blocks you. Each tier adds capability as it finishes.

| Tier | What happens | Time | You get |
|------|--------------|------|---------|
| 0 | File scan and hashing | < 5s | grep search |
| 1 | AST parsing, graph building | 30s–2min | structural search, graph queries |
| 2 | Vector embeddings | 5–15min | semantic search |
| 3 | LLM enrichment | background | richer context in plans |

## Getting started

Requires Node 20+, Docker, and roughly 2GB of RAM for Memgraph.

```bash
git clone https://github.com/yum72/codesense.git
cd codesense
npm install

# Memgraph is required: it stores the graph and the vector index
docker compose up -d memgraph

# copy the example config, then index a project
cp codesense.config.example.json codesense.config.json
node src/index.js scan /path/to/your/project
```

A scan prints what it built:

```
Tier 0: Scanning files...
  Added: 36, Modified: 0, Deleted: 0, Unchanged: 0
Tier 1: Parsing AST...
  Parsed: 36, Failed: 0
Tier 2: Generating embeddings...
  Files: 36, Chunks: 964, Failed: 0
Building dependency graph...
  Files: 36, Edges: 907

✅ Indexing complete.
   Files: 36   Chunks: 964
   IMPORTS edges: 48   CALLS edges: 696   CONTAINS edges: 1928
```

Run `compute_graph_analytics` once after the first scan to populate PageRank,
which is what `find_hub_functions` and impact ranking use.

### Connecting an assistant

Add CodeSense to any MCP client. For Claude Code, put this in `.mcp.json` at the
root of the project you want indexed:

```json
{
  "mcpServers": {
    "codesense": {
      "command": "node",
      "args": ["/absolute/path/to/codesense/src/index.js", "mcp", "."],
      "env": { "LLM_API_KEY": "your-key-here" }
    }
  }
}
```

For Claude Desktop the same block goes in `claude_desktop_config.json`. The
`.` argument is the directory to index; pass an absolute path if the client does
not start in the project root.

LLM enrichment is optional. Without `LLM_API_KEY` everything except enrichment
and query understanding still works.

## Tools

| Tool | What it answers |
|------|-----------------|
| `search_codebase` | Find code by meaning, structure or regex |
| `generate_plan` | Where should this change go, and what does it touch |
| `investigate_bug` | Which code is on the path of this stack trace |
| `validate_diff` | Does this diff fit the codebase's patterns |
| `impact_analysis` | What breaks if I change this function |
| `trace_data_flow` | How does a value get from here to there |
| `find_hub_functions` | Which functions are most central |
| `get_call_graph` | Callers and callees around a function |
| `compute_graph_analytics` | Recompute PageRank and communities |
| `get_index_status` | What is indexed, how far, how many edges |
| `refresh_index` | Re-scan after changes |
| `enrich_chunk`, `get_enrichment_status` | LLM enrichment control |
| `get_plan`, `list_plans` | Stored plans |
| `get_config` | Effective configuration |

## Configuration

Copy `codesense.config.example.json` to `codesense.config.json`. The defaults
enable everything except LLM features, which need a key.

The keys most worth knowing:

| Key | Effect |
|-----|--------|
| `indexing.maxTier` | How far to index. `0` files, `1` +AST/graph, `2` +embeddings |
| `graph.metrics` | Enables PageRank and community detection |
| `llm.enabled` | Enrichment and query understanding. Needs `LLM_API_KEY` |
| `llm.provider` | `openrouter`, `openai` or `ollama` for local models |

Full reference in [docs/configuration.md](docs/configuration.md).

## Tech stack

| Component | Technology | Why |
|-----------|------------|-----|
| Runtime | Node.js 20+ | MCP SDK, ESM |
| Database | Memgraph | Graph queries, vector search, PageRank in one engine |
| AST parser | web-tree-sitter | WASM grammars, no native build step |
| Embeddings | @xenova/transformers | Local, free, no API call per chunk |
| Text search | @vscode/ripgrep | Bundled binary, nothing to install |
| LLM | Vercel AI SDK | Swap providers without touching call sites |
| Protocol | MCP over stdio | Works with Claude Code, Claude Desktop, Cursor |

## Documentation

- [Architecture](docs/architecture.md) — the layers and how data moves between them
- [Configuration](docs/configuration.md) — every key and preset
- [Examples](docs/examples.md) — worked sessions

## Roadmap

Done: progressive indexing through Tier 2, Memgraph graph and vector search,
the MCP server and its tools, plan generation, bug investigation, diff
validation, background enrichment, PageRank and community detection.

Next: file watching for automatic reindex, a VS Code extension, and a web UI for
browsing the index.

## License

MIT
