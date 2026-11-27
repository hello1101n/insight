import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  DataGrid,
  DataGridOrderPlugin,
  DataGridTableTreePlugin,
  useDataGridPluginContext,
  type DataGridItem,
  type DataGridLoadContext,
  type DataGridTableColumn,
  type DataGridTableTreePluginApi,
} from '@gears-frontx/ui-kit';

import { sortRows } from '../grid/gridModel';
import { useAriaSort } from '../grid/useAriaSort';
import { useDataVersion } from '../grid/useDataVersion';
import styles from '../widgets.module.css';

type Value = string | number | null;

/** The values behind a chart as a flat table: one column per field, one row per delivered point or slice. */
export interface ValuesTable {
  columns: string[];
  rows: Value[][];
}

// A data row, or a detail row under an opened data row: one per field, its name and its value.
type Item = DataGridItem & { values: Value[]; detailOf?: number; field?: number };

const isDataRow = (item: DataGridItem) => (item as Item).detailOf === undefined;

// The table's width floor per column, so a narrow cell scrolls sideways instead of breaking values apart, plus the
// room of the open button in the first column. The kit's fixed layout shares the floor among the columns, which stay
// flexible: a fixed first column would wrap long category names in a wide cell.
const COLUMN_FLOOR = 112;
const OPEN_BUTTON_WIDTH = 32;

/**
 * Scrolls the picked row to the top of the grid's own scroll area, just under
 * the sticky header, so the detail rows it opens show below it; the page and
 * the cell around the grid scroll only as far as it takes to show the row.
 */
function scrollPickedRow(cell: HTMLElement) {
  const table = cell.closest('table');
  let scroller = table?.parentElement ?? null;
  while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  if (scroller && table) {
    const header = table.querySelector('thead')?.getBoundingClientRect().height ?? 0;
    scroller.scrollTop += cell.getBoundingClientRect().top - scroller.getBoundingClientRect().top - header;
  }
  cell.scrollIntoView?.({ block: 'nearest' });
}

/**
 * Opens the picked row once it has loaded, through the kit table tree plugin,
 * which then loads its detail rows; once they show, scrolls the row into view
 * once, so the viewer sees the row with its fields and can scroll away after.
 */
function OpenPicked({ id, onShown }: { id: number; onShown: () => void }) {
  const context = useDataGridPluginContext();
  const loaded = context.useStore((store) => store.visibleRecords.some((record) => record.id === id));
  const detailed = context.useStore((store) => store.visibleRecords.some((record) => (record.item as Item).detailOf === id));
  const opened = useRef(false);
  useEffect(() => {
    if (!loaded || opened.current) return;
    const tree = context.getPlugin<DataGridTableTreePluginApi>('tableTree');
    if (!tree) return;
    opened.current = true;
    tree.toggle(id);
  }, [context, id, loaded]);
  useEffect(() => {
    if (detailed) onShown();
  }, [detailed, onShown]);
  return null;
}

/**
 * The data view of a chart: every delivered value in a sortable kit DataGrid,
 * held in memory. Each row opens to list its fields; the picked row (the
 * mark the viewer clicked) opens on its own, is marked, and is scrolled to the
 * top of the grid under its header once its fields show.
 */
export function DataView({
  table,
  version,
  picked,
  label,
  format,
  locale,
  container,
}: {
  table: ValuesTable;
  /** A number that changes when the table's rows do, if the caller already tracks it; the rows are compared by content otherwise. */
  version?: number;
  /** Index of the picked row in `table.rows`. */
  picked?: number | null;
  label: string;
  /** Formats a value of the column at this index, in the delivered row at this index. */
  format: (value: Value, column: number, row: number) => string;
  locale: string;
  container?: HTMLElement | ShadowRoot | null;
}) {
  const name = `data-view-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const pickedId = picked === null || picked === undefined ? 0 : picked + 1;
  // The chart rebuilds its table and formatter on every render; the grid needs stable columns and load, so it keys them by the rows.
  // The headings are read live: a new language renames them without a new grid, so the viewer's sort stays.
  const formatRef = useRef(format);
  formatRef.current = format;
  const headingsKey = JSON.stringify(table.columns);
  const headings = useMemo(() => table.columns, [headingsKey]);
  const rowsKey = version ?? JSON.stringify(table.rows);
  const stable = useMemo(() => table, [rowsKey]);
  const [order, setOrder] = useState<{ column: string; direction: 'asc' | 'desc' } | undefined>(undefined);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const dataVersion = useDataVersion(stable);
  const ids = useMemo(() => stable.columns.map((_, index) => `field_${index}`), [stable]);
  const columns = useMemo<DataGridTableColumn<Item>[]>(
    () =>
      stable.columns.map((title, index) => ({
        id: ids[index],
        label: headings[index] ?? title,
        getClassName: (item) => (item.id === pickedId ? styles.picked : undefined),
        render: (item) => {
          // A detail row holds a field name and that field's value, formatted as its own column.
          const field = (item as Item).field;
          const value = item.values[index] ?? null;
          const row = Number((item as Item).detailOf ?? item.id) - 1;
          // Its field name is read from the live headings, so an open row follows a new language.
          const text = field === undefined ? formatRef.current(value, index, row) : index === 1 ? formatRef.current(value, field, row) : index === 0 ? (headings[field] ?? '') : '';
          if (index > 0 || item.id !== pickedId) return text;
          return <span aria-current="true">{text}</span>;
        },
      })),
    [stable, ids, pickedId, headings],
  );
  const load = useCallback(
    async (context: DataGridLoadContext) => {
      const parent = context.tree?.parentId;
      if (parent !== null && parent !== undefined) {
        const values = stable.rows[Number(parent) - 1] ?? [];
        const details: Item[] = stable.columns.map((_, index) => ({ id: `${parent}-${index}`, detailOf: Number(parent), field: index, values: [null, values[index] ?? null] }));
        return { results: details, total: details.length };
      }
      const items: Item[] = stable.rows.map((values, index) => ({ id: index + 1, values }));
      const first = context.order?.[0];
      setOrder(first);
      const column = first ? ids.indexOf(first.column) : -1;
      const results = first && column >= 0 ? sortRows(items, (item) => item.values[column] ?? null, first.direction, locale) : items;
      return { results, total: results.length };
    },
    [stable, ids, locale],
  );
  // The grid draws the detail rows after its store has them, so the scroll waits a frame for them to be laid out.
  // It runs once per data view: the kit may mount the plugins again, and the viewer may have scrolled away since.
  const shown = useRef(false);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const showPicked = useCallback(() => {
    if (shown.current) return;
    shown.current = true;
    frame.current = requestAnimationFrame(() => {
      const current = root?.querySelector<HTMLElement>('[aria-current="true"]');
      if (current) scrollPickedRow(current.closest('td') ?? current);
    });
  }, [root]);
  const sortedIndex = order ? ids.indexOf(order.column) : -1;
  const sortedLabel = sortedIndex >= 0 ? headings[sortedIndex] : undefined;
  // An x label may equal a series name: count the same-labelled columns before the sorted one.
  const occurrence = headings.slice(0, Math.max(sortedIndex, 0)).filter((title) => title === sortedLabel).length;
  useAriaSort(root, sortedLabel, order?.direction, occurrence);
  return (
    <div ref={setRoot} className={styles.grid} style={{ '--data-grid-table-min-inline-size': `${stable.columns.length * COLUMN_FLOOR + OPEN_BUTTON_WIDTH}px` } as CSSProperties}>
      <DataGrid<Item> key={dataVersion} name={name} label={label} load={load} columns={columns} persistent="memory" stickyHeader portalContainer={container ?? undefined}>
        <DataGridOrderPlugin />
        <DataGridTableTreePlugin<Item> expandable={isDataRow} />
        {pickedId > 0 ? <OpenPicked id={pickedId} onShown={showPicked} /> : null}
      </DataGrid>
    </div>
  );
}
