import { createFileScanner } from './scanner.js';
import { createASTParser } from './ast-parser.js';
import { createModuleResolver, parseConfigAliases } from './module-resolver.js';
import { createIndexBuilder } from './index-builder.js';
import { createGraphBuilder } from './graph-builder.js';
import { createChunker } from './chunker.js';
import { createEmbedder } from './embedder.js';
import { buildBaseRepresentation } from './representation-builder.js';
import fs from 'node:fs/promises';

/**
 * @typedef {Object} IndexingConfig
 * @property {boolean} enabled - Whether indexing is enabled
 * @property {number} maxTier - Maximum tier to index (0=files, 1=+AST, 2=+embeddings)
 * @property {number} scanBatchSize - Files to process per batch during scan
 * @property {number} dbBatchSize - Rows per DB transaction
 * @property {string[]} ignoredDirs - Directories to ignore
 */

/**
 * @typedef {Object} GraphConfig
 * @property {boolean} enabled - Whether to build dependency graph
 * @property {boolean} metrics - Whether to calculate fan-in/fan-out metrics
 */

/**
 * @typedef {Object} IndexManagerConfig
 * @property {IndexingConfig} indexing
 * @property {GraphConfig} graph
 */

/**
 * Creates an index manager to orchestrate the indexing process.
 * 
 * The index manager is a pure orchestrator - it coordinates the scanner,
 * parser, graph builder, and embedder, but delegates all database operations
 * to the adapter.
 * 
 * @param {Object} db - Database adapter (must have async domain methods)
 * @param {IndexManagerConfig} config - Configuration
 * @returns {Promise<Object>} Index Manager API
 */
