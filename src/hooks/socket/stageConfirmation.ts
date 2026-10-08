import type { Socket } from 'socket.io-client';
import type { Message } from '../../types/index.js';
import {
  formatTime,
  nowTs,
  cancelHuman,
  scheduleHuman,
  buildWelcomeText,
  waOutbound,
} from './socketHelpers.js';

interface ConfirmationContext {
  socket: Socket;
  contactId: string;
  contactName: string;
  bodyLower: string;
  chatStates: Record<string, any>;
  saveChatStates: (states: Record<string, any>) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  quickRepliesRef: React.MutableRefObject<string[]>;
  addLog: (text: string, type?: 'info' | 'success' | 'process' | 'error') => void;
  setIsAgentTyping: React.Dispatch<React.SetStateAction<boolean>>;
}

/** Prompt CURTO para respostas indefinidas — os dados do contrato NÃO são
 *  reenviados (regra: os dados aparecem UMA única vez). */
function buildShortConfirmPrompt(): string {
  return (
    'Por favor, responda apenas:\n' +
    '**SIM** — confirma os dados e recebe o boleto\n' +
    '**NÃO** — quero corrigir os dados\n\n' +
    '**Deseja reiniciar o atendimento do zero?**\n' +
    '**1-Sim** (começa tudo de novo)\n' +
    '**2-Não** (segue para a confirmação)'
  );
}

export function handleStageConfirmation(ctx: ConfirmationContext): void {
  const {
    socket,
    contactId,
    contactName,
    bodyLower,
    chatStates,
    setMessages,
    addLog,
    setIsAgentTyping,
  } = ctx;

  // Mensagem nova do cliente → derruba envios pendentes antigos
  // (acabam as respostas "fantasma" — tipo confirmação após reinício).
  cancelHuman(contactId);

  const isYes =
    /\b(sim|s|si|y|yes|ok|okay|confirm[ao]|corret[oo]|isso)\b/i.test(bodyLower) ||
    bodyLower.trim() === 's';
  const isNo =
    /\b(n[ãa]o|nao|errad[oa]|incorret[oa]|diferente|trocar|troca|revisar|corrigir|alterar|troquei)\b/i.test(
      bodyLower
    ) || bodyLower.trim() === 'n';

  const choice = bodyLower.trim();
  // Atalhos oferecidos na mensagem: **1-Sim** reinicia, **2-Não** segue.
  const wantsRestart = choice === '1' || choice === '01';
  const wantsContinue = choice === '2' || choice === '02';

  const pending = chatStates[contactId]?.pendingData;

  const pushAndSend = (rawText: string, idSuffix: string): void => {
    // Forma final do texto (mesma sanitização do backend) → o rascunho local
    // é idêntico ao que volta do WhatsApp: sem duplicação, com negrito real.
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

  // ─── SIM + dados pendentes → boleto → PIX → agradece → reinicia ──────────
  if (isYes && pending?.parcela) {
    setIsAgentTyping(true);
    // Reinício automático acontece AQUI; as mensagens abaixo saem em sequência.
    socket.emit('reset-chat-state', { contactId });

    const pixUrl = pending.parcela.pixUrl || pending.parcela.boletoUrl;
    const pixText = `data.cel.cash\n${pixUrl}\n\n➡ Aqui está seu boleto PIX para pagamento:\n\nPara realizar o pagamento, acesse o link e copie o código.\n\n🔗 Link de pagamento via Pix (desbloqueio imediato): ${pixUrl}\n🔗 Link do boleto completo: ${pending.parcela.boletoUrl}\n\n⚠ Aviso:\nPagamentos efetuados por pix tem sua compensação instantanea.\nPagamentos efetuados pelo código de barras podem levar até 3 dias úteis para compensar.`;
    const thanksText =
      'Agradecemos o seu contato! 💙 Foi um prazer te atender.\n\nEnvie "oi" quando quiser — estamos sempre por aqui. 😊';
    const sendThanks = (): void => {
      pushAndSend(thanksText, 'thanks');
      setIsAgentTyping(false);
      addLog(`Atendimento concluído e reiniciado para ${contactName}`, 'success');
    };

    // 1) boleto/PIX
    scheduleHuman(contactId, () => {
      pushAndSend(pixText, 'pix');
      addLog(`Boleto/PIX enviado para ${contactName}`, 'success');

      // 2) código PIX copia-e-cola; 3) agradecimento
      if (pending.parcela.pixCode) {
        scheduleHuman(contactId, () => {
          pushAndSend(pending.parcela.pixCode, 'code');
          addLog(`PIX Copia e Cola enviado para ${contactName}`, 'success');
          scheduleHuman(contactId, sendThanks);
        });
      } else {
        scheduleHuman(contactId, sendThanks);
      }
    });
    return;
  }

  // ─── NÃO / *1-Sim* (reiniciar) / SIM sem dados → reinicia ───────────────
  if (isNo || isYes || wantsRestart) {
    socket.emit('reset-chat-state', { contactId });
    setIsAgentTyping(true);
    scheduleHuman(contactId, () => {
      setIsAgentTyping(false);
      pushAndSend(buildWelcomeText(), 'welcome');
      addLog(
        wantsRestart
          ? `Cliente escolheu reiniciar o atendimento (${contactName})`
          : isYes
            ? `SIM recebido sem dados pendentes — atendimento reiniciado para ${contactName}`
            : `Correção solicitada — atendimento reiniciado para ${contactName}`,
        'info'
      );
    });
    return;
  }

  // ─── Resposta indefinida / *2-Não* → lembra só o MÉTODO (dados não repetem)
  if (pending?.parcela || wantsContinue) {
    setIsAgentTyping(true);
    scheduleHuman(contactId, () => {
      setIsAgentTyping(false);
      pushAndSend(buildShortConfirmPrompt(), 'reconfirm');
      addLog(
        wantsContinue
          ? `Cliente optou por seguir sem reiniciar (${contactName})`
          : `Confirmação relembrada para ${contactName} (sem repetir dados)`,
        'info'
      );
    });
    return;
  }

  // Sem dados pendentes → reinicia (comportamento antigo)
  socket.emit('reset-chat-state', { contactId });
  setIsAgentTyping(true);
  scheduleHuman(contactId, () => {
    setIsAgentTyping(false);
    pushAndSend(buildWelcomeText(), 'welcome');
    addLog(`Atendimento reiniciado para ${contactName}`, 'info');
  });
}
