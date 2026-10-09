const express = require("express");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const net = require("node:net");
const { WebSocket, WebSocketServer } = require("ws");
const storage = require("./storage");
let persistenceState = { configured: storage.configured(), profileRestored: false, lastProfileBackup: null, lastVideoBackup: null, warning: null };

const app = express();
app.use(express.json({ limit: "32kb" }));

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.FLOW_BRIDGE_TOKEN || "";
const DATA_DIR = process.env.FLOW_DATA_DIR || "/data";
const OUT_DIR = path.join(DATA_DIR, "out");
const JOBS_DIR = path.join(DATA_DIR, "jobs");
const PROFILE = process.env.GFLOW_PROFILE || "default";
const MODEL = process.env.GFLOW_VIDEO_MODEL || "Veo 3.1 - Lite";
const MAX_PROMPT_LENGTH = 12000;
const jobs = new Map();
let runningJobId = null;
const remoteSessions = new Map();
const remoteWsTickets = new Map();
let loginProcess = null;
const REMOTE_SESSION_TTL_MS = 30 * 60 * 1000;
const REMOTE_WS_TICKET_TTL_MS = 2 * 60 * 1000;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(JOBS_DIR, { recursive: true });

function tokenIsValid(req) {
  if (!TOKEN) return false;
  const header = req.get("authorization") || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireToken(req, res, next) {
  if (!TOKEN) return res.status(503).json({ error: "FLOW_BRIDGE_TOKEN n'est pas configuré." });
  if (!tokenIsValid(req)) return res.status(401).json({ error: "Jeton invalide ou absent." });
  next();
}

function persistJob(job) {
  const target = path.join(JOBS_DIR, job.id + ".json");
  fs.writeFileSync(target, JSON.stringify(job, null, 2));
}

function loadJob(id) {
  if (typeof id !== "string" || !/^[a-z0-9_-]{1,70}$/.test(id)) return null;
  if (jobs.has(id)) return jobs.get(id);
  const target = path.join(JOBS_DIR, id + ".json");
  if (!fs.existsSync(target)) return null;
  try {
    const job = JSON.parse(fs.readFileSync(target, "utf8"));
    jobs.set(id, job);
    return job;
  } catch {
    return null;
  }
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || null,
    prompt: job.prompt,
    model: job.model,
    ratio: job.ratio,
    duration: job.duration,
    error: job.error || null,
    videoUrl: job.status === "completed" ? "/jobs/" + encodeURIComponent(job.id) + "/video" : null
  };
}


