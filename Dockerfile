# Node 20 + system yt-dlp + ffmpeg
FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg curl ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages -U yt-dlp \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* \
 && yt-dlp --version && ffmpeg -version | head -1

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p downloads

EXPOSE 3000
CMD ["node", "server.js"]
