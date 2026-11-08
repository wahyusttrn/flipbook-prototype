// Unguessable public slug, e.g. "k8Fq2xLm9a". No look-alike chars (0/O, 1/l/I).
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function randomSlug(length = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}
