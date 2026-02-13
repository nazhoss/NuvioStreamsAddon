const axios = require('axios');
const cheerio = require('cheerio');
const bytes = require('bytes');
const { URL } = require('url');
const path = require('path');
const fs = require('fs').promises;

// Debug logging
const DEBUG = process.env.DEBUG === 'true' || process.env['4KHDHUB_DEBUG'] === 'true';
const log = DEBUG ? console.log : () => {};
const logWarn = DEBUG ? console.warn : () => {};

// Cache setup (simplified – remove Redis if not needed)
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true';
const CACHE_DIR = process.env.VERCEL ? '/tmp/.4khdhub_cache' : path.join(__dirname, '.cache', '4khdhub');

const BASE_URL = 'https://4khdhub.dad';       // ← most likely 2025–2026 domain
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';

const httpsAgent = new (require('https').Agent)({ rejectUnauthorized: false });

async function ensureCacheDir() {
    if (!CACHE_ENABLED) return;
    try { await fs.mkdir(CACHE_DIR, { recursive: true }); } catch {}
}

ensureCacheDir();

async function fetchText(url, options = {}) {
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                ...options.headers
            },
            timeout: 14000,
            httpsAgent
        });
        return response.data;
    } catch (err) {
        logWarn(`fetchText failed: ${url} → ${err.message}`);
        return null;
    }
}

async function getTmdbDetails(tmdbId, type) {
    const isSeries = type === 'series' || type === 'tv';
    const url = `https://api.themoviedb.org/3/${isSeries ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    
    try {
        const { data } = await axios.get(url, { timeout: 10000 });
        return {
            title: isSeries ? data.name : data.title,
            year: isSeries 
                ? (data.first_air_date ? parseInt(data.first_air_date.split('-')[0]) : 0)
                : (data.release_date ? parseInt(data.release_date.split('-')[0]) : 0)
        };
    } catch (err) {
        logWarn(`TMDB failed for ${tmdbId}: ${err.message}`);
        return null;
    }
}

async function fetchPageUrl(name, year) {
    const cacheKey = `4khd_${name.replace(/[^a-z0-9]/gi,'_')}_${year}`;
    // simple file cache check skipped for brevity – implement if needed

    try {
        const html = await fetchText(`${BASE_URL}/?s=${encodeURIComponent(`${name} ${year}`)}`);
        if (!html) return null;

        const $ = cheerio.load(html);
        let bestHref = null;
        let bestScore = Infinity;

        $('.result-item .details h2 a').each((i, el) => {
            const text = $(el).text().trim().toLowerCase();
            const href = $(el).attr('href');
            if (href && text.includes(name.toLowerCase())) {
                const dist = text.length - name.length;
                if (dist < bestScore) {
                    bestScore = dist;
                    bestHref = href;
                }
            }
        });

        return bestHref || null;
    } catch (err) {
        logWarn(`fetchPageUrl failed: ${err.message}`);
        return null;
    }
}

async function get4KHDHubStreams(tmdbId, type, season = null, episode = null) {
    const details = await getTmdbDetails(tmdbId, type);
    if (!details) return [];

    const { title, year } = details;
    log(`4KHDHub → ${title} (${year})`);

    const pageUrl = await fetchPageUrl(title, year);
    if (!pageUrl) return [];

    const html = await fetchText(pageUrl);
    if (!html) return [];

    const $ = cheerio.load(html);
    const streams = [];

    // Very simplified – real version would need better link extraction
    $('.download-server a').each((i, el) => {
        const url = $(el).attr('href');
        const text = $(el).text().trim();
        if (url && (text.includes('1080') || text.includes('720') || text.includes('4K'))) {
            streams.push({
                name: `4KHDHub - ${text}`,
                title: `${title} ${text}`,
                url,
                behaviorHints: { notWebReady: true }
            });
        }
    });

    return streams.length > 0 ? streams : [];
}

module.exports = { get4KHDHubStreams };
