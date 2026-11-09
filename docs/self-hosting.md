# Self-hosting

The stdio process is unchanged and remains the default. HTTP mode is for a machine you administer. It speaks the current Streamable HTTP MCP transport at `/mcp` and answers `GET /healthz` with `{"ok":true}`.

A typical layout is a Debian 12 unprivileged Proxmox LXC. The Node process binds to `127.0.0.1:8080`. Caddy or nginx in the same container terminates TLS for your domain and proxies the whole site.

Each person adds `https://<your-domain>/mcp` in their MCP client. The client discovers OAuth from a `401` and `WWW-Authenticate` header, registers itself, and opens a browser on this server. The person signs in with their own Artemis username and password. You do not create accounts or log anyone in on the server.

This server is its own OAuth 2.1 authorization server: protected-resource metadata, authorization-server metadata, dynamic client registration, an authorization-code flow with PKCE `S256`, rotating refresh tokens, and revocation. It does not fetch client-id metadata documents from other hosts. A static bearer token is still available for an admin client that cannot do OAuth.

Automated tests use an in-process mock of Artemis. They do not log in to a real Artemis server, and they do not exercise a real reverse proxy or a real MCP client.

## Size

For one or a few students:

| Resource | Starting point |
| --- | --- |
| CPU | 1 vCPU |
| Memory | 512 MB |
| Disk | 4 GB |
| OS | Debian 12 |
| Container | Unprivileged LXC, no nesting |

Node stays small. The extra disk is for the OS, the Node 22 install, and the state directory. Do not enable Docker. The process is a normal systemd service.

## Install, set the env, start

From a checkout of this repository, as root, on Debian 12:

```bash
sudo ./deploy/install-debian12.sh
```

The script installs Node.js 22 from the official tarball when `node` is missing or older than 22, creates the system user `artemis-mcp`, copies the app to `/opt/artemis-student-mcp`, installs the systemd unit and an env file, and starts the service. It does not touch an existing `/etc/artemis-student-mcp.env` and it does not delete the state directory.

Edit `/etc/artemis-student-mcp.env`:

- `ARTEMIS_BASE_URL` is the Artemis origin, such as `https://artemis.tum.de`.
- `ARTEMIS_MCP_PUBLIC_URL` is the public origin of this MCP server, with no path, such as `https://mcp.example.com`. That value is the OAuth issuer. The process does not take the issuer from `X-Forwarded-Proto` or `X-Forwarded-Host`.
- `ARTEMIS_REMEMBER_ME=true` asks Artemis for a longer session. The password is still not stored. The first sign-in for an account can cause Artemis to email that account.

Then:

```bash
systemctl restart artemis-student-mcp
```

Give each person `https://mcp.example.com/mcp`. They add that URL in Cursor, Claude, Grok Bot, or another client that implements MCP OAuth. The client opens the sign-in page. When the Artemis session later expires, the server answers `401` with `invalid_token` and the client starts the browser sign-in again.

The same steps by hand:

```bash
apt-get update
apt-get install -y ca-certificates curl xz-utils tar
# If node is not already 22 or newer, install the official linux tarball
# for your architecture under /usr/local. See deploy/install-debian12.sh.
useradd --system --user-group --home-dir /var/lib/artemis-student-mcp \
  --create-home --shell /usr/sbin/nologin artemis-mcp
install -d -o artemis-mcp -g artemis-mcp -m 700 /var/lib/artemis-student-mcp
rm -rf /opt/artemis-student-mcp
mkdir -p /opt/artemis-student-mcp
# Copy this repository to /opt/artemis-student-mcp, without .git.
chown -R root:root /opt/artemis-student-mcp
find /opt/artemis-student-mcp -type d -exec chmod 755 {} +
find /opt/artemis-student-mcp -type f -exec chmod 644 {} +
chmod 755 /opt/artemis-student-mcp/bin/artemis-student-mcp /opt/artemis-student-mcp/bin/artemis-student-auth
install -m 644 deploy/artemis-student-mcp.service /etc/systemd/system/artemis-student-mcp.service
install -m 640 -o root -g artemis-mcp deploy/artemis-student-mcp.env.example /etc/artemis-student-mcp.env
systemctl daemon-reload
systemctl enable --now artemis-student-mcp.service
```

