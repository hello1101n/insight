import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@gears-frontx/ui-kit";
import type { Describing } from "@/lib/custom/editor/aria";
import { cn } from "@/lib/utils";

export interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

export function FieldSelect({
  id,
  label,
  value,
  options,
  placeholder,
  disabled,
  describe,
  onChange,
  className,
}: {
  id: string;
  label?: string;
  value: string;
  options: readonly Option[];
  placeholder?: string;
  disabled?: boolean;
  describe?: Describing;
  onChange: (value: string) => void;
  className?: string;
}) {
  const picked = options.find((option) => option.value === value);

  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        {...describe}
        className={cn("w-full", className)}
      >
        <SelectValue>
          {picked ? (
            picked.label
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
