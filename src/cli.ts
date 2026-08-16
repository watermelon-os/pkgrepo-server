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
