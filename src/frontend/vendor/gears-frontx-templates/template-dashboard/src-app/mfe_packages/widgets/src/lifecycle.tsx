import { Component, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ActionHandler, ChildMfeBridge, MfeEntryLifecycle } from '@gears-frontx/mfes';
import kitThemeCss from '@gears-frontx/ui-kit/theme.css?inline';
import {
  intlLocaleOf,
  kitScopeOf,
  LANGUAGE_PROPERTY_ID,
  RENDER_WIDGET_ACTION_ID,
  THEME_PROPERTY_ID,
  type RenderWidgetPayload,
} from '@gears-frontx/frontx-dashboard-root/contract';

import { DEFAULT_WIDGET_TEXTS, WidgetCannotBeShown } from './states';
import styles from './widgets.module.css';

/*
 * The MFE lifecycle every catalog widget entry shares (widget contract
 * FEATURE, "Entry declaration" and "Widget-author obligations"): it mounts the
 * widget into the shadow root the registry gives it, registers the
 * `render_widget` handler before `mount` resolves, follows the theme and
 * language shared properties, and resolves each `render_widget` as soon as it
 * holds the payload, before drawing.
 */

/** What a widget renderer gets besides its payload. */
export interface WidgetContext {
  /** The host language. */
  locale: string;
  /**
   * An element inside this widget's shadow root that carries the kit theme
   * scope: kit overlays (Dialog, Tooltip, Select, Popover, DropdownMenu)
   * open here, so they keep the widget's styles and theme.
   */
  container: HTMLElement | null;
}

export type WidgetRenderer = (payload: RenderWidgetPayload, context: WidgetContext) => ReactNode;

/**
 * The kit's design tokens, for this widget's shadow root: document styles stop
 * at the shadow boundary, and a widget bundle cannot assume which host page
 * loads it. The kit declares its base tokens on `:root`, which matches nothing
 * inside a shadow root, so they move to `:host`; the light and dark blocks
 * already match the widget root's `data-theme`. The widget's own CSS and the
 * kit component CSS it uses come with its bundle: the FrontX MF handler puts
 * the entry's stylesheets into the same shadow root.
 */
const KIT_TOKENS = kitThemeCss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/:root\b((?:\[[^\]]*\]|:not\([^()]*\))*)/g, (_match, tail: string) => (tail ? `:host(${tail})` : ':host'));

