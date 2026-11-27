import { cn } from "@/lib/utils";

export function ChartEmpty({
  message,
  className,
}: {
  message: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-48 w-full min-w-0 flex-1 flex-col items-center justify-center p-6 text-center text-balance",
        className
      )}
    >
      <p className="max-w-sm text-sm/relaxed text-muted-foreground">
        {message}
      </p>
    </div>
  );
}
