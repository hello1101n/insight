import { useId, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from "lucide-react";

import type { DatasetRecord, DeclaredField } from "@/api/custom-client";
import {
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@gears-frontx/ui-kit";
import { pathSegments } from "@/lib/custom/dataset-path";
import { read } from "@/lib/custom/editor/document";
import { TEXT_BODY, TEXT_LABEL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";

export const ARRIVED = "received_at";

export interface Ordering {
  by: string;
  descending: boolean;
}

export function RecordTable({
  fields,
  records,
  shown,
  ordering,
  onShow,
  onOrder,
}: {
  fields: readonly DeclaredField[];
  records: readonly DatasetRecord[];
  shown: readonly string[];
  ordering: Ordering;
  onShow: (names: string[]) => void;
  onOrder: (ordering: Ordering) => void;
}) {
  const drawn = fields.filter((field) => shown.includes(field.name));

  return (
    <div className="flex flex-col gap-3">
      <Columns fields={fields} shown={shown} drawn={drawn} onShow={onShow} />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-0" />
            <Sortable
              name={ARRIVED}
              label="Received"
              ordering={ordering}
              onOrder={onOrder}
            />
            {drawn.map((field) => (
              <Sortable
                key={field.name}
                name={field.name}
                label={field.name}
                ordering={ordering}
                onOrder={onOrder}
              />
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((record) => (
            <Row key={record.id} record={record} fields={drawn} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Columns({
  fields,
  shown,
  drawn,
  onShow,
}: {
  fields: readonly DeclaredField[];
  shown: readonly string[];
  drawn: readonly DeclaredField[];
  onShow: (names: string[]) => void;
}) {
  const toggle = (name: string) =>
    onShow(
      shown.includes(name)
        ? shown.filter((held) => held !== name)
        : fields
            .map((field) => field.name)
            .filter((held) => held === name || shown.includes(held))
    );

  return (
    <Collapsible>
      <CollapsibleTrigger
        render={
          <Button variant="ghost" size="sm" className="self-start" icon={<ChevronDown className="size-4" />}>
            Columns · {drawn.length} of {fields.length}
          </Button>
        }
      />
      <CollapsibleContent>
        <div className="mt-2 grid gap-x-6 gap-y-2 rounded-md border border-border p-3 sm:grid-cols-2 lg:grid-cols-3">
          {fields.map((field) => (
            <label
              key={field.name}
              className={cn(TEXT_LABEL, "flex items-center gap-2")}
            >
              <Checkbox
                checked={shown.includes(field.name)}
                onCheckedChange={() => toggle(field.name)}
              />
              <span className="font-mono">{field.name}</span>
              <span className="text-muted-foreground">{field.type}</span>
            </label>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Sortable({
  name,
  label,
  ordering,
  onOrder,
}: {
  name: string;
  label: string;
  ordering: Ordering;
  onOrder: (ordering: Ordering) => void;
}) {
  const chosen = ordering.by === name;
  const sorted = chosen ? (ordering.descending ? "descending" : "ascending") : "none";

  return (
    <TableHead aria-sort={sorted}>
      <button
        type="button"
        className="inline-flex items-center gap-1 font-mono hover:underline"
        aria-label={
          chosen ? `Order by ${label}, now ${sorted}` : `Order by ${label}`
        }
        onClick={() =>
          onOrder({
            by: name,
            descending: chosen ? !ordering.descending : true,
          })
        }
      >
        {label}
        {chosen ? (
          ordering.descending ? (
            <ArrowDown className="size-3" aria-hidden />
          ) : (
            <ArrowUp className="size-3" aria-hidden />
          )
        ) : null}
      </button>
    </TableHead>
  );
}

function Row({
  record,
  fields,
}: {
  record: DatasetRecord;
  fields: readonly DeclaredField[];
}) {
  const [open, setOpen] = useState(false);
  const whole = useId();

  return (
    <>
      <TableRow
        className="cursor-pointer"
        onClick={() => setOpen((was) => !was)}
      >
        <TableCell className="w-0">
          <button
            type="button"
            id={`${whole}-trigger`}
            aria-expanded={open}
            aria-controls={open ? whole : undefined}
            aria-label={`${open ? "Hide" : "Show"} the whole record received at ${record.received_at}`}
            className="flex items-center text-muted-foreground"
            onClick={(event) => {
              event.stopPropagation();
              setOpen((was) => !was);
            }}
          >
            {open ? (
              <ChevronDown className="size-4" aria-hidden />
            ) : (
              <ChevronRight className="size-4" aria-hidden />
            )}
          </button>
        </TableCell>
        <TableCell className="font-mono whitespace-nowrap">
          {record.received_at}
        </TableCell>
        {fields.map((field) => {
          const held = cell(record.raw_data, field);
          return (
            <TableCell
              key={field.name}
              title={held || undefined}
              className="max-w-64 truncate font-mono"
            >
              {held}
            </TableCell>
          );
        })}
      </TableRow>
      {open ? (
        <TableRow>
          <TableCell colSpan={fields.length + 2}>
            <pre
              id={whole}
              aria-labelledby={`${whole}-trigger`}
              className={cn(TEXT_BODY, "overflow-x-auto font-mono")}
            >
              {JSON.stringify(record.raw_data, null, 2)}
            </pre>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function cell(payload: unknown, field: DeclaredField): string {
  const value = read(payload, pathSegments(field.path));
  if (value === undefined || value === null || value === "") {
    return field.absent_value ?? "";
  }
  if (typeof value === "object") return JSON.stringify(value);

  return String(value);
}
