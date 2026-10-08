/**
 * @fileoverview Player de mensagem de voz no estilo WhatsApp Web.
 * Reprodução via Web Audio (AudioContext) — funciona também em webviews/iframes
 * restritos (ex.: preview embutido do VS Code), onde o elemento <audio> pode
 * ser bloqueado. Forma de onda REAL, seek arrastando, velocidade 1x/1.5x/2x.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { waveformBars, formatDuration, parseDataUrl } from './chatLogic.js';
import { PauseIcon, PlayIcon } from './icons.js';

const BAR_COUNT = 42;
const SPEEDS = [1, 1.5, 2] as const;

/** Apenas um áudio tocando por vez, como no WhatsApp. */
let stopActive: (() => void) | null = null;

/** AudioContext compartilhado (decodificação + reprodução). */
let sharedCtx: AudioContext | null = null;
function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  sharedCtx ??= new Ctor();
  return sharedCtx;
}

/**
 * Decodifica o áudio (data URL base64) em um AudioBuffer.
 * Prefere decodificar direto dos bytes (atob), sem fetch — mais compatível
 * com webviews que restringem certos carregamentos.
 */
async function decodeVoice(src: string): Promise<AudioBuffer | null> {
  const ctx = getAudioContext();
  if (!ctx) return null;
  const parsed = parseDataUrl(src);
  let bytes: ArrayBuffer;
  if (parsed) {
    const bin = atob(parsed.base64.replace(/\s+/g, ''));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    bytes = arr.buffer;
  } else {
    bytes = await (await fetch(src)).arrayBuffer();
  }
  return ctx.decodeAudioData(bytes);
}

/** Ondas de espera (determinísticas) enquanto o áudio não é decodificado. */
function placeholderBars(): number[] {
  return Array.from({ length: BAR_COUNT }, (_, i) => 0.35 + 0.45 * Math.abs(Math.sin(i * 0.7)));
}

interface VoiceNotePlayerProps {
  /** Data URL do áudio (base64) */
  src: string;
  /** Mensagem enviada (bolha verde) */
  isOut: boolean;
  /** Foto de quem enviou (contato) — opcional */
  avatarUrl?: string | null;
}

