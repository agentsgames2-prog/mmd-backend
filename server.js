/**
 * MMD — MoixMedia Downloader Backend
 * ===========================
 * Node.js + yt-dlp + ffmpeg.
 * The MoixMedia Downloader engine — the MMD frontend
 * (index.html) talks to it with ZERO changes, just point BACKEND at this URL.
 *
 * API:
 *   POST /api/download            {url, quality}  -> {jobId}   (YouTube)
 *   POST /api/facebook/download   {url, quality}  -> {jobId}
 *   POST /api/instagram/download  {url, quality}  -> {jobId}
 *   POST /api/tiktok/download     {url, quality}  -> {jobId}
 *   POST /api/snapchat/download   {url, quality}  -> {jobId}
 *   POST /api/mp3/download        {url, bitrate}  -> {jobId}
 *   GET  /api/progress/{jobId}    -> {progress, status, done, error, fileName, downloadUrl}
 *   GET  /api/file/{jobId}        -> the downloaded file (attachment)
 *   GET  /health                  -> {ok:true}
 *
 * Env vars:
 *   PORT            default 3000
 *   MAX_CONCURRENT  default 3   (simultaneous downloads)
 *   FILE_TTL_MIN    default 60  (downloaded files auto-deleted after N min)
 *   COOKIES_TXT     optional Netscape-format cookies (helps with YouTube blocks)
 *   YTDLP_PROXY     optional proxy URL for yt-dlp
 */

const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "1mb" }));
const PORT = process.env.PORT || 3000;
const DL_DIR = process.env.DL_DIR || path.join(__dirname, "downloads");
/* 🎬 video watermark remover uploads */
const multer = require("multer");
const UP_DIR = path.join(DL_DIR, "uploads");
try { fs.mkdirSync(UP_DIR, { recursive: true }); } catch (e) {}
const upload = multer({ dest: UP_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAX_CONCURRENT || "3", 10));
const FILE_TTL_MS = Math.max(5, parseInt(process.env.FILE_TTL_MIN || "60", 10)) * 60 * 1000;

fs.mkdirSync(DL_DIR, { recursive: true });
// clean stale files from previous runs
for (const f of fs.readdirSync(DL_DIR)) {
  try { fs.unlinkSync(path.join(DL_DIR, f)); } catch (e) {}
}

/* ---------- optional: cookies / proxy (helps beat platform blocks) ---------- */
let COOKIE_FILE = null;
if (process.env.COOKIES_TXT) {
  COOKIE_FILE = path.join("/tmp", "cookies.txt");
  fs.writeFileSync(COOKIE_FILE, process.env.COOKIES_TXT);
  console.log("[init] using cookies file for yt-dlp");
}
const PROXY = process.env.YTDLP_PROXY || null;

function baseArgs() {
  const a = ["--no-playlist", "--newline", "--no-warnings",
             "--socket-timeout", "30", "--retries", "3"];
  if (COOKIE_FILE) a.push("--cookies", COOKIE_FILE);
  if (PROXY) a.push("--proxy", PROXY);
  return a;
}

/* ------------------------------ job store ------------------------------ */
const jobs = new Map();   // jobId -> job object
const queue = [];         // pending tasks
let running = 0;

function newJob(platform) {
  const id = crypto.randomUUID();
  jobs.set(id, {
    platform, progress: 0, status: "Queued…",
    done: false, error: null,
    fileName: null, filePath: null, downloadUrl: null,
    createdAt: Date.now(),
  });
  return id;
}

function enqueue(platform, defMode) {
  return (req, res) => {
    const { url, quality, bitrate } = req.body || {};
    if (!url || !/^https?:\/\/.+\..+/.test(String(url).trim())) {
      return res.status(400).json({ error: "A valid URL is required." });
    }
    const h = parseInt(quality, 10);
    const bm = String((req.body && req.body.mode) || "").toLowerCase();
    const mode = (defMode !== "mp3" && (bm === "post" || bm === "video")) ? bm : defMode; // "video" | "mp3" | "post"
    const bp = String((req.body && req.body.platform) || "").toLowerCase();
    const plat = /^[a-z]+$/.test(bp) ? bp : platform;
    const id = newJob(plat);
    queue.push({
      id,
      url: String(url).trim(),
      quality: Number.isFinite(h) ? h : 1080,
      mode,
      enhance: !!(req.body && req.body.enhance), // ✨ video enhancement
      bitrate: String(bitrate || "192").replace(/[^0-9]/g, "") || "192",
      platform: plat,
    });
    console.log(`[job ${id}] queued (${platform}, ${mode})`);
    processQueue();
    res.json({ jobId: id });
  };
}

