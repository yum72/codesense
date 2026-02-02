import { createDatabaseAdapter } from './src/db/adapter.js';
import path from 'node:path';

const db = createDatabaseAdapter(path.join(process.cwd(), 'codesense.db'));

console.log('--- Files ---');
console.table(db.prepare('SELECT id, path, indexed_tier, fan_in, fan_out FROM files').all());

console.log('--- Definitions ---');
console.table(db.prepare('SELECT id, file_id, name, type FROM definitions').all());

console.log('--- Relationships ---');
console.table(db.prepare('SELECT * FROM relationships').all());

db.close();
