/**
 * @fileoverview Smoke test do roteiro determinístico 24/7 (AthinaFlowService) —
 * cobre o fluxo completo desenhado em `workflow athina.excalidraw`: coleta de
 * nome/CPF-IMEI, cadastro não localizado, menu principal, boleto único vs.
 * múltiplos atrasados, saldo, celular bloqueado (comprovante) e "falar com
 * atendente".
 *
 * Roda sem WhatsApp/Paymobi/IA reais: injeta dependências mockadas via
 * AthinaFlowDeps (mesmo padrão de tests/agent.smoke.ts) e usa o
 * ChatStateService real (fallback em memória, sem precisar de Redis) para
 * validar a transição de estágios entre mensagens.
 *
 * Uso: npx tsx tests/athina_flow.smoke.ts
 */
import assert from 'node:assert/strict';
import { AthinaFlowService } from '../src/services/AthinaFlowService.js';
import config from '../src/config/index.js';
import type { PaymobiResult } from '../src/types/index.js';

const mutableConfig = config as unknown as { agentAutoReply: boolean };
const originalAutoReply = mutableConfig.agentAutoReply;
mutableConfig.agentAutoReply = true;

interface SentMessage {
  to: string;
  text: string;
}
interface Notification {
  client: { nome: string; cpf: string; imei: string };
  reason: string;
  details: string;
}
interface Scenario {
  name: string;
  run: () => Promise<void>;
}

let passed = 0;
const failures: Array<{ name: string; error: unknown }> = [];

function client(overrides?: Partial<PaymobiResult['data'] extends infer D ? (D extends { client: infer C } ? C : never) : never>) {
  return {
    loja: 'Loja Teste',
    dataVenda: '2024-01-01',
    expirationDate: '2025-01-01',
    duration: '12 meses',
    cpf: '12345678901',
    contrato: 'C1',
    nome: 'Maria Silva',
    imei: '123456789012345',
    statusVenda: 'active',
    ...overrides,
  };
}

const PARCELA = {
  numero: '4',
  vencimento: '10/10/2026',
  valor: 'R$ 405,63',
  status: 'Aberta',
  boletoUrl: 'https://data.cel.cash/boleto/1',
  pixUrl: 'https://data.cel.cash/pix/1',
  pixCode: '00020101021226960014br.gov.bcb.pix',
  qrCodePath: '',
  total: 6,
};

const INSTALLMENTS = [
  { numero: '1', vencimento: '10/08/2026', valor: 'R$ 405,63', status: 'Pago' },
  { numero: '2', vencimento: '10/09/2026', valor: 'R$ 405,63', status: 'Pago' },
  { numero: '3', vencimento: '10/10/2026', valor: 'R$ 405,63', status: 'Em atraso' },
];

const NOT_FOUND: PaymobiResult = {
  success: false,
  reason: 'NOT_FOUND',
  message: 'Infelizmente não encontramos nenhum cadastro com os dados fornecidos.',
};

function foundEmDia(): PaymobiResult {
  return { success: true, message: 'ok', data: { client: client(), statusContrato: 'em_dia', overdueCount: 0, installments: INSTALLMENTS } };
}
function foundUmAtraso(): PaymobiResult {
  return {
    success: true,
    message: 'ok',
    data: { client: client(), statusContrato: 'atraso', overdueCount: 1, parcela: PARCELA, installments: INSTALLMENTS },
  };
}
function foundMultiAtraso(): PaymobiResult {
  return { success: true, message: 'ok', data: { client: client(), statusContrato: 'atraso', overdueCount: 3, parcela: PARCELA, installments: INSTALLMENTS } };
}

/** Cria um AthinaFlowService com dependências mockadas e retorna os spies. */
function makeFlow(overrides?: {
  consultarPaymobi?: (query: string, clientName?: string) => Promise<PaymobiResult>;
  receiptKind?: 'PIX' | 'BOLETO' | 'INDEFINIDO';
  ready?: boolean;
}) {
  const sent: SentMessage[] = [];
  const notified: Notification[] = [];
  const consulted: Array<{ query: string; clientName?: string }> = [];

  const flow = new AthinaFlowService({
    sendMessage: async (to, text) => {
      sent.push({ to, text });
    },
    consultarPaymobi: async (query, clientName) => {
      consulted.push({ query, clientName });
      return overrides?.consultarPaymobi
        ? overrides.consultarPaymobi(query, clientName)
        : NOT_FOUND;
    },
    analyzeReceipt: async () => overrides?.receiptKind ?? 'PIX',
    notifyHumans: async (payload) => {
      notified.push(payload);
    },
    isReady: () => overrides?.ready ?? true,
    replyDelayMs: () => 0,
  });

  return { flow, sent, notified, consulted };
}

let seq = 0;
/** Novo contato (JID único) por cenário — evita contaminação entre testes no ChatStateService global. */
function newContact(): string {
  seq += 1;
  return `55119${String(seq).padStart(8, '0')}@c.us`;
}

const scenarios: Scenario[] = [
  {
    name: 'ignora mensagens quando AGENT_AUTOREPLY está desligado',
    run: async () => {
      mutableConfig.agentAutoReply = false;
      const { flow, sent } = makeFlow();
      await flow.handleIncomingMessage({ from: newContact(), body: 'oi', id: 'm1' });
      assert.equal(sent.length, 0);
      mutableConfig.agentAutoReply = true;
    },
  },
  {
    name: 'ignora grupos, broadcasts e mensagens próprias',
    run: async () => {
      const { flow, sent } = makeFlow();
      await flow.handleIncomingMessage({ from: '123@g.us', body: 'oi', id: 'm2' });
      await flow.handleIncomingMessage({ from: 'status@broadcast', body: 'oi', id: 'm3' });
      await flow.handleIncomingMessage({ from: newContact(), body: 'oi', fromMe: true, id: 'm4' });
      assert.equal(sent.length, 0);
    },
  },
  {
    name: 'coleta nome + CPF e cadastro NÃO localizado → mensagem de não encontrado',
    run: async () => {
      const { flow, sent, consulted } = makeFlow({ consultarPaymobi: async () => NOT_FOUND });
      const contact = newContact();
      await flow.handleIncomingMessage({ from: contact, body: 'Maria Silva', id: 'a1' });
      assert.ok(sent.some((m) => /CPF.*IMEI/i.test(m.text)), 'deveria pedir o CPF/IMEI após o nome');
      await flow.handleIncomingMessage({ from: contact, body: '12345678901', id: 'a2' });
      assert.ok(sent.some((m) => /não encontramos/i.test(m.text)), 'deveria avisar que não localizou o cadastro');
      assert.equal(consulted.length, 1);

      // Retentativa: o nome já informado NÃO deve precisar ser repetido —
      // o novo documento já dispara uma nova consulta direto.
      await flow.handleIncomingMessage({ from: contact, body: '98765432100', id: 'a3' });
      assert.equal(consulted.length, 2, 'o novo documento deveria disparar uma nova consulta imediatamente');
      assert.equal(consulted[1].clientName, 'Maria Silva', 'o nome já informado deveria ser reaproveitado');
    },
  },
  {
    name: 'coleta nome + CPF e cadastro ENCONTRADO → menu principal',
    run: async () => {
      const { flow, sent, consulted } = makeFlow({ consultarPaymobi: async () => foundEmDia() });
      const contact = newContact();
      await flow.handleIncomingMessage({ from: contact, body: 'Maria Silva', id: 'b1' });
      await flow.handleIncomingMessage({ from: contact, body: '12345678901', id: 'b2' });
      assert.equal(consulted.length, 1);
      assert.equal(consulted[0].query, '12345678901');
      assert.equal(consulted[0].clientName, 'Maria Silva');
      assert.ok(sent.some((m) => /Como podemos lhe ajudar/i.test(m.text)), 'deveria mostrar o menu 1-4');
    },
  },
  {
    name: 'menu → 1 parcela em atraso → confirma dados → recebe PIX + código',
    run: async () => {
      const { flow, sent, notified } = makeFlow({ consultarPaymobi: async () => foundUmAtraso() });
      const contact = newContact();
      await flow.handleIncomingMessage({ from: contact, body: 'Maria Silva', id: 'c1' });
      await flow.handleIncomingMessage({ from: contact, body: '12345678901', id: 'c2' });
      await flow.handleIncomingMessage({ from: contact, body: '1', id: 'c3' }); // Pagar Boleto
      assert.ok(sent.some((m) => /boleto em atraso/i.test(m.text)), 'deveria mostrar 1 boleto em atraso');
      assert.ok(sent.some((m) => /corretos/i.test(m.text)), 'deveria perguntar se os dados estão corretos');
      await flow.handleIncomingMessage({ from: contact, body: '1', id: 'c4' }); // confirma
      assert.ok(sent.some((m) => m.text.includes(PARCELA.pixCode)), 'deveria enviar o código PIX copia-e-cola');
      assert.ok(sent.some((m) => /Agradecemos o seu contato/i.test(m.text)), 'deveria encerrar com a mensagem padrão');
      assert.equal(notified.length, 0, 'boleto único é self-service — não deveria notificar humanos');
    },
  },
  {
    name: 'menu → 0 parcelas em atraso → parabéns e reexibe o menu',
    run: async () => {
      const { flow, sent } = makeFlow({ consultarPaymobi: async () => foundEmDia() });
      const contact = newContact();
      await flow.handleIncomingMessage({ from: contact, body: 'Maria Silva', id: 'd1' });
      await flow.handleIncomingMessage({ from: contact, body: '12345678901', id: 'd2' });
      await flow.handleIncomingMessage({ from: contact, body: '1', id: 'd3' });
      assert.ok(sent.some((m) => /Parabéns/i.test(m.text)));
      assert.ok(sent.some((m) => /Como podemos lhe ajudar/i.test(m.text)));
    },
  },
  {
    name: 'menu → 2+ parcelas em atraso → regularizar → transfere para humano',
    run: async () => {
      const { flow, sent, notified } = makeFlow({ consultarPaymobi: async () => foundMultiAtraso() });
      const contact = newContact();
      await flow.handleIncomingMessage({ from: contact, body: 'Maria Silva', id: 'e1' });
      await flow.handleIncomingMessage({ from: contact, body: '12345678901', id: 'e2' });
      await flow.handleIncomingMessage({ from: contact, body: '1', id: 'e3' });
      assert.ok(sent.some((m) => /3 boletos em atraso/i.test(m.text)));
      await flow.handleIncomingMessage({ from: contact, body: '1', id: 'e4' }); // quer regularizar
      assert.equal(notified.length, 1);
      assert.match(notified[0].reason, /Regulariza/i);
      assert.equal(notified[0].client.nome, 'Maria Silva');
    },
  },
  {
    name: 'menu → Verificar Saldo → lista parcelas → "algo mais? sim" volta ao menu',
    run: async () => {
      const { flow, sent } = makeFlow({ consultarPaymobi: async () => foundEmDia() });
      const contact = newContact();
      await flow.handleIncomingMessage({ from: contact, body: 'Maria Silva', id: 'f1' });
      await flow.handleIncomingMessage({ from: contact, body: '12345678901', id: 'f2' });
      await flow.handleIncomingMessage({ from: contact, body: '2', id: 'f3' });
      assert.ok(sent.some((m) => /Saldo atual/i.test(m.text) && m.text.includes('Em atraso')));
      await flow.handleIncomingMessage({ from: contact, body: '1', id: 'f4' });
      assert.ok(sent.some((m, i) => i === sent.length - 1 && /Como podemos lhe ajudar/i.test(m.text)));
    },
  },
  {
    name: 'menu → Celular Bloqueado → pagou por Pix → envia comprovante → transfere para humano',
    run: async () => {
      const { flow, sent, notified } = makeFlow({ consultarPaymobi: async () => foundUmAtraso(), receiptKind: 'PIX' });
      const contact = newContact();
      await flow.handleIncomingMessage({ from: contact, body: 'Maria Silva', id: 'g1' });
      await flow.handleIncomingMessage({ from: contact, body: '12345678901', id: 'g2' });
      await flow.handleIncomingMessage({ from: contact, body: '3', id: 'g3' }); // Celular Bloqueado
      assert.ok(sent.some((m) => /bloqueio do celular/i.test(m.text)));
      await flow.handleIncomingMessage({ from: contact, body: '2', id: 'g4' }); // já paguei
      assert.ok(sent.some((m) => /como foi efetuado/i.test(m.text)));
      await flow.handleIncomingMessage({ from: contact, body: '1', id: 'g5' }); // Pix
      assert.ok(sent.some((m) => /comprovante/i.test(m.text)));

      // Mensagem de texto antes da mídia → lembrete, sem transferir ainda.
      await flow.handleIncomingMessage({ from: contact, body: 'já enviei', id: 'g6' });
      assert.equal(notified.length, 0);

      // Agora a mídia do comprovante.
      await flow.handleIncomingMessage({
        from: contact,
        body: '',
        hasMedia: true,
        id: 'g7',
        downloadMedia: async () => ({ data: 'ZmFrZQ==', mimetype: 'image/png' }),
      });
      assert.equal(notified.length, 1);
      assert.match(notified[0].details, /PIX/);
    },
  },
  {
    name: 'menu → Falar com atendente → digita assunto → confirma → transfere para humano',
    run: async () => {
      const { flow, sent, notified } = makeFlow({ consultarPaymobi: async () => foundEmDia() });
      const contact = newContact();
      await flow.handleIncomingMessage({ from: contact, body: 'Maria Silva', id: 'h1' });
      await flow.handleIncomingMessage({ from: contact, body: '12345678901', id: 'h2' });
      await flow.handleIncomingMessage({ from: contact, body: '4', id: 'h3' });
      assert.ok(sent.some((m) => /sobre o que/i.test(m.text)));
      await flow.handleIncomingMessage({ from: contact, body: 'Quero trocar o dia de vencimento', id: 'h4' });
      assert.ok(sent.some((m) => m.text.includes('Quero trocar o dia de vencimento')));
      await flow.handleIncomingMessage({ from: contact, body: '1', id: 'h5' });
      assert.equal(notified.length, 1);
      assert.match(notified[0].details, /trocar o dia de vencimento/);
    },
  },
  {
    name: 'takeover humano: operador respondeu → bot fica em silêncio',
    run: async () => {
      const { flow, sent } = makeFlow();
      const contact = newContact();
      flow.noteHumanReply(contact);
      await flow.handleIncomingMessage({ from: contact, body: 'oi', id: 'i1' });
      assert.equal(sent.length, 0);
    },
  },
  {
    name: 'dedupe: a mesma mensagem (mesmo id) só é processada uma vez',
    run: async () => {
      const { flow, sent } = makeFlow();
      const contact = newContact();
      await flow.handleIncomingMessage({ from: contact, body: 'oi', id: 'dup-1' });
      await flow.handleIncomingMessage({ from: contact, body: 'oi', id: 'dup-1' });
      assert.equal(sent.length, 1);
    },
  },
];

for (const scenario of scenarios) {
  try {
    await scenario.run();
    passed += 1;
    console.log(`  ✔ ${scenario.name}`);
  } catch (error) {
    failures.push({ name: scenario.name, error });
    console.error(`  ✘ ${scenario.name}`);
    console.error(error);
  }
}

mutableConfig.agentAutoReply = originalAutoReply;

console.log(`\nAthinaFlow smoke test: ${passed}/${scenarios.length} cenários passaram`);
if (failures.length > 0) {
  process.exitCode = 1;
}
