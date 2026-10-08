/**
 * @fileoverview Training data service — persiste regras e Q&As APROVADOS no
 * SQLite local (backend/data/athina.db) e alimenta o agente autônomo.
 *
 * Substitui o antigo learning_database.json (importado automaticamente na
 * primeira execução — ver services/db.ts). Continua sendo a fonte única:
 * handlers de socket gravam aqui, o agente lê daqui.
 *
 * Learning loop: `learnFromExchange()` captura respostas reais do operador
 * (pergunta do cliente → resposta aprovada), mais recentes primeiro, para o
 * agente melhorar a cada conversa sem entrada manual de dados.
 */
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import logger from '../utils/logger.js';
import { getDb, getMeta, setMeta } from './db.js';
import type { TrainingData, QAExample } from '../types/index.js';

const MAX_RULES = 50;
const MAX_QAS = 300;
const MAX_RULE_LENGTH = 600;
const MAX_QUESTION_LENGTH = 600;
const MAX_ANSWER_LENGTH = 2500;
/** Orçamento total de caracteres do bloco de treino no system prompt. */
const MAX_PROMPT_CHARS = 8000;
/** Faixas plausíveis para um par aprendido automaticamente. */
const LEARN_MIN_QUESTION = 5;
const LEARN_MAX_QUESTION = 300;
const LEARN_MIN_ANSWER = 10;
const LEARN_MAX_ANSWER = 1200;

const qaSchema = z.object({
  intent: z.string().min(1).max(120),
  question: z.string().min(3).max(MAX_QUESTION_LENGTH),
  answer: z.string().min(3).max(MAX_ANSWER_LENGTH),
});

const DEFAULT_TRAINING: TrainingData = {
  customRules: [
    'Sempre reafirmar que somos a Financeira Nuovo/Nuovopay de forma clara e profissional.',
    'Para clientes impacientes ou rudes, ignorar a hostilidade e priorizar a empatia e a resolução ágil do problema.',
    'Manter a formatação das mensagens sempre muito organizada, limpa e dividida linha por linha.',
  ],
  qaExamples: [],
};

