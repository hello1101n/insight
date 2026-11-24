import type { RenderWidgetPayload } from '@gears-frontx/frontx-dashboard-root/contract';

import { isCompact, useElementSize } from '../chart/size';
import { formatValue, isOutsideRange, nonFiniteProblemOf, percentInRange, percentOfShare, progressOf } from '../format';
import { DEFAULT_WIDGET_TEXTS, WidgetCannotBeShown, WidgetEmpty, type WidgetTexts } from '../states';
import { fitCentreLines, fitLine, LINE_HEIGHT, useMeasuredLines } from '../textFit';
import type { RadialProgressData, RadialProgressRender } from '../types';
import styles from '../widgets.module.css';

// The ring is drawn in a square of the cell's shorter side; before the first measurement (and in a test document,
// which measures nothing) it is drawn as in a square of this side.
const FALLBACK_SIDE = 200;
// The ring's width as a share of its outer radius, within a floor and a ceiling in pixels, and the room the goal tick
// reaches past the ring on each side.
const RING_SHARE = 0.18;
const RING_MIN = 6;
const RING_MAX = 20;
const TICK_OVERHANG = 3;
// The centre text sizes: the main number, the second line of `both`, the caption. The shared text fit sizes them to
// the hole by their measured widths and leaves a line out under its readable floor.
const MAIN_SIZE = 32;
const SECOND_SIZE = 14;
const CAPTION_SIZE = 12;
// The room between the ring and a caption that stands under it.
const CAPTION_GAP = 4;

/** The ring's own check of its data: the problem, or null. A null `current` or `target` is no problem: the ring is empty. */
export function checkRadialProgress(data: RadialProgressData): string | null {
  if (data.target !== null && data.target <= 0) return 'radial_progress: data.target is not above 0';
  if (data.current !== null && data.current < 0) return 'radial_progress: data.current is below 0';
  return null;
}

/**
 * The `radial_progress` widget: one ring filling by `current` over `target`, full when `current` reaches or exceeds
 * `target`, with the percent, the value or both in its hole and an optional goal tick. It is a progress bar for
 * assistive technology: named by the cell's label, its value text says the percent, the current and target values,
 * whether the current value is over the target, and the goal.
 */
export function RadialProgress({
  payload,
  locale = 'en',
  texts = DEFAULT_WIDGET_TEXTS,
  label,
}: {
  payload: RenderWidgetPayload<RadialProgressRender, RadialProgressData>;
  locale?: string;
  texts?: WidgetTexts;
  label?: string;
  container?: HTMLElement | ShadowRoot | null;
}) {
  const { render, data, value_format } = payload;
  const [measure, { width, height }] = useElementSize();
  // The drawn centre lines are measured after each drawing, and sized again by their measured widths.
  const [svg, measured] = useMeasuredLines<SVGSVGElement>();
  if (!data) return <WidgetCannotBeShown texts={texts} problem="radial_progress: no data" />;
  const nonFinite = nonFiniteProblemOf('radial_progress', payload);
  if (nonFinite) return <WidgetCannotBeShown texts={texts} problem={nonFinite} />;
  const problem = checkRadialProgress(data);
  if (problem) return <WidgetCannotBeShown texts={texts} problem={problem} />;
  // A ring with no current value or no target has nothing to fill, as a data type's empty condition.
  if (data.current === null || data.target === null) return <WidgetEmpty texts={texts} />;

  // A negative zero reads as 0.
  const current = data.current || 0;
  const { target } = data;
  // Both finite, `target` above 0: the ratio is finite or, beyond the largest number, an infinity the text leaves out.
  const ratio = current / target;
  // Below reached the ring never closes, so the drawing, `aria-valuenow` and the text agree it is not reached.
  const { reached, over, filled } = progressOf(ratio);
  // The percent is rounded down from the share snapped by the shared helper, so an exact share (29 of 100) is not shown
  // one lower through the error of binary arithmetic; a percent below reached never rounds up to 100%.
  const rounded = Math.floor(percentOfShare(ratio));
  const percent = formatValue((reached ? rounded : Math.min(rounded, 99)) / 100, { value_type: 'percent', decimals: 0 }, locale);
  const value = formatValue(current, value_format, locale);
  const goal = typeof data.goal === 'number' ? { value: data.goal || 0, share: data.goal / target } : null;
  const goalAt = goal && percentInRange(goal.share);
  const goalOutside = goal !== null && isOutsideRange(goal.share);
  const goalText = goal ? `${render.goal_label ?? texts.radial.goal}: ${formatValue(goal.value, value_format, locale)}${goalOutside ? `, ${texts.radial.goalOutside}` : ''}` : '';
  const valueText = [percent, `${value} ${texts.radial.of} ${formatValue(target, value_format, locale)}`, over ? texts.radial.overTarget : '', goalText].filter(Boolean).join(', ');

  const display = render.display ?? 'percent';
  const main = display === 'value' ? value : percent || value;
  const second = display === 'both' && main === percent ? value : '';
  // In a low cell the caption is left out, so the numbers keep the hole.
  const caption = isCompact(height) ? '' : (render.center_label ?? '');

  const side = Math.min(width, height) || FALLBACK_SIDE;
  const centre = side / 2;
  const outer = centre - TICK_OVERHANG - 1;
  const ring = Math.max(RING_MIN, Math.min(RING_MAX, outer * RING_SHARE));
  const hole = outer - ring;
  // A body too small for the ring draws nothing in it; the value text still says everything.
  const drawn = outer > ring;
  const lines = drawn
    ? fitCentreLines(
        hole,
        [
          { role: 'main', text: main, size: MAIN_SIZE, className: styles.radialMain },
          { role: 'second', text: second, size: SECOND_SIZE, className: styles.radialSecond },
          { role: 'caption', text: caption, size: CAPTION_SIZE, className: styles.radialCaption },
        ],
        measured,
      )
    : [];
  // A caption the hole cannot fit stands under the ring when the cell is taller than the ring by its line: a narrow
  // high cell, whose hole is small for its width. The ring keeps the square of the cell's width.
  const captionLine = { role: 'caption', text: caption, size: CAPTION_SIZE, className: styles.radialCaption };
  const under =
    drawn && caption !== '' && width > 0 && height > 0 && !lines.some((line) => line.role === 'caption') ? fitLine(side, captionLine, measured) : null;
  const below = under !== null && height - side >= CAPTION_GAP + under.size * LINE_HEIGHT ? under : null;
  const drawnHeight = below ? side + CAPTION_GAP + below.size * LINE_HEIGHT : side;
  const block = lines.reduce((total, line) => total + line.size * LINE_HEIGHT, 0);
  // The goal tick crosses the ring, clockwise from the top; a goal outside the ring stands at its nearer end.
  const tick = goalAt === null ? null : ((goalAt / 100) * 2 - 0.5) * Math.PI;
  const at = (radius: number, angle: number) => ({ x: centre + radius * Math.cos(angle), y: centre + radius * Math.sin(angle) });

  return (
    <div
      ref={measure}
      className={styles.radial}
      role="progressbar"
      aria-label={label ?? texts.radial.name}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={filled}
      aria-valuetext={valueText}
      title={goalText || undefined}
    >
      <svg ref={svg} className={styles.radialRing} viewBox={`0 0 ${side} ${drawnHeight}`} aria-hidden>
        {drawn ? <circle className={styles.radialTrack} cx={centre} cy={centre} r={outer - ring / 2} strokeWidth={ring} /> : null}
        {/* The fill runs clockwise from the top over the share of a ring of path length 100. */}
        {drawn ? (
          <circle
            className={styles.radialFill}
            cx={centre}
            cy={centre}
            r={outer - ring / 2}
            strokeWidth={ring}
            pathLength={100}
            strokeDasharray={`${filled} 100`}
            transform={`rotate(-90 ${centre} ${centre})`}
          />
        ) : null}
        {!drawn || tick === null ? null : (
          <line className={styles.radialGoal} x1={at(Math.max(0, hole - TICK_OVERHANG), tick).x} y1={at(Math.max(0, hole - TICK_OVERHANG), tick).y} x2={at(outer + TICK_OVERHANG, tick).x} y2={at(outer + TICK_OVERHANG, tick).y} />
        )}
        {lines.map((line, index) => {
          const before = lines.slice(0, index).reduce((total, item) => total + item.size * LINE_HEIGHT, 0);
          return (
            <text key={line.role} data-role={line.role} className={line.className} x={centre} y={centre - block / 2 + before + (line.size * LINE_HEIGHT) / 2} textAnchor="middle" dominantBaseline="central" fontSize={line.size}>
              {line.text}
            </text>
          );
        })}
        {below ? (
          <text
            data-role={below.role}
            className={below.className}
            x={centre}
            y={side + CAPTION_GAP + (below.size * LINE_HEIGHT) / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={below.size}
          >
            {below.text}
          </text>
        ) : null}
      </svg>
    </div>
  );
}
