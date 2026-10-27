# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Content creators filming performance videos, mostly for social media, who care about framing. They open the phone page by scanning a QR code shown by the VisiDAW desktop app, then set up and frame the shot on the phone before recording in VisiDAW.

## Product Purpose
VisiDAW phone turns a phone into a webcam for the VisiDAW desktop DAW. The phone page (`index.html`) captures the phone camera and streams it over WebRTC to the receiver (`desktop.html`), which VisiDAW embeds to show and record the video in sync with audio. Success: the creator scans, taps Start Camera, and sees their shot arrive in VisiDAW with no friction.

## Positioning
The phone camera feeds straight into a DAW, and the recorded video lines up with the audio on the timeline automatically. No separate camera app, file transfer, or manual syncing.

## Operating Context
- The phone is usually propped or mounted while the creator performs, so it is glanced at from a distance as well as handled up close.
- Opened from a QR code; reconnecting means rescanning the same code and tapping Start Camera.
- Runs in iPhone Safari and Android Chrome over HTTPS; camera access needs a secure context.
- Signaling goes through Vercel (`api/signal.js`, KV storage); media is peer-to-peer when the network allows it.

## Capabilities and Constraints
- Controls that must stay: Start Camera, Flip Camera, Zoom (disabled when the device has no adjustable zoom), Flashlight (only shown when the device supports a torch).
- Live status messages tell the user what's happening (waiting for permission, connecting, streaming, errors).
- Session ID comes from the `?s=` URL parameter; it doesn't have to be prominent.
- Static HTML/CSS/JS deployed on Vercel; no build step today.

## Brand Commitments
- The phone page (`index.html`) follows the VisiDAW website (visidaw.com, source in the `visidaw-web` repo) in light mode: `#f8f8f8` ground, black ink, the pale blue accent `#82c7e8` with `#1c2226` text on it, system sans (SF) for body text, JetBrains Mono bold for the wordmark and primary button, and the dark waveform logo tile. Decided 2026-10-27.
- `theme.css` stays the dark desktop-app theme (mirrors `VisiDAWTheme.cpp`) because the receiver (`desktop.html`) is embedded in the dark DAW. The phone page no longer loads it.

## Evidence on Hand
No screenshots, testimonials, or marketing claims exist in this repo. Don't make any up.

## Product Principles
1. The camera view comes first; everything else supports framing the shot.
2. Readable at arm's length and from across the room once streaming.
3. Connection state should always be clear: never leave the creator guessing whether they're live.
4. Feel like part of VisiDAW and its website, not a separate utility.
