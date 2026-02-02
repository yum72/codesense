import fg from 'fast-glob';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {Object} FileEntry
 * @property {string} path
 * @property {string} hash
 * @property {number} size
 * @property {number} modifiedAt
 */

/**
 * @typedef {Object} ChangeSet
 * @property {FileEntry[]} added
 * @property {FileEntry[]} modified
 * @property {FileEntry[]} unchanged
 * @property {string[]} deleted
 */

/**
 * Creates a file scanner for discovering source files.
 * @param {Object} config - Scanner configuration
 * @param {string[]} [config.ignorePatterns] - Patterns to ignore
 * @param {number} [config.scanBatchSize=50] - Files to process per batch
 * @returns {Object} FileScanner API
 */
export function createFileScanner(config = {}) {
  const defaultIgnores = [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.git/**',
    '**/*.d.ts',
    '**/*.min.js',
    '**/coverage/**',
    '**/.DS_Store',
    '**/Thumbs.db'
  ];

  const ignorePatterns = config.ignorePatterns || defaultIgnores;
  const scanBatchSize = config.scanBatchSize || 50;

  /**
   * Loads .gitignore patterns and converts them to glob patterns.
   * @param {string} rootPath 
   * @returns {Promise<string[]>}
   */
  const _loadGitIgnore = async (rootPath) => {
    try {
      const gitignorePath = path.join(rootPath, '.gitignore');
      const content = await readFile(gitignorePath, 'utf-8');
      return content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => {
          if (line.startsWith('/')) return line.slice(1);
          if (line.endsWith('/')) return `**/${line}**`;
          return `**/${line}`;
        });
    } catch (e) {
      return [];
    }
  };

  /**
   * Processes a single file to extract metadata.
   * @param {string} filePath - Absolute path to the file
   * @returns {Promise<FileEntry>}
   * @private
   */
  const _processFile = async (filePath) => {
    const [content, stats] = await Promise.all([
      readFile(filePath), // Reading as buffer for hashing
      stat(filePath)
    ]);

    return {
      path: filePath,
      hash: createHash('sha256').update(content).digest('hex').slice(0, 16),
      size: stats.size,
      modifiedAt: Math.floor(stats.mtimeMs)
    };
  };

  /**
   * Scans directory for source files.
   * @param {string} rootPath - Root path to scan
   * @returns {Promise<FileEntry[]>}
   */
  const scan = async (rootPath) => {
    const gitIgnores = await _loadGitIgnore(rootPath);
    const combinedIgnores = [...new Set([...ignorePatterns, ...gitIgnores])];

    const files = await fg('**/*.{ts,tsx,js,jsx,mjs,cjs}', {
      cwd: rootPath,
      ignore: combinedIgnores,
      absolute: true,
      dot: false,
      onlyFiles: true
    });

    const entries = [];

    for (let i = 0; i < files.length; i += scanBatchSize) {
      const batch = files.slice(i, i + scanBatchSize);
      const results = await Promise.all(batch.map(p => _processFile(p)));
      entries.push(...results);
    }

    return entries;
  };

  /**
   * Detects changes between scanned files and existing file hashes.
   * 
   * This is a PURE function - it takes data in and returns data out,
   * with no database access. The caller is responsible for fetching
   * existing hashes from the database.
   * 
   * @param {Map<string, string>} existingHashes - Map of path -> hash from database
   * @param {FileEntry[]} entries - Scanned file entries
   * @returns {ChangeSet}
   */
  const detectChanges = (existingHashes, entries) => {
    const added = [];
    const modified = [];
    const unchanged = [];
    const deleted = [];

    // Track which paths we've seen in the scan
    const scannedPaths = new Set();

    for (const entry of entries) {
      scannedPaths.add(entry.path);
      const existingHash = existingHashes.get(entry.path);
      
      if (!existingHash) {
        added.push(entry);
      } else if (existingHash !== entry.hash) {
        modified.push(entry);
      } else {
        unchanged.push(entry);
      }
    }

    // Any path in existingHashes that wasn't scanned is deleted
    for (const existingPath of existingHashes.keys()) {
      if (!scannedPaths.has(existingPath)) {
        deleted.push(existingPath);
      }
    }

    return { added, modified, unchanged, deleted };
  };

  /**
   * Convenience method: scan and detect changes in one call.
   * Still requires existingHashes to be passed in (no DB access).
   * 
   * @param {string} rootPath - Root path to scan
   * @param {Map<string, string>} existingHashes - Map of path -> hash from database
   * @returns {Promise<{entries: FileEntry[], changes: ChangeSet}>}
   */
  const scanWithChanges = async (rootPath, existingHashes) => {
    const entries = await scan(rootPath);
    const changes = detectChanges(existingHashes, entries);
    return { entries, changes };
  };

  return { 
    scan, 
    detectChanges,
    scanWithChanges
  };
}
