import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} FileEntry
 * @property {string} path
 * @property {string} hash
 * @property {number} size
 * @property {number} modifiedAt
 */

/**
 * @typedef {Object} FileRecord
 * @property {number} id
 * @property {string} path
 * @property {string} hash
 * @property {number} size
 * @property {number} modifiedAt
 * @property {number} indexedTier
 */

/**
 * @typedef {Object} DefinitionRecord
 * @property {string} name
 * @property {string} type
 * @property {boolean} exported
 * @property {number} startLine
 * @property {number} endLine
 */

/**
 * @typedef {Object} ChunkRecord
 * @property {string} id
 * @property {number} fileId
 * @property {string} type
 * @property {string} name
 * @property {string} code
 * @property {string} [jsdoc] - Extracted JSDoc comment
 * @property {string} [signature] - Function/class signature
 * @property {number} startLine
 * @property {number} endLine
 * @property {number} tokenCount
 */

/**
 * Creates a database adapter for SQLite with vector support.
 * @param {string} dbPath - Path to the SQLite database file
 * @param {Object} [options]
 * @param {number} [options.batchSize=100] - Default batch size for bulk operations
 * @returns {Object} Database adapter API
 */
export function createDatabaseAdapter(dbPath, options = {}) {
  const db = new Database(dbPath);
  const batchSize = options.batchSize || 100;
  
  // Load vector extension
  sqliteVec.load(db);
  
  // Performance optimizations
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -64000'); // 64MB cache
  db.pragma('temp_store = MEMORY');

  // ─────────────────────────────────────────────────────────────────────────
  // Lazy-initialized prepared statements cache
  // ─────────────────────────────────────────────────────────────────────────
  const stmtCache = {};
  
  const getStmt = (key, sql) => {
    if (!stmtCache[key]) {
      stmtCache[key] = db.prepare(sql);
    }
    return stmtCache[key];
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Core Database Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initializes the database schema.
   * @param {string} schemaPath - Path to the SQL schema file
   */
  const initSchema = (schemaPath) => {
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    db.exec(schema);
  };

  /**
   * Closes the database connection.
   */
  const close = () => {
    db.close();
  };

  /**
   * Executes a function within a transaction.
   * @param {function} fn - Function to execute
   * @returns {any} Result of the function
   */
  const transaction = (fn) => {
    return db.transaction(fn);
  };

  /**
   * Prepares a SQL statement.
   * @param {string} sql - SQL statement
   * @returns {Object} Prepared statement
   */
  const prepare = (sql) => {
    return db.prepare(sql);
  };

  /**
   * Executes a SQL statement.
   * @param {string} sql - SQL statement
   */
  const exec = (sql) => {
    db.exec(sql);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // File Operations (Tier 0)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Gets all file paths and their hashes from the database.
   * @returns {Map<string, string>} Map of path -> hash
   */
  const getAllFileHashes = () => {
    const rows = db.prepare('SELECT path, hash FROM files').all();
    return new Map(rows.map(r => [r.path, r.hash]));
  };

  /**
   * Gets a file record by path.
   * @param {string} filePath 
   * @returns {FileRecord | undefined}
   */
  const getFileByPath = (filePath) => {
    const row = db.prepare('SELECT id, path, hash, size, modified_at, indexed_tier FROM files WHERE path = ?').get(filePath);
    if (!row) return undefined;
    return {
      id: row.id,
      path: row.path,
      hash: row.hash,
      size: row.size,
      modifiedAt: row.modified_at,
      indexedTier: row.indexed_tier
    };
  };

  /**
   * Upserts multiple files to the database in batches.
   * @param {FileEntry[]} entries - File entries to upsert
   * @param {number} [customBatchSize] - Override default batch size
   */
  const upsertFiles = (entries, customBatchSize) => {
    const size = customBatchSize || batchSize;
    const stmt = getStmt('upsertFile', `
      INSERT INTO files (path, hash, size, modified_at, indexed_tier)
      VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(path) DO UPDATE SET
        hash = excluded.hash,
        size = excluded.size,
        modified_at = excluded.modified_at,
        indexed_tier = 0,
        updated_at = unixepoch()
    `);
    
    for (let i = 0; i < entries.length; i += size) {
      const batch = entries.slice(i, i + size);
      db.transaction(() => {
        for (const entry of batch) {
          stmt.run(entry.path, entry.hash, entry.size, entry.modifiedAt);
        }
      })();
    }
  };

  /**
   * Deletes multiple files from the database in batches.
   * @param {string[]} paths - File paths to delete
   * @param {number} [customBatchSize] - Override default batch size
   */
  const deleteFiles = (paths, customBatchSize) => {
    const size = customBatchSize || batchSize;
    const stmt = getStmt('deleteFile', 'DELETE FROM files WHERE path = ?');
    
    for (let i = 0; i < paths.length; i += size) {
      const batch = paths.slice(i, i + size);
      db.transaction(() => {
        for (const p of batch) {
          stmt.run(p);
        }
      })();
    }
  };

  /**
   * Gets files that need processing for a given tier.
   * @param {number} tier - The minimum tier required
   * @returns {Array<{id: number, path: string}>}
   */
  const getFilesNeedingTier = (tier) => {
    return db.prepare('SELECT id, path FROM files WHERE indexed_tier < ?').all(tier);
  };

  /**
   * Gets all files at or above a given tier.
   * @param {number} tier - The minimum tier
   * @returns {Array<{id: number, path: string}>}
   */
  const getFilesAtTier = (tier) => {
    return db.prepare('SELECT id, path FROM files WHERE indexed_tier >= ?').all(tier);
  };

  /**
   * Updates a file's indexed tier.
   * @param {number} fileId 
   * @param {number} tier 
   */
  const updateFileTier = (fileId, tier) => {
    const stmt = getStmt('updateFileTier', 'UPDATE files SET indexed_tier = ? WHERE id = ?');
    stmt.run(tier, fileId);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Definition Operations (Tier 1)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Deletes all definitions for a file.
   * @param {number} fileId 
   */
  const deleteDefinitionsForFile = (fileId) => {
    const stmt = getStmt('deleteDefs', 'DELETE FROM definitions WHERE file_id = ?');
    stmt.run(fileId);
  };

  /**
   * Inserts multiple definitions for a file in a single transaction.
   * @param {number} fileId 
   * @param {DefinitionRecord[]} definitions 
   */
  const insertDefinitions = (fileId, definitions) => {
    const stmt = getStmt('insertDef', `
      INSERT INTO definitions (file_id, name, type, exported, start_line, end_line)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    db.transaction(() => {
      for (const def of definitions) {
        stmt.run(
          fileId,
          def.name,
          def.type,
          def.exported ? 1 : 0,
          def.startLine,
          def.endLine
        );
      }
    })();
  };

  /**
   * Replaces all definitions for a file (delete + insert in one transaction).
   * @param {number} fileId 
   * @param {DefinitionRecord[]} definitions 
   */
  const replaceDefinitions = (fileId, definitions) => {
    const deleteStmt = getStmt('deleteDefs', 'DELETE FROM definitions WHERE file_id = ?');
    const insertStmt = getStmt('insertDef', `
      INSERT INTO definitions (file_id, name, type, exported, start_line, end_line)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    db.transaction(() => {
      deleteStmt.run(fileId);
      for (const def of definitions) {
        insertStmt.run(
          fileId,
          def.name,
          def.type,
          def.exported ? 1 : 0,
          def.startLine,
          def.endLine
        );
      }
    })();
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Chunk Operations (Tier 2)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Upserts a chunk with its base embedding (Location + JSDoc + Code).
   * This is called during initial Tier 2 indexing.
   * @param {ChunkRecord} chunk 
   * @param {Float32Array} embedding - Base embedding
   */
  const upsertChunkWithEmbedding = (chunk, embedding) => {
    const upsertStmt = getStmt('upsertChunkFull', `
      INSERT INTO chunks (id, file_id, type, name, code, jsdoc, signature, start_line, end_line, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        code = excluded.code,
        jsdoc = excluded.jsdoc,
        signature = excluded.signature,
        token_count = excluded.token_count
    `);
    const deleteVecStmt = getStmt('deleteVec', 'DELETE FROM vec_chunks WHERE chunk_id = ?');
    const insertVecStmt = getStmt('insertVec', 'INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)');
    
    db.transaction(() => {
      upsertStmt.run(
        chunk.id,
        chunk.fileId,
        chunk.type,
        chunk.name,
        chunk.code,
        chunk.jsdoc || null,
        chunk.signature || null,
        chunk.startLine,
        chunk.endLine,
        chunk.tokenCount
      );
      deleteVecStmt.run(chunk.id);
      insertVecStmt.run(chunk.id, embedding);
    })();
  };

  /**
   * Upserts a chunk without embedding.
   * @param {ChunkRecord} chunk 
   */
  const upsertChunk = (chunk) => {
    const stmt = getStmt('upsertChunkFull', `
      INSERT INTO chunks (id, file_id, type, name, code, jsdoc, signature, start_line, end_line, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        code = excluded.code,
        jsdoc = excluded.jsdoc,
        signature = excluded.signature,
        token_count = excluded.token_count
    `);
    
    stmt.run(
      chunk.id,
      chunk.fileId,
      chunk.type,
      chunk.name,
      chunk.code,
      chunk.jsdoc || null,
      chunk.signature || null,
      chunk.startLine,
      chunk.endLine,
      chunk.tokenCount
    );
  };

  /**
   * Deletes all chunks for a file.
   * @param {number} fileId 
   */
  const deleteChunksForFile = (fileId) => {
    const stmt = getStmt('deleteChunksForFile', 'DELETE FROM chunks WHERE file_id = ?');
    stmt.run(fileId);
  };

  /**
   * Gets all chunks for a file.
   * @param {number} fileId 
   * @returns {ChunkRecord[]}
   */
  const getChunksForFile = (fileId) => {
    const rows = db.prepare(`
      SELECT id, file_id, type, name, code, jsdoc, signature, start_line, end_line, token_count
      FROM chunks WHERE file_id = ?
    `).all(fileId);
    
    return rows.map(r => ({
      id: r.id,
      fileId: r.file_id,
      type: r.type,
      name: r.name,
      code: r.code,
      jsdoc: r.jsdoc,
      signature: r.signature,
      startLine: r.start_line,
      endLine: r.end_line,
      tokenCount: r.token_count
    }));
  };

  /**
   * Gets a single chunk by ID with file info.
   * Returns flat structure for use in representation builder.
   * @param {string} chunkId 
   * @returns {Object | undefined}
   */
  const getChunkWithFile = (chunkId) => {
    const row = db.prepare(`
      SELECT c.*, f.path as file_path, f.fan_in, f.fan_out
      FROM chunks c
      JOIN files f ON f.id = c.file_id
      WHERE c.id = ?
    `).get(chunkId);
    
    if (!row) return undefined;
    
    // Return flat structure matching what representation builder expects
    return {
      id: row.id,
      file_id: row.file_id,
      type: row.type,
      name: row.name,
      code: row.code,
      jsdoc: row.jsdoc,
      signature: row.signature,
      start_line: row.start_line,
      end_line: row.end_line,
      token_count: row.token_count,
      file_path: row.file_path,
      fan_in: row.fan_in,
      fan_out: row.fan_out
    };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Enriched Embedding Operations (Contextual Retrieval)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Upserts an enriched embedding for a chunk.
   * Called after LLM enrichment completes to create a better embedding.
   * @param {string} chunkId 
   * @param {Float32Array} embedding - Enriched embedding (Location + JSDoc + Enrichment + Code)
   */
  const upsertEnrichedEmbedding = (chunkId, embedding) => {
    const deleteStmt = getStmt('deleteEnrichedVec', 'DELETE FROM vec_chunks_enriched WHERE chunk_id = ?');
    const insertStmt = getStmt('insertEnrichedVec', 'INSERT INTO vec_chunks_enriched (chunk_id, embedding) VALUES (?, ?)');
    
    db.transaction(() => {
      deleteStmt.run(chunkId);
      insertStmt.run(chunkId, embedding);
    })();
  };

  /**
   * Checks if a chunk has an enriched embedding.
   * @param {string} chunkId 
   * @returns {boolean}
   */
  const hasEnrichedEmbedding = (chunkId) => {
    const row = db.prepare('SELECT 1 FROM vec_chunks_enriched WHERE chunk_id = ?').get(chunkId);
    return !!row;
  };

  /**
   * Gets chunks that have enrichment but no enriched embedding.
   * These need to be re-embedded with the enrichment context.
   * @param {number} [limit=100]
   * @returns {Array<{chunkId: string, fileId: number}>}
   */
  const getChunksNeedingEnrichedEmbedding = (limit = 100) => {
    return db.prepare(`
      SELECT e.chunk_id as chunkId, e.file_id as fileId
      FROM enrichment e
      LEFT JOIN vec_chunks_enriched ve ON ve.chunk_id = e.chunk_id
      WHERE ve.chunk_id IS NULL
      LIMIT ?
    `).all(limit);
  };

  /**
   * Gets count of chunks with enriched embeddings vs total enriched.
   * @returns {{enriched: number, withEnrichedEmbedding: number}}
   */
  const getEnrichedEmbeddingStats = () => {
    const enriched = db.prepare('SELECT COUNT(*) as count FROM enrichment').get().count;
    const withEmbedding = db.prepare('SELECT COUNT(*) as count FROM vec_chunks_enriched').get().count;
    return { enriched, withEnrichedEmbedding: withEmbedding };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Graph Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Deletes all edges originating from a file.
   * @param {number} fileId 
   */
  const deleteEdgesFromFile = (fileId) => {
    const stmt = getStmt('deleteEdgesFromFile', 'DELETE FROM edges WHERE source_file_id = ?');
    stmt.run(fileId);
  };

  /**
   * Inserts an edge into the graph.
   * @param {Object} edge 
   * @param {number} edge.sourceFileId
   * @param {number} edge.targetFileId
   * @param {string} edge.type
   * @param {string} [edge.sourceName]
   * @param {string} [edge.targetName]
   * @param {number} [edge.line]
   */
  const insertEdge = (edge) => {
    const stmt = getStmt('insertEdge', `
      INSERT OR REPLACE INTO edges (source_file_id, target_file_id, type, source_name, target_name, line)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      edge.sourceFileId,
      edge.targetFileId,
      edge.type,
      edge.sourceName || null,
      edge.targetName || null,
      edge.line || null
    );
  };

  /**
   * Inserts multiple edges in a single transaction.
   * @param {Array} edges 
   */
  const insertEdges = (edges) => {
    const stmt = getStmt('insertEdge', `
      INSERT OR REPLACE INTO edges (source_file_id, target_file_id, type, source_name, target_name, line)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    db.transaction(() => {
      for (const edge of edges) {
        stmt.run(
          edge.sourceFileId,
          edge.targetFileId,
          edge.type,
          edge.sourceName || null,
          edge.targetName || null,
          edge.line || null
        );
      }
    })();
  };

  /**
   * Updates file metrics (fan_in, fan_out).
   */
  const updateFileMetrics = () => {
    db.exec(`
      UPDATE files SET fan_out = (
        SELECT COUNT(DISTINCT target_file_id) FROM edges WHERE source_file_id = files.id
      );
      UPDATE files SET fan_in = (
        SELECT COUNT(DISTINCT source_file_id) FROM edges WHERE target_file_id = files.id
      );
    `);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Enrichment Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Gets enrichment for a chunk.
   * @param {string} chunkId 
   * @returns {Object | undefined}
   */
  const getEnrichment = (chunkId) => {
    return db.prepare(`
      SELECT chunk_id, summary, docstring, tags, prompt_version, created_at
      FROM enrichments WHERE chunk_id = ?
    `).get(chunkId);
  };

  /**
   * Upserts an enrichment record.
   * @param {Object} enrichment 
   */
  const upsertEnrichment = (enrichment) => {
    db.prepare(`
      INSERT INTO enrichments (chunk_id, summary, docstring, tags, prompt_version)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        summary = excluded.summary,
        docstring = excluded.docstring,
        tags = excluded.tags,
        prompt_version = excluded.prompt_version,
        created_at = unixepoch()
    `).run(
      enrichment.chunkId,
      enrichment.summary,
      enrichment.docstring,
      JSON.stringify(enrichment.tags || []),
      enrichment.promptVersion
    );
  };

  /**
   * Deletes enrichment for a chunk.
   * @param {string} chunkId 
   */
  const deleteEnrichment = (chunkId) => {
    db.prepare('DELETE FROM enrichments WHERE chunk_id = ?').run(chunkId);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Plan Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Inserts a plan record.
   * @param {Object} plan 
   * @returns {number} The inserted plan ID
   */
  const insertPlan = (plan) => {
    const result = db.prepare(`
      INSERT INTO plans (task_type, original_query, steps, context_summary)
      VALUES (?, ?, ?, ?)
    `).run(
      plan.taskType,
      plan.originalQuery,
      JSON.stringify(plan.steps),
      plan.contextSummary || null
    );
    return result.lastInsertRowid;
  };

  /**
   * Gets a plan by ID.
   * @param {number} planId 
   * @returns {Object | undefined}
   */
  const getPlan = (planId) => {
    const row = db.prepare(`
      SELECT id, task_type, original_query, steps, context_summary, created_at
      FROM plans WHERE id = ?
    `).get(planId);
    
    if (!row) return undefined;
    
    return {
      id: row.id,
      taskType: row.task_type,
      originalQuery: row.original_query,
      steps: JSON.parse(row.steps),
      contextSummary: row.context_summary,
      createdAt: row.created_at
    };
  };

  /**
   * Lists recent plans.
   * @param {number} [limit=10] 
   * @returns {Array}
   */
  const listPlans = (limit = 10) => {
    const rows = db.prepare(`
      SELECT id, task_type, original_query, context_summary, created_at
      FROM plans ORDER BY created_at DESC LIMIT ?
    `).all(limit);
    
    return rows.map(r => ({
      id: r.id,
      taskType: r.task_type,
      originalQuery: r.original_query,
      contextSummary: r.context_summary,
      createdAt: r.created_at
    }));
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Stats and Diagnostics
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Gets database statistics.
   * @returns {Object}
   */
  const getStats = () => {
    const fileCount = db.prepare('SELECT COUNT(*) as count FROM files').get().count;
    const tier0 = db.prepare('SELECT COUNT(*) as count FROM files WHERE indexed_tier >= 0').get().count;
    const tier1 = db.prepare('SELECT COUNT(*) as count FROM files WHERE indexed_tier >= 1').get().count;
    const tier2 = db.prepare('SELECT COUNT(*) as count FROM files WHERE indexed_tier >= 2').get().count;
    const chunkCount = db.prepare('SELECT COUNT(*) as count FROM chunks').get().count;
    const defCount = db.prepare('SELECT COUNT(*) as count FROM definitions').get().count;
    const edgeCount = db.prepare('SELECT COUNT(*) as count FROM edges').get().count;
    const enrichmentCount = db.prepare('SELECT COUNT(*) as count FROM enrichments').get().count;

    return {
      files: { total: fileCount, tier0, tier1, tier2 },
      chunks: chunkCount,
      definitions: defCount,
      edges: edgeCount,
      enrichments: enrichmentCount
    };
  };

  return {
    // Core operations
    initSchema,
    close,
    transaction,
    prepare,
    exec,
    getRawDb: () => db,

    // File operations
    getAllFileHashes,
    getFileByPath,
    upsertFiles,
    deleteFiles,
    getFilesNeedingTier,
    getFilesAtTier,
    updateFileTier,

    // Definition operations
    deleteDefinitionsForFile,
    insertDefinitions,
    replaceDefinitions,

    // Chunk operations
    upsertChunkWithEmbedding,
    upsertChunk,
    deleteChunksForFile,
    getChunksForFile,
    getChunkWithFile,

    // Enriched embedding operations
    upsertEnrichedEmbedding,
    hasEnrichedEmbedding,
    getChunksNeedingEnrichedEmbedding,
    getEnrichedEmbeddingStats,

    // Graph operations
    deleteEdgesFromFile,
    insertEdge,
    insertEdges,
    updateFileMetrics,

    // Enrichment operations
    getEnrichment,
    upsertEnrichment,
    deleteEnrichment,

    // Plan operations
    insertPlan,
    getPlan,
    listPlans,

    // Stats
    getStats,
  };
}
