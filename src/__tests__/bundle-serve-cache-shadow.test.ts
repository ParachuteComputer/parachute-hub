// hub#961 generalises bundle-serve.test.ts's hub#780 literal-root pins.
// The live cache fallback is environment-dependent and does not reproduce on
// this mini; an on-disk cache fixture plus a resolver stub models that answer.
// Hub-only twins: bundle-serve.test.ts and root-serve.test.ts.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localInstallRoot, resolveBundleDistFrom } from "../bundle-serve.ts";
import { makeAppDistResolver } from "../root-serve.ts";
const APP_PKG = "@openparachute/app";
function makeShadowFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "phub-961-")));
  const home = join(root, "home");
  const globalNM = join(home, ".bun/install/global/node_modules");
  const globalRoot = join(globalNM, APP_PKG);
  const cacheRoot = join(
    home,
    ".bun/install/cache/@openparachute/app@0.22.14@@@1/node_modules",
    APP_PKG,
  );
  const project = join(root, "project");
  const projectRoot = join(project, "node_modules", APP_PKG);
  for (const [dir, version] of [
    [globalRoot, "0.22.15-rc.1"],
    [cacheRoot, "0.22.14"],
    [projectRoot, "9.9.9"],
  ] as const) {
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: APP_PKG, version }));
    writeFileSync(join(dir, "dist/index.html"), version);
  }
  const hubHome = join(root, "home-of-hub");
  mkdirSync(hubHome);
  mkdirSync(join(project, "packages/sub"), { recursive: true });
  return {
    home,
    hubHome,
    project,
    globalNM,
    globalRoot,
    globalDist: join(globalRoot, "dist"),
    cachePkgJson: join(cacheRoot, "package.json"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("P1: bare hub cwd cannot shadow the installed rc with Bun's cache", () => {
  const f = makeShadowFixture();
  try {
    const probed: string[] = [];
    const out = resolveBundleDistFrom({
      cwd: f.hubHome,
      home: f.home,
      pkg: APP_PKG,
      resolveSync: (s, b) => {
        probed.push(b);
        if (b === f.hubHome) return f.cachePkgJson;
        return Bun.resolveSync(s, b);
      },
    });
    expect(out).toBe(f.globalDist);
    expect(out).not.toContain(".bun/install/cache");
    expect(probed).toEqual([f.globalNM]);
  } finally {
    f.cleanup();
  }
});
test("P2: skipped cwd remains in the resolution error with its reason", () => {
  const f = makeShadowFixture();
  try {
    let message = "";
    try {
      resolveBundleDistFrom({
        cwd: f.hubHome,
        home: f.home,
        pkg: APP_PKG,
        resolveSync: () => {
          throw new Error("missing");
        },
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(`${f.hubHome}: skipped`);
    expect(message).toContain(`node_modules/${APP_PKG}/package.json`);
    expect(message).toContain("hub#961");
    expect(message).toContain(f.globalNM);
  } finally {
    f.cleanup();
  }
});
test("P3: a real local install wins", () => {
  const f = makeShadowFixture();
  try {
    const probed: string[] = [];
    const out = resolveBundleDistFrom({
      cwd: f.project,
      home: f.home,
      pkg: APP_PKG,
      resolveSync: (s, b) => {
        probed.push(b);
        if (b === f.project) return join(f.project, "node_modules", APP_PKG, "package.json");
        throw new Error("unexpected");
      },
    });
    expect(out).toBe(join(f.project, "node_modules", APP_PKG, "dist"));
    expect(probed).toEqual([f.project]);
  } finally {
    f.cleanup();
  }
});
test("P6: supervisor install-root cwd is actually probed and wins", () => {
  const f = makeShadowFixture();
  try {
    const cwd = f.globalRoot;
    const probed: string[] = [];
    const out = resolveBundleDistFrom({
      cwd,
      home: f.home,
      pkg: APP_PKG,
      resolveSync: (s, b) => {
        probed.push(b);
        return Bun.resolveSync(s, b);
      },
    });
    expect(out).toBe(f.globalDist);
    expect(probed).toEqual([cwd]);
    expect(localInstallRoot(cwd, APP_PKG, existsSync)).toBe(join(f.home, ".bun/install/global"));
  } finally {
    f.cleanup();
  }
});
test("P7: first successful root resolution logs once", () => {
  const lines: string[] = [];
  const resolve = makeAppDistResolver(
    () => "/x/dist",
    (l) => lines.push(l),
  );
  for (let i = 0; i < 3; i++) expect(resolve()).toBe("/x/dist");
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain("root_mode=serve-app");
  expect(lines[0]).toContain("/x/dist");
});
test("P8: failure is silent and recovery logs once", () => {
  let installed = false;
  const lines: string[] = [];
  const resolve = makeAppDistResolver(
    () => {
      if (!installed) throw new Error("missing");
      return "/x/dist";
    },
    (l) => lines.push(l),
  );
  expect(resolve()).toBeNull();
  expect(resolve()).toBeNull();
  expect(lines.length).toBe(0);
  installed = true;
  expect(resolve()).toBe("/x/dist");
  expect(lines.length).toBe(1);
  expect(resolve()).toBe("/x/dist");
  expect(lines.length).toBe(1);
});

test("P4: ancestor local install admits a nested cwd", () => {
  const f = makeShadowFixture();
  try {
    const cwd = join(f.project, "packages/sub");
    const probed: string[] = [];
    const out = resolveBundleDistFrom({
      cwd,
      home: f.home,
      pkg: APP_PKG,
      resolveSync: (s, b) => {
        probed.push(b);
        if (b === cwd) return join(f.project, "node_modules", APP_PKG, "package.json");
        throw new Error("unexpected");
      },
    });
    expect(out).toBe(join(f.project, "node_modules", APP_PKG, "dist"));
    expect(probed).toEqual([cwd]);
    expect(localInstallRoot(cwd, APP_PKG, existsSync)).toBe(f.project);
  } finally {
    f.cleanup();
  }
});
test("P5: pure ancestor walk terminates at the filesystem root", () => {
  expect(
    localInstallRoot(
      "/a/b/c",
      APP_PKG,
      (p) => p === "/a/node_modules/@openparachute/app/package.json",
    ),
  ).toBe("/a");
  expect(localInstallRoot("/a/b/c", APP_PKG, () => false)).toBeUndefined();
  expect(localInstallRoot("/", APP_PKG, () => false)).toBeUndefined();
});
