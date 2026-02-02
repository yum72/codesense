# CodeSense: Memgraph Migration Plan

**Version:** 3.0  
**Status:** Ready for Implementation  
**Migration:** SQLite + sqlite-vec → Memgraph (In-Memory Graph Database)  
**Key Feature:** Research Agent Enrichment with Context Tier System

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Analysis](#2-current-state-analysis)
3. [Target Architecture](#3-target-architecture)
4. [Context Tier System](#4-context-tier-system)
5. [Research Agent Enrichment](#5-research-agent-enrichment)
6. [Memgraph Schema](#6-memgraph-schema)
7. [Implementation Phases](#7-implementation-phases)
8. [Module Migration Guide](#8-module-migration-guide)
9. [Configuration](#9-configuration)
10. [Deployment](#10-deployment)

---

## 1. Executive Summary

### Why Memgraph?

| Current (SQLite) | Target (Memgraph) |
|------------------|-------------------|
| Recursive CTEs for graph traversal (slow, complex) | Native Cypher queries (fast, intuitive) |
| Two systems: SQLite + sqlite-vec | One system: Graph + Vectors + State |
| No graph algorithms | PageRank, Community Detection, Betweenness |
| Separate vector search then graph query | Combined vector + graph in single query |
| 5-50ms per query | 0.1-1ms per query (in-memory) |

### Key Innovation: Research Agent Enrichment

Instead of 1-shot LLM enrichment (limited context), we implement a **Research Agent** that:
1. Explores the graph to gather context
2. Captures spillover knowledge about neighbors
3. Creates tiered enrichment (full/partial/structural)
4. Embeds AFTER enrichment for maximum quality

---

## 2. Current State Analysis

### What Exists (SQLite-based, ~90% Complete)

```
src/
├── db/
│   ├── adapter.js          ✅ 762 lines, full CRUD
│   └── schema.sql          ✅ 212 lines, complete schema
├── indexing/
│   ├── scanner.js          ✅ File discovery, hashing
│   ├── ast-parser.js       ✅ Tree-sitter parsing
│   ├── chunker.js          ✅ Smart chunking, JSDoc extraction
│   ├── embedder.js         ✅ MiniLM embeddings
│   ├── graph-builder.js    ✅ Import/call relationships
│   ├── index-builder.js    ✅ In-memory maps
│   ├── index-manager.js    ✅ Tier orchestration
│   ├── module-resolver.js  ✅ Path alias resolution
│   └── representation-builder.js ✅ Contextual embeddings
├── search/
│   ├── semantic-search.js  ✅ Vector search (dual embedding)
│   ├── grep-search.js      ✅ Ripgrep wrapper
│   ├── structural-search.js ✅ AST-based search
│   ├── query-engine.js     ✅ Unified search
│   └── query-understanding.js ✅ Intent classification
├── enrichment/
│   ├── hierarchical-enricher.js ✅ LLM enrichment
│   ├── background-queue.js ✅ Async processing
│   ├── on-demand-enricher.js ✅ Sync enrichment
│   ├── prioritizer.js      ✅ Graph-guided priority
│   └── cache-manager.js    ✅ Cache invalidation
├── planning/
│   ├── context-assembler.js ✅ LLM context building
│   ├── plan-generator.js   ✅ Plan generation
│   ├── bug-investigator.js ✅ Bug analysis
│   └── diff-validator.js   ✅ Diff validation
├── llm/
│   ├── client.js           ✅ Multi-provider support
│   └── schemas.js          ✅ Zod schemas
├── mcp/
│   └── server.js           ✅ 11 MCP tools
└── utils/
    └── config.js           ✅ Feature flags, presets
```

### What Needs to Change

| Module | Change Type | Effort |
|--------|-------------|--------|
| `src/db/adapter.js` | **REPLACE** with `memgraph-adapter.js` | High |
| `src/db/schema.sql` | **REPLACE** with `schema.cypher` | High |
| `src/indexing/index-manager.js` | **UPDATE** for new adapter + tier system | Medium |
| `src/indexing/graph-builder.js` | **UPDATE** for Cypher edge creation | Medium |
| `src/enrichment/*` | **MAJOR REWRITE** for Research Agent | High |
| `src/search/semantic-search.js` | **UPDATE** for vector_search + graph | Medium |
| `src/mcp/server.js` | **UPDATE** add new graph tools | Medium |
| `src/utils/config.js` | **UPDATE** add Memgraph + Research Agent config | Low |

### What to Remove/Deprecate

| File | Action |
|------|--------|
| `src/db/adapter.js` | Keep as `adapter.sqlite.js` (reference only) |
| `src/db/schema.sql` | Keep as `schema.sqlite.sql` (reference only) |
| sqlite-vec dependency | Remove from package.json |
| better-sqlite3 dependency | Remove from package.json |

---

## 3. Target Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           CODESENSE ARCHITECTURE (Memgraph)                          │
└─────────────────────────────────────────────────────────────────────────────────────┘

                              ┌──────────────────┐
                              │   AI Coding LLM  │
                              │  (Claude, GPT)   │
                              └────────┬─────────┘
                                       │ MCP Protocol
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              MCP SERVER (src/mcp/server.js)                          │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  SEARCH TOOLS              PLANNING TOOLS           GRAPH INTELLIGENCE (NEW)        │
│  ────────────              ──────────────           ────────────────────────        │
│  • search_codebase         • generate_plan          • get_impact_radius             │
│  • enrich_chunk            • investigate_bug        • get_hub_functions             │
│  • get_enrichment_status   • validate_diff          • get_flows                     │
│  • get_index_status        • get_plan               • find_path                     │
│  • refresh_index           • list_plans             • get_data_flow                 │
│                                                     • analyze_change                │
│                                                                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                       │
           ┌───────────────────────────┼───────────────────────────┐
           │                           │                           │
           ▼                           ▼                           ▼
┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────────────────┐
│   SEARCH LAYER      │   │   PLANNING LAYER    │   │       ENRICHMENT LAYER          │
│   src/search/       │   │   src/planning/     │   │       src/enrichment/           │
├─────────────────────┤   ├─────────────────────┤   ├─────────────────────────────────┤
│ • query-engine      │   │ • context-assembler │   │ • research-agent.js (NEW)       │
│ • semantic-search   │   │ • plan-generator    │   │ • enrichment-processor.js (NEW) │
│ • grep-search       │   │ • bug-investigator  │   │ • background-queue.js           │
│ • structural-search │   │ • diff-validator    │   │ • prioritizer.js (uses PageRank)│
│ • query-understand  │   │                     │   │ • cache-manager.js              │
└─────────────────────┘   └─────────────────────┘   └─────────────────────────────────┘
           │                           │                           │
           └───────────────────────────┼───────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                         MEMGRAPH ADAPTER (src/db/memgraph-adapter.js)                │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│   FILE OPS          CHUNK OPS           GRAPH OPS            ANALYTICS              │
│   ────────          ─────────           ─────────            ─────────              │
│   • upsertFiles     • upsertChunk       • addCallEdge        • computePageRank      │
│   • deleteFiles     • getChunk          • getCallers         • getHubFunctions      │
│   • getFileHashes   • getWithContext    • getCallees         • detectCommunities    │
│                                         • getImpactRadius    • findPath             │
│                                                                                      │
│   SEARCH OPS                            ENRICHMENT OPS                              │
│   ──────────                            ──────────────                              │
│   • semanticSearch                      • upsertEnrichment                          │
│   • semanticSearchWithContext           • getChunksNeedingEnrichment                │
│   (vector + graph in ONE query)         • mergePartialEnrichment                    │
│                                                                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       │ Bolt Protocol (neo4j-driver)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              MEMGRAPH (In-Memory Graph DB)                           │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│   ┌─────────────────────────────────────────────────────────────────────────────┐   │
│   │                           GRAPH DATA MODEL                                   │   │
│   │                                                                              │   │
│   │    (:File)──[:CONTAINS]──▶(:Chunk)──[:CALLS]──▶(:Chunk)                     │   │
│   │       │                      │                    │                          │   │
│   │       │                      ├── context_tier     │                          │   │
│   │       │                      ├── enrichment (JSON)│                          │   │
│   │       │                      ├── embedding[]      │                          │   │
│   │       │                      └── research_sources │                          │   │
│   │       ▼                                                                      │   │
│   │  (:File)◀──[:IMPORTS]──(:File)                                               │   │
│   │                                                                              │   │
│   │              (:Chunk)──[:EXTENDS]──▶(:Chunk)                                 │   │
│   │              (:Chunk)──[:IMPLEMENTS]──▶(:Chunk)                              │   │
│   │              (:Chunk)──[:READS]──▶(:DataModel)                               │   │
│   │              (:Chunk)──[:WRITES]──▶(:DataModel)                              │   │
│   │                                                                              │   │
│   └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
│   ┌─────────────────────────────────────┐  ┌────────────────────────────────────┐   │
│   │  VECTOR INDEXES                     │  │  MAGE ALGORITHMS                   │   │
│   │  • embedding_index (384 dims)       │  │  • pagerank.get()                  │   │
│   │                                     │  │  • community_detection.get()       │   │
│   │  PROPERTY INDEXES                   │  │  • betweenness_centrality.get()    │   │
│   │  • :File(path)                      │  │  • shortestPath()                  │   │
│   │  • :Chunk(id, name, context_tier)   │  │                                    │   │
│   └─────────────────────────────────────┘  └────────────────────────────────────┘   │
│                                                                                      │
│   PERSISTENCE: Snapshots + WAL → Disk                                               │
│                                                                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Context Tier System

### Tier Definitions

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                            CONTEXT TIER HIERARCHY                                    │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│   TIER: "structural" (Tier 0-2.5)                                                   │
│   ────────────────────────────────                                                  │
│   • Data from AST parsing only (no LLM)                                             │
│   • Properties: name, code, signature, jsdoc, params, return_type                   │
│   • Graph: fan_in, fan_out, relationships                                           │
│   • Embedding: code + jsdoc only                                                    │
│   • Confidence: N/A                                                                 │
│                                                                                      │
│   ─────────────────────────────────────────────────────────────────────────────────  │
│                                                                                      │
│   TIER: "partial" (Discovered during research)                                       │
│   ────────────────────────────────────────────                                       │
│   • This chunk was RESEARCHED while enriching another chunk                          │
│   • Properties:                                                                      │
│     - partial_enrichments: [{                                                        │
│         learned: "Brief description from research",                                  │
│         discovered_by: "chunk_id that researched this",                              │
│         relationship: "caller|callee|sibling|data_source",                           │
│         confidence: 0.0-1.0,                                                         │
│         discovered_at: timestamp                                                     │
│       }, ...]                                                                        │
│   • Embedding: code + jsdoc + merged partial enrichments                             │
│   • Medium confidence - useful but not comprehensive                                 │
│                                                                                      │
│   ─────────────────────────────────────────────────────────────────────────────────  │
│                                                                                      │
│   TIER: "full" (Primary research target)                                             │
│   ──────────────────────────────────────                                             │
│   • This chunk was the PRIMARY target of a research session                          │
│   • Full enrichment JSON (see schema below)                                          │
│   • Embedding: code + jsdoc + full enrichment                                        │
│   • Highest confidence                                                               │
│   • Includes: research_sources[] for cache invalidation                              │
│                                                                                      │
│   ─────────────────────────────────────────────────────────────────────────────────  │
│                                                                                      │
│   TIER PROMOTION RULES:                                                              │
│   ─────────────────────                                                              │
│   • structural → partial: When discovered during another chunk's research            │
│   • partial → full: When this chunk becomes primary enrichment target                │
│   • full → full: Re-enrichment updates existing, keeps tier                          │
│   • NEVER demote: Once "full", always "full" (until code changes)                    │
│                                                                                      │
│   ─────────────────────────────────────────────────────────────────────────────────  │
│                                                                                      │
│   MERGE BEHAVIOR (partial exists, then full enrichment runs):                        │
│   ──────────────────────────────────────────────────────────────                     │
│   1. Keep partial_enrichments for provenance (move to research_context)              │
│   2. Replace with full enrichment                                                    │
│   3. Promote tier to "full"                                                          │
│   4. Re-generate embedding with full enrichment                                      │
│                                                                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### Chunk Properties by Tier

```javascript
// structural tier (no enrichment)
{
  id: "chunk_abc123",
  name: "calculateTotal",
  type: "function",
  code: "function calculateTotal(cart) {...}",
  signature: "calculateTotal(cart: Cart): number",
  jsdoc: "Calculates total price including discounts",
  start_line: 42,
  end_line: 78,
  token_count: 150,
  context_tier: "structural",
  embedding: [0.12, -0.34, ...],  // code + jsdoc only
}

// partial tier (discovered during research)
{
  ...structural_properties,
  context_tier: "partial",
  partial_enrichments: [
    {
      learned: "Calculates order total including discounts and tax",
      discovered_by: "processOrder",
      relationship: "callee",
      confidence: 0.8,
      discovered_at: 1703001234
    },
    {
      learned: "Central pricing function called by checkout flow",
      discovered_by: "updateCart",
      relationship: "callee", 
      confidence: 0.75,
      discovered_at: 1703002345
    }
  ],
  embedding: [0.15, -0.38, ...],  // code + jsdoc + partial enrichments
}

// full tier (primary research target)
{
  ...structural_properties,
  context_tier: "full",
  enrichment: {
    summary: "Calculates final order total including discounts, tax, and shipping.",
    purpose: "Central pricing logic for the checkout flow.",
    key_operations: ["apply discounts", "calculate tax", "add shipping"],
    side_effects: ["updates cart.total", "logs pricing events"],
    state_changes: ["cart.total", "cart.taxAmount", "cart.discountApplied"],
    implicit_dependencies: ["TAX_SERVICE_URL env var", "pricing config"],
    design_patterns: ["Calculator", "Strategy for discounts"],
    complexity: "medium",
    flow_context: "checkout: cart → calculateTotal → processPayment",
    tags: ["pricing", "checkout", "cart", "tax", "discount"],
    confidence: 0.9,
    research_depth: "deep"
  },
  research_sources: ["applyDiscount", "calculateTax", "Cart"],
  research_source_hashes: {
    "applyDiscount": "abc123",
    "calculateTax": "def456",
    "Cart": "ghi789"
  },
  enriched_at: 1703003456,
  embedding: [0.18, -0.42, ...],  // code + jsdoc + full enrichment
}
```

---

## 5. Research Agent Enrichment

### Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              RESEARCH AGENT FLOW                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘

  ENRICHMENT QUEUE (Priority Ordered by PageRank, fan_in, recency)
  ─────────────────────────────────────────────────────────────────
                                    │
                                    ▼
  ┌───────────────────────────────────────────────────────────────────────────────────┐
  │                              RESEARCH AGENT                                        │
  │                                                                                    │
  │  Target: enrichChunk("calculateTotal")                                             │
  │                                                                                    │
  │  ┌──────────────────────────────────────────────────────────────────────────────┐ │
  │  │  STEP 1: Gather Structural Context (from graph, no LLM)                       │ │
  │  │                                                                               │ │
  │  │  • Get chunk code, signature, JSDoc                                           │ │
  │  │  • Get direct callers (1 hop): [processOrder, updateCart]                     │ │
  │  │  • Get direct callees (1 hop): [applyDiscount, calculateTax]                  │ │
  │  │  • Get file context: Other exports in this file                               │ │
  │  │  • Get existing partial enrichments (from previous research)                  │ │
  │  │  • Check if neighbors already have "full" enrichment (use cached summaries)   │ │
  │  └──────────────────────────────────────────────────────────────────────────────┘ │
  │                                  │                                                 │
  │                                  ▼                                                 │
  │  ┌──────────────────────────────────────────────────────────────────────────────┐ │
  │  │  STEP 2: Research Loop (LLM-driven exploration)                               │ │
  │  │                                                                               │ │
  │  │  Agent Prompt:                                                                │ │
  │  │  "You are analyzing calculateTotal(). Here's what we know:                    │ │
  │  │   [structural context + existing partial enrichments]                         │ │
  │  │                                                                               │ │
  │  │   To understand this function deeply, you may use these tools:                │ │
  │  │   - read_chunk(id): Get full code of another chunk                            │ │
  │  │   - get_callers(id, depth): Who calls this?                                   │ │
  │  │   - get_callees(id, depth): What does this call?                              │ │
  │  │   - get_file_siblings(id): Other chunks in same file                          │ │
  │  │   - search_similar(query): Find semantically related code                     │ │
  │  │                                                                               │ │
  │  │   CONSTRAINTS:                                                                │ │
  │  │   - Max ${config.research.maxToolCalls} tool calls                            │ │
  │  │   - Max ${config.research.maxDepth} hops from target                          │ │
  │  │   - Stop when you have sufficient understanding                               │ │
  │  │                                                                               │ │
  │  │   As you research, note what you learn about OTHER functions too.             │ │
  │  │   We'll capture that knowledge."                                              │ │
  │  │                                                                               │ │
  │  │  ┌────────────────────────────────────────────────────────────────────────┐  │ │
  │  │  │  Example Agent Actions:                                                 │  │ │
  │  │  │                                                                         │  │ │
  │  │  │  1. read_chunk("applyDiscount")                                         │  │ │
  │  │  │     → Learns: "Applies percentage or fixed discounts"                   │  │ │
  │  │  │     → CAPTURE for applyDiscount (partial)                               │  │ │
  │  │  │                                                                         │  │ │
  │  │  │  2. read_chunk("calculateTax")                                          │  │ │
  │  │  │     → Learns: "Calculates tax based on jurisdiction"                    │  │ │
  │  │  │     → CAPTURE for calculateTax (partial)                                │  │ │
  │  │  │                                                                         │  │ │
  │  │  │  3. get_callers("calculateTotal", 1)                                    │  │ │
  │  │  │     → Learns: Called by checkout flow                                   │  │ │
  │  │  │     → CAPTURE for processOrder, updateCart (partial)                    │  │ │
  │  │  │                                                                         │  │ │
  │  │  │  Agent: "I have sufficient understanding"                               │  │ │
  │  │  └────────────────────────────────────────────────────────────────────────┘  │ │
  │  └──────────────────────────────────────────────────────────────────────────────┘ │
  │                                  │                                                 │
  │                                  ▼                                                 │
  │  ┌──────────────────────────────────────────────────────────────────────────────┐ │
  │  │  STEP 3: Generate Structured Output                                           │ │
  │  │                                                                               │ │
  │  │  {                                                                            │ │
  │  │    "target_chunk": "calculateTotal",                                          │ │
  │  │                                                                               │ │
  │  │    "enrichment": {                                                            │ │
  │  │      "summary": "Calculates final order total with discounts and tax.",       │ │
  │  │      "purpose": "Central pricing logic for checkout flow.",                   │ │
  │  │      "key_operations": [...],                                                 │ │
  │  │      "side_effects": [...],                                                   │ │
  │  │      ... // full enrichment schema                                            │ │
  │  │    },                                                                         │ │
  │  │                                                                               │ │
  │  │    "research_captured": [                                                     │ │
  │  │      {                                                                        │ │
  │  │        "chunk_id": "applyDiscount",                                           │ │
  │  │        "learned": "Applies percentage or fixed discounts to subtotal",        │ │
  │  │        "relationship": "callee",                                              │ │
  │  │        "confidence": 0.8                                                      │ │
  │  │      },                                                                       │ │
  │  │      {                                                                        │ │
  │  │        "chunk_id": "processOrder",                                            │ │
  │  │        "learned": "Orchestrates checkout, calls calculateTotal",              │ │
  │  │        "relationship": "caller",                                              │ │
  │  │        "confidence": 0.85                                                     │ │
  │  │      }                                                                        │ │
  │  │    ],                                                                         │ │
  │  │                                                                               │ │
  │  │    "research_sources": ["applyDiscount", "calculateTax", "processOrder"]      │ │
  │  │  }                                                                            │ │
  │  └──────────────────────────────────────────────────────────────────────────────┘ │
  │                                                                                    │
  └────────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌───────────────────────────────────────────────────────────────────────────────────┐
  │                         STEP 4: Store in Graph                                     │
  ├───────────────────────────────────────────────────────────────────────────────────┤
  │                                                                                    │
  │  // Store FULL enrichment on target                                                │
  │  MATCH (c:Chunk {id: 'calculateTotal'})                                            │
  │  SET c.enrichment = $enrichment_json,                                              │
  │      c.context_tier = 'full',                                                      │
  │      c.enriched_at = timestamp(),                                                  │
  │      c.research_sources = $sources,                                                │
  │      c.research_source_hashes = $source_hashes                                     │
  │                                                                                    │
  │  // Merge PARTIAL enrichment on researched neighbors                               │
  │  UNWIND $research_captured AS research                                             │
  │  MATCH (c:Chunk {id: research.chunk_id})                                           │
  │  SET c.partial_enrichments = COALESCE(c.partial_enrichments, []) + [research],     │
  │      c.context_tier = CASE WHEN c.context_tier = 'full'                            │
  │                            THEN 'full' ELSE 'partial' END                          │
  │                                                                                    │
  └───────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌───────────────────────────────────────────────────────────────────────────────────┐
  │                         STEP 5: Generate Embedding                                 │
  ├───────────────────────────────────────────────────────────────────────────────────┤
  │                                                                                    │
  │  Build representation:                                                             │
  │  ─────────────────────                                                             │
  │  representation = [                                                                │
  │    file_path,                          // "src/cart/pricing.js"                    │
  │    enrichment.summary,                 // "Calculates final order total..."        │
  │    enrichment.purpose,                 // "Central pricing logic..."               │
  │    enrichment.tags.join(" "),          // "pricing checkout cart tax"              │
  │    enrichment.flow_context,            // "checkout: cart → calculateTotal → ..."  │
  │    signature,                          // "calculateTotal(cart: Cart): number"     │
  │    code                                // actual function code                     │
  │  ].join("\n\n")                                                                    │
  │                                                                                    │
  │  embedding = embed(representation)                                                 │
  │                                                                                    │
  │  MATCH (c:Chunk {id: 'calculateTotal'})                                            │
  │  SET c.embedding = $embedding                                                      │
  │                                                                                    │
  └───────────────────────────────────────────────────────────────────────────────────┘
```

### Research Agent Tool Set

```javascript
// Tools available to Research Agent (read-only)

const RESEARCH_TOOLS = [
  {
    name: "read_chunk",
    description: "Get full code and metadata of a chunk",
    parameters: { chunk_id: "string" },
    returns: { code, signature, jsdoc, existing_enrichment }
  },
  {
    name: "get_callers",
    description: "Get chunks that call this chunk",
    parameters: { chunk_id: "string", depth: "number (1-2)" },
    returns: [{ id, name, summary_if_enriched, relationship }]
  },
  {
    name: "get_callees",
    description: "Get chunks that this chunk calls",
    parameters: { chunk_id: "string", depth: "number (1-2)" },
    returns: [{ id, name, summary_if_enriched, relationship }]
  },
  {
    name: "get_file_siblings",
    description: "Get other chunks in the same file",
    parameters: { chunk_id: "string" },
    returns: [{ id, name, type, summary_if_enriched }]
  },
  {
    name: "search_similar",
    description: "Find semantically similar code",
    parameters: { query: "string", limit: "number" },
    returns: [{ id, name, file_path, score }]
  },
  {
    name: "done",
    description: "Signal that research is complete",
    parameters: { reason: "string" }
  }
];
```

### Research Loop Constraints (Configurable)

```javascript
// Default configuration for research agent
const RESEARCH_DEFAULTS = {
  maxToolCalls: 12,           // Max tool invocations per enrichment
  maxDepth: 2,                // Max hops from target (callers of callers)
  maxTokensRead: 50000,       // Max tokens of code read per session
  stopOnFullNeighbors: true,  // Stop if all neighbors already enriched
  parallelResearch: false,    // Process queue items sequentially (safer)
};
```

---

## 6. Memgraph Schema

### Node Types

```cypher
// ═══════════════════════════════════════════════════════════════════════════
// FILE NODE
// ═══════════════════════════════════════════════════════════════════════════
(:File {
  path: STRING,                    // Unique identifier (absolute path)
  hash: STRING,                    // Content hash for change detection
  size: INTEGER,
  modified_at: INTEGER,
  indexed_tier: INTEGER,           // 0=scanned, 1=parsed, 2=chunked, 3=graph
  fan_in: INTEGER,                 // Files importing this
  fan_out: INTEGER,                // Files this imports
  complexity_score: INTEGER
})

// ═══════════════════════════════════════════════════════════════════════════
// CHUNK NODE (Core unit for code intelligence)
// ═══════════════════════════════════════════════════════════════════════════
(:Chunk {
  id: STRING,                      // Unique chunk identifier
  name: STRING,                    // Function/class name
  type: STRING,                    // function, class, method, module
  code: STRING,                    // Raw source code
  jsdoc: STRING,                   // Extracted JSDoc comment
  signature: STRING,               // Function/class signature
  start_line: INTEGER,
  end_line: INTEGER,
  token_count: INTEGER,
  
  // Context Tier System
  context_tier: STRING,            // "structural" | "partial" | "full"
  
  // Embeddings
  embedding: LIST OF FLOAT,        // Current best embedding (384 dims)
  
  // Partial Enrichment (for "partial" tier)
  partial_enrichments: STRING,     // JSON array of partial enrichment objects
  
  // Full Enrichment (for "full" tier)
  enrichment: STRING,              // JSON object with full enrichment
  research_sources: LIST OF STRING,     // Chunk IDs researched
  research_source_hashes: STRING,       // JSON: {chunk_id: hash} for invalidation
  enriched_at: INTEGER,
  
  // Graph Analytics (computed)
  pagerank: FLOAT,
  community_id: INTEGER
})

// ═══════════════════════════════════════════════════════════════════════════
// DEFINITION NODE (Lightweight reference)
// ═══════════════════════════════════════════════════════════════════════════
(:Definition {
  name: STRING,
  type: STRING,                    // function, class, interface, const, type
  exported: BOOLEAN,
  start_line: INTEGER,
  end_line: INTEGER,
  signature: STRING
})

// ═══════════════════════════════════════════════════════════════════════════
// DATA MODEL NODE (Optional - for data flow tracking)
// ═══════════════════════════════════════════════════════════════════════════
(:DataModel {
  name: STRING,                    // Table name, model name
  type: STRING,                    // database_table, api_endpoint, state_store
  fields: LIST OF STRING,
  source_file: STRING
})

// ═══════════════════════════════════════════════════════════════════════════
// ENRICHMENT QUEUE NODE
// ═══════════════════════════════════════════════════════════════════════════
(:EnrichmentQueueItem {
  chunk_id: STRING,
  priority: INTEGER,
  status: STRING,                  // pending, processing, complete, failed
  attempts: INTEGER,
  error_message: STRING,
  created_at: INTEGER,
  next_retry_at: INTEGER
})
```

### Edge Types

```cypher
// File → Chunk containment
(:File)-[:CONTAINS]->(:Chunk)
(:File)-[:CONTAINS]->(:Definition)

// Code relationships
(:Chunk)-[:CALLS {line: INTEGER}]->(:Chunk)
(:Chunk)-[:IMPORTS {line: INTEGER}]->(:Chunk)
(:Chunk)-[:EXTENDS]->(:Chunk)
(:Chunk)-[:IMPLEMENTS]->(:Chunk)
(:Chunk)-[:USES]->(:Chunk)

// Data flow
(:Chunk)-[:READS {fields: LIST OF STRING}]->(:DataModel)
(:Chunk)-[:WRITES {fields: LIST OF STRING}]->(:DataModel)

// File-level relationships
(:File)-[:IMPORTS]->(:File)
```

### Indexes

```cypher
// Vector index for semantic search
CREATE VECTOR INDEX chunk_embedding_index ON :Chunk(embedding)
  WITH CONFIG {"dimension": 384, "capacity": 100000, "metric": "cos"};

// Property indexes
CREATE INDEX ON :File(path);
CREATE INDEX ON :Chunk(id);
CREATE INDEX ON :Chunk(name);
CREATE INDEX ON :Chunk(context_tier);
CREATE INDEX ON :Definition(name);
CREATE INDEX ON :EnrichmentQueueItem(status);
```

---

## 7. Implementation Phases

### Phase 1: Memgraph Foundation (Week 1)

**Goal:** Replace SQLite with Memgraph, basic CRUD working.

**Tasks:**
- [ ] Set up Docker Compose with Memgraph + Memgraph Lab
- [ ] Create `src/db/memgraph-adapter.js` with connection management
- [ ] Create `src/db/schema.cypher` with full schema
- [ ] Implement core operations:
  - [ ] File CRUD (upsertFiles, deleteFiles, getAllFileHashes)
  - [ ] Chunk CRUD (upsertChunk, getChunk, deleteChunksForFile)
  - [ ] Basic graph operations (addEdge, getCallers, getCallees)
- [ ] Create adapter tests
- [ ] Update `src/utils/config.js` with Memgraph settings

**Deliverable:** `node test/db/memgraph-adapter.test.js` passes

### Phase 2: Structural Indexing Migration (Week 1-2)

**Goal:** Tiers 0-2.5 working with Memgraph.

**Tasks:**
- [ ] Update `src/indexing/index-manager.js` for new adapter
- [ ] Update `src/indexing/graph-builder.js` for Cypher edges
- [ ] Add `context_tier: "structural"` on chunk creation
- [ ] **DO NOT embed yet** - defer to Phase 4
- [ ] Verify complete call graph builds correctly
- [ ] Update file metrics (fan_in, fan_out) via Cypher
- [ ] Test on real codebase

**Deliverable:** Full graph built from codebase, queryable via Cypher

### Phase 3: Research Agent Enrichment (Week 2-3)

**Goal:** Implement Research Agent with context tier system.

**Tasks:**
- [ ] Create `src/enrichment/research-agent.js`
  - [ ] Define research tool set
  - [ ] Implement tool execution against graph
  - [ ] Implement research loop with configurable limits
  - [ ] Capture spillover research for partial enrichment
- [ ] Create `src/enrichment/enrichment-processor.js`
  - [ ] Full enrichment storage
  - [ ] Partial enrichment merging
  - [ ] Context tier promotion logic
- [ ] Update `src/enrichment/prioritizer.js`
  - [ ] Use PageRank for priority (once computed)
  - [ ] Consider existing partial enrichments
- [ ] Update `src/enrichment/background-queue.js` for new flow
- [ ] Update `src/enrichment/cache-manager.js`
  - [ ] Invalidation based on `research_source_hashes`
  - [ ] Mark dependents as stale when sources change
- [ ] Define full enrichment JSON schema (Zod)
- [ ] Define partial enrichment schema

**Deliverable:** Enrichment with spillover capture working

### Phase 4: Embedding Generation (Week 3)

**Goal:** Tier-aware embeddings after enrichment.

**Tasks:**
- [ ] Update `src/indexing/representation-builder.js`
  - [ ] Tier-aware representation building
  - [ ] Structural: code + jsdoc
  - [ ] Partial: code + jsdoc + merged partial enrichments
  - [ ] Full: code + jsdoc + full enrichment
- [ ] Update `src/indexing/embedder.js` for Memgraph storage
- [ ] Create vector index in Memgraph
- [ ] Implement re-embedding triggers:
  - [ ] After tier promotion (structural → partial → full)
  - [ ] After code change
  - [ ] After re-enrichment

**Deliverable:** Embeddings generated based on context tier

### Phase 5: Search Integration (Week 3-4)

**Goal:** Combined vector + graph search.

**Tasks:**
- [ ] Update `src/search/semantic-search.js`
  - [ ] Use `vector_search.search()` procedure
  - [ ] Add graph expansion option (include callers/callees)
- [ ] Update `src/search/structural-search.js` for Cypher
- [ ] Update `src/search/query-engine.js`
- [ ] Implement combined queries:
  ```cypher
  CALL vector_search.search("chunk_embedding_index", 10, $embedding)
  YIELD node, score
  MATCH (f:File)-[:CONTAINS]->(node)
  OPTIONAL MATCH (node)-[:CALLS*1..2]->(callee:Chunk)
  OPTIONAL MATCH (caller:Chunk)-[:CALLS*1..2]->(node)
  RETURN node, f.path, score,
         collect(DISTINCT callee) as callees,
         collect(DISTINCT caller) as callers
  ```

**Deliverable:** Rich search results with graph context

### Phase 6: Graph Intelligence Tools (Week 4)

**Goal:** New MCP tools leveraging graph capabilities.

**Tasks:**
- [ ] Implement `get_impact_radius` tool
  ```cypher
  MATCH (target:Chunk {id: $id})<-[:CALLS*1..10]-(affected:Chunk)
  RETURN DISTINCT affected
  ```
- [ ] Implement `get_hub_functions` tool (PageRank)
- [ ] Implement `get_flows` tool (community detection)
- [ ] Implement `find_path` tool (shortest path)
- [ ] Implement `analyze_change` tool (impact analysis)
- [ ] Update existing tools to use graph context
- [ ] Add PageRank computation on indexing complete
- [ ] Add community detection on indexing complete

**Deliverable:** All new MCP tools working

### Phase 7: Polish & Deploy (Week 4-5)

**Goal:** Production-ready deployment.

**Tasks:**
- [ ] Create `Dockerfile` for CodeSense
- [ ] Create `docker-compose.yml` with Memgraph + CodeSense
- [ ] Implement startup validation (check Memgraph health)
- [ ] Implement graceful shutdown
- [ ] Add comprehensive error handling
- [ ] Performance testing on large codebase
- [ ] Documentation
- [ ] Migration guide for existing users

**Deliverable:** `docker-compose up` starts working system

---

## 8. Module Migration Guide

### Files to Create (NEW)

| File | Purpose |
|------|---------|
| `src/db/memgraph-adapter.js` | Memgraph connection and operations |
| `src/db/schema.cypher` | Cypher schema setup |
| `src/db/queries/files.js` | File-related Cypher queries |
| `src/db/queries/chunks.js` | Chunk-related Cypher queries |
| `src/db/queries/graph.js` | Relationship queries |
| `src/db/queries/search.js` | Vector + graph search queries |
| `src/db/queries/analytics.js` | PageRank, community detection |
| `src/enrichment/research-agent.js` | Research agent implementation |
| `src/enrichment/enrichment-processor.js` | Enrichment storage and tier management |
| `docker-compose.yml` | Deployment configuration |
| `Dockerfile` | CodeSense container |

### Files to Update

| File | Changes |
|------|---------|
| `src/indexing/index-manager.js` | Use new adapter, add context_tier |
| `src/indexing/graph-builder.js` | Cypher edge creation |
| `src/indexing/representation-builder.js` | Tier-aware representations |
| `src/indexing/embedder.js` | Store embeddings in Memgraph |
| `src/search/semantic-search.js` | Use vector_search + graph expansion |
| `src/search/structural-search.js` | Use Cypher queries |
| `src/search/query-engine.js` | Minor updates for new adapter |
| `src/enrichment/hierarchical-enricher.js` | Replaced by research-agent.js |
| `src/enrichment/background-queue.js` | Use new enrichment processor |
| `src/enrichment/prioritizer.js` | Use PageRank, consider partial enrichments |
| `src/enrichment/cache-manager.js` | Research source invalidation |
| `src/planning/context-assembler.js` | Use graph context |
| `src/mcp/server.js` | Add new graph tools |
| `src/utils/config.js` | Memgraph + research agent config |
| `package.json` | Add neo4j-driver, remove sqlite deps |

### Files to Deprecate

| File | Action |
|------|--------|
| `src/db/adapter.js` | Rename to `adapter.sqlite.js`, keep for reference |
| `src/db/schema.sql` | Rename to `schema.sqlite.sql`, keep for reference |

---

## 9. Configuration

### New Configuration Schema

```javascript
// src/utils/config.js additions

const MemgraphConfigSchema = z.object({
  url: z.string().default('bolt://localhost:7687'),
  username: z.string().default(''),
  password: z.string().default(''),
  database: z.string().default('memgraph'),
});

const ResearchAgentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxToolCalls: z.number().min(5).max(50).default(12),
  maxDepth: z.number().min(1).max(5).default(2),
  maxTokensRead: z.number().default(50000),
  stopOnFullNeighbors: z.boolean().default(true),
  parallelResearch: z.boolean().default(false),
});

const ConfigSchema = z.object({
  // ... existing config ...
  
  // New Memgraph config
  memgraph: MemgraphConfigSchema.default({}),
  
  // New Research Agent config
  researchAgent: ResearchAgentConfigSchema.default({}),
  
  // Graph analytics
  graphAnalytics: z.object({
    computePageRank: z.boolean().default(true),
    computeCommunities: z.boolean().default(true),
    pageRankDamping: z.number().default(0.85),
  }).default({}),
});
```

### Example Configuration File

```json
// codesense.config.json
{
  "memgraph": {
    "url": "bolt://localhost:7687",
    "username": "",
    "password": ""
  },
  "researchAgent": {
    "enabled": true,
    "maxToolCalls": 12,
    "maxDepth": 2,
    "maxTokensRead": 50000,
    "stopOnFullNeighbors": true
  },
  "graphAnalytics": {
    "computePageRank": true,
    "computeCommunities": true
  },
  "llm": {
    "provider": "openrouter",
    "model": "anthropic/claude-3-haiku"
  }
}
```

---

## 10. Deployment

### Docker Compose

```yaml
# docker-compose.yml
version: '3.8'

services:
  memgraph:
    image: memgraph/memgraph-mage:latest
    ports:
      - "7687:7687"
      - "7444:7444"
    volumes:
      - memgraph-data:/var/lib/memgraph
    command: >
      --schema-info-enabled=true
      --storage-snapshot-interval-sec=300
      --storage-wal-enabled=true
      --log-level=WARNING
    environment:
      - MEMGRAPH_USER=${MEMGRAPH_USER:-}
      - MEMGRAPH_PASSWORD=${MEMGRAPH_PASSWORD:-}
    healthcheck:
      test: ["CMD-SHELL", "echo 'RETURN 1;' | mgconsole || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5

  memgraph-lab:
    image: memgraph/lab:latest
    ports:
      - "3000:3000"
    depends_on:
      - memgraph
    environment:
      - QUICK_CONNECT_MG_HOST=memgraph
      - QUICK_CONNECT_MG_PORT=7687

  codesense:
    build: .
    depends_on:
      memgraph:
        condition: service_healthy
    volumes:
      - ${CODEBASE_PATH:-.}:/workspace:ro
      - codesense-config:/app/config
    environment:
      - MEMGRAPH_URL=bolt://memgraph:7687
      - MEMGRAPH_USER=${MEMGRAPH_USER:-}
      - MEMGRAPH_PASSWORD=${MEMGRAPH_PASSWORD:-}
      - CODEBASE_PATH=/workspace
      - LLM_PROVIDER=${LLM_PROVIDER:-openrouter}
      - LLM_API_KEY=${LLM_API_KEY}
      - LLM_MODEL=${LLM_MODEL:-anthropic/claude-3-haiku}
    stdin_open: true
    tty: true

volumes:
  memgraph-data:
  codesense-config:
```

### Dockerfile

```dockerfile
# Dockerfile
FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy source
COPY src/ ./src/

# Set entrypoint
ENTRYPOINT ["node", "src/index.js"]
CMD ["serve"]
```

### Quick Start

```bash
# Start Memgraph + CodeSense
export CODEBASE_PATH=/path/to/your/codebase
export LLM_API_KEY=your-api-key
docker-compose up -d

# Check status
docker-compose logs -f codesense

# Access Memgraph Lab (optional)
open http://localhost:3000
```

---

## Appendix: Key Cypher Queries

```cypher
// ═══════════════════════════════════════════════════════════════════════════
// IMPACT ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

// Find all code affected by changing a function
MATCH (target:Chunk {id: $id})<-[:CALLS*1..10]-(affected:Chunk)
RETURN DISTINCT affected.name, affected.enrichment.summary,
       length(shortestPath((affected)-[:CALLS*]->(target))) as distance
ORDER BY distance

// ═══════════════════════════════════════════════════════════════════════════
// SEMANTIC SEARCH + GRAPH CONTEXT
// ═══════════════════════════════════════════════════════════════════════════

// Search with callers/callees included
CALL vector_search.search("chunk_embedding_index", 10, $embedding)
YIELD node, score
MATCH (f:File)-[:CONTAINS]->(node)
OPTIONAL MATCH (node)-[:CALLS]->(callee:Chunk)
OPTIONAL MATCH (caller:Chunk)-[:CALLS]->(node)
RETURN node.name, node.enrichment.summary, f.path, score,
       collect(DISTINCT {name: callee.name, summary: callee.enrichment.summary}) as callees,
       collect(DISTINCT {name: caller.name, summary: caller.enrichment.summary}) as callers
ORDER BY score DESC

// ═══════════════════════════════════════════════════════════════════════════
// HUB FUNCTIONS (PageRank)
// ═══════════════════════════════════════════════════════════════════════════

// Find most important functions
MATCH (c:Chunk)
WHERE c.pagerank IS NOT NULL
RETURN c.name, c.file_path, c.enrichment.summary, c.pagerank
ORDER BY c.pagerank DESC
LIMIT 20

// ═══════════════════════════════════════════════════════════════════════════
// RESEARCH AGENT QUERIES
// ═══════════════════════════════════════════════════════════════════════════

// Get callers with existing enrichment
MATCH (target:Chunk {id: $id})<-[:CALLS]-(caller:Chunk)
RETURN caller.id, caller.name, caller.context_tier,
       CASE WHEN caller.context_tier = 'full' 
            THEN caller.enrichment.summary 
            ELSE null END as summary

// Get callees with existing enrichment
MATCH (target:Chunk {id: $id})-[:CALLS]->(callee:Chunk)
RETURN callee.id, callee.name, callee.context_tier,
       CASE WHEN callee.context_tier = 'full' 
            THEN callee.enrichment.summary 
            ELSE null END as summary

// Get file siblings
MATCH (f:File)-[:CONTAINS]->(target:Chunk {id: $id})
MATCH (f)-[:CONTAINS]->(sibling:Chunk)
WHERE sibling.id <> target.id
RETURN sibling.id, sibling.name, sibling.type

// ═══════════════════════════════════════════════════════════════════════════
// ENRICHMENT STORAGE
// ═══════════════════════════════════════════════════════════════════════════

// Store full enrichment
MATCH (c:Chunk {id: $chunkId})
SET c.enrichment = $enrichmentJson,
    c.context_tier = 'full',
    c.enriched_at = timestamp(),
    c.research_sources = $sources,
    c.research_source_hashes = $sourceHashes

// Merge partial enrichment (append, don't overwrite)
MATCH (c:Chunk {id: $chunkId})
WHERE c.context_tier <> 'full'
SET c.partial_enrichments = COALESCE(c.partial_enrichments, '[]'),
    c.context_tier = 'partial'
WITH c, c.partial_enrichments as existing
SET c.partial_enrichments = $newPartialJson

// ═══════════════════════════════════════════════════════════════════════════
// CACHE INVALIDATION
// ═══════════════════════════════════════════════════════════════════════════

// Find chunks that need re-enrichment because a source changed
MATCH (c:Chunk)
WHERE $changedChunkId IN c.research_sources
SET c.stale = true
RETURN c.id, c.name
```

---

*End of Migration Plan*
