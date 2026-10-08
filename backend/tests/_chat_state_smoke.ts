/**
 * Smoke test do fluxo de ESTADO do atendimento (a causa raiz do bug do
 * boleto): update-chat-state → get-chat-state → reset-chat-state.
 * Usa um contactId fictício — NENHUM cliente real é afetado.
 *
 * Uso: npx tsx tests/_chat_state_smoke.ts
 */
import { io as SocketIOClient } from 'socket.io-client';

const FAKE_CONTACT = '5511000009999@c.us';
const socket = SocketIOClient('http://127.0.0.1:3001', { transports: ['websocket'] });
const timeout = setTimeout(() => {
  console.error('TIMEOUT (15s)');
  process.exit(1);
}, 15000);

const pendingData = {
  client: { nome: 'Teste E2E', cpf: '11122233344', imei: '351234567890123', loja: 'Loja X', contrato: 'CT-9' },
  statusContrato: 'atraso',
  parcela: { numero: '4', total: '6', valor: 'R$ 100,00', vencimento: '10/10/2026', status: 'Aberta', pixCode: '000201TESTE', boletoUrl: 'https://x.test/b' },
};

let phase: 'set' | 'get' | 'reset' | 'check-reset' = 'set';

socket.on('connect', () => {
  console.log('conectado — salvando estado WAITING_CONFIRMATION (contato fictício)');
  socket.emit('update-chat-state', {
    contactId: FAKE_CONTACT,
    state: { stage: 'WAITING_CONFIRMATION', pendingData },
  });
  setTimeout(() => {
    phase = 'get';
    console.log('lendo estado de volta...');
    socket.emit('get-chat-state', { contactId: FAKE_CONTACT });
  }, 500);
});

socket.on('chat-state-loaded', (data: { contactId: string; state: any }) => {
  if (data.contactId !== FAKE_CONTACT) return;

  if (phase === 'get') {
    const stage = data.state?.stage;
    const hasParcela = Boolean(data.state?.pendingData?.parcela);
    console.log(`  stage: ${stage} | pendingData.parcela: ${hasParcela}`);
    if (stage === 'WAITING_CONFIRMATION' && hasParcela) {
      console.log('OK: estado persistido — o "SIM" agora cai no estágio de confirmação');
      phase = 'reset';
      socket.emit('reset-chat-state', { contactId: FAKE_CONTACT });
      setTimeout(() => {
        phase = 'check-reset';
        socket.emit('get-chat-state', { contactId: FAKE_CONTACT });
      }, 400);
    } else {
      console.error('FALHA: estado não persistiu (a causa raiz do bug do boleto)');
      process.exit(1);
    }
  } else if (phase === 'check-reset') {
    const stage = data.state?.stage ?? 'COLLECTING';
    console.log(`  após reset: stage=${stage}, pendingData=${JSON.stringify(data.state?.pendingData)}`);
    const ok = stage === 'COLLECTING' && !data.state?.pendingData;
    console.log(ok ? 'OK: reset limpa o estado (PII também)' : 'FALHA no reset');
    clearTimeout(timeout);
    process.exit(ok ? 0 : 1);
  }
});
