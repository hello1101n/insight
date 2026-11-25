import { ConfirmRemove } from "@/components/custom/confirm-remove";
import { Button } from "@gears-frontx/ui-kit";
import { useRemoveDataset } from "@/queries/custom";

export function RemoveDataset({
  name,
  onRemoved,
}: {
  name: string;
  onRemoved: () => void;
}) {
  const remove = useRemoveDataset();

  return (
    <ConfirmRemove
      ask={(open) => (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove ${name}`}
          onClick={open}
        >
          Remove
        </Button>
      )}
      confirm="Remove it, with its records"
      pending={remove.isPending}
      error={remove.error}
      onRemove={() => remove.mutate(name, { onSuccess: onRemoved })}
      onKeep={remove.reset}
    />
  );
}
