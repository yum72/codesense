# CodeSense Engine: Unified Implementation Plan v2.1 - Part 2: Implementation

**Version:** 2.1  
**Language:** JavaScript (ESM) with JSDoc  
**Paradigm:** Functional Programming (Factory Functions, No Classes)

---

## 5. Enrichment Engine

The Enrichment Engine is the differentiating feature that transforms "code search" into "code understanding." It uses LLM analysis to extract semantic meaning, business logic, risks, and patterns that static analysis cannot detect.

### 5.1 Core Principles

1. **Graph-Guided Selection** - Don't enrich everything. Use graph metrics to prioritize high-value targets.
2. **Hierarchical Context** - Enrich leaf nodes first, then use their summaries when enriching parents.
3. **Just-In-Time** - Enrich on-demand for thorough mode, background queue for everything else.
4. **Cache Aggressively** - Enrichment is expensive; never re-compute unnecessarily.
5. **Retry with Backoff** - Handle transient LLM failures gracefully with exponential backoff.

### 5.2 Two Enrichment Paths

```
┌─────────────────────────────────────────────────────────────┐
│                    ENRICHMENT ENGINE                         │
│                                                              │
│   ┌──────────────────┐         ┌──────────────────────┐     │
│   │  BACKGROUND QUEUE │         │   ON-DEMAND (SYNC)   │     │
│   │                  │         │                      │     │
│   │  - Git commits   │         │  - User requests     │     │
│   │  - Idle time     │         │    "thorough" mode   │     │
│   │  - Priority files│         │  - Blocks until done │     │
│   │  - Retry failed  │         │                      │     │
│   │                  │         │                      │     │
│   └────────┬─────────┘         └──────────┬───────────┘     │
│            │                              │                  │
│            └──────────┬───────────────────┘                  │
│                       ▼                                      │
│              ┌────────────────┐                              │
│              │ ENRICHMENT     │                              │
│              │ CACHE (SQLite) │                              │
│              └────────────────┘                              │
└─────────────────────────────────────────────────────────────┘
```

### 5.3 Priority-Based Selection (Graph-Guided)

**Problem:** 80% of code is boilerplate or simple utilities. LLM analysis on these is low-value.

**Solution:** Use graph metrics from Tier 1 to identify high-value targets.

| Priority | Criteria | Rationale |
|----------|----------|-----------|
| **P0 (Critical)** | fan_in > 10 | Core utilities used everywhere |
| **P0 (Critical)** | fan_out > 15 | Orchestrators, controllers, "god classes" |
| **P1 (High)** | In `src/services/`, `src/core/` | Likely business logic |
| **P1 (High)** | Recently modified (< 7 days) | Active development area |
| **P2 (Medium)** | Entry points (fan_in = 0, exported) | API surface |
| **P3 (Low)** | Everything else | Enrich only on demand |
| **Skip** | In `test/`, `__tests__/` | Tests have limited planning value |
| **Skip** | Type definitions / JSDoc only | No runtime logic |
| **Skip** | < 50 tokens | Too small to be complex |

