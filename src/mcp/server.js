import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMemgraphAdapter } from '../db/memgraph-adapter.js';
import { createEmbedder } from '../indexing/embedder.js';
import { createSemanticSearch } from '../search/semantic-search.js';
import { createGrepSearch } from '../search/grep-search.js';
import { createStructuralSearch } from '../search/structural-search.js';
import { createQueryEngine } from '../search/query-engine.js';
import { createIndexManager } from '../indexing/index-manager.js';
import { createAIClient } from '../llm/client.js';
import { createContextAssembler } from '../planning/context-assembler.js';
import { createPlanGenerator } from '../planning/plan-generator.js';
import { createBugInvestigator } from '../planning/bug-investigator.js';
import { createDiffValidator } from '../planning/diff-validator.js';
import { createResearchAgent } from '../enrichment/research-agent.js';
import { createEnrichmentProcessor } from '../enrichment/enrichment-processor.js';
import { createEnrichmentPrioritizer } from '../enrichment/prioritizer.js';
import { createBackgroundEnrichmentQueue } from '../enrichment/background-queue.js';
import { createOnDemandEnricher } from '../enrichment/on-demand-enricher.js';
import { createEnrichmentCacheManager } from '../enrichment/cache-manager.js';
import { loadConfig, featureDisabledError } from '../utils/config.js';
import path from 'node:path';

/**
 * Creates and starts the CodeSense MCP server.
 * @param {string} rootPath - Codebase root path
 * @param {Object} [userConfig] - Optional user configuration override
 * @returns {Promise<Object>} MCP Server API
 */
