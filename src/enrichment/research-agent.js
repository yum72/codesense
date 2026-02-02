import { z } from 'zod';
import { EnrichmentSchema } from '../llm/schemas.js';

/**
 * Research Agent output schema.
 * Includes full enrichment for target plus partial enrichments captured during research.
 */
export const ResearchOutputSchema = z.object({
  targetChunkId: z.string(),
  enrichment: EnrichmentSchema,
  researchCaptured: z.array(z.object({
    chunkId: z.string(),
    learned: z.string().max(200),
    relationship: z.enum(['caller', 'callee', 'sibling', 'similar', 'grep_match']),
    confidence: z.number().min(0).max(1)
  })).max(20),
  researchSources: z.array(z.string()).max(30),
  toolCallCount: z.number(),
  stopReason: z.string()
});

/**
 * Creates a Research Agent for context-aware code enrichment.
 * 
 * The agent uses an agentic loop to explore related code before enriching,
 * capturing partial knowledge about neighbors along the way.
 * 
 * @param {Object} deps - Dependencies
 * @param {Object} deps.db - Memgraph database adapter
 * @param {Object} deps.llmClient - LLM client for chat/structured generation
 * @param {Object} deps.grepSearch - Grep search API (optional)
 * @param {Object} deps.config - Research agent configuration
 * @returns {Object} Research Agent API
 */
