import { HOSTILE_TERMS } from '../../types/index.js';
import type { AgentLog, AnalyticsStats } from '../../types/index.js';
import {
  isGreeting as sharedIsGreeting,
  hasCpfOrImei as sharedHasCpfOrImei,
  isFullName as sharedIsFullName,
  sanitizeForWhatsApp,
} from '@shared/validators.js';

export const INITIAL_LOGS: AgentLog[] = [
  { id: 'init', type: 'info', text: 'Agente Athina inicializada.', time: new Date().toLocaleTimeString() },
];

export const DEFAULT_STATS: AnalyticsStats = {
  totalChats: 0,
  autoResolved: 0,
  humanInterventions: 0,
  ocrScans: 0,
  ocrValids: 0,
  ocrSuspicious: 0,
  intentCounts: {},
};

// Sound alert for hostile messages (Web Audio API)
export function playAlertSound(): void {
  try {
    const AudioCtor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const audioCtx = new AudioCtor!();
    const playNote = (freq: number, duration: number, delay: number): void => {
      const osc = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      osc.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime + delay);
      gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime + delay);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + delay + duration);
      osc.start(audioCtx.currentTime + delay);
      osc.stop(audioCtx.currentTime + delay + duration);
    };
    playNote(880, 0.15, 0);
    playNote(1109, 0.25, 0.18);
  } catch {
    console.warn('AudioContext not available');
  }
}

export function isGreeting(text: string): boolean {
  return sharedIsGreeting(text);
}

export function hasCpfOrImei(text: string): boolean {
  return sharedHasCpfOrImei(text);
}

export function isFullName(text: string): boolean {
  return sharedIsFullName(text);
}

export function isHostileMessage(text: string): boolean {
  if (!text) return false;
  const clean = text.toLowerCase();
  return HOSTILE_TERMS.some((term) => clean.includes(term));
}

/** Format current time as HH:MM */
/**
 * Atraso "humano" para as respostas do painel: sorteia entre 2s e 7s para
 * simular digitação/leitura de um atendente real (nunca mais o mesmo tempo).
 */
export function humanDelayMs(): number {
  const options = [2000, 3000, 4000, 5000, 7000];
  return options[Math.floor(Math.random() * options.length)];
}

/**
 * Espelho EXATO de sanitizeForWhatsApp() do backend (utils/sanitizeForWhatsApp.ts):
 * TODO texto do 'send-reply' é sanitizado lá antes de ir ao WhatsApp, então a
 * mensagem local do painel precisa ter a MESMA forma — senão a mensagem real
 * que volta (message_create) difere do rascunho local, o dedupe não acha o
 * gêmeo e a mensagem aparece DUPLICADA no chat.
 */
export function waOutbound(text: string): string {
  return sanitizeForWhatsApp(text);
}

/** Unix em SEGUNDOS — timestamp das mensagens criadas localmente no painel
 *  (sem isto elas eram ordenadas por último, fora da cronologia). */
export function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Timers de resposta agendados POR CONTATO. Ao chegar uma mensagem nova,
 * cancelHuman() derruba envios pendentes antigos — acabam as respostas
 * "fantasma" (confirmação reenviada depois do reinício, por exemplo).
 */
const pendingTimers = new Map<string, number[]>();

export function cancelHuman(contactId: string): void {
  const timers = pendingTimers.get(contactId);
  if (timers) {
    for (const t of timers) window.clearTimeout(t);
    pendingTimers.delete(contactId);
  }
}

/** Agenda fn com atraso humano (2-7s) associado ao contato (auto-cancela). */
export function scheduleHuman(contactId: string, fn: () => void): void {
  const id = window.setTimeout(() => {
    const list = pendingTimers.get(contactId) ?? [];
    pendingTimers.set(contactId, list.filter((t) => t !== id));
    fn();
  }, humanDelayMs());
  const list = pendingTimers.get(contactId) ?? [];
  list.push(id);
  pendingTimers.set(contactId, list);
}

/**
 * Boas-vindas do fluxo: pede UMA coisa por vez (nome primeiro), como um
 * atendente humano — nunca nome + CPF juntos.
 */
export function buildWelcomeText(): string {
  return (
    'Bem-vindo(a) ao suporte da Financeira Nuovopay! 🌟\n\n' +
    'Sou a Athina, assistente virtual da Nuovopay, e vou te ajudar com segurança.\n\n' +
    'Para localizarmos seu contrato, me informe seu **nome completo**, por favor. 👤\n\n' +
    '🔒 Por segurança, os dados devem ser do PRÓPRIO titular do contrato.\n\n' +
    '**Deseja reiniciar o atendimento do zero?**\n' +
    '**1-Sim** (começa tudo de novo)\n' +
    '**2-Não** (continua informando seu nome)'
  );
}

export function formatTime(date: Date = new Date()): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Generate a unique message ID with timestamp + random suffix */
export function createMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Map AI response text to a quick reply index.
 * Returns -1 if the response is a custom message (not a template).
 */
export function buildAIResponseIndex(text: string): number {
  if (!text) return -1;
  const clean = text.trim().toLowerCase();
  if (clean === '1' || clean.includes('[resposta 1]') || clean.includes('bem-vindo')) {
    return 0;
  }
  if (clean === '2' || clean.includes('[resposta 2]') || clean.includes('aguarde')) {
    return 1;
  }
  if (clean === '3' || clean === '5' || clean.includes('[resposta 3]') || clean.includes('boleto')) {
    return 2;
  }
  return -1;
}
