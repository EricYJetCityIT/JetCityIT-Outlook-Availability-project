const crypto = require('crypto');

// Constant-time secret comparison. Both inputs are first hashed to fixed-length
// SHA-256 digests so crypto.timingSafeEqual never sees mismatched lengths (it
// throws when the two buffers differ in length) — this makes the comparison
// leak neither the secret's content nor its length via timing. Use for
// comparing caller-supplied tokens/secrets against configured values, instead
// of `!==`, which short-circuits on the first differing byte.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { safeEqual };
