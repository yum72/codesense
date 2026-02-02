import { describe, it, expect } from 'vitest';
import { 
  validateConfig, 
  loadConfig, 
  isFeatureEnabled, 
  featureDisabledError,
  PRESET_MINIMAL,
  PRESET_AST_ONLY,
  PRESET_FULL
} from '../../src/utils/config.js';

describe('Config Validation', () => {
  describe('validateConfig', () => {
    it('should pass validation for default config', () => {
      const config = {
        indexing: { enabled: true, maxTier: 2 },
        enrichment: { enabled: true },
        search: { semantic: true, structural: true, grep: true, queryUnderstanding: true },
        planning: { enabled: true },
        graph: { enabled: true },
        llm: { enabled: true, provider: 'openai', apiKey: 'test-key' },
        logging: { level: 'info' }
      };

      const result = validateConfig(config);
      
      expect(result.warnings).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should warn when semantic search requires higher maxTier', () => {
      const config = {
        indexing: { enabled: true, maxTier: 1 }, // Too low for semantic
        enrichment: { enabled: false },
        search: { semantic: true, structural: true, grep: true },
        planning: { enabled: false },
        graph: { enabled: true },
        llm: { enabled: false },
        logging: { level: 'info' }
      };

      const result = validateConfig(config);
      
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some(w => w.includes('search.semantic'))).toBe(true);
      expect(result.effectiveConfig.search.semantic).toBe(false);
    });

    it('should warn when structural search requires higher maxTier', () => {
      const config = {
        indexing: { enabled: true, maxTier: 0 }, // Too low for structural
        enrichment: { enabled: false },
        search: { semantic: false, structural: true, grep: true },
        planning: { enabled: false },
        graph: { enabled: false },
        llm: { enabled: false },
        logging: { level: 'info' }
      };

      const result = validateConfig(config);
      
      expect(result.warnings.some(w => w.includes('search.structural'))).toBe(true);
      expect(result.effectiveConfig.search.structural).toBe(false);
    });

    it('should warn when enrichment requires LLM', () => {
      const config = {
        indexing: { enabled: true, maxTier: 2 },
        enrichment: { enabled: true }, // Requires LLM
        search: { semantic: true, structural: true, grep: true },
        planning: { enabled: false },
        graph: { enabled: true },
        llm: { enabled: false }, // Disabled
        logging: { level: 'info' }
      };

      const result = validateConfig(config);
      
      expect(result.warnings.some(w => w.includes('enrichment'))).toBe(true);
      expect(result.effectiveConfig.enrichment.enabled).toBe(false);
    });

    it('should warn when planning requires LLM', () => {
      const config = {
        indexing: { enabled: true, maxTier: 2 },
        enrichment: { enabled: false },
        search: { semantic: true, structural: true, grep: true },
        planning: { enabled: true }, // Requires LLM
        graph: { enabled: true },
        llm: { enabled: false }, // Disabled
        logging: { level: 'info' }
      };

      const result = validateConfig(config);
      
      expect(result.warnings.some(w => w.includes('planning'))).toBe(true);
      expect(result.effectiveConfig.planning.enabled).toBe(false);
    });

    it('should warn when graph requires Tier 1', () => {
      const config = {
        indexing: { enabled: true, maxTier: 0 }, // Too low for graph
        enrichment: { enabled: false },
        search: { semantic: false, structural: false, grep: true },
        planning: { enabled: false },
        graph: { enabled: true }, // Requires Tier 1
        llm: { enabled: false },
        logging: { level: 'info' }
      };

      const result = validateConfig(config);
      
      expect(result.warnings.some(w => w.includes('graph'))).toBe(true);
      expect(result.effectiveConfig.graph.enabled).toBe(false);
    });

    it('should warn when indexing is completely disabled', () => {
      const config = {
        indexing: { enabled: false, maxTier: 2 },
        enrichment: { enabled: false },
        search: { semantic: true, structural: true, grep: true },
        planning: { enabled: false },
        graph: { enabled: true },
        llm: { enabled: false },
        logging: { level: 'info' }
      };

      const result = validateConfig(config);
      
      expect(result.warnings.some(w => w.includes('indexing.enabled is false'))).toBe(true);
      expect(result.effectiveConfig.search.semantic).toBe(false);
      expect(result.effectiveConfig.search.structural).toBe(false);
    });
  });

  describe('isFeatureEnabled', () => {
    it('should return true for enabled features', () => {
      const config = {
        search: { semantic: true, grep: false },
        llm: { enabled: true }
      };

      expect(isFeatureEnabled(config, 'search.semantic')).toBe(true);
      expect(isFeatureEnabled(config, 'llm.enabled')).toBe(true);
    });

    it('should return false for disabled features', () => {
      const config = {
        search: { semantic: false, grep: true },
        llm: { enabled: false }
      };

      expect(isFeatureEnabled(config, 'search.semantic')).toBe(false);
      expect(isFeatureEnabled(config, 'llm.enabled')).toBe(false);
    });

    it('should return false for missing paths', () => {
      const config = { search: { semantic: true } };

      expect(isFeatureEnabled(config, 'nonexistent.path')).toBe(false);
      expect(isFeatureEnabled(config, 'search.nonexistent')).toBe(false);
    });
  });

  describe('featureDisabledError', () => {
    it('should return formatted error message', () => {
      const error = featureDisabledError('semantic search');
      expect(error).toContain('semantic search');
      expect(error).toContain('disabled');
    });

    it('should include reason when provided', () => {
      const error = featureDisabledError('enrichment', 'LLM is not configured');
      expect(error).toContain('enrichment');
      expect(error).toContain('LLM is not configured');
    });
  });

  describe('Preset Configurations', () => {
    it('PRESET_MINIMAL should have LLM and most features disabled', () => {
      expect(PRESET_MINIMAL.llm.enabled).toBe(false);
      expect(PRESET_MINIMAL.search.semantic).toBe(false);
      expect(PRESET_MINIMAL.search.structural).toBe(false);
      expect(PRESET_MINIMAL.search.grep).toBe(true);
      expect(PRESET_MINIMAL.planning.enabled).toBe(false);
      expect(PRESET_MINIMAL.indexing.maxTier).toBe(0);
    });

    it('PRESET_AST_ONLY should have Tier 1 with no embeddings', () => {
      expect(PRESET_AST_ONLY.indexing.maxTier).toBe(1);
      expect(PRESET_AST_ONLY.search.semantic).toBe(false);
      expect(PRESET_AST_ONLY.search.structural).toBe(true);
      expect(PRESET_AST_ONLY.llm.enabled).toBe(true);
    });

    it('PRESET_FULL should be empty (uses defaults)', () => {
      expect(Object.keys(PRESET_FULL).length).toBe(0);
    });

    it('PRESET_MINIMAL should pass validation without errors', () => {
      // Merge with defaults to get full config
      const config = {
        indexing: { enabled: true, maxTier: 0, scanBatchSize: 50, dbBatchSize: 100, maxFileSizeKb: 500, ignoredDirs: [] },
        enrichment: { enabled: false, backgroundQueue: false, onDemand: false, dailyLimit: 1000, batchSize: 5, maxRetries: 3 },
        search: { semantic: false, structural: false, grep: true, queryUnderstanding: false, defaultLimit: 10, maxContextTokens: 8000 },
        planning: { enabled: false, persistence: false, bugInvestigator: false, diffValidator: false },
        graph: { enabled: false, metrics: false },
        llm: { enabled: false, provider: 'openai', model: 'gpt-4' },
        logging: { level: 'info', verbose: false }
      };

      const result = validateConfig(config);
      // Should have some warnings about disabled features but no errors
      expect(result.errors).toHaveLength(0);
    });
  });
});
