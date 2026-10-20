import { describe, expect, it } from 'vitest';
import { patchWebmDurationBytes } from '@/lib/webm';

const bytes = (...parts: (number[] | Uint8Array)[]) => new Uint8Array(parts.flatMap((p) => [...p]));

/** Minimal file shaped like MediaRecorder output: EBML header, unknown-size Segment, Info, Tracks, Cluster. */
function sampleWebm(withDuration = false): Uint8Array {
  const timecodeScale = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]; // 1,000,000
  const muxingApp = [0x4d, 0x80, 0x86, ...'Chrome'.split('').map((c) => c.charCodeAt(0))];
  const oldDuration = withDuration ? [0x44, 0x89, 0x84, 0x00, 0x00, 0x00, 0x00] : [];
  const infoData = [...timecodeScale, ...muxingApp, ...oldDuration];
  return bytes(
    [0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01], // EBML { EBMLVersion 1 }
    [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], // Segment, unknown size
    [0x15, 0x49, 0xa9, 0x66, 0x80 | infoData.length, ...infoData],
    [0x16, 0x54, 0xae, 0x6b, 0x82, 0xae, 0x80], // Tracks { TrackEntry {} }
    [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7, 0x81, 0x00], // Cluster
  );
}

function findDuration(buf: Uint8Array): number | null {
  for (let i = 0; i + 11 <= buf.length; i++) {
    if (buf[i] === 0x44 && buf[i + 1] === 0x89 && buf[i + 2] === 0x88) {
      return new DataView(buf.buffer, buf.byteOffset + i + 3, 8).getFloat64(0);
    }
  }
  return null;
}

describe('patchWebmDurationBytes', () => {
  it('adds a Duration element to Segment > Info', () => {
    const input = sampleWebm();
    const out = patchWebmDurationBytes(input, 83_250)!;
    expect(out).not.toBeNull();
    expect(out.length).toBe(input.length + 11);
    expect(findDuration(out)).toBe(83_250);
    // Info size grew by 11 bytes.
    const infoAt = out.findIndex((_, i) => out[i] === 0x15 && out[i + 1] === 0x49 && out[i + 2] === 0xa9 && out[i + 3] === 0x66);
    expect(out[infoAt + 4]! & 0x7f).toBe((input[infoAt + 4]! & 0x7f) + 11);
    // Everything after Info is untouched.
    expect([...out.slice(-22)]).toEqual([...input.slice(-22)]);
  });

  it('replaces an existing Duration', () => {
    const out = patchWebmDurationBytes(sampleWebm(true), 5000)!;
    expect(findDuration(out)).toBe(5000);
    expect(out.length).toBe(sampleWebm(true).length - 7 + 11);
  });

  it('returns null for data that is not WebM', () => {
    expect(patchWebmDurationBytes(new Uint8Array([1, 2, 3, 4]), 1000)).toBeNull();
  });
});
