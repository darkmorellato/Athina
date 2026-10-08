/**
 * @fileoverview Smoke test do loop do agente autônomo (AgentService) e do
 * aprendizado automático (TrainingService).
 *
 * Roda sem WhatsApp/LLM reais: injeta dependências mockadas via AgentDeps e
 * valida o fluxo completo (guards, tool-calling, dedupe, memória de conversa,
 * fallback, takeover humano e aprendizado).
 *
 * Uso: npm --prefix backend test  (ou: npx tsx tests/agent.smoke.ts)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentService } from '../src/services/AgentService.js';
import config from '../src/config/index.js';
import trainingService from '../src/services/TrainingService.js';

// O agente só responde com AGENT_AUTOREPLY=true — força para o teste.
const mutableConfig = config as unknown as { agentAutoReply: boolean };
const originalAutoReply = mutableConfig.agentAutoReply;
mutableConfig.agentAutoReply = true;

interface SentMessage {
  to: string;
  text: string;
}

interface Scenario {
  name: string;
  run: () => Promise<void>;
}

let passed = 0;
const failures: Array<{ name: string; error: unknown }> = [];

/** Cria um AgentService com dependências mockadas e retorna os spies. */
function makeAgent(overrides?: {
  completions?: Array<{ content?: string | null; tool_calls?: unknown[] }>;
  consultarResult?: string;
  ready?: boolean;
}) {
  const sent: SentMessage[] = [];
  const consulted: Array<{ query: string; clientName?: string }> = [];
  const completions = [...(overrides?.completions ?? [{ content: 'Resposta padrão.' }])];

  const agent = new AgentService({
    chatCompletion: async () => {
      const next = completions.shift();
      if (!next) throw new Error('Sem respostas mockadas restantes');
      return next as never;
    },
    sendMessage: async (to, text) => {
      sent.push({ to, text });
    },
    consultarPaymobi: async (query, clientName) => {
      consulted.push({ query, clientName });
      return overrides?.consultarResult ?? JSON.stringify({ encontrado: false });
    },
    isReady: () => overrides?.ready ?? true,
  });

  return { agent, sent, consulted };
}

