// =============================================================================
// server.js
//
// This is the ENTRY POINT of the whole application — it's the file you (or
// Render) actually run with `node src/server.js`. Its job is small and
// boring on purpose:
//   1. Create one real MonitorManager (the brain).
//   2. Wire up what should happen when it emits "alert" or "recover" events
//      (this is where a real email/webhook integration would eventually
//      plug in — see the comment on the "alert" listener below).
//   3. Build the Express app around that manager (using createApp from
//      app.js) and start it listening on a port.
//   4. Make sure the server shuts down cleanly when asked to.
//
// Notice that NONE of the actual monitoring logic lives in this file — by
// the time you're reading this file, monitorManager.js has already done
// all the hard thinking. server.js is just the "ignition switch".
// =============================================================================

import { createApp } from "./app.js";
import { MonitorManager } from "./monitorManager.js";

// Render (and most hosting platforms) will tell your app which port to
// listen on via the PORT environment variable — you do NOT get to choose
// your own port number in production. Locally, where PORT usually isn't
// set, we fall back to 3000 so `npm start` just works out of the box on
// your laptop.
const PORT = process.env.PORT || 3000;

// One single MonitorManager for the whole running process — every request
// that comes in through Express shares this same manager and therefore the
// same in-memory list of monitors.
const manager = new MonitorManager();

// -----------------------------------------------------------------------
// Developer's Choice: notification hooks.
// -----------------------------------------------------------------------
// Remember from monitorManager.js: the manager .emit()s an "alert" event
// whenever a device's timer expires, and a "recover" event whenever a
// previously-down device sends a heartbeat again. Here is where we
// "subscribe" to those events and decide what to actually DO about them.
//
// Right now we just console.log a fake notification — but because of how
// EventEmitter / loose coupling works, you could swap this single block
// out for real logic (e.g. calling an email API like SendGrid, or doing an
// HTTP POST to a Slack webhook URL) without touching monitorManager.js or
// app.js AT ALL. That's the whole point of this design.
manager.on("alert", ({ monitor }) => {
  if (monitor.alert_email) {
    console.log(`[notify] Would email ${monitor.alert_email} about '${monitor.id}' going down.`);
  }
});

manager.on("recover", (monitor) => {
  console.log(JSON.stringify({ RECOVERED: `Device ${monitor.id} is back online.`, time: new Date().toISOString() }));
});

// Build the actual Express app, wired to our one shared manager.
const app = createApp(manager);

// app.listen(...) starts the HTTP server and gives us back a `server`
// object, which we need to hold onto so we can later call server.close()
// during a graceful shutdown (see below).
const server = app.listen(PORT, () => {
  console.log(`Watchdog Sentinel listening on http://localhost:${PORT}`);
});

// -----------------------------------------------------------------------
// Graceful shutdown.
// -----------------------------------------------------------------------
// SIGINT is the signal sent when you press Ctrl+C in a terminal. SIGTERM is
// the signal most hosting platforms (including Render) send when they want
// your app to stop — e.g. during a deploy, a restart, or scaling down.
//
// If we didn't handle these, Node would just die abruptly mid-request and
// leave any pending setTimeout timers dangling. Instead, we:
//   1. Call manager.shutdown() to cancel every monitor's timer.
//   2. Call server.close() to stop accepting NEW connections but let any
//      in-flight requests finish first.
//   3. Only once that's done, call process.exit(0) — the `0` means "this
//      was a clean, intentional exit", as opposed to a crash.
// This is considered good practice for any production Node.js service.
function close() {
  manager.shutdown();
  server.close(() => process.exit(0));
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
