const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "ibra-google-flow-bridge-private";
const PROFILE_NAME = process.env.GFLOW_PROFILE || "default";
const PROFILE_ROOT = path.join(process.env.HOME || "/home/node", ".gflow", "profiles");
const PROFILE_DIR = path.join(PROFILE_ROOT, PROFILE_NAME);
const MAX_OBJECT_BYTES = 50 * 1024 * 1024;

function configured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function objectUrl(objectPath) {
  const safePath = objectPath.split("/").map(encodeURIComponent).join("/");
  return process.env.SUPABASE_URL.replace(/\/$/, "") + "/storage/v1/object/" + BUCKET + "/" + safePath;
}

async function requestStorage(method, objectPath, body, contentType) {
  if (!configured()) throw new Error("Supabase Storage non configuré: ajouter SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY dans Render.");
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  if (contentType) headers["Content-Type"] = contentType;
  if (method === "POST" || method === "PUT") headers["x-upsert"] = "true";
  const response = await fetch(objectUrl(objectPath), { method, headers, body });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    if (response.status === 404) return null;
    throw new Error("Supabase Storage HTTP " + response.status + ": " + detail);
  }
  return response;
}

async function restoreProfile() {
  if (!configured()) return { enabled: false, restored: false, reason: "secrets_missing" };
  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
  const response = await requestStorage("GET", "profile/" + PROFILE_NAME + ".tar.gz");
  if (!response) return { enabled: true, restored: false, reason: "no_backup_yet" };
  const archive = path.join(os.tmpdir(), "ibra-flow-profile-restore.tar.gz");
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  try {
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
    const result = spawnSync("tar", ["-xzf", archive, "-C", PROFILE_ROOT], { encoding: "utf8" });
    if (result.status !== 0) throw new Error((result.stderr || "tar extraction failed").slice(0, 500));
    return { enabled: true, restored: true, reason: "backup_restored" };
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

async function backupProfile() {
  if (!configured() || !fs.existsSync(PROFILE_DIR)) return { saved: false, reason: configured() ? "profile_missing" : "secrets_missing" };
  const archive = path.join(os.tmpdir(), "ibra-flow-profile-backup.tar.gz");
  try {
    const result = spawnSync("tar", [
      "-czf", archive,
      "--exclude=Cache", "--exclude=Code Cache", "--exclude=GPUCache",
      "--exclude=GrShaderCache", "--exclude=ShaderCache", "--exclude=Crashpad",
      "-C", PROFILE_ROOT, PROFILE_NAME
    ], { encoding: "utf8" });
    if (result.status !== 0) throw new Error((result.stderr || "tar archive failed").slice(0, 500));
    const stat = fs.statSync(archive);
    if (stat.size > MAX_OBJECT_BYTES) throw new Error("Archive du profil trop grande pour la limite du bucket (50 Mo).");
    const body = fs.readFileSync(archive);
    await requestStorage("POST", "profile/" + PROFILE_NAME + ".tar.gz", body, "application/gzip");
    return { saved: true, bytes: stat.size };
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

async function uploadVideo(filePath, jobId) {
  if (!configured()) return { saved: false, reason: "secrets_missing" };
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_OBJECT_BYTES) return { saved: false, reason: "video_over_50mb", bytes: stat.size };
  await requestStorage("POST", "videos/" + jobId + ".mp4", fs.readFileSync(filePath), "video/mp4");
  return { saved: true, path: "videos/" + jobId + ".mp4", bytes: stat.size };
}

async function downloadVideo(objectPath) {
  const response = await requestStorage("GET", objectPath);
  if (!response) return null;
  return Buffer.from(await response.arrayBuffer());
}

module.exports = { configured, restoreProfile, backupProfile, uploadVideo, downloadVideo };
