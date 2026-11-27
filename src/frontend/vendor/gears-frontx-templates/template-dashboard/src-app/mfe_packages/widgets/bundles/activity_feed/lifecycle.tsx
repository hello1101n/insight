import { ActivityFeed } from '../../src/cards/ActivityFeed';
import { createWidgetLifecycle, type WidgetRenderer } from '../../src/lifecycle';

/** The `activity_feed` widget bundle: one Module Federation remote that exposes this entry's lifecycle. */
export const render: WidgetRenderer = (payload, { locale, container }) => <ActivityFeed payload={payload as never} locale={locale} container={container} />;

export default createWidgetLifecycle(render);
