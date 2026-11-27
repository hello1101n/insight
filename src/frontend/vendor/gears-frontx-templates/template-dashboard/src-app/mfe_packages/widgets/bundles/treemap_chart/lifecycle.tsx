import { TreemapChart } from '../../src/chart/TreemapChart';
import { createWidgetLifecycle, type WidgetRenderer } from '../../src/lifecycle';

/** The `treemap_chart` widget bundle: one Module Federation remote that exposes this entry's lifecycle. */
export const render: WidgetRenderer = (payload, { locale, container }) => <TreemapChart payload={payload as never} locale={locale} container={container} />;

export default createWidgetLifecycle(render);
