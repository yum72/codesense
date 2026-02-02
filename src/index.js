import path from 'node:path';
import { createMemgraphAdapter } from './db/memgraph-adapter.js';
import { createIndexManager } from './indexing/index-manager.js';
import { loadConfig } from './utils/config.js';
import { createCodeSenseServer } from './mcp/server.js';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const targetDir = args[1] ? path.resolve(args[1]) : process.cwd();

  // Load configuration
  const { effectiveConfig, warnings } = loadConfig({ startDir: targetDir });
  
  if (warnings.length > 0) {
    console.error('Configuration warnings:');
    warnings.forEach(w => console.error(`  - ${w}`));
  }

  if (command === 'mcp') {
    // MCP server mode - full server with all tools
    const server = await createCodeSenseServer(targetDir, effectiveConfig);
    await server.start();
    return;
  }

  if (command === 'scan') {
    // Scan mode - index the codebase
    console.log(`🔍 Scanning ${targetDir}...`);
    
    // Initialize Memgraph
    const schemaPath = path.join(__dirname, 'db', 'schema.cypher');
    const db = createMemgraphAdapter(effectiveConfig.memgraph, {
      batchSize: effectiveConfig.indexing.dbBatchSize
    });
    
    // Verify connection
    const connected = await db.verifyConnection();
    if (!connected) {
      console.error('❌ Failed to connect to Memgraph. Is it running?');
      console.error('   Start with: docker-compose up -d memgraph');
      process.exit(1);
    }
    console.log('✅ Connected to Memgraph');
    
    // Initialize schema
    await db.initSchema(schemaPath);
    console.log('✅ Schema initialized');
    
    // Run indexing
    const indexManager = await createIndexManager(db, effectiveConfig);
    const result = await indexManager.runIndexing(targetDir);
    
    // Get stats
    const stats = await db.getStats();
    
    console.log(`\n✅ Indexing complete.`);
    console.log(`   Files: ${stats.files?.total || 0}`);
    console.log(`   Chunks: ${stats.chunks?.total || 0}`);
    console.log(`   IMPORTS edges: ${stats.edges?.IMPORTS || 0}`);
    console.log(`   CALLS edges: ${stats.edges?.CALLS || 0}`);
    console.log(`   CONTAINS edges: ${stats.edges?.CONTAINS || 0}`);
    
    await db.close();
    return;
  }

  // Show usage
  console.log('CodeSense - AI-powered codebase understanding engine\n');
  console.log('Usage:');
  console.log('  node src/index.js scan [/path/to/project]  - Scan and index the project');
  console.log('  node src/index.js mcp [/path/to/project]   - Start the MCP server');
  console.log('\nPrerequisites:');
  console.log('  - Memgraph running: docker-compose up -d memgraph');
  console.log('  - Optional: Memgraph Lab UI at http://localhost:3000');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
