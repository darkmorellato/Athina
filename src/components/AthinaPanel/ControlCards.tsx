import { User, Mic, BookOpen } from 'lucide-react';

interface ControlCardsProps {
  setActiveModal: (modal: 'persona' | 'voice' | 'quick_replies') => void;
}

export function ControlCards({ setActiveModal }: ControlCardsProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 shrink-0">
      {/* Card A: Persona Guidelines */}
      <div
        onClick={() => setActiveModal('persona')}
        className="group bg-slate-900/60 border border-slate-800/80 rounded-2xl p-4 flex flex-col gap-3 hover:border-indigo-500/40 hover:bg-slate-900 transition-all duration-300 shadow-md cursor-pointer relative overflow-hidden"
      >
        <div className="p-2.5 bg-indigo-500/10 rounded-xl w-fit group-hover:bg-indigo-500/20 transition-all">
          <User size={16} className="text-indigo-400" />
        </div>
        <div>
          <h3 className="font-extrabold text-xs text-white">Editar Diretrizes</h3>
          <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
            Personalize o comportamento, tom de voz e regras de ouro da IA.
          </p>
        </div>
      </div>

      {/* Card B: Voice Reply */}
      <div
        onClick={() => setActiveModal('voice')}
        className="group bg-slate-900/60 border border-slate-800/80 rounded-2xl p-4 flex flex-col gap-3 hover:border-purple-500/40 hover:bg-slate-900 transition-all duration-300 shadow-md cursor-pointer relative overflow-hidden"
      >
        <div className="p-2.5 bg-purple-500/10 rounded-xl w-fit group-hover:bg-purple-500/20 transition-all">
          <Mic size={16} className="text-purple-400" />
        </div>
        <div>
          <h3 className="font-extrabold text-xs text-white">Resposta por Voz</h3>
          <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
            Envie áudios manuais digitados com sintetizador de voz integrado.
          </p>
        </div>
      </div>

      {/* Card C: Biblioteca */}
      <div
        onClick={() => setActiveModal('quick_replies')}
        className="group bg-slate-900/60 border border-slate-800/80 rounded-2xl p-4 flex flex-col gap-3 hover:border-emerald-500/40 hover:bg-slate-900 transition-all duration-300 shadow-md cursor-pointer relative overflow-hidden"
      >
        <div className="p-2.5 bg-emerald-500/10 rounded-xl w-fit group-hover:bg-emerald-500/20 transition-all">
          <BookOpen size={16} className="text-emerald-400" />
        </div>
        <div>
          <h3 className="font-extrabold text-xs text-white">Biblioteca Nuovo</h3>
          <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
            Modelos prontos de respostas rápidas institucionais e treinamento.
          </p>
        </div>
      </div>
    </div>
  );
}
