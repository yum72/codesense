import { featureDisabledError } from '../utils/config.js';

/**
 * @typedef {Object} PlanArtifact
 * @property {string} id
 * @property {string} task
 * @property {string} taskType
 * @property {string} mode
 * @property {string} plan
 * @property {Object} metadata
 */

/**
 * @typedef {Object} PlanningConfig
 * @property {boolean} [enabled=true] - Master toggle for planning
 * @property {boolean} [persistence=true] - Save plans to DB
 */

/**
 * @typedef {Object} PlanGenerator
 * @property {function(string, string=): Promise<PlanArtifact>} generate
 * @property {function(string): Object|null} getPlan
 * @property {function(): Object[]} listPlans
 * @property {function(): boolean} isEnabled
 */

/**
 * Creates a plan generator with persistence.
 * @param {Object} db - SQLite database adapter
 * @param {Object} queryEngine - Query engine (null if disabled)
 * @param {Object} contextAssembler - Context assembler
 * @param {Object} llmClient - LLM client (null if disabled)
 * @param {PlanningConfig} config - Planning configuration
 * @returns {PlanGenerator}
 */
export function createPlanGenerator(db, queryEngine, contextAssembler, llmClient, config = {}) {
  const enabled = config.enabled !== false && llmClient !== null && queryEngine !== null;
  const persistenceEnabled = config.persistence !== false;

  /**
   * Returns whether planning is enabled.
   * @returns {boolean}
   */
  const isEnabled = () => enabled;

  // If disabled, return stub implementation
  if (!enabled) {
    const reason = llmClient === null 
      ? 'LLM is disabled in configuration'
      : queryEngine === null
        ? 'Search/indexing is disabled in configuration'
        : 'planning.enabled is false in configuration';

    return {
      isEnabled,
      generate: async () => {
        throw new Error(featureDisabledError('plan generation', reason));
      },
      getPlan: () => null,
      listPlans: () => []
    };
  }

  /**
   * Detects the task type from the task description.
   * @param {string} task
   * @returns {string}
   * @private
   */
  const _detectTaskType = (task) => {
    const lowerTask = task.toLowerCase();
    
    if (/fix|bug|error|issue|broken|crash|fail/.test(lowerTask)) {
      return 'bug';
    }
    if (/refactor|clean|reorganize|restructure|simplify/.test(lowerTask)) {
      return 'refactor';
    }
    if (/add|implement|create|build|new|feature/.test(lowerTask)) {
      return 'feature';
    }
    if (/update|change|modify|improve|enhance/.test(lowerTask)) {
      return 'enhancement';
    }
    
    return 'feature';
  };

  /**
   * Stores a plan in the database.
   * @param {PlanArtifact} plan
   * @private
   */
  const _storePlan = (plan) => {
    if (!persistenceEnabled) return;
    
    db.prepare(`
      INSERT OR REPLACE INTO plans (id, task, task_type, mode, plan_json, chunks_used, created_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    `).run(
      plan.id,
      plan.task,
      plan.taskType,
      plan.mode,
      JSON.stringify(plan.plan),
      JSON.stringify(plan.metadata.chunksUsed || [])
    );
  };

  /**
   * Generates an implementation plan for a task.
   * @param {string} task 
   * @param {string} [mode='fast'] - 'fast' or 'thorough'
   * @returns {Promise<PlanArtifact>}
   */
  const generate = async (task, mode = 'fast') => {
    // 1. Search for relevant code
    const searchLimit = mode === 'thorough' ? 25 : 15;
    const results = await queryEngine.search(task, { limit: searchLimit });
    
    // 2. Assemble context
    const maxTokens = mode === 'thorough' ? 12000 : 8000;
    const context = await contextAssembler.assemble(results, maxTokens);
    
    // 3. Detect task type
    const taskType = _detectTaskType(task);

    // 4. Build prompt based on task type
    let additionalInstructions = '';
    if (taskType === 'bug') {
      additionalInstructions = `
- Focus on identifying the root cause.
- Suggest debugging strategies.
- Consider edge cases that might have been missed.`;
    } else if (taskType === 'refactor') {
      additionalInstructions = `
- Preserve existing functionality.
- Identify breaking changes and migration needs.
- Suggest incremental refactoring steps.`;
    }

    // 5. Generate plan
    const prompt = `You are a senior software architect. Generate an implementation plan for the following task:

**Task:** ${task}
**Task Type:** ${taskType}
**Mode:** ${mode}

**Relevant Code Context:**
${context.code}

${context.enrichments.length > 0 ? `**Semantic Analysis:**
${context.enrichments.map(e => `- ${e.chunkName || 'Code'}: ${e.summary}`).join('\n')}` : ''}

**Instructions:**
1. Analyze the requirements against the provided code.
2. Identify affected files and specific changes needed.
3. Identify existing patterns that should be followed.
4. Provide a step-by-step implementation guide.
5. Identify potential risks and edge cases.
6. Suggest a testing strategy.
${additionalInstructions}

Return the plan in a clear, structured Markdown format with the following sections:
- **Summary**: Brief overview of the implementation approach
- **Affected Areas**: Files and components that need changes
- **Implementation Steps**: Numbered, actionable steps
- **Risks & Considerations**: Potential issues to watch for
- **Testing Plan**: How to verify the changes work correctly`;

    const planText = await llmClient.chat(prompt);
    
    const plan = {
      id: `plan_${Date.now()}`,
      task,
      taskType,
      mode,
      plan: planText,
      metadata: {
        createdAt: new Date().toISOString(),
        chunksUsed: results.filter(r => r.method === 'semantic').map(r => r.chunkId),
        contextTokens: context.tokenCount,
        searchResultsCount: results.length,
        hasEnrichments: context.enrichments.length > 0
      }
    };

    // 6. Store plan in database (if persistence enabled)
    _storePlan(plan);

    return plan;
  };

  /**
   * Retrieves a plan by ID.
   * @param {string} planId
   * @returns {Object|null}
   */
  const getPlan = (planId) => {
    if (!persistenceEnabled) return null;
    
    const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
    if (!row) return null;

    return {
      id: row.id,
      task: row.task,
      taskType: row.task_type,
      mode: row.mode,
      plan: JSON.parse(row.plan_json),
      metadata: {
        chunksUsed: JSON.parse(row.chunks_used || '[]'),
        createdAt: new Date(row.created_at * 1000).toISOString()
      }
    };
  };

  /**
   * Lists recent plans.
   * @param {number} limit
   * @returns {Object[]}
   */
  const listPlans = (limit = 10) => {
    if (!persistenceEnabled) return [];
    
    const rows = db.prepare(`
      SELECT id, task, task_type, mode, created_at 
      FROM plans 
      ORDER BY created_at DESC 
      LIMIT ?
    `).all(limit);

    return rows.map(row => ({
      id: row.id,
      task: row.task,
      taskType: row.task_type,
      mode: row.mode,
      createdAt: new Date(row.created_at * 1000).toISOString()
    }));
  };

  return { isEnabled, generate, getPlan, listPlans };
}
