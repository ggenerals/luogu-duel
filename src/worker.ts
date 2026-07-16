/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import { applyEvent, applyEvents, createInitialState } from "./domain";
import type { DuelEvent, SignedEnvelope } from "./types";

type Env = {
  DUEL_ROOM: DurableObjectNamespace<DuelRoom>;
  ASSETS: Fetcher;
  MAINTENANCE?: string;
};

type RoomListing = {
  roomId: string;
  secret: string;
  host: string;
  createdAt: number;
  problemCount: number;
  status: "lobby" | "arena" | "finished";
  startedAt?: number;
  endedAt?: number;
  winner?: "red" | "blue" | "draw";
  rated?: boolean;
  closedReason?: string;
  redPlayers?: string[];
  bluePlayers?: string[];
};

type UserRecord = {
  name: string;
  rating: number;
  wins: number;
  losses: number;
  games: number;
  avatar?: string;
  color?: string;
  profileHtml?: string;
  updatedAt: number;
};

type ClientMessage = { type: "event"; envelope: SignedEnvelope };
type SocketKind = "room" | "directory";

const bannedAvatarUrl = "https://cdn.luogu.com.cn/images/banned.png";
const adminNames = new Set(["general0826", "slmxf", "liyifan202201", "gcend", "gcsg01"]);

