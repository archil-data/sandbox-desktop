import { createServer, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Sandbox } from "disk";
import { getDesktopToken, NOVNC_PORT, viewerPath } from "./desktop.js";

const MAX_REQUEST_HEAD_BYTES = 16 * 1024;
const HEAD_END = Buffer.from("\r\n\r\n");

export interface DesktopTunnel {
  /** Open this in a local browser. */
  url: string;
  close(): Promise<void>;
}

/**
 * Serves the desktop on localhost without making it public. Each local
 * connection is relayed over TLS to the sandbox's private port hostname, with
 * a short-lived Archil port token added to its first request. Archil
 * authenticates only that first request and relays the rest of the
 * connection unchanged, which covers both noVNC's page loads and its
 * WebSocket.
 */
export async function openDesktopTunnel(
  sandbox: Sandbox,
  options: { localPort?: number; ttl?: string } = {},
): Promise<DesktopTunnel> {
  const access = await sandbox.createPortToken(NOVNC_PORT, { ttl: options.ttl ?? "12h" });
  const desktopToken = await getDesktopToken(sandbox);
  const server = createServer((client) =>
    relay(client, access.hostname, access.token).catch(() => client.destroy()),
  );
  await listen(server, options.localPort ?? NOVNC_PORT);
  const { port } = server.address() as { port: number };

  return {
    url: `http://localhost:${port}${viewerPath(desktopToken)}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await sandbox.deletePortToken(access.id).catch(() => {});
    },
  };
}

async function relay(client: Socket, hostname: string, portToken: string): Promise<void> {
  const head = await readRequestHead(client);
  const upstream = tlsConnect({ host: hostname, port: 443, servername: hostname });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());

  const requestLineEnd = head.indexOf("\r\n");
  upstream.write(
    Buffer.concat([
      head.subarray(0, requestLineEnd + 2),
      Buffer.from(`X-Archil-Token: ${portToken}\r\n`),
      head.subarray(requestLineEnd + 2),
    ]),
  );
  client.pipe(upstream).pipe(client);
}

/** Reads until the end of the first request's headers; returns everything read so far. */
function readRequestHead(client: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.includes(HEAD_END)) {
        cleanup();
        client.pause();
        resolve(buffered);
      } else if (buffered.length > MAX_REQUEST_HEAD_BYTES) {
        cleanup();
        reject(new Error("request head too large"));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("connection closed before request head"));
    };
    const cleanup = () => {
      client.off("data", onData);
      client.off("end", onEnd);
      client.off("error", onEnd);
    };
    client.on("data", onData);
    client.on("end", onEnd);
    client.on("error", onEnd);
  });
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}
