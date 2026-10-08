/**
 * @fileoverview Training data service — persists custom rules and QA examples
 * to backend/learning_database.json and feeds them to the autonomous agent.
 *
 * Previously the panel emitted training updates into the void (no backend
 * handler) and learning_database.json was unused. This service is the single
 * source of truth: socket handlers persist here, the agent reads from here.
 *
 * Learning loop: `learnFromExchange()` captures real operator replies
 * (customer question → approved answer) automatically, newest first, so the
 * agent improves with every conversation without manual data entry.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import logger from '../utils/logger.js';
import type { TrainingData, QAExample } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../learning_database.json');
const BACKUP_PATH = `${DB_PATH}.bak`;

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

const trainingSchema = z.object({
  lastUpdated: z.string().optional(),
  customRules: z.array(z.string().min(3).max(MAX_RULE_LENGTH)).max(MAX_RULES),
  qaExamples: z.array(qaSchema).max(MAX_QAS),
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

class TrainingService {
  private cache: TrainingData | null = null;
  private cacheMtimeMs = 0;

  /** Get training data (cached, invalidated by file mtime) */
  getTraining(): TrainingData {
    try {
      const stat = fs.statSync(DB_PATH);
      if (this.cache && stat.mtimeMs === this.cacheMtimeMs) {
        return this.cache;
      }
      const raw = fs.readFileSync(DB_PATH, 'utf-8');
      const parsed = trainingSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        logger.warn({ errors: parsed.error.flatten().fieldErrors }, 'Invalid learning_database.json — using defaults');
        this.backupCorruptFile();
        return this.loadDefaults();
      }
      this.cache = { customRules: parsed.data.customRules, qaExamples: parsed.data.qaExamples };
      this.cacheMtimeMs = stat.mtimeMs;
      return this.cache;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Failed to read learning_database.json');
        this.backupCorruptFile();
      }
      return this.loadDefaults();
    }
  }

  /**
   * Preserve a corrupt database before defaults take over, so the operator
   * can recover the data instead of silently losing it on the next save.
   */
  private backupCorruptFile(): void {
    try {
      if (fs.existsSync(DB_PATH) && !fs.existsSync(BACKUP_PATH)) {
        fs.copyFileSync(DB_PATH, BACKUP_PATH);
        logger.warn({ backupPath: BACKUP_PATH }, 'Corrupt learning_database.json backed up');
      }
    } catch {
      /* best effort */
    }
  }

  private loadDefaults(): TrainingData {
    this.cache = { ...DEFAULT_TRAINING };
    this.cacheMtimeMs = 0;
    return this.cache;
  }

  /** Replace all custom rules (validated) and persist */
  setRules(rules: unknown): TrainingData {
    const parsed = z.array(z.string().trim().min(3).max(MAX_RULE_LENGTH)).max(MAX_RULES).safeParse(rules);
    if (!parsed.success) {
      throw new Error('Regras inválidas');
    }
    const updated = this.mutate((current) => ({ customRules: parsed.data, qaExamples: current.qaExamples }));
    return updated;
  }

  /** Replace all QA examples (validated) and persist */
  setQas(qas: unknown): TrainingData {
    const parsed = z.array(qaSchema).max(MAX_QAS).safeParse(qas);
    if (!parsed.success) {
      throw new Error('Exemplos de Q&A inválidos');
    }
    const updated = this.mutate((current) => ({ customRules: current.customRules, qaExamples: parsed.data }));
    return updated;
  }

  /**
   * Auto-learning: capture an approved exchange (customer question → operator
   * answer). The pair is stored newest-first so the prompt block always shows
   * the most recent learning. Duplicate questions update the answer in place.
   */
  learnFromExchange(question: string, answer: string): void {
    const q = (question ?? '').trim();
    const a = (answer ?? '').trim();
    if (q.length < LEARN_MIN_QUESTION || q.length > LEARN_MAX_QUESTION) return;
    if (a.length < LEARN_MIN_ANSWER || a.length > LEARN_MAX_ANSWER) return;

    try {
      this.mutate((current) => {
        const key = normalizeKey(q);
        const rest = current.qaExamples.filter((qa) => normalizeKey(qa.question) !== key);
        const entry: QAExample = {
          intent: 'Aprendizado automático',
          question: q,
          answer: a,
        };
        // Newest first + hard cap keeps the collection bounded.
        return { customRules: current.customRules, qaExamples: [entry, ...rest].slice(0, MAX_QAS) };
      });
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Auto-learning failed');
    }
  }

  /**
   * Run a read-modify-write cycle. All fs ops are synchronous, so Node's
   * single-threaded execution already serializes concurrent writers
   * (panel updates vs auto-learning) — no lock needed.
   */
  private mutate(fn: (current: TrainingData) => TrainingData): TrainingData {
    const updated = fn(this.getTraining());
    this.save(updated);
    return updated;
  }

  private save(data: TrainingData): void {
    const payload = {
      lastUpdated: new Date().toISOString(),
      customRules: data.customRules,
      qaExamples: data.qaExamples,
    };
    const tmp = `${DB_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmp, DB_PATH);
    this.cache = { customRules: data.customRules, qaExamples: data.qaExamples };
    this.cacheMtimeMs = fs.statSync(DB_PATH).mtimeMs;
    logger.info(
      { rules: data.customRules.length, qas: data.qaExamples.length },
      'Training data updated and persisted'
    );
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

export default new TrainingService();
