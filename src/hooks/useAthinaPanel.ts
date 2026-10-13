import { useState, useEffect, useCallback, useRef } from 'react';
import type { Socket } from 'socket.io-client';

interface UseAthinaPanelProps {
  socket: Socket | null;
  selectedContact: string | null;
  agentPersona: string;
  setAgentPersona: (v: string) => void;
  setQuickReplies: React.Dispatch<React.SetStateAction<string[]>>;
}

export function useAthinaPanel({
  socket,
  selectedContact,
  agentPersona,
  setAgentPersona,
  setQuickReplies,
}: UseAthinaPanelProps) {
  const [localPersona, setLocalPersona] = useState(agentPersona);

  // Voice reply box states
  const [voiceText, setVoiceText] = useState('');
  const [selectedVoice, setSelectedVoice] = useState('pf_dora');
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [isCorrecting, setIsCorrecting] = useState(false);
  const [isSendingVoice, setIsSendingVoice] = useState(false);
  const [audioBase64, setAudioBase64] = useState<string | null>(null);
  const [pendingSend, setPendingSend] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  // Cache do último áudio gerado (texto+voz → base64) para o botão Ouvir
  // responder instantaneamente num clique (gesto do usuário = playback liberado).
  const audioCacheRef = useRef<{ key: string; base64: string } | null>(null);
  const lastRequestKeyRef = useRef<string | null>(null);

  // Modal active states
  const [activeModal, setActiveModal] = useState<'none' | 'persona' | 'voice' | 'quick_replies'>('none');
  const [newReplyText, setNewReplyText] = useState('');

  // Sync local persona with prop persona if changed externally
  useEffect(() => {
    setLocalPersona(agentPersona);
  }, [agentPersona]);

  // Set up socket listeners for TTS generation and Spelling correction
  useEffect(() => {
    if (!socket) return;

    const playBase64 = (base64: string) => {
      // O play() devolve uma promise que NÃO é capturada por try/catch — sem
      // .catch(), o bloqueio de autoplay do navegador falha em silêncio.
      try {
        const audio = new Audio('data:audio/ogg;base64,' + base64);
        audio.play().catch((err) => {
          console.warn('Autoplay bloqueado pelo navegador, use o botão Tocar:', err);
          setPlaybackBlocked(true);
        });
      } catch (err) {
        console.error('Erro ao reproduzir preview de áudio:', err);
        setPlaybackBlocked(true);
      }
    };

    const handleTtsGenerated = (data: { base64: string }) => {
      setIsSynthesizing(false);
      setAudioBase64(data.base64);

      if (lastRequestKeyRef.current) {
        audioCacheRef.current = { key: lastRequestKeyRef.current, base64: data.base64 };
      }

      // Tenta tocar já na geração; se o navegador bloquear, o botão "Tocar"
      // (clique direto do usuário) reproduz sem problema.
      playBase64(data.base64);

      // If pending send trigger is active, send immediately to active WhatsApp contact
      if (pendingSend && selectedContact) {
        socket.emit('send-voice-reply', { to: selectedContact, base64: data.base64 });
        setPendingSend(false);
        setIsSendingVoice(false);
        setVoiceText('');
        setAudioBase64(null);
      }
    };

    const handleTtsError = (data: { message: string }) => {
      setIsSynthesizing(false);
      setIsSendingVoice(false);
      setPendingSend(false);
      alert('Erro ao processar síntese de voz: ' + data.message);
    };

    const handleSpellingCorrected = (data: { text: string }) => {
      setIsCorrecting(false);
      setVoiceText(data.text);
    };

    const handleSpellingError = (data: { message: string }) => {
      setIsCorrecting(false);
      alert('Erro ao revisar ortografia: ' + data.message);
    };

    socket.on('tts-audio-generated', handleTtsGenerated);
    socket.on('tts-audio-error', handleTtsError);
    socket.on('spelling-corrected', handleSpellingCorrected);
    socket.on('spelling-error', handleSpellingError);

    return () => {
      socket.off('tts-audio-generated', handleTtsGenerated);
      socket.off('tts-audio-error', handleTtsError);
      socket.off('spelling-corrected', handleSpellingCorrected);
      socket.off('spelling-error', handleSpellingError);
    };
  }, [socket, pendingSend, selectedContact]);

  const handlePersonaBlur = useCallback(() => {
    setAgentPersona(localPersona);
  }, [localPersona, setAgentPersona]);

  const handleDeleteReply = useCallback(
    (index: number) => {
      setQuickReplies((prev) => prev.filter((_, idx) => idx !== index));
    },
    [setQuickReplies]
  );

  // Voice reply box actions
  const handleOuvir = () => {
    if (!voiceText.trim() || !socket) return;

    // Mesmo texto+voz já sintetizado? Toca direto do cache — o clique do
    // usuário é o gesto que libera o playback no navegador.
    const key = `${selectedVoice}::${voiceText}`;
    const cached = audioCacheRef.current;
    if (cached && cached.key === key) {
      setPlaybackBlocked(false);
      try {
        const audio = new Audio('data:audio/ogg;base64,' + cached.base64);
        audio.play().catch((err) => {
          console.error('Erro ao reproduzir áudio:', err);
          setPlaybackBlocked(true);
        });
      } catch (err) {
        console.error('Erro ao reproduzir áudio:', err);
      }
      return;
    }

    setPlaybackBlocked(false);
    setIsSynthesizing(true);
    setAudioBase64(null);
    lastRequestKeyRef.current = key;
    socket.emit('generate-tts-audio', { text: voiceText, voice: selectedVoice });
  };

  /** Reproduz o último áudio gerado (clique direto do usuário no botão Tocar). */
  const playPreview = useCallback(() => {
    if (!audioBase64) return;
    setPlaybackBlocked(false);
    try {
      const audio = new Audio('data:audio/ogg;base64,' + audioBase64);
      audio.play().catch((err) => {
        console.error('Erro ao reproduzir áudio:', err);
        setPlaybackBlocked(true);
      });
    } catch (err) {
      console.error('Erro ao reproduzir áudio:', err);
    }
  }, [audioBase64]);

  const handleCorrigir = () => {
    if (!voiceText.trim() || !socket) return;
    setIsCorrecting(true);
    socket.emit('correct-spelling', { text: voiceText, model: 'nvidia/nemotron-3.5-lightning-30b-a3b' });
  };

  const handleLimpar = () => {
    setVoiceText('');
    setAudioBase64(null);
    setPendingSend(false);
    setPlaybackBlocked(false);
    audioCacheRef.current = null;
  };

  const handleEnviarAudio = () => {
    if (!voiceText.trim() || !selectedContact || !socket) return;
    setIsSendingVoice(true);

    if (audioBase64) {
      socket.emit('send-voice-reply', { to: selectedContact, base64: audioBase64 });
      setIsSendingVoice(false);
      setVoiceText('');
      setAudioBase64(null);
    } else {
      setPendingSend(true);
      socket.emit('generate-tts-audio', { text: voiceText, voice: selectedVoice });
    }
  };

  // Add new quick reply action
  const handleAddQuickReply = useCallback(() => {
    if (!newReplyText.trim()) return;
    setQuickReplies((prev) => [...prev, newReplyText.trim()]);
    setNewReplyText('');
  }, [newReplyText, setQuickReplies]);

  return {
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
    pendingSend,
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
  };
}
