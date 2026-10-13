/**
 * @fileoverview Textos PT-BR do roteiro determinístico da Athina
 * (AthinaFlowService) — um por nó do `workflow athina.excalidraw`.
 *
 * A redação do boas-vindas, do boleto PIX e do encerramento é a MESMA já
 * aprovada em produção no fluxo do painel (`src/hooks/socket/socketHelpers.ts`
 * e `stageConfirmation.ts`) — repetida aqui porque backend e frontend não
 * compartilham módulo de UI (só `shared/contracts.ts`, reservado a schemas).
 *
 * `*negrito*` é a formatação nativa do WhatsApp — NÃO usar `**`/markdown aqui
 * (quem faz a conversão de `**` é o painel; o backend já escreve direto no
 * formato final).
 */
import type { ChatClientData, ChatInstallmentSummary, ChatParcelaData } from './ChatStateService.js';
import type { ReceiptKind } from './helpers/receiptAnalysisHelper.js';
import { flowText, opts } from './athinaTexts.js';

export function buildWelcomeText(): string {
  return flowText('welcome');
}

export function buildAskDocText(name: string): string {
  return `Obrigada, ${name}! Para localizarmos seu contrato, por favor informe o seu *CPF* ou o *IMEI* do aparelho. 📲`;
}

export function buildAskNameText(): string {
  return flowText('askName');
}

export function buildLookupWaitText(): string {
  return flowText('lookupWait');
}

export function buildMainMenuText(client: ChatClientData): string {
  return (
    'Encontramos seu cadastro! ✅\n\n' +
    `📝 Nome: ${client.nome}\n` +
    `🆔 CPF/CNPJ: ${client.cpf}\n` +
    `📱 IMEI: ${client.imei}\n\n` +
    '👇 *Como podemos lhe ajudar?*\n' +
    'Responda apenas com o *número* da opção:\n\n' +
    opts('Pagar Boleto', 'Verificar Saldo restante', 'Celular Bloqueado', 'Falar com atendente')
  );
}

export function buildInvalidMenuChoiceText(menuText: string): string {
  return `Não entendi sua resposta. 🤔 Por favor, responda apenas com o número de uma das opções abaixo:\n\n${menuText}`;
}

export function buildProcessingText(): string {
  return flowText('processing');
}

export function buildEmDiaText(): string {
  return flowText('emDia');
}

export function buildBoletoSingleConfirmText(client: ChatClientData, parcela: ChatParcelaData): string {
  return (
    'Identificamos um boleto em atraso! 🔴\n\n' +
    'Para desbloquear seu celular, efetue o pagamento via PIX. O aparelho deve estar conectado à ' +
    'internet (wifi ou dados móveis) para o desbloqueio automático.\n\n' +
    `📝 Nome: ${client.nome}\n` +
    `🆔 CPF/CNPJ: ${client.cpf}\n` +
    `📱 IMEI: ${client.imei}\n` +
    `💵 Parcela: ${parcela.numero}/${parcela.total}\n` +
    `💵 Valor: ${parcela.valor}\n` +
    `📅 Vencimento: ${parcela.vencimento}\n` +
    `📊 Status: ${parcela.status}\n\n` +
    '✅ *Os dados acima estão corretos?*\n\n' +
    opts('Sim, quero o boleto', 'Não, está errado')
  );
}

/** Mesma redação já aprovada em `stageConfirmation.ts` (pixText). */
export function buildPixDeliveryText(parcela: ChatParcelaData): string {
  const pixUrl = parcela.pixUrl || parcela.boletoUrl;
  return (
    `data.cel.cash\n${pixUrl}\n\n` +
    '➡ Aqui está seu boleto PIX para pagamento:\n\n' +
    'Para realizar o pagamento, acesse o link e copie o código.\n\n' +
    `🔗 Link de pagamento via Pix (desbloqueio imediato): ${pixUrl}\n` +
    `🔗 Link do boleto completo: ${parcela.boletoUrl}\n\n` +
    '⚠ Aviso:\n' +
    'Pagamentos efetuados por pix tem sua compensação instantanea.\n' +
    'Pagamentos efetuados pelo código de barras podem levar até 3 dias úteis para compensar.'
  );
}

/** Mesma redação já aprovada em `stageConfirmation.ts` (thanksText). */
export function buildClosingText(): string {
  return flowText('closing');
}

export function buildBoletoDataWrongText(): string {
  return flowText('boletoDataWrong');
}

export function buildBoletoMultiConfirmText(overdueCount: number): string {
  return (
    `Identificamos ${overdueCount} boletos em atraso! 🔴\n\n` +
    'Mas não se preocupe, temos uma boa notícia para você! Efetuando o pagamento de uma parcela, ' +
    'conseguimos atualizar as outras parcelas em atraso e você volta a usufruir do aparelho ' +
    'normalmente.\n\n' +
    '👇 *O que deseja fazer?*\n\n' +
    opts('Sim, quero regularizar minhas pendências', 'Não, obrigado')
  );
}

export function buildTransferToSpecialistText(reason: string): string {
  return flowText('transfer').replace('{motivo}', reason);
}

export function buildPoliteDeclineText(): string {
  return flowText('politeDecline');
}

export function buildSaldoDetailText(client: ChatClientData, installments: ChatInstallmentSummary[]): string {
  const lista = installments
    .map((inst) => `${inst.numero}ª parcela ${inst.valor} - Venc. ${inst.vencimento} - ${inst.status}`)
    .join('\n');
  return (
    `💰 Saldo atual — ${client.nome}\n\n` +
    `Seu contrato está parcelado em ${installments.length} parcelas:\n\n` +
    `${lista}\n\n` +
    '👇 *Algo mais em que podemos ajudar?*\n\n' +
    opts('Sim', 'Não')
  );
}

export function buildBloqueioMenuText(): string {
  return flowText('bloqueioMenu');
}

export function buildBloqueioMetodoText(): string {
  return flowText('bloqueioMetodo');
}

export function buildAguardandoComprovanteText(metodo: 'pix' | 'boleto'): string {
  const aviso =
    metodo === 'pix'
      ? 'Pagamentos por PIX costumam ser imediatos.\n\nVerifique se seu aparelho está conectado à internet (dados móveis ou wifi).'
      : 'Pagamentos por código de barras podem levar até 3 dias úteis para compensar.';
  return `💠 ${aviso}\n\nPor gentileza, encaminhe o comprovante do pagamento para análise. 📎`;
}

export function buildReceiptReminderText(): string {
  return flowText('receiptReminder');
}

export function buildReceiptReceivedText(kind: ReceiptKind): string {
  const via = kind === 'PIX' ? ' via PIX' : kind === 'BOLETO' ? ' via boleto' : '';
  return `Ótimo! Recebemos seu comprovante de pagamento${via}. ${buildTransferToSpecialistText('dar continuidade ao seu atendimento')}`;
}

export function buildHumanTopicText(): string {
  return flowText('humanTopic');
}

export function buildHumanTopicConfirmText(topic: string): string {
  return (
    `Entendi, você quer falar sobre:\n\n"${topic}"\n\n` +
    '👇 *Está certo?*\n\n' +
    opts('Sim, seguir com o atendimento', 'Não, quero digitar de novo')
  );
}
