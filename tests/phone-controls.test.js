const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function createPhone(track) {
  const elements = new Map();
  const frames = new Map();
  let frameId = 0;
  const context = vm.createContext({
    URLSearchParams,
    window: {
      location: { search: "" },
      requestAnimationFrame(callback) {
        frames.set(++frameId, callback);
        return frameId;
      },
      cancelAnimationFrame(id) { frames.delete(id); }
    },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    } },
    track
  });
  vm.runInContext(script, context);
  vm.runInContext("activeVideoTrack = track; refreshCameraControls();", context);
  return {
    context,
    elements,
    frames,
    drag(value) {
      const slider = elements.get("zoom");
      slider.value = String(value);
      slider.oninput();
    },
    nextFrame() {
      assert.equal(frames.size, 1, "one zoom update is scheduled per frame");
      const [id, callback] = frames.entries().next().value;
      frames.delete(id);
      return callback();
    }
  };
}

function zoomTrack(applyConstraints) {
  return {
    getCapabilities: () => ({ zoom: { min: 1, max: 4, step: 0.25 } }),
    getSettings: () => ({ zoom: 2 }),
    applyConstraints
  };
}

test("zoom updates during continuous dragging and uses the camera's supported range", async () => {
  const applied = [];
  const track = zoomTrack(async (constraints) => { applied.push(constraints.advanced[0].zoom); });
  const phone = createPhone(track);
  const slider = phone.elements.get("zoom");
  assert.equal(slider.disabled, false);
  assert.equal(slider.min, 1);
  assert.equal(slider.max, 4);
  assert.equal(slider.step, 0.25);
  assert.equal(slider.value, 2);

  phone.drag(2.25);
  phone.drag(2.5);
  await phone.nextFrame();
  assert.deepEqual(applied, [2.5]);
  phone.drag(2.75);
  await phone.nextFrame();
  assert.deepEqual(applied, [2.5, 2.75]);
  assert.equal(phone.frames.size, 0);

  track.getCapabilities = () => ({});
  vm.runInContext("refreshCameraControls()", phone.context);
  assert.equal(slider.disabled, true);
  assert.equal(slider.value, 1);
  assert.equal(phone.elements.get("zoomLabel").textContent, "Zoom unavailable");
  assert.equal(phone.elements.get("controls").className, "controls visible");
  phone.drag(3);
  assert.equal(phone.frames.size, 0);
});

test("slow cameras apply one zoom at a time and finish at the final drag position", async () => {
  const applied = [];
  let finish;
  const phone = createPhone(zoomTrack((constraints) => {
    applied.push(constraints.advanced[0].zoom);
    return new Promise((resolve) => { finish = resolve; });
  }));
  phone.drag(2.25);
  const first = phone.nextFrame();
  phone.drag(2.5);
  phone.drag(3);
  phone.drag(4);
  assert.equal(phone.frames.size, 0);
  assert.deepEqual(applied, [2.25]);

  finish();
  await first;
  const last = phone.nextFrame();
  assert.deepEqual(applied, [2.25, 4]);
  finish();
  await last;
  assert.equal(phone.frames.size, 0);
});

test("switching cameras drops pending zoom and ignores errors from the previous track", async () => {
  let rejectOldZoom;
  const phone = createPhone(zoomTrack(() => new Promise((resolve, reject) => { rejectOldZoom = reject; })));
  phone.drag(2.5);
  const oldZoom = phone.nextFrame();
  phone.drag(4);

  const applied = [];
  const newTrack = zoomTrack(async (constraints) => { applied.push(constraints.advanced[0].zoom); });
  phone.context.navigator = { mediaDevices: {
    getUserMedia: async () => ({ getVideoTracks: () => [newTrack] })
  } };
  await vm.runInContext('startOrRestartCamera("Camera flipped.")', phone.context);
  phone.drag(1.5);
  rejectOldZoom(new Error("Old camera stopped"));
  await oldZoom;
  assert.equal(phone.elements.get("status").textContent, "Camera flipped.");
  assert.equal(phone.elements.get("zoom").value, "1.5");
  await phone.nextFrame();
  assert.deepEqual(applied, [1.5]);
});

test("switching cameras cancels a zoom frame that has not run yet", async () => {
  const applied = [];
  const phone = createPhone(zoomTrack(async () => { applied.push("old"); }));
  phone.drag(4);
  const newTrack = zoomTrack(async () => { applied.push("new"); });
  phone.context.navigator = { mediaDevices: {
    getUserMedia: async () => ({ getVideoTracks: () => [newTrack] })
  } };
  await vm.runInContext("startOrRestartCamera()", phone.context);
  assert.equal(phone.frames.size, 0);
  assert.deepEqual(applied, []);
  assert.equal(phone.elements.get("zoom").value, 2);
});

test("failed zoom restores camera settings and allows the next drag to retry", async () => {
  let rejectZoom;
  const track = zoomTrack(() => new Promise((resolve, reject) => { rejectZoom = reject; }));
  const phone = createPhone(track);
  phone.drag(2.5);
  const failedZoom = phone.nextFrame();
  phone.drag(4);
  rejectZoom(new Error("Zoom failed"));
  await failedZoom;
  assert.equal(phone.elements.get("zoom").value, 2);
  assert.equal(phone.elements.get("status").textContent, "Camera setting failed: Zoom failed");
  assert.equal(phone.frames.size, 0);

  let applied;
  track.applyConstraints = async (constraints) => { applied = constraints.advanced[0].zoom; };
  phone.drag(3);
  await phone.nextFrame();
  assert.equal(applied, 3);
});

