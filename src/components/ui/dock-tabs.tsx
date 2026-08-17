'use client';

import React, { useState } from 'react';
import { Home, Mail, Calendar, Camera, Music, Settings, FileText, MessageCircle, Globe, Folder } from 'lucide-react';

export interface DockItem {
  id: string;
  name: string;
  icon: React.ReactNode;
  color?: string;
  onClick?: () => void;
}

const defaultDockItems: DockItem[] = [
  { id: 'finder', name: 'Finder', icon: <Folder className="w-5 h-5" />, color: 'bg-blue-500' },
  { id: 'home', name: 'Home', icon: <Home className="w-5 h-5" />, color: 'bg-gray-600' },
  { id: 'mail', name: 'Mail', icon: <Mail className="w-5 h-5" />, color: 'bg-blue-600' },
  { id: 'calendar', name: 'Calendar', icon: <Calendar className="w-5 h-5" />, color: 'bg-red-500' },
  { id: 'camera', name: 'Camera', icon: <Camera className="w-5 h-5" />, color: 'bg-gray-800' },
  { id: 'music', name: 'Music', icon: <Music className="w-5 h-5" />, color: 'bg-gradient-to-br from-pink-500 to-purple-600' },
  { id: 'messages', name: 'Messages', icon: <MessageCircle className="w-5 h-5" />, color: 'bg-green-500' },
  { id: 'safari', name: 'Safari', icon: <Globe className="w-5 h-5" />, color: 'bg-blue-400' },
  { id: 'notes', name: 'Notes', icon: <FileText className="w-5 h-5" />, color: 'bg-yellow-400' },
  { id: 'settings', name: 'Settings', icon: <Settings className="w-5 h-5" />, color: 'bg-gray-500' },
];

function DockIcon({
  item,
  orientation = 'horizontal',
  isActive = false
}: {
  item: DockItem;
  orientation?: 'horizontal' | 'vertical';
  isActive?: boolean;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [isClicked, setIsClicked] = useState(false);

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onMouseDown={() => setIsClicked(true)}
      onMouseUp={() => setIsClicked(false)}
      onClick={item.onClick}
      className={`relative flex items-center justify-center cursor-pointer select-none group transition-all duration-300 ease-out origin-center
        ${orientation === 'vertical' ? 'w-[42px] h-[42px] hover:w-[54px] hover:h-[54px]' : 'w-[42px] h-[42px] hover:w-[54px] hover:h-[54px]'}
        ${isClicked ? 'scale-95' : ''}
      `}
    >
      <div
        className={`w-full h-full rounded-2xl shadow-md flex items-center justify-center text-white relative overflow-hidden transition-all duration-300 ease-out ${
          item.color || (isActive ? 'bg-[#0A84FF]' : 'bg-white/10 hover:bg-white/20')
        } ${isHovered && orientation === 'vertical' ? 'translate-x-1' : ''} ${isHovered && orientation === 'horizontal' ? '-translate-y-1' : ''}`}
      >
        <div className={`text-lg flex items-center justify-center transition-transform duration-300 ${isHovered ? 'scale-110' : 'scale-100'}`}>
          {item.icon}
        </div>

        {/* Shine effect */}
        <div
          className={`absolute inset-0 bg-gradient-to-br from-white/25 via-transparent to-black/20 rounded-2xl pointer-events-none transition-opacity duration-300 ${isHovered ? 'opacity-40' : 'opacity-15'}`}
        />
      </div>

      {/* Tooltip */}
      <div
        className={`absolute z-50 bg-zinc-900/95 border border-white/20 text-white text-xs px-3 py-1.5 rounded-xl whitespace-nowrap pointer-events-none backdrop-blur-2xl shadow-2xl font-semibold tracking-wide transition-all duration-300 ${
          isHovered ? 'opacity-100 scale-100' : 'opacity-0 scale-90'
        } ${
          orientation === 'vertical' 
            ? 'left-full ml-3 top-1/2 -translate-y-1/2' 
            : '-top-12 left-1/2 -translate-x-1/2'
        }`}
      >
        {item.name}
      </div>

      {/* Active Indicator Dot */}
      {isActive && (
        <div
          className={`absolute bg-white rounded-full transition-transform duration-300 ${
            orientation === 'vertical' ? '-left-1 top-1/2 -translate-y-1/2 w-1.5 h-2' : '-bottom-1.5 left-1/2 -translate-x-1/2 w-2 h-1.5'
          } ${isClicked ? 'scale-125' : 'scale-100'}`}
        />
      )}
    </div>
  );
}

export function DockTabs({
  items = defaultDockItems,
  orientation = 'horizontal',
  activeId
}: {
  items?: DockItem[];
  orientation?: 'horizontal' | 'vertical';
  activeId?: string;
}) {
  if (orientation === 'vertical') {
    return (
      <div className="flex flex-col items-center justify-center w-full select-none py-1">
        <div
          className="flex flex-col items-center gap-2.5 py-2 px-1.5 rounded-3xl bg-zinc-900/40 backdrop-blur-xl border border-white/10 shadow-xl overflow-visible animate-in fade-in duration-300"
        >
          {items.map((item) => (
            <DockIcon
              key={item.id}
              item={item}
              orientation="vertical"
              isActive={activeId === item.id}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center p-4 select-none">
      <div
        className="mx-auto flex h-16 items-center gap-3 rounded-3xl bg-zinc-900/40 backdrop-blur-xl px-4 py-2 border border-white/10 shadow-xl overflow-visible animate-in fade-in slide-in-from-bottom-4 duration-300"
      >
        {items.map((item) => (
          <DockIcon
            key={item.id}
            item={item}
            orientation="horizontal"
            isActive={activeId === item.id}
          />
        ))}
      </div>
    </div>
  );
}
