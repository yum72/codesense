// ═══════════════════════════════════════════════════════════════════════════
// CODESENSE MEMGRAPH SCHEMA
// ═══════════════════════════════════════════════════════════════════════════
//
// This schema defines the graph data model for CodeSense.
// Execute this file against Memgraph to initialize the database.
//
// Usage:
//   cat schema.cypher | mgconsole
//   OR run via the adapter's initSchema() method

// ─────────────────────────────────────────────────────────────────────────────
// CONSTRAINTS (Unique identifiers)
// ─────────────────────────────────────────────────────────────────────────────

// File nodes are uniquely identified by their path
CREATE CONSTRAINT ON (f:File) ASSERT f.path IS UNIQUE;

// Chunk nodes are uniquely identified by their id
CREATE CONSTRAINT ON (c:Chunk) ASSERT c.id IS UNIQUE;

// Definition nodes are uniquely identified by file_id + name + type
CREATE CONSTRAINT ON (d:Definition) ASSERT d.id IS UNIQUE;

// EnrichmentQueueItem nodes are uniquely identified by chunk_id
CREATE CONSTRAINT ON (e:EnrichmentQueueItem) ASSERT e.chunk_id IS UNIQUE;

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES (Performance optimization)
// ─────────────────────────────────────────────────────────────────────────────

// File lookups
CREATE INDEX ON :File(path);
CREATE INDEX ON :File(hash);
CREATE INDEX ON :File(indexed_tier);

// Chunk lookups
CREATE INDEX ON :Chunk(id);
CREATE INDEX ON :Chunk(name);
CREATE INDEX ON :Chunk(type);
CREATE INDEX ON :Chunk(context_tier);
CREATE INDEX ON :Chunk(file_id);

// Definition lookups
CREATE INDEX ON :Definition(name);
CREATE INDEX ON :Definition(type);
CREATE INDEX ON :Definition(exported);

// Enrichment queue lookups
CREATE INDEX ON :EnrichmentQueueItem(status);
CREATE INDEX ON :EnrichmentQueueItem(priority);
CREATE INDEX ON :EnrichmentQueueItem(next_retry_at);

// ─────────────────────────────────────────────────────────────────────────────
// VECTOR INDEX (Semantic search)
// ─────────────────────────────────────────────────────────────────────────────

// Vector index for chunk embeddings (384 dimensions for all-MiniLM-L6-v2)
// Note: This uses Memgraph's native vector index (v3.7+)
// The capacity should be larger than expected chunk count
CREATE VECTOR INDEX chunk_embedding_index ON :Chunk(embedding) WITH CONFIG {"dimension": 384, "metric": "cos", "capacity": 50000};

// ─────────────────────────────────────────────────────────────────────────────
// NODE SCHEMA DOCUMENTATION
// ─────────────────────────────────────────────────────────────────────────────
//
// :File {
//   path: STRING,                    // Unique identifier (absolute path)
//   hash: STRING,                    // Content hash for change detection
//   size: INTEGER,
//   modified_at: INTEGER,            // Unix timestamp
//   indexed_tier: INTEGER,           // 0=scanned, 1=parsed, 2=chunked, 3=graph
//   fan_in: INTEGER,                 // Files importing this
//   fan_out: INTEGER,                // Files this imports
//   complexity_score: INTEGER,
//   created_at: INTEGER,
//   updated_at: INTEGER
// }
//
// :Chunk {
//   id: STRING,                      // Unique chunk identifier (hash-based)
//   file_id: STRING,                 // Reference to File.path
//   name: STRING,                    // Function/class name
//   type: STRING,                    // function, class, method, module
//   code: STRING,                    // Raw source code
//   jsdoc: STRING,                   // Extracted JSDoc comment
//   signature: STRING,               // Function/class signature
//   start_line: INTEGER,
//   end_line: INTEGER,
//   token_count: INTEGER,
//   
//   // Context Tier System
//   context_tier: STRING,            // "structural" | "partial" | "full"
//   
//   // Embeddings (384 dimensions)
//   embedding: LIST OF FLOAT,        // Current best embedding
//   
//   // Partial Enrichment (for "partial" tier)
//   partial_enrichments: STRING,     // JSON array of partial enrichment objects
//   
//   // Full Enrichment (for "full" tier)
//   enrichment: STRING,              // JSON object with full enrichment
//   research_sources: LIST OF STRING,     // Chunk IDs researched
//   research_source_hashes: STRING,       // JSON: {chunk_id: hash}
//   enriched_at: INTEGER,
//   
//   // Graph Analytics (computed)
//   pagerank: FLOAT,
//   community_id: INTEGER
// }
//
// :Definition {
//   id: STRING,                      // Unique: file_path + name + type
//   file_id: STRING,                 // Reference to File.path
//   name: STRING,
//   type: STRING,                    // function, class, interface, const, type
//   exported: BOOLEAN,
//   start_line: INTEGER,
//   end_line: INTEGER,
//   signature: STRING
// }
//
// :EnrichmentQueueItem {
//   chunk_id: STRING,                // Reference to Chunk.id
//   priority: INTEGER,               // Higher = process first
//   status: STRING,                  // pending, processing, complete, failed
//   attempts: INTEGER,
//   max_attempts: INTEGER,
//   error_message: STRING,
//   created_at: INTEGER,
//   processed_at: INTEGER,
//   next_retry_at: INTEGER
// }
//
// ─────────────────────────────────────────────────────────────────────────────
// EDGE SCHEMA DOCUMENTATION
// ─────────────────────────────────────────────────────────────────────────────
//
// (:File)-[:CONTAINS]->(:Chunk)
// (:File)-[:CONTAINS]->(:Definition)
//
// (:Chunk)-[:CALLS {line: INTEGER}]->(:Chunk)
// (:Chunk)-[:IMPORTS {line: INTEGER}]->(:Chunk)
// (:Chunk)-[:EXTENDS]->(:Chunk)
// (:Chunk)-[:IMPLEMENTS]->(:Chunk)
// (:Chunk)-[:USES]->(:Chunk)
//
// (:File)-[:IMPORTS {line: INTEGER, is_external: BOOLEAN}]->(:File)
//
// ─────────────────────────────────────────────────────────────────────────────
// INITIALIZATION COMPLETE
// ─────────────────────────────────────────────────────────────────────────────