/** Normalize text for dedupe comparison (case/accents/punctuation insensitive). */
function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class TrainingService {
  private db: DatabaseSync;
  private cache: TrainingData | null = null;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.seedDefaultsOnce();
  }

  /** Primeira execução em banco vazio: persiste as regras padrão (uma vez). */
  private seedDefaultsOnce(): void {
    if (getMeta(this.db, 'training_seeded')) return;
    const { count } =
      (this.db.prepare('SELECT COUNT(*) AS count FROM training_rules').get() as { count: number }) ?? {
        count: 0,
      };
    const { qas } =
      (this.db.prepare('SELECT COUNT(*) AS qas FROM training_qas').get() as { qas: number }) ?? {
        qas: 0,
      };
    if (count === 0 && qas === 0) {
      const insert = this.db.prepare('INSERT INTO training_rules (ord, text) VALUES (?, ?)');
      this.db.exec('BEGIN');
      try {
        DEFAULT_TRAINING.customRules.forEach((r, i) => insert.run(i, r));
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
    setMeta(this.db, 'training_seeded', new Date().toISOString());
  }

  /** Get training data (cache invalidado a cada escrita). */
  getTraining(): TrainingData {
    if (this.cache) return this.cache;
    try {
      const rules = this.db
        .prepare('SELECT text FROM training_rules ORDER BY ord ASC, id ASC')
        .all() as Array<{ text: string }>;
      const qas = this.db
        .prepare('SELECT intent, question, answer FROM training_qas ORDER BY ord ASC, id ASC')
        .all() as unknown as QAExample[];
      this.cache = { customRules: rules.map((r) => r.text), qaExamples: qas };
      return this.cache;
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Falha ao ler treinamento do SQLite — usando padrões'
      );
      return { ...DEFAULT_TRAINING };
    }
  }

  /** Replace all custom rules (validated) and persist */
  setRules(rules: unknown): TrainingData {
    const parsed = z.array(z.string().trim().min(3).max(MAX_RULE_LENGTH)).max(MAX_RULES).safeParse(rules);
    if (!parsed.success) {
      throw new Error('Regras inválidas');
    }
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM training_rules').run();
      const insert = this.db.prepare('INSERT INTO training_rules (ord, text) VALUES (?, ?)');
      parsed.data.forEach((text, i) => insert.run(i, text));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.cache = null;
    return this.getTraining();
  }

  /** Replace all QA examples (validated) and persist */
  setQas(qas: unknown): TrainingData {
    const parsed = z.array(qaSchema).max(MAX_QAS).safeParse(qas);
    if (!parsed.success) {
      throw new Error('Exemplos de Q&A inválidos');
    }
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM training_qas').run();
      const insert = this.db.prepare(
        'INSERT INTO training_qas (ord, intent, question, answer) VALUES (?, ?, ?, ?)'
      );
      parsed.data.forEach((qa, i) => insert.run(i, qa.intent, qa.question, qa.answer));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.cache = null;
    logger.info({ qas: parsed.data.length }, 'Training QAs updated and persisted');
    return this.getTraining();
  }

  /**
   * Auto-learning: capture an approved exchange (customer question → operator
   * answer). The pair is stored newest-first (ord decrescente) so the prompt
   * block always shows the most recent learning. Duplicate questions update
   * the answer in place.
   */
  learnFromExchange(question: string, answer: string): void {
    const q = (question ?? '').trim();
    const a = (answer ?? '').trim();
    if (q.length < LEARN_MIN_QUESTION || q.length > LEARN_MAX_QUESTION) return;
    if (a.length < LEARN_MIN_ANSWER || a.length > LEARN_MAX_ANSWER) return;

    try {
      const key = normalizeKey(q);
      this.db.exec('BEGIN');
      try {
        // Remove par duplicado (mesma pergunta normalizada)
        const existing = this.db
          .prepare('SELECT id, question FROM training_qas')
          .all() as Array<{ id: number; question: string }>;
        const dupes = existing.filter((row) => normalizeKey(row.question) === key);
        const del = this.db.prepare('DELETE FROM training_qas WHERE id = ?');
        dupes.forEach((row) => del.run(row.id));

        // Nova entrada vai para o TOPO (menor ord)
        const minRow = this.db.prepare('SELECT MIN(ord) AS m FROM training_qas').get() as {
          m: number | null;
        };
        const newOrd = (minRow?.m ?? 0) - 1;
        this.db
          .prepare('INSERT INTO training_qas (ord, intent, question, answer) VALUES (?, ?, ?, ?)')
          .run(newOrd, 'Aprendizado automático', q, a);

        // Teto duro: mantém apenas os MAX_QAS mais recentes (menores ords)
        this.db
          .prepare(
            'DELETE FROM training_qas WHERE id NOT IN (SELECT id FROM training_qas ORDER BY ord ASC LIMIT ?)'
          )
          .run(MAX_QAS);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
      this.cache = null;
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Auto-learning failed');
    }
  }

  /**
   * Format rules + QA examples as a prompt block for the autonomous agent.
   * Newest QAs first (learning order), capped by example count AND a total
   * character budget so the context window stays healthy.
   */
  getPromptBlock(maxExamples = 40): string {
    const { customRules, qaExamples } = this.getTraining();
    const parts: string[] = [];

    if (customRules.length > 0) {
      parts.push(
        'REGRAS OPERACIONAIS APRENDIDAS (siga sempre):\n' +
          customRules.map((r, i) => `${i + 1}. ${r}`).join('\n')
      );
    }

    // qaExamples are stored newest-first (see learnFromExchange).
    const examples = qaExamples.slice(0, maxExamples);
    const exampleParts: string[] = [];
    let usedChars = parts.join('\n\n').length;

    for (const qa of examples) {
      const block = `P: ${qa.question}\nR: ${qa.answer}`;
      if (usedChars + block.length + 5 > MAX_PROMPT_CHARS) break;
      exampleParts.push(block);
      usedChars += block.length + 5;
    }

    if (exampleParts.length > 0) {
      parts.push(
        'EXEMPLOS REAIS DE PERGUNTAS E RESPOSTAS APROVADAS (use como referência de tom e conteúdo):\n' +
          exampleParts.join('\n---\n')
      );
    }

    return parts.join('\n\n');
  }
}

export default new TrainingService(getDb());
