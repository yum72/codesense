# CodeSense

**Your codebase's local brain.**

CodeSense is an AI-powered codebase understanding engine that runs entirely on your machine. It creates a comprehensive index of your code and exposes it via [MCP (Model Context Protocol)](https://modelcontextprotocol.io/), enabling AI assistants like Claude and Cursor to understand your project deeply before writing a single line of code.

---

## Philosophy

### Planning First, Coding Second

Most AI coding tools focus on code generation and autocomplete. CodeSense takes a different approach: **it focuses on the pre-implementation phase**.

Before an AI writes code, it needs to understand:
- Where should changes be made?
- What patterns does this codebase follow?
- What are the risks and side effects?
- Which files are connected to each other?

**The quality of AI-generated code is directly proportional to the quality of context it receives.** A model with poor context will hallucinate file paths, invent APIs that don't exist, and ignore architectural patterns. CodeSense solves this by building a rich, queryable understanding of your codebase that AI assistants can tap into.

### Graph First, AI Second

CodeSense uses a hybrid approach powered by **Memgraph**, a high-performance graph database:

1. **Graph-Based Analysis** - Call graphs, dependency tracking, PageRank, and community detection provide deep structural understanding
2. **Semantic Search** - Vector embeddings enable natural language queries ("where is authentication handled?")
3. **Research Agent Enrichment** - An agentic LLM explores the code graph to build rich context before enriching each function

The graph-based analysis enables powerful queries like "what code is affected if I change this function?" that would be impossible with traditional indexing.

### Progressive, Not Blocking

CodeSense never blocks you from working:

| Tier | What Happens | Time | You Can |
|------|--------------|------|---------|
| 0 | File scan + hashing | < 5s | Use grep search |
| 1 | AST parsing + graph | 30s-2min | Use structural search, graph queries |
| 2 | Vector embeddings | 5-15min | Use semantic search |
| 3 | LLM enrichment | Background | Get rich context in plans |

You can start working immediately. Quality improves progressively as indexing completes.

---

## How It Works

CodeSense builds understanding through layered analysis:

```
┌───────────────────────────────────────────────────────────────────────────┐
│                          MCP SERVER (Node.js)                             │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                      LAYER 3: PRODUCT                               │  │
│  │   generate_plan | investigate_bug | impact_analysis | find_hubs     │  │
│  └────────────────────────────────────┬────────────────────────────────┘  │
│                                       │                                   │
│  ┌────────────────────────────────────▼────────────────────────────────┐  │
│  │                      LAYER 2: RETRIEVAL                             │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │  │
│  │  │   SEMANTIC   │  │  STRUCTURAL  │  │    GREP      │               │  │
│  │  │   (vectors)  │  │  (graph/AST) │  │   (regex)    │               │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │  │
│  │                           │                                         │  │
│  │                  CONTEXT ASSEMBLER                                  │  │
│  │         (Combines results + enrichment for LLM)                     │  │
│  └────────────────────────────┬────────────────────────────────────────┘  │
│                               │                                           │
│  ┌────────────────────────────▼────────────────────────────────────────┐  │
│  │                      RESEARCH AGENT                                 │  │
│  │  ┌──────────────────┐         ┌──────────────────────┐              │  │
│  │  │  AGENTIC LOOP    │         │   GRAPH EXPLORATION   │             │  │
│  │  │  - Tool calls    │         │   - Callers/Callees   │             │  │
│  │  │  - Multi-hop     │         │   - File siblings     │             │  │
│  │  │  - Grep search   │         │   - Semantic search   │             │  │
│  │  └──────────────────┘         └──────────────────────┘              │  │
│  └────────────────────────────┬────────────────────────────────────────┘  │
│                               │                                           │
│  ┌────────────────────────────▼────────────────────────────────────────┐  │
│  │                      LAYER 1: UNDERSTANDING                         │  │
│  │  File Scan → Parse (AST) → Resolve Modules → Build Graph → Embed    │  │
│  └────────────────────────────┬────────────────────────────────────────┘  │
│                               │                                           │
│  ┌────────────────────────────▼────────────────────────────────────────┐  │
│  │                      LAYER 0: DATA                                  │  │
│  │               Memgraph (Graph DB + Vector Search)                   │  │
│  │   (files, chunks, call graph, PageRank, communities, embeddings)    │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
```

### Layer 0: Data

Everything lives in **Memgraph**, a high-performance graph database:
- **Files** - Path, hash, size, modification time
- **Chunks** - Functions, classes, modules as graph nodes
- **Relationships** - CALLS, IMPORTS, CONTAINS edges in the graph
- **PageRank** - Importance scores for hub function detection
- **Communities** - Automatically detected code clusters
- **Vectors** - Embeddings for semantic search (built-in vector index)
- **Enrichment** - LLM-generated summaries, patterns, risks

### Layer 1: Understanding

The indexing pipeline:

1. **Scanner** - Discovers files, respects `.gitignore`, computes hashes for change detection
2. **AST Parser** - Uses Tree-sitter to extract definitions, imports, and calls
3. **Module Resolver** - Resolves imports to actual file paths (handles aliases like `@/`)
4. **Graph Builder** - Builds the dependency graph, calculates fan-in/fan-out metrics
5. **Chunker** - Splits code into semantic units (functions, classes, modules)
6. **Embedder** - Generates vector embeddings using local transformers

### Layer 2: Retrieval

Three complementary search methods:

| Method | Best For | Requires |
|--------|----------|----------|
| **Semantic** | Natural language queries ("auth logic", "payment handling") | Tier 2 (embeddings) |
| **Structural** | Precise lookups ("find function calculateTax", "imports of utils.js") | Tier 1 (AST) |
| **Grep** | Regex patterns, literal strings | Tier 0 (files only) |

The **Context Assembler** combines results from all methods, deduplicates, ranks by relevance, and packages context for LLM consumption.

### Layer 3: Product

MCP tools that AI assistants can call:

- `search_codebase` - Multi-method code search
- `generate_plan` - Create implementation plans for features/bugs
- `investigate_bug` - Analyze stack traces and generate hypotheses
- `validate_diff` - Check if a diff matches a plan
- `get_index_status` - Check indexing progress

### Enrichment Engine

High-value code gets LLM analysis:

- **Summary** - One-sentence description
- **Purpose** - Business/technical motivation
- **Key Operations** - What the code does
- **Side Effects** - Database writes, API calls, emails
- **Design Patterns** - Factory, Singleton, Repository, etc.
- **Security Concerns** - Potential vulnerabilities
- **Business Rules** - Domain logic encoded in the code

Enrichment is **priority-based**: files with high fan-in (imported by many others) get enriched first.

---

## Getting Started

### Prerequisites

- **Node.js 20+**
- **Docker & Docker Compose** (for Memgraph)
- **An MCP-compatible client** (Claude Desktop, Cursor, or similar)
- **Optional**: OpenRouter/OpenAI API key for LLM features

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/codesense.git
cd codesense

# Install dependencies
npm install

# Start Memgraph (required)
docker-compose up -d memgraph memgraph-lab
```

### Docker Setup

CodeSense requires Memgraph for graph storage. Start it with:

```bash
# Start Memgraph and Memgraph Lab (web UI)
docker-compose up -d

# View Memgraph Lab at http://localhost:3000
```

The `docker-compose.yml` includes:
- **Memgraph** - Graph database on port 7687
- **Memgraph Lab** - Web UI on port 3000
- **CodeSense** - MCP server (optional, can run locally)

### Configuration

Create a `codesense.config.json` in your project root (optional - sensible defaults are used):

```json
{
  "memgraph": {
    "url": "bolt://localhost:7687",
    "username": "",
    "password": ""
  },
  "indexing": {
    "enabled": true,
    "maxTier": 2
  },
  "search": {
    "semantic": true,
    "structural": true,
    "grep": true
  },
  "llm": {
    "enabled": true,
    "provider": "openrouter",
    "model": "anthropic/claude-3-haiku"
  },
  "researchAgent": {
    "enabled": true,
    "maxToolCalls": 12,
    "maxDepth": 2
  },
  "graphAnalytics": {
    "computePageRank": true,
    "computeCommunities": true
  }
}
```

Set your API key in `.env`:

```bash
# For cloud LLM (OpenRouter, OpenAI)
LLM_API_KEY=your-api-key-here

# Or use local Ollama
LLM_PROVIDER=ollama
LLM_BASE_URL=http://localhost:11434
LLM_MODEL=llama3
```

### Running CodeSense

#### Option 1: Index Only (CLI)

```bash
# Scan and index a project
node src/index.js scan /path/to/your/project
```

#### Option 2: MCP Server

```bash
# Start the MCP server
node src/index.js mcp /path/to/your/project
```

### Connecting to Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "codesense": {
      "command": "node",
      "args": ["/path/to/codesense/src/index.js", "mcp", "/path/to/your/project"]
    }
  }
}
```

### Connecting to Cursor

Add to Cursor's MCP settings:

```json
{
  "mcpServers": {
    "codesense": {
      "command": "node",
      "args": ["/path/to/codesense/src/index.js", "mcp", "."]
    }
  }
}
```

---

## Available Tools

### Core Tools

### search_codebase

Search your codebase using natural language or regex.

```
Query: "where is user authentication handled"
Method: all | semantic | structural | grep
Limit: 10
```

### generate_plan

Generate a senior-level implementation plan for a feature or bug fix.

```
Task: "Add rate limiting to API endpoints"
Mode: fast | thorough
```

Returns:
- Files to modify
- Step-by-step implementation guide
- Risks and considerations
- Related code context

### investigate_bug

Analyze a stack trace and generate investigation hypotheses.

```
Stack Trace: "TypeError: Cannot read property 'id' of undefined\n    at UserService.getUser..."
```

Returns:
- Parsed stack frames with file locations
- Relevant code context
- Potential root causes
- Suggested investigation steps

### validate_diff

Check if a code change matches the original plan.

```
Diff: "<unified diff content>"
Plan ID: "plan_abc123"
```

---

### Graph Intelligence Tools

These tools leverage Memgraph's graph capabilities for deep code understanding:

### impact_analysis

Analyze what code is affected if you change a function.

```
Chunk ID: "src/auth/login.js::authenticateUser::function"
Max Depth: 10
```

Returns:
- All functions that depend on the target (directly or transitively)
- Grouped by file for easy review
- Distance from the target function

### trace_data_flow

Find the path data takes between two functions.

```
Source Chunk ID: "src/api/handler.js::parseRequest::function"
Target Chunk ID: "src/db/query.js::executeQuery::function"
```

Returns:
- Shortest path through the call graph
- Each function in the chain

### find_hub_functions

Find the most important "hub" functions using PageRank.

```
Limit: 20
```

Returns:
- Functions ordered by PageRank score
- Higher scores = more central/critical functions
- Great for understanding codebase architecture

### get_call_graph

Get the call graph for a specific function.

```
Chunk ID: "src/services/user.js::createUser::function"
Depth: 2
```

Returns:
- What the function calls (callees)
- What calls the function (callers)
- Enrichment summary if available

### compute_graph_analytics

Compute PageRank and community detection for the codebase.

```
(No parameters)
```

Returns:
- Number of chunks updated with PageRank scores
- Number of communities detected

Run this after indexing to enable `find_hub_functions`.

---

### Index & Status Tools

### get_index_status

Check the current state of the codebase index.

Returns:
- Total files indexed
- Indexing tier progress
- Enrichment queue status
- Last update time

### refresh_index

Re-scan the codebase and update the index with changes.

### get_config

View the current configuration and enabled features.

---

## Configuration Reference

### Full Configuration Options

```json
{
  "memgraph": {
    "url": "bolt://localhost:7687",
    "username": "",
    "password": "",
    "database": "memgraph"
  },
  "indexing": {
    "enabled": true,
    "maxTier": 2,
    "scanBatchSize": 50,
    "dbBatchSize": 100,
    "maxFileSizeKb": 500,
    "ignoredDirs": ["node_modules", "dist", ".git", "build", "out", "coverage"]
  },
  "enrichment": {
    "enabled": true,
    "backgroundQueue": true,
    "onDemand": true,
    "dailyLimit": 1000,
    "batchSize": 5,
    "maxRetries": 3
  },
  "researchAgent": {
    "enabled": true,
    "maxToolCalls": 12,
    "maxDepth": 2,
    "maxFilesPerHop": 5
  },
  "graphAnalytics": {
    "computePageRank": true,
    "computeCommunities": true,
    "pageRankDamping": 0.85
  },
  "search": {
    "semantic": true,
    "structural": true,
    "grep": true,
    "queryUnderstanding": true,
    "defaultLimit": 10,
    "maxContextTokens": 8000
  },
  "planning": {
    "enabled": true,
    "persistence": true,
    "bugInvestigator": true,
    "diffValidator": true
  },
  "llm": {
    "enabled": true,
    "provider": "openrouter",
    "apiKey": null,
    "baseUrl": null,
    "model": "anthropic/claude-3-haiku",
    "embeddingModel": "Xenova/all-MiniLM-L6-v2",
    "embeddingDimension": 384
  },
  "logging": {
    "level": "info",
    "verbose": false
  }
}
```

### Configuration Options Explained

#### memgraph

| Option | Default | Description |
|--------|---------|-------------|
| `url` | `"bolt://localhost:7687"` | Memgraph Bolt connection URL |
| `username` | `""` | Database username (optional) |
| `password` | `""` | Database password (optional) |
| `database` | `"memgraph"` | Database name |

#### indexing

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable indexing entirely |
| `maxTier` | `2` | Maximum indexing tier (0=files, 1=AST, 2=embeddings) |
| `scanBatchSize` | `50` | Files to hash per batch |
| `dbBatchSize` | `100` | Rows per database transaction |
| `maxFileSizeKb` | `500` | Skip files larger than this |
| `ignoredDirs` | `[...]` | Directories to ignore |

#### enrichment

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable LLM enrichment |
| `backgroundQueue` | `true` | Process enrichment in background |
| `onDemand` | `true` | Allow sync enrichment requests |
| `dailyLimit` | `1000` | Max LLM calls per day |
| `batchSize` | `5` | Chunks to enrich per batch |
| `maxRetries` | `3` | Retry attempts on failure |

#### search

| Option | Default | Description |
|--------|---------|-------------|
| `semantic` | `true` | Enable vector similarity search |
| `structural` | `true` | Enable AST-based lookups |
| `grep` | `true` | Enable regex pattern matching |
| `queryUnderstanding` | `true` | Use LLM to classify queries |
| `defaultLimit` | `10` | Default result limit |
| `maxContextTokens` | `8000` | Max tokens in assembled context |

#### planning

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable plan generation |
| `persistence` | `true` | Save plans to database |
| `bugInvestigator` | `true` | Enable bug investigation |
| `diffValidator` | `true` | Enable diff validation |

#### researchAgent

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable Research Agent for enrichment |
| `maxToolCalls` | `12` | Max tool calls per research session |
| `maxDepth` | `2` | Max hops through call graph |
| `maxFilesPerHop` | `5` | Max files to explore per hop |
| `maxGrepResults` | `50` | Max grep search results per call |

**Research Agent Tools**: The agent can use these tools during research:
- `read_chunk(id)` - Read full code of a chunk
- `get_callers(id, depth)` - Find what calls this chunk
- `get_callees(id, depth)` - Find what this chunk calls
- `get_file_siblings(id)` - Get other chunks in the same file
- `search_similar(query, limit)` - Semantic search for related code
- `search_grep(pattern, limit)` - Grep for literal patterns (event names, string invocations, magic strings)

#### graphAnalytics

| Option | Default | Description |
|--------|---------|-------------|
| `computePageRank` | `true` | Compute PageRank for hub detection |
| `computeCommunities` | `true` | Detect code communities/clusters |
| `pageRankDamping` | `0.85` | PageRank damping factor |

#### llm

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable LLM features |
| `provider` | `"openrouter"` | LLM provider (openrouter, openai, ollama, custom) |
| `apiKey` | `null` | API key (or use `LLM_API_KEY` env var) |
| `baseUrl` | `null` | Custom API endpoint |
| `model` | `"anthropic/claude-3-haiku"` | Model to use |
| `embeddingModel` | `"Xenova/all-MiniLM-L6-v2"` | Local embedding model |
| `embeddingDimension` | `384` | Embedding vector size |

### Preset Configurations

#### Minimal (No LLM, grep only)

```json
{
  "indexing": { "maxTier": 0 },
  "llm": { "enabled": false },
  "search": { "semantic": false, "structural": false },
  "enrichment": { "enabled": false },
  "planning": { "enabled": false }
}
```

#### AST Only (Structural search, no embeddings)

```json
{
  "indexing": { "maxTier": 1 },
  "search": { "semantic": false },
  "llm": { "enabled": true }
}
```

#### Full (All features)

Use defaults or create an empty config file.

---

## Example Usage

### Example 1: Understanding a New Codebase

```
You: I just cloned this project. Can you help me understand the architecture?

Claude: I'll search the codebase to understand its structure.

[Calls search_codebase with query "main entry point application setup"]
[Calls get_index_status to see what's indexed]

Based on my search, this is a Node.js application with:
- Entry point at `src/index.js`
- MCP server implementation in `src/mcp/server.js`
- Layered architecture with indexing, search, planning, and enrichment modules
- SQLite database for persistence

The main components are:
1. **Indexing** (`src/indexing/`) - Scans and parses code
2. **Search** (`src/search/`) - Multi-method code search
3. **Planning** (`src/planning/`) - Implementation plan generation
4. **Enrichment** (`src/enrichment/`) - LLM-powered code analysis
```

### Example 2: Planning a Feature

```
You: I want to add rate limiting to the API endpoints. Can you create a plan?

Claude: I'll generate an implementation plan for this feature.

[Calls generate_plan with task "Add rate limiting to API endpoints" mode "thorough"]

Here's the implementation plan:

## Rate Limiting Implementation

### Files to Modify
1. `src/mcp/server.js` - Add rate limiting middleware
2. `src/utils/config.js` - Add rate limit configuration options

### Implementation Steps

1. **Add rate limiting configuration**
   - Add `rateLimit.enabled`, `rateLimit.windowMs`, `rateLimit.maxRequests` to config schema
   
2. **Create rate limiter utility**
   - Implement token bucket or sliding window algorithm
   - Store state in SQLite for persistence across restarts
   
3. **Integrate with MCP server**
   - Wrap tool handlers with rate limit check
   - Return appropriate error when limit exceeded

### Risks
- State persistence adds database writes
- Clock skew could affect distributed setups

### Related Code
- Config loading: `src/utils/config.js:99-196`
- Server initialization: `src/mcp/server.js:30-100`
```

### Example 3: Investigating a Bug

```
You: I'm getting this error:
TypeError: Cannot read property 'search' of null
    at QueryEngine.search (src/search/query-engine.js:45:23)
    at handleSearch (src/mcp/server.js:312:28)

Claude: Let me investigate this stack trace.

[Calls investigate_bug with the stack trace]

## Bug Analysis

### Stack Trace Summary
- Error occurs in `QueryEngine.search` at line 45
- Called from `handleSearch` in the MCP server

### Root Cause
The `semanticSearch` component is `null` because:
1. `search.semantic` is enabled in config
2. But `indexing.maxTier` is set to 1 (requires tier 2)
3. Config validation should have disabled semantic search, but the query engine wasn't updated

### Fix
In `src/search/query-engine.js:45`, add a null check:

```javascript
if (method === 'semantic' && !this.semanticSearch) {
  return { results: [], error: 'Semantic search not available' };
}
```

### Related Files
- `src/search/query-engine.js` - Query orchestration
- `src/utils/config.js` - Config validation
```

### Example 4: Validating a Change

```
You: I made some changes. Can you check if they match the plan?

Claude: I'll validate your diff against the plan.

[Calls validate_diff with the diff and plan ID]


```

---

## Tech Stack

| Component | Technology | Why |
|-----------|------------|-----|
| Runtime | Node.js 20+ | MCP SDK, ESM support |
| Database | Memgraph | Graph DB with vector search, PageRank, communities |
| AST Parser | web-tree-sitter | Cross-platform WASM |
| Embeddings | @xenova/transformers | Local, free, fast |
| Grep Search | @vscode/ripgrep | Bundled binary, no system install |
| LLM | Vercel AI SDK | Provider-independent |
| Protocol | MCP (stdio) | Claude/Cursor integration |
| Container | Docker | Easy deployment with docker-compose |

---

## Status

**Current: Beta (Memgraph Edition)**

- [x] Tier 0: File scanning and hashing
- [x] Tier 1: AST parsing and graph building  
- [x] Tier 2: Vector embeddings and semantic search
- [x] MCP server with core tools
- [x] Plan generation
- [x] Bug investigation
- [x] Diff validation
- [x] Background enrichment queue
- [x] Feature flag system
- [x] **Memgraph integration** - Graph database with vector search
- [x] **Research Agent** - Agentic LLM exploration for enrichment
- [x] **Graph Intelligence Tools** - Impact analysis, hub detection, data flow tracing
- [x] **PageRank & Community Detection** - Identify important code and clusters
- [x] **Docker support** - Easy deployment with docker-compose
- [ ] File watcher for auto-reindex
- [ ] VS Code extension
- [ ] Web UI for browsing index

---

## License

MIT
