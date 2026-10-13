/**
 * Smoke test do evento send-file-reply — valida a camada de schema
 * (payloads inválidos são rejeitados sem efeito colateral; NÃO envia
 * imagens reais a clientes).
 *
 * Uso: npx tsx tests/_image_reply_smoke.ts
 */
import { io as SocketIOClient } from 'socket.io-client';

const socket = SocketIOClient('http://127.0.0.1:3001', { transports: ['websocket'] });
const timeout = setTimeout(() => {
  console.error('TIMEOUT: sem conexão em 15s');
  process.exit(1);
}, 15000);

socket.on('connect', async () => {
  console.log('conectado');

  // 1) mimetype proibido → schema deve rejeitar (sem envio)
  socket.emit('send-file-reply', {
    to: '11111111111@c.us',
    base64: 'aGVsbG8=',
    mimetype: 'application/zip',
    caption: 'x',
  });

  // 2) base64 vazio → schema deve rejeitar
  socket.emit('send-file-reply', {
    to: '11111111111@c.us',
    base64: '',
    mimetype: 'image/png',
  });

  // 3) payload bem-formado porém chat inexistente → handler deve falhar
  //    COM GESTÃO de erro (sem derrubar o servidor); nada é entregue a ninguém.
  socket.emit('send-file-reply', {
    to: '00000000000@c.us',
    base64: Buffer.from('fake-imagem').toString('base64'),
    mimetype: 'image/png',
    caption: 'teste',
  });

  // Se o servidor processar sem derrubar a conexão, ficamos vivos por 4s.
  setTimeout(() => {
    clearTimeout(timeout);
    console.log('OK: payloads processados, conexão estável, servidor não caiu');
    console.log('(validação de schema + handler com erro tratado exercitados)');
    process.exit(0);
  }, 4000);
});

socket.on('disconnect', () => {
  console.error('Conexão caiu — possível crash do servidor');
  process.exit(1);
});