export async function createCodeSenseServer(rootPath, userConfig = null) {
  // Load and validate configuration
  // userConfig can be either a raw config object or a loadConfig() result with {config, effectiveConfig, warnings}
  let config, effectiveConfig, warnings;
  if (userConfig) {
    if (userConfig.effectiveConfig && userConfig.config) {
      // It's a loadConfig() result
      ({ config, effectiveConfig, warnings } = userConfig);
    } else {
      // It's a raw config object
      config = userConfig;
      effectiveConfig = userConfig;
      warnings = [];
    }
  } else {
    ({ config, effectiveConfig, warnings } = loadConfig({ startDir: rootPath }));
  }

  if (warnings.length > 0) {
    console.error('Configuration warnings:');
    warnings.forEach(w => console.error(`  - ${w}`));
  }

  const server = new Server(
    { name: 'codesense', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // Initialize Memgraph database
  const schemaPath = path.join(process.cwd(), 'src', 'db', 'schema.cypher');
  const db = createMemgraphAdapter(effectiveConfig.memgraph, { 
    batchSize: effectiveConfig.indexing.dbBatchSize 
  });
  
  // Verify connection and initialize schema
  const connected = await db.verifyConnection();
  if (!connected) {
    throw new Error('Failed to connect to Memgraph. Is it running?');
  }
  await db.initSchema(schemaPath);

  // ─────────────────────────────────────────────────────────────────────────
  // Initialize components based on feature flags
  // ─────────────────────────────────────────────────────────────────────────

  // LLM Client (null if disabled)
  const llmClient = effectiveConfig.llm.enabled 
    ? createAIClient({
        llmProvider: effectiveConfig.llm.provider,
        llmApiKey: effectiveConfig.llm.apiKey,
        llmBaseUrl: effectiveConfig.llm.baseUrl,
        llmModel: effectiveConfig.llm.model,
        embeddingModel: effectiveConfig.llm.embeddingModel,
        embeddingDimension: effectiveConfig.llm.embeddingDimension
      })
    : null;

  // Embedder (null if maxTier < 2)
  const embedder = effectiveConfig.indexing.maxTier >= 2
    ? await createEmbedder({
        embeddingModel: effectiveConfig.llm.embeddingModel,
        embeddingDimension: effectiveConfig.llm.embeddingDimension
      })
    : null;

  // Search components
  const semanticSearch = effectiveConfig.search.semantic && embedder
    ? createSemanticSearch(db, embedder)
    : null;

  const grepSearch = effectiveConfig.search.grep
    ? createGrepSearch(rootPath)
    : null;

  const structuralSearch = effectiveConfig.search.structural && effectiveConfig.indexing.maxTier >= 1
    ? createStructuralSearch(db)
    : null;

  const queryEngine = createQueryEngine(db, {
    semanticSearch,
    grepSearch,
    structuralSearch,
    config: effectiveConfig.search
  });

  // Index manager
  const indexManager = await createIndexManager(db, effectiveConfig);

  // Context assembler (always available, uses what's indexed)
  const contextAssembler = createContextAssembler(db);

  // Planning components
  const planGenerator = createPlanGenerator(
    db, 
    queryEngine, 
    contextAssembler, 
    llmClient,
    effectiveConfig.planning
  );

  const bugInvestigator = createBugInvestigator(
    db, 
    queryEngine, 
    contextAssembler, 
    llmClient,
    { enabled: effectiveConfig.planning.bugInvestigator }
  );

  const diffValidator = createDiffValidator(
    db, 
    llmClient,
    { enabled: effectiveConfig.planning.diffValidator }
  );

  // Enrichment components - using Research Agent for Memgraph
  const researchAgent = effectiveConfig.enrichment.enabled && llmClient
    ? createResearchAgent({ 
        db, 
        llmClient, 
        grepSearch,
        config: effectiveConfig 
      })
    : null;

  const enrichmentProcessor = effectiveConfig.enrichment.enabled
    ? createEnrichmentProcessor(db, researchAgent, embedder)
    : null;

  const prioritizer = effectiveConfig.enrichment.enabled
    ? createEnrichmentPrioritizer(db)
    : null;

  const cacheManager = effectiveConfig.enrichment.enabled
    ? createEnrichmentCacheManager(db, { currentPromptVersion: 'v1.0' })
    : null;

  const onDemandEnricher = createOnDemandEnricher(
    db, 
    enrichmentProcessor,
    { enabled: effectiveConfig.enrichment.onDemand },
    embedder  // Pass embedder for enriched re-embedding
  );

  const backgroundQueue = createBackgroundEnrichmentQueue(
    db, 
    enrichmentProcessor,
    {
      enabled: effectiveConfig.enrichment.backgroundQueue,
      batchSize: effectiveConfig.enrichment.batchSize,
      maxRetries: effectiveConfig.enrichment.maxRetries,
      dailyLimit: effectiveConfig.enrichment.dailyLimit
    },
    embedder  // Pass embedder for enriched re-embedding
  );

  // Start background enrichment if enabled
  if (backgroundQueue.isEnabled() && prioritizer) {
    try {
      await prioritizer.queueHighPriorityChunks();
      backgroundQueue.start();
    } catch (err) {
      console.warn('Failed to start background enrichment queue:', err.message);
      // Continue without background enrichment - it's not critical
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Build tool list based on enabled features
  // ─────────────────────────────────────────────────────────────────────────

  const tools = [];

  // Core search tool (always available)
  tools.push({
    name: 'search_codebase',
    description: 'Search the codebase using natural language or regex. ' +
      `Available methods: ${Object.entries(queryEngine.getEnabledMethods())
        .filter(([_, v]) => v).map(([k]) => k).join(', ') || 'grep only'}`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        method: { 
          type: 'string', 
          enum: ['all', 'semantic', 'grep', 'structural'], 
          default: 'all',
          description: 'Search method to use'
        },
        limit: { type: 'number', description: 'Max results', default: 10 }
      },
      required: ['query']
    }
  });

  // Planning tools
  tools.push({
    name: 'generate_plan',
    description: planGenerator.isEnabled()
      ? 'Generate an implementation plan for a task.'
      : 'DISABLED: Planning requires LLM to be enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task description' },
        mode: { type: 'string', enum: ['fast', 'thorough'], default: 'fast' }
      },
      required: ['task']
    }
  });

  tools.push({
    name: 'investigate_bug',
    description: bugInvestigator.isEnabled()
      ? 'Investigate a bug using a stack trace. Parses stack, finds relevant code, and generates hypotheses.'
      : 'PARTIALLY AVAILABLE: Stack trace parsing works, but hypothesis generation requires LLM.',
    inputSchema: {
      type: 'object',
      properties: {
        stackTrace: { type: 'string', description: 'Stack trace or error message' }
      },
      required: ['stackTrace']
    }
  });

  tools.push({
    name: 'validate_diff',
    description: diffValidator.isEnabled()
      ? 'Validate a diff against a generated plan.'
      : 'PARTIALLY AVAILABLE: Diff parsing works, but plan validation requires LLM.',
    inputSchema: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'Unified diff content' },
        planId: { type: 'string', description: 'Plan ID to validate against' }
      },
      required: ['diff', 'planId']
    }
  });

  tools.push({
    name: 'get_plan',
    description: effectiveConfig.planning.persistence
      ? 'Retrieve a previously generated plan.'
      : 'DISABLED: Plan persistence is disabled.',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'Plan ID' }
      },
      required: ['planId']
    }
  });

  tools.push({
    name: 'list_plans',
    description: effectiveConfig.planning.persistence
      ? 'List recent implementation plans.'
      : 'DISABLED: Plan persistence is disabled.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum plans to return', default: 10 }
      }
    }
  });

  // Enrichment tools
  tools.push({
    name: 'enrich_chunk',
    description: onDemandEnricher.isEnabled()
      ? 'Enrich a code chunk with LLM analysis on-demand.'
      : 'DISABLED: On-demand enrichment requires LLM to be enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        chunkId: { type: 'string', description: 'Chunk ID to enrich' },
        force: { type: 'boolean', description: 'Force re-enrichment', default: false }
      },
      required: ['chunkId']
    }
  });

  tools.push({
    name: 'get_enrichment_status',
    description: 'Get the status of enrichment processing.',
    inputSchema: { type: 'object', properties: {} }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Graph Intelligence Tools (Memgraph-powered)
  // ─────────────────────────────────────────────────────────────────────────

  tools.push({
    name: 'impact_analysis',
    description: 'Analyze the impact radius of changing a function. ' +
      'Returns all code that directly or indirectly depends on the target.',
    inputSchema: {
      type: 'object',
      properties: {
        chunkId: { type: 'string', description: 'Chunk ID to analyze' },
        maxDepth: { type: 'number', description: 'Max call depth to traverse', default: 10 }
      },
      required: ['chunkId']
    }
  });

  tools.push({
    name: 'trace_data_flow',
    description: 'Trace data flow through the call graph. ' +
      'Shows the path data takes from source to destination functions.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceChunkId: { type: 'string', description: 'Source chunk ID' },
        targetChunkId: { type: 'string', description: 'Target chunk ID' }
      },
      required: ['sourceChunkId', 'targetChunkId']
    }
  });

  tools.push({
    name: 'find_hub_functions',
    description: 'Find the most important "hub" functions in the codebase using PageRank. ' +
      'Hub functions are called by many other functions and are critical to understand.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of hub functions to return', default: 20 }
      }
    }
  });

  tools.push({
    name: 'get_call_graph',
    description: 'Get the call graph for a function, showing what it calls and what calls it.',
    inputSchema: {
      type: 'object',
      properties: {
        chunkId: { type: 'string', description: 'Chunk ID to get call graph for' },
        depth: { type: 'number', description: 'Depth of calls to include', default: 2 }
      },
      required: ['chunkId']
    }
  });

  tools.push({
    name: 'compute_graph_analytics',
    description: effectiveConfig.graphAnalytics?.computePageRank
      ? 'Compute PageRank and community detection for the codebase graph. ' +
        'Should be run after indexing to enable hub function detection.'
      : 'DISABLED: Graph analytics is disabled in config.',
    inputSchema: { type: 'object', properties: {} }
  });

  // Index tools
  tools.push({
    name: 'get_index_status',
    description: 'Get the status of the codebase index.',
    inputSchema: { type: 'object', properties: {} }
  });

  tools.push({
    name: 'refresh_index',
    description: effectiveConfig.indexing.enabled
      ? 'Re-scan the codebase and update the index.'
      : 'DISABLED: Indexing is disabled.',
    inputSchema: { type: 'object', properties: {} }
  });

  // Config tool
  tools.push({
    name: 'get_config',
    description: 'Get the current effective configuration and enabled features.',
    inputSchema: { type: 'object', properties: {} }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Register tool handlers
  // ─────────────────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'search_codebase': {
          const results = await queryEngine.search(args.query, { 
            method: args.method,
            limit: args.limit
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(results, null, 2) }]
          };
        }

        case 'generate_plan': {
          const plan = await planGenerator.generate(args.task, args.mode);
          return {
            content: [{ type: 'text', text: JSON.stringify(plan, null, 2) }]
          };
        }

        case 'investigate_bug': {
          const investigation = await bugInvestigator.investigate(args.stackTrace);
          return {
            content: [{ type: 'text', text: JSON.stringify(investigation, null, 2) }]
          };
        }

        case 'validate_diff': {
          const validation = await diffValidator.validate(args.diff, args.planId);
          return {
            content: [{ type: 'text', text: JSON.stringify(validation, null, 2) }]
          };
        }

        case 'get_plan': {
          const plan = planGenerator.getPlan(args.planId);
          if (!plan) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Plan not found' }) }]
            };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(plan, null, 2) }]
          };
        }

        case 'list_plans': {
          const plans = planGenerator.listPlans(args.limit || 10);
          return {
            content: [{ type: 'text', text: JSON.stringify(plans, null, 2) }]
          };
        }

        case 'enrich_chunk': {
          const enrichment = await onDemandEnricher.enrichChunk(args.chunkId, { 
            force: args.force 
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(enrichment, null, 2) }]
          };
        }

        case 'get_enrichment_status': {
          const status = {
            enabled: effectiveConfig.enrichment.enabled,
            queue: backgroundQueue.getStats(),
            cache: cacheManager ? cacheManager.getStats() : null,
            priority: prioritizer ? await prioritizer.getQueueStats() : null
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(status, null, 2) }]
          };
        }

        // ─────────────────────────────────────────────────────────────────────
        // Graph Intelligence Tool Handlers
        // ─────────────────────────────────────────────────────────────────────

        case 'impact_analysis': {
          const maxDepth = args.maxDepth || 10;
          const impactedChunks = await db.getImpactRadius(args.chunkId, maxDepth);
          
          // Get the target chunk info
          const targetChunk = await db.getChunk(args.chunkId);
          if (!targetChunk) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Chunk not found' }) }],
              isError: true
            };
          }
          
          // Group by file for better readability
          const byFile = {};
          for (const chunk of impactedChunks) {
            const filePath = chunk.file_path;
            if (!byFile[filePath]) {
              byFile[filePath] = [];
            }
            byFile[filePath].push({
              id: chunk.id,
              name: chunk.name,
              distance: chunk.distance
            });
          }
          
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({
                target: {
                  id: args.chunkId,
                  name: targetChunk.name,
                  file: targetChunk.fileId
                },
                impactRadius: impactedChunks.length,
                affectedFiles: Object.keys(byFile).length,
                affectedChunks: byFile
              }, null, 2) 
            }]
          };
        }

        case 'trace_data_flow': {
          const path = await db.findPath(args.sourceChunkId, args.targetChunkId);
          
          if (path.length === 0) {
            return {
              content: [{ 
                type: 'text', 
                text: JSON.stringify({ 
                  message: 'No path found between the specified chunks',
                  source: args.sourceChunkId,
                  target: args.targetChunkId
                }, null, 2) 
              }]
            };
          }
          
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({
                pathLength: path.length,
                path: path
              }, null, 2) 
            }]
          };
        }

        case 'find_hub_functions': {
          const limit = args.limit || 20;
          const hubs = await db.getHubFunctions(limit);
          
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({
                hubFunctions: hubs,
                description: 'Functions ordered by PageRank score. Higher scores indicate ' +
                  'more central/important functions in the call graph.'
              }, null, 2) 
            }]
          };
        }

        case 'get_call_graph': {
          const depth = args.depth || 2;
          
          // Get the chunk and its relationships
          const chunk = await db.getChunk(args.chunkId);
          if (!chunk) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Chunk not found' }) }],
              isError: true
            };
          }
          
          const callers = await db.getCallers(args.chunkId, depth);
          const callees = await db.getCallees(args.chunkId, depth);
          
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({
                chunk: {
                  id: chunk.id,
                  name: chunk.name,
                  type: chunk.type,
                  file: chunk.fileId,
                  contextTier: chunk.contextTier
                },
                callers: callers,
                callees: callees,
                summary: chunk.enrichment?.summary || null
              }, null, 2) 
            }]
          };
        }

        case 'compute_graph_analytics': {
          if (!effectiveConfig.graphAnalytics?.computePageRank) {
            return {
              content: [{ 
                type: 'text', 
                text: JSON.stringify({ 
                  error: featureDisabledError('graphAnalytics', 'graphAnalytics.computePageRank is false') 
                }) 
              }]
            };
          }
          
          const pageRankCount = await db.computePageRank();
          const communityCount = effectiveConfig.graphAnalytics?.computeCommunities
            ? await db.detectCommunities()
            : 0;
          
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({
                message: 'Graph analytics computed successfully.',
                pageRankUpdated: pageRankCount,
                communitiesDetected: communityCount
              }, null, 2) 
            }]
          };
        }

        case 'get_index_status': {
          const stats = await db.getStats();
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({
                enabled: effectiveConfig.indexing.enabled,
                maxTier: effectiveConfig.indexing.maxTier,
                ...stats
              }, null, 2) 
            }]
          };
        }

        case 'refresh_index': {
          if (!effectiveConfig.indexing.enabled) {
            return {
              content: [{ 
                type: 'text', 
                text: JSON.stringify({ 
                  error: featureDisabledError('indexing', 'indexing.enabled is false') 
                }) 
              }]
            };
          }

          // Invalidate stale enrichments first
          const invalidated = cacheManager ? cacheManager.invalidateStale() : 0;
          
          // Run indexing
          const indexResult = await indexManager.runIndexing(rootPath);
          
          // Queue new high-priority chunks
          const queued = prioritizer ? await prioritizer.queueHighPriorityChunks() : 0;
          
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({
                message: 'Index refreshed successfully.',
                indexResult,
                invalidatedEnrichments: invalidated,
                queuedForEnrichment: queued
              }, null, 2) 
            }]
          };
        }

        case 'get_config': {
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({
                effective: effectiveConfig,
                enabledFeatures: {
                  indexing: effectiveConfig.indexing.enabled,
                  maxTier: effectiveConfig.indexing.maxTier,
                  llm: effectiveConfig.llm.enabled,
                  semanticSearch: queryEngine.getEnabledMethods().semantic,
                  structuralSearch: queryEngine.getEnabledMethods().structural,
                  grepSearch: queryEngine.getEnabledMethods().grep,
                  planning: planGenerator.isEnabled(),
                  bugInvestigator: bugInvestigator.isEnabled(),
                  diffValidator: diffValidator.isEnabled(),
                  enrichment: effectiveConfig.enrichment.enabled,
                  backgroundEnrichment: backgroundQueue.isEnabled(),
                  onDemandEnrichment: onDemandEnricher.isEnabled()
                },
                warnings
              }, null, 2) 
            }]
          };
        }

        default:
          throw new Error(`Tool not found: ${name}`);
      }
    } catch (error) {
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ error: error.message }, null, 2) 
        }],
        isError: true
      };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Server lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Starts the server.
   */
  const start = async () => {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('CodeSense MCP server running on stdio');
    console.error(`Enabled features: indexing=${effectiveConfig.indexing.enabled}, ` +
      `maxTier=${effectiveConfig.indexing.maxTier}, ` +
      `llm=${effectiveConfig.llm.enabled}, ` +
      `enrichment=${effectiveConfig.enrichment.enabled}`);
  };

  /**
   * Stops the server and cleanup.
   */
  const stop = async () => {
    backgroundQueue.stop();
    await db.close();
  };

  return { start, stop, db, queryEngine, indexManager };
}
