import { z } from 'zod';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// Schema Definitions
// ─────────────────────────────────────────────────────────────────────────────

const IndexingSchema = z.object({
  enabled: z.boolean().default(true),
  maxTier: z.number().min(0).max(2).default(2), // 0=files, 1=+AST/graph, 2=+embeddings
  scanBatchSize: z.number().min(1).default(50), // Files to hash per batch
  dbBatchSize: z.number().min(1).default(100),  // Rows per DB transaction
  maxFileSizeKb: z.number().default(500),
  ignoredDirs: z.array(z.string()).default([
    'node_modules', 'dist', '.git', 'build', 'out', 'coverage'
  ]),
});

const EnrichmentSchema = z.object({
  enabled: z.boolean().default(true),
  backgroundQueue: z.boolean().default(true),   // Process queue in background
  onDemand: z.boolean().default(true),          // Allow sync enrichment requests
  dailyLimit: z.number().default(1000),         // Max LLM calls per day
  batchSize: z.number().default(5),             // Chunks to enrich per batch
  maxRetries: z.number().default(3),            // Retry attempts on failure
});

const SearchSchema = z.object({
  semantic: z.boolean().default(true),          // Vector similarity (requires maxTier >= 2)
  structural: z.boolean().default(true),        // AST-based lookup (requires maxTier >= 1)
  grep: z.boolean().default(true),              // Text pattern matching (always available)
  queryUnderstanding: z.boolean().default(true),// LLM intent classification
  defaultLimit: z.number().default(10),
  maxContextTokens: z.number().default(8000),
});

const PlanningSchema = z.object({
  enabled: z.boolean().default(true),
  persistence: z.boolean().default(true),       // Save plans to DB
  bugInvestigator: z.boolean().default(true),   // Stack trace analysis
  diffValidator: z.boolean().default(true),     // Diff vs plan comparison
});

const GraphSchema = z.object({
  enabled: z.boolean().default(true),           // Build dependency graph
  metrics: z.boolean().default(true),           // Calculate fan-in/fan-out metrics
});

const MemgraphSchema = z.object({
  host: z.string().default('localhost'),
  port: z.number().default(7687),
  username: z.string().default(''),
  password: z.string().default(''),
  database: z.string().default('memgraph'),
  maxConnectionPoolSize: z.number().default(50),
  connectionAcquisitionTimeout: z.number().default(60000), // ms
  connectionTimeout: z.number().default(30000),            // ms
});

const ResearchAgentSchema = z.object({
  enabled: z.boolean().default(true),
  maxToolCalls: z.number().min(1).max(50).default(12),     // Max tool invocations per enrichment
  maxHops: z.number().min(1).max(5).default(2),            // Max graph traversal depth
  maxFilesPerHop: z.number().min(1).max(20).default(5),    // Files to explore per hop
  maxTokensPerEnrichment: z.number().default(4000),        // Token budget per enrichment
  model: z.string().optional(),                            // Override LLM model for research
  temperature: z.number().min(0).max(1).default(0.1),      // Low temp for focused research
  contextTiers: z.object({
    structural: z.boolean().default(true),                 // Tier 0: Signatures, imports
    partial: z.boolean().default(true),                    // Tier 1: Key relationships
    full: z.boolean().default(true),                       // Tier 2: Complete understanding
  }).default({}),
});

const LlmSchema = z.object({
  enabled: z.boolean().default(true),
  provider: z.enum(['openrouter', 'openai', 'ollama', 'gmicloud', 'custom']).default('openrouter'),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string().default('anthropic/claude-3-haiku'),
  embeddingModel: z.string().default('Xenova/all-MiniLM-L6-v2'),
  embeddingDimension: z.number().default(384),
});

const LoggingSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  verbose: z.boolean().default(false),          // Extra diagnostic output
});

const ConfigSchema = z.object({
  indexing: IndexingSchema.default({}),
  enrichment: EnrichmentSchema.default({}),
  search: SearchSchema.default({}),
  planning: PlanningSchema.default({}),
  graph: GraphSchema.default({}),
  llm: LlmSchema.default({}),
  logging: LoggingSchema.default({}),
  memgraph: MemgraphSchema.default({}),
  researchAgent: ResearchAgentSchema.default({}),
});

/**
 * @typedef {z.infer<typeof ConfigSchema>} Config
 */

// ─────────────────────────────────────────────────────────────────────────────
// Config Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ValidationResult
 * @property {string[]} warnings - Non-fatal issues that will cause feature degradation
 * @property {string[]} errors - Fatal issues that prevent operation
 * @property {Config} effectiveConfig - Config with incompatible features disabled
 */

/**
 * Validates config and returns warnings about incompatible settings.
 * Automatically adjusts config to disable features that can't run.
 * @param {Config} config 
 * @returns {ValidationResult}
 */