export class DuelRoom extends DurableObject<Env> {
  private eventsCache: SignedEnvelope[] | null = null;
  private eventIds = new Set<string>();
  private cachedState = createInitialState("");
  private firstEvent: DuelEvent | null = null;
  private roomSecret: string | null = null;
  private listingsCache: Map<string, RoomListing> | null = null;
  private usersCache: Map<string, UserRecord> | null = null;
  private bannedUsersCache: Set<string> | null = null;
  private processedResultsCache: Set<string> | null = null;
  private actorWriteWindow = new Map<string, number[]>();
  private directoryObject: boolean | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          issued_at INTEGER NOT NULL,
          lamport INTEGER NOT NULL,
          envelope TEXT NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS listings (
          room_id TEXT PRIMARY KEY,
          listing TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS users (
          name_key TEXT PRIMARY KEY,
          user_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS processed_results (
          room_id TEXT PRIMARY KEY,
          processed_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS banned_users (
          name_key TEXT PRIMARY KEY,
          detected_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS active_players (
          name_key TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS snapshots (
          snapshot_key TEXT PRIMARY KEY,
          snapshot_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const secret = url.searchParams.get("secret");
    if (secret) await this.rememberSecret(secret);
    if (url.pathname.endsWith("/directory/ws")) return this.handleDirectoryWebSocket(request);
    if (url.pathname.endsWith("/directory")) return this.handleDirectory(request);
    if (url.pathname.endsWith("/active-player")) return this.handleActivePlayer(request);
    if (url.pathname.endsWith("/users")) return this.handleUsers(request);
    if (url.pathname.endsWith("/clear-all")) return this.handleClearAll(request);
    if (url.pathname.endsWith("/clear-room")) return this.handleClearRoom(request);
    const userMatch = url.pathname.match(/\/users\/([^/]+)$/);
    if (userMatch) return this.handleUser(request, decodeURIComponent(userMatch[1]));
    if (url.pathname.endsWith("/ws")) return this.handleWebSocket(request);
    if (url.pathname.endsWith("/snapshot")) {
      await this.expireStaleLobby();
      return Response.json({ envelopes: this.listEvents() });
    }
    if (url.pathname.endsWith("/event") && request.method === "POST") {
      const body = (await request.json()) as Partial<ClientMessage>;
      if (!body.envelope) return jsonError("missing envelope", 400);
      try {
        const saved = await this.acceptEnvelope(body.envelope);
        if (saved) this.broadcast({ type: "event", envelope: body.envelope });
        return Response.json({ ok: true });
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : "event rejected", 409);
      }
    }
    return jsonError("not found", 404);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    try {
      const data = JSON.parse(message) as Partial<ClientMessage>;
      const attachment = ws.deserializeAttachment() as { kind?: SocketKind } | undefined;
      if (attachment?.kind === "directory") return;
      if (data.type !== "event" || !data.envelope) return;
      const saved = await this.acceptEnvelope(data.envelope);
      if (saved) this.broadcast({ type: "event", envelope: data.envelope });
    } catch (error) {
      ws.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "bad message" }));
    }
  }

  async webSocketClose(): Promise<void> {
    // Hibernation lets the runtime clean up closed sockets; no in-memory state is required.
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return jsonError("expected websocket", 426);
    await this.expireStaleLobby();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ kind: "room" satisfies SocketKind, connectedAt: Date.now() });
    server.send(JSON.stringify({ type: "hello", envelopes: this.listEvents() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private handleDirectoryWebSocket(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") return jsonError("expected websocket", 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ kind: "directory" satisfies SocketKind, connectedAt: Date.now() });
    server.send(JSON.stringify({ type: "directory", rooms: this.listRooms() }));
    server.send(JSON.stringify({ type: "users", users: this.listUsers() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async acceptEnvelope(envelope: SignedEnvelope): Promise<boolean> {
    const event = envelope.event;
    this.hydrateEvents();
    if (this.eventIds.has(event.id)) return false;
    if (!this.allowActorWrite(event.actorId)) throw new Error("操作过于频繁，已阻止本次服务器写入");
    const currentRoomId = this.cachedState.roomId || this.firstEvent?.roomId;
    if (currentRoomId && currentRoomId !== event.roomId) return false;
    // Finished matches are immutable archives. Reject before SQLite persistence
    // so delayed retries cannot produce writes or directory broadcasts.
    if (event.roomId !== "global" && this.cachedState.phase === "finished") return false;

    const currentPlayer = this.cachedState.players[event.actorId];
    const kickedPlayer = event.type === "player.kicked"
      ? this.cachedState.players[event.targetId] ?? Object.values(this.cachedState.players).find((player) => normalizeName(player.luoguName) === normalizeName(event.targetName || ""))
      : undefined;
    const claimName =
      event.type === "player.joined" && isPlayingSeat(event.team)
        ? event.luoguName
        : event.type === "player.teamChanged" && isPlayingSeat(event.team) && currentPlayer
          ? currentPlayer.luoguName
          : "";
    if (claimName && !(await this.claimActivePlayer(claimName, event.roomId))) {
      throw new Error("你已在另一场未结束比赛中，本房只能观赛");
    }

    const releaseName =
      event.type === "player.left" && currentPlayer
        ? currentPlayer.luoguName
        : event.type === "player.teamChanged" && event.team === "spectator" && currentPlayer
          ? currentPlayer.luoguName
          : kickedPlayer
            ? kickedPlayer.luoguName
          : "";
    const previousPhase = this.cachedState.phase;
    const previousDirectoryFingerprint = directoryFingerprint(this.cachedState);

    this.ctx.storage.sql.exec(
      "INSERT INTO events (id, room_id, issued_at, lamport, envelope) VALUES (?, ?, ?, ?, ?)",
      event.id,
      event.roomId,
      event.issuedAt,
      event.lamport,
      JSON.stringify(envelope)
    );
    this.eventsCache!.push(envelope);
    this.eventsCache!.sort(compareEnvelopes);
    this.eventIds.add(event.id);
    this.writeSnapshot("events", this.eventsCache!);
    this.firstEvent ??= event;
    this.cachedState = applyEvent(this.cachedState.roomId === event.roomId ? this.cachedState : createInitialState(event.roomId), event);
    if (claimName && !isPlayingSeat(this.cachedState.players[event.actorId]?.team)) {
      await this.releaseActivePlayer(claimName, event.roomId);
    }
    if (releaseName) await this.releaseActivePlayer(releaseName, event.roomId);
    if (previousPhase !== "finished" && this.cachedState.phase === "finished") await this.releaseActiveRoom(event.roomId);
    if (previousDirectoryFingerprint !== directoryFingerprint(this.cachedState)) {
      await this.updateDirectory(event.roomId, event);
    }
    if (event.roomId !== "global") {
      if (this.cachedState.phase === "lobby" && event.type === "room.configured") {
        await this.ctx.storage.setAlarm((this.firstEvent?.issuedAt ?? event.issuedAt) + 10 * 60_000);
      } else if (this.cachedState.phase !== "lobby") {
        await this.ctx.storage.deleteAlarm();
      }
    }
    return true;
  }

  async alarm(): Promise<void> {
    if (await this.isDirectoryObject()) {
      await this.pruneDirectory();
      if (this.listingsCache!.size > 500) await this.ctx.storage.setAlarm(Date.now() + 1_000);
      this.broadcastDirectory();
      return;
    }
    await this.expireStaleLobby();
  }

  private async expireStaleLobby(): Promise<void> {
    this.hydrateEvents();
    const createdAt = this.firstEvent?.issuedAt;
    if (!createdAt || this.cachedState.roomId === "global" || this.cachedState.phase !== "lobby") return;
    const deadline = createdAt + 10 * 60_000;
    if (Date.now() < deadline) {
      await this.ctx.storage.setAlarm(deadline);
      return;
    }
    const envelope = await systemCloseEnvelope(this.cachedState.roomId, this.cachedState.lamport + 1, Date.now());
    const saved = await this.acceptEnvelope(envelope);
    if (saved) this.broadcast({ type: "event", envelope });
  }

  private allowActorWrite(actorId: string): boolean {
    const now = Date.now();
    const recent = (this.actorWriteWindow.get(actorId) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= 60) return false;
    recent.push(now);
    this.actorWriteWindow.set(actorId, recent);
    return true;
  }

  private async claimActivePlayer(name: string, roomId: string): Promise<boolean> {
    const response = await this.env.DUEL_ROOM.getByName("__directory").fetch("https://duel.internal/active-player", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "claim", name, roomId })
    });
    const result = (await response.json()) as { ok?: boolean };
    return result.ok === true;
  }

  private async releaseActivePlayer(name: string, roomId: string): Promise<void> {
    await this.env.DUEL_ROOM.getByName("__directory").fetch("https://duel.internal/active-player", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "release", name, roomId })
    });
  }

  private async releaseActiveRoom(roomId: string): Promise<void> {
    await this.env.DUEL_ROOM.getByName("__directory").fetch("https://duel.internal/active-player", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "release-room", roomId })
    });
  }

  private listEvents(): SignedEnvelope[] {
    this.hydrateEvents();
    return this.eventsCache!;
  }

  private hydrateEvents(): void {
    if (this.eventsCache) return;
    const snapshot = this.readSnapshot<SignedEnvelope[]>("events");
    if (snapshot) {
      this.eventsCache = snapshot;
    } else {
      this.eventsCache = this.ctx.storage.sql
        .exec<{ envelope: string }>("SELECT envelope FROM events ORDER BY lamport ASC, issued_at ASC, id ASC LIMIT 1000")
        .toArray()
        .map((row) => JSON.parse(row.envelope) as SignedEnvelope);
      this.writeSnapshot("events", this.eventsCache);
    }
    this.eventsCache.sort(compareEnvelopes);
    this.eventIds = new Set(this.eventsCache.map((item) => item.event.id));
    this.firstEvent = this.eventsCache[0]?.event ?? null;
    const roomId = this.firstEvent?.roomId ?? "";
    this.cachedState = roomId ? applyEvents(roomId, this.eventsCache.map((item) => item.event)) : createInitialState("");
  }

  private async updateDirectory(roomId: string, latestEvent: DuelEvent): Promise<void> {
    if (roomId === "global" || roomId === "__directory") return;
    const state = this.cachedState.roomId === roomId ? this.cachedState : applyEvents(roomId, this.listEvents().map((item) => item.event));
    const directory = this.env.DUEL_ROOM.getByName("__directory");
    const firstEvent = this.firstEvent ?? latestEvent;
    const firstPlayer = Object.values(state.players)[0];
    const redPlayers = Object.values(state.players).filter((player) => player.team === "red").map((player) => player.luoguName);
    const bluePlayers = Object.values(state.players).filter((player) => player.team === "blue").map((player) => player.luoguName);
    const listing: RoomListing = {
      roomId,
      secret: "",
      host: state.players[state.hostId ?? ""]?.luoguName ?? firstPlayer?.luoguName ?? "unknown",
      createdAt: firstEvent.issuedAt,
      problemCount: state.problems.length,
      status: state.closed || state.phase === "finished" ? "finished" : state.phase === "arena" ? "arena" : "lobby",
      startedAt: state.startedAt,
      endedAt: state.closed || state.phase === "finished" ? state.endedAt ?? latestEvent.issuedAt : undefined,
      winner: state.winner,
      rated: state.rated,
      closedReason: state.closed?.reason,
      redPlayers,
      bluePlayers
    };
    const attachmentSecret = await this.readSecret();
    if (attachmentSecret) listing.secret = attachmentSecret;
    await directory.fetch("https://duel.internal/directory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listing })
    });
  }

  private async handleDirectory(request: Request): Promise<Response> {
    if (request.method === "GET") {
      return Response.json({ rooms: this.listRooms() }, { headers: cacheHeaders(60, 24 * 60 * 60) });
    }
    if (request.method === "POST") {
      this.directoryObject = true;
      await this.ctx.storage.put("directory-object", true);
      const body = (await request.json()) as { listing?: RoomListing };
      if (!body.listing?.roomId) return jsonError("missing listing", 400);
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO listings (room_id, listing, updated_at) VALUES (?, ?, ?)",
        body.listing.roomId,
        JSON.stringify(body.listing),
        Date.now()
      );
      this.registerListingUsers(body.listing);
      this.applyFinishedListingResult(body.listing);
      this.hydrateDirectory();
      this.listingsCache!.set(body.listing.roomId, body.listing);
      await this.pruneDirectory();
      this.writeSnapshot("directory", [...this.listingsCache!.values()]);
      if (this.listingsCache!.size > 500) await this.ctx.storage.setAlarm(Date.now() + 1_000);
      this.broadcastDirectory();
      return Response.json({ ok: true });
    }
    if (request.method === "DELETE") {
      const body = (await request.json()) as { roomId?: string };
      if (body.roomId) {
        this.ctx.storage.sql.exec("DELETE FROM listings WHERE room_id = ?", body.roomId);
        this.hydrateDirectory();
        this.listingsCache!.delete(body.roomId);
        this.writeSnapshot("directory", [...this.listingsCache!.values()]);
        this.broadcastDirectory();
      }
      return Response.json({ ok: true });
    }
    return jsonError("method not allowed", 405);
  }

  private async handleActivePlayer(request: Request): Promise<Response> {
    if (request.method !== "POST") return jsonError("method not allowed", 405);
    const body = (await request.json()) as { action?: string; name?: string; roomId?: string };
    const roomId = body.roomId?.trim() || "";
    if (!roomId) return jsonError("missing room", 400);

    if (body.action === "release-room") {
      this.ctx.storage.sql.exec("DELETE FROM active_players WHERE room_id = ?", roomId);
      return Response.json({ ok: true });
    }

    const nameKey = normalizeName(body.name || "");
    if (!nameKey) return jsonError("missing player", 400);
    if (body.action === "release") {
      this.ctx.storage.sql.exec("DELETE FROM active_players WHERE name_key = ? AND room_id = ?", nameKey, roomId);
      return Response.json({ ok: true });
    }
    if (body.action !== "claim") return jsonError("bad action", 400);

    const existing = this.ctx.storage.sql
      .exec<{ room_id: string; updated_at: number }>("SELECT room_id, updated_at FROM active_players WHERE name_key = ? LIMIT 1", nameKey)
      .toArray()[0];
    if (existing && existing.room_id !== roomId && Date.now() - existing.updated_at < 24 * 60 * 60 * 1000) {
      return Response.json({ ok: false, roomId: existing.room_id }, { status: 409 });
    }
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO active_players (name_key, room_id, updated_at) VALUES (?, ?, ?)",
      nameKey,
      roomId,
      Date.now()
    );
    return Response.json({ ok: true });
  }

  private handleUsers(request: Request): Response {
    if (request.method !== "GET") return jsonError("method not allowed", 405);
    return Response.json({ users: this.listUsers() }, { headers: cacheHeaders(60, 24 * 60 * 60) });
  }

  private async handleUser(request: Request, rawName: string): Promise<Response> {
    const name = rawName.trim();
    if (!name) return jsonError("missing name", 400);
    if (request.method === "GET") {
      const user = this.readUser(name);
      return user ? Response.json({ user }, { headers: cacheHeaders(60, 24 * 60 * 60) }) : jsonError("not found", 404);
    }
    if (request.method === "POST") {
      const body = (await request.json()) as Partial<UserRecord>;
      const requestedRating = typeof body.rating === "number" && Number.isFinite(body.rating) ? Math.round(body.rating) : undefined;
      if (requestedRating !== undefined && !adminNames.has(normalizeName(request.headers.get("x-admin-name") || ""))) {
        return jsonError("admin required", 403);
      }
      if (isBannedAvatar(body.avatar)) {
        this.removeUser(name);
        this.broadcastDirectory();
        return jsonError("user is banned", 410);
      }
      this.hydrateBannedUsers();
      if (this.bannedUsersCache!.has(normalizeName(name))) return jsonError("user is banned", 410);
      const user = this.upsertUser({
        name,
        avatar: stringField(body as Record<string, unknown>, "avatar") || undefined,
        color: stringField(body as Record<string, unknown>, "color") || undefined,
        profileHtml: typeof body.profileHtml === "string" ? body.profileHtml.slice(0, 20_000) : undefined,
        rating: requestedRating === undefined ? undefined : Math.max(0, Math.min(10_000, requestedRating))
      });
      this.broadcastDirectory();
      return Response.json({ user });
    }
    return jsonError("method not allowed", 405);
  }

  private handleClearAll(request: Request): Response {
    if (request.method !== "POST") return jsonError("method not allowed", 405);
    for (const table of ["events", "listings", "users", "processed_results", "banned_users", "active_players", "snapshots"]) {
      this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
    }
    this.eventsCache = [];
    this.eventIds = new Set();
    this.cachedState = createInitialState("");
    this.firstEvent = null;
    this.listingsCache = new Map();
    this.usersCache = new Map();
    this.bannedUsersCache = new Set();
    this.processedResultsCache = new Set();
    this.broadcastDirectory();
    return Response.json({ ok: true });
  }

  private async handleClearRoom(request: Request): Promise<Response> {
    if (request.method !== "POST") return jsonError("method not allowed", 405);
    this.ctx.storage.sql.exec("DELETE FROM events");
    await this.ctx.storage.delete("secret");
    await this.ctx.storage.deleteAlarm();
    this.eventsCache = [];
    this.eventIds = new Set();
    this.cachedState = createInitialState("");
    this.firstEvent = null;
    this.roomSecret = "";
    this.ctx.storage.sql.exec("DELETE FROM snapshots WHERE snapshot_key = 'events'");
    return Response.json({ ok: true });
  }

  private async pruneDirectory(): Promise<void> {
    this.hydrateDirectory();
    const overflow = [...this.listingsCache!.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(500, 525);
    for (const listing of overflow) {
      this.ctx.storage.sql.exec("DELETE FROM listings WHERE room_id = ?", listing.roomId);
      this.ctx.storage.sql.exec("DELETE FROM processed_results WHERE room_id = ?", listing.roomId);
      this.ctx.storage.sql.exec("DELETE FROM active_players WHERE room_id = ?", listing.roomId);
      this.listingsCache!.delete(listing.roomId);
      this.processedResultsCache?.delete(listing.roomId);
      const secret = listing.secret || "public-room";
      await this.env.DUEL_ROOM.getByName(`${listing.roomId}:${secret}`).fetch("https://duel.internal/clear-room", { method: "POST" });
    }
    if (overflow.length) this.writeSnapshot("directory", [...this.listingsCache!.values()]);
  }

  private async isDirectoryObject(): Promise<boolean> {
    if (this.directoryObject !== null) return this.directoryObject;
    this.directoryObject = (await this.ctx.storage.get<boolean>("directory-object")) === true;
    return this.directoryObject;
  }

  private registerListingUsers(listing: RoomListing): void {
    for (const name of listingNames(listing)) {
      if (!this.readUser(name)) this.upsertUser({ name });
    }
  }

  private applyFinishedListingResult(listing: RoomListing): void {
    if (listing.rated === false || listing.status !== "finished" || listing.winner === "draw" || !listing.winner) return;
    const red = dedupeNames(listing.redPlayers ?? []);
    const blue = dedupeNames(listing.bluePlayers ?? []);
    if (!red.length || !blue.length) return;
    this.hydrateProcessedResults();
    if (this.processedResultsCache!.has(listing.roomId)) return;

    const redRows = red.map((name) => this.upsertUser({ name }));
    const blueRows = blue.map((name) => this.upsertUser({ name }));
    const redAvg = average(redRows.map((user) => user.rating));
    const blueAvg = average(blueRows.map((user) => user.rating));
    const redScore = listing.winner === "red" ? 1 : 0;
    const redExpected = 1 / (1 + 10 ** ((blueAvg - redAvg) / 400));
    const delta = Math.round(64 * (redScore - redExpected));
    for (const user of redRows) this.writeUser(applyRatingDelta(user, delta, redScore === 1));
    for (const user of blueRows) this.writeUser(applyRatingDelta(user, -delta, redScore === 0));
    this.ctx.storage.sql.exec("INSERT INTO processed_results (room_id, processed_at) VALUES (?, ?)", listing.roomId, Date.now());
    this.processedResultsCache!.add(listing.roomId);
    this.writeSnapshot("processed-results", [...this.processedResultsCache!]);
  }

  private readUser(name: string): UserRecord | null {
    this.hydrateUsers();
    const key = normalizeName(name);
    return this.usersCache!.get(key) ?? null;
  }

  private upsertUser(input: { name: string; avatar?: string; color?: string; profileHtml?: string; rating?: number }): UserRecord {
    const existing = this.readUser(input.name);
    const user: UserRecord = {
      name: existing?.name || input.name.trim(),
      rating: input.rating ?? existing?.rating ?? 1300,
      wins: existing?.wins ?? 0,
      losses: existing?.losses ?? 0,
      games: existing?.games ?? 0,
      avatar: input.avatar ?? existing?.avatar,
      color: input.color ?? existing?.color,
      profileHtml: input.profileHtml ?? existing?.profileHtml,
      updatedAt: Date.now()
    };
    return this.writeUser(user);
  }

  private writeUser(user: UserRecord): UserRecord {
    const key = normalizeName(user.name);
    if (isBannedAvatar(user.avatar)) {
      this.removeUser(user.name);
      return user;
    }
    this.hydrateBannedUsers();
    if (this.bannedUsersCache!.has(key)) return user;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO users (name_key, user_json, updated_at) VALUES (?, ?, ?)",
      key,
      JSON.stringify(user),
      user.updatedAt
    );
    this.hydrateUsers();
    this.usersCache!.set(key, user);
    this.writeSnapshot("users", [...this.usersCache!.values()]);
    return user;
  }

  private removeUser(name: string): void {
    const key = normalizeName(name);
    if (!key) return;
    this.ctx.storage.sql.exec("DELETE FROM users WHERE name_key = ?", key);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO banned_users (name_key, detected_at) VALUES (?, ?)",
      key,
      Date.now()
    );
    this.hydrateUsers();
    this.hydrateBannedUsers();
    this.usersCache!.delete(key);
    this.bannedUsersCache!.add(key);
    this.writeSnapshot("users", [...this.usersCache!.values()]);
    this.writeSnapshot("banned-users", [...this.bannedUsersCache!]);
  }

  private listRooms(): RoomListing[] {
    this.hydrateDirectory();
    const maxAge = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return [...this.listingsCache!.values()]
      .map((room) => room.status === "lobby" && Date.now() - room.createdAt >= 10 * 60_000
        ? { ...room, status: "finished" as const, endedAt: room.createdAt + 10 * 60_000, closedReason: "房间创建 10 分钟仍未开始，已自动关闭" }
        : room)
      .filter((room) => room.createdAt >= maxAge || (room.endedAt ?? room.startedAt ?? room.createdAt) >= maxAge)
      .sort((a, b) => (b.endedAt ?? b.startedAt ?? b.createdAt) - (a.endedAt ?? a.startedAt ?? a.createdAt))
      .slice(0, 500);
  }

  private listUsers(): UserRecord[] {
    this.hydrateUsers();
    return [...this.usersCache!.values()]
      .sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.name.localeCompare(b.name))
      .slice(0, 1000);
  }

  private hydrateDirectory(): void {
    if (this.listingsCache) return;
    const snapshot = this.readSnapshot<RoomListing[]>("directory");
    if (snapshot) {
      this.listingsCache = new Map(snapshot.map((listing) => [listing.roomId, listing]));
      return;
    }
    const rows = this.ctx.storage.sql.exec<{ listing: string }>("SELECT listing FROM listings").toArray();
    this.listingsCache = new Map(rows.map((row) => {
      const listing = JSON.parse(row.listing) as RoomListing;
      return [listing.roomId, listing];
    }));
    this.writeSnapshot("directory", [...this.listingsCache.values()]);
  }

  private hydrateUsers(): void {
    if (this.usersCache) return;
    this.hydrateBannedUsers();
    const snapshot = this.readSnapshot<UserRecord[]>("users");
    if (snapshot) {
      this.usersCache = new Map(snapshot.flatMap((user) => this.bannedUsersCache!.has(normalizeName(user.name)) ? [] : [[normalizeName(user.name), user]]));
      return;
    }
    const rows = this.ctx.storage.sql
      .exec<{ user_json: string }>("SELECT user_json FROM users")
      .toArray();
    this.usersCache = new Map();
    for (const row of rows) {
      const user = JSON.parse(row.user_json) as UserRecord;
      const key = normalizeName(user.name);
      if (isBannedAvatar(user.avatar)) {
        this.removeUser(user.name);
        continue;
      }
      if (!this.bannedUsersCache!.has(key)) this.usersCache.set(key, user);
    }
    this.writeSnapshot("users", [...this.usersCache.values()]);
  }

  private hydrateBannedUsers(): void {
    if (this.bannedUsersCache) return;
    const snapshot = this.readSnapshot<string[]>("banned-users");
    if (snapshot) {
      this.bannedUsersCache = new Set(snapshot);
      return;
    }
    const rows = this.ctx.storage.sql
      .exec<{ name_key: string }>("SELECT name_key FROM banned_users")
      .toArray();
    this.bannedUsersCache = new Set(rows.map((row) => row.name_key));
    this.writeSnapshot("banned-users", [...this.bannedUsersCache]);
  }

  private hydrateProcessedResults(): void {
    if (this.processedResultsCache) return;
    const snapshot = this.readSnapshot<string[]>("processed-results");
    if (snapshot) {
      this.processedResultsCache = new Set(snapshot);
      return;
    }
    const rows = this.ctx.storage.sql
      .exec<{ room_id: string }>("SELECT room_id FROM processed_results")
      .toArray();
    this.processedResultsCache = new Set(rows.map((row) => row.room_id));
    this.writeSnapshot("processed-results", [...this.processedResultsCache]);
  }

  private readSnapshot<T>(key: string): T | null {
    const row = this.ctx.storage.sql
      .exec<{ snapshot_json: string }>("SELECT snapshot_json FROM snapshots WHERE snapshot_key = ? LIMIT 1", key)
      .toArray()[0];
    if (!row) return null;
    try {
      return JSON.parse(row.snapshot_json) as T;
    } catch {
      this.ctx.storage.sql.exec("DELETE FROM snapshots WHERE snapshot_key = ?", key);
      return null;
    }
  }

  private writeSnapshot(key: string, value: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO snapshots (snapshot_key, snapshot_json, updated_at) VALUES (?, ?, ?)",
      key,
      JSON.stringify(value),
      Date.now()
    );
  }

  private async rememberSecret(secret: string): Promise<void> {
    if (this.roomSecret === secret) return;
    this.roomSecret = secret;
    await this.ctx.storage.put("secret", secret);
  }

  private async readSecret(): Promise<string | null> {
    if (this.roomSecret !== null) return this.roomSecret;
    this.roomSecret = await this.ctx.storage.get<string>("secret") ?? "";
    return this.roomSecret;
  }

  private broadcastDirectory(): void {
    this.broadcast({ type: "directory", rooms: this.listRooms() }, "directory");
    this.broadcast({ type: "users", users: this.listUsers() }, "directory");
  }

  private broadcast(payload: unknown, kind: SocketKind = "room"): void {
    const message = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as { kind?: SocketKind } | undefined;
      if ((attachment?.kind ?? "room") === kind) ws.send(message);
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (env.MAINTENANCE === "1" && !url.pathname.startsWith("/api/admin/clear-all")) {
      return new Response(maintenanceHtml(), {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
      });
    }
    if (url.pathname === "/api/auth/vjudge/verify" && request.method === "POST") return verifyVJudgeLogin(request, env);
    const problemBankMatch = url.pathname.match(/^\/api\/problem-bank\/(luogu|codeforces|atcoder)$/);
    if (problemBankMatch && request.method === "GET") {
      return proxyProblemBank(request, problemBankMatch[1] as ProblemBankSource, ctx);
    }
    if (url.pathname === "/api/vjudge/status" && request.method === "GET") return fetchVJudgeStatus(url);
    if (url.pathname === "/api/rooms" && request.method === "GET") {
      return directoryJsonResponse(request, env, "https://duel.internal/directory");
    }
    if (url.pathname === "/api/rooms/ws") return env.DUEL_ROOM.getByName("__directory").fetch(new Request("https://duel.internal/directory/ws", request));
    if (url.pathname === "/api/users" && request.method === "GET") {
      return directoryJsonResponse(request, env, "https://duel.internal/users");
    }
    if (url.pathname === "/api/admin/clear-all" && request.method === "POST") {
      return env.DUEL_ROOM.getByName("__directory").fetch("https://duel.internal/clear-all", request);
    }
    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch) {
      return env.DUEL_ROOM.getByName("__directory").fetch(new Request(`https://duel.internal/users/${userMatch[1]}`, request));
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(ws|snapshot|event)$/);
    if (roomMatch) {
      const roomId = decodeURIComponent(roomMatch[1]);
      const action = roomMatch[2];
      const secret = url.searchParams.get("secret") || "public-room";
      const stub = env.DUEL_ROOM.getByName(`${roomId}:${secret}`);
      return stub.fetch(new Request(`https://duel.internal/${action}?secret=${encodeURIComponent(secret)}`, request));
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (request.method !== "GET" || !assetResponse.ok) return assetResponse;
    const pathname = new URL(request.url).pathname;
    const headers = new Headers(assetResponse.headers);
    if (pathname === "/" || pathname.endsWith(".html")) {
      headers.set("cache-control", "no-store");
    } else {
      headers.set("cache-control", "public, max-age=0, must-revalidate, s-maxage=86400, stale-while-revalidate=604800");
    }
    return new Response(assetResponse.body, { status: assetResponse.status, statusText: assetResponse.statusText, headers });
  }
};

