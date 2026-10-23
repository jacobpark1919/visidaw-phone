const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function page(filename) {
  const elements = new Map();
  const peers = [];
  const requests = [];
  const events = [];
  let signal = {};
  let onFetch = null;
  class Peer {
    constructor() { peers.push(this); this.candidates = []; this.iceConnectionState = "new"; }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    async createAnswer() { return { type: "answer", sdp: `answer-${peers.indexOf(this)}` }; }
    async createOffer() { return { type: "offer", sdp: `offer-${peers.indexOf(this)}` }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async addIceCandidate(candidate) {
      assert.ok(this.remoteDescription, "remote description must precede ICE candidates");
      this.candidates.push(candidate);
    }
    close() { this.closed = true; }
    addTrack(track) { return { track, async replaceTrack() {} }; }
  }
  const track = { kind: "video", readyState: "live" };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const window = {
    location: { search: "?s=reusable-qr" },
    crypto: { randomUUID: () => `phone-${peers.length}` },
    cancelAnimationFrame() {},
    __JUCE__: { backend: { emitEvent: (_name, payload) => events.push(payload) } }
  };
  const context = vm.createContext({
    window, URLSearchParams, RTCPeerConnection: Peer,
    MediaStream: class {}, performance: { now: () => 1000 },
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    setInterval: () => 1, setTimeout: () => 1, clearTimeout() {},
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    } },
    fetch: async (_url, options = {}) => {
      const payload = options.body ? JSON.parse(options.body) : null;
      requests.push(payload);
      const response = onFetch ? await onFetch(payload) : null;
      return response || { ok: true, json: async () => payload ? { ok: true } : structuredClone(signal) };
    }
  });
  const html = fs.readFileSync(path.join(__dirname, "..", filename), "utf8");
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], context);
  return { context, peers, requests, elements, events,
    setSignal(value) { signal = value; },
    interceptFetch(callback) { onFetch = callback; },
    run(code) { return vm.runInContext(code, context); },
    start() { return elements.get("start").onclick(); },
    poll() { return vm.runInContext(filename === "desktop.html" ? "pollPhoneOffer()" : "pollDesktopAnswer()", context); }
  };
}

function offer(id) {
  return { offerId: id, offer: { type: "offer", sdp: `offer-${id}` },
    phoneCandidates: [{ candidate: `ice-${id}` }] };
}

test("rescanning the same QR replaces the receiver peer repeatedly and clears the frozen frame", async () => {
  const receiver = page("desktop.html");
  await receiver.start();
  assert.equal(receiver.peers.length, 0);
  let oldPeer;
  let staleTrackEvent;
  let staleEnd;
  for (const id of ["first", "second", "third"]) {
    receiver.setSignal(offer(id));
    await receiver.poll();
    const peer = receiver.peers.at(-1);
    if (oldPeer) assert.equal(oldPeer.closed, true);
    const remote = receiver.elements.get("remote");
    assert.equal(remote.srcObject, null);
    const stream = { id };
    const track = {};
    peer.ontrack({ streams: [stream], track });
    peer.iceConnectionState = "connected";
    peer.oniceconnectionstatechange();
    assert.equal(remote.srcObject, stream);
    if (staleTrackEvent) {
      staleTrackEvent({ streams: [{}], track: {} });
      staleEnd();
      assert.equal(remote.srcObject, stream, "callbacks from retired peers cannot clear the new feed");
    }
    staleTrackEvent = peer.ontrack;
    staleEnd = track.onended;
    const peerCount = receiver.peers.length;
    await receiver.poll();
    assert.equal(receiver.peers.length, peerCount, "same offer is answered only once");
    assert.equal(peer.candidates.length, 1);
    peer.iceConnectionState = "disconnected";
    peer.oniceconnectionstatechange();
    assert.equal(remote.srcObject, null);
    assert.match(receiver.elements.get("status").textContent, /Scan the same QR/);
    oldPeer = peer;
  }
  assert.deepEqual(receiver.requests.filter((request) => request?.type === "answer").map((request) => request.offerId),
    ["first", "second", "third"]);
});

