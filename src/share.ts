// Shareable rigs: the whole project travels in the URL's fragment (#rig=…), deflated and base64url-encoded.
// A fragment is never sent to the server, so a shared rig is seen only by whoever opens the link.

const toBase64Url = (bytes: Uint8Array) => {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const fromBase64Url = (text: string) => {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
const pump = async (bytes: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> }) =>
  new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer())

/** Project JSON → compact code. 'z' = deflated, 'j' = plain (for a browser without CompressionStream). */
export async function encodeRig(json: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(JSON.parse(json))) // re-stringify: drops the pretty-printing
  if (typeof CompressionStream === 'undefined') return `j${toBase64Url(bytes)}`
  return `z${toBase64Url(await pump(bytes, new CompressionStream('deflate-raw')))}`
}

export async function decodeRig(code: string): Promise<string> {
  const bytes = fromBase64Url(code.slice(1))
  if (code[0] === 'j') return new TextDecoder().decode(bytes)
  if (code[0] !== 'z') throw new Error('Unknown link format')
  return new TextDecoder().decode(await pump(bytes, new DecompressionStream('deflate-raw')))
}

/** The rig code in a URL fragment, if there is one. */
export const rigInHash = (hash: string) => hash.match(/[#&]rig=([A-Za-z0-9_-]+)/)?.[1]

export async function shareUrl(json: string, base: string): Promise<string> {
  return `${base}#rig=${await encodeRig(json)}`
}