type ProblemBankSource = "luogu" | "codeforces" | "atcoder";

const problemBankSources: Record<ProblemBankSource, { url: string; accept: string }> = {
  luogu: {
    url: "https://cdn.luogu.com.cn/problemset-open/latest.ndjson.gz",
    accept: "application/gzip, application/octet-stream"
  },
  codeforces: {
    url: "https://codeforces.com/api/problemset.problems",
    accept: "application/json"
  },
  atcoder: {
    url: "https://kenkoooo.com/atcoder/resources/problem-models.json",
    accept: "application/json"
  }
};

const problemBankCacheSeconds = 30 * 24 * 60 * 60;

const proxyProblemBank = async (request: Request, source: ProblemBankSource, ctx: ExecutionContext): Promise<Response> => {
  try {
    const cacheUrl = new URL(request.url);
    cacheUrl.search = "";
    const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
    const cache = (caches as CacheStorage & { default: Cache }).default;
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const config = problemBankSources[source];
    const upstream = await fetch(config.url, {
      headers: { accept: config.accept },
      cf: { cacheEverything: true, cacheTtl: problemBankCacheSeconds },
      signal: AbortSignal.timeout(60_000)
    });
    if (!upstream.ok) return jsonError(`${source} problem bank upstream returned ${upstream.status}`, 502);

    const headers = new Headers(upstream.headers);
    headers.set("cache-control", `public, max-age=${problemBankCacheSeconds}, s-maxage=${problemBankCacheSeconds}`);
    headers.delete("set-cookie");
    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : `${source} problem bank proxy failed`, 502);
  }
};

