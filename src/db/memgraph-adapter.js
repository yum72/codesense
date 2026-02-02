import neo4j from 'neo4j-driver';
import fs from 'node:fs';

/**
 * @typedef {Object} FileEntry
 * @property {string} path
 * @property {string} hash
 * @property {number} size
 * @property {number} modifiedAt
 */

/**
 * @typedef {Object} FileRecord
 * @property {string} path
 * @property {string} hash
 * @property {number} size
 * @property {number} modifiedAt
 * @property {number} indexedTier
 * @property {number} fanIn
 * @property {number} fanOut
 */

/**
 * @typedef {Object} ChunkRecord
 * @property {string} id
 * @property {string} fileId - File path reference
 * @property {string} type
 * @property {string} name
 * @property {string} code
 * @property {string} [jsdoc]
 * @property {string} [signature]
 * @property {number} startLine
 * @property {number} endLine
 * @property {number} tokenCount
 * @property {string} [contextTier] - "structural" | "partial" | "full"
 */

/**
 * @typedef {Object} MemgraphConfig
 * @property {string} url - Bolt URL (e.g., bolt://localhost:7687)
 * @property {string} [username]
 * @property {string} [password]
 * @property {string} [database]
 */

/**
 * Creates a database adapter for Memgraph graph database.
 * Provides the same interface as the SQLite adapter for compatibility.
 * 
 * @param {MemgraphConfig} config - Memgraph connection configuration
 * @param {Object} [options]
 * @param {number} [options.batchSize=100] - Default batch size for bulk operations
 * @returns {Object} Database adapter API
 */
