import type { ReactNode } from "react";
import { Dialog } from "@/components/ui/Dialog";

// The app's yes/no dialog, on the shared Dialog. (The file pane package keeps
// its own copy with the same Enter rules, since it can't import the app.)
export function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirm",
  destructive,
  onClose,
  onConfirm,
}: {
  title: ReactNode;
  message: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      title={title}
      size="sm"
      danger={destructive}
      confirmLabel={confirmLabel}
      onConfirm={onConfirm}
      onClose={onClose}
      data-testid="confirm-dialog"
      bodyClassName="whitespace-pre-line"
    >
      {message}
    </Dialog>
  );
}
