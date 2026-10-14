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
import { isGreeting, extractPlausibleDocument, extractNameFromText } from '../utils/conversationPatterns.js';
import whatsAppService from './WhatsAppService.js';
import chatStateService, { type ChatFlowData, type ChatStage, type ChatState } from './ChatStateService.js';
import analyticsService from './AnalyticsService.js';
import { PaymobiScraperService, extractPixBounded } from './PaymobiScraperService.js';
import dialogueNluService, { type NluDecision } from './DialogueNluService.js';
import type { DeferredIntent } from '@shared/contracts.js';
import config from '../config/index.js';
import { getDb, getMeta, setMeta } from './db.js';
import { sanitizeForWhatsApp } from '../utils/sanitizeForWhatsApp.js';
import { downloadMediaBounded, analyzeReceipt, type DownloadedMedia, type ReceiptAnalysis, type ReceiptKind } from './helpers/receiptAnalysisHelper.js';
import { transcribeAudioMedia } from './helpers/audioTranscriptionHelper.js';
import { notifyHumanAgents } from './helpers/humanHandoffHelper.js';
import type { PaymobiResult } from '../types/index.js';
import * as msg from './athinaMessages.js';
import { flowText, opts } from './athinaTexts.js';
import { isWithinBusinessHours, BUSINESS_HOURS_LABEL } from '../utils/businessHours.js';

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
  consultarPaymobi: (query: string, clientName?: string, options?: { skipPix?: boolean }) => Promise<PaymobiResult>;
  resolvePix: (boletoUrl: string) => Promise<{ pixCode: string; pixUrl: string; qrCodePath: string }>;
  analyzeReceipt: (media: DownloadedMedia) => Promise<ReceiptAnalysis>;
  transcribeAudio: (media: DownloadedMedia) => Promise<string | null>;
  notifyHumans: (payload: {
    client: { nome: string; cpf: string; imei: string };
    reason: string;
    details: string;
    attachment?: DownloadedMedia;
  }) => Promise<void>;
  isReady: () => boolean;
  /** Atraso "humano" antes de cada resposta (ms) — injetável para testes (sem espera real). */
  replyDelayMs: () => number;
  /** Janela de debounce (ms) para agrupar mensagens picadas do mesmo cliente (0 = desativado). */
  debounceMs: () => number;
  /** Relógio do atendimento — injetável para testar horário de expediente. */
  now: () => Date;
}

const MAX_PROCESSED_IDS = 2000;
/** Tempo em que os dados do contrato recém-consultado no Paymobi permanecem válidos em cache (5 min). */
const CONTRACT_CACHE_TTL_MS = 5 * 60 * 1000;
/** Limite de tentativas incompreendidas consecutivas antes de transferir para atendente humano. */
const MAX_FALLBACK_STRIKES = 3;

function humanDelayMs(): number {
  const options = [2000, 3000, 4000, 5000, 7000];
  return options[Math.floor(Math.random() * options.length)];
}

const METHOD_LABEL: Record<ReceiptKind, string> = { PIX: 'PIX', BOLETO: 'boleto', INDEFINIDO: 'não identificado' };

/** Resumo para o atendente: resultado, confiança, sinais e divergência com o cliente. */
export function describeReceiptForOperator(analysis: ReceiptAnalysis, declared: 'pix' | 'boleto' | undefined): string {
  const lines = [
    `Análise do comprovante: ${METHOD_LABEL[analysis.kind]} (confiança ${analysis.confidence}).`,
    `Sinais: ${analysis.evidence.length > 0 ? analysis.evidence.join('; ') : 'nenhum'}.`,
    `Cliente informou: ${declared === 'pix' ? 'PIX' : declared === 'boleto' ? 'boleto' : 'não informou'}.`,
  ];
  const declaredKind: ReceiptKind | null = declared === 'pix' ? 'PIX' : declared === 'boleto' ? 'BOLETO' : null;
  if (analysis.kind === 'INDEFINIDO') {
    lines.push('⚠️ Não foi possível confirmar o tipo. Conferir o comprovante antes de liberar.');
  } else if (declaredKind && declaredKind !== analysis.kind) {
    lines.push(`⚠️ DIVERGÊNCIA: o cliente disse ${METHOD_LABEL[declaredKind]}, mas o comprovante indica ${METHOD_LABEL[analysis.kind]}. Conferir antes de liberar.`);
  }
  return lines.join('\n');
}

