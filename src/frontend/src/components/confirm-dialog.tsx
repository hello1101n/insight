import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@gears-frontx/ui-kit";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  destructive = false,
  isPending,
  confirmDisabled = false,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  isPending: boolean;
  confirmDisabled?: boolean;
  error?: string | null;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const requestClose = (next: boolean) => {
    if (isPending && !next) return;
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={requestClose}>
      <DialogContent className="sm:max-w-md" showCloseButton={!isPending}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {/* INVARIANT: the kit insets each direct child of DialogContent with its own padding, so the body sits in one wrapper. */}
        {children || error ? (
          <div className="flex flex-col gap-3">
            {children}
            {error ? (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => requestClose(false)}
            disabled={isPending}
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={isPending || confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
