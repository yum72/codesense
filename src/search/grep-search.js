import { rgPath } from '@vscode/ripgrep';
import { spawn } from 'node:child_process';

/**
 * @typedef {Object} GrepResult
 * @property {string} path - File path
 * @property {number} line - Line number
 * @property {string} text - Matching line text
 * @property {string} [before] - Context before match
 * @property {string} [after] - Context after match
 */

/**
 * @typedef {Object} GrepSearchOptions
 * @property {number} [limit=50] - Maximum number of results
 * @property {boolean} [caseSensitive=false] - Case-sensitive search
 * @property {boolean} [wholeWord=false] - Match whole words only
 * @property {number} [contextLines=0] - Lines of context before/after match
 * @property {string[]} [fileTypes] - File extensions to include (e.g., ['js', 'ts'])
 */

/**
 * Creates a grep search engine using @vscode/ripgrep.
 * Respects .gitignore by default, searches whole codebase.
 * 
 * @param {string} rootPath - Root path to search
 * @returns {Object} Grep Search API
 */
export function createGrepSearch(rootPath) {
  /**
   * Searches for a pattern in the codebase using ripgrep.
   * 
   * @param {string} pattern - Regex pattern to search for
   * @param {GrepSearchOptions} [options={}] - Search options
   * @returns {Promise<GrepResult[]>} Search results
   */
  const search = async (pattern, options = {}) => {
    const {
      limit = 50,
      caseSensitive = false,
      wholeWord = false,
      contextLines = 0,
      fileTypes = null
    } = options;

    return new Promise((resolve) => {
      const args = [
        '--json',           // JSON output for structured parsing
        '--no-heading',     // Don't group by file
        '--line-number',    // Include line numbers
        '--max-count', String(limit * 2),  // Limit matches (buffer for filtering)
      ];

      // Case sensitivity
      if (!caseSensitive) {
        args.push('--ignore-case');
      }

      // Whole word matching
      if (wholeWord) {
        args.push('--word-regexp');
      }

      // Context lines
      if (contextLines > 0) {
        args.push('--context', String(contextLines));
      }

      // File type filter
      if (fileTypes && fileTypes.length > 0) {
        for (const ext of fileTypes) {
          args.push('--glob', `**/*.${ext}`);
        }
      }

      // The pattern and path
      args.push(pattern, rootPath);

      const results = [];
      let stderr = '';

      const rg = spawn(rgPath, args, {
        cwd: rootPath,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      rg.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            
            if (parsed.type === 'match') {
              const match = parsed.data;
              results.push({
                path: match.path.text,
                line: match.line_number,
                text: match.lines.text.trim(),
                submatches: match.submatches?.map(s => ({
                  text: s.match.text,
                  start: s.start,
                  end: s.end
                }))
              });
            }
          } catch (e) {
            // Skip malformed JSON lines
          }
        }
      });

      rg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      rg.on('close', (code) => {
        // ripgrep returns 1 for no matches, 0 for matches found
        if (code === 0 || code === 1) {
          resolve(results.slice(0, limit));
        } else {
          console.warn('ripgrep error:', stderr);
          resolve([]); // Return empty on error rather than failing
        }
      });

      rg.on('error', (err) => {
        console.warn('ripgrep spawn error:', err.message);
        resolve([]); // Graceful fallback
      });
    });
  };

  /**
   * Searches for a literal string (not regex).
   * Faster than regex search for exact matches.
   * 
   * @param {string} literal - Literal string to search for
   * @param {GrepSearchOptions} [options={}] - Search options
   * @returns {Promise<GrepResult[]>} Search results
   */
  const searchLiteral = async (literal, options = {}) => {
    const {
      limit = 50,
      caseSensitive = false,
      wholeWord = false,
      contextLines = 0,
      fileTypes = null
    } = options;

    return new Promise((resolve) => {
      const args = [
        '--json',
        '--no-heading',
        '--line-number',
        '--fixed-strings',  // Literal string, not regex
        '--max-count', String(limit * 2),
      ];

      if (!caseSensitive) {
        args.push('--ignore-case');
      }

      if (wholeWord) {
        args.push('--word-regexp');
      }

      if (contextLines > 0) {
        args.push('--context', String(contextLines));
      }

      if (fileTypes && fileTypes.length > 0) {
        for (const ext of fileTypes) {
          args.push('--glob', `**/*.${ext}`);
        }
      }

      args.push(literal, rootPath);

      const results = [];

      const rg = spawn(rgPath, args, {
        cwd: rootPath,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      rg.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            
            if (parsed.type === 'match') {
              const match = parsed.data;
              results.push({
                path: match.path.text,
                line: match.line_number,
                text: match.lines.text.trim()
              });
            }
          } catch (e) {
            // Skip malformed JSON
          }
        }
      });

      rg.on('close', (code) => {
        if (code === 0 || code === 1) {
          resolve(results.slice(0, limit));
        } else {
          resolve([]);
        }
      });

      rg.on('error', () => {
        resolve([]);
      });
    });
  };

  /**
   * Searches for references to a symbol name.
   * Optimized for finding usages of functions, classes, variables.
   * 
   * @param {string} symbolName - Symbol name to find
   * @param {GrepSearchOptions} [options={}] - Search options
   * @returns {Promise<GrepResult[]>} Search results
   */
  const searchSymbol = async (symbolName, options = {}) => {
    // Use word boundary matching for symbol searches
    return search(`\\b${escapeRegex(symbolName)}\\b`, {
      ...options,
      caseSensitive: true  // Symbol names are case-sensitive
    });
  };

  /**
   * Escapes special regex characters in a string.
   * @param {string} str 
   * @returns {string}
   */
  const escapeRegex = (str) => {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  return { 
    search, 
    searchLiteral, 
    searchSymbol,
    escapeRegex
  };
}
