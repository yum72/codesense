/**
 * @typedef {Object} StructuralSearchResult
 * @property {string} fileId
 * @property {string} path
 * @property {string} defId
 * @property {string} name
 * @property {string} type
 * @property {number} startLine
 * @property {number} endLine
 * @property {string} signature
 * @property {boolean} exported
 * @property {number} relevance
 */

/**
 * Creates a structural search engine for AST-based queries.
 * Uses Cypher queries against Memgraph for structural matching.
 * 
 * @param {Object} db - Memgraph database adapter
 * @returns {Object} Structural Search API
 */
export function createStructuralSearch(db) {
  /**
   * Finds definitions by name (exact or fuzzy).
   * @param {string} name - Symbol name to find
   * @param {Object} options
   * @param {boolean} [options.exact=false] - Exact match only
   * @param {string} [options.type] - Filter by type (function, class, etc.)
   * @param {boolean} [options.exportedOnly=false] - Only exported symbols
   * @param {number} [options.limit=20] - Maximum results
   * @returns {Promise<StructuralSearchResult[]>}
   */
  const findDefinitions = async (name, options = {}) => {
    const { exact = false, type, exportedOnly = false, limit = 20 } = options;

    let whereClause = exact 
      ? 'd.name = $name' 
      : 'd.name CONTAINS $name';
    
    if (type) {
      whereClause += ' AND d.type = $type';
    }
    if (exportedOnly) {
      whereClause += ' AND d.exported = true';
    }

    const result = await db.query(`
      MATCH (d:Definition)-[:DEFINED_IN]->(f:File)
      WHERE ${whereClause}
      RETURN d.id AS defId, d.name AS name, d.type AS type,
             d.startLine AS startLine, d.endLine AS endLine,
             d.signature AS signature, d.exported AS exported,
             f.id AS fileId, f.path AS path, f.fanIn AS fanIn
      ORDER BY 
        CASE WHEN d.name = $name THEN 0 ELSE 1 END,
        d.exported DESC,
        COALESCE(f.fanIn, 0) DESC
      LIMIT $limit
    `, { name, type, limit });

    return result.records.map((r, idx) => ({
      defId: r.get('defId'),
      name: r.get('name'),
      type: r.get('type'),
      startLine: toNumber(r.get('startLine')),
      endLine: toNumber(r.get('endLine')),
      signature: r.get('signature'),
      exported: r.get('exported'),
      fileId: r.get('fileId'),
      path: r.get('path'),
      relevance: 1 - (idx / result.records.length) * 0.5
    }));
  };

  /**
   * Finds all definitions of a specific type.
   * @param {string} type - Definition type (function, class, interface, const, type)
   * @param {Object} options
   * @param {string} [options.pathPattern] - Filter by path pattern
   * @param {boolean} [options.exportedOnly=false]
   * @param {number} [options.limit=50]
   * @returns {Promise<StructuralSearchResult[]>}
   */
  const findByType = async (type, options = {}) => {
    const { pathPattern, exportedOnly = false, limit = 50 } = options;

    let whereClause = 'd.type = $type';
    if (pathPattern) {
      whereClause += ' AND f.path CONTAINS $pathPattern';
    }
    if (exportedOnly) {
      whereClause += ' AND d.exported = true';
    }

    const result = await db.query(`
      MATCH (d:Definition)-[:DEFINED_IN]->(f:File)
      WHERE ${whereClause}
      RETURN d.id AS defId, d.name AS name, d.type AS type,
             d.startLine AS startLine, d.endLine AS endLine,
             d.signature AS signature, d.exported AS exported,
             f.id AS fileId, f.path AS path, f.fanIn AS fanIn
      ORDER BY COALESCE(f.fanIn, 0) DESC, d.name ASC
      LIMIT $limit
    `, { type, pathPattern, limit });

    return result.records.map((r, idx) => ({
      defId: r.get('defId'),
      name: r.get('name'),
      type: r.get('type'),
      startLine: toNumber(r.get('startLine')),
      endLine: toNumber(r.get('endLine')),
      signature: r.get('signature'),
      exported: r.get('exported'),
      fileId: r.get('fileId'),
      path: r.get('path'),
      relevance: 1 - (idx / result.records.length) * 0.3
    }));
  };

  /**
   * Finds all exports from a file or matching a pattern.
   * @param {string} pattern - File path pattern or symbol pattern
   * @param {Object} options
   * @param {number} [options.limit=50]
   * @returns {Promise<StructuralSearchResult[]>}
   */
  const findExports = async (pattern, options = {}) => {
    const { limit = 50 } = options;

    const result = await db.query(`
      MATCH (d:Definition)-[:DEFINED_IN]->(f:File)
      WHERE d.exported = true
        AND (f.path CONTAINS $pattern OR d.name CONTAINS $pattern)
      RETURN d.id AS defId, d.name AS name, d.type AS type,
             d.startLine AS startLine, d.endLine AS endLine,
             d.signature AS signature, d.exported AS exported,
             f.id AS fileId, f.path AS path, f.fanIn AS fanIn
      ORDER BY COALESCE(f.fanIn, 0) DESC, d.name ASC
      LIMIT $limit
    `, { pattern, limit });

    return result.records.map((r, idx) => ({
      defId: r.get('defId'),
      name: r.get('name'),
      type: r.get('type'),
      startLine: toNumber(r.get('startLine')),
      endLine: toNumber(r.get('endLine')),
      signature: r.get('signature'),
      exported: r.get('exported'),
      fileId: r.get('fileId'),
      path: r.get('path'),
      relevance: 1 - (idx / result.records.length) * 0.3
    }));
  };

  /**
   * General structural search with multiple criteria.
   * @param {Object} criteria
   * @param {string} [criteria.name] - Symbol name pattern
   * @param {string} [criteria.type] - Definition type
   * @param {string} [criteria.path] - File path pattern
   * @param {boolean} [criteria.exported] - Filter by exported
   * @param {number} [criteria.minFanIn] - Minimum file fan-in
   * @param {number} [criteria.limit=30]
   * @returns {Promise<StructuralSearchResult[]>}
   */
  const search = async (criteria) => {
    const {
      name,
      type,
      path,
      exported,
      minFanIn,
      limit = 30
    } = criteria;

    const conditions = [];
    const params = { limit };

    if (name) {
      conditions.push('d.name CONTAINS $name');
      params.name = name;
    }
    if (type) {
      conditions.push('d.type = $type');
      params.type = type;
    }
    if (path) {
      conditions.push('f.path CONTAINS $path');
      params.path = path;
    }
    if (exported !== undefined) {
      conditions.push('d.exported = $exported');
      params.exported = exported;
    }
    if (minFanIn) {
      conditions.push('COALESCE(f.fanIn, 0) >= $minFanIn');
      params.minFanIn = minFanIn;
    }

    const whereClause = conditions.length > 0 
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    const result = await db.query(`
      MATCH (d:Definition)-[:DEFINED_IN]->(f:File)
      ${whereClause}
      RETURN d.id AS defId, d.name AS name, d.type AS type,
             d.startLine AS startLine, d.endLine AS endLine,
             d.signature AS signature, d.exported AS exported,
             f.id AS fileId, f.path AS path, f.fanIn AS fanIn
      ORDER BY COALESCE(f.fanIn, 0) DESC, d.exported DESC, d.name ASC
      LIMIT $limit
    `, params);

    return result.records.map((r, idx) => ({
      defId: r.get('defId'),
      name: r.get('name'),
      type: r.get('type'),
      startLine: toNumber(r.get('startLine')),
      endLine: toNumber(r.get('endLine')),
      signature: r.get('signature'),
      exported: r.get('exported'),
      fileId: r.get('fileId'),
      path: r.get('path'),
      fanIn: toNumber(r.get('fanIn')),
      relevance: 1 - (idx / result.records.length) * 0.3
    }));
  };

  /**
   * Finds callers of a definition (who calls this?).
   * Leverages graph relationships for accurate call tracking.
   * 
   * @param {string} defId - Definition ID
   * @param {Object} options
   * @param {number} [options.depth=1] - How many hops to traverse
   * @param {number} [options.limit=20]
   * @returns {Promise<Object[]>}
   */
  const findCallers = async (defId, options = {}) => {
    const { depth = 1, limit = 20 } = options;

    const result = await db.query(`
      MATCH (caller:Definition)-[:CALLS*1..${depth}]->(target:Definition {id: $defId})
      MATCH (caller)-[:DEFINED_IN]->(f:File)
      RETURN DISTINCT caller.id AS defId, caller.name AS name, 
             caller.type AS type, f.path AS path,
             caller.startLine AS startLine
      ORDER BY f.path, caller.name
      LIMIT $limit
    `, { defId, limit });

    return result.records.map(r => ({
      defId: r.get('defId'),
      name: r.get('name'),
      type: r.get('type'),
      path: r.get('path'),
      startLine: toNumber(r.get('startLine'))
    }));
  };

  /**
   * Finds callees of a definition (what does this call?).
   * 
   * @param {string} defId - Definition ID
   * @param {Object} options
   * @param {number} [options.depth=1] - How many hops to traverse
   * @param {number} [options.limit=20]
   * @returns {Promise<Object[]>}
   */
  const findCallees = async (defId, options = {}) => {
    const { depth = 1, limit = 20 } = options;

    const result = await db.query(`
      MATCH (source:Definition {id: $defId})-[:CALLS*1..${depth}]->(callee:Definition)
      MATCH (callee)-[:DEFINED_IN]->(f:File)
      RETURN DISTINCT callee.id AS defId, callee.name AS name,
             callee.type AS type, f.path AS path,
             callee.startLine AS startLine
      ORDER BY f.path, callee.name
      LIMIT $limit
    `, { defId, limit });

    return result.records.map(r => ({
      defId: r.get('defId'),
      name: r.get('name'),
      type: r.get('type'),
      path: r.get('path'),
      startLine: toNumber(r.get('startLine'))
    }));
  };

  /**
   * Finds the dependency path between two definitions.
   * 
   * @param {string} fromDefId - Source definition ID
   * @param {string} toDefId - Target definition ID
   * @param {number} [maxDepth=5] - Maximum path length
   * @returns {Promise<Object[]>} Path of definitions
   */
  const findPath = async (fromDefId, toDefId, maxDepth = 5) => {
    const result = await db.query(`
      MATCH path = shortestPath(
        (from:Definition {id: $fromDefId})-[:CALLS*1..${maxDepth}]->(to:Definition {id: $toDefId})
      )
      UNWIND nodes(path) AS node
      MATCH (node)-[:DEFINED_IN]->(f:File)
      RETURN node.id AS defId, node.name AS name, node.type AS type, f.path AS path
    `, { fromDefId, toDefId });

    return result.records.map(r => ({
      defId: r.get('defId'),
      name: r.get('name'),
      type: r.get('type'),
      path: r.get('path')
    }));
  };

  return { 
    findDefinitions, 
    findByType, 
    findExports, 
    search,
    findCallers,
    findCallees,
    findPath
  };
}

/**
 * Safely converts Neo4j integer to JS number.
 * @param {any} value 
 * @returns {number}
 */
function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value.toNumber === 'function') return value.toNumber();
  return parseInt(value, 10) || 0;
}
