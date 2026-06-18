import { EventEmitter } from "node:events";

/**
 * Monitor status lifecycle:
 *   active  -> timer running, waiting for next heartbeat
 *   paused  -> timer stopped, no alerts will fire (snooze)
 *   down    -> timer expired, alert was fired
 */
export const Status = Object.freeze({
  ACTIVE: "active",
  PAUSED: "paused",
  DOWN: "down",
});

/**
 * MonitorManager holds all monitors in memory and owns the timer logic.
 * It extends EventEmitter so other parts of the system (webhooks, loggers,
 * the test suite) can react to "alert" events without tight coupling.
 */
export class MonitorManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} */
    this.monitors = new Map();
  }

  /**
   * Create and start a new monitor.
   * @returns the created monitor, or null if the id already exists.
   */
  register({ id, timeout, alert_email }) {
    if (this.monitors.has(id)) return null;

    const monitor = {
      id,
      timeout, // seconds
      alert_email: alert_email ?? null,
      status: Status.ACTIVE,
      createdAt: Date.now(),
      lastHeartbeat: Date.now(),
      expiresAt: Date.now() + timeout * 1000,
      missedDeadlines: 0, // Developer's Choice: track flaps/recoveries
      _timer: null,
    };

    this.monitors.set(id, monitor);
    this.#arm(monitor);
    return this.#publicView(monitor);
  }

  /**
   * Reset the countdown for a monitor. Also un-pauses a paused monitor
   * and revives one that was already "down" (a recovered device).
   * @returns the updated monitor, or null if not found.
   */
  heartbeat(id) {
    const monitor = this.monitors.get(id);
    if (!monitor) return null;

    const wasDown = monitor.status === Status.DOWN;
    monitor.status = Status.ACTIVE;
    monitor.lastHeartbeat = Date.now();
    monitor.expiresAt = Date.now() + monitor.timeout * 1000;
    this.#arm(monitor);

    if (wasDown) this.emit("recover", this.#publicView(monitor));
    return this.#publicView(monitor);
  }

  /**
   * Pause a monitor (snooze). Timer stops; no alert can fire.
   * @returns the updated monitor, or null if not found.
   */
  pause(id) {
    const monitor = this.monitors.get(id);
    if (!monitor) return null;

    this.#disarm(monitor);
    monitor.status = Status.PAUSED;
    monitor.expiresAt = null;
    return this.#publicView(monitor);
  }

  /** Read a single monitor's public view, or null if not found. */
  get(id) {
    const monitor = this.monitors.get(id);
    return monitor ? this.#publicView(monitor) : null;
  }

  /** List all monitors (public view). */
  list() {
    return [...this.monitors.values()].map((m) => this.#publicView(m));
  }

  /** Remove a monitor entirely. @returns true if it existed. */
  remove(id) {
    const monitor = this.monitors.get(id);
    if (!monitor) return false;
    this.#disarm(monitor);
    return this.monitors.delete(id);
  }

  /** Clear all timers — important so the process can exit cleanly / tests stop. */
  shutdown() {
    for (const monitor of this.monitors.values()) this.#disarm(monitor);
  }

  // --- internals ---

  #arm(monitor) {
    this.#disarm(monitor);
    monitor._timer = setTimeout(() => this.#fire(monitor), monitor.timeout * 1000);
    // Don't let a pending timer keep the event loop (process) alive forever.
    if (typeof monitor._timer.unref === "function") monitor._timer.unref();
  }

  #disarm(monitor) {
    if (monitor._timer) {
      clearTimeout(monitor._timer);
      monitor._timer = null;
    }
  }

  #fire(monitor) {
    monitor.status = Status.DOWN;
    monitor.missedDeadlines += 1;
    monitor._timer = null;

    const alert = {
      ALERT: `Device ${monitor.id} is down!`,
      time: new Date().toISOString(),
    };
    // Acceptance criterion: log the alert JSON.
    console.log(JSON.stringify(alert));
    // Allow webhook/email handlers to subscribe.
    this.emit("alert", { ...alert, monitor: this.#publicView(monitor) });
  }

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