export const VoiceNotePlayer = memo(function VoiceNotePlayer({
  src,
  isOut,
  avatarUrl,
}: VoiceNotePlayerProps) {
  const bufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef(0); // ctx.currentTime no início do trecho atual
  const offsetRef = useRef(0); // segundos dentro do áudio no início do trecho
  const speedRef = useRef(0); // índice em SPEEDS
  const stopSelfRef = useRef<() => void>(() => undefined);

  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [bars, setBars] = useState<number[]>(placeholderBars);
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);

  /** Posição atual (segundos), calculada pelo relógio do AudioContext. */
  const position = (): number => {
    const ctx = getAudioContext();
    const s = sourceRef.current;
    if (!ctx || !s) return offsetRef.current;
    return offsetRef.current + (ctx.currentTime - startedAtRef.current) * SPEEDS[speedRef.current];
  };

  /** Interrompe o trecho em execução (opcionalmente guardando a posição). */
  const stopPlayback = (keepOffset: boolean): void => {
    const s = sourceRef.current;
    if (s) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* já parado */
      }
      sourceRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (!keepOffset) offsetRef.current = 0;
  };

  // Decodifica uma vez: alimenta a forma de onda E a reprodução.
  useEffect(() => {
    let cancelled = false;
    bufferRef.current = null;
    void (async () => {
      try {
        const audioBuf = await decodeVoice(src);
        if (cancelled || !audioBuf) return;
        bufferRef.current = audioBuf;
        setDuration(audioBuf.duration);
        const data = audioBuf.getChannelData(0);
        const peakCount = 160;
        const step = Math.max(1, Math.floor(data.length / peakCount));
        const peaks: number[] = [];
        for (let i = 0; i < peakCount; i++) {
          let max = 0;
          const base = i * step;
          const end = Math.min(base + step, data.length);
          for (let j = base; j < end; j += 4) {
            const v = Math.abs(data[j]);
            if (v > max) max = v;
          }
          peaks.push(max);
        }
        const realBars = waveformBars(peaks, BAR_COUNT);
        if (!cancelled && realBars.some((b) => b > 0)) setBars(realBars);
      } catch {
        /* mantém o placeholder; o erro visível aparece ao tentar reproduzir */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src]);

  // Registro "um por vez" + limpeza ao desmontar.
  useEffect(() => {
    const self = (): void => {
      stopPlayback(false);
      setPlaying(false);
      setCurrent(0);
      if (stopActive === self) stopActive = null;
    };
    stopSelfRef.current = self;
    return () => {
      self();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Inicia a reprodução a partir de offsetRef. */
  const startPlayback = async (): Promise<void> => {
    const ctx = getAudioContext();
    const buf = bufferRef.current;
    if (!ctx || !buf) {
      setPlayError('Não foi possível carregar este áudio neste navegador.');
      return;
    }
    if (ctx.state === 'suspended') {
      // resume() pode ficar pendente para sempre se o embedder não reconhecer o
      // gesto — não dá para esperar por ele; o watchdog abaixo avisa nesse caso.
      void ctx.resume().catch((err: unknown) => {
        console.warn('[VoiceNotePlayer] AudioContext.resume() falhou:', err);
      });
    }
    if (stopActive && stopActive !== stopSelfRef.current) stopActive();
    stopActive = stopSelfRef.current;

    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.playbackRate.value = SPEEDS[speedRef.current];
    node.connect(ctx.destination);
    node.onended = (): void => {
      if (sourceRef.current !== node) return;
      sourceRef.current = null;
      offsetRef.current = 0;
      setCurrent(0);
      setPlaying(false);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (stopActive === stopSelfRef.current) stopActive = null;
    };
    const startAt = Math.min(offsetRef.current, Math.max(0, buf.duration - 0.01));
    startedAtRef.current = ctx.currentTime;
    try {
      node.start(0, startAt);
    } catch (err) {
      console.warn('[VoiceNotePlayer] AudioBufferSourceNode.start() falhou:', err);
      setPlayError('Não foi possível reproduzir este áudio neste navegador.');
      return;
    }
    sourceRef.current = node;
    setPlaying(true);
    setPlayError(null);

    // Watchdog: se o contexto continuar suspenso (embedder ignorou o gesto), avisa.
    window.setTimeout(() => {
      if (sourceRef.current === node && ctx.state !== 'running') {
        setPlayError(
          'Este preview está bloqueando o áudio. Abra o painel em um navegador (ex.: Zen).'
        );
      }
    }, 1000);

    const tick = (): void => {
      if (sourceRef.current !== node) return;
      const pos = position();
      setCurrent(pos >= buf.duration ? buf.duration : pos);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  /** Pausa guardando a posição atual. */
  const pausePlayback = (): void => {
    if (!sourceRef.current) return;
    const pos = Math.min(position(), duration || Number.POSITIVE_INFINITY);
    stopPlayback(true);
    offsetRef.current = pos;
    setCurrent(pos);
    setPlaying(false);
  };

  const toggle = (): void => {
    if (playing) pausePlayback();
    else void startPlayback();
  };

  /** Vai para uma posição (segundos); se estiver tocando, retoma de lá. */
  const seekTo = (seconds: number): void => {
    const max = bufferRef.current ? bufferRef.current.duration : duration;
    const pos = Math.min(Math.max(0, seconds), Math.max(0, max - 0.01));
    if (playing) {
      stopPlayback(true);
      offsetRef.current = pos;
      setCurrent(pos);
      void startPlayback();
    } else {
      offsetRef.current = pos;
      setCurrent(pos);
    }
  };

  const seekFromPointer = (clientX: number, el: HTMLElement): void => {
    const max = bufferRef.current ? bufferRef.current.duration : duration;
    if (!max) return;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    seekTo(frac * max);
  };

  const cycleSpeed = (): void => {
    const next = (speedRef.current + 1) % SPEEDS.length;
    speedRef.current = next;
    setSpeedIdx(next);
    if (playing) {
      const pos = position();
      stopPlayback(true);
      offsetRef.current = pos;
      setCurrent(pos);
      void startPlayback();
    }
  };

  const progress = duration > 0 ? current / duration : 0;
  const remaining = Math.max(0, duration - current);
  const timeLabel = formatDuration(playing || current > 0 ? remaining : duration);
  const showAvatar = Boolean(avatarUrl) && failedAvatar !== avatarUrl;

  return (
    <>
      <div className="wa-voice">
        <button
          type="button"
          className="wa-voice-play"
          onClick={toggle}
          onPointerDown={() => {
            // segunda chance de gesto: alguns embedders registram no pointerdown
            const c = getAudioContext();
            if (c && c.state === 'suspended') void c.resume().catch(() => undefined);
          }}
          aria-label={playing ? 'Pausar áudio' : 'Reproduzir áudio'}
          title={playing ? 'Pausar' : 'Reproduzir'}
        >
          {showAvatar ? (
            <img
              src={avatarUrl as string}
              alt=""
              className="wa-voice-avatar"
              onError={() => setFailedAvatar(avatarUrl ?? null)}
            />
          ) : (
            <span
              className={`wa-voice-avatar wa-voice-avatar-fallback${isOut ? ' wa-voice-fallback-out' : ''}`}
            />
          )}
          <span className="wa-voice-icon">
            {playing ? <PauseIcon width={18} height={18} /> : <PlayIcon width={18} height={18} />}
          </span>
        </button>

        <div
          className="wa-wave"
          role="slider"
          aria-label="Posição do áudio"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          title="Arraste para navegar"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekFromPointer(e.clientX, e.currentTarget);
          }}
          onPointerMove={(e) => {
            if (e.buttons) seekFromPointer(e.clientX, e.currentTarget);
          }}
        >
          {bars.map((v, i) => (
            <span
              key={i}
              className={`wa-bar${i / bars.length < progress ? ' wa-bar-played' : ''}`}
              style={{ height: `${Math.round(6 + v * 20)}px` }}
            />
          ))}
        </div>

        <span className="wa-voice-time">{timeLabel}</span>
        <button
          type="button"
          className="wa-speed"
          onClick={cycleSpeed}
          title="Velocidade de reprodução"
        >
          {SPEEDS[speedIdx]}x
        </button>
      </div>
      {playError && <div className="wa-voice-error">{playError}</div>}
    </>
  );
});
