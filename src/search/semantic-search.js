/**
 * Creates a semantic search engine using Memgraph vector search.
 * 
 * Combines vector similarity with graph context for enhanced retrieval:
 * - Uses Memgraph's built-in vector_search for semantic matching
 * - Optionally expands results with graph neighborhood (callers, callees)
 * - Respects context tiers (full > partial > structural) for ranking
 * 
 * @param {Object} db - Memgraph database adapter
 * @param {Object} embedder - Embedder API
 * @returns {Object} Semantic Search API
 */
export function createSemanticSearch(db, embedder) {
  /**
   * Searches for code chunks using semantic similarity.
   * Uses Memgraph's vector index for fast approximate nearest neighbor search.
   * 
   * @param {string} query - Natural language query
   * @param {number} [limit=10] - Max results
   * @returns {Promise<Object[]>} Search results
   */
  const search = async (query, limit = 10) => {
    const embedding = await embedder.embed(query);
    
    // Use Memgraph adapter's semantic search
    const results = await db.semanticSearch(embedding, limit);
    
    return results.map((r, idx) => ({
      chunkId: r.chunkId,
      name: r.name,
      type: r.type,
      code: r.code,
      path: r.filePath,
      startLine: r.startLine,
      endLine: r.endLine,
      jsdoc: r.jsdoc,
      signature: r.signature,
      score: r.score,
      contextTier: r.contextTier,
      source: 'semantic'
    }));
  };

  /**
   * Searches with graph context expansion.
   * Finds semantically similar chunks, then expands with their graph neighbors.
   * 
   * @param {string} query - Natural language query
   * @param {Object} options
   * @param {number} [options.limit=10] - Max primary results
   * @param {boolean} [options.includeCallers=true] - Include callers in context
   * @param {boolean} [options.includeCallees=true] - Include callees in context
   * @param {number} [options.contextDepth=1] - How many hops for context
   * @returns {Promise<Object>} Search results with context
   */
  const searchWithContext = async (query, options = {}) => {
    const { 
      limit = 10, 
      includeCallers = true, 
      includeCallees = true,
      contextDepth = 1 
    } = options;

    const embedding = await embedder.embed(query);
    
    // Use adapter's combined vector + graph search
    const results = await db.semanticSearchWithContext(embedding, {
      limit,
      includeCallers,
      includeCallees,
      depth: contextDepth
    });

    return {
      primary: results.primary.map(formatResult),
      context: results.context.map(r => ({
        ...formatResult(r),
        relationship: r.relationship,
        relatedTo: r.relatedTo
      })),
      stats: {
        primaryCount: results.primary.length,
        contextCount: results.context.length,
        queryEmbeddingTime: results.embeddingTime
      }
    };
  };

  /**
   * Finds similar code to a given chunk.
   * Useful for "find similar patterns" queries.
   * 
   * @param {string} chunkId - Reference chunk ID
   * @param {number} [limit=5] - Max results
   * @returns {Promise<Object[]>} Similar chunks
   */
  const findSimilar = async (chunkId, limit = 5) => {
    // Get the chunk's embedding
    const result = await db.query(`
      MATCH (c:Chunk {id: $chunkId})
      RETURN c.embedding AS embedding
    `, { chunkId });

    if (result.records.length === 0 || !result.records[0].get('embedding')) {
      return [];
    }

    const embedding = result.records[0].get('embedding');
    
    // Search for similar, excluding the source chunk
    const similar = await db.query(`
      CALL vector_search.search('chunk_embedding_index', toInteger($limit) + 1, $embedding)
      YIELD node, score
      WHERE node.id <> $chunkId
      MATCH (node)-[:BELONGS_TO]->(f:File)
      RETURN node.id AS id, node.name AS name, node.type AS type,
             f.path AS filePath, score,
             node.contextTier AS contextTier
      LIMIT toInteger($limit)
    `, { embedding, chunkId, limit: Math.floor(limit) });

    return similar.records.map(r => ({
      chunkId: r.get('id'),
      name: r.get('name'),
      type: r.get('type'),
      path: r.get('filePath'),
      score: r.get('score'),
      contextTier: r.get('contextTier')
    }));
  };

  /**
   * Hybrid search combining semantic and keyword matching.
   * 
   * @param {string} query - Search query
   * @param {Object} options
   * @param {number} [options.limit=10]
   * @param {number} [options.semanticWeight=0.7] - Weight for semantic results
   * @param {number} [options.keywordWeight=0.3] - Weight for keyword matches
   * @returns {Promise<Object[]>}
   */
  const hybridSearch = async (query, options = {}) => {
    const { limit = 10, semanticWeight = 0.7, keywordWeight = 0.3 } = options;

    // Get semantic results
    const embedding = await embedder.embed(query);
    const semanticResults = await db.semanticSearch(embedding, limit * 2);

    // Extract keywords for exact matching
    const keywords = extractKeywords(query);
    
    // Get keyword matches from graph
    const keywordResults = await db.query(`
      MATCH (c:Chunk)-[:BELONGS_TO]->(f:File)
      WHERE any(kw IN $keywords WHERE 
        c.name CONTAINS kw OR 
        c.code CONTAINS kw OR
        c.jsdoc CONTAINS kw
      )
      RETURN c.id AS id, c.name AS name, c.type AS type,
             c.code AS code, f.path AS filePath,
             c.startLine AS startLine, c.endLine AS endLine,
             c.contextTier AS contextTier
      LIMIT $limit
    `, { keywords, limit: limit * 2 });

    // Merge and score results
    const merged = new Map();

    // Add semantic results
    for (const r of semanticResults) {
      merged.set(r.id, {
        ...r,
        semanticScore: r.score,
        keywordScore: 0,
        combinedScore: r.score * semanticWeight
      });
    }

    // Add/update keyword results
    for (const record of keywordResults.records) {
      const id = record.get('id');
      const existing = merged.get(id);
      const keywordScore = 1.0; // Binary match for now

      if (existing) {
        existing.keywordScore = keywordScore;
        existing.combinedScore = 
          existing.semanticScore * semanticWeight + 
          keywordScore * keywordWeight;
      } else {
        merged.set(id, {
          id,
          name: record.get('name'),
          type: record.get('type'),
          code: record.get('code'),
          filePath: record.get('filePath'),
          startLine: record.get('startLine'),
          endLine: record.get('endLine'),
          contextTier: record.get('contextTier'),
          semanticScore: 0,
          keywordScore,
          combinedScore: keywordScore * keywordWeight
        });
      }
    }

    // Sort by combined score and limit
    const sorted = Array.from(merged.values())
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, limit);

    return sorted.map(formatResult);
  };

  /**
   * Gets statistics about embedding coverage and tiers.
   * @returns {Promise<Object>}
   */
  const getStats = async () => {
    const result = await db.query(`
      MATCH (c:Chunk)
      WITH 
        count(*) AS total,
        sum(CASE WHEN c.embedding IS NOT NULL THEN 1 ELSE 0 END) AS withEmbedding,
        sum(CASE WHEN c.contextTier = 'full' THEN 1 ELSE 0 END) AS fullTier,
        sum(CASE WHEN c.contextTier = 'partial' THEN 1 ELSE 0 END) AS partialTier,
        sum(CASE WHEN c.contextTier = 'structural' OR c.contextTier IS NULL THEN 1 ELSE 0 END) AS structuralTier
      RETURN total, withEmbedding, fullTier, partialTier, structuralTier
    `);

    if (result.records.length === 0) {
      return { total: 0, withEmbedding: 0, tiers: {} };
    }

    const r = result.records[0];
    return {
      total: r.get('total')?.toNumber?.() || r.get('total') || 0,
      withEmbedding: r.get('withEmbedding')?.toNumber?.() || r.get('withEmbedding') || 0,
      tiers: {
        full: r.get('fullTier')?.toNumber?.() || r.get('fullTier') || 0,
        partial: r.get('partialTier')?.toNumber?.() || r.get('partialTier') || 0,
        structural: r.get('structuralTier')?.toNumber?.() || r.get('structuralTier') || 0
      }
    };
  };

  return { 
    search, 
    searchWithContext, 
    findSimilar, 
    hybridSearch,
    getStats 
  };
}

/**
 * Formats a search result for consistent output.
 * @param {Object} r - Raw result
 * @returns {Object}
 */
function formatResult(r) {
  return {
    chunkId: r.id || r.chunkId,
    name: r.name,
    type: r.type,
    code: r.code,
    path: r.filePath || r.path,
    startLine: r.startLine,
    endLine: r.endLine,
    jsdoc: r.jsdoc,
    signature: r.signature,
    score: r.score || r.combinedScore,
    contextTier: r.contextTier
  };
}

/**
 * Extracts keywords from a query for keyword matching.
 * @param {string} query 
 * @returns {string[]}
 */
function extractKeywords(query) {
  // Remove common words and split
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'what', 'where', 'when', 'how', 'why', 'which', 'who',
    'find', 'show', 'get', 'list', 'search', 'look', 'for',
    'that', 'this', 'with', 'from', 'to', 'in', 'on', 'at',
    'code', 'function', 'method', 'class', 'file', 'all'
  ]);

  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word))
    .slice(0, 5); // Max 5 keywords
}
