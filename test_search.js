import { createDatabaseAdapter } from './src/db/adapter.js';
import { createEmbedder } from './src/indexing/embedder.js';
import { createSemanticSearch } from './src/search/semantic-search.js';
import { loadConfig } from './src/utils/config.js';
import path from 'node:path';

async function testSearch() {
  const config = loadConfig();
  const db = createDatabaseAdapter(path.join(process.cwd(), 'codesense.db'));
  const embedder = await createEmbedder(config);
  const semanticSearch = createSemanticSearch(db, embedder);

  const query = "main entry point";
  console.log(`🔎 Searching for: "${query}"`);
  const results = await semanticSearch.search(query);
  console.table(results);

  db.close();
}

testSearch().catch(console.error);
