/** Round-trip real: conecta no backend por socket e pede geração de áudio. */
import { io } from 'socket.io-client';

const socket = io('http://127.0.0.1:3001', { transports: ['websocket'] });

const timeout = setTimeout(() => {
  console.error('TIMEOUT: nenhum evento de resposta em 20s');
  process.exit(1);
}, 20000);

socket.on('connect', () => {
  console.log('conectado, pedindo TTS...');
  socket.emit('generate-tts-audio', { text: 'Teste de geração de áudio pelo painel.', voice: process.argv[2] ?? 'pf_dora' });
});

socket.on('tts-audio-generated', (data: { base64: string }) => {
  clearTimeout(timeout);
  console.log('RECEBIDO tts-audio-generated | base64:', data.base64.length, '| ogg:', data.base64.startsWith('T2dn'));
  process.exit(data.base64.startsWith('T2dn') ? 0 : 1);
});

socket.on('tts-audio-error', (e: { message: string }) => {
  clearTimeout(timeout);
  console.error('ERRO:', e.message);
  process.exit(1);
});
