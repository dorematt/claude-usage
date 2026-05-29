import * as vscode from "vscode";
import { locatePython } from "./python-locator";
import { resolveInstallMode, dashboardSpawnArgs, InstallMode } from "./install-mode";
import { resolvePort } from "./port-allocator";
import { ServerManager, OutputSink } from "./server-manager";
import { DashboardSidebar } from "./sidebar";

/**
 * Lifecycle owner for the extension. Held as a module-level singleton so
 * deactivate() can find it.
 */
class Extension {
  private context: vscode.ExtensionContext;
  private output: vscode.OutputChannel;
  private sidebar: DashboardSidebar;
  private server: ServerManager | undefined;
  /**
   * In-flight startup. Subsequent openDashboard() calls await this one
   * instead of spawning a second ServerManager. Cleared on resolve/reject.
   * Prevents the double-click orphaned-process race Codex flagged.
   */
  private startupInFlight: Promise<void> | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.output = vscode.window.createOutputChannel("Claude Usage");
    this.sidebar = new DashboardSidebar();

    context.subscriptions.push(
      this.output,
      vscode.window.registerWebviewViewProvider(DashboardSidebar.viewId, this.sidebar),
      vscode.commands.registerCommand("claudeUsage.open", () => this.openDashboard()),
      vscode.commands.registerCommand("claudeUsage.rescan", () => this.rescan()),
      vscode.commands.registerCommand("claudeUsage.restart", () => this.restart()),
      vscode.commands.registerCommand("claudeUsage.showLogs", () => this.output.show()),
    );
  }

  /**
   * Start (or focus) the dashboard. If the server isn't running yet, this
   * resolves Python + install mode + port, spawns the server, then points
   * the sidebar at it.
   */
  async openDashboard(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.extension.claudeUsageSidebar");

    if (this.server && this.server.status === "ready") {
      this.sidebar.refresh();
      return;
    }
    // Coalesce concurrent calls onto a single in-flight startup so we don't
    // spawn two Python processes and overwrite this.server.
    if (this.startupInFlight) {
      return this.startupInFlight;
    }
    this.startupInFlight = this.doStartup().finally(() => {
      this.startupInFlight = undefined;
    });
    return this.startupInFlight;
  }

  private async doStartup(): Promise<void> {
    const config = vscode.workspace.getConfiguration("claudeUsage");
    const configuredPython = config.get<string>("pythonPath", "");
    const configuredCli = config.get<string>("cliPath", "");
    // Hardcoded to localhost. We previously exposed a `host` setting but
    // 0.0.0.0 would have made the user's usage data visible on the LAN.
    // The Python dashboard accepts HOST/PORT env vars directly if someone
    // really needs to bind elsewhere; that's an out-of-extension config.
    const host = "127.0.0.1";
    const configuredPort = config.get<number>("port", 0);

    const mode = resolveInstallMode({
      configuredCliPath: configuredCli,
      extensionDir: this.context.extensionUri.fsPath,
    });
    if (mode.kind === "none") {
      const msg = "Could not find a claude-usage install. Install via Homebrew or set claudeUsage.cliPath to a clone's cli.py.";
      this.output.appendLine(msg);
      this.sidebar.setStatus(msg);
      vscode.window.showErrorMessage(msg);
      return;
    }

    const python = mode.kind === "clone" ? locatePython(configuredPython) : undefined;
    if (mode.kind === "clone" && !python) {
      const msg = "Could not find Python 3 on PATH. Install Python or set claudeUsage.pythonPath.";
      this.output.appendLine(msg);
      this.sidebar.setStatus(msg);
      vscode.window.showErrorMessage(msg);
      return;
    }

    const port = await resolvePort(configuredPort, host);
    const url = `http://${host}:${port}/`;
    // Probe a dashboard-specific endpoint so we don't get fooled by some
    // other localhost service listening on the same port.
    const probeUrl = `http://${host}:${port}/api/data`;
    const spawnArgs = dashboardSpawnArgs(mode, python, ["--host", host, "--port", String(port)]);
    if (!spawnArgs) {
      const msg = "Could not assemble a valid command to spawn the dashboard.";
      this.output.appendLine(msg);
      this.sidebar.setStatus(msg);
      return;
    }

    this.sidebar.setStatus(`Starting dashboard at ${url}…`);
    this.output.appendLine(`[ext] install mode: ${describeMode(mode)}`);
    // Capture the manager into a local so the catch block can't dispose
    // a *different* manager that was created by a concurrent call.
    const manager = new ServerManager({
      command: spawnArgs.command,
      args: spawnArgs.args,
      url: probeUrl,
      output: this.toSink(),
    });
    this.server = manager;
    try {
      await manager.start();
      this.sidebar.setUrl(url);
    } catch (err) {
      const msg = `Failed to start dashboard: ${(err as Error).message}`;
      this.output.appendLine(msg);
      this.sidebar.setStatus(msg);
      vscode.window.showErrorMessage(msg);
      manager.dispose();
      if (this.server === manager) this.server = undefined;
    }
  }

  /**
   * Trigger a rescan against the running server, then refresh the iframe.
   * Currently just refreshes — the existing Python dashboard has a Rescan
   * button inside the UI; this is a placeholder for future host-driven
   * rescan if we add a POST endpoint dedicated to it.
   */
  rescan(): void {
    this.sidebar.refresh();
  }

  async restart(): Promise<void> {
    // If a startup is in flight, wait for it to settle so we don't dispose a
    // manager mid-spawn and leave an orphaned Python process.
    if (this.startupInFlight) {
      try { await this.startupInFlight; } catch { /* ignored — about to restart */ }
    }
    if (this.server) {
      this.server.dispose();
      this.server = undefined;
    }
    this.sidebar.setUrl(null);
    await this.openDashboard();
  }

  dispose(): void {
    if (this.server) {
      this.server.dispose();
      this.server = undefined;
    }
  }

  private toSink(): OutputSink {
    return { appendLine: (line) => this.output.appendLine(line) };
  }
}

function describeMode(mode: InstallMode): string {
  if (mode.kind === "brew") return `brew (${mode.binary})`;
  if (mode.kind === "clone") return `clone (${mode.cliPy})`;
  return "none";
}

let extension: Extension | undefined;

export function activate(context: vscode.ExtensionContext): void {
  extension = new Extension(context);
}

export function deactivate(): void {
  extension?.dispose();
  extension = undefined;
}