const fetchVJudgeStatus = async (requestUrl: URL): Promise<Response> => {
  const oj = requestUrl.searchParams.get("oj") || "";
  const problem = (requestUrl.searchParams.get("problem") || "").trim();
  const allowedOjs = new Set(["AtCoder", "CodeForces", "洛谷"]);
  if (!allowedOjs.has(oj) || !/^[A-Za-z0-9_.-]{1,80}$/.test(problem)) return jsonError("invalid VJudge status query", 400);

  const upstreamUrl = new URL("https://vjudge.net/status/data");
  upstreamUrl.searchParams.set("length", "20");
  upstreamUrl.searchParams.set("OJId", oj);
  upstreamUrl.searchParams.set("probNum", problem);
  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { accept: "application/json", referer: "https://vjudge.net/status" },
      signal: AbortSignal.timeout(12_000)
    });
    if (!upstream.ok) return jsonError(`VJudge status upstream returned ${upstream.status}`, 502);
    const payload = (await upstream.json()) as { data?: Array<Record<string, unknown>> };
    const data = (payload.data ?? []).slice(0, 20).flatMap((record) => {
      const userId = typeof record.userId === "number" || typeof record.userId === "string" ? record.userId : undefined;
      const userName = typeof record.userName === "string" ? record.userName : "";
      const status = typeof record.status === "string" ? record.status : "";
      const time = typeof record.time === "number" ? record.time : Number(record.time);
      const runId = typeof record.runId === "number" || typeof record.runId === "string" ? record.runId : "";
      return userId !== undefined && status && Number.isFinite(time) ? [{ userId, userName, status, time, runId }] : [];
    });
    return Response.json({ data }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "VJudge status request failed", 502);
  }
};

