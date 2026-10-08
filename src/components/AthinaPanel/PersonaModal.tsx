import { motion } from 'framer-motion';
import { X, Bot, Server, ChevronRight, User } from 'lucide-react';
import { AVAILABLE_MODELS } from '../../types/index.js';

interface PersonaModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedModel: string;
  setSelectedModel: (v: string) => void;
  localPersona: string;
  setLocalPersona: (v: string) => void;
  handlePersonaBlur: () => void;
}

export function PersonaModal({
  isOpen,
  onClose,
  selectedModel,
  setSelectedModel,
  localPersona,
  setLocalPersona,
  handlePersonaBlur,
}: PersonaModalProps) {
  if (!isOpen) return null;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="w-full max-h-[85%] bg-slate-900 border border-slate-800 rounded-3xl p-5 shadow-2xl flex flex-col gap-4 relative overflow-hidden"
    >
      {/* Close Button */}
      <button
        onClick={onClose}
        className="absolute right-4 top-4 p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 rounded-xl transition-all cursor-pointer"
      >
        <X size={16} />
      </button>

      <div className="flex items-center gap-3">
        <div className="p-2 bg-indigo-500/10 rounded-xl">
          <Bot size={20} className="text-indigo-400" />
        </div>
        <div>
          <h3 className="font-bold text-sm tracking-tight text-white">Diretrizes da Persona & IA</h3>
          <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Cérebro da Athina</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col gap-4 dark-scrollbar pr-1">
        {/* Model Selector */}
        <div className="flex flex-col gap-2">
          <label className="text-[10px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-2 select-none">
            <Server size={10} className="text-indigo-400" />
            Motor de IA (NVIDIA NIM)
          </label>
          <div className="relative group">
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2 text-xs text-indigo-100 focus:outline-hidden focus:border-indigo-500/50 appearance-none cursor-pointer transition-all hover:bg-slate-950 shadow-inner"
            >
              {AVAILABLE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <ChevronRight
              size={12}
              className="absolute right-3 top-1/2 -translate-y-1/2 rotate-90 text-slate-600 pointer-events-none"
            />
          </div>
        </div>

        {/* Persona Textarea */}
        <div className="flex-1 flex flex-col gap-2 min-h-[220px]">
          <label className="text-[10px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-2 select-none">
            <User size={10} className="text-indigo-400" />
            Diretrizes da Persona
          </label>
          <textarea
            value={localPersona}
            onChange={(e) => setLocalPersona(e.target.value)}
            onBlur={handlePersonaBlur}
            className="flex-1 w-full bg-slate-950/60 border border-slate-800 rounded-2xl p-4 text-[11px] text-indigo-100/80 resize-none focus:outline-hidden focus:border-indigo-500/30 shadow-inner leading-relaxed custom-scrollbar transition-all hover:bg-slate-950"
            placeholder="Defina o comportamento e diretrizes da persona da IA..."
          />
        </div>
      </div>

      <div className="flex gap-2 justify-end pt-2 border-t border-slate-800/50">
        <button
          onClick={onClose}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-bold text-xs rounded-xl shadow-lg transition-all cursor-pointer"
        >
          Salvar e Fechar
        </button>
      </div>
    </motion.div>
  );
}
