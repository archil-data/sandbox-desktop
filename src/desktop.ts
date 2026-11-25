import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Archil, CreateSandboxRequest, Sandbox } from "disk";

export const NOVNC_PORT = 6080;
export const DEFAULT_IMAGE = "ghcr.io/archil-data/sandbox-desktop:latest";
/** Stock image for `bootstrap: true`. */
export const BOOTSTRAP_BASE_IMAGE = "ubuntu:26.04";

export interface CreateDesktopOptions extends Omit<CreateSandboxRequest, "ports"> {
  /** Initial screen size, e.g. "1920x1080". Viewers resize it to fit their window. */
  geometry?: string;
  /**
   * Install the desktop into a stock Debian sandbox instead of starting from the
   * prebuilt image. Slower (about 30s more), but needs no image registry.
   */
  bootstrap?: boolean;
}

export interface DesktopInfo {
  /** Secret the noVNC viewer presents to websockify. Anyone holding it can see and control the desktop. */
  token: string;
}

export async function createDesktop(
  client: Archil,
  options: CreateDesktopOptions = {},
): Promise<{ sandbox: Sandbox; desktop: DesktopInfo }> {
  const { geometry, bootstrap, ...request } = options;
  if (!request.baseImage && !request.imageId) {
    request.baseImage = bootstrap ? BOOTSTRAP_BASE_IMAGE : DEFAULT_IMAGE;
  }
  // Unset options (e.g. from CLI flags that weren't passed) must not erase these defaults.
  const given = Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined));
  const sandbox = await client.sandboxes.create({
    vcpuCount: 2,
    memSizeMiB: 4096,
    // Viewer traffic arrives over a port, which does not count as sandbox
    // activity, so an idle timeout would pause the desktop mid-session.
    idleTtlSeconds: 0,
    maxTtlSeconds: 4 * 60 * 60,
    ...given,
  });
  if (sandbox.status !== "running") {
    throw new Error(`sandbox ${sandbox.id} is ${sandbox.status}, not running`);
  }
  if (bootstrap) await installDesktop(sandbox);
  return { sandbox, desktop: await startDesktop(sandbox, { geometry }) };
}

/**
 * Starts the desktop services if they are not running and returns the viewer
 * token. Safe to call repeatedly. Pass `rotateToken` on a fork so it does not
 * share its parent's token.
 */
export async function startDesktop(
  sandbox: Sandbox,
  options: { geometry?: string; rotateToken?: boolean } = {},
): Promise<DesktopInfo> {
  if (options.rotateToken) await run(sandbox, "desktopctl token --rotate");
  const geometry = options.geometry ? ` --geometry ${shellQuote(options.geometry)}` : "";
  const { token } = JSON.parse(await run(sandbox, `desktopctl up${geometry}`)) as DesktopInfo;
  return { token };
}

export async function getDesktopToken(sandbox: Sandbox): Promise<string> {
  return (await run(sandbox, "desktopctl token")).trim();
}

/** Path on the noVNC server that opens the viewer and connects with `token`. */
export function viewerPath(token: string): string {
  const params = new URLSearchParams({
    autoconnect: "1",
    resize: "remote",
    reconnect: "1",
    path: `websockify?token=${token}`,
  });
  return `/vnc.html?${params}`;
}

/**
 * Publishes the desktop on a public HTTPS hostname and returns a viewer link.
 * The link embeds the token: anyone who has it controls the desktop until
 * `unshareDesktop` is called.
 */
export async function shareDesktop(sandbox: Sandbox): Promise<string> {
  const hostname = await sandbox.exposePort(NOVNC_PORT);
  return `https://${hostname}${viewerPath(await getDesktopToken(sandbox))}`;
}

/** Removes the public hostname, invalidates old links, and disconnects current viewers. */
export async function unshareDesktop(sandbox: Sandbox): Promise<void> {
  await sandbox.unexposePort(NOVNC_PORT);
  await run(sandbox, "desktopctl revoke");
}

/** Starts a GUI program on the desktop, e.g. `["chromium", "https://archil.com"]`. */
export async function launchOnDesktop(sandbox: Sandbox, argv: string[]): Promise<void> {
  await run(sandbox, `desktopctl launch ${argv.map(shellQuote).join(" ")}`);
}

/** Copies image/ into a running sandbox and runs its installer. */
export async function installDesktop(sandbox: Sandbox): Promise<void> {
  const imageDir = fileURLToPath(new URL("../image/", import.meta.url));
  const steps = ["set -e", "rm -rf /tmp/archil-desktop"];
  for (const file of await listFiles(imageDir)) {
    const target = `/tmp/archil-desktop/${relative(imageDir, file)}`;
    const contents = (await readFile(file)).toString("base64");
    steps.push(
      `mkdir -p ${shellQuote(target.slice(0, target.lastIndexOf("/")))}`,
      `echo ${contents} | base64 -d > ${shellQuote(target)}`,
    );
  }
  steps.push("sh /tmp/archil-desktop/install.sh", "rm -rf /tmp/archil-desktop");
  await run(sandbox, steps.join("\n"), 15 * 60);
}

async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files;
}

async function run(sandbox: Sandbox, command: string, timeoutSeconds = 120): Promise<string> {
  const result = await sandbox.exec(command, { timeoutSeconds });
  if (result.exitCode !== 0) {
    const firstLine = command.split("\n")[0];
    throw new Error(
      `\`${firstLine}\` failed in sandbox ${sandbox.id} (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
