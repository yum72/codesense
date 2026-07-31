# CodeSense architecture

How the indexing and retrieval layers fit together. For setup see the
[README](../README.md); for every configuration key see
[configuration.md](configuration.md).

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

