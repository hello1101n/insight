import {
  ActionHandler,
  ConcurrentMountStrategy,
  ExtensionDomainImplementation,
  ExtensionDomainImplementationFactory,
  MfeHandler,
  MfeHandlerMF,
  createMfeRegistryFactory,
  type ActionPayload,
  type DomainContext,
  type ExtensionDomain,
  type MfeEntryLifecycle,
  type MfeEntryMF,
  type MfManifest,
  type MfeRegistry,
  type MountStrategy,
  type TypeSystemPlugin,
} from '@gears-frontx/mfes';

import { ENTRY_MF_TYPE_ID } from '../contract';
import { WIDGETS_DOMAIN } from '../gts';

/*
 * The registry the dashboard root owns, with the `widgets` domain registered
 * in it (runtime FEATURE "Register the widgets domain"). The domain mounts
 * many extensions at once; each extension's container is a plain element the
 * root places into its cell.
 */

/** A widget entry's lifecycle factory, called once per generated extension so no two extensions share module state. */
export type WidgetEntries = Readonly<Record<string, () => MfeEntryLifecycle>>;

/**
 * Loads each widget entry from its own bundle with the FrontX MF handler
 * (DESIGN §3.3 Widget bundles): the manifest the entry names gives the
 * bundle's address, and every generated extension gets its own evaluation of
 * the bundle and of its shared dependencies. A bundle that fails to load or
 * whose lifecycle throws fails only the cells of that extension, at mount.
 *
 * `entries` is for tests only, where no bundle server exists: an entry listed
 * there loads from the product's own bundle instead, with the widget's CSS
 * left in the page rather than in the widget's shadow root.
 */
export class WidgetEntryHandler extends MfeHandler<MfeEntryMF> {
  private readonly mf = new MfeHandlerMF(ENTRY_MF_TYPE_ID);
  /**
   * The FrontX MF handler keeps loads in a page-wide cache keyed by the id it is given, for the page's life.
   * Generated extension ids are the same in every root that shows a widget, so the key carries this handler's own
   * random token (a counter would repeat across two copies of this module): each root gets its own evaluation of a
   * widget, and a root that shows a widget again reuses its own. Every root adds its own entries, so a product
   * creates its roots once, not per render.
   */
  private readonly scope = globalThis.crypto?.randomUUID?.().replace(/-/g, '') ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  readonly bridgeFactory = this.mf.bridgeFactory;

  constructor(
    private readonly entries: WidgetEntries,
    private readonly bundleOrigins: ReadonlySet<string>,
  ) {
    super(ENTRY_MF_TYPE_ID, 10);
  }

  override attachTypeSystem(typeSystem: TypeSystemPlugin): void {
    super.attachTypeSystem(typeSystem);
    this.mf.attachTypeSystem(typeSystem);
  }

