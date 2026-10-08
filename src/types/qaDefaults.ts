import type { QAExample } from './index.js';

export const DEFAULT_QA_EXAMPLES: QAExample[] = [
  // ─── GRUPO 1: BOLETO E PAGAMENTO ───────────────────────────
  {
    intent: "solicitar_boleto",
    question: "Preciso do boleto para pagar meu celular",
    answer: "Claro! Para localizar seu contrato e gerar o boleto, por favor informe seu CPF ou o IMEI do aparelho."
  },
  {
    intent: "solicitar_boleto",
    question: "Quero pagar a parcela do meu celular",
    answer: "Perfeito! Para enviar seu boleto, preciso localizar seu contrato. Informe seu CPF ou IMEI do aparelho, por favor."
  },
  {
    intent: "solicitar_boleto",
    question: "Pode me mandar o PIX?",
    answer: "Claro! Para gerar o link de pagamento, informe seu CPF ou o IMEI do aparelho para localizarmos seu contrato."
  },
  {
    intent: "solicitar_boleto",
    question: "Como faço para pagar?",
    answer: "O pagamento é realizado via boleto ou PIX. Informe seu CPF ou IMEI e enviaremos o link de pagamento imediatamente."
  },
  // ─── GRUPO 2: DESBLOQUEIO ──────────────────────────────────
  {
    intent: "desbloquear_celular",
    question: "Meu celular está bloqueado",
    answer: "Compreendo. Para verificar a situação do seu aparelho, informe seu CPF ou IMEI. Se houver parcela em aberto, enviarei o link de pagamento. Após confirmar, o desbloqueio ocorre automaticamente em até 1 minuto."
  },
  {
    intent: "desbloquear_celular",
    question: "Preciso desbloquear meu celular urgente",
    answer: "Entendo a urgência! Vou verificar seu contrato agora. Por favor, informe seu CPF ou IMEI do aparelho."
  },
  {
    intent: "desbloquear_manual",
    question: "Já paguei e o celular continua bloqueado, precisa desbloquear",
    answer: "Compreendo sua situação. Vou transferir seu atendimento para um de nossos especialistas que realizará o desbloqueio manual com prioridade. Um momento, por favor."
  },
  // ─── GRUPO 3: PAGAMENTO EFETUADO / CELULAR BLOQUEADO ──────
  {
    intent: "pagamento_efetuado_bloqueado",
    question: "Paguei o boleto e meu celular continua bloqueado",
    answer: "Compreendo! Após o pagamento, o desbloqueio ocorre automaticamente em até 1 minuto, desde que o aparelho esteja conectado à internet. Por favor: 1️⃣ Verifique sua conexão (Wi-Fi ou dados móveis) 2️⃣ Reinicie o aparelho Se ainda assim não desbloquear, informe seu CPF ou IMEI para que um especialista te auxilie."
  },
  {
    intent: "pagamento_efetuado_bloqueado",
    question: "Fiz o pagamento mas o aparelho não desbloqueou",
    answer: "Lamento pelo inconveniente! Verifique se o aparelho está com internet activa e reinicie-o. Caso persista após 5 minutos, irei transferir para um especialista realizar o desbloqueio manual."
  },
  {
    intent: "pagamento_efetuado_bloqueado",
    question: "Reiniciei e ainda está bloqueado, já faz 10 minutos",
    answer: "Entendo! Neste caso, vou transferir seu atendimento para um especialista que realizará o desbloqueio manual imediatamente. Um momento, por favor."
  },
  // ─── GRUPO 4: MUDANÇA DE DATA ──────────────────────────────
  {
    intent: "mudanca_vencimento",
    question: "Preciso mudar a data do pagamento",
    answer: "A alteração de data de vencimento é realizada por nossa equipe especializada. Vou transferir seu atendimento para que possam te auxiliar. Por favor, informe seu CPF para agilizar o processo."
  },
  {
    intent: "mudanca_vencimento",
    question: "Posso mudar o dia que vence meu boleto?",
    answer: "Sim, é possível solicitar a alteração! Essa mudança é feita por nossos atendentes. Vou te transferir agora. Pode me informar seu CPF para já passar o dado ao especialista?"
  },
  {
    intent: "mudanca_vencimento",
    question: "Quero mudar a data para o dia 10",
    answer: "Entendido! Vou transferir seu atendimento para um especialista que poderá realizar essa alteração no seu contrato. Um momento, por favor."
  },
  // ─── GRUPO 5: INFORMAÇÕES GERAIS ──────────────────────────
  {
    intent: "como_funciona_bloqueio",
    question: "Como funciona o bloqueio do celular?",
    answer: "O aparelho possui um aplicativo de gestão instalado. Caso haja parcela em atraso, o sistema realiza o bloqueio automático do dispositivo. Após o pagamento, o desbloqueio também é automático em até 1 minuto, com o aparelho conectado à internet."
  },
  {
    intent: "como_funciona_bloqueio",
    question: "Por que meu celular foi bloqueado?",
    answer: "O bloqueio ocorre automaticamente quando há parcela em atraso no contrato. Para regularizar, basta efetuar o pagamento e o desbloqueio acontece automaticamente. Deseja que eu envie o boleto?"
  },
  {
    intent: "prazo_desbloqueio",
    question: "Quanto tempo demora para desbloquear após o pagamento?",
    answer: "Após a confirmação do pagamento, o desbloqueio ocorre automaticamente em até 1 minuto, desde que o aparelho esteja conectado à internet (Wi-Fi ou dados). Se ultrapassar esse tempo, reinicie o dispositivo."
  },
  {
    intent: "contato_humano",
    question: "Quero falar com um atendente",
    answer: "Claro! Vou transferir seu atendimento para um de nossos especialistas. Por favor, informe seu CPF ou IMEI para agilizar o processo."
  },
  {
    intent: "contato_humano",
    question: "Preciso falar com uma pessoa",
    answer: "Entendido! Estou transferindo seu atendimento para um especialista da Nuovopay. Um momento, por favor."
  },
  {
    intent: "renegociacao",
    question: "Posso parcelar o que estou devendo?",
    answer: "Para renegociação de contrato, nossos especialistas podem te oferecer as melhores opções. Vou transferir seu atendimento agora. Informe seu CPF para agilizar."
  },
  {
    intent: "duvida_imei",
    question: "Onde encontro o IMEI do meu celular?",
    answer: "O IMEI do seu aparelho pode ser encontrado: 1️⃣ Digitando *#06# no teclado do celular 2️⃣ Na caixa do aparelho 3️⃣ Em Configurações > Sobre o telefone"
  }
];
