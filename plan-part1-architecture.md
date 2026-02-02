# CodeSense Engine: Unified Implementation Plan v2.1 - Part 1: Architecture

**Version:** 2.1  
**Status:** Pre-implementation  
**Stack:** Node.js (ESM), `better-sqlite3` (WAL), `sqlite-vec`, `web-tree-sitter`  
**Language:** JavaScript (ESM) with JSDoc  
**Paradigm:** Functional Programming (Factory Functions, No Classes)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Data Model & Schema](#3-data-model--schema)
4. [Tiered Indexing System](#4-tiered-indexing-system)
5. [Implementation Roadmap](#5-implementation-roadmap)
6. [Technical Stack](#6-technical-stack)
7. [Coding Standards & Style](#7-coding-standards--style)
8. [Risks & Mitigations](#8-risks--mitigations)

---

## 1. Executive Summary

**CodeSense** is an AI-powered codebase understanding engine delivered as an MCP server. It generates senior-level implementation plans by combining:

- **Deterministic Graph Analysis** - AST parsing, call graphs, import resolution
- **Semantic Vector Search** - Natural language code discovery
- **LLM Enrichment** - Deep understanding of business logic, risks, and patterns

### Core Value Proposition

Turn any feature request or bug report into a concrete, architecture-aware implementation plan—reducing reliance on senior engineers for routine planning.

### Key Differentiator

"Planning first, coding second." While competitors focus on code generation and autocomplete, CodeSense focuses on the *pre-implementation* phase: understanding where to make changes, what patterns to follow, and what risks to consider.

### Core Philosophy

1. **"Graph First, AI Second"** - Use deterministic analysis for structure, LLM for meaning
2. **"Progressive, Not Blocking"** - Users can work immediately, quality improves over time
3. **"Enrich Smart, Not Everything"** - Target high-value code, not boilerplate

### Delivery

MCP Server (stdio transport) - Compatible with Cursor, Claude Desktop, and other MCP clients.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          MCP SERVER (Node.js)                             │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                      LAYER 3: PRODUCT                                │  │
│  │   generate_plan  |  investigate_bug  |  validate_diff  |  search    │  │
│  └────────────────────────────────┬────────────────────────────────────┘  │
│                                   │                                       │
│  ┌────────────────────────────────▼────────────────────────────────────┐  │
│  │                      LAYER 2: RETRIEVAL                              │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │  │
│  │  │   SEMANTIC   │  │  STRUCTURAL  │  │    GRAPH     │               │  │
│  │  │   (vectors)  │  │  (AST/grep)  │  │  (relations) │               │  │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘               │  │
│  │         └─────────────────┼─────────────────┘                        │  │
│  │                           ▼                                          │  │
│  │                  CONTEXT ASSEMBLER                                   │  │
│  │         (Combines results + enrichment for LLM)                      │  │
│  └────────────────────────────┬────────────────────────────────────────┘  │
│                               │                                           │
│  ┌────────────────────────────▼────────────────────────────────────────┐  │
│  │                      ENRICHMENT ENGINE                               │  │
│  │  ┌──────────────────┐         ┌──────────────────────┐              │  │
│  │  │  BACKGROUND QUEUE │         │   ON-DEMAND (SYNC)   │              │  │
│  │  │  - Git triggers   │         │   - Thorough mode    │              │  │
│  │  │  - Idle processing│         │   - Blocks if needed │              │  │
│  │  │  - Priority-based │         │                      │              │  │
│  │  └────────┬──────────┘         └──────────┬───────────┘              │  │
│  │           └────────────────┬──────────────┘                          │  │
│  │                            ▼                                         │  │
│  │                   ENRICHMENT CACHE                                   │  │
│  └────────────────────────────┬────────────────────────────────────────┘  │
│                               │                                           │
│  ┌────────────────────────────▼────────────────────────────────────────┐  │
│  │                      LAYER 1: UNDERSTANDING                          │  │
│  │  File Scan → Parse (AST) → Resolve Modules → Build Graph → Embed    │  │
│  └────────────────────────────┬────────────────────────────────────────┘  │
│                               │                                           │
│  ┌────────────────────────────▼────────────────────────────────────────┐  │
│  │                      LAYER 0: DATA                                   │  │
│  │           SQLite (WAL) + sqlite-vec                                  │  │
│  │   (files, definitions, relationships, chunks, vectors, enrichment)  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

### Layer Responsibilities

| Layer | Responsibility | Key Components |
|-------|---------------|----------------|
| **Layer 0: Data** | Persistent storage | SQLite + sqlite-vec |
| **Layer 1: Understanding** | Code analysis pipeline | Scanner, Parser, Resolver, Graph Builder, Embedder |
| **Enrichment Engine** | LLM-powered code analysis | Background Queue, On-Demand Enricher, Cache |
| **Layer 2: Retrieval** | Finding relevant code | Semantic Search, Structural Search, Graph Traversal |
| **Layer 3: Product** | User-facing tools | MCP tools (generate_plan, etc.) |

---

## 3. Data Model & Schema

### 3.1 Complete SQLite Schema

```sql
-- ============================================
-- TIER 0: File Metadata
-- ============================================
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  hash TEXT NOT NULL,                    -- For change detection
  size INTEGER,
  modified_at INTEGER,
  indexed_tier INTEGER DEFAULT 0,        -- Highest completed tier
  
  -- Graph metrics (computed in Tier 1)
  fan_in INTEGER DEFAULT 0,              -- How many files import this
  fan_out INTEGER DEFAULT 0,             -- How many files this imports
  complexity_score INTEGER DEFAULT 0,    -- Token count or cyclomatic
  
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_files_path ON files(path);
CREATE INDEX idx_files_fan_in ON files(fan_in DESC);

-- ============================================
-- TIER 1: Definitions (Graph Nodes)
-- ============================================
CREATE TABLE definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                    -- function, class, interface, const, type
  exported BOOLEAN DEFAULT FALSE,
  start_line INTEGER,
  end_line INTEGER,
  signature TEXT,                        -- For display: "async function foo(x: string): Promise<void>"
  
  -- For classes
  extends_name TEXT,                     -- Raw name, resolved in relationships
  implements_names TEXT,                 -- JSON array of interface names
  
  FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX idx_def_file ON definitions(file_id);
CREATE INDEX idx_def_name ON definitions(name);
CREATE INDEX idx_def_type ON definitions(type);
CREATE INDEX idx_def_exported ON definitions(exported) WHERE exported = 1;

-- ============================================
-- TIER 1: Relationships (Graph Edges)
-- ============================================
CREATE TABLE relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file_id INTEGER NOT NULL,
  source_def_id INTEGER,                 -- NULL for file-level imports
  target_file_id INTEGER,                -- NULL for external packages
  target_def_id INTEGER,                 -- NULL if unresolved
  target_name TEXT,                      -- Raw name (for display/debugging)
  type TEXT NOT NULL,                    -- import, call, extends, implements
  is_external BOOLEAN DEFAULT FALSE,     -- TRUE for npm packages
  line_number INTEGER,                   -- Where in source this occurs
  
  FOREIGN KEY(source_file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY(target_file_id) REFERENCES files(id) ON DELETE SET NULL,
  FOREIGN KEY(source_def_id) REFERENCES definitions(id) ON DELETE CASCADE,
  FOREIGN KEY(target_def_id) REFERENCES definitions(id) ON DELETE SET NULL
);

CREATE INDEX idx_rel_source ON relationships(source_file_id, source_def_id);
CREATE INDEX idx_rel_target ON relationships(target_file_id, target_def_id);
CREATE INDEX idx_rel_type ON relationships(type);

-- ============================================
-- TIER 2: Chunks (Embedding Units)
-- ============================================
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,                   -- UUID or hash-based ID
  file_id INTEGER NOT NULL,
  def_id INTEGER,                        -- Link to definition if chunk = single function/class
  type TEXT NOT NULL,                    -- class, function, function_group, module
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  token_count INTEGER,                   -- For context budget management
  context_json TEXT,                     -- JSON: { imports: [], language: "javascript" }
  
  FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY(def_id) REFERENCES definitions(id) ON DELETE SET NULL
);

CREATE INDEX idx_chunks_file ON chunks(file_id);
CREATE INDEX idx_chunks_def ON chunks(def_id);

-- ============================================
-- TIER 2: Vector Storage (sqlite-vec)
-- ============================================
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[384]                   -- all-MiniLM-L6-v2 dimension
);

-- ============================================
-- TIER 3: Enrichment Cache
-- ============================================
CREATE TABLE enrichment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT UNIQUE NOT NULL,
  file_id INTEGER NOT NULL,
  hash TEXT NOT NULL,                    -- File hash when enriched (invalidation)
  content_hash TEXT,                     -- Hash of chunk code (for reuse on file rename)
  
  -- Core understanding
  summary TEXT,                          -- 1 sentence
  purpose TEXT,                          -- Business/technical purpose
  
  -- Structural insights
  key_operations TEXT,                   -- JSON array: ["validates input", "calls API"]
  side_effects TEXT,                     -- JSON array: ["writes to DB", "sends email"]
  state_changes TEXT,                    -- JSON array: ["modifies User table"]
  implicit_dependencies TEXT,            -- JSON array: ["requires REDIS_URL env var"]
  
  -- Pattern detection
  design_patterns TEXT,                  -- JSON array: ["Factory", "Singleton"]
  architectural_patterns TEXT,           -- JSON array: ["Repository", "Service"]
  anti_patterns TEXT,                    -- JSON array: ["God class", "circular dep"]
  
  -- Risk signals
  complexity TEXT,                       -- low, medium, high
  security_concerns TEXT,                -- JSON array
  performance_concerns TEXT,             -- JSON array
  
  -- Business context
  business_rules TEXT,                   -- JSON array: human-readable business logic
  
  -- Semantic tags
  tags TEXT,                             -- JSON array for search enhancement
  
  -- Metadata
  model_used TEXT,
  prompt_version TEXT,                   -- For cache invalidation on prompt changes
  enriched_at INTEGER,
  confidence REAL,
  
  FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
  FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX idx_enrichment_file ON enrichment(file_id);
CREATE INDEX idx_enrichment_hash ON enrichment(hash);
CREATE INDEX idx_enrichment_content ON enrichment(content_hash);

-- ============================================
-- ENRICHMENT QUEUE
-- ============================================
CREATE TABLE enrichment_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  priority INTEGER DEFAULT 0,            -- Higher = process first (minimum 0)
  status TEXT DEFAULT 'pending',         -- pending, processing, complete, failed
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,        -- Maximum retry attempts
  error_message TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  processed_at INTEGER,
  next_retry_at INTEGER,                 -- When to retry (exponential backoff)
  
  FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
  FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX idx_queue_status ON enrichment_queue(status, priority DESC);
CREATE INDEX idx_queue_chunk ON enrichment_queue(chunk_id);
CREATE INDEX idx_queue_retry ON enrichment_queue(next_retry_at) WHERE status = 'failed' AND attempts < max_attempts;

-- ============================================
-- PLANS (For validate_diff reference)
-- ============================================
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  task_type TEXT NOT NULL,               -- feature, bug, refactor
  mode TEXT NOT NULL,                    -- fast, thorough
  plan_json TEXT NOT NULL,
  chunks_used TEXT,                      -- JSON array of chunk_ids used
  created_at INTEGER DEFAULT (unixepoch())
);

-- ============================================
-- INDEX STATE
-- ============================================
CREATE TABLE index_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

### 3.2 In-Memory Maps (Performance Optimization)

Built once at startup/reindex, used throughout for O(1) lookups:

```javascript
/**
 * @typedef {Object} IndexMaps
 * @property {Map<string, number>} filePathToId - "/src/utils.js" -> 42
 * @property {Map<number, string>} fileIdToPath - 42 -> "/src/utils.js"
 * @property {Map<number, Export[]>} fileExports - fileId -> [{ name, defId, type }]
 * @property {Map<string, SymbolLocation[]>} symbolIndex - "calculateTax" -> [{ fileId, defId }]
 * @property {Map<string, string>} pathAliases - "@/" -> "./src/"
 */

/**
 * @typedef {Object} Export
 * @property {string} name
 * @property {number} defId
 * @property {'function'|'class'|'const'|'type'|'interface'} type
 * @property {boolean} isDefault
 */

/**
 * @typedef {Object} SymbolLocation
 * @property {number} fileId
 * @property {number} defId
 * @property {boolean} isExported
 */
```

**Why In-Memory Maps?**

| Approach | 10k imports in codebase |
|----------|------------------------|
| SQLite query per import | ~10,000 queries, ~5-10 seconds |
| In-memory Map lookup | ~10,000 lookups, <100ms |

---

## 4. Tiered Indexing System

### 4.1 Tier Overview

| Tier | Name | Time | Blocking | What Happens | User Can |
|------|------|------|----------|--------------|----------|
| 0 | File Scan | < 5s | Yes | Scan files, respect .gitignore, compute hashes | Browse files, grep |
| 1 | Structure | 30s-2min | No | AST parse, extract definitions, build graph | Structural search, graph queries |
| 2 | Embeddings | 5-15min | No | Chunk code, generate vectors | Semantic search |
| 3 | Enrichment | Ongoing | No | LLM analysis (background + on-demand) | Rich context in plans |

### 4.2 Tier 0: File Scanner (Functional)

**Responsibility:** Discover all source files, compute hashes for change detection.

```javascript
import { glob } from 'fast-glob';
import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';

/**
 * @typedef {Object} FileEntry
 * @property {string} path
 * @property {string} hash
 * @property {number} size
 * @property {number} modifiedAt
 */

/**
 * @typedef {Object} ChangeSet
 * @property {FileEntry[]} added
 * @property {FileEntry[]} modified
 * @property {FileEntry[]} unchanged
 * @property {string[]} deleted
 */

/**
 * @typedef {Object} FileScanner
 * @property {function(string): Promise<FileEntry[]>} scan
 * @property {function(Object, FileEntry[]): Promise<ChangeSet>} detectChanges
 */

/**
 * Creates a file scanner for discovering source files.
 * @param {Object} config - Scanner configuration
 * @param {string[]} config.ignorePatterns - Patterns to ignore
 * @returns {FileScanner}
 */
export function createFileScanner(config) {
  const ignorePatterns = config.ignorePatterns || [
    'node_modules/**',
    'dist/**',
    'build/**',
    '.git/**',
    '**/*.d.ts',
    '**/*.min.js',
    'coverage/**'
  ];

  /**
   * Processes a single file to extract metadata.
   * @private
   */
  const processFile = async (filePath) => {
    const [content, stats] = await Promise.all([
      readFile(filePath, 'utf-8'),
      stat(filePath)
    ]);

    return {
      path: filePath,
      hash: createHash('sha256').update(content).digest('hex').slice(0, 16),
      size: stats.size,
      modifiedAt: Math.floor(stats.mtimeMs)
    };
  };

  /**
   * Scans directory for source files.
   */
  const scan = async (rootPath) => {
    const files = await glob('**/*.{ts,tsx,js,jsx}', {
      cwd: rootPath,
      ignore: ignorePatterns,
      absolute: true,
      dot: false
    });

    const entries = [];
    const batchSize = 100;

    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(p => processFile(p)));
      entries.push(...results);
    }

    return entries;
  };

  /**
   * Detects changes between scanned files and database.
   */
  const detectChanges = async (db, entries) => {
    const existing = new Map(
      db.prepare('SELECT path, hash FROM files').all()
        .map((r) => [r.path, r.hash])
    );

    const added = [];
    const modified = [];
    const unchanged = [];
    const deleted = [];

    for (const entry of entries) {
      const existingHash = existing.get(entry.path);
      if (!existingHash) {
        added.push(entry);
      } else if (existingHash !== entry.hash) {
        modified.push(entry);
      } else {
        unchanged.push(entry);
      }
      existing.delete(entry.path);
    }

    deleted.push(...existing.keys());

    return { added, modified, unchanged, deleted };
  };

  return { scan, detectChanges };
}
```

---

## 5. Implementation Roadmap

### 5.1 Phase Overview

| Phase | Duration | Focus | Deliverable |
|-------|----------|-------|-------------|
| 1 | Days 1-2 | Skeleton | Scanner + SQLite schema working |
| 2 | Days 3-5 | Graph | Parser + ModuleResolver + Graph Builder |
| 3 | Days 6-7 | Vectors | Chunker + Embedder + Semantic search |
| 4 | Days 8-9 | MCP | MCP server + search_codebase + get_index_status |
| 5 | Days 10-12 | Planning | generate_plan + Context Assembler |
| 6 | Days 13-15 | Enrichment | Background queue + On-demand enricher |
| 7 | Days 16-18 | Polish | Bug investigation + Validation + Testing |

### 5.2 Phase 1: Skeleton (Days 1-2)

**Goal:** Basic file scanning and database setup.

**Tasks:**
- [x] Initialize project with JavaScript (ESM)
- [x] Set up `better-sqlite3` with WAL mode
- [x] Implement full SQLite schema (all tables)
- [x] Implement `createFileScanner` factory function
  - [x] fast-glob integration
  - [x] .gitignore respect
  - [x] Hash computation
  - [x] Change detection
- [x] Write tests for scanner

**Deliverable:** A script that scans a codebase and populates the `files` table.

```bash
node src/index.js scan /path/to/project
# Output: "Scanned 847 files in 1.2s"
```

### 5.3 Phase 2: Graph (Days 3-5)

**Goal:** AST parsing and relationship graph.

**Tasks:**
- [x] Set up `web-tree-sitter` with WASM binaries
  - [x] Configure WASM file resolution from node_modules
  - [x] Add build script to copy WASM files if needed
- [x] Implement `createASTParser` factory function (with mandatory JSDoc)
  - [x] Definition extraction (functions, classes, interfaces)
  - [x] Import extraction
  - [x] Call extraction
- [x] Implement `createIndexBuilder` (in-memory maps)
- [x] Parse `tsconfig.json` OR `jsconfig.json` for path aliases
- [x] Implement `createModuleResolver` factory
  - [x] Relative path resolution
  - [x] Alias resolution (@/, ~/)
  - [x] Extension/index file resolution
  - [x] Support both TS and JS config files
- [x] Implement `createGraphBuilder` factory
  - [x] Import relationships
  - [x] Call relationships
  - [x] Fan-in/fan-out metrics
- [x] Write tests for parser and resolver

#### WASM File Resolution for Tree-Sitter

```javascript
import { createRequire } from 'module';
import Parser from 'web-tree-sitter';
import path from 'path';

// Use createRequire to resolve node_modules paths in ESM
const require = createRequire(import.meta.url);

/**
 * Initializes the tree-sitter parser with language support.
 * @returns {Promise<Object>} Parser instance with loaded languages
 */
async function initializeParser() {
  await Parser.init();
  
  const parser = new Parser();
  
  // Resolve WASM files from node_modules
  const tsWasmPath = require.resolve('tree-sitter-typescript/tree-sitter-typescript.wasm');
  const tsxWasmPath = require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm');
  const jsWasmPath = require.resolve('tree-sitter-javascript/tree-sitter-javascript.wasm');
  
  // Load languages
  const languages = {
    typescript: await Parser.Language.load(tsWasmPath),
    tsx: await Parser.Language.load(tsxWasmPath),
    javascript: await Parser.Language.load(jsWasmPath)
  };
  
  return { parser, languages };
}

/**
 * Selects appropriate language based on file extension.
 * @param {string} filePath
 * @param {Object} languages
 * @returns {Object} Tree-sitter language
 */
function getLanguage(filePath, languages) {
  const ext = path.extname(filePath).toLowerCase();
  
  switch (ext) {
    case '.ts':
      return languages.typescript;
    case '.tsx':
      return languages.tsx;
    case '.js':
    case '.mjs':
    case '.cjs':
      return languages.javascript;
    case '.jsx':
      return languages.tsx; // TSX parser handles JSX
    default:
      throw new Error(`Unsupported file extension: ${ext}`);
  }
}
```

**Deliverable:** Query the graph to answer "Which files import auth.js?"

```sql
SELECT f.path FROM files f
JOIN relationships r ON r.source_file_id = f.id
WHERE r.target_file_id = (SELECT id FROM files WHERE path LIKE '%auth.js')
  AND r.type = 'import';
```

### 5.4 Phase 3: Vectors (Days 6-7)

**Goal:** Semantic code search.

**Tasks:**
- [x] Set up `sqlite-vec` extension
- [x] Implement `createChunker` factory
  - [x] Class chunking
  - [x] Function grouping
  - [x] Token counting
- [x] Implement `createEmbedder` factory
  - [x] @xenova/transformers integration
  - [x] Batch embedding
- [x] Implement `createSemanticSearch` factory
- [ ] Implement `createStructuralSearch` factory
- [x] Implement `createGrepSearch` factory (ripgrep wrapper)
- [x] Write tests for search methods

**Deliverable:** Semantic search working.

```javascript
const results = await semanticSearch.search("where is user authentication handled");
// Returns: [{ file: "src/auth/login.js", score: 0.87 }, ...]
```

### 5.5 Phase 4: MCP (Days 8-9)

**Goal:** MCP server with basic tools.

**Tasks:**
- [x] Set up MCP SDK with stdio transport
- [x] Implement `createCodeSenseServer` factory
- [x] Implement `search_codebase` tool
- [x] Implement `get_index_status` tool
- [x] Implement `createQueryEngine` factory (orchestrator)
- [ ] Implement `createQueryUnderstandingEngine` factory
- [x] Test with Claude Desktop / Cursor

**Deliverable:** MCP server responding to search queries.

```json
// Claude Desktop config
{
  "mcpServers": {
    "codesense": {
      "command": "node",
      "args": ["./src/index.js"],
      "cwd": "/path/to/project"
    }
  }
}
```

### 5.6 Phase 5: Planning (Days 10-12)

**Goal:** Plan generation working.

**Tasks:**
- [x] Implement `createContextAssembler` factory
- [x] Implement `createLLMClient` factory (OpenRouter)
- [x] Implement `createPlanGenerator` factory
  - [x] Prompt engineering
  - [x] Plan artifact structure
  - [x] Confidence scoring
- [x] Implement `generate_plan` tool
- [ ] Store plans in database
- [ ] Test on real codebases

**Deliverable:** Generate useful implementation plans.

```
User: generate_plan "Add rate limiting to the API endpoints"
CodeSense: [Returns structured plan with files, steps, risks]
```

### 5.7 Phase 6: Enrichment (Days 13-15)

**Goal:** LLM-powered code understanding.

**Tasks:**
- [ ] Implement `createEnrichmentPrioritizer` factory (graph-guided)
- [ ] Implement `createHierarchicalEnricher` factory
  - [ ] Dependency context building
  - [ ] Enrichment prompts
- [ ] Implement `createBackgroundEnrichmentQueue` factory
  - [ ] Priority-based processing
  - [ ] Retry logic with exponential backoff
  - [ ] Daily limits
  - [ ] Git commit triggers
- [ ] Implement `createOnDemandEnricher` factory
- [ ] Implement `createEnrichmentCacheManager` factory
- [ ] Integrate enrichment into Context Assembler
- [ ] Test thorough mode

**Deliverable:** Enriched context in plans.

```
Plan includes:
- "PaymentService handles Stripe webhooks and validates signatures"
- "Side effects: writes to transactions table, sends receipt email"
- "Security concern: API key stored in environment variable"
```

### 5.8 Phase 7: Polish (Days 16-18)

**Goal:** Complete feature set and polish.

**Tasks:**
- [ ] Implement `createBugInvestigator` factory
  - [ ] Stack trace parsing
  - [ ] Hypothesis generation
- [ ] Implement `createDiffValidator` factory
  - [ ] Diff parsing
  - [ ] Plan comparison
- [ ] Implement `investigate_bug` tool
- [ ] Implement `validate_diff` tool
- [ ] Add file watcher for auto-reindex
- [ ] Error handling and logging
- [ ] Performance optimization
- [ ] Documentation

**Deliverable:** Complete CodeSense MVP.

---

## 6. Technical Stack

### 6.1 Core Dependencies

```json
{
  "name": "codesense",
  "version": "1.0.0",
  "type": "module",
  "main": "src/index.js",
  "bin": {
    "codesense": "./src/index.js"
  },
  "scripts": {
    "dev": "node --watch src/index.js",
    "start": "node src/index.js",
    "test": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@xenova/transformers": "^2.17.0",
    "ai": "^3.0.0",
    "@ai-sdk/openai": "^0.0.1",
    "ollama-ai-provider": "^1.1.0",
    "better-sqlite3": "^11.0.0",
    "sqlite-vec": "^0.1.0",
    "web-tree-sitter": "^0.22.0",
    "fast-glob": "^3.3.2",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "vitest": "^2.0.0"
  }
}
```

### 6.2 Component Technology Choices

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Runtime** | Node.js 20+ | MCP SDK, ecosystem, ESM support |
| **Language** | JavaScript (ESM) | JSDoc + Zod for type safety |
| **Paradigm** | Functional (Factory Functions) | No classes, closures for state, dependency injection |
| **Protocol** | MCP (stdio) | Cursor/Claude integration |
| **AST Parser** | web-tree-sitter | Cross-platform WASM, no native deps |
| **Metadata DB** | better-sqlite3 | Zero config, WAL mode, fast |
| **Vector DB** | sqlite-vec | Same DB, simpler deployment |
| **Embeddings** | @xenova/transformers | Local, free, fast enough |
| **LLM Client** | Vercel AI SDK Core | Lightweight, provider-independent, structured output |
| **LLM Provider** | OpenRouter / Ollama | Local or cloud support via unified API |
| **Default LLM** | Claude Haiku / Llama 3 | Cost-effective (cloud) or private (local) |

### 6.3 File Structure

```
codesense/
├── src/
│   ├── index.js                    # Entry point
│   │
│   ├── mcp/
│   │   ├── server.js               # MCP server setup
│   │   └── handlers.js             # Tool request handlers
│   │
│   ├── indexing/
│   │   ├── index-manager.js        # Orchestrates all tiers
│   │   ├── file-scanner.js         # Tier 0: File discovery
│   │   ├── ast-parser.js           # Tier 1: Tree-sitter parsing
│   │   ├── module-resolver.js      # Tier 1: Import resolution
│   │   ├── graph-builder.js        # Tier 1: Relationship graph
│   │   ├── index-builder.js        # In-memory maps
│   │   ├── chunker.js              # Tier 2: Smart chunking
│   │   └── embedder.js             # Tier 2: Vector generation
│   │
│   ├── enrichment/
│   │   ├── prioritizer.js          # Graph-guided selection
│   │   ├── hierarchical-enricher.js # Context-aware enrichment
│   │   ├── background-queue.js     # Async processing
│   │   ├── on-demand-enricher.js   # Sync enrichment
│   │   └── cache-manager.js        # Invalidation logic
│   │
│   ├── search/
│   │   ├── query-engine.js         # Combines search methods
│   │   ├── query-understanding.js  # Intent classification
│   │   ├── semantic-search.js      # Vector search
│   │   ├── structural-search.js    # AST-based search
│   │   ├── graph-search.js         # Relationship queries
│   │   └── grep-search.js          # Ripgrep wrapper
│   │
│   ├── planning/
│   │   ├── plan-generator.js       # Main planning logic
│   │   ├── context-assembler.js    # Builds LLM context
│   │   ├── bug-investigator.js     # Bug investigation
│   │   └── diff-validator.js       # Plan validation
│   │
│   ├── llm/
│   │   ├── client.js               # LLM abstraction
│   │   ├── prompts.js              # All LLM prompts
│   │   └── schemas.js              # Zod schemas for LLM outputs
│   │
│   ├── db/
│   │   ├── adapter.js              # SQLite operations
│   │   └── schema.sql              # Full schema
│   │
│   └── utils/
│       ├── config.js               # Configuration
│       ├── logger.js               # Logging
│       └── tokens.js               # Token counting
│
├── test/
│   ├── fixtures/                   # Test codebases
│   ├── indexing/
│   ├── search/
│   └── planning/
│
├── .codesense/                     # Created at runtime
│   └── index.db                    # SQLite database
│
├── package.json
├── jsconfig.json                   # Path aliases for JS
├── .env.example
└── README.md
```

### 6.4 Configuration

```javascript
// src/utils/config.js
import { z } from 'zod';

const ConfigSchema = z.object({
  // LLM
  llmProvider: z.enum(['openrouter', 'openai', 'ollama', 'custom']).default('openrouter'),
  llmApiKey: z.string().optional(),
  llmBaseUrl: z.string().optional(),
  llmModel: z.string().default('anthropic/claude-3-haiku'),
  
  // Embedding
  embeddingModel: z.string().default('Xenova/all-MiniLM-L6-v2'),
  embeddingDimension: z.number().default(384),
  
  // Indexing
  maxFileSizeKb: z.number().default(500),
  ignoredDirs: z.array(z.string()).default(['node_modules', 'dist', '.git']),
  
  // Enrichment
  enrichmentEnabled: z.boolean().default(true),
  maxDailyEnrichments: z.number().default(1000),
  enrichmentBatchSize: z.number().default(5),
  maxEnrichmentRetries: z.number().default(3),
  
  // Search
  defaultSearchLimit: z.number().default(10),
  maxContextTokens: z.number().default(8000)
});

/**
 * @typedef {z.infer<typeof ConfigSchema>} Config
 */

/**
 * Loads and validates configuration from environment.
 * @returns {Config}
 */
export function loadConfig() {
  return ConfigSchema.parse({
    llmApiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
    llmProvider: process.env.LLM_PROVIDER,
    llmBaseUrl: process.env.LLM_BASE_URL,
    llmModel: process.env.LLM_MODEL,
    maxEnrichmentRetries: process.env.MAX_ENRICHMENT_RETRIES ? 
      parseInt(process.env.MAX_ENRICHMENT_RETRIES, 10) : undefined
  });
}
```

### 6.5 Environment Variables

```bash
# .env.example

# Provider Selection (openrouter | ollama | openai | custom)
LLM_PROVIDER=openrouter

# Cloud: Required for OpenRouter/OpenAI
LLM_API_KEY=sk-or-...

# Local: Required for Ollama / LM Studio (e.g., http://localhost:11434/v1)
LLM_BASE_URL=http://localhost:11434

# Model ID
LLM_MODEL=anthropic/claude-3-haiku

# Enrichment retry limit
MAX_ENRICHMENT_RETRIES=3
```

---

## 7. Coding Standards & Style

**Goal:** Ensure the codebase is maintainable, readable, and easily indexed by CodeSense itself.

### 7.1 Structure & Size
- **File Size:** Hard limit of **300 lines** per file. 
- **Function Size:** Ideal limit of **50 lines**.
- **Patterns:** Use **Factory Functions** and **Functional Programming** principles.
  - **NO `class` or `this` keywords allowed**
  - Use closures for private state
  - Pass dependencies explicitly (Dependency Injection)
- **Exports:** Prefer **named exports** over default exports.

### 7.2 Functional Design (Factory Functions)
- Components must be created via factory functions that return an object containing the public API
- All dependencies must be passed as arguments to the factory
- Use pure functions where possible
- Side effects should be isolated and clearly documented

```javascript
/**
 * @typedef {Object} EnrichmentPrioritizer
 * @property {function(number): number} calculatePriority
 * @property {function(): Promise<void>} queueHighPriorityChunks
 */

/**
 * Creates a prioritizer for enrichment.
 * @param {Object} db - SQLite database adapter
 * @returns {EnrichmentPrioritizer}
 */
export function createEnrichmentPrioritizer(db) {
  // Private functions using closures
  const calculatePriority = (fileId) => {
    // Logic here...
  };

  const queueHighPriorityChunks = async () => {
    // Logic here...
  };

  // Return public API
  return {
    calculatePriority,
    queueHighPriorityChunks
  };
}
```

### 7.3 Documentation (JSDoc)
- **Mandatory JSDoc** for all exported factory functions
- JSDoc must include `@param`, `@returns`, and `@typedef` for complex objects
- Document side effects explicitly
- Use `@private` for internal helper functions

### 7.4 Pattern Consistency
- **Zod Everywhere:** Use Zod for validation at boundaries
- **Typed Errors:** Use custom error classes (extending `Error`) for domain-specific failures
- **Pure Functions:** Separate side-effecting logic from pure logic
- **ESM:** Use pure JavaScript (ESM) with `.js` extensions
- **No Classes:** Use factory functions with closures for encapsulation

---

## 8. Risks & Mitigations

### 8.1 Technical Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **Tree-sitter WASM performance** | Slow parsing on large files | Medium | Benchmark early; skip files > 500KB; use worker threads if needed |
| **sqlite-vec limitations** | Slow on 50k+ chunks | Low | Acceptable for MVP; migrate to Qdrant if needed post-launch |
| **Module resolution edge cases** | Broken graph for complex projects | High | Parse jsconfig.json in Phase 1; test on real projects early |
| **LLM hallucination in plans** | Bad recommendations | Medium | Include source code in prompts; add confidence scores; user verification |
| **LLM Testing Costs** | High cost during dev | Low | Strict use of interface-based LLMClient and mocking in Vitest |
| **Memory usage** | OOM on large codebases | Low | Stream file processing; limit in-memory map size |

### 8.2 Product Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **Plans aren't useful** | No adoption | High | Test on real tasks early; iterate prompts; user feedback loop |
| **Index takes too long** | Bad first impression | Medium | Progressive tiers (never block user); show progress |
| **Enrichment too expensive** | Cost concerns | Medium | Default to cheap models; daily limits; clear cost visibility |
| **Competition** | Feature parity with Cursor | High | Focus on planning quality + validation loop (unique value) |

### 8.3 Mitigation Strategies

**For Module Resolution:**
```javascript
// Start with explicit support for common patterns
const SUPPORTED_ALIAS_PATTERNS = [
  { pattern: '@/', replacement: './src/' },
  { pattern: '~/', replacement: './src/' },
];

// Log unresolved imports for debugging
if (resolved.type === 'unresolved') {
  logger.warn(`Unresolved import: ${importPath} in ${sourceFile}`);
  unresolvedImports.push({ source: sourceFile, import: importPath });
}
```

**For LLM Reliability:**
```javascript
/**
 * Validates and parses LLM JSON response.
 * @template T
 * @param {string} response - Raw LLM output
 * @param {import('zod').ZodSchema<T>} schema - Zod validation schema
 * @returns {T} Validated object
 */
function parseLLMResponse(response, schema) {
  try {
    const parsed = JSON.parse(response);
    return schema.parse(parsed);
  } catch (error) {
    logger.error('LLM response validation failed', { response, error });
    throw new Error('Invalid LLM response format');
  }
}
```

**For Performance:**
```javascript
// Profile critical paths
const timer = logger.startTimer();
await indexManager.runTier1();
timer.done({ message: 'Tier 1 complete', files: fileCount });

// Set hard limits
const MAX_FILES_PER_BATCH = 100;
const MAX_EMBEDDING_BATCH = 10;
const MAX_ENRICHMENT_PER_REQUEST = 5;
```

---

*End of Part 1*
