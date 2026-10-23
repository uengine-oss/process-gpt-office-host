// The IPC wire format shared by both shims: JSON with binary values tagged, since
// Electron IPC carries ArrayBuffer / Uint8Array (document bytes) natively.
const toB64 = (u8) => {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64')
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(s)
}
const fromB64 = (b64) => {
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64')
  const s = atob(b64)
  const u8 = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i)
  return u8
}

export function encode(value) {
  if (value instanceof ArrayBuffer) return { __bin: 'ab', b64: toB64(new Uint8Array(value)) }
  if (ArrayBuffer.isView(value)) {
    return { __bin: 'u8', b64: toB64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) }
  }
  if (value instanceof Map) return { __map: [...value].map(([k, v]) => [encode(k), encode(v)]) }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(encode)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) if (typeof v !== 'function') out[k] = encode(v)
    return out
  }
  return value
}

export function decode(value) {
  if (Array.isArray(value)) return value.map(decode)
  if (value && typeof value === 'object') {
    if (value.__bin) {
      const u8 = fromB64(value.b64)
      return value.__bin === 'ab' ? u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) : u8
    }
    if (value.__map) return new Map(value.__map.map(([k, v]) => [decode(k), decode(v)]))
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = decode(v)
    return out
  }
  return value
}