```javascript
/**
 * @typedef {Object} EnrichmentPrioritizer
 * @property {function(number): number} calculatePriority
 * @property {function(): Promise<void>} queueHighPriorityChunks
 */

/**
 * Creates a prioritizer for enrichment.
 * @param {Object} db - SQLite database adapter
 * @returns {EnrichmentPrioritizer}
 */
export function createEnrichmentPrioritizer(db) {
  /**
   * Calculates priority based on connectivity and metadata.
   * Priority is always >= 0.
   */
  const calculatePriority = (fileId) => {
    const file = db.prepare(`
      SELECT path, fan_in, fan_out, complexity_score 
      FROM files WHERE id = ?
    `).get(fileId);

    if (!file) return 0;

    let priority = 0;
    
    // High connectivity = high priority
    if (file.fan_in > 10) priority += 100;
    if (file.fan_out > 15) priority += 100;
    
    // Core directories = high priority
    if (file.path.includes('/services/') || file.path.includes('/core/')) {
      priority += 50;
    }

    // Recently modified = high priority
    const recentlyModified = db.prepare(`
      SELECT 1 FROM files 
      WHERE id = ? AND modified_at > unixepoch() - 604800
    `).get(fileId);
    if (recentlyModified) priority += 50;

    // Entry points = medium priority
    if (file.fan_in === 0) priority += 25;
    
    // Negative criteria - skip or deprioritize, but don't go negative
    if (file.path.includes('/test/') || file.path.includes('__tests__')) {
      return 0; // Skip tests entirely
    }
    if (file.complexity_score < 50) {
      priority = Math.max(0, priority - 50);
    }

    return Math.max(0, priority);
  };

  /**
   * Queues high connectivity files for background enrichment.
   * Uses top 10% of files by connectivity.
   */
  const queueHighPriorityChunks = async () => {
    const topFiles = db.prepare(`
      SELECT id FROM files 
      WHERE indexed_tier >= 2
      ORDER BY (fan_in + fan_out) DESC
      LIMIT MAX(1, (SELECT COUNT(*) / 10 FROM files))
    `).all();

    const insertStmt = db.prepare(`
      INSERT INTO enrichment_queue (chunk_id, file_id, priority, status)
      SELECT c.id, c.file_id, ?, 'pending'
      FROM chunks c
      WHERE c.file_id = ?
      AND NOT EXISTS (SELECT 1 FROM enrichment e WHERE e.chunk_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM enrichment_queue eq WHERE eq.chunk_id = c.id)
    `);

    // Use transaction for bulk insert
    const transaction = db.transaction((files) => {
      for (const file of files) {
        const priority = calculatePriority(file.id);
        if (priority > 0) {
          insertStmt.run(priority, file.id);
        }
      }
    });

    transaction(topFiles);
  };

  return { calculatePriority, queueHighPriorityChunks };
}
```

### 5.4 Hierarchical Context Strategy

**Problem:** An LLM understands `CheckoutService.js` better if it knows what its dependencies do.

**Solution:** "Map-Reduce" approach: Enrich leaf nodes first, then use their summaries when enriching parents.

```javascript
/**
 * @typedef {Object} HierarchicalEnricher
 * @property {function(string): Promise<Object>} enrichWithContext
 */

/**
 * Creates a hierarchical enricher.
 * @param {Object} db - SQLite database adapter
 * @param {Object} llmClient - LLM client for enrichment
 * @returns {HierarchicalEnricher}
 */
export function createHierarchicalEnricher(db, llmClient) {
  const getDependencies = (fileId) => {
    return db.prepare(`
      SELECT DISTINCT target_file_id as fileId, target_def_id as defId, target_name as name
      FROM relationships
      WHERE source_file_id = ? 
        AND type IN ('import', 'call')
        AND target_file_id IS NOT NULL
    `).all(fileId);
  };

  const buildDependencyContext = async (dependencies) => {
    const summaries = [];
    for (const dep of dependencies) {
      const enrichment = db.prepare(`
        SELECT e.summary FROM enrichment e
        JOIN chunks c ON c.id = e.chunk_id
        WHERE c.file_id = ? AND (c.def_id = ? OR c.name LIKE ?)
      `).get(dep.fileId, dep.defId, `%${dep.name}%`);

      summaries.push(enrichment 
        ? `- ${dep.name}: ${enrichment.summary}` 
        : `- ${dep.name}: (not yet analyzed)`);
    }
    return summaries.join('\n');
  };

  const enrichWithContext = async (chunkId) => {
    const chunk = db.prepare(`
      SELECT c.*, f.path FROM chunks c 
      JOIN files f ON f.id = c.file_id 
      WHERE c.id = ?
    `).get(chunkId);

    if (!chunk) {
      throw new Error(`Chunk not found: ${chunkId}`);
    }

    const dependencies = getDependencies(chunk.file_id);
    const dependencyContext = await buildDependencyContext(dependencies);
    
    return llmClient.enrich(chunk, dependencyContext);
  };

  return { enrichWithContext };
}
```

### 5.5 Background Queue Processor with Retry Logic

