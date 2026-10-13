/**
 * @fileoverview Provider LLM compartilhado (Vercel AI SDK · OpenAI-compatible).
 * Fonte única: NVIDIA NIM (nuvem, padrão) ou Ollama/llama.cpp/vLLM via AI_BASE_URL.
 * Usado pelo AIService (sugestões do painel).
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import config from '../config/index.js';

export const aiProvider = createOpenAICompatible({
  name: 'athina-ai',
  baseURL: config.aiBaseUrl,
  // Ollama/local não exige chave; a string só evita erro de header vazio.
  apiKey: config.aiApiKey ?? 'local',
});

/** Modelo de chat para o id informado (ex.: 'nvidia/…' ou 'qwen3:8b'). */
export function getChatModel(modelId: string) {
  return aiProvider.chatModel(modelId);
}

/** True quando o endpoint configurado é o NVIDIA NIM (nuvem). */
export function isCloudProvider(): boolean {
  return config.aiBaseUrl.includes('integrate.api.nvidia.com');
}
