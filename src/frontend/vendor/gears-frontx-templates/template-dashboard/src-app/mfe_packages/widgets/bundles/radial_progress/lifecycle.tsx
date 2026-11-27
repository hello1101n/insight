import { RadialProgress } from '../../src/cards/RadialProgress';
import { createWidgetLifecycle, type WidgetRenderer } from '../../src/lifecycle';

/** The `radial_progress` widget bundle: one Module Federation remote that exposes this entry's lifecycle. */
export const render: WidgetRenderer = (payload, { locale, container }) => <RadialProgress payload={payload as never} locale={locale} container={container} />;

export default createWidgetLifecycle(render);
