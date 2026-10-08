import type { AIModel } from './index.js';

export const AVAILABLE_MODELS: AIModel[] = [
  // Ordem: modelos FUNCIONAIS primeiro (07/10/2026: deepseek-v4.1 e glm-5.3
  // estavam com timeout/504 no upstream NIM — mantidos no fim da lista).
  { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', name: 'Nemotron 3.5 Lightning 30B' },
  { id: 'google/diffusiongemma-26b-a4b-it', name: 'DiffusionGemma 26B' },
  { id: 'poolside/laguna-xs-2.1', name: 'Laguna XS 2.1' },
  { id: 'deepseek-ai/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (instável)' },
  { id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash (instável)' },
];

export const HOSTILE_TERMS = [
  'lixo', 'bosta', 'merda', 'caralho', 'puta', 'safado',
  'ladrao', 'ladrão', 'roubo', 'procon', 'policia', 'polícia',
  'processar', 'processo', 'injusto', 'farsa', 'merdas', 'engana',
];

export const GREETING_PATTERNS = [
  'oi', 'olá', 'ola', 'tudo bem', 'bom dia', 'boa tarde', 'boa noite',
  'opa', 'hello', 'hi', 'oi tudo bem', 'ola tudo bem', 'olá tudo bem',
  'tudo bem com voce', 'tudo bem com você', 'como vai', 'bomdia',
  'boatarde', 'boanoite',
];
