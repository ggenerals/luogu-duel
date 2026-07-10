# Luogu Duel Architecture

Luogu Duel is now a Cloudflare Worker application with static assets, CP OAuth
API routes, and one Durable Object per room.

## Runtime

- Static assets are served by the Worker Assets binding from `dist`.
- `wrangler.jsonc` binds the Worker to `duel.gengen.qzz.io/*`.
- `DUEL_ROOM` is a SQLite-backed Durable Object namespace. A room uses the
  deterministic name `${roomId}:${secret}`.
- The room directory is stored in the same Durable Object class under the
  reserved name `__directory`.

## Realtime Room Model

Every room mutation is still a signed `DuelEvent`, but the Durable Object is now
the network source of truth:

1. The browser signs an event with its local ECDSA key.
2. The browser sends it over `/api/rooms/:roomId/ws?secret=...`.
3. The room Durable Object stores the envelope in SQLite before broadcasting it.
4. Reconnecting clients receive a full ordered snapshot in the WebSocket hello.
5. `/api/rooms/:roomId/snapshot` and `/event` are HTTP fallback paths.

The WebSocket path uses Cloudflare's WebSockets Hibernation API, so idle rooms
do not need an always-awake Worker instance.

## Authority Rules

- The reducer remains the deterministic game authority for winners, votes, and
  moderation state.
- `hostId` is set by room creation or the first join.
- The host can close a room only while it is still in the lobby.
- Admins (`General826`, `Gcend`, `GCSG01`) can force-close rooms at any time.
- Room bans are synchronized events. A banned user sees a full-screen blocking
  overlay and cannot operate the room UI.

## OAuth

CP OAuth redirects to `/api/auth/callback`. The callback page reads the PKCE
verifier from `sessionStorage`, calls `/api/auth/exchange`, and the Worker uses
`CP_CLIENT_SECRET` from Cloudflare secrets to exchange the code server-side.

Never put `CP_CLIENT_SECRET` in source, `.env`, or `wrangler.jsonc`.
