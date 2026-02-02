/**
 * Creates an index builder that maintains in-memory maps for fast lookups.
 * 
 * Updated for async Memgraph adapter - all database queries are async.
 * Uses file paths as unique identifiers (not numeric IDs).
 * 
 * @param {Object} db - Database adapter (Memgraph)
 * @returns {Object} Index Builder API
 */
export function createIndexBuilder(db) {
  /**
   * Builds in-memory maps from the database.
   * 
   * Creates lookup structures for:
   * - filePathToId: Map file paths to their identifiers (path is the ID in Memgraph)
   * - fileIdToPath: Reverse mapping (identity in Memgraph since path IS the ID)
   * - fileExports: Map file paths to their exported definitions
   * - symbolIndex: Map symbol names to all locations where they're defined
   * - defKeyToId: Map "filePath:name:startLine" to definition ID
   * - chunkIndex: Map chunk names to chunk IDs for call graph building
   * 
   * @returns {Promise<Object>} Index maps
   */
  const buildMaps = async () => {
    const filePathToId = new Map();
    const fileIdToPath = new Map();
    const fileExports = new Map(); // filePath -> Export[]
    const symbolIndex = new Map(); // name -> SymbolLocation[]
    const defKeyToId = new Map(); // "filePath:name:startLine" -> defId
    const chunkIndex = new Map(); // name -> ChunkLocation[]

    // Load files using Cypher query
    // In Memgraph, path IS the unique identifier
    const filesResult = await db.query(`
      MATCH (f:File)
      RETURN f.path AS path
    `);
    
    // db.query() returns an array of objects (not Neo4j ResultSummary)
    for (const record of filesResult) {
      const path = record.path;
      // In Memgraph, the path is both the ID and the path
      filePathToId.set(path, path);
      fileIdToPath.set(path, path);
    }

    // Load definitions using Cypher query
    // Schema: (:File)-[:CONTAINS]->(:Definition)
    const defsResult = await db.query(`
      MATCH (f:File)-[:CONTAINS]->(d:Definition)
      RETURN d.id AS id, f.path AS filePath, d.name AS name, 
             d.type AS type, d.exported AS exported, d.start_line AS startLine
    `);
    
    for (const record of defsResult) {
      const id = record.id;
      const filePath = record.filePath;
      const name = record.name;
      const type = record.type;
      const exported = record.exported;
      const startLine = record.startLine;

      // Symbol index - map name to all locations
      if (!symbolIndex.has(name)) {
        symbolIndex.set(name, []);
      }
      symbolIndex.get(name).push({
        filePath,
        defId: id,
        isExported: !!exported
      });

      // Definition key to ID mapping for call resolution
      const defKey = `${filePath}:${name}:${startLine}`;
      defKeyToId.set(defKey, id);

      // File exports - track exported definitions per file
      if (exported) {
        if (!fileExports.has(filePath)) {
          fileExports.set(filePath, []);
        }
        fileExports.get(filePath).push({
          name,
          defId: id,
          type
        });
      }
    }

    // Load chunks for call graph building
    // CALLS edges connect Chunks, so we need to map names to chunk IDs
    const chunksResult = await db.query(`
      MATCH (f:File)-[:CONTAINS]->(c:Chunk)
      RETURN c.id AS id, f.path AS filePath, c.name AS name, 
             c.type AS type, c.start_line AS startLine, c.end_line AS endLine
    `);

    for (const record of chunksResult) {
      const id = record.id;
      const filePath = record.filePath;
      const name = record.name;
      const startLine = record.startLine;
      const endLine = record.endLine;

      // Chunk index - map name to all chunk locations
      if (!chunkIndex.has(name)) {
        chunkIndex.set(name, []);
      }
      chunkIndex.get(name).push({
        chunkId: id,
        filePath,
        startLine,
        endLine
      });
    }

    return { 
      filePathToId, 
      fileIdToPath, 
      fileExports, 
      symbolIndex, 
      defKeyToId,
      chunkIndex  // New: for building CALLS edges between chunks
    };
  };

  return { buildMaps };
}
