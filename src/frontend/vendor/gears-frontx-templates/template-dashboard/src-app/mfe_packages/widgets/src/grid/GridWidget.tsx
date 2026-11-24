import { createContext, useCallback, useContext, useId, useMemo, useState, type ComponentType, type CSSProperties } from 'react';
import { CircleAlertIcon, CircleCheckIcon, CircleXIcon, InfoIcon, SearchIcon } from 'lucide-react';
import {
  DataGrid,
  DataGridEmptyStatePlugin,
  DataGridOrderPlugin,
  DataGridPaginationPlugin,
  Empty,
  EmptyHeader,
  EmptyTitle,
  Input,
  Progress,
  VisuallyHidden,
  createDataGridPlugin,
  useDataGrid,
  type DataGridLoadContext,
  type DataGridPluginApi,
  type DataGridTableColumn,
  type DataGridTableGroup,
} from '@gears-frontx/ui-kit';
import type { RenderWidgetPayload, ValueFormat } from '@gears-frontx/frontx-dashboard-root/contract';

import { formatValue, nonFiniteProblemOf } from '../format';
import { SafeLink, hasVisibleText } from '../links';
import { DEFAULT_WIDGET_TEXTS, WidgetCannotBeShown, WidgetEmpty, type WidgetTexts } from '../states';
import { ToneBadge } from '../tones';
import type { GridColumn, GridData, GridRender, GridValue } from '../types';
import styles from '../widgets.module.css';
import { useAriaSort } from './useAriaSort';
import { useDataVersion } from './useDataVersion';
import { DEFAULT_PAGE_SIZES, checkGrid, isLink, isSortable, pinnedCount, searchRows, shownTextOf, sortRows } from './gridModel';

type RowItem = { id: number; row: GridValue[] };

// The kit takes stricter column ids than a column key allows (no `a__b` or `total_`), so the grid gives it its own, by position.
const columnId = (index: number) => `col_${index}`;
const indexOfColumnId = (id: string) => (/^col_\d+$/.test(id) ? Number(id.slice(4)) : -1);

// The width a column without its own width keeps before the grid scrolls sideways.
const FLEXIBLE_COLUMN_FLOOR = 160;

/**
 * The table's width floor: every column's own width, or the flexible floor.
 * The kit's fixed layout sizes columns from the first header row, where a column
 * group has no width, so without this floor a group's columns shrink to their
 * group title and their values break apart; with it the table scrolls sideways instead.
 */
const tableFloorOf = (columns: GridColumn[]) => columns.reduce((sum, column) => sum + (column.width ?? FLEXIBLE_COLUMN_FLOOR), 0);
type Order = DataGridLoadContext['order'];

const ROW_COLORS = {
  success: { icon: CircleCheckIcon },
  warning: { icon: CircleAlertIcon },
  error: { icon: CircleXIcon },
  info: { icon: InfoIcon },
} as const;

type RowColor = keyof typeof ROW_COLORS;
const rowColorOf = (value: GridValue): RowColor | null => (typeof value === 'string' && Object.hasOwn(ROW_COLORS, value) ? (value as RowColor) : null);

/** The texts of the widget, for the search box and the empty search result the kit draws inside the grid. */
const GridTexts = createContext<WidgetTexts>(DEFAULT_WIDGET_TEXTS);

// The load context key the search box writes its query under.
const SEARCH_KEY = 'gridSearch';

interface SearchApi extends DataGridPluginApi {
  query: () => string;
  setQuery: (query: string) => void;
}

/** The search box: a named search field in the grid's toolbar, its query applied as it is typed. */
function SearchBox() {
  const texts = useContext(GridTexts);
  const search = useDataGrid().getPlugin<SearchApi>('gridSearch')!;
  const [value, setValue] = useState(search.query);
  return (
    <Input
      type="search"
      aria-label={texts.grid.search}
      placeholder={texts.grid.search}
      icon={<SearchIcon />}
      value={value}
      className={styles.gridSearch}
      onValueChange={(next: string) => {
        setValue(next);
        search.setQuery(next);
      }}
    />
  );
}

/**
 * The grid's search, a kit plugin: a box in the toolbar and the query in the load context. Each new query reloads
 * at once (the rows are in memory) through the kit refresh, which keeps the sort and shows the first page.
 */
const GridSearchPlugin = createDataGridPlugin<RowItem, 'gridSearch', Record<string, never>, SearchApi>('gridSearch', (context) => {
  let query = '';
  context.registerSlot('top-start', { id: 'gridSearch', component: SearchBox });
  context.hook('load:context', () => (query.trim() ? { filters: { [SEARCH_KEY]: { value: query } } } : undefined));
  return {
    query: () => query,
    setQuery(next) {
      query = next;
      void context.refresh({ resetFilters: false });
    },
  };
});

/** What the grid shows when a search keeps no row; the grid itself never reaches it without a search, as no rows draw the widget's empty state. */
function NoMatch() {
  const texts = useContext(GridTexts);
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{texts.grid.noMatch}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

function CellText({ value, column, valueFormat, locale, texts }: { value: GridValue; column: GridColumn; valueFormat: ValueFormat | undefined; locale: string; texts: WidgetTexts }) {
  const truncate = column.overflow === 'truncate';
  if (isLink(value) && column.kind !== 'badge') {
    return (
      // The shared link rule; the link text and its link icon stay on one line, so a short id such as REQ-1000 never wraps.
      <SafeLink text={value.text} href={value.href} texts={texts} className={styles.gridLink}>
        <span className={truncate ? styles.truncate : undefined} title={truncate ? value.text : undefined}>
          {value.text}
        </span>
      </SafeLink>
    );
  }
  // A delivered object that is not a well-formed link has no text to show.
  const text = shownTextOf(value, column, valueFormat, locale);
  // A badge with no visible character is an empty cell, not an empty badge (ToneBadge draws none).
  if (column.kind === 'badge') return <ToneBadge text={text} tones={column.tones} className={styles.gridBadge} />;
  return truncate ? (
    <span className={styles.truncate} title={text}>
      {text}
    </span>
  ) : (
    <>{text}</>
  );
}

/** A progress cell: a bar filled by the value, 0 to 1, with its percent as text, which carries the value; null is an empty cell. */
function ProgressCell({ value, locale }: { value: GridValue; locale: string }) {
  if (typeof value !== 'number') return null;
  return (
    <span className={styles.gridProgress}>
      <Progress value={value * 100} className={styles.gridProgressBar} aria-hidden />
      <span className={styles.gridProgressText}>{formatValue(value, { value_type: 'percent' }, locale)}</span>
    </span>
  );
}

// The sparkline's drawing box: a line across the width with a margin of its stroke above and below.
const SPARK_HEIGHT = 24;
const SPARK_WIDTH = 100;
const SPARK_MARGIN = 2;

/**
 * A sparkline cell: a small line in the theme's chart colour, with no axes, broken at a null point; a lone point is a
 * dot. Its text alternative names the first, last, lowest and highest values. A list with no number is an empty cell.
 */
function SparklineCell({ value, valueFormat, locale, texts }: { value: GridValue; valueFormat: ValueFormat | undefined; locale: string; texts: WidgetTexts }) {
  if (!Array.isArray(value)) return null;
  const numbers = value.filter((point): point is number => typeof point === 'number');
  if (numbers.length === 0) return null;
  const min = Math.min(...numbers);
  const max = Math.max(...numbers);
  const xOf = (index: number) => (value.length === 1 ? SPARK_WIDTH / 2 : (index / (value.length - 1)) * SPARK_WIDTH);
  // Halved before subtracting, so a range as wide as the number line (1e308 to -1e308) does not overflow to Infinity.
  // A half range of 0 (equal points, or 0 and 5e-324, whose halves are equal) is a flat line, never a division by 0.
  const halfRange = max / 2 - min / 2;
  const yOf = (point: number) => (halfRange === 0 ? SPARK_HEIGHT / 2 : SPARK_MARGIN + ((max / 2 - point / 2) / halfRange) * (SPARK_HEIGHT - 2 * SPARK_MARGIN));
  // One move per run of numbers after a null (or at the start); a run of one point draws a dot through its round cap.
  const path = value
    .map((point, index) => {
      if (point === null) return '';
      const at = `${xOf(index).toFixed(2)} ${yOf(point).toFixed(2)}`;
      const starts = index === 0 || value[index - 1] === null;
      const alone = starts && (index === value.length - 1 || value[index + 1] === null);
      return starts ? `M${at}${alone ? ' h0' : ''}` : `L${at}`;
    })
    .join(' ');
  const shown = (point: number) => formatValue(point, valueFormat, locale);
  const label = texts.grid.sparkline({ first: shown(numbers[0]), last: shown(numbers[numbers.length - 1]), min: shown(min), max: shown(max) });
  return (
    <svg className={styles.gridSpark} viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <path d={path} />
    </svg>
  );
}

// @cpt-dod:cpt-frontx-dashboard-dod-widget-catalog-grid:p1
/**
 * The `grid` widget: the ui-kit DataGrid over the rows the transform
 * delivered. Its load callback answers every sort, page and page size from
 * those rows in memory and never sends a request.
 */
export function GridWidget({
  payload,
  locale = 'en',
  texts = DEFAULT_WIDGET_TEXTS,
  label: labelProp,
  container,
}: {
  payload: RenderWidgetPayload<GridRender, GridData>;
  locale?: string;
  texts?: WidgetTexts;
  /** Names the grid's region and pager; distinct per grid on a page. `texts.table` when the cell gives none. */
  label?: string;
  /** Where the grid's popups go, for a grid inside a shadow root. */
  container?: HTMLElement | ShadowRoot | null;
}) {
  const { render, data, value_format } = payload;
  const label = labelProp ?? texts.table;
  const name = `grid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [order, setOrder] = useState<Order>(undefined);
  // The finite-number walk reads the whole payload: once per payload, not on every sort, page or search keystroke.
  const problem = useMemo(() => (data ? (nonFiniteProblemOf('grid', payload) ?? checkGrid(render, data)) : 'grid: no data'), [payload, data, render]);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  // Versioned by content: a re-delivery of the same rows keeps the viewer's sort and page.
  const rowsKey = useMemo(() => JSON.stringify(rows), [rows]);
  const dataVersion = useDataVersion(rowsKey);
  const sizes = useMemo(() => (render.page_sizes?.length ? render.page_sizes : DEFAULT_PAGE_SIZES), [render]);
  const keys = useMemo(() => render.columns.map((column) => column.key), [render]);
  const colorAt = render.row_color === undefined ? -1 : keys.indexOf(render.row_color);

  const columns = useMemo(() => {
    const pinned = pinnedCount(render);
    const columnOf = (column: GridColumn, index: number): DataGridTableColumn<RowItem> => ({
      id: columnId(index),
      label: column.title ?? column.key,
      width: column.width,
      sticky: index < pinned,
      cellOverflow: column.overflow === 'truncate' ? 'nowrap' : 'wrap',
      getClassName: (item) => {
        const color = colorAt >= 0 ? rowColorOf(item.row[colorAt] ?? null) : null;
        return [column.align === 'end' ? styles.alignEnd : column.align === 'center' ? styles.alignCenter : '', color ? styles[`row-${color}`] : ''].join(' ').trim() || undefined;
      },
      render: (item) => {
        const color = index === 0 && colorAt >= 0 ? rowColorOf(item.row[colorAt] ?? null) : null;
        const Icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }> | null = color ? ROW_COLORS[color].icon : null;
        return (
          <>
            {Icon && color ? (
              <>
                <Icon className={styles.rowIcon} aria-hidden />
                <VisuallyHidden>{texts.rowMeaning[color]}: </VisuallyHidden>
              </>
            ) : null}
            {column.kind === 'progress' ? (
              <ProgressCell value={item.row[index] ?? null} locale={locale} />
            ) : column.kind === 'sparkline' ? (
              <SparklineCell value={item.row[index] ?? null} valueFormat={value_format} locale={locale} texts={texts} />
            ) : (
              <CellText value={item.row[index] ?? null} column={column} valueFormat={value_format} locale={locale} texts={texts} />
            )}
          </>
        );
      },
    });
    const result: (DataGridTableColumn<RowItem> | DataGridTableGroup<RowItem>)[] = [];
    const placed = new Set<string>();
    render.columns.forEach((column, index) => {
      if (placed.has(column.key)) return;
      const groupIndex = (render.column_groups ?? []).findIndex((group) => group.members.includes(column.key));
      if (groupIndex < 0) {
        result.push(columnOf(column, index));
        return;
      }
      const group = render.column_groups![groupIndex];
      const members = render.columns.map((item, position) => [item, position] as const).filter(([item]) => group.members.includes(item.key));
      members.forEach(([item]) => placed.add(item.key));
      result.push({ id: `group_${groupIndex}`, label: group.title, sticky: members.every(([, position]) => position < pinned), columns: members.map(([item, position]) => columnOf(item, position)) });
    });
    return result;
  }, [render, value_format, locale, colorAt, texts]);

  // @cpt-flow:cpt-frontx-dashboard-flow-widget-catalog-grid-sort-page:p1
  const load = useCallback(
    async (context: DataGridLoadContext) => {
      // @cpt-begin:cpt-frontx-dashboard-flow-widget-catalog-grid-sort-page:p1:inst-wc-search-do
      const all: RowItem[] = rows.map((row, index) => ({ id: index + 1, row }));
      const query = (context.filters?.[SEARCH_KEY] as { value?: unknown } | undefined)?.value;
      const items = typeof query === 'string' ? searchRows(all, (item) => item.row, query, render.columns, value_format, locale) : all;
      // @cpt-end:cpt-frontx-dashboard-flow-widget-catalog-grid-sort-page:p1:inst-wc-search-do
      // @cpt-begin:cpt-frontx-dashboard-flow-widget-catalog-grid-sort-page:p1:inst-wc-sort-do
      const first = context.order?.[0];
      setOrder(context.order);
      const column = first ? indexOfColumnId(first.column) : -1;
      // A badge column sorts by the text its badges show, so a number in it sorts among the strings. A badge with no
      // visible character draws nothing, so it sorts with the nulls.
      const badge = render.columns[column]?.kind === 'badge' ? render.columns[column] : undefined;
      const sortValueOf = (value: GridValue): GridValue => {
        if (!badge || value === null) return value;
        const text = shownTextOf(value, badge, value_format, locale);
        return hasVisibleText(text) ? text : null;
      };
      const sorted = first && column >= 0 ? sortRows(items, (item) => sortValueOf(item.row[column] ?? null), first.direction, locale) : items;
      // @cpt-end:cpt-frontx-dashboard-flow-widget-catalog-grid-sort-page:p1:inst-wc-sort-do
      // @cpt-begin:cpt-frontx-dashboard-flow-widget-catalog-grid-sort-page:p1:inst-wc-page-do
      const limit = context.pagination?.limit ?? sizes[0];
      const start = ((context.pagination?.page ?? 1) - 1) * limit;
      return { results: sorted.slice(start, start + limit), total: sorted.length };
      // @cpt-end:cpt-frontx-dashboard-flow-widget-catalog-grid-sort-page:p1:inst-wc-page-do
    },
    [rows, locale, sizes, render, value_format],
  );

  const headingOf = (column: GridColumn) => column.title ?? column.key;
  // A sort kept from earlier data may name a column the new render no longer has.
  const orderedAt = order?.[0] ? indexOfColumnId(order[0].column) : -1;
  const sortedAt = orderedAt < render.columns.length ? orderedAt : -1;
  const sortedHeading = sortedAt >= 0 ? headingOf(render.columns[sortedAt]) : undefined;
  // Two columns may share a title: count the same-titled sortable columns before the sorted one.
  const occurrence = render.columns.slice(0, Math.max(sortedAt, 0)).filter((column) => isSortable(column) && headingOf(column) === sortedHeading).length;
  useAriaSort(root, sortedHeading, order?.[0]?.direction, occurrence);

  if (problem) return <WidgetCannotBeShown texts={texts} problem={problem} />;
  if (rows.length === 0) return <WidgetEmpty texts={texts} />;
  const excluded = render.columns.flatMap((column, index) => (isSortable(column) ? [] : [columnId(index)]));
  return (
    <div ref={setRoot} className={styles.grid} style={{ '--data-grid-table-min-inline-size': `${tableFloorOf(render.columns)}px` } as CSSProperties}>
      {/* The kit keeps loaded records and its pager size, and reloads on neither a new load nor new limits: new rows or new page sizes remount the grid, which starts it again unsorted on page 1. A new language does not: the columns render it, and the sort and page stay; text already on the page keeps the old language's collation until the next sort or page. */}
      <GridTexts.Provider value={texts}>
        <DataGrid<RowItem> key={`${dataVersion}:${sizes.join(',')}:${render.search ? 'search' : ''}`} name={name} label={label} load={load} columns={columns} persistent="memory" stickyHeader portalContainer={container ?? undefined}>
          {render.search ? <GridSearchPlugin /> : null}
          <DataGridPaginationPlugin defaultLimit={sizes[0]} limits={sizes} />
          <DataGridOrderPlugin excludedColumns={excluded} />
          <DataGridEmptyStatePlugin component={NoMatch} />
        </DataGrid>
      </GridTexts.Provider>
    </div>
  );
}
