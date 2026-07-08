const DEFAULT_CLIENT_ID = "85694b6a-9167-48dc-9e00-343d23d826ef";
const CPOAUTH_ENDPOINT = "https://www.cpoauth.com";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://duel.gengen.qzz.io",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174"
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/health") return json({ ok: true }, 200, cors);
    if (url.pathname === "/oauth/callback" && request.method === "POST") {
      return handleOAuthCallback(request, env, cors);
    }
    if (url.pathname === "/luogu/records" && request.method === "GET") {
      return handleLuoguRecords(url, env, cors);
    }

    return json({ error: "not_found" }, 404, cors);
  }
};

async function handleOAuthCallback(request, env, cors) {
  const body = await request.json();
  const code = stringField(body.code);
  const redirectUri = stringField(body.redirect_uri);
  const clientId = env.CP_OAUTH_CLIENT_ID || stringField(body.client_id) || DEFAULT_CLIENT_ID;

  if (!code || !redirectUri || !clientId) return json({ error: "missing_required_fields" }, 400, cors);

  const tokenPayload = {
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: env.CP_OAUTH_SECRET,
    code,
    redirect_uri: redirectUri
  };

  const tokenResponse = await fetch(`${CPOAUTH_ENDPOINT}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(tokenPayload)
  });
  const token = await safeJson(tokenResponse);
  if (!tokenResponse.ok || token.error || !token.access_token) {
    return json({ error: "token_exchange_failed", status: tokenResponse.status, detail: stripSensitive(token) }, 400, cors);
  }

  const userResponse = await fetch(`${CPOAUTH_ENDPOINT}/api/oauth/userinfo`, {
    headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" }
  });
  const userinfo = await safeJson(userResponse);
  if (!userResponse.ok) {
    return json({ error: "userinfo_failed", status: userResponse.status, detail: stripSensitive(userinfo) }, 400, cors);
  }

  const luogu = userinfo.linked_accounts?.find((account) => String(account.platform || "").toLowerCase() === "luogu");
  const luoguName = luogu?.username || luogu?.name || userinfo.luogu?.username || userinfo.luogu?.name;
  if (!luoguName) return json({ error: "luogu_not_linked" }, 403, cors);
  return json({ luoguName }, 200, cors);
}

async function handleLuoguRecords(url, env, cors) {
  const pid = url.searchParams.get("pid") || "";
  if (!/^P\d{1,5}$/i.test(pid)) return json({ error: "invalid_pid" }, 400, cors);

  const target = new URL("https://www.luogu.com.cn/record/list");
  target.searchParams.set("pid", pid.toUpperCase());
  target.searchParams.set("_contentOnly", "1");

  const response = await fetch(target, {
    headers: {
      accept: "application/json",
      cookie: env.LUOGU_COOKIE || ""
    }
  });

  return new Response(await response.text(), {
    status: response.status,
    headers: {
      ...cors,
      "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    "access-control-allow-origin": allowed.includes(origin) ? origin : allowed[0] || "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function stringField(value) {
  return typeof value === "string" ? value : "";
}

function stripSensitive(value) {
  if (!value || typeof value !== "object") return value;
  const clone = { ...value };
  delete clone.access_token;
  delete clone.refresh_token;
  delete clone.id_token;
  return clone;
}
