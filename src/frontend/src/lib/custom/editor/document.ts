export type Path = readonly (string | number)[];

export interface Held {
  document: Record<string, unknown>;
  text: string;
  unparsed?: string;
}

export function written(document: Record<string, unknown>): string {
  return JSON.stringify(document, null, 2);
}

export function hold(document: Record<string, unknown> = {}): Held {
  return { document, text: written(document) };
}

export function change(held: Held, path: Path, value: unknown): Held {
  const document = put(held.document, path, value) as Record<string, unknown>;

  return { document, text: written(document) };
}

export function retype(held: Held, text: string): Held {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return { ...held, text, unparsed: (error as Error).message };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...held, text, unparsed: "A definition is an object." };
  }

  return { document: parsed as Record<string, unknown>, text };
}

export function sendable(held: Held): boolean {
  return held.unparsed === undefined;
}

export function brokenLine(unparsed: string | undefined): number | undefined {
  const named = unparsed?.match(/line (\d+)/);
  return named ? Number(named[1]) : undefined;
}

export function read(document: unknown, path: Path): unknown {
  return path.reduce<unknown>((at, segment) => {
    if (at === null || typeof at !== "object") return undefined;
    if (typeof segment === "number") {
      return Array.isArray(at) ? at[segment] : undefined;
    }
    return (at as Record<string, unknown>)[segment];
  }, document);
}

function put(at: unknown, path: Path, value: unknown): unknown {
  const [segment, ...rest] = path;
  if (segment === undefined) return value;

  if (typeof segment === "number") {
    const list = Array.isArray(at) ? [...at] : [];
    const next = put(list[segment], rest, value);
    if (rest.length === 0 && value === undefined) {
      list.splice(segment, 1);
      return list;
    }
    list[segment] = next;
    return list;
  }

  const record: Record<string, unknown> =
    at !== null && typeof at === "object" && !Array.isArray(at)
      ? { ...(at as Record<string, unknown>) }
      : {};
  const next = put(record[segment], rest, value);
  const emptied = value === undefined && (rest.length === 0 || bare(next));
  if (emptied) {
    delete record[segment];
    return record;
  }
  record[segment] = next;
  return record;
}

function bare(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}
