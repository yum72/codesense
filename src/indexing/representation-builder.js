/**
 * Representation Builder for Contextual Embeddings
 * 
 * Builds rich text representations of code chunks for embedding.
 * Based on Anthropic's "Contextual Retrieval" approach - prepending
 * context to chunks before embedding significantly improves retrieval.
 * 
 * Context Tier System:
 * - structural: File path, signature, JSDoc, code (no LLM enrichment)
 * - partial: Structural + partial enrichment from neighbor research
 * - full: Structural + complete LLM enrichment from Research Agent
 * 
 * The representation includes:
 * 1. Location context (file path, symbol name, type)
 * 2. JSDoc/signature (if available)
 * 3. LLM enrichment (if available) - condensed summary, purpose, operations
 * 4. Raw code
 * 
 * Token budget: ~300-500 tokens max for context, rest is code
 */

/**
 * @typedef {Object} ChunkData
 * @property {string} id - Chunk identifier
 * @property {string} name - Symbol name
 * @property {string} type - function, class, method, module
 * @property {string} code - Raw source code
 * @property {string} [jsdoc] - JSDoc comment if present
 * @property {string} [signature] - Function/class signature
 * @property {number} startLine
 * @property {number} endLine
 */

/**
 * @typedef {Object} FileData
 * @property {string} path - File path
 * @property {number} [fanIn] - Number of files importing this
 * @property {number} [fanOut] - Number of files this imports
 */

/**
 * @typedef {Object} EnrichmentData
 * @property {string} [summary] - One sentence summary
 * @property {string} [purpose] - Business/technical purpose
 * @property {string[]} [keyOperations] - Main operations performed
 * @property {string[]} [sideEffects] - Database writes, API calls, etc.
 * @property {string[]} [dependencies] - Key dependencies
 * @property {string[]} [patterns] - Design patterns detected
 * @property {string} [complexity] - low, medium, high
 * @property {string[]} [tags] - Searchable keywords
 * @property {string} [flowContext] - Position in data/control flow
 */

/**
 * @typedef {Object} PartialEnrichment
 * @property {string} learned - What was learned about this chunk
 * @property {string} relationship - caller, callee, sibling
 * @property {number} confidence - 0-1 confidence score
 * @property {string} sourceChunkId - Which chunk's research discovered this
 */

/**
 * Maximum tokens for the context portion (before code).
 * Leaves room for code in the embedding model's context.
 */
const MAX_CONTEXT_CHARS = 1500; // ~375 tokens

/**
 * Maximum tokens for code portion.
 * MiniLM has 512 token limit, but we truncate to be safe.
 */
const MAX_CODE_CHARS = 2000; // ~500 tokens

/**
 * Builds a rich text representation of a chunk for embedding.
 * 
 * This follows Anthropic's "Contextual Retrieval" pattern:
 * - Prepend contextual information before the chunk content
 * - Include natural language descriptions for better semantic matching
 * - Keep it concise to fit within embedding model limits
 * 
 * @param {ChunkData} chunk - The code chunk
 * @param {FileData} file - File metadata
 * @param {EnrichmentData} [enrichment] - LLM enrichment (optional)
 * @returns {string} Text representation for embedding
 */