export function createMemgraphAdapter(config, options = {}) {
  const batchSize = options.batchSize || 100;
  
  // Create driver with connection configuration
  const driver = neo4j.driver(
    config.url || 'bolt://localhost:7687',
    config.username && config.password
      ? neo4j.auth.basic(config.username, config.password)
      : undefined,
    {
      maxConnectionPoolSize: 50,
      connectionAcquisitionTimeout: 30000,
      maxTransactionRetryTime: 30000,
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Session Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Gets a new session for database operations.
   * @returns {Object} Neo4j session
   */
  const getSession = () => {
    return driver.session({
      database: config.database || 'memgraph',
      defaultAccessMode: neo4j.session.WRITE,
    });
  };

  /**
   * Executes a read query.
   * @param {string} cypher - Cypher query
   * @param {Object} params - Query parameters
   * @returns {Promise<Array>} Query results
   */
  const query = async (cypher, params = {}) => {
    const session = getSession();
    try {
      const result = await session.run(cypher, params);
      return result.records.map(r => r.toObject());
    } finally {
      await session.close();
    }
  };

  /**
   * Executes a write query.
   * @param {string} cypher - Cypher query
   * @param {Object} params - Query parameters
   * @returns {Promise<Object>} Query summary
   */
  const execute = async (cypher, params = {}) => {
    const session = getSession();
    try {
      const result = await session.run(cypher, params);
      const stats = result.summary.counters._stats || {};
      return {
        nodesCreated: stats.nodesCreated || 0,
        nodesDeleted: stats.nodesDeleted || 0,
        relationshipsCreated: stats.relationshipsCreated || 0,
        relationshipsDeleted: stats.relationshipsDeleted || 0,
        propertiesSet: stats.propertiesSet || 0,
      };
    } finally {
      await session.close();
    }
  };

  /**
   * Executes multiple queries in a transaction.
   * @param {function} work - Transaction work function
   * @returns {Promise<any>} Transaction result
   */
  const transaction = async (work) => {
    const session = getSession();
    try {
      return await session.executeWrite(work);
    } finally {
      await session.close();
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Core Database Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initializes the database schema from a Cypher file.
   * @param {string} schemaPath - Path to the Cypher schema file
   */
  const initSchema = async (schemaPath) => {
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    
    // Split by semicolons and filter empty statements
    const statements = schema
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('//'));
    
    const session = getSession();
    try {
      for (const statement of statements) {
        try {
          await session.run(statement);
        } catch (e) {
          // Ignore "already exists" errors for constraints/indexes
          if (!e.message.includes('already exists') && 
              !e.message.includes('Already exists')) {
            console.warn(`Schema statement warning: ${e.message}`);
          }
        }
      }
    } finally {
      await session.close();
    }
  };

  /**
   * Closes the database connection.
   */
  const close = async () => {
    await driver.close();
  };

  /**
   * Verifies the connection to Memgraph.
   * @returns {Promise<boolean>}
   */
  const verifyConnection = async () => {
    try {
      await query('RETURN 1 as test');
      return true;
    } catch (e) {
      console.error('Memgraph connection failed:', e.message);
      return false;
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // File Operations (Tier 0)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Gets all file paths and their hashes from the database.
   * @returns {Promise<Map<string, string>>} Map of path -> hash
   */
  const getAllFileHashes = async () => {
    const results = await query('MATCH (f:File) RETURN f.path as path, f.hash as hash');
    return new Map(results.map(r => [r.path, r.hash]));
  };

  /**
   * Gets a file record by path.
   * @param {string} filePath 
   * @returns {Promise<FileRecord | undefined>}
   */
  const getFileByPath = async (filePath) => {
    const results = await query(
      'MATCH (f:File {path: $path}) RETURN f',
      { path: filePath }
    );
    
    if (results.length === 0) return undefined;
    
    const f = results[0].f.properties;
    return {
      path: f.path,
      hash: f.hash,
      size: toNumber(f.size),
      modifiedAt: toNumber(f.modified_at),
      indexedTier: toNumber(f.indexed_tier),
      fanIn: toNumber(f.fan_in),
      fanOut: toNumber(f.fan_out),
    };
  };

  /**
   * Upserts multiple files to the database in batches.
   * @param {FileEntry[]} entries - File entries to upsert
   */
  const upsertFiles = async (entries) => {
    if (entries.length === 0) return;
    
    const now = Math.floor(Date.now() / 1000);
    
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      
      await execute(`
        UNWIND $entries AS entry
        MERGE (f:File {path: entry.path})
        SET f.hash = entry.hash,
            f.size = entry.size,
            f.modified_at = entry.modifiedAt,
            f.indexed_tier = 0,
            f.updated_at = $now,
            f.created_at = COALESCE(f.created_at, $now)
      `, { entries: batch, now });
    }
  };

  /**
   * Deletes multiple files from the database.
   * @param {string[]} paths - File paths to delete
   */
  const deleteFiles = async (paths) => {
    if (paths.length === 0) return;
    
    for (let i = 0; i < paths.length; i += batchSize) {
      const batch = paths.slice(i, i + batchSize);
      
      // Delete files and all related nodes (chunks, definitions)
      await execute(`
        UNWIND $paths AS path
        MATCH (f:File {path: path})
        OPTIONAL MATCH (f)-[:CONTAINS]->(c:Chunk)
        OPTIONAL MATCH (f)-[:CONTAINS]->(d:Definition)
        DETACH DELETE f, c, d
      `, { paths: batch });
    }
  };

  /**
   * Gets files that need processing for a given tier.
   * @param {number} tier - The minimum tier required
   * @returns {Promise<Array<{path: string}>>}
   */
  const getFilesNeedingTier = async (tier) => {
    const results = await query(
      'MATCH (f:File) WHERE f.indexed_tier < $tier RETURN f.path as path',
      { tier }
    );
    return results;
  };

  /**
   * Gets all files at or above a given tier.
   * @param {number} tier - The minimum tier
   * @returns {Promise<Array<{path: string}>>}
   */
  const getFilesAtTier = async (tier) => {
    const results = await query(
      'MATCH (f:File) WHERE f.indexed_tier >= $tier RETURN f.path as path',
      { tier }
    );
    return results;
  };

  /**
   * Updates a file's indexed tier.
   * @param {string} filePath 
   * @param {number} tier 
   */
  const updateFileTier = async (filePath, tier) => {
    await execute(
      'MATCH (f:File {path: $path}) SET f.indexed_tier = $tier',
      { path: filePath, tier }
    );
  };

  /**
   * Updates file metrics (fan_in, fan_out) based on relationships.
   */
  const updateFileMetrics = async () => {
    await execute(`
      MATCH (f:File)
      OPTIONAL MATCH (f)<-[:IMPORTS]-(importer:File)
      WITH f, COUNT(DISTINCT importer) as fanIn
      OPTIONAL MATCH (f)-[:IMPORTS]->(imported:File)
      WITH f, fanIn, COUNT(DISTINCT imported) as fanOut
      SET f.fan_in = fanIn, f.fan_out = fanOut
    `);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Helper: Convert Neo4j integers to JS numbers
  // ─────────────────────────────────────────────────────────────────────────

  const toNumber = (value) => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (neo4j.isInt(value)) return value.toNumber();
    return parseInt(value, 10) || 0;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Definition Operations (Tier 1)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Deletes all definitions for a file.
   * @param {string} filePath 
   */
  const deleteDefinitionsForFile = async (filePath) => {
    await execute(`
      MATCH (f:File {path: $path})-[:CONTAINS]->(d:Definition)
      DETACH DELETE d
    `, { path: filePath });
  };

  /**
   * Inserts multiple definitions for a file.
   * @param {string} filePath 
   * @param {Array} definitions 
   */
  const insertDefinitions = async (filePath, definitions) => {
    if (definitions.length === 0) return;
    
    await execute(`
      MATCH (f:File {path: $path})
      UNWIND $definitions AS def
      CREATE (d:Definition {
        id: $path + '::' + def.name + '::' + def.type,
        file_id: $path,
        name: def.name,
        type: def.type,
        exported: def.exported,
        start_line: def.startLine,
        end_line: def.endLine,
        signature: def.signature
      })
      CREATE (f)-[:CONTAINS]->(d)
    `, { path: filePath, definitions });
  };

  /**
   * Replaces all definitions for a file (delete + insert).
   * @param {string} filePath 
   * @param {Array} definitions 
   */
  const replaceDefinitions = async (filePath, definitions) => {
    await deleteDefinitionsForFile(filePath);
    await insertDefinitions(filePath, definitions);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Chunk Operations (Tier 2)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Upserts a chunk with embedding.
   * @param {ChunkRecord} chunk 
   * @param {Float32Array} embedding 
   */
  const upsertChunkWithEmbedding = async (chunk, embedding) => {
    const embeddingArray = Array.from(embedding);
    
    await execute(`
      MATCH (f:File {path: $fileId})
      MERGE (c:Chunk {id: $id})
      SET c.file_id = $fileId,
          c.type = $type,
          c.name = $name,
          c.code = $code,
          c.jsdoc = $jsdoc,
          c.signature = $signature,
          c.start_line = $startLine,
          c.end_line = $endLine,
          c.token_count = $tokenCount,
          c.context_tier = $contextTier,
          c.embedding = $embedding
      MERGE (f)-[:CONTAINS]->(c)
    `, {
      id: chunk.id,
      fileId: chunk.fileId,
      type: chunk.type,
      name: chunk.name,
      code: chunk.code,
      jsdoc: chunk.jsdoc || null,
      signature: chunk.signature || null,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      tokenCount: chunk.tokenCount,
      contextTier: chunk.contextTier || 'structural',
      embedding: embeddingArray,
    });
  };

  /**
   * Upserts a chunk without embedding.
   * @param {ChunkRecord} chunk 
   */
  const upsertChunk = async (chunk) => {
    await execute(`
      MATCH (f:File {path: $fileId})
      MERGE (c:Chunk {id: $id})
      SET c.file_id = $fileId,
          c.type = $type,
          c.name = $name,
          c.code = $code,
          c.jsdoc = $jsdoc,
          c.signature = $signature,
          c.start_line = $startLine,
          c.end_line = $endLine,
          c.token_count = $tokenCount,
          c.context_tier = COALESCE(c.context_tier, 'structural')
      MERGE (f)-[:CONTAINS]->(c)
    `, {
      id: chunk.id,
      fileId: chunk.fileId,
      type: chunk.type,
      name: chunk.name,
      code: chunk.code,
      jsdoc: chunk.jsdoc || null,
      signature: chunk.signature || null,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      tokenCount: chunk.tokenCount,
    });
  };

  /**
   * Deletes all chunks for a file.
   * @param {string} filePath 
   */
  const deleteChunksForFile = async (filePath) => {
    await execute(`
      MATCH (f:File {path: $path})-[:CONTAINS]->(c:Chunk)
      DETACH DELETE c
    `, { path: filePath });
  };

  /**
   * Gets all chunks for a file.
   * @param {string} filePath 
   * @returns {Promise<ChunkRecord[]>}
   */
  const getChunksForFile = async (filePath) => {
    const results = await query(`
      MATCH (f:File {path: $path})-[:CONTAINS]->(c:Chunk)
      RETURN c
    `, { path: filePath });
    
    return results.map(r => {
      const c = r.c.properties;
      return {
        id: c.id,
        fileId: c.file_id,
        type: c.type,
        name: c.name,
        code: c.code,
        jsdoc: c.jsdoc,
        signature: c.signature,
        startLine: toNumber(c.start_line),
        endLine: toNumber(c.end_line),
        tokenCount: toNumber(c.token_count),
        contextTier: c.context_tier,
      };
    });
  };

  /**
   * Gets a single chunk by ID with file info.
   * @param {string} chunkId 
   * @returns {Promise<Object | undefined>}
   */
  const getChunkWithFile = async (chunkId) => {
    const results = await query(`
      MATCH (f:File)-[:CONTAINS]->(c:Chunk {id: $id})
      RETURN c, f.path as file_path, f.fan_in as fan_in, f.fan_out as fan_out
    `, { id: chunkId });
    
    if (results.length === 0) return undefined;
    
    const r = results[0];
    const c = r.c.properties;
    
    return {
      id: c.id,
      file_id: c.file_id,
      type: c.type,
      name: c.name,
      code: c.code,
      jsdoc: c.jsdoc,
      signature: c.signature,
      start_line: toNumber(c.start_line),
      end_line: toNumber(c.end_line),
      token_count: toNumber(c.token_count),
      context_tier: c.context_tier,
      file_path: r.file_path,
      fan_in: toNumber(r.fan_in),
      fan_out: toNumber(r.fan_out),
    };
  };

  /**
   * Gets a chunk by ID.
   * @param {string} chunkId 
   * @returns {Promise<Object | undefined>}
   */
  const getChunk = async (chunkId) => {
    const results = await query(`
      MATCH (c:Chunk {id: $id})
      RETURN c
    `, { id: chunkId });
    
    if (results.length === 0) return undefined;
    
    const c = results[0].c.properties;
    return {
      id: c.id,
      fileId: c.file_id,
      type: c.type,
      name: c.name,
      code: c.code,
      jsdoc: c.jsdoc,
      signature: c.signature,
      startLine: toNumber(c.start_line),
      endLine: toNumber(c.end_line),
      tokenCount: toNumber(c.token_count),
      contextTier: c.context_tier,
      enrichment: c.enrichment ? JSON.parse(c.enrichment) : null,
      partialEnrichments: c.partial_enrichments ? JSON.parse(c.partial_enrichments) : [],
    };
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Graph Edge Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Deletes all edges originating from a file.
   * @param {string} filePath 
   */
  const deleteEdgesFromFile = async (filePath) => {
    await execute(`
      MATCH (f:File {path: $path})-[r:IMPORTS]->()
      DELETE r
    `, { path: filePath });
    
    await execute(`
      MATCH (f:File {path: $path})-[:CONTAINS]->(c:Chunk)-[r:CALLS|EXTENDS|IMPLEMENTS|USES]->()
      DELETE r
    `, { path: filePath });
  };

  /**
   * Adds a file import edge.
   * @param {string} sourceFilePath 
   * @param {string} targetFilePath 
   * @param {number} [line]
   * @param {boolean} [isExternal=false]
   */
  const addFileImport = async (sourceFilePath, targetFilePath, line, isExternal = false) => {
    await execute(`
      MATCH (source:File {path: $sourcePath})
      MATCH (target:File {path: $targetPath})
      MERGE (source)-[r:IMPORTS]->(target)
      SET r.line = $line, r.is_external = $isExternal
    `, { sourcePath: sourceFilePath, targetPath: targetFilePath, line, isExternal });
  };

  /**
   * Adds a chunk call edge.
   * @param {string} sourceChunkId 
   * @param {string} targetChunkId 
   * @param {number} [line]
   */
  const addCallEdge = async (sourceChunkId, targetChunkId, line) => {
    await execute(`
      MATCH (source:Chunk {id: $sourceId})
      MATCH (target:Chunk {id: $targetId})
      MERGE (source)-[r:CALLS]->(target)
      SET r.line = $line
    `, { sourceId: sourceChunkId, targetId: targetChunkId, line });
  };

  /**
   * Gets all chunks that call a given chunk.
   * @param {string} chunkId 
   * @param {number} [depth=1]
   * @returns {Promise<Array>}
   */
  const getCallers = async (chunkId, depth = 1) => {
    const results = await query(`
      MATCH (caller:Chunk)-[:CALLS*1..${depth}]->(target:Chunk {id: $id})
      RETURN DISTINCT caller.id as id, caller.name as name, 
             caller.context_tier as context_tier,
             CASE WHEN caller.enrichment IS NOT NULL 
                  THEN caller.enrichment ELSE null END as enrichment
    `, { id: chunkId });
    
    return results.map(r => ({
      id: r.id,
      name: r.name,
      contextTier: r.context_tier,
      summary: r.enrichment ? JSON.parse(r.enrichment).summary : null,
    }));
  };

  /**
   * Gets all chunks that a given chunk calls.
   * @param {string} chunkId 
   * @param {number} [depth=1]
   * @returns {Promise<Array>}
   */
  const getCallees = async (chunkId, depth = 1) => {
    const results = await query(`
      MATCH (source:Chunk {id: $id})-[:CALLS*1..${depth}]->(callee:Chunk)
      RETURN DISTINCT callee.id as id, callee.name as name,
             callee.context_tier as context_tier,
             CASE WHEN callee.enrichment IS NOT NULL 
                  THEN callee.enrichment ELSE null END as enrichment
    `, { id: chunkId });
    
    return results.map(r => ({
      id: r.id,
      name: r.name,
      contextTier: r.context_tier,
      summary: r.enrichment ? JSON.parse(r.enrichment).summary : null,
    }));
  };

  /**
   * Gets all chunks in the same file as a given chunk.
   * @param {string} chunkId 
   * @returns {Promise<Array>}
   */
  const getFileSiblings = async (chunkId) => {
    const results = await query(`
      MATCH (f:File)-[:CONTAINS]->(target:Chunk {id: $id})
      MATCH (f)-[:CONTAINS]->(sibling:Chunk)
      WHERE sibling.id <> $id
      RETURN sibling.id as id, sibling.name as name, sibling.type as type,
             sibling.context_tier as context_tier
    `, { id: chunkId });
    
    return results;
  };

  /**
   * Gets the impact radius of a chunk (all chunks affected by changes).
   * @param {string} chunkId 
   * @param {number} [maxDepth=10]
   * @returns {Promise<Array>}
   */
  const getImpactRadius = async (chunkId, maxDepth = 10) => {
    const results = await query(`
      MATCH (target:Chunk {id: $id})<-[:CALLS*1..${maxDepth}]-(affected:Chunk)
      RETURN DISTINCT affected.id as id, affected.name as name,
             affected.file_id as file_path,
             length(shortestPath((affected)-[:CALLS*]->(target))) as distance
      ORDER BY distance
    `, { id: chunkId });
    
    return results;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Enrichment Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Gets enrichment for a chunk.
   * @param {string} chunkId 
   * @returns {Promise<Object | undefined>}
   */
  const getEnrichment = async (chunkId) => {
    const results = await query(`
      MATCH (c:Chunk {id: $id})
      WHERE c.enrichment IS NOT NULL
      RETURN c.enrichment as enrichment, c.context_tier as context_tier,
             c.enriched_at as enriched_at
    `, { id: chunkId });
    
    if (results.length === 0) return undefined;
    
    return {
      chunkId,
      enrichment: JSON.parse(results[0].enrichment),
      contextTier: results[0].context_tier,
      enrichedAt: toNumber(results[0].enriched_at),
    };
  };

  /**
   * Upserts full enrichment for a chunk (promotes to "full" tier).
   * @param {string} chunkId 
   * @param {Object} enrichment 
   * @param {string[]} researchSources - Chunk IDs that were researched
   * @param {Object} sourceHashes - Map of chunk ID to hash
   */
  const upsertFullEnrichment = async (chunkId, enrichment, researchSources = [], sourceHashes = {}) => {
    const now = Math.floor(Date.now() / 1000);
    
    await execute(`
      MATCH (c:Chunk {id: $id})
      SET c.enrichment = $enrichment,
          c.context_tier = 'full',
          c.enriched_at = $now,
          c.research_sources = $sources,
          c.research_source_hashes = $hashes
    `, {
      id: chunkId,
      enrichment: JSON.stringify(enrichment),
      now,
      sources: researchSources,
      hashes: JSON.stringify(sourceHashes),
    });
  };

  /**
   * Adds a partial enrichment to a chunk (promotes to "partial" tier if not already "full").
   * @param {string} chunkId 
   * @param {Object} partialEnrichment 
   */
  const addPartialEnrichment = async (chunkId, partialEnrichment) => {
    const now = Math.floor(Date.now() / 1000);
    partialEnrichment.discovered_at = now;
    
    await execute(`
      MATCH (c:Chunk {id: $id})
      WHERE c.context_tier <> 'full'
      SET c.partial_enrichments = COALESCE(c.partial_enrichments, '[]'),
          c.context_tier = 'partial'
      WITH c, c.partial_enrichments as existing
      SET c.partial_enrichments = $newPartial
    `, {
      id: chunkId,
      newPartial: JSON.stringify([partialEnrichment]),
    });
  };

  /**
   * Gets chunks that need enrichment (ordered by priority).
   * @param {number} [limit=10]
   * @returns {Promise<Array>}
   */
  const getChunksNeedingEnrichment = async (limit = 10) => {
    const results = await query(`
      MATCH (c:Chunk)
      WHERE c.context_tier = 'structural' OR c.context_tier IS NULL
      OPTIONAL MATCH (caller:Chunk)-[:CALLS]->(c)
      WITH c, COUNT(caller) as inDegree
      RETURN c.id as id, c.name as name, c.file_id as fileId,
             c.pagerank as pagerank, inDegree
      ORDER BY c.pagerank DESC NULLS LAST, inDegree DESC
      LIMIT $limit
    `, { limit });
    
    return results;
  };

  /**
   * Deletes enrichment for a chunk.
   * @param {string} chunkId 
   */
  const deleteEnrichment = async (chunkId) => {
    await execute(`
      MATCH (c:Chunk {id: $id})
      REMOVE c.enrichment, c.enriched_at, c.research_sources, c.research_source_hashes
      SET c.context_tier = 'structural'
    `, { id: chunkId });
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Enrichment Queue Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Adds a chunk to the enrichment queue.
   * @param {string} chunkId 
   * @param {string} fileId 
   * @param {number} priority 
   */
  const queueForEnrichment = async (chunkId, fileId, priority = 0) => {
    const now = Math.floor(Date.now() / 1000);
    
    await execute(`
      MERGE (q:EnrichmentQueueItem {chunk_id: $chunkId})
      SET q.file_id = $fileId,
          q.priority = $priority,
          q.status = 'pending',
          q.attempts = COALESCE(q.attempts, 0),
          q.max_attempts = 3,
          q.created_at = COALESCE(q.created_at, $now)
    `, { chunkId, fileId, priority, now });
  };

  /**
   * Gets the next batch of items from the enrichment queue.
   * @param {number} [limit=5]
   * @returns {Promise<Array>}
   */
  const getEnrichmentQueueBatch = async (limit = 5) => {
    const now = Math.floor(Date.now() / 1000);
    
    const results = await query(`
      MATCH (q:EnrichmentQueueItem)
      WHERE q.status = 'pending' 
         OR (q.status = 'failed' AND q.attempts < q.max_attempts AND q.next_retry_at <= $now)
      RETURN q.chunk_id as chunkId, q.file_id as fileId, q.priority as priority,
             q.attempts as attempts
      ORDER BY q.priority DESC
      LIMIT $limit
    `, { limit, now });
    
    return results;
  };

  /**
   * Updates the status of an enrichment queue item.
   * @param {string} chunkId 
   * @param {string} status 
   * @param {string} [errorMessage]
   */
  const updateEnrichmentQueueStatus = async (chunkId, status, errorMessage = null) => {
    const now = Math.floor(Date.now() / 1000);
    
    if (status === 'failed') {
      // Calculate exponential backoff for retry
      await execute(`
        MATCH (q:EnrichmentQueueItem {chunk_id: $chunkId})
        SET q.status = $status,
            q.attempts = q.attempts + 1,
            q.error_message = $error,
            q.next_retry_at = $now + (60 * toInteger(power(2, q.attempts)))
      `, { chunkId, status, error: errorMessage, now });
    } else {
      await execute(`
        MATCH (q:EnrichmentQueueItem {chunk_id: $chunkId})
        SET q.status = $status,
            q.processed_at = $now
      `, { chunkId, status, now });
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Search Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Performs semantic search using vector similarity.
   * @param {Float32Array} embedding 
   * @param {number} [limit=10]
   * @returns {Promise<Array>}
   */
  const semanticSearch = async (embedding, limit = 10) => {
    const embeddingArray = Array.from(embedding);
    
    // Use Memgraph's vector search procedure
    // Note: limit must be an integer, so we use toInteger() in Cypher
    const results = await query(`
      CALL vector_search.search("chunk_embedding_index", toInteger($limit), $embedding)
      YIELD node, similarity
      MATCH (f:File)-[:CONTAINS]->(node)
      RETURN node.id as id, node.name as name, node.code as code,
             node.type as type, node.start_line as start_line, node.end_line as end_line,
             node.jsdoc as jsdoc, node.signature as signature,
             node.context_tier as context_tier, node.enrichment as enrichment,
             f.path as file_path, similarity as score
      ORDER BY score DESC
    `, { embedding: embeddingArray, limit: Math.floor(limit) });
    
    return results.map(r => ({
      chunkId: r.id,
      name: r.name,
      code: r.code,
      type: r.type,
      startLine: r.start_line,
      endLine: r.end_line,
      jsdoc: r.jsdoc,
      signature: r.signature,
      contextTier: r.context_tier,
      enrichment: r.enrichment ? JSON.parse(r.enrichment) : null,
      filePath: r.file_path,
      score: r.score,
    }));
  };

  /**
   * Performs semantic search with graph context expansion.
   * @param {Float32Array} embedding 
   * @param {number} [limit=10]
   * @param {boolean} [includeCallers=true]
   * @param {boolean} [includeCallees=true]
   * @returns {Promise<Array>}
   */
  const semanticSearchWithContext = async (embedding, limit = 10, includeCallers = true, includeCallees = true) => {
    const embeddingArray = Array.from(embedding);
    
    const results = await query(`
      CALL vector_search.search("chunk_embedding_index", toInteger($limit), $embedding)
      YIELD node, similarity
      MATCH (f:File)-[:CONTAINS]->(node)
      OPTIONAL MATCH (node)-[:CALLS]->(callee:Chunk)
      OPTIONAL MATCH (caller:Chunk)-[:CALLS]->(node)
      RETURN node.id as id, node.name as name, node.code as code,
             node.type as type, node.start_line as start_line, node.end_line as end_line,
             node.jsdoc as jsdoc, node.signature as signature,
             node.context_tier as context_tier, node.enrichment as enrichment,
             f.path as file_path, similarity as score,
             collect(DISTINCT {id: callee.id, name: callee.name}) as callees,
             collect(DISTINCT {id: caller.id, name: caller.name}) as callers
      ORDER BY score DESC
    `, { embedding: embeddingArray, limit: Math.floor(limit) });
    
    return results.map(r => ({
      chunkId: r.id,
      name: r.name,
      code: r.code,
      type: r.type,
      startLine: r.start_line,
      endLine: r.end_line,
      jsdoc: r.jsdoc,
      signature: r.signature,
      contextTier: r.context_tier,
      enrichment: r.enrichment ? JSON.parse(r.enrichment) : null,
      filePath: r.file_path,
      score: r.score,
      callees: includeCallees ? r.callees.filter(c => c.id) : [],
      callers: includeCallers ? r.callers.filter(c => c.id) : [],
    }));
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Graph Analytics Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Computes PageRank for all chunks and stores the results.
   * @returns {Promise<number>} Number of chunks updated
   */
  const computePageRank = async () => {
    const result = await execute(`
      CALL pagerank.get()
      YIELD node, rank
      WITH node, rank
      WHERE node:Chunk
      SET node.pagerank = rank
      RETURN count(node) as updated
    `);
    
    return result.propertiesSet;
  };

  /**
   * Gets hub functions (highest PageRank).
   * @param {number} [limit=20]
   * @returns {Promise<Array>}
   */
  const getHubFunctions = async (limit = 20) => {
    const results = await query(`
      MATCH (c:Chunk)
      WHERE c.pagerank IS NOT NULL
      MATCH (f:File)-[:CONTAINS]->(c)
      RETURN c.id as id, c.name as name, c.type as type,
             f.path as file_path, c.pagerank as pagerank,
             c.enrichment as enrichment
      ORDER BY c.pagerank DESC
      LIMIT $limit
    `, { limit });
    
    return results.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      filePath: r.file_path,
      pagerank: r.pagerank,
      summary: r.enrichment ? JSON.parse(r.enrichment).summary : null,
    }));
  };

  /**
   * Detects communities in the call graph and stores results.
   * @returns {Promise<number>} Number of communities found
   */
  const detectCommunities = async () => {
    const result = await execute(`
      CALL community_detection.get()
      YIELD node, community_id
      WITH node, community_id
      WHERE node:Chunk
      SET node.community_id = community_id
      RETURN count(DISTINCT community_id) as communities
    `);
    
    return result.propertiesSet;
  };

  /**
   * Finds the shortest path between two chunks.
   * @param {string} sourceChunkId 
   * @param {string} targetChunkId 
   * @returns {Promise<Array>}
   */
  const findPath = async (sourceChunkId, targetChunkId) => {
    const results = await query(`
      MATCH path = shortestPath(
        (source:Chunk {id: $sourceId})-[:CALLS*]-(target:Chunk {id: $targetId})
      )
      RETURN [n IN nodes(path) | {id: n.id, name: n.name}] as path
    `, { sourceId: sourceChunkId, targetId: targetChunkId });
    
    if (results.length === 0) return [];
    return results[0].path;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Stats and Diagnostics
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Gets database statistics.
   * @returns {Promise<Object>}
   */
  const getStats = async () => {
    const fileStats = await query(`
      MATCH (f:File)
      RETURN 
        count(f) as total,
        sum(CASE WHEN f.indexed_tier >= 0 THEN 1 ELSE 0 END) as tier0,
        sum(CASE WHEN f.indexed_tier >= 1 THEN 1 ELSE 0 END) as tier1,
        sum(CASE WHEN f.indexed_tier >= 2 THEN 1 ELSE 0 END) as tier2
    `);
    
    const chunkStats = await query(`
      MATCH (c:Chunk)
      RETURN 
        count(c) as total,
        sum(CASE WHEN c.context_tier = 'structural' THEN 1 ELSE 0 END) as structural,
        sum(CASE WHEN c.context_tier = 'partial' THEN 1 ELSE 0 END) as partial,
        sum(CASE WHEN c.context_tier = 'full' THEN 1 ELSE 0 END) as full
    `);
    
    const edgeStats = await query(`
      MATCH ()-[r]->()
      RETURN type(r) as type, count(r) as count
    `);
    
    const queueStats = await query(`
      MATCH (q:EnrichmentQueueItem)
      RETURN q.status as status, count(q) as count
    `);

    return {
      files: {
        total: toNumber(fileStats[0]?.total),
        tier0: toNumber(fileStats[0]?.tier0),
        tier1: toNumber(fileStats[0]?.tier1),
        tier2: toNumber(fileStats[0]?.tier2),
      },
      chunks: {
        total: toNumber(chunkStats[0]?.total),
        structural: toNumber(chunkStats[0]?.structural),
        partial: toNumber(chunkStats[0]?.partial),
        full: toNumber(chunkStats[0]?.full),
      },
      edges: Object.fromEntries(edgeStats.map(r => [r.type, toNumber(r.count)])),
      enrichmentQueue: Object.fromEntries(queueStats.map(r => [r.status, toNumber(r.count)])),
    };
  };

  return {
    // Core operations
    initSchema,
    close,
    verifyConnection,
    query,
    execute,
    transaction,
    getDriver: () => driver,

    // File operations
    getAllFileHashes,
    getFileByPath,
    upsertFiles,
    deleteFiles,
    getFilesNeedingTier,
    getFilesAtTier,
    updateFileTier,
    updateFileMetrics,

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
    getChunk,

    // Graph operations
    deleteEdgesFromFile,
    addFileImport,
    addCallEdge,
    getCallers,
    getCallees,
    getFileSiblings,
    getImpactRadius,

    // Enrichment operations
    getEnrichment,
    upsertFullEnrichment,
    addPartialEnrichment,
    getChunksNeedingEnrichment,
    deleteEnrichment,

    // Enrichment queue operations
    queueForEnrichment,
    getEnrichmentQueueBatch,
    updateEnrichmentQueueStatus,

    // Search operations
    semanticSearch,
    semanticSearchWithContext,

    // Graph analytics
    computePageRank,
    getHubFunctions,
    detectCommunities,
    findPath,

    // Stats
    getStats,
  };
}
