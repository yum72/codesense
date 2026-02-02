import { createQueryUnderstandingEngine } from './query-understanding.js';

/**
 * @typedef {Object} SearchResult
 * @property {string} chunkId
 * @property {string} path
 * @property {string} name
 * @property {string} method
 * @property {number} score
 * @property {number} [line]
 * @property {string} [code]
 */

/**
 * @typedef {Object} SearchConfig
 * @property {boolean} semantic - Enable semantic search
 * @property {boolean} structural - Enable structural search
 * @property {boolean} grep - Enable grep search
 * @property {boolean} queryUnderstanding - Enable LLM-based query understanding
 * @property {number} defaultLimit - Default result limit
 */

/**
 * @typedef {Object} QueryEngine
 * @property {function(string, Object=): Promise<SearchResult[]>} search
 * @property {function(): Object} getEnabledMethods
 */

/**
 * Creates a query engine that orchestrates multiple search methods.
 * Combines semantic, grep, and structural search with intelligent ranking.
 * 
 * Respects feature flags from config to enable/disable search methods.
 * 
 * @param {Object} db - Database adapter
 * @param {Object} options
 * @param {Object} [options.semanticSearch] - Semantic search API (null if disabled)
 * @param {Object} [options.grepSearch] - Grep search API (null if disabled)
 * @param {Object} [options.structuralSearch] - Structural search API (null if disabled)
 * @param {SearchConfig} options.config - Search configuration with feature flags
 * @returns {QueryEngine}
 */
