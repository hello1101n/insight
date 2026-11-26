import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@gears-frontx/ui-kit";

import {
  UNMEASURED,
  formatRecords,
  type ConnectorTone,
} from "@/lib/portal/connector-health";
import { activatesRow } from "@/lib/identities/row-activation";
import { cn } from "@/lib/utils";
import { TONE_BADGE } from "./connector-health-tone";

export const INITIAL_HISTORY_ROWS = 10;

interface HistoryRow {
  id: string;
  status: { label: string; tone: ConnectorTone };
  started: string;
  duration: string;
  inFlight: boolean;
  records: number | null | undefined;
}

interface HistorySelection {
  selectedId: string;
  detailsId: string;
  onSelect: (id: string) => void;
}

export function ConnectorSyncTable({
  id,
  rows,
  selection,
}: {
  id: string;
  rows: HistoryRow[];
  selection?: HistorySelection;
}) {
  const { t } = useTranslation();
  return (
    <Table
      id={id}
      label={t("connectors.history.heading")}
      containerClassName="min-w-0 max-w-full whitespace-normal [overflow-wrap:anywhere]"
      aria-label={t("connectors.history.heading")}
      className="w-full max-w-full table-fixed text-xs sm:text-sm"
    >
      <colgroup>
        <col className="w-[23%] sm:w-1/4" />
        <col className="w-[33%] sm:w-2/5" />
        <col className="w-[19%] sm:w-1/5" />
        <col className="w-1/4 sm:w-[15%]" />
      </colgroup>
      <TableHeader className="[overflow-wrap:anywhere] [word-break:normal] whitespace-normal">
        <TableRow className="border-b text-left text-muted-foreground">
          <TableHead scope="col" className="px-1 py-2 font-medium">
            {t("common.table.status")}
          </TableHead>
          <TableHead
            scope="col"
            className="px-1 py-2 font-medium whitespace-normal"
          >
            {t("connectors.history.started_utc")}
          </TableHead>
          <TableHead scope="col" className="px-1 py-2 text-right font-medium">
            {t("connectors.duration")}
          </TableHead>
          <TableHead scope="col" className="px-1 py-2 text-right font-medium">
            {t("connectors.history.records")}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={row.id}
            data-state={
              selection?.selectedId === row.id ? "selected" : undefined
            }
            className={cn(
              "border-b last:border-0",
              selection && "cursor-pointer"
            )}
            onClick={
              selection &&
              ((event) => {
                if (activatesRow(event)) selection.onSelect(row.id);
              })
            }
          >
            <TableCell className="px-1 py-2 align-top">
              <Badge
                variant={TONE_BADGE[row.status.tone]}
                className="max-w-full whitespace-normal"
              >
                {row.status.label}
              </Badge>
            </TableCell>
            <TableCell className="px-1 py-2 align-top whitespace-normal text-muted-foreground tabular-nums">
              {selection ? (
                <button
                  type="button"
                  aria-controls={selection.detailsId}
                  aria-pressed={selection.selectedId === row.id}
                  className="rounded-sm text-start underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground focus-visible:outline-2"
                  onClick={() => selection.onSelect(row.id)}
                >
                  {row.started}
                </button>
              ) : (
                row.started
              )}
            </TableCell>
            <TableCell
              className={cn(
                "px-1 py-2 text-right align-top whitespace-normal tabular-nums",
                row.inFlight ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {row.duration}
            </TableCell>
            <TableCell className="px-1 py-2 text-right align-top [overflow-wrap:anywhere] whitespace-normal text-muted-foreground tabular-nums">
              {formatRecords(row.records)}
              {row.records == null && (
                <span className="sr-only">
                  {t("connectors.history.unmeasured", { value: UNMEASURED })}
                </span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ConnectorSyncTableToggle({
  tableId,
  count,
  showAll,
  onToggle,
}: {
  tableId: string;
  count: number;
  showAll: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  if (count <= INITIAL_HISTORY_ROWS) return null;

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      aria-expanded={showAll}
      aria-controls={tableId}
      onClick={onToggle}
    >
      {showAll
        ? t("connectors.history.show_latest", { count: INITIAL_HISTORY_ROWS })
        : t("connectors.history.show_all", { count })}
    </Button>
  );
}
