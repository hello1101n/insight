import { useCallback, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight } from "lucide-react";

import type { EvidencePersonRow } from "@/components/metric-evidence-context";
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@gears-frontx/ui-kit";
import { cn } from "@/lib/utils";

/** Same geometry as the record table's: values, then the rail that opens them. */
const VALUE_REM = 10;
const OPENER_REM = 2.25;
const HEADER_PX = 40;
const ROW_PX = 44;

/**
 * The people behind one figure: who they are and their own value, in the same
 * dialog — and the same table — their records live in.
 *
 * Values are the ones the surface already holds, so a row never disagrees with
 * the bar or card that opened it. A row whose metric carries no readable
 * evidence stays a plain row: nothing to open, so nothing to click.
 *
 * INVARIANT: the ARIA roles are spelled out because the layout is flex, not
 * table — without them a browser drops the row and cell mapping, and every
 * value reads as a bare number under no column.
 */
export function MetricEvidencePeople({
  rows,
  valueLabel,
  onDrill,
}: {
  rows: readonly EvidencePersonRow[];
  valueLabel: string;
  onDrill: (row: EvidencePersonRow) => void;
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewport,
    estimateSize: () => ROW_PX,
    overscan: 8,
    getItemKey: useCallback(
      (index: number) => rows[index]?.entityId ?? index,
      [rows]
    ),
  });
  const virtualRows = virtualizer.getVirtualItems();
  const bodyHeight = virtualizer.getTotalSize();

  return (
    <div className="relative min-h-0 flex-1">
      <Table
        role="table"
        // The header is row 1 and the data starts at 2 (see `aria-rowindex`
        // below), so the count has to include it — otherwise the last row
        // announces itself as one past the end.
        aria-rowcount={rows.length + 1}
        containerRef={setViewport}
        containerClassName="h-full overflow-auto"
        className="grid min-w-full"
        style={{
          height: bodyHeight + HEADER_PX,
          gridTemplateRows: "2.5rem 1fr",
        }}
      >
        <TableHeader
          role="rowgroup"
          className="sticky top-0 z-20 grid bg-card shadow-[inset_0_-1px_0_0_var(--border)]"
        >
          <TableRow
            role="row"
            className="flex w-full"
          >
            <TableHead
              role="columnheader"
              className="flex min-w-0 flex-1 items-center"
            >
              Person
            </TableHead>
            <TableHead
              role="columnheader"
              className="flex shrink-0 items-center justify-end text-right"
              style={{ flex: `0 0 ${VALUE_REM}rem` }}
            >
              {valueLabel}
            </TableHead>
            <TableHead
              role="columnheader"
              className="flex shrink-0 items-center"
              style={{ flex: `0 0 ${OPENER_REM}rem` }}
            >
              <span className="sr-only">Open records</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody
          role="rowgroup"
          className="relative grid"
          style={{ height: bodyHeight }}
        >
          {virtualRows.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            const target = row.target;
            return (
              <TableRow
                role="row"
                key={row.entityId}
                aria-rowindex={virtualRow.index + 2}
                // The whole row is the mouse target, as a record row is; the
                // keyboard path is the button in the rail, which says what it
                // opens.
                onClick={target ? () => onDrill(row) : undefined}
                className={cn(
                  "absolute top-0 left-0 flex w-full",
                  target
                    ? "cursor-pointer"
                    : ""
                )}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <TableCell
                  role="cell"
                  className="min-w-0 flex-1 truncate"
                  title={row.name}
                >
                  {row.name}
                </TableCell>
                <TableCell
                  role="cell"
                  className="shrink-0 text-right tabular-nums"
                  style={{ flex: `0 0 ${VALUE_REM}rem` }}
                >
                  {row.valueText}
                </TableCell>
                <TableCell
                  role="cell"
                  className="flex shrink-0 items-center justify-center"
                  style={{ flex: `0 0 ${OPENER_REM}rem` }}
                >
                  {target ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Open records for ${row.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDrill(row);
                      }}
                      icon={<ChevronRight aria-hidden />}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
