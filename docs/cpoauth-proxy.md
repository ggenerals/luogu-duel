# CP OAuth Proxy

Browser SPA code cannot call `https://www.cpoauth.com/api/oauth/token` directly
when that endpoint does not return CORS headers. Add a small endpoint to the
existing API service and set:

```text
VITE_CP_OAUTH_PROXY=https://oauth.gengen.qzz.io/
```

## Endpoint Contract

Frontend request:

```http
POST /oauth/callback
Content-Type: application/json
```

```json
{
  "code": "AUTHORIZATION_CODE",
  "code_verifier": "PKCE_VERIFIER",
  "redirect_uri": "https://duel.gengen.qzz.io/callback",
  "client_id": "85694b6a-9167-48dc-9e00-343d23d826ef"
}
```

Response:

```json
{
  "luoguName": "example_user"
}
```

## Worker-Style Example

Keep `CP_OAUTH_SECRET` on the server. Do not expose it to the browser bundle.

```js
const CORS = {
  "access-control-allow-origin": "https://duel.gengen.qzz.io",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname !== "/oauth/callback" || request.method !== "POST") {
      return new Response("Not found", { status: 404, headers: CORS });
    }

    const { code, redirect_uri, client_id, code_verifier } = await request.json();
    if (!code || !redirect_uri || !client_id) {
      return json({ error: "missing_fields" }, 400);
    }

    const tokenResponse = await fetch("https://www.cpoauth.com/api/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id,
        client_secret: env.CP_OAUTH_SECRET,
        code,
        redirect_uri,
        code_verifier
      })
    });

    const token = await tokenResponse.json();
    if (!tokenResponse.ok || token.error) {
      return json({ error: token.error || "token_failed", detail: token }, 400);
    }

    const userResponse = await fetch("https://www.cpoauth.com/api/oauth/userinfo", {
      headers: {
        authorization: `Bearer ${token.access_token}`,
        accept: "application/json"
      }
    });

    const userinfo = await userResponse.json();
    if (!userResponse.ok) {
      return json({ error: "userinfo_failed", detail: userinfo }, 400);
    }

    const luogu = userinfo.linked_accounts?.find(
      (account) => account.platform?.toLowerCase() === "luogu"
    );
    const luoguName = luogu?.username || luogu?.name || userinfo.luogu?.username || userinfo.username;
    if (!luoguName) {
      return json({ error: "luogu_not_linked" }, 403);
    }

    return json({ luoguName });
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      "content-type": "application/json; charset=utf-8"
    }
  });
}
```

For local development, also allow the local origin in CORS or echo allowed
origins dynamically.
