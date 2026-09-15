import crypto from "node:crypto";

const STYLE = `
  :root { color-scheme: light dark; --bg: #f6f7f9; --panel: #fff; --text: #17202a; --muted: #637083; --line: #d9dee7; --accent: #0f766e; --danger: #b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111418; --panel: #1a1f25; --text: #e7eaee; --muted: #9aa5b1; --line: #2c333b; --accent: #2dd4bf; --danger: #f97066; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { width: min(440px, calc(100% - 32px)); margin: 12vh auto 0; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 22px; }
  h1 { margin: 0 0 6px; font-size: 21px; line-height: 1.2; }
  p { margin: 10px 0 0; }
  .client { font-weight: 600; overflow-wrap: anywhere; }
  .muted { color: var(--muted); font-size: 13px; }
  .code { margin: 18px 0 4px; font: 700 44px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .06em; text-align: center; white-space: nowrap; }
  .status { margin-top: 16px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); }
  .status.ok { border-color: var(--accent); color: var(--accent); }
  .status.bad { border-color: var(--danger); color: var(--danger); }
`;

// The browser polls the status endpoint with its per-page secret and follows
// the redirect only after the Figma plugin approved or denied the request.
const SCRIPT = `
  (() => {
    const status = document.getElementById("status");
    const body = JSON.stringify(payload);
    const show = (text, kind) => { status.textContent = text; status.className = "status " + (kind || ""); };
    const poll = async () => {
      let result;
      try {
        const response = await fetch("/oauth/authorize/status", { method: "POST", headers: { "Content-Type": "application/json" }, body, cache: "no-store" });
        result = await response.json();
      } catch (_) {
        setTimeout(poll, 2000);
        return;
      }
      switch (result.status) {
        case "pending":
          setTimeout(poll, 2000);
          return;
        case "approved":
          show("Access approved. Returning to the app\\u2026", "ok");
          window.location.replace(result.redirect);
          return;
        case "denied":
          show("Access denied.", "bad");
          window.location.replace(result.redirect);
          return;
        case "done":
          show("This connection is already complete. You can close this page.", "ok");
          return;
        default:
          show("This request has expired. Start the connection again from your AI app.", "bad");
      }
    };
    poll();
  })();
`;

export function approvalPage({ clientName, code, requestId, browserSecret }) {
  const nonce = createNonce();
  const content = `
    <h1>Connect to Figma Bridge</h1>
    <p><span class="client">${escapeHtml(clientName)}</span> is requesting access to Figma through Figma Bridge.</p>
    <p>In Figma, open the Figma Bridge plugin, choose Connect AI app, and enter this code.</p>
    <div class="code" aria-label="Approval code">${escapeHtml(code)}</div>
    <p id="status" class="status" role="status">Waiting for approval in Figma&hellip;</p>
    <p class="muted">The code expires in 10 minutes. If you did not start this connection, close this page.</p>
    <script nonce="${nonce}">
      const payload = ${scriptJson({ request: requestId, secret: browserSecret })};
      ${SCRIPT}
    </script>`;
  return { headers: pageHeaders(nonce), body: pageDocument(nonce, content) };
}

export function errorPage(message) {
  const nonce = createNonce();
  const content = `
    <h1>Connection failed</h1>
    <p class="status bad">${escapeHtml(message)}</p>`;
  return { headers: pageHeaders(nonce), body: pageDocument(nonce, content) };
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}

function pageDocument(nonce, content) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Connect to Figma Bridge</title>
  <style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
  <div class="panel">${content}
  </div>
</main>
</body>
</html>
`;
}

function pageHeaders(nonce) {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  };
}

function createNonce() {
  return crypto.randomBytes(16).toString("base64url");
}

// JSON that is safe inside an inline script element.
function scriptJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
