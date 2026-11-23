require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const m3u8stream = require('m3u8stream');
const { spawn } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const fs = require('fs');

// Custom Scrapers
const tmdbScrape = require('./vidsrc'); 

if (!ffmpeg || !fs.existsSync(ffmpeg)) {
    console.error('❌ FATAL: ffmpeg-static binary not found.');
    process.exit(1);
}

process.on('uncaughtException', (err) => console.error('🔥 Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('🔥 Unhandled Rejection:', reason));

const app = express();
const cache = new NodeCache({ stdTTL: 600 });

app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
app.use('/api/', limiter);

const TMDB_API = process.env.TMDB_API_KEY;

app.get('/', (req, res) => res.json({ status: "online", message: "StreamNova V24 is running perfectly!" }));
app.get('/api/v1/health', (req, res) => res.json({ success: true, status: 'online', version: '24.0.4' }));

app.get('/api/v1/discover', async (req, res) => {
    try {
        const { type = 'movie', category = 'trending', page = 1, country, genre, startYear = 1994, endYear = 2030 } = req.query;
        
        if (!TMDB_API) return res.status(500).json({ success: false, error: "TMDB API Key missing." });

        const cacheKey = `cat_${type}_${category}_${page}_${country}_${genre}_${startYear}_${endYear}`;
        const cached = cache.get(cacheKey);
        if (cached) return res.json(cached);

        let url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&sort_by=popularity.desc`;
        const dateField = type === 'movie' ? 'primary_release_date' : 'first_air_date';
        url += `&${dateField}.gte=${startYear}-01-01&${dateField}.lte=${endYear}-12-31`;

        if (category === 'trending') url += `&sort_by=vote_count.desc`;
        else if (category === 'anime') url += `&with_genres=16&with_original_language=ja&with_origin_country=JP`;
        else if (category === 'reality') url = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API}&page=${page}&sort_by=popularity.desc&with_genres=10764&first_air_date.gte=${startYear}-01-01&first_air_date.lte=${endYear}-12-31`;
        else if (category === 'dubbed') url += `&with_original_language=ja|ko|zh|es|fr|hi|tr|de|it|pt&language=en-US`;

        if (country && country !== 'all') url += `&with_origin_country=${country}`;
        if (genre && genre !== 'all') url += `&with_genres=${genre}`;

        const response = await axios.get(url, { timeout: 10000 });
        let results = response.data.results;

        if (category === 'dubbed') {
            results = results.filter(item => {
                const title = item.title || item.name;
                const originalTitle = item.original_title || item.original_name;
                return title && originalTitle && title !== originalTitle;
            });
        }

        const data = { success: true, page: parseInt(page), results };
        cache.set(cacheKey, data);
        res.json(data);
    } catch (error) { 
        res.status(500).json({ success: false, error: "Catalogue unavailable." }); 
    }
});

app.get('/api/v1/anime/extract', async (req, res) => {
    const { title, episode = 1, dub = 'true' } = req.query;
    if (!title) return res.status(400).json({ error: "Anime title required" });

    try {
        const HI_ANIME_API = "https://hianime-api-iy4s.onrender.com/api";
        const searchRes = await axios.get(`${HI_ANIME_API}/search`, { params: { keyword: title, page: 1 }, timeout: 15000 });
        if (!searchRes.data?.animes?.length) return res.status(404).json({ success: false, error: "Anime not found" });

        const bestMatch = searchRes.data.animes[0];
        const epListRes = await axios.get(`${HI_ANIME_API}/episodes/${bestMatch.id}`, { timeout: 15000 });
        const episodes = epListRes.data.episodes || [];
        if (!episodes.length) return res.status(404).json({ success: false, error: "No episodes found" });

        const targetEp = episodes.find(e => e.number === parseInt(episode)) || episodes[0];
        const serversRes = await axios.get(`${HI_ANIME_API}/servers`, { params: { id: targetEp.id }, timeout: 15000 });
        
        const dubServers = serversRes.data.dub || [];
        const subServers = serversRes.data.sub || [];
        const serverToUse = (dub === 'true' && dubServers.length > 0) ? dubServers[0] : subServers[0];
        if (!serverToUse) return res.status(404).json({ success: false, error: "No streaming servers available" });

        const streamRes = await axios.get(`${HI_ANIME_API}/stream`, { 
            params: { id: targetEp.id, type: dub === 'true' && dubServers.length > 0 ? 'dub' : 'sub', server: serverToUse.name }, 
            timeout: 15000 
        });

        const sourcesList = streamRes.data?.sources || [];
        const source = sourcesList.find(s => s.isM3U8) || sourcesList[0];
        if (!source) throw new Error("No video source found");

        res.json({ success: true, provider: `HiAnime (${serverToUse.name})`, title: bestMatch.title, episode, streamUrl: source.url, headers: source.headers || { "Referer": "https://hianime.to/" }, type: 'hls' });
    } catch (error) { 
        res.status(500).json({ success: false, error: "Anime extraction failed" }); 
    }
});

// ============================================================================
// PLAYER SOURCES (VidLink -> Custom VidSrc -> SuperEmbed)
// ============================================================================
app.get('/api/v1/player/:id/sources', async (req, res) => {
    const { id } = req.params;
    const { type = 'movie', season = 1, episode = 1 } = req.query;
    const sources = [];

    // 1. Try VidLink
    try {
        let vidLinkUrl = type === 'movie' ? `https://vidlink.pro/api/b/movie/${id}` : `https://vidlink.pro/api/b/tv/${id}/${season}/${episode}`;
        const vidLinkRes = await axios.get(vidLinkUrl, { timeout: 6000 });
        if (vidLinkRes.data?.stream?.playlist) {
            sources.push({ provider: 'VidLink (Native HLS)', url: vidLinkRes.data.stream.playlist, type: 'hls', referer: 'https://vidlink.pro/' });
        }
    } catch (error) { console.log(`⚠️ VidLink failed for ${id}, trying custom scraper...`); }

    // 2. Try Custom VidSrc Scraper (whisperingauroras)
    if (sources.length === 0) {
        try {
            const customStreams = await tmdbScrape(id, type, season, episode);
            if (customStreams && customStreams.length > 0) {
                customStreams.forEach(s => {
                    sources.push({ provider: s.name, url: s.stream, type: 'hls', referer: s.referer });
                });
            }
        } catch (error) { console.log(`⚠️ Custom scraper failed for ${id}`); }
    }

    // 3. Fallback to SuperEmbed
    if (sources.length === 0) {
        let embedUrl = type === 'movie' ? `https://multiembed.mov/?video_id=${id}&tmdb=1` : `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${season}&e=${episode}`;
        sources.push({ provider: 'SuperEmbed (Iframe)', url: embedUrl, type: 'iframe' });
    }

    return res.json({ success: true, sources });
});

// ============================================================================
// DOWNLOADS (Works with any of the .m3u8 links above)
// ============================================================================
app.get('/api/v1/downloads/request', (req, res) => {
    const { url, referer, filename } = req.query;
    if (!url) return res.status(400).send("Stream URL is required");

    const safeFilename = filename ? filename.replace(/[^a-z0-9]/gi, '_') : 'StreamNova_Download';
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.mp4"`);
    res.setHeader('Content-Type', 'video/mp4');

    try {
        const stream = m3u8stream(url, { requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': referer || 'https://vidlink.pro/' } } });
        const ffmpegProcess = spawn(ffmpeg, ['-i', 'pipe:0', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-threads', '1', '-f', 'mp4', 'pipe:1']);
        
        stream.pipe(ffmpegProcess.stdin);
        ffmpegProcess.stdout.pipe(res);

        ffmpegProcess.on('error', (err) => {
            console.error("FFmpeg Error:", err);
            if (!res.headersSent) res.status(500).send("Failed to process download.");
        });

        req.on('close', () => { stream.destroy(); ffmpegProcess.kill('SIGKILL'); });
    } catch (error) {
        if (!res.headersSent) res.status(500).send("Failed to process download.");
    }
});

app.get('/api/v1/sports', async (req, res) => {
    try {
        const cached = cache.get('sports');
        if (cached) return res.json(cached);
        const espnRes = await axios.get('https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard', { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const events = (espnRes.data.events || []).map(event => {
            const competition = event.competitions?.[0] || {};
            const status = competition.status?.type?.description || 'Scheduled';
            return { id: event.id, name: event.name, date: event.date, status, isLive: status === 'In Progress' || status === 'Halftime', homeTeam: competition.competitors?.find(c => c.homeAway === 'home')?.team?.displayName, awayTeam: competition.competitors?.find(c => c.homeAway === 'away')?.team?.displayName, score: status === 'In Progress' ? `${competition.competitors?.find(c => c.homeAway === 'home')?.score} - ${competition.competitors?.find(c => c.homeAway === 'away')?.score}` : null };
        });
        cache.set('sports', { success: true, events }, 60);
        res.json({ success: true, events });
    } catch (error) { res.status(500).json({ success: false, error: "Sports Error" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 STREAMNOVA V24 running on port ${PORT}`));
