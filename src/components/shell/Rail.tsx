'use client';

import {
  Building2,
  CreditCard,
  DollarSign,
  LayoutDashboard,
  MessageSquare,
  Package,
  Plug,
  ShoppingBag,
  Users,
} from 'lucide-react';

/** Os nove destinos do produto. São exatamente os mesmos de antes do Ticket 01. */
export type TabType =
  | 'dashboard'
  | 'sales'
  | 'inventory'
  | 'contacts'
  | 'finance'
  | 'sac'
  | 'organization'
  | 'integrations'
  | 'billing';

interface UserSession {
  email: string;
  name: string;
}

interface RailProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  session: UserSession | null;
  onLogout: () => void;
}

const DESTINOS: ReadonlyArray<{ id: TabType; label: string; Icone: typeof LayoutDashboard }> = [
  { id: 'dashboard', label: 'Visão Geral', Icone: LayoutDashboard },
  { id: 'sales', label: 'Vendas & Pedidos', Icone: ShoppingBag },
  { id: 'inventory', label: 'Estoque & Produtos', Icone: Package },
  { id: 'contacts', label: 'Clientes & Contatos', Icone: Users },
  { id: 'finance', label: 'Controle Financeiro', Icone: DollarSign },
  { id: 'sac', label: 'SAC / Atendimento', Icone: MessageSquare },
  { id: 'organization', label: 'Organização & Membros', Icone: Building2 },
  { id: 'integrations', label: 'Integrações (Bling / Chatwoot)', Icone: Plug },
  { id: 'billing', label: 'Plano & Faturamento', Icone: CreditCard },
];

function OrbitaLogoIcon({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 110.88 117.1" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <polygon fill="#0A84FF" points="42.72 22.97 51.52 3.89 58.66 3.96 68.16 23.01 67.59 71.89 65.58 87.31 45.1 86.91 43.34 71.93 42.72 22.97"/>
      <path fill="#5E5CE6" d="M43.94,29.68c-1.53,1.37-2.38,3.99-2.56,6.12-16.87,2.74-29.08,14.06-41.38,28.71C4.08,44.03,22.32,28.02,42.72,22.97c2.1,1.36,1.18,5.16,1.22,6.71Z"/>
      <path fill="#30D158" d="M91.36,79.64c.5,9.17,4.32,17.39-5.85,23.99-4.76-3.4-7.18-8.74-6.35-14.49l1.4-9.59c3.48.3,7.29-.45,10.8.08Z"/>
      <path fill="#30D158" d="M30.35,79.59c.25,9.54,4.92,16.53-5.91,24.22-9.3-8.77-6.34-13.94-4.85-24.25,3.47-.28,7.34.05,10.76.04Z"/>
      <path fill="#FF9F0A" d="M30.35,79.59c-3.42.01-7.29-.31-10.76-.04-2.25-.75-3.44-3.12-2.83-6.06,1.05-5.06,5.57-8.87,10.6-10.32,13.17-3.79,13.05-15.72,14.02-27.39-.18-2.12,1.03-4.75,2.56-6.12.24,9.02.73,26.93,0,37.53-.21,2.99-1.5,5.43.82,8.44-5.07,2.62-11.51-1.76-14.4,3.95Z"/>
      <path fill="#64D2FF" d="M61.34,18.44c-4.65.58-8.36.45-12.43.03-.27-5.3,3.09-8.84,6.26-12.26,3.65,4.04,6.53,7.2,6.17,12.22Z"/>
    </svg>
  );
}

/**
 * A navegação do Orbita — e a **única** que existe.
 *
 * Antes do Ticket 01 havia duas: um dock vertical de nove ícones e, logo abaixo
 * do topo, uma segunda barra horizontal com os mesmos nove destinos. Dois
 * controles para o mesmo lugar não é estilo, é a interface não sabendo dizer
 * onde a pessoa está.
 *
 * O item ativo é a única cápsula lime da tela. Ênfase só existe se for escassa.
 */
export function Rail({ activeTab, setActiveTab, session, onLogout }: RailProps) {
  const iniciais = session?.name ? session.name.substring(0, 2).toUpperCase() : 'US';

  return (
    <nav
      aria-label="Navegação principal"
      className="flex flex-col items-center justify-between shrink-0 py-5"
      style={{ width: 'var(--rail-width)', borderRight: '1px solid var(--line)' }}
    >
      <div className="relative" title="Órbita">
        <OrbitaLogoIcon className="h-9 w-9" />
        <span
          className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full"
          style={{ background: 'var(--accent)' }}
        />
      </div>

      <ul className="flex flex-col items-center gap-2 my-auto list-none p-0">
        {DESTINOS.map(({ id, label, Icone }) => (
          <li key={id} className="group relative flex items-center">
            <button
              type="button"
              onClick={() => setActiveTab(id)}
              aria-current={activeTab === id ? 'page' : undefined}
              aria-label={label}
              className="orbita-rail-item"
            >
              <Icone className="w-5 h-5" strokeWidth={1.75} />
            </button>
            <span
              role="tooltip"
              className="pointer-events-none absolute left-full ml-3 z-50 hidden whitespace-nowrap rounded-xl px-3 py-2 text-xs font-semibold group-hover:block"
              style={{ background: 'var(--modal)', border: '1px solid var(--line)', color: 'var(--txt)' }}
            >
              {label}
            </span>
          </li>
        ))}
      </ul>

      {session && (
        <div className="group relative flex items-center">
          <button
            type="button"
            onClick={onLogout}
            aria-label="Sair da conta"
            className="w-9 h-9 rounded-2xl flex items-center justify-center text-[11px] font-bold cursor-pointer transition-colors"
            style={{ background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt)' }}
          >
            {iniciais}
          </button>
          <span
            role="tooltip"
            className="pointer-events-none absolute left-full ml-3 z-50 hidden whitespace-nowrap rounded-xl px-3 py-2 group-hover:flex flex-col gap-0.5"
            style={{ background: 'var(--modal)', border: '1px solid var(--line)' }}
          >
            <span className="text-xs font-bold" style={{ color: 'var(--txt)' }}>
              {session.name || session.email}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--txt3)' }}>
              Clique para sair da conta
            </span>
          </span>
        </div>
      )}
    </nav>
  );
}
