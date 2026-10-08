const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const protocol = require("../recorder-protocol.js");

const receiver = fs.readFileSync(path.join(__dirname, "..", "desktop.html"), "utf8");

test("VisiDAW browser bridge exports recording controls and delivers native events", () => {
  const emitted = [];
  const elements = new Map();
  const window = {
    location: { search: "?s=bridge-test" },
    __JUCE__: { backend: { emitEvent: (name, payload) => emitted.push({ name, payload }) } },
  };
  const context = vm.createContext({
    window,
    URLSearchParams,
    MediaStream: class MediaStream {},
    performance: { now: () => 1000 },
    document: { getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "recorder-protocol.js"), "utf8"), context);
  for (const script of receiver.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(script[1], context);
  }

  assert.equal(typeof window.VisiDAWRecorderProtocol.calculateDuration, "function");
  assert.equal(window.visidawRecorderProtocolVersion, 2);
  window.visidawStartWebRtcRecording(42);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].name, "visidawWebRtcVideo");
  assert.equal(emitted[0].payload.type, "error");
  assert.equal(emitted[0].payload.takeId, 42);
  assert.match(emitted[0].payload.message, /No WebRTC stream/);
  window.visidawStopWebRtcRecording();
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].name, "visidawWebRtcVideo");
  assert.equal(emitted[1].payload.type, "stopped");
  assert.equal(emitted[1].payload.chunkCount, 0);
});

test("recording delivers chunks and finalization to the native VisiDAW take", () => {
  const emitted = [];
  const pendingReads = [];
  let now = 1000;
  let recorder;
  class MediaStream {
    getVideoTracks() { return [{ readyState: "live" }]; }
  }
  class MediaRecorder {
    static isTypeSupported() { return true; }
    constructor() { recorder = this; this.state = "inactive"; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.onstop(); }
  }
  class FileReader {
    readAsDataURL(data) {
      pendingReads.push(() => {
        this.result = "data:video/webm;base64," + data.base64;
        this.onload();
      });
    }
  }
  const elements = new Map([["remote", { srcObject: new MediaStream() }]]);
  const window = {
    location: { search: "?s=recording-test" },
    MediaRecorder,
    __JUCE__: { backend: { emitEvent: (name, payload) => emitted.push({ name, payload }) } },
  };
  const context = vm.createContext({
    window, MediaStream, MediaRecorder, FileReader, URLSearchParams,
    performance: { now: () => now },
    setTimeout: () => 1,
    clearTimeout: () => {},
    document: { getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "recorder-protocol.js"), "utf8"), context);
  for (const script of receiver.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(script[1], context);
  }

  window.visidawStartWebRtcRecording(42);
  assert.ok(emitted.some(({ payload }) => payload.type === "started"));
  recorder.ondataavailable({ data: { size: 3, base64: "YWJj" } });
  recorder.ondataavailable({ data: { size: 2, base64: "ZGU=" } });
  now = 2250;
  window.visidawStopWebRtcRecording();
  assert.ok(!emitted.some(({ payload }) => payload.type === "stopped"));
  pendingReads[1]();
  assert.ok(!emitted.some(({ payload }) => payload.type === "stopped"));
  pendingReads[0]();

  assert.ok(emitted.every(({ name, payload }) =>
    name === "visidawWebRtcVideo" && payload.takeId === 42 && payload.type !== "error"));
  const chunks = emitted.filter(({ payload }) => payload.type === "chunk");
  assert.deepEqual(chunks.map(({ payload }) => [payload.sequence, payload.data]), [[1, "ZGU="], [0, "YWJj"]]);
  const stopped = emitted.at(-1).payload;
  assert.equal(stopped.type, "stopped");
  assert.equal(stopped.chunkCount, 2);
  assert.equal(stopped.bytes, 5);
  assert.equal(stopped.sourceDurationSeconds, 1.25);
});

test("FileReader completion order cannot change assigned chunk order", async () => {
  let nextSequence = 0;
  const emitted = [];
  const read = (delay) => {
    const sequence = nextSequence++;
    return new Promise((resolve) => setTimeout(() => {
      emitted.push(sequence);
      resolve();
    }, delay));
  };
  await Promise.all([read(20), read(0), read(10)]);
  assert.deepEqual(emitted, [1, 2, 0]);
  assert.deepEqual([...emitted].sort((a, b) => a - b), [0, 1, 2]);
  assert.match(receiver, /const sequence = nextRecorderChunkSequence\+\+;[\s\S]*new FileReader\(\)/);
});

test("stopped waits for MediaRecorder stop and every asynchronous chunk read", () => {
  assert.match(receiver, /if \(!recorderStopRequested \|\| pendingChunkReads > 0\)/);
  assert.match(receiver, /mediaRecorder\.onstop = \(\) => \{[\s\S]*maybeEmitRecorderStopped\(\)/);
  assert.doesNotMatch(receiver, /recorderStopGraceTimer|requestData\(\)/);
  assert.match(receiver, /chunkCount: nextRecorderChunkSequence/);
});

test("duration uses the median frame interval and capture boundaries are monotonic", () => {
  const timing = protocol.calculateDuration(10, 10.1, [0.05, 0.033, 0.04], 99);
  assert.equal(timing.finalFrameIntervalSeconds, 0.04);
  assert.ok(Math.abs(timing.sourceDurationSeconds - 0.14) < 1e-9);
  assert.equal(protocol.captureBoundaryReached(999, 1000), false);
  assert.equal(protocol.captureBoundaryReached(1000, 1000), true);
  assert.equal(protocol.captureBoundaryReached(1001, 1000), true);
  assert.match(receiver, /captureBoundaryHardTimer = setTimeout[\s\S]*2000/);
});

test("receiver advertises protocol 2 and reports integrity metadata", () => {
  assert.match(receiver, /visidawRecorderProtocolVersion = 2/);
  assert.match(receiver, /sourceDurationSeconds/);
  assert.match(receiver, /finalFrameIntervalSeconds/);
  assert.match(receiver, /sequence,/);
});
