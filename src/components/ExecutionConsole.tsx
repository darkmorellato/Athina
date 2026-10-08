/**
 * @fileoverview Execution console / log viewer component.
 */
import { useEffect, useRef } from 'react';
import { Activity, RefreshCw, Eraser } from 'lucide-react';
import type { AgentLog } from '../types/index.js';

interface ExecutionConsoleProps {
  logs: AgentLog[];
  isAgentTyping: boolean;
  onClear: () => void;
}

const LOG_COLORS: Record<AgentLog['type'], string> = {
  success: 'text-emerald-400/90',
  process: 'text-amber-400/90',
  error: 'text-red-400/90',
  info: 'text-slate-400/80',
};

export function ExecutionConsole({ logs, isAgentTyping, onClear }: ExecutionConsoleProps) {
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="flex-1 flex flex-col gap-3 min-h-[180px] border-t border-slate-800/50 pt-6">
      <div className="flex items-center justify-between">
        <label className="text-[10px] uppercase font-bold text-slate-500
          tracking-widest flex items-center gap-2">
          <Activity size={12} className="text-emerald-400" />
          Consola de Execução
        </label>
        <div className="flex gap-3 items-center">
          {isAgentTyping && (
            <span className="text-[9px] text-indigo-400 font-bold animate-pulse
              flex items-center gap-1">
              <RefreshCw size={10} className="animate-spin" />
              IA Processando
            </span>
          )}
          <button
            onClick={onClear}
            className="p-1.5 hover:bg-slate-800 rounded-lg text-slate-600
              hover:text-slate-400 transition-colors"
            title="Limpar Consola"
          >
            <Eraser size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 bg-black/30 backdrop-blur-xs rounded-2xl p-4
        font-mono text-[10px] overflow-y-auto border border-slate-800/50
        shadow-inner custom-scrollbar">
        {logs.length === 0 && (
          <div className="text-slate-700 italic">A aguardar eventos...</div>
        )}
        {logs.map((log) => (
          <div
            key={log.id}
            className="mb-2 flex gap-3 border-l border-slate-800/50 pl-3"
          >
            <span className="text-slate-600 shrink-0 tabular-nums">[{log.time}]</span>
            <span className={`leading-relaxed ${LOG_COLORS[log.type]}`}>{log.text}</span>
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}