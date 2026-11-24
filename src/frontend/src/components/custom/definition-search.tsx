import { Search } from "lucide-react";

import { Input } from "@gears-frontx/ui-kit";
import { cn } from "@/lib/utils";

export function DefinitionSearch({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: string;
  onChange: (needle: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("w-full max-w-64", className)}>
      <Input
        type="search"
        icon={<Search />}
        value={value}
        aria-label={label}
        placeholder={label}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
