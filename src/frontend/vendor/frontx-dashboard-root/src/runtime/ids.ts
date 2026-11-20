/*
 * The deterministic ids the dashboard root generates: one extension id per
 * cell and per larger view, and one stamped-data id per widget and role
 * (DESIGN §3.1, UUIDv5 namespace constant). A reload gives the same ids; none
 * is persisted.
 */

import { WIDGET_EXT_TYPE_ID } from '../contract';

/** The template's own UUIDv5 namespace, used for extension ids and stamped data ids. */
export const UUID_NAMESPACE = 'b3f7a1c2-4d6e-4f8a-9c1b-3e5d7f9a2b04';

/** The role a widget instance plays in its cell. */
export type Role = 'cell' | 'larger_view';

function sha1(bytes: Uint8Array): Uint8Array {
  const words: number[] = [];
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLength >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32));
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16];
      words[i] = (x << 1) | (x >>> 31);
    }
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let i = 0; i < 80; i++) {
      const [f, k] =
        i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (((a << 5) | (a >>> 27)) + f + e + k + words[i]) >>> 0;
      [e, d, c, b, a] = [d, c, (b << 30) | (b >>> 2), a, t];
    }
    [h0, h1, h2, h3, h4] = [(h0 + a) >>> 0, (h1 + b) >>> 0, (h2 + c) >>> 0, (h3 + d) >>> 0, (h4 + e) >>> 0];
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => outView.setUint32(i * 4, h));
  return out;
}

/** RFC 9562 UUID version 5 of `name` (UTF-8) in `namespace`, lowercase. */
export function uuidv5(name: string, namespace: string = UUID_NAMESPACE): string {
  const ns = namespace.replace(/-/g, '').match(/../g)!.map((byte) => Number.parseInt(byte, 16));
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + nameBytes.length);
  input.set(ns);
  input.set(nameBytes, 16);
  const hash = sha1(input).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const nameOf = (...parts: string[]) => parts.map((part) => part.toLowerCase()).join('|');

/** `<widget_ext type>~<UUIDv5(namespace, widget id | role | entry id)>`. */
export const extensionIdOf = (widgetId: string, role: Role, entryId: string) => `${WIDGET_EXT_TYPE_ID}${uuidv5(nameOf(widgetId, role, entryId))}`;

/** `<data type>~<UUIDv5(namespace, widget id | role)>`; the data type id ends with `~`. */
export const stampIdOf = (dataTypeId: string, widgetId: string, role: Role) => `${dataTypeId}${uuidv5(nameOf(widgetId, role))}`;

/** `<render type>~<UUIDv5(namespace, widget id | role | render)>`; the last name part keeps it apart from the data stamp. */
export const renderStampIdOf = (renderTypeId: string, widgetId: string, role: Role) => `${renderTypeId}${uuidv5(nameOf(widgetId, role, 'render'))}`;
