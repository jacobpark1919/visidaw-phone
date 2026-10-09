# VisiDAW phone web

This is the prototype HTTPS phone camera/WebRTC pairing site for VisiDAW.

It is designed for Vercel:

- `index.html` opens the iPhone camera over HTTPS and sends it with WebRTC
- `desktop.html` receives the WebRTC stream and emits ordered protocol-2 recording chunks to VisiDAW
- `recorder-protocol.js` provides shared recording-duration and capture-boundary calculations
- `api/signal.js` stores temporary WebRTC offer/answer/ICE signaling messages
- `api/frame.js` is the older JPEG relay fallback/prototype endpoint
- `package.json` installs Vercel's KV client for serverless signaling storage

Vercel is only used for pairing/signaling. The WebRTC media path should connect peer-to-peer when the network allows it.

## Required Storage

For local development, use Node.js 18 or newer and run:

```sh
npm run dev
```

Open `http://localhost:8000` for the phone page and
`http://localhost:8000/desktop.html` for the receiver. Both default to the
`manual` session; use matching `?s=your-session` values for other sessions.
The local server handles `/api/signal` with temporary in-memory storage, so
it needs no Redis credentials or package installation. Sessions expire after
ten minutes without a signaling write and reset when the server restarts.
The legacy `/api/frame` endpoint is not part of this local server.

A static server such as `python3 -m http.server` only previews the pages;
it cannot handle camera pairing and returns HTTP 501 for signaling POSTs.
The local server binds to your computer's loopback address. To test with an
actual phone, use the HTTPS deployment and its configured storage.
Zoom is available only when the camera/browser exposes an adjustable zoom
range; otherwise the slider remains visible but disabled.

### Hosted storage

Vercel serverless functions do not reliably share in-memory state between requests, so signaling needs Redis/KV storage.

Create a Vercel KV / Upstash Redis database. Vercel may add these environment variables automatically:

```text
KV_REST_API_URL
KV_REST_API_TOKEN
KV_REST_API_READ_ONLY_TOKEN
KV_URL
REDIS_URL
```

The relay uses Vercel's `@vercel/kv` client, which reads the `KV_*` variables automatically.

It also supports the equivalent Upstash names if you add them manually:

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

Without working KV variables, the phone page can open but WebRTC pairing will not complete.

## Deploy

Deploy this folder as the Vercel project root.

After deployment, you can verify that KV is working by opening:

```text
https://visidaw-phone.vercel.app/api/frame?session=test&debug=1
```

It should return JSON with `"ok": true`.

After deployment, the desktop app expects:

```text
https://visidaw-phone.vercel.app
```

Before distributing a native build that requires recorder protocol 2, verify in the deployed receiver console:

```js
window.visidawRecorderProtocolVersion
```

It must return `2`. Run the receiver protocol tests with `npm test` before deployment.

The receiver exports `window.visidawStartWebRtcRecording` and
`window.visidawStopWebRtcRecording`, advertises
`window.visidawRecorderProtocolVersion`, and emits `visidawWebRtcVideo` events.
Deploy this receiver together with the matching VisiDAW desktop bridge rename;
older desktop builds using the previous bridge names will not receive its events.
Protocol version 2 and its timing limitations are unchanged by this rename.

If your Vercel URL changes, configure the desktop build with
`-DVISIDAW_PHONE_WEB_BASE_URL=https://your-phone-origin.example`.

## WebRTC Flow

1. In VisiDAW, choose `Phone as Webcam (WebRTC)`.
2. VisiDAW opens `desktop.html?s=<session>` in the computer's browser.
3. Scan the QR from VisiDAW with the iPhone.
4. Tap `Start Camera`.
5. Click `Start Receiver` in the desktop browser page if it has not already started.

The embedded receiver records the remote stream with `MediaRecorder`. It assigns chunk sequence numbers before asynchronous reads, waits for the final `dataavailable` event and all reads, and then sends integrity and duration metadata to the native app for local storage and timeline insertion.
