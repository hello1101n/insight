import { Sparkles } from "lucide-react";
import { useState } from "react";

import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@gears-frontx/ui-kit";
import { useAiAvailable, useExplainMetric } from "@/queries/ai";
import type { MetricSnapshot } from "@/api/ai-client";
import { TEXT_HEADING, TEXT_LABEL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";

export interface ExplainWithAiProps {
  snapshot: MetricSnapshot;
  className?: string;
}

export function ExplainWithAi({ snapshot, className }: ExplainWithAiProps) {
  const { featureOn, hasKey } = useAiAvailable();
  const [open, setOpen] = useState(false);
  const explain = useExplainMetric();

  if (!featureOn || !hasKey) return null;

  const ask = () => {
    setOpen(true);
    if (explain.isPending) return;
    explain.mutate(snapshot);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Explain ${snapshot.label} with AI`}
            onClick={ask}
            disabled={explain.isPending}
            className={cn(
              "absolute top-2 right-2 z-10 grid size-7 place-items-center rounded-md",
              "text-muted-foreground transition-colors",
              "hover:bg-muted hover:text-foreground",
              "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
              open && "bg-muted text-foreground",
              className
            )}
          >
            <Sparkles className="size-3.5" aria-hidden />
          </button>
        }
      />
      <PopoverContent align="end" className="flex w-96 max-w-[90vw] flex-col gap-3">
        <p className={TEXT_HEADING}>{snapshot.label}, explained</p>
        <ExplanationBody
          isPending={explain.isPending}
          isError={explain.isError}
          text={explain.data?.text ?? ""}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={TEXT_LABEL}>
            {explain.data
              ? `${explain.data.model} · ${explain.data.tenant_context_entries} org + ${explain.data.person_context_entries} personal notes`
              : ""}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={ask}
            disabled={explain.isPending}
          >
            Try again
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ExplanationBody({
  isPending,
  isError,
  text,
}: {
  isPending: boolean;
  isError: boolean;
  text: string;
}) {
  if (isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy>
        <span className="bg-muted h-2.5 w-full animate-pulse rounded-full" />
        <span className="bg-muted h-2.5 w-11/12 animate-pulse rounded-full" />
        <span className="bg-muted h-2.5 w-2/3 animate-pulse rounded-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <p className="text-sm">
        That did not work. Your key may have been rejected — check it in AI
        assistant settings, or try again in a moment.
      </p>
    );
  }

  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <div className="flex max-h-[26rem] flex-col gap-3 overflow-y-auto pr-1">
      {paragraphs.map((paragraph, i) => (
        <p key={i} className="text-sm leading-relaxed">
          {paragraph}
        </p>
      ))}
    </div>
  );
}
