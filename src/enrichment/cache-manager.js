/**
 * @typedef {Object} EnrichmentCacheManager
 * @property {function(): number} invalidateStale
 * @property {function(number): void} invalidateFile
 * @property {function(string): boolean} isValid
 * @property {function(): Object} getStats
 * @property {function(): void} cleanup
 */

/**
 * Creates a cache manager for enrichment invalidation.
 * Handles cache validation based on file hashes and prompt versions.
 * 
 * @param {Object} db - SQLite database adapter
 * @param {Object} config - Cache configuration
 * @param {string} [config.currentPromptVersion='v1.0'] - Current prompt version
 * @returns {EnrichmentCacheManager}
 */
export function createEnrichmentCacheManager(db, config = {}) {
  const currentPromptVersion = config.currentPromptVersion || 'v1.0';

  /**
   * Checks if an enrichment is still valid.
   * Enrichment is invalid if:
   * - File hash has changed (code was modified)
   * - Prompt version is outdated
   * 
   * @param {string} chunkId
   * @returns {boolean}
   */
  const isValid = (chunkId) => {
    const row = db.prepare(`
      SELECT e.hash as enrichment_hash, e.prompt_version,
             f.hash as current_hash
      FROM enrichment e
      JOIN chunks c ON c.id = e.chunk_id
      JOIN files f ON f.id = c.file_id
      WHERE e.chunk_id = ?
    `).get(chunkId);

    if (!row) return false;

    // Check file hash (code changed)
    if (row.enrichment_hash !== row.current_hash) {
      return false;
    }

    // Check prompt version
    if (row.prompt_version !== currentPromptVersion) {
      return false;
    }

    return true;
  };

  /**
   * Invalidates stale enrichments where file hash no longer matches.
   * Does not delete - marks for re-enrichment by updating the queue.
   * 
   * @returns {number} Number of enrichments invalidated
   */
  const invalidateStale = () => {
    // Find enrichments where file hash has changed
    const stale = db.prepare(`
      SELECT e.id, e.chunk_id, e.file_id
      FROM enrichment e
      JOIN chunks c ON c.id = e.chunk_id
      JOIN files f ON f.id = c.file_id
      WHERE e.hash != f.hash
         OR e.prompt_version != ?
    `).all(currentPromptVersion);

    if (stale.length === 0) return 0;

    // Delete stale enrichments
    const deleteEnrichment = db.prepare('DELETE FROM enrichment WHERE id = ?');
    
    // Queue for re-enrichment
    const queueForReenrichment = db.prepare(`
      INSERT OR IGNORE INTO enrichment_queue (chunk_id, file_id, priority, status)
      VALUES (?, ?, 50, 'pending')
    `);

    db.transaction(() => {
      for (const item of stale) {
        deleteEnrichment.run(item.id);
        queueForReenrichment.run(item.chunk_id, item.file_id);
      }
    })();

    return stale.length;
  };

  /**
   * Invalidates all enrichments for a specific file.
   * Used when a file is modified.
   * 
   * @param {number} fileId
   */
  const invalidateFile = (fileId) => {
    // Get all chunks for this file that have enrichments
    const chunks = db.prepare(`
      SELECT c.id as chunk_id FROM chunks c
      JOIN enrichment e ON e.chunk_id = c.id
      WHERE c.file_id = ?
    `).all(fileId);

    if (chunks.length === 0) return;

    const deleteEnrichment = db.prepare('DELETE FROM enrichment WHERE chunk_id = ?');
    const queueForReenrichment = db.prepare(`
      INSERT OR IGNORE INTO enrichment_queue (chunk_id, file_id, priority, status)
      VALUES (?, ?, 75, 'pending')
    `);

    db.transaction(() => {
      for (const chunk of chunks) {
        deleteEnrichment.run(chunk.chunk_id);
        queueForReenrichment.run(chunk.chunk_id, fileId);
      }
    })();
  };

  /**
   * Cleans up orphaned enrichments (chunks that no longer exist).
   */
  const cleanup = () => {
    // Delete enrichments for chunks that no longer exist
    db.prepare(`
      DELETE FROM enrichment 
      WHERE chunk_id NOT IN (SELECT id FROM chunks)
    `).run();

    // Delete queue items for chunks that no longer exist
    db.prepare(`
      DELETE FROM enrichment_queue 
      WHERE chunk_id NOT IN (SELECT id FROM chunks)
    `).run();

    // Delete completed queue items older than 7 days
    db.prepare(`
      DELETE FROM enrichment_queue 
      WHERE status = 'complete' 
        AND processed_at < unixepoch() - 604800
    `).run();
  };

  /**
   * Gets cache statistics.
   * @returns {Object}
   */
  const getStats = () => {
    const total = db.prepare(`SELECT COUNT(*) as count FROM enrichment`).get();
    
    const valid = db.prepare(`
      SELECT COUNT(*) as count
      FROM enrichment e
      JOIN chunks c ON c.id = e.chunk_id
      JOIN files f ON f.id = c.file_id
      WHERE e.hash = f.hash AND e.prompt_version = ?
    `).get(currentPromptVersion);

    const stale = db.prepare(`
      SELECT COUNT(*) as count
      FROM enrichment e
      JOIN chunks c ON c.id = e.chunk_id
      JOIN files f ON f.id = c.file_id
      WHERE e.hash != f.hash OR e.prompt_version != ?
    `).get(currentPromptVersion);

    const orphaned = db.prepare(`
      SELECT COUNT(*) as count
      FROM enrichment 
      WHERE chunk_id NOT IN (SELECT id FROM chunks)
    `).get();

    return {
      total: total.count,
      valid: valid.count,
      stale: stale.count,
      orphaned: orphaned.count,
      currentPromptVersion
    };
  };

  return { 
    isValid, 
    invalidateStale, 
    invalidateFile, 
    cleanup,
    getStats 
  };
}