```javascript
/**
 * @typedef {Object} BackgroundEnrichmentQueue
 * @property {function(): Promise<void>} start
 * @property {function(): void} stop
 * @property {function(): Object} getStats
 */

/**
 * Creates a background enrichment queue with retry logic.
 * @param {Object} db - SQLite database adapter
 * @param {Object} enricher - Hierarchical enricher
 * @param {Object} config - Queue configuration
 * @returns {BackgroundEnrichmentQueue}
 */
export function createBackgroundEnrichmentQueue(db, enricher, config) {
  let isProcessing = false;
  let processedCount = 0;
  let failedCount = 0;

  /**
   * Calculates exponential backoff delay.
   * @private
   */
  const calculateBackoff = (attempts) => {
    const baseDelay = 60; // 60 seconds
    return baseDelay * Math.pow(2, attempts);
  };

  /**
   * Processes a single enrichment item with error handling.
   * @private
   */
  const processItem = async (item) => {
    const updateStatus = db.prepare(`
      UPDATE enrichment_queue 
      SET status = ?, processed_at = unixepoch(), attempts = attempts + 1, error_message = ?
      WHERE chunk_id = ?
    `);

    const updateRetry = db.prepare(`
      UPDATE enrichment_queue 
      SET status = 'failed', attempts = attempts + 1, 
          next_retry_at = unixepoch() + ?, error_message = ?
      WHERE chunk_id = ?
    `);

    try {
      // Mark as processing
      db.prepare(`UPDATE enrichment_queue SET status = 'processing' WHERE chunk_id = ?`)
        .run(item.chunk_id);

      // Enrich the chunk
      const enrichment = await enricher.enrichWithContext(item.chunk_id);

      // Store enrichment result
      db.prepare(`
        INSERT INTO enrichment (
          chunk_id, file_id, hash, content_hash,
          summary, purpose, key_operations, side_effects, state_changes,
          implicit_dependencies, design_patterns, architectural_patterns,
          anti_patterns, complexity, security_concerns, performance_concerns,
          business_rules, tags, model_used, prompt_version, enriched_at, confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?)
      `).run(
        item.chunk_id, item.file_id, enrichment.hash, enrichment.content_hash,
        enrichment.summary, enrichment.purpose, 
        JSON.stringify(enrichment.key_operations),
        JSON.stringify(enrichment.side_effects),
        JSON.stringify(enrichment.state_changes),
        JSON.stringify(enrichment.implicit_dependencies),
        JSON.stringify(enrichment.design_patterns),
        JSON.stringify(enrichment.architectural_patterns),
        JSON.stringify(enrichment.anti_patterns),
        enrichment.complexity,
        JSON.stringify(enrichment.security_concerns),
        JSON.stringify(enrichment.performance_concerns),
        JSON.stringify(enrichment.business_rules),
        JSON.stringify(enrichment.tags),
        enrichment.model_used,
        enrichment.prompt_version,
        enrichment.confidence
      );

      // Mark as complete
      updateStatus.run('complete', null, item.chunk_id);
      processedCount++;

    } catch (error) {
      failedCount++;
      
      const currentAttempts = item.attempts + 1;
      
      if (currentAttempts >= config.maxRetries) {
        // Exceeded max retries - mark as failed permanently
        updateStatus.run('failed', error.message, item.chunk_id);
      } else {
        // Schedule retry with exponential backoff
        const backoffSeconds = calculateBackoff(currentAttempts);
        updateRetry.run(backoffSeconds, error.message, item.chunk_id);
      }
    }
  };

  /**
   * Main processing loop.
   * @private
   */
  const processLoop = async () => {
    while (isProcessing) {
      // Get pending items (including failed items ready for retry)
      const batch = db.prepare(`
        SELECT chunk_id, file_id, attempts FROM enrichment_queue 
        WHERE (
          status = 'pending' 
          OR (status = 'failed' AND attempts < max_attempts AND unixepoch() >= next_retry_at)
        )
        ORDER BY priority DESC 
        LIMIT ?
      `).all(config.batchSize);

      if (batch.length === 0) {
        await new Promise(r => setTimeout(r, config.idleDelayMs));
        continue;
      }

      // Process batch with concurrency control
      const processingBatch = batch.map(item => processItem(item));
      await Promise.allSettled(processingBatch);

      // Small delay between batches to avoid overwhelming LLM API
      await new Promise(r => setTimeout(r, 1000));
    }
  };

  const start = async () => { 
    isProcessing = true; 
    processedCount = 0;
    failedCount = 0;
    processLoop(); 
  };

  const stop = () => { 
    isProcessing = false; 
  };

  const getStats = () => ({
    processed: processedCount,
    failed: failedCount,
    pending: db.prepare(`SELECT COUNT(*) as count FROM enrichment_queue WHERE status = 'pending'`).get().count,
    retryable: db.prepare(`SELECT COUNT(*) as count FROM enrichment_queue WHERE status = 'failed' AND attempts < max_attempts`).get().count
  });

  return { start, stop, getStats };
}
```

