import { Fragment } from 'react';
import type { CSSProperties } from 'react';
import { Text } from '@gears-frontx/ui-kit';
import type { RenderWidgetPayload } from '@gears-frontx/frontx-dashboard-root/contract';

import { formatValue, nonFiniteProblemOf, percentInRange, textOf } from '../format';
import { DEFAULT_WIDGET_TEXTS, ValuesText, WidgetCannotBeShown, WidgetEmpty, type WidgetTexts } from '../states';
import type { TreemapData, TreemapRender } from '../types';
import { ChartShell } from './ChartShell';
import type { ValuesTable } from './DataView';
import { PALETTE } from './palette';
import { isLaidOut, useElementSize } from './size';
import { estimateWidth } from '../textFit';
import styles from '../widgets.module.css';

/*
 * The `treemap_chart` widget: squarified tiles of its measured box, drawn with no chart library, like the funnel
 * and the heatmap. Recharts' treemap draws SVG text and takes no rule a tile's text follows (a label that hides
 * when it cannot fit, a group header over nested tiles, kit tokens on every colour), so the layout of Bruls,
 * Huizing and van Wijk is laid out here over plain HTML instead, and this bundle carries no chart library.
 */

/** One laid-out rectangle: where a tile stands in its box and how large it is, in px. */
interface TileBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The font size the width estimate (`estimateWidth`) counts with: the label, the value and the share are all 12 px,
// as the funnel judges its row.
const TEXT_PX = 12;
// One text line's height, and the gap between a tile's label line and its value line (`--treemap-gap`, which the box
// sets for `.treemapText`).
const LINE = 16;
const LINE_GAP = 2;
// The room a tile keeps around its text and a group header beside its name (`--treemap-pad`, which the box sets for
// `.treemapText` and `.treemapGroupHead`): the tile itself keeps exactly its slot, so a tile too small for any text
// draws at its slot's size.
const PAD = 8;
// A group's header band is one text line plus its gap, and it takes that room only while its group's tiles keep
// at least the least tile height (8 px, the funnel bar's floor) under it.
const HEADER = LINE + LINE_GAP;
const LEAST_TILE = 8;
const widthOf = (text: string) => estimateWidth(text, TEXT_PX);
// The text room the fit above counts with, handed to the styles, so the two cannot drift apart.
const TEXT_ROOM = { '--treemap-pad': `${PAD}px`, '--treemap-gap': `${LINE_GAP}px` } as CSSProperties;

/** The treemap's own check of its data: the first item with a negative value, by its position, or null. */
export function checkTreemap(data: TreemapData): string | null {
  const index = data.items.findIndex((item) => item.value !== null && item.value < 0);
  return index < 0 ? null : `treemap_chart: data.items[${index}].value is below 0`;
}

/**
 * The squarified layout of Bruls, Huizing and van Wijk: the values laid out largest first, each a rectangle of the
 * box's area its value has over their total, a row of rectangles across the shorter side of the room that is left
 * filled greedily while the worst aspect ratio of the row improves. The rows are laid out over a copy of the values
 * sorted by size, largest first, equal values keeping their delivered order, and each box is handed back to the
 * position of the value it was laid out for, so the delivered order of the tiles does not move. The values are
 * scaled over their largest first, so a total beyond the largest number (two 1.5e308 items) divides by finite
 * numbers only. A box without room, or no value, lays every tile out at 0 by 0 at the box's corner, and so does a
 * value whose area scales to 0 (a positive value too small beside the largest, 5e-324 beside 1e308), never a NaN
 * one, and so does a value left with no room by the rows before it.
 */
function squarified(values: number[], box: TileBox): TileBox[] {
  const empty = () => ({ x: box.x, y: box.y, width: 0, height: 0 });
  if (values.length === 0 || !(box.width > 0) || !(box.height > 0)) return values.map(empty);
  // The layout assumes the values descending: the copy sorted so is what is laid out, and the boxes go back to the
  // positions of the values they were laid out for.
  const order = values.map((value, at) => ({ value, at })).sort((one, other) => other.value - one.value);
  const most = order[0].value;
  if (!(most > 0)) return values.map(empty);
  const unitTotal = order.reduce((sum, { value }) => sum + value / most, 0);
  const scaled = order.map(({ value }) => ((value / most) / unitTotal) * box.width * box.height);
  const tiles: TileBox[] = values.map(empty);
  // Only the areas above 0 are laid out: a 0 would make a row's worst aspect ratio infinite and its tile NaN wide.
  const laid = scaled.flatMap((area, at) => (area > 0 ? [at] : []));
  const rest = { ...box };
  let index = 0;
  // The room left after a row can round to 0 or a hair below while items remain (1e-20 beside 1): those items keep
  // the 0 by 0 tile they start with, never an infinite or negative one.
  while (index < laid.length && rest.width > 0 && rest.height > 0) {
    // A row lies along the shorter side of the room that is left: side by side in a strip across the top of a
    // taller (or square) room, stacked in a strip against the left of a wider one.
    const horizontal = rest.width <= rest.height;
    const along = horizontal ? rest.width : rest.height;
    const worstOf = (row: number[]) => {
      const sum = row.reduce((total, value) => total + value, 0);
      const largest = Math.max(...row);
      const smallest = Math.min(...row);
      return Math.max((along * along * largest) / (sum * sum), (sum * sum) / (along * along * smallest));
    };
    const row = [scaled[laid[index]]];
    let best = worstOf(row);
    let next = index + 1;
    while (next < laid.length) {
      const worst = worstOf([...row, scaled[laid[next]]]);
      if (worst > best) break;
      row.push(scaled[laid[next]]);
      best = worst;
      next += 1;
    }
    const thickness = row.reduce((total, value) => total + value, 0) / along;
    let offset = horizontal ? rest.x : rest.y;
    for (const area of row) {
      const extent = area / thickness;
      tiles[order[laid[index]].at] = horizontal ? { x: offset, y: rest.y, width: extent, height: thickness } : { x: rest.x, y: offset, width: thickness, height: extent };
      offset += extent;
      index += 1;
    }
    if (horizontal) {
      rest.y += thickness;
      rest.height -= thickness;
    } else {
      rest.x += thickness;
      rest.width -= thickness;
    }
  }
  return tiles;
}

/** One drawn tile: its item, its place in its box, its colour, and the delivered row it shows. */
interface Tile {
  index: number;
  label: string;
  value: number;
  box: TileBox;
  colour: string;
  /** The name of the group the tile is nested under, when the items come in groups. */
  group?: string;
}

/** One nested group of tiles: its face in the box, its header band when the box fits it, and the tiles' total. */
interface Group {
  /** The group the items name, or null for the items without one: a group literally named "Other" stays its own. */
  key: string | null;
  name: string;
  colour: string;
  /** The tiles' raw sum, which may pass the largest number (two 1.5e308 items): it is written only while finite. */
  total: number;
  /** The tiles' sum in units of the largest value: the group's area and share, finite whatever the raw sum. */
  units: number;
  face: TileBox;
  head: TileBox | null;
  /** The tiles' sum as written, or null when it passes the largest number. */
  totalText: string | null;
  /** Whether the header writes the total (and with show_share the share) after the name. */
  withTotal: boolean;
  tiles: Tile[];
}

/**
 * The `treemap_chart` widget: one tile per item with a positive value, in delivered order, each as large as its
 * value over the total, squarified into the cell. When any item names a group, the tiles are nested one level by
 * group in first-seen order, a null group under the "Other" of the texts, every tile in its group's colour and
 * without groups in its own; a group names itself over its tiles while its box fits the name. A tile shows its
 * label and, by `value_labels` with the share of `show_share`, its value, where they fit its tile, and it names
 * both in its tooltip whatever it shows. With drill_down a tile is a button that opens the data view with its row
 * picked.
 */
export function TreemapChart({
  payload,
  locale = 'en',
  texts = DEFAULT_WIDGET_TEXTS,
  label: labelProp,
  container,
}: {
  payload: RenderWidgetPayload<TreemapRender, TreemapData>;
  locale?: string;
  texts?: WidgetTexts;
  label?: string;
  container?: HTMLElement | ShadowRoot | null;
}) {
  const { render, data, value_format } = payload;
  const label = labelProp ?? texts.chart;
  // The cell the tiles fill, as it is laid out: no tiles into a box taken out of the page, which measures 0 by 0.
  const [measure, size] = useElementSize();
  // The tiles share the box's own measure, which leaves out the data view button of a chart with drill-down.
  const [measureBox, box] = useElementSize<HTMLDivElement>();
  if (!data) return <WidgetCannotBeShown texts={texts} problem="treemap_chart: no data" />;
  const nonFinite = nonFiniteProblemOf('treemap_chart', payload);
  if (nonFinite) return <WidgetCannotBeShown texts={texts} problem={nonFinite} />;
  const problem = checkTreemap(data);
  if (problem) return <WidgetCannotBeShown texts={texts} problem={problem} />;

  const { items } = data;
  const valueOf = (value: number | null) => formatValue(value, value_format, locale);
  // The shares and the areas go over the largest value, so a total beyond the largest number (two 1.5e308 items)
  // divides by finite numbers only.
  const most = items.reduce((largest, item) => Math.max(largest, item.value ?? 0), 0);
  if (!(most > 0)) return <WidgetEmpty texts={texts} />;
  const unitTotal = items.reduce((sum, item) => sum + (item.value ?? 0) / most, 0);
  const shareOf = (value: number) => value / most / unitTotal;
  const percentOf = (share: number | null) => formatValue(share, { value_type: 'percent' }, locale);
  const shareTextOf = (value: number) => percentOf(shareOf(value));
  // A tile is drawn for a value whose share of the box stays above 0 once scaled: a positive value too small beside
  // the largest (5e-324 beside 1e308) draws no tile, like a 0, and stays in the data view.
  const drawn = (value: number | null): value is number => value !== null && value / most > 0;

  const showShare = render.show_share === true;
  const valueLabels = render.value_labels ?? 'auto';
  // A group writes its raw sum while it is finite, and with show_share its share, which its units give.
  const groupShareOf = (group: { units: number }) => percentOf(group.units / unitTotal);
  const grouped = items.some((item) => item.group !== null);
  const colourOf = (position: number) => PALETTE[position % PALETTE.length];
  const whole: TileBox = { x: 0, y: 0, width: box.width, height: box.height };

  // The tiles, laid out in the measured box: flat by item, or one level deep by group. A value of 0 or null draws
  // no tile and stays in the data view; a group with none left draws nothing either.
  const flat: Tile[] = [];
  const groups: Group[] = [];
  if (grouped) {
    const nested: Pick<Group, 'key' | 'name' | 'colour' | 'total' | 'units' | 'tiles'>[] = [];
    for (const [index, item] of items.entries()) {
      const { value } = item;
      if (!drawn(value)) continue;
      const name = item.group ?? texts.treemap.other;
      let group = nested.find((candidate) => candidate.key === item.group);
      if (!group) {
        group = { key: item.group, name, colour: colourOf(nested.length), total: 0, units: 0, tiles: [] };
        nested.push(group);
      }
      group.total += value;
      group.units += value / most;
      group.tiles.push({ index, label: item.label, value, box: { x: 0, y: 0, width: 0, height: 0 }, colour: group.colour, group: name });
    }
    const faces = squarified(
      nested.map((group) => group.units),
      whole,
    );
    for (const [position, group] of nested.entries()) {
      const face = faces[position];
      // The header band takes its room only while the tiles keep the least tile under it, and the name fits; it
      // writes the group's total (and share) after the name while they fit too.
      const head = face.height >= HEADER + LEAST_TILE && widthOf(group.name) + 2 * PAD <= face.width ? { x: face.x, y: face.y, width: face.width, height: HEADER } : null;
      const totalText = Number.isFinite(group.total) ? valueOf(group.total) : null;
      const headText = [totalText, ...(showShare ? [groupShareOf(group)] : [])].filter((part) => part !== null).join(' ');
      const withTotal = head !== null && headText !== '' && widthOf(`${group.name}, ${headText}`) + 2 * PAD <= face.width;
      const area = head ? { x: face.x, y: face.y + HEADER, width: face.width, height: face.height - HEADER } : face;
      const boxes = squarified(
        group.tiles.map((tile) => tile.value),
        area,
      );
      for (const [at, tile] of group.tiles.entries()) tile.box = boxes[at];
      groups.push({ ...group, face, head, totalText, withTotal });
    }
  } else {
    const positive = items.flatMap((item, index) => (drawn(item.value) ? [{ index, label: item.label, value: item.value }] : []));
    const boxes = squarified(
      positive.map(({ value }) => value),
      whole,
    );
    for (const [position, { index, label: itemLabel, value }] of positive.entries()) {
      flat.push({ index, label: itemLabel, value, box: boxes[position], colour: colourOf(position) });
    }
  }

  // The name of a tile, in its tooltip and to assistive technology: its label, its value, its group and its share,
  // whatever the tile shows of them.
  const nameOf = (tile: Tile) =>
    [`${tile.label}: ${valueOf(tile.value)}`, ...(tile.group ? [tile.group] : []), ...(showShare ? [`${shareTextOf(tile.value)} ${texts.treemap.ofTotal}`] : [])].join(', ');
  const valueTextOf = (tile: Tile) => (showShare ? `${valueOf(tile.value)} ${shareTextOf(tile.value)}` : valueOf(tile.value));

  // The text a tile shows: the label, and the value under it, only where the tile fits them (`auto`); `always`
  // writes both whatever the tile fits (the tile clips), `never` writes neither.
  const textOfTile = (tile: Tile) => {
    if (valueLabels === 'never') return { label: null as string | null, value: null as string | null };
    if (valueLabels === 'always') return { label: tile.label, value: valueTextOf(tile) };
    if (!(widthOf(tile.label) + 2 * PAD <= tile.box.width) || tile.box.height < LINE + 2 * PAD) return { label: null, value: null };
    const valueText = valueTextOf(tile);
    const valueFits = widthOf(valueText) + 2 * PAD <= tile.box.width && tile.box.height >= 2 * LINE + LINE_GAP + 2 * PAD;
    return { label: tile.label, value: valueFits ? valueText : null };
  };

  // The text alternative and the data view: label, group (with groups), value, and with show_share the share.
  const columns = [texts.columns.label, ...(grouped ? [texts.treemap.group] : []), texts.columns.value, ...(showShare ? [texts.treemap.share] : [])];
  const table: ValuesTable = {
    columns,
    rows: items.map((item) => {
      // A null value has no share either, and the share is worked out only when the share column is shown.
      const share = showShare && item.value !== null ? shareOf(item.value) : null;
      return [item.label, ...(grouped ? [item.group] : []), item.value, ...(showShare ? [share] : [])];
    }),
  };
  const valueColumn = grouped ? 2 : 1;
  const shareColumn = showShare ? valueColumn + 1 : -1;
  const format = (value: string | number | null, column: number) => {
    const number = typeof value === 'number' ? value : null;
    if (column === valueColumn) return valueOf(number);
    if (column === shareColumn) return percentOf(number);
    return textOf(value, undefined, locale);
  };

  const place = (tileBox: TileBox) => ({ left: tileBox.x, top: tileBox.y, width: tileBox.width, height: tileBox.height }) as CSSProperties;
  // Nothing is drawn into a box without room (a group the rows before it left none, or an item those rows left none
  // for): no tile, no group face and no group header.
  const hasRoom = (tileBox: TileBox) => tileBox.width > 0 && tileBox.height > 0;

  /** One tile: an image named by its item and value, or with drill-down a button that picks its row. */
  const tileOf = (tile: Tile, onPick: ((row: number) => void) | undefined) => {
    if (!hasRoom(tile.box)) return null;
    const text = textOfTile(tile);
    const name = nameOf(tile);
    const style = { ...place(tile.box), '--tile': tile.colour } as CSSProperties;
    const content =
      text.label === null && text.value === null ? null : (
        <span className={styles.treemapText}>
          {text.label !== null ? (
            <Text typography="label" render={<span />} className={styles.treemapLabel}>
              {text.label}
            </Text>
          ) : null}
          {text.value !== null ? (
            <Text typography="meta" render={<span />} className={styles.treemapValue}>
              {valueOf(tile.value)}
              {showShare ? ' ' : null}
              {showShare ? <span className={styles.treemapShare}>{shareTextOf(tile.value)}</span> : null}
            </Text>
          ) : null}
        </span>
      );
    const share = percentInRange(shareOf(tile.value));
    return onPick ? (
      <button key={tile.index} type="button" className={`${styles.treemapTile} ${styles.treemapButton}`} style={style} title={name} aria-label={name} data-share={share} onClick={() => onPick(tile.index)}>
        {content}
      </button>
    ) : (
      <span key={tile.index} role="img" className={styles.treemapTile} style={style} title={name} aria-label={name} data-share={share}>
        {content}
      </span>
    );
  };

  return (
    <div ref={measure} className={styles.fill} role="figure" aria-label={label}>
      <ChartShell
        drillDown={render.drill_down === true}
        laidOut={isLaidOut(size)}
        table={table}
        label={texts.dataOf(label)}
        texts={texts}
        format={format}
        locale={locale}
        container={container}
        draw={(onPick) => (
          <div ref={measureBox} className={styles.treemapBox} style={TEXT_ROOM}>
            {grouped
              ? groups.map((group) => (
                  <Fragment key={group.key === null ? 'null' : `group:${group.key}`}>
                    {hasRoom(group.face) ? <span aria-hidden="true" className={styles.treemapGroupFace} style={{ ...place(group.face), '--tile': group.colour } as CSSProperties} /> : null}
                    {group.head !== null && hasRoom(group.head) ? (
                      <Text
                        typography="label"
                        render={<span />}
                        className={styles.treemapGroupHead}
                        style={{ ...place(group.head), '--tile': group.colour } as CSSProperties}
                        title={[group.totalText === null ? group.name : `${group.name}: ${group.totalText}`, ...(showShare ? [`${groupShareOf(group)} ${texts.treemap.ofTotal}`] : [])].join(', ')}
                      >
                        {group.name}
                        {group.withTotal ? (
                          <>
                            {', '}
                            {group.totalText !== null ? <span className={styles.treemapValue}>{group.totalText}</span> : null}
                            {showShare && group.totalText !== null ? ' ' : null}
                            {showShare ? <span className={styles.treemapShare}>{groupShareOf(group)}</span> : null}
                          </>
                        ) : null}
                      </Text>
                    ) : null}
                    {group.tiles.map((tile) => tileOf(tile, onPick))}
                  </Fragment>
                ))
              : flat.map((tile) => tileOf(tile, onPick))}
          </div>
        )}
      />
      {/* A text alternative of the delivered values, in delivered order. */}
      <ValuesText caption={label} columns={table.columns} rows={table.rows.map((row) => row.map((value, column) => format(value, column)))} />
    </div>
  );
}
