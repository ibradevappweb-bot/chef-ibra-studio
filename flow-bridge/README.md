# IBRA Google Flow Bridge

HTTP bridge intended for n8n to submit a prompt to the unofficial `gflow-cli`, generate a video through the normal Google Flow browser UI, and retrieve the resulting MP4.

## Current limitations

- This service does **not** bypass Google sign-in, 2FA, CAPTCHA, Flow credits, or usage limits.
- The Google account must be signed in to Google Flow in the same Chrome profile used by `gflow-cli`.
- A persistent data volume mounted at `/data` is required to preserve the browser profile and downloaded MP4 files across restarts.
- The development branch adds a token-gated remote Chrome screen at `/remote`, using noVNC over the same public HTTPS port. The browser session is limited to 30 minutes and the VNC/RFB port is bound to localhost behind the authenticated WebSocket proxy.
- This interface still needs a successful Render build and live test before it is considered installed. The login must be completed by the account owner; it does not bypass Google sign-in, CAPTCHA, 2FA, or account checks.
- Never commit Google cookies, browser profiles, passwords, or session tokens to GitHub.

## Environment

- `FLOW_BRIDGE_TOKEN`: required secret for all job and download endpoints.
- `FLOW_DATA_DIR`: defaults to `/data`; mount persistent storage here.
- `GFLOW_PROFILE`: defaults to `default`.
- `GFLOW_VIDEO_MODEL`: defaults to `Veo 3.1 - Lite`.
- `GFLOW_CHROME_PATH`: defaults to `/usr/bin/google-chrome`.

## API

Send requests with header `Authorization: Bearer <FLOW_BRIDGE_TOKEN>`.

### Submit a job

`POST /jobs`

```json
{
  "id": "clip-001",
  "prompt": "A cinematic vertical video ...",
  "model": "Veo 3.1 - Lite",
  "ratio": "9:16",
  "duration": 8
}
```

Returns HTTP 202 with the job ID and status URL.

### Check status

`GET /jobs/clip-001`

### Download MP4

`GET /jobs/clip-001/video`

### Remote first login (development branch only)

1. Open `https://<service-host>/remote` in your phone browser.
2. Enter the existing `FLOW_BRIDGE_TOKEN` in the password field. Do not send it in chat.
3. Tap **Lancer Chrome pour se connecter** and complete Google sign-in in the displayed Chrome window.
4. The remote session expires after 30 minutes. The `/remote` route is available only on this development branch until reviewed and deployed.

The remote desktop uses Xvfb, x11vnc (localhost-only), noVNC, websockify, and an authenticated WebSocket proxy. Do not deploy before a Docker build and security test.

### Health

`GET /health`

## Deployment note

Do not deploy this as a finished automation yet. First add a secure way to complete the normal Google login in the same Chrome profile, verify `gflow doctor`, then deploy with persistent storage and verify a real end-to-end generation.
