const axios = require('axios');
const cheerio = require('cheerio');
const bytes = require('bytes');
const levenshtein = require('fast-levenshtein');
const rot13Cipher = require('rot13-cipher');
const path = require('path');
const fs = require('fs').promises;
const RedisCache = require('../utils/redisCache');

// Debug logging
const DEBUG = process.env.DEBUG === 'true' || process.env['4KHDHUB_DEBUG'] === 'true';
const log = DEBUG ? console.log : () => { };

// Cache configuration
const CACHE_ENABLED = process.env.DISABLE_CACHE !== 'true';
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.4khdhub_cache') : path.join(__dirname, '.cache', '4khdhub');
const redisCache = new RedisCache('4KHDHub');

const BASE_URL = 'https://4khdhub.dad';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '439c478a771f35c05022f9feabcca01c';

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

// Helper: Polyfill for atob
const atob = (str) => Buffer.from(str, 'base64').toString('binary');

// Helper: Fetch Text
async function fetchText(url, options = {}) {
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                ...options.headers
            },
            timeout: 10000
        });
        return response.data;
    } catch (error) {
        log(`[4KHDHub] Request failed for ${url}: ${error.message}`);
        return null;
    }
}

// 1. Get TMDB Details (Fixed)
async function getTmdbDetails(tmdbId, type) {
    try {
        const isSeries = type === 'series' || type === 'tv';
        const url = `https://api.themoviedb.org/3/${isSeries ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}`;
        
        const cacheKey = `tmdb_${type}_${tmdbId}`;
        if (CACHE_ENABLED) {
            const cached = await redisCache.getFromCache(cacheKey, '', CACHE_DIR);
            if (cached) return cached.data || cached;
        }

        log(`[4KHDHub] Fetching TMDB details: ${url}`);
        const response = await axios.get(url);
        const data = response.data;

        let result;
        if (isSeries) {
            result = {
                title: data.name,
                year: data.first_air_date ? parseInt(data.first_air_date.split('-')[0]) : 0
            };
        } else {
            result = {
                title: data.title,
                year: data.release_date ? parseInt(data.release_date.split('-')[0]) : 0
            };
        }

        if (CACHE_ENABLED) {
            await redisCache.saveToCache(cacheKey, { data: result }, '', CACHE_DIR, 86400 * 7); // Cache for 7 days
        }
        return result;

    } catch (error) {
        console.error(`[4KHDHub] TMDB request failed: ${error.message}`);
        return null;
    }
}

// 2. Resolve Obfuscated Redirects
async function resolveRedirectUrl(redirectUrl) {
    if (!redirectUrl) return null;
    const cacheKey = `redirect_v2_${redirectUrl.replace(/[^a-z0-9]/gi, '')}`;
    
    if (CACHE_ENABLED) {
        const cached = await redisCache.getFromCache(cacheKey, '', CACHE_DIR);
        if (cached) return cached.data || cached;
    }

    const redirectHtml = await fetchText(redirectUrl);
    if (!redirectHtml) return null;

    try {
        const redirectDataMatch = redirectHtml.match(/'o','(.*?)'/);
        if (!redirectDataMatch) return null;

        const step1 = atob(redirectDataMatch[1]);
        const step2 = atob(step1);
        const step3 = rot13Cipher(step2); // Requires rot13-cipher package
        const step4 = atob(step3);
        const redirectData = JSON.parse(step4);

        if (redirectData && redirectData.o) {
            const resolved = atob(redirectData.o);
            if (CACHE_ENABLED) {
                await redisCache.saveToCache(cacheKey, { data: resolved }, '', CACHE_DIR, 86400 * 3);
            }
            return resolved;
        }
    } catch (e) {
        console.error(`[4KHDHub] Error resolving redirect: ${e.message}`);
    }
    return null;
}

