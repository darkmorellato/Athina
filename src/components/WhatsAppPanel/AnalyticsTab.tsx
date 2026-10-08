/**
 * @fileoverview Analytics metrics tab component.
 */
import { BarChart3, AlertTriangle } from 'lucide-react';
import type { AnalyticsStats } from '../../types/index.js';

interface AnalyticsTabProps {
  stats: AnalyticsStats;
  onRefresh: () => void;
  onReset: () => void;
}

export function AnalyticsTab({ stats, onRefresh, onReset }: AnalyticsTabProps) {
  const totalIntents = Object.values(stats.intentCounts).reduce((a, b) => a + b, 0) || 1;

  return (
    <div className="flex-1 flex flex-col bg-white overflow-y-auto p-5 gap-5 custom-scrollbar">
      <div className="flex items-center justify-between border-b border-gray-150 pb-3 shrink-0">
        <div className="flex items-center gap-2">
          <BarChart3 className="text-violet-600" size={20} />
          <h3 className="font-bold text-sm text-gray-800">HUD de Análise e Telemetria NuovoPay</h3>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onRefresh}
            className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider
              bg-violet-100 text-violet-700 rounded-lg hover:bg-violet-200 transition-colors"
          >
            🔄 Atualizar
          </button>
          <button
            onClick={() => { if (window.confirm('Tem certeza? Isso resetará todas as métricas.')) onReset(); }}
            className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider
              bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition-colors"
          >
            🗑️ Resetar
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard label="Total de Conversas" value={stats.totalChats} color="indigo" />
        <StatCard label="Auto-Resolvidos (IA)" value={stats.autoResolved} color="emerald" />
        <StatCard label="Intervenções Humanas" value={stats.humanInterventions} color="amber" />
        <StatCard label="OCR Comprovantes" value={stats.ocrScans} color="violet" />
        <StatCard label="Comprovantes Válidos" value={stats.ocrValids} color="blue" />
        <StatCard label="Fraudes / Suspeitos" value={stats.ocrSuspicious} color="rose" />
      </div>

      {/* Intent Distribution */}
      <div className="flex flex-col gap-3">
        <h4 className="font-bold text-xs uppercase text-gray-500 tracking-wider">
          Principais Intenções de Clientes
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {Object.keys(stats.intentCounts).length === 0 ? (
            <div className="text-xs text-gray-400 italic py-4">
              Nenhuma intenção classificada ainda.
            </div>
          ) : (
            Object.entries(stats.intentCounts).map(([intent, count]) => {
              const pct = Math.round((count / totalIntents) * 100);
              return (
                <div
                  key={intent}
                  className="space-y-1 bg-gray-50 p-3.5 rounded-xl border border-gray-150
                    shadow-xs flex flex-col justify-between"
                >
                  <div className="flex justify-between items-center text-xs">
                    <span className="font-bold text-gray-700">{intent}</span>
                    <span className="font-extrabold text-gray-900 tabular-nums">
                      {count} chamados ({pct}%)
                    </span>
                  </div>
                  <div className="w-full bg-gray-250 h-2 rounded-full overflow-hidden mt-1.5">
                    <div
                      style={{ width: `${pct}%` }}
                      className="bg-indigo-600 h-full rounded-full transition-all duration-500"
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* OCR Shield Report */}
      <div className="flex flex-col gap-3 border-t border-gray-150 pt-5">
        <h4 className="font-bold text-xs uppercase text-gray-500 tracking-wider flex items-center gap-1.5">
          <AlertTriangle className="text-amber-500" size={14} />
          Relatórios Recentes do Escudo OCR Shield
        </h4>
        <div className="bg-gray-50 p-4 rounded-2xl border border-gray-150 text-xs
          leading-relaxed text-gray-600">
          <p className="mb-2">
            O <b>OCR Shield</b> atua ativamente protegendo a NuovoPay de fraudes
            financeiras na liberação rápida de aparelhos.
          </p>
          <div className="flex flex-col gap-2 mt-2">
            <div className="flex justify-between items-center border-b border-gray-200/50 pb-1.5">
              <span>Validação de Data:</span>
              <span className="font-semibold text-gray-800">
                Recusa automática de anos anteriores a 2026.
              </span>
            </div>
            <div className="flex justify-between items-center border-b border-gray-200/50 pb-1.5">
              <span>Validação de Favorecido:</span>
              <span className="font-semibold text-gray-800">
                Exige menções claras a Celcoin / NuovoPay.
              </span>
            </div>
            <div className="flex justify-between items-center pb-1">
              <span>Monitor de Fraude:</span>
              <span className="font-semibold text-emerald-600 flex items-center gap-1">
                <div className="w-2 h-2 bg-emerald-500 rounded-full animate-ping" />
                Monitoramento Ativo
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: number;
  color: 'indigo' | 'emerald' | 'amber' | 'violet' | 'blue' | 'rose';
}

function StatCard({ label, value, color }: StatCardProps) {
  const colors = {
    indigo: 'bg-indigo-50 border-indigo-100 text-indigo-500',
    emerald: 'bg-emerald-50 border-emerald-100 text-emerald-500',
    amber: 'bg-amber-50 border-amber-100 text-amber-500',
    violet: 'bg-violet-50 border-violet-100 text-violet-500',
    blue: 'bg-blue-50 border-blue-100 text-blue-500',
    rose: 'bg-rose-50 border-rose-100 text-rose-500',
  };

  return (
    <div className={`${colors[color]} border rounded-2xl p-4 shadow-xs flex flex-col gap-1`}>
      <span className="text-[10px] uppercase font-bold tracking-wider">{label}</span>
      <span className="text-2xl font-extrabold tabular-nums text-gray-900">
        {value}
      </span>
    </div>
  );
}