/**
 * Public liveness probe. Deliberately touches nothing except the clock so a load balancer or
 * uptime checker can tell the process is alive even when the database is down.
 */
export default defineEventHandler(() => {
  return {
    ok: true,
    service: "yiling-hub",
    version: "0.1.0",
    time: new Date().toISOString(),
  };
});