export function validateConfig(config) {
  const warnings = [];
  const errors = [];
  
  // Deep clone to create effective config
  const effective = JSON.parse(JSON.stringify(config));

  // ─────────────────────────────────────────────────────────────────────────
  // Check: Semantic search requires embeddings (Tier 2)
  // ─────────────────────────────────────────────────────────────────────────
  if (config.search.semantic && config.indexing.maxTier < 2) {
    warnings.push(
      `search.semantic requires indexing.maxTier >= 2 (current: ${config.indexing.maxTier}), ` +
      `semantic search will be disabled`
    );
    effective.search.semantic = false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Check: Structural search requires AST (Tier 1)
  // ─────────────────────────────────────────────────────────────────────────
  if (config.search.structural && config.indexing.maxTier < 1) {
    warnings.push(
      `search.structural requires indexing.maxTier >= 1 (current: ${config.indexing.maxTier}), ` +
      `structural search will be disabled`
    );
    effective.search.structural = false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Check: Enrichment requires LLM
  // ─────────────────────────────────────────────────────────────────────────
  if (config.enrichment.enabled && !config.llm.enabled) {
    warnings.push(
      `enrichment.enabled requires llm.enabled, enrichment will be disabled`
    );
    effective.enrichment.enabled = false;
    effective.enrichment.backgroundQueue = false;
    effective.enrichment.onDemand = false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Check: Query understanding requires LLM
  // ─────────────────────────────────────────────────────────────────────────
  if (config.search.queryUnderstanding && !config.llm.enabled) {
    warnings.push(
      `search.queryUnderstanding requires llm.enabled, will use keyword-based classification`
    );
    effective.search.queryUnderstanding = false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Check: Planning features require LLM
  // ─────────────────────────────────────────────────────────────────────────
  if (config.planning.enabled && !config.llm.enabled) {
    warnings.push(
      `planning.enabled requires llm.enabled, planning will be disabled`
    );
    effective.planning.enabled = false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Check: Graph requires at least Tier 1
  // ─────────────────────────────────────────────────────────────────────────
  if (config.graph.enabled && config.indexing.maxTier < 1) {
    warnings.push(
      `graph.enabled requires indexing.maxTier >= 1 (current: ${config.indexing.maxTier}), ` +
      `graph building will be disabled`
    );
    effective.graph.enabled = false;
    effective.graph.metrics = false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Check: Indexing disabled means most features won't work
  // ─────────────────────────────────────────────────────────────────────────
  if (!config.indexing.enabled) {
    warnings.push(
      `indexing.enabled is false - only grep search will be available`
    );
    effective.search.semantic = false;
    effective.search.structural = false;
    effective.graph.enabled = false;
    effective.graph.metrics = false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Check: LLM API key when LLM is enabled
  // ─────────────────────────────────────────────────────────────────────────
  if (config.llm.enabled && !config.llm.apiKey && 
      config.llm.provider !== 'ollama') {
    warnings.push(
      `llm.enabled is true but llm.apiKey is not set (provider: ${config.llm.provider}), ` +
      `LLM calls may fail`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Check: Research Agent requires LLM and enrichment
  // ─────────────────────────────────────────────────────────────────────────
  if (config.researchAgent.enabled && !config.llm.enabled) {
    warnings.push(
      `researchAgent.enabled requires llm.enabled, research agent will be disabled`
    );
    effective.researchAgent.enabled = false;
  }

  if (config.researchAgent.enabled && !config.enrichment.enabled) {
    warnings.push(
      `researchAgent.enabled requires enrichment.enabled, research agent will be disabled`
    );
    effective.researchAgent.enabled = false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Check: Research Agent context tiers require graph
  // ─────────────────────────────────────────────────────────────────────────
  if (config.researchAgent.enabled && 
      config.researchAgent.contextTiers.partial && 
      !config.graph.enabled) {
    warnings.push(
      `researchAgent.contextTiers.partial requires graph.enabled, partial context will be disabled`
    );
    effective.researchAgent.contextTiers.partial = false;
  }

  return { warnings, errors, effectiveConfig: effective };
}

// ─────────────────────────────────────────────────────────────────────────────
// Config Loading
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_FILENAME = 'codesense.config.json';

/**
 * Searches for config file starting from startDir and walking up.
 * @param {string} [startDir] - Directory to start search from
 * @returns {string | null} Path to config file or null
 */
function findConfigFile(startDir) {
  let dir = startDir || process.cwd();
  const root = path.parse(dir).root;

  while (dir !== root) {
    const configPath = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(configPath)) {
      return configPath;
    }
    dir = path.dirname(dir);
  }

  // Check root as well
  const rootConfig = path.join(root, CONFIG_FILENAME);
  if (fs.existsSync(rootConfig)) {
    return rootConfig;
  }

  return null;
}

/**
 * Loads config from JSON file if present.
 * @param {string} [startDir] - Directory to start search from
 * @returns {object} Partial config from file (empty object if not found)
 */
function loadConfigFile(startDir) {
  const configPath = findConfigFile(startDir);
  
  if (!configPath) {
    return {};
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content);
    return parsed;
  } catch (e) {
    console.warn(`Failed to load config from ${configPath}: ${e.message}`);
    return {};
  }
}

/**
 * Deep merges source into target (mutates target).
 * @param {object} target 
 * @param {object} source 
 * @returns {object}
 */
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

/**
 * Loads and validates configuration from:
 * 1. Default values
 * 2. codesense.config.json (if found)
 * 3. Environment variables (for sensitive values like API keys)
 * 
 * @param {object} [options]
 * @param {string} [options.startDir] - Directory to search for config file
 * @param {boolean} [options.validate=true] - Whether to run validation
 * @param {boolean} [options.logWarnings=true] - Whether to log validation warnings
 * @returns {{config: Config, effectiveConfig: Config, warnings: string[]}}
 */
export function loadConfig(options = {}) {
  const { startDir, validate = true, logWarnings = true } = options;

  // Load from JSON file
  const fileConfig = loadConfigFile(startDir);

  // Apply environment variable overrides for sensitive data
  const envOverrides = {
    llm: {
      apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GMICLOUD_API_KEY,
      provider: process.env.LLM_PROVIDER,
      baseUrl: process.env.LLM_BASE_URL,
      model: process.env.LLM_MODEL,
    },
    memgraph: {
      host: process.env.MEMGRAPH_HOST,
      port: process.env.MEMGRAPH_PORT ? parseInt(process.env.MEMGRAPH_PORT, 10) : undefined,
      username: process.env.MEMGRAPH_USERNAME,
      password: process.env.MEMGRAPH_PASSWORD,
    },
    researchAgent: {
      maxToolCalls: process.env.RESEARCH_AGENT_MAX_TOOL_CALLS 
        ? parseInt(process.env.RESEARCH_AGENT_MAX_TOOL_CALLS, 10) : undefined,
      maxHops: process.env.RESEARCH_AGENT_MAX_HOPS
        ? parseInt(process.env.RESEARCH_AGENT_MAX_HOPS, 10) : undefined,
    },
  };

  // Remove undefined values from env overrides
  const cleanEnvOverrides = JSON.parse(JSON.stringify(envOverrides, (_, v) => v ?? undefined));

  // Merge: defaults <- file <- env
  const merged = deepMerge(deepMerge({}, fileConfig), cleanEnvOverrides);

  // Parse and validate with Zod (applies defaults)
  const config = ConfigSchema.parse(merged);

  if (!validate) {
    return { config, effectiveConfig: config, warnings: [] };
  }

  // Run semantic validation
  const { warnings, errors, effectiveConfig } = validateConfig(config);

  if (logWarnings && warnings.length > 0) {
    console.warn('Config warnings:');
    for (const w of warnings) {
      console.warn(`  - ${w}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Config errors:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }

  return { config, effectiveConfig, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature Check Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if a feature is enabled in the effective config.
 * @param {Config} config 
 * @param {string} featurePath - Dot-separated path like 'search.semantic'
 * @returns {boolean}
 */
export function isFeatureEnabled(config, featurePath) {
  const parts = featurePath.split('.');
  let value = config;
  
  for (const part of parts) {
    if (value === undefined || value === null) return false;
    value = value[part];
  }
  
  return Boolean(value);
}

/**
 * Returns a disabled feature error message for MCP tools.
 * @param {string} featureName 
 * @param {string} [reason]
 * @returns {string}
 */
export function featureDisabledError(featureName, reason) {
  const base = `Feature '${featureName}' is disabled in configuration.`;
  if (reason) {
    return `${base} ${reason}`;
  }
  return `${base} Enable it in codesense.config.json to use this functionality.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preset Configurations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal config: Just file registry + grep (fastest, no LLM, no graph DB).
 */
export const PRESET_MINIMAL = {
  indexing: { enabled: true, maxTier: 0 },
  enrichment: { enabled: false },
  search: { semantic: false, structural: false, grep: true, queryUnderstanding: false },
  planning: { enabled: false },
  graph: { enabled: false },
  llm: { enabled: false },
  researchAgent: { enabled: false },
};

/**
 * AST-only config: Structure without embeddings or enrichment.
 */
export const PRESET_AST_ONLY = {
  indexing: { enabled: true, maxTier: 1 },
  enrichment: { enabled: false },
  search: { semantic: false, structural: true, grep: true },
  planning: { enabled: true },
  graph: { enabled: true },
  llm: { enabled: true },
  researchAgent: { enabled: false },
};

/**
 * Full config: Everything enabled (default behavior).
 * Uses Memgraph for graph storage and Research Agent for enrichment.
 */
export const PRESET_FULL = {};

/**
 * Development config: Full features with verbose logging and lower limits.
 */
export const PRESET_DEV = {
  logging: { level: 'debug', verbose: true },
  enrichment: { dailyLimit: 100, batchSize: 2 },
  researchAgent: { maxToolCalls: 6, maxHops: 1 },
};