class Store<T> {
  private value: T;
  private readonly listeners = new Set<() => void>();
  constructor(value: T) {
    this.value = value;
  }
  get = () => this.value;
  set(value: T) {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/**
 * Contains a widget that throws while drawing: its area shows the widget's own cannot-be-shown state and the
 * cell frame stays (widget contract FEATURE, widget-author obligations). A new payload draws again.
 */
class DrawingBoundary extends Component<{ payload: unknown; children: ReactNode }, { failed: string | null; payload?: unknown }> {
  state: { failed: string | null; payload?: unknown } = { failed: null };
  // The text is taken once, safely: any thrown value, undefined or one whose toString throws, still shows the state.
  static getDerivedStateFromError(failed: unknown) {
    let text = 'unprintable error';
    try {
      text = String(failed);
    } catch {
      // Kept as unprintable.
    }
    return { failed: text };
  }
  static getDerivedStateFromProps(props: { payload: unknown }, state: { payload?: unknown }) {
    return props.payload === state.payload ? null : { failed: null, payload: props.payload };
  }
  render() {
    if (this.state.failed !== null) return <WidgetCannotBeShown texts={DEFAULT_WIDGET_TEXTS} problem={`drawing failed: ${this.state.failed}`} />;
    return this.props.children;
  }
}

/** Calls the renderer inside the boundary, so a renderer that throws on its payload is contained as well. */
function Drawn({ render, payload, context }: { render: WidgetRenderer; payload: RenderWidgetPayload; context: WidgetContext }) {
  return <>{render(payload, context)}</>;
}

function WidgetHost({ payload, theme, language, render }: { payload: Store<RenderWidgetPayload | undefined>; theme: Store<string | undefined>; language: Store<string | undefined>; render: WidgetRenderer }) {
  const current = useSyncExternalStore(payload.subscribe, payload.get);
  const scope = kitScopeOf(useSyncExternalStore(theme.subscribe, theme.get));
  const locale = intlLocaleOf(useSyncExternalStore(language.subscribe, language.get));
  const [overlays, setOverlays] = useState<HTMLElement | null>(null);
  return (
    <div data-theme={scope} lang={locale} className={styles.widgetRoot}>
      {current ? (
        <DrawingBoundary payload={current}>
          <Drawn render={render} payload={current} context={{ locale, container: overlays }} />
        </DrawingBoundary>
      ) : null}
      {/* Kit overlays open here, inside the shadow root and the theme scope. gears-frontx#763 adds PortalContainerProvider /
          usePortalContainer() to ui-kit 0.6.0; an explicit `container` keeps winning over it, so this stays valid after that. */}
      <div ref={setOverlays} data-theme={scope} />
    </div>
  );
}

/** One lifecycle per generated extension: the entry's factory calls this for each, so no two widgets share state. */
export function createWidgetLifecycle(render: WidgetRenderer): MfeEntryLifecycle {
  const payload = new Store<RenderWidgetPayload | undefined>(undefined);
  const theme = new Store<string | undefined>(undefined);
  const language = new Store<string | undefined>(undefined);
  let root: Root | undefined;
  // The bridge the handler is registered on. The FrontX MF handler keeps one lifecycle per extension id for the page's
  // life, and an extension registered again (a dashboard left and opened again) comes with a new bridge.
  let registeredOn: ChildMfeBridge | undefined;
  let unsubscribe: (() => void)[] = [];

  return {
    mount(container: Element | ShadowRoot, bridge: ChildMfeBridge) {
      if (registeredOn !== bridge) {
        // Once per bridge: a bridge keeps the handler across unmounts and hands it to the next mount.
        bridge.registerActionHandler(
          RENDER_WIDGET_ACTION_ID,
          // A plain handler object: the bridge only calls `handleAction`, so the widget bundle carries no FrontX runtime.
          { handleAction: async (_type, received) => payload.set(received as unknown as RenderWidgetPayload) } satisfies ActionHandler,
        );
        registeredOn = bridge;
      }
      theme.set(bridge.getProperty(THEME_PROPERTY_ID)?.value as string | undefined);
      language.set(bridge.getProperty(LANGUAGE_PROPERTY_ID)?.value as string | undefined);
      // A mount after a failed one comes with no unmount between them: drop the earlier subscriptions and React root first.
      for (const stop of unsubscribe) stop();
      root?.unmount();
      payload.set(undefined);
      unsubscribe = [
        bridge.subscribeToProperty(THEME_PROPERTY_ID, (property) => theme.set(property.value as string)),
        bridge.subscribeToProperty(LANGUAGE_PROPERTY_ID, (property) => language.set(property.value as string)),
      ];
      // `:scope` matches nothing on a shadow root, so the root's own children are looked at instead.
      if (!Array.from(container.children).some((child) => child.matches('style[data-kit-tokens]'))) {
        const tokens = document.createElement('style');
        tokens.dataset.kitTokens = '';
        tokens.textContent = KIT_TOKENS;
        container.prepend(tokens);
      }
      root = createRoot(container);
      root.render(<WidgetHost payload={payload} theme={theme} language={language} render={render} />);
    },
    unmount() {
      // A remount shows nothing until the root sends its next render_widget, never the last mount's payload.
      payload.set(undefined);
      for (const stop of unsubscribe) stop();
      unsubscribe = [];
      root?.unmount();
      root = undefined;
    },
  };
}
