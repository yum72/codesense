import { z } from 'zod';

/**
 * Schema for LLM enrichment output.
 * 
 * Optimized for contextual embeddings:
 * - summary and purpose are constrained to 1 sentence each
 * - Arrays are limited to prevent token bloat
 * - All fields support search indexing
 */
export const EnrichmentSchema = z.object({
  // Core understanding (MUST be concise for embeddings)
  summary: z.string().max(150).describe('Exactly 1 sentence, max 100 chars. What does this code do?'),
  purpose: z.string().max(200).describe('Exactly 1 sentence. Why does this code exist?'),
  
  // Structural insights (3-5 items each)
  key_operations: z.array(z.string().max(50)).max(5).describe('3-5 short phrases of main actions'),
  side_effects: z.array(z.string().max(50)).max(5).describe('Database writes, API calls, emails, etc.'),
  state_changes: z.array(z.string().max(50)).max(5).describe('What data/state does this modify?'),
  implicit_dependencies: z.array(z.string().max(50)).max(5).describe('Env vars, external services required'),
  
  // Pattern detection (only if clearly present)
  design_patterns: z.array(z.string().max(30)).max(3).describe('Factory, Singleton, Observer, etc.'),
  architectural_patterns: z.array(z.string().max(30)).max(3).describe('MVC, Service Layer, Repository, etc.'),
  anti_patterns: z.array(z.string().max(50)).max(3).describe('God class, tight coupling, etc.'),
  
  // Risk signals
  complexity: z.enum(['low', 'medium', 'high']).describe('Based on cyclomatic complexity'),
  security_concerns: z.array(z.string().max(80)).max(3).describe('Only real security issues'),
  performance_concerns: z.array(z.string().max(80)).max(3).describe('Only real performance issues'),
  
  // Business context
  business_rules: z.array(z.string().max(100)).max(5).describe('Domain logic encoded in code'),
  
  // Semantic tags (critical for search)
  tags: z.array(z.string().max(30)).min(3).max(10).describe('5-10 searchable keywords'),
  
  // Metadata (added by enricher, not LLM)
  hash: z.string().optional(),
  content_hash: z.string().optional(),
  model_used: z.string().optional(),
  prompt_version: z.string().optional(),
  confidence: z.number().optional()
});

/**
 * @typedef {z.infer<typeof EnrichmentSchema>} ChunkEnrichment
 */

/**
 * Condensed enrichment for embedding representation.
 * This is derived from the full enrichment but optimized for token budget.
 */
export const EmbeddingEnrichmentSchema = z.object({
  summary: z.string().max(150),
  purpose: z.string().max(200),
  key_operations: z.array(z.string()).max(5),
  side_effects: z.array(z.string()).max(4),
  patterns: z.array(z.string()).max(3),
  complexity: z.enum(['low', 'medium', 'high']).optional()
});

/**
 * @typedef {z.infer<typeof EnrichmentSchema>} ChunkEnrichment
 */
