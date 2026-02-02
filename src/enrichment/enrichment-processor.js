import { createResearchAgent } from './research-agent.js';
import { buildEnrichedRepresentation } from '../indexing/representation-builder.js';

/**
 * Creates an enrichment processor for background queue processing.
 * 
 * Coordinates the Research Agent with the enrichment queue,
 * handling retries, rate limiting, and embedding generation.
 * 
 * @param {Object} deps - Dependencies
 * @param {Object} deps.db - Memgraph database adapter
 * @param {Object} deps.llmClient - LLM client
 * @param {Object} deps.embedder - Embedder for generating vectors
 * @param {Object} deps.config - Configuration
 * @returns {Object} Enrichment Processor API
 */
export function createEnrichmentProcessor({ db, llmClient, embedder, config }) {
  const researchAgent = createResearchAgent({ db, llmClient, config });
  
  const batchSize = config?.enrichment?.batchSize ?? 5;
  const maxRetries = config?.enrichment?.maxRetries ?? 3;
  const dailyLimit = config?.enrichment?.dailyLimit ?? 1000;

  // Track daily usage
  let dailyCallCount = 0;
  let lastResetDate = new Date().toDateString();

  /**
   * Resets daily counter if it's a new day.
   */
  const checkDailyReset = () => {
    const today = new Date().toDateString();
    if (today !== lastResetDate) {
      dailyCallCount = 0;
      lastResetDate = today;
    }
  };

  /**
   * Processes a single chunk through the research agent.
   * 
   * @param {string} chunkId - Chunk to enrich
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  const processChunk = async (chunkId) => {
    checkDailyReset();
    
    if (dailyCallCount >= dailyLimit) {
      return { success: false, error: 'Daily limit reached' };
    }

    try {
      // Run research agent
      const result = await researchAgent.enrich(chunkId);
      dailyCallCount++;

      // Store enrichment results
      await researchAgent.storeResults(result);

      // Generate embedding from enriched representation
      if (embedder) {
        const chunk = await db.getChunkWithFile(chunkId);
        if (chunk) {
          const representation = buildEnrichedRepresentation(chunk, result.enrichment);
          const embedding = await embedder.embed(representation);
          
          // Update chunk with new embedding
          await db.upsertChunkWithEmbedding({
            id: chunk.id,
            fileId: chunk.fileId,
            type: chunk.type,
            name: chunk.name,
            code: chunk.code,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            tokenCount: chunk.tokenCount,
            jsdoc: chunk.jsdoc,
            signature: chunk.signature
          }, new Float32Array(embedding));
        }
      }

      // Mark queue item as complete
      await db.updateEnrichmentQueueStatus(chunkId, 'complete');

      return { 
        success: true, 
        toolCalls: result.toolCallCount,
        researchedCount: result.researchSources.length
      };

    } catch (e) {
      console.error(`Enrichment failed for ${chunkId}:`, e.message);
      
      // Update queue item with error, increment attempts
      const queueItem = await getQueueItem(chunkId);
      const attempts = (queueItem?.attempts || 0) + 1;
      
      if (attempts >= maxRetries) {
        await db.updateEnrichmentQueueStatus(chunkId, 'failed', e.message);
      } else {
        // Schedule retry with exponential backoff
        const retryDelay = Math.pow(2, attempts) * 60000; // 2, 4, 8 minutes
        await db.updateEnrichmentQueueStatus(chunkId, 'pending', e.message, retryDelay);
      }

      return { success: false, error: e.message };
    }
  };

  /**
   * Gets a queue item by chunk ID.
   * @param {string} chunkId 
   * @returns {Promise<Object|null>}
   */
  const getQueueItem = async (chunkId) => {
    const result = await db.query(`
      MATCH (q:EnrichmentQueueItem {chunkId: $chunkId})
      RETURN q.attempts AS attempts, q.status AS status
    `, { chunkId });
    
    if (result.records.length === 0) return null;
    const record = result.records[0];
    return {
      attempts: record.get('attempts'),
      status: record.get('status')
    };
  };

  /**
   * Processes a batch of chunks from the enrichment queue.
   * 
   * @param {number} [limit] - Max chunks to process (defaults to batchSize)
   * @returns {Promise<{processed: number, succeeded: number, failed: number}>}
   */
  const processBatch = async (limit = batchSize) => {
    checkDailyReset();

    const remaining = dailyLimit - dailyCallCount;
    if (remaining <= 0) {
      console.log('Daily enrichment limit reached');
      return { processed: 0, succeeded: 0, failed: 0, reason: 'daily_limit' };
    }

    const effectiveLimit = Math.min(limit, remaining);
    const batch = await db.getEnrichmentQueueBatch(effectiveLimit);

    let succeeded = 0;
    let failed = 0;

    for (const item of batch) {
      // Mark as processing
      await db.updateEnrichmentQueueStatus(item.chunkId, 'processing');

      const result = await processChunk(item.chunkId);
      if (result.success) {
        succeeded++;
      } else {
        failed++;
      }
    }

    return {
      processed: batch.length,
      succeeded,
      failed,
      dailyRemaining: dailyLimit - dailyCallCount
    };
  };

  /**
   * Adds chunks to the enrichment queue.
   * 
   * @param {Array<{chunkId: string, priority: number}>} items 
   * @returns {Promise<number>} Number of items queued
   */
  const queueChunks = async (items) => {
    let queued = 0;
    for (const item of items) {
      await db.queueForEnrichment(item.chunkId, item.priority);
      queued++;
    }
    return queued;
  };

  /**
   * Gets queue statistics.
   * @returns {Promise<Object>}
   */
  const getQueueStats = async () => {
    const stats = await db.query(`
      MATCH (q:EnrichmentQueueItem)
      RETURN q.status AS status, count(*) AS count
    `);

    const byStatus = {};
    for (const record of stats.records) {
      byStatus[record.get('status')] = record.get('count').toNumber();
    }

    return {
      ...byStatus,
      dailyCallCount,
      dailyLimit,
      dailyRemaining: dailyLimit - dailyCallCount
    };
  };

  /**
   * Runs continuous background processing.
   * 
   * @param {Object} options
   * @param {number} options.intervalMs - Delay between batches (default 30s)
   * @param {function} options.onBatch - Callback after each batch
   * @param {AbortSignal} options.signal - Signal to stop processing
   * @returns {Promise<void>}
   */
  const runBackground = async ({ intervalMs = 30000, onBatch, signal } = {}) => {
    console.log('Starting background enrichment processor...');

    while (!signal?.aborted) {
      const result = await processBatch();
      
      if (onBatch) {
        onBatch(result);
      }

      if (result.processed === 0) {
        // No work to do, wait longer
        await sleep(intervalMs * 2, signal);
      } else {
        await sleep(intervalMs, signal);
      }
    }

    console.log('Background enrichment processor stopped');
  };

  return {
    processChunk,
    processBatch,
    queueChunks,
    getQueueStats,
    runBackground,
    // Expose for testing
    researchAgent
  };
}

/**
 * Sleep helper that respects abort signal.
 * @param {number} ms 
 * @param {AbortSignal} signal 
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
