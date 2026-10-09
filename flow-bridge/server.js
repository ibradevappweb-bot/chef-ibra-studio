const express = require("express");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
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
  app.listen(PORT, "0.0.0.0", () => {
    console.log("IBRA Google Flow Bridge listening on port " + PORT);
  });
}
start().catch(err => {
  console.error("Startup error:", err.message);
  app.listen(PORT, "0.0.0.0");
});
