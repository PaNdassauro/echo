# Running Echo behind a reverse proxy

Use this when you already have a proxy on the machine (nginx, Caddy, Traefik, Cloudflare Tunnel, or the proxy that a
hosting panel runs for you) and want it to terminate TLS for Echo. If you have nothing in front, use
`./install.sh --domain echo.example.com` instead: the Echo gateway gets and renews the certificate itself.

The gateway is itself a Caddy that serves the front end and every API under one origin. Behind a proxy it listens on plain
HTTP, with no certificate logic, and your proxy forwards **everything** to it.

> **What was measured and what was not.** The behavior of the gateway behind a proxy was measured with a Caddy in a
> second Docker network (client address read from `X-Forwarded-For`, login limit per client, internal listener not
> visible from the proxy network). The recipes for nginx, Traefik and Cloudflare Tunnel below follow from the contract in
> the next section; they were written from the tools' documentation and **were not each run against Echo**. Test yours
> with the checklist at the end.

## 1. Install in proxy mode

```bash
# proxy on the host (nginx, Caddy, cloudflared installed on the system): it forwards to 127.0.0.1:8088
./install.sh --behind-proxy --url https://echo.example.com --port 8088

# proxy in a container (Traefik, Coolify, cloudflared in Docker): the proxy's Docker network must already exist
./install.sh --behind-proxy --url https://echo.example.com --proxy-network traefik
```

- `--url` is the **public** address, the one your users type, and it is stored in the installation: it cannot change later
  without reinstalling.
- With `--port`, the gateway publishes `127.0.0.1:<port>` only. Nothing is exposed to the network by Echo.
- With `--proxy-network NAME` the gateway also joins that external network with the alias `<project>-gateway` (`echo-gateway` for
  the default project name), and your proxy points at `http://echo-gateway:80`. The gateway stays in its own network too:
  it needs it to reach the other services.
- **The only name your proxy should use is the alias `<project>-gateway`.** The gateway itself reaches the other services by the
  qualified name `<service>.<project>_default` (`auth.echo_default`, `rest.echo_default`, ...), never by the short name.
  The qualified name prevents an **accidental** collision: the proxy's network may hold other containers with aliases such as
  `auth` or `storage`, and a short name could resolve to one of them. It does **not** protect against a hostile container on the
  proxy's network that picks the literal alias `<service>.<project>_default` (Docker's DNS matches the whole name first; measured).
  Use `--proxy-network` only with a proxy network where every container is trusted, or with a network dedicated to Echo and its
  proxy. At start the gateway refuses to run if one of those qualified names resolves outside the subnet of the internal network
  (see [troubleshooting.md](./troubleshooting.md)), but that check runs only at start: it catches a neighbour that already exists,
  not one that appears later. Do not give your proxy the short service names, and do not attach other containers to
  `<project>_default`.
- The gateway's **internal listener (`:8000`) is not visible from the proxy network**: it is bound to the address the gateway
  has in the Compose network only. It carries no login limit and none of the blocks of the public side, so never publish
  it and never route to it.

## 2. What your proxy must do

| Requirement | Why |
|---|---|
| Forward every path to the gateway, **without rewriting the path** | the gateway routes `/auth/v1`, `/rest/v1`, `/realtime/v1`, `/storage/v1`, `/functions/v1`, `/qr` and the front end itself |
| Pass WebSocket upgrades (`/realtime/v1/websocket`) and keep them open | the inbox updates in real time over it. Use a long read timeout (an hour is fine) |
| **No limit on the request body** (uploads of up to 1 GiB) | media sent from the browser |
| **No response buffering** for `/qr/` (Server-Sent Events) | the pairing screen shows the QR code as a stream. A buffering proxy shows a blank screen until the stream ends. The QR service sends `: conectado` at once and a `: ping` every 25 seconds, so any proxy that streams will show it |
| Send the **real client address in `X-Forwarded-For`** | see below |
| Do not add or change `Content-Security-Policy`, `X-Frame-Options` or `X-Content-Type-Options` | the gateway sets them on the front end |
| Reach the gateway from a **private address** | see below |

### The `X-Forwarded-For` header (login limit)

Sign-in is limited per client address: from the 31st wrong password in a window, the Auth service answers 429 (measured
with 30 wrong passwords answered 400 and the 31st answered 429). The gateway decides who the client is.

- Without `--behind-proxy` the gateway **trusts no `X-Forwarded-For` at all** and uses the address of the TCP connection, so a
  client cannot invent an address.
- With `--behind-proxy` the gateway trusts `X-Forwarded-For` **only from private addresses** (`private_ranges`, strict mode:
  it takes the right-most address that is not a trusted proxy). So your proxy has to connect from a private address
  (loopback, a Docker network, your LAN or VPN), and has to put the real client address in the header.
- If your proxy forgets the header, or connects from a public address, **every user shares one limit bucket**: a handful of
  mistyped passwords locks everyone out of signing in for a while. If you see 429 on sign-in for people in different places, this
  is the first thing to check.
