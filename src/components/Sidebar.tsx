'use client';

import { useState } from "react";
import {
  LayoutDashboard,
  ShoppingBag,
  Package,
  Users,
  MessageSquare,
  Menu,
  X,
  DollarSign,
  Building2,
  Plug,
  CreditCard,
} from "lucide-react";
import { DockTabs, DockItem } from '@/components/ui/dock-tabs';

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
  role: 'dono' | 'colaborador';
  name: string;
}

interface SidebarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  session: UserSession | null;
  onLogout: () => void;
  badges?: {
    sales?: number;
    chats?: number;
  };
}

function OrbitaLogoIcon({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 110.88 117.1" fill="none" xmlns="http://www.w3.org/2000/svg">
      <polygon fill="#0A84FF" points="42.72 22.97 51.52 3.89 58.66 3.96 68.16 23.01 67.59 71.89 65.58 87.31 45.1 86.91 43.34 71.93 42.72 22.97"/>
      <path fill="#5E5CE6" d="M43.94,29.68c-1.53,1.37-2.38,3.99-2.56,6.12-16.87,2.74-29.08,14.06-41.38,28.71C4.08,44.03,22.32,28.02,42.72,22.97c2.1,1.36,1.18,5.16,1.22,6.71Z"/>
      <path fill="#30D158" d="M91.36,79.64c.5,9.17,4.32,17.39-5.85,23.99-4.76-3.4-7.18-8.74-6.35-14.49l1.4-9.59c3.48.3,7.29-.45,10.8.08Z"/>
      <path fill="#30D158" d="M30.35,79.59c.25,9.54,4.92,16.53-5.91,24.22-9.3-8.77-6.34-13.94-4.85-24.25,3.47-.28,7.34.05,10.76.04Z"/>
      <path fill="#FF9F0A" d="M30.35,79.59c-3.42.01-7.29-.31-10.76-.04-2.25-.75-3.44-3.12-2.83-6.06,1.05-5.06,5.57-8.87,10.6-10.32,13.17-3.79,13.05-15.72,14.02-27.39-.18-2.12,1.03-4.75,2.56-6.12.24,9.02.73,26.93,0,37.53-.21,2.99-1.5,5.43.82,8.44-5.07,2.62-11.51-1.76-14.4,3.95Z"/>
      <path fill="#64D2FF" d="M61.34,18.44c-4.65.58-8.36.45-12.43.03-.27-5.3,3.09-8.84,6.26-12.26,3.65,4.04,6.53,7.2,6.17,12.22Z"/>
    </svg>
  );
}

export function Sidebar({
  activeTab,
  setActiveTab,
  session,
  onLogout
}: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [hoveredFooterItem, setHoveredFooterItem] = useState<string | null>(null);


  const menuItems = [
    {
      id: 'dashboard' as TabType,
      label: 'Visão Geral',
      icon: LayoutDashboard,
      color: 'bg-zinc-800 hover:bg-[#0A84FF]'
    },
    {
      id: 'sales' as TabType,
      label: 'Vendas & Bling ERP',
      icon: ShoppingBag,
      color: 'bg-zinc-800 hover:bg-[#30D158]'
    },
    {
      id: 'inventory' as TabType,
      label: 'Estoque & Produtos',
      icon: Package,
      color: 'bg-zinc-800 hover:bg-[#FF9F0A]'
    },
    {
      id: 'contacts' as TabType,
      label: 'Clientes & Contatos',
      icon: Users,
      color: 'bg-zinc-800 hover:bg-[#5E5CE6]'
    },
    {
      id: 'finance' as TabType,
      label: 'Controle Financeiro',
      icon: DollarSign,
      color: 'bg-zinc-800 hover:bg-[#FFD60A]'
    },
    {
      id: 'sac' as TabType,
      label: 'SAC / Atendimento',
      icon: MessageSquare,
      color: 'bg-zinc-800 hover:bg-[#64D2FF]'
    },
    {
      id: 'organization' as TabType,
      label: 'Organização & Membros',
      icon: Building2,
      color: 'bg-zinc-800 hover:bg-[#0A84FF]'
    },
    {
      id: 'integrations' as TabType,
      label: 'Integrações (Bling / Chatwoot)',
      icon: Plug,
      color: 'bg-zinc-800 hover:bg-[#30D158]'
    },
    {
      id: 'billing' as TabType,
      label: 'Plano & Faturamento',
      icon: CreditCard,
      color: 'bg-zinc-800 hover:bg-[#FFD60A]'
    },
  ];

  // Convert menu items into DockItems for the macOS vertical Dock
  const dockItems: DockItem[] = menuItems.map((item) => {
    const Icon = item.icon;
    return {
      id: item.id,
      name: item.label,
      icon: <Icon className="w-5 h-5 text-white" />,
      color: item.color,
      onClick: () => {
        setActiveTab(item.id);
        setMobileOpen(false);
      }
    };
  });

  const sidebarContent = (
    <div className="flex flex-col h-full justify-between items-center select-none py-3 px-2 overflow-visible">
      {/* Top Header Logo */}
      <div className="flex flex-col items-center gap-2">
        <div className="relative group cursor-pointer" title="ÓRBITA Painel de Controle">
          <OrbitaLogoIcon className="h-9 w-9 group-hover:scale-110 transition-transform duration-200" />
          <div className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-[#30D158]" />
        </div>
      </div>

      {/* Navigation Mode: macOS Vertical Animated Dock */}
      <div className="my-auto flex flex-col items-center justify-center overflow-visible">
        <DockTabs
          items={dockItems}
          orientation="vertical"
          activeId={activeTab}
        />
      </div>

      {/* Footer / User Profile & Setup Actions */}
      <div className="flex flex-col items-center gap-3 pt-2 border-t border-white/10 w-full relative overflow-visible">
        {/* User Profile Avatar & Logout */}
        {session && (
          <div className="relative group flex items-center justify-center">
            <button
              onClick={onLogout}
              onMouseEnter={() => setHoveredFooterItem('user')}
              onMouseLeave={() => setHoveredFooterItem(null)}
              className="w-9 h-9 rounded-2xl bg-zinc-700 hover:bg-red-500/80 border border-white/15 flex items-center justify-center font-extrabold text-xs text-white shadow-md transition-all group-hover:scale-105"
            >
              {session.name ? session.name.substring(0, 2).toUpperCase() : 'US'}
            </button>

            {hoveredFooterItem === 'user' && (
              <div className="absolute z-50 left-full ml-3 top-1/2 -translate-y-1/2 bg-zinc-900/95 border border-white/20 text-white text-xs px-3 py-2 rounded-xl whitespace-nowrap backdrop-blur-2xl shadow-2xl font-semibold tracking-wide flex flex-col gap-0.5 animate-in fade-in duration-150">
                <span className="text-white font-bold">{session.name || session.email}</span>
                <span className="text-[10px] text-slate-400 font-normal">Clique para sair da conta</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile Menu Button */}
      <div className="md:hidden fixed top-3 left-3 z-50">
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className="p-2.5 rounded-xl glass-panel text-slate-200 hover:text-white border border-white/15 shadow-xl"
        >
          {mobileOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </button>
      </div>

      {/* Desktop Fixed Compact Vertical Dock Sidebar */}
      <aside className="hidden md:block sticky top-0 h-screen z-40 p-3 w-20 overflow-visible">
        <div className="h-full rounded-3xl glass-panel border border-white/10 overflow-visible shadow-2xl">
          {sidebarContent}
        </div>
      </aside>

      {/* Mobile Drawer Overlay */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <button
            type="button"
            aria-label="Fechar menu"
            className="fixed inset-0 bg-black/80 backdrop-blur-md transition-opacity cursor-default"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative w-20 h-full glass-panel border-r border-white/15 z-50 p-2 overflow-visible">
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
}
