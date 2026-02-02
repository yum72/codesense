import { generateObject, generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOllama } from 'ollama-ai-provider';

/**
 * Creates an AI client for LLM operations.
 * @param {Object} config - Configuration
 * @returns {Object} LLM Client API
 */
export function createAIClient(config) {
  const getModel = () => {
    if (config.llmProvider === 'ollama') {
      return createOllama({ baseURL: config.llmBaseUrl })(config.llmModel);
    }
    return createOpenAI({
      baseURL: config.llmBaseUrl || 'https://openrouter.ai/api/v1',
      apiKey: config.llmApiKey
    })(config.llmModel);
  };

  const model = getModel();

  /**
   * General chat completion for plan generation.
   * @param {string} prompt 
   * @returns {Promise<string>}
   */
  const chat = async (prompt) => {
    const { text } = await generateText({ model, prompt });
    return text;
  };

  /**
   * Generates a structured object using a schema.
   * @param {string} prompt 
   * @param {Object} schema - Zod schema
   * @returns {Promise<Object>}
   */
  const generateStructured = async (prompt, schema) => {
    const { object } = await generateObject({
      model,
      schema,
      prompt,
      temperature: 0.3,
    });
    return object;
  };

  return { chat, generateStructured };
}
