import { featureDisabledError } from '../utils/config.js';

/**
 * @typedef {Object} StackFrame
 * @property {string} functionName
 * @property {string} filePath
 * @property {number} line
 * @property {number} column
 * @property {boolean} isInternal - true if node_modules or internal
 */

/**
 * @typedef {Object} BugContext
 * @property {string} errorType
 * @property {string} errorMessage
 * @property {StackFrame[]} stackFrames
 * @property {Object[]} relevantCode - Code snippets from stack
 * @property {Object[]} enrichments - Enrichment data for relevant files
 * @property {Object[]} relationships - Graph relationships
 */

/**
 * @typedef {Object} Investigation
 * @property {string} id
 * @property {string} summary
 * @property {Object[]} hypotheses
 * @property {Object[]} affectedFiles
 * @property {Object[]} suggestedActions
 * @property {BugContext} context
 */

/**
 * @typedef {Object} BugInvestigatorConfig
 * @property {boolean} [enabled=true] - Whether bug investigation is enabled
 */

/**
 * @typedef {Object} BugInvestigator
 * @property {function(string): StackFrame[]} parseStackTrace
 * @property {function(string): Promise<Investigation>} investigate
 * @property {function(): boolean} isEnabled
 */

/**
 * Creates a bug investigator for stack trace parsing and analysis.
 * 
 * @param {Object} db - SQLite database adapter
 * @param {Object} queryEngine - Query engine for code search (null if disabled)
 * @param {Object} contextAssembler - Context assembler
 * @param {Object} llmClient - LLM client for hypothesis generation (null if disabled)
 * @param {BugInvestigatorConfig} config - Configuration
 * @returns {BugInvestigator}
 */
