-- ============================================
-- TIER 0: File Metadata
-- ============================================
CREATE TABLE IF NOT EXISTS files (
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

CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_fan_in ON files(fan_in DESC);

-- ============================================
-- TIER 1: Definitions (Graph Nodes)
-- ============================================
CREATE TABLE IF NOT EXISTS definitions (
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

CREATE INDEX IF NOT EXISTS idx_def_file ON definitions(file_id);
CREATE INDEX IF NOT EXISTS idx_def_name ON definitions(name);
CREATE INDEX IF NOT EXISTS idx_def_type ON definitions(type);
CREATE INDEX IF NOT EXISTS idx_def_exported ON definitions(exported) WHERE exported = 1;

-- ============================================
-- TIER 1: Relationships (Graph Edges)
-- ============================================
CREATE TABLE IF NOT EXISTS relationships (
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

CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source_file_id, source_def_id);
CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_file_id, target_def_id);
CREATE INDEX IF NOT EXISTS idx_rel_type ON relationships(type);

-- ============================================
-- TIER 2: Chunks (Embedding Units)
-- ============================================
CREATE TABLE IF NOT EXISTS chunks (
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
  
  -- Contextual embedding support (added for Anthropic-style contextual retrieval)
  jsdoc TEXT,                            -- Extracted JSDoc comment for context
  signature TEXT,                        -- Function/class signature
  
  FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY(def_id) REFERENCES definitions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_chunks_def ON chunks(def_id);

-- ============================================
-- TIER 2: Vector Storage - Base Embeddings (sqlite-vec)
-- Base embeddings: Location + JSDoc + Code (no LLM enrichment)
-- ============================================
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[384]                   -- all-MiniLM-L6-v2 dimension
);

-- ============================================
-- TIER 2: Vector Storage - Enriched Embeddings (sqlite-vec)
-- Enriched embeddings: Location + JSDoc + LLM Enrichment + Code
-- Created after LLM enrichment completes, provides better semantic search
-- ============================================
CREATE VIRTUAL TABLE vec_chunks_enriched USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[384]                   -- all-MiniLM-L6-v2 dimension
);

-- ============================================
-- TIER 3: Enrichment Cache
-- ============================================
CREATE TABLE IF NOT EXISTS enrichment (
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

CREATE INDEX IF NOT EXISTS idx_enrichment_file ON enrichment(file_id);
CREATE INDEX IF NOT EXISTS idx_enrichment_hash ON enrichment(hash);
CREATE INDEX IF NOT EXISTS idx_enrichment_content ON enrichment(content_hash);

-- ============================================
-- ENRICHMENT QUEUE
-- ============================================
CREATE TABLE IF NOT EXISTS enrichment_queue (
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

CREATE INDEX IF NOT EXISTS idx_queue_status ON enrichment_queue(status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_queue_chunk ON enrichment_queue(chunk_id);
CREATE INDEX IF NOT EXISTS idx_queue_retry ON enrichment_queue(next_retry_at) WHERE status = 'failed' AND attempts < max_attempts;

-- ============================================
-- PLANS (For validate_diff reference)
-- ============================================
CREATE TABLE IF NOT EXISTS plans (
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
CREATE TABLE IF NOT EXISTS index_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
