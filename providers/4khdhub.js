const axios = require('axios');
const cheerio = require('cheerio');
const bytes = require('bytes');
const levenshtein = require('fast-levenshtein');
const rot13Cipher = require('rot13-cipher');
const { URL } = require('url');
const path = require('path');
const fs = require('fs').promises;
const RedisCache = require('../utils/redisCache');

// --- Configuration ---
// Debug logging flag - set DEBUG=true to enable verbose logging
const DEBUG = process.env.DEBUG === 'true' || process.env['4KHDHUB_DEBUG'] === 'true';
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true';
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.4khdhub_cache') : path.join(__dirname, '.cache', '4khdhub');
const BASE_URL = 'https://4khdhub.fans';
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const MAX_RETRIES = 3;
const CONCURRENCY_LIMIT = 5; // How many links to process at once

// Logger
const log = DEBUG ? console.log : () => { };
const logWarn = DEBUG ? console.warn : () => { };

const redisCache = new RedisCache('4KHDHub');

// Ensure cache directory exists
const ensureCacheDir = async () => {
    if (!CACHE_ENABLED) return;
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') console.error(`[4KHDHub] Error creating cache directory: ${error.message}`);
    }
};
ensureCacheDir();

// --- HTTP Client Setup ---
// Create a specialized Axios instance with browser-like headers
const client = axios.create({
    timeout: 15000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1'
    }
});

// Polyfill for atob
const atob = (str) => Buffer.from(str, 'base64').toString('binary');

// --- Helper Functions ---

/**
 * Robust fetch with retry logic and exponential backoff
 */
async function fetchText(url, options = {}) {
    let lastError;
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            const response = await client.get(url, {
                ...options,
                validateStatus: (status) => status >= 200 && status < 500
            });
            return response.data;
        } catch (error) {
            lastError = error;
            if (DEBUG) logWarn(`[4KHDHub] Attempt ${i + 1}/${MAX_RETRIES} failed for ${url}: ${error.message}`);
            // Wait before retrying (1s, 2s, 4s)
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
        }
    }
    console.error(`[4KHDHub] FATAL: Request failed after ${MAX_RETRIES} attempts for ${url}: ${lastError?.message}`);
    return null;
}

// Fetch TMDB Details
async function getTmdbDetails(tmdbId, type) {
    try {
        const isSeries = type === 'series' || type === 'tv';
        const url = `https://api.themoviedb.org/3/${isSeries ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}`;
        log(`[4KHDHub] Fetching TMDB details from: ${url}`);
        
        const response = await axios.get(url);
        const data = response.data;

        if (isSeries) {
            return {
                title: data.name,
                year: data.first_air_date ? parseInt(data.first_air_date.split('-')[0]) : 0
            };
        } else {
            return {
                title: data.title,
                year: data.release_date ? parseInt(data.release_date.split('-')[0]) : 0
            };
        }
    } catch (error) {
        console.error(`[4KHDHub] TMDB request failed: ${error.message}`);
        return null;
    }
}

// --- Scraper Logic ---

