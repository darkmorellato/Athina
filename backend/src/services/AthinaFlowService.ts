/**
 * @fileoverview Roteiro determinístico de atendimento da Athina (24/7).
 *
 * Implementa o fluxo desenhado em `workflow athina.excalidraw`: saudação →
 * coleta de nome + CPF/IMEI → consulta de cadastro → menu numerado
 * (1-Pagar Boleto / 2-Verificar Saldo / 3-Celular Bloqueado / 4-Falar com
 * atendente) → sub-fluxos de boleto único vs. múltiplos atrasados, saldo
 * detalhado, desbloqueio por comprovante (PIX/boleto) e transferência para
 * atendente humano.
 *
 * É o ÚNICO atendimento automático (`AGENT_AUTOREPLY=true`): não há modelo
 * de linguagem decidindo o que responder — cada mensagem
 * do cliente é interpretada por regras simples (número da opção, nome, CPF/
 * IMEI, mídia) e a próxima mensagem é escolhida por um `switch` sobre o
 * estágio salvo em `ChatStateService`. O único ponto onde um modelo de IA
 * entra é a classificação do comprovante de pagamento (visão), feita em
 * `receiptAnalysisHelper.ts` e com fallback seguro quando não configurada.
 */
import { LRUCache } from 'lru-cache';
import logger from '../utils/logger.js';
import { maskDocument, maskName } from '../utils/redact.js';
import { isGreeting, isFullName } from '../utils/conversationPatterns.js';
import whatsAppService from './WhatsAppService.js';
import chatStateService, { type ChatFlowData, type ChatState } from './ChatStateService.js';
import analyticsService from './AnalyticsService.js';
import { PaymobiScraperService } from './PaymobiScraperService.js';
import config from '../config/index.js';
import { getDb, getMeta, setMeta } from './db.js';
import { sanitizeForWhatsApp } from '../utils/sanitizeForWhatsApp.js';
import { downloadMediaBounded, classifyReceipt, type DownloadedMedia } from './helpers/receiptAnalysisHelper.js';
import { notifyHumanAgents } from './helpers/humanHandoffHelper.js';
import type { PaymobiResult } from '../types/index.js';
import * as msg from './athinaMessages.js';
import { flowText, opts } from './athinaTexts.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface FlowIncomingMessage {
  from?: string;
  body?: string;
  fromMe?: boolean;
  hasMedia?: boolean;
  id?: { id?: string } | string;
  downloadMedia?: () => Promise<{ data: string; mimetype: string } | null | undefined>;
}

export interface AthinaFlowDeps {
  sendMessage: (to: string, text: string) => Promise<void>;
  consultarPaymobi: (query: string, clientName?: string) => Promise<PaymobiResult>;
  analyzeReceipt: (media: DownloadedMedia) => Promise<'PIX' | 'BOLETO' | 'INDEFINIDO'>;
  notifyHumans: (payload: {
    client: { nome: string; cpf: string; imei: string };
    reason: string;
    details: string;
    attachment?: DownloadedMedia;
  }) => Promise<void>;
  isReady: () => boolean;
  /** Atraso "humano" antes de cada resposta (ms) — injetável para testes (sem espera real). */
  replyDelayMs: () => number;
}

const MAX_PROCESSED_IDS = 2000;
const MAIN_MENU_OPTIONS = new Set(['1', '2', '3', '4']);

function humanDelayMs(): number {
  const options = [2000, 3000, 4000, 5000, 7000];
  return options[Math.floor(Math.random() * options.length)];
}

export class AthinaFlowService {
  private deps: AthinaFlowDeps;
  private pending: Map<string, Promise<void>> = new Map();
  private processedIds = new Set<string>();
  private processedOrder: string[] = [];
  private humanTakeover = new LRUCache<string, number>({ max: 500, ttl: 10 * 60 * 1000 });
  /** Última mensagem de TEXTO do cliente por contato (base do aprendizado do painel). */
  private recentInbound = new LRUCache<string, string>({ max: 500, ttl: 24 * 60 * 60 * 1000 });
  /** Liga/desliga em tempo real pelo painel (null = segue AGENT_AUTOREPLY do .env). */
  private enabledOverride: boolean | null = null;

