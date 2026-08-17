import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface GlassModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  headerActions?: React.ReactNode;
  className?: string; // Override maxWidth or other DialogContent positioning
}

export function GlassModal({
  isOpen,
  onClose,
  title,
  subtitle,
  icon,
  children,
  footer,
  headerActions,
  className,
}: GlassModalProps) {
  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-200" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-[50%] top-[50%] z-50 w-full max-w-4xl translate-x-[-50%] translate-y-[-50%] duration-300 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] focus:outline-none sm:rounded-3xl p-4 sm:p-6",
            className
          )}
        >
          <div className="relative w-full glass-panel border border-white/15 rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
            {/* Header Bar */}
            <div className="p-6 border-b border-white/10 flex items-center justify-between bg-white/[0.02]">
              <div className="flex items-center gap-4 min-w-0">
                {icon && (
                  <div className="h-14 w-14 shrink-0 flex items-center justify-center rounded-2xl border border-blue-500/30 bg-blue-500/10 glow-cyan">
                    {icon}
                  </div>
                )}
                <div className="min-w-0">
                  <DialogPrimitive.Title className="text-xl font-bold text-white truncate max-w-md m-0">
                    {title}
                  </DialogPrimitive.Title>
                  {subtitle && (
                    <DialogPrimitive.Description asChild>
                      <div className="text-xs text-slate-400 font-mono mt-0.5 m-0">
                        {subtitle}
                      </div>
                    </DialogPrimitive.Description>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                {headerActions}
                <DialogPrimitive.Close className="p-2.5 rounded-2xl glass-card text-slate-400 hover:text-white hover:bg-rose-500/20 hover:border-rose-500/30 transition focus:outline-none">
                  <X className="w-5 h-5" />
                </DialogPrimitive.Close>
              </div>
            </div>

            {/* Modal Content Scroll Area */}
            <div className="p-6 overflow-y-auto flex-1 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
              {children}
            </div>

            {/* Footer Bar */}
            {footer && (
              <div className="p-5 border-t border-white/10 bg-white/[0.02] flex items-center justify-between gap-3">
                {footer}
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
