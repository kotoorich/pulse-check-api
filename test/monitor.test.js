// =============================================================================
// monitor.test.js
//
// This is our automated test suite, using Node.js's BUILT-IN test runner
// (node:test) — no extra libraries like Jest or Mocha needed, which is why
// package.json has zero dependencies beyond Express.
//
// HOW TO RUN THESE: `npm test` (which runs `node --test` under the hood).
//
// WHAT IS A "TEST" IN PLAIN ENGLISH?
// Every `test("description", () => { ... })` block below is a small,
// completely independent program that:
//   1. Sets up a fresh, clean scenario (almost always: `new MonitorManager()`)
//   2. Performs an action (e.g. register a monitor, send a heartbeat)
//   3. Asserts ("checks") that the result is what we expect, using
//      Node's built-in assert library. If an assertion is false, the test
//      fails LOUDLY and tells you exactly which line and what was expected
//      vs what actually happened.
//
// WHY BOTHER WITH AUTOMATED TESTS AT ALL?
// Without these, every time you changed monitorManager.js you'd have to
// manually start the server, use curl or Postman to hit every endpoint in
// every possible state, and eyeball the JSON output to check it's correct
// — for EVERY change, forever. These 8 tests do that in under a second,
// every single time, and they will scream at you immediately if a future
// change accidentally breaks old behaviour (this is called a "regression").
// =============================================================================

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { MonitorManager, Status } from "../src/monitorManager.js";

/**
 * A tiny helper that returns a Promise which resolves after `ms`
 * milliseconds. We need this because our tests need to ACTUALLY wait for
 * real time to pass in order to test a real setTimeout-based timer — there's
 * no way to "fast forward" time without faking the clock entirely (which is
 * possible with extra tooling, but overkill for a project this size).
 *
 * `await sleep(200)` inside a test pauses that test for 200 real
 * milliseconds before continuing to the next line.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// US1 = "User Story 1" — registering a new monitor.
// ---------------------------------------------------------------------------

test("US1: register creates an active monitor", () => {
  // Always create a BRAND NEW MonitorManager inside each test, never share
  // one between tests. If tests shared state, the order they happen to run
  // in could change the outcome — a classic source of "flaky" tests that
  // sometimes pass and sometimes fail for no obvious reason.
  const m = new MonitorManager();

  const mon = m.register({ id: "d1", timeout: 60, alert_email: "a@b.com" });

  // assert.equal(actual, expected) — if these aren't equal, the test fails
  // and prints both values so you can see exactly what went wrong.
  assert.equal(mon.id, "d1");
  assert.equal(mon.status, Status.ACTIVE);

  // Always clean up timers at the end of a test that registers monitors —
  // otherwise this test's 60-second timer keeps running in the background
  // even after the test itself has finished, which can cause Node to hang
  // when you try to exit, or interfere with later tests.
  m.shutdown();
});

test("US1: duplicate id is rejected", () => {
  const m = new MonitorManager();
  m.register({ id: "d1", timeout: 60 });

  // Registering the SAME id a second time should return null (see the
  // guard clause at the top of register() in monitorManager.js) — this is
  // what app.js turns into an HTTP 409 Conflict response.
  assert.equal(m.register({ id: "d1", timeout: 60 }), null);
  m.shutdown();
});

// ---------------------------------------------------------------------------
// US2 = "User Story 2" — heartbeats.
// ---------------------------------------------------------------------------

test("US2: heartbeat on missing id returns null (404 upstream)", () => {
  const m = new MonitorManager();
  // We never registered "nope", so this should safely return null rather
  // than crashing — this is what lets app.js respond with a clean 404
  // instead of a confusing server error.
  assert.equal(m.heartbeat("nope"), null);
  m.shutdown();
});

// ---------------------------------------------------------------------------
// US3 = "User Story 3" — the actual "dead man's switch" firing.
// ---------------------------------------------------------------------------

test("US3: monitor fires an alert when the timer expires", async () => {
  // Note this test function is `async` — it contains an `await` below, so
  // it needs to be marked async for that to be allowed.
  const m = new MonitorManager();

  let fired = null;
  // We subscribe to the "alert" event BEFORE registering the monitor, so
  // we're guaranteed not to miss it.
  m.on("alert", (a) => (fired = a));

  // A very short timeout (0.1 seconds = 100ms) so the test doesn't have to
  // wait around for ages — we're not testing whether 60 real seconds can
  // pass, just that the SAME mechanism works, regardless of the actual
  // number used.
  m.register({ id: "d1", timeout: 0.1 });

  // Wait LONGER than the timeout (200ms > 100ms) to give the alert time to
  // actually fire before we check the result.
  await sleep(200);

  assert.ok(fired, "alert should have fired"); // assert.ok = "this should be truthy"
  assert.equal(m.get("d1").status, Status.DOWN);
  m.shutdown();
});

test("US2: heartbeat resets the timer and prevents the alert", async () => {
  const m = new MonitorManager();
  let fired = false;
  m.on("alert", () => (fired = true));

  m.register({ id: "d1", timeout: 0.2 }); // 200ms countdown
  await sleep(100); // wait until we're halfway through the countdown
  m.heartbeat("d1"); // ...then reset it before it expires
  await sleep(150); // wait again — if the reset DIDN'T work, this would
                     // be enough extra time for the ORIGINAL timer to have
                     // fired by now

  assert.equal(fired, false, "alert should not fire if heartbeat keeps coming");
  assert.equal(m.get("d1").status, Status.ACTIVE);
  m.shutdown();
});

// ---------------------------------------------------------------------------
// Bonus User Story — pause / snooze.
// ---------------------------------------------------------------------------

test("Bonus: pause stops the timer; no alert fires", async () => {
  const m = new MonitorManager();
  let fired = false;
  m.on("alert", () => (fired = true));

  m.register({ id: "d1", timeout: 0.1 });
  m.pause("d1"); // immediately pause before the 100ms is even up
  await sleep(200); // wait well past when it WOULD have expired

  assert.equal(fired, false); // pausing should have prevented the alert entirely
  assert.equal(m.get("d1").status, Status.PAUSED);
  m.shutdown();
});

test("Bonus: heartbeat un-pauses and restarts the timer", async () => {
  const m = new MonitorManager();
  m.register({ id: "d1", timeout: 5 });
  m.pause("d1");
  assert.equal(m.get("d1").status, Status.PAUSED);

  const back = m.heartbeat("d1"); // a heartbeat should bring it back to life
  assert.equal(back.status, Status.ACTIVE);
  m.shutdown();
});

// ---------------------------------------------------------------------------
// Developer's Choice — auto-recovery after a device comes back from "down".
// ---------------------------------------------------------------------------

test("Dev choice: a down monitor recovers on next heartbeat", async () => {
  const m = new MonitorManager();
  let recovered = false;
  m.on("recover", () => (recovered = true));

  m.register({ id: "d1", timeout: 0.1 });
  await sleep(200); // let it expire and become "down"
  assert.equal(m.get("d1").status, Status.DOWN);

  m.heartbeat("d1"); // the device wakes back up and checks in again

  assert.equal(m.get("d1").status, Status.ACTIVE);
  assert.equal(recovered, true); // and we should have heard the "recover" event
  m.shutdown();
});
