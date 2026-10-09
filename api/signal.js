async function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

async function getKv() {
  const module = await import("@vercel/kv");
  return module.kv || module.default;
}

function sanitizeSession(value) {
  return String(value || "manual")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64) || "manual";
}

function getSession(req, body = {}) {
  return sanitizeSession(req.query.session || req.query.s || body.session);
}

function createEmptyState(session) {
  return {
    session,
    offer: null,
    answer: null,
    phoneCandidates: [],
    desktopCandidates: [],
    updatedAt: Date.now()
  };
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, max-age=0");
}

function addCandidate(list, candidate) {
  if (!candidate || typeof candidate !== "object") {
    return list;
  }

  const next = [...list, candidate];
  return next.slice(-64);
}

function createHandler(getStore = getKv) {
  return async function handler(req, res) {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    try {
      const kv = await getStore();

      if (req.method === "GET") {
        const session = getSession(req);
        const state = await kv.get(`floof:webrtc:${session}`);
        res.status(200).json(state || createEmptyState(session));
        return;
      }

      if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
      }

      const body = await readJson(req);
      const session = getSession(req, body);
      const key = `floof:webrtc:${session}`;
      const type = String(body.type || "");
      const role = String(body.role || "");

      if (type === "clear") {
        await kv.del(key);
        res.status(200).json({ ok: true, state: createEmptyState(session) });
        return;
      }

      let state = await kv.get(key);

      if (!state || typeof state !== "object") {
        state = createEmptyState(session);
      }

      state.session = session;
      state.updatedAt = Date.now();

      if (type === "offer") {
        state.offer = body.description || null;
        state.answer = null;
        state.phoneCandidates = [];
        state.desktopCandidates = [];
      } else if (type === "answer") {
        state.answer = body.description || null;
      } else if (type === "candidate") {
        if (role === "phone") {
          state.phoneCandidates = addCandidate(state.phoneCandidates || [], body.candidate);
        } else if (role === "desktop") {
          state.desktopCandidates = addCandidate(state.desktopCandidates || [], body.candidate);
        }
      } else {
        res.status(400).json({ error: "Unknown signal type" });
        return;
      }

      await kv.set(key, state, { ex: 600 });
      res.status(200).json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message || "Signal failed" });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
