/**
 * WHICH HOST IS THE SCANNER — one answer, in one place.
 *
 * The 30-minute sweep used to run only on this platform computer, and that
 * computer is switched off and replaced regularly: the owner got one Telegram
 * message shortly after he mentioned the silence, then nothing. The sweep now
 * runs on the owner's IONOS VPS (systemd `eaw-alerts`, restart=always), and the
 * platform host must NOT scan as well — two scanners would double-alert the
 * group and double-spend odds credits.
 *
 * So exactly one host is the scanner, named here:
 *
 *   PRIMARY_SCANNER = "vps"        ← the owner's VPS is the one scanner
 *
 * Every entry point that could spend credits or send an alert asks
 * `isPrimaryScanner()` first:
 *
 *   • scripts/alert-loop.sh      — the 30-minute schedule (bash, reads
 *                                  deploy/vps/primary.conf, which a test pins to
 *                                  the constant below)
 *   • scripts/alert-keepalive.sh — the platform supervisor that restarts it
 *   • vite.config.ts             — the dev-server boot hook that spawns both
 *   • src/server/scan-on-open.ts — the page-open scan (/api/instant-wins), which
 *                                  runs the SAME pipeline: real credits, real
 *                                  Telegram, real snapshot push
 *
 * HOW A HOST KNOWS: `EAW_ALERT_ROLE`. The systemd unit on the VPS sets it to
 * `vps`; the platform sets nothing, so it reads as `platform`. Absence is
 * deliberately the platform value — if the VPS is ever wiped, the platform
 * machine is still a working scanner the moment someone rolls back
 * (deploy/vps/rollback.sh), with no environment to remember.
 */

export type AlertHost = "platform" | "vps";

/**
 * The host that scans. Changing this is a cutover or a rollback, not a tweak:
 * `deploy/vps/primary.conf` must be changed with it (test/alert-role.test.ts
 * fails until they agree), and deploy/vps/rollback.sh changes both at once.
 */
export const PRIMARY_SCANNER: AlertHost = "vps";

/** Which host is this process on? Unset means the platform. */
export function thisHost(): AlertHost {
  return (process.env.EAW_ALERT_ROLE ?? "").trim().toLowerCase() === "vps" ? "vps" : "platform";
}

/**
 * May THIS process scan, alert, or push a snapshot?
 *
 * False on the platform host now that the VPS is primary. A caller that gets
 * false must not fetch odds, must not message Telegram, and should say why
 * rather than pretending a scan happened.
 */
export function isPrimaryScanner(): boolean {
  return thisHost() === PRIMARY_SCANNER;
}

/** A short, honest explanation for a caller that was told not to scan. */
export function notScannerReason(): string {
  return `this host (${thisHost()}) is not the alert scanner — the ${PRIMARY_SCANNER} host is`;
}
