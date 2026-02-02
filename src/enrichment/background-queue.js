import { featureDisabledError } from '../utils/config.js';
import { buildEnrichedRepresentation, parseEnrichmentForEmbedding } from '../indexing/representation-builder.js';

/**
 * @typedef {Object} BackgroundEnrichmentQueue
 * @property {function(): Promise<void>} start
 * @property {function(): void} stop
 * @property {function(): Object} getStats
 * @property {function(): Promise<number>} processOnce
 * @property {function(): boolean} isEnabled
 */

/**
 * @typedef {Object} QueueConfig
 * @property {boolean} [enabled=true] - Whether background queue is enabled
 * @property {number} [batchSize=5] - Items to process per batch
 * @property {number} [idleDelayMs=30000] - Delay when queue is empty
 * @property {number} [maxRetries=3] - Maximum retry attempts
 * @property {number} [dailyLimit=1000] - Maximum enrichments per day
 */

/**
 * Creates a background enrichment queue with retry logic.
 * Processes enrichment requests asynchronously with exponential backoff.
 * 
 * @param {Object} db - SQLite database adapter
 * @param {Object} enricher - Hierarchical enricher instance (null if disabled)
 * @param {QueueConfig} config - Queue configuration
 * @param {Object} [embedder] - Embedder instance for re-embedding after enrichment
 * @returns {BackgroundEnrichmentQueue}
 */