export function createBugInvestigator(db, queryEngine, contextAssembler, llmClient, config = {}) {
  const enabled = config.enabled !== false && llmClient !== null;

  /**
   * Returns whether bug investigation is enabled.
   * @returns {boolean}
   */
  const isEnabled = () => enabled;

  /**
   * Parses a stack trace string into structured frames.
   * Supports Node.js, browser, and Python stack traces.
   * 
   * NOTE: This function works even when LLM is disabled (pure parsing).
   * 
   * @param {string} stackTrace
   * @returns {StackFrame[]}
   */
  const parseStackTrace = (stackTrace) => {
    const frames = [];
    const lines = stackTrace.split('\n');

    // Node.js / V8 pattern: at functionName (filePath:line:column)
    const nodePattern = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/;
    
    // Browser pattern: functionName@filePath:line:column
    const browserPattern = /^\s*(.+?)@(.+?):(\d+):(\d+)$/;
    
    // Python pattern: File "path", line N, in function
    const pythonPattern = /^\s*File "(.+?)", line (\d+)(?:, in (.+))?$/;

    for (const line of lines) {
      let match;

      if ((match = line.match(nodePattern))) {
        const filePath = match[2];
        frames.push({
          functionName: match[1] || '<anonymous>',
          filePath,
          line: parseInt(match[3], 10),
          column: parseInt(match[4], 10),
          isInternal: filePath.includes('node_modules') || 
                      filePath.includes('internal/') ||
                      filePath.startsWith('node:')
        });
      } else if ((match = line.match(browserPattern))) {
        frames.push({
          functionName: match[1] || '<anonymous>',
          filePath: match[2],
          line: parseInt(match[3], 10),
          column: parseInt(match[4], 10),
          isInternal: match[2].includes('node_modules')
        });
      } else if ((match = line.match(pythonPattern))) {
        frames.push({
          functionName: match[3] || '<module>',
          filePath: match[1],
          line: parseInt(match[2], 10),
          column: 0,
          isInternal: match[1].includes('site-packages') || 
                      match[1].includes('/lib/python')
        });
      }
    }

    return frames;
  };

  // If LLM is disabled, return partial implementation (parsing only)
  if (!enabled) {
    const reason = llmClient === null 
      ? 'LLM is disabled in configuration'
      : 'planning.bugInvestigator is false in configuration';

    return {
      isEnabled,
      parseStackTrace, // Parsing still works
      investigate: async (stackTrace) => {
        // Return basic parsing without LLM analysis
        const { errorType, errorMessage } = _parseErrorInfo(stackTrace);
        const stackFrames = parseStackTrace(stackTrace);
        
        return {
          id: `inv_${Date.now()}`,
          summary: `${errorType}: ${errorMessage} (LLM analysis disabled)`,
          hypotheses: [],
          affectedFiles: stackFrames.filter(f => !f.isInternal).map(f => ({
            path: f.filePath,
            reason: `Referenced in stack trace at line ${f.line}`
          })),
          suggestedActions: [{
            action: 'Enable LLM for full hypothesis generation',
            priority: 'low'
          }],
          context: {
            errorType,
            errorMessage,
            stackFrames: stackFrames.filter(f => !f.isInternal),
            relevantCode: [],
            enrichments: []
          },
          llmDisabled: true,
          disabledReason: reason
        };
      }
    };
  }

  /**
   * Extracts error type and message from stack trace.
   * @param {string} stackTrace
   * @returns {{errorType: string, errorMessage: string}}
   * @private
   */
  const _parseErrorInfo = (stackTrace) => {
    const lines = stackTrace.split('\n');
    
    // Common error pattern: ErrorType: message
    const errorMatch = lines[0]?.match(/^(\w+(?:Error|Exception)?):?\s*(.*)$/);
    
    if (errorMatch) {
      return {
        errorType: errorMatch[1],
        errorMessage: errorMatch[2] || ''
      };
    }

    // Python traceback
    const pythonMatch = lines.find(l => l.includes('Error:') || l.includes('Exception:'));
    if (pythonMatch) {
      const parts = pythonMatch.split(':');
      return {
        errorType: parts[0]?.trim() || 'Error',
        errorMessage: parts.slice(1).join(':').trim()
      };
    }

    return {
      errorType: 'Error',
      errorMessage: lines[0] || 'Unknown error'
    };
  };

  /**
   * Gets relevant code context from stack frames.
   * @param {StackFrame[]} frames
   * @returns {Promise<Object[]>}
   * @private
   */
  const _getRelevantCode = async (frames) => {
    const relevantCode = [];
    const userFrames = frames.filter(f => !f.isInternal).slice(0, 5);

    for (const frame of userFrames) {
      // Find file in database
      const file = db.prepare(`
        SELECT id, path FROM files WHERE path LIKE ?
      `).get(`%${frame.filePath.split('/').pop()}`);

      if (!file) continue;

      // Find chunk containing the line
      const chunk = db.prepare(`
        SELECT c.*, f.path FROM chunks c
        JOIN files f ON f.id = c.file_id
        WHERE c.file_id = ?
          AND c.start_line <= ?
          AND c.end_line >= ?
        LIMIT 1
      `).get(file.id, frame.line, frame.line);

      if (chunk) {
        relevantCode.push({
          frame,
          file: file.path,
          chunk: {
            id: chunk.id,
            name: chunk.name,
            type: chunk.type,
            code: chunk.code,
            startLine: chunk.start_line,
            endLine: chunk.end_line
          }
        });
      }
    }

    return relevantCode;
  };

  /**
   * Gets enrichments for affected files.
   * @param {Object[]} relevantCode
   * @returns {Object[]}
   * @private
   */
  const _getEnrichments = (relevantCode) => {
    const enrichments = [];
    const seenChunks = new Set();

    for (const item of relevantCode) {
      if (seenChunks.has(item.chunk.id)) continue;
      seenChunks.add(item.chunk.id);

      const enrichment = db.prepare(`
        SELECT * FROM enrichment WHERE chunk_id = ?
      `).get(item.chunk.id);

      if (enrichment) {
        enrichments.push({
          chunkId: item.chunk.id,
          chunkName: item.chunk.name,
          file: item.file,
          summary: enrichment.summary,
          purpose: enrichment.purpose,
          sideEffects: JSON.parse(enrichment.side_effects || '[]'),
          securityConcerns: JSON.parse(enrichment.security_concerns || '[]')
        });
      }
    }

    return enrichments;
  };

  /**
   * Investigates a bug using stack trace and codebase context.
   * @param {string} stackTrace
   * @returns {Promise<Investigation>}
   */
  const investigate = async (stackTrace) => {
    const { errorType, errorMessage } = _parseErrorInfo(stackTrace);
    const stackFrames = parseStackTrace(stackTrace);
    const relevantCode = await _getRelevantCode(stackFrames);
    const enrichments = _getEnrichments(relevantCode);

    // Build context for LLM
    const context = {
      errorType,
      errorMessage,
      stackFrames: stackFrames.filter(f => !f.isInternal),
      relevantCode,
      enrichments
    };

    // Search for additional related code (if query engine available)
    let additionalContext = { code: '', tokenCount: 0 };
    if (queryEngine) {
      const searchQuery = `${errorMessage} ${relevantCode.map(r => r.chunk.name).join(' ')}`;
      const searchResults = await queryEngine.search(searchQuery, { method: 'semantic' });
      additionalContext = await contextAssembler.assemble(searchResults, 4000);
    }

    // Generate investigation with LLM
    const prompt = `You are debugging a software issue. Analyze the following error and provide investigation results.

**Error Type:** ${errorType}
**Error Message:** ${errorMessage}

**Stack Trace (user code only):**
${stackFrames.filter(f => !f.isInternal).map(f => 
  `  at ${f.functionName} (${f.filePath}:${f.line})`
).join('\n')}

**Relevant Code:**
${relevantCode.map(r => `
--- ${r.file}:${r.frame.line} (${r.chunk.name}) ---
${r.chunk.code}
`).join('\n')}

**Code Analysis (if available):**
${enrichments.map(e => 
  `- ${e.chunkName}: ${e.summary}${e.sideEffects.length ? ` | Side effects: ${e.sideEffects.join(', ')}` : ''}`
).join('\n')}

**Additional Related Code:**
${additionalContext.code}

**Task:** Provide a structured investigation with:
1. A brief summary of what's happening
2. 2-3 hypotheses about the root cause (ranked by likelihood)
3. List of affected files that should be examined
4. Suggested debugging actions

Return your response as a JSON object with this structure:
{
  "summary": "Brief description of the issue",
  "hypotheses": [
    {"cause": "description", "likelihood": "high|medium|low", "evidence": "what suggests this"}
  ],
  "affectedFiles": [
    {"path": "file path", "reason": "why this file is relevant"}
  ],
  "suggestedActions": [
    {"action": "what to do", "priority": "high|medium|low"}
  ]
}`;

    const response = await llmClient.chat(prompt);
    
    let investigation;
    try {
      investigation = JSON.parse(response);
    } catch {
      investigation = {
        summary: response,
        hypotheses: [],
        affectedFiles: [],
        suggestedActions: []
      };
    }

    return {
      id: `inv_${Date.now()}`,
      ...investigation,
      context
    };
  };

  return { isEnabled, parseStackTrace, investigate };
}

// Export the helper for use when disabled
function _parseErrorInfo(stackTrace) {
  const lines = stackTrace.split('\n');
  const errorMatch = lines[0]?.match(/^(\w+(?:Error|Exception)?):?\s*(.*)$/);
  
  if (errorMatch) {
    return {
      errorType: errorMatch[1],
      errorMessage: errorMatch[2] || ''
    };
  }

  return {
    errorType: 'Error',
    errorMessage: lines[0] || 'Unknown error'
  };
}
