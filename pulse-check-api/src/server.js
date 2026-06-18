import { createApp } from "./app.js";
import { MonitorManager } from "./monitorManager.js";

const PORT = process.env.PORT || 3000;

const manager = new MonitorManager();

// Developer's Choice: a webhook/email hook point.
// In production this would POST to a webhook URL or send a real email.
manager.on("alert", ({ monitor }) => {
  if (monitor.alert_email) {
    console.log(`[notify] Would email ${monitor.alert_email} about '${monitor.id}' going down.`);
  }
});
manager.on("recover", (monitor) => {
  console.log(JSON.stringify({ RECOVERED: `Device ${monitor.id} is back online.`, time: new Date().toISOString() }));
});

const app = createApp(manager);

const server = app.listen(PORT, () => {
  console.log(`Watchdog Sentinel listening on http://localhost:${PORT}`);
});

// Graceful shutdown so timers don't dangle.
function close() {
  manager.shutdown();
  server.close(() => process.exit(0));
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