const scenarios: Scenario[] = [
  {
    name: 'ignora mensagens quando AGENT_AUTOREPLY está desligado',
    run: async () => {
      mutableConfig.agentAutoReply = false;
      const { agent, sent } = makeAgent();
      await agent.handleIncomingMessage({ from: '5511999990000@c.us', body: 'olá', id: 'm1' });
      assert.equal(sent.length, 0, 'não deveria responder com autoreply desligado');
    },
  },
  {
    name: 'ignora grupos, broadcasts e mensagens próprias',
    run: async () => {
      const { agent, sent } = makeAgent();
      await agent.handleIncomingMessage({ from: '12345@g.us', body: 'oi', id: 'm2' });
      await agent.handleIncomingMessage({ from: 'status@broadcast', body: 'oi', id: 'm3' });
      await agent.handleIncomingMessage({ from: '5511@c.us', body: 'oi', fromMe: true, id: 'm4' });
      assert.equal(sent.length, 0, 'grupos/broadcast/mensagens próprias devem ser ignorados');
    },
  },
  {
    name: 'fluxo completo com tool-calling: extrai dígitos, consulta e responde',
    run: async () => {
      const { agent, sent, consulted } = makeAgent({
        completions: [
          {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'consultar_financiamento',
                  arguments: JSON.stringify({ query: '123.456.789-01', clientName: 'João' }),
                },
              },
            ],
          },
          { content: 'Olá João! Sua parcela vence dia 10. Segue o PIX.' },
        ],
        consultarResult: JSON.stringify({ encontrado: true, cliente: 'João' }),
      });

      await agent.handleIncomingMessage({
        from: '5511888880000@c.us',
        body: 'quero consultar meu contrato, CPF 123.456.789-01',
        id: 'm5',
      });

      assert.equal(consulted.length, 1, 'a ferramenta deveria ser chamada uma vez');
      assert.equal(consulted[0].query, '12345678901', 'o CPF deveria ir só com dígitos');
      assert.equal(consulted[0].clientName, 'João');
      assert.equal(sent.length, 1, 'deveria enviar exatamente uma resposta');
      assert.equal(sent[0].to, '5511888880000@c.us');
      assert.match(sent[0].text, /parcela vence dia 10/);
    },
  },
  {
    name: 'valida argumentos da ferramenta (query curta vira erro controlado)',
    run: async () => {
      const { agent, sent, consulted } = makeAgent({
        completions: [
          {
            content: null,
            tool_calls: [
              {
                id: 'call_2',
                type: 'function',
                function: {
                  name: 'consultar_financiamento',
                  arguments: JSON.stringify({ query: '123' }),
                },
              },
            ],
          },
          { content: 'Pode conferir o CPF, por favor?' },
        ],
      });

      await agent.handleIncomingMessage({ from: '5511777770000@c.us', body: 'consultar', id: 'm6' });
      assert.equal(consulted.length, 0, 'query inválida não deve chegar ao Paymobi');
      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /conferir o CPF/);
    },
  },
  {
    name: 'aceita apenas CPF(11), CNPJ(14) ou IMEI(15) — 12 dígitos é rejeitado',
    run: async () => {
      const { agent, sent, consulted } = makeAgent({
        completions: [
          {
            content: null,
            tool_calls: [
              {
                id: 'call_3',
                type: 'function',
                function: {
                  name: 'consultar_financiamento',
                  arguments: JSON.stringify({ query: '123456789012' }),
                },
              },
            ],
          },
          { content: 'Esse número não confere, pode confirmar?' },
        ],
      });

      await agent.handleIncomingMessage({ from: '5511333330000@c.us', body: 'consultar', id: 'm7' });
      assert.equal(consulted.length, 0, '12 dígitos não deve chegar ao Paymobi');
      assert.equal(sent.length, 1);
    },
  },
  {
    name: 'dedupe: a mesma mensagem (mesmo id) só é processada uma vez',
    run: async () => {
      const { agent, sent } = makeAgent({ completions: [{ content: 'ok' }, { content: 'ok' }] });
      await agent.handleIncomingMessage({ from: '5511666660000@c.us', body: 'oi', id: 'dup-1' });
      await agent.handleIncomingMessage({ from: '5511666660000@c.us', body: 'oi', id: 'dup-1' });
      assert.equal(sent.length, 1, 'mensagem duplicada não deve gerar resposta dupla');
    },
  },
  {
    name: 'mantém memória de conversa entre mensagens do mesmo contato',
    run: async () => {
      const seen: Array<Array<{ role?: string; content?: unknown }>> = [];
      const sent: SentMessage[] = [];
      let call = 0;
      const agent = new AgentService({
        chatCompletion: async (messages) => {
          seen.push(messages.map((m) => ({ role: m.role, content: m.content })));
          call += 1;
          return { role: 'assistant', content: `resposta ${call}` } as never;
        },
        sendMessage: async (to, text) => {
          sent.push({ to, text });
        },
        consultarPaymobi: async () => '{}',
        isReady: () => true,
      });

      await agent.handleIncomingMessage({ from: '5511555550000@c.us', body: 'primeira mensagem', id: 'h1' });
      await agent.handleIncomingMessage({ from: '5511555550000@c.us', body: 'segunda mensagem', id: 'h2' });

      assert.equal(sent.length, 2);
      assert.equal(seen.length, 2, 'duas chamadas de LLM');
      const secondTurn = seen[1].map((m) => String(m.content));
      assert.ok(
        secondTurn.some((c) => c.includes('primeira mensagem')),
        'o histórico da 1ª mensagem deveria entrar no contexto da 2ª'
      );
      assert.ok(
        secondTurn.some((c) => c.includes('resposta 1')),
        'a resposta anterior deveria entrar no contexto'
      );
    },
  },
  {
    name: 'conteúdo vazio do LLM: reprocessa sem ferramentas e envia fallback',
    run: async () => {
      const { agent, sent } = makeAgent({
        completions: [{ content: null }, { content: '' }],
      });
      await agent.handleIncomingMessage({ from: '5511222220000@c.us', body: 'oi', id: 'f1' });
      assert.equal(sent.length, 1, 'o cliente nunca deve ficar sem resposta');
      assert.match(sent[0].text, /atendente humano/i, 'fallback deve encaminhar para humano');
    },
  },
  {
    name: 'falha de LLM não derruba o processo e gera fallback (1x por hora)',
    run: async () => {
      const { agent, sent } = makeAgent({ completions: [] });
      await agent.handleIncomingMessage({ from: '5511111110000@c.us', body: 'oi', id: 'e1' });
      assert.equal(sent.length, 1, 'deve haver uma mensagem de fallback');
      assert.match(sent[0].text, /atendente humano/i);

      // Segunda falha na mesma hora: sem spam.
      await agent.handleIncomingMessage({ from: '5511111110000@c.us', body: 'oi de novo', id: 'e2' });
      assert.equal(sent.length, 1, 'fallback deve ter cooldown por contato');
    },
  },
  {
    name: 'takeover humano: operador respondeu → agente fica em silêncio',
    run: async () => {
      const { agent, sent } = makeAgent({ completions: [{ content: 'não deveria sair' }] });
      agent.noteHumanReply('5511000000001@c.us');
      await agent.handleIncomingMessage({ from: '5511000000001@c.us', body: 'oi', id: 't1' });
      assert.equal(sent.length, 0, 'agente não deve falar por cima do operador');
      assert.ok(agent.isHumanTakeover('5511000000001@c.us'));
    },
  },
  {
    name: 'mensagem de mídia sem texto → orientação única (sem loop)',
    run: async () => {
      const { agent, sent } = makeAgent();
      await agent.handleIncomingMessage({
        from: '5511000000002@c.us',
        body: '',
        hasMedia: true,
        id: 'md1',
      });
      assert.equal(sent.length, 1, 'deve orientar o cliente sobre mídia');
      assert.match(sent[0].text, /mensagens de texto/);

      await agent.handleIncomingMessage({
        from: '5511000000002@c.us',
        body: '',
        hasMedia: true,
        id: 'md2',
      });
      assert.equal(sent.length, 1, 'cooldown deve impedir spam de orientação');
    },
  },
  {
    name: 'aprendizado automático: resposta humana vira exemplo na base',
    run: async () => {
      const dbPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../learning_database.json'
      );
      const backup = fs.readFileSync(dbPath, 'utf-8');
      try {
        const before = trainingService.getPromptBlock();
        trainingService.learnFromExchange(
          'Vocês abrem no sábado de manhã?',
          'Sim! Nossas lojas abrem aos sábados das 8h às 12h. 😊'
        );
        const after = trainingService.getPromptBlock();
        assert.ok(
          !before.includes('abrem no sábado') && after.includes('abrem no sábado'),
          'o novo par pergunta/resposta deveria entrar no bloco de prompt'
        );
        assert.ok(after.includes('8h às 12h'), 'a resposta aprovada deve ser preservada');

        // Pergunta repetida atualiza o par em vez de duplicar.
        trainingService.learnFromExchange(
          'vocês abrem no sabado de manha?',
          'Atualização: agora abrimos das 9h às 13h.'
        );
        const updated = trainingService.getPromptBlock();
        assert.ok(updated.includes('9h às 13h'), 'par duplicado deve ser atualizado');
        assert.ok(!updated.includes('8h às 12h'), 'resposta antiga deve ser substituída');

        // Entradas fora da faixa são ignoradas.
        trainingService.learnFromExchange('oi', 'oi');
        assert.ok(!updated.includes('\nP: oi\n'), 'par curto demais deve ser ignorado');
      } finally {
        fs.writeFileSync(dbPath, backup, 'utf-8'); // restaura a base real
      }
    },
  },
];

for (const scenario of scenarios) {
  try {
    mutableConfig.agentAutoReply = true;
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

console.log(`\nAgent smoke test: ${passed}/${scenarios.length} cenários passaram`);
if (failures.length > 0) {
  process.exitCode = 1;
}
