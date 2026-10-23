const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createDevServer, createMemoryKv } = require("../dev-server.js");

test("local pages and signaling support a complete pairing exchange without Redis", async (t) => {
  const server = createDevServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${origin}/api/signal?s=local-test`;
  const post = (body) => fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  for (const pathname of ["/", "/desktop.html", "/recorder-protocol.js"]) {
    const response = await fetch(origin + pathname);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 0);
  }
  assert.equal((await fetch(origin + "/package.json")).status, 404);
  const offer = { type: "offer", sdp: "test-offer" };
  const answer = { type: "answer", sdp: "test-answer" };
  assert.equal((await post({ type: "offer", description: offer })).status, 200);
  assert.equal((await post({ type: "answer", description: answer })).status, 200);
  for (const role of ["phone", "desktop"]) {
    assert.equal((await post({ type: "candidate", role, candidate: { candidate: role } })).status, 200);
  }
  const state = await (await fetch(endpoint)).json();
  assert.deepEqual(state.offer, offer);
  assert.deepEqual(state.answer, answer);
  assert.deepEqual(state.phoneCandidates, [{ candidate: "phone" }]);
  assert.deepEqual(state.desktopCandidates, [{ candidate: "desktop" }]);
  assert.equal((await (await fetch(`${origin}/api/signal?s=other`)).json()).offer, null);
  assert.equal((await post({ type: "unknown" })).status, 400);
  assert.equal((await post({ type: "clear" })).status, 200);
  assert.equal((await (await fetch(endpoint)).json()).offer, null);
});

test("local signaling storage expires sessions and isolates stored objects", async () => {
  const kv = createMemoryKv();
  const state = { candidates: [] };
  await kv.set("session", state, { ex: 600 });
  state.candidates.push("not stored");
  const copy = await kv.get("session");
  assert.deepEqual(copy, { candidates: [] });
  copy.candidates.push("also not stored");
  assert.deepEqual(await kv.get("session"), { candidates: [] });
  await kv.set("expired", state, { ex: -1 });
  assert.equal(await kv.get("expired"), null);
});

test("one QR session survives new phone pages and delayed writes cannot restore the old connection", async (t) => {
  const kv = createMemoryKv();
  const originalSet = kv.set.bind(kv);
  let releaseAnswer;
  let answerStarted;
  const started = new Promise((resolve) => { answerStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseAnswer = resolve; });
  kv.set = async (key, value, options) => {
    if (key.endsWith(":first:answer")) {
      answerStarted();
      await blocked;
    }
    return originalSet(key, value, options);
  };
  const server = createDevServer(kv);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/signal?s=same-qr`;
  const post = (body) => fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const offer = (offerId) => post({ type: "offer", offerId,
    description: { type: "offer", sdp: `sdp-${offerId}` } });
  assert.equal((await offer("first")).status, 200);
  const delayedAnswer = post({ type: "answer", offerId: "first", description: { sdp: "stale" } });
  await started;
  assert.equal((await offer("second")).status, 200);
  await post({ type: "answer", offerId: "second", description: { sdp: "current" } });
  await Promise.all(["phone", "desktop"].map((role) => post({
    type: "candidate", role, offerId: "second", candidate: { candidate: role }
  })));
  releaseAnswer();
  await delayedAnswer;
  assert.equal((await post({ type: "candidate", role: "phone", offerId: "first",
    candidate: { candidate: "stale" } })).status, 409);
  const state = await (await fetch(endpoint)).json();
  assert.equal(state.offerId, "second");
  assert.equal(state.offer.sdp, "sdp-second");
  assert.equal(state.answer.sdp, "current");
  assert.deepEqual(state.phoneCandidates, [{ candidate: "phone" }]);
  assert.deepEqual(state.desktopCandidates, [{ candidate: "desktop" }]);

  // A long pause may expire the temporary signaling entry, not the QR URL.
  await kv.del("floof:webrtc:same-qr");
  assert.equal((await offer("third")).status, 200);
  const fresh = await (await fetch(endpoint)).json();
  assert.equal(fresh.offerId, "third");
  assert.equal(fresh.answer, null);
  assert.deepEqual(fresh.phoneCandidates, []);
  assert.deepEqual(fresh.desktopCandidates, []);
});
