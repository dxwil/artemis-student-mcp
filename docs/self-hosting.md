# Self-hosting the HTTP listener

The stdio process is unchanged and remains the default. HTTP mode is for a machine you administer. It speaks the current Streamable HTTP MCP transport at `/mcp` and answers `GET /healthz` with `{"ok":true}`.

A typical layout is a Debian 12 unprivileged Proxmox LXC. The Node process binds to `127.0.0.1:8080`. Caddy or nginx in the same container terminates TLS for your domain and proxies `/mcp`.

This server does not implement MCP OAuth 2.1. It does not publish protected-resource metadata and it does not register OAuth clients. Each remote client sends a bearer token in the `Authorization` header. That is the supported remote authentication.

Automated tests use an in-process mock of Artemis. They do not log in to a real Artemis server, and they do not exercise a real reverse proxy.

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

## What is stored

`ARTEMIS_MCP_STATE_DIR` defaults to `/var/lib/artemis-student-mcp`. The directory is mode `0700`. Files inside it are mode `0600`.

| Path | Contents |
| --- | --- |
| `access-tokens.json` | SHA-256 hashes of client bearer tokens, plus a public id, label, and account id. The bearer token itself is not stored. |
| `users/<id>/session.json` | The Artemis session for that one client token. |
| `users/<id>/write-confirmations.json` | Two-phase write confirmations for that account only. |

Creating a token creates a new account directory. Two tokens do not share confirmations, even if you later sign both into the same Artemis user. A confirmation token from one client is rejected for the other.

The Artemis password is read from a hidden terminal prompt (or from `ARTEMIS_PASSWORD` if you set it for that command). It is not written to the state directory. Leave it unset so it is not in the shell history or the service environment. `ARTEMIS_REMEMBER_ME=true` asks Artemis for the longer session cookie. The password is still not stored. A new password login can cause Artemis to email the account; a saved session is reused until it expires.

## Install

From a checkout of this repository, as root, on Debian 12:

```bash
sudo ./deploy/install-debian12.sh
```

The script installs Node.js 22 from the official tarball when `node` is missing or older than 22, creates the system user `artemis-mcp`, copies the app to `/opt/artemis-student-mcp`, installs the systemd unit and an env file, and starts the service. It does not touch an existing `/etc/artemis-student-mcp.env` and it does not delete the state directory.

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

Edit `/etc/artemis-student-mcp.env` before or after the first start. Set `ARTEMIS_BASE_URL` to your Artemis origin. When you publish the proxy, set `ARTEMIS_MCP_PUBLIC_URL` to that HTTPS origin (`https://mcp.example.com`, with no path). Then restart:

```bash
systemctl restart artemis-student-mcp
```

The unit binds the process to the address in that file. The shipped default is `127.0.0.1:8080`. Logs go to the journal and do not include bearer tokens, Artemis session tokens, or passwords:

```bash
journalctl -u artemis-student-mcp -f
```

## Create a token and sign in

Run the commands as `artemis-mcp` so the files stay owned by the service user. `su` gives the login command a terminal, which it needs to turn off echo.

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

`token create` prints the bearer token once on stdout. Store it in the MCP client. It cannot be printed again. The id on the `id:` line is not a secret. Pass that id to `login`, `status`, `logout`, and `token revoke`. Do not pass the bearer token as an argument.

`login` asks for the Artemis username and password with echo off. It uses the same directory-password and normal password flow as `artemis-student-auth login`. Success prints `courses: N` after a real course-list call. The service reads the new session file on the next request. It does not need a restart.

```bash
./bin/artemis-student-mcp token list
./bin/artemis-student-mcp status t_<id>
./bin/artemis-student-mcp logout t_<id>
./bin/artemis-student-mcp token revoke t_<id>
```

`logout` deletes that account's Artemis session and calls the Artemis logout endpoint. `token revoke` rejects the bearer token from then on. Revoking does not by itself call Artemis logout.

The login origin has to match the service. Sourcing `/etc/artemis-student-mcp.env` is what keeps `ARTEMIS_BASE_URL` the same. A session saved for one origin is not sent to another.

## Reverse proxy

TLS ends at the proxy. Leave the Node process on loopback. Do not publish port 8080 on the container's bridge.

