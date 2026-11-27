import { FunnelChart } from '../../src/chart/FunnelChart';
import { createWidgetLifecycle, type WidgetRenderer } from '../../src/lifecycle';

/** The `funnel_chart` widget bundle: one Module Federation remote that exposes this entry's lifecycle. */
export const render: WidgetRenderer = (payload, { locale, container }) => <FunnelChart payload={payload as never} locale={locale} container={container} />;

export default createWidgetLifecycle(render);
