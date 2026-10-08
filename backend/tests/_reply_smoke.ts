/**
 * Smoke test do reply citado (send-reply + quotedMessageId).
 * Payloads inválidos → schema rejeita; payload válido para chat inexistente →
 * handler falha com erro tratado. NENHUMA mensagem real é enviada.
 *
 * Uso: npx tsx tests/_reply_smoke.ts
 */
import { io as SocketIOClient } from 'socket.io-client';

const socket = SocketIOClient('http://127.0.0.1:3001', { transports: ['websocket'] });
const timeout = setTimeout(() => {
  console.error('TIMEOUT (15s)');
  process.exit(1);
}, 15000);

socket.on('connect', () => {
  console.log('conectado');

  // 1) quotedMessageId vazio → schema rejeita (min(1))
  socket.emit('send-reply', { to: '11111111111@c.us', text: 'oi', isManual: true, quotedMessageId: '' });

  // 2) quotedMessageId gigante → schema rejeita (max 300)
  socket.emit('send-reply', { to: '11111111111@c.us', text: 'oi', isManual: true, quotedMessageId: 'x'.repeat(400) });

  // 3) formato válido + chat inexistente → erro tratado no handler (sem crash)
  socket.emit('send-reply', {
    to: '00000000000@c.us',
    text: 'teste de reply',
    isManual: true,
    quotedMessageId: 'false_00000000000@c.us_BAE5TESTE123',
  });

  setTimeout(() => {
    clearTimeout(timeout);
    console.log('OK: payloads processados, conexão estável');
    process.exit(0);
  }, 4000);
});

socket.on('disconnect', () => {
  console.error('Conexão caiu — possível crash');
  process.exit(1);
});
