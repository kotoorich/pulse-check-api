// =============================================================================
// monitorManager.js
//
// This is the BRAIN of the whole application. Everything else (the routes in
// app.js, the server bootstrap in server.js) is just plumbing around this
// file. If you only have time to deeply understand one file, make it this one.
//
// WHAT PROBLEM ARE WE SOLVING?
// ---------------------------------------------------------------------------
// Imagine a solar panel sitting in the middle of nowhere. It has no one
// watching it. How do you know if it's still working? The trick used in
// real-world monitoring systems is called a "Dead Man's Switch":
//
//   1. The device promises to "check in" (send a heartbeat) every N seconds.
//   2. We start a countdown timer for N seconds the moment it registers.
//   3. Every time a heartbeat arrives, we cancel the old timer and start a
//      fresh one (like resetting a kitchen timer).
//   4. If the countdown ever reaches ZERO without a heartbeat arriving in
//      time, we assume the device died (lost power, lost signal, etc.) and
//      we fire an alert.
//
// This is exactly how a real "dead man's switch" works on a train: the
// driver has to keep pressing a pedal. If they stop (because they fell
// asleep, or worse), the train automatically brakes.
//
// WHY "in-memory"?
// ---------------------------------------------------------------------------
// We're storing all monitors in a JavaScript Map() that lives in RAM, not in
// a database. That's fine for this project (and the brief allows it) but it
// has one big consequence you should be able to explain in an interview:
// if the server restarts, every monitor and its countdown is wiped out. In
// a "real" production system you'd back this with Redis or Postgres so the
// timers survive a crash/restart, and so you could run more than one copy of
// the server (horizontal scaling) sharing the same state.
// =============================================================================

import { EventEmitter } from "node:events";

/**
 * Status is just a fancy, safer way of writing string constants.
 *
 * Instead of typing the raw string "active" everywhere in the code (and
 * risking a typo like "activ" that JavaScript won't catch for you), we type
 * Status.ACTIVE. If you mistype Status.ACTIVEE, JavaScript throws an error
 * immediately instead of silently breaking your app at 2am.
 *
 * Object.freeze() locks the object so nobody can accidentally do
 * Status.ACTIVE = "oops" somewhere else in the codebase.
 *
 * The three possible states a monitor can be in:
 *   active  -> timer is running, we are waiting for the next heartbeat
 *   paused  -> the human has "snoozed" this monitor; timer is stopped
 *   down    -> the timer hit zero with no heartbeat; we fired an alert
 */
export const Status = Object.freeze({
  ACTIVE: "active",
  PAUSED: "paused",
  DOWN: "down",
});

/**
 * MonitorManager is a class that holds every monitor in memory and is in
 * charge of all the setTimeout() timers that make the "dead man's switch"
 * idea actually work.
 *
 * WHY DOES IT EXTEND EventEmitter?
 * EventEmitter is a built-in Node.js class that gives any object the
 * ability to "emit" (announce) named events, and let other code "listen"
 * for those events without the two pieces of code knowing about each other
 * directly. Think of it like a radio station (the manager) broadcasting on
 * a frequency ("alert", "recover") — anyone with a radio tuned to that
 * frequency can listen, but the station doesn't need to know who's
 * listening or how many people there are.
 *
 * We use this so that:
 *   - server.js can listen for "alert" and pretend to send an email/webhook
 *   - the test file can listen for "alert"/"recover" and assert they fired
 * ...without MonitorManager needing to import or know about email senders,
 * webhooks, or test frameworks. This is called "loose coupling" and it's a
 * core software design idea worth mentioning in an interview.
 */
export class MonitorManager extends EventEmitter {
  constructor() {
    // Always call super() first in a constructor that extends another
    // class — it runs EventEmitter's own constructor so `this.emit(...)`
    // and `this.on(...)` work correctly.
    super();

    // A Map is like a JavaScript object, but built specifically for
    // key -> value storage with no weird side effects (e.g. no inherited
    // properties like `toString` clashing with a monitor id). We key it by
    // the monitor's `id` (a string the client chooses, e.g. "device-123")
    // so lookups are instant: this.monitors.get("device-123").
    /** @type {Map<string, object>} */
    this.monitors = new Map();
  }

  /**
   * Create and start a brand-new monitor. This is what runs when a device
   * calls POST /monitors for the first time.
   *
   * @param {object} params
   * @param {string} params.id - unique name the device chooses for itself
   * @param {number} params.timeout - how many seconds before we consider
   *                                   the device "dead" if no heartbeat
   * @param {string} [params.alert_email] - optional email to "notify"
   * @returns the newly created monitor (safe to send back as JSON), or
   *          `null` if a monitor with this id already exists (we don't want
   *          to silently overwrite someone else's countdown).
   */
  register({ id, timeout, alert_email }) {
    // Guard clause: if it already exists, refuse and let the caller (app.js)
    // turn this into an HTTP 409 Conflict response.
    if (this.monitors.has(id)) return null;

    // This is the actual shape of data we keep for every monitor.
    // Note: this is the INTERNAL/private shape — it includes `_timer`,
    // the raw setTimeout handle, which we never want to send back to a
    // client over HTTP (you can't JSON.stringify a timer handle sensibly,
    // and it's an implementation detail, not data). See #publicView() below
    // for how we strip that out before handing data to the outside world.
    const monitor = {
      id,
      timeout, // seconds the device promised to check in within
      alert_email: alert_email ?? null, // ?? = "use this only if left/undefined"
      status: Status.ACTIVE,
      createdAt: Date.now(),       // raw timestamp (milliseconds since 1970)
      lastHeartbeat: Date.now(),   // when we last heard from the device
      expiresAt: Date.now() + timeout * 1000, // exact moment the timer dies
      missedDeadlines: 0, // Developer's Choice feature — explained below
      _timer: null,        // will hold the actual setTimeout() handle
    };

    this.monitors.set(id, monitor);

    // #arm starts the actual countdown clock for this monitor.
    this.#arm(monitor);

    // We return the "public" (safe-to-expose) version of the monitor, not
    // the raw internal object — see #publicView for why.
    return this.#publicView(monitor);
  }

  /**
   * A heartbeat says "I'm still alive!". This does THREE different jobs
   * depending on what state the monitor was in, which is part of what
   * makes this function interesting:
   *
   *   - If the monitor was ACTIVE: just reset the countdown (the normal,
   *     everyday case — this happens every few seconds/minutes forever).
   *   - If the monitor was PAUSED: un-pause it and restart the countdown.
   *   - If the monitor was DOWN: this means the device CAME BACK TO LIFE
   *     after we'd already declared it dead and fired an alert. We bring
   *     it back to ACTIVE and announce a "recover" event (our Developer's
   *     Choice feature, explained in the README and in the email below).
   *
   * @param {string} id
   * @returns the updated monitor, or `null` if no monitor has this id.
   */
  heartbeat(id) {
    const monitor = this.monitors.get(id);
    if (!monitor) return null; // app.js turns this into a 404

    // Remember whether it WAS down, before we change its status, so we can
    // decide afterwards whether this heartbeat counts as a "recovery".
    const wasDown = monitor.status === Status.DOWN;

    monitor.status = Status.ACTIVE;
    monitor.lastHeartbeat = Date.now();
    // This is the heart of the "dead man's switch": every heartbeat pushes
    // the expiry time further into the future by `timeout` seconds.
    monitor.expiresAt = Date.now() + monitor.timeout * 1000;

    // Cancel whatever old timer existed and start a brand new one.
    this.#arm(monitor);

    // Only announce a "recover" event if the device was actually down
    // before this heartbeat — we don't want to spam a "recovered!" event
    // on every single normal heartbeat.
    if (wasDown) this.emit("recover", this.#publicView(monitor));

    return this.#publicView(monitor);
  }

  /**
   * Pause ("snooze") a monitor. Useful for planned maintenance — e.g. "I
   * know I'm about to take this device offline on purpose for an hour,
   * please don't page anyone about it."
   *
   * While paused, the countdown timer is stopped completely (#disarm), so
   * it is IMPOSSIBLE for an alert to fire, no matter how long the pause
   * lasts. The very next heartbeat automatically un-pauses it (see
   * heartbeat() above).
   *
   * @param {string} id
   * @returns the updated monitor, or `null` if no monitor has this id.
   */
  pause(id) {
    const monitor = this.monitors.get(id);
    if (!monitor) return null;

    this.#disarm(monitor); // stop the clock entirely
    monitor.status = Status.PAUSED;
    monitor.expiresAt = null; // there's no "expiry" while paused
    return this.#publicView(monitor);
  }

  /** Look up a single monitor by id. Returns null if it doesn't exist. */
  get(id) {
    const monitor = this.monitors.get(id);
    return monitor ? this.#publicView(monitor) : null;
  }

  /**
   * Return every monitor we currently know about, in their "public" shape.
   * [...this.monitors.values()] turns the Map's values into a normal array
   * so we can use array methods like .map() on it.
   */
  list() {
    return [...this.monitors.values()].map((m) => this.#publicView(m));
  }

  /**
   * Permanently delete a monitor (e.g. a device is being decommissioned).
   * Importantly we #disarm it FIRST — if we deleted it from the Map but
   * forgot to cancel its setTimeout, the timer would still be sitting in
   * memory and could fire later, trying to operate on a monitor that no
   * longer exists. Always clean up timers/intervals when you're done with
   * them — this is one of the most common sources of memory leaks and
   * "ghost" bugs in Node.js apps.
   *
   * @returns {boolean} true if a monitor with this id existed and was removed.
   */
  remove(id) {
    const monitor = this.monitors.get(id);
    if (!monitor) return false;
    this.#disarm(monitor);
    return this.monitors.delete(id);
  }

  /**
   * Stop every single timer for every monitor. We call this when the whole
   * server is shutting down (see server.js's SIGINT/SIGTERM handlers) and
   * also at the end of every test, so that:
   *   (a) the Node process can exit cleanly instead of hanging forever
   *       waiting for timers to finish, and
   *   (b) tests don't leak timers into the NEXT test and cause flaky,
   *       hard-to-debug failures.
   */
  shutdown() {
    for (const monitor of this.monitors.values()) this.#disarm(monitor);
  }

  // ---------------------------------------------------------------------
  // PRIVATE METHODS
  // ---------------------------------------------------------------------
  // The `#` prefix is real, modern JavaScript syntax (not a comment trick)
  // for a TRUE private class method — it cannot be called or even seen
  // from outside this class (manager.#arm(...) from another file would be
  // a syntax error, not just "bad practice"). We use this for the internal
  // "wiring" that callers of this class should never need to touch
  // directly: arming/disarming timers and shaping data for output.
  // ---------------------------------------------------------------------

  /**
   * Start (or restart) the countdown timer for a monitor.
   *
   * setTimeout(fn, ms) schedules `fn` to run once, `ms` milliseconds from
   * now. We multiply seconds by 1000 because JavaScript's timer functions
   * always work in milliseconds.
   */
  #arm(monitor) {
    // Always disarm first! If we didn't, calling #arm twice on the same
    // monitor (e.g. two heartbeats in quick succession) would leave the
    // OLD timer still running in the background alongside the new one —
    // a classic timer-leak bug.
    this.#disarm(monitor);

    monitor._timer = setTimeout(() => this.#fire(monitor), monitor.timeout * 1000);

    // .unref() tells Node "don't count this timer as a reason to keep the
    // process alive". Without it, a Node process with a pending setTimeout
    // will refuse to exit even after server.close() — handy to know
    // because it's a very common "why won't my Node script quit?!" bug.
    if (typeof monitor._timer.unref === "function") monitor._timer.unref();
  }

  /** Cancel a monitor's timer, if one is currently running. */
  #disarm(monitor) {
    if (monitor._timer) {
      clearTimeout(monitor._timer);
      monitor._timer = null; // also clear the reference so we don't reuse a dead handle
    }
  }

  /**
   * This runs ONLY when a timer reaches zero with no heartbeat in time —
   * i.e. the device has gone silent and we're declaring it "down".
   *
   * This is a private method, deliberately: nothing outside this class
   * should ever be able to force-fire a monitor manually. The only way
   * this runs is the natural, real passage of time via setTimeout.
   */
  #fire(monitor) {
    monitor.status = Status.DOWN;
    // Developer's Choice feature: count how many times this monitor has
    // ever gone down. A monitor that's currently "active" but has
    // missedDeadlines: 7 tells a very different story than one with 0 —
    // it's "flapping" (repeatedly failing and recovering), which usually
    // means a flaky power supply or weak signal, not a one-off outage.
    monitor.missedDeadlines += 1;
    monitor._timer = null; // the timer has already fired, nothing to clear

    const alert = {
      ALERT: `Device ${monitor.id} is down!`,
      time: new Date().toISOString(),
    };

    // The brief's acceptance criterion is specifically "log this as JSON",
    // so we do exactly that.
    console.log(JSON.stringify(alert));

    // Broadcast the "alert" event so anyone listening (server.js, or a
    // test) can react — e.g. pretend to send an email — without this
    // class needing to know anything about emails or webhooks itself.
    this.emit("alert", { ...alert, monitor: this.#publicView(monitor) });
  }

  /**
   * Convert our INTERNAL monitor object into a safe-to-expose "public"
   * version for JSON responses / events.
   *
   * Two important jobs happen here:
   *   1. We strip out `_timer` (the raw setTimeout handle) using object
   *      destructuring with a "rest" pattern. `const { _timer, ...rest } =
   *      monitor` pulls `_timer` into its own variable (which we then
   *      simply ignore) and gathers every OTHER property into `rest`.
   *      This is a very common JavaScript idiom for "give me everything
   *      except X".
   *   2. We convert raw millisecond timestamps (numbers like
   *      1750252800000) into proper ISO date strings (like
   *      "2026-06-18T12:00:00.000Z") which are far more useful to a human
   *      reading the API response or a log file.
   *
   * We also calculate `secondsRemaining` on the fly, right at the moment
   * someone asks for it, rather than storing it — because "time remaining"
   * is constantly changing every millisecond; it only makes sense as a
   * live calculation (expiresAt - now), never as a stored value that would
   * instantly go stale.
   */
  #publicView(monitor) {
    const { _timer, ...rest } = monitor;
    return {
      ...rest,
      createdAt: new Date(monitor.createdAt).toISOString(),
      lastHeartbeat: new Date(monitor.lastHeartbeat).toISOString(),
      expiresAt: monitor.expiresAt ? new Date(monitor.expiresAt).toISOString() : null,
      secondsRemaining:
        monitor.status === Status.ACTIVE && monitor.expiresAt
          ? Math.max(0, Math.round((monitor.expiresAt - Date.now()) / 1000))
          : null,
    };
  }
}
