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
import { analyzeReceiptText, combineAnalyses } from '../src/services/helpers/receiptAnalysisHelper.js';
import { describeReceiptForOperator } from '../src/services/AthinaFlowService.js';
import {
  verifyWebhookSignature,
  processPaymentWebhook,
  signWebhookPayload,
} from '../src/services/helpers/paymentWebhookHelper.js';

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
    cpf: '52998224725',
    contrato: 'C1',
    nome: 'Maria Silva',
    imei: '529982247252345',
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
  now?: Date;
  debounceMs?: () => number;
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
    analyzeReceipt: async () => ({ kind: overrides?.receiptKind ?? 'PIX', confidence: 'alta' as const, evidence: ['teste'] }),
    notifyHumans: async (payload) => {
      notified.push(payload);
    },
    isReady: () => overrides?.ready ?? true,
    replyDelayMs: () => 0,
    debounceMs: () => overrides?.debounceMs?.() ?? 0,
    now: () => overrides?.now ?? new Date('2026-10-12T13:00:00Z'),
  });

  return { flow, sent, notified, consulted };
}

let seq = 0;
/** Novo contato (JID único) por cenário — evita contaminação entre testes no ChatStateService global. */
function newContact(): string {
  seq += 1;
  return `55119${String(seq).padStart(8, '0')}@c.us`;
}

/** Fluxo até a confirmação de regularização (2+ parcelas em atraso). */
async function reachMultiConfirm(flow: ReturnType<typeof makeFlow>['flow'], contact: string): Promise<void> {
  await flow.handleIncomingMessage({ from: contact, body: 'Maria Silva', id: `${contact}-a` });
  await flow.handleIncomingMessage({ from: contact, body: '52998224725', id: `${contact}-b` });
  await flow.handleIncomingMessage({ from: contact, body: '1', id: `${contact}-c` });
}

class FakeWhatsAppMessage {
  private readonly client = { ok: true };
  hasMedia = true;
  body = '';
  /** Como na lib: o download depende de `this` (cliente interno). */
  async downloadMedia(): Promise<{ data: string; mimetype: string }> {
    if (!this.client.ok) throw new Error('sem cliente');
    return { data: 'ZmFrZQ==', mimetype: 'application/pdf' };
  }
}

