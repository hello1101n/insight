import { Spinner } from "@gears-frontx/ui-kit";
import { cn } from "@/lib/utils";

export function CenteredSpinner({
  className,
  "data-testid": testId,
}: {
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn("flex items-center justify-center", className)}
    >
      <Spinner size="lg" />
    </div>
  );
}
