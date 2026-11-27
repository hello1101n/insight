import { CartesianChart } from '../../src/chart/CartesianChart';
import { createWidgetLifecycle, type WidgetRenderer } from '../../src/lifecycle';

/** The `cartesian_chart` widget bundle: one Module Federation remote that exposes this entry's lifecycle. */
export const render: WidgetRenderer = (payload, { locale, container }) => <CartesianChart payload={payload as never} locale={locale} container={container} />;

export default createWidgetLifecycle(render);
