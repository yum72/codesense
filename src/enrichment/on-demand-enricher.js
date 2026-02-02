import { featureDisabledError } from '../utils/config.js';
import { buildEnrichedRepresentation, parseEnrichmentForEmbedding } from '../indexing/representation-builder.js';

/**
 * @typedef {Object} OnDemandEnricher
 * @property {function(string): Promise<Object>} enrichChunk
 * @property {function(string[]): Promise<Object[]>} enrichChunks
 * @property {function(number): Promise<Object[]>} enrichFile
 * @property {function(): boolean} isEnabled
 */

/**
 * @typedef {Object} OnDemandConfig
 * @property {boolean} [enabled=true] - Whether on-demand enrichment is enabled
 */

/**
 * Creates an on-demand enricher for synchronous enrichment.
 * Used for "thorough" mode where results are needed immediately.
 * 
 * @param {Object} db - SQLite database adapter
 * @param {Object} enricher - Hierarchical enricher instance (null if disabled)
 * @param {OnDemandConfig} config - Configuration
 * @param {Object} [embedder] - Embedder instance for re-embedding after enrichment
 * @returns {OnDemandEnricher}
 */
export function createOnDemandEnricher(db, enricher, config = {}, embedder = null) {
  const enabled = config.enabled !== false && enricher !== null;

  /**
   * Returns whether on-demand enrichment is enabled.
   * @returns {boolean}
   */
  const isEnabled = () => enabled;

  // If disabled, return stub implementation
  if (!enabled) {
    const disabledError = () => {
      const reason = enricher === null 
        ? 'LLM/enrichment is disabled in configuration'
        : 'enrichment.onDemand is false in configuration';
      return Promise.reject(new Error(featureDisabledError('on-demand enrichment', reason)));
    };

    return {
      isEnabled,
      enrichChunk: disabledError,
      enrichChunks: async () => [],
      enrichFile: async () => []
    };
  }

  /**
   * Stores enrichment result in database.
   * @param {Object} enrichment
   * @private
   */
  const _storeEnrichment = (enrichment) => {
    db.prepare(`
      INSERT OR REPLACE INTO enrichment (
        chunk_id, file_id, hash, content_hash,
        summary, purpose, key_operations, side_effects, state_changes,
        implicit_dependencies, design_patterns, architectural_patterns,
        anti_patterns, complexity, security_concerns, performance_concerns,
        business_rules, tags, model_used, prompt_version, enriched_at, confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?)
    `).run(
      enrichment.chunk_id,
      enrichment.file_id,
      enrichment.hash,
      enrichment.content_hash || null,
      enrichment.summary,
      enrichment.purpose,
      JSON.stringify(enrichment.key_operations || []),
      JSON.stringify(enrichment.side_effects || []),
      JSON.stringify(enrichment.state_changes || []),
      JSON.stringify(enrichment.implicit_dependencies || []),
      JSON.stringify(enrichment.design_patterns || []),
      JSON.stringify(enrichment.architectural_patterns || []),
      JSON.stringify(enrichment.anti_patterns || []),
      enrichment.complexity || 'medium',
      JSON.stringify(enrichment.security_concerns || []),
      JSON.stringify(enrichment.performance_concerns || []),
      JSON.stringify(enrichment.business_rules || []),
      JSON.stringify(enrichment.tags || []),
      enrichment.model_used,
      enrichment.prompt_version,
      enrichment.confidence || 0.8
    );
  };

  /**
   * Generates and stores enriched embedding for a chunk.
   * Called after enrichment completes to improve semantic search quality.
   * 
   * @param {string} chunkId - The chunk that was enriched
   * @param {Object} enrichment - The enrichment data
   * @private
   */
  const _generateEnrichedEmbedding = async (chunkId, enrichment) => {
    if (!embedder) return; // No embedder available, skip

    try {
      // Get chunk and file data
      const chunkWithFile = db.getChunkWithFile(chunkId);
      if (!chunkWithFile) {
        console.warn(`Could not find chunk ${chunkId} for enriched embedding`);
        return;
      }

      // Build chunk and file data for representation builder
      const chunkData = {
        id: chunkWithFile.id,
        name: chunkWithFile.name,
        type: chunkWithFile.type,
        code: chunkWithFile.code,
        jsdoc: chunkWithFile.jsdoc,
        signature: chunkWithFile.signature,
        startLine: chunkWithFile.start_line,
        endLine: chunkWithFile.end_line
      };

      const fileData = {
        path: chunkWithFile.file_path,
        fanIn: chunkWithFile.fan_in || 0,
        fanOut: chunkWithFile.fan_out || 0
      };

      // Parse enrichment for embedding format
      const enrichmentData = parseEnrichmentForEmbedding(enrichment);

      // Build enriched representation
      const representation = buildEnrichedRepresentation(chunkData, fileData, enrichmentData);

      // Generate embedding
      const embedding = await embedder.embed(representation);

      // Store in enriched embeddings table
      db.upsertEnrichedEmbedding(chunkId, new Float32Array(embedding));
    } catch (error) {
      // Log but don't fail the enrichment - base embedding still works
      console.error(`Failed to generate enriched embedding for ${chunkId}:`, error.message);
    }
  };

  /**
   * Gets existing enrichment for a chunk.
   * @param {string} chunkId
   * @returns {Object|null}
   * @private
   */
  const _getExisting = (chunkId) => {
    const row = db.prepare(`
      SELECT e.*, f.hash as current_hash 
      FROM enrichment e
      JOIN chunks c ON c.id = e.chunk_id
      JOIN files f ON f.id = c.file_id
      WHERE e.chunk_id = ?
    `).get(chunkId);

    if (!row) return null;

    // Check if still valid (file hash matches)
    if (row.hash !== row.current_hash) {
      return null; // Stale, needs re-enrichment
    }

    return row;
  };

  /**
   * Enriches a single chunk on-demand.
   * Returns cached result if valid, otherwise performs enrichment.
   * 
   * @param {string} chunkId
   * @param {Object} options
   * @param {boolean} [options.force=false] - Force re-enrichment even if cached
   * @returns {Promise<Object>}
   */
  const enrichChunk = async (chunkId, options = {}) => {
    // Check for valid cached result
    if (!options.force) {
      const existing = _getExisting(chunkId);
      if (existing) {
        return existing;
      }
    }

    // Perform enrichment
    const enrichment = await enricher.enrichWithContext(chunkId);
    
    // Store result
    _storeEnrichment(enrichment);

    // Generate enriched embedding for better semantic search
    await _generateEnrichedEmbedding(chunkId, enrichment);

    return enrichment;
  };

  /**
   * Enriches multiple chunks on-demand.
   * Processes sequentially to respect rate limits.
   * 
   * @param {string[]} chunkIds
   * @param {Object} options
   * @returns {Promise<Object[]>}
   */
  const enrichChunks = async (chunkIds, options = {}) => {
    const results = [];

    for (const chunkId of chunkIds) {
      try {
        const enrichment = await enrichChunk(chunkId, options);
        results.push(enrichment);
      } catch (error) {
        results.push({
          chunk_id: chunkId,
          error: error.message,
          success: false
        });
      }

      // Small delay between items
      await new Promise(r => setTimeout(r, 200));
    }

    return results;
  };

  /**
   * Enriches all chunks for a file.
   * 
   * @param {number} fileId
   * @param {Object} options
   * @returns {Promise<Object[]>}
   */
  const enrichFile = async (fileId, options = {}) => {
    const chunks = db.prepare(`
      SELECT id FROM chunks WHERE file_id = ?
    `).all(fileId);

    const chunkIds = chunks.map(c => c.id);
    return enrichChunks(chunkIds, options);
  };

  return { isEnabled, enrichChunk, enrichChunks, enrichFile };
}