export function createBackgroundEnrichmentQueue(db, enricher, config = {}, embedder = null) {
  const enabled = config.enabled !== false && enricher !== null;
  const batchSize = config.batchSize || 5;
  const idleDelayMs = config.idleDelayMs || 30000;
  const maxRetries = config.maxRetries || 3;
  const dailyLimit = config.dailyLimit || 1000;

  let isProcessing = false;
  let processedToday = 0;
  let lastResetDate = new Date().toDateString();

  // Stats tracking
  let stats = {
    processed: 0,
    failed: 0,
    startedAt: null
  };

  /**
   * Returns whether background queue is enabled.
   * @returns {boolean}
   */
  const isEnabled = () => enabled;

  // If disabled, return stub implementation
  if (!enabled) {
    return {
      isEnabled,
      start: async () => {
        console.warn('Background enrichment queue is disabled in configuration');
      },
      stop: () => {},
      getStats: () => ({
        enabled: false,
        isProcessing: false,
        processedThisSession: 0,
        failedThisSession: 0,
        processedToday: 0,
        dailyLimit,
        remainingToday: dailyLimit,
        queue: { pending: 0, processing: 0, complete: 0, permanentlyFailed: 0, retrying: 0 },
        startedAt: null,
        disabledReason: enricher === null 
          ? 'LLM/enrichment is disabled' 
          : 'enrichment.backgroundQueue is false'
      }),
      processOnce: async () => 0
    };
  }

  /**
   * Calculates exponential backoff delay in seconds.
   * @param {number} attempts
   * @returns {number}
   * @private
   */
  const _calculateBackoff = (attempts) => {
    const baseDelay = 60; // 60 seconds
    return Math.min(baseDelay * Math.pow(2, attempts), 3600); // Max 1 hour
  };

  /**
   * Resets daily counter if date changed.
   * @private
   */
  const _checkDailyReset = () => {
    const today = new Date().toDateString();
    if (today !== lastResetDate) {
      processedToday = 0;
      lastResetDate = today;
    }
  };

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
   * Processes a single enrichment item.
   * @param {Object} item - Queue item
   * @returns {Promise<boolean>} Success status
   * @private
   */
  const _processItem = async (item) => {
    const updateStatus = db.prepare(`
      UPDATE enrichment_queue 
      SET status = ?, processed_at = unixepoch(), attempts = attempts + 1, error_message = ?
      WHERE id = ?
    `);

    const updateRetry = db.prepare(`
      UPDATE enrichment_queue 
      SET status = 'pending', attempts = attempts + 1, 
          next_retry_at = unixepoch() + ?, error_message = ?
      WHERE id = ?
    `);

    try {
      // Mark as processing
      db.prepare(`UPDATE enrichment_queue SET status = 'processing' WHERE id = ?`)
        .run(item.id);

      // Perform enrichment
      const enrichment = await enricher.enrichWithContext(item.chunk_id);

      // Store result
      _storeEnrichment(enrichment);

      // Generate enriched embedding for better semantic search
      await _generateEnrichedEmbedding(item.chunk_id, enrichment);

      // Mark as complete
      updateStatus.run('complete', null, item.id);
      stats.processed++;
      processedToday++;

      return true;
    } catch (error) {
      stats.failed++;
      const currentAttempts = item.attempts + 1;

      if (currentAttempts >= maxRetries) {
        // Exceeded max retries - mark as permanently failed
        updateStatus.run('failed', error.message, item.id);
      } else {
        // Schedule retry with exponential backoff
        const backoffSeconds = _calculateBackoff(currentAttempts);
        updateRetry.run(backoffSeconds, error.message, item.id);
      }

      return false;
    }
  };

  /**
   * Processes a single batch of items.
   * @returns {Promise<number>} Number of items processed
   */
  const processOnce = async () => {
    _checkDailyReset();

    if (processedToday >= dailyLimit) {
      return 0;
    }

    const remainingToday = dailyLimit - processedToday;
    const effectiveBatchSize = Math.min(batchSize, remainingToday);

    // Get pending items (including failed items ready for retry)
    const batch = db.prepare(`
      SELECT id, chunk_id, file_id, attempts FROM enrichment_queue 
      WHERE (
        status = 'pending' 
        OR (status = 'pending' AND attempts < ? AND (next_retry_at IS NULL OR unixepoch() >= next_retry_at))
      )
      ORDER BY priority DESC, created_at ASC
      LIMIT ?
    `).all(maxRetries, effectiveBatchSize);

    if (batch.length === 0) {
      return 0;
    }

    // Process items sequentially to respect rate limits
    let processed = 0;
    for (const item of batch) {
      const success = await _processItem(item);
      if (success) processed++;
      
      // Small delay between items to avoid overwhelming LLM API
      await new Promise(r => setTimeout(r, 500));
    }

    return processed;
  };

  /**
   * Main processing loop.
   * @private
   */
  const _processLoop = async () => {
    while (isProcessing) {
      const processed = await processOnce();

      if (processed === 0) {
        // No work to do, wait before checking again
        await new Promise(r => setTimeout(r, idleDelayMs));
      } else {
        // Small delay between batches
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  };

  /**
   * Starts the background processing loop.
   */
  const start = async () => {
    if (isProcessing) return;
    
    isProcessing = true;
    stats.startedAt = new Date();
    stats.processed = 0;
    stats.failed = 0;
    
    // Start loop without awaiting (runs in background)
    _processLoop().catch(err => {
      console.error('Background enrichment loop error:', err);
      isProcessing = false;
    });
  };

  /**
   * Stops the background processing loop.
   */
  const stop = () => {
    isProcessing = false;
  };

  /**
   * Gets current queue statistics.
   * @returns {Object}
   */
  const getStats = () => {
    const queueStats = db.prepare(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'processing') as processing,
        COUNT(*) FILTER (WHERE status = 'complete') as complete,
        COUNT(*) FILTER (WHERE status = 'failed' AND attempts >= ?) as permanentlyFailed,
        COUNT(*) FILTER (WHERE status = 'pending' AND attempts > 0) as retrying
      FROM enrichment_queue
    `).get(maxRetries);

    return {
      enabled: true,
      isProcessing,
      processedThisSession: stats.processed,
      failedThisSession: stats.failed,
      processedToday,
      dailyLimit,
      remainingToday: dailyLimit - processedToday,
      queue: queueStats,
      startedAt: stats.startedAt
    };
  };

  return { isEnabled, start, stop, getStats, processOnce };
}
