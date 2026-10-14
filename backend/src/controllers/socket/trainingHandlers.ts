import type { Server } from 'socket.io';
import type { AthinaSocket } from './safeEmit.js';
import { safeEmit } from './safeEmit.js';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/contracts.js';
import { flowTextUpdateSchema } from '@shared/contracts.js';
import trainingService from '../../services/TrainingService.js';
import { listFlowTexts, saveFlowText } from '../../services/athinaTexts.js';
import logger from '../../utils/logger.js';

/** Regras, exemplos de treinamento e textos do roteiro (aba Treinamento). */
export function registerTrainingHandlers(
  socket: AthinaSocket,
  io: Server<ClientToServerEvents, ServerToClientEvents>
): void {
  // ─── Training data (persisted in backend/learning_database.json) ───────
  socket.on('update-training-rules', (rules: unknown) => {
    try {
      const updated = trainingService.setRules(rules);
      io.emit('training-data-updated', updated);
      logger.info({ count: updated.customRules.length, socketId: socket.id }, 'Training rules updated');
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err), socketId: socket.id }, 'Invalid training rules rejected');
    }
  });

  socket.on('update-training-qas', (qas: unknown) => {
    try {
      const updated = trainingService.setQas(qas);
      io.emit('training-data-updated', updated);
      logger.info({ count: updated.qaExamples.length, socketId: socket.id }, 'Training QAs updated');
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err), socketId: socket.id }, 'Invalid training QAs rejected');
    }
  });

  socket.on('request-training', () => {
    safeEmit(socket, 'training-data', trainingService.getTraining());
  });

  // ─── Textos editáveis do roteiro da Athina (aba Treinamento) ───────────
  socket.on('update-flow-text', (data: unknown) => {
    const parsed = flowTextUpdateSchema.safeParse(data);
    if (!parsed.success) {
      logger.warn({ socketId: socket.id }, 'Invalid update-flow-text payload rejected');
      return;
    }
    const saved = saveFlowText(parsed.data.key, parsed.data.text);
    if (!saved) {
      logger.warn({ key: parsed.data.key, socketId: socket.id }, 'Unknown flow text key rejected');
      return;
    }
    io.emit('flow-texts', listFlowTexts());
  });

  socket.on('request-flow-texts', () => {
    safeEmit(socket, 'flow-texts', listFlowTexts());
  });
  safeEmit(socket, 'flow-texts', listFlowTexts());

  // Send persisted training data immediately so the panel always starts in sync
  safeEmit(socket, 'training-data', trainingService.getTraining());

}