const directoryJsonResponse = async (request: Request, env: Env, internalUrl: string): Promise<Response> => {
  try {
    const publicUrl = new URL(request.url);
    publicUrl.search = "";
    const cacheKey = new Request(publicUrl.toString(), { method: "GET" });
    const cache = (caches as CacheStorage & { default: Cache }).default;
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const response = await env.DUEL_ROOM.getByName("__directory").fetch(internalUrl);
    if (!response.ok) return jsonError(`directory returned ${response.status}`, response.status);
    const payload = await response.json();
    const body = JSON.stringify(payload);
    const complete = new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(new TextEncoder().encode(body).byteLength),
        "cache-control": "public, max-age=20, s-maxage=20, stale-while-revalidate=20"
      }
    });
    await cache.put(cacheKey, complete.clone());
    return complete;
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "directory response incomplete", 502);
  }
};

const verifyVJudgeLogin = async (request: Request, env: Env): Promise<Response> => {
  const body = (await request.json().catch(() => null)) as { username?: unknown; challenge?: unknown } | null;
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const challenge = typeof body?.challenge === "string" ? body.challenge.trim() : "";
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(username)) return jsonError("请输入有效的 VJudge 用户名", 400);
  if (!/^\d{6}$/.test(challenge)) return jsonError("验证码必须为六位数字", 400);

  try {
    const response = await fetch(`https://vjudge.net/user/${encodeURIComponent(username)}`, {
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 404) return jsonError("未找到该 VJudge 用户", 404);
    if (!response.ok) throw new Error(`VJudge 返回 ${response.status}`);
    const html = await response.text();
    const school = extractProfileField(html, "user.profile.school");
    if (!school.includes(challenge)) return jsonError("学校字段中未找到当前六位验证码", 403);
    const avatar = extractVJudgeAvatar(html);
    const saved = await env.DUEL_ROOM.getByName("__directory").fetch(
      new Request(`https://duel.internal/users/${encodeURIComponent(username)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: username, avatar })
      })
    );
    if (!saved.ok) throw new Error("用户资料保存失败");
    return Response.json({ session: { username, avatar, signedInAt: Date.now() } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "VJudge 验证失败", 502);
  }
};

const extractProfileField = (html: string, i18nKey: string): string => {
  const marker = `data-i18n="${i18nKey}"`;
  const start = html.indexOf(marker);
  if (start < 0) return "";
  const field = html.slice(start, html.indexOf("</div>", start) + 6);
  const value = field.match(/<dd[^>]*>([\s\S]*?)<\/dd>/i)?.[1] ?? "";
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
};

const extractVJudgeAvatar = (html: string): string | undefined => {
  const tag = html.match(/<img\b[^>]*\bid=["']user_avatar["'][^>]*>/i)?.[0] ?? "";
  const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
  if (!src) return undefined;
  try {
    return new URL(decodeHtml(src), "https://vjudge.net").toString();
  } catch {
    return undefined;
  }
};

const decodeHtml = (value: string): string => value
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, "\"")
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">");

/*
const authCallback = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const cookies = readCookies(request);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const expectedState = cookies.get("luogu_duel_oauth_state") || "";
  let returnTo = safeReturnTo(cookies.get("luogu_duel_oauth_return") || "/");
  const headers = new Headers({
    "cache-control": "no-store"
  });
  clearOAuthCookies(headers);

  try {
    if (!code || !state || !expectedState || state !== expectedState) {
      throw new Error("OAuth state mismatch");
    }
    const luoguName = await exchangeCodeForLuoguName(
      {
        code,
        redirect_uri: `${url.origin}/api/auth/callback`
      },
      env
    );
    returnTo = withAuthParam(returnTo, "auth_session", JSON.stringify({ luoguName, signedInAt: Date.now() }));
    headers.append("set-cookie", cookie("luogu_duel_cp_session", JSON.stringify({ luoguName, signedInAt: Date.now() }), 30 * 24 * 60 * 60));
    headers.append("set-cookie", clearCookie("luogu_duel_oauth_error"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    returnTo = withAuthParam(returnTo, "auth_error", message);
    headers.append("set-cookie", cookie("luogu_duel_oauth_error", message, 300));
  }

  headers.set("location", returnTo);
  return new Response(null, { status: 302, headers });
};

const authLogin = (request: Request, env: Env): Response => {
  const url = new URL(request.url);
  const state = crypto.randomUUID().replaceAll("-", "");
  const returnTo = safeReturnTo(url.searchParams.get("returnTo") || "/");
  const authorize = new URL("/oauth/authorize", oauthBase);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", env.CP_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${url.origin}/api/auth/callback`);
  authorize.searchParams.set("scope", oauthScope);
  authorize.searchParams.set("state", state);
  const headers = new Headers({
    location: authorize.toString(),
    "cache-control": "no-store"
  });
  headers.append("set-cookie", cookie("luogu_duel_oauth_state", state, 300));
  headers.append("set-cookie", cookie("luogu_duel_oauth_return", returnTo, 300));
  headers.append("set-cookie", clearCookie("luogu_duel_oauth_error"));
  return new Response(null, { status: 302, headers });
};

const exchangeOAuthCode = async (request: Request, env: Env): Promise<Response> => {
  const body = (await request.json()) as { code?: string; code_verifier?: string; redirect_uri?: string };
  if (!body.code || !body.code_verifier || !body.redirect_uri) return jsonError("missing oauth fields", 400);

  try {
    const luoguName = await exchangeCodeForLuoguName(body, env);
    return Response.json({ luoguName });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 502);
  }
};

const exchangeCodeForLuoguName = async (
  body: { code?: string; code_verifier?: string; redirect_uri?: string },
  env: Env
): Promise<string> => {
  const token = await exchangeToken(body, env);
  if (!token.access_token) throw new Error("missing access token");

  const userInfo = await fetchUserInfo(token.access_token);
  if (!userInfo) throw new Error("oauth userinfo failed");
  const typedUserInfo = userInfo as {
    username?: string;
    display_name?: string;
    linked_accounts?: Array<{ platform?: string; username?: string; name?: string }>;
    luogu?: { username?: string; name?: string };
  };
  const luoguName = extractLuoguName(typedUserInfo);
  if (!luoguName) throw new Error("no luogu account linked");
  return luoguName;
};

const extractLuoguName = (userInfo: {
  username?: string;
  display_name?: string;
  linked_accounts?: Array<Record<string, unknown>>;
  luogu?: Record<string, unknown>;
}): string => {
  const linked = userInfo.linked_accounts?.find((account) => {
    const platform = String(account.platform ?? account.provider ?? account.type ?? "").toLowerCase();
    return platform.includes("luogu") || platform.includes("洛谷");
  });
  return (
    stringField(linked, "username") ||
    stringField(linked, "platformUsername") ||
    stringField(linked, "name") ||
    stringField(linked, "handle") ||
    stringField(linked, "display_name") ||
    stringField(userInfo.luogu, "username") ||
    stringField(userInfo.luogu, "name") ||
    stringField(userInfo.luogu, "handle") ||
    stringField(userInfo.luogu, "display_name") ||
    stringField(userInfo as Record<string, unknown>, "luogu_username") ||
    stringField(userInfo as Record<string, unknown>, "luoguName")
  );
};

const fetchLuoguRecords = async (url: URL, env: Env): Promise<Response> => {
  const pid = (url.searchParams.get("pid") || "").trim().toUpperCase();
  const target = new URL("https://www.luogu.com.cn/record/list");
  target.searchParams.set("pid", pid);
  target.searchParams.set("_contentOnly", "1");
  const response = await fetchThroughLuoguProxy(target, "application/json");
  return new Response(await response.text(), {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
};

const fetchLuoguUserSearch = async (url: URL, env: Env): Promise<Response> => {
  const keyword = (url.searchParams.get("keyword") || "").trim();
  if (!keyword || keyword.length > 40) return jsonError("invalid keyword", 400);
  const target = new URL("https://www.luogu.com.cn/api/user/search");
  target.searchParams.set("keyword", keyword);
  const response = await fetchThroughLuoguProxy(target, "application/json");
  return new Response(await response.text(), {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "public, max-age=300"
    }
  });
};

const fetchLuoguProblemBank = async (): Promise<Response> => {
  const response = await fetchThroughLuoguProxy(new URL("https://cdn.luogu.com.cn/problemset-open/latest.ndjson.gz"), "application/gzip");
  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "application/gzip",
      "cache-control": "public, max-age=0, must-revalidate, s-maxage=86400"
    }
  });
};