  constructor(deps?: Partial<AthinaFlowDeps>) {
    this.deps = {
      sendMessage: deps?.sendMessage ?? this.defaultSendMessage,
      consultarPaymobi: deps?.consultarPaymobi ?? this.defaultConsultarPaymobi,
      analyzeReceipt: deps?.analyzeReceipt ?? classifyReceipt,
      notifyHumans: deps?.notifyHumans ?? this.defaultNotifyHumans,
      isReady:
        deps?.isReady ??
        (() => whatsAppService.getClientState() === 'READY' && Boolean(whatsAppService.getClient())),
      replyDelayMs: deps?.replyDelayMs ?? humanDelayMs,
    };
  }

  /** True quando a Athina está respondendo clientes automaticamente. */
  isEnabled(): boolean {
    return this.enabledOverride ?? config.agentAutoReply;
  }

  /** Liga/desliga o atendimento automático e persiste a escolha entre reinícios. */
  setEnabled(enabled: boolean): void {
    this.enabledOverride = enabled;
    try {
      setMeta(getDb(), 'auto_reply_enabled', enabled ? '1' : '0');
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        '[AthinaFlow] Não foi possível persistir o estado do atendimento automático'
      );
    }
    logger.info({ enabled }, '[AthinaFlow] Atendimento automático alterado pelo painel');
  }

  /** Recupera a última escolha feita no painel (chamado só no boot do singleton). */
  restoreEnabled(): void {
    try {
      const saved = getMeta(getDb(), 'auto_reply_enabled');
      if (saved !== null) this.enabledOverride = saved === '1';
    } catch {
      /* sem banco — segue o .env */
    }
  }

  /** Última mensagem de texto recebida do contato (ou null). */
  getLastInbound(contactId: string): string | null {
    return this.recentInbound.get(contactId) ?? null;
  }

  /** Um atendente humano respondeu pelo painel — a Athina fica em silêncio por um tempo. */
  noteHumanReply(contactId: string): void {
    if (!contactId) return;
    this.humanTakeover.set(contactId, Date.now());
  }

  private isHumanTakeover(contactId: string): boolean {
    return this.humanTakeover.has(contactId);
  }

  // ─── Entry point ──────────────────────────────────────────────────────────

  async handleIncomingMessage(raw: FlowIncomingMessage): Promise<void> {
    const from = typeof raw?.from === 'string' ? raw.from : '';
    const text = (typeof raw?.body === 'string' ? raw.body : '').trim();

    const isCustomerChat = Boolean(raw) && !raw.fromMe && Boolean(from) && !from.includes('broadcast') && !from.endsWith('@g.us');
    // O aprendizado do painel precisa da última pergunta do cliente mesmo com o
    // autoatendimento desligado.
    if (isCustomerChat && text) this.recentInbound.set(from, text.slice(0, 2000));

    if (!this.isEnabled()) return;
    if (!isCustomerChat) return;
    if (!text && !raw.hasMedia) return;

    const msgId = typeof raw.id === 'string' ? raw.id : raw.id?.id;
    if (msgId) {
      if (this.processedIds.has(msgId)) return;
      this.processedIds.add(msgId);
      this.processedOrder.push(msgId);
      while (this.processedOrder.length > MAX_PROCESSED_IDS) {
        this.processedIds.delete(this.processedOrder.shift()!);
      }
    }

    const previous = this.pending.get(from) ?? Promise.resolve();
    const task = previous
      .then(() => {
        if (!this.deps.isReady()) return;
        return this.processMessage(from, text, raw);
      })
      .catch((err) => {
        logger.error(
          { error: err instanceof Error ? err.message : String(err), from },
          '[AthinaFlow] Falha ao processar mensagem'
        );
      })
      .finally(() => {
        if (this.pending.get(from) === task) this.pending.delete(from);
      });
    this.pending.set(from, task);
    return task;
  }

  private async processMessage(contactId: string, text: string, raw: FlowIncomingMessage): Promise<void> {
    if (this.isHumanTakeover(contactId)) {
      logger.info({ contactId }, '[AthinaFlow] Atendente humano assumiu — bot em silêncio');
      return;
    }

    const state = (await chatStateService.getState(contactId)) ?? { stage: 'COLLECTING', createdAt: Date.now(), updatedAt: Date.now() };

    // Mídia sem texto fora do fluxo de comprovante (único estágio que espera
    // mídia) — orienta o cliente em vez de tratar o corpo vazio como resposta.
    if (raw.hasMedia && !text && state.stage !== 'WAITING_RECEIPT') {
      await this.reply(contactId, flowText('mediaGuidance'));
      return;
    }

    switch (state.stage) {
      case 'MAIN_MENU':
        await this.handleMainMenu(contactId, text, state);
        return;
      case 'BOLETO_CONFIRM':
        await this.handleBoletoConfirm(contactId, text, state);
        return;
      case 'BOLETO_MULTI_CONFIRM':
        await this.handleBoletoMultiConfirm(contactId, text, state);
        return;
      case 'SALDO_FOLLOWUP':
        await this.handleSaldoFollowup(contactId, text, state);
        return;
      case 'BLOQUEIO_MENU':
        await this.handleBloqueioMenu(contactId, text, state);
        return;
      case 'BLOQUEIO_METODO':
        await this.handleBloqueioMetodo(contactId, text, state);
        return;
      case 'WAITING_RECEIPT':
        await this.handleWaitingReceipt(contactId, state, raw);
        return;
      case 'HUMAN_TOPIC':
        await this.handleHumanTopic(contactId, text, state);
        return;
      case 'HUMAN_TOPIC_CONFIRM':
        await this.handleHumanTopicConfirm(contactId, text, state);
        return;
      case 'WAITING_CONFIRMATION':
      case 'COLLECTING':
      default:
        await this.handleCollecting(contactId, text, state);
        return;
    }
  }

  // ─── Estágio: COLLECTING (nome + CPF/IMEI, um por vez) ─────────────────────

  private async handleCollecting(contactId: string, text: string, state: ChatState): Promise<void> {
    const collect = state.collect;
    const cleanDigits = text.replace(/\D/g, '');
    const hasDoc = cleanDigits.length === 11 || cleanDigits.length === 15;
    const textWithoutNumbers = text.replace(/[0-9\n\r\t.\-/]/g, ' ').replace(/\s+/g, ' ').trim();
    const hasName = isFullName(textWithoutNumbers);
    const nameCandidate = hasName ? textWithoutNumbers : '';

    const activeName = nameCandidate || collect?.name || '';
    const activeDoc = hasDoc ? cleanDigits : collect?.doc || '';
    const bringsNewData = hasName || hasDoc;

    const userDoesNotKnow = /\b(n[aã]o\s+sei|n[aã]o\s+lembr|esquec|n[aã]o\s+tenh|perdi|onde\s+vejo|como\s+vejo|como\s+olho)\b/i.test(
      text
    );
    if (userDoesNotKnow) {
      await this.reply(
        contactId,
        activeName
          ? 'Sem problemas! Você encontra o IMEI discando *#06#* no próprio celular. Me envie o seu *IMEI* (15 dígitos), por favor. 📲'
          : msg.buildWelcomeText()
      );
      return;
    }

    if (activeName && activeDoc && bringsNewData) {
      await chatStateService.setState(contactId, { stage: 'COLLECTING', collect: { name: activeName.slice(0, 120), doc: activeDoc.slice(0, 30) } });
      await this.reply(contactId, msg.buildLookupWaitText());
      await this.runLookup(contactId, activeName, activeDoc);
      return;
    }

    if (hasDoc && !activeName) {
      await chatStateService.setState(contactId, { stage: 'COLLECTING', collect: { ...collect, doc: cleanDigits.slice(0, 30) } });
      await this.reply(contactId, msg.buildAskNameText());
      return;
    }

    if (hasName && !activeDoc) {
      await chatStateService.setState(contactId, { stage: 'COLLECTING', collect: { ...collect, name: nameCandidate.slice(0, 120) } });
      await this.reply(contactId, msg.buildAskDocText(activeName));
      return;
    }

    if (isGreeting(text) && !hasDoc && !hasName) {
      await chatStateService.resetFlowState(contactId);
      await this.reply(contactId, msg.buildWelcomeText());
      return;
    }

    if (activeName && activeDoc) {
      await this.reply(
        contactId,
        'Seus dados já estão preenchidos. Para eu consultar novamente, envie o seu *CPF* ou *IMEI* uma vez, por favor.'
      );
      return;
    }
    if (activeName) {
      await this.reply(contactId, msg.buildAskDocText(activeName));
      return;
    }
    await this.reply(contactId, msg.buildWelcomeText());
  }

  private async runLookup(contactId: string, name: string, doc: string): Promise<void> {
    logger.info({ contactId, doc: maskDocument(doc), name: maskName(name) }, '[AthinaFlow] Consultando Paymobi');
    const result = await this.deps.consultarPaymobi(doc, name);

    if (!result.success || !result.data) {
      await this.reply(contactId, result.message);
      // Mantém o NOME já informado — a mensagem de "não encontrado" só pede
      // para conferir o CPF/CNPJ ou enviar o IMEI, não para recomeçar do zero.
      await chatStateService.setState(contactId, { stage: 'COLLECTING', collect: { name } });
      return;
    }

    await analyticsService.increment('totalChats');
    const flow: ChatFlowData = {
      client: result.data.client,
      statusContrato: result.data.statusContrato,
      overdueCount: result.data.overdueCount ?? (result.data.statusContrato === 'atraso' ? 1 : 0),
      installments: result.data.installments,
    };
    await chatStateService.setFlowState(contactId, 'MAIN_MENU', flow);
    await this.reply(contactId, msg.buildMainMenuText(result.data.client));
  }

  // ─── Estágio: MAIN_MENU (1-Pagar Boleto / 2-Saldo / 3-Bloqueado / 4-Atendente) ──

  private async handleMainMenu(contactId: string, text: string, state: ChatState): Promise<void> {
    const choice = text.trim();
    const flow = state.flow ?? {};
    if (!MAIN_MENU_OPTIONS.has(choice)) {
      await this.reply(contactId, msg.buildInvalidMenuChoiceText(msg.buildMainMenuText(flow.client ?? { nome: '', cpf: '', imei: '', loja: '', contrato: '' })));
      return;
    }

    if (choice === '1') {
      await this.reply(contactId, msg.buildProcessingText());
      await this.handlePagarBoleto(contactId, flow);
      return;
    }
    if (choice === '2') {
      await this.reply(contactId, msg.buildProcessingText());
      await this.handleVerificarSaldo(contactId, flow);
      return;
    }
    if (choice === '3') {
      await chatStateService.setFlowState(contactId, 'BLOQUEIO_MENU', flow);
      await this.reply(contactId, msg.buildBloqueioMenuText());
      return;
    }
    // choice === '4'
    await chatStateService.setFlowState(contactId, 'HUMAN_TOPIC', flow);
    await this.reply(contactId, msg.buildHumanTopicText());
  }

  /** Reconsulta o Paymobi (dados já coletados) e decide em-dia / 1 atraso / 2+ atraso. */
  private async handlePagarBoleto(contactId: string, flow: ChatFlowData): Promise<void> {
    const doc = flow.client?.cpf || flow.client?.imei || '';
    const result = await this.deps.consultarPaymobi(doc.replace(/\D/g, ''), flow.client?.nome);
    if (!result.success || !result.data) {
      await this.reply(contactId, result.message);
      await chatStateService.setFlowState(contactId, 'MAIN_MENU', flow);
      return;
    }

    const overdueCount = result.data.overdueCount ?? 0;
    const nextFlow: ChatFlowData = {
      ...flow,
      client: result.data.client,
      statusContrato: result.data.statusContrato,
      overdueCount,
      installments: result.data.installments ?? flow.installments,
    };

    if (overdueCount === 0 || !result.data.parcela) {
      await this.reply(contactId, msg.buildEmDiaText());
      await chatStateService.setFlowState(contactId, 'MAIN_MENU', nextFlow);
      await this.reply(contactId, msg.buildMainMenuText(result.data.client));
      return;
    }

    if (overdueCount === 1) {
      await chatStateService.setFlowState(contactId, 'BOLETO_CONFIRM', { ...nextFlow, parcela: result.data.parcela });
      await this.reply(contactId, msg.buildBoletoSingleConfirmText(result.data.client, result.data.parcela));
      return;
    }

    // 2+ parcelas em atraso — negociação vai para um especialista humano.
    await chatStateService.setFlowState(contactId, 'BOLETO_MULTI_CONFIRM', nextFlow);
    await this.reply(contactId, msg.buildBoletoMultiConfirmText(overdueCount));
  }

  private async handleVerificarSaldo(contactId: string, flow: ChatFlowData): Promise<void> {
    const doc = flow.client?.cpf || flow.client?.imei || '';
    const result = await this.deps.consultarPaymobi(doc.replace(/\D/g, ''), flow.client?.nome);
    if (!result.success || !result.data) {
      await this.reply(contactId, result.message);
      await chatStateService.setFlowState(contactId, 'MAIN_MENU', flow);
      return;
    }
    const installments = result.data.installments ?? [];
    const nextFlow: ChatFlowData = { ...flow, client: result.data.client, installments };
    await chatStateService.setFlowState(contactId, 'SALDO_FOLLOWUP', nextFlow);
    await this.reply(contactId, msg.buildSaldoDetailText(result.data.client, installments));
  }

  // ─── Estágio: BOLETO_CONFIRM ("os dados acima estão corretos? 1/2") ────────

  private async handleBoletoConfirm(contactId: string, text: string, state: ChatState): Promise<void> {
    const choice = text.trim();
    const flow = state.flow ?? {};
    if (choice === '1' && flow.parcela) {
      await this.reply(contactId, msg.buildPixDeliveryText(flow.parcela));
      if (flow.parcela.pixCode) {
        await this.reply(contactId, flow.parcela.pixCode);
      }
      await this.reply(contactId, msg.buildClosingText());
      await analyticsService.increment('autoResolved');
      await chatStateService.resetFlowState(contactId);
      return;
    }
    if (choice === '2') {
      await this.reply(contactId, msg.buildBoletoDataWrongText());
      await chatStateService.resetFlowState(contactId);
      return;
    }
    await this.reply(
      contactId,
      flow.client && flow.parcela
        ? msg.buildInvalidMenuChoiceText(opts('Sim, quero o boleto', 'Não, está errado'))
        : msg.buildWelcomeText()
    );
  }

  // ─── Estágio: BOLETO_MULTI_CONFIRM ("quer regularizar? 1/2") ───────────────

  private async handleBoletoMultiConfirm(contactId: string, text: string, state: ChatState): Promise<void> {
    const choice = text.trim();
    const flow = state.flow ?? {};
    if (choice === '1') {
      await this.reply(contactId, msg.buildTransferToSpecialistText('regularizar suas parcelas em atraso'));
      await this.deps.notifyHumans({
        client: this.clientForHandoff(flow),
        reason: 'Regularização de múltiplas parcelas em atraso',
        details: `Cliente deseja regularizar pendências — ${flow.overdueCount ?? '2+'} parcelas em atraso.`,
      });
      await chatStateService.resetFlowState(contactId);
      return;
    }
    if (choice === '2') {
      await this.reply(contactId, msg.buildPoliteDeclineText());
      await chatStateService.resetFlowState(contactId);
      return;
    }
    await this.reply(contactId, msg.buildInvalidMenuChoiceText(opts('Sim, quero regularizar minhas pendências', 'Não, obrigado')));
  }

  // ─── Estágio: SALDO_FOLLOWUP ("algo mais? 1/2") ────────────────────────────

  private async handleSaldoFollowup(contactId: string, text: string, state: ChatState): Promise<void> {
    const choice = text.trim();
    const flow = state.flow ?? {};
    if (choice === '1') {
      await chatStateService.setFlowState(contactId, 'MAIN_MENU', flow);
      await this.reply(contactId, msg.buildMainMenuText(flow.client ?? { nome: '', cpf: '', imei: '', loja: '', contrato: '' }));
      return;
    }
    if (choice === '2') {
      await this.reply(contactId, msg.buildClosingText());
      await analyticsService.increment('autoResolved');
      await chatStateService.resetFlowState(contactId);
      return;
    }
    await this.reply(contactId, msg.buildInvalidMenuChoiceText(opts('Sim', 'Não')));
  }

  // ─── Estágio: BLOQUEIO_MENU ("1 pagar / 2 já paguei / 3 voltar") ───────────

  private async handleBloqueioMenu(contactId: string, text: string, state: ChatState): Promise<void> {
    const choice = text.trim();
    const flow = state.flow ?? {};
    if (choice === '1') {
      await this.reply(contactId, msg.buildProcessingText());
      await this.handlePagarBoleto(contactId, flow);
      return;
    }
    if (choice === '2') {
      await chatStateService.setFlowState(contactId, 'BLOQUEIO_METODO', flow);
      await this.reply(contactId, msg.buildBloqueioMetodoText());
      return;
    }
    if (choice === '3') {
      await chatStateService.setFlowState(contactId, 'MAIN_MENU', flow);
      await this.reply(contactId, msg.buildMainMenuText(flow.client ?? { nome: '', cpf: '', imei: '', loja: '', contrato: '' }));
      return;
    }
    await this.reply(contactId, msg.buildInvalidMenuChoiceText(msg.buildBloqueioMenuText()));
  }

  // ─── Estágio: BLOQUEIO_METODO ("como pagou? 1-Pix / 2-Boleto") ─────────────

  private async handleBloqueioMetodo(contactId: string, text: string, state: ChatState): Promise<void> {
    const choice = text.trim();
    const flow = state.flow ?? {};
    if (choice !== '1' && choice !== '2') {
      await this.reply(contactId, msg.buildInvalidMenuChoiceText(opts('Pix', 'Código de barras')));
      return;
    }
    const metodo: 'pix' | 'boleto' = choice === '1' ? 'pix' : 'boleto';
    await chatStateService.setFlowState(contactId, 'WAITING_RECEIPT', { ...flow, bloqueioMetodo: metodo });
    await this.reply(contactId, msg.buildAguardandoComprovanteText(metodo));
  }

  // ─── Estágio: WAITING_RECEIPT (espera a foto/PDF do comprovante) ──────────

  private async handleWaitingReceipt(
    contactId: string,
    state: ChatState,
    raw: FlowIncomingMessage
  ): Promise<void> {
    const flow = state.flow ?? {};
    if (!raw.hasMedia || typeof raw.downloadMedia !== 'function') {
      await this.reply(contactId, msg.buildReceiptReminderText());
      return;
    }

    const media = await downloadMediaBounded({ hasMedia: raw.hasMedia, downloadMedia: raw.downloadMedia });
    if (!media) {
      await this.reply(contactId, msg.buildReceiptReminderText());
      return;
    }

    await analyticsService.increment('ocrScans');
    const kind = await this.deps.analyzeReceipt(media);
    if (kind === 'INDEFINIDO') {
      await analyticsService.increment('ocrSuspicious');
    } else {
      await analyticsService.increment('ocrValids');
    }

    await this.reply(contactId, msg.buildReceiptReceivedText(kind));
    await this.deps.notifyHumans({
      client: this.clientForHandoff(flow),
      reason: 'Comprovante de pagamento recebido (celular bloqueado)',
      details: `Comprovante analisado como: ${kind}. Método informado pelo cliente: ${flow.bloqueioMetodo ?? 'não informado'}.`,
      attachment: media,
    });
    await chatStateService.resetFlowState(contactId);
  }

  // ─── Estágio: HUMAN_TOPIC / HUMAN_TOPIC_CONFIRM ("falar com atendente") ────

  private async handleHumanTopic(contactId: string, text: string, state: ChatState): Promise<void> {
    const flow = state.flow ?? {};
    const topic = text.trim().slice(0, 500);
    if (!topic) {
      await this.reply(contactId, msg.buildHumanTopicText());
      return;
    }
    await chatStateService.setFlowState(contactId, 'HUMAN_TOPIC_CONFIRM', { ...flow, humanTopic: topic });
    await this.reply(contactId, msg.buildHumanTopicConfirmText(topic));
  }

  private async handleHumanTopicConfirm(contactId: string, text: string, state: ChatState): Promise<void> {
    const choice = text.trim();
    const flow = state.flow ?? {};
    if (choice === '1') {
      await this.reply(contactId, msg.buildTransferToSpecialistText('falar com nosso especialista'));
      await this.deps.notifyHumans({
        client: this.clientForHandoff(flow),
        reason: 'Falar com atendente',
        details: `Assunto informado pelo cliente: "${flow.humanTopic ?? ''}"`,
      });
      await chatStateService.resetFlowState(contactId);
      return;
    }
    if (choice === '2') {
      await chatStateService.setFlowState(contactId, 'HUMAN_TOPIC', flow);
      await this.reply(contactId, msg.buildHumanTopicText());
      return;
    }
    await this.reply(contactId, msg.buildInvalidMenuChoiceText(opts('Sim, seguir com o atendimento', 'Não, quero digitar de novo')));
  }

  // ─── Helpers compartilhados ─────────────────────────────────────────────────

  private clientForHandoff(flow: ChatFlowData): { nome: string; cpf: string; imei: string } {
    return {
      nome: flow.client?.nome ?? 'Não identificado',
      cpf: flow.client?.cpf ?? '',
      imei: flow.client?.imei ?? '',
    };
  }

  /** Envia a resposta ao cliente com o mesmo atraso humano e a mesma
   *  sanitização (markdown→WhatsApp, máscara de CPF) de toda saída. */
  private async reply(contactId: string, text: string): Promise<void> {
    if (this.isHumanTakeover(contactId)) return;
    await new Promise((resolve) => setTimeout(resolve, this.deps.replyDelayMs()));
    if (this.isHumanTakeover(contactId)) return;
    const sanitized = sanitizeForWhatsApp(text);
    await this.deps.sendMessage(contactId, sanitized);
  }

  // ─── Default (production) dependencies ─────────────────────────────────────

  private async defaultSendMessage(to: string, text: string): Promise<void> {
    const client = whatsAppService.getClient();
    if (!client) throw new Error('WhatsApp client not available');
    const chunks = text.match(/[\s\S]{1,3800}/g) ?? [text];
    for (const chunk of chunks) {
      await client.sendMessage(to, chunk);
    }
  }

  private async defaultConsultarPaymobi(query: string, clientName?: string): Promise<PaymobiResult> {
    const email = config.paymobiEmail;
    const password = config.paymobiPassword;
    if (!email || !password) {
      return { success: false, message: 'Sistema de consulta não configurado no servidor.' };
    }
    const scraper = new PaymobiScraperService(email, password);
    return scraper.scrape({
      query,
      clientName,
      searchType: query.length === 15 ? 'imei' : query.length === 14 ? 'cnpj' : 'cpf',
    });
  }

  private async defaultNotifyHumans(payload: {
    client: { nome: string; cpf: string; imei: string };
    reason: string;
    details: string;
    attachment?: DownloadedMedia;
  }): Promise<void> {
    const client = whatsAppService.getClient();
    if (!client) {
      logger.warn('[AthinaFlow] WhatsApp client indisponível — transferência não notificada');
      return;
    }
    await notifyHumanAgents(client, payload);
  }
}

const athinaFlowService = new AthinaFlowService();
athinaFlowService.restoreEnabled();

export default athinaFlowService;
