/** Depura sanitizeForWhatsApp com amostras reais. */
import { sanitizeForWhatsApp } from '../src/services/AgentService.js';

const samples = [
  'Verifiquei o CPF **123.456.789-01** (mascarado para proteção).',
  'O cliente enviou o CPF 12345678901 e pediu o boleto. Parcela R$ 299,90.',
  'Seu CPF 12345678901 está ok.\nCódigo PIX: 00020126BR.GOV.BCB.PIX-TESTE-AABBCC',
  'Fiz o Pix e o código **000201265204000053039865802BR5913NORDESTE6009SAOPAULO62070636062634AM** funciona?',
  'Use *ênfase* e `código` aqui.',
];

for (const s of samples) {
  console.log('IN :', JSON.stringify(s));
  console.log('OUT:', JSON.stringify(sanitizeForWhatsApp(s)));
  console.log('---');
}
