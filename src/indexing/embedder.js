import { pipeline } from '@xenova/transformers';

/**
 * Creates an embedder for generating vector embeddings.
 * @param {Object} config - Configuration
 * @returns {Promise<Object>} Embedder API
 */
export async function createEmbedder(config) {
  const modelName = config.embeddingModel || 'Xenova/all-MiniLM-L6-v2';
  
  // Initialize the pipeline
  const extractor = await pipeline('feature-extraction', modelName);

  /**
   * Generates an embedding for a string.
   * @param {string} text 
   * @returns {Promise<number[]>} Embedding vector
   */
  const embed = async (text) => {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  };

  /**
   * Generates embeddings for a batch of strings.
   * @param {string[]} texts 
   * @returns {Promise<number[][]>} Array of embedding vectors
   */
  const embedBatch = async (texts) => {
    // Transformers.js handles batching if we pass an array, but we'll do it sequentially for now to be safe with memory
    const results = [];
    for (const text of texts) {
      results.push(await embed(text));
    }
    return results;
  };

  return { embed, embedBatch };
}
