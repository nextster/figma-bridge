// Mutual authentication between the plugin UI and the local companion.
// Inlined into ui.html at build time; companion/src/plugin-auth.mjs implements
// the same messages with node:crypto. Neither side sends a secret before the
// other proves it knows it, so a process squatting on the loopback port learns
// nothing and cannot drive the Figma document.
//
// Figma's plugin iframe is not a secure context, so crypto.subtle is missing
// there. HMAC-SHA256 is implemented here in plain JavaScript instead.
const FigmaBridgeAuth = (() => {
  const encoder = new TextEncoder();
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function rotate(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
  }

  function sha256(bytes) {
    const blocks = Math.ceil((bytes.length + 9) / 64);
    const data = new Uint8Array(blocks * 64);
    data.set(bytes);
    data[bytes.length] = 0x80;
    const view = new DataView(data.buffer);
    const bits = bytes.length * 8;
    view.setUint32(data.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(data.length - 4, bits >>> 0);
    const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const words = new Uint32Array(64);
    for (let offset = 0; offset < data.length; offset += 64) {
      for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
      for (let index = 16; index < 64; index += 1) {
        const s0 = rotate(words[index - 15], 7) ^ rotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
        const s1 = rotate(words[index - 2], 17) ^ rotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
        words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = hash;
      for (let index = 0; index < 64; index += 1) {
        const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[index] + words[index]) >>> 0;
        const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      [a, b, c, d, e, f, g, h].forEach((value, index) => { hash[index] = (hash[index] + value) >>> 0; });
    }
    const output = new Uint8Array(32);
    const outputView = new DataView(output.buffer);
    hash.forEach((value, index) => outputView.setUint32(index * 4, value));
    return output;
  }

  function concat(first, second) {
    const joined = new Uint8Array(first.length + second.length);
    joined.set(first);
    joined.set(second, first.length);
    return joined;
  }

  function hmac(key, message) {
    let keyBytes = encoder.encode(key);
    if (keyBytes.length > 64) keyBytes = sha256(keyBytes);
    const block = new Uint8Array(64);
    block.set(keyBytes);
    const inner = sha256(concat(block.map(byte => byte ^ 0x36), encoder.encode(message)));
    return sha256(concat(block.map(byte => byte ^ 0x5c), inner));
  }

  function base64url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function nonce() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return base64url(bytes);
  }

  async function proof(key, purpose, serverNonce, clientNonce, extra = '') {
    return base64url(hmac(key, `figma-bridge/${purpose}\n${serverNonce}\n${clientNonce}${extra ? `\n${extra}` : ''}`));
  }

  function equal(first, second) {
    if (typeof first !== 'string' || typeof second !== 'string' || first.length !== second.length) return false;
    let difference = 0;
    for (let index = 0; index < first.length; index += 1) difference |= first.charCodeAt(index) ^ second.charCodeAt(index);
    return difference === 0;
  }

  return { nonce, proof, equal };
})();
