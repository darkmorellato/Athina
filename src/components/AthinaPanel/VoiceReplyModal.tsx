import { motion } from 'framer-motion';
import { X, Mic, Languages, ChevronRight, Trash2, Play, Sparkles, Send } from 'lucide-react';

interface VoiceReplyModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedContact: string | null;
  voiceText: string;
  setVoiceText: (text: string) => void;
  selectedVoice: string;
  setSelectedVoice: (voice: string) => void;
  isSynthesizing: boolean;
  isCorrecting: boolean;
  isSendingVoice: boolean;
  hasAudio: boolean;
  playbackBlocked: boolean;
  playPreview: () => void;
  handleLimpar: () => void;
  handleOuvir: () => void;
  handleCorrigir: () => void;
  handleEnviarAudio: () => void;
}

export function VoiceReplyModal({
  isOpen,
  onClose,
  selectedContact,
  voiceText,
  setVoiceText,
  selectedVoice,
  setSelectedVoice,
  isSynthesizing,
  isCorrecting,
  isSendingVoice,
  hasAudio,
  playbackBlocked,
  playPreview,
  handleLimpar,
  handleOuvir,
  handleCorrigir,
  handleEnviarAudio,
}: VoiceReplyModalProps) {
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
        <div className="p-2 bg-purple-500/10 rounded-xl">
          <Mic size={20} className="text-purple-400" />
        </div>
        <div>
          <h3 className="font-bold text-sm tracking-tight text-white">Resposta por Voz (Manual)</h3>
          <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Texto para Voz (TTS)</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col gap-4 dark-scrollbar pr-1">
        <div className="flex items-center justify-between">
          <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider select-none">Configuração da resposta</span>
          {selectedContact ? (
            <span className="text-[9px] bg-emerald-500/15 text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-500/20 font-bold uppercase tracking-tighter">
              Chat Ativo
            </span>
          ) : (
            <span className="text-[9px] bg-amber-500/15 text-amber-400 px-2 py-0.5 rounded-full border border-amber-500/20 font-bold uppercase tracking-tighter">
              Sem Chat
            </span>
          )}
        </div>

        <textarea
          value={voiceText}
          onChange={(e) => setVoiceText(e.target.value)}
          placeholder="Digite o texto que deseja converter em mensagem de voz e enviar ao cliente..."
          className="w-full min-h-[140px] bg-slate-950/60 border border-slate-800/70 rounded-xl px-3 py-2 text-xs text-indigo-100 placeholder-slate-600 focus:outline-hidden focus:border-indigo-500/50 resize-none transition-all"
        />

        <div className="flex flex-col gap-2">
          <label className="text-[10px] uppercase font-bold text-slate-500 tracking-widest flex items-center gap-2 select-none">
            <Languages size={10} className="text-purple-400" />
            Selecione a Voz
          </label>
          <div className="relative">
            <select
              value={selectedVoice}
              onChange={(e) => setSelectedVoice(e.target.value)}
              className="w-full bg-slate-950/60 border border-slate-800/70 rounded-xl pl-3 pr-8 py-2 text-xs text-slate-300 focus:outline-hidden focus:border-indigo-500/50 appearance-none cursor-pointer"
            >
              <option value="pf_dora">🌸 Dora (BR · local)</option>
              <option value="pm_alex">🎙️ Alex (BR · local)</option>
              <option value="riva_male">⚡ Chatterbox Masculina (BR · NVIDIA)</option>
              <option value="magpie_diego">⚡ Diego Masculina (BR · NVIDIA)</option>
              <option value="magpie_louise">✨ Louise Feminina (BR · NVIDIA)</option>
              <option value="magpie_isabela">✨ Isabela Feminina (BR · NVIDIA)</option>
            </select>
            <ChevronRight size={12} className="absolute right-3 top-1/2 -translate-y-1/2 rotate-90 text-slate-500 pointer-events-none" />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-2 border-t border-slate-800/50">
        {playbackBlocked && (
          <p className="text-[9px] text-amber-400/90 absolute -top-6 left-5 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2 py-1">
            O navegador bloqueou o autoplay — clique em ▶ Tocar para ouvir.
          </p>
        )}
        <button
          onClick={handleLimpar}
          disabled={!voiceText}
          className="px-3 py-2 bg-slate-800/80 hover:bg-slate-700/80 disabled:opacity-30 disabled:hover:bg-slate-800/80 text-slate-400 hover:text-slate-200 rounded-xl transition-all cursor-pointer shadow-xs text-xs font-bold flex items-center gap-1.5"
        >
          <Trash2 size={12} />
          Limpar
        </button>

        <div className="flex-1" />

        <button
          onClick={handleOuvir}
          disabled={!voiceText || isSynthesizing}
          className="px-3 py-2 bg-indigo-500/10 hover:bg-indigo-500/20 disabled:opacity-30 disabled:hover:bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 rounded-xl transition-all cursor-pointer shadow-xs text-xs font-bold flex items-center gap-1.5"
        >
          {isSynthesizing ? (
            <span className="w-3 h-3 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
          ) : (
            <Play size={12} />
          )}
          Ouvir
        </button>

        {hasAudio && (
          <button
            onClick={playPreview}
            title="Reproduzir o último áudio gerado"
            className="px-3 py-2 bg-indigo-500 hover:bg-indigo-400 active:bg-indigo-600 text-white rounded-xl transition-all cursor-pointer shadow-md text-xs font-bold flex items-center gap-1.5"
          >
            <Play size={12} />
            Tocar
          </button>
        )}

        <button
          onClick={handleCorrigir}
          disabled={!voiceText || isCorrecting}
          className="px-3 py-2 bg-purple-500/10 hover:bg-purple-500/20 disabled:opacity-30 disabled:hover:bg-purple-500/10 border border-purple-500/20 text-purple-400 rounded-xl transition-all cursor-pointer shadow-xs text-xs font-bold flex items-center gap-1.5"
        >
          {isCorrecting ? (
            <span className="w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
          ) : (
            <Sparkles size={12} />
          )}
          Revisar
        </button>

        <button
          onClick={handleEnviarAudio}
          disabled={!voiceText || !selectedContact || isSendingVoice}
          className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-30 disabled:hover:bg-emerald-600 text-white rounded-xl transition-all cursor-pointer shadow-md text-xs font-bold flex items-center gap-1.5"
        >
          {isSendingVoice ? (
            <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <Send size={12} />
          )}
          Enviar
        </button>
      </div>
    </motion.div>
  );
}
