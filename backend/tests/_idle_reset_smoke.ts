/**
 * Teste do reinício automático por ausência do cliente.
 * Rode: CHAT_IDLE_RESET_MS=1200 npx tsx tests/_idle_reset_smoke.ts
 * (o timer padrão é 5 min; o teste encurta para 1,2s via env).
 */
import chatStateService from '../src/services/ChatStateService.js';

const CONTACT = '5511999990000@c.us';

async function main(): Promise<void> {
  console.log(`CHAT_IDLE_RESET_MS=${process.env.CHAT_IDLE_RESET_MS ?? '(padrão 5 min)'}`);

  // 1) Cliente está no meio do atendimento (confirmação com dados)
  await chatStateService.setWaitingConfirmation(CONTACT, {
    client: { nome: 'Cliente Teste', cpf: '12345678901', imei: '354293694592836', loja: 'X', contrato: 'Y' },
    statusContrato: 'atraso',
    parcela: {
      numero: '3', vencimento: '10/10/2026', valor: 'R$ 300,00', status: 'Aberta',
      boletoUrl: 'http://x/b', pixUrl: 'http://x/p', pixCode: 'pix', qrCodePath: '', total: 6,
    },
  } as any);

  // 2) Coleta parcial também conta como progresso
  await chatStateService.setState(CONTACT, { stage: 'COLLECTING', collect: { name: 'Maria Silva' } });

  const before = await chatStateService.getState(CONTACT);
  console.log(`antes: stage=${before?.stage} collect=${JSON.stringify(before?.collect)} pending=${!!before?.pendingData}`);
  if (before?.collect?.name !== 'Maria Silva') throw new Error('FALHOU: collect não persistido');

  // 3) Simula 5 min de ausência (timer encurtado via env)
  console.log('aguardando o reinício automático...');
  await new Promise((r) => setTimeout(r, Number(process.env.CHAT_IDLE_RESET_MS ?? 300000) + 700));

  // 4) Estado deve estar zerado (novo atendimento pede o nome do zero)
  const after = await chatStateService.getState(CONTACT);
  console.log(`depois: stage=${after?.stage} collect=${JSON.stringify(after?.collect)} pending=${!!after?.pendingData}`);

  if (!after) throw new Error('FALHOU: estado sumiu');
  if (after.stage !== 'COLLECTING') throw new Error(`FALHOU: stage=${after.stage}`);
  if (after.collect !== undefined) throw new Error('FALHOU: collect não limpo');
  if (after.pendingData !== undefined) throw new Error('FALHOU: pendingData não limpo');

  console.log('OK: atendimento reiniciado automaticamente após a ausência');
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
