export function pathSegments(path: string): string[] {
  const segments: string[] = [];
  let current = "";
  let escaped = false;

  for (const character of path) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === ".") {
      segments.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  segments.push(current);

  return segments;
}
