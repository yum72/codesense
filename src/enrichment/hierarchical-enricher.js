import { EnrichmentSchema } from '../llm/schemas.js';

/**
 * Creates a hierarchical enricher for LLM-powered code analysis.
 * 
 * The enricher produces condensed, structured JSON output optimized for:
 * 1. Contextual embeddings (prepended to chunks before embedding)
 * 2. Search result enhancement (displayed to users)
 * 3. Plan generation context (fed to planning LLM)
 * 
 * @param {Object} db - Database adapter
 * @param {Object} llmClient - LLM client
 * @returns {Object} Hierarchical Enricher API
 */
export function createHierarchicalEnricher(db, llmClient) {
  /**
   * Gets dependencies for a file from the relationship graph.
   * @param {number} fileId 
   * @returns {Array<{fileId: number, name: string}>}
   */
  const getDependencies = (fileId) => {
    return db.prepare(`
      SELECT DISTINCT target_file_id as fileId, target_name as name
      FROM relationships
      WHERE source_file_id = ? 
        AND type IN ('import', 'call')
        AND target_file_id IS NOT NULL
    `).all(fileId);
  };

  /**
   * Builds context from already-enriched dependencies.
   * This enables hierarchical enrichment - dependencies inform parent analysis.
   * 
   * @param {Array} dependencies 
   * @returns {string}
   */
  const buildDependencyContext = (dependencies) => {
    if (dependencies.length === 0) return '';
    
    const summaries = [];
    for (const dep of dependencies.slice(0, 5)) { // Limit to 5 for token budget
      const enrichment = db.prepare(`
        SELECT e.summary FROM enrichment e
        JOIN chunks c ON c.id = e.chunk_id
        WHERE c.file_id = ? AND (c.name LIKE ?)
        LIMIT 1
      `).get(dep.fileId, `%${dep.name}%`);

      if (enrichment?.summary) {
        summaries.push(`- ${dep.name}: ${enrichment.summary}`);
      }
    }
    return summaries.join('\n');
  };

  /**
   * Enriches a chunk with LLM analysis.
   * 
   * The prompt is optimized for:
   * - Concise output (for embedding token budget)
   * - Structured JSON (for reliable parsing)
   * - Semantic richness (for search matching)
   * 
   * @param {string} chunkId 
   * @returns {Promise<Object>} Enrichment data
   */
  const enrichWithContext = async (chunkId) => {
    const chunk = db.prepare(`
      SELECT c.*, f.path, f.fan_in, f.fan_out 
      FROM chunks c 
      JOIN files f ON f.id = c.file_id 
      WHERE c.id = ?
    `).get(chunkId);

    if (!chunk) {
      throw new Error(`Chunk not found: ${chunkId}`);
    }

    const dependencies = getDependencies(chunk.file_id);
    const dependencyContext = buildDependencyContext(dependencies);
    
    // Condensed prompt optimized for embedding-friendly output
    const prompt = buildEnrichmentPrompt(chunk, dependencyContext);

    const enrichment = await llmClient.generateStructured(prompt, EnrichmentSchema);
    
    // Get file hash for cache invalidation
    const fileHash = db.prepare('SELECT hash FROM files WHERE id = ?').get(chunk.file_id)?.hash;
    
    return {
      ...enrichment,
      chunk_id: chunkId,
      file_id: chunk.file_id,
      hash: fileHash,
      prompt_version: 'v2.0-contextual'
    };
  };

  return { enrichWithContext, getDependencies, buildDependencyContext };
}

/**
 * Builds the enrichment prompt optimized for contextual embeddings.
 * 
 * Key design decisions:
 * - Summary MUST be exactly 1 sentence (for embedding brevity)
 * - Purpose MUST be exactly 1 sentence
 * - Arrays limited to 3-5 items each
 * - Focus on searchable terms and concepts
 * 
 * @param {Object} chunk 
 * @param {string} dependencyContext 
 * @returns {string}
 */
function buildEnrichmentPrompt(chunk, dependencyContext) {
  return `Analyze this code and provide CONCISE structured insights.

**IMPORTANT: This output will be used for search indexing. Be brief and use searchable terms.**

**File:** ${chunk.path}
**Type:** ${chunk.type}
**Name:** ${chunk.name}
${chunk.fan_in > 3 ? `**Note:** This is a high-impact file (imported by ${chunk.fan_in} other files)` : ''}

**Code:**
\`\`\`javascript
${truncateCode(chunk.code, 2000)}
\`\`\`

${dependencyContext ? `**Known Dependencies:**\n${dependencyContext}\n` : ''}

**Output Requirements:**
- summary: EXACTLY 1 sentence, max 100 chars. What does this code do?
- purpose: EXACTLY 1 sentence. Why does this code exist? (business/technical value)
- key_operations: 3-5 short phrases. Main actions performed.
- side_effects: List any: database writes, API calls, file I/O, emails, state mutations.
- state_changes: What data/state does this modify?
- implicit_dependencies: Env vars, global state, external services required.
- design_patterns: Factory, Singleton, Observer, Repository, etc. (only if clearly present)
- architectural_patterns: MVC, Service Layer, etc. (only if clearly present)
- anti_patterns: God class, tight coupling, etc. (only if clearly present)
- complexity: low/medium/high based on cyclomatic complexity and cognitive load.
- security_concerns: SQL injection, XSS, auth issues, etc. (only real concerns)
- performance_concerns: N+1 queries, memory leaks, etc. (only real concerns)
- business_rules: Domain logic encoded (e.g., "Orders over $100 get free shipping")
- tags: 5-10 searchable keywords (e.g., "authentication", "stripe", "webhook", "validation")

Focus on insights that help developers find this code via natural language search.`;
}

/**
 * Truncates code to fit within token budget.
 * @param {string} code 
 * @param {number} maxChars 
 * @returns {string}
 */
function truncateCode(code, maxChars) {
  if (code.length <= maxChars) return code;
  return code.slice(0, maxChars) + '\n// ... truncated for analysis';
}