function processQueue() {
  while (running < MAX_CONCURRENT && queue.length) {
    const task = queue.shift();
    running++;
    runJob(task).finally(() => { running--; processQueue(); });
  }
}

/* ------------------------------ the work ------------------------------ */

/* ✨ Enhance: denoise + sharpen + gentle color pop (fast, honest cleanup) */
function enhanceVideo(filePath) {
  return new Promise((resolve) => {
    const tmp = filePath + ".enh.mp4";
    const vf = "hqdn3d=1.2:1.2:5:5,unsharp=5:5:0.6:5:5:0.3,eq=contrast=1.03:saturation=1.06";
    let child;
    try {
      child = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
        "-i", filePath, "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "copy", tmp]);
    } catch (e) { return resolve(false); }
    let done = false;
    const finish = (ok) => {
      if (done) return; done = true; clearTimeout(kill);
      if (ok) { try { fs.renameSync(tmp, filePath); } catch (e) { ok = false; } }
      else { try { fs.unlinkSync(tmp); } catch (e) {} }
      resolve(ok);
    };
    const kill = setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} finish(false); }, 15 * 60 * 1000);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

/* YouTube player clients to try in order — datacenter IPs get blocked on
   some clients, so we fall back automatically (fixes most "unavailable" errors). */
const YT_CLIENTS = ["android", "ios", "web_embedded", "web"];
/* permanent failures: retrying with another client will not help */
const PERMANENT_RE = /private video|has been removed|has been deleted|video unavailable|unsupported url|no video formats found/i;

function buildArgs(task, client) {
  const H = task.quality;
  const args = baseArgs();
  args.push("--progress", "-o", path.join(DL_DIR, task.id + ".%(ext)s"));
  if (task.mode === "mp3") {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", task.bitrate + "K",
              "--extractor-args", "youtube:player_client=" + client);
  } else if (task.mode === "post") {
    /* post = whatever the post holds (video or images) */
    args.push("-f", "b",
              "--merge-output-format", "mp4",
              "--concurrent-fragments", "8",
              "--extractor-args", "youtube:player_client=" + client);
  } else {
    args.push("-f", `bv*[height<=${H}]+ba/b[height<=${H}]/b`,
              "--merge-output-format", "mp4",
              "--concurrent-fragments", "8", /* ultra-fast: parallel DASH fragments */
              "--extractor-args", "youtube:player_client=" + client);
  }
  args.push(task.url);
  return args;
}

function attemptDownload(task, job, client) {
  return new Promise((resolve) => {
    const args = buildArgs(task, client);
    job.status = task.mode === "mp3" ? "Extracting audio…" : "Downloading…";
    job.progress = 2;
    console.log(`[job ${task.id}] starting yt-dlp (${task.mode}, <=${task.quality}p, client=${client})`);

    let child;
    try {
      child = spawn("yt-dlp", args);
    } catch (e) {
      return resolve({ ok: false, fatal: true, logTail: "" });
    }

    let logTail = "";
    const onData = (d) => {
      for (const line of d.toString().split("\n")) {
        const m = line.match(/\[download\]\s+(\d{1,3}(?:\.\d+)?)%/);
        if (m) {
          const p = Math.min(99, Math.round(parseFloat(m[1])));
          if (p > job.progress) job.progress = p;
          job.status = (task.mode === "mp3" ? "Downloading audio… " : "Downloading… ") + p + "%";
        } else if (/\[ExtractAudio\]/.test(line)) {
          job.status = "Encoding MP3…";
          job.progress = Math.max(job.progress, 92);
        } else if (/\[Merger\]/.test(line)) {
          job.status = "Merging video + audio…";
          job.progress = Math.max(job.progress, 94);
        }
        if (line.length < 400) {
          logTail += line + "\n";
          if (logTail.length > 4000) logTail = logTail.slice(-4000);
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", () => resolve({ ok: false, fatal: true, logTail }));
    child.on("close", (code) => resolve({ ok: code === 0, fatal: false, logTail }));
  });
}

async function runJob(task) {
  const job = jobs.get(task.id);
  if (!job) return;
  if (task.mode === "thumbnail") return runThumbnail(task);

  let failLog = "";
  let engineMissing = false;
  for (const client of YT_CLIENTS) {
    if (client !== YT_CLIENTS[0]) {
      job.status = `Retrying with alternate method…`;
      job.progress = Math.max(job.progress, 2);
      console.log(`[job ${task.id}] retrying with player_client=${client}`);
    }
    const r = await attemptDownload(task, job, client);
    if (r.ok) { failLog = ""; break; }
    if (r.fatal) { engineMissing = true; break; }
    failLog = r.logTail;
    if (PERMANENT_RE.test(r.logTail)) break; /* no point retrying */
  }

  if (engineMissing) {
    job.done = true;
    job.error = "Downloader engine (yt-dlp) is not installed on the server.";
    return;
  }
  if (failLog) {
    job.done = true;
    job.error = friendlyError(failLog);
    console.log(`[job ${task.id}] failed: ${job.error}`);
    return;
  }
  let files = [];
  try { files = fs.readdirSync(DL_DIR).filter((f) => f.startsWith(task.id)); } catch (e) {}
  if (!files.length) {
    job.done = true;
    job.error = "Download finished but no file was produced.";
    return;
  }
  let filePath;
  if (files.length === 1) {
    filePath = path.join(DL_DIR, files[0]);
  } else {
    /* carousel / multi-image post -> zip everything */
    job.status = "Packing post media…";
    const zipPath = path.join(DL_DIR, task.id + ".zip");
    let zok = false;
    try { zok = await zipFiles(files.map((f) => path.join(DL_DIR, f)), zipPath); } catch (e) { zok = false; }
    if (!zok) {
      job.done = true;
      job.error = "Could not package the post media.";
      return;
    }
    for (const f of files) { try { fs.unlinkSync(path.join(DL_DIR, f)); } catch (e) {} }
    files = [task.id + ".zip"];
    filePath = zipPath;
  }
  if (task.enhance && task.mode === "video") {
    job.status = "Enhancing video… ✨";
    job.progress = Math.max(job.progress, 96);
    const ok = await enhanceVideo(filePath);
    console.log(`[job ${task.id}] enhance ${ok ? "done ✨" : "skipped (kept original)"}`);
  }
  const ext = (path.extname(files[0]).slice(1) || (task.mode === "mp3" ? "mp3" : "mp4")).toLowerCase();
  const title = await getTitle(task.url);
  job.description = await getDescription(task.url);
  const safe = (title || task.platform || "video")
    .replace(/[^\p{L}\p{N}\- ]+/gu, "").trim().slice(0, 60) || "video";
  job.fileName = `${safe} [MMD].${ext}`;
  job.filePath = filePath;
  job.progress = 100;
  job.status = "Done!";
  job.done = true;
  console.log(`[job ${task.id}] done -> ${job.fileName}`);
}

/* download a remote file (follows redirects) */
function fetchFile(url, dest, redirs) {
  redirs = redirs == null ? 5 : redirs;
  return new Promise((resolve) => {
    if (redirs < 0) return resolve(false);
    const lib = url.startsWith("https") ? require("https") : require("http");
    let req;
    try {
      req = lib.get(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return resolve(fetchFile(new URL(res.headers.location, url).toString(), dest, redirs - 1));
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(false); }
        const ws = fs.createWriteStream(dest);
        res.pipe(ws);
        ws.on("finish", () => ws.close(() => {
          try { resolve(fs.statSync(dest).size > 0); } catch (e) { resolve(false); }
        }));
        ws.on("error", () => resolve(false));
      });
    } catch (e) { return resolve(false); }
    req.on("error", () => resolve(false));
    req.setTimeout(25000, () => { try { req.destroy(); } catch (e) {} resolve(false); });
  });
}

/* zip multiple files into one */
function zipFiles(srcs, dest) {
  return new Promise((resolve) => {
    let arcMod;
    try { arcMod = require("archiver"); } catch (e) { return resolve(false); }
    let arc;
    try {
      /* archiver v6/v7: callable factory; v8+: { ZipArchive } class export */
      const factory = (typeof arcMod === "function") ? arcMod : (arcMod && arcMod.default);
      arc = factory
        ? factory("zip", { zlib: { level: 9 } })
        : new arcMod.ZipArchive({ zlib: { level: 9 } });
    } catch (e) { return resolve(false); }
    const out = fs.createWriteStream(dest);
    let done = false;
    const fin = (ok) => { if (!done) { done = true; resolve(ok); } };
    out.on("close", () => fin(true));
    out.on("error", () => fin(false));
    arc.on("error", () => fin(false));
    arc.pipe(out);
    srcs.forEach((s, i) => arc.file(s, { name: "media-" + (i + 1) + path.extname(s) }));
    arc.finalize();
  });
}

/* 🖼 thumbnail job: fetch best thumbnail, save it, serve it */
async function runThumbnail(task) {
  const job = jobs.get(task.id);
  if (!job) return;
  job.status = "Fetching thumbnail…";
  job.progress = 10;
  const turl = await new Promise((resolve) => {
    let child, done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      child = spawn("yt-dlp", [...baseArgs(), "--skip-download",
        "--extractor-args", "youtube:player_client=android",
        "--print", "%(thumbnail)s", "--socket-timeout", "20", task.url]);
    } catch (e) { return fin(null); }
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", () => fin(null));
    child.on("close", (code) => {
      const lines = out.trim().split("\n").map((s) => s.trim()).filter(Boolean);
      const last = lines[lines.length - 1];
      fin(code === 0 && last && /^https?:\/\//.test(last) ? last : null);
    });
    setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} fin(null); }, 30000);
  });
  if (!turl) {
    job.done = true;
    job.error = "Could not find a thumbnail for this link.";
    return;
  }
  job.status = "Downloading thumbnail…";
  job.progress = 60;
  const mExt = turl.split("?")[0].match(/\.([a-z]{3,4})$/i);
  const ext = ((mExt && mExt[1]) || "jpg").toLowerCase();
  const dest = path.join(DL_DIR, task.id + "." + ext);
  const ok = await fetchFile(turl, dest);
  if (!ok) {
    job.done = true;
    job.error = "Could not download the thumbnail.";
    return;
  }
  const title = await getTitle(task.url);
  const safe = (title || task.platform || "thumbnail").replace(/[^\p{L}\p{N}\- ]+/gu, "").trim().slice(0, 60) || "thumbnail";
  job.fileName = `${safe} [MMD]-thumbnail.${ext}`;
  job.filePath = dest;
  job.progress = 100;
  job.status = "Done!";
  job.done = true;
  console.log(`[job ${task.id}] thumbnail done -> ${job.fileName}`);
}

function friendlyError(log) {
  const L = log.toLowerCase();
  if (/unsupported url/.test(L)) return "This link is not supported.";
  if (/private video|login required|log in/.test(L)) return "This video is private or needs login.";
  if (/confirm your age|age-restricted|age gated/.test(L)) return "This video is age-restricted and needs a logged-in account.";
  if (/video unavailable|has been removed|deleted/.test(L)) return "This video is unavailable or was removed.";
  if (/http error 403|forbidden/.test(L)) return "The platform blocked this download. Try again later.";
  if (/http error 429|too many requests/.test(L)) return "Rate-limited by the platform. Try again in a few minutes.";
  if (/timed out/.test(L)) return "Connection timed out. Try again.";
  if (/no video formats found/.test(L)) return "No downloadable media found at this link.";
  return "Download failed. The link may be private, removed, or blocked by the platform.";
}

function getTitle(url) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("yt-dlp", [...baseArgs(), "--extractor-args", "youtube:player_client=android", "--print", "%(title)s", "--socket-timeout", "15", url]);
    } catch (e) { return resolve(null); }
    let out = "";
    const kill = setTimeout(() => { try { child.kill(); } catch (e) {} resolve(null); }, 20000);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", () => { clearTimeout(kill); resolve(null); });
    child.on("close", () => { clearTimeout(kill); resolve(out.trim().split("\n")[0] || null); });
  });
}

function getDescription(url) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("yt-dlp", [...baseArgs(), "--extractor-args", "youtube:player_client=android", "--print", "%(description)s", "--socket-timeout", "15", url]);
    } catch (e) { return resolve(null); }
    let out = "";
    const kill = setTimeout(() => { try { child.kill(); } catch (e) {} resolve(null); }, 20000);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", () => { clearTimeout(kill); resolve(null); });
    child.on("close", () => {
      clearTimeout(kill);
      const t = out.trim();
      resolve(t && t !== "NA" ? t.slice(0, 4000) : null);
    });
  });
}

/* -------------------------------- routes -------------------------------- */
app.get("/", (req, res) =>
  res.json({ ok: true, service: "mmd-downloader", jobs: jobs.size, queued: queue.length, running }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/api/download", enqueue("youtube", "video"));
app.post("/api/facebook/download", enqueue("facebook", "video"));
app.post("/api/instagram/download", enqueue("instagram", "video"));
app.post("/api/tiktok/download", enqueue("tiktok", "video"));
app.post("/api/snapchat/download", enqueue("snapchat", "video"));
app.post("/api/mp3/download", enqueue("mp3", "mp3"));

/* 🖼 thumbnail: fetch best thumbnail image (no video download) */
app.post("/api/thumbnail", (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\/.+\..+/.test(String(url).trim())) {
    return res.status(400).json({ error: "A valid URL is required." });
  }
  const bp = String((req.body && req.body.platform) || "").toLowerCase();
  const plat = /^[a-z]+$/.test(bp) ? bp : "thumbnail";
  const id = newJob(plat);
  queue.push({ id, url: String(url).trim(), quality: 0, mode: "thumbnail", enhance: false, bitrate: "192", platform: plat });
  console.log(`[job ${id}] queued (thumbnail)`);
  processQueue();
  res.json({ jobId: id });
});

/* 📃 playlist: list videos (flat, max 50) */
app.post("/api/playlist", (req, res) => {
  const { url } = req.body || {};
  if (!url || !/^https?:\/\/.+\..+/.test(String(url).trim())) {
    return res.status(400).json({ error: "A valid URL is required." });
  }
  const u = String(url).trim();
  const args = ["--flat-playlist", "--no-warnings", "--socket-timeout", "30",
    "--extractor-args", "youtube:player_client=android",
    "--print", "%(id)s\t%(title)s\t%(webpage_url)s",
    "--playlist-end", "50", u];
  if (COOKIE_FILE) args.unshift("--cookies", COOKIE_FILE);
  if (PROXY) args.unshift("--proxy", PROXY);
  let child;
  try { child = spawn("yt-dlp", args); }
  catch (e) { return res.status(500).json({ error: "Downloader engine is not installed on the server." }); }
  let out = "", errOut = "", done = false;
  const fin = (ok) => {
    if (done) return; done = true;
    if (!ok) return res.status(422).json({ error: "No playlist found at this link." });
    const items = [];
    for (const line of out.split("\n")) {
      const p = line.split("\t");
      if (p.length >= 3 && p[0] && p[2] && /^https?:\/\//.test(p[2])) {
        items.push({ id: p[0].trim(), title: (p[1] || "Untitled").trim(), url: p[2].trim() });
      }
    }
    if (!items.length) return res.status(422).json({ error: "No videos found in this playlist." });
    res.json({ items, count: items.length });
  };
  child.stdout.on("data", (d) => { out += d.toString(); if (out.length > 200000) out = out.slice(-200000); });
  child.stderr.on("data", (d) => { errOut += d.toString(); });
  child.on("error", () => fin(false));
  child.on("close", (code) => fin(code === 0));
  setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} fin(false); }, 60000);
});

/* ------------------------------ caption extractor ------------------------------ */
app.post("/api/caption", (req, res) => {
  (async () => {
    const url = (req.body && req.body.url || "").trim();
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: "Valid video link required." });
    const desc = await getDescription(url);
    if (!desc) return res.status(404).json({ error: "Caption not found \u2014 is the link public?" });
    const title = await getTitle(url);
    res.json({ title: title || null, description: desc });
  })().catch(() => res.status(500).json({ error: "Server error." }));
});

app.get("/api/progress/:jobId", (req, res) => {
  const j = jobs.get(req.params.jobId);
  if (!j) return res.status(404).json({ error: "Job not found.", done: true });
  let downloadUrl = null;
  if (j.done && !j.error && j.filePath && fs.existsSync(j.filePath)) {
    downloadUrl = `${req.protocol}://${req.get("host")}/api/file/${req.params.jobId}`;
  }
  res.json({
    progress: j.progress, status: j.status, done: j.done,
    error: j.error, fileName: j.fileName, downloadUrl,
    description: j.description || null,
  });
});

/* ------------------------------ video watermark remover ------------------------------ */
app.post("/api/delogo", upload.single("video"), (req, res) => {
  (async () => {
    try {
      if (!req.file) return res.status(400).json({ error: "no video uploaded" });
      const x = Math.max(0, parseInt(req.body.x) || 0);
      const y = Math.max(0, parseInt(req.body.y) || 0);
      const w = Math.max(8, parseInt(req.body.w) || 120);
      const h = Math.max(8, parseInt(req.body.h) || 40);
      const inP = req.file.path;
      const outP = path.join(DL_DIR, `nowm_${Date.now()}.mp4`);
      await new Promise((resolve, reject) => {
        const child = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
          "-i", inP, "-vf", `delogo=x=${x}:y=${y}:w=${w}:h=${h}:show=0`,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", outP]);
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error("ffmpeg " + code)));
      });
      fs.unlink(inP, () => {});
      setTimeout(() => fs.unlink(outP, () => {}), 30 * 60 * 1000);
      res.download(outP, "video-no-watermark [MMD].mp4");
    } catch (e) {
      console.error("[delogo]", e.message);
      if (!res.headersSent) res.status(500).json({ error: "watermark remove failed" });
    }
  })();
});

/* ------------------------------ audio/video cutter ------------------------------ */
app.post("/api/trim", upload.single("media"), (req, res) => {
  (async () => {
    try {
      if (!req.file) return res.status(400).json({ error: "no file uploaded" });
      const kind = req.body.kind === "video" ? "video" : "audio";
      const start = Math.max(0, parseFloat(req.body.start) || 0);
      let end = Math.max(0, parseFloat(req.body.end) || 0);
      if (!(end > start)) return res.status(400).json({ error: "bad range" });
      const dur = Math.min(end - start, 3 * 3600); // max 3h clip
      const inP = req.file.path;
      const ext = kind === "video" ? "mp4" : "mp3";
      const outP = path.join(DL_DIR, `cut_${Date.now()}.${ext}`);
      const args = ["-y", "-hide_banner", "-loglevel", "error",
        "-ss", String(start), "-t", String(dur), "-i", inP];
      if (kind === "video") args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac");
      else args.push("-c:a", "libmp3lame", "-q:a", "4");
      args.push(outP);
      await new Promise((resolve, reject) => {
        const child = spawn("ffmpeg", args);
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error("ffmpeg " + code)));
      });
      fs.unlink(inP, () => {});
      setTimeout(() => fs.unlink(outP, () => {}), 30 * 60 * 1000);
      res.download(outP, `cut [MMD].${ext}`);
    } catch (e) {
      console.error("[trim]", e.message);
      if (!res.headersSent) res.status(500).json({ error: "cut failed" });
    }
  })();
});

app.get("/api/file/:jobId", (req, res) => {
  const j = jobs.get(req.params.jobId);
  if (!j || !j.done || j.error || !j.filePath || !fs.existsSync(j.filePath)) {
    return res.status(404).send("File not found or expired.");
  }
  res.download(j.filePath, j.fileName || "mmd-download", () => {});
});

/* --------------------------- auto-cleanup --------------------------- */
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > FILE_TTL_MS) {
      try { if (job.filePath && fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath); } catch (e) {}
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e && e.message));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e && e.message));
app.listen(PORT, () => {
  console.log(`MMD downloader listening on :${PORT} (max ${MAX_CONCURRENT} concurrent)`);
});