### 5.6 Enrichment Schema (Zod)

```javascript
// src/llm/schemas.js
import { z } from 'zod';

/**
 * Schema for LLM enrichment output.
 * Ensures structured, validated responses from the LLM.
 */
export const EnrichmentSchema = z.object({
  // File metadata
  hash: z.string(),
  content_hash: z.string(),
  
  // Core understanding
  summary: z.string().max(500).describe('One sentence describing what this code does'),
  purpose: z.string().describe('Business or technical purpose - why does this exist?'),
  
  // Structural insights
  key_operations: z.array(z.string()).describe('Main actions performed'),
  side_effects: z.array(z.string()).describe('Non-obvious effects like DB writes, API calls'),
  state_changes: z.array(z.string()).describe('Data modifications'),
  implicit_dependencies: z.array(z.string()).describe('Hidden requirements like env vars'),
  
  // Pattern detection
  design_patterns: z.array(z.string()).describe('Design patterns used'),
  architectural_patterns: z.array(z.string()).describe('Architectural patterns like Repository, Service'),
  anti_patterns: z.array(z.string()).describe('Code smells and anti-patterns'),
  
  // Risk signals
  complexity: z.enum(['low', 'medium', 'high']),
  security_concerns: z.array(z.string()).describe('Security issues'),
  performance_concerns: z.array(z.string()).describe('Performance issues'),
  
  // Business context
  business_rules: z.array(z.string()).describe('Human-readable business logic'),
  
  // Semantic tags
  tags: z.array(z.string()).describe('Semantic tags for search enhancement'),
  
  // Metadata
  model_used: z.string(),
  prompt_version: z.string(),
  confidence: z.number().min(0).max(1)
});

/**
 * @typedef {z.infer<typeof EnrichmentSchema>} ChunkEnrichment
 */
```

### 5.7 LLM Client (Vercel AI SDK Core)

```javascript
import { generateObject, generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOllama } from 'ollama-ai-provider';
import { EnrichmentSchema } from './schemas.js';
import { createHash } from 'crypto';

/**
 * @typedef {Object} LLMClient
 * @property {function(Object, string): Promise<import('./schemas.js').ChunkEnrichment>} enrich
 * @property {function(string): Promise<string>} chat
 */

/**
 * Creates an AI client for LLM operations.
 * @param {import('../utils/config.js').Config} config - Configuration
 * @returns {LLMClient}
 */
export function createAIClient(config) {
  const PROMPT_VERSION = 'v1.0';

  const getModel = () => {
    if (config.llmProvider === 'ollama') {
      return createOllama({ baseURL: config.llmBaseUrl })(config.llmModel);
    }
    return createOpenAI({
      baseURL: config.llmBaseUrl || 'https://openrouter.ai/api/v1',
      apiKey: config.llmApiKey
    })(config.llmModel);
  };

  const model = getModel();

  /**
   * Enriches a code chunk with LLM analysis.
   */
  const enrich = async (chunk, dependencyContext) => {
    const prompt = `Analyze this code and extract semantic understanding.

**File:** ${chunk.path}
**Type:** ${chunk.type}
**Name:** ${chunk.name}