- Set the header, do not append to one the client sent (nginx example below uses `$remote_addr`). Appending also works with
  the strict mode, because the right-most entry is the one your proxy wrote, but setting is simpler to reason about.

The header cannot be forged to dodge the limit: a request that carries its own `X-Forwarded-For`, `X-Real-IP` or `X-Echo-Client-IP`
was measured to still count against its real address.

## 3. nginx (on the host)

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name echo.example.com;

    ssl_certificate     /etc/letsencrypt/live/echo.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/echo.example.com/privkey.pem;

    client_max_body_size 0;               # no body limit: uploads up to 1 GiB
    proxy_request_buffering off;          # stream large uploads instead of writing them to disk first

    location / {
        proxy_pass http://127.0.0.1:8088;     # the --port you gave the installer
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;   # set, do not append
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;          # WebSocket
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location /qr/ {                          # Server-Sent Events: no buffering
        proxy_pass http://127.0.0.1:8088;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}

server {
    listen 80;
    server_name echo.example.com;
    return 301 https://$host$request_uri;
}
```

Do not put a trailing slash or a path in `proxy_pass`: that would rewrite the path. `http2 on;` needs nginx 1.25.1 or newer;
on older versions write `listen 443 ssl http2;`.

## 4. Caddy (on the host)

```caddyfile
echo.example.com {
	reverse_proxy 127.0.0.1:8088 {
		flush_interval -1
	}
}
```

Caddy upgrades WebSockets by itself, has no request body limit by default, and sets `X-Forwarded-For` to the client
address (when nothing in front of it is trusted, it overwrites whatever the client sent). `flush_interval -1` makes it stream
the QR code immediately.

## 5. Traefik (proxy in a container)

Install with `--proxy-network traefik` (the name of the external network your Traefik uses), then add the router in
`docker-compose.override.yml`. The installer lists that file in `COMPOSE_FILE` and never edits it:

```yaml
services:
  gateway:
    labels:
      - traefik.enable=true
      - traefik.docker.network=traefik
      - traefik.http.routers.echo.rule=Host(`echo.example.com`)
      - traefik.http.routers.echo.entrypoints=websecure
      - traefik.http.routers.echo.tls.certresolver=letsencrypt
      - traefik.http.services.echo.loadbalancer.server.port=80
```

Then `./echo up`. Adjust the entry point and certificate resolver names to your Traefik. Traefik passes WebSockets, does not
buffer responses and has no body limit unless you add a buffering middleware; do not add one to this router. Traefik adds
the client address to `X-Forwarded-For` and connects from a private Docker address, which is what the gateway wants.

## 6. Cloudflare Tunnel

- **`cloudflared` installed on the host:** install with `--behind-proxy --url https://echo.example.com --port 8088` and point
  the tunnel's public hostname at `http://127.0.0.1:8088`.
- **`cloudflared` in a container:** install with `--proxy-network <network of the cloudflared container>` and point the public
  hostname at `http://echo-gateway:80` (`<project>-gateway:80` if you changed the project name).

Cloudflare sets `CF-Connecting-IP` and `X-Forwarded-For`; since the tunnel connects from a private address the gateway
reads the client from `X-Forwarded-For`. Cloudflare limits the size of one request body by plan (100 MB on its free plan,
according to its documentation, which you should check for yours): that is a limit of Cloudflare, not of Echo, and large
files may need a plan with a higher limit or a different path. Streaming of the QR code through Cloudflare was not tested.

## 7. Panels with their own proxy (Coolify and similar)

These panels run Traefik or Caddy for you and are happiest when you hand them a Compose file. This repository's Compose file
is meant to be started by `./install.sh`, because the installer generates the `.env` with the secrets and the guard refuses
to start the database without them. Importing `docker-compose.yml` into a panel and filling variables by hand was **not tested**.
The tested shape is: run `./install.sh --behind-proxy --url https://echo.example.com --proxy-network <the panel's proxy
network>` on the host and add the routing labels the panel's proxy expects through `docker-compose.override.yml`, as in the Traefik
example. The port the proxy must reach is `80` of the container named `<project>-gateway`.

## 8. Check that it works

1. `./echo doctor` has no ERRO.
2. Open `https://echo.example.com`: the sign-in screen loads and, in the browser's network tab, `/config.js` answers 200 with
   `Cache-Control: no-store`.
3. Sign in and open a conversation. A message sent to the number appears **without reloading the page**: this proves the WebSocket
   goes through.
4. Upload a large file (a video of a few hundred MB) in a conversation: this proves there is no body limit or timeout in between.
5. "Configurações > Números", tab "QR Code": type a display name and click "Gerar QR" (Generate QR): the QR code appears within a second or two. If the screen stays blank until it times out,
   your proxy is buffering `/qr/`.
6. Mistype a password 31 times from one browser, then sign in correctly from another network: the second one must still be accepted. If
   it is refused too, `X-Forwarded-For` is not reaching the gateway as described above.
7. From a machine other than the server, `curl -I http://<server>:8088/` must fail (the port is bound to the loopback only), and so must any
   address on port 8000.
