/**
 * @fileoverview Athina AI Agent control panel component.
 */
import { memo } from 'react';
import { Bot } from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import { ExecutionConsole } from './ExecutionConsole.tsx';
import { useAthinaPanel } from '../hooks/useAthinaPanel.js';
import { ToggleSwitch } from './AthinaPanel/ToggleSwitch.js';
import { ControlCards } from './AthinaPanel/ControlCards.js';
import { PersonaModal } from './AthinaPanel/PersonaModal.js';
import { VoiceReplyModal } from './AthinaPanel/VoiceReplyModal.js';
import { QuickRepliesModal } from './AthinaPanel/QuickRepliesModal.js';
import type { AgentLog } from '../types/index.js';
import type { Socket } from 'socket.io-client';

interface AthinaPanelProps {
  socket: Socket | null;
  selectedContact: string | null;
  isConnected: boolean;
  isAgentActive: boolean;
  setIsAgentActive: (v: boolean) => void;
  audioMode: boolean;
  toggleAudioMode: (v: boolean) => void;
  selectedModel: string;
  setSelectedModel: (v: string) => void;
  agentPersona: string;
  setAgentPersona: (v: string) => void;
  quickReplies: string[];
  setQuickReplies: React.Dispatch<React.SetStateAction<string[]>>;
  agentLogs: AgentLog[];
  isAgentTyping: boolean;
  clearLogs: () => void;
  onQuickReplySelect: (text: string) => void;
}

export default memo(function AthinaPanel({
  socket,
  selectedContact,
  isConnected,
  isAgentActive,
  setIsAgentActive,
  audioMode,
  toggleAudioMode,
  selectedModel,
  setSelectedModel,
  agentPersona,
  setAgentPersona,
  quickReplies,
  setQuickReplies,
  agentLogs,
  isAgentTyping,
  clearLogs,
  onQuickReplySelect,
}: AthinaPanelProps) {
  const {
    localPersona,
    setLocalPersona,
    voiceText,
    setVoiceText,
    selectedVoice,
    setSelectedVoice,
    isSynthesizing,
    isCorrecting,
    isSendingVoice,
    audioBase64,
    playbackBlocked,
    playPreview,
    activeModal,
    setActiveModal,
    newReplyText,
    setNewReplyText,
    handlePersonaBlur,
    handleDeleteReply,
    handleOuvir,
    handleCorrigir,
    handleLimpar,
    handleEnviarAudio,
    handleAddQuickReply,
  } = useAthinaPanel({
    socket,
    selectedContact,
    agentPersona,
    setAgentPersona,
    setQuickReplies,
  });

  return (
    <div className="flex flex-col bg-[#0f172a] rounded-3xl shadow-2xl overflow-hidden
      text-slate-200 border border-slate-800 relative h-full">
      {/* Top accent gradient */}
      <div className="absolute top-0 left-0 right-0 h-1 bg-linear-to-r
        from-indigo-500 via-purple-500 to-emerald-500 z-20" />

      {/* Header */}
      <div className="p-5 border-b border-slate-800/50 flex items-center justify-between
        bg-[#0f172a]/95 backdrop-blur-md z-10">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-500/10 rounded-xl">
            <Bot size={24} className="text-indigo-400" />
          </div>
          <div>
            <h2 className="font-bold text-base tracking-tight">Athina Kaiser</h2>
            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
              Nuovopay Intelligence
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 border-r border-slate-800/60 pr-4 mr-1">
            <span className="text-[10px] font-bold text-slate-400 flex items-center gap-1 select-none">
              🎙️ Resposta por Áudio
            </span>
            <ToggleSwitch
              active={audioMode}
              color="bg-indigo-500"
              onClick={() => toggleAudioMode(!audioMode)}
            />
          </div>

          <div className={`px-2 py-1 rounded-md text-[9px] font-bold uppercase
            tracking-tighter
            ${isConnected
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'bg-red-500/10 text-red-400 border border-red-500/20'
            }`}>
            {isConnected ? 'Bridge Ativa' : 'Desconectado'}
          </div>

          <ToggleSwitch
            active={isAgentActive}
            color="bg-emerald-500"
            onClick={() => setIsAgentActive(!isAgentActive)}
          />
        </div>
      </div>

      {/* Core Panel Control Cards */}
      <div className="flex-1 p-5 overflow-y-auto custom-scrollbar flex flex-col gap-5 bg-slate-950/20">
        <ControlCards setActiveModal={setActiveModal} />

        {/* Console logs */}
        <div className="flex-1 min-h-[220px] flex flex-col">
          <ExecutionConsole
            logs={agentLogs}
            isAgentTyping={isAgentTyping}
            onClear={clearLogs}
          />
        </div>
      </div>

      {/* Modals Overlay */}
      <AnimatePresence>
        {activeModal !== 'none' && (
          <div className="absolute inset-0 z-40 bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-5 animate-fade-in">
            <PersonaModal
              isOpen={activeModal === 'persona'}
              onClose={() => {
                handlePersonaBlur();
                setActiveModal('none');
              }}
              selectedModel={selectedModel}
              setSelectedModel={setSelectedModel}
              localPersona={localPersona}
              setLocalPersona={setLocalPersona}
              handlePersonaBlur={handlePersonaBlur}
            />

            <VoiceReplyModal
              isOpen={activeModal === 'voice'}
              onClose={() => setActiveModal('none')}
              selectedContact={selectedContact}
              voiceText={voiceText}
              setVoiceText={setVoiceText}
              selectedVoice={selectedVoice}
              setSelectedVoice={setSelectedVoice}
              isSynthesizing={isSynthesizing}
              isCorrecting={isCorrecting}
              isSendingVoice={isSendingVoice}
              hasAudio={Boolean(audioBase64)}
              playbackBlocked={playbackBlocked}
              playPreview={playPreview}
              handleLimpar={handleLimpar}
              handleOuvir={handleOuvir}
              handleCorrigir={handleCorrigir}
              handleEnviarAudio={handleEnviarAudio}
            />

            <QuickRepliesModal
              isOpen={activeModal === 'quick_replies'}
              onClose={() => setActiveModal('none')}
              quickReplies={quickReplies}
              newReplyText={newReplyText}
              setNewReplyText={setNewReplyText}
              handleAddQuickReply={handleAddQuickReply}
              handleDeleteReply={handleDeleteReply}
              onQuickReplySelect={onQuickReplySelect}
            />
          </div>
        )}
      </AnimatePresence>
    </div>
  );
});