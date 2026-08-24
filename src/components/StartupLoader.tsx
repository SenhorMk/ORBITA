import { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from './ui/button';

interface StartupLoaderProps {
  onComplete: () => void;
  onNeedsAuth: () => void;
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
  isVisible: boolean;
}

export function StartupLoader({ onComplete, onNeedsAuth, fetchWithAuth, isVisible }: StartupLoaderProps) {
  const [status, setStatus] = useState<'verifying' | 'syncing' | 'success' | 'error' | 'auth_needed'>('verifying');
  const [progressText, setProgressText] = useState('Verificando integridade do Token...');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (!isVisible) return;

    let isMounted = true;

    const runStartupSync = async () => {
      try {
        setStatus('verifying');
        setProgressText('Testando conexão com o servidor Bling...');

        const response = await fetchWithAuth('/api/startup', { method: 'POST' });
        const data = await response.json();

        if (!isMounted) return;

        if (data.needsAuth || response.status === 401) {
          setStatus('auth_needed');
          setProgressText('Token expirado. É necessário reautorizar o aplicativo.');
          return;
        }

        if (data.success) {
          setStatus('success');
          setProgressText('Sincronização concluída com sucesso!');
          setTimeout(() => {
            if (isMounted) onComplete();
          }, 1500);
        } else {
          setStatus('error');
          setErrorMessage(data.error || 'Falha ao sincronizar com o Bling.');
        }
      } catch (err: unknown) {
        if (!isMounted) return;
        setStatus('error');
        setErrorMessage(err instanceof Error ? err.message : 'Erro de rede ou servidor.');
      }
    };

    runStartupSync();

    return () => {
      isMounted = false;
    };
  }, [isVisible, fetchWithAuth, onComplete]);

  if (!isVisible) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md"
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          className="w-full max-w-md p-8 rounded-3xl glass-panel border border-white/20 shadow-2xl flex flex-col items-center justify-center text-center space-y-6"
        >
          <div className="relative">
            {status === 'verifying' || status === 'syncing' ? (
              <div className="relative flex items-center justify-center w-24 h-24">
                <div className="absolute inset-0 border-t-2 border-r-2 border-emerald-400 rounded-full animate-spin" />
                <div className="absolute inset-2 border-b-2 border-l-2 border-cyan-400 rounded-full animate-spin animation-delay-150" />
                <RefreshCw className="w-8 h-8 text-white animate-pulse" />
              </div>
            ) : status === 'success' ? (
              <div className="w-24 h-24 rounded-full bg-emerald-500/20 flex items-center justify-center">
                <CheckCircle2 className="w-12 h-12 text-emerald-400" />
              </div>
            ) : (
              <div className="w-24 h-24 rounded-full bg-rose-500/20 flex items-center justify-center">
                <AlertTriangle className="w-12 h-12 text-rose-400" />
              </div>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-xl font-bold text-white tracking-tight">
              {status === 'verifying' && 'Inicializando Órbita'}
              {status === 'syncing' && 'Sincronizando ERP'}
              {status === 'success' && 'Tudo Pronto'}
              {status === 'auth_needed' && 'Reautenticação Necessária'}
              {status === 'error' && 'Erro na Inicialização'}
            </h3>
            <p className="text-sm text-slate-300 max-w-[280px] mx-auto leading-relaxed">
              {progressText}
            </p>
            {errorMessage && (
              <p className="text-xs text-rose-300 mt-2 bg-rose-500/10 p-2 rounded-lg border border-rose-500/20">
                {errorMessage}
              </p>
            )}
          </div>

          {(status === 'error' || status === 'auth_needed') && (
            <div className="pt-4 w-full flex gap-3">
              <Button
                variant="outline"
                className="flex-1 bg-white/5 border-white/10 hover:bg-white/10"
                onClick={() => onComplete()}
              >
                Ignorar (Modo Offline)
              </Button>
              {status === 'auth_needed' && (
                <Button
                  className="flex-1 glass-button-primary"
                  onClick={() => {
                    onNeedsAuth();
                  }}
                >
                  Conectar Bling
                </Button>
              )}
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