const scenarios: Scenario[] = [
  {
    name: 'comprovante enviado como objeto da lib (método com this) é baixado e analisado',
    run: async () => {
      const analyzed: string[] = [];
      const { flow, sent } = makeFlow({ consultarPaymobi: async () => foundUmAtraso(), receiptKind: 'BOLETO' });
      (flow as unknown as { deps: { analyzeReceipt: (m: { mimetype: string }) => Promise<unknown> } }).deps.analyzeReceipt = async (m) => {
        analyzed.push(m.mimetype);
        return { kind: 'BOLETO', confidence: 'alta', evidence: [] };
      };
      const contact = newContact();
      await flow.handleIncomingMessage({ from: contact, body: 'Maria Silva', id: 'w1' });
      await flow.handleIncomingMessage({ from: contact, body: '52998224725', id: 'w2' });
      await flow.handleIncomingMessage({ from: contact, body: '3', id: 'w3' }); // celular bloqueado
      await flow.handleIncomingMessage({ from: contact, body: '2', id: 'w4' }); // já paguei
      await flow.handleIncomingMessage({ from: contact, body: '2', id: 'w5' }); // código de barras
      const media = Object.assign(new FakeWhatsAppMessage(), { from: contact, id: 'w6' });
      await flow.handleIncomingMessage(media as never);
      assert.deepEqual(analyzed, ['application/pdf'], 'o PDF deveria ser baixado e analisado');
      assert.ok(!sent.some((m) => /Ainda estou aguardando/.test(m.text)), 'não deve pedir o comprovante de novo');
    },
  },
  {
    name: 'análise de comprovante: evidências fortes, rodapé de PIX em boleto e conflito',
    run: async () => {
      // texto real do comprovante Santander (OCR)
      const santander = analyzeReceiptText('Comprovante de Pagamento de Títulos Código de barras 50950.00001 Valor Total R$ 405,63');
      assert.equal(santander.kind, 'BOLETO');
      assert.equal(santander.confidence, 'media', 'título sem linha digitável fica com confiança média');
      const ocrSantander = analyzeReceiptText('Código de barras 50950.00001 00000000000000133533933334195000000 4 Valor R$ 405,63');
      assert.equal(ocrSantander.kind, 'BOLETO');
      assert.equal(ocrSantander.confidence, 'alta', 'OCR com dígitos separados por espaço conta como código de barras');
      const linha = analyzeReceiptText('Linha digitável 23790.00000 60000.000000 00000.000000 1 99990000040563');
      assert.equal(linha.kind, 'BOLETO');
      assert.equal(linha.confidence, 'alta');
      const pix = analyzeReceiptText('Transferência PIX efetivada. Identificador E12345678202610101432ABCDE123456');
      assert.equal(pix.kind, 'PIX');
      assert.equal(pix.confidence, 'alta');
      // boleto que cita PIX no rodapé continua sendo boleto
      assert.equal(analyzeReceiptText('Linha digitável 23790.00000 60000.000000 pague também via pix').kind, 'BOLETO');
      // linha de boleto e ID de PIX juntos: não decide
      assert.equal(analyzeReceiptText('Linha digitável 23790.00000 60000.000000 E12345678202610101432ABCDE123456').kind, 'INDEFINIDO');
      assert.equal(analyzeReceiptText('texto qualquer sem termos').kind, 'INDEFINIDO');
    },
  },
  {
    name: 'análise de comprovante: visão confirma, discorda ou falta',
    run: async () => {
      const boleto = analyzeReceiptText('Linha digitável 23790.00000 60000.000000 00000.000000 1 99990000040563');
      assert.equal(combineAnalyses(boleto, 'BOLETO').confidence, 'alta');
      assert.equal(combineAnalyses(boleto, 'PIX').kind, 'INDEFINIDO', 'texto e visão discordando não decide');
      const semVisao = combineAnalyses(boleto, null);
      assert.equal(semVisao.kind, 'BOLETO');
      assert.ok(semVisao.evidence.some((e) => /indisponível/.test(e)));
      const soVisao = combineAnalyses(analyzeReceiptText('sem termos'), 'PIX');
      assert.equal(soVisao.kind, 'PIX');
      assert.equal(soVisao.confidence, 'media');
    },
  },
  {
    name: 'operador vê divergência quando o cliente diz PIX e o comprovante é boleto',
    run: async () => {
      const analysis = { kind: 'BOLETO' as const, confidence: 'alta' as const, evidence: ['linha digitável'] };
      const texto = describeReceiptForOperator(analysis, 'pix');
      assert.match(texto, /DIVERGÊNCIA/);
      assert.match(texto, /Sinais: linha digitável/);
      const ok = describeReceiptForOperator(analysis, 'boleto');
      assert.doesNotMatch(ok, /DIVERGÊNCIA/);
      const indef = describeReceiptForOperator({ kind: 'INDEFINIDO', confidence: 'baixa', evidence: [] }, undefined);
      assert.match(indef, /Não foi possível confirmar/);
    },
  },
  {
    name: 'transferência em horário de expediente: sem aviso de fora do horário',
    run: async () => {
      const { flow, sent, notified } = makeFlow({ consultarPaymobi: async () => foundMultiAtraso(), now: new Date('2026-10-12T13:00:00Z') });
      const contact = newContact();
      await reachMultiConfirm(flow, contact);
      await flow.handleIncomingMessage({ from: contact, body: '1', id: `${contact}-d` });
      assert.equal(notified.length, 1);
      assert.ok(!sent.some((m) => /não estão presentes/.test(m.text)), 'não deve avisar fora do horário em dia útil às 10h');
    },
  },
  {
    name: 'transferência no domingo: cliente recebe o aviso de retorno no próximo expediente',
    run: async () => {
      const { flow, sent, notified } = makeFlow({ consultarPaymobi: async () => foundMultiAtraso(), now: new Date('2026-10-18T13:00:00Z') });
      const contact = newContact();
      await reachMultiConfirm(flow, contact);
      await flow.handleIncomingMessage({ from: contact, body: '1', id: `${contact}-d` });
      assert.equal(notified.length, 1, 'a transferência continua sendo enviada aos atendentes');
      const notice = sent[sent.length - 1];
      assert.match(notice.text, /não estão presentes/);
      assert.match(notice.text, /seg\. a sex\. das 8h às 20h/);
      assert.match(notice.text, /assim que eles voltarem ao expediente/);
    },
  },
  {
    name: 'transferência no sábado à noite (19h) e sexta às 19h30 seguem a regra certa',
    run: async () => {
      const sat = makeFlow({ consultarPaymobi: async () => foundMultiAtraso(), now: new Date('2026-10-17T22:00:00Z') });
      const c1 = newContact();
      await reachMultiConfirm(sat.flow, c1);
      await sat.flow.handleIncomingMessage({ from: c1, body: '1', id: `${c1}-d` });
      assert.ok(sat.sent.some((m) => /não estão presentes/.test(m.text)), 'sábado 19h está fora do expediente');

      const fri = makeFlow({ consultarPaymobi: async () => foundMultiAtraso(), now: new Date('2026-10-16T22:30:00Z') });
      const c2 = newContact();
      await reachMultiConfirm(fri.flow, c2);
      await fri.flow.handleIncomingMessage({ from: c2, body: '1', id: `${c2}-d` });
      assert.ok(!fri.sent.some((m) => /não estão presentes/.test(m.text)), 'sexta 19h30 ainda está no expediente');
    },
  },
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
      await flow.handleIncomingMessage({ from: contact, body: '52998224725', id: 'a2' });
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
      await flow.handleIncomingMessage({ from: contact, body: '52998224725', id: 'b2' });
      assert.equal(consulted.length, 1);
      assert.equal(consulted[0].query, '52998224725');
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
      await flow.handleIncomingMessage({ from: contact, body: '52998224725', id: 'c2' });
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
      await flow.handleIncomingMessage({ from: contact, body: '52998224725', id: 'd2' });
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
      await flow.handleIncomingMessage({ from: contact, body: '52998224725', id: 'e2' });
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
      await flow.handleIncomingMessage({ from: contact, body: '52998224725', id: 'f2' });
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
      await flow.handleIncomingMessage({ from: contact, body: '52998224725', id: 'g2' });
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
      await flow.handleIncomingMessage({ from: contact, body: '52998224725', id: 'h2' });
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
    name: 'takeover humano: operador respondeu → bot fica em silêncio (persiste no SQLite e permite liberar)',
    run: async () => {
      const { flow, sent } = makeFlow();
      const contact = newContact();
      flow.noteHumanReply(contact);
      await flow.handleIncomingMessage({ from: contact, body: 'oi', id: 'i1' });
      assert.equal(sent.length, 0);

      // Nova instância (simula restart do processo Node): takeover deve continuar ativo via SQLite
      const secondInstance = makeFlow();
      await secondInstance.flow.handleIncomingMessage({ from: contact, body: 'oi de novo', id: 'i2' });
      assert.equal(secondInstance.sent.length, 0, 'takeover deve sobreviver entre instâncias via SQLite');

      // Operador devolve a conversa para a Athina
      secondInstance.flow.releaseHumanTakeover(contact);
      await secondInstance.flow.handleIncomingMessage({ from: contact, body: 'oi', id: 'i3' });
      assert.equal(secondInstance.sent.length, 1, 'após liberar takeover, a Athina volta a responder');
    },
  },
  {
    name: 'validação de documento: rejeita dígitos repetidos e telefones, mas aceita CNPJ de 14 dígitos',
    run: async () => {
      const { flow, sent, consulted } = makeFlow({ consultarPaymobi: async () => foundEmDia() });
      const contact = newContact();
      await flow.handleIncomingMessage({ from: contact, body: 'Maria Silva', id: 'v1' });
      await flow.handleIncomingMessage({ from: contact, body: '00000000000', id: 'v2' });
      assert.equal(consulted.length, 0, 'CPF com dígitos repetidos não deve consultar Paymobi');
      assert.ok(sent.some((m) => /CPF.*IMEI/i.test(m.text)));

      await flow.handleIncomingMessage({ from: contact, body: '(11) 98765-4321', id: 'v3' });
      assert.equal(consulted.length, 0, 'telefone formatado não deve ser confundido com CPF');

      await flow.handleIncomingMessage({ from: contact, body: '11.222.333/0001-81', id: 'v4' });
      assert.equal(consulted.length, 1, 'CNPJ válido de 14 dígitos deve consultar o Paymobi');
      assert.equal(consulted[0].query, '11222333000181');
    },
  },
  {
    name: 'performance P1: reutiliza contrato recém-consultado (<5min) no menu e extrai PIX sob demanda apenas na opção 1',
    run: async () => {
      let clock = new Date('2026-10-12T13:00:00Z');
      const pixResolvedLinks: string[] = [];
      const { flow, sent, consulted } = makeFlow({
        consultarPaymobi: async () => ({
          success: true,
          message: 'ok',
          data: {
            client: client(),
            statusContrato: 'atraso',
            overdueCount: 1,
            installments: INSTALLMENTS,
            // No lookup rápido (skipPix), parcela vem sem pixCode
            parcela: { ...PARCELA, pixCode: '', pixUrl: '' },
          },
        }),
        now: clock,
      });
      (flow as unknown as {
        deps: {
          now: () => Date;
          resolvePix: (url: string) => Promise<{ pixCode: string; pixUrl: string; qrCodePath: string }>;
        };
      }).deps.now = () => clock;
      (flow as unknown as {
        deps: {
          resolvePix: (url: string) => Promise<{ pixCode: string; pixUrl: string; qrCodePath: string }>;
        };
      }).deps.resolvePix = async (url: string) => {
        pixResolvedLinks.push(url);
        return {
          pixCode: PARCELA.pixCode,
          pixUrl: PARCELA.pixUrl,
          qrCodePath: '',
        };
      };

      const contact = newContact();
      await flow.handleIncomingMessage({ from: contact, body: 'Maria Silva', id: 'p1-1' });
      await flow.handleIncomingMessage({ from: contact, body: '52998224725', id: 'p1-2' });
      assert.equal(consulted.length, 1, 'lookup inicial faz 1 consulta na API');
      assert.equal(pixResolvedLinks.length, 0, 'lookup inicial NÃO deve abrir Playwright para extrair PIX');

      // Cliente escolhe 2 (Verificar Saldo): deve reutilizar cache sem nova consulta e sem extrair PIX
      await flow.handleIncomingMessage({ from: contact, body: '2', id: 'p1-3' });
      assert.equal(consulted.length, 1, 'Verificar Saldo dentro de 5 min deve reutilizar o contrato em cache');
      assert.equal(pixResolvedLinks.length, 0, 'Verificar Saldo não precisa extrair PIX');

      // Volta ao menu ("1" em SALDO_FOLLOWUP) e escolhe "1" (Pagar Boleto)
      await flow.handleIncomingMessage({ from: contact, body: '1', id: 'p1-4' });
      await flow.handleIncomingMessage({ from: contact, body: '1', id: 'p1-5' });
      assert.equal(consulted.length, 1, 'Pagar Boleto dentro de 5 min reutiliza o contrato');
      assert.equal(pixResolvedLinks.length, 1, 'Pagar Boleto extrai o PIX sob demanda');

      // Confirma o boleto ("1") e recebe o PIX extraído sob demanda
      await flow.handleIncomingMessage({ from: contact, body: '1', id: 'p1-6' });
      assert.ok(sent.some((m) => m.text.includes(PARCELA.pixCode)), 'deve entregar o pixCode resolvido sob demanda');
    },
  },
  {
    name: 'motor conversacional P2: Slot Jumping — cliente informa nome, CPF e intenção de pagar boleto na mesma mensagem e pula o menu principal',
    run: async () => {
      const { flow, sent, consulted } = makeFlow({ consultarPaymobi: async () => foundUmAtraso() });
      const contact = newContact();
      await flow.handleIncomingMessage({
        from: contact,
        body: 'Oi, meu nome é Maria Silva, meu CPF é 52998224725 e quero pagar meu boleto',
        id: 'nlu-1',
      });
      assert.equal(consulted.length, 1);
      assert.ok(
        sent.some((m) => /boleto em atraso/i.test(m.text) && /corretos/i.test(m.text)),
        'deve pular o menu principal e já exibir a confirmação do boleto em atraso'
      );

      // Confirma em linguagem natural ("sim, pode mandar") em vez de digitar "1"
      await flow.handleIncomingMessage({
        from: contact,
        body: 'sim, pode mandar por favor',
        id: 'nlu-2',
      });
      assert.ok(sent.some((m) => m.text.includes(PARCELA.pixCode)), 'deve aceitar confirmação em linguagem natural e enviar o PIX');
    },
  },
  {
    name: 'motor conversacional P2: navegação em linguagem natural no menu e atalho de "já paguei no pix"',
    run: async () => {
      const { flow, sent } = makeFlow({ consultarPaymobi: async () => foundUmAtraso() });
      const contact = newContact();
      await flow.handleIncomingMessage({ from: contact, body: 'Maria Silva', id: 'nlu-3' });
      await flow.handleIncomingMessage({ from: contact, body: '52998224725', id: 'nlu-4' });
      // No MAIN_MENU, em vez de "3" → "2" → "1", o cliente diz direto que o celular bloqueou mas já pagou via PIX
      await flow.handleIncomingMessage({
        from: contact,
        body: 'meu celular está bloqueado mas eu já paguei no pix hoje',
        id: 'nlu-5',
      });
      assert.ok(
        sent.some((m) => /encaminhe o comprovante/i.test(m.text)),
        'deve avançar direto para o envio do comprovante PIX sem exigir 3 menus numerados'
      );
    },
  },
  {
    name: 'motor conversacional P2: 3 fallbacks consecutivos ou mensagem hostil transferem automaticamente para humano',
    run: async () => {
      const { flow, notified } = makeFlow({ consultarPaymobi: async () => foundEmDia() });
      const contact = newContact();
      await flow.handleIncomingMessage({ from: contact, body: 'Maria Silva', id: 'fb-1' });
      await flow.handleIncomingMessage({ from: contact, body: '52998224725', id: 'fb-2' });

      // 3 respostas incompreensíveis no MAIN_MENU
      await flow.handleIncomingMessage({ from: contact, body: 'xyz123', id: 'fb-3' });
      assert.equal(notified.length, 0);
      await flow.handleIncomingMessage({ from: contact, body: 'blablabla', id: 'fb-4' });
      assert.equal(notified.length, 0);
      await flow.handleIncomingMessage({ from: contact, body: 'nao sei o que escolher kkk', id: 'fb-5' });
      assert.equal(notified.length, 1, 'na 3ª tentativa sem compreensão deve escalar para humano');
      assert.match(notified[0].reason, /fallback|compreens/i);
    },
  },
  {
    name: 'motor conversacional P2: debounce agrupa mensagens picadas enviadas em sequência rápida',
    run: async () => {
      const { flow, sent, consulted } = makeFlow({
        consultarPaymobi: async () => foundEmDia(),
        debounceMs: () => 40,
      });
      const contact = newContact();

      // Cliente manda nome e CPF em duas mensagens separadas por 5ms
      const p1 = flow.handleIncomingMessage({ from: contact, body: 'Maria Silva', id: 'db-1' });
      const p2 = flow.handleIncomingMessage({ from: contact, body: '52998224725', id: 'db-2' });
      await Promise.all([p1, p2]);

      assert.equal(consulted.length, 1, 'as duas mensagens agrupadas já completam nome + CPF e consultam o Paymobi de uma vez');
      assert.ok(
        !sent.some((m) => /informe o seu \*CPF\*/i.test(m.text)),
        'não deve pedir o CPF separadamente pois ele já veio na segunda mensagem agrupada'
      );
    },
  },
  {
    name: 'automação P3: nota de voz (áudio/ptt) enviada pelo cliente é transcrita (STT) e processada no fluxo conversacional',
    run: async () => {
      const { flow, sent, consulted } = makeFlow({ consultarPaymobi: async () => foundEmDia() });
      (flow as unknown as {
        deps: { transcribeAudio: (m: { mimetype: string }) => Promise<string | null> };
      }).deps.transcribeAudio = async (m) => {
        if (m.mimetype.startsWith('audio/')) {
          return 'Oi meu nome é Maria Silva e meu CPF é 52998224725';
        }
        return null;
      };

      const contact = newContact();
      await flow.handleIncomingMessage({
        from: contact,
        body: '',
        hasMedia: true,
        id: 'stt-1',
        downloadMedia: async () => ({ data: 'ZmFrZUF1ZGlv', mimetype: 'audio/ogg; codecs=opus' }),
      });

      assert.equal(consulted.length, 1, 'áudio transcrito com nome + CPF deve consultar o Paymobi automaticamente');
      assert.ok(sent.some((m) => /Como podemos lhe ajudar/i.test(m.text)), 'deve apresentar o menu após processar o áudio');
    },
  },
  {
    name: 'automação P3: webhook de confirmação de pagamento valida assinatura HMAC e notifica desbloqueio proativamente',
    run: async () => {
      const secret = 'segredo-webhook-teste';
      const rawBody = JSON.stringify({
        phone: '5511988887777',
        customerName: 'Maria Silva',
        installmentNumber: 4,
        value: 'R$ 405,63',
        status: 'paid',
      });
      const validSig = signWebhookPayload(rawBody, secret);

      assert.equal(verifyWebhookSignature(rawBody, validSig, secret), true);
      assert.equal(verifyWebhookSignature(rawBody, 'assinatura-invalida', secret), false);

      const sentWebhook: SentMessage[] = [];
      const res = await processPaymentWebhook(JSON.parse(rawBody), {
        sendMessage: async (to, text) => {
          sentWebhook.push({ to, text });
        },
      });

      assert.equal(res.notified, true);
      assert.equal(sentWebhook.length, 1);
      assert.equal(sentWebhook[0].to, '5511988887777@c.us');
      assert.match(sentWebhook[0].text, /pagamento.*confirmado|recebemos/i);
    },
  },
  {
    name: 'P0: CPF com dígito verificador errado (typo) não consulta o Paymobi e pede conferência',
    run: async () => {
      const { flow, sent, consulted } = makeFlow({ consultarPaymobi: async () => foundEmDia() });
      const contact = newContact();
      await flow.handleIncomingMessage({ from: contact, body: 'Maria Silva', id: 'cd-1' });
      // 52998224720: mesmo CPF do fixture, com o último dígito trocado → Mod-11 falha
      await flow.handleIncomingMessage({ from: contact, body: '52998224720', id: 'cd-2' });
      assert.equal(consulted.length, 0, 'CPF com checksum inválido não deve consultar o Paymobi');
      assert.ok(sent.some((m) => /incorreto|confira/i.test(m.text)), 'deve pedir para conferir o documento');

      await flow.handleIncomingMessage({ from: contact, body: '52998224725', id: 'cd-3' });
      assert.equal(consulted.length, 1, 'CPF válido deve consultar normalmente depois');
      assert.equal(consulted[0].clientName, 'Maria Silva', 'o nome informado antes deve ser preservado');
    },
  },
  {
    name: 'P2: o debounce padrão de produção fica na faixa humana de 1.5–2.5s (plano)',
    run: async () => {
      const flow = new AthinaFlowService({
        sendMessage: async () => {},
        consultarPaymobi: async () => NOT_FOUND,
        resolvePix: async () => ({ pixCode: '', pixUrl: '', qrCodePath: '' }),
        analyzeReceipt: async () => ({ kind: 'INDEFINIDO', confidence: 'baixa', evidence: [] }),
        transcribeAudio: async () => null,
        notifyHumans: async () => {},
        isReady: () => true,
        replyDelayMs: () => 0,
        now: () => new Date('2026-10-12T13:00:00Z'),
      });
      const d = (flow as unknown as { deps: { debounceMs: () => number } }).deps.debounceMs();
      assert.ok(d >= 1500 && d <= 2500, `debounce padrão deve ficar entre 1500 e 2500 ms (veio ${d})`);
    },
  },
  {
    name: 'P2: mídia que chega logo após texto em buffer espera o texto ser processado antes (ordem preservada)',
    run: async () => {
      const { flow, sent } = makeFlow({
        consultarPaymobi: async () => foundEmDia(),
        debounceMs: () => 40,
      });
      const contact = newContact();
      const textMsg = flow.handleIncomingMessage({ from: contact, body: 'Maria Silva', id: 'ord-1' });
      const mediaMsg = flow.handleIncomingMessage({
        from: contact,
        body: '',
        hasMedia: true,
        id: 'ord-2',
        downloadMedia: async () => ({ data: 'ZmFrZQ==', mimetype: 'image/png' }),
      });
      await Promise.all([textMsg, mediaMsg]);

      const idxAskDoc = sent.findIndex((m) => /CPF/i.test(m.text));
      const idxMedia = sent.findIndex((m) => /Recebi sua mídia/i.test(m.text));
      assert.ok(idxAskDoc !== -1, 'o texto do buffer deve ser processado');
      assert.ok(idxMedia !== -1, 'a mídia deve receber a orientação');
      assert.ok(idxAskDoc < idxMedia, 'o texto em buffer deve vir ANTES da mídia seguinte');
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
