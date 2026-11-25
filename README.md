# Archil Sandbox Desktop

A Linux desktop you can open in your browser, running in an [Archil sandbox](https://docs.archil.com/compute/persistent-sandboxes).
It's Ubuntu 26.04 with Xubuntu's XFCE desktop and Firefox, served over VNC through noVNC. You can use it yourself, hand a
link to a teammate, or point a computer-use agent at it.

![XFCE desktop in a browser tab](docs/screenshot.png)

```bash
npx archil login
npx archil sandbox create my-desk --desktop
npx archil sandbox desktop my-desk     # opens it in your browser, privately
npx archil sandbox ssh my-desk         # real SSH into the same machine
```

The `archil` CLI (from the [`archil`](https://www.npmjs.com/package/archil) npm package) is the
supported way to run these desktops. This repository holds the image it starts from, plus a
small TypeScript library (`src/`) for driving desktops from agent code.

## How it works

```
 your browser ──HTTPS/WSS──▶ Archil edge ──▶ sandbox :6080 websockify + noVNC ──▶ localhost:5901 Xtigervnc ◀── XFCE session
                (private: X-Archil-Token      (checks the viewer token)            (not reachable from outside)
                 added by `connect`;
                 shared: public hostname)
```

Inside the sandbox, `desktopctl up` registers three
[supervised services](https://docs.archil.com/compute/persistent-sandboxes#hosting-network-services):

| Service           | Runs                                                       |
| ----------------- | ---------------------------------------------------------- |
| `desktop-vnc`     | Xtigervnc on display `:1`, with VNC on `localhost:5901` only |
| `desktop-session` | XFCE as the unprivileged `desktop` user                     |
| `desktop-novnc`   | websockify on `:6080`. It serves the noVNC web client and only proxies to VNC when the request carries the viewer token. |

Service definitions persist on the sandbox's disk. The desktop comes back by itself after a
pause/resume or a stop/start.

## Two ways to view it

**Private (default).** `connect` gets a short-lived Archil port token and runs a proxy on
`localhost` that adds the token to each connection. Port 6080 is never public. Anyone who
wants to view the desktop needs your Archil API key.

**Shared link.** `share` exposes port 6080 on a public HTTPS hostname and prints a link
that carries the viewer token:

```bash
npx archil-sandbox-desktop share my-desktop      # https://6080-<id>.<region>.archil.app/vnc.html?...
npx archil-sandbox-desktop unshare my-desktop    # removes the hostname, rotates the token, drops viewers
```

Anyone with the link can see and control the desktop, so treat it like a password. The
token is 256 bits from `/dev/urandom`. Without it, websockify closes the connection before
any VNC traffic flows.

## CLI

```
archil-desktop create [--name N] [--image REF | --bootstrap] [--cpus 2] [--memory 4096]
                      [--hours 4] [--geometry 1920x1080] [--public]
archil-desktop connect <sandbox> [--port 6080] [--no-open]
archil-desktop share <sandbox>
archil-desktop unshare <sandbox>
archil-desktop delete <sandbox>
```

`--bootstrap` installs the desktop into a stock `ubuntu:26.04` sandbox (about 50 seconds)
instead of starting from the prebuilt image, so you don't need an image registry.
`connect`, `share`, and `unshare` resume a paused or stopped sandbox first.

## Library

```ts
import { Archil } from "disk";
import { createDesktop, launchOnDesktop, openDesktopTunnel, shareDesktop } from "archil-sandbox-desktop";

const client = new Archil(); // ARCHIL_API_KEY / ARCHIL_REGION
const { sandbox } = await createDesktop(client, { name: "agent-desktop", vcpuCount: 4, memSizeMiB: 8192 });

await launchOnDesktop(sandbox, ["firefox", "https://archil.com"]);

const tunnel = await openDesktopTunnel(sandbox);  // private, on localhost
console.log(tunnel.url);
// or: console.log(await shareDesktop(sandbox)); // public link
```

`createDesktop` takes every `client.sandboxes.create` option, including `mounts`, so you
can put an Archil disk on the desktop.

### Computer-use agents

The image includes `xdotool` and `scrot`, so an agent can drive the desktop with
`sandbox.exec` while a person watches through the viewer:

```ts
const shot = await sandbox.exec("DISPLAY=:1 scrot -o /tmp/s.png && base64 -w0 /tmp/s.png");
const png = Buffer.from(shot.stdout, "base64");

await sandbox.exec("DISPLAY=:1 xdotool mousemove 640 400 click 1");
await sandbox.exec("DISPLAY=:1 xdotool type --delay 20 'hello from the agent'");
```

### Forks

Forking a sandbox copies its disk, viewer token included. Rotate the token on the fork
before you share it:

```ts
const copy = await sandbox.fork();
await startDesktop(copy, { rotateToken: true });
```

## Things to know

- **Timeouts.** Viewer traffic doesn't count as sandbox activity, so `createDesktop` turns
  off the idle timeout (otherwise the desktop would pause partway through a session). It
  caps each session at 4 hours instead (`--hours` / `maxTtlSeconds`) and then pauses. A
  paused sandbox costs only storage. Delete desktops you're finished with.
- **Starting GUI apps from `exec`.** A process started by `sandbox.exec` is killed when
  the exec returns. Start GUI programs with `desktopctl launch <cmd>` (or
  `launchOnDesktop`), which detaches them. Programs started from the desktop itself are
  unaffected.
- **SSH.** The image includes `openssh-server` and `rsync`, so `archil sandbox ssh` and
  `scp`/`rsync` to `<name>.archil` work immediately (see the `disk` package's CLI docs).
  The image ships no SSH host keys; each sandbox creates its own on first use.
- **The `desktop` user** has passwordless `sudo`. The sandbox VM is the security boundary.
  Running the session as a non-root user lets the browser keep its own sandbox.
- **Firefox comes from Mozilla's APT repository.** Ubuntu's own `firefox` and `chromium`
  packages are snap wrappers, and snaps don't run in a sandbox. A policy file
  (`/etc/firefox/policies/policies.json`) skips the first-run screens and turns off telemetry.
- **No Super-key shortcuts.** Browsers send a Mac's Cmd key to the desktop as Super, and
  often never send the key-up. If Super shortcuts existed, a stuck Cmd would turn plain
  typing into shortcuts (Super+E opens the file manager), so the install removes them.
- **Architectures.** Archil sandboxes may be x86_64 or arm64, so the image is built for both.
- **Base image.** The image is `ubuntu:26.04`. `install.sh` also works on `debian:trixie`,
  where you get plain XFCE instead of the Xubuntu look. Don't use `debian:trixie-slim`:
  it currently fails to boot as an Archil sandbox.

## Customizing

Build on the published image:

```dockerfile
FROM ghcr.io/archil-data/sandbox-desktop:latest
RUN apt-get update && apt-get install -y --no-install-recommends gimp libreoffice-writer
```

Then pass `--image <your-ref>`. Any public OCI image works. For a private image, build it
with `client.images.build({ source, registryAuth })` and pass `imageId` to `createDesktop`.

Inside a running sandbox:

```
desktopctl up [--geometry WxH]   start the desktop (idempotent), print {"port","token"}
desktopctl token [--rotate]      print or replace the viewer token
desktopctl revoke                rotate the token and disconnect every viewer
desktopctl launch <cmd> [args]   start a GUI program on the desktop
desktopctl down                  stop the desktop and remove its services
desktopctl status                show the desktop services
```

## Development

```bash
npm install
npm run typecheck
npx tsx src/cli.ts create --bootstrap   # exercises image/ without publishing an image
```

`image/install.sh` is the single source of truth for what's on the desktop. The Dockerfile
and `--bootstrap` both run it.

## License

MIT
