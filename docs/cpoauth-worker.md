# CP OAuth Worker Exchange

The browser starts CP OAuth with PKCE and redirects to:

```text
https://duel.gengen.qzz.io/api/auth/callback
```

The Worker serves a tiny callback page that reads the verifier from
`sessionStorage`, then posts to:

```http
POST /api/auth/exchange
Content-Type: application/json
```

```json
{
  "code": "AUTHORIZATION_CODE",
  "code_verifier": "PKCE_VERIFIER",
  "redirect_uri": "https://duel.gengen.qzz.io/api/auth/callback"
}
```

The Worker exchanges the code with CP OAuth using:

- `CP_CLIENT_ID` from `wrangler.jsonc`
- `CP_CLIENT_SECRET` from Cloudflare Worker secrets

Set the secret with:

```sh
npx wrangler secret put CP_CLIENT_SECRET
```

The browser only receives:

```json
{
  "luoguName": "example_user"
}
```

Do not expose the client secret in frontend code or repository files.