// 3. Search for the Page URL
async function fetchPageUrl(name, year, isSeries) {
    const cacheKey = `search_v3_${name.replace(/[^a-z0-9]/gi, '_')}_${year}_${isSeries}`;
    
    if (CACHE_ENABLED) {
        const cached = await redisCache.getFromCache(cacheKey, '', CACHE_DIR);
        if (cached) return cached.data || cached;
    }

    const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(`${name} ${year}`)}`;
    const html = await fetchText(searchUrl);
    if (!html) return null;

    const $ = cheerio.load(html);
    const targetType = isSeries ? 'Series' : 'Movies';

    const matchingCards = $('.movie-card')
        .filter((_i, el) => {
            // Check type (Series vs Movie) if possible, but 4KHDHub often mixes them.
            // We rely heavily on Title + Year matching.
            return true; 
        })
        .filter((_i, el) => {
            const metaText = $(el).find('.movie-card-meta').text();
            const movieCardYear = parseInt(metaText) || 0;
            // Allow 1 year variance
            return Math.abs(movieCardYear - year) <= 1;
        })
        .filter((_i, el) => {
            const movieCardTitle = $(el).find('.movie-card-title').text()
                .replace(/\[.*?]/g, '') // Remove [4K] [Dual Audio] etc
                .trim();
            
            const dist = levenshtein.get(movieCardTitle.toLowerCase(), name.toLowerCase());
            return dist < 5 || movieCardTitle.toLowerCase().includes(name.toLowerCase());
        })
        .map((_i, el) => {
            let href = $(el).find('a').first().attr('href'); // Ensure we grab the anchor tag href
            if (href && !href.startsWith('http')) {
                href = BASE_URL + (href.startsWith('/') ? '' : '/') + href;
            }
            return href;
        })
        .get();

    const result = matchingCards.length > 0 ? matchingCards[0] : null;
    
    if (CACHE_ENABLED && result) {
        await redisCache.saveToCache(cacheKey, { data: result }, '', CACHE_DIR, 86400);
    }
    return result;
}

// 4. Extract Intermediate Links (HubCloud/HubDrive)
async function extractSourceResults($, el) {
    const localHtml = $(el).html();
    const sizeMatch = localHtml.match(/([\d.]+ ?[GM]B)/i);
    let heightMatch = localHtml.match(/(\d{3,4})p/i);

    const title = $(el).find('.file-title, .episode-file-title, strong').text().trim();

    // Fallback quality detection
    if (!heightMatch) {
        heightMatch = title.match(/(\d{3,4})p/i);
    }
    let height = heightMatch ? parseInt(heightMatch[1]) : 0;
    if (height === 0 && (title.includes('4K') || title.includes('2160p'))) {
        height = 2160;
    } else if (height === 0 && (title.includes('1080p'))) {
        height = 1080;
    }

    const meta = {
        bytes: sizeMatch ? bytes.parse(sizeMatch[1]) : 0,
        height: height,
        title: title
    };

    // Find HubCloud Link
    let hubCloudLink = $(el).find('a[href*="hubcloud"], a[href*="/archives/"]').first().attr('href');
    
    // Sometimes links are hidden in buttons
    if (!hubCloudLink) {
        $(el).find('a').each((i, a) => {
            const txt = $(a).text().toLowerCase();
            if (txt.includes('hubcloud') || txt.includes('watch') || txt.includes('download')) {
                hubCloudLink = $(a).attr('href');
                return false; // break
            }
        });
    }

    if (hubCloudLink) {
        // Resolve the first redirect
        const resolved = await resolveRedirectUrl(hubCloudLink);
        if (resolved) {
             return { url: resolved, meta };
        }
    }

    return null;
}

// 5. Extract Final Streaming Links (FSL/Pixel)
async function extractHubCloud(hubCloudUrl, baseMeta) {
    if (!hubCloudUrl) return [];

    const cacheKey = `hubcloud_final_${hubCloudUrl.replace(/[^a-z0-9]/gi, '')}`;
    if (CACHE_ENABLED) {
        const cached = await redisCache.getFromCache(cacheKey, '', CACHE_DIR);
        if (cached) return cached.data || cached;
    }

    // 1. Fetch the HubCloud page (often has a JS redirect)
    const redirectHtml = await fetchText(hubCloudUrl, { headers: { Referer: hubCloudUrl } });
    if (!redirectHtml) return [];

    // 2. Look for the "var url = '...'" pattern used by their verification
    const redirectUrlMatch = redirectHtml.match(/var url ?= ?'(.*?)'/);
    if (!redirectUrlMatch) return [];

    const finalLinksUrl = redirectUrlMatch[1];
    
    // 3. Fetch the actual links page
    const linksHtml = await fetchText(finalLinksUrl, { headers: { Referer: hubCloudUrl } });
    if (!linksHtml) return [];

    const $ = cheerio.load(linksHtml);
    const results = [];
    
    // Try to grab size/title from this final page if missing
    const pageTitle = $('.card-title').text() || $('h4').text();
    const pageSize = $('.file-size').text(); 
    
    const currentMeta = {
        ...baseMeta,
        title: baseMeta.title || pageTitle,
        bytes: baseMeta.bytes || (pageSize ? bytes.parse(pageSize) : 0)
    };

    $('.btn, a').each((_i, el) => {
        const text = $(el).text().trim();
        const href = $(el).attr('href');
        if (!href || href === '#') return;

        if (text.includes('FSL') || text.includes('Fast Server') || text.includes('Download File')) {
            results.push({
                source: 'FSL',
                url: href,
                meta: currentMeta
            });
        }
        else if (text.includes('Pixel') || href.includes('pixeldra')) {
            // Convert /u/ to /api/file/ for direct streaming if possible
            // const pixelUrl = href.replace('/u/', '/api/file/'); 
            results.push({
                source: 'PixelDrain',
                url: href,
                meta: currentMeta
            });
        }
    });

    if (CACHE_ENABLED && results.length > 0) {
        await redisCache.saveToCache(cacheKey, { data: results }, '', CACHE_DIR, 3600);
    }

    return results;
}

// === MAIN FUNCTION ===
async function get4KHDHubStreams(tmdbId, type, season = null, episode = null) {
    const isSeries = type === 'series' || type === 'tv';
    
    // 1. Get Metadata
    const tmdbDetails = await getTmdbDetails(tmdbId, type);
    if (!tmdbDetails) {
        log(`[4KHDHub] No TMDB details found for ID ${tmdbId}`);
        return [];
    }

    const { title, year } = tmdbDetails;
    log(`[4KHDHub] Processing: ${title} (${year})`);

    // 2. Find Page URL
    const pageUrl = await fetchPageUrl(title, year, isSeries);
    if (!pageUrl) {
        log(`[4KHDHub] Page not found for ${title}`);
        return [];
    }

    // 3. Parse Page
    const html = await fetchText(pageUrl);
    if (!html) return [];
    const $ = cheerio.load(html);

    let itemsToProcess = [];

    if (isSeries && season && episode) {
        // Series Logic
        const seasonStr = `S${String(season).padStart(2, '0')}`;
        const episodeStr = `E${String(episode).padStart(2, '0')}`; // Standard S01E01
        
        // Also try "Episode 1" format
        const episodeStrAlt = `Episode-${String(episode).padStart(2, '0')}`;
        const episodeStrAlt2 = `Episode ${episode}`;

        // Find the Season Container first
        $('h3, h4, .episode-category').each((i, el) => {
            if ($(el).text().includes(seasonStr) || $(el).text().includes(`Season ${season}`)) {
                // Look for episodes nearby
                $(el).nextUntil('h3').find('a').each((j, link) => {
                    const txt = $(link).text();
                    if (txt.includes(episodeStr) || txt.includes(episodeStrAlt) || txt.includes(episodeStrAlt2)) {
                         // This anchor tag probably leads to the episode page or is a direct download link
                         itemsToProcess.push(link);
                    }
                });
            }
        });

        // Fallback: Check if page structure is "One page per season"
        if (itemsToProcess.length === 0) {
             $('p, div').filter((i, el) => $(el).text().includes(seasonStr)).find('a').each((i, link) => {
                  const txt = $(link).text();
                  if (txt.includes(episodeStr) || txt.includes(episodeStrAlt)) {
                      itemsToProcess.push(link);
                  }
             });
        }

    } else {
        // Movie Logic: Grab all download links usually found in "Download Links" section
        $('.download-links a, p a').each((_i, el) => {
             const txt = $(el).text();
             if (txt.includes('Download') || txt.includes('Watch') || txt.includes('HubCloud')) {
                 itemsToProcess.push(el);
             }
        });
    }

    log(`[4KHDHub] Found ${itemsToProcess.length} potential links`);

    const streams = [];

    // 4. Extract Streams
    for (const item of itemsToProcess) {
        try {
            // Get HubCloud URL from the item
            const sourceResult = await extractSourceResults($, item);
            
            if (sourceResult && sourceResult.url) {
                log(`[4KHDHub] Resolving HubCloud: ${sourceResult.url}`);
                const extractedLinks = await extractHubCloud(sourceResult.url, sourceResult.meta);

                for (const link of extractedLinks) {
                    streams.push({
                        name: `4KHDHub\n${link.source} ${sourceResult.meta.height ? sourceResult.meta.height + 'p' : ''}`,
                        title: `${title}\n${link.meta.title}\n💾 ${bytes.format(link.meta.bytes || 0)}`,
                        url: link.url,
                        behaviorHints: {
                            bingeGroup: `4khdhub-${link.source}-${sourceResult.meta.height||'unk'}`
                        }
                    });
                }
            }
        } catch (err) {
            if (DEBUG) console.error(`[4KHDHub] Item error: ${err.message}`);
        }
    }

    return streams;
}

module.exports = { get4KHDHubStreams };