export class AthinaFlowService {
  private deps: AthinaFlowDeps;
  private pending: Map<string, Promise<void>> = new Map();
  private debounceBuffers: Map<
    string,
    {
      texts: string[];
      lastRaw: FlowIncomingMessage;
      timer: ReturnType<typeof setTimeout>;
      promise: Promise<void>;
      resolve: () => void;
    }
  > = new Map();
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
      resolvePix: deps?.resolvePix ?? extractPixBounded,
      analyzeReceipt: deps?.analyzeReceipt ?? analyzeReceipt,
      transcribeAudio: deps?.transcribeAudio ?? transcribeAudioMedia,
      notifyHumans: deps?.notifyHumans ?? this.defaultNotifyHumans,
      isReady:
        deps?.isReady ??
        (() => whatsAppService.getClientState() === 'READY' && Boolean(whatsAppService.getClient())),
      replyDelayMs: deps?.replyDelayMs ?? humanDelayMs,
      // Janela de agrupamento de mensagens picadas: 1.8s de silêncio junta
      // "oi" / "meu nome é…" / "quero pagar" num único turno lógico.
      debounceMs: deps?.debounceMs ?? (() => 1800),
      now: deps?.now ?? (() => new Date()),
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

  /** Um atendente humano respondeu pelo painel — a Athina fica em silêncio por um tempo (persistido em SQLite). */
  noteHumanReply(contactId: string): void {
    if (!contactId) return;
    this.humanTakeover.set(contactId, Date.now());
    try {
      chatStateService.setHumanTakeoverSync(contactId);
    } catch {
      /* contato não sanitizável — mantém em memória */
    }
  }

  /** Devolve o contato para o atendimento automático da Athina imediatamente. */
  releaseHumanTakeover(contactId: string): void {
    if (!contactId) return;
    this.humanTakeover.delete(contactId);
    try {
      chatStateService.clearHumanTakeoverSync(contactId);
    } catch {
      /* ignora */
    }
  }

