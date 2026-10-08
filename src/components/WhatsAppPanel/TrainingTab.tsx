/**
 * @fileoverview Training configuration tab component.
 */
import { Brain, BookOpen } from 'lucide-react';
import type { TrainingData } from '../../types/index.js';

import { useState } from 'react';

interface TrainingTabProps {
  trainingData: TrainingData;
  updateTrainingRules: (rules: string[]) => void;
  updateTrainingQas: (qas: TrainingData['qaExamples']) => void;
}

export function TrainingTab({
  trainingData,
  updateTrainingRules,
  updateTrainingQas,
}: TrainingTabProps) {
  const [newRuleInput, setNewRuleInput] = useState('');
  const [newQaIntent, setNewQaIntent] = useState('');
  const [newQaQuestion, setNewQaQuestion] = useState('');
  const [newQaAnswer, setNewQaAnswer] = useState('');

  const handleAddRule = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!newRuleInput.trim()) return;
    updateTrainingRules([...(trainingData.customRules || []), newRuleInput.trim()]);
    setNewRuleInput('');
  };

  const handleAddQa = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!newQaIntent.trim() || !newQaQuestion.trim() || !newQaAnswer.trim()) return;
    updateTrainingQas([...(trainingData.qaExamples || []), {
      intent: newQaIntent.trim(),
      question: newQaQuestion.trim(),
      answer: newQaAnswer.trim(),
    }]);
    setNewQaIntent('');
    setNewQaQuestion('');
    setNewQaAnswer('');
  };

  return (
    <div className="flex-1 flex flex-col md:flex-row bg-white overflow-hidden p-5 gap-5">
      {/* Rules Section */}
      <div className="flex-1 flex flex-col gap-4 border-b md:border-b-0 md:border-r border-gray-150 pr-0 md:pr-5 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-gray-150 pb-3 shrink-0">
          <Brain className="text-indigo-600" size={20} />
          <h3 className="font-bold text-sm text-gray-800">Diretrizes & Regras de Conduta</h3>
        </div>

        <form onSubmit={handleAddRule} className="flex gap-2 shrink-0">
          <input
            type="text"
            value={newRuleInput}
            onChange={(e) => setNewRuleInput(e.target.value)}
            placeholder="Escreva uma nova diretriz de resposta..."
            className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-xs shadow-inner
              focus:ring-2 focus:ring-indigo-500 transition-all bg-gray-50"
          />
          <button
            type="submit"
            className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 rounded-xl
              flex items-center justify-center text-white font-bold text-xs gap-1
              transition-transform active:scale-95"
          >
            Adicionar
          </button>
        </form>

        <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 flex flex-col gap-2.5">
          {(!trainingData.customRules || trainingData.customRules.length === 0) && (
            <div className="text-xs text-gray-400 italic text-center py-8">
              Nenhuma diretriz de conduta cadastrada.
            </div>
          )}
          {trainingData.customRules.map((rule, idx) => (
            <div
              key={idx}
              className="bg-gray-50 p-3 rounded-xl border border-gray-150 flex justify-between
                items-start gap-3 transition-colors hover:bg-gray-100/50"
            >
              <p className="text-[11.5px] text-gray-700 font-semibold leading-relaxed">
                <span className="text-indigo-500 font-extrabold mr-1">#{idx + 1}</span>
                {rule}
              </p>
              <button
                onClick={() => {
                  const updated = [...trainingData.customRules];
                  updated.splice(idx, 1);
                  updateTrainingRules(updated);
                }}
                className="text-[10px] font-bold text-red-500 hover:text-red-700 shrink-0
                  uppercase tracking-wide hover:bg-red-50 px-2 py-1 rounded"
              >
                Excluir
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Q&A Section */}
      <div className="flex-1 flex flex-col gap-4 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-gray-150 pb-3 shrink-0">
          <BookOpen className="text-indigo-600" size={20} />
          <h3 className="font-bold text-sm text-gray-800">Exemplos de Q&A (Few-Shot)</h3>
        </div>

        <form
          onSubmit={handleAddQa}
          className="bg-gray-50 p-3 rounded-2xl border border-gray-200
            flex flex-col gap-2 shrink-0"
        >
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={newQaIntent}
              onChange={(e) => setNewQaIntent(e.target.value)}
              placeholder="Intenção (ex: Pix)"
              className="px-3 py-2 rounded-xl border border-gray-200 text-xs shadow-inner
                bg-white focus:ring-1 focus:ring-indigo-500"
            />
            <input
              type="text"
              value={newQaQuestion}
              onChange={(e) => setNewQaQuestion(e.target.value)}
              placeholder="Pergunta de exemplo"
              className="px-3 py-2 rounded-xl border border-gray-200 text-xs shadow-inner
                bg-white focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <textarea
            value={newQaAnswer}
            onChange={(e) => setNewQaAnswer(e.target.value)}
            placeholder="Resposta perfeita que a Athina deve dar..."
            className="w-full h-16 rounded-xl border border-gray-200 p-2.5 text-xs
              shadow-inner bg-white focus:ring-1 focus:ring-indigo-500 resize-none leading-normal"
          />
          <button
            type="submit"
            className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 rounded-xl
              flex items-center justify-center text-white font-bold text-xs gap-1
              transition-transform active:scale-95"
          >
            Cadastrar Exemplo de Treino
          </button>
        </form>

        <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 grid grid-cols-1 gap-3">
          {(!trainingData.qaExamples || trainingData.qaExamples.length === 0) && (
            <div className="text-xs text-gray-400 italic text-center py-8">
              Nenhum exemplo Q&A cadastrado.
            </div>
          )}
          {trainingData.qaExamples.map((qa, idx) => (
            <div
              key={idx}
              className="bg-gray-50/50 p-3.5 rounded-xl border border-gray-200/60
                flex flex-col gap-2 relative"
            >
              <div className="flex justify-between items-center border-b border-gray-200 pb-1.5">
                <span className="px-2 py-0.5 rounded-full text-[8px] font-extrabold uppercase
                  bg-indigo-100 text-indigo-700 tracking-wide border border-indigo-250">
                  🏷️ {qa.intent}
                </span>
                <button
                  onClick={() => {
                    const updated = [...trainingData.qaExamples];
                    updated.splice(idx, 1);
                    updateTrainingQas(updated);
                  }}
                  className="text-[9px] font-bold text-red-400 hover:text-red-600 uppercase tracking-wider"
                >
                  Excluir
                </button>
              </div>
              <div className="space-y-1 text-xs text-gray-700">
                <p>
                  <b>❓ Pergunta:</b>{' '}
                  <span className="italic">"{qa.question}"</span>
                </p>
                <div className="bg-white p-2.5 rounded-lg text-[11px] text-gray-600
                  border border-gray-150 mt-1 leading-normal">
                  <b>💡 Resposta Alvo:</b>
                  <br />
                  <span className="whitespace-pre-wrap">{qa.answer}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}