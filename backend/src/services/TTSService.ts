import axios from 'axios';
import { promises as fsPromises } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config/index.js';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function generateTTS(text: string, voice?: string): Promise<string> {
  // Toda a síntese passa pelo servidor TTS local (backend/ttsServer.py):
  //   - vozes pf_dora/pm_* → Kokoro ONNX local
  //   - vozes riva*        → NVIDIA Chatterbox (com fallback para Kokoro)
  // (A integração Resemble foi removida da UI por decisão de produto.)
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await axios.post<{ success: boolean; filePath: string; error?: string }>(
        `${config.ttsServerUrl}/tts`,
        {
          text: text,
          voice: (voice && voice !== 'resemble') ? voice : 'pf_dora',
          format: 'ogg',
          speed: 0.92
        },
        { timeout: 30000 }
      );

      if (response.data?.success && response.data.filePath) {
        // Security fix: Validate and sanitize file path, use async operations
        return await validateAndReadAudioFile(response.data.filePath);
      }
      lastError = new Error(response.data?.error || 'TTS Server returned failure status');
      break;
    } catch (err) {
      lastError = err;
      if (attempt === 1) {
        logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Local TTS failed — retrying');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('TTS failed');
}

/** Validate file path and read audio file asynchronously */
async function validateAndReadAudioFile(filePath: string): Promise<string> {
  try {
    // Security: Validate file path to prevent path traversal.
    // Resolve symlinks and require the path to be strictly INSIDE one of the
    // allowed audio dirs. The TTS server writes to backend/.tts_tmp (fixed,
    // project-local); os.tmpdir() is kept as legacy root for old files. Both
    // are realpaths, so symlink tricks are out.
    const resolvedPath = await fsPromises.realpath(path.normalize(filePath));
    const allowedRoots = await Promise.all(
      [path.resolve(__dirname, '../../.tts_tmp'), os.tmpdir()].map((dir) =>
        fsPromises.realpath(dir).catch(() => dir)
      )
    );
    const insideAllowed = allowedRoots.some((root) => {
      const relative = path.relative(root, resolvedPath);
      return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
    if (!insideAllowed) {
      logger.error({ filePath: resolvedPath }, 'Invalid file path - outside allowed directory');
      throw new Error('Invalid file path');
    }
    
    // Check if file exists and is a file (not directory)
    const stats = await fsPromises.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error('Path is not a file');
    }
    
    // Read file asynchronously
    const buffer = await fsPromises.readFile(resolvedPath);
    const base64 = buffer.toString('base64');
    
    // Clean up: Delete temporary file after reading
    await fsPromises.unlink(resolvedPath).catch((err) => {
      logger.warn({ error: err.message, filePath: resolvedPath }, 'Failed to delete temp audio file');
    });
    
    return base64;
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error), filePath }, 'Failed to read audio file');
    throw error;
  }
}