The unit binds the process to the address in the env file. The shipped default is `127.0.0.1:8080`. Logs go to the journal and do not include OAuth tokens, Artemis session tokens, or passwords:

```bash
journalctl -u artemis-student-mcp -f
curl -fsS http://127.0.0.1:8080/healthz
```

## What the browser sign-in does

`GET /authorize` is a page on this server. It has no third-party scripts or images. It says that the server is unofficial and that the username and password are sent to this server, used once to sign in to the configured Artemis origin, and not stored. The form is protected by a cookie that must match a hidden field. The page is sent with `Referrer-Policy: same-origin`, so a browser includes this site's origin on the form POST. A POST whose `Origin` is the string `null` is still rejected. Failed attempts are shown on the page and rate-limited per username and per TCP peer.

The password is discarded after the Artemis login call. The Artemis session is stored under that person's account directory. Access tokens last 15 minutes. Refresh tokens last 30 days and rotate on every use. Reusing an old refresh token revokes that grant. `POST /revoke` revokes a presented token. Revoking a refresh token also revokes the access tokens in that grant.

A confirmation token for a write lives in that account's directory. It cannot be used with another person's access token.

`download_file`, lecture materials, and file links in posts and problem statements return a `downloadUrl` on this server: `<public URL>/files/<token>`. Minting the link does not download the file. The token is random. The server stores only its hash in memory, with the allowlisted path, the caller's account, and a 10-minute expiry. `GET /files/<token>` checks the token, expiry, and allowlist, then streams the file from Artemis with that caller's session. The body is not buffered and is not written to disk. The link works once. `HEAD` checks the link and does not use it up. A missing Artemis session returns 401. A revoked sign-in returns 410. An expired or reused link returns 404. A stdio session has no public URL, so `download_file` returns `http_required` and does not fetch the file.

## What is stored

`ARTEMIS_MCP_STATE_DIR` defaults to `/var/lib/artemis-student-mcp`. The directory is mode `0700`. Files inside it are mode `0600`.

| Path | Contents |
| --- | --- |
| `oauth.json` | Hashes of authorization codes, access tokens, and refresh tokens, plus registered redirect URIs. The raw tokens are not stored. |
| `access-tokens.json` | SHA-256 hashes of optional admin bearer tokens. |
| `users/<id>/session.json` | The Artemis session for that one OAuth grant or admin token. |
| `users/<id>/write-confirmations.json` | Two-phase write confirmations for that account only. |

## Reverse proxy

TLS ends at the proxy. Leave the Node process on loopback. Proxy the whole site, not only `/mcp`, so the client can fetch `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/register`, `/authorize`, `/token`, and `/revoke`. Do not publish port 8080 on the container's bridge.

Set `ARTEMIS_MCP_PUBLIC_URL` to the HTTPS origin. Send the public `Host` header. The server allows that host and, when a browser sends `Origin`, that origin. Requests with no `Origin` are allowed so native clients work. Loopback names stay allowed for local health checks.

`/mcp` must not be buffered. The server can answer `tools/call` with either JSON or a short server-sent event. `GET /mcp` returns 405 because this process does not open a standing event stream. Clients that speak Streamable HTTP continue with `POST`. The older HTTP+SSE transport is not implemented.

`/mcp` and `/healthz` reject every query string, so a token cannot be placed in the URL. `/authorize` uses its query string for the OAuth request. The password is only accepted as a form body.

If the proxy runs on a different machine, set `ARTEMIS_MCP_HOST` to a private address and allow only the proxy to connect. The process does not trust `X-Forwarded-For`. Failed `/mcp` authentications share one rate-limit bucket per TCP peer. A still-valid token is not blocked by that counter. Sign-in attempts are limited separately. Restarting the service clears the in-memory counters.

### Caddy

```caddy
mcp.example.com {
	encode off
	reverse_proxy 127.0.0.1:8080 {
		flush_interval -1
		header_up Host {host}
		header_up X-Forwarded-Proto {scheme}
		transport http {
			response_header_timeout 10m
			read_timeout 10m
			write_timeout 10m
		}
	}
}
```

`encode off` and `flush_interval -1` keep the proxy from buffering `/mcp` and `/files/`. The ten-minute timeouts cover a slow Artemis read. Caddy obtains and renews the certificate for the site. `X-Forwarded-Proto` is recorded for the proxy's own logs. This server does not use it to choose the OAuth issuer.

### nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name mcp.example.com;

    ssl_certificate     /etc/letsencrypt/live/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        gzip off;
        proxy_read_timeout 10m;
        proxy_send_timeout 10m;
        client_max_body_size 8m;
    }
}
```

`client_max_body_size 8m` matches the MCP request limit, which is the same 8 MB cap as a file-upload exercise. OAuth form and registration bodies are limited further, to 16 KB.

`proxy_buffering off` applies to `/files/` as well as `/mcp`. Leave it off. If you split `/files/` into its own `location`, copy the proxy settings above and add `proxy_max_temp_file_size 0` so nginx does not spill a large download onto disk. `gzip off` avoids compressing the stream. The sample `location /` already covers `/files/`, so an existing config with that one location does not need a new block as long as buffering stays off.

## Optional admin bearer token

A client that cannot run OAuth can still use a bearer token created on the server. Run the commands as `artemis-mcp` so the files stay owned by the service user. `su` gives the login command a terminal, which it needs to turn off echo.

```bash
su -s /bin/bash artemis-mcp
set -a
. /etc/artemis-student-mcp.env
set +a
cd /opt/artemis-student-mcp
./bin/artemis-student-mcp token create --label laptop
./bin/artemis-student-mcp login t_<id>
exit
```

`token create` prints the bearer token once on stdout. It cannot be printed again. Pass the id, not the bearer token, to `login`, `status`, `logout`, and `token revoke`. `login` uses the same directory-password and password flow as the browser. The login origin has to match `ARTEMIS_BASE_URL`.

The client then sends `Authorization: Bearer <bearer-token>` to `https://mcp.example.com/mcp`. Do not put the token in the URL.

## Update

The state directory is outside the install tree. From a git checkout at `/opt/artemis-student-mcp`:

```bash
git -C /opt/artemis-student-mcp pull
systemctl restart artemis-student-mcp
```

Or copy a new tree over `/opt/artemis-student-mcp` and restart. Re-running `deploy/install-debian12.sh` does that and keeps the env file and the state directory. Confirm `node -v` is still 22 or newer after a Node upgrade.

## Backups

The state directory contains Artemis session tokens and hashes of OAuth tokens. Treat the archive as a credential. Keep it on the same machine, mode `0600`, or encrypt it before it leaves.

```bash
umask 077
tar -C /var/lib -czf /root/artemis-student-mcp-state.tgz artemis-student-mcp
```

Restore with the service stopped, then fix the owner:

```bash
systemctl stop artemis-student-mcp
tar -C /var/lib -xzf /root/artemis-student-mcp-state.tgz
chown -R artemis-mcp:artemis-mcp /var/lib/artemis-student-mcp
chmod 700 /var/lib/artemis-student-mcp
systemctl start artemis-student-mcp
```

OAuth access and refresh tokens cannot be recovered from the hash file. People sign in again from the client. Artemis sessions in `session.json` are what a backup restores. An admin bearer token cannot be printed again. Create a new one if it was lost.

## Security

- Bind to loopback unless the proxy is on another host, and then firewall that port.
- Put TLS on the proxy. The Node process speaks plain HTTP. OAuth clients should use the HTTPS public origin.
- `ARTEMIS_MCP_PUBLIC_URL` is the issuer. Forwarded headers do not change it.
- The sign-in page and the Artemis password are not accepted in a URL.
- OAuth tokens and admin bearer tokens are random. Only their SHA-256 hashes are stored. Comparison walks every hash with a constant-time compare.
- Redirect URIs are matched exactly and must be HTTPS, a loopback `http` URL, or a private-use application scheme.
- Failed `/mcp` authentications are counted per TCP peer. After 30 failures in five minutes the server answers 429. A request that presents a still-valid token is not counted.
- Sign-in attempts are limited per username and per TCP peer. The limit is in memory and clears on restart.
- MCP request bodies are limited to 8 MB. OAuth bodies are limited to 16 KB.
- The service user is `artemis-mcp`, with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, and `StateDirectory`. `submit_file` reads a path on this machine as that user. An access token is the capability to call every tool, so do not run the service as root.
- Instructor personal access tokens are still refused by the student session checks.
- MCP session ids live in memory and are bound to the access token's account. They disappear when the process restarts. Clients send `initialize` again.
- `GET /mcp` is 405. There is no legacy SSE endpoint.
