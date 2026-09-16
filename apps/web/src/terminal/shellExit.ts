import type { ShellExit } from "@termany/core";

/**
 * How long a shell has to survive before we believe it started successfully.
 * Under this, a death is a launch failure (bad rc file, missing binary) rather
 * than anything the user did.
 */
export const RESTART_HEALTHY_MS = 3000;

/**
 * Cap on consecutive fast respawns, so a shell that dies on every launch can't
 * spin forever. Reset once a shell lives past RESTART_HEALTHY_MS, which keeps
 * the cap meaning "5 failures in a row" rather than "5 ever".
 */
export const MAX_AUTO_RESTARTS = 5;

export type ShellExitDisposition = "close-pane" | "restart";

/**
 * Decide what a dead shell should do to its pane.
 *
 * Every mainstream terminal closes the pane when its shell exits, and that is
 * what a user pressing Ctrl+D is asking for. Respawning in place (what this app
 * did unconditionally before) makes the pane un-closable from the keyboard and
 * surprises anyone with terminal muscle memory.
 *
 * The tempting test — "exit code 0 means the user meant it" — does not work:
 * both bash and zsh exit with the LAST COMMAND'S status on EOF, so Ctrl+D after
 * a `grep` that matched nothing arrives as code 1. Judging by exit code alone
 * would respawn exactly the pane the user just asked to close.
 *
 * So the signal we key on is *how* the shell died, not what it returned:
 *
 *   - killed by a signal (segfault, OOM, `kill -9`) -> never user intent
 *   - dead within RESTART_HEALTHY_MS of spawning    -> launch failure, not intent
 *   - anything else                                 -> it ran, then ended on its
 *                                                      own, i.e. the user did it
 *
 * `exit` being undefined means the socket closed without the server saying how
 * (its own shutdown, a newer connection displacing this one, an older server).
 * Closing a pane is destructive and irreversible, so it needs positive
 * evidence — without any, fall back to the historical restart behaviour.
 */
export function shellExitDisposition(
  exit: ShellExit | undefined,
  aliveMs: number
): ShellExitDisposition {
  if (!exit) return "restart";
  if (exit.signal) return "restart"; // 0/undefined == "not signalled"
  if (aliveMs <= RESTART_HEALTHY_MS) return "restart";
  return "close-pane";
}
