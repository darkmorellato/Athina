/**
 * Smoke test REAL: pede fotos de perfil de contatos reais via socket.
 * Conecta no backend, espera o chats-loaded, pega jids e pede os avatares.
 *
 * Uso: npx tsx tests/_avatars_smoke.ts
 */
import { io as SocketIOClient } from 'socket.io-client';

const socket = SocketIOClient('http://127.0.0.1:3001', { transports: ['websocket'] });
const timeout = setTimeout(() => {
  console.error('TIMEOUT: sem resposta em 30s');
  process.exit(1);
}, 30000);

let phase: 'chats' | 'avatars' = 'chats';

socket.on('connect', () => {
  console.log('conectado, pedindo status...');
  socket.emit('request-status');
});

socket.on('chats-loaded', (chats: Array<{ id: string; name: string }>) => {
  if (phase !== 'chats') return;
  phase = 'avatars';
  console.log('total de entradas:', chats.length, '| ids (8):', JSON.stringify(chats.slice(0, 8).map((c) => c.id)));
  // Contas modernas do WhatsApp usam @lid; aceitamos qualquer formato de JID
  const jids = chats.slice(0, 5).map((c) => c.id).filter((j) => j.includes('@'));
  if (jids.length === 0) {
    console.error('Nenhum chat @c.us retornado');
    process.exit(1);
  }
  console.log('pedindo avatares para:', jids.length, 'contatos');
  socket.emit('get-contact-avatars', { jids });
});

socket.on('contact-avatars', (data: { avatars: Record<string, string | null> }) => {
  clearTimeout(timeout);
  const entries = Object.entries(data.avatars ?? {});
  console.log(`resposta: ${entries.length} entradas`);
  const comFoto = entries.filter(([, url]) => typeof url === 'string' && url.startsWith('http'));
  const semFoto = entries.filter(([, url]) => url === null);
  console.log(`  com foto (URL): ${comFoto.length}`);
  console.log(`  sem foto/oculta: ${semFoto.length}`);
  if (comFoto.length > 0) console.log('  exemplo:', comFoto[0][1]!.slice(0, 90) + '...');
  const ok = entries.length > 0 && comFoto.length + semFoto.length === entries.length;
  console.log(ok ? '\nOK: avatares resolvidos pelo backend' : '\nFALHA');
  process.exit(ok ? 0 : 1);
});