const fetchThroughLuoguProxy = async (target: URL, accept: string): Promise<Response> => {
  const proxy = new URL(luoguProxyBase);
  proxy.searchParams.set("url", target.toString());
  try {
    const response = await fetch(proxy, { headers: { accept }, signal: AbortSignal.timeout(12_000) });
    if (response.ok) return response;
  } catch {
    // The Worker runs outside mainland China, but keep a direct fallback for a transient HF outage.
  }
  return fetch(target, { headers: { accept }, signal: AbortSignal.timeout(12_000) });
};
*/

const stringField = (source: Record<string, unknown> | undefined, key: string): string => {
  const value = source?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
};

const normalizeName = (name: string): string => name.trim().toLowerCase();

const dedupeNames = (names: string[]): string[] => {
  const seen = new Set<string>();
  return names.flatMap((name) => {
    const trimmed = name.trim();
    const key = normalizeName(trimmed);
    if (!trimmed || seen.has(key)) return [];
    seen.add(key);
    return [trimmed];
  });
};

const listingNames = (listing: RoomListing): string[] =>
  dedupeNames([listing.host, ...(listing.redPlayers ?? []), ...(listing.bluePlayers ?? [])]);

const average = (values: number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 1300;

const applyRatingDelta = (user: UserRecord, delta: number, won: boolean): UserRecord => ({
  ...user,
  rating: Math.max(0, user.rating + delta),
  wins: user.wins + (won ? 1 : 0),
  losses: user.losses + (won ? 0 : 1),
  games: user.games + 1,
  updatedAt: Date.now()
});

const compareEnvelopes = (a: SignedEnvelope, b: SignedEnvelope): number =>
  a.event.lamport - b.event.lamport || a.event.issuedAt - b.event.issuedAt || a.event.id.localeCompare(b.event.id);

const cacheHeaders = (_browserMaxAge: number, edgeMaxAge = _browserMaxAge): HeadersInit => ({
  "cache-control": `public, max-age=0, must-revalidate, s-maxage=${edgeMaxAge}, stale-while-revalidate=${edgeMaxAge * 4}`
});

const isBannedAvatar = (avatar: unknown): boolean => avatar === bannedAvatarUrl;
const isPlayingSeat = (seat: unknown): boolean => seat === "red" || seat === "blue";
const systemCloseEnvelope = async (roomId: string, lamport: number, issuedAt: number): Promise<SignedEnvelope> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const actorId = await keyId(publicKey);
  const event: DuelEvent = {
    type: "room.closed",
    roomId,
    actorId,
    id: crypto.randomUUID(),
    lamport,
    issuedAt,
    actorName: "gcend",
    reason: "房间创建 10 分钟仍未开始，已自动关闭"
  };
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, textBytes(stableStringify(event)));
  return { publicKey, event, signature: btoa(String.fromCharCode(...new Uint8Array(signature))) };
};

