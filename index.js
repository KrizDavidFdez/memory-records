const fs = require("fs");
const path = require("path");
const axios = require("axios");

class HentaiLaDownloader {
  constructor(options = {}) {
    this.BASE = "https://cdn.hvidserv.com";
    this.concurrency = options.concurrency || 8;
    this.timeout = options.timeout || 30000;

    this.HEADERS = {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
      Accept: "",
      "Accept-Language": "es-419,es;q=0.9",
      "Accept-Encoding": "identity",
      Origin: this.BASE,
      Referer: `${this.BASE}/`,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124"',
      "sec-ch-ua-mobile": "?1",
      "sec-ch-ua-platform": '"Android"',
      Connection: "keep-alive",
      ...(options.headers || {}),
    };
  }

  formatDate(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    return `${mm}/${dd}/${yy}`;
  }

  formatTitle(slug = "") {
    return String(slug)
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .replace(/\b\w/g, (l) => l.toUpperCase());
  }

  extractId(input) {
    const m = String(input).match(/([a-f0-9]{32})/i);
    return m[1];
  }

  sanitizeFileName(name = "video") {
    return name
      .replace(/[\/:*?"<>|]/g, "")
      .replace(/\s+/g, "_")
      .trim();
  }

  async fetchBuf(url, headers = this.HEADERS) {
    const res = await fetch(url, { headers });
    return Buffer.from(await res.arrayBuffer());
  }

  read32(buf, off) {
    return buf.readUInt32BE(off);
  }

  write32(buf, off, val) {
    buf.writeUInt32BE(val >>> 0, off);
  }

  write64(buf, off, hi, lo) {
    buf.writeUInt32BE(hi >>> 0, off);
    buf.writeUInt32BE(lo >>> 0, off + 4);
  }

  findBox(buf, type, start = 0, end = buf.length) {
    let i = start;
    while (i + 8 <= end) {
      const size = this.read32(buf, i);
      const name = buf.slice(i + 4, i + 8).toString("ascii");
      if (name === type) return { offset: i, size };
      i += Math.max(size, 8);
    }
    return null;
  }

  patchDuration(initBuf, totalSeconds) {
    const buf = Buffer.from(initBuf);

    const moov = this.findBox(buf, "moov");
    if (!moov) return buf;

    const moovEnd = moov.offset + moov.size;

    const mvhd = this.findBox(buf, "mvhd", moov.offset + 8, moovEnd);
    if (mvhd) {
      const version = buf[mvhd.offset + 8];
      let timescale, durationOff;

      if (version === 1) {
        timescale = this.read32(buf, mvhd.offset + 8 + 1 + 3 + 16);
        durationOff = mvhd.offset + 8 + 1 + 3 + 20;
        const durationUnits = Math.round(totalSeconds * timescale);
        this.write64(
          buf,
          durationOff,
          Math.floor(durationUnits / 0x100000000),
          durationUnits >>> 0
        );
      } else {
        timescale = this.read32(buf, mvhd.offset + 8 + 1 + 3 + 8);
        durationOff = mvhd.offset + 8 + 1 + 3 + 12;
        const durationUnits = Math.round(totalSeconds * timescale);
        this.write32(buf, durationOff, durationUnits);
      }
    }

    let search = moov.offset + 8;
    while (search < moovEnd) {
      const trak = this.findBox(buf, "trak", search, moovEnd);
      if (!trak) break;

      const trakEnd = trak.offset + trak.size;
      const tkhd = this.findBox(buf, "tkhd", trak.offset + 8, trakEnd);

      if (tkhd) {
        const version = buf[tkhd.offset + 8];

        const mdia = this.findBox(buf, "mdia", trak.offset + 8, trakEnd);
        if (mdia) {
          const mdhd = this.findBox(
            buf,
            "mdhd",
            mdia.offset + 8,
            mdia.offset + mdia.size
          );

          if (mdhd) {
            const mdhdV = buf[mdhd.offset + 8];
            let timescale = 1;

            if (mdhdV === 1) {
              timescale = this.read32(buf, mdhd.offset + 8 + 1 + 3 + 16);
            } else {
              timescale = this.read32(buf, mdhd.offset + 8 + 1 + 3 + 8);
            }

            const mdhdDurUnits = Math.round(totalSeconds * timescale);

            if (mdhdV === 1) {
              this.write64(
                buf,
                mdhd.offset + 8 + 1 + 3 + 20,
                Math.floor(mdhdDurUnits / 0x100000000),
                mdhdDurUnits >>> 0
              );
            } else {
              this.write32(buf, mdhd.offset + 8 + 1 + 3 + 12, mdhdDurUnits);
            }
          }
        }

        if (mvhd) {
          const mvhdV = buf[mvhd.offset + 8];
          let movieTS =
            mvhdV === 1
              ? this.read32(buf, mvhd.offset + 28)
              : this.read32(buf, mvhd.offset + 20);

          const units = Math.round(totalSeconds * movieTS);

          if (version === 1) {
            this.write64(
              buf,
              tkhd.offset + 8 + 1 + 3 + 24,
              Math.floor(units / 0x100000000),
              units >>> 0
            );
          } else {
            this.write32(buf, tkhd.offset + 8 + 1 + 3 + 16, units);
          }
        }
      }

      search = trak.offset + trak.size;
    }

    return buf;
  }

  async getPlaylist(videoId) {
    const url = `${this.BASE}/m3u8/${videoId}`;
    const res = await fetch(url, { headers: this.HEADERS });
    const text = await res.text();

    let initUrl = null;
    const segments = [];
    let pendingDuration = null;

    for (const raw of text.split("\n")) {
      const line = raw.trim();

      if (line.startsWith("#EXT-X-MAP:URI=")) {
        initUrl = line.match(/URI="([^"]+)"/)?.[1] || null;
      } else if (line.startsWith("#EXTINF:")) {
        pendingDuration = parseFloat(line.slice(8));
      } else if (line.startsWith("http")) {
        segments.push({ url: line, duration: pendingDuration || 0 });
        pendingDuration = null;
      }
    }

    const totalSeconds = segments.reduce((s, seg) => s + seg.duration, 0);
    return { initUrl, segments, totalSeconds };
  }

  async downloadAll(urls, concurrency = this.concurrency) {
    const results = new Array(urls.length);
    let idx = 0;

    async function worker(ctx) {
      while (idx < urls.length) {
        const i = idx++;
        results[i] = await ctx.fetchBuf(urls[i].url || urls[i]);
      }
    }

    const workers = Array.from({ length: concurrency }, () => worker(this));
    await Promise.all(workers);
    return results;
  }

  async scrape(url) {
    try {
      const cleanUrl = url.replace(/\/+$/, "");
      const parts = cleanUrl.split("/");
      const episode = Number(parts[parts.length - 1]) || null;
      const slugIndex = parts.findIndex((v) => v === "media");
      const rawTitle = slugIndex !== -1 ? parts[slugIndex + 1] : null;
      const title = this.formatTitle(rawTitle);
      const dataUrl = `${cleanUrl}/__data.json?x-sveltekit-invalidated=0001`;

      const { data: json } = await axios.get(dataUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json,text/plain",
          Referer: cleanUrl,
        },
        timeout: this.timeout,
      });

      const dataNode = json?.nodes?.find((v) => v?.type === "data");
      const arr = dataNode?.data || [];

      const resolve = (value, seen = new WeakSet()) => {
        if (typeof value === "number") {
          if (value === -1) return null;
          if (value >= 0 && value < arr.length) return resolve(arr[value], seen);
          return value;
        }
        if (Array.isArray(value)) return value.map((v) => resolve(v, seen));
        if (value && typeof value === "object") {
          if (seen.has(value)) return value;
          seen.add(value);
          const out = {};
          for (const [k, v] of Object.entries(value)) out[k] = resolve(v, seen);
          return out;
        }
        return value;
      };

      const resolved = arr.map((v) => {
        try { return resolve(v); } catch { return v; }
      });

      const episodeObj =
        resolved.find(
          (v) =>
            v &&
            typeof v === "object" &&
            (v.id || v.episodeNumber || v.publishedAt || v.filler !== undefined)
        ) || {};

      const embedsObj =
        resolved.find(
          (v) =>
            v &&
            typeof v === "object" &&
            (Array.isArray(v.SUB) || Array.isArray(v.DUB) || Array.isArray(v.RAW))
        ) || {};

      const downloadsObj =
        resolved.find(
          (v) =>
            v &&
            typeof v === "object" &&
            (Array.isArray(v.SUB) || Array.isArray(v.DUB) || Array.isArray(v.RAW)) &&
            JSON.stringify(v).includes("server")
        ) || {};

      const getHvidData = (playUrl) => {
        const id = playUrl?.match(/\/play\/([a-f0-9]+)/i)?.[1] || null;
        return {
          id,
          play: playUrl || null,
          m3u8: id ? `https://cdn.hvidserv.com/m3u8/${id}` : null,
          embed: id ? `https://hvidserv.com/embed/${id}` : null,
        };
      };

      const dedupeByUrl = (items = []) => {
        const seen = new Set();
        return items.filter((item) => {
          const key = item?.url || item?.play || item?.m3u8;
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      };

      const normalizeMirrors = (mirrorRefs) => {
        if (!Array.isArray(mirrorRefs)) return [];
        return dedupeByUrl(
          mirrorRefs
            .map((m) => resolve(m))
            .filter((v) => v && typeof v === "object" && v.server && v.url)
            .map((v) => ({ server: v.server || null, ...getHvidData(v.url) }))
        );
      };

      const normalizeDownloads = (downloadRefs) => {
        if (!Array.isArray(downloadRefs)) return [];
        return dedupeByUrl(
          downloadRefs
            .map((d) => resolve(d))
            .filter((v) => v && typeof v === "object" && v.server && v.url)
            .map((v) => ({ server: v.server || null, url: v.url || null }))
        );
      };

      const mirrors = {
        SUB: normalizeMirrors(embedsObj.SUB || []),
        DUB: normalizeMirrors(embedsObj.DUB || []),
        RAW: normalizeMirrors(embedsObj.RAW || []),
      };

      const downloads = {
        SUB: normalizeDownloads(downloadsObj.SUB || []),
        DUB: normalizeDownloads(downloadsObj.DUB || []),
        RAW: normalizeDownloads(downloadsObj.RAW || []),
      };

      const allMirrorLinks = [...mirrors.SUB, ...mirrors.DUB, ...mirrors.RAW];
      const allDownloadLinks = [...downloads.SUB, ...downloads.DUB, ...downloads.RAW];

      return {
        success: true,
        title,
        episode,
        url: cleanUrl,
        filler: episodeObj.filler ?? null,
        published: this.formatDate(episodeObj.publishedAt),
        links: {
          main: {
            id: allMirrorLinks[0]?.id || null,
            play: allMirrorLinks[0]?.play || null,
            m3u8: allMirrorLinks[0]?.m3u8 || null,
            embed: allMirrorLinks[0]?.embed || null,
          },
          mirrors,
          downloads: allDownloadLinks,
        },
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async downloadFromPlayUrl(playUrl, outputFile) {
    const videoId = this.extractId(playUrl);
    const { initUrl, segments, totalSeconds } = await this.getPlaylist(videoId);
    let initBuf = await this.fetchBuf(initUrl);
    initBuf = this.patchDuration(initBuf, totalSeconds);

    const segBuffers = await this.downloadAll(segments);

    const out = outputFile || `${videoId}.mp4`;

    const ws = fs.createWriteStream(out);
    const writeChunk = (b) =>
      new Promise((res, rej) => ws.write(b, (e) => (e ? rej(e) : res())));

    await writeChunk(initBuf);
    for (const buf of segBuffers) await writeChunk(buf);

    await new Promise((res, rej) => {
      ws.end();
      ws.on("finish", res);
      ws.on("error", rej);
    });

    const stats = fs.statSync(out);

    return {
      success: true,
      id: videoId,
      file: path.resolve(out),
      size: +(stats.size / 1024 / 1024).toFixed(2) + " MB",
      segments: segments.length,
    };
  }

  async download(pageUrl, outputFile = null) {
    const info = await this.scrape(pageUrl);
    const playUrl = info?.links?.main?.play;
    const finalName =
      outputFile ||
      `${this.sanitizeFileName(info.title || "video")}_ep${info.episode || "1"}.mp4`;

    const downloaded = await this.downloadFromPlayUrl(playUrl, finalName);

    return {
      success: true,
      info,
      download: downloaded,
    };
  }
}
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const downloader = new HentaiLaDownloader();

// Directorio temporal para los videos
const TMP_DIR = path.join(process.cwd(), "tmp_videos");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

/**
 * GET  /hentaidl?url=<episode-url>
 * POST /hentaidl  { "url": "..." }
 *
 * Descarga el video completo (HLS → mp4) y lo sirve al cliente.
 */
app.all("/hentaidl", async (req, res) => {
  const url = req.query.url || req.body?.url;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'Falta el parámetro "url".',
      example: "GET /hentaidl?url=https://hentai.la/media/anime-title/1",
    });
  }

  let tmpFile = null;

  try {
    // 1. Scrape info + play URL
    console.log(`[1/3] Scrapeando: ${url}`);
    const info = await downloader.scrape(url);

    if (!info.success) {
      return res.status(502).json({ success: false, error: "No se pudo obtener info del episodio." });
    }

    const playUrl = info.links?.main?.play;
    if (!playUrl) {
      return res.status(502).json({ success: false, error: "No se encontró URL de reproducción." });
    }

    // 2. Ruta del archivo temporal (dentro del proyecto, no /tmp)
    const safeName = downloader.sanitizeFileName(info.title || "video");
    const ep = info.episode || "1";
    const fileName = `${safeName}_ep${ep}.mp4`;
    tmpFile = path.join(TMP_DIR, `${safeName}_ep${ep}_${Date.now()}.mp4`);

    console.log(`[2/3] Descargando segmentos → ${tmpFile}`);
    const result = await downloader.downloadFromPlayUrl(playUrl, tmpFile);

    if (!result.success || !fs.existsSync(tmpFile)) {
      return res.status(500).json({ success: false, error: "Error al ensamblar el video." });
    }

    // 3. Servir al cliente
    console.log(`[3/3] Enviando archivo (${result.size})`);
    const stat = fs.statSync(tmpFile);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Length", stat.size);
    res.setHeader("X-Episode-Title", info.title || "");
    res.setHeader("X-Episode-Number", String(ep));
    res.setHeader("X-Segments", String(result.segments));
    res.setHeader("X-File-Size", result.size);

    const stream = fs.createReadStream(tmpFile);

    stream.on("end", () => {
      fs.unlink(tmpFile, () => console.log(`[cleanup] Borrado: ${tmpFile}`));
    });

    stream.on("error", (err) => {
      console.error("[stream error]", err.message);
      fs.unlink(tmpFile, () => {});
      if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    });

    stream.pipe(res);

  } catch (err) {
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlink(tmpFile, () => {});
    console.error("[error]", err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    endpoints: {
      "GET  /hentaidl?url=<episode_url>": "Descarga el episodio como .mp4",
      "POST /hentaidl  { url }": "Igual que GET pero url en body JSON",
    },
  });
});

app.listen(PORT, () => {
  console.log(`HentaiDL API → http://localhost:${PORT}`);
  console.log(`Temp dir: ${TMP_DIR}`);
});

module.exports = app;