/**
 * Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
 *
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 *
 * Header-only image dimension extraction (no deps).
 * Supports PNG, GIF, BMP, WebP (lossy/lossless/extended) and JPEG (SOF scan).
 */
function readU16BE(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!
}

function readU32BE(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
}

function readU16LE(b: Uint8Array, o: number): number {
  return (b[o + 1]! << 8) | b[o]!
}

function readInt32LE(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) | 0
}

export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes
  if (!b || b.length < 24) return null

  // PNG: signature + IHDR (width @16, height @20, big-endian u32)
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return { width: readU32BE(b, 16), height: readU32BE(b, 20) }
  }

  // GIF: "GIF87a"/"GIF89a", logical screen width @6 / height @8 (u16 LE)
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: readU16LE(b, 6), height: readU16LE(b, 8) }
  }

  // BMP: "BM", width @18 / height @22 (i32 LE; height may be negative)
  if (b[0] === 0x42 && b[1] === 0x4d) {
    const width = readInt32LE(b, 18)
    const height = readInt32LE(b, 22)
    if (width > 0 && height !== 0) {
      return { width, height: Math.abs(height) }
    }
  }

  // WebP: "RIFF"...."WEBP"
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
    if (fourcc === 'VP8 ' && b.length >= 30) {
      const width = readU16LE(b, 26) & 0x3fff
      const height = readU16LE(b, 28) & 0x3fff
      if (width && height) return { width, height }
    } else if (fourcc === 'VP8L' && b.length >= 25) {
      const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
      const width = (bits & 0x3fff) + 1
      const height = ((bits >> 14) & 0x3fff) + 1
      if (width && height) return { width, height }
    } else if (fourcc === 'VP8X' && b.length >= 30) {
      const width = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16))
      const height = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16))
      if (width && height) return { width, height }
    }
  }

  // JPEG: scan marker segments after SOI (FFD8) for a SOF frame.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2
    while (offset + 9 <= b.length) {
      if (b[offset] !== 0xff) {
        offset++
        continue
      }
      const marker = b[offset + 1]!
      // Standalone markers (RST0..RST7, SOI, TEM) carry no length.
      if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0xd8 || marker === 0x01) {
        offset += 2
        continue
      }
      const len = readU16BE(b, offset + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = readU16BE(b, offset + 5)
        const width = readU16BE(b, offset + 7)
        if (width && height) return { width, height }
      }
      offset += 2 + len
    }
  }

  return null
}