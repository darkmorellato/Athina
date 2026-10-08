/**
 * @fileoverview Main server entry point with Express + Socket.IO.
 */
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import config from './config/index.js';
import whatsAppService from './services/WhatsAppService.js';
import analyticsService from './services/AnalyticsService.js';
import chatStateService from './services/ChatStateService.js';
import redisService from './services/RedisService.js';
import { closeSharedBrowser } from './services/PaymobiScraperService.js';
import SocketController from './controllers/SocketController.js';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/contracts.js';
import logger from './utils/logger.js';
import { initLlmTracing } from './services/llmTracer.js';

process.on('uncaughtException', (error) => {
  logger.error({ error: error instanceof Error ? error.stack : String(error) }, 'Uncaught Exception captured');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason: reason instanceof Error ? reason.stack : String(reason) }, 'Unhandled Rejection captured');
});

const app = express();

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
/** Quick TTS readiness probe (2s timeout, never throws). */
async function checkTtsHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${config.ttsServerUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

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
      redis: {
        // Redis is optional (memory fallback) — informational only.
        connected: redisService.isReady(),
      },
      tts: {
        url: config.ttsServerUrl,
        healthy: await checkTtsHealth(),
      },
      agent: {
        autoReply: config.agentAutoReply,
        model: config.agentModel,
        aiBaseUrl: config.aiBaseUrl,
      },
    },
    memory: {
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
  };

  // Redis is optional (everything falls back to memory) — only an unhealthy
  // WhatsApp degrades the service.
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
  
  // Initialize WhatsApp
  try {
    await whatsAppService.init();
    logger.info('WhatsApp service initialized');
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'WhatsApp initialization failed');
  }
});

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Shutting down gracefully...');

  // Stop accepting new connections immediately
  server.close();

  // Hard exit safety net — must stay under tsx watch's 5s force-kill window,
  // otherwise Chrome gets SIGKILLed and leaves crash dumps behind.
  const forceExit = setTimeout(() => {
    logger.warn('Forced shutdown after timeout');
    process.exit(0);
  }, 4000);
  forceExit.unref();

  try {
    await whatsAppService.destroy();
    await closeSharedBrowser();
    await redisService.disconnect();
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Error during shutdown cleanup');
  }

  logger.info('Server closed');
  process.exit(0);
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
