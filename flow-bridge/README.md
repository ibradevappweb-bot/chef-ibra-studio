# IBRA Google Flow Bridge

HTTP bridge intended for n8n to submit a prompt to the unofficial `gflow-cli`, generate a video through the normal Google Flow browser UI, and retrieve the resulting MP4.

## Current limitations

- This service does **not** bypass Google sign-in, 2FA, CAPTCHA, Flow credits, or usage limits.
- The Google account must be signed in to Google Flow in the same Chrome profile used by `gflow-cli`.
- A persistent data volume mounted at `/data` is required to preserve the browser profile and downloaded MP4 files across restarts.
- This initial container does not provide an interactive browser-login screen. It is not ready for real generation until a safe, interactive first-login method is added and the profile is verified with `gflow doctor`.
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

### Health

`GET /health`

## Deployment note

Do not deploy this as a finished automation yet. First add a secure way to complete the normal Google login in the same Chrome profile, verify `gflow doctor`, then deploy with persistent storage and verify a real end-to-end generation.
