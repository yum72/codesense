/**
 * @typedef {Object} QueryUnderstanding
 * @property {string} intent - find_implementation, find_usage, explain, find_definition, find_pattern
 * @property {string[]} keywords - Extracted keywords
 * @property {string[]} suggestedMethods - semantic, structural, graph, grep
 * @property {string|null} targetSymbol - Extracted symbol name if detected
 * @property {Object} modifiers - Additional query modifiers
 */

/**
 * @typedef {Object} QueryUnderstandingEngine
 * @property {function(string): QueryUnderstanding} classify
 */

/**
 * Creates a query understanding engine for intent classification.
 * Analyzes natural language queries to determine search strategy.
 * 
 * @returns {QueryUnderstandingEngine}
 */
export function createQueryUnderstandingEngine() {
  // Intent patterns
  const intentPatterns = {
    find_usage: [
      /who calls/i,
      /where is .* used/i,
      /what uses/i,
      /callers of/i,
      /references to/i,
      /usages of/i
    ],
    find_definition: [
      /where is .* defined/i,
      /definition of/i,
      /find .* function/i,
      /find .* class/i,
      /locate .* implementation/i
    ],
    explain: [
      /explain/i,
      /how does .* work/i,
      /what does .* do/i,
      /describe/i,
      /understand/i
    ],
    find_pattern: [
      /where do we/i,
      /how do we/i,
      /pattern for/i,
      /example of/i,
      /similar to/i
    ],
    find_implementation: [
      /implement/i,
      /handle/i,
      /process/i,
      /where.*logic/i
    ]
  };

  // Keywords that suggest graph-based search
  const graphKeywords = [
    'calls', 'imports', 'depends', 'uses', 'extends', 
    'implements', 'references', 'callers', 'callees'
  ];

  // Keywords that suggest grep/structural search
  const structuralKeywords = [
    'function', 'class', 'interface', 'type', 'const',
    'export', 'import', 'async', 'await'
  ];

  /**
   * Extracts potential symbol names from query.
   * Looks for quoted strings, backticks, or camelCase/PascalCase words.
   * @param {string} query
   * @returns {string|null}
   * @private
   */
  const _extractSymbol = (query) => {
    // Check for backtick-wrapped symbols
    const backtickMatch = query.match(/`([^`]+)`/);
    if (backtickMatch) return backtickMatch[1];

    // Check for quoted strings
    const quoteMatch = query.match(/["']([^"']+)["']/);
    if (quoteMatch) return quoteMatch[1];

    // Look for camelCase or PascalCase words (likely function/class names)
    const camelCaseMatch = query.match(/\b([a-z]+[A-Z][a-zA-Z]*|[A-Z][a-z]+[A-Z][a-zA-Z]*)\b/);
    if (camelCaseMatch) return camelCaseMatch[1];

    // Look for underscore_case
    const snakeCaseMatch = query.match(/\b([a-z]+_[a-z_]+)\b/);
    if (snakeCaseMatch) return snakeCaseMatch[1];

    return null;
  };

  /**
   * Extracts keywords from query.
   * Filters out common stop words.
   * @param {string} query
   * @returns {string[]}
   * @private
   */
  const _extractKeywords = (query) => {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
      'would', 'could', 'should', 'may', 'might', 'must', 'shall',
      'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
      'from', 'as', 'into', 'through', 'during', 'before', 'after',
      'above', 'below', 'between', 'under', 'again', 'further',
      'then', 'once', 'here', 'there', 'when', 'where', 'why',
      'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some',
      'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
      'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or',
      'because', 'until', 'while', 'this', 'that', 'these', 'those',
      'what', 'which', 'who', 'whom', 'find', 'show', 'get', 'me'
    ]);

    return query
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word));
  };

  /**
   * Determines which search methods to use.
   * @param {string} query
   * @param {string} intent
   * @returns {string[]}
   * @private
   */
  const _suggestMethods = (query, intent) => {
    const methods = [];
    const lowerQuery = query.toLowerCase();

    // Always include semantic for natural language understanding
    methods.push('semantic');

    // Check for graph-related keywords
    if (graphKeywords.some(kw => lowerQuery.includes(kw))) {
      methods.push('graph');
    }

    // Check for structural keywords
    if (structuralKeywords.some(kw => lowerQuery.includes(kw))) {
      methods.push('structural');
    }

    // Intent-based method selection
    if (intent === 'find_usage') {
      if (!methods.includes('graph')) methods.push('graph');
    }

    if (intent === 'find_definition') {
      if (!methods.includes('structural')) methods.push('structural');
      methods.push('grep');
    }

    // If we have a specific symbol, grep is useful
    const symbol = _extractSymbol(query);
    if (symbol && !methods.includes('grep')) {
      methods.push('grep');
    }

    return methods;
  };

  /**
   * Extracts query modifiers.
   * @param {string} query
   * @returns {Object}
   * @private
   */
  const _extractModifiers = (query) => {
    const modifiers = {
      limit: null,
      filePattern: null,
      excludeTests: false,
      recentOnly: false
    };

    // Check for limit
    const limitMatch = query.match(/(?:top|first|limit)\s+(\d+)/i);
    if (limitMatch) modifiers.limit = parseInt(limitMatch[1], 10);

    // Check for file pattern
    const inMatch = query.match(/in\s+(\S+\.\w+)/i);
    if (inMatch) modifiers.filePattern = inMatch[1];

    // Check for test exclusion
    if (/exclude.*test|no.*test|without.*test/i.test(query)) {
      modifiers.excludeTests = true;
    }

    // Check for recency
    if (/recent|lately|new|latest/i.test(query)) {
      modifiers.recentOnly = true;
    }

    return modifiers;
  };

  /**
   * Classifies a query and extracts understanding.
   * @param {string} query
   * @returns {QueryUnderstanding}
   */
  const classify = (query) => {
    // Determine intent
    let intent = 'find_implementation'; // default

    for (const [intentName, patterns] of Object.entries(intentPatterns)) {
      if (patterns.some(pattern => pattern.test(query))) {
        intent = intentName;
        break;
      }
    }

    const keywords = _extractKeywords(query);
    const targetSymbol = _extractSymbol(query);
    const suggestedMethods = _suggestMethods(query, intent);
    const modifiers = _extractModifiers(query);

    return {
      intent,
      keywords,
      targetSymbol,
      suggestedMethods,
      modifiers
    };
  };

  return { classify };
}