export async function createIndexManager(db, config) {
  // Validate that indexing is enabled
  if (!config.indexing?.enabled) {
    return {
      runIndexing: async () => {
        console.log('Indexing is disabled in configuration');
        return { skipped: true, reason: 'indexing.enabled is false' };
      },
      getStats: () => db.getStats()
    };
  }

  const maxTier = config.indexing.maxTier ?? 2;
  const scanBatchSize = config.indexing.scanBatchSize ?? 50;
  const dbBatchSize = config.indexing.dbBatchSize ?? 100;
  
  // Convert ignoredDirs to glob patterns
  const ignorePatterns = (config.indexing.ignoredDirs || []).map(dir => `**/${dir}/**`);
  
  const scanner = createFileScanner({ 
    ignorePatterns,
    scanBatchSize 
  });

  // Only create parser if we need Tier 1+
  const parser = maxTier >= 1 ? await createASTParser() : null;
  
  // Only create chunker/embedder if we need Tier 2
  const chunker = maxTier >= 2 ? createChunker() : null;
  const embedder = maxTier >= 2 ? await createEmbedder(config) : null;

  /**
   * Runs Tier 0 (File Scan).
   * Updates the files table with current filesystem state.
   * @param {string} rootPath 
   * @returns {Promise<{added: number, modified: number, deleted: number, unchanged: number}>}
   */
  const _runTier0 = async (rootPath) => {
    // Get existing file hashes from database (async for Memgraph)
    const existingHashes = await db.getAllFileHashes();
    
    // Scan filesystem and detect changes
    const { changes } = await scanner.scanWithChanges(rootPath, existingHashes);

    // Apply changes to database (async operations)
    if (changes.deleted.length > 0) {
      await db.deleteFiles(changes.deleted, dbBatchSize);
    }

    const toUpsert = [...changes.added, ...changes.modified];
    if (toUpsert.length > 0) {
      await db.upsertFiles(toUpsert, dbBatchSize);
    }

    return {
      added: changes.added.length,
      modified: changes.modified.length,
      deleted: changes.deleted.length,
      unchanged: changes.unchanged.length
    };
  };

  /**
   * Runs Tier 1 (AST Parsing).
   * Parses files and extracts definitions.
   * @param {string} rootPath 
   * @returns {Promise<{parsed: number, failed: number}>}
   */
  const _runTier1 = async (rootPath) => {
    if (!parser) {
      return { parsed: 0, failed: 0, skipped: true };
    }

    const filesToParse = await db.getFilesNeedingTier(1);
    let parsed = 0;
    let failed = 0;

    for (const file of filesToParse) {
      try {
        const content = await fs.readFile(file.path, 'utf-8');
        const result = parser.parseFile(file.path, content);

        // Convert definitions to the format expected by adapter
        const definitions = result.definitions.map(def => ({
          name: def.name,
          type: def.type,
          exported: def.exported,
          startLine: def.startLine,
          endLine: def.endLine
        }));

        // Replace definitions and update tier (async for Memgraph)
        // Note: Memgraph uses file.path as the unique identifier
        await db.replaceDefinitions(file.path, definitions);
        await db.updateFileTier(file.path, 1);
        parsed++;
      } catch (e) {
        console.error(`Failed to parse ${file.path}:`, e.message);
        failed++;
      }
    }

    return { parsed, failed };
  };

  /**
   * Runs graph building (part of Tier 1).
   * Builds import/export relationships between files.
   * @param {string} rootPath 
   * @returns {Promise<{filesProcessed: number, edgesCreated: number}>}
   */
  const _runGraphBuilding = async (rootPath) => {
    if (!config.graph?.enabled || !parser) {
      return { filesProcessed: 0, edgesCreated: 0, skipped: true };
    }

    const aliases = parseConfigAliases(rootPath);
    const resolver = createModuleResolver({ rootPath, aliases });
    const indexBuilder = createIndexBuilder(db);
    const graphBuilder = createGraphBuilder(db, resolver);

    const maps = await indexBuilder.buildMaps();
    const allParsedFiles = await db.getFilesAtTier(1);
    
    let filesProcessed = 0;
    let edgesCreated = 0;

    for (const file of allParsedFiles) {
      try {
        const content = await fs.readFile(file.path, 'utf-8');
        const parsed = parser.parseFile(file.path, content);
        const edges = await graphBuilder.buildRelationships(file.path, file.path, parsed, maps);
        edgesCreated += edges || 0;
        filesProcessed++;
      } catch (e) {
        console.error(`Failed to build graph for ${file.path}:`, e.message);
      }
    }

    // Update metrics if enabled (async for Memgraph)
    if (config.graph?.metrics) {
      await db.updateFileMetrics();
    }

    return { filesProcessed, edgesCreated };
  };

  /**
   * Runs Tier 2 (Embeddings).
   * Creates chunks and generates embeddings for semantic search.
   * Uses contextual representation (file path, JSDoc, signature) for better retrieval.
   * @returns {Promise<{filesProcessed: number, chunksCreated: number, failed: number}>}
   */
  const _runTier2 = async () => {
    if (!chunker || !embedder) {
      return { filesProcessed: 0, chunksCreated: 0, failed: 0, skipped: true };
    }

    const filesToEmbed = await db.getFilesNeedingTier(2);
    let filesProcessed = 0;
    let chunksCreated = 0;
    let failed = 0;

    for (const file of filesToEmbed) {
      try {
        const content = await fs.readFile(file.path, 'utf-8');
        const parsed = parser.parseFile(file.path, content);
        const chunks = chunker.chunk(file.path, content, parsed);

        // Build file metadata for representation builder
        const fileData = {
          path: file.path,
          fanIn: file.fanIn || file.fan_in || 0,
          fanOut: file.fanOut || file.fan_out || 0
        };

        for (const chunk of chunks) {
          // Build contextual representation for better semantic matching
          // Includes: file path, symbol type/name, JSDoc, signature, and code
          const representation = buildBaseRepresentation(chunk, fileData);
          const embedding = await embedder.embed(representation);
          
          // Note: Memgraph uses file.path as the unique identifier
          await db.upsertChunkWithEmbedding({
            id: chunk.id,
            fileId: file.path,
            type: chunk.type,
            name: chunk.name,
            code: chunk.code,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            tokenCount: chunk.tokenCount,
            jsdoc: chunk.jsdoc || null,
            signature: chunk.signature || null
          }, new Float32Array(embedding));
          
          chunksCreated++;
        }

        await db.updateFileTier(file.path, 2);
        filesProcessed++;
      } catch (e) {
        console.error(`Failed to embed ${file.path}:`, e.message);
        failed++;
      }
    }

    return { filesProcessed, chunksCreated, failed };
  };

  /**
   * Runs the full indexing pipeline up to the configured maxTier.
   * @param {string} rootPath - Root directory to index
   * @returns {Promise<Object>} Indexing results
   */
  const runIndexing = async (rootPath) => {
    const results = {
      tier0: null,
      tier1: null,
      graph: null,
      tier2: null,
      maxTier,
      startTime: Date.now()
    };

    // Tier 0: File scanning (always run)
    console.log('Tier 0: Scanning files...');
    results.tier0 = await _runTier0(rootPath);
    console.log(`  Added: ${results.tier0.added}, Modified: ${results.tier0.modified}, ` +
                `Deleted: ${results.tier0.deleted}, Unchanged: ${results.tier0.unchanged}`);

    // Tier 1: AST Parsing
    if (maxTier >= 1) {
      console.log('Tier 1: Parsing AST...');
      results.tier1 = await _runTier1(rootPath);
      console.log(`  Parsed: ${results.tier1.parsed}, Failed: ${results.tier1.failed}`);

      // Graph building (depends on Tier 1)
      if (config.graph?.enabled) {
        console.log('Building dependency graph...');
        results.graph = await _runGraphBuilding(rootPath);
        console.log(`  Files: ${results.graph.filesProcessed}, Edges: ${results.graph.edgesCreated}`);
      }
    }

    // Tier 2: Embeddings
    if (maxTier >= 2) {
      console.log('Tier 2: Generating embeddings...');
      results.tier2 = await _runTier2();
      console.log(`  Files: ${results.tier2.filesProcessed}, Chunks: ${results.tier2.chunksCreated}, ` +
                  `Failed: ${results.tier2.failed}`);
    }

    results.endTime = Date.now();
    results.durationMs = results.endTime - results.startTime;
    console.log(`Indexing complete in ${results.durationMs}ms`);

    return results;
  };

  /**
   * Gets current indexing statistics.
   * @returns {Promise<Object>}
   */
  const getStats = async () => {
    return await db.getStats();
  };

  return { 
    runIndexing, 
    getStats,
    // Expose individual tiers for granular control
    runTier0: _runTier0,
    runTier1: _runTier1,
    runGraphBuilding: _runGraphBuilding,
    runTier2: _runTier2
  };
}
