# Luogu Duel Architecture

Luogu Duel is a pure static web app. It has no traditional self-hosted backend.
All cross-network state is exchanged through a tiny cloud variable API:
`https://vd.gengen.qzz.io`.

## Static Networking Model

- Static hosting: GitHub Pages, Cloudflare Pages, Netlify static, or any CDN can
  serve the compiled files.
- Room access: private room links carry `room` and `secret` in the URL fragment.
  The cloud variable key is derived from both values, so the room id alone is
  not enough to read the room log.
- Synchronization: the API stores a signed event-log snapshot. Clients poll,
  merge unseen signed events, and write back only when they have local dirty
  events.
- Request control: foreground arena pages poll every 4 seconds, lobbies every
  6 seconds, the global room every 10 seconds, and hidden tabs every 30 seconds.
  Local actions are debounced before POST.
- No WebRTC: there is no Nostr signalling, STUN, TURN, or browser-to-browser
  mesh. The API is the only room transport.

## State Synchronization

Every mutation is a signed `DuelEvent`:

1. The local browser generates an ECDSA key pair and stores it in localStorage.
2. A Luogu/CPAuth identity should be bound to that public key.
3. Each event contains an actor id, room id, Lamport clock, wall time, and typed
   payload.
4. Clients verify signatures, de-duplicate by event id, sort by Lamport clock
   and id, then run the same reducer.
5. A client keeps locally dirty event ids until a later GET confirms the server
   snapshot contains them.

The reducer is the authority. Network arrival order does not decide winners or
votes. Accepted Luogu records are ordered by original record time; if two events
claim the same problem, the earlier Luogu AC wins.

## Conflict Policy

The API is a last-writer-wins key-value store, not a compare-and-swap database.
Concurrent POSTs can temporarily overwrite each other. To avoid permanent event
loss, every client keeps its unsaved signed events locally and re-posts a merged
snapshot when the next poll shows those event ids are missing.

- Event integrity: events are signed and immutable.
- Merge rule: event id de-duplication plus deterministic Lamport/id ordering.
- Dirty retry: local event ids are cleared only after the server returns them.
- Votes: problem replacement/deletion and draw require every active participant.
  Surrender requires every player on the surrendering team.

## Judging

Each active client can periodically fetch Luogu record data and emit raw
observed records. A claim is valid only when the record is for an in-room player,
in the current problem list, and has `OK` status.

The code includes a browser-side adapter for
`https://www.luogu.com.cn/record/list`. If Luogu blocks cross-origin browser
requests, the pure-static options are:

- use a CPAuth/official CORS-enabled records endpoint;
- ship a companion browser extension/userscript that performs same-origin
  Luogu requests and posts results to the page;
- require every participant to keep a Luogu tab/session available and manually
  click judge, while all clients still validate records they can fetch.
