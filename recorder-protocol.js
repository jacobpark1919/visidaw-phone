(function attachVisiDAWRecorderProtocol(root, factory) {
  const protocol = factory();
  if (typeof module === "object" && module.exports) module.exports = protocol;
  if (root) root.VisiDAWRecorderProtocol = protocol;
})(typeof window !== "undefined" ? window : globalThis, () => {
  function medianFrameInterval(intervals) {
    const sorted = Array.from(intervals || [])
      .filter((value) => Number.isFinite(value) && value > 0 && value < 1)
      .sort((left, right) => left - right);
    return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
  }

  function calculateDuration(firstMediaTime, lastMediaTime, intervals, elapsedSeconds) {
    const finalFrameIntervalSeconds = medianFrameInterval(intervals);
    const sourceDurationSeconds = Number.isFinite(firstMediaTime) && Number.isFinite(lastMediaTime)
      ? Math.max(0, lastMediaTime - firstMediaTime) + finalFrameIntervalSeconds
      : Math.max(0, Number(elapsedSeconds) || 0);
    return { sourceDurationSeconds, finalFrameIntervalSeconds };
  }

  function captureBoundaryReached(captureTimeMs, targetCaptureTimeMs) {
    return Number.isFinite(captureTimeMs)
      && Number.isFinite(targetCaptureTimeMs)
      && captureTimeMs >= targetCaptureTimeMs;
  }

  return { medianFrameInterval, calculateDuration, captureBoundaryReached };
});
