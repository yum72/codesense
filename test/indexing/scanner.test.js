import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFileScanner } from '../../src/indexing/scanner.js';
import { createDatabaseAdapter } from '../../src/db/adapter.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootPath = path.resolve(__dirname, '../../test/fixtures/project1');
const dbPath = path.join(__dirname, 'test.db');
const schemaPath = path.resolve(__dirname, '../../src/db/schema.sql');

describe('FileScanner', () => {
  let db;
  let scanner;

  beforeEach(() => {
    db = createDatabaseAdapter(dbPath);
    db.initSchema(schemaPath);
    scanner = createFileScanner();
  });

  afterEach(async () => {
    db.close();
    try {
      await fs.unlink(dbPath);
      await fs.unlink(`${dbPath}-wal`);
      await fs.unlink(`${dbPath}-shm`);
    } catch (e) {
      // Ignore
    }
  });

  describe('scan', () => {
    it('should scan files in a directory', async () => {
      const entries = await scanner.scan(rootPath);
      expect(entries.length).toBe(2);
      expect(entries.map(e => path.basename(e.path))).toContain('main.js');
      expect(entries.map(e => path.basename(e.path))).toContain('utils.js');
    });

    it('should return file entries with hash, size, and modifiedAt', async () => {
      const entries = await scanner.scan(rootPath);
      for (const entry of entries) {
        expect(entry).toHaveProperty('path');
        expect(entry).toHaveProperty('hash');
        expect(entry).toHaveProperty('size');
        expect(entry).toHaveProperty('modifiedAt');
        expect(typeof entry.hash).toBe('string');
        expect(entry.hash.length).toBe(16);
        expect(typeof entry.size).toBe('number');
        expect(typeof entry.modifiedAt).toBe('number');
      }
    });

    it('should respect custom batch size', async () => {
      const customScanner = createFileScanner({ scanBatchSize: 1 });
      const entries = await customScanner.scan(rootPath);
      expect(entries.length).toBe(2);
    });
  });

  describe('detectChanges (pure function)', () => {
    it('should detect all files as added when existing hashes is empty', async () => {
      const entries = await scanner.scan(rootPath);
      const existingHashes = new Map();
      
      const changes = scanner.detectChanges(existingHashes, entries);
      
      expect(changes.added.length).toBe(2);
      expect(changes.modified.length).toBe(0);
      expect(changes.deleted.length).toBe(0);
      expect(changes.unchanged.length).toBe(0);
    });

    it('should detect no changes when hashes match', async () => {
      const entries = await scanner.scan(rootPath);
      
      // Create a Map with matching hashes
      const existingHashes = new Map(
        entries.map(e => [e.path, e.hash])
      );
      
      const changes = scanner.detectChanges(existingHashes, entries);
      
      expect(changes.added.length).toBe(0);
      expect(changes.modified.length).toBe(0);
      expect(changes.deleted.length).toBe(0);
      expect(changes.unchanged.length).toBe(2);
    });

    it('should detect modified files when hashes differ', async () => {
      const entries = await scanner.scan(rootPath);
      
      // Create a Map with different hashes
      const existingHashes = new Map(
        entries.map(e => [e.path, 'different_hash_xx'])
      );
      
      const changes = scanner.detectChanges(existingHashes, entries);
      
      expect(changes.added.length).toBe(0);
      expect(changes.modified.length).toBe(2);
      expect(changes.deleted.length).toBe(0);
      expect(changes.unchanged.length).toBe(0);
    });

    it('should detect deleted files not in scan results', async () => {
      const entries = await scanner.scan(rootPath);
      
      // Create a Map with extra files that don't exist
      const existingHashes = new Map([
        ...entries.map(e => [e.path, e.hash]),
        ['/fake/path/deleted.js', 'some_hash_12345']
      ]);
      
      const changes = scanner.detectChanges(existingHashes, entries);
      
      expect(changes.added.length).toBe(0);
      expect(changes.modified.length).toBe(0);
      expect(changes.deleted.length).toBe(1);
      expect(changes.deleted[0]).toBe('/fake/path/deleted.js');
      expect(changes.unchanged.length).toBe(2);
    });

    it('should handle mixed changes', async () => {
      const entries = await scanner.scan(rootPath);
      
      // One matching, one different hash, one deleted
      const existingHashes = new Map([
        [entries[0].path, entries[0].hash], // unchanged
        [entries[1].path, 'different_hash_xx'], // modified
        ['/fake/path/old.js', 'old_hash_123456'] // deleted
      ]);
      
      const changes = scanner.detectChanges(existingHashes, entries);
      
      expect(changes.added.length).toBe(0);
      expect(changes.modified.length).toBe(1);
      expect(changes.deleted.length).toBe(1);
      expect(changes.unchanged.length).toBe(1);
    });
  });

  describe('scanWithChanges', () => {
    it('should scan and detect changes in one call', async () => {
      const existingHashes = new Map();
      
      const { entries, changes } = await scanner.scanWithChanges(rootPath, existingHashes);
      
      expect(entries.length).toBe(2);
      expect(changes.added.length).toBe(2);
      expect(changes.modified.length).toBe(0);
      expect(changes.deleted.length).toBe(0);
    });
  });

  describe('integration with DB adapter', () => {
    it('should work with db.getAllFileHashes()', async () => {
      // First scan - populate DB
      const entries = await scanner.scan(rootPath);
      db.upsertFiles(entries);
      
      // Get hashes from DB using adapter method
      const existingHashes = db.getAllFileHashes();
      
      // Second scan - detect no changes
      const entries2 = await scanner.scan(rootPath);
      const changes = scanner.detectChanges(existingHashes, entries2);
      
      expect(changes.added.length).toBe(0);
      expect(changes.modified.length).toBe(0);
      expect(changes.unchanged.length).toBe(2);
    });
  });
});
