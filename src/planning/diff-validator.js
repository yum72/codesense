import { featureDisabledError } from '../utils/config.js';

/**
 * @typedef {Object} DiffHunk
 * @property {string} filePath
 * @property {number} oldStart
 * @property {number} oldLines
 * @property {number} newStart
 * @property {number} newLines
 * @property {string[]} additions
 * @property {string[]} deletions
 * @property {string} content
 */

/**
 * @typedef {Object} ValidationResult
 * @property {string} id
 * @property {boolean} isValid
 * @property {number} alignmentScore - 0-100
 * @property {Object[]} alignedSteps - Plan steps covered by diff
 * @property {Object[]} missedSteps - Plan steps not in diff
 * @property {Object[]} unexpectedChanges - Changes not in plan
 * @property {Object[]} concerns - Potential issues
 * @property {string} summary
 */

/**
 * @typedef {Object} DiffValidatorConfig
 * @property {boolean} [enabled=true] - Whether diff validation is enabled
 */

/**
 * @typedef {Object} DiffValidator
 * @property {function(string): DiffHunk[]} parseDiff
 * @property {function(string, string): Promise<ValidationResult>} validate
 * @property {function(): boolean} isEnabled
 */

/**
 * Creates a diff validator for comparing changes against plans.
 * 
 * @param {Object} db - SQLite database adapter
 * @param {Object} llmClient - LLM client for analysis (null if disabled)
 * @param {DiffValidatorConfig} config - Configuration
 * @returns {DiffValidator}
 */
export function createDiffValidator(db, llmClient, config = {}) {
  const enabled = config.enabled !== false && llmClient !== null;

  /**
   * Returns whether diff validation is enabled.
   * @returns {boolean}
   */
  const isEnabled = () => enabled;

  /**
   * Parses a unified diff into structured hunks.
   * 
   * NOTE: This function works even when LLM is disabled (pure parsing).
   * 
   * @param {string} diff
   * @returns {DiffHunk[]}
   */
  const parseDiff = (diff) => {
    const hunks = [];
    const lines = diff.split('\n');
    
    let currentFile = null;
    let currentHunk = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // New file header: diff --git a/path b/path
      if (line.startsWith('diff --git')) {
        const match = line.match(/diff --git a\/(.+) b\/(.+)/);
        if (match) {
          currentFile = match[2];
        }
        continue;
      }

      // Alternative: +++ b/path
      if (line.startsWith('+++')) {
        const match = line.match(/\+\+\+ [ab]\/(.+)/);
        if (match) {
          currentFile = match[1];
        }
        continue;
      }

      // Hunk header: @@ -old,count +new,count @@
      if (line.startsWith('@@')) {
        const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (match && currentFile) {
          // Save previous hunk
          if (currentHunk) {
            hunks.push(currentHunk);
          }

          currentHunk = {
            filePath: currentFile,
            oldStart: parseInt(match[1], 10),
            oldLines: parseInt(match[2] || '1', 10),
            newStart: parseInt(match[3], 10),
            newLines: parseInt(match[4] || '1', 10),
            additions: [],
            deletions: [],
            content: ''
          };
        }
        continue;
      }

      // Collect hunk content
      if (currentHunk) {
        currentHunk.content += line + '\n';
        
        if (line.startsWith('+') && !line.startsWith('+++')) {
          currentHunk.additions.push(line.slice(1));
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          currentHunk.deletions.push(line.slice(1));
        }
      }
    }

    // Don't forget the last hunk
    if (currentHunk) {
      hunks.push(currentHunk);
    }

    return hunks;
  };

  // If LLM is disabled, return partial implementation (parsing only)
  if (!enabled) {
    const reason = llmClient === null 
      ? 'LLM is disabled in configuration'
      : 'planning.diffValidator is false in configuration';

    return {
      isEnabled,
      parseDiff, // Parsing still works
      validate: async (diff, planId) => {
        // Return basic parsing results without LLM analysis
        const hunks = parseDiff(diff);
        const changedFiles = [...new Set(hunks.map(h => h.filePath))];
        
        return {
          id: `val_${Date.now()}`,
          isValid: false,
          alignmentScore: 0,
          alignedSteps: [],
          missedSteps: [],
          unexpectedChanges: changedFiles.map(f => ({
            file: f,
            concern: 'Unable to analyze without LLM'
          })),
          concerns: [{
            type: 'llm_disabled',
            description: reason,
            severity: 'medium'
          }],
          summary: `Parsed ${hunks.length} hunks across ${changedFiles.length} files. Enable LLM for full validation.`,
          context: {
            planId,
            hunksCount: hunks.length,
            filesChanged: changedFiles.length
          },
          llmDisabled: true,
          disabledReason: reason
        };
      }
    };
  }

  /**
   * Gets a plan from the database.
   * @param {string} planId
   * @returns {Object|null}
   * @private
   */
  const _getPlan = (planId) => {
    const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
    if (!row) return null;
    
    return {
      ...row,
      plan: JSON.parse(row.plan_json),
      chunksUsed: JSON.parse(row.chunks_used || '[]')
    };
  };

  /**
   * Analyzes diff changes against plan steps.
   * @param {DiffHunk[]} hunks
   * @param {Object} plan
   * @returns {Object}
   * @private
   */
  const _analyzeAlignment = (hunks, plan) => {
    const changedFiles = [...new Set(hunks.map(h => h.filePath))];
    const plannedFiles = plan.affectedAreas?.map(a => a.file) || [];
    const plannedSteps = plan.implementationSteps || [];

    // Files that match
    const alignedFiles = changedFiles.filter(f => 
      plannedFiles.some(pf => f.includes(pf) || pf.includes(f))
    );

    // Files changed but not in plan
    const unexpectedFiles = changedFiles.filter(f => 
      !plannedFiles.some(pf => f.includes(pf) || pf.includes(f))
    );

    // Files in plan but not changed
    const missedFiles = plannedFiles.filter(pf => 
      !changedFiles.some(f => f.includes(pf) || pf.includes(f))
    );

    return {
      changedFiles,
      plannedFiles,
      alignedFiles,
      unexpectedFiles,
      missedFiles,
      plannedSteps
    };
  };

  /**
   * Validates a diff against a plan.
   * @param {string} diff - Unified diff content
   * @param {string} planId - Plan ID to validate against
   * @returns {Promise<ValidationResult>}
   */
  const validate = async (diff, planId) => {
    const plan = _getPlan(planId);
    if (!plan) {
      throw new Error(`Plan not found: ${planId}`);
    }

    const hunks = parseDiff(diff);
    const analysis = _analyzeAlignment(hunks, plan.plan);

    // Build context for LLM analysis
    const diffSummary = hunks.map(h => ({
      file: h.filePath,
      added: h.additions.length,
      removed: h.deletions.length,
      sample: h.content.slice(0, 500)
    }));

    const prompt = `You are reviewing code changes against an implementation plan.

**Original Task:** ${plan.task}

**Planned Implementation Steps:**
${analysis.plannedSteps.map((s, i) => `${i + 1}. ${s.description || s}`).join('\n')}

**Planned Files to Modify:**
${analysis.plannedFiles.join('\n') || 'None specified'}

**Actual Changes:**
${diffSummary.map(d => `- ${d.file}: +${d.added}/-${d.removed} lines`).join('\n')}

**Files Changed But Not Planned:** ${analysis.unexpectedFiles.join(', ') || 'None'}
**Planned Files Not Changed:** ${analysis.missedFiles.join(', ') || 'None'}

**Diff Content (truncated):**
${hunks.slice(0, 5).map(h => `
--- ${h.filePath} ---
${h.content.slice(0, 300)}
`).join('\n')}

**Task:** Analyze how well the diff aligns with the plan. Provide:
1. An alignment score (0-100)
2. Which plan steps are covered by the diff
3. Which plan steps are missing
4. Any unexpected changes
5. Potential concerns

Return as JSON:
{
  "alignmentScore": number,
  "alignedSteps": [{"step": "description", "evidence": "what in diff covers this"}],
  "missedSteps": [{"step": "description", "importance": "high|medium|low"}],
  "unexpectedChanges": [{"file": "path", "concern": "why unexpected"}],
  "concerns": [{"type": "type", "description": "details", "severity": "high|medium|low"}],
  "summary": "Brief overall assessment"
}`;

    const response = await llmClient.chat(prompt);
    
    let result;
    try {
      result = JSON.parse(response);
    } catch {
      result = {
        alignmentScore: 50,
        alignedSteps: [],
        missedSteps: [],
        unexpectedChanges: [],
        concerns: [],
        summary: response
      };
    }

    return {
      id: `val_${Date.now()}`,
      isValid: result.alignmentScore >= 70,
      ...result,
      context: {
        planId,
        task: plan.task,
        hunksCount: hunks.length,
        filesChanged: analysis.changedFiles.length
      }
    };
  };

  return { isEnabled, parseDiff, validate };
}