async function fetchPageUrl(name, year, isSeries) {
    const cacheKey = `search_v3_${name.replace(/[^a-z0-9]/gi, '_')}_${year}`;
    
    if (CACHE_ENABLED) {
        const cached = await redisCache.getFromCache(cacheKey, '', CACHE_DIR);
        if (cached) return cached.data || cached;
    }

    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(`${name} ${year}`)}`;
    const html = await fetchText(searchUrl);
    if (!html) return null;

    const $ = cheerio.load(html);
    const targetType = isSeries ? 'Series' : 'Movies';

    // Find cards that contain the correct type
    const matchingCards = $('.movie-card')
        .filter((_i, el) => {
            const hasFormat = $(el).find(`.movie-card-format:contains("${targetType}")`).length > 0;
            return hasFormat;
        })
        .filter((_i, el) => {
            const metaText = $(el).find('.movie-card-meta').text();
            const movieCardYear = parseInt(metaText);
            // Allow 1 year margin of error
            return !isNaN(movieCardYear) && Math.abs(movieCardYear - year) <= 1;
        })
        .filter((_i, el) => {
            const movieCardTitle = $(el).find('.movie-card-title')
                .text()
                .replace(/\[.*?]/g, '')
                .trim();
            
            // Allow exact match or close Levenshtein distance
            return levenshtein.get(movieCardTitle.toLowerCase(), name.toLowerCase()) < 5;
        })
        .map((_i, el) => {
            let href = $(el).attr('href');
            if (href && !href.startsWith('http')) {
                href = BASE_URL + (href.startsWith('/') ? '' : '/') + href;
            }
            return href;
        })
        .get();

    const result = matchingCards.length > 0 ? matchingCards[0] : null;
    if (CACHE_ENABLED && result) {
        await redisCache.saveToCache(cacheKey, { data: result }, '', CACHE_DIR, 86400); // 1 day TTL
    }
    return result;
}

/**
 * Robust Redirect Resolver
 * Handles encryption layers (atob, rot13) and meta-refreshes
 */
async function resolveRedirectUrl(redirectUrl) {
    const cacheKey = `redirect_v4_${redirectUrl.replace(/[^a-z0-9]/gi, '')}`;
    if (CACHE_ENABLED) {
        const cached = await redisCache.getFromCache(cacheKey, '', CACHE_DIR);
        if (cached) return cached.data || cached;
    }

    const html = await fetchText(redirectUrl);
    if (!html) return null;

    let resolvedUrl = null;

    // STRATEGY A: Standard "Hub" Obfuscation (var o = '...')
    const match = html.match(/['"]o['"]\s*,\s*['"](.*?)['"]/);
    if (match) {
        try {
            // Standard chain: Atob -> Atob -> Rot13 -> Atob -> JSON
            let step = atob(match[1]); 
            step = atob(step);        
            step = rot13Cipher(step); 
            step = atob(step);        
            const json = JSON.parse(step);
            if (json && json.o) {
                resolvedUrl = atob(json.o);
            }
        } catch (e) {
            logWarn(`[4KHDHub] Decode error: ${e.message}`);
        }
    }

    // STRATEGY B: Meta Refresh (Fallback)
    if (!resolvedUrl) {
        const metaMatch = html.match(/content=['"]\d+;\s*url=(.*?)['"]/i);
        if (metaMatch) resolvedUrl = metaMatch[1];
    }

    if (resolvedUrl) {
        if (CACHE_ENABLED) {
            await redisCache.saveToCache(cacheKey, { data: resolvedUrl }, '', CACHE_DIR, 86400 * 3); // 3 days
        }
        return resolvedUrl;
    }

    return null;
}

/**
 * Extracts the source info (Quality, Size, Initial URL) from the movie page listing
 */
async function extractSourceResults($, el) {
    const localHtml = $(el).html();
    const sizeMatch = localHtml.match(/([\d.]+ ?[GM]B)/i);
    let heightMatch = localHtml.match(/\d{3,4}p/i);

    const title = $(el).find('.file-title, .episode-file-title').text().trim();

    // If quality detection failed from HTML, try the title
    if (!heightMatch) {
        heightMatch = title.match(/(\d{3,4})p/i);
    }

    // Fallback for "4K" text without specific "2160p" text
    let height = heightMatch ? parseInt(heightMatch[0]) : 0;
    if (height === 0) {
        if (title.match(/4K|2160p/i) || localHtml.match(/4K|2160p/i)) height = 2160;
        else if (title.match(/1080p/i) || localHtml.match(/1080p/i)) height = 1080;
        else if (title.match(/720p/i) || localHtml.match(/720p/i)) height = 720;
    }

    const meta = {
        bytes: sizeMatch ? bytes.parse(sizeMatch[1]) : 0,
        height: height,
        title: title
    };

    // 1. Try HubCloud Link directly
    let hubCloudLink = $(el).find('a')
        .filter((_i, a) => $(a).text().includes('HubCloud'))
        .attr('href');

    if (hubCloudLink) {
        const resolved = await resolveRedirectUrl(hubCloudLink);
        return { url: resolved, meta, type: 'cloud' };
    }

    // 2. Try HubDrive Link (which usually contains a HubCloud link inside)
    let hubDriveLink = $(el).find('a')
        .filter((_i, a) => $(a).text().includes('HubDrive'))
        .attr('href');

    if (hubDriveLink) {
        const resolvedDrive = await resolveRedirectUrl(hubDriveLink);
        if (resolvedDrive) {
            // Fetch HubDrive page to find inner HubCloud link
            const hubDriveHtml = await fetchText(resolvedDrive);
            if (hubDriveHtml) {
                const $2 = cheerio.load(hubDriveHtml);
                const innerCloudLink = $2('a').filter((i, el) => $(el).text().includes('HubCloud')).attr('href');
                if (innerCloudLink) {
                    return { url: innerCloudLink, meta, type: 'drive' };
                }
            }
        }
    }

    return null;
}

/**
 * Aggressive Extractor for HubCloud final pages
 */
async function extractHubCloud(hubCloudUrl, baseMeta) {
    if (!hubCloudUrl) return [];

    const cacheKey = `hubcloud_v4_${hubCloudUrl.replace(/[^a-z0-9]/gi, '')}`;
    if (CACHE_ENABLED) {
        const cached = await redisCache.getFromCache(cacheKey, '', CACHE_DIR);
        if (cached) return cached.data || cached;
    }

    // IMPORTANT: Referer must be the hubCloudUrl itself usually
    const headers = { Referer: hubCloudUrl }; 

    // Step 1: Fetch the interstitial page
    const redirectHtml = await fetchText(hubCloudUrl, { headers });
    if (!redirectHtml) return [];

    // Step 2: Extract the destination URL
    // REGEX: Handles "var url", "var link", single/double quotes
    const redirectUrlMatch = redirectHtml.match(/var\s+(?:url|link)\s*=\s*['"]([^'"]+)['"]/i);
    
    let finalLinksUrl = null;
    if (redirectUrlMatch) {
        finalLinksUrl = redirectUrlMatch[1];
    } else {
        // Fallback: Check for meta refresh
        const metaRefresh = redirectHtml.match(/content=['"]\d+;\s*url=([^'"]+)['"]/i);
        if (metaRefresh) finalLinksUrl = metaRefresh[1];
    }

    if (!finalLinksUrl) {
        if(DEBUG) logWarn(`[4KHDHub] Failed to find next URL in HubCloud page: ${hubCloudUrl}`);
        return [];
    }

    // Step 3: Fetch the final links page
    const linksHtml = await fetchText(finalLinksUrl, { headers });
    if (!linksHtml) return [];

    const $ = cheerio.load(linksHtml);
    const results = [];
    const sizeText = $('#size, .file-size').text().trim();
    const titleText = $('title').text().replace(' - HubCloud', '').trim();

    const currentMeta = {
        ...baseMeta,
        bytes: sizeText ? (bytes.parse(sizeText) || baseMeta.bytes) : baseMeta.bytes,
        title: titleText || baseMeta.title
    };

    // Helper to clean PixelServer URLs
    const cleanPixelUrl = (u) => u.replace('/u/', '/api/file/');

    // Step 4: Scan ALL links
    $('a').each((_i, el) => {
        const text = $(el).text().trim().toLowerCase();
        const href = $(el).attr('href');
        const classes = $(el).attr('class') || '';

        if (!href || href === '#' || href.startsWith('javascript')) return;

        // MATCHING LOGIC
        const isFSL = text.includes('fsl') || text.includes('download file');
        const isPixel = text.includes('pixel') || text.includes('fast server');
        // Sometimes valid links are just generic "Download" buttons
        const isGenericDownload = classes.includes('btn-success') || classes.includes('btn-primary');

        if (isFSL) {
            results.push({
                source: 'FSL',
                url: href,
                meta: currentMeta
            });
        }
        else if (isPixel) {
            results.push({
                source: 'PixelServer',
                url: cleanPixelUrl(href),
                meta: currentMeta
            });
        }
        else if (isGenericDownload && !results.some(r => r.url === href)) {
             results.push({
                source: 'Direct',
                url: href,
                meta: currentMeta
            });
        }
    });

    if (CACHE_ENABLED && results.length > 0) {
        await redisCache.saveToCache(cacheKey, { data: results }, '', CACHE_DIR, 3600); // 1 hour
    }

    return results;
}

// --- Main Entry Point ---

async function get4KHDHubStreams(tmdbId, type, season = null, episode = null) {
    const tmdbDetails = await getTmdbDetails(tmdbId, type);
    if (!tmdbDetails) return [];

    const { title, year } = tmdbDetails;
    log(`[4KHDHub] Search: ${title} (${year})`);

    const isSeries = type === 'series' || type === 'tv';
    const pageUrl = await fetchPageUrl(title, year, isSeries);
    if (!pageUrl) {
        log(`[4KHDHub] Page not found for ${title}`);
        return [];
    }
    
    const html = await fetchText(pageUrl);
    if (!html) return [];
    const $ = cheerio.load(html);

    let itemsToProcess = [];

    if (isSeries && season && episode) {
        const seasonStr = `S${String(season).padStart(2, '0')}`;
        const episodeStr = `Episode-${String(episode).padStart(2, '0')}`;
        
        // Flexible searching for episode block
        $('.episode-item').each((_i, el) => {
            const epTitle = $('.episode-title', el).text();
            if (epTitle.includes(seasonStr)) {
                const downloadItems = $('.episode-download-item', el)
                    .filter((_j, item) => {
                         const txt = $(item).text();
                         return txt.includes(episodeStr) || txt.includes(`E${String(episode).padStart(2,'0')}`);
                    });

                downloadItems.each((_k, item) => itemsToProcess.push(item));
            }
        });
    } else {
        $('.download-item').each((_i, el) => itemsToProcess.push(el));
    }

    log(`[4KHDHub] Found ${itemsToProcess.length} potential sources. Processing...`);

    // --- CONCURRENCY HANDLING ---
    // Process multiple links in parallel to speed up scraping
    
    const results = [];
    const queue = [...itemsToProcess];
    const workers = [];

    // Worker function
    const processItem = async (item) => {
        try {
            const sourceResult = await extractSourceResults($, item);
            if (sourceResult && sourceResult.url) {
                log(`[4KHDHub] Extracting ${sourceResult.type}: ${sourceResult.url}`);
                const extractedLinks = await extractHubCloud(sourceResult.url, sourceResult.meta);
                
                extractedLinks.forEach(link => {
                    results.push({
                        name: `4KHDHub - ${link.source} ${sourceResult.meta.height ? sourceResult.meta.height + 'p' : ''}`,
                        title: `${link.meta.title}\n${bytes.format(link.meta.bytes || 0)}`,
                        url: link.url,
                        quality: sourceResult.meta.height ? `${sourceResult.meta.height}p` : undefined,
                        behaviorHints: {
                            bingeGroup: `4khdhub-${link.source}`,
                        }
                    });
                });
            }
        } catch (err) {
            logWarn(`[4KHDHub] Item processing error: ${err.message}`);
        }
    };

    // Run queue with concurrency limit
    const runQueue = async () => {
        while (queue.length > 0) {
            if (workers.length >= CONCURRENCY_LIMIT) {
                await Promise.race(workers);
            }
            const item = queue.shift();
            const p = processItem(item).then(() => {
                workers.splice(workers.indexOf(p), 1);
            });
            workers.push(p);
        }
        await Promise.all(workers);
    };

    await runQueue();

    return results;
}

module.exports = { get4KHDHubStreams };
