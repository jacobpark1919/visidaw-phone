function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

async function getKv() {
  const module = await import("@vercel/kv");
  return module.kv || module.default;
}

function getSession(req) {
  const value = req.query.session;
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value)
    && value !== "manual" ? value : null;
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, max-age=0");
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const session = getSession(req);
  if (!session) {
    res.status(400).json({ error: "A valid pairing session is required" });
    return;
  }
  const key = `floof:frame:${session}`;

  if (req.method === "GET" && req.query.debug === "1") {
    try {
      const kv = await getKv();
      const debugKey = `floof:debug:${session}`;
      const value = `${Date.now()}`;

      await kv.set(debugKey, value, { ex: 10 });
      const storedValue = await kv.get(debugKey);

      const storedValueText = storedValue == null ? "" : String(storedValue);

      res.status(200).json({
        ok: storedValueText === value,
        session,
        hasKvUrl: Boolean(process.env.KV_REST_API_URL),
        hasKvToken: Boolean(process.env.KV_REST_API_TOKEN),
        storedValueMatches: storedValueText === value,
        storedValueType: typeof storedValue,
        storedValueTextLength: storedValueText.length
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message || "KV debug check failed"
      });
    }

    return;
  }

  if (req.method === "POST") {
    try {
      const body = await readBody(req);

      if (body.length > 0) {
        const kv = await getKv();
        await kv.set(key, body.toString("base64"), { ex: 5 });
      }

      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error.message || "Failed to store frame" });
    }

    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    try {
      const kv = await getKv();
      const frame = await kv.get(key);

      if (!frame) {
        res.status(204).end();
        return;
      }

      const body = Buffer.from(String(frame), "base64");
      res.setHeader("Content-Type", "image/jpeg");

      if (req.method === "HEAD") {
        res.status(200).end();
        return;
      }

      res.setHeader("Content-Length", body.length);
      res.status(200).send(body);
    } catch (error) {
      res.status(500).json({ error: error.message || "Failed to load frame" });
    }

    return;
  }

  res.status(405).json({ error: "Method not allowed" });
};
