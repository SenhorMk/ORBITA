'use client';

import React, { useState, useRef, useEffect } from 'react';

export interface DropdownAction {
  id: string;
  label: string;
  icon?: React.ElementType;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export interface DropdownSection {
  title?: string;
  actions: DropdownAction[];
}

interface DropdownMenuProps {
  trigger: React.ReactNode;
  sections: DropdownSection[];
  align?: 'left' | 'right';
}

export function DropdownMenu({ trigger, sections, align = 'right' }: DropdownMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div className="relative inline-block text-left select-none" ref={menuRef}>
      <div onClick={() => setIsOpen(!isOpen)}>{trigger}</div>

      {isOpen && (
        <div
          className={`absolute ${
            align === 'right' ? 'right-0' : 'left-0'
          } mt-2 w-52 rounded-2xl glass-panel border border-white/15 shadow-2xl backdrop-blur-2xl z-50 p-1 space-y-1 animate-in fade-in duration-150`}
        >
          {sections.map((section, sIdx) => (
            <div key={sIdx} className={sIdx > 0 ? 'pt-1 border-t border-white/10' : ''}>
              {section.title && (
                <div className="px-2 py-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  {section.title}
                </div>
              )}
              {section.actions.map((action) => {
                const Icon = action.icon;
                return (
                  <button
                    key={action.id}
                    disabled={action.disabled}
                    onClick={() => {
                      if (!action.disabled) {
                        action.onClick();
                        setIsOpen(false);
                      }
                    }}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 text-xs rounded-xl transition-all duration-150 ${
                      action.disabled
                        ? 'opacity-40 cursor-not-allowed text-slate-500'
                        : action.danger
                        ? 'text-red-400 hover:bg-red-500/20 hover:text-red-200'
                        : 'text-slate-200 hover:bg-[#0A84FF] hover:text-white'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {Icon && (
                        <Icon className="w-3.5 h-3.5" />
                      )}
                      <span className="font-medium">{action.label}</span>
                    </div>

                    {action.shortcut && (
                      <kbd className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-black/40 text-slate-400">
                        {action.shortcut}
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
