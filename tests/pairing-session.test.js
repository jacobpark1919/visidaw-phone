const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Readable } = require("node:stream");
const { createHandler } = require("../api/signal.js");
const frameHandler = require("../api/frame.js");

const invalidSessions = [undefined, "", "manual", "bad/session", "a".repeat(65)];

function page(filename, search) {
  const elements = new Map();
  let activity = 0;
  const unexpectedActivity = () => { activity++; throw new Error("Unpaired page started activity"); };
  const context = vm.createContext({
    URLSearchParams,
    window: { location: { search }, addEventListener: unexpectedActivity },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    } },
    navigator: { mediaDevices: { getUserMedia: unexpectedActivity } },
    fetch: unexpectedActivity,
    RTCPeerConnection: unexpectedActivity,
    setInterval: unexpectedActivity,
    setTimeout: unexpectedActivity
  });
  const html = fs.readFileSync(path.join(__dirname, "..", filename), "utf8");
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(script[1], context);
  }
  return { elements, context, activity: () => activity };
}

for (const filename of ["index.html", "desktop.html"]) {
  test(`${filename} refuses unpaired startup, including receiver autostart`, async () => {
    for (const session of invalidSessions) {
      const search = "?auto=1" + (session === undefined ? "" : "&s=" + encodeURIComponent(session));
      const fixture = page(filename, search);
      const start = fixture.elements.get("start");
      assert.equal(start.disabled, true);
      assert.match(fixture.elements.get("status").textContent, /VisiDAW/);
      // The guard must survive direct handler calls or DOM changes, too.
      start.disabled = false;
      await start.onclick();
      assert.equal(fixture.activity(), 0);
    }
  });

  test(`${filename} preserves both explicit pairing URL forms`, () => {
    for (const parameter of ["s", "session"]) {
      const fixture = page(filename, `?${parameter}=ABCD2345`);
      assert.notEqual(fixture.elements.get("start").disabled, true);
      assert.equal(vm.runInContext("session", fixture.context), "ABCD2345");
      assert.equal(vm.runInContext("hasPairingSession", fixture.context), true);
    }
  });
}

async function request(handler, method, query, body = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.query = query;
  const res = {
    setHeader() {},
    status(code) { this.code = code; return this; },
    json(value) { this.body = value; },
    end() {}
  };
  await handler(req, res);
  return res;
}

test("signaling rejects missing, shared, malformed and non-string sessions before storage", async () => {
  let storeCalls = 0;
  const handler = createHandler(async () => { storeCalls++; throw new Error("Unexpected storage"); });
  for (const session of [...invalidSessions, ["ABCD2345"], 12345]) {
    for (const method of ["GET", "POST"]) {
      const res = await request(handler, method, session === undefined ? {} : { session });
      assert.equal(res.code, 400);
    }
    assert.equal((await request(handler, "POST", {}, { session })).code, 400);
  }
  assert.equal(storeCalls, 0);
});

test("signaling preserves explicit body sessions and never normalizes invalid URLs into another room", async () => {
  const keys = [];
  const handler = createHandler(async () => ({ get: async (key) => { keys.push(key); return null; } }));
  assert.equal((await request(handler, "GET", { s: "ABCD2345" })).code, 200);
  assert.deepEqual(keys, ["floof:webrtc:ABCD2345"]);
  assert.equal((await request(handler, "POST", { session: "bad/session" }, { session: "ABCD2345" })).code, 400);
  assert.equal(keys.length, 1);
  const bodyHandler = createHandler(async () => ({
    get: async () => null,
    set: async (key) => { keys.push(key); }
  }));
  assert.equal((await request(bodyHandler, "POST", {}, {
    session: "ABCD2345", type: "offer", description: { type: "offer", sdp: "test" }
  })).code, 200);
  assert.equal(keys.at(-1), "floof:webrtc:ABCD2345");
});

test("legacy frame and debug routes also reject unpaired requests before accessing KV", async () => {
  for (const session of invalidSessions) {
    for (const method of ["GET", "HEAD", "POST"]) {
      const res = await request(frameHandler, method, { session, debug: "1" });
      assert.equal(res.code, 400);
    }
  }
});
