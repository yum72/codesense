# CodeSense usage examples

Worked examples of the MCP tools in a real session.

## Example Usage

### Example 1: Understanding a New Codebase

```
You: I just cloned this project. Can you help me understand the architecture?

Claude: I'll search the codebase to understand its structure.

[Calls search_codebase with query "main entry point application setup"]
[Calls get_index_status to see what's indexed]

Based on my search, this is a Node.js application with:
- Entry point at `src/index.js`
- MCP server implementation in `src/mcp/server.js`
- Layered architecture with indexing, search, planning, and enrichment modules
- SQLite database for persistence

The main components are:
1. **Indexing** (`src/indexing/`) - Scans and parses code
2. **Search** (`src/search/`) - Multi-method code search
3. **Planning** (`src/planning/`) - Implementation plan generation
4. **Enrichment** (`src/enrichment/`) - LLM-powered code analysis
```

### Example 2: Planning a Feature

```
You: I want to add rate limiting to the API endpoints. Can you create a plan?

Claude: I'll generate an implementation plan for this feature.

[Calls generate_plan with task "Add rate limiting to API endpoints" mode "thorough"]

Here's the implementation plan:

## Rate Limiting Implementation

### Files to Modify
1. `src/mcp/server.js` - Add rate limiting middleware
2. `src/utils/config.js` - Add rate limit configuration options

### Implementation Steps

1. **Add rate limiting configuration**
   - Add `rateLimit.enabled`, `rateLimit.windowMs`, `rateLimit.maxRequests` to config schema
   
2. **Create rate limiter utility**
   - Implement token bucket or sliding window algorithm
   - Store state in SQLite for persistence across restarts
   
3. **Integrate with MCP server**
   - Wrap tool handlers with rate limit check
   - Return appropriate error when limit exceeded

### Risks
- State persistence adds database writes
- Clock skew could affect distributed setups

### Related Code
- Config loading: `src/utils/config.js:99-196`
- Server initialization: `src/mcp/server.js:30-100`
```

### Example 3: Investigating a Bug

```
You: I'm getting this error:
TypeError: Cannot read property 'search' of null
    at QueryEngine.search (src/search/query-engine.js:45:23)
    at handleSearch (src/mcp/server.js:312:28)

Claude: Let me investigate this stack trace.

[Calls investigate_bug with the stack trace]

## Bug Analysis

### Stack Trace Summary
- Error occurs in `QueryEngine.search` at line 45
- Called from `handleSearch` in the MCP server

### Root Cause
The `semanticSearch` component is `null` because:
1. `search.semantic` is enabled in config
2. But `indexing.maxTier` is set to 1 (requires tier 2)
3. Config validation should have disabled semantic search, but the query engine wasn't updated

### Fix
In `src/search/query-engine.js:45`, add a null check:

```javascript
if (method === 'semantic' && !this.semanticSearch) {
  return { results: [], error: 'Semantic search not available' };
}
```

### Related Files
- `src/search/query-engine.js` - Query orchestration
- `src/utils/config.js` - Config validation
```

### Example 4: Validating a Change

```
You: I made some changes. Can you check if they match the plan?

Claude: I'll validate your diff against the plan.

[Calls validate_diff with the diff and plan ID]


```

---

