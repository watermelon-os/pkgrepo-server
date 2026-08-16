#!/usr/bin/env node
import { Command } from "commander";
import { readVersion } from "./version.js";

interface ServerOptions {
  host: string;
  port: number;
}

function baseUrl(opts: ServerOptions): string {
  return `http://${opts.host}:${opts.port}`;
}

async function fetchJson(url: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(url);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON response body.
  }
  return { ok: res.ok, status: res.status, body };
}

function toServerOptions(opts: Record<string, unknown>): ServerOptions {
  return { host: String(opts.host), port: Number(opts.port) };
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const version = await readVersion();

  const program = new Command();
  program
    .name("wmserver-ts")
    .description("Watermelon Server (TypeScript) management CLI. Talks to the server over HTTP.")
    .version(version)
    .option("-H, --host <host>", "server host", "127.0.0.1")
    .option("-p, --port <port>", "server port", "34817");

  program
    .command("status")
    .description("Check server health via GET /api/health")
    .action(async () => {
      const { ok, status, body } = await fetchJson(
        `${baseUrl(toServerOptions(program.optsWithGlobals()))}/api/health`,
      );
      if (ok) {
        console.log(JSON.stringify(body, null, 2));
      } else {
        console.error(`status failed: HTTP ${status}`);
        process.exitCode = 1;
      }
    });

  program
    .command("meta")
    .description("Read generic app metadata via GET /api/meta/:key")
    .argument("<key>", "metadata key")
    .action(async (key: string) => {
      const { ok, status, body } = await fetchJson(
        `${baseUrl(toServerOptions(program.optsWithGlobals()))}/api/meta/${key}`,
      );
      if (ok) {
        console.log(JSON.stringify(body, null, 2));
      } else {
        console.error(`meta failed: HTTP ${status}`);
        process.exitCode = 1;
      }
    });

  program
    .command("meta-set")
    .description("Write generic app metadata via PUT /api/meta/:key")
    .argument("<key>", "metadata key")
    .argument("<value>", "metadata value")
    .action(async (key: string, value: string) => {
      const opts = program.optsWithGlobals();
      const res = await fetch(`${baseUrl(toServerOptions(opts))}/api/meta/${key}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // Non-JSON response body.
      }
      if (res.ok) {
        console.log(JSON.stringify(body, null, 2));
      } else {
        console.error(`meta-set failed: HTTP ${res.status}`);
        process.exitCode = 1;
      }
    });

  program
    .command("version")
    .description("Print the server package version")
    .action(() => {
      console.log(version);
    });

  await program.parseAsync(argv);
}

if (import.meta.main) {
  await main();
}
