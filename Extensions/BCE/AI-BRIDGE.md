# BCE ↔ Development-AI Local Bridge

**Status:** Design only; not connected or enabled. **BCE branch:** `Chatgpt`. **Date:** 2026-11-17.

## Decision

Use Chrome Manifest V3 Native Messaging between the existing BCE service worker (`service.js`) and a separately installed Development-AI native host. Do not start with a loopback HTTP/WebSocket server. Chrome launches the host and exchanges length-prefixed JSON over stdin/stdout; the host manifest allowlists the exact extension origin. See [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

**Security caveat:** Native Messaging is not an end-to-end secure channel. Chromium warns that a local process may also launch a native host. Validate Chrome's caller-origin argument and implement pairing/session authentication, replay defense and authorization above the transport. Extension-ID allowlisting is necessary but not sufficient.

## Preserve existing BCE

```text
popup / options / prompt-manager
              |
              v
       service.js (MV3 worker)
        |           |
        +--> Teams content script
        +--> ChatGPT content script + existing prompt scheduler
        |
        +--> Native Messaging port
                    |
                    v
             Development-AI host
                    |
                    v
       AutomationRuntime / policy / task store
```

Do not wire legacy `background.js`, `sidepanel.html` or `ui.js` into the active path. Do not replace Teams reader or ChatGPT scheduler. AI may request prompt jobs through a narrow BCE command; BCE retains tab validation, same-conversation locks, sequential repeats and uncertain-response handling. Content scripts never connect directly to native host.

## Pairing and session trust

1. Native-host manifest allowlists only the exact production BCE extension ID. Use a separate dev manifest/ID; no wildcards.
2. Host validates the exact Chrome-supplied origin argument (`chrome-extension://<id>/`) before processing stdin.
3. First-run pairing requires explicit confirmation in trusted host UI. Generate a high-entropy secret and store it in OS-protected per-user storage. Never expose it in DOM, prompt text, URLs or ordinary extension storage.
4. Every connection creates a fresh session ID and nonce, bound to authenticated principal, extension installation, protocol version and expiry. Construct backend `RuntimeIdentity` only after host authentication.
5. Every request after pairing carries request ID, monotonic sequence, session ID, timestamp, nonce, body and HMAC-SHA-256. Verify MAC in constant time; reject replay, out-of-order sequence, stale timestamp, expired session, unknown type and wrong protocol version.
6. Reconnect performs a fresh handshake; do not silently reuse old nonce/sequence windows. Durable principal/session state belongs in Development-AI `SQLiteSessionStore`; transport credentials are stored/revoked separately.
7. Sign-out, extension removal/update, host restart, session expiry, permission removal and owner "Stop all" revoke or terminate the session.

A session ID is an identifier, not a credential. Pairing-secret rotation/recovery and OS credential storage must be implemented before production pairing.

## Framing and limits

- Chrome framing: 4-byte unsigned message length in native byte order, then UTF-8 JSON.
- Chrome host-to-extension maximum is 1 MiB; adopt a stricter 64 KiB application limit in both directions.
- Reject invalid UTF-8, malformed JSON, duplicate keys, non-object envelopes, unknown fields and oversized nested data.
- Correlate one response to each request ID; no unsolicited host command can cause a browser action.
- Bounded queues, deadlines, heartbeat/idle timeout and backpressure.
- stdout is protocol-only; diagnostics to stderr.
- Never accept arbitrary JS, shell, Python source, binaries or generated executable code as action payloads.

## Version 1 message types

Envelope fields: `protocol="aliens.bce.ai"`, `version=1`, `type`, `request_id`, `session_id`, `sequence`, `issued_at`, `nonce`, `body`, `mac`. Validate exact schemas; errors use stable codes and never expose secrets/tracebacks.

- `bridge.hello`, `bridge.paired`, `bridge.ping`
- `capabilities.get` (read-only registered manifests)
- `task.propose`, `task.get`, `task.cancel`, `task.events`
- `approval.request`, `approval.confirm`, `approval.reject`
- `chatgpt.prompt_job.create`, `chatgpt.prompt_job.control` (BCE validates tabs and owns scheduler locks)

No `tool.execute`, arbitrary workflow code or model-generated browser command in protocol v1. The model proposes; deterministic policy and AutomationRuntime authorize. Approval UI displays exact target, action, argument summary, side effects, scope and expiry. Browser adapter independently checks tab, origin, application state and permission before action. Teams/page/ChatGPT text remains untrusted input.

## Failure behavior

- Host absent: show AI disconnected; existing BCE features continue; no hidden queued side effects.
- Host restart: reconnect and re-handshake; recover task state; never replay non-idempotent work merely because a response was lost.
- Unknown outcome: needs-review; owner reconciles.
- Stop: prevent new dispatch, cancel eligible active work and report uncertain side effects.
- Extension ID change: fail closed until exact ID is allowlisted and paired again.

## Implementation sequence

1. Freeze schema/threat model and add adversarial pure-validator tests on both sides.
2. Implement stdio framing + caller-origin validation in Development-AI, no adapters.
3. Add pairing, OS credential storage, MAC, replay window, expiry and revocation.
4. Add BCE service-worker native-port lifecycle, request correlation and reconnect; leave content scripts unchanged.
5. Add read-only status/capability discovery.
6. Add task proposal and approval UI, still no dispatch.
7. Connect authenticated RuntimeIdentity and scoped grants.
8. Test fake adapter approve/deny/cancel/restart paths.
9. Add browser operations individually with permission and postcondition tests.

## Not implemented

The manifest does not request `nativeMessaging`; no native host, pairing, HMAC, bridge messages, backend endpoint or browser dispatch is enabled. This is a design decision, not a live connection.
