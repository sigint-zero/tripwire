import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "./ui";

/**
 * Asks before something that cannot be undone. Escape, the backdrop and
 * Cancel all close it. `tone` is "go" for an act that is not a loss,
 * such as sending an approved response.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirm,
  tone = "danger",
  pending = false,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  /** The confirming button's label, naming the act. */
  confirm: string;
  tone?: "danger" | "go";
  pending?: boolean;
  error?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      // Nothing lit at first; Tab reaches Cancel, then the act.
      element.focus();
    }
    if (!open && element.open) element.close();
  }, [open]);

  // A click on the backdrop lands on the dialog itself, outside its content.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const outside = (e: MouseEvent) => {
      if (e.target === element && !pending) onClose();
    };
    element.addEventListener("click", outside);
    return () => element.removeEventListener("click", outside);
  }, [pending, onClose]);

  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      onClose={onClose}
      onCancel={(e) => pending && e.preventDefault()}
      className="m-auto w-full outline-none max-w-md bg-panel text-gray-300 shadow-2xl shadow-black backdrop:bg-black/70 backdrop:backdrop-blur-sm"
    >
      <div className="p-8">
        <h2 className="font-display text-xl font-bold tracking-tight text-white uppercase">
          {title}
        </h2>
        <div className="mt-3 text-sm leading-relaxed text-gray-400">
          {children}
        </div>
        {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
        <div className="mt-8 flex justify-end gap-3">
          <Button variant="quiet" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={tone === "go" ? "primary" : "destroy"}
            disabled={pending}
            onClick={onConfirm}
          >
            {confirm}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
