# Luogu Duel Architecture

Luogu Duel is designed as a pure static web app. It has no trusted self-hosted
backend. Browsers form WebRTC rooms, use public Nostr relays only for WebRTC
signalling, and derive all match state from a replicated signed event log.

## Static networking model

- Static hosting: GitHub Pages, Cloudflare Pages, Netlify static, or any CDN can
  serve the compiled files.
- Room discovery: the home screen joins a public P2P lobby topic and announces
  open rooms. Private room links carry `room` and `secret` in the URL fragment.
- Cross-network realtime: WebRTC data channels carry room events. Nostr relays
  are used as disposable signalling media. App data is not persisted there.
- NAT traversal: public STUN is enough for most users. Restrictive networks need
  a third-party TURN service configured in the browser; the TURN relay transports
  encrypted WebRTC packets and remains untrusted.

## State synchronization

Every mutation is a signed `DuelEvent`:

1. The local browser generates an ECDSA key pair and stores it in localStorage.
2. A Luogu/CPAuth identity should be bound to that public key.
3. Each event contains an actor id, room id, Lamport clock, wall time, and typed
   payload.
4. Peers verify signatures, de-duplicate by event id, sort by Lamport clock and
   id, then run the same reducer.
5. When a peer joins, existing peers send their event logs as snapshots.

The reducer is the authority. Network arrival order does not decide winners or
votes. Accepted Luogu records are ordered by original record time; if two events
claim the same problem, the earlier Luogu AC wins.

## Anti-cheat and conflict policy

No static client can be perfectly trusted, so the design avoids trusting any
single client.

- Identity: CPAuth should issue a signed proof mapping Luogu username to the
  browser public key. Other peers reject events without a valid proof.
- Event integrity: events are signed and immutable; peers reject malformed or
  unauthorized actions.
- Judging: each peer periodically fetches Luogu record data and broadcasts only
  raw observed records. A claim is valid only when the record is for an in-room
  player, in the current problem list, and has `OK` status.
- Conflicts: reducer tie-breakers are deterministic. Accepted records use Luogu
  submission time first, then record id, then event id.
- Votes: problem replacement/deletion and draw require every active participant.
  Surrender requires every player on the surrendering team.
- Limit: a malicious modified browser can omit data it sees, but it cannot make
  other honest peers accept an invalid AC if they can independently query Luogu.

## Luogu records adapter

The code includes a browser-side adapter for `https://www.luogu.com.cn/record/list`.
If Luogu blocks cross-origin browser requests, the pure-static options are:

- use a CPAuth/official CORS-enabled records endpoint;
- ship a companion browser extension/userscript that performs same-origin
  Luogu requests and posts results to the page;
- require every participant to keep a Luogu tab/session available and manually
  click judge, while all peers still validate records they can fetch.

Do not add a custom Node/Python crawler server; that would break the project's
core static constraint.
