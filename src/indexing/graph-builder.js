/**
 * Creates a graph builder for managing code relationships.
 * 
 * Uses the Memgraph adapter's edge creation methods.
 * All operations are async to support the graph database.
 * 
 * Important: In Memgraph, file paths are the unique identifiers (not numeric IDs).
 * CALLS edges connect Chunk nodes, IMPORTS edges connect File nodes.
 * 
 * @param {Object} db - Database adapter (Memgraph)
 * @param {Object} resolver - Module resolver
 * @returns {Object} Graph Builder API
 */
export function createGraphBuilder(db, resolver) {
  /**
   * Builds relationships for a file.
   * 
   * Creates IMPORTS edges between Files and CALLS edges between Chunks.
   * Returns the number of edges created.
   * 
   * @param {string} filePath - Path of the source file (used as ID in Memgraph)
   * @param {string} _filePath - Duplicate param for backward compat (ignored)
   * @param {Object} parsedData - Data from AST parser { definitions, imports, calls }
   * @param {Object} maps - Index maps from IndexBuilder
   * @returns {Promise<number>} Number of edges created
   */
  const buildRelationships = async (filePath, _filePath, parsedData, maps) => {
    const { imports, calls, definitions } = parsedData;
    let edgesCreated = 0;

    // Clear existing edges from this file
    await db.deleteEdgesFromFile(filePath);

    // 1. Process Imports - create IMPORTS edges between files
    for (const imp of imports) {
      const resolvedPath = resolver.resolve(filePath, imp.source);
      const isExternal = !resolvedPath;

      // Only create edge if we have a valid target (internal import)
      if (resolvedPath) {
        // Memgraph adapter signature: addFileImport(sourceFilePath, targetFilePath, line, isExternal)
        await db.addFileImport(filePath, resolvedPath, imp.line, isExternal);
        edgesCreated++;
      }
    }

    // 2. Process Calls - create CALLS edges between Chunks
    // We need to find which chunk contains the call and which chunk is being called
    
    // Build a line-to-chunk map to find the containing chunk for each call
    const findContainingChunk = (line) => {
      // Look up chunks in this file from the chunkIndex
      const allChunks = [];
      for (const [name, locations] of maps.chunkIndex || new Map()) {
        for (const loc of locations) {
          if (loc.filePath === filePath) {
            allChunks.push(loc);
          }
        }
      }
      
      // Find the innermost (smallest) chunk that contains this line
      // This ensures we attribute calls to the right function, not outer scopes
      let bestChunk = null;
      let smallestSpan = Infinity;
      
      for (const chunk of allChunks) {
        if (chunk.startLine <= line && chunk.endLine >= line) {
          const span = chunk.endLine - chunk.startLine;
          if (span < smallestSpan) {
            smallestSpan = span;
            bestChunk = chunk;
          }
        }
      }
      return bestChunk?.chunkId || null;
    };

    for (const call of calls || []) {
      // Find the source chunk (containing the call site)
      const sourceChunkId = findContainingChunk(call.line);
      if (!sourceChunkId) continue; // Skip if we can't find the source chunk

      // Find target chunks with matching name
      const targetLocations = maps.chunkIndex?.get(call.name) || [];
      
      // Link to chunks that are in different files or exported
      for (const loc of targetLocations) {
        // Skip self-references within the same chunk
        if (loc.chunkId === sourceChunkId) continue;
        
        // For same-file calls, allow any match
        // For cross-file calls, we'd ideally check exports but for now link all matches
        // Memgraph adapter signature: addCallEdge(sourceChunkId, targetChunkId, line)
        await db.addCallEdge(sourceChunkId, loc.chunkId, call.line);
        edgesCreated++;
      }
    }

    return edgesCreated;
  };

  /**
   * Updates fan-in and fan-out metrics for all files.
   * Delegates to the database adapter which uses Cypher aggregation.
   * @returns {Promise<void>}
   */
  const updateMetrics = async () => {
    await db.updateFileMetrics();
  };

  return { buildRelationships, updateMetrics };
}