**Code:**
\`\`\`javascript
${chunk.code}
\`\`\`

**Dependencies Context:**
${dependencyContext || 'No dependencies analyzed yet'}

**Task:** Provide a structured analysis focusing on insights that static analysis cannot provide. Be specific and actionable.

Return a JSON object with these fields:
- summary: One sentence describing what this code does
- purpose: Business or technical purpose (why does this exist?)
- key_operations: Array of main actions
- side_effects: Array of non-obvious effects
- state_changes: Array of data modifications
- implicit_dependencies: Array of hidden requirements
- design_patterns: Array of patterns used
- architectural_patterns: Array of architectural patterns
- anti_patterns: Array of code smells
- complexity: "low", "medium", or "high"
- security_concerns: Array of security issues
- performance_concerns: Array of performance issues
- business_rules: Array of business logic
- tags: Array of semantic tags for search`;

    const { object } = await generateObject({
      model,
      schema: EnrichmentSchema,
      prompt,
      temperature: 0.3,
    });

    // Add metadata
    return {
      ...object,
      hash: chunk.hash || createHash('sha256').update(chunk.code).digest('hex').slice(0, 16),
      content_hash: createHash('sha256').update(chunk.code).digest('hex').slice(0, 16),
      model_used: config.llmModel,
      prompt_version: PROMPT_VERSION,
      confidence: 0.8 // Default confidence; can be enhanced with calibration
    };
  };

  /**
   * General chat completion for plan generation.
   */
  const chat = async (prompt) => {
    const { text } = await generateText({ model, prompt });
    return text;
  };

  return { enrich, chat };
}
```

---

## 6. Retrieval Engine

### 6.1 Query Understanding

```javascript
/**
 * @typedef {Object} QueryUnderstanding
 * @property {string} intent - find_implementation, find_usage, explain, etc.
 * @property {string[]} keywords - Extracted keywords
 * @property {string[]} suggestedMethods - semantic, structural, graph
 */

/**
 * @typedef {Object} QueryUnderstandingEngine
 * @property {function(string): QueryUnderstanding} classify
 */

/**
 * Creates a query understanding engine.
 * @returns {QueryUnderstandingEngine}
 */
export function createQueryUnderstandingEngine() {
  const classify = (query) => {
    const lowerQuery = query.toLowerCase();
    
    // Intent detection
    let intent = 'find_implementation';
    if (lowerQuery.includes('who calls') || lowerQuery.includes('where is used')) {
      intent = 'find_usage';
    } else if (lowerQuery.includes('explain') || lowerQuery.includes('how does')) {
      intent = 'explain';
    }
    
    // Keyword extraction (simple for MVP)
    const keywords = query.split(/\s+/).filter(w => w.length > 3);
    
    // Method suggestion
    const suggestedMethods = ['semantic'];
    if (lowerQuery.includes('calls') || lowerQuery.includes('imports')) {
      suggestedMethods.push('graph');
    }
    
    return { intent, keywords, suggestedMethods };
  };
  
  return { classify };
}
```

### 6.2 Semantic Search

```javascript
/**
 * @typedef {Object} SearchResult
 * @property {string} chunkId
 * @property {number} distance
 * @property {string} code
 * @property {string} path
 */

/**
 * @typedef {Object} SemanticSearch
 * @property {function(string, number=): Promise<SearchResult[]>} search
 */

/**
 * Creates a semantic search engine.
 * @param {Object} db - SQLite database adapter
 * @param {Object} embedder - Embedder for query vectorization
 * @returns {SemanticSearch}
 */
export function createSemanticSearch(db, embedder) {
  const search = async (query, limit = 10) => {
    const embedding = await embedder.embed(query);
    
    // Note: sqlite-vec uses different syntax than shown in initial plan
    // Actual syntax: SELECT * FROM vec_chunks WHERE rowid IN (SELECT rowid FROM vec_chunks ORDER BY distance)
    // This is a simplified version - consult sqlite-vec docs for exact syntax
    const results = db.prepare(`
      SELECT 
        c.id as chunkId,
        c.code,
        f.path,
        vec_distance_cosine(v.embedding, ?) as distance
      FROM vec_chunks v
      JOIN chunks c ON c.id = v.chunk_id
      JOIN files f ON f.id = c.file_id
      ORDER BY distance ASC
      LIMIT ?
    `).all(JSON.stringify(embedding), limit);
    
    return results;
  };
  
  return { search };
}
```

### 6.3 Graph Search

```javascript
/**
 * @typedef {Object} GraphSearch
 * @property {function(string): Array} findCallers
 * @property {function(string): Array} findCallees
 * @property {function(number): Array} getImports
 */

/**
 * Creates a graph search engine.
 * @param {Object} db - SQLite database adapter
 * @returns {GraphSearch}
 */
