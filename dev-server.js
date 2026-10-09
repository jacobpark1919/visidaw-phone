const http = require("node:http");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { createHandler } = require("./api/signal.js");

// One process serves both pages and signaling; no hosted database is needed.
// Keep this store local to the dev server. Production still uses Vercel KV.
function createMemoryKv() {
  const entries = new Map();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return null;
      }
      return structuredClone(entry.value);
    },
    async set(key, value, { ex }) {
      for (const [storedKey, entry] of entries) {
        if (entry.expiresAt <= Date.now()) entries.delete(storedKey);
      }
      entries.set(key, { value: structuredClone(value), expiresAt: Date.now() + ex * 1000 });
    },
    async del(key) {
      entries.delete(key);
    }
  };
}

function createDevServer() {
  const kv = createMemoryKv();
  const signal = createHandler(async () => kv);
  const files = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
    ["/desktop.html", ["desktop.html", "text/html; charset=utf-8"]],
    ["/recorder-protocol.js", ["recorder-protocol.js", "text/javascript; charset=utf-8"]],
    ["/theme.css", ["theme.css", "text/css; charset=utf-8"]],
    ...["jetbrains_mono_nl_regular.ttf", "jetbrains_mono_nl_medium.ttf", "OFL.txt", "AUTHORS.txt"].map((name) => {
      const filename = `assets/fonts/jetbrains-mono/${name}`;
      return [`/${filename}`, [filename, name.endsWith(".ttf") ? "font/ttf" : "text/plain; charset=utf-8"]];
    })
  ]);

  return http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/signal") {
        req.query = Object.fromEntries(url.searchParams);
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (body) => {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
        };
        await signal(req, res);
        return;
      }

      const file = files.get(url.pathname);
      if (!file) {
        res.writeHead(404).end("Not found");
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
        return;
      }
      const body = await readFile(path.join(__dirname, file[0]));
      res.writeHead(200, { "Content-Type": file[1], "Content-Length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (error) {
      console.error(error);
      res.writeHead(500).end("Local server error");
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8000);
  const server = createDevServer();
  server.on("error", (error) => {
    console.error("Unable to start local server:", error.message);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`VisiDAW phone: http://localhost:${port}`);
    console.log(`Receiver: http://localhost:${port}/desktop.html`);
    console.log("Local signaling is ready. Sessions reset when the server restarts.");
  });
}

module.exports = { createDevServer, createMemoryKv };
