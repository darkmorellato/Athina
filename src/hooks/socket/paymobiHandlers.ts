import type { Message } from '../../types/index.js';
import { formatTime, nowTs, cancelHuman, scheduleHuman, waOutbound } from './socketHelpers.js';

interface PaymobiHandlerContext {
  socket: any;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  addLog: (text: string, type?: 'info' | 'success' | 'process' | 'error') => void;
  setIsAgentTyping: React.Dispatch<React.SetStateAction<boolean>>;
}

/** Texto de confirmação de cadastro (compartilhado com o estágio de confirmação). */
export function buildConfirmationText(data: { client: any; parcela: any }): string {
  const { client, parcela } = data;
  return `👤 Confirmamos seu cadastro!\n\n📝 Nome: ${client.nome}\n🆔 CPF/CNPJ: ${client.cpf}\n📱 IMEI: ${client.imei}\n\n💵 Pagamento: Parcela ${parcela.numero}/${parcela.total}\n💵 Valor: ${parcela.valor}\n📅 Vencimento: ${parcela.vencimento}\n📊 Status: ${parcela.status}\n\nOs dados acima estão corretos? Por favor, responda com **SIM** para confirmar seu boleto, ou **NÃO** para corrigir.\n\n**Deseja reiniciar o atendimento do zero?**\n**1-Sim** (começa tudo de novo)\n**2-Não** (segue com a confirmação acima)`;
}

export function handlePaymobiResult(
  ctx: PaymobiHandlerContext,
  data: { result: any; contactId?: string }
): void {
  const { setMessages, socket, addLog, setIsAgentTyping } = ctx;
  const { result } = data;
  const contactId = data.contactId ?? '';
  const contactName = contactId.split('@')[0];

  // Resultado novo → derruba respostas pendentes antigas do contato
  cancelHuman(contactId);

  if (!result) {
    setIsAgentTyping(false);
    return;
  }

  if (result.success && result.data) {
    const parcela = result.data.parcela;

    if (parcela) {
      // Update chat state to WAITING_CONFIRMATION via backend
      socket.emit('update-chat-state', {
        contactId,
        state: {
          stage: 'WAITING_CONFIRMATION',
          pendingData: result.data,
        },
      });

      const confirmationText = waOutbound(buildConfirmationText(result.data));

      // Atraso humano (2-7s): o estado já foi salvo; a mensagem "digita" antes.
      // A confirmação (dados + valor/data + SIM/NÃO) aparece UMA única vez.
      scheduleHuman(contactId, () => {
        setIsAgentTyping(false);
        const agentMsg1: Message = {
          id: `ai-${Date.now()}-confirm`,
          text: confirmationText,
          sender: 'agent',
          fromId: contactId,
          time: formatTime(),
          timestamp: nowTs(),
        };
        setMessages((prev) => [...prev, agentMsg1]);
        socket.emit('send-reply', { to: contactId, text: confirmationText });
        addLog(`Confirmação enviada para ${contactName}`, 'success');
      });
    } else {
      const okText = waOutbound(result.message || 'Parabéns! Você está em dia com todas as parcelas!');
      scheduleHuman(contactId, () => {
        setIsAgentTyping(false);
        const agentMsg: Message = {
          id: `ai-${Date.now()}-in-dia`,
          text: okText,
          sender: 'agent',
          fromId: contactId,
          time: formatTime(),
          timestamp: nowTs(),
        };
        setMessages((prev) => [...prev, agentMsg]);
        socket.emit('send-reply', { to: contactId, text: okText });
        addLog(`Cliente em dia: ${contactName}`, 'success');
      });
    }
  } else {
    const reasonText = waOutbound(
      result.reason === 'CONTRACT_FINALIZED'
      ? "Encontramos seu cadastro, pois ja foi nosso cliente. Mas seu contrato conosco se encontra Quitado. Algo que eu possa te ajudar?"
      : result.message
    );

    scheduleHuman(contactId, () => {
      setIsAgentTyping(false);
      const agentMsg: Message = {
        id: `ai-${Date.now()}-failed`,
        text: reasonText,
        sender: 'agent',
        fromId: contactId,
        time: formatTime(),
        timestamp: nowTs(),
      };
      setMessages((prev) => [...prev, agentMsg]);
      socket.emit('send-reply', { to: contactId, text: reasonText });
      addLog(`Status: ${reasonText}`, 'info');
    });
  }
}

export function handlePaymobiError(
  ctx: Pick<PaymobiHandlerContext, 'setMessages' | 'socket' | 'addLog' | 'setIsAgentTyping'>,
  data: { message: string; contactId?: string }
): void {
  const { setMessages, socket, addLog, setIsAgentTyping } = ctx;
  const contactId = data.contactId || '';
  const contactName = contactId ? contactId.split('@')[0] : 'Cliente';
  const errorText = waOutbound('Desculpe, ocorreu uma instabilidade temporária no sistema de busca. Por favor, tente novamente em alguns instantes.');

  addLog(`Erro Paymobi para ${contactName}: ${data.message}`, 'error');

  if (contactId) {
    cancelHuman(contactId);
    scheduleHuman(contactId, () => {
      setIsAgentTyping(false);
      const agentMsg: Message = {
        id: `ai-${Date.now()}-error`,
        text: errorText,
        sender: 'agent',
        fromId: contactId,
        time: formatTime(),
        timestamp: nowTs(),
      };
      setMessages((prev) => [...prev, agentMsg]);
      socket.emit('send-reply', { to: contactId, text: errorText });
    });
  } else {
    setIsAgentTyping(false);
  }
}
