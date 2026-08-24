'use client';

import { useState, useEffect } from "react";

interface SyncTimerProps {
  lastSyncDate: Date | null;
}

export function SyncTimer({ lastSyncDate }: SyncTimerProps) {
  const [syncAgoText, setSyncAgoText] = useState<string>('');

  useEffect(() => {
    const updateSyncAgo = () => {
      if (!lastSyncDate) {
        setSyncAgoText('');
        return;
      }
      const diffMs = Date.now() - lastSyncDate.getTime();
      const diffSecs = Math.floor(diffMs / 1000);
      const diffMins = Math.floor(diffSecs / 60);

      if (diffSecs < 10) {
        setSyncAgoText('Sincronizado agorinha');
      } else if (diffSecs < 60) {
        setSyncAgoText(`Sincronizado há ${diffSecs}s`);
      } else if (diffMins === 1) {
        setSyncAgoText('Sincronizado há 1 min');
      } else {
        setSyncAgoText(`Sincronizado há ${diffMins} mins`);
      }
    };

    updateSyncAgo();
    const interval = setInterval(updateSyncAgo, 10000);
    return () => clearInterval(interval);
  }, [lastSyncDate]);

  return <span className="hidden md:inline font-mono text-[10px] text-slate-500 uppercase tracking-wider">{syncAgoText}</span>;
}
