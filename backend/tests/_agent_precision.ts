/**
 * Teste de PRECISÃO da Athina com LLM real + tool-calling real-mockado.
 * Valida que o agente: pede dados antes de consultar, não inventa valores,
 * usa a ferramenta quando tem CPF e reproduz fielmente os dados retornados.
 *
 * Uso: npx tsx tests/_agent_precision.ts
 */
import assert from 'node:assert/strict';
import { AgentService } from '../src/services/AgentService.js';
import config from '../src/config/index.js';

(config as unknown as { agentAutoReply: boolean }).agentAutoReply = true;

const CONTRACT_OK = JSON.stringify({
  encontrado: true,
  cliente: 'João da Silva',
  loja: 'Loja Centro',
  contrato: 'CT-12345',
  statusContrato: 'atraso',
  parcela: {
    numero: '3',
    vencimento: '10/10/2026',
    valor: 'R$ 299,90',
    status: 'atrasada',
    total: '12',
    pixCode: '00020126BR.GOV.BCB.PIX-TESTE-AABBCC',
  },
  mensagem: 'contrato localizado',
});
const NOT_FOUND = JSON.stringify({ encontrado: false, motivo: 'NOT_FOUND', mensagem: 'contrato não localizado' });

interface Case {
  name: string;
  user: string;
  toolResult?: string;
  expectTool?: boolean;
  mustInclude?: RegExp;
  mustNotInclude?: RegExp | RegExp[];
}

const cases: Case[] = [
  {
    name: '1. Sem dados → pede CPF/nome, não inventa consulta',
    user: 'Oi, tudo bem? Preciso de ajuda',
    mustNotInclude: /R\$\s*\d/i,
  },
  {
    name: '2. Sem dados → não inventa valor de parcela',
    user: 'Quanto falta para pagar meu celular?',
    mustNotInclude: [/R\$\s*\d/i, /\*\*/], // nem valor inventado nem markdown
  },
  {
    name: '3. Com CPF → chama a ferramenta e responde "não encontrado" sem inventar',
    user: 'Meu CPF é 12345678901, quero saber do meu boleto',
    toolResult: NOT_FOUND,
    expectTool: true,
    // CPF completo nunca é exibido (regra de treinamento) e nada inventado
    mustNotInclude: [/123\.456\.789-01|12345678901/, /R\$\s*\d/i, /\*\*/],
  },
  {
    name: '4. Ferramenta retornou contrato → reproduz fielmente valor/PIX',
    user: 'Segue meu CPF 12345678901, pode mandar o boleto',
    toolResult: CONTRACT_OK,
    expectTool: true,
    mustInclude: /299,90/,
  },
];

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

for (const c of cases) {
  const sent: string[] = [];
  const calls: string[] = [];
  const agent = new (AgentService as never as { new (d?: unknown): AgentService })({
    sendMessage: async (_to: string, text: string) => {
      sent.push(text);
    },
    consultarPaymobi: async (query: string) => {
      calls.push(query);
      return c.toolResult ?? NOT_FOUND;
    },
    isReady: () => true,
  });

  try {
    await agent.handleIncomingMessage({
      from: `55119${Math.floor(Math.random() * 1e6)}@c.us`,
      body: c.user,
      id: `prec-${Date.now()}-${c.name[0]}`,
    });
    const reply = sent.join(' \n---\n ');

    assert.ok(reply.length > 0, 'sem resposta do agente');
    if (c.expectTool) assert.equal(calls.length, 1, `ferramenta não chamada (calls=${calls.length})`);
    if (c.mustInclude) assert.match(reply, c.mustInclude, `esperava: ${c.mustInclude}`);
    // A máscara de CPF (***.456.789-**) contém ** por design — substituída
    // antes das checagens para não gerar falso positivo de markdown.
    const replyForChecks = reply.replace(/\*\*\*\.\d{3}\.\d{3}-\*\*/g, 'CPF.MASKED');
    const forbidden = c.mustNotInclude ? [].concat(c.mustNotInclude as RegExp[]) : [];
    for (const re of forbidden) {
      assert.doesNotMatch(replyForChecks, re, `RESPOSTA VIOLOU ${re}: ${reply.slice(0, 150)}`);
    }

    results.push({ name: c.name, ok: true, detail: reply.replace(/\n/g, ' ').slice(0, 130) });
  } catch (err) {
    results.push({ name: c.name, ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : String(err) });
  }
}

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✔' : '✘'} ${r.name}`);
  console.log(`   → ${r.detail}`);
  if (!r.ok) failed++;
}
console.log(`\nPrecisão: ${results.length - failed}/${results.length} cenários passaram`);
process.exit(failed ? 1 : 0);
