import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/**
 * Manages SQLite connection and data persistence.
 */
export class SQLiteAdapter {
  constructor(dbPath = 'codesense.db') {
    this.db = new Database(dbPath);
    
    // Load the vector extension for future Tier 2 usage
    sqliteVec.load(this.db);
    
    // Performance optimizations (Crucial for local-first apps)
    // WAL mode allows concurrent readers and prevents blocking
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    this.initSchema();
  }

  /**
   * Initialize the database tables if they don't exist.
   */
  initSchema() {
    this.db.exec(`
      -- 1. Metadata: Tracks file state (Tier 0)
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        hash TEXT NOT NULL,
        last_processed_at INTEGER,
        tier INTEGER DEFAULT 0 -- 0=Scanned, 1=Parsed, 2=Embedded
      );

      -- 2. Definitions: Tracks symbols like functions/classes (Tier 1)
      CREATE TABLE IF NOT EXISTS definitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
      );

      -- 3. Embeddings: Vector storage (Tier 2)
      -- Using vec0 virtual table from sqlite-vec
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(
        embedding float[1536]
      );
    `);
  }

  /**
   * Insert or Update a file record.
   * Checks the hash to decide if processing is needed.
   * * @param {string} path - Absolute path to the file
   * @param {string} hash - SHA-256 hash of file content
   * @returns {{ id: number, changed: boolean }}
   */
  upsertFile(path, hash) {
    // Check if file exists
    const existing = this.db.prepare('SELECT id, hash FROM files WHERE path = ?').get(path);

    if (existing) {
      if (existing.hash === hash) {
        // Content hasn't changed, no action needed
        return { id: existing.id, changed: false };
      }
      
      // File changed: Update hash, timestamp, and reset tier to 0 (needs re-parsing)
      this.db.prepare(`
        UPDATE files 
        SET hash = ?, last_processed_at = ?, tier = 0 
        WHERE id = ?
      `).run(hash, Date.now(), existing.id);
      
      return { id: existing.id, changed: true };
    }

    // New file: Insert record
    const result = this.db.prepare(`
      INSERT INTO files (path, hash, last_processed_at, tier)
      VALUES (?, ?, ?, 0)
    `).run(path, hash, Date.now());
    
    return { id: result.lastInsertRowid, changed: true };
  }

  /**
   * Cleanup logic: Remove files from DB that were not seen in the current scan.
   * @param {Set<string>} activePaths - List of all paths found on disk right now
   */
  removeDeletedFiles(activePaths) {
    if (activePaths.size === 0) return;

    // TODO: For very large codebases (10k+ files), passing a Set to SQL is inefficient.
    // In Phase 2, we will implement a "scan_id" logic to efficiently sweep deleted files.
    // For now, we rely on the fact that 'upsertFile' keeps the active ones up to date.
    // A simple approach for small repos:
    
    // Fetch all DB paths
    const allDbFiles = this.db.prepare('SELECT path FROM files').all();
    
    const deleteStmt = this.db.prepare('DELETE FROM files WHERE path = ?');
    
    const tx = this.db.transaction(() => {
        for (const row of allDbFiles) {
            if (!activePaths.has(row.path)) {
                console.log(`🗑️ Removing deleted file: ${row.path}`);
                deleteStmt.run(row.path);
            }
        }
    });
    
    tx();
  }
  
  close() {
      this.db.close();
  }
}