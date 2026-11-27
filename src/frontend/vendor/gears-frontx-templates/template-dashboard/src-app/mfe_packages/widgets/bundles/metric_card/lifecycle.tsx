import { MetricCard } from '../../src/cards/MetricCard';
import { createWidgetLifecycle, type WidgetRenderer } from '../../src/lifecycle';

/** The `metric_card` widget bundle: one Module Federation remote that exposes this entry's lifecycle. */
export const render: WidgetRenderer = (payload, { locale }) => <MetricCard payload={payload as never} locale={locale} />;

export default createWidgetLifecycle(render);
