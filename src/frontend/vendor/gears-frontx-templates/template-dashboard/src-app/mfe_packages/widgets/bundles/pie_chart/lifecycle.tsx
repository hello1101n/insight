import { PieChart } from '../../src/chart/PieChart';
import { createWidgetLifecycle, type WidgetRenderer } from '../../src/lifecycle';

/** The `pie_chart` widget bundle: one Module Federation remote that exposes this entry's lifecycle. */
export const render: WidgetRenderer = (payload, { locale, container }) => <PieChart payload={payload as never} locale={locale} container={container} />;

export default createWidgetLifecycle(render);