  async load(entry: MfeEntryMF, extensionId: string): Promise<MfeEntryLifecycle> {
    const create = this.entries[entry.id];
    if (create) return create();
    const manifest = (typeof entry.manifest === 'string' ? this.typeSystem?.getSchema(entry.manifest) : entry.manifest) as MfManifest | undefined;
    const publicPath = manifest?.metaData?.publicPath;
    // Module Federation writes "auto" when a build sets no publicPath; it names no address.
    if (typeof publicPath !== 'string' || !publicPath || publicPath === 'auto') throw new Error(`the bundle of entry ${entry.id} has no bundle address: its manifest is missing or has no publicPath`);
    // Every file the handler fetches resolves against the bundle's base: the base itself, the shared modules and the
    // entry's chunks and stylesheets. A shared module or an asset may be written as an absolute address, so each is checked.
    const assets = entry.exposeAssets;
    const files = [
      ...(manifest?.shared ?? []).map((shared) => shared?.chunkPath),
      ...[assets?.js?.sync, assets?.js?.async, assets?.css?.sync, assets?.css?.async].flatMap((list) => (Array.isArray(list) ? list : [])),
    ];
    let base: URL | undefined;
    try {
      base = new URL(String(publicPath), globalThis.document?.baseURI ?? globalThis.location?.href);
    } catch {
      // Left undefined: the check below fails the cell.
    }
    const outside = (address: unknown) => {
      if (typeof address !== 'string') return true;
      try {
        const url = new URL(address, base);
        return (url.protocol !== 'https:' && url.protocol !== 'http:') || !this.bundleOrigins.has(url.origin);
      } catch {
        return true;
      }
    };
    const allowed = [...this.bundleOrigins].join(', ');
    if (!base || outside(base.href)) throw new Error(`the bundle of entry ${entry.id} is served from ${String(publicPath)}, outside the allowed bundle origins (${allowed})`);
    // findIndex, not find: a missing address (undefined) is a stray as well.
    const stray = files.findIndex(outside);
    if (stray !== -1) throw new Error(`the bundle of entry ${entry.id} names ${String(files[stray])}, outside the allowed bundle origins (${allowed})`);
    return this.mf.load(entry, `${extensionId}#root-${this.scope}`);
  }
}

/** What the root observes of the domain: a mount settling, and an unmount of an extension it did not ask to leave. */
export interface DomainEvents {
  mounted(extensionId: string, error?: unknown): void;
  unmounted(extensionId: string): void;
}

class WidgetsDomain extends ExtensionDomainImplementation {
  private readonly strategy: ConcurrentMountStrategy;

  constructor(ctx: DomainContext, containers: Map<string, HTMLElement>, events: DomainEvents) {
    super();
    this.strategy = new ConcurrentMountStrategy(ctx.mounter, {
      create: (extensionId) => {
        const container = document.createElement('div');
        container.dataset.widgetExtension = extensionId;
        // The container fills the cell's slot; the widget inside its shadow root fills the container.
        container.style.cssText = 'display:flex;flex-direction:column;flex:1;min-block-size:0;min-inline-size:0';
        containers.set(extensionId, container);
        return container;
      },
      destroy: (extensionId) => {
        containers.get(extensionId)?.remove();
        containers.delete(extensionId);
      },
    });
    ctx.registerHandler(
      ctx.typeSystem.resolveMountExtActionId(),
      ActionHandler.fromFunction(async (_type, payload) => {
        const subject = (payload as ActionPayload).subject;
        try {
          await this.strategy.mount(payload as ActionPayload);
        } catch (error) {
          events.mounted(subject, error);
          throw error;
        }
        events.mounted(subject);
      }),
    );
    ctx.registerHandler(
      ctx.typeSystem.resolveUnmountExtActionId(),
      ActionHandler.fromFunction(async (_type, payload) => {
        await this.strategy.unmount(payload as ActionPayload);
        events.unmounted((payload as ActionPayload).subject);
      }),
    );
  }

  protected getMountStrategies(): MountStrategy[] {
    return [this.strategy];
  }
}

class WidgetsDomainFactory extends ExtensionDomainImplementationFactory {
  constructor(
    private readonly containers: Map<string, HTMLElement>,
    private readonly events: DomainEvents,
  ) {
    super();
  }

  build(ctx: DomainContext): ExtensionDomainImplementation {
    return new WidgetsDomain(ctx, this.containers, this.events);
  }
}

/** Builds the root's own registry and registers the `widgets` domain in it; throws when the domain is rejected. */
export function createWidgetsRegistry(
  typeSystem: TypeSystemPlugin,
  handler: WidgetEntryHandler,
  containers: Map<string, HTMLElement>,
  events: DomainEvents,
): MfeRegistry {
  const registry = createMfeRegistryFactory().build({ typeSystem, mfeHandlers: [handler] });
  registry.registerDomain(WIDGETS_DOMAIN as unknown as ExtensionDomain, new WidgetsDomainFactory(containers, events));
  return registry;
}
