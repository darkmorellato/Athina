/**
 * @fileoverview Main application entry point.
 */
import { useState, useEffect, useCallback } from 'react';
import useSocket from './hooks/useSocket';
import WhatsAppPanel from './components/WhatsAppPanel.tsx';
import AthinaPanel from './components/AthinaPanel.tsx';
import { DraggableDivider } from './components/DraggableDivider.tsx';

export default function App() {
  const {
    socket,
    isConnected,
    isAgentActive,
    setIsAgentActive,
    audioMode,
    toggleAudioMode,
    qrCodeData,
    statusMessage,
    messages,
    chatList,
    historyMeta,
    isAgentTyping,
    agentLogs,
    selectedModel,
    setSelectedModel,
    agentPersona,
    setAgentPersona,
    quickReplies,
    setQuickReplies,
    stats,
    trainingData,
    sendReply,
    sendImage,
    avatars,
    requestAvatars,
    loadChatHistory,
    loadOlderMessages,
    restartWhatsApp,
    clearLogs,
    updateTrainingRules,
    updateTrainingQas,
    refreshStats,
    resetStats,
  } = useSocket();

  const [leftPanelWidth, setLeftPanelWidth] = useState(60);
  const [inputValue, setInputValue] = useState('');
  const [selectedContact, setSelectedContact] = useState<string | null>(null);

  useEffect(() => {
    if (selectedContact) {
      loadChatHistory(selectedContact);
    }
  }, [selectedContact, loadChatHistory]);

  const handleQuickReplySelect = useCallback((text: string) => {
    setInputValue(text);
  }, []);

  return (
    <div className="flex h-screen w-full bg-[#E5E7EB] p-2 md:p-4 gap-0
      font-sans overflow-hidden select-none">
      {/* Left Panel - WhatsApp */}
      <div
        style={{ width: `${leftPanelWidth}%` }}
        className="flex flex-col h-full transition-[width] duration-75 ease-linear"
      >
        <WhatsAppPanel
          isConnected={isConnected}
          qrCodeData={qrCodeData}
          statusMessage={statusMessage}
          messages={messages}
          chatList={chatList}
          historyMeta={historyMeta}
          onLoadOlder={loadOlderMessages}
          isAgentTyping={isAgentTyping}
          sendReply={sendReply}
          restartWhatsApp={restartWhatsApp}
          stats={stats}
          refreshStats={refreshStats}
          resetStats={resetStats}
          trainingData={trainingData}
          updateTrainingRules={updateTrainingRules}
          updateTrainingQas={updateTrainingQas}
          selectedContact={selectedContact}
          setSelectedContact={setSelectedContact}
          inputValue={inputValue}
          setInputValue={setInputValue}
          avatars={avatars}
          requestAvatars={requestAvatars}
          sendImage={sendImage}
        />
      </div>

      <DraggableDivider onResize={setLeftPanelWidth} />

      {/* Right Panel - Athina */}
      <div
        style={{ width: `${100 - leftPanelWidth}%` }}
        className="flex flex-col h-full transition-[width] duration-75 ease-linear"
      >
        <AthinaPanel
          socket={socket}
          selectedContact={selectedContact}
          isConnected={isConnected}
          isAgentActive={isAgentActive}
          setIsAgentActive={setIsAgentActive}
          audioMode={audioMode}
          toggleAudioMode={toggleAudioMode}
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          agentPersona={agentPersona}
          setAgentPersona={setAgentPersona}
          quickReplies={quickReplies}
          setQuickReplies={setQuickReplies}
          agentLogs={agentLogs}
          isAgentTyping={isAgentTyping}
          clearLogs={clearLogs}
          onQuickReplySelect={handleQuickReplySelect}
        />
      </div>
    </div>
  );
}