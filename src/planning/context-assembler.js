/**
 * Creates a context assembler for building LLM prompts.
 * @param {Object} db - Database adapter
 * @returns {Object} Context Assembler API
 */
export function createContextAssembler(db) {
  /**
   * Assembles context from search results.
   * @param {Object[]} searchResults 
   * @param {number} [maxTokens=8000] 
   * @returns {Promise<Object>} Assembled context
   */
  const assemble = async (searchResults, maxTokens = 8000) => {
    const chunks = [];
    const enrichments = [];
    let totalTokens = 0;

    for (const result of searchResults) {
      if (result.method !== 'semantic') continue; // Only semantic results for now

      const chunk = db.prepare(`
        SELECT c.*, f.path FROM chunks c
        JOIN files f ON f.id = c.file_id
        WHERE c.id = ?
      `).get(result.chunkId);

      if (!chunk) continue;

      // Rough token count if not available
      const tokens = chunk.token_count || Math.ceil(chunk.code.length / 4);
      if (totalTokens + tokens > maxTokens) break;

      chunks.push(chunk);
      totalTokens += tokens;

      const enrichment = db.prepare(`SELECT * FROM enrichment WHERE chunk_id = ?`).get(result.chunkId);
      if (enrichment) {
        enrichments.push(enrichment);
      }
    }

    const codeContext = chunks.map(c => 
      `// File: ${c.path} (lines ${c.start_line}-${c.end_line})\n${c.code}`
    ).join('\n\n');

    return {
      code: codeContext,
      enrichments,
      tokenCount: totalTokens
    };
  };

  return { assemble };
}