If the proxy runs on a different machine, set `ARTEMIS_MCP_HOST` to a private address, allow only the proxy to connect to that port, and still require bearer tokens. The process does not trust `X-Forwarded-For`. Failed authentications share one rate-limit bucket per TCP peer, which is the proxy when it is local. A valid bearer token is still accepted while that bucket is exhausted. Restarting the service clears the in-memory counters.

`ARTEMIS_MCP_PUBLIC_URL` is the origin clients use (`https://mcp.example.com`). The server allows that `Host` and, when a browser sends `Origin`, that origin. Requests with no `Origin` are allowed so native clients work. Any other `Host` or `Origin` is rejected. Loopback names are always allowed so a local health check works.

`/mcp` must not be buffered. The server also accepts `text/event-stream` responses. `GET /mcp` returns 405 because this process does not open a standing server-sent-events stream. Clients that speak Streamable HTTP continue with `POST`. The older HTTP+SSE transport from protocol `2024-11-05` is not implemented.

Any query string on `/mcp` or `/healthz` is rejected, including a token in the query.

### Caddy

```caddy
mcp.example.com {
	encode off
	handle /mcp* {
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
	handle /healthz {
		reverse_proxy 127.0.0.1:8080
	}
}
```

`encode off` and `flush_interval -1` keep the proxy from buffering a stream. The ten-minute timeouts cover a slow Artemis read. Caddy obtains and renews the certificate for the site.

### nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name mcp.example.com;

    # Install certificates with your usual method, for example certbot.
    ssl_certificate     /etc/letsencrypt/live/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.example.com/privkey.pem;

    location /mcp {
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

    location = /healthz {
        proxy_pass http://127.0.0.1:8080/healthz;
        proxy_set_header Host $host;
    }
}
```

`client_max_body_size 8m` matches the server's request limit, which is the same 8 MB cap as a file-upload exercise.

Check the listener before the proxy is public:

```bash
curl -fsS http://127.0.0.1:8080/healthz
```

## Connect a client

The URL is `https://mcp.example.com/mcp`. The client must send:

```http
Authorization: Bearer <bearer-token>
Accept: application/json, text/event-stream
```

In Cursor, add an MCP server by URL and set that header. Do not put the token in the URL. A client config that has a headers map looks like this:

```json
{
  "mcpServers": {
    "artemis-student": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <bearer-token>"
      }
    }
  }
}
```

Other MCP clients, including ones that add a server by URL, use the same URL and header. A client that can only authenticate with OAuth will not connect.

Writes are still two steps. The first call returns a preview and a confirmation token and does not send the write. Show that preview to the person using the client. Send the confirmation token only after they approve. The token is valid only for the account directory of the bearer token that created it.

## Update

The state directory is outside the install tree. From a git checkout at `/opt/artemis-student-mcp`:

```bash
git -C /opt/artemis-student-mcp pull
systemctl restart artemis-student-mcp
```

Or copy a new tree over `/opt/artemis-student-mcp` and restart. Re-running `deploy/install-debian12.sh` does that and keeps the env file and the state directory. Confirm `node -v` is still 22 or newer after a Node upgrade.

## Backups

The state directory contains Artemis session tokens. Treat the archive as a credential. Keep it on the same machine, mode `0600`, or encrypt it before it leaves.

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

Bearer tokens cannot be recovered from the hash file. Clients need the token you saved when you created it. Artemis sessions in `session.json` are what a backup restores.

## Security

- Bind to loopback unless the proxy is on another host, and then firewall that port.
- Put TLS on the proxy. The Node process speaks plain HTTP.
- Never put an Artemis password, an Artemis session, or a client bearer token in a URL. The server rejects every query string.
- Bearer tokens are 256-bit random values. Only their SHA-256 hashes are stored. Comparison walks every hash with a constant-time compare.
- Failed authentications are counted per TCP peer. After 30 failures in five minutes the server answers 429. A request that presents a still-valid token is not counted and is not blocked by that counter.
- Request bodies are limited to 8 MB.
- The service user is `artemis-mcp`, with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, and `StateDirectory`. `submit_file` reads a path on this machine as that user. A bearer token is the capability to call every tool, so do not give the service user a home directory full of private files, and do not run it as root.
- Instructor personal access tokens are still refused by the student session checks.
- MCP session ids live in memory and are bound to the bearer token's account. They disappear when the process restarts. Clients send `initialize` again.
- `GET /mcp` is 405. There is no legacy SSE endpoint and no OAuth discovery URL.
