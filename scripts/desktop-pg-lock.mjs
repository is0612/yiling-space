import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const held = new Set();

function lockError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Windows OS lifetime lock only. The caller must protect the existing instance directory
 * with an appropriate user ACL before calling. This is mutual exclusion, not authentication.
 * No PID files, stale-file deletion, credentials, or database operations are involved.
 */
export async function acquireDesktopPgLock(root) {
  if (process.platform !== "win32") {
    throw lockError("DESKTOP_PG_LOCK_UNSUPPORTED", "Desktop PostgreSQL OS lock currently supports Windows only; Unix socket cleanup has not been verified.");
  }
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw lockError("DESKTOP_PG_LOCK_INVALID_ROOT", "The instance root must be an existing absolute directory.");
  }
  if (!(await stat(root)).isDirectory()) {
    throw lockError("DESKTOP_PG_LOCK_INVALID_ROOT", "The instance root must be an existing absolute directory.");
  }
  // Resolve symlinks/junctions, normalize separators/case, and remove trailing separators.
  // Windows directories are normally case insensitive. Over-serializing a deliberately
  // case-sensitive directory is preferable to accidentally starting two database managers.
  const canonical = path.normalize(await realpath(root)).replace(/[\\/]+$/u, "").toLowerCase();
  const digest = createHash("sha256").update(canonical).digest("hex");
  // Deliberately NOT namespaced by SID: different users reaching the same physical root
  // must contend for the same lock. User access control belongs to the directory ACL.
  const pipe = `\\\\.\\pipe\\yiling-desktop-pg-${digest}`;
  const busy = () => lockError("DESKTOP_PG_LOCK_BUSY", "This PostgreSQL instance already has a running desktop manager.");
  if (held.has(canonical)) throw busy();
  held.add(canonical); // Includes pending acquisition, closing the same-process race.
  const sockets = new Set();
  const server = net.createServer(socket => {
    // The pipe carries no protocol or data. Do not let an unsolicited client delay release.
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.destroy();
  });
  let acquired = false;
  let releasePromise;
  let unexpectedError;
  server.on("error", error => { unexpectedError = error; });
  try {
    await new Promise((resolve, reject) => {
      const fail = error => { server.off("listening", ready); reject(error); };
      const ready = () => { server.off("error", fail); resolve(); };
      server.once("error", fail);
      server.once("listening", ready);
      // libuv's first named-pipe instance binding supplies OS-level exclusivity.
      server.listen(pipe);
    });
    acquired = true;
  } catch (error) {
    held.delete(canonical);
    if (error.code === "EADDRINUSE") throw busy();
    throw error;
  }
  return {
    assertHeld() {
      if (!acquired || !server.listening || unexpectedError) {
        throw lockError("DESKTOP_PG_LOCK_NOT_HELD", "The desktop PostgreSQL instance lock is no longer held.");
      }
    },
    release() {
      if (releasePromise) return releasePromise;
      acquired = false;
      releasePromise = new Promise((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close(error => {
          held.delete(canonical);
          if (error) reject(error);
          else resolve();
        });
      });
      return releasePromise;
    },
  };
}
