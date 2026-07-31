# CodeSense configuration reference

Every key, its default, and what it does. Copy
`codesense.config.example.json` to `codesense.config.json` to start.

## Configuration Reference

### Full Configuration Options

```json
{
  "memgraph": {
    "url": "bolt://localhost:7687",
    "username": "",
    "password": "",
    "database": "memgraph"
  },
  "indexing": {
    "enabled": true,
    "maxTier": 2,
    "scanBatchSize": 50,
    "dbBatchSize": 100,
    "maxFileSizeKb": 500,
    "ignoredDirs": ["node_modules", "dist", ".git", "build", "out", "coverage"]
  },
  "enrichment": {
    "enabled": true,
    "backgroundQueue": true,
    "onDemand": true,
    "dailyLimit": 1000,
    "batchSize": 5,
    "maxRetries": 3
  },
  "researchAgent": {
    "enabled": true,
    "maxToolCalls": 12,
    "maxDepth": 2,
    "maxFilesPerHop": 5
  },
  "graphAnalytics": {
    "computePageRank": true,
    "computeCommunities": true,
    "pageRankDamping": 0.85
  },
  "search": {
    "semantic": true,
    "structural": true,
    "grep": true,
    "queryUnderstanding": true,
    "defaultLimit": 10,
    "maxContextTokens": 8000
  },
  "planning": {
    "enabled": true,
    "persistence": true,
    "bugInvestigator": true,
    "diffValidator": true
  },
  "llm": {
    "enabled": true,
    "provider": "openrouter",
    "apiKey": null,
    "baseUrl": null,
    "model": "anthropic/claude-3-haiku",
    "embeddingModel": "Xenova/all-MiniLM-L6-v2",
    "embeddingDimension": 384
  },
  "logging": {
    "level": "info",
    "verbose": false
  }
}
```

### Configuration Options Explained

#### memgraph

| Option | Default | Description |
|--------|---------|-------------|
| `url` | `"bolt://localhost:7687"` | Memgraph Bolt connection URL |
| `username` | `""` | Database username (optional) |
| `password` | `""` | Database password (optional) |
| `database` | `"memgraph"` | Database name |

#### indexing

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable indexing entirely |
| `maxTier` | `2` | Maximum indexing tier (0=files, 1=AST, 2=embeddings) |
| `scanBatchSize` | `50` | Files to hash per batch |
| `dbBatchSize` | `100` | Rows per database transaction |
| `maxFileSizeKb` | `500` | Skip files larger than this |
| `ignoredDirs` | `[...]` | Directories to ignore |

#### enrichment

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable LLM enrichment |
| `backgroundQueue` | `true` | Process enrichment in background |
| `onDemand` | `true` | Allow sync enrichment requests |
| `dailyLimit` | `1000` | Max LLM calls per day |
| `batchSize` | `5` | Chunks to enrich per batch |
| `maxRetries` | `3` | Retry attempts on failure |

#### search

| Option | Default | Description |
|--------|---------|-------------|
| `semantic` | `true` | Enable vector similarity search |
| `structural` | `true` | Enable AST-based lookups |
| `grep` | `true` | Enable regex pattern matching |
| `queryUnderstanding` | `true` | Use LLM to classify queries |
| `defaultLimit` | `10` | Default result limit |
| `maxContextTokens` | `8000` | Max tokens in assembled context |

#### planning

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable plan generation |
| `persistence` | `true` | Save plans to database |
| `bugInvestigator` | `true` | Enable bug investigation |
| `diffValidator` | `true` | Enable diff validation |

#### researchAgent

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable Research Agent for enrichment |
| `maxToolCalls` | `12` | Max tool calls per research session |
| `maxDepth` | `2` | Max hops through call graph |
| `maxFilesPerHop` | `5` | Max files to explore per hop |
| `maxGrepResults` | `50` | Max grep search results per call |

**Research Agent Tools**: The agent can use these tools during research:
- `read_chunk(id)` - Read full code of a chunk
- `get_callers(id, depth)` - Find what calls this chunk
- `get_callees(id, depth)` - Find what this chunk calls
- `get_file_siblings(id)` - Get other chunks in the same file
- `search_similar(query, limit)` - Semantic search for related code
- `search_grep(pattern, limit)` - Grep for literal patterns (event names, string invocations, magic strings)

#### graphAnalytics

| Option | Default | Description |
|--------|---------|-------------|
| `computePageRank` | `true` | Compute PageRank for hub detection |
| `computeCommunities` | `true` | Detect code communities/clusters |
| `pageRankDamping` | `0.85` | PageRank damping factor |

#### llm

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable LLM features |
| `provider` | `"openrouter"` | LLM provider (openrouter, openai, ollama, custom) |
| `apiKey` | `null` | API key (or use `LLM_API_KEY` env var) |
| `baseUrl` | `null` | Custom API endpoint |
| `model` | `"anthropic/claude-3-haiku"` | Model to use |
| `embeddingModel` | `"Xenova/all-MiniLM-L6-v2"` | Local embedding model |
| `embeddingDimension` | `384` | Embedding vector size |

### Preset Configurations

#### Minimal (No LLM, grep only)

```json
{
  "indexing": { "maxTier": 0 },
  "llm": { "enabled": false },
  "search": { "semantic": false, "structural": false },
  "enrichment": { "enabled": false },
  "planning": { "enabled": false }
}
```

#### AST Only (Structural search, no embeddings)

```json
{
  "indexing": { "maxTier": 1 },
  "search": { "semantic": false },
  "llm": { "enabled": true }
}
```

#### Full (All features)

Use defaults or create an empty config file.

---