export function createGraphSearch(db) {
  const findCallers = (targetName) => {
    return db.prepare(`
      SELECT f.path, d.name, r.line_number
      FROM relationships r
      JOIN files f ON f.id = r.source_file_id
      LEFT JOIN definitions d ON d.id = r.source_def_id
      WHERE r.target_name = ? AND r.type = 'call'
    `).all(targetName);
  };
  
  const findCallees = (sourceDefId) => {
    return db.prepare(`
      SELECT f.path, d.name, r.target_name
      FROM relationships r
      LEFT JOIN files f ON f.id = r.target_file_id
      LEFT JOIN definitions d ON d.id = r.target_def_id
      WHERE r.source_def_id = ? AND r.type = 'call'
    `).all(sourceDefId);
  };
  
  const getImports = (fileId) => {
    return db.prepare(`
      SELECT f.path, r.target_name, r.is_external
      FROM relationships r
      LEFT JOIN files f ON f.id = r.target_file_id
      WHERE r.source_file_id = ? AND r.type = 'import'
    `).all(fileId);
  };
  
  return { findCallers, findCallees, getImports };
}
```

---

## 7. Product Layer (MCP Tools)

### 7.1 Context Assembler

```javascript
/**
 * @typedef {Object} AssembledContext
 * @property {string} code - Concatenated relevant code
 * @property {Object[]} enrichments - Related enrichments
 * @property {Object[]} relationships - Graph relationships
 * @property {number} tokenCount - Total tokens
 */

/**
 * @typedef {Object} ContextAssembler
 * @property {function(Object[], number): Promise<AssembledContext>} assemble
 */

/**
 * Creates a context assembler for LLM prompts.
 * @param {Object} db - SQLite database adapter
 * @param {Object} tokenCounter - Token counting utility
 * @returns {ContextAssembler}
 */
export function createContextAssembler(db, tokenCounter) {
  const assemble = async (searchResults, maxTokens = 8000) => {
    const chunks = [];
    const enrichments = [];
    let totalTokens = 0;
    
    for (const result of searchResults) {
      // Get chunk details
      const chunk = db.prepare(`
        SELECT c.*, f.path FROM chunks c
        JOIN files f ON f.id = c.file_id
        WHERE c.id = ?
      `).get(result.chunkId);
      
      if (!chunk) continue;
      
      const chunkTokens = tokenCounter.count(chunk.code);
      if (totalTokens + chunkTokens > maxTokens) break;
      
      chunks.push(chunk);
      totalTokens += chunkTokens;
      
      // Get enrichment if available
      const enrichment = db.prepare(`
        SELECT * FROM enrichment WHERE chunk_id = ?
      `).get(result.chunkId);
      
      if (enrichment) {
        enrichments.push(enrichment);
      }
    }
    
    // Build context string
    const codeContext = chunks.map(c => 
      `// ${c.path}:${c.start_line}-${c.end_line}\n${c.code}`
    ).join('\n\n');
    
    return {
      code: codeContext,
      enrichments,
      relationships: [], // TODO: Add graph context
      tokenCount: totalTokens
    };
  };
  
  return { assemble };
}
```

### 7.2 Plan Generator

```javascript
/**
 * @typedef {Object} PlanArtifact
 * @property {string} id
 * @property {Object} metadata
 * @property {string} summary
 * @property {Object[]} affectedAreas
 * @property {Object[]} existingPatterns
 * @property {Object[]} implementationSteps
 * @property {Object[]} risks
 * @property {Object} testPlan
 */

/**
 * @typedef {Object} PlanGenerator
 * @property {function(string, string=): Promise<PlanArtifact>} generate
 */

/**
 * Creates a plan generator.
 * @param {Object} queryEngine - Query engine for code search
 * @param {Object} contextAssembler - Context assembler
 * @param {Object} llmClient - LLM client
 * @returns {PlanGenerator}
 */