export function createQueryEngine(db, options = {}) {
  const {
    semanticSearch = null,
    grepSearch = null,
    structuralSearch = null,
    config = {}
  } = options;

  // Determine which methods are actually available
  const enabledMethods = {
    semantic: config.semantic !== false && semanticSearch !== null,
    structural: config.structural !== false && structuralSearch !== null,
    grep: config.grep !== false && grepSearch !== null,
    queryUnderstanding: config.queryUnderstanding !== false
  };

  // Create query understanding engine (falls back to keyword-based if disabled)
  const queryUnderstanding = enabledMethods.queryUnderstanding 
    ? createQueryUnderstandingEngine()
    : createFallbackQueryUnderstanding();

  /**
   * Creates a simple fallback query understanding when LLM is disabled.
   * @returns {Object}
   */
  function createFallbackQueryUnderstanding() {
    return {
      classify: (query) => {
        // Simple keyword-based classification
        const lowerQuery = query.toLowerCase();
        let intent = 'find_implementation';
        
        if (/where.*defined|definition of|find.*function|find.*class/i.test(query)) {
          intent = 'find_definition';
        } else if (/who calls|where.*used|callers|usages/i.test(query)) {
          intent = 'find_usage';
        } else if (/explain|how does|what does/i.test(query)) {
          intent = 'explain';
        }

        // Extract potential symbol (simple version)
        const backtickMatch = query.match(/`([^`]+)`/);
        const targetSymbol = backtickMatch ? backtickMatch[1] : null;

        // Keywords are just the non-stop words
        const stopWords = new Set(['the', 'a', 'is', 'are', 'to', 'of', 'in', 'for', 'and', 'or', 'where', 'what', 'how', 'find', 'show']);
        const keywords = query.toLowerCase()
          .replace(/[^\w\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 2 && !stopWords.has(w));

        // Suggest methods based on what's available
        const suggestedMethods = [];
        if (enabledMethods.semantic) suggestedMethods.push('semantic');
        if (enabledMethods.grep) suggestedMethods.push('grep');
        if (enabledMethods.structural && intent === 'find_definition') {
          suggestedMethods.push('structural');
        }

        return {
          intent,
          keywords,
          targetSymbol,
          suggestedMethods: suggestedMethods.length > 0 ? suggestedMethods : ['grep'],
          modifiers: {}
        };
      }
    };
  }

  /**
   * Normalizes scores to 0-1 range.
   * @param {number} score
   * @param {string} method
   * @returns {number}
   * @private
   */
  const _normalizeScore = (score, method) => {
    if (method === 'semantic') {
      // Semantic distance: lower is better, convert to higher-is-better
      // Typical cosine distance is 0-2, most results are 0-1
      return Math.max(0, 1 - (score / 2));
    }
    if (method === 'grep') {
      // Grep results don't have a score, assign based on position
      return 0.7; // Base score for grep matches
    }
    if (method === 'structural') {
      // Already 0-1
      return score;
    }
    return 0.5;
  };

  /**
   * Deduplicates results by file path and line range.
   * Keeps the highest scored result for overlapping content.
   * @param {SearchResult[]} results
   * @returns {SearchResult[]}
   * @private
   */
  const _deduplicate = (results) => {
    const seen = new Map(); // key: "path:startLine" or just "path:chunkId"

    for (const result of results) {
      // Create a unique key based on path and location
      const key = result.chunkId || `${result.path}:${result.line || 0}`;
      
      if (!seen.has(key) || result.score > seen.get(key).score) {
        seen.set(key, result);
      }
    }

    return Array.from(seen.values());
  };

  /**
   * Ranks results using a weighted scoring system.
   * @param {SearchResult[]} results
   * @param {Object} understanding - Query understanding result
   * @returns {SearchResult[]}
   * @private
   */
  const _rank = (results, understanding) => {
    // Apply method-specific boosts based on intent
    const methodBoosts = {
      find_usage: { graph: 0.3, grep: 0.2 },
      find_definition: { structural: 0.3, grep: 0.2 },
      explain: { semantic: 0.2 },
      find_pattern: { semantic: 0.2, grep: 0.1 }
    };

    const boosts = methodBoosts[understanding.intent] || {};

    return results
      .map(r => ({
        ...r,
        score: r.score + (boosts[r.method] || 0)
      }))
      .sort((a, b) => b.score - a.score);
  };

  /**
   * Returns which search methods are currently enabled.
   * @returns {Object}
   */
  const getEnabledMethods = () => ({ ...enabledMethods });

  /**
   * Searches the codebase using multiple methods.
   * @param {string} query 
   * @param {Object} options 
   * @param {number} [options.limit=10]
   * @param {string} [options.method='all'] - 'all', 'semantic', 'grep', 'structural'
   * @returns {Promise<SearchResult[]>}
   */
  const search = async (query, options = {}) => {
    const { limit = config.defaultLimit || 10, method = 'all' } = options;
    const results = [];

    // Check if any search methods are available
    if (!enabledMethods.semantic && !enabledMethods.grep && !enabledMethods.structural) {
      console.warn('No search methods are enabled. Check your configuration.');
      return [];
    }

    // Understand the query to inform search strategy
    const understanding = queryUnderstanding.classify(query);
    
    // Filter suggested methods to only those that are enabled
    let effectiveMethods;
    if (method === 'all') {
      effectiveMethods = understanding.suggestedMethods.filter(m => {
        if (m === 'semantic') return enabledMethods.semantic;
        if (m === 'structural') return enabledMethods.structural;
        if (m === 'grep') return enabledMethods.grep;
        return false;
      });
      // Fallback to grep if nothing else is available
      if (effectiveMethods.length === 0 && enabledMethods.grep) {
        effectiveMethods = ['grep'];
      }
    } else {
      // Single method requested - check if it's enabled
      if (method === 'semantic' && !enabledMethods.semantic) {
        console.warn('Semantic search is disabled. Enable indexing.maxTier >= 2 and search.semantic in config.');
        return [];
      }
      if (method === 'structural' && !enabledMethods.structural) {
        console.warn('Structural search is disabled. Enable indexing.maxTier >= 1 and search.structural in config.');
        return [];
      }
      if (method === 'grep' && !enabledMethods.grep) {
        console.warn('Grep search is disabled. Enable search.grep in config.');
        return [];
      }
      effectiveMethods = [method];
    }

    // Execute searches in parallel where possible
    const searchPromises = [];

    if (effectiveMethods.includes('semantic') && semanticSearch) {
      searchPromises.push(
        semanticSearch.search(query, limit * 2).then(res =>
          res.map(r => ({
            chunkId: r.chunkId,
            path: r.path,
            name: r.name || '',
            code: r.code,
            line: r.startLine,
            method: 'semantic',
            score: r.score  // Already normalized 0-1 similarity from Memgraph
          }))
        ).catch(err => {
          console.error('Semantic search failed:', err.message);
          return [];
        })
      );
    }

    if (effectiveMethods.includes('grep') && grepSearch) {
      // Grep with target symbol if detected, otherwise keywords
      const grepQuery = understanding.targetSymbol || query;
      searchPromises.push(
        Promise.resolve(grepSearch.search(grepQuery)).then(res =>
          res.slice(0, limit * 2).map((r, idx) => ({
            path: r.path,
            line: r.line,
            name: r.match || '',
            code: r.context,
            method: 'grep',
            score: _normalizeScore(0, 'grep') - (idx * 0.01) // Slight decay by position
          }))
        ).catch(err => {
          console.error('Grep search failed:', err.message);
          return [];
        })
      );
    }

    if (effectiveMethods.includes('structural') && structuralSearch) {
      const structuralQuery = understanding.targetSymbol || 
        understanding.keywords.join(' ');
      searchPromises.push(
        Promise.resolve(structuralSearch.findDefinitions(structuralQuery, { 
          limit: limit * 2 
        })).then(res =>
          res.map(r => ({
            path: r.path,
            name: r.name,
            line: r.startLine,
            method: 'structural',
            score: r.relevance
          }))
        ).catch(err => {
          console.error('Structural search failed:', err.message);
          return [];
        })
      );
    }

    // Wait for all searches
    const searchResults = await Promise.all(searchPromises);
    for (const batch of searchResults) {
      results.push(...batch);
    }

    // Deduplicate, rank, and limit
    const deduped = _deduplicate(results);
    const ranked = _rank(deduped, understanding);

    return ranked.slice(0, limit);
  };

  return { search, getEnabledMethods };
}
