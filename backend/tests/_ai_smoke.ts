/** Teste do AIService do backend com a chave configurada em .env. */
import aiService from '../src/services/AIService.js';

const reply = await aiService.call({
  model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  persona: 'Responda em português brasileiro, de forma curta e cordial.',
  message: 'Diga boa tarde em uma frase.',
  contactId: 'smoke-test',
});
console.log('RESPOSTA:', JSON.stringify(reply).slice(0, 200));

// Mesmo caminho usado pelo painel na correção ortográfica (branch especial).
const corrected = await aiService.call({
  model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
  persona: 'Você é o revisor ortográfico. Responda APENAS com o texto corrigido.',
  message: 'olá bom diaa, tudo bem',
  contactId: 'spelling-correction',
});
console.log('ORTOGRAFIA:', JSON.stringify(corrected).slice(0, 200));
