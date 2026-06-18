import express from "express";
import { MonitorManager, Status } from "./monitorManager.js";

/**
 * Build the Express app. The manager is injected so tests can pass their own.
 */
export function createApp(manager = new MonitorManager()) {
  const app = express();
  app.use(express.json());

  // Health check (Developer's Choice support endpoint).
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", monitors: manager.list().length, uptime: process.uptime() });
  });

  // User Story 1: Register a monitor.
  app.post("/monitors", (req, res) => {
    const { id, timeout, alert_email } = req.body ?? {};

    if (typeof id !== "string" || id.trim() === "") {
      return res.status(400).json({ error: "`id` is required and must be a non-empty string." });
    }
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      return res.status(400).json({ error: "`timeout` is required and must be a positive number (seconds)." });
    }
    if (alert_email !== undefined && typeof alert_email !== "string") {
      return res.status(400).json({ error: "`alert_email` must be a string if provided." });
    }

    const created = manager.register({ id, timeout, alert_email });
    if (!created) {
      return res.status(409).json({ error: `Monitor '${id}' already exists.` });
    }

    return res.status(201).json({
      message: `Monitor '${id}' created. Countdown started for ${timeout}s.`,
      monitor: created,
    });
  });

  // List all monitors (Developer's Choice support — useful for dashboards/debug).
  app.get("/monitors", (_req, res) => {
    res.json({ monitors: manager.list() });
  });

  // Read one monitor.
  app.get("/monitors/:id", (req, res) => {
    const monitor = manager.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: `Monitor '${req.params.id}' not found.` });
    res.json({ monitor });
  });

  // User Story 2: Heartbeat (reset). Also un-pauses / revives.
  app.post("/monitors/:id/heartbeat", (req, res) => {
    const monitor = manager.heartbeat(req.params.id);
    if (!monitor) return res.status(404).json({ error: `Monitor '${req.params.id}' not found.` });
    res.status(200).json({
      message: `Heartbeat received. Timer reset to ${monitor.timeout}s.`,
      monitor,
    });
  });

  // Bonus User Story: Pause (snooze).
  app.post("/monitors/:id/pause", (req, res) => {
    const monitor = manager.pause(req.params.id);
    if (!monitor) return res.status(404).json({ error: `Monitor '${req.params.id}' not found.` });
    res.status(200).json({
      message: `Monitor '${monitor.id}' paused. No alerts will fire until the next heartbeat.`,
      monitor,
    });
  });

  // Delete a monitor (Developer's Choice support — clean teardown).
  app.delete("/monitors/:id", (req, res) => {
    const ok = manager.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: `Monitor '${req.params.id}' not found.` });
    res.status(200).json({ message: `Monitor '${req.params.id}' deleted.` });
  });

  // 404 fallback.
  app.use((req, res) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
  });

  return app;
}

export { Status };
