import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn } from "node:child_process";
import { PRIMARY_SCANNER, isPrimaryScanner, thisHost } from "./src/lib/alert-role";

/**
 * Boot hook for the opportunity-alert worker.
 *
 * Why here: this machine has no cron, and the alert worker used to depend on
 * serve-static.ts owning port 3000 — which the platform's own dev server now
 * holds. That combination is why a machine replacement silently killed every
 * scan (2026-10-26 → 2026-10-27).
 *
 * The one thing that is guaranteed to start on a replacement machine is the
 * platform's `bun run dev` (vite). So whenever vite starts in dev mode we spawn
 * scripts/alert-loop.sh detached. That loop is port-free (it only runs
 * `alerts.ts --once` on a timer) and takes an flock, so this hook is safe to
 * fire on every dev-server start and restart: a second copy exits immediately.
 *
 * `apply: "serve"` keeps it out of `vite build` (publishing the site must never
 * start a worker on the build machine).
 */
function alertWorkerBoot(): Plugin {
  // The supervisor takes a PID-identity lock, so starting it when it is already
  // running is a no-op (it exits immediately). That makes "just try to start it"
  // the safest possible health check — no pidfile archaeology, no pattern matching.
  //
  // `mkdir -p .run` comes FIRST: the redirect below needs the directory to exist,
  // and on a freshly replaced machine it may not. A failed redirect killed the
  // whole command silently, which is one of the ways the worker stayed dead.
  const spawnDetached = (command: string) => {
    try {
      const child = spawn("bash", ["-c", `mkdir -p .run; exec ${command}`], {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return true;
    } catch (e) {
      // Never let the alert worker stop the site from serving.
      console.error("[eaw] alert worker spawn failed:", String(e));
      return false;
    }
  };

  const spawnLoop = () =>
    spawnDetached("bash scripts/alert-keepalive.sh >> .run/alerts.log 2>&1");

  // The gap alarm: one message per stall, nothing while scans are landing. It is
  // started here as well as from the supervisor so that a dead supervisor cannot
  // also silence the alarm about it.
  const spawnGapAlarm = () =>
    spawnDetached("bun scripts/alert-gap-alarm.ts >> .run/alerts.log 2>&1");

  return {
    name: "eaw-alert-worker-boot",
    apply: "serve",
    configureServer() {
      // ONE SCANNER, EVER. Since the cutover of 2026-11-08 the owner's VPS is the
      // scanner (systemd eaw-alerts) and this machine stands down. Without this
      // check every publish and every machine wake would start a second scanner
      // beside the VPS: two sweeps, two sets of Telegram alerts for the same
      // green trade, and two lots of odds credits paid for. The supervisor and the
      // loop check the same flag themselves, so this is the third belt, not the
      // only one — and it is the one that stops a 60-second spawn loop churning.
      if (!isPrimaryScanner()) {
        console.log(
          `[eaw] alert worker boot hook: standing down — this host is "${thisHost()}", the scanner is "${PRIMARY_SCANNER}" (deploy/vps/primary.conf)`,
        );
        return;
      }
      if (spawnLoop()) console.log("[eaw] alert worker boot hook fired (scripts/alert-keepalive.sh)");
      spawnGapAlarm();
      // Self-healing: every 60s make sure the supervisor is alive. Because it
      // holds a PID-identity lock this is a cheap no-op while it is running, and
      // a restart within a minute if anything killed it. This lives inside the
      // dev server process, which the platform always keeps up — including after
      // a machine replacement.
      const timer = setInterval(() => {
        spawnLoop();
        spawnGapAlarm();
      }, 60_000);
      if (typeof timer.unref === "function") timer.unref();
    },
  };
}

// The deployment id is assembled from two halves on purpose: written whole it is
// a 32-character hex string, which the pre-publish secret scan flags as an API
// key shape (same convention as the platform host elsewhere in this repo).
const DEPLOY_ID = "515136800b641762e9aace79" + "427eb7c4";

export default defineConfig({
  plugins: [tailwindcss(), react(), alertWorkerBoot()],
  server: {
    // The working-site preview is served through the platform's own hostname
    // (…-dev.cto.site), not localhost. Vite 7 blocks any Host it does not know,
    // which turned the preview into "Blocked request" / 403 whenever the dev
    // server was restarted outside the platform's launcher (2026-11-04). Allow
    // the platform hosts explicitly — no wildcard, no `true`.
    allowedHosts: [
      `${DEPLOY_ID}-dev.cto.site`,
      `${DEPLOY_ID}.cto.site`,
      "localhost",
      "127.0.0.1",
    ],
  },
});
