import type { Socket } from 'socket.io-client';
import type { Message, WAMessage } from '../../types/index.js';
import {
  formatTime,
  isFullName,
  isGreeting,
  nowTs,
  cancelHuman,
  scheduleHuman,
  buildWelcomeText,
  waOutbound,
} from './socketHelpers.js';

/** Dados parciais da coleta persistidos NO SERVIDOR (por contato). */
export interface CollectData {
  name?: string;
  doc?: string;
}

interface CollectingContext {
  socket: Socket;
  contactId: string;
  contactName: string;
  bodyClean: string;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  quickRepliesRef: React.MutableRefObject<string[]>;
  /** Coleta parcial vinda do estado do servidor (NUNCA do histórico). */
  collect?: CollectData;
  addLog: (text: string, type?: 'info' | 'success' | 'process' | 'error') => void;
  setIsAgentTyping: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * Etapa de COLETA — sempre um dado por vez (fluxo humano):
 *   oi → pede NOME → cliente manda nome → pede CPF/IMEI →
 *   cliente manda documento → confirmação (valor/data + SIM/NÃO) → boleto.
 *
 * Nome/CPF em andamento ficam no `collect` do estado do servidor, SALVO POR
 * CONTATO. Antes esta etapa varria o histórico de mensagens e misturava o CPF
 * de uma conversa com o nome de outra (consulta no cliente errado).
 */
export function handleStageCollecting(ctx: CollectingContext, msg: WAMessage): void {
  const {
    socket,
    contactId,
    contactName,
    bodyClean,
    setMessages,
    quickRepliesRef,
    collect,
    addLog,
    setIsAgentTyping,
  } = ctx;

  // Mensagem nova do cliente → derruba respostas pendentes antigas
  // (evita respostas "fantasma" chegando depois de um reinício).
  cancelHuman(contactId);

  const cleanDigits = bodyClean.replace(/\D/g, '');
  const isCpfMatch = cleanDigits.length === 11;
  const isImeiMatch = cleanDigits.length === 15;
  const hasCpfOrImeiValue = isCpfMatch || isImeiMatch;

  const textWithoutNumbers = bodyClean.replace(/[0-9\n\r\t.\-/]/g, ' ').replace(/\s+/g, ' ').trim();
  const hasName = isFullName(textWithoutNumbers);
  const nameCandidate = hasName ? textWithoutNumbers : '';

  /** Persiste o dado parcial no servidor (sobrescrevendo só o campo). */
  const saveCollect = (patch: Partial<CollectData>): void => {
    socket.emit('update-chat-state', {
      contactId,
      state: { stage: 'COLLECTING', collect: { ...collect, ...patch } },
    });
  };

  const pushAndSend = (rawText: string, idSuffix: string): void => {
    const text = waOutbound(rawText);
    const agentMsg: Message = {
      id: `ai-${Date.now()}-${idSuffix}`,
      text,
      sender: 'agent',
      fromId: contactId,
      time: formatTime(),
      timestamp: nowTs(),
    };
    setMessages((prev) => [...prev, agentMsg]);
    socket.emit('send-reply', { to: contactId, text });
  };

  // Atalho **1-Sim** oferecido nas mensagens: o cliente pediu para reiniciar.
  const choice = bodyClean.trim();
  if (choice === '1' || choice === '01') {
    socket.emit('reset-chat-state', { contactId });
    setIsAgentTyping(true);
    scheduleHuman(contactId, () => {
      setIsAgentTyping(false);
      pushAndSend(buildWelcomeText(), 'restart');
      addLog(`Cliente escolheu reiniciar o atendimento (${contactName})`, 'info');
    });
    return;
  }

  // O que JÁ foi coletado neste atendimento (estado do servidor) + o que
  // acabou de chegar nesta mensagem.
  const activeName = nameCandidate || collect?.name || '';
  const activeDoc = hasCpfOrImeiValue ? cleanDigits : collect?.doc || '';
  const currentSuppliesData = hasName || hasCpfOrImeiValue;

  // "Não sei / onde vejo" → ajuda UMA coisa por vez (nome, ou documento se
  // o nome já foi dado)
  const userDoesNotKnow = /\b(n[aã]o\s+sei|n[aã]o\s+lembr|esquec|n[aã]o\s+tenh|perdi|onde\s+vejo|como\s+vejo|como\s+olho)\b/i.test(bodyClean);
  if (userDoesNotKnow) {
    setIsAgentTyping(true);
    scheduleHuman(contactId, () => {
      setIsAgentTyping(false);
      pushAndSend(
        activeName
          ? 'Sem problemas! Você encontra o IMEI discando **#06#** no próprio celular. Me envie o seu **IMEI** (15 dígitos), por favor. 📲'
          : 'Sem problemas! Para começarmos, me informe o seu **nome completo**, por favor. 👤',
        'no-info'
      );
      addLog(`Cliente não sabe os dados. Orientação enviada para ${contactName}`, 'info');
    });
    return;
  }

  // ─── Nome + documento COMPLETOS e a mensagem atual trouxe dado novo →
  //      consulta (os dois ficam salvos para o caso de erro/retentativa) ─────
  if (activeName && activeDoc && currentSuppliesData) {
    setIsAgentTyping(true);
    saveCollect({ name: activeName.slice(0, 120), doc: activeDoc.slice(0, 30) });
    addLog(`Dados completos: "${activeName}" + "${activeDoc}". Buscando Paymobi...`, 'process');

    const waitText = waOutbound(quickRepliesRef.current[1]);
    const waitMsg: Message = {
      id: `ai-${Date.now()}-wait`,
      text: waitText,
      sender: 'agent',
      fromId: contactId,
      time: formatTime(),
      timestamp: nowTs(),
    };
    setMessages((prev) => [...prev, waitMsg]);
    socket.emit('send-reply', { to: contactId, text: waitText });
    socket.emit('consult-paymobi', { query: activeDoc, clientName: activeName, contactId });
    return;
  }

  // ─── Documento sem nome → pede NOME ──────────────────────────────────────
  if (hasCpfOrImeiValue && !activeName) {
    saveCollect({ doc: cleanDigits.slice(0, 30) });
    setIsAgentTyping(true);
    scheduleHuman(contactId, () => {
      setIsAgentTyping(false);
      pushAndSend(
        'Obrigada por informar seus dados! Para localizar seu cadastro com segurança, por favor, digite também o seu **Nome Completo**. 👤',
        'prompt-name'
      );
      addLog(`CPF/IMEI recebido. Solicitando Nome de ${contactName}`, 'info');
    });
    return;
  }

  // ─── Nome sem documento → pede CPF ou IMEI ───────────────────────────────
  if (hasName && !activeDoc) {
    saveCollect({ name: nameCandidate.slice(0, 120) });
    setIsAgentTyping(true);
    scheduleHuman(contactId, () => {
      setIsAgentTyping(false);
      pushAndSend(
        `Obrigada, ${activeName}! Para localizarmos seu contrato, por favor informe o seu **CPF** ou o **IMEI** do aparelho. 📲`,
        'prompt-cpf'
      );
      addLog(`Nome recebido. Solicitando CPF/IMEI de ${contactName}`, 'info');
    });
    return;
  }

  // ─── Saudação → limpa coleta parcial e envia boas-vindas (pede só o NOME)
  if (isGreeting(msg.body) && !hasCpfOrImeiValue && !hasName) {
    socket.emit('reset-chat-state', { contactId });
    setIsAgentTyping(true);
    addLog('Saudação detectada. Enviando boas-vindas...', 'process');
    scheduleHuman(contactId, () => {
      setIsAgentTyping(false);
      pushAndSend(buildWelcomeText(), 'welcome');
      addLog(`Boas-vindas enviadas para ${contactName}`, 'success');
    });
    return;
  }

  // ─── Default: pede o dado que FALTA (sequencial, um por vez) ─────────────
  setIsAgentTyping(true);
  scheduleHuman(contactId, () => {
    setIsAgentTyping(false);
    if (activeName && activeDoc) {
      // Os dois dados já estão salvos, mas a mensagem não trouxe dado novo
      // (ex.: a consulta falhou). NÃO reconsulta sozinha — pede o CPF/IMEI.
      pushAndSend(
        'Seus dados já estão preenchidos. Para eu consultar novamente, envie o seu **CPF** ou **IMEI** uma vez, ou **1-Sim** para reiniciar o atendimento.',
        'enforce-retry'
      );
    } else if (activeName) {
      pushAndSend('Para localizarmos seu contrato, por favor informe o seu **CPF** ou o **IMEI** do aparelho. 📲', 'enforce-doc');
    } else {
      pushAndSend(
        'Para darmos início ao atendimento, me informe o seu **nome completo**, por favor. 👤\n\n**Deseja reiniciar o atendimento do zero?**\n**1-Sim** (começa tudo de novo)\n**2-Não** (continua informando seu nome)',
        'enforce'
      );
    }
    addLog(`Solicitando dados de ${contactName}`, 'info');
  });
}
