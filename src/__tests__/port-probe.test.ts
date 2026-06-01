import { describe, expect, test } from "bun:test";
import { defaultPortListening } from "../port-probe.ts";

describe("defaultPortListening", () => {
  test("true when something is listening on the loopback port", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    try {
      expect(await defaultPortListening(server.port as number)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("false when nothing is bound (connection refused)", async () => {
    // Grab a port, immediately release it, then probe — it's free.
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const freePort = probe.port as number;
    probe.stop(true);
    // Brief settle so the kernel releases the port before we probe.
    await new Promise((r) => setTimeout(r, 50));
    expect(await defaultPortListening(freePort)).toBe(false);
  });
});