export function createResearchAgent({ db, llmClient, grepSearch = null, config }) {
  const maxToolCalls = config?.researchAgent?.maxToolCalls ?? 12;
  const maxHops = config?.researchAgent?.maxHops ?? 2;
  const maxFilesPerHop = config?.researchAgent?.maxFilesPerHop ?? 5;
  const maxGrepResults = config?.researchAgent?.maxGrepResults ?? 50;
  const temperature = config?.researchAgent?.temperature ?? 0.1;

  /**
   * Tools available to the research agent (read-only).
   */
  const tools = {
    /**
     * Read full chunk data.
     */
    read_chunk: async (chunkId) => {
      const chunk = await db.getChunk(chunkId);
      if (!chunk) return { error: `Chunk not found: ${chunkId}` };
      
      const enrichment = await db.getEnrichment(chunkId);
      return {
        id: chunk.id,
        name: chunk.name,
        type: chunk.type,
        code: truncateCode(chunk.code, 1500),
        signature: chunk.signature,
        jsdoc: chunk.jsdoc,
        existingEnrichment: enrichment?.summary || null
      };
    },

    /**
     * Get chunks that call this chunk.
     */
    get_callers: async (chunkId, depth = 1) => {
      const callers = await db.getCallers(chunkId, Math.min(depth, maxHops));
      return callers.slice(0, maxFilesPerHop).map(c => ({
        id: c.id,
        name: c.name,
        filePath: c.filePath,
        summary: c.summary || null,
        relationship: 'caller'
      }));
    },

    /**
     * Get chunks that this chunk calls.
     */
    get_callees: async (chunkId, depth = 1) => {
      const callees = await db.getCallees(chunkId, Math.min(depth, maxHops));
      return callees.slice(0, maxFilesPerHop).map(c => ({
        id: c.id,
        name: c.name,
        filePath: c.filePath,
        summary: c.summary || null,
        relationship: 'callee'
      }));
    },

    /**
     * Get other chunks in the same file.
     */
    get_file_siblings: async (chunkId) => {
      const siblings = await db.getFileSiblings(chunkId);
      return siblings.slice(0, maxFilesPerHop).map(c => ({
        id: c.id,
        name: c.name,
        type: c.type,
        summary: c.summary || null,
        relationship: 'sibling'
      }));
    },

    /**
     * Search for semantically similar code.
     */
    search_similar: async (query, limit = 5) => {
      const results = await db.semanticSearch(query, Math.min(limit, maxFilesPerHop));
      return results.map(r => ({
        id: r.id,
        name: r.name,
        filePath: r.filePath,
        score: r.score,
        relationship: 'similar'
      }));
    },

    /**
     * Search for literal patterns in the codebase using grep.
     * Useful for finding:
     * - String-based invocations (e.g., activity names in Temporal)
     * - Event names, route definitions
     * - Config references, magic strings
     * - Dynamic imports or requires
     */
    search_grep: async (pattern, limit = 50) => {
      if (!grepSearch) {
        return { error: 'Grep search not available' };
      }
      
      const results = await grepSearch.search(pattern, { 
        limit: Math.min(limit, maxGrepResults),
        caseSensitive: false
      });
      
      return results.slice(0, Math.min(limit, maxGrepResults)).map(r => ({
        path: r.path,
        line: r.line,
        text: r.text,
        relationship: 'grep_match'
      }));
    }
  };

  /**
   * Executes a single tool call.
   * @param {string} toolName 
   * @param {Object} args 
   * @returns {Promise<Object>}
   */
  const executeTool = async (toolName, args) => {
    if (!tools[toolName]) {
      return { error: `Unknown tool: ${toolName}` };
    }
    try {
      return await tools[toolName](...Object.values(args));
    } catch (e) {
      return { error: e.message };
    }
  };

  /**
   * Builds the research agent system prompt.
   * @param {Object} chunk - Target chunk to enrich
   * @returns {string}
   */
  const buildSystemPrompt = (chunk) => {
    const grepAvailable = grepSearch !== null;
    
    return `You are a Research Agent analyzing code to understand its purpose and context.

TARGET CHUNK:
- ID: ${chunk.id}
- Name: ${chunk.name}
- Type: ${chunk.type}
- File: ${chunk.filePath}

${chunk.code ? `CODE:\n\`\`\`\n${truncateCode(chunk.code, 2000)}\n\`\`\`` : ''}

YOUR TASK:
Research this code to understand:
1. What it does and why it exists
2. How it fits into the larger system
3. Its relationships with other code

AVAILABLE TOOLS:
- read_chunk(chunk_id): Get full code and metadata of a chunk
- get_callers(chunk_id, depth): Get chunks that call this (depth 1-2)
- get_callees(chunk_id, depth): Get chunks this calls (depth 1-2)
- get_file_siblings(chunk_id): Get other chunks in same file
- search_similar(query, limit): Find semantically similar code (conceptual search)
${grepAvailable ? `- search_grep(pattern, limit): Search for literal patterns in codebase (default limit 50)` : ''}

WHEN TO USE EACH SEARCH:
- search_similar: For conceptual queries like "authentication logic" or "error handling"
- search_grep: For literal patterns like:
  * String-based invocations: search_grep("activityName") for Temporal/workflow patterns
  * Event names: search_grep("user.created") for event-driven code
  * Magic strings: search_grep("FEATURE_FLAG") for config references
  * Dynamic references: search_grep("${chunk.name}") to find all usages of this function

CONSTRAINTS:
- Max ${maxToolCalls} tool calls
- Max ${maxHops} hops from target
- Stop when you have sufficient understanding

IMPORTANT: As you research, note what you learn about OTHER chunks too.
We will capture that knowledge for partial enrichment.

When ready, respond with DONE and provide your analysis.`;
  };

  /**
   * Parses tool calls from LLM response.
   * @param {string} text - LLM response text
   * @returns {Array<{name: string, args: Object}>}
   */
  const parseToolCalls = (text) => {
    const calls = [];
    // Match patterns like: read_chunk("chunkId") or get_callers("chunkId", 2)
    const patterns = [
      /read_chunk\s*\(\s*["']([^"']+)["']\s*\)/g,
      /get_callers\s*\(\s*["']([^"']+)["']\s*(?:,\s*(\d+))?\s*\)/g,
      /get_callees\s*\(\s*["']([^"']+)["']\s*(?:,\s*(\d+))?\s*\)/g,
      /get_file_siblings\s*\(\s*["']([^"']+)["']\s*\)/g,
      /search_similar\s*\(\s*["']([^"']+)["']\s*(?:,\s*(\d+))?\s*\)/g,
      /search_grep\s*\(\s*["']([^"']+)["']\s*(?:,\s*(\d+))?\s*\)/g
    ];

    const toolNames = ['read_chunk', 'get_callers', 'get_callees', 'get_file_siblings', 'search_similar', 'search_grep'];

    for (let i = 0; i < patterns.length; i++) {
      let match;
      while ((match = patterns[i].exec(text)) !== null) {
        const args = { arg0: match[1] };
        if (match[2]) args.arg1 = parseInt(match[2], 10);
        calls.push({ name: toolNames[i], args });
      }
    }

    return calls;
  };

  /**
   * Runs the research loop for a chunk.
   * @param {Object} chunk - Chunk to research
   * @returns {Promise<Object>} Research session state
   */
  const runResearchLoop = async (chunk) => {
    const history = [];
    const researchedChunks = new Map(); // chunkId -> learned info
    let toolCallCount = 0;
    let stopReason = 'max_tool_calls';

    // Initial system prompt
    history.push({ role: 'system', content: buildSystemPrompt(chunk) });
    history.push({ role: 'user', content: 'Begin your research. Call tools to explore the codebase.' });

    while (toolCallCount < maxToolCalls) {
      // Get LLM response
      const response = await llmClient.chat(
        history.map(h => `${h.role}: ${h.content}`).join('\n\n')
      );

      history.push({ role: 'assistant', content: response });

      // Check if done
      if (response.toLowerCase().includes('done') && toolCallCount > 0) {
        stopReason = 'agent_done';
        break;
      }

      // Parse and execute tool calls
      const toolCalls = parseToolCalls(response);
      
      if (toolCalls.length === 0) {
        // No tool calls, ask to continue or conclude
        history.push({ 
          role: 'user', 
          content: 'Please call a tool to continue research, or say DONE if you have sufficient understanding.' 
        });
        continue;
      }

      // Execute tools (limit to 3 per turn)
      const results = [];
      for (const call of toolCalls.slice(0, 3)) {
        toolCallCount++;
        const result = await executeTool(call.name, call.args);
        results.push({ tool: call.name, args: call.args, result });

        // Track researched chunks for partial enrichment
        if (result && !result.error && result.id) {
          researchedChunks.set(result.id, {
            chunkId: result.id,
            name: result.name,
            relationship: result.relationship || 'explored'
          });
        }

        if (toolCallCount >= maxToolCalls) break;
      }

      // Add tool results to history
      history.push({
        role: 'user',
        content: `Tool results:\n${JSON.stringify(results, null, 2)}\n\nContinue research or say DONE.`
      });
    }

    return {
      history,
      researchedChunks,
      toolCallCount,
      stopReason
    };
  };

  /**
   * Generates final enrichment from research session.
   * @param {Object} chunk - Target chunk
   * @param {Object} session - Research session state
   * @returns {Promise<Object>}
   */
  const generateEnrichment = async (chunk, session) => {
    const prompt = `Based on your research of ${chunk.name}, provide a structured enrichment.

RESEARCH SUMMARY:
- Tool calls made: ${session.toolCallCount}
- Chunks explored: ${session.researchedChunks.size}
- Stop reason: ${session.stopReason}

Now provide the final enrichment for this code. Focus on:
1. What it does (summary - 1 sentence)
2. Why it exists (purpose - 1 sentence)
3. Key operations (3-5 items)
4. Side effects, state changes, dependencies
5. Patterns and concerns
6. Searchable tags (5-10 keywords)

Also list what you learned about OTHER chunks during research (for partial enrichment).`;

    session.history.push({ role: 'user', content: prompt });

    // Generate structured output
    const enrichment = await llmClient.generateStructured(
      session.history.map(h => `${h.role}: ${h.content}`).join('\n\n'),
      EnrichmentSchema
    );

    return enrichment;
  };

  /**
   * Enriches a chunk using the research agent.
   * 
   * @param {string} chunkId - Chunk to enrich
   * @returns {Promise<Object>} Research output with enrichment and captured knowledge
   */
  const enrich = async (chunkId) => {
    // Get chunk data
    const chunkData = await db.getChunkWithFile(chunkId);
    if (!chunkData) {
      throw new Error(`Chunk not found: ${chunkId}`);
    }

    const chunk = {
      id: chunkData.id,
      name: chunkData.name,
      type: chunkData.type,
      code: chunkData.code,
      signature: chunkData.signature,
      jsdoc: chunkData.jsdoc,
      filePath: chunkData.filePath
    };

    // Run research loop
    const session = await runResearchLoop(chunk);

    // Generate final enrichment
    const enrichment = await generateEnrichment(chunk, session);

    // Build research captured array
    const researchCaptured = [];
    for (const [id, info] of session.researchedChunks) {
      if (id !== chunkId) {
        researchCaptured.push({
          chunkId: id,
          learned: `Explored during research of ${chunk.name}`,
          relationship: info.relationship || 'explored',
          confidence: 0.6
        });
      }
    }

    return {
      targetChunkId: chunkId,
      enrichment,
      researchCaptured,
      researchSources: Array.from(session.researchedChunks.keys()),
      toolCallCount: session.toolCallCount,
      stopReason: session.stopReason
    };
  };

  /**
   * Stores research results in the database.
   * @param {Object} result - Research output
   * @returns {Promise<void>}
   */
  const storeResults = async (result) => {
    // Store full enrichment on target
    await db.upsertFullEnrichment(result.targetChunkId, {
      ...result.enrichment,
      researchSources: result.researchSources
    });

    // Store partial enrichments on researched neighbors
    for (const partial of result.researchCaptured) {
      await db.addPartialEnrichment(partial.chunkId, {
        learned: partial.learned,
        relationship: partial.relationship,
        confidence: partial.confidence,
        sourceChunkId: result.targetChunkId
      });
    }
  };

  return {
    enrich,
    storeResults,
    // Expose for testing
    executeTool,
    parseToolCalls
  };
}

/**
 * Truncates code to fit token budget.
 * @param {string} code 
 * @param {number} maxChars 
 * @returns {string}
 */
function truncateCode(code, maxChars) {
  if (!code) return '';
  if (code.length <= maxChars) return code;
  return code.slice(0, maxChars) + '\n// ... truncated';
}
