/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import { applyEvents, createInitialState } from "./domain";
import type { DuelEvent, SignedEnvelope } from "./types";

type Env = {
  DUEL_ROOM: DurableObjectNamespace<DuelRoom>;
  ASSETS: Fetcher;
  CP_CLIENT_ID: string;
  CP_CLIENT_SECRET: string;
  LUOGU_COOKIE?: string;
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

const oauthBase = "https://www.cpoauth.com";
const oauthScope = "openid profile cp:linked link:luogu";

export class DuelRoom extends DurableObject<Env> {
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
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const secret = url.searchParams.get("secret");
    if (secret) await this.ctx.storage.put("secret", secret);
    if (url.pathname.endsWith("/directory")) return this.handleDirectory(request);
    if (url.pathname.endsWith("/users")) return this.handleUsers(request);
    if (url.pathname.endsWith("/clear-all")) return this.handleClearAll(request);
    const userMatch = url.pathname.match(/\/users\/([^/]+)$/);
    if (userMatch) return this.handleUser(request, decodeURIComponent(userMatch[1]));
    if (url.pathname.endsWith("/ws")) return this.handleWebSocket(request);
    if (url.pathname.endsWith("/snapshot")) return Response.json({ envelopes: this.listEvents() });
    if (url.pathname.endsWith("/event") && request.method === "POST") {
      const body = (await request.json()) as Partial<ClientMessage>;
      if (!body.envelope) return jsonError("missing envelope", 400);
      const saved = await this.acceptEnvelope(body.envelope);
      if (saved) this.broadcast({ type: "event", envelope: body.envelope });
      return Response.json({ ok: true });
    }
    return jsonError("not found", 404);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    try {
      const data = JSON.parse(message) as Partial<ClientMessage>;
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

  private handleWebSocket(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") return jsonError("expected websocket", 426);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ connectedAt: Date.now() });
    server.send(JSON.stringify({ type: "hello", envelopes: this.listEvents() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async acceptEnvelope(envelope: SignedEnvelope): Promise<boolean> {
    const event = envelope.event;
    const saved = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM events WHERE id = ?", event.id).toArray();
    if (saved.length > 0) return false;

    this.ctx.storage.sql.exec(
      "INSERT INTO events (id, room_id, issued_at, lamport, envelope) VALUES (?, ?, ?, ?, ?)",
      event.id,
      event.roomId,
      event.issuedAt,
      event.lamport,
      JSON.stringify(envelope)
    );
    await this.updateDirectory(event.roomId, event);
    return true;
  }

  private listEvents(): SignedEnvelope[] {
    return this.ctx.storage.sql
      .exec<{ envelope: string }>("SELECT envelope FROM events ORDER BY lamport ASC, issued_at ASC, id ASC LIMIT 1000")
      .toArray()
      .map((row) => JSON.parse(row.envelope) as SignedEnvelope);
  }

  private async updateDirectory(roomId: string, latestEvent: DuelEvent): Promise<void> {
    if (roomId === "global" || roomId === "__directory") return;
    const state = applyEvents(roomId, this.listEvents().map((item) => item.event));
    const directory = this.env.DUEL_ROOM.getByName("__directory");
    const firstEvent = this.listEvents()[0]?.event ?? latestEvent;
    const firstPlayer = Object.values(state.players)[0];
    const redPlayers = Object.values(state.players).filter((player) => player.team === "red").map((player) => player.luoguName);
    const bluePlayers = Object.values(state.players).filter((player) => player.team === "blue").map((player) => player.luoguName);
    const listing: RoomListing = {
      roomId,
      secret: "",
      host: state.players[state.hostId ?? ""]?.luoguName ?? firstPlayer?.luoguName ?? "unknown",
      createdAt: firstEvent.issuedAt,
      problemCount: state.problems.length,
      status: state.phase === "finished" ? "finished" : state.phase === "arena" ? "arena" : "lobby",
      startedAt: state.startedAt,
      endedAt: state.phase === "finished" ? latestEvent.issuedAt : undefined,
      winner: state.winner,
      redPlayers,
      bluePlayers
    };
    const attachmentSecret = await this.ctx.storage.get<string>("secret");
    if (attachmentSecret) listing.secret = attachmentSecret;
    await directory.fetch("https://duel.internal/directory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listing })
    });
  }

  private async handleDirectory(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const maxAge = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const rooms = this.ctx.storage.sql
        .exec<{ listing: string; updated_at: number }>("SELECT listing, updated_at FROM listings WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT 120", maxAge)
        .toArray()
        .map((row) => JSON.parse(row.listing) as RoomListing);
      return Response.json({ rooms });
    }
    if (request.method === "POST") {
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
      return Response.json({ ok: true });
    }
    if (request.method === "DELETE") {
      const body = (await request.json()) as { roomId?: string };
      if (body.roomId) this.ctx.storage.sql.exec("DELETE FROM listings WHERE room_id = ?", body.roomId);
      return Response.json({ ok: true });
    }
    return jsonError("method not allowed", 405);
  }

  private handleUsers(request: Request): Response {
    if (request.method !== "GET") return jsonError("method not allowed", 405);
    const users = this.ctx.storage.sql
      .exec<{ user_json: string }>("SELECT user_json FROM users ORDER BY updated_at DESC LIMIT 1000")
      .toArray()
      .map((row) => JSON.parse(row.user_json) as UserRecord)
      .sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.name.localeCompare(b.name));
    return Response.json({ users });
  }

  private async handleUser(request: Request, rawName: string): Promise<Response> {
    const name = rawName.trim();
    if (!name) return jsonError("missing name", 400);
    if (request.method === "GET") {
      const user = this.readUser(name);
      return user ? Response.json({ user }) : jsonError("not found", 404);
    }
    if (request.method === "POST") {
      const body = (await request.json()) as Partial<UserRecord>;
      const user = this.upsertUser({
        name,
        avatar: stringField(body as Record<string, unknown>, "avatar") || undefined,
        color: stringField(body as Record<string, unknown>, "color") || undefined,
        profileHtml: typeof body.profileHtml === "string" ? body.profileHtml.slice(0, 20_000) : undefined
      });
      return Response.json({ user });
    }
    return jsonError("method not allowed", 405);
  }

  private handleClearAll(request: Request): Response {
    if (request.method !== "POST") return jsonError("method not allowed", 405);
    for (const table of ["events", "listings", "users", "processed_results"]) {
      this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
    }
    return Response.json({ ok: true });
  }

  private registerListingUsers(listing: RoomListing): void {
    for (const name of listingNames(listing)) this.upsertUser({ name });
  }

  private applyFinishedListingResult(listing: RoomListing): void {
    if (listing.status !== "finished" || listing.winner === "draw" || !listing.winner) return;
    const red = dedupeNames(listing.redPlayers ?? []);
    const blue = dedupeNames(listing.bluePlayers ?? []);
    if (!red.length || !blue.length) return;
    const processed = this.ctx.storage.sql
      .exec<{ room_id: string }>("SELECT room_id FROM processed_results WHERE room_id = ?", listing.roomId)
      .toArray();
    if (processed.length) return;

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
  }

  private readUser(name: string): UserRecord | null {
    const key = normalizeName(name);
    const rows = this.ctx.storage.sql
      .exec<{ user_json: string }>("SELECT user_json FROM users WHERE name_key = ?", key)
      .toArray();
    return rows[0] ? JSON.parse(rows[0].user_json) as UserRecord : null;
  }

  private upsertUser(input: { name: string; avatar?: string; color?: string; profileHtml?: string }): UserRecord {
    const existing = this.readUser(input.name);
    const user: UserRecord = {
      name: existing?.name || input.name.trim(),
      rating: existing?.rating ?? 1300,
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
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO users (name_key, user_json, updated_at) VALUES (?, ?, ?)",
      normalizeName(user.name),
      JSON.stringify(user),
      user.updatedAt
    );
    return user;
  }

  private broadcast(payload: unknown): void {
    const message = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) ws.send(message);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (env.MAINTENANCE === "1" && !url.pathname.startsWith("/api/admin/clear-all")) {
      return new Response(maintenanceHtml(), {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
      });
    }
    if (url.pathname === "/api/auth/login") return authLogin(request, env);
    if (url.pathname === "/api/auth/callback") return authCallback(request, env);
    if (url.pathname === "/api/auth/exchange" && request.method === "POST") return exchangeOAuthCode(request, env);
    if (url.pathname === "/api/luogu/records") return fetchLuoguRecords(url, env);
    if (url.pathname === "/api/luogu/user/search") return fetchLuoguUserSearch(url, env);
    if (url.pathname === "/api/rooms") return env.DUEL_ROOM.getByName("__directory").fetch("https://duel.internal/directory");
    if (url.pathname === "/api/users") return env.DUEL_ROOM.getByName("__directory").fetch("https://duel.internal/users", request);
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

    return env.ASSETS.fetch(request);
  }
};

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
  const response = await fetch(target, {
    headers: {
      accept: "application/json",
      cookie: env.LUOGU_COOKIE || "_uid=1058607; __client_id=yi3r6uea6ccsp2ns6z4v6x6guyyx6bykinni6go5aene2r4z"
    }
  });
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
  const response = await fetch(target, {
    headers: {
      accept: "application/json",
      cookie: env.LUOGU_COOKIE || "_uid=1058607; __client_id=yi3r6uea6ccsp2ns6z4v6x6guyyx6bykinni6go5aene2r4z"
    }
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "public, max-age=300"
    }
  });
};

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

const maintenanceHtml = (): string => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Luogu Duel Maintenance</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1016;color:#eef4ff;font:16px/1.6 system-ui,sans-serif}
main{max-width:560px;padding:28px;border:1px solid #263241;border-radius:8px;background:#111820;box-shadow:0 20px 70px #0008}
h1{margin:0 0 8px;font-size:24px}p{margin:0;color:#a8b3c1}
</style>
<main><h1>Luogu Duel 正在维护</h1><p>本次更新正在清空旧房间与刷新用户数据，稍后自动恢复访问。</p></main>`;

const exchangeToken = async (
  body: { code?: string; code_verifier?: string; redirect_uri?: string },
  env: Env
): Promise<{ access_token?: string }> => {
  const payload = {
    grant_type: "authorization_code",
    code: body.code,
    redirect_uri: body.redirect_uri,
    client_id: env.CP_CLIENT_ID,
    code_verifier: body.code_verifier
  };
  const payloads = [
    payload,
    {
      ...payload,
      client_secret: env.CP_CLIENT_SECRET
    }
  ];
  const endpoints = ["/api/oauth/token", "/oauth/token"];
  for (const endpoint of endpoints) {
    for (const currentPayload of payloads) {
      const jsonResponse = await fetch(new URL(endpoint, oauthBase), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(currentPayload)
      });
      if (jsonResponse.ok) return (await jsonResponse.json()) as { access_token?: string };

      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(currentPayload)) {
        if (value) form.set(key, value);
      }
      const formResponse = await fetch(new URL(endpoint, oauthBase), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form
      });
      if (formResponse.ok) return (await formResponse.json()) as { access_token?: string };
    }
  }
  return {};
};

const fetchUserInfo = async (accessToken: string): Promise<unknown | null> => {
  for (const endpoint of ["/api/oauth/userinfo", "/oauth/userinfo"]) {
    const response = await fetch(new URL(endpoint, oauthBase), {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
    });
    if (response.ok) return response.json();
  }
  return null;
};

const readCookies = (request: Request): Map<string, string> => {
  const cookies = new Map<string, string>();
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) continue;
    cookies.set(rawName, decodeURIComponent(rawValue.join("=") || ""));
  }
  return cookies;
};

const cookie = (name: string, value: string, maxAge: number): string =>
  `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure`;

const clearCookie = (name: string): string => `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;

const clearOAuthCookies = (headers: Headers) => {
  for (const key of ["state", "verifier", "return", "attempt"]) {
    headers.append("set-cookie", clearCookie(`luogu_duel_oauth_${key}`));
  }
};

const safeReturnTo = (value: string): string => {
  if (!value || value.startsWith("/api/auth/") || value.includes("/api/auth/")) return "/";
  return value.startsWith("/") ? value : "/";
};

const withAuthParam = (returnTo: string, key: string, value: string): string => {
  const url = new URL(returnTo, "https://duel.local");
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
};

const jsonError = (message: string, status: number): Response => Response.json({ error: message }, { status });
