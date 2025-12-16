import fg from 'fast-glob';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Scans the file system and detects changes.
 */
export class CodebaseScanner {
  /**
   * @param {import('../db/adapter').SQLiteAdapter} db 
   * @param {string} rootPath 
   */
  constructor(db, rootPath) {
    this.db = db;
    this.rootPath = rootPath;
  }

  async scan() {
    console.log(`🔍 Scanning directory: ${this.rootPath}...`);

    // 1. Get Ignore Patterns (Defaults + User's .gitignore)
    const ignorePatterns = await this._getIgnorePatterns();

    // 2. Find all relevant code files using fast-glob
    const entries = await fg('**/*.{js,jsx,ts,tsx,py,go,rs,java,c,cpp,md,json}', {
      cwd: this.rootPath,
      ignore: ignorePatterns,
      absolute: true,
      onlyFiles: true,
      stats: true, 
    });

    const changedFiles = [];
    const activeFilePaths = new Set();

    // 3. Process files
    for (const entry of entries) {
      activeFilePaths.add(entry.path);

      try {
        const content = await fs.readFile(entry.path);
        const hash = crypto.createHash('sha256').update(content).digest('hex');

        // Upsert into DB
        const { changed } = this.db.upsertFile(entry.path, hash);

        if (changed) {
          changedFiles.push(entry.path);
        }
      } catch (err) {
        console.warn(`⚠️ Error processing file ${entry.path}:`, err.message);
      }
    }

    // 4. Cleanup deleted files
    this.db.removeDeletedFiles(activeFilePaths);

    console.log(`✅ Scan complete.`);
    console.log(`   Total files tracked: ${entries.length}`);
    console.log(`   Files changed/new (Tier 1 Pending): ${changedFiles.length}`);

    return changedFiles;
  }

  /**
   * Loads the user's .gitignore and merges it with system defaults.
   * This ensures we don't index things the user explicitly excluded.
   */
  async _getIgnorePatterns() {
    const defaultIgnores = [
      // 📦 Dependencies & Build Artifacts
      '**/node_modules/**', 
      '**/dist/**', 
      '**/build/**',
      '**/out/**',
      
      // ⚙️ Version Control & IDE Settings
      '**/.git/**', 
      '**/.vscode/**',
      '**/.idea/**',
      
      // 🧪 Testing & Logs
      '**/coverage/**',
      '**/*.log',
      '**/npm-debug.log*',
      '**/yarn-error.log*',
      
      // 🖥️ System Files
      '**/.DS_Store',
      '**/Thumbs.db',
      
      // 🔒 Config & Secrets (Security)
      '**/.env',
      '**/.env.*',
      
      // 📝 User Specific
      '**/docs/**',      // Ignored: Ideas and scratchpad
      
      // 💽 Self-Reference (Database)
      '**/*.db',         
      '**/*.db-wal',
      '**/*.db-shm'
    ];

    try {
      const gitIgnorePath = path.join(this.rootPath, '.gitignore');
      const content = await fs.readFile(gitIgnorePath, 'utf-8');
      
      const userIgnores = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#')) // Remove empty lines & comments
        .map(line => {
          // Convert .gitignore syntax to fast-glob syntax
          // 1. Remove leading slash (anchored to root) -> relative in glob
          // 2. If no slash, prepend **/ to match recursively
          if (line.startsWith('/')) {
            return line.slice(1); 
          }
          return `**/${line}`;
        });
        
      console.log(`📄 Loaded ${userIgnores.length} patterns from .gitignore`);
      // Combine and deduplicate
      return [...new Set([...defaultIgnores, ...userIgnores])];
    } catch (e) {
      // If no .gitignore exists, just use defaults
      return defaultIgnores;
    }
  }
}