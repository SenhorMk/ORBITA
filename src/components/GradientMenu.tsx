'use client';

import React from 'react';

export interface GradientMenuItem {
  id: string;
  label: string;
  count?: number;
  icon?: React.ElementType;
}

interface GradientMenuProps {
  items: GradientMenuItem[];
  activeId: string;
  onChange: (id: string) => void;
  size?: 'sm' | 'md' | 'lg';
}

export function GradientMenu({
  items,
  activeId,
  onChange,
  size = 'md'
}: GradientMenuProps) {
  const paddingClasses = {
    sm: 'px-2.5 py-1 text-xs',
    md: 'px-3.5 py-1.5 text-xs',
    lg: 'px-4 py-2 text-sm'
  }[size];

  return (
    <div className="inline-flex p-1 rounded-xl bg-zinc-900/80 backdrop-blur-xl border border-white/10 shadow-sm relative gap-1 select-none">
      {items.map((item) => {
        const isActive = activeId === item.id;
        const Icon = item.icon;

        return (
          <button
            key={item.id}
            onClick={() => onChange(item.id)}
            className={`relative flex items-center gap-2 font-medium rounded-lg transition-all duration-200 ${paddingClasses} ${
              isActive
                ? 'bg-gradient-to-r from-[#5e1dad] to-[#42a0ed] text-white font-semibold shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
            }`}
          >
            {Icon && (
              <Icon
                className={`w-3.5 h-3.5 transition-transform ${
                  isActive ? 'text-white' : 'text-slate-400'
                }`}
              />
            )}

            <span className="relative z-10">{item.label}</span>

            {item.count !== undefined && (
              <span
                className={`relative z-10 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                  isActive
                    ? 'bg-black/20 text-white'
                    : 'bg-zinc-800 text-slate-400 border border-white/5'
                }`}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
