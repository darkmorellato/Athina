import { useState } from 'react';
import { RotateCcw, Save, Workflow } from 'lucide-react';
import type { FlowTextItem } from '@shared/contracts.js';

interface FlowTextsSectionProps {
  flowTexts: FlowTextItem[];
  updateFlowText: (key: string, text: string) => void;
}

/** Textos do roteiro da Athina editáveis pelo operador (salvos no servidor). */
export function FlowTextsSection({ flowTexts, updateFlowText }: FlowTextsSectionProps) {
  const stages = Array.from(new Set(flowTexts.map((t) => t.stage)));

  return (
    <div className="flex-1 flex flex-col gap-4 overflow-hidden min-w-0">
      <div className="flex items-center gap-2 border-b border-gray-150 pb-3 shrink-0">
        <Workflow className="text-emerald-600" size={20} />
        <h3 className="font-bold text-sm text-gray-800">Workflow da Athina — textos do atendimento</h3>
      </div>
      <p className="text-[11px] text-gray-500 shrink-0">
        Edite as mensagens de cada etapa. A alteração vale na próxima mensagem do cliente, sem reiniciar.
        Dados do cliente (menu com nome, PIX, boleto) continuam automáticos.
      </p>

      <div className="flex-1 overflow-y-auto custom-scrollbar flex flex-col gap-5 pr-1">
        {stages.map((stage) => (
          <section key={stage} className="flex flex-col gap-3">
            <h4 className="text-[11px] font-bold uppercase tracking-wide text-emerald-700">{stage}</h4>
            {flowTexts
              .filter((t) => t.stage === stage)
              .map((item) => (
                <FlowTextEditor
                  key={`${item.key}:${item.text}`}
                  item={item}
                  onSave={(text) => updateFlowText(item.key, text)}
                />
              ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function FlowTextEditor({ item, onSave }: { item: FlowTextItem; onSave: (text: string) => void }) {
  const [draft, setDraft] = useState(item.text);
  const changed = draft.trim() !== item.text;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-gray-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-gray-800">{item.label}</span>
        {item.isCustom && (
          <span className="text-[9px] font-bold uppercase text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
            personalizado
          </span>
        )}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={Math.min(8, Math.max(3, draft.split('\n').length))}
        maxLength={2000}
        aria-label={item.label}
        className="w-full px-3 py-2 rounded-lg border border-gray-200 text-xs leading-relaxed focus:outline-hidden focus:ring-1 focus:ring-emerald-500 resize-y"
      />
      {item.placeholders.length > 0 && (
        <span className="text-[10px] text-gray-400">Use {item.placeholders.join(', ')} para o dado dinâmico.</span>
      )}
      <div className="flex justify-end gap-2">
        {item.isCustom && (
          <button
            type="button"
            onClick={() => onSave('')}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] text-gray-600 hover:bg-gray-100"
          >
            <RotateCcw size={12} /> Restaurar padrão
          </button>
        )}
        <button
          type="button"
          disabled={!changed || draft.trim() === ''}
          onClick={() => onSave(draft)}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Save size={12} /> Salvar
        </button>
      </div>
    </div>
  );
}
