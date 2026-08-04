import {
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { CloseIcon } from "./icons.js";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface MobileOverlayProps {
  open: boolean;
  variant: "drawer" | "sheet";
  title: string;
  testId: string;
  onClose: () => void;
  children: ReactNode;
}

export function MobileOverlay({
  open,
  variant,
  title,
  testId,
  onClose,
  children,
}: MobileOverlayProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const returnTarget = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    const siblings = [...(rootRef.current?.parentElement?.children ?? [])]
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== rootRef.current)
      .map((element) => ({ element, inert: element.inert }));
    for (const { element } of siblings) element.inert = true;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => {
      const focusable = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      (focusable ?? panelRef.current)?.focus({ preventScroll: true });
    });

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || panelRef.current === null) return;
      const controls = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((element) => !element.hasAttribute("hidden"));
      if (controls.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = controls[0];
      const last = controls.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKeyDown);
      for (const { element, inert } of siblings) element.inert = inert;
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => returnTarget?.focus({ preventScroll: true }));
    };
  }, [open]);

  if (!open) return null;
  return (
    <div ref={rootRef} className={`mobile-overlay mobile-overlay-${variant}`} data-testid={testId}>
      <button
        type="button"
        className="mobile-overlay-backdrop"
        aria-label={`Close ${title}`}
        onClick={onClose}
      />
      <div
        className="mobile-overlay-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panelRef}
      >
        {children}
      </div>
    </div>
  );
}

export function MobileOverlayHeading({
  title,
  detail,
  onClose,
}: {
  title: string;
  detail?: string;
  onClose: () => void;
}) {
  return (
    <header className="mobile-overlay-heading">
      <div>
        <h2>{title}</h2>
        {detail !== undefined && <p>{detail}</p>}
      </div>
      <button type="button" className="mobile-icon-button" aria-label={`Close ${title}`} onClick={onClose}>
        <CloseIcon />
      </button>
    </header>
  );
}
