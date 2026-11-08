# TSE signing runs on the Render server, never in the request

Orders and payments are saved as waiting for their signature, and the Render server (the long-running process that also holds the WebSockets) signs them with fiskaly: straight away when Vercel pings it over the existing internal channel, and from a sweep every 30 seconds that picks up anything still waiting or failed. We chose this because Vercel cannot reliably keep working after it has replied, and signing inside the request would slow every order and payment and make them fail when fiskaly is down (ADR-0003).

## Considered Options

- **Sign inside the request with a short timeout.** Simplest, but couples every order and payment to fiskaly's latency and uptime.
- **A queue service.** More moving parts than one sweep on a server we already run.

## Consequences

- A receipt can exist before its signature does; it shows that the signature is still coming.
- The sweep runs only where `ENABLE_JOBS=true` (Render, or local), so two servers never sign the same transaction.
