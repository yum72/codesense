/**
 * @typedef {Object} ChunkOutput
 * @property {string} id - Unique chunk identifier
 * @property {string} name - Symbol name
 * @property {string} type - function, class, method, module
 * @property {string} code - Raw source code
 * @property {string} [jsdoc] - JSDoc comment if present
 * @property {string} [signature] - Function/class signature
 * @property {number} startLine
 * @property {number} endLine
 * @property {number} tokenCount - Estimated token count
 */

/**
 * Creates a chunker for breaking down code into embedding units.
 * 
 * Chunks include:
 * - The raw code
 * - Extracted JSDoc comments (for contextual embeddings)
 * - Function/class signatures
 * 
 * @returns {Object} Chunker API
 */
export function createChunker() {
  /**
   * Extracts JSDoc comment that precedes a definition.
   * Looks backwards from the definition start line to find /** ... *​/
   * 
   * @param {string[]} lines - All lines of the file
   * @param {number} defStartLine - 1-based line number where definition starts
   * @returns {string|null} JSDoc comment or null
   */
  const extractJSDoc = (lines, defStartLine) => {
    // Look at lines before the definition (up to 30 lines back)
    const searchStart = Math.max(0, defStartLine - 31);
    const searchEnd = defStartLine - 1; // Convert to 0-based and go one before
    
    let jsdocEnd = -1;
    let jsdocStart = -1;

    // Find the end of JSDoc (*/)
    for (let i = searchEnd - 1; i >= searchStart; i--) {
      const line = lines[i];
      const trimmed = line.trim();
      
      // Skip empty lines and decorators
      if (trimmed === '' || trimmed.startsWith('@') && !trimmed.startsWith('@param')) {
        continue;
      }
      
      // Found end of JSDoc
      if (trimmed.endsWith('*/')) {
        jsdocEnd = i;
        break;
      }
      
      // Hit non-JSDoc code, stop searching
      if (!trimmed.startsWith('*') && !trimmed.startsWith('/*')) {
        break;
      }
    }

    if (jsdocEnd === -1) return null;

    // Find the start of JSDoc (/**)
    for (let i = jsdocEnd; i >= searchStart; i--) {
      const line = lines[i];
      if (line.trim().startsWith('/**')) {
        jsdocStart = i;
        break;
      }
    }

    if (jsdocStart === -1) return null;

    // Extract the JSDoc block
    return lines.slice(jsdocStart, jsdocEnd + 1).join('\n');
  };

  /**
   * Extracts function/class signature from definition.
   * 
   * @param {string[]} lines - All lines of the file
   * @param {Object} def - Definition from AST parser
   * @returns {string|null} Signature or null
   */
  const extractSignature = (lines, def) => {
    // For functions, get the first line (or until opening brace)
    if (def.type === 'function' || def.type === 'method') {
      const startIdx = def.startLine - 1;
      let signature = '';
      
      for (let i = startIdx; i < Math.min(startIdx + 5, lines.length); i++) {
        signature += lines[i];
        if (lines[i].includes('{') || lines[i].includes('=>')) {
          break;
        }
        signature += ' ';
      }
      
      // Clean up - remove body, trim
      return signature
        .replace(/\{[\s\S]*$/, '')
        .replace(/=>\s*$/, '=>')
        .replace(/\s+/g, ' ')
        .trim();
    }
    
    // For classes, get the class declaration line
    if (def.type === 'class') {
      const line = lines[def.startLine - 1];
      return line
        .replace(/\{[\s\S]*$/, '')
        .trim();
    }
    
    return null;
  };

  /**
   * Chunks parsed code into meaningful units.
   * 
   * Each chunk includes:
   * - Raw source code
   * - JSDoc comment (if present)
   * - Function/class signature
   * 
   * @param {string} filePath 
   * @param {string} content 
   * @param {Object} parsedData - Data from AST parser
   * @returns {ChunkOutput[]} Array of chunks
   */
  const chunk = (filePath, content, parsedData) => {
    const lines = content.split('\n');
    const chunks = [];

    // 1. Chunk by definitions (functions, classes)
    for (const def of parsedData.definitions) {
      const chunkCode = lines.slice(def.startLine - 1, def.endLine).join('\n');
      
      // Extract JSDoc and signature for contextual embedding
      const jsdoc = extractJSDoc(lines, def.startLine);
      const signature = extractSignature(lines, def);
      
      chunks.push({
        id: `${filePath}:${def.name}:${def.startLine}`,
        name: def.name,
        type: def.type,
        code: chunkCode,
        jsdoc,
        signature,
        startLine: def.startLine,
        endLine: def.endLine,
        tokenCount: estimateTokens(chunkCode, jsdoc)
      });
    }

    // 2. If no definitions or small file, chunk the whole file
    if (chunks.length === 0 && content.trim().length > 0) {
      // Try to extract file-level JSDoc (usually at top of file)
      const fileJsdoc = extractFileJSDoc(lines);
      
      chunks.push({
        id: `${filePath}:module`,
        name: 'module',
        type: 'module',
        code: content,
        jsdoc: fileJsdoc,
        signature: null,
        startLine: 1,
        endLine: lines.length,
        tokenCount: estimateTokens(content, fileJsdoc)
      });
    }

    return chunks;
  };

  /**
   * Extracts file-level JSDoc comment (usually @fileoverview or @module).
   * 
   * @param {string[]} lines 
   * @returns {string|null}
   */
  const extractFileJSDoc = (lines) => {
    // Look for JSDoc at the start of the file (first 20 lines)
    for (let i = 0; i < Math.min(20, lines.length); i++) {
      const line = lines[i].trim();
      
      // Skip shebang, 'use strict', empty lines
      if (line.startsWith('#!') || line === "'use strict';" || 
          line === '"use strict";' || line === '') {
        continue;
      }
      
      // Found JSDoc start
      if (line.startsWith('/**')) {
        // Find the end
        for (let j = i; j < Math.min(i + 30, lines.length); j++) {
          if (lines[j].trim().endsWith('*/')) {
            return lines.slice(i, j + 1).join('\n');
          }
        }
      }
      
      // Hit non-JSDoc content, stop
      if (!line.startsWith('*') && !line.startsWith('/*')) {
        break;
      }
    }
    
    return null;
  };

  /**
   * Estimates token count for a chunk.
   * Uses ~4 chars per token as rough estimate.
   * 
   * @param {string} code 
   * @param {string} [jsdoc]
   * @returns {number}
   */
  const estimateTokens = (code, jsdoc) => {
    const codeTokens = Math.ceil(code.length / 4);
    const jsdocTokens = jsdoc ? Math.ceil(jsdoc.length / 4) : 0;
    return codeTokens + jsdocTokens;
  };

  return { chunk, extractJSDoc, extractSignature };
}
