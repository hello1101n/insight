// WORKAROUND: TanStack Router hands the pathname already decoded; decoding the segment again can throw.
export function alertIdFromPath(pathname: string): string {
  const match = pathname.match(/^\/dashboards\/alerts\/([^/]+)/);
  if (!match || match[1] === "new") return "";

  return match[1];
}
