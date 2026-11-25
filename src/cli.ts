#!/usr/bin/env node
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { Archil, type Sandbox } from "disk";
import { createDesktop, shareDesktop, startDesktop, unshareDesktop } from "./desktop.js";
import { openDesktopTunnel } from "./tunnel.js";

const USAGE = `usage: archil-desktop <command> [options]

Commands:
  create              create a sandbox running a VNC desktop
    --name <name>       sandbox name
    --image <ref>       OCI image (default: the prebuilt desktop image)
    --bootstrap         install the desktop into stock ubuntu:26.04 instead
    --cpus <n>          vCPUs (default 2)
    --memory <MiB>      memory (default 4096)
    --hours <n>         pause after this many hours (default 4)
    --geometry <WxH>    initial screen size (default 1920x1080)
    --public            also print a public viewer link (see "share")
  connect <sandbox>   open the desktop privately through localhost
    --port <n>          local port (default 6080)
    --no-open           print the URL instead of opening a browser
  share <sandbox>     publish the desktop and print a public viewer link
  unshare <sandbox>   unpublish, invalidate old links, disconnect viewers
  delete <sandbox>    stop and delete the sandbox

<sandbox> is a sandbox ID or name. Credentials come from ARCHIL_API_KEY and ARCHIL_REGION.`;

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      image: { type: "string" },
      bootstrap: { type: "boolean" },
      cpus: { type: "string" },
      memory: { type: "string" },
      hours: { type: "string" },
      geometry: { type: "string" },
      public: { type: "boolean" },
      port: { type: "string" },
      "no-open": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, target] = positionals;
  if (values.help || !command) return console.log(USAGE);

  const client = new Archil();
  switch (command) {
    case "create": {
      const { sandbox } = await createDesktop(client, {
        name: values.name,
        baseImage: values.image,
        bootstrap: values.bootstrap,
        vcpuCount: optionalInt(values.cpus, "--cpus"),
        memSizeMiB: optionalInt(values.memory, "--memory"),
        maxTtlSeconds: values.hours ? Math.round(Number(values.hours) * 3600) : undefined,
        geometry: values.geometry,
        labels: { "archil-desktop": "1" },
      });
      console.log(`Desktop ready in sandbox ${sandbox.id} (${sandbox.name}).`);
      if (values.public) {
        console.log(`Public viewer link (anyone with it controls the desktop):\n  ${await shareDesktop(sandbox)}`);
      } else {
        console.log(`Open it with:\n  archil-desktop connect ${sandbox.id}`);
      }
      return;
    }
    case "connect": {
      const sandbox = await wake(await findSandbox(client, target));
      const tunnel = await openDesktopTunnel(sandbox, {
        localPort: optionalInt(values.port, "--port"),
      });
      console.log(`Desktop for ${sandbox.name} at:\n  ${tunnel.url}\nPress Ctrl-C to close the tunnel.`);
      if (!values["no-open"]) openBrowser(tunnel.url);
      process.once("SIGINT", () => void tunnel.close().then(() => process.exit(0)));
      return;
    }
    case "share": {
      const sandbox = await wake(await findSandbox(client, target));
      console.log(await shareDesktop(sandbox));
      return;
    }
    case "unshare": {
      const sandbox = await wake(await findSandbox(client, target));
      await unshareDesktop(sandbox);
      console.log(`Unshared ${sandbox.name}; existing links no longer work.`);
      return;
    }
    case "delete": {
      const sandbox = await findSandbox(client, target);
      if (sandbox.status === "running" || sandbox.status === "paused") await sandbox.stop();
      await sandbox.delete();
      console.log(`Deleted ${sandbox.name}.`);
      return;
    }
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

async function findSandbox(client: Archil, ref: string | undefined): Promise<Sandbox> {
  if (!ref) throw new UsageError("missing <sandbox>");
  const [byName] = await client.sandboxes.list({ name: ref });
  return byName ?? client.sandboxes.get(ref);
}

/** Brings a paused or stopped desktop back; services restart on boot by themselves. */
async function wake(sandbox: Sandbox): Promise<Sandbox> {
  if (sandbox.status === "paused") await sandbox.resume();
  else if (sandbox.status === "stopped") await sandbox.start();
  if (sandbox.status !== "running") {
    throw new Error(`sandbox ${sandbox.id} is ${sandbox.status}, not running`);
  }
  await startDesktop(sandbox);
  return sandbox;
}

function optionalInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`${flag} must be a positive integer`);
  return parsed;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

class UsageError extends Error {}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`archil-desktop: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof UsageError) console.error(`\n${USAGE}`);
  process.exit(1);
});
