import { useState, type ReactNode } from "react";

import { refusal } from "@/components/custom/refusal";
import { Button } from "@gears-frontx/ui-kit";
import { TEXT_LABEL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";

export function ConfirmRemove({
  ask,
  confirm,
  pending,
  error,
  onRemove,
  onKeep,
}: {
  ask: (open: () => void) => ReactNode;
  confirm: string;
  pending: boolean;
  error: unknown;
  onRemove: () => void;
  onKeep: () => void;
}) {
  const [asked, setAsked] = useState(false);

  if (!asked) return <>{ask(() => setAsked(true))}</>;

  return (
    <span className="flex flex-col items-end gap-1">
      <span className="flex items-center gap-1">
        <Button
          variant="destructive"
          size="sm"
          onClick={onRemove}
          loading={pending}
        >
          {confirm}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setAsked(false);
            onKeep();
          }}
        >
          Keep
        </Button>
      </span>

      {error ? (
        <span role="alert" className={cn(TEXT_LABEL, "text-destructive")}>
          {refusal(error, "Couldn't remove it.")}
        </span>
      ) : null}
    </span>
  );
}