const keyId = async (publicKey: JsonWebKey): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", textBytes(stableStringify(publicKey)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
};

const textBytes = (value: string): ArrayBuffer => {
  const encoded = new TextEncoder().encode(value);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
};

const stableStringify = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
};
const directoryFingerprint = (state: ReturnType<typeof createInitialState>): string => JSON.stringify({
  phase: state.phase,
  hostId: state.hostId,
  startedAt: state.startedAt,
  endedAt: state.endedAt,
  winner: state.winner,
  closed: state.closed,
  rated: state.rated,
  problemCount: state.problems.length,
  players: Object.values(state.players)
    .map((player) => [player.id, player.luoguName, player.team, player.online])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
});

const maintenanceHtml = (): string => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VJudge Duel Maintenance</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1016;color:#eef4ff;font:16px/1.6 system-ui,sans-serif}
main{max-width:560px;padding:28px;border:1px solid #263241;border-radius:8px;background:#111820;box-shadow:0 20px 70px #0008}
h1{margin:0 0 8px;font-size:24px}p{margin:0;color:#a8b3c1}
</style>
<main><h1>Luogu Duel 正在维护</h1><p>本次更新正在清空旧房间与刷新用户数据，稍后自动恢复访问。</p></main>`;

const jsonError = (message: string, status: number): Response => Response.json({ error: message }, { status });
