import { test, after } from "node:test";
import assert from "node:assert/strict";
import { MonitorManager, Status } from "../src/monitorManager.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("US1: register creates an active monitor", () => {
  const m = new MonitorManager();
  const mon = m.register({ id: "d1", timeout: 60, alert_email: "a@b.com" });
  assert.equal(mon.id, "d1");
  assert.equal(mon.status, Status.ACTIVE);
  m.shutdown();
});

test("US1: duplicate id is rejected", () => {
  const m = new MonitorManager();
  m.register({ id: "d1", timeout: 60 });
  assert.equal(m.register({ id: "d1", timeout: 60 }), null);
  m.shutdown();
});

test("US2: heartbeat on missing id returns null (404 upstream)", () => {
  const m = new MonitorManager();
  assert.equal(m.heartbeat("nope"), null);
  m.shutdown();
});

test("US3: monitor fires an alert when the timer expires", async () => {
  const m = new MonitorManager();
  let fired = null;
  m.on("alert", (a) => (fired = a));
  m.register({ id: "d1", timeout: 0.1 });
  await sleep(200);
  assert.ok(fired, "alert should have fired");
  assert.equal(m.get("d1").status, Status.DOWN);
  m.shutdown();
});

test("US2: heartbeat resets the timer and prevents the alert", async () => {
  const m = new MonitorManager();
  let fired = false;
  m.on("alert", () => (fired = true));
  m.register({ id: "d1", timeout: 0.2 });
  await sleep(100);
  m.heartbeat("d1"); // reset before expiry
  await sleep(150);
  assert.equal(fired, false, "alert should not fire if heartbeat keeps coming");
  assert.equal(m.get("d1").status, Status.ACTIVE);
  m.shutdown();
});

test("Bonus: pause stops the timer; no alert fires", async () => {
  const m = new MonitorManager();
  let fired = false;
  m.on("alert", () => (fired = true));
  m.register({ id: "d1", timeout: 0.1 });
  m.pause("d1");
  await sleep(200);
  assert.equal(fired, false);
  assert.equal(m.get("d1").status, Status.PAUSED);
  m.shutdown();
});

test("Bonus: heartbeat un-pauses and restarts the timer", async () => {
  const m = new MonitorManager();
  m.register({ id: "d1", timeout: 5 });
  m.pause("d1");
  assert.equal(m.get("d1").status, Status.PAUSED);
  const back = m.heartbeat("d1");
  assert.equal(back.status, Status.ACTIVE);
  m.shutdown();
});

test("Dev choice: a down monitor recovers on next heartbeat", async () => {
  const m = new MonitorManager();
  let recovered = false;
  m.on("recover", () => (recovered = true));
  m.register({ id: "d1", timeout: 0.1 });
  await sleep(200);
  assert.equal(m.get("d1").status, Status.DOWN);
  m.heartbeat("d1");
  assert.equal(m.get("d1").status, Status.ACTIVE);
  assert.equal(recovered, true);
  m.shutdown();
});
