import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { spawn } from "node:child_process";

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
  // The loop takes an flock, so starting it when it is already running is a
  // no-op (it exits immediately). That makes "just try to start it" the safest
  // possible health check — no pidfile archaeology, no pattern matching.
  const spawnLoop = () => {
    try {
      const child = spawn(
        "bash",
        ["-c", "exec bash scripts/alert-keepalive.sh >> .run/alerts.log 2>&1"],
        { cwd: process.cwd(), detached: true, stdio: "ignore" }
      );
      child.unref();
      return true;
    } catch (e) {
      // Never let the alert worker stop the site from serving.
      console.error("[eaw] alert worker spawn failed:", String(e));
      return false;
    }
  };

  return {
    name: "eaw-alert-worker-boot",
    apply: "serve",
    configureServer() {
      if (spawnLoop()) console.log("[eaw] alert worker boot hook fired (scripts/alert-loop.sh)");
      // Self-healing: every 60s make sure the loop is alive. Because the loop
      // holds an flock this is a cheap no-op while it is running, and a restart
      // within a minute if anything killed it. This lives inside the dev server
      // process, which the platform always keeps up.
      const timer = setInterval(spawnLoop, 60_000);
      if (typeof timer.unref === "function") timer.unref();
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), react(), alertWorkerBoot()],
});
