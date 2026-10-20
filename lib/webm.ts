/**
 * MediaRecorder writes WebM files without a duration, so players show no
 * length and cannot seek. This patches the Segment > Info element of the
 * first chunk to add a Duration, without touching the rest of the file.
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;

interface Element {
  id: number;
  /** Offset of the element's first byte. */
  start: number;
  /** Offset of the element's data. */
  dataStart: number;
  /** -1 when the size is "unknown" (live streams, MediaRecorder clusters). */
  size: number;
  sizeLength: number;
}

function readId(buf: Uint8Array, pos: number): { id: number; length: number } | null {
  const first = buf[pos];
  if (first === undefined) return null;
  let length = 1;
  for (let mask = 0x80; length <= 4 && !(first & mask); mask >>= 1) length++;
  if (length > 4 || pos + length > buf.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + buf[pos + i]!;
  return { id, length };
}

function readSize(buf: Uint8Array, pos: number): { size: number; length: number } | null {
  const first = buf[pos];
  if (first === undefined) return null;
  let length = 1;
  let mask = 0x80;
  for (; length <= 8 && !(first & mask); mask >>= 1) length++;
  if (length > 8 || pos + length > buf.length) return null;
  let value = first & (mask - 1);
  let allOnes = value === mask - 1;
  for (let i = 1; i < length; i++) {
    const byte = buf[pos + i]!;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { size: allOnes ? -1 : value, length };
}

function readElement(buf: Uint8Array, pos: number): Element | null {
  const id = readId(buf, pos);
  if (!id) return null;
  const size = readSize(buf, pos + id.length);
  if (!size) return null;
  return { id: id.id, start: pos, dataStart: pos + id.length + size.length, size: size.size, sizeLength: size.length };
}

function encodeSize(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0]! |= 0x80 >> (length - 1);
  return out;
}

function minSizeLength(value: number): number {
  let length = 1;
  while (value >= 2 ** (7 * length) - 1) length++;
  return length;
}

function readUint(buf: Uint8Array, start: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + buf[start + i]!;
  return v;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/**
 * Returns `head` with a Duration element written into Segment > Info, or null
 * when the structure is not recognised (the caller then keeps the original).
 */
export function patchWebmDurationBytes(head: Uint8Array, durationMs: number): Uint8Array | null {
  const ebml = readElement(head, 0);
  if (!ebml || ebml.id !== ID_EBML || ebml.size < 0) return null;
  const segment = readElement(head, ebml.dataStart + ebml.size);
  if (!segment || segment.id !== ID_SEGMENT) return null;

  const segmentEnd = segment.size < 0 ? head.length : Math.min(head.length, segment.dataStart + segment.size);
  let pos = segment.dataStart;
  let info: Element | null = null;
  while (pos < segmentEnd) {
    const el = readElement(head, pos);
    if (!el || el.size < 0) break;
    if (el.id === ID_INFO) {
      info = el;
      break;
    }
    pos = el.dataStart + el.size;
  }
  if (!info || info.dataStart + info.size > head.length) return null;

  let timecodeScale = 1_000_000;
  const children: Uint8Array[] = [];
  let p = info.dataStart;
  const infoEnd = info.dataStart + info.size;
  while (p < infoEnd) {
    const el = readElement(head, p);
    if (!el || el.size < 0) return null;
    const end = el.dataStart + el.size;
    if (el.id === ID_TIMECODE_SCALE) timecodeScale = readUint(head, el.dataStart, el.size) || timecodeScale;
    if (el.id !== ID_DURATION) children.push(head.subarray(el.start, end));
    p = end;
  }

  const duration = new Uint8Array(11);
  duration.set([0x44, 0x89, 0x88]);
  new DataView(duration.buffer).setFloat64(3, (durationMs * 1_000_000) / timecodeScale);
  children.push(duration);

  const infoData = concat(children);
  const infoEl = concat([
    new Uint8Array([0x15, 0x49, 0xa9, 0x66]),
    encodeSize(infoData.length, Math.max(info.sizeLength, minSizeLength(infoData.length))),
    infoData,
  ]);
  const delta = infoEl.length - (infoEnd - info.start);

  let segmentHeader = head.subarray(segment.start, segment.dataStart);
  if (segment.size >= 0) {
    const idLength = segment.dataStart - segment.sizeLength - segment.start;
    segmentHeader = concat([
      head.subarray(segment.start, segment.start + idLength),
      encodeSize(segment.size + delta, Math.max(segment.sizeLength, minSizeLength(segment.size + delta))),
    ]);
  }

  return concat([
    head.subarray(0, segment.start),
    segmentHeader,
    head.subarray(segment.dataStart, info.start),
    infoEl,
    head.subarray(infoEnd),
  ]);
}

/** Patches the first chunk of a recording; the remaining chunks are unchanged. */
export async function patchWebmDuration(firstChunk: Blob, durationMs: number): Promise<Blob> {
  const headSize = Math.min(firstChunk.size, 256 * 1024);
  const head = new Uint8Array(await firstChunk.slice(0, headSize).arrayBuffer());
  const patched = patchWebmDurationBytes(head, durationMs);
  if (!patched) return firstChunk;
  return new Blob([patched as BlobPart, firstChunk.slice(headSize)], { type: firstChunk.type });
}
