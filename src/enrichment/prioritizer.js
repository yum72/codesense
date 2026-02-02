/**
 * @typedef {Object} EnrichmentPrioritizer
 * @property {function(string): Promise<number>} calculatePriority
 * @property {function(): Promise<number>} queueHighPriorityChunks
 * @property {function(): Promise<Object>} getQueueStats
 * @property {function(): Promise<void>} computePageRank
 */

/**
 * Creates a prioritizer for enrichment based on graph metrics.
 * 
 * Uses PageRank, fan-in/fan-out, path patterns, and recency to determine priority.
 * Updated for async Memgraph operations.
 * 
 * Priority Rules:
 * - P0 (Critical): PageRank > 0.01 OR fan_in > 10
 * - P1 (High): In /services/ or /core/, hub functions, recently modified
 * - P2 (Medium): Entry points (fan_in = 0, exported)
 * - P3 (Low): Everything else
 * - Skip: Tests, type definitions, small files
 * 
 * @param {Object} db - Memgraph database adapter
 * @returns {EnrichmentPrioritizer}
 */
export function createEnrichmentPrioritizer(db) {
  /**
   * Computes PageRank for all chunks in the graph.
   * Should be called periodically after graph updates.
   * @returns {Promise<void>}
   */
  const computePageRank = async () => {
    await db.computePageRank();
  };

  /**
   * Calculates priority score for a chunk.
   * Higher score = higher priority. Returns 0 to skip.
   * @param {string} chunkId
   * @returns {Promise<number>}
   */
  const calculatePriority = async (chunkId) => {
    const result = await db.query(`
      MATCH (c:Chunk {id: $chunkId})-[:BELONGS_TO]->(f:File)
      RETURN c.pagerank AS pagerank, 
             f.path AS path, 
             f.fanIn AS fanIn, 
             f.fanOut AS fanOut,
             c.tokenCount AS tokenCount
    `, { chunkId });

    if (result.records.length === 0) return 0;

    const record = result.records[0];
    const path = record.get('path');
    const pagerank = record.get('pagerank') || 0;
    const fanIn = record.get('fanIn') || 0;
    const fanOut = record.get('fanOut') || 0;
    const tokenCount = record.get('tokenCount') || 0;

    // Skip criteria - return 0 to exclude
    if (shouldSkip(path)) return 0;

    // Skip very small chunks (< 50 tokens)
    if (tokenCount < 50) return 0;

    let priority = 10; // Base priority for any valid chunk

    // P0: High PageRank = critical priority (hub functions)
    if (pagerank > 0.01) priority += 150;
    else if (pagerank > 0.005) priority += 100;
    else if (pagerank > 0.001) priority += 50;

    // P0: High connectivity
    if (fanIn > 10) priority += 100;
    if (fanOut > 15) priority += 75;

    // P1: Core directories
    if (path.includes('/services/') || 
        path.includes('/core/') ||
        path.includes('/lib/')) {
      priority += 50;
    }

    // P2: Entry points (exported but not imported)
    if (fanIn === 0) {
      const hasExports = await checkExported(chunkId);
      if (hasExports) priority += 25;
    }

    // Bonus for complex chunks
    if (tokenCount > 500) priority += 25;
    if (tokenCount > 1000) priority += 25;

    return Math.max(0, priority);
  };

  /**
   * Checks if path should be skipped for enrichment.
   * @param {string} path 
   * @returns {boolean}
   */
  const shouldSkip = (path) => {
    if (!path) return true;
    
    // Skip tests
    if (path.includes('/test/') || 
        path.includes('/__tests__/') ||
        path.includes('.test.') ||
        path.includes('.spec.')) {
      return true;
    }

    // Skip type definitions
    if (path.endsWith('.d.ts')) return true;

    // Skip config files
    if (path.includes('/config/') && path.endsWith('.json')) return true;

    return false;
  };

  /**
   * Checks if a chunk has exported definitions.
   * @param {string} chunkId 
   * @returns {Promise<boolean>}
   */
  const checkExported = async (chunkId) => {
    const result = await db.query(`
      MATCH (c:Chunk {id: $chunkId})-[:BELONGS_TO]->(f:File)
      MATCH (d:Definition {exported: true})-[:DEFINED_IN]->(f)
      RETURN count(d) > 0 AS hasExports
    `, { chunkId });

    if (result.records.length === 0) return false;
    return result.records[0].get('hasExports');
  };

  /**
   * Queues high priority chunks for background enrichment.
   * Uses PageRank to prioritize hub functions.
   * @returns {Promise<number>} Number of chunks queued
   */
  const queueHighPriorityChunks = async () => {
    // Get chunks that need enrichment, ordered by PageRank
    // Using a simpler pattern that Memgraph handles better
    const result = await db.query(`
      MATCH (f:File)-[:CONTAINS]->(c:Chunk)
      WHERE c.context_tier IS NULL OR c.context_tier = 'structural'
      OPTIONAL MATCH (q:EnrichmentQueueItem {chunk_id: c.id})
      WHERE q.status IN ['pending', 'processing']
      WITH c, f, q
      WHERE q IS NULL
      RETURN c.id AS chunkId, 
             c.pagerank AS pagerank,
             f.path AS path,
             f.fan_in AS fanIn,
             f.fan_out AS fanOut,
             c.token_count AS tokenCount
      ORDER BY COALESCE(c.pagerank, 0) DESC
      LIMIT 100
    `);

    let totalQueued = 0;

    for (const row of result) {
      const chunkId = row.chunkId;
      const path = row.path;
      const pagerank = row.pagerank || 0;
      const fanIn = row.fanIn || 0;
      const fanOut = row.fanOut || 0;
      const tokenCount = row.tokenCount || 0;

      // Skip if it should be excluded
      if (shouldSkip(path)) continue;
      if (tokenCount < 50) continue;

      // Calculate priority inline (avoid extra DB call)
      let priority = 10;
      if (pagerank > 0.01) priority += 150;
      else if (pagerank > 0.005) priority += 100;
      if (fanIn > 10) priority += 100;
      if (fanOut > 15) priority += 75;
      if (path.includes('/services/') || path.includes('/core/')) priority += 50;

      if (priority > 0) {
        await db.queueForEnrichment(chunkId, priority);
        totalQueued++;
      }
    }

    return totalQueued;
  };

  /**
   * Gets statistics about the enrichment queue.
   * @returns {Promise<Object>}
   */
  const getQueueStats = async () => {
    const queueStats = await db.query(`
      MATCH (q:EnrichmentQueueItem)
      WITH q.status AS status, count(*) AS count
      RETURN collect({status: status, count: count}) AS stats
    `);

    const statusCounts = { pending: 0, processing: 0, complete: 0, failed: 0 };
    if (queueStats.records.length > 0) {
      const stats = queueStats.records[0].get('stats');
      for (const s of stats) {
        statusCounts[s.status] = s.count.toNumber ? s.count.toNumber() : s.count;
      }
    }

    const enrichedResult = await db.query(`
      MATCH (c:Chunk)
      WHERE c.contextTier = 'full'
      RETURN count(c) AS count
    `);
    const enrichedCount = enrichedResult.records[0]?.get('count')?.toNumber() || 0;

    const totalResult = await db.query(`
      MATCH (c:Chunk)
      RETURN count(c) AS count
    `);
    const totalChunks = totalResult.records[0]?.get('count')?.toNumber() || 0;

    // Get hub functions (high PageRank)
    const hubsResult = await db.query(`
      MATCH (c:Chunk)
      WHERE c.pagerank > 0.005
      RETURN count(c) AS count
    `);
    const hubCount = hubsResult.records[0]?.get('count')?.toNumber() || 0;

    return {
      queue: statusCounts,
      enriched: enrichedCount,
      totalChunks,
      hubFunctions: hubCount,
      enrichmentRate: totalChunks > 0 
        ? (enrichedCount / totalChunks * 100).toFixed(1) + '%'
        : '0%'
    };
  };

  return { 
    calculatePriority, 
    queueHighPriorityChunks,
    getQueueStats,
    computePageRank
  };
}
