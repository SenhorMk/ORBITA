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

/**
 * Destinos que o rail não apresenta.
 *
 * `billing` sai da navegação **apresentada**, e só dela: o `TabType` continua
 * existindo, o painel continua montado em `page.tsx`, e Stripe, assinatura e
 * entitlement seguem exatamente como estão. Ninguém perde autorização por esta
 * linha — o que se perde é um ícone que a apresentação não vai abrir, e um
 * destino que ninguém abre é ruído no único lugar da tela onde a ênfase
 * precisa ser escassa.
 *
 * Para trazê-lo de volta, tire-o daqui. Nada mais precisa mudar.
 */
const DESTINOS_NAO_APRESENTADOS: ReadonlySet<TabType> = new Set<TabType>(['billing']);

const DESTINOS_VISIVEIS = DESTINOS.filter((destino) => !DESTINOS_NAO_APRESENTADOS.has(destino.id));

/**
 * A navegação do Orbita — e a **única** que existe.
 *
 * Antes do Ticket 01 havia duas: um dock vertical de nove ícones e, logo abaixo
 * do topo, uma segunda barra horizontal com os mesmos nove destinos. Dois
 * controles para o mesmo lugar não é estilo, é a interface não sabendo dizer
 * onde a pessoa está.
 *
 * O item ativo é a única cápsula lime da tela. Ênfase só existe se for escassa.
 *
 * A composição é a de `Orbita Vendas.dc.html`: logo, o grupo de destinos dentro
 * de uma superfície própria, o espaço flexível, e o usuário no rodapé. O
 * contêiner em volta do grupo não é enfeite — é ele que faz os nove ícones
 * lerem como uma navegação, e não como nove coisas soltas na borda.
 */
export function Rail({ activeTab, setActiveTab, session, onLogout }: RailProps) {
  const iniciais = session?.name ? session.name.substring(0, 2).toUpperCase() : 'US';

  return (
    <nav
      aria-label="Navegação principal"
      className="flex flex-col items-center shrink-0"
      style={{ width: 'var(--rail-width)', padding: 'var(--rail-pad-y) 0', gap: 'var(--rail-pad-y)' }}
    >
      {/* O mesmo asset que o protótipo usa. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/icon.svg"
        alt="Órbita"
        className="block shrink-0"
        style={{ width: 'var(--rail-logo)', height: 'var(--rail-logo)' }}
      />

      <ul
        className="flex flex-col list-none m-0"
        style={{
          gap: 6,
          padding: '8px 7px',
          borderRadius: 26,
          background: 'var(--chip)',
          border: '1px solid var(--line)',
        }}
      >
        {DESTINOS_VISIVEIS.map(({ id, label, Icone }) => (
          <li key={id} className="group relative flex items-center">
            <button
              type="button"
              onClick={() => setActiveTab(id)}
              aria-current={activeTab === id ? 'page' : undefined}
              aria-label={label}
              className="orbita-rail-item"
            >
              <Icone className="w-[21px] h-[21px]" strokeWidth={1.75} />
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

      <div className="flex-1" />

      {session && (
        <div className="group relative flex items-center">
          <button
            type="button"
            onClick={onLogout}
            aria-label="Sair da conta"
            className="w-10 h-10 rounded-full flex items-center justify-center cursor-pointer"
            style={{
              background: 'var(--chip)',
              border: '1px solid var(--line)',
              color: 'var(--txt)',
              font: '600 13px/1 var(--font-jetbrains-mono), monospace',
            }}
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