export function createPlanGenerator(queryEngine, contextAssembler, llmClient) {
  const generate = async (task, mode = 'fast') => {
    // Search for relevant code
    const results = await queryEngine.search(task);
    
    // Assemble context
    const context = await contextAssembler.assemble(results);
    
    // Generate plan with LLM
    const prompt = `You are a senior software architect. Generate an implementation plan for the following task:

**Task:** ${task}

**Relevant Code:**
${context.code}

${context.enrichments.length > 0 ? `**Code Analysis:**
${context.enrichments.map(e => `- ${e.summary}`).join('\n')}` : ''}

**Instructions:**
1. Identify affected files and why they need changes
2. Identify existing patterns to follow
3. Break down implementation into concrete steps
4. Identify risks and mitigation strategies
5. Suggest testing approach

Return a structured JSON plan.`;

    const planText = await llmClient.chat(prompt);
    
    // Parse and validate plan (simplified - add Zod schema)
    const plan = JSON.parse(planText);
    plan.id = `plan_${Date.now()}`;
    plan.metadata = {
      task,
      mode,
      createdAt: new Date().toISOString()
    };
    
    return plan;
  };
  
  return { generate };
}
```

### 7.3 CodeSense MCP Server

```javascript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * Starts the CodeSense MCP server.
 * @param {string} rootPath - Root path of codebase to analyze
 * @param {import('./utils/config.js').Config} config - Configuration
 */
export async function startCodeSenseServer(rootPath, config) {
  const server = new Server(
    { name: 'codesense', version: '1.0.0' }, 
    { capabilities: { tools: {} } }
  );
  
  // Initialize all components via dependency injection
  const db = initDatabase(rootPath);
  const embedder = createEmbedder(config);
  const llmClient = createAIClient(config);
  const enricher = createHierarchicalEnricher(db, llmClient);
  
  // Search components
  const semanticSearch = createSemanticSearch(db, embedder);
  const graphSearch = createGraphSearch(db);
  const queryEngine = createQueryEngine(db, semanticSearch, graphSearch);
  
  // Planning components
  const tokenCounter = createTokenCounter();
  const contextAssembler = createContextAssembler(db, tokenCounter);
  const planGenerator = createPlanGenerator(queryEngine, contextAssembler, llmClient);
  
  // Background enrichment (optional - start if enabled)
  if (config.enrichmentEnabled) {
    const prioritizer = createEnrichmentPrioritizer(db);
    const queue = createBackgroundEnrichmentQueue(db, enricher, config);
    await prioritizer.queueHighPriorityChunks();
    queue.start();
  }

  // Tool handlers
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    switch (request.params.name) {
      case 'generate_plan': {
        const plan = await planGenerator.generate(
          request.params.arguments.task,
          request.params.arguments.mode || 'fast'
        );
        return { 
          content: [{ type: 'text', text: JSON.stringify(plan, null, 2) }] 
        };
      }
      
      case 'search_codebase': {
        const results = await queryEngine.search(request.params.arguments.query);
        return { 
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] 
        };
      }
      
      case 'get_index_status': {
        const status = db.prepare(`
          SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN indexed_tier >= 1 THEN 1 ELSE 0 END) as parsed,
            SUM(CASE WHEN indexed_tier >= 2 THEN 1 ELSE 0 END) as embedded
          FROM files
        `).get();
        return { 
          content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] 
        };
      }
      
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  });

  await server.connect(new StdioServerTransport());
}
```

---

## 8. Concurrency & Performance Optimizations

### 8.1 Database Transactions

Always use transactions for bulk operations:

```javascript
/**
 * Bulk inserts files using a transaction.
 * @param {Object} db
 * @param {Object[]} fileEntries
 */
function bulkInsertFiles(db, fileEntries) {
  const insert = db.prepare(`
    INSERT INTO files (path, hash, size, modified_at)
    VALUES (?, ?, ?, ?)
  `);
  
  const transaction = db.transaction((entries) => {
    for (const entry of entries) {
      insert.run(entry.path, entry.hash, entry.size, entry.modifiedAt);
    }
  });
  
  transaction(fileEntries);
}
```

### 8.2 Connection Pooling (Not Needed for SQLite)

SQLite uses a single connection, but ensure WAL mode is enabled:

```javascript
/**
 * Initializes database with optimal settings.
 * @param {string} dbPath
 * @returns {Object} Database instance
 */
function initDatabase(dbPath) {
  const db = new Database(dbPath);
  
  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000'); // 64MB cache
  db.pragma('temp_store = MEMORY');
  
  return db;
}
```

### 8.3 Batch Processing

Process large datasets in batches to avoid memory issues:

```javascript
/**
 * Processes items in batches with a callback.
 * @param {Array} items
 * @param {number} batchSize
 * @param {function} callback
 */
async function processBatches(items, batchSize, callback) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await callback(batch, i);
  }
}
```

---

*End of Part 2*
