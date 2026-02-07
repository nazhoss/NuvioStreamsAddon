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
const DEBUG = process.env.DEBUG === 'true' || process.env['4KHDHUB_DEBUG'] === 'true';
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true';
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.4khdhub_cache') : path.join(__dirname, '.cache', '4khdhub');
const BASE_URL = 'https://4khdhub.fans';
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const MAX_RETRIES = 3;
const CONCURRENCY_LIMIT = 5; // Process 5 links at a time

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
// Create a specialized Axios instance with better default headers
const client = axios.create({
    timeout: 15000, // Increased timeout
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
 * Robust fetch with retry logic
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
            logWarn(`[4KHDHub] Attempt ${i + 1}/${MAX_RETRIES} failed for ${url}: ${error.message}`);
            // Wait before retrying (exponential backoff: 1s, 2s, 4s)
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
    const cacheKey = `search_v3_${name.replace(/[^a-z0-9]/gi, '_')}_${year}`; // Bumped version to v3
    
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

async function resolveRedirectUrl(redirectUrl) {
    const cacheKey = `redirect_v3_${redirectUrl.replace(/[^a-z0-9]/gi, '')}`;
    if (CACHE_ENABLED) {
        const cached = await redisCache.getFromCache(cacheKey, '', CACHE_DIR);
        if (cached) return cached.data || cached;
    }

    const redirectHtml = await fetchText(redirectUrl);
    if (!redirectHtml) return null;

    try {
        // Robust Regex: Handles various spacing around 'o' and the value
        const redirectDataMatch = redirectHtml.match(/'o'\s*,\s*['"](.*?)['"]/);
        
        if (!redirectDataMatch) {
            logWarn(`[4KHDHub] Failed to match redirect data pattern for ${redirectUrl}`);
            return null;
        }

        // Logic: atob -> atob -> rot13 -> atob -> JSON
        const step1 = atob(redirectDataMatch[1]);
        const step2 = atob(step1);
        const step3 = rot13Cipher(step2);
        const step4 = atob(step3);
        const redirectData = JSON.parse(step4);

        if (redirectData && redirectData.o) {
            const resolved = atob(redirectData.o);
            if (CACHE_ENABLED) {
                await redisCache.saveToCache(cacheKey, { data: resolved }, '', CACHE_DIR, 86400 * 3); // 3 days
            }
            return resolved;
        }
    } catch (e) {
        console.error(`[4KHDHub] Error resolving redirect obfuscation: ${e.message}`);
    }
    return null;
}

// Logic to extract the specific HubCloud/Drive link from the row
async function extractSourceResults($, el) {
    const localHtml = $(el).html();
    const sizeMatch = localHtml.match(/([\d.]+ ?[GM]B)/i);
    let heightMatch = localHtml.match(/\d{3,4}p/i);

    const title = $(el).find('.file-title, .episode-file-title').text().trim();

    // If quality detection failed from HTML, try the title
    if (!heightMatch) {
        heightMatch = title.match(/(\d{3,4})p/i);
    }

    // Fallback for "4K"
    let height = heightMatch ? parseInt(heightMatch[0]) : 0;
    if (height === 0) {
        if (title.match(/4K|2160p/i) || localHtml.match(/4K|2160p/i)) height = 2160;
        else if (title.match(/1080p/i) || localHtml.match(/1080p/i)) height = 1080;
        else if (title.match(/720p/i) || localHtml.match(/720p/i)) height = 720;
        else if (title.match(/480p/i) || localHtml.match(/480p/i)) height = 480;
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
            // We must fetch the HubDrive page to find the HubCloud link
            const hubDriveHtml = await fetchText(resolvedDrive);
            if (hubDriveHtml) {
                const $2 = cheerio.load(hubDriveHtml);
                // Look for the inner Cloud link
                const innerCloudLink = $2('a').filter((i, el) => $(el).text().includes('HubCloud')).attr('href');
                if (innerCloudLink) {
                    return { url: innerCloudLink, meta, type: 'drive' };
                }
            }
        }
    }

    return null;
}

// HubCloud Extractor Logic
async function extractHubCloud(hubCloudUrl, baseMeta) {
    if (!hubCloudUrl) return [];

    const cacheKey = `hubcloud_v3_${hubCloudUrl.replace(/[^a-z0-9]/gi, '')}`;
    if (CACHE_ENABLED) {
        const cached = await redisCache.getFromCache(cacheKey, '', CACHE_DIR);
        if (cached) return cached.data || cached;
    }

    // Important: Pass the correct Referer
    const headers = { Referer: hubCloudUrl };
    
    // Step 1: Fetch the interstitial page
    const redirectHtml = await fetchText(hubCloudUrl, { headers });
    if (!redirectHtml) return [];

    // Step 2: Extract the destination URL
    // IMPROVED REGEX: Handles single/double quotes and whitespace variations
    const redirectUrlMatch = redirectHtml.match(/var\s+url\s*=\s*['"]([^'"]+)['"]/i);
    
    if (!redirectUrlMatch) {
        logWarn(`[4KHDHub] Could not find 'var url' in HubCloud response for ${hubCloudUrl}`);
        // Fallback: Check for meta refresh just in case
        const metaRefresh = redirectHtml.match(/content=['"]\d+;url=([^'"]+)['"]/i);
        if (metaRefresh) {
            log(`[4KHDHub] Found meta refresh fallback.`);
             // proceed with metaRefresh[1] if implemented, but usually it's the JS var
        }
        return [];
    }

    const finalLinksUrl = redirectUrlMatch[1];
    
    // Step 3: Fetch the final links page
    const linksHtml = await fetchText(finalLinksUrl, { headers });
    if (!linksHtml) return [];

    const $ = cheerio.load(linksHtml);
    const results = [];
    const sizeText = $('#size').text(); // Try to get size from final page
    const titleText = $('title').text().replace(' - HubCloud', '').trim();

    const currentMeta = {
        ...baseMeta,
        bytes: sizeText ? (bytes.parse(sizeText) || baseMeta.bytes) : baseMeta.bytes,
        title: titleText || baseMeta.title
    };

    // Helper to clean PixelServer URLs
    const cleanPixelUrl = (u) => u.replace('/u/', '/api/file/');

    $('a').each((_i, el) => {
        const text = $(el).text().trim();
        const href = $(el).attr('href');
        if (!href || href === '#') return;

        // Condition 1: FSL / Download File
        if (text.includes('FSL') || text.includes('Download File')) {
             results.push({
                source: 'FSL',
                url: href,
                meta: currentMeta
            });
        }
        // Condition 2: PixelServer / Fast Server
        else if (text.includes('PixelServer') || text.includes('Fast Server')) {
            results.push({
                source: 'PixelServer',
                url: cleanPixelUrl(href),
                meta: currentMeta
            });
        }
        // Condition 3: Instant / Direct (Common variations)
        else if (text.includes('Instant') || $(el).attr('class')?.includes('btn-success')) {
             // Sometimes generic success buttons are the download links
             if (!results.find(r => r.url === href)) {
                 results.push({
                    source: 'Direct',
                    url: href,
                    meta: currentMeta
                 });
             }
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
    // Simple implementation of p-limit to avoid banning
    // We map the items to promises that execute the extraction logic
    
    const streams = [];
    let activePromises = 0;
    const results = [];

    // Helper to process a single item
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
                            // headers: { ... } // If the video file needs headers, add them here
                        }
                    });
                });
            }
        } catch (err) {
            logWarn(`[4KHDHub] Item processing error: ${err.message}`);
        }
    };

    // Execution Queue
    const queue = [...itemsToProcess];
    const runQueue = async () => {
        const workers = [];
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
