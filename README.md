# ToolKiva Downloader Backend 🚀

Apna khud ka video downloader backend — **Node.js + yt-dlp + ffmpeg**.
Tumhari ToolKiva site ke saath 100% compatible: sirf site mein ek line badlo, bas.

## Kya karta hai

- YouTube / TikTok / Instagram / Facebook / Snapchat se video download (720p se **8K** tak)
- Kisi bhi video se **MP3** extract (128–320 kbps)
- Job system: `POST` karo → `jobId` milta hai → `/api/progress/{jobId}` par progress dekho → `/api/file/{jobId}` se file download

## Local mein chalana

Pehle system par `yt-dlp` aur `ffmpeg` install karo:

```bash
# Ubuntu/Debian
sudo apt install ffmpeg
pip3 install -U yt-dlp

# macOS
brew install yt-dlp ffmpeg
```

Phir:

```bash
cd backend
npm install
npm start
# → http://localhost:3000
```

## Railway par deploy (recommended)

1. Railway → **New Project** → **Deploy from GitHub repo** (ye `backend/` folder wala repo push karo)
   - Ya: `railway init` + `railway up` (Railway CLI se, Dockerfile auto-detect hoga)
2. Deploy ke baad tumhein URL milega, misal: `https://toolkiva-dl-production.up.railway.app`
3. Test karo: `https://tumhara-url.up.railway.app/health` → `{"ok":true}` aana chahiye

> Railway Dockerfile automatically detect kar lega — kuch configure karne ki zaroorat nahi.

## Site se connect karna (1 line!)

`index.html` mein ye line dhoondo:

```js
const BACKEND = "https://toolkivo-production.up.railway.app";
```

Apne naye backend ka URL likh do:

```js
const BACKEND = "https://tumhara-url.up.railway.app";
```

Ho gaya! 🎉 Ab downloads tumhare apne server se honge.

## Environment variables (optional)

| Variable | Default | Kaam |
|---|---|---|
| `PORT` | `3000` | Server port (Railway khud set karta hai) |
| `MAX_CONCURRENT` | `3` | Ek saath kitne downloads (server halka ho to `2` rakho) |
| `FILE_TTL_MIN` | `60` | Files kitne minute baad auto-delete hon |
| `COOKIES_TXT` | — | YouTube block kare to browser cookies (Netscape format) yahan paste karo |
| `YTDLP_PROXY` | — | Agar proxy chahiye to, misal `http://user:pass@host:port` |

### YouTube cookies kaise nikalein?

1. Chrome mein **"Get cookies.txt LOCALLY"** extension install karo
2. youtube.com kholo (logged in), extension se cookies export karo
3. File ka content copy karke Railway → Variables → `COOKIES_TXT` mein paste karo
4. Redeploy — YouTube blocks khatam!

## API reference

| Method | Endpoint | Body | Response |
|---|---|---|---|
| POST | `/api/download` | `{url, quality}` | `{jobId}` |
| POST | `/api/facebook/download` | `{url, quality}` | `{jobId}` |
| POST | `/api/instagram/download` | `{url, quality}` | `{jobId}` |
| POST | `/api/tiktok/download` | `{url, quality}` | `{jobId}` |
| POST | `/api/snapchat/download` | `{url, quality}` | `{jobId}` |
| POST | `/api/mp3/download` | `{url, bitrate}` | `{jobId}` |
| GET | `/api/progress/{jobId}` | — | `{progress, status, done, error, fileName, downloadUrl}` |
| GET | `/api/file/{jobId}` | — | file download |
| GET | `/health` | — | `{ok:true}` |

`quality`: `"360"`, `"720"`, `"1080"`, `"1440"`, `"2160"`, `"4320"` (8K)

## Zaroori notes

- **Ek waqt mein 2–3 downloads** rakho — video downloading CPU/network heavy hota hai
- Files **auto-delete** hoti hain (default 60 min) — storage full nahi hoga
- Sirf wohi content download karo jiska tumhein **haq** ho — copyright ka khayal rakho 💜
