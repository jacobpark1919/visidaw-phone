const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("zoom applies supported camera constraints and becomes unavailable after switching cameras", async () => {
  const elements = new Map();
  let capabilities = { zoom: { min: 1, max: 4, step: 0.25 } };
  let applied;
  const context = vm.createContext({
    URLSearchParams,
    window: { location: { search: "" } },
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    } },
    track: {
      getCapabilities: () => capabilities,
      getSettings: () => ({ zoom: 2 }),
      applyConstraints: async (constraints) => { applied = constraints; }
    }
  });
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  vm.runInContext("activeVideoTrack = track; refreshCameraControls();", context);
  const slider = elements.get("zoom");
  assert.equal(slider.disabled, false);
  assert.equal(slider.value, 2);
  slider.value = "2.5";
  await vm.runInContext("applyZoom()", context);
  assert.equal(applied.advanced[0].zoom, 2.5);

  capabilities = {};
  vm.runInContext("refreshCameraControls()", context);
  assert.equal(slider.disabled, true);
  assert.equal(slider.value, 1);
  assert.equal(elements.get("zoomLabel").textContent, "Zoom unavailable");
  assert.equal(elements.get("controls").className, "controls visible");
});