test("camera opens on the front camera and the flip button switches to the back camera", async () => {
  const phone = createPhone(null);
  const requestedFacingModes = [];
  phone.context.navigator = { mediaDevices: {
    getUserMedia: async (constraints) => {
      requestedFacingModes.push(constraints.video.facingMode.ideal);
      const track = { stop() {} };
      return { getVideoTracks: () => [track], getTracks: () => [track] };
    }
  } };
  await vm.runInContext("startOrRestartCamera()", phone.context);
  await phone.elements.get("flip").onclick();
  await phone.elements.get("flip").onclick();
  assert.deepEqual(requestedFacingModes, ["user", "environment", "user"]);
});

function cameraStream(name) {
  const track = { kind: "video", readyState: "live", stop() { this.readyState = "ended"; } };
  return { name, getVideoTracks: () => [track], getTracks: () => [track] };
}

function attachSender(phone, stream, replaceTrack) {
  phone.context.initialStream = stream;
  phone.context.sender = { track: stream.getVideoTracks()[0], replaceTrack };
  phone.context.connection = { identity: "paired-peer" };
  vm.runInContext("localStream = initialStream; activeVideoTrack = sender.track; videoSender = sender; peer = connection;", phone.context);
}

test("flip releases an exclusive camera before reopening and preserves the paired sender", async () => {
  const phone = createPhone(null);
  const front = cameraStream("front");
  const back = cameraStream("back");
  const restoredFront = cameraStream("front-again");
  let current = front;
  const replacements = [];
  attachSender(phone, front, async (track) => { replacements.push(track); });
  phone.context.navigator = { mediaDevices: { getUserMedia: async () => {
    assert.equal(current.getVideoTracks()[0].readyState, "ended", "exclusive camera released first");
    current = current === front ? back : restoredFront;
    return current;
  } } };
  await phone.elements.get("flip").onclick();
  await phone.elements.get("flip").onclick();
  assert.deepEqual(replacements, [back.getVideoTracks()[0], restoredFront.getVideoTracks()[0]]);
  assert.equal(vm.runInContext("peer === connection && videoSender === sender", phone.context), true);
  assert.equal(phone.elements.get("preview").srcObject, restoredFront);
  assert.equal(restoredFront.getVideoTracks()[0].readyState, "live");
});

test("rapid flips serialize camera acquisition and track replacement", async () => {
  const phone = createPhone(null);
  const front = cameraStream("front");
  const back = cameraStream("back");
  let acquired;
  let replaced;
  let opens = 0;
  attachSender(phone, front, () => new Promise((resolve) => { replaced = resolve; }));
  phone.context.navigator = { mediaDevices: { getUserMedia: () => {
    opens++;
    return new Promise((resolve) => { acquired = resolve; });
  } } };
  const flip = phone.elements.get("flip").onclick;
  const first = flip();
  await flip();
  assert.equal(opens, 1);
  acquired(back);
  await new Promise((resolve) => setImmediate(resolve));
  await flip();
  assert.equal(opens, 1);
  assert.equal(phone.elements.get("flip").disabled, true);
  replaced();
  await first;
  assert.equal(phone.elements.get("flip").disabled, false);
});

for (const failure of ["acquire", "replace"]) {
  test(`failed camera ${failure} restores the previous facing mode on the same connection`, async () => {
    const phone = createPhone(null);
    const front = cameraStream("front");
    const rejected = cameraStream("back");
    const restored = cameraStream("restored");
    let replacements = 0;
    attachSender(phone, front, async () => {
      if (++replacements === 1 && failure === "replace") throw new Error("Replacement rejected");
    });
    const modes = [];
    phone.context.navigator = { mediaDevices: { getUserMedia: async (constraints) => {
      modes.push(constraints.video.facingMode.ideal);
      if (modes.length === 1) {
        if (failure === "acquire") throw new Error("Camera unavailable");
        return rejected;
      }
      return restored;
    } } };
    await phone.elements.get("flip").onclick();
    assert.deepEqual(modes, ["environment", "user"]);
    if (failure === "replace") assert.equal(rejected.getVideoTracks()[0].readyState, "ended");
    assert.equal(phone.elements.get("preview").srcObject, restored);
    assert.equal(vm.runInContext("peer === connection && videoSender === sender", phone.context), true);
    assert.match(phone.elements.get("status").textContent, /Previous camera restored/);
  });
}

test("failed flip and recovery keep the pairing available for a subsequent retry", async () => {
  const phone = createPhone(null);
  attachSender(phone, cameraStream("front"), async () => {});
  phone.context.navigator = { mediaDevices: { getUserMedia: async () => { throw new Error("Unavailable"); } } };
  await phone.elements.get("flip").onclick();
  assert.equal(phone.elements.get("flip").disabled, false);
  assert.match(phone.elements.get("status").textContent, /retry/);
  const stream = cameraStream("retry");
  phone.context.navigator.mediaDevices.getUserMedia = async () => stream;
  await phone.elements.get("flip").onclick();
  assert.equal(phone.elements.get("preview").srcObject, stream);
  assert.equal(vm.runInContext("peer === connection && videoSender === sender", phone.context), true);
});
