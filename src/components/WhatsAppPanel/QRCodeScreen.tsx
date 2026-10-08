/**
 * @fileoverview QR Code connection screen with auto-retry and error handling.
 */
import { QrCode, RefreshCw, ShieldCheck, Download, AlertTriangle } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useRef, useEffect, useState } from 'react';

interface QRCodeScreenProps {
  qrCodeData: string | null;
  statusMessage: string;
  onRestart: () => void;
}

export function QRCodeScreen({ qrCodeData, statusMessage, onRestart }: QRCodeScreenProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [showError, setShowError] = useState(false);

  // Auto-retry if QR not received within 15 seconds
  useEffect(() => {
    if (qrCodeData || statusMessage.includes('Conectado')) return;

    const timer = setInterval(() => {
      setRetryCount((prev) => {
        if (prev >= 3) {
          setShowError(true);
          clearInterval(timer);
          return prev;
        }
        return prev + 1;
      });
    }, 15000);

    return () => clearInterval(timer);
  }, [qrCodeData, statusMessage]);

  // Reset error/retry state when a QR arrives (React-documented pattern:
  // adjust state during render guarded by a previous-value state)
  const [prevQr, setPrevQr] = useState(qrCodeData);
  if (prevQr !== qrCodeData) {
    setPrevQr(qrCodeData);
    if (qrCodeData) {
      setShowError(false);
      setRetryCount(0);
    }
  }

  const handleDownload = () => {
    if (!svgRef.current || !qrCodeData) return;
    const svgData = new XMLSerializer().serializeToString(svgRef.current);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
      canvas.width = 400;
      canvas.height = 400;
      ctx?.drawImage(img, 0, 0, 400, 400);
      const pngUrl = canvas.toDataURL('image/png');
      const downloadLink = document.createElement('a');
      downloadLink.href = pngUrl;
      downloadLink.download = `qr-athina-${Date.now()}.png`;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const handleForceRestart = () => {
    setShowError(false);
    setRetryCount(0);
    onRestart();
  };

  return (
    <div className="flex-1 flex flex-col bg-gray-50 items-center justify-center p-8 text-center">
      <div className="w-full max-w-md bg-white p-8 rounded-3xl shadow-xl border
        border-gray-100 flex flex-col items-center gap-6">
        
        {/* Icon */}
        <div className="p-4 bg-emerald-50 rounded-full text-emerald-500 animate-pulse">
          <QrCode size={48} />
        </div>

        {/* Title */}
        <div className="space-y-2">
          <h2 className="text-xl font-bold text-gray-800">Conectar Nuovopay Bot</h2>
          <p className="text-sm text-gray-500 max-w-xs mx-auto">
            Leia o código abaixo com o WhatsApp do seu telemóvel para iniciar a Agente Athina.
          </p>
        </div>

        {/* QR Code Area */}
        <div className="w-[420px] h-[420px] border-4 border-emerald-50 rounded-3xl
          flex items-center justify-center p-6 bg-white shadow-inner relative">
          
          {qrCodeData ? (
            <>
              <QRCodeSVG
                ref={svgRef}
                value={qrCodeData}
                size={400}
                includeMargin={false}
                level="H"
              />
              {/* Retry indicator */}
              {retryCount > 0 && (
                <div className="absolute top-2 right-2 bg-amber-100 text-amber-700 
                  px-2 py-1 rounded-lg text-[10px] font-bold">
                  Tentativa {retryCount}/3
                </div>
              )}
            </>
          ) : showError ? (
            /* Error State */
            <div className="flex flex-col items-center gap-4 p-6 text-center">
              <AlertTriangle className="text-red-400" size={48} />
              <div className="space-y-2">
                <h3 className="font-bold text-red-600">QR Code não recebido</h3>
                <p className="text-xs text-gray-500">
                  O servidor não conseguiu gerar o QR Code. Isso pode ocorrer devido a:
                </p>
                <ul className="text-[11px] text-gray-400 text-left list-disc pl-4 space-y-1">
                  <li>Sessão WhatsApp corrompida</li>
                  <li>Puppeteer/Chromium não iniciou</li>
                  <li>Conexão de rede instável</li>
                </ul>
              </div>
              <button
                onClick={handleForceRestart}
                className="flex items-center justify-center gap-2 px-6 py-3 
                  bg-red-500 hover:bg-red-600 text-white rounded-2xl 
                  font-semibold text-sm transition-all active:scale-[0.98]"
              >
                <RefreshCw size={16} />
                Limpar Sessão e Tentar Novamente
              </button>
            </div>
          ) : (
            /* Loading State */
            <div className="flex flex-col items-center gap-3 p-4 text-center">
              <RefreshCw className="animate-spin text-emerald-500 shrink-0" size={32} />
              <span className="text-xs text-gray-400 font-medium italic
                break-words max-w-[200px]">
                {statusMessage || 'A inicializar WhatsApp...'}
              </span>
              {/* Progress dots */}
              <div className="flex gap-1.5 mt-2">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="w-2 h-2 bg-emerald-300 rounded-full animate-bounce"
                    style={{ animationDelay: `${i * 0.15}s` }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-4 w-full mt-2">
          <div className="flex gap-2 items-center justify-center text-[11px]
            text-gray-400 font-medium">
            <ShieldCheck size={14} className="text-emerald-500" />
            Conexão encriptada e segura
          </div>
          
          <div className="flex flex-col gap-2 w-full">
            <button
              onClick={handleForceRestart}
              className="flex items-center justify-center gap-2 w-full py-3 px-4
                bg-gray-100 hover:bg-gray-200 hover:text-gray-900 text-gray-600
                rounded-2xl font-semibold text-sm transition-all active:scale-[0.98]"
            >
              <RefreshCw size={16} />
              Forçar Reinicialização (Limpar Cache)
            </button>
            
            {qrCodeData && (
              <button
                onClick={handleDownload}
                className="flex items-center justify-center gap-2 w-full py-2 px-4
                  bg-emerald-50 hover:bg-emerald-100 text-emerald-700
                  rounded-2xl font-semibold text-sm transition-all active:scale-[0.98]"
              >
                <Download size={16} />
                Baixar QR Code (PNG 400x400)
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
