/**
 * @fileoverview Main server entry point with Express + Socket.IO.
 */
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { Server } from 'socket.io';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import config from './config/index.js';
import whatsAppService from './services/WhatsAppService.js';
import analyticsService from './services/AnalyticsService.js';
import chatStateService from './services/ChatStateService.js';
import { closeSharedBrowser } from './services/PaymobiScraperService.js';
import SocketController from './controllers/SocketController.js';
import athinaFlowService from './services/AthinaFlowService.js';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/contracts.js';
import logger from './utils/logger.js';
import { initLlmTracing } from './services/llmTracer.js';

process.on('uncaughtException', (error) => {
  logger.error({ error: error instanceof Error ? error.stack : String(error) }, 'Uncaught Exception captured');
  // Em produção, uma exceção não capturada deixa o processo "vivo" com estado
  // possivelmente corrompido: encerra para o supervisor (systemd/pm2)
  // reiniciar limpo. Em dev, segue apenas o log (tsx watch não supervisiona).
  if (config.nodeEnv === 'production') {
    void gracefulShutdown('uncaughtException', 1);
  }
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason: reason instanceof Error ? reason.stack : String(reason) }, 'Unhandled Rejection captured');
});

const app = express();

// Atrás de reverse proxy (nginx/traefik), configure TRUST_PROXY=<nº de hops>
// para o rate limit por IP enxergar o cliente real; 0 (default) = exposição
// direta — não ativar sem proxy, senão X-Forwarded-For vira spoof de limite.
if (config.trustProxy > 0) {
  app.set('trust proxy', config.trustProxy);
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Security fix: Global HTTP rate limiting (skip Socket.IO transport to avoid breaking realtime)
const httpRateLimiter = rateLimit({
  windowMs: 60_000, // 1 minute
  limit: 300, // 300 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/socket.io'),
  message: { error: 'Too many requests, please try again later.' },
});
app.use(httpRateLimiter);

const server = http.createServer(app);

const allowedOrigin = config.isDev
  ? '*'
  : config.allowedOrigin || false;

if (!allowedOrigin && !config.isDev) {
  logger.warn('⚠️  ALLOWED_ORIGIN not set in production — CORS will deny all cross-origin requests.');
}

const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: {
    origin: allowedOrigin || false,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 25e6, // 25MB limit for base64 audio payloads
  // Performance: compress chat payloads (JSON compresses ~5-10x)
  perMessageDeflate: {
    threshold: 1024,
    zlibDeflateOptions: { level: 6 },
  },
});

// ─── Autenticação do painel (Socket.IO) ─────────────────────────────────────
// Sem isto, qualquer cliente TCP que alcance a porta recebe o QR do WhatsApp
// (takeover de sessão), o histórico de conversas e pode enviar mensagens em
// nome da empresa (CORS não protege clientes não-browser).
// Com ADMIN_SECRET configurado, o handshake exige o token (o painel o envia
// via socket.handshake.auth.token). Sem ADMIN_SECRET, só loopback é aceito.
io.use((socket, next) => {
  const secret = config.adminSecret;
  if (!secret) {
    const addr = socket.handshake.address || '';
    const isLoopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    if (isLoopback) return next();
    logger.warn({ socketId: socket.id, addr }, 'Socket não-local rejeitado (ADMIN_SECRET não configurado)');
    return next(new Error('Unauthorized'));
  }
  const token = String((socket.handshake.auth as { token?: unknown } | undefined)?.token ?? '');
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  if (a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b)) {
    return next();
  }
  logger.warn({ socketId: socket.id }, 'Socket rejeitado: token inválido');
  return next(new Error('Unauthorized'));
});

const socketController = new SocketController(io);

// Tracing opcional das chamadas de LLM (OTel → Langfuse).
// No-op absoluto sem LANGFUSE_PUBLIC_KEY/SECRET_KEY no ambiente.
initLlmTracing();

io.on('connection', (socket) => {
  logger.info({ socketId: socket.id }, 'Socket connected');
  socketController.registerSocket(socket);

  socket.on('disconnect', (reason) => {
    logger.info({ socketId: socket.id, reason }, 'Socket disconnected');
  });
});

// Share io with WhatsAppService
whatsAppService.setEmitter(io);

// Health check with service status and memory metrics
/** Quick TTS readiness probe (2s timeout, result cached 15s, never throws). */
let ttsProbeCache: { at: number; healthy: boolean } = { at: 0, healthy: false };
async function checkTtsHealth(): Promise<boolean> {
  const now = Date.now();
  if (now - ttsProbeCache.at < 15_000) return ttsProbeCache.healthy;
  try {
    const res = await fetch(`${config.ttsServerUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    ttsProbeCache = { at: now, healthy: res.ok };
  } catch {
    ttsProbeCache = { at: now, healthy: false };
  }
  return ttsProbeCache.healthy;
}

// Liveness para supervisores: SEMPRE responde 200 enquanto o processo vive.
// Reconexão do WhatsApp NÃO deve disparar restart do serviço — use este
// endpoint para "está de pé?" e o /health para "está pronto?".
app.get('/live', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/health', async (_req, res) => {
  const health = {
    status: 'ok' as 'ok' | 'degraded',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      whatsapp: {
        state: whatsAppService.getClientState(),
        healthy: whatsAppService.getClientState() === 'READY',
      },
      tts: {
        url: config.ttsServerUrl,
        healthy: await checkTtsHealth(),
      },
      agent: {
        autoReply: athinaFlowService.isEnabled(),
        aiBaseUrl: config.aiBaseUrl,
      },
    },
    memory: {
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
  };

  // Só o WhatsApp degradado derruba o status (o estado fica no SQLite local).
  if (!health.services.whatsapp.healthy) {
    health.status = 'degraded';
  }

  res.status(health.status === 'ok' ? 200 : 503).json(health);
});

const PORT = config.port;

server.listen(PORT, async () => {
  logger.info({ port: PORT }, 'Server listening');
  
  io.emit('server-status', 'A inicializar o sistema...');
  
  // Initialize services in background (non-blocking)
  Promise.allSettled([
    analyticsService.getStats().then(() => logger.info('Analytics service ready')),
    chatStateService.cleanup().then(() => logger.info('Chat state service ready')),
  ]).catch(() => {}); // Ignore errors - services will work on-demand
  // Estados de atendimento expirados (TTL de 24h) são removidos a cada hora.
  setInterval(() => { void chatStateService.cleanup(); }, 60 * 60 * 1000).unref();
  
  // Initialize WhatsApp
  try {
    await whatsAppService.init();
    logger.info('WhatsApp service initialized');
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'WhatsApp initialization failed');
  }
});

let isShuttingDown = false;

async function gracefulShutdown(signal: string, exitCode = 0): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Shutting down gracefully...');

  // Stop accepting new connections immediately
  server.close();

  // Hard exit safety net — must stay under tsx watch's 5s force-kill window,
  // otherwise Chrome gets SIGKILLed and leaves crash dumps behind.
  const forceExit = setTimeout(() => {
    logger.warn('Forced shutdown after timeout');
    process.exit(exitCode);
  }, 4000);
  forceExit.unref();

  try {
    await whatsAppService.destroy();
    await closeSharedBrowser();
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Error during shutdown cleanup');
  }

  logger.info('Server closed');
  process.exit(exitCode);
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
