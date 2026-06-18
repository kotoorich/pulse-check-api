// =============================================================================
// app.js
//
// This file is the HTTP "front door" of the application. It uses Express
// (a popular, minimal Node.js web framework) to turn incoming HTTP requests
// like "POST /monitors" into calls on our MonitorManager (the real brain,
// in monitorManager.js).
//
// THE BIG IDEA TO REMEMBER:
// app.js should be "dumb". Its only two jobs are:
//   1. Validate that the request looks sane (right fields, right types).
//   2. Translate between HTTP-land (status codes, JSON bodies) and our
//      MonitorManager's plain JavaScript method calls.
// All the actual *logic* (timers, state transitions, alerts) lives in
// monitorManager.js. This separation is called "layering" — it means you
// could swap Express for a different web framework, or add a CLI on top of
// the SAME MonitorManager, without rewriting any business logic.
//
// WHY IS MonitorManager "INJECTED" AS A PARAMETER?
// createApp(manager = new MonitorManager()) lets the caller hand in their
// own manager. In production (server.js) we just let it create a fresh
// one. In tests, you could create your OWN manager, do some setup on it,
// then pass it into createApp() to test the HTTP layer against a manager
// you fully control. This pattern is called "dependency injection" and is
// a big deal in interviews — it's what makes code testable.
// =============================================================================

import express from "express";
import { MonitorManager, Status } from "./monitorManager.js";

/**
 * Build and configure the Express app. We wrap this in a function (instead
 * of just writing `const app = express()` at the top level of the file)
 * specifically so we can call createApp() multiple times with different
 * managers — once for the real server, and as many times as we like in
 * tests, each with a clean, isolated manager.
 */
export function createApp(manager = new MonitorManager()) {
  const app = express();

  // This built-in Express middleware reads the raw bytes of an incoming
  // request body, and if its Content-Type is application/json, parses it
  // into a real JavaScript object available as `req.body`. Without this
  // line, req.body would be undefined and every POST route below would
  // break.
  app.use(express.json());

  // ---------------------------------------------------------------------
  // GET /health
  // A "liveness" endpoint. Load balancers, uptime checkers (like Render's
  // own health checks!) and humans hit this to ask "are you alive and
  // working?" without it doing anything meaningful to application state.
  // ---------------------------------------------------------------------
  app.get("/health", (_req, res) => {
    // The leading underscore on `_req` is just a convention meaning "this
    // parameter exists because Express requires it, but I never use it".
    res.json({ status: "ok", monitors: manager.list().length, uptime: process.uptime() });
  });

  // ---------------------------------------------------------------------
  // POST /monitors   — User Story 1: register a new monitor
  // ---------------------------------------------------------------------
  app.post("/monitors", (req, res) => {
    // `req.body ?? {}` guards against a request sent with NO body at all
    // (where req.body could be undefined) so the destructuring below
    // doesn't crash the server with "cannot destructure property of
    // undefined".
    const { id, timeout, alert_email } = req.body ?? {};

    // --- Input validation ---
    // We deliberately check each field separately, with a specific error
    // message for each, rather than one big vague "bad request". This
    // makes the API much nicer to use: a client gets told EXACTLY what
    // they did wrong, instead of guessing.

    if (typeof id !== "string" || id.trim() === "") {
      return res.status(400).json({ error: "`id` is required and must be a non-empty string." });
    }
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      // Number.isFinite() rejects NaN, Infinity, and -Infinity — all
      // technically "numbers" in JavaScript but useless as a countdown
      // length. Always prefer Number.isFinite() over the global isFinite()
      // for this reason.
      return res.status(400).json({ error: "`timeout` is required and must be a positive number (seconds)." });
    }
    if (alert_email !== undefined && typeof alert_email !== "string") {
      // alert_email is OPTIONAL, so we only complain if it was provided
      // AND it's the wrong type — we don't require it to exist at all.
      return res.status(400).json({ error: "`alert_email` must be a string if provided." });
    }

    // Hand off to the real logic in MonitorManager.
    const created = manager.register({ id, timeout, alert_email });

    if (!created) {
      // register() returns null specifically when the id already exists.
      // 409 Conflict is the correct HTTP status code for "this resource
      // already exists" — worth remembering for interviews (400 = "your
      // request was malformed", 409 = "your request was fine, but
      // conflicts with existing state").
      return res.status(409).json({ error: `Monitor '${id}' already exists.` });
    }

    // 201 Created is the correct status for "I made a new thing for you",
    // as opposed to 200 OK which is the generic "it worked" status.
    return res.status(201).json({
      message: `Monitor '${id}' created. Countdown started for ${timeout}s.`,
      monitor: created,
    });
  });

  // ---------------------------------------------------------------------
  // GET /monitors — list everything (handy for building a dashboard, or
  // just for debugging while you build/demo the project).
  // ---------------------------------------------------------------------
  app.get("/monitors", (_req, res) => {
    res.json({ monitors: manager.list() });
  });

  // ---------------------------------------------------------------------
  // GET /monitors/:id — fetch one monitor.
  // `:id` is an Express "route parameter" — whatever the client put in
  // that position of the URL becomes available as req.params.id. e.g. a
  // request to GET /monitors/device-123 gives req.params.id === "device-123".
  // ---------------------------------------------------------------------
  app.get("/monitors/:id", (req, res) => {
    const monitor = manager.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: `Monitor '${req.params.id}' not found.` });
    res.json({ monitor });
  });

  // ---------------------------------------------------------------------
  // POST /monitors/:id/heartbeat — User Story 2.
  // This is the endpoint a real device would call every few
  // seconds/minutes to say "I'm still alive". It also doubles as the
  // "un-pause" and "recover from down" action — see heartbeat() in
  // monitorManager.js for why that's handled there, not here.
  // ---------------------------------------------------------------------
  app.post("/monitors/:id/heartbeat", (req, res) => {
    const monitor = manager.heartbeat(req.params.id);
    if (!monitor) return res.status(404).json({ error: `Monitor '${req.params.id}' not found.` });
    res.status(200).json({
      message: `Heartbeat received. Timer reset to ${monitor.timeout}s.`,
      monitor,
    });
  });

  // ---------------------------------------------------------------------
  // POST /monitors/:id/pause — Bonus User Story.
  // Lets a human "snooze" alerts during planned maintenance.
  // ---------------------------------------------------------------------
  app.post("/monitors/:id/pause", (req, res) => {
    const monitor = manager.pause(req.params.id);
    if (!monitor) return res.status(404).json({ error: `Monitor '${req.params.id}' not found.` });
    res.status(200).json({
      message: `Monitor '${monitor.id}' paused. No alerts will fire until the next heartbeat.`,
      monitor,
    });
  });

  // ---------------------------------------------------------------------
  // DELETE /monitors/:id — clean teardown of a monitor that's no longer
  // needed (e.g. the device has been permanently retired).
  // ---------------------------------------------------------------------
  app.delete("/monitors/:id", (req, res) => {
    const ok = manager.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: `Monitor '${req.params.id}' not found.` });
    res.status(200).json({ message: `Monitor '${req.params.id}' deleted.` });
  });

  // ---------------------------------------------------------------------
  // Catch-all 404 fallback.
  // Because Express checks routes TOP TO BOTTOM in the order they're
  // defined, this `app.use(...)` with no path only ever runs if NONE of
  // the routes above matched — meaning the client asked for something we
  // simply don't have. This must stay at the BOTTOM of the file; if you
  // moved it above the real routes, it would swallow every single request
  // and none of your actual endpoints would ever run.
  // ---------------------------------------------------------------------
  app.use((req, res) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
  });

  return app;
}

// Re-export Status so other files (like tests) can import it from either
// app.js or monitorManager.js — just a small convenience.
export { Status };
