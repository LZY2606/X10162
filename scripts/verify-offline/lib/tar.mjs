/**
 * Minimal reader for POSIX ustar/npm tarballs. Only what package-content
 * verification needs: file names, sizes and content hashes. No external tar
 * binary is required, so the offline check stays hermetic.
 */

export function listTarEntries(buffer) {
  const entries = []
  let offset = 0
  let paxPath = null

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break

    const name = readString(header, 0, 100)
    const size = parseOctal(header, 124, 12)
    const typeFlag = String.fromCharCode(header[156])
    const prefix = readString(header, 345, 155)
    offset += 512

    const content = buffer.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512

    if (typeFlag === 'x' || typeFlag === 'g') {
      // PAX extended header: parse "path=..." records used for long names.
      const text = content.toString('utf8')
      const match = text.match(/(?:^|\n)\d+ path=([^\n]+)/)
      if (match) paxPath = match[1]
      continue
    }

    if (typeFlag === '0' || typeFlag === '\0') {
      const entryName = paxPath ?? (prefix ? `${prefix}/${name}` : name)
      paxPath = null
      entries.push({ name: entryName.replace(/^package\//, ''), content })
    }
  }

  return entries
}

function readString(buffer, start, length) {
  return buffer
    .subarray(start, start + length)
    .toString('utf8')
    .replace(/\0.*$/, '')
}

function parseOctal(buffer, start, length) {
  const text = readString(buffer, start, length).trim()
  return text ? parseInt(text, 8) : 0
}
