// Mutual authentication between the plugin UI and the local companion.
// Inlined into ui.html at build time; companion/src/plugin-auth.mjs implements
// the same messages with node:crypto. Neither side sends a secret before the
// other proves it knows it, so a process squatting on the loopback port learns
// nothing and cannot drive the Figma document.
const FigmaBridgeAuth = (() => {
  const encoder = new TextEncoder();

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

  async function hmac(key, message) {
    if (!crypto?.subtle) throw new Error('This Figma version cannot verify the Figma Bridge companion.');
    const imported = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(message))));
  }

  function proof(key, purpose, serverNonce, clientNonce, extra = '') {
    return hmac(key, `figma-bridge/${purpose}\n${serverNonce}\n${clientNonce}${extra ? `\n${extra}` : ''}`);
  }

  function equal(first, second) {
    if (typeof first !== 'string' || typeof second !== 'string' || first.length !== second.length) return false;
    let difference = 0;
    for (let index = 0; index < first.length; index += 1) difference |= first.charCodeAt(index) ^ second.charCodeAt(index);
    return difference === 0;
  }

  return { nonce, proof, equal };
})();
