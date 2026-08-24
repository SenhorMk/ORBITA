'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/');
  }, [router]);

  return (
    <div className="min-h-screen bg-[#0d0818] flex items-center justify-center text-slate-300">
      <div className="flex items-center gap-3">
        <div className="h-5 w-5 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
        <span className="text-sm font-medium">Redirecionando para autenticação...</span>
      </div>
    </div>
  );
}