test("receiver serializes slow polling and negotiation, then picks up the latest offer", async () => {
  const receiver = page("desktop.html");
  receiver.setSignal(offer("old"));
  const pendingAnswer = deferred();
  const answerStarted = deferred();
  receiver.interceptFetch(async (payload) => {
    if (payload?.type === "answer" && payload.offerId === "old") {
      answerStarted.resolve();
      await pendingAnswer.promise;
    }
  });
  const start = receiver.start();
  await answerStarted.promise;
  receiver.setSignal(offer("new"));
  await Promise.all([receiver.poll(), receiver.poll()]);
  assert.equal(receiver.requests.filter((request) => request === null).length, 1);
  pendingAnswer.resolve();
  await start;
  await receiver.poll();
  assert.equal(receiver.peers.length, 2);
  assert.equal(receiver.peers[1].remoteDescription.sdp, "offer-new");
});

test("failed answer publication retries without refreshing the receiver", async () => {
  const receiver = page("desktop.html");
  receiver.setSignal(offer("retry"));
  receiver.interceptFetch((payload) => payload?.type === "answer" ? { ok: false, status: 503 } : null);
  await receiver.start();
  assert.equal(receiver.peers[0].closed, true);
  receiver.interceptFetch(null);
  await receiver.poll();
  assert.equal(receiver.peers.length, 2);
  assert.equal(receiver.peers[1].candidates.length, 1);
});

test("receiver supports rescanning from older phone pages without offer IDs", async () => {
  const receiver = page("desktop.html");
  await receiver.start();
  for (const id of ["old-page-1", "old-page-2"]) {
    const state = offer(id);
    delete state.offerId;
    receiver.setSignal(state);
    await receiver.poll();
  }
  assert.equal(receiver.peers.length, 2);
  assert.equal(receiver.peers[0].closed, true);
});

test("phone ignores old answers and ICE, and waits for its own answer before applying candidates", async () => {
  const phone = page("index.html");
  await phone.start();
  const id = phone.requests.find((request) => request?.type === "offer").offerId;
  const answer = { type: "answer", sdp: "answer" };
  phone.setSignal({ offerId: "old-phone", answer, desktopCandidates: [{ candidate: "old" }] });
  await phone.poll();
  assert.equal(phone.peers[0].remoteDescription, undefined);
  phone.setSignal({ offerId: id, desktopCandidates: [{ candidate: "current" }] });
  await phone.poll();
  assert.equal(phone.peers[0].candidates.length, 0);
  phone.setSignal({ offerId: id, answer, desktopCandidates: [{ candidate: "current" }] });
  await phone.poll();
  assert.equal(phone.peers[0].remoteDescription.sdp, "answer");
  assert.equal(phone.peers[0].candidates.length, 1);
  await phone.poll();
  assert.equal(phone.peers[0].candidates.length, 1);
});

test("ICE writes from each peer are serialized and carry the negotiation ID", async () => {
  for (const filename of ["desktop.html", "index.html"]) {
    const client = page(filename);
    client.setSignal(offer("receiver-test"));
    await client.start();
    const firstWrite = deferred();
    const started = deferred();
    let count = 0;
    client.interceptFetch(async (payload) => {
      if (payload?.type === "candidate" && ++count === 1) {
        started.resolve();
        await firstWrite.promise;
      }
    });
    const peer = client.peers[0];
    peer.onicecandidate({ candidate: { candidate: "one" } });
    peer.onicecandidate({ candidate: { candidate: "two" } });
    await started.promise;
    assert.equal(count, 1);
    firstWrite.resolve();
    await client.run(filename === "desktop.html" ? "connection.writes" : "candidateWrites");
    assert.equal(count, 2);
    const writes = client.requests.filter((request) => request?.type === "candidate");
    assert.ok(writes.every((request) => request.offerId === writes[0].offerId && request.offerId));
  }
});

test("replacing a phone finalizes the old recorder before accepting the new stream", async () => {
  const receiver = page("desktop.html");
  receiver.setSignal(offer("recording"));
  await receiver.start();
  let stopped = 0;
  receiver.context.oldRecorder = { state: "recording", stop() { stopped++; this.state = "inactive"; } };
  receiver.run("mediaRecorder = oldRecorder");
  receiver.setSignal(offer("replacement"));
  await receiver.poll();
  assert.equal(stopped, 1);
  assert.equal(receiver.run("mediaRecorder === oldRecorder"), true, "retain pending chunk/finalization ownership");
  assert.equal(receiver.elements.get("remote").srcObject, null);
});
