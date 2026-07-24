"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface AdminDrawerProps {
  open: boolean;
  title: string;
  eyebrow?: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  widthClassName?: string;
  closeLabel?: string;
}

const openDrawerRoots: HTMLDivElement[] = [];

export function AdminDrawer({ open, title, eyebrow, description, onClose, children, footer, widthClassName = "max-w-[620px]", closeLabel = "关闭详情抽屉" }: AdminDrawerProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = document.createElement("div");
    root.dataset.adminDrawerRoot = "true";
    document.body.appendChild(root);
    setPortalRoot(root);
    return () => root.remove();
  }, []);

  useEffect(() => {
    if (!open || !portalRoot) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const ownRootState = {
      inert: portalRoot.hasAttribute("inert"),
      ariaHidden: portalRoot.getAttribute("aria-hidden"),
    };
    const backgroundElements = Array.from(document.body.children).filter((element) => element !== portalRoot);
    const backgroundState = backgroundElements.map((element) => ({
      element,
      inert: element.hasAttribute("inert"),
      ariaHidden: element.getAttribute("aria-hidden"),
    }));

    document.body.style.overflow = "hidden";
    portalRoot.removeAttribute("inert");
    portalRoot.removeAttribute("aria-hidden");
    backgroundElements.forEach((element) => {
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
    });
    openDrawerRoots.push(portalRoot);

    const focusFirst = () => panelRef.current?.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (openDrawerRoots.at(-1) !== portalRoot) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    requestAnimationFrame(focusFirst);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const stackIndex = openDrawerRoots.lastIndexOf(portalRoot);
      if (stackIndex >= 0) openDrawerRoots.splice(stackIndex, 1);
      document.body.style.overflow = previousOverflow;
      backgroundState.forEach(({ element, inert, ariaHidden }) => {
        if (!inert) element.removeAttribute("inert");
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      });
      if (ownRootState.inert) portalRoot.setAttribute("inert", "");
      else portalRoot.removeAttribute("inert");
      if (ownRootState.ariaHidden === null) portalRoot.removeAttribute("aria-hidden");
      else portalRoot.setAttribute("aria-hidden", ownRootState.ariaHidden);
      previousFocus?.focus?.();
    };
  }, [onClose, open, portalRoot]);

  if (!open || !portalRoot) return null;
  return createPortal(
    <div className="admin-console-shell fixed inset-0 z-[80] flex justify-end">
      <button type="button" aria-label={closeLabel} onClick={onClose} className="absolute inset-0 bg-[#1a0d07]/40 backdrop-blur-sm" />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} className={`retro-panel-strong relative flex h-dvh w-full flex-col overflow-hidden rounded-none border-y-0 border-r-0 shadow-[-24px_0_80px_rgba(38,16,4,0.22)] outline-none ${widthClassName}`}>
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-black/8 px-4 py-4 dark:border-white/10 sm:px-6">
          <div className="min-w-0">
            {eyebrow && <p className="retro-kicker">{eyebrow}</p>}
            <h2 id={titleId} className="mt-1 truncate text-xl font-bold retro-text">{title}</h2>
            {description && <p id={descriptionId} className="mt-1 type-caption retro-muted">{description}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label={closeLabel} className="retro-close-button"><X className="h-4 w-4" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">{children}</div>
        {footer && <footer className="shrink-0 border-t border-black/8 bg-white/75 px-4 py-3 backdrop-blur-xl dark:border-white/10 dark:bg-[#130b22]/85 sm:px-6">{footer}</footer>}
      </div>
    </div>,
    portalRoot,
  );
}