function parseCookies(header = "") {
  const result = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) result[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return result;
}
function validRemoteSession(req) {
  const id = parseCookies(req.headers.cookie || "").ibra_flow_remote;
  const expires = id ? remoteSessions.get(id) : null;
  if (!expires || expires < Date.now()) {
    if (id) remoteSessions.delete(id);
    return false;
  }
  return true;
}
function requireRemoteSession(req, res, next) {
  if (!validRemoteSession(req)) return res.status(401).send("Session distante expirée. Revenez à /remote et reconnectez-vous.");
  next();
}
function issueRemoteWsTicket() {
  const ticket = crypto.randomBytes(32).toString("hex");
  remoteWsTickets.set(ticket, Date.now() + REMOTE_WS_TICKET_TTL_MS);
  return ticket;
}
function consumeRemoteWsTicket(ticket) {
  if (typeof ticket !== "string" || !ticket) return false;
  const expires = remoteWsTickets.get(ticket);
  remoteWsTickets.delete(ticket);
  return Boolean(expires && expires >= Date.now());
}
app.get("/remote", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html><html lang="fr"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connexion Google Flow — IBRA</title>
  <body style="font:16px system-ui;max-width:520px;margin:35px auto;padding:18px;background:#f5f6f8;color:#172033">
  <h2>Connexion sécurisée Google Flow</h2><p>Cette page ouvre le navigateur du pont. Le jeton n'est pas enregistré dans le navigateur distant.</p>
  <label for="token">Jeton privé du pont</label><input id="token" type="password" autocomplete="off" style="display:block;width:100%;box-sizing:border-box;padding:12px;margin:8px 0 14px">
  <button id="connect" style="padding:12px 18px">Ouvrir la session sécurisée</button><p id="msg"></p>
  <script>const b=document.getElementById('connect'),m=document.getElementById('msg');b.onclick=async()=>{b.disabled=true;m.textContent='Vérification…';try{const r=await fetch('/remote/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:document.getElementById('token').value})});if(!r.ok)throw new Error('Jeton incorrect ou service indisponible');document.getElementById('token').value='';location.href='/remote/login';}catch(e){m.textContent=e.message;b.disabled=false}}</script></body></html>`);
});
app.post("/remote/session", (req, res) => {
  const supplied = typeof req.body?.token === "string" ? req.body.token : "";
  if (!tokenIsValid({ get: name => name.toLowerCase() === "authorization" ? "Bearer " + supplied : "" })) {
    return res.status(401).json({ error: "Jeton invalide." });
  }
  const id = crypto.randomBytes(32).toString("hex");
  remoteSessions.set(id, Date.now() + REMOTE_SESSION_TTL_MS);
  res.set("Cache-Control", "no-store");
  res.cookie("ibra_flow_remote", id, { httpOnly: true, secure: true, sameSite: "strict", maxAge: REMOTE_SESSION_TTL_MS, path: "/" });
  res.json({ ok: true, expiresInMinutes: 30 });
});
app.get("/remote/login", requireRemoteSession, (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html><html lang="fr"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google Flow</title><body style="font:16px system-ui;padding:24px;max-width:600px;margin:auto"><h2>Navigateur Google Flow</h2><p>Appuyez sur le bouton. Chrome s'ouvrira dans la fenêtre distante. Connectez-vous vous-même à Google Flow.</p><button id="go" style="padding:14px">Lancer Chrome pour se connecter</button><p id="status"></p><script>document.getElementById('go').onclick=async()=>{const b=document.getElementById('go'),s=document.getElementById('status');b.disabled=true;s.textContent='Démarrage de Chrome…';const r=await fetch('/remote/start-login',{method:'POST'});if(!r.ok){s.textContent='Impossible de lancer Chrome. Consultez les journaux du pont.';b.disabled=false;return}location.href='/remote/desktop';}</script></body></html>`);
});
app.post("/remote/start-login", requireRemoteSession, (_req, res) => {
  if (loginProcess) return res.status(409).json({ error: "La connexion Chrome est déjà en cours." });
  if (runningJobId) return res.status(409).json({ error: "Attendez la fin de la génération vidéo avant de vous connecter." });
  loginProcess = spawn("gflow", ["auth", "login", "--profile", PROFILE], {
    cwd: DATA_DIR,
    env: { ...process.env, DISPLAY: ":99", GFLOW_CHROME_PATH: process.env.GFLOW_CHROME_PATH || "/usr/bin/google-chrome" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  loginProcess.stdout.on("data", c => console.log("[gflow-auth]", c.toString().slice(0, 1000)));
  loginProcess.stderr.on("data", c => console.log("[gflow-auth]", c.toString().slice(0, 1000)));
  loginProcess.on("error", e => { console.error("[gflow-auth] launch error:", e.message); loginProcess = null; });
  loginProcess.on("close", code => { console.log("[gflow-auth] finished with code", code); loginProcess = null; });
  res.status(202).json({ ok: true, message: "Chrome est en cours de démarrage." });
});
app.get("/remote/desktop", requireRemoteSession, (_req, res) => {
  const ticket = issueRemoteWsTicket();
  res.set("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html><html lang="fr"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bureau distant IBRA</title><style>html,body,#screen{width:100%;height:100%;margin:0;background:#171717}#status{position:fixed;z-index:2;top:8px;left:8px;max-width:90%;padding:8px 12px;background:#fff;color:#111;border-radius:6px;font:14px system-ui}#screen{display:block}</style></head><body><div id="status">Connexion sécurisée au bureau distant…</div><div id="screen"></div><script type="module">
const status=document.getElementById('status');
const ticket=${JSON.stringify(ticket)};
const protocol=location.protocol==='https:'?'wss:':'ws:';
const socketUrl=protocol+'//'+location.host+'/websockify?ticket='+encodeURIComponent(ticket);
let connected=false;
window.addEventListener('error',event=>{status.textContent='Erreur du navigateur : '+(event.message||'script impossible à charger');});
window.addEventListener('unhandledrejection',event=>{status.textContent='Erreur de chargement du bureau : '+(event.reason?.message||String(event.reason||'inconnue'));});
status.textContent='Chargement du client du bureau…';
import('/remote/core/rfb.js').then(({default:RFB})=>{
  status.textContent='Client chargé. Connexion au bureau…';
  const rfb=new RFB(document.getElementById('screen'),socketUrl);
  rfb.scaleViewport=true;
  rfb.resizeSession=true;
  rfb.showDotCursor=true;
  rfb.addEventListener('connect',()=>{connected=true;status.textContent='Bureau distant connecté';setTimeout(()=>status.remove(),2500)});
  rfb.addEventListener('disconnect',event=>{status.textContent='Échec de connexion au bureau distant. '+(event.detail.clean?'La session a été fermée.':'Le serveur VNC local a interrompu la connexion.');});
  rfb.addEventListener('credentialsrequired',()=>{status.textContent='Le bureau demande des identifiants VNC inattendus.';});
  setTimeout(()=>{if(!connected)status.textContent='Client chargé, mais le bureau ne répond pas encore. Vérification du serveur VNC nécessaire.';},12000);
}).catch(error=>{status.textContent='Échec de chargement du client noVNC : '+(error?.message||String(error));});
</script></body></html>`);
});
app.use("/remote", express.static("/usr/share/novnc", { index: false, fallthrough: true, dotfiles: "deny" }));

app.get("/", (_req, res) => {
  res.json({ name: "IBRA Google Flow Bridge", status: "online", endpoints: ["GET /health", "POST /jobs", "GET /jobs/:id", "GET /jobs/:id/video"] });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    tokenConfigured: Boolean(TOKEN),
    dataDirectoryWritable: (() => {
      try { fs.accessSync(DATA_DIR, fs.constants.W_OK); return true; }
      catch { return false; }
    })(),
    gflowProfile: PROFILE,
    activeJobId: runningJobId,
    supabaseStorageConfigured: storage.configured(),
    profileRestored: persistenceState.profileRestored,
    lastProfileBackup: persistenceState.lastProfileBackup,
    lastVideoBackup: persistenceState.lastVideoBackup,
    persistenceWarning: persistenceState.warning
  });
});

app.post("/jobs", requireToken, (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) return res.status(400).json({ error: "Le champ 'prompt' est obligatoire." });
  if (prompt.length > MAX_PROMPT_LENGTH) return res.status(400).json({ error: "Prompt trop long (maximum 12000 caractères)." });
  if (runningJobId) return res.status(409).json({ error: "Une génération est déjà en cours.", activeJobId: runningJobId });

  const id = (typeof req.body.id === "string" ? req.body.id : "ibra-" + Date.now())
    .toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 70);
  if (!id) return res.status(400).json({ error: "Identifiant de tâche invalide." });

  const duration = Number(req.body.duration ?? 8);
  if (![4, 6, 8, 10].includes(duration)) return res.status(400).json({ error: "duration doit être 4, 6, 8 ou 10." });

  const ratio = req.body.ratio || "9:16";
  if (!["9:16", "16:9"].includes(ratio)) return res.status(400).json({ error: "ratio doit être 9:16 ou 16:9." });

  const model = typeof req.body.model === "string" ? req.body.model : MODEL;
  const job = {
    id, prompt, duration, ratio, model, status: "queued",
    createdAt: new Date().toISOString(), finishedAt: null, error: null
  };
  jobs.set(id, job);
  persistJob(job);

  // Acknowledge immediately so n8n does not wait for a long video generation.
  res.status(202).json(publicJob(job));

  runningJobId = id;
  job.status = "running";
  persistJob(job);

  const args = [
    "video", "--id", id, "--prompt", prompt,
    "--duration", String(duration), "--ratio", ratio,
    "--model", model, "--out", OUT_DIR, "--profile", PROFILE,
    "--timeout", "1800"
  ];

  const child = spawn("xvfb-run", ["-a", "gflow", ...args], {
    cwd: DATA_DIR,
    env: { ...process.env, GFLOW_CHROME_PATH: process.env.GFLOW_CHROME_PATH || "/usr/bin/google-chrome" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let logs = "";
  child.stdout.on("data", chunk => { logs = (logs + chunk.toString()).slice(-12000); });
  child.stderr.on("data", chunk => { logs = (logs + chunk.toString()).slice(-12000); });

  child.on("error", err => {
    job.status = "failed";
    job.error = "Impossible de lancer gflow: " + err.message;
    job.finishedAt = new Date().toISOString();
    job.diagnostic = logs;
    persistJob(job);
    runningJobId = null;
  });

  child.on("close", async code => {
    if (job.status === "failed" && job.finishedAt) return;
    const expected = path.join(OUT_DIR, id + "-001.mp4");
    const found = fs.existsSync(expected) ? expected : null;
    job.status = code === 0 && found ? "completed" : "failed";
    job.error = job.status === "failed"
      ? (code !== 0 ? "gflow s'est terminé avec le code " + code + ". Vérifier la session Google Flow et les journaux." : "gflow a terminé mais le MP4 attendu est introuvable.")
      : null;
    job.outputFile = found;
    job.finishedAt = new Date().toISOString();
    job.diagnostic = logs;
    if (found && storage.configured()) {
      try {
        const savedVideo = await storage.uploadVideo(found, id);
        if (savedVideo.saved) {
          job.storageVideoPath = savedVideo.path;
          persistenceState.lastVideoBackup = new Date().toISOString();
        } else {
          persistenceState.warning = "Vidéo non sauvegardée dans Supabase: " + savedVideo.reason;
        }
      } catch (err) {
        persistenceState.warning = "Sauvegarde vidéo Supabase échouée: " + err.message;
      }
    }
    if (storage.configured()) {
      try {
        const savedProfile = await storage.backupProfile();
        if (savedProfile.saved) {
          persistenceState.lastProfileBackup = new Date().toISOString();
          persistenceState.warning = null;
        } else if (savedProfile.reason !== "profile_missing") {
          persistenceState.warning = "Profil Google Flow non sauvegardé: " + savedProfile.reason;
        }
      } catch (err) {
        persistenceState.warning = "Sauvegarde du profil Google Flow échouée: " + err.message;
      }
    }
    persistJob(job);
    runningJobId = null;
  });
});

app.get("/jobs/:id", requireToken, (req, res) => {
  const job = loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Tâche introuvable." });
  res.json(publicJob(job));
});

app.get("/jobs/:id/video", requireToken, async (req, res) => {
  const job = loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Tâche introuvable." });
  if (job.status !== "completed") return res.status(409).json({ error: "La vidéo n'est pas encore disponible." });
  if (job.outputFile && fs.existsSync(job.outputFile)) return res.download(job.outputFile, job.id + ".mp4");
  if (job.storageVideoPath && storage.configured()) {
    try {
      const video = await storage.downloadVideo(job.storageVideoPath);
      if (video) {
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", 'attachment; filename="' + job.id + '.mp4"');
        return res.send(video);
      }
    } catch (err) {
      return res.status(502).json({ error: "Impossible de récupérer la vidéo sauvegardée.", detail: err.message });
    }
  }
  return res.status(409).json({ error: "La vidéo n'est pas disponible localement ni dans Supabase." });
});

app.get("/jobs/:id/log", requireToken, (req, res) => {
  const job = loadJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Tâche introuvable." });
  res.json({ id: job.id, status: job.status, error: job.error, diagnostic: job.diagnostic || "" });
});

async function start() {
  if (storage.configured()) {
    try {
      const restored = await storage.restoreProfile();
      persistenceState.profileRestored = restored.restored;
      if (!restored.restored && restored.reason === "no_backup_yet") {
        persistenceState.warning = "Aucun profil Google Flow sauvegardé. Une première connexion manuelle reste nécessaire.";
      }
      console.log("Supabase profile restore: " + restored.reason);
    } catch (err) {
      persistenceState.warning = "Restauration du profil Google Flow échouée: " + err.message;
      console.error(persistenceState.warning);
    }
  } else {
    persistenceState.warning = "Persistance inactive: ajouter SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY dans Render.";
  }

  const server = require("node:http").createServer(app);
  // Authenticate the browser connection here, then relay WebSocket frames
  // through websockify, which performs the WebSocket-to-VNC conversion.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 2 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const parsedUrl = new URL(req.url, "http://localhost");
    const pathname = parsedUrl.pathname;
    const allowedPath = ["/websockify", "/remote/websockify"].includes(pathname);
    const sessionOk = validRemoteSession(req);
    const ticketOk = allowedPath && consumeRemoteWsTicket(parsedUrl.searchParams.get("ticket"));
    if (!allowedPath || (!sessionOk && !ticketOk)) {
      console.warn("[remote-vnc] WebSocket upgrade rejected:", JSON.stringify({ pathname, sessionOk, ticketOk }));
      socket.write("HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, browser => {
      const upstream = new WebSocket("ws://127.0.0.1:6080/websockify", "binary", {
        handshakeTimeout: 10000,
        perMessageDeflate: false,
        maxPayload: 2 * 1024 * 1024
      });
      let upstreamOpened = false;
      const closeBoth = () => {
        if (browser.readyState === WebSocket.OPEN || browser.readyState === WebSocket.CONNECTING) browser.terminate();
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      };
      upstream.on("open", () => {
        upstreamOpened = true;
        console.log("[remote-vnc] Browser WebSocket relayed through websockify:6080");
      });
      browser.on("message", (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      });
      upstream.on("message", (data, isBinary) => {
        if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary: isBinary });
      });
      upstream.on("error", err => console.error("[remote-vnc] websockify connection failed:", err.message));
      upstream.on("close", (code, reason) => {
        console.warn("[remote-vnc] websockify closed:", code, reason.toString().slice(0, 160));
        if (browser.readyState === WebSocket.OPEN) browser.close();
      });
      browser.on("error", err => console.warn("[remote-vnc] Browser WebSocket error:", err.message));
      browser.on("close", () => {
        if (upstream.readyState === WebSocket.OPEN) upstream.close();
        else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      });
      const timer = setTimeout(() => {
        if (!upstreamOpened) {
          console.error("[remote-vnc] websockify connection timed out");
          closeBoth();
        }
      }, 12000);
      timer.unref();
      upstream.once("open", () => clearTimeout(timer));
    });
  });
  server.listen(PORT, "0.0.0.0", () => {
    console.log("IBRA Google Flow Bridge listening on port " + PORT);
    function monitorChild(name, child) {
      child.stdout?.on("data", chunk => console.log(`[remote-browser:${name}:stdout]`, chunk.toString().trim().slice(0, 1200)));
      child.stderr?.on("data", chunk => console.warn(`[remote-browser:${name}:stderr]`, chunk.toString().trim().slice(0, 1200)));
      child.on("error", err => console.error(`[remote-browser:${name}] spawn error:`, err.message));
      child.on("exit", (code, signal) => console.error(`[remote-browser:${name}] exited: code=${code} signal=${signal}`));
    }
    const xvfb = spawn("Xvfb", [":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: ["ignore", "pipe", "pipe"] });
    monitorChild("Xvfb", xvfb);
    setTimeout(() => {
      const vnc = spawn("x11vnc", ["-display", ":99", "-localhost", "-forever", "-shared", "-rfbport", "5900", "-nopw"], { stdio: ["ignore", "pipe", "pipe"] });
      monitorChild("x11vnc", vnc);
      const proxy = spawn("websockify", ["--web", "/usr/share/novnc", "6080", "127.0.0.1:5900"], { stdio: ["ignore", "pipe", "pipe"] });
      monitorChild("websockify", proxy);
    }, 2500);
  });
}
start().catch(err => {
  console.error("Startup error:", err.message);
  app.listen(PORT, "0.0.0.0");
});