  isHumanTakeover(contactId: string): boolean {
    if (this.humanTakeover.has(contactId)) return true;
    if (chatStateService.isHumanTakeoverActiveSync(contactId)) {
      this.humanTakeover.set(contactId, Date.now());
      return true;
    }
    return false;
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

    const debounceWindow = this.deps.debounceMs();
    if (debounceWindow > 0 && !raw.hasMedia && text) {
      const existing = this.debounceBuffers.get(from);
      if (existing) {
        existing.texts.push(text);
        existing.lastRaw = raw;
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => this.flushDebounce(from), debounceWindow);
        return existing.promise;
      }
      let resolvePromise!: () => void;
      const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
      });
      const timer = setTimeout(() => this.flushDebounce(from), debounceWindow);
      this.debounceBuffers.set(from, {
        texts: [text],
        lastRaw: raw,
        timer,
        promise,
        resolve: resolvePromise,
      });
      return promise;
    }

    // Mídia (ou mensagem sem texto) não entra no debounce, mas precisa preservar
    // a ordem: drena o texto ainda em buffer do MESMO contato antes de processar.
    if (this.debounceBuffers.has(from)) this.flushDebounce(from);
    return this.enqueueMessage(from, text, raw);
  }

  private flushDebounce(from: string): void {
    const entry = this.debounceBuffers.get(from);
    if (!entry) return;
    this.debounceBuffers.delete(from);
    clearTimeout(entry.timer);
    const combinedText = entry.texts.join('\n');
    const mergedRaw: FlowIncomingMessage = { ...entry.lastRaw, body: combinedText };
    void this.enqueueMessage(from, combinedText, mergedRaw).finally(() => entry.resolve());
  }

  private enqueueMessage(from: string, text: string, raw: FlowIncomingMessage): Promise<void> {
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

    let effectiveText = text;

    // Mídia sem texto fora do fluxo de comprovante: se for nota de voz (áudio),
    // tenta transcrever (STT) e seguir o diálogo normalmente; senão orienta o cliente.
    if (raw.hasMedia && !effectiveText && state.stage !== 'WAITING_RECEIPT') {
      if (typeof raw.downloadMedia === 'function') {
        const media = await downloadMediaBounded({
          hasMedia: raw.hasMedia,
          downloadMedia: () => raw.downloadMedia!.call(raw),
        });
        if (media && media.mimetype.startsWith('audio/')) {
          const transcribed = await this.deps.transcribeAudio(media);
          if (transcribed && transcribed.trim().length > 0) {
            effectiveText = transcribed.trim();
            this.recentInbound.set(contactId, effectiveText.slice(0, 2000));
          }
        }
      }
      if (!effectiveText) {
        await this.reply(contactId, flowText('mediaGuidance'));
        return;
      }
    }

    const nlu = await dialogueNluService.interpret({
      text: effectiveText,
      stage: state.stage,
      recentTurns: state.flow?.recentTurns,
    });

    // Escalonamento imediato por sentimento hostil quando o cliente já está identificado
    if (nlu.sentiment === 'HOSTILE' && state.flow?.client) {
      await this.reply(contactId, msg.buildTransferToSpecialistText('atender sua solicitação com prioridade'));
      await this.handoffToHumans({
        contactId,
        client: this.clientForHandoff(state.flow),
        reason: 'Cliente insatisfeito / linguagem hostil detectada',
        details: `Escalonamento automático por sentimento hostil na etapa ${state.stage}: "${effectiveText.slice(0, 300)}"`,
      });
      await chatStateService.resetFlowState(contactId);
      return;
    }

    switch (state.stage) {
      case 'MAIN_MENU':
        await this.handleMainMenu(contactId, effectiveText, state, nlu);
        return;
      case 'BOLETO_CONFIRM':
        await this.handleBoletoConfirm(contactId, effectiveText, state, nlu);
        return;
      case 'BOLETO_MULTI_CONFIRM':
        await this.handleBoletoMultiConfirm(contactId, effectiveText, state, nlu);
        return;
      case 'SALDO_FOLLOWUP':
        await this.handleSaldoFollowup(contactId, effectiveText, state, nlu);
        return;
      case 'BLOQUEIO_MENU':
        await this.handleBloqueioMenu(contactId, effectiveText, state, nlu);
        return;
      case 'BLOQUEIO_METODO':
        await this.handleBloqueioMetodo(contactId, effectiveText, state, nlu);
        return;
      case 'WAITING_RECEIPT':
        await this.handleWaitingReceipt(contactId, state, raw);
        return;
      case 'HUMAN_TOPIC':
        await this.handleHumanTopic(contactId, effectiveText, state);
        return;
      case 'HUMAN_TOPIC_CONFIRM':
        await this.handleHumanTopicConfirm(contactId, effectiveText, state, nlu);
        return;
      case 'WAITING_CONFIRMATION':
      case 'COLLECTING':
      default:
        await this.handleCollecting(contactId, effectiveText, state, nlu);
        return;
    }
  }

  // ─── Estágio: COLLECTING (nome + CPF/IMEI, com suporte a Slot Jumping) ────

  private async handleCollecting(
    contactId: string,
    text: string,
    state: ChatState,
    nlu: NluDecision
  ): Promise<void> {
    const collect = state.collect;
    const extractedDoc = nlu.extractedDoc ?? extractPlausibleDocument(text);
    // Gate de checksum (Mod-11 CPF/CNPJ, Luhn IMEI): tamanho certo com dígito
    // verificador errado NÃO consulta o Paymobi — pede conferência imediata.
    const docRejected = extractedDoc !== null && !extractedDoc.checksumValid;
    const validDoc = extractedDoc && extractedDoc.checksumValid ? extractedDoc : null;
    const hasDoc = validDoc !== null;
    const cleanDigits = validDoc?.digits ?? '';
    const extractedName = nlu.extractedName ?? extractNameFromText(text);
    const hasName = extractedName !== null;
    const nameCandidate = extractedName ?? '';

    const activeName = nameCandidate || collect?.name || '';
    const activeDoc = hasDoc ? cleanDigits : collect?.doc || '';
    const bringsNewData = hasName || hasDoc;
    const deferredIntent = nlu.deferredIntent ?? state.flow?.deferredIntent;
    const bloqueioMetodo = nlu.paymentMethod ?? state.flow?.bloqueioMetodo;
    const flowMeta: ChatFlowData = {
      ...(state.flow ?? {}),
      ...(deferredIntent ? { deferredIntent } : {}),
      ...(bloqueioMetodo ? { bloqueioMetodo } : {}),
    };

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

    // Documento com dígito verificador errado (typo do cliente): corrige na hora,
    // sem consultar o Paymobi — preserva o nome já informado.
    if (docRejected) {
      if (hasName) {
        await chatStateService.setState(contactId, {
          stage: 'COLLECTING',
          collect: { ...collect, name: nameCandidate.slice(0, 120) },
          flow: flowMeta,
        });
      }
      await this.reply(contactId, msg.buildInvalidDocText());
      return;
    }

    if (activeName && activeDoc && bringsNewData) {
      await chatStateService.setState(contactId, {
        stage: 'COLLECTING',
        collect: { name: activeName.slice(0, 120), doc: activeDoc.slice(0, 30) },
        flow: flowMeta,
      });
      await this.reply(contactId, msg.buildLookupWaitText());
      await this.runLookup(contactId, activeName, activeDoc, {
        deferredIntent,
        bloqueioMetodo,
      });
      return;
    }

    if (hasDoc && !activeName) {
      await chatStateService.setState(contactId, {
        stage: 'COLLECTING',
        collect: { ...collect, doc: cleanDigits.slice(0, 30) },
        flow: flowMeta,
      });
      await this.reply(contactId, msg.buildAskNameText());
      return;
    }

    if (hasName && !activeDoc) {
      await chatStateService.setState(contactId, {
        stage: 'COLLECTING',
        collect: { ...collect, name: nameCandidate.slice(0, 120) },
        flow: flowMeta,
      });
      await this.reply(contactId, msg.buildAskDocText(activeName));
      return;
    }

    if (isGreeting(text) && !hasDoc && !hasName && !deferredIntent) {
      await chatStateService.resetFlowState(contactId);
      await this.reply(contactId, msg.buildWelcomeText());
      return;
    }

    if (deferredIntent && !activeName && !activeDoc) {
      await chatStateService.setState(contactId, { stage: 'COLLECTING', flow: flowMeta });
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
      await chatStateService.setState(contactId, { stage: 'COLLECTING', flow: flowMeta });
      await this.reply(contactId, msg.buildAskDocText(activeName));
      return;
    }
    await this.reply(contactId, msg.buildWelcomeText());
  }

  private async runLookup(
    contactId: string,
    name: string,
    doc: string,
    extra?: { deferredIntent?: DeferredIntent; bloqueioMetodo?: 'pix' | 'boleto' }
  ): Promise<void> {
    logger.info({ contactId, doc: maskDocument(doc), name: maskName(name) }, '[AthinaFlow] Consultando Paymobi');
    const result = await this.deps.consultarPaymobi(doc, name, { skipPix: true });

    if (!result.success || !result.data) {
      await this.reply(contactId, result.message);
      // Mantém o NOME e a intenção já informados para não obrigar o cliente a repetir tudo
      await chatStateService.setState(contactId, {
        stage: 'COLLECTING',
        collect: { name },
        ...(extra?.deferredIntent
          ? { flow: { deferredIntent: extra.deferredIntent, bloqueioMetodo: extra.bloqueioMetodo } }
          : {}),
      });
      return;
    }

    await analyticsService.increment('totalChats');
    const flow: ChatFlowData = {
      client: result.data.client,
      statusContrato: result.data.statusContrato,
      overdueCount: result.data.overdueCount ?? (result.data.statusContrato === 'atraso' ? 1 : 0),
      installments: result.data.installments,
      parcela: result.data.parcela,
      contractFetchedAt: this.deps.now().getTime(),
      fallbackCount: 0,
    };

    // Slot Jumping: se o cliente já declarou a intenção durante a identificação, executa direto!
    if (extra?.deferredIntent) {
      await analyticsService.trackIntent(extra.deferredIntent);
      await this.executeIntentFromMenu(contactId, extra.deferredIntent, flow, extra.bloqueioMetodo);
      return;
    }

    await chatStateService.setFlowState(contactId, 'MAIN_MENU', flow);
    await this.reply(contactId, msg.buildMainMenuText(result.data.client));
  }

  /** Executa uma intenção de menu principal (ou salto de etapa direto para envio de comprovante). */
  private async executeIntentFromMenu(
    contactId: string,
    intent: DeferredIntent,
    flow: ChatFlowData,
    paymentMethod?: 'pix' | 'boleto' | null
  ): Promise<void> {
    const cleanFlow: ChatFlowData = { ...flow, deferredIntent: undefined, fallbackCount: 0 };

    if (intent === 'PAGAR_BOLETO') {
      await this.reply(contactId, msg.buildProcessingText());
      await this.handlePagarBoleto(contactId, cleanFlow);
      return;
    }
    if (intent === 'VERIFICAR_SALDO') {
      await this.reply(contactId, msg.buildProcessingText());
      await this.handleVerificarSaldo(contactId, cleanFlow);
      return;
    }
    if (intent === 'INFORMAR_JA_PAGUEI') {
      if (paymentMethod === 'pix' || paymentMethod === 'boleto') {
        await chatStateService.setFlowState(contactId, 'WAITING_RECEIPT', {
          ...cleanFlow,
          bloqueioMetodo: paymentMethod,
        });
        await this.reply(contactId, msg.buildAguardandoComprovanteText(paymentMethod));
        return;
      }
      await chatStateService.setFlowState(contactId, 'BLOQUEIO_METODO', cleanFlow);
      await this.reply(contactId, msg.buildBloqueioMetodoText());
      return;
    }
    if (intent === 'CELULAR_BLOQUEADO') {
      await chatStateService.setFlowState(contactId, 'BLOQUEIO_MENU', cleanFlow);
      await this.reply(contactId, msg.buildBloqueioMenuText());
      return;
    }
    // FALAR_COM_ATENDENTE
    await chatStateService.setFlowState(contactId, 'HUMAN_TOPIC', cleanFlow);
    await this.reply(contactId, msg.buildHumanTopicText());
  }

  // ─── Estágio: MAIN_MENU (1-Pagar Boleto / 2-Saldo / 3-Bloqueado / 4-Atendente + NLU) ──

  private async handleMainMenu(
    contactId: string,
    text: string,
    state: ChatState,
    nlu: NluDecision
  ): Promise<void> {
    const flow = state.flow ?? {};
    const mappedIntent: DeferredIntent | null =
      nlu.intent === 'PAGAR_BOLETO' ||
      nlu.intent === 'VERIFICAR_SALDO' ||
      nlu.intent === 'CELULAR_BLOQUEADO' ||
      nlu.intent === 'INFORMAR_JA_PAGUEI' ||
      nlu.intent === 'FALAR_COM_ATENDENTE'
        ? nlu.intent
        : null;

    if (!mappedIntent) {
      await this.handleStageFallback(
        contactId,
        'MAIN_MENU',
        flow,
        msg.buildMainMenuText(flow.client ?? { nome: '', cpf: '', imei: '', loja: '', contrato: '' }),
        text
      );
      return;
    }

    await analyticsService.trackIntent(mappedIntent);
    await this.executeIntentFromMenu(contactId, mappedIntent, flow, nlu.paymentMethod);
  }

  private isContractCacheFresh(flow: ChatFlowData): boolean {
    if (!flow.client || !flow.contractFetchedAt) return false;
    return this.deps.now().getTime() - flow.contractFetchedAt < CONTRACT_CACHE_TTL_MS;
  }

  /** Reutiliza o contrato em cache (<5min) ou reconsulta o Paymobi e decide em-dia / 1 atraso / 2+ atraso. */
  private async handlePagarBoleto(contactId: string, flow: ChatFlowData): Promise<void> {
    let nextFlow: ChatFlowData = { ...flow };

    if (!this.isContractCacheFresh(flow)) {
      const doc = flow.client?.cpf || flow.client?.imei || '';
      const result = await this.deps.consultarPaymobi(doc.replace(/\D/g, ''), flow.client?.nome, { skipPix: true });
      if (!result.success || !result.data) {
        await this.reply(contactId, result.message);
        await chatStateService.setFlowState(contactId, 'MAIN_MENU', flow);
        return;
      }
      nextFlow = {
        ...flow,
        client: result.data.client,
        statusContrato: result.data.statusContrato,
        overdueCount: result.data.overdueCount ?? 0,
        installments: result.data.installments ?? flow.installments,
        parcela: result.data.parcela,
        contractFetchedAt: this.deps.now().getTime(),
      };
    }

    const overdueCount = nextFlow.overdueCount ?? 0;
    const clientData = nextFlow.client!;

    if (overdueCount === 0 || !nextFlow.parcela) {
      await this.reply(contactId, msg.buildEmDiaText());
      await chatStateService.setFlowState(contactId, 'MAIN_MENU', nextFlow);
      await this.reply(contactId, msg.buildMainMenuText(clientData));
      return;
    }

    if (overdueCount === 1) {
      let parcela = nextFlow.parcela;
      // Lazy PIX extraction: só abre o navegador para extrair o PIX quando o cliente pede para pagar 1 parcela
      if (parcela.boletoUrl && !parcela.pixCode) {
        const pix = await this.deps.resolvePix(parcela.boletoUrl);
        parcela = { ...parcela, ...pix };
      }
      const updatedFlow = { ...nextFlow, parcela };
      await chatStateService.setFlowState(contactId, 'BOLETO_CONFIRM', updatedFlow);
      await this.reply(contactId, msg.buildBoletoSingleConfirmText(clientData, parcela));
      return;
    }

    // 2+ parcelas em atraso — negociação vai para um especialista humano.
    await chatStateService.setFlowState(contactId, 'BOLETO_MULTI_CONFIRM', nextFlow);
    await this.reply(contactId, msg.buildBoletoMultiConfirmText(overdueCount));
  }

  private async handleVerificarSaldo(contactId: string, flow: ChatFlowData): Promise<void> {
    let nextFlow: ChatFlowData = { ...flow };
    if (!this.isContractCacheFresh(flow) || !flow.installments) {
      const doc = flow.client?.cpf || flow.client?.imei || '';
      const result = await this.deps.consultarPaymobi(doc.replace(/\D/g, ''), flow.client?.nome, { skipPix: true });
      if (!result.success || !result.data) {
        await this.reply(contactId, result.message);
        await chatStateService.setFlowState(contactId, 'MAIN_MENU', flow);
        return;
      }
      nextFlow = {
        ...flow,
        client: result.data.client,
        installments: result.data.installments ?? [],
        contractFetchedAt: this.deps.now().getTime(),
      };
    }
    const installments = nextFlow.installments ?? [];
    await chatStateService.setFlowState(contactId, 'SALDO_FOLLOWUP', nextFlow);
    await this.reply(contactId, msg.buildSaldoDetailText(nextFlow.client!, installments));
  }

  // ─── Estágio: BOLETO_CONFIRM ("os dados acima estão corretos? 1/2") ────────

  private async handleBoletoConfirm(
    contactId: string,
    text: string,
    state: ChatState,
    nlu: NluDecision
  ): Promise<void> {
    const flow = state.flow ?? {};
    if (nlu.intent === 'CONFIRM_YES' && flow.parcela) {
      await this.reply(contactId, msg.buildPixDeliveryText(flow.parcela));
      if (flow.parcela.pixCode) {
        await this.reply(contactId, flow.parcela.pixCode);
      }
      await this.reply(contactId, msg.buildClosingText());
      await analyticsService.increment('autoResolved');
      await chatStateService.resetFlowState(contactId);
      return;
    }
    if (nlu.intent === 'CONFIRM_NO') {
      await this.reply(contactId, msg.buildBoletoDataWrongText());
      await chatStateService.resetFlowState(contactId);
      return;
    }
    if (nlu.intent === 'FALAR_COM_ATENDENTE') {
      await chatStateService.setFlowState(contactId, 'HUMAN_TOPIC', { ...flow, fallbackCount: 0 });
      await this.reply(contactId, msg.buildHumanTopicText());
      return;
    }
    if (!flow.client || !flow.parcela) {
      await this.reply(contactId, msg.buildWelcomeText());
      return;
    }
    await this.handleStageFallback(
      contactId,
      'BOLETO_CONFIRM',
      flow,
      opts('Sim, quero o boleto', 'Não, está errado'),
      text
    );
  }

  // ─── Estágio: BOLETO_MULTI_CONFIRM ("quer regularizar? 1/2") ───────────────

  private async handleBoletoMultiConfirm(
    contactId: string,
    text: string,
    state: ChatState,
    nlu: NluDecision
  ): Promise<void> {
    const flow = state.flow ?? {};
    if (nlu.intent === 'CONFIRM_YES' || nlu.intent === 'FALAR_COM_ATENDENTE') {
      await this.reply(contactId, msg.buildTransferToSpecialistText('regularizar suas parcelas em atraso'));
      await this.handoffToHumans({
        contactId,
        client: this.clientForHandoff(flow),
        reason: 'Regularização de múltiplas parcelas em atraso',
        details: `Cliente deseja regularizar pendências — ${flow.overdueCount ?? '2+'} parcelas em atraso.`,
      });
      await chatStateService.resetFlowState(contactId);
      return;
    }
    if (nlu.intent === 'CONFIRM_NO') {
      await this.reply(contactId, msg.buildPoliteDeclineText());
      await chatStateService.resetFlowState(contactId);
      return;
    }
    await this.handleStageFallback(
      contactId,
      'BOLETO_MULTI_CONFIRM',
      flow,
      opts('Sim, quero regularizar minhas pendências', 'Não, obrigado'),
      text
    );
  }

  // ─── Estágio: SALDO_FOLLOWUP ("algo mais? 1/2") ────────────────────────────

  private async handleSaldoFollowup(
    contactId: string,
    text: string,
    state: ChatState,
    nlu: NluDecision
  ): Promise<void> {
    const flow = state.flow ?? {};
    if (nlu.intent === 'CONFIRM_YES' || nlu.intent === 'BACK_TO_MENU') {
      await chatStateService.setFlowState(contactId, 'MAIN_MENU', { ...flow, fallbackCount: 0 });
      await this.reply(contactId, msg.buildMainMenuText(flow.client ?? { nome: '', cpf: '', imei: '', loja: '', contrato: '' }));
      return;
    }
    if (nlu.intent === 'CONFIRM_NO') {
      await this.reply(contactId, msg.buildClosingText());
      await analyticsService.increment('autoResolved');
      await chatStateService.resetFlowState(contactId);
      return;
    }
    await this.handleStageFallback(contactId, 'SALDO_FOLLOWUP', flow, opts('Sim', 'Não'), text);
  }

  // ─── Estágio: BLOQUEIO_MENU ("1 pagar / 2 já paguei / 3 voltar") ───────────

  private async handleBloqueioMenu(
    contactId: string,
    text: string,
    state: ChatState,
    nlu: NluDecision
  ): Promise<void> {
    const flow = state.flow ?? {};
    if (nlu.intent === 'PAGAR_BOLETO') {
      await this.reply(contactId, msg.buildProcessingText());
      await this.handlePagarBoleto(contactId, { ...flow, fallbackCount: 0 });
      return;
    }
    if (nlu.intent === 'INFORMAR_JA_PAGUEI') {
      if (nlu.paymentMethod === 'pix' || nlu.paymentMethod === 'boleto') {
        await chatStateService.setFlowState(contactId, 'WAITING_RECEIPT', {
          ...flow,
          bloqueioMetodo: nlu.paymentMethod,
          fallbackCount: 0,
        });
        await this.reply(contactId, msg.buildAguardandoComprovanteText(nlu.paymentMethod));
        return;
      }
      await chatStateService.setFlowState(contactId, 'BLOQUEIO_METODO', { ...flow, fallbackCount: 0 });
      await this.reply(contactId, msg.buildBloqueioMetodoText());
      return;
    }
    if (nlu.intent === 'BACK_TO_MENU') {
      await chatStateService.setFlowState(contactId, 'MAIN_MENU', { ...flow, fallbackCount: 0 });
      await this.reply(contactId, msg.buildMainMenuText(flow.client ?? { nome: '', cpf: '', imei: '', loja: '', contrato: '' }));
      return;
    }
    if (nlu.intent === 'FALAR_COM_ATENDENTE') {
      await chatStateService.setFlowState(contactId, 'HUMAN_TOPIC', { ...flow, fallbackCount: 0 });
      await this.reply(contactId, msg.buildHumanTopicText());
      return;
    }
    await this.handleStageFallback(contactId, 'BLOQUEIO_MENU', flow, msg.buildBloqueioMenuText(), text);
  }

  // ─── Estágio: BLOQUEIO_METODO ("como pagou? 1-Pix / 2-Boleto") ─────────────

  private async handleBloqueioMetodo(
    contactId: string,
    text: string,
    state: ChatState,
    nlu: NluDecision
  ): Promise<void> {
    const flow = state.flow ?? {};
    if (nlu.intent === 'PAYMENT_METHOD_PIX' || nlu.intent === 'PAYMENT_METHOD_BOLETO') {
      const metodo: 'pix' | 'boleto' = nlu.intent === 'PAYMENT_METHOD_PIX' ? 'pix' : 'boleto';
      await chatStateService.setFlowState(contactId, 'WAITING_RECEIPT', {
        ...flow,
        bloqueioMetodo: metodo,
        fallbackCount: 0,
      });
      await this.reply(contactId, msg.buildAguardandoComprovanteText(metodo));
      return;
    }
    if (nlu.intent === 'BACK_TO_MENU') {
      await chatStateService.setFlowState(contactId, 'MAIN_MENU', { ...flow, fallbackCount: 0 });
      await this.reply(contactId, msg.buildMainMenuText(flow.client ?? { nome: '', cpf: '', imei: '', loja: '', contrato: '' }));
      return;
    }
    if (nlu.intent === 'FALAR_COM_ATENDENTE') {
      await chatStateService.setFlowState(contactId, 'HUMAN_TOPIC', { ...flow, fallbackCount: 0 });
      await this.reply(contactId, msg.buildHumanTopicText());
      return;
    }
    await this.handleStageFallback(
      contactId,
      'BLOQUEIO_METODO',
      flow,
      opts('Pix', 'Código de barras'),
      text
    );
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

    const media = await downloadMediaBounded({ hasMedia: raw.hasMedia, downloadMedia: () => raw.downloadMedia!.call(raw) });
    if (!media) {
      await this.reply(contactId, msg.buildReceiptReminderText());
      return;
    }

    await analyticsService.increment('ocrScans');
    const analysis = await this.deps.analyzeReceipt(media);
    const kind = analysis.kind;
    if (kind === 'INDEFINIDO') {
      await analyticsService.increment('ocrSuspicious');
    } else {
      await analyticsService.increment('ocrValids');
    }

    await this.reply(contactId, msg.buildReceiptReceivedText(kind));
    await this.handoffToHumans({
      contactId,
      client: this.clientForHandoff(flow),
      reason: 'Comprovante de pagamento recebido (celular bloqueado)',
      details: describeReceiptForOperator(analysis, flow.bloqueioMetodo),
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

  private async handleHumanTopicConfirm(
    contactId: string,
    text: string,
    state: ChatState,
    nlu: NluDecision
  ): Promise<void> {
    const flow = state.flow ?? {};
    if (nlu.intent === 'CONFIRM_YES') {
      await this.reply(contactId, msg.buildTransferToSpecialistText('falar com nosso especialista'));
      await this.handoffToHumans({
        contactId,
        client: this.clientForHandoff(flow),
        reason: 'Falar com atendente',
        details: `Assunto informado pelo cliente: "${flow.humanTopic ?? ''}"`,
      });
      await chatStateService.resetFlowState(contactId);
      return;
    }
    if (nlu.intent === 'CONFIRM_NO') {
      await chatStateService.setFlowState(contactId, 'HUMAN_TOPIC', { ...flow, fallbackCount: 0 });
      await this.reply(contactId, msg.buildHumanTopicText());
      return;
    }
    await this.handleStageFallback(
      contactId,
      'HUMAN_TOPIC_CONFIRM',
      flow,
      opts('Sim, seguir com o atendimento', 'Não, quero digitar de novo'),
      text
    );
  }

  /**
   * Tratamento de fallback progressivo:
   * - Tentativas 1 e 2: reapresenta as opções da etapa atual.
   * - Tentativa 3 (MAX_FALLBACK_STRIKES): transfere automaticamente para atendente humano.
   */
  private async handleStageFallback(
    contactId: string,
    stage: ChatStage,
    flow: ChatFlowData,
    menuText: string,
    userText: string
  ): Promise<void> {
    const strikes = (flow.fallbackCount ?? 0) + 1;
    if (strikes >= MAX_FALLBACK_STRIKES) {
      await this.reply(contactId, msg.buildTransferToSpecialistText('concluir o seu atendimento'));
      await this.handoffToHumans({
        contactId,
        client: this.clientForHandoff(flow),
        reason: 'Dificuldade de compreensão no autoatendimento (fallback)',
        details: `Cliente enviou ${strikes} respostas não reconhecidas na etapa ${stage}. Última mensagem: "${userText.slice(0, 300)}"`,
      });
      await chatStateService.resetFlowState(contactId);
      return;
    }
    await chatStateService.setFlowState(contactId, stage, { ...flow, fallbackCount: strikes });
    await this.reply(contactId, msg.buildInvalidMenuChoiceText(menuText));
  }

  // ─── Helpers compartilhados ─────────────────────────────────────────────────

  /**
   * Transfere para os atendentes. Fora do expediente, o cliente também recebe
   * o aviso de que o especialista retorna no próximo horário de atendimento.
   */
  private async handoffToHumans(payload: Parameters<AthinaFlowDeps['notifyHumans']>[0] & { contactId?: string }): Promise<void> {
    const { contactId, ...handoff } = payload;
    await this.deps.notifyHumans(handoff);
    if (contactId && !isWithinBusinessHours(this.deps.now())) {
      await this.reply(contactId, flowText('offHours').replace('{horario}', BUSINESS_HOURS_LABEL));
    }
  }

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

  private async defaultConsultarPaymobi(
    query: string,
    clientName?: string,
    options?: { skipPix?: boolean }
  ): Promise<PaymobiResult> {
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
      skipPix: options?.skipPix,
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
      whatsAppService.alertOperators(`Transferência de ${payload.client.nome} NÃO enviada: WhatsApp indisponível.`);
      return;
    }
    const { delivered, total } = await notifyHumanAgents(client, payload);
    if (delivered < total || total === 0) {
      whatsAppService.alertOperators(
        total === 0
          ? `Transferência de ${payload.client.nome} NÃO enviada: nenhum atendente configurado (HUMAN_HANDOFF_CONTACTS).`
          : `Transferência de ${payload.client.nome}: ${delivered} de ${total} atendentes notificados. Verifique os logs [HumanHandoff].`
      );
    }
  }
}

const athinaFlowService = new AthinaFlowService();
athinaFlowService.restoreEnabled();

export default athinaFlowService;
