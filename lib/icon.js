'use strict'

const { deflateSync } = require('zlib')

/** Minimal RGBA PNG encoder — avoids a canvas/image dependency for tray icons. */
function buildPng(width, height, pixels) {
  const tbl = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    tbl[n] = c
  }
  const crc = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = tbl[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
  const chunk = (type, data) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(data.length)
    const t = Buffer.from(type, 'ascii')
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(Buffer.concat([t, data])))
    return Buffer.concat([l, t, data, cr])
  }
  const rows = []
  for (let y = 0; y < height; y++) {
    rows.push(0)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      rows.push(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3])
    }
  }
  const hdr = Buffer.alloc(13)
  hdr.writeUInt32BE(width, 0); hdr.writeUInt32BE(height, 4)
  hdr[8] = 8; hdr[9] = 6 // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', hdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const STATUS_RGB = {
  current: [34, 197, 94],
  behind:  [239, 68, 68],
  error:   [245, 158, 11],
  idle:    [148, 163, 184]
}

/** 32px git-branch glyph on a dark rounded square, tinted by status. */
function trayIconBuffer(status) {
  const [sr, sg, sb] = STATUS_RGB[status] || STATUS_RGB.idle
  const S = 32, rad = 6
  const px = new Uint8Array(S * S * 4)

  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || x >= S || y < 0 || y >= S) return
    const i = (y * S + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a
  }

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let inside = true
      if      (x < rad    && y < rad)    inside = (x - rad) ** 2         + (y - rad) ** 2         < rad * rad
      else if (x >= S-rad && y < rad)    inside = (x - (S - rad - 1)) ** 2 + (y - rad) ** 2         < rad * rad
      else if (x < rad    && y >= S-rad) inside = (x - rad) ** 2         + (y - (S - rad - 1)) ** 2 < rad * rad
      else if (x >= S-rad && y >= S-rad) inside = (x - (S - rad - 1)) ** 2 + (y - (S - rad - 1)) ** 2 < rad * rad
      if (inside) set(x, y, 15, 23, 42)
      else        set(x, y, 0, 0, 0, 0)
    }
  }

  const dot = (cx, cy, r) => {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (dx * dx + dy * dy <= r * r) set(cx + dx, cy + dy, sr, sg, sb)
  }
  const line = (x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1
    const steps = Math.max(Math.abs(dx), Math.abs(dy))
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x1 + dx * i / steps)
      const y = Math.round(y1 + dy * i / steps)
      set(x, y, sr, sg, sb); set(x + 1, y, sr, sg, sb)
    }
  }

  line(10, 13, 10, 20)   // trunk
  line(10, 18, 22, 10)   // branch
  dot(10, 9, 3); dot(10, 23, 3); dot(22, 9, 3)

  return buildPng(S, S, px)
}

module.exports = { buildPng, trayIconBuffer, STATUS_RGB }
