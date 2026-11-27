import { RadarChart } from '../../src/chart/RadarChart';
import { createWidgetLifecycle, type WidgetRenderer } from '../../src/lifecycle';

/** The `radar_chart` widget bundle: one Module Federation remote that exposes this entry's lifecycle. */
export const render: WidgetRenderer = (payload, { locale, container }) => <RadarChart payload={payload as never} locale={locale} container={container} />;

export default createWidgetLifecycle(render);
