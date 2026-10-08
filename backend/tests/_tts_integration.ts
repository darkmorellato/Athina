/** Teste de integração do TTSService contra o servidor TTS local (porta 5050).
 *
 *  Uso: npm --prefix backend run test:tts -- [voz]
 *  Vozes: pf_dora (local, padrão) | riva | riva_male | riva_female
 */
import { generateTTS } from '../src/services/TTSService.js';

const voice = process.argv[2] ?? 'pf_dora';
const base64 = await generateTTS(
  'Olá! Esta é uma verificação de integração de voz em português.',
  voice
);
console.log('voz:', voice, '| base64 length:', base64.length);

// OGG/Opus começa com "T2dn" em base64 (magic "OggS")
const isOgg = base64.startsWith('T2dn');
console.log('is ogg/opus:', isOgg);
if (!isOgg || base64.length < 1000) {
  console.error('FALHA: áudio inválido');
  process.exit(1);
}
console.log('OK: integração Node → TTS funcionando');