export function buildEmbeddingRepresentation(chunk, file, enrichment = null) {
  const parts = [];

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Location Context (always available)
  // ─────────────────────────────────────────────────────────────────────────
  const locationParts = [`File: ${file.path}`];
  
  if (chunk.type !== 'module') {
    locationParts.push(`${capitalize(chunk.type)}: ${chunk.name}`);
  }
  
  if (file.fanIn > 5) {
    locationParts.push(`(imported by ${file.fanIn} files)`);
  }
  
  parts.push(locationParts.join(' | '));

  // ─────────────────────────────────────────────────────────────────────────
  // 2. JSDoc / Signature (if available)
  // ─────────────────────────────────────────────────────────────────────────
  if (chunk.jsdoc) {
    // Clean up JSDoc - remove excessive whitespace, keep content
    const cleanedJsdoc = cleanJSDoc(chunk.jsdoc);
    if (cleanedJsdoc) {
      parts.push(cleanedJsdoc);
    }
  } else if (chunk.signature) {
    // Fall back to signature if no JSDoc
    parts.push(`Signature: ${chunk.signature}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. LLM Enrichment (if available)
  // ─────────────────────────────────────────────────────────────────────────
  if (enrichment) {
    const enrichmentText = buildEnrichmentText(enrichment);
    if (enrichmentText) {
      parts.push(enrichmentText);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Raw Code (truncated if needed)
  // ─────────────────────────────────────────────────────────────────────────
  const contextLength = parts.join('\n\n').length;
  const remainingBudget = MAX_CONTEXT_CHARS + MAX_CODE_CHARS - contextLength;
  
  let code = chunk.code;
  if (code.length > remainingBudget) {
    code = code.slice(0, remainingBudget - 20) + '\n// ... truncated';
  }
  
  parts.push(code);

  return parts.join('\n\n');
}

/**
 * Builds a condensed natural language description from enrichment data.
 * Target: 1-2 short paragraphs max.
 * 
 * @param {EnrichmentData} enrichment 
 * @returns {string}
 */
function buildEnrichmentText(enrichment) {
  const sentences = [];

  // Summary + Purpose (most important)
  if (enrichment.summary) {
    sentences.push(enrichment.summary);
  }
  if (enrichment.purpose && enrichment.purpose !== enrichment.summary) {
    sentences.push(enrichment.purpose);
  }

  // Flow context (position in architecture)
  if (enrichment.flowContext) {
    sentences.push(`Flow: ${enrichment.flowContext}`);
  }

  // Key operations as a sentence
  if (enrichment.keyOperations?.length > 0) {
    const ops = enrichment.keyOperations.slice(0, 5); // Max 5
    sentences.push(`Operations: ${ops.join(', ')}.`);
  }

  // Side effects (critical for search)
  if (enrichment.sideEffects?.length > 0) {
    const effects = enrichment.sideEffects.slice(0, 4); // Max 4
    sentences.push(`Side effects: ${effects.join(', ')}.`);
  }

  // Patterns (useful for architectural queries)
  if (enrichment.patterns?.length > 0) {
    sentences.push(`Patterns: ${enrichment.patterns.join(', ')}.`);
  }

  // Tags (critical for keyword matching)
  if (enrichment.tags?.length > 0) {
    sentences.push(`Tags: ${enrichment.tags.slice(0, 10).join(', ')}.`);
  }

  // Complexity indicator
  if (enrichment.complexity === 'high') {
    sentences.push('High complexity.');
  }

  return sentences.join(' ');
}

/**
 * Cleans up a JSDoc comment for embedding.
 * - Removes comment delimiters
 * - Removes excessive whitespace
 * - Keeps @param, @returns, @description content
 * 
 * @param {string} jsdoc 
 * @returns {string}
 */
function cleanJSDoc(jsdoc) {
  if (!jsdoc) return '';

  return jsdoc
    // Remove opening /** and closing */
    .replace(/^\/\*\*\s*/m, '')
    .replace(/\s*\*\/$/m, '')
    // Remove leading * from each line
    .replace(/^\s*\*\s?/gm, '')
    // Collapse multiple newlines
    .replace(/\n{3,}/g, '\n\n')
    // Trim
    .trim();
}

/**
 * Capitalizes the first letter of a string.
 * @param {string} str 
 * @returns {string}
 */
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Builds a base representation without enrichment.
 * Used for initial embedding during Tier 2 (before enrichment is available).
 * This is the "structural" tier representation.
 * 
 * @param {ChunkData} chunk 
 * @param {FileData} file 
 * @returns {string}
 */
export function buildBaseRepresentation(chunk, file) {
  return buildEmbeddingRepresentation(chunk, file, null);
}

/**
 * Builds an enriched representation with full LLM enrichment.
 * Used for re-embedding after Research Agent enrichment completes.
 * This is the "full" tier representation.
 * 
 * @param {ChunkData} chunk 
 * @param {EnrichmentData} enrichment 
 * @returns {string}
 */
export function buildEnrichedRepresentation(chunk, enrichment) {
  // Build file data from chunk if needed
  const file = {
    path: chunk.filePath || chunk.path || '',
    fanIn: chunk.fanIn || 0,
    fanOut: chunk.fanOut || 0
  };
  return buildEmbeddingRepresentation(chunk, file, enrichment);
}

/**
 * Builds a partial enrichment representation.
 * Used for chunks that have been researched by neighbors but not fully enriched.
 * This is the "partial" tier representation.
 * 
 * @param {ChunkData} chunk 
 * @param {FileData} file 
 * @param {PartialEnrichment[]} partialEnrichments - Partial knowledge from neighbor research
 * @returns {string}
 */
export function buildPartialRepresentation(chunk, file, partialEnrichments) {
  const parts = [];

  // Location context
  const locationParts = [`File: ${file.path}`];
  if (chunk.type !== 'module') {
    locationParts.push(`${capitalize(chunk.type)}: ${chunk.name}`);
  }
  if (file.fanIn > 5) {
    locationParts.push(`(imported by ${file.fanIn} files)`);
  }
  parts.push(locationParts.join(' | '));

  // JSDoc/Signature
  if (chunk.jsdoc) {
    const cleanedJsdoc = cleanJSDoc(chunk.jsdoc);
    if (cleanedJsdoc) parts.push(cleanedJsdoc);
  } else if (chunk.signature) {
    parts.push(`Signature: ${chunk.signature}`);
  }

  // Partial enrichment from neighbor research
  if (partialEnrichments && partialEnrichments.length > 0) {
    const learned = partialEnrichments
      .filter(p => p.confidence >= 0.5)
      .slice(0, 3)
      .map(p => `[${p.relationship}] ${p.learned}`)
      .join(' ');
    
    if (learned) {
      parts.push(`Context: ${learned}`);
    }
  }

  // Code
  const contextLength = parts.join('\n\n').length;
  const remainingBudget = MAX_CONTEXT_CHARS + MAX_CODE_CHARS - contextLength;
  
  let code = chunk.code;
  if (code.length > remainingBudget) {
    code = code.slice(0, remainingBudget - 20) + '\n// ... truncated';
  }
  parts.push(code);

  return parts.join('\n\n');
}

/**
 * Builds a representation appropriate for the chunk's context tier.
 * Automatically selects the right builder based on available data.
 * 
 * @param {ChunkData} chunk 
 * @param {FileData} file 
 * @param {Object} options
 * @param {EnrichmentData} [options.enrichment] - Full enrichment if available
 * @param {PartialEnrichment[]} [options.partialEnrichments] - Partial enrichments
 * @param {string} [options.contextTier] - Override tier selection
 * @returns {{representation: string, tier: string}}
 */
export function buildTierAwareRepresentation(chunk, file, options = {}) {
  const { enrichment, partialEnrichments, contextTier } = options;

  // Determine tier
  let tier = contextTier;
  if (!tier) {
    if (enrichment?.summary) {
      tier = 'full';
    } else if (partialEnrichments?.length > 0) {
      tier = 'partial';
    } else {
      tier = 'structural';
    }
  }

  // Build appropriate representation
  let representation;
  switch (tier) {
    case 'full':
      representation = buildEmbeddingRepresentation(chunk, file, enrichment);
      break;
    case 'partial':
      representation = buildPartialRepresentation(chunk, file, partialEnrichments);
      break;
    default:
      representation = buildEmbeddingRepresentation(chunk, file, null);
      tier = 'structural';
  }

  return { representation, tier };
}

/**
 * Parses enrichment data into EnrichmentData format.
 * Handles both:
 * - Live enrichment objects (arrays are already arrays)
 * - Database records (arrays are JSON strings)
 * 
 * @param {Object} enrichment - Enrichment data from LLM or database
 * @returns {EnrichmentData}
 */
export function parseEnrichmentForEmbedding(enrichment) {
  if (!enrichment) return null;

  return {
    summary: enrichment.summary || null,
    purpose: enrichment.purpose || null,
    keyOperations: ensureArray(enrichment.key_operations || enrichment.keyOperations) || [],
    sideEffects: ensureArray(enrichment.side_effects || enrichment.sideEffects) || [],
    dependencies: ensureArray(enrichment.implicit_dependencies || enrichment.dependencies) || [],
    patterns: [
      ...(ensureArray(enrichment.design_patterns || enrichment.designPatterns) || []),
      ...(ensureArray(enrichment.architectural_patterns || enrichment.architecturalPatterns) || [])
    ],
    complexity: enrichment.complexity || null,
    tags: ensureArray(enrichment.tags) || [],
    flowContext: enrichment.flow_context || enrichment.flowContext || null
  };
}

/**
 * Parses partial enrichments from database JSON.
 * 
 * @param {string|Object[]} partialEnrichments - JSON string or array
 * @returns {PartialEnrichment[]}
 */
export function parsePartialEnrichments(partialEnrichments) {
  if (!partialEnrichments) return [];
  
  const arr = ensureArray(partialEnrichments);
  if (!arr) return [];

  return arr.map(p => ({
    learned: p.learned || '',
    relationship: p.relationship || 'unknown',
    confidence: p.confidence || 0,
    sourceChunkId: p.sourceChunkId || p.source_chunk_id || null
  }));
}

/**
 * Ensures a value is an array.
 * Handles JSON strings, arrays, null, and undefined.
 * @param {any} value 
 * @returns {string[]|null}
 */
function ensureArray(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}
