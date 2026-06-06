import { describe, expect, test } from "bun:test";
import {
  CloudflaredError,
  createTunnel,
  credentialsPath,
  deleteTunnel,
  findTunnelByName,
  listTunnels,
  routeDns,
  tunnelConnectionCount,
} from "../cloudflare/tunnel.ts";
import type { CommandResult, Runner } from "../tailscale/run.ts";

function makeRunner(
  expected: string[][],
  results: CommandResult[],
): {
  runner: Runner;
  seen: string[][];
} {
  const seen: string[][] = [];
  let i = 0;
  const runner: Runner = async (cmd) => {
    seen.push([...cmd]);
    const exp = expected[i];
    if (exp) expect([...cmd]).toEqual(exp);
    const out = results[i];
    if (!out) throw new Error(`runner called more times than stubs (call #${i + 1})`);
    i++;
    return out;
  };
  return { runner, seen };
}

describe("cloudflare tunnel", () => {
  test("listTunnels parses the json array and drops malformed rows", async () => {
    const { runner } = makeRunner(
      [["cloudflared", "tunnel", "list", "--output", "json"]],
      [
        {
          code: 0,
          stdout: JSON.stringify([
            {
              id: "2c1a7c7e-1234-5678-9abc-def012345678",
              name: "parachute",
              created_at: "2026-04-22T00:00:00Z",
            },
            { id: "other-id-without-name" },
            { name: "nameonly" },
            "not an object",
          ]),
          stderr: "",
        },
      ],
    );
    const tunnels = await listTunnels(runner);
    expect(tunnels).toEqual([
      {
        id: "2c1a7c7e-1234-5678-9abc-def012345678",
        name: "parachute",
        createdAt: "2026-04-22T00:00:00Z",
      },
    ]);
  });

  test("listTunnels throws CloudflaredError on non-zero exit", async () => {
    const { runner } = makeRunner(
      [["cloudflared", "tunnel", "list", "--output", "json"]],
      [{ code: 1, stdout: "", stderr: "Cannot determine default origin certificate path" }],
    );
    try {
      await listTunnels(runner);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CloudflaredError);
      expect((err as CloudflaredError).message).toContain("Cannot determine default origin");
    }
  });

  test("listTunnels throws on non-array JSON", async () => {
    const { runner } = makeRunner(
      [["cloudflared", "tunnel", "list", "--output", "json"]],
      [{ code: 0, stdout: JSON.stringify({ tunnels: [] }), stderr: "" }],
    );
    await expect(listTunnels(runner)).rejects.toBeInstanceOf(CloudflaredError);
  });

  test("findTunnelByName returns match", async () => {
    const { runner } = makeRunner(
      [["cloudflared", "tunnel", "list", "--output", "json"]],
      [
        {
          code: 0,
          stdout: JSON.stringify([
            { id: "aaaaaaaa-0000-0000-0000-000000000001", name: "foo" },
            { id: "bbbbbbbb-0000-0000-0000-000000000002", name: "parachute" },
          ]),
          stderr: "",
        },
      ],
    );
    const t = await findTunnelByName(runner, "parachute");
    expect(t?.id).toBe("bbbbbbbb-0000-0000-0000-000000000002");
  });

  test("findTunnelByName returns undefined when absent", async () => {
    const { runner } = makeRunner(
      [["cloudflared", "tunnel", "list", "--output", "json"]],
      [{ code: 0, stdout: "[]", stderr: "" }],
    );
    expect(await findTunnelByName(runner, "parachute")).toBeUndefined();
  });

  test("createTunnel parses UUID from typical stdout", async () => {
    const { runner } = makeRunner(
      [["cloudflared", "tunnel", "create", "parachute"]],
      [
        {
          code: 0,
          stdout:
            "Tunnel credentials written to /Users/x/.cloudflared/2c1a7c7e-1234-5678-9abc-def012345678.json.\n" +
            "Created tunnel parachute with id 2c1a7c7e-1234-5678-9abc-def012345678\n",
          stderr: "",
        },
      ],
    );
    const t = await createTunnel(runner, "parachute");
    expect(t).toEqual({ id: "2c1a7c7e-1234-5678-9abc-def012345678", name: "parachute" });
  });

  test("createTunnel throws CloudflaredError when UUID can't be parsed", async () => {
    const { runner } = makeRunner(
      [["cloudflared", "tunnel", "create", "parachute"]],
      [{ code: 0, stdout: "some unexpected output\n", stderr: "" }],
    );
    await expect(createTunnel(runner, "parachute")).rejects.toBeInstanceOf(CloudflaredError);
  });

  test("createTunnel surfaces cloudflared error output on non-zero exit", async () => {
    const { runner } = makeRunner(
      [["cloudflared", "tunnel", "create", "parachute"]],
      [{ code: 1, stdout: "", stderr: "tunnel with name parachute already exists" }],
    );
    await expect(createTunnel(runner, "parachute")).rejects.toMatchObject({
      message: expect.stringContaining("already exists"),
    });
  });

  test("routeDns passes --overwrite-dns and surfaces zone-not-found errors", async () => {
    const { runner, seen } = makeRunner(
      [
        [
          "cloudflared",
          "tunnel",
          "route",
          "dns",
          "--overwrite-dns",
          "parachute",
          "vault.example.com",
        ],
      ],
      [
        {
          code: 1,
          stdout: "",
          stderr: "Failed to add route: code: 1000, reason: Invalid DNS zone",
        },
      ],
    );
    await expect(routeDns(runner, "parachute", "vault.example.com")).rejects.toMatchObject({
      message: expect.stringContaining("Invalid DNS zone"),
    });
    expect(seen[0]).toEqual([
      "cloudflared",
      "tunnel",
      "route",
      "dns",
      "--overwrite-dns",
      "parachute",
      "vault.example.com",
    ]);
  });

  test("routeDns succeeds on rerun when the CNAME already exists (upsert semantics)", async () => {
    // Without --overwrite-dns this call would exit non-zero with "An A, AAAA,
    // or CNAME record with that host already exists" on the second run. The
    // flag turns it into an idempotent UPSERT, which is what users expect.
    const { runner, seen } = makeRunner(
      [
        [
          "cloudflared",
          "tunnel",
          "route",
          "dns",
          "--overwrite-dns",
          "parachute",
          "vault.example.com",
        ],
      ],
      [{ code: 0, stdout: "Added CNAME vault.example.com which will route to …", stderr: "" }],
    );
    await routeDns(runner, "parachute", "vault.example.com");
    expect(seen[0]).toContain("--overwrite-dns");
  });

  test("credentialsPath joins uuid under the cloudflared home", () => {
    expect(credentialsPath("abc", "/Users/x/.cloudflared")).toBe("/Users/x/.cloudflared/abc.json");
  });

  test("deleteTunnel passes --force and surfaces failures (#593)", async () => {
    const { runner, seen } = makeRunner(
      [["cloudflared", "tunnel", "delete", "--force", "parachute"]],
      [{ code: 0, stdout: "Deleted tunnel parachute\n", stderr: "" }],
    );
    await deleteTunnel(runner, "parachute");
    expect(seen[0]).toEqual(["cloudflared", "tunnel", "delete", "--force", "parachute"]);

    const fail = makeRunner(
      [["cloudflared", "tunnel", "delete", "--force", "parachute"]],
      [{ code: 1, stdout: "", stderr: "tunnel has active connections" }],
    );
    await expect(deleteTunnel(fail.runner, "parachute")).rejects.toMatchObject({
      message: expect.stringContaining("active connections"),
    });
  });

  describe("tunnelConnectionCount (#593)", () => {
    function infoRunner(result: CommandResult): Runner {
      return async (cmd) => {
        expect([...cmd]).toEqual([
          "cloudflared",
          "tunnel",
          "info",
          "--output",
          "json",
          "parachute",
        ]);
        return result;
      };
    }

    test("counts connector entries under `conns`", async () => {
      const runner = infoRunner({
        code: 0,
        stdout: JSON.stringify({ conns: [{ id: "a" }, { id: "b" }] }),
        stderr: "",
      });
      expect(await tunnelConnectionCount(runner, "parachute")).toBe(2);
    });

    test("counts connector entries under the legacy `connections` shape", async () => {
      const runner = infoRunner({
        code: 0,
        stdout: JSON.stringify({ connections: [{ id: "a" }] }),
        stderr: "",
      });
      expect(await tunnelConnectionCount(runner, "parachute")).toBe(1);
    });

    test("returns 0 on empty conns, non-zero exit, unparseable JSON, or a runner throw", async () => {
      expect(
        await tunnelConnectionCount(
          infoRunner({ code: 0, stdout: '{"conns":[]}', stderr: "" }),
          "parachute",
        ),
      ).toBe(0);
      expect(
        await tunnelConnectionCount(
          infoRunner({ code: 1, stdout: "", stderr: "not found" }),
          "parachute",
        ),
      ).toBe(0);
      expect(
        await tunnelConnectionCount(
          infoRunner({ code: 0, stdout: "not json", stderr: "" }),
          "parachute",
        ),
      ).toBe(0);
      const thrower: Runner = async () => {
        throw new Error("spawn failed");
      };
      expect(await tunnelConnectionCount(thrower, "parachute")).toBe(0);
    });
  });
});
