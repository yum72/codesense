import path from 'node:path';
import { SQLiteAdapter } from './db/adapter.js';
import { CodebaseScanner } from './core/scanner.js';

async function main() {
  // 1. Parse arguments (default to current directory)
  const args = process.argv.slice(2);
  const targetDir = args[0] ? path.resolve(args[0]) : process.cwd();

  console.log('🚀 Starting CodeSense...');

  // 2. Initialize Database
  const db = new SQLiteAdapter();
  
  // 3. Run Scanner (Tier 0)
  const scanner = new CodebaseScanner(db, targetDir);
  
  try {
    const changedFiles = await scanner.scan();

    // 4. Future: Pass changedFiles to Tier 1 Parser
    if (changedFiles.length > 0) {
      console.log('📝 Next Step: These files would be sent to Tree-sitter for parsing.');
      // await parser.parseFiles(changedFiles);
    } else {
      console.log('✨ No changes detected. Index is up to date.');
    }

  } catch (error) {
    console.error('❌ Application Error:', error);
  } finally {
    // Ideally keep the DB open if building a server, but close for CLI one-off run
    // db.close(); 
  }
}

main();