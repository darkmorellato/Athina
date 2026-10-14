/**
 * @fileoverview Textos EDITÁVEIS do roteiro da Athina (aba Treinamento).
 *
 * Cada texto tem um padrão no código; se o operador editar pelo painel, a
 * versão salva no SQLite passa a valer na hora (cache em memória, sem reiniciar).
 * "Restaurar padrão" apaga a versão salva. Só os textos SEM dados do cliente
 * são editáveis — PIX, boleto e menus com nome/CPF continuam no código.
 */
import logger from '../utils/logger.js';
import { getDb } from './db.js';

export interface FlowTextDef {
  key: string;
  stage: string;
  label: string;
  defaultText: string;
  /** Placeholders aceitos no texto (ex.: {motivo}) */
  placeholders: string[];
}

const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];

/** Opções numeradas em negrito, com emoji de tecla: o cliente vê e responde com o número. */
export function opts(...labels: string[]): string {
  return labels.map((label, i) => `${KEYCAPS[i]} *${label}*`).join('\n');
}

export const FLOW_TEXT_DEFS: readonly FlowTextDef[] = [
  {
    key: 'welcome',
    stage: 'Início',
    label: 'Boas-vindas',
    placeholders: [],
    defaultText:
      'Bem-vindo(a) ao suporte da Financeira Nuovopay! 🌟\n\n' +
      'Sou a Athina, assistente virtual da Nuovopay, e vou te ajudar com segurança.\n\n' +
      'Para localizarmos seu contrato, me informe seu *nome completo*, por favor. 👤\n\n' +
      '🔒 Por segurança, os dados devem ser do PRÓPRIO titular do contrato.',
  },
  {
    key: 'askName',
    stage: 'Coleta',
    label: 'Pedir nome (quando o CPF/IMEI chega antes)',
    placeholders: [],
    defaultText:
      'Obrigada por informar seus dados! Para localizar seu cadastro com segurança, por favor, digite também o seu *Nome Completo*. 👤',
  },
  {
    key: 'lookupWait',
    stage: 'Consulta',
    label: 'Aviso enquanto consulta',
    placeholders: [],
    defaultText:
      'Obrigada pelas informações! 🙏\n\n' +
      'Estamos consultando os dados do seu contrato no sistema. Por favor, aguarde um momento...',
  },
  {
    key: 'processing',
    stage: 'Menu',
    label: 'Processando solicitação',
    placeholders: [],
    defaultText: 'Processando sua solicitação...\n\nAguarde um momento...',
  },
  {
    key: 'emDia',
    stage: 'Boleto',
    label: 'Contrato em dia',
    placeholders: [],
    defaultText: 'Parabéns! 🎉 Você está em dia com todas as parcelas!',
  },
  {
    key: 'boletoDataWrong',
    stage: 'Boleto',
    label: 'Dados do boleto estão errados',
    placeholders: [],
    defaultText:
      'Sem problemas! Vamos conferir seus dados novamente.\n\nPara localizarmos seu contrato, me informe seu *nome completo*, por favor. 👤',
  },
  {
    key: 'transfer',
    stage: 'Transferência',
    label: 'Transferir para especialista',
    placeholders: ['{motivo}'],
    defaultText:
      'Ótimo! Vou te transferir para um especialista para ajudá-lo(a) a {motivo}. 🙂\n\nAguarde um momento que logo você será atendido(a).',
  },
  {
    key: 'offHours',
    stage: 'Atendente',
    label: 'Fora do horário de atendimento (após transferir)',
    placeholders: ['{horario}'],
    defaultText:
      '🕒 *Os especialistas não estão presentes no momento.*\n\n' +
      'Horário de funcionamento: {horario}.\n\n' +
      'Sua mensagem foi direcionada e, assim que eles voltarem ao expediente, você terá um retorno sobre o seu caso. 🙏',
  },
  {
    key: 'politeDecline',
    stage: 'Encerramento',
    label: 'Cliente não quer mais nada',
    placeholders: [],
    defaultText: 'Sem problemas! Estou por aqui se precisar de mais alguma coisa. 😊',
  },
  {
    key: 'closing',
    stage: 'Encerramento',
    label: 'Mensagem de encerramento',
    placeholders: [],
    defaultText:
      'Agradecemos o seu contato! 💙 Foi um prazer te atender.\n\nEnvie "oi" quando quiser — estamos sempre por aqui. 😊',
  },
  {
    key: 'bloqueioMenu',
    stage: 'Celular bloqueado',
    label: 'Explicação e opções do bloqueio',
    placeholders: [],
    defaultText:
      '🔒 O bloqueio do celular ocorre 2 dias após o vencimento da parcela.\n\n' +
      'Recomendamos efetuar o pagamento via PIX quando vencido, agilizando o desbloqueio do aparelho.\n\n' +
      '👇 *Escolha uma opção* respondendo com o número:\n\n' +
      opts('Efetuar o pagamento pendente', 'Pagamento já efetuado e bloqueio continua', 'Voltar ao início'),
  },
  {
    key: 'bloqueioMetodo',
    stage: 'Celular bloqueado',
    label: 'Como foi o pagamento?',
    placeholders: [],
    defaultText:
      'Certo, estou aqui para ajudá-lo(a). 🙂\n\n' +
      '💳 Precisamos entender como foi efetuado o pagamento.\n' +
      '👇 *Responda com o número*:\n\n' +
      opts('Pix', 'Código de barras'),
  },
  {
    key: 'receiptReminder',
    stage: 'Celular bloqueado',
    label: 'Lembrete do comprovante',
    placeholders: [],
    defaultText: 'Ainda estou aguardando o comprovante do seu pagamento. 📎 Pode enviar a foto ou o arquivo, por favor?',
  },
  {
    key: 'humanTopic',
    stage: 'Atendente',
    label: 'Pedir o assunto',
    placeholders: [],
    defaultText: 'Certo! Para te ajudar a falar com nosso especialista, me conte, por favor, sobre o que você gostaria de falar. ✍️',
  },
  {
    key: 'mediaGuidance',
    stage: 'Mídia',
    label: 'Mídia enviada fora do comprovante',
    placeholders: [],
    defaultText: 'Recebi sua mídia, mas no momento só processo comprovantes de pagamento quando solicitado. Pode me dizer como posso ajudar? 😊',
  },
];

const DEF_BY_KEY = new Map(FLOW_TEXT_DEFS.map((d) => [d.key, d]));
const MAX_TEXT_CHARS = 1500;

/** Cache das versões salvas pelo operador (key → texto). */
const overrides = new Map<string, string>();

function loadOverrides(): void {
  try {
    const rows = getDb().prepare('SELECT key, text FROM flow_texts').all() as Array<{ key: string; text: string }>;
    for (const row of rows) {
      if (DEF_BY_KEY.has(row.key)) overrides.set(row.key, row.text);
    }
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Textos do fluxo não carregados — usando padrão');
  }
}
loadOverrides();

/** Texto atual de uma etapa (versão do operador, se houver; senão o padrão). */
export function flowText(key: string): string {
  return overrides.get(key) ?? DEF_BY_KEY.get(key)?.defaultText ?? '';
}

export interface FlowTextState extends FlowTextDef {
  text: string;
  isCustom: boolean;
}

export function listFlowTexts(): FlowTextState[] {
  return FLOW_TEXT_DEFS.map((d) => ({
    ...d,
    text: flowText(d.key),
    isCustom: overrides.has(d.key),
  }));
}

/** Salva (ou restaura, com texto vazio) o texto de uma etapa. Retorna null se inválido. */
export function saveFlowText(key: string, text: string): FlowTextState | null {
  const def = DEF_BY_KEY.get(key);
  if (!def) return null;
  const trimmed = text.trim();
  try {
    if (trimmed === '' || trimmed === def.defaultText) {
      getDb().prepare('DELETE FROM flow_texts WHERE key = ?').run(key);
      overrides.delete(key);
    } else {
      const value = trimmed.slice(0, MAX_TEXT_CHARS);
      getDb()
        .prepare(
          'INSERT INTO flow_texts (key, text, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at'
        )
        .run(key, value, Date.now());
      overrides.set(key, value);
    }
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err), key }, 'Falha ao salvar texto do fluxo');
    return null;
  }
  return { ...def, text: flowText(key), isCustom: overrides.has(key) };
}
