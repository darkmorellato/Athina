/**
 * @fileoverview Handles NVIDIA NIM API calls for AI responses.
 */
import axios from 'axios';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import type { AIRequest } from '../types/index.js';

interface ThinkingModels {
  [key: string]: boolean;
}

// Modelos que aceitam parâmetros de raciocínio (chat_template_kwargs/reasoning_budget).
// deepseek-ai/deepseek-v4.1-flash responde direto, sem parâmetros de thinking.
const THINKING_MODELS: ThinkingModels = {};

const DEFAULT_CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

function resolveChatUrl(): string {
  const base = config.aiBaseUrl;
  return base ? `${base}/chat/completions` : DEFAULT_CHAT_URL;
}

interface NvidiaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface NvidiaPayload {
  model: string;
  messages: NvidiaMessage[];
  temperature: number;
  top_p: number;
  max_tokens: number;
  chat_template_kwargs?: Record<string, unknown>;
  reasoning_budget?: number;
}

class AIService {
  private apiKey: string | null;

  constructor() {
    this.apiKey = config.aiApiKey;
  }

  async call(data: AIRequest): Promise<string> {
    const isCloudProvider = resolveChatUrl().includes('integrate.api.nvidia.com');
    if (!this.apiKey && isCloudProvider) {
      throw new Error('NVIDIA_API_KEY not configured on server.');
    }

    const payload = this.buildPayload(data);

    // Security fix: Retry logic with exponential backoff
    return this.makeRequestWithRetry(payload);
  }

  private async makeRequestWithRetry(payload: NvidiaPayload, retries = 3): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await axios.post<NvidiaResponse>(resolveChatUrl(), payload, {
          headers,
          timeout: 30_000, // Reduced from 60s to 30s
        });

        return response.data.choices[0]?.message?.content ?? '';
      } catch (error) {
        const isRetryable = axios.isAxiosError(error) && 
          (!error.response || error.response.status >= 500 || error.code === 'ECONNABORTED');
        
        if (attempt === retries || !isRetryable) {
          const errorMsg = this.extractErrorMessage(error);
          logger.error({ error: errorMsg, attempt }, 'NVIDIA API error');
          throw new Error(errorMsg);
        }
        
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        logger.warn({ attempt, delay }, `Retry attempt ${attempt}/${retries} after ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('Max retries exceeded');
  }

  /** Sanitize input to prevent prompt injection attacks */
  private sanitizeInput(input: string): string {
    if (!input) return '';
    
    // Limit length
    const maxLength = 4000;
    let sanitized = input.slice(0, maxLength);
    
    // Remove potential prompt injection patterns
    sanitized = sanitized
      .replace(/system:/gi, '')
      .replace(/assistant:/gi, '')
      .replace(/user:/gi, '')
      .replace(/<\|im_start\|>/gi, '')
      .replace(/<\|im_end\|>/gi, '');
    
    return sanitized.trim();
  }

  private buildPayload(data: AIRequest): NvidiaPayload {
    // Security fix: Sanitize inputs to prevent prompt injection
    const sanitizedPersona = this.sanitizeInput(data.persona);
    const sanitizedMessage = this.sanitizeInput(data.message);
    
    const isThinkingModel = THINKING_MODELS[data.model] ?? false;
    const payload: NvidiaPayload = {
      model: data.model,
      messages: data.contactId === 'spelling-correction'
        ? [
            {
              role: 'user',
              content: `${sanitizedPersona}\n\nTexto a corrigir:\n"${sanitizedMessage}"`,
            },
          ]
        : [
            { role: 'system', content: sanitizedPersona },
            { role: 'user', content: sanitizedMessage },
          ],
      temperature: data.contactId === 'spelling-correction' ? 0.1 : (data.model.includes('safety') ? 0.1 : 0.7),
      top_p: 0.9,
      max_tokens: data.contactId === 'spelling-correction' ? 300 : 4096,
    };

    if (isThinkingModel) {
      payload.chat_template_kwargs = {
        enable_thinking: data.contactId !== 'spelling-correction',
        clear_thinking: false,
      };
      if (data.model === 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning') {
        payload.reasoning_budget = 16384;
      }
    }

    return payload;
  }

  private extractErrorMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
      return error.response?.data?.error?.message ?? error.message;
    }
    if (error instanceof Error) return error.message;
    return String(error);
  }
}

interface NvidiaResponse {
  choices: Array<{ message: { content: string } }>;
}

export default new AIService();