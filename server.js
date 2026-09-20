/**
 * ToolKiva Downloader Backend
 * ===========================
 * Node.js + yt-dlp + ffmpeg.
 * Drop-in replacement for the old Railway backend — the ToolKiva frontend
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

function enqueue(platform, mode) {
  return (req, res) => {
    const { url, quality, bitrate } = req.body || {};
    if (!url || !/^https?:\/\/.+\..+/.test(String(url).trim())) {
      return res.status(400).json({ error: "A valid URL is required." });
    }
    const h = parseInt(quality, 10);
    const id = newJob(platform);
    queue.push({
      id,
      url: String(url).trim(),
      quality: Number.isFinite(h) ? h : 1080,
      mode, // "video" | "mp3"
      bitrate: String(bitrate || "192").replace(/[^0-9]/g, "") || "192",
      platform,
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
function runJob(task) {
  return new Promise((resolve) => {
    const job = jobs.get(task.id);
    if (!job) return resolve();

    const H = task.quality;
    const args = baseArgs();
    args.push("--progress", "-o", path.join(DL_DIR, task.id + ".%(ext)s"));

    if (task.mode === "mp3") {
      args.push("-x", "--audio-format", "mp3", "--audio-quality", task.bitrate + "K");
    } else {
      args.push("-f", `bv*[height<=${H}]+ba/b[height<=${H}]/b`,
                "--merge-output-format", "mp4",
                "--extractor-args", "youtube:player_client=android");
    }
    args.push(task.url);

    job.status = task.mode === "mp3" ? "Extracting audio…" : "Downloading…";
    job.progress = 2;
    console.log(`[job ${task.id}] starting yt-dlp (${task.mode}, <=${H}p)`);

    let child;
    try {
      child = spawn("yt-dlp", args);
    } catch (e) {
      job.done = true;
      job.error = "Downloader engine (yt-dlp) is not installed on the server.";
      return resolve();
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
    child.on("error", () => {
      job.done = true;
      job.error = "Could not start the downloader engine.";
      resolve();
    });
    child.on("close", async (code) => {
      if (code !== 0) {
        job.done = true;
        job.error = friendlyError(logTail);
        console.log(`[job ${task.id}] failed: ${job.error}`);
        return resolve();
      }
      let files = [];
      try { files = fs.readdirSync(DL_DIR).filter((f) => f.startsWith(task.id + ".")); } catch (e) {}
      if (!files.length) {
        job.done = true;
        job.error = "Download finished but no file was produced.";
        return resolve();
      }
      const filePath = path.join(DL_DIR, files[0]);
      const ext = (path.extname(files[0]).slice(1) || (task.mode === "mp3" ? "mp3" : "mp4")).toLowerCase();
      const title = await getTitle(task.url);
      const safe = (title || task.platform || "video")
        .replace(/[^\p{L}\p{N}\- ]+/gu, "").trim().slice(0, 60) || "video";
      job.fileName = `${safe} [MMD].${ext}`;
      job.filePath = filePath;
      job.progress = 100;
      job.status = "Done!";
      job.done = true;
      console.log(`[job ${task.id}] done -> ${job.fileName}`);
      resolve();
    });
  });
}

function friendlyError(log) {
  const L = log.toLowerCase();
  if (/unsupported url/.test(L)) return "This link is not supported.";
  if (/private video|login required|log in/.test(L)) return "This video is private or needs login.";
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
      child = spawn("yt-dlp", [...baseArgs(), "--print", "%(title)s", "--socket-timeout", "15", url]);
    } catch (e) { return resolve(null); }
    let out = "";
    const kill = setTimeout(() => { try { child.kill(); } catch (e) {} resolve(null); }, 20000);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("error", () => { clearTimeout(kill); resolve(null); });
    child.on("close", () => { clearTimeout(kill); resolve(out.trim().split("\n")[0] || null); });
  });
}

/* -------------------------------- routes -------------------------------- */
app.get("/", (req, res) =>
  res.json({ ok: true, service: "toolkiva-downloader", jobs: jobs.size, queued: queue.length, running }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/api/download", enqueue("youtube", "video"));
app.post("/api/facebook/download", enqueue("facebook", "video"));
app.post("/api/instagram/download", enqueue("instagram", "video"));
app.post("/api/tiktok/download", enqueue("tiktok", "video"));
app.post("/api/snapchat/download", enqueue("snapchat", "video"));
app.post("/api/mp3/download", enqueue("mp3", "mp3"));

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
  });
});

app.get("/api/file/:jobId", (req, res) => {
  const j = jobs.get(req.params.jobId);
  if (!j || !j.done || j.error || !j.filePath || !fs.existsSync(j.filePath)) {
    return res.status(404).send("File not found or expired.");
  }
  res.download(j.filePath, j.fileName || "toolkiva-download", () => {});
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

app.listen(PORT, () => {
  console.log(`ToolKiva downloader listening on :${PORT} (max ${MAX_CONCURRENT} concurrent)`);
});
