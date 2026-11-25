export interface Typed {
  text: string;
  start: number;
  end: number;
}

const INDENT = "  ";

export function indent(text: string, start: number, end: number): Typed {
  if (start === end || !text.slice(start, end).includes("\n")) {
    const next = text.slice(0, start) + INDENT + text.slice(end);
    return {
      text: next,
      start: start + INDENT.length,
      end: start + INDENT.length,
    };
  }

  const [from, to] = lineSpan(text, start, end);
  const lines = text.slice(from, to).split("\n");
  const shifted = lines.map((line) => INDENT + line).join("\n");
  const next = text.slice(0, from) + shifted + text.slice(to);

  return { text: next, start: from, end: from + shifted.length };
}

export function outdent(text: string, start: number, end: number): Typed {
  const [from, to] = lineSpan(text, start, end);
  const lines = text.slice(from, to).split("\n");
  const shifted = lines
    .map((line) => (line.startsWith(INDENT) ? line.slice(INDENT.length) : line))
    .join("\n");
  const next = text.slice(0, from) + shifted + text.slice(to);
  const taken = lines[0]?.startsWith(INDENT) ? INDENT.length : 0;

  return {
    text: next,
    start: Math.max(from, start - taken),
    end: from + shifted.length,
  };
}

export function newline(text: string, start: number, end: number): Typed {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lead = text.slice(lineStart, start).match(/^[ \t]*/)?.[0] ?? "";
  const inserted = "\n" + lead;
  const next = text.slice(0, start) + inserted + text.slice(end);
  const caret = start + inserted.length;

  return { text: next, start: caret, end: caret };
}

function lineSpan(text: string, start: number, end: number): [number, number] {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const after = text.indexOf("\n", Math.max(end - 1, start));
  const to = after === -1 ? text.length : after;

  return [from, to];
}
