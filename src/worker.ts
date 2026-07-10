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
};

type RoomListing = {
  roomId: string;
  secret: string;
  host: string;
  createdAt: number;
  problemCount: number;
  status: "lobby" | "arena";
  startedAt?: number;
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
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const secret = url.searchParams.get("secret");
    if (secret) await this.ctx.storage.put("secret", secret);
    if (url.pathname.endsWith("/directory")) return this.handleDirectory(request);
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
    if (state.phase === "finished") {
      await directory.fetch("https://duel.internal/directory", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId })
      });
      return;
    }
    const firstEvent = this.listEvents()[0]?.event ?? latestEvent;
    const firstPlayer = Object.values(state.players)[0];
    const listing: RoomListing = {
      roomId,
      secret: "",
      host: state.players[state.hostId ?? ""]?.luoguName ?? firstPlayer?.luoguName ?? "unknown",
      createdAt: firstEvent.issuedAt,
      problemCount: state.problems.length,
      status: state.phase === "arena" ? "arena" : "lobby",
      startedAt: state.startedAt
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
      const maxAge = Date.now() - 6 * 60 * 60 * 1000;
      const rooms = this.ctx.storage.sql
        .exec<{ listing: string; updated_at: number }>("SELECT listing, updated_at FROM listings WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT 80", maxAge)
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
      return Response.json({ ok: true });
    }
    if (request.method === "DELETE") {
      const body = (await request.json()) as { roomId?: string };
      if (body.roomId) this.ctx.storage.sql.exec("DELETE FROM listings WHERE room_id = ?", body.roomId);
      return Response.json({ ok: true });
    }
    return jsonError("method not allowed", 405);
  }

  private broadcast(payload: unknown): void {
    const message = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) ws.send(message);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/login") return authLogin(request, env);
    if (url.pathname === "/api/auth/callback") return authCallback(request, env);
    if (url.pathname === "/api/auth/exchange" && request.method === "POST") return exchangeOAuthCode(request, env);
    if (url.pathname === "/api/luogu/records") return fetchLuoguRecords(url, env);
    if (url.pathname === "/api/rooms") return env.DUEL_ROOM.getByName("__directory").fetch("https://duel.internal/directory");

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

const stringField = (source: Record<string, unknown> | undefined, key: string): string => {
  const value = source?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
};

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
