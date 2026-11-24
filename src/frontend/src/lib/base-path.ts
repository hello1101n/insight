export function servingBasepath(baseURI: string = document.baseURI): string {
  return new URL(baseURI).pathname;
}
