import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveInstallMode, dashboardSpawnArgs } from "../src/install-mode";

const IS_WIN = process.platform === "win32";
const PATH_SEP = IS_WIN ? ";" : ":";

function writeShim(dir: string, name: string): string {
  const p = path.join(dir, name);
  if (IS_WIN) {
    fs.writeFileSync(p, "@echo fake\r\n");
  } else {
    fs.writeFileSync(p, "#!/bin/sh\necho fake\n");
    fs.chmodSync(p, 0o755);
  }
  return p;
}

describe("resolveInstallMode", () => {
  let tmpDir: string;
  let cleanEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-mode-"));
    cleanEnv = { ...process.env, PATH: tmpDir };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns brew mode when claude-usage is on PATH", () => {
    const shim = writeShim(tmpDir, IS_WIN ? "claude-usage.exe" : "claude-usage");
    const mode = resolveInstallMode({ configuredCliPath: "", env: cleanEnv });
    expect(mode).toEqual({ kind: "brew", binary: shim });
  });

  it("returns clone mode when configuredCliPath points at a cli.py file", () => {
    const cli = path.join(tmpDir, "cli.py");
    fs.writeFileSync(cli, "# placeholder\n");
    const mode = resolveInstallMode({ configuredCliPath: cli, env: cleanEnv });
    expect(mode).toEqual({ kind: "clone", cliPy: cli });
  });

  it("returns clone mode when configuredCliPath points at a clone directory", () => {
    const cli = path.join(tmpDir, "cli.py");
    fs.writeFileSync(cli, "# placeholder\n");
    const mode = resolveInstallMode({ configuredCliPath: tmpDir, env: cleanEnv });
    expect(mode).toEqual({ kind: "clone", cliPy: cli });
  });

  it("explicit setting wins even when brew is also on PATH", () => {
    writeShim(tmpDir, IS_WIN ? "claude-usage.exe" : "claude-usage");
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-mode-other-"));
    try {
      const cli = path.join(otherDir, "cli.py");
      fs.writeFileSync(cli, "# placeholder\n");
      const mode = resolveInstallMode({ configuredCliPath: cli, env: cleanEnv });
      expect(mode).toEqual({ kind: "clone", cliPy: cli });
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("falls back to monorepo sibling cli.py when neither setting nor PATH find anything", () => {
    // Simulate this extension dir being inside a Python repo: <root>/vscode-extension/
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "install-mode-mono-"));
    const extDir = path.join(repoRoot, "vscode-extension");
    fs.mkdirSync(extDir);
    const sibling = path.join(repoRoot, "cli.py");
    fs.writeFileSync(sibling, "# placeholder\n");
    try {
      const mode = resolveInstallMode({
        configuredCliPath: "",
        extensionDir: extDir,
        env: cleanEnv, // empty PATH, no brew
      });
      expect(mode).toEqual({ kind: "clone", cliPy: sibling });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("returns none when nothing is found anywhere", () => {
    const mode = resolveInstallMode({ configuredCliPath: "", env: cleanEnv });
    expect(mode).toEqual({ kind: "none" });
  });

  it("ignores configuredCliPath that doesn't exist", () => {
    const mode = resolveInstallMode({
      configuredCliPath: path.join(tmpDir, "no-such-cli.py"),
      env: cleanEnv,
    });
    expect(mode).toEqual({ kind: "none" });
  });
});

describe("dashboardSpawnArgs", () => {
  it("brew mode emits the bin directly with subcommand", () => {
    const mode = { kind: "brew" as const, binary: "/usr/local/bin/claude-usage" };
    expect(dashboardSpawnArgs(mode, undefined, ["--host", "127.0.0.1", "--port", "9000"]))
      .toEqual({ command: "/usr/local/bin/claude-usage", args: ["dashboard", "--host", "127.0.0.1", "--port", "9000"] });
  });

  it("clone mode emits python + cli.py + subcommand", () => {
    const mode = { kind: "clone" as const, cliPy: "/repo/cli.py" };
    expect(dashboardSpawnArgs(mode, "/usr/bin/python3", ["--host", "127.0.0.1"]))
      .toEqual({ command: "/usr/bin/python3", args: ["/repo/cli.py", "dashboard", "--host", "127.0.0.1"] });
  });

  it("clone mode returns undefined when no python is available", () => {
    const mode = { kind: "clone" as const, cliPy: "/repo/cli.py" };
    expect(dashboardSpawnArgs(mode, undefined, [])).toBeUndefined();
  });

  it("none mode returns undefined regardless of python", () => {
    expect(dashboardSpawnArgs({ kind: "none" }, "/usr/bin/python3", [])).toBeUndefined();
    expect(dashboardSpawnArgs({ kind: "none" }, undefined, [])).toBeUndefined();
  });
});
