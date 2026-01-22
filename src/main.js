// Kickstarter Projects Scraper - HYBRID: Playwright (listing) + Got-Scraping (details)
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

await Actor.init();

// Random delay utility
const randomDelay = (min = 500, max = 2000) =>
    new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

// Parse funding data from detail page using got-scraping (FAST & CHEAP)
async function fetchProjectDetails(projectUrl) {
    try {
        const response = await gotScraping({
            url: projectUrl,
            headers: {
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'accept-language': 'en-US,en;q=0.9',
                'sec-ch-ua': '"Chromium";v="122", "Google Chrome";v="122"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
            },
            timeout: { request: 30000 },
            retry: { limit: 2 },
        });

        const $ = cheerio.load(response.body);

        // Try JSON-LD first (most reliable)
        let pledged = null, backers = null, funding_goal = null, days_left = null, percentage_funded = null;

        $('script[type="application/ld+json"]').each((_, el) => {
            try {
                const json = JSON.parse($(el).text());
                if (json['@type'] === 'Product' || json['@type'] === 'CreativeWork') {
                    // Extract from structured data if available
                }
            } catch { }
        });

        // Extract from page content - look for stats
        const pageText = $('body').text();

        // Pledged amount (e.g., "$12,345 pledged" or "€5,000 pledged")
        const pledgedMatch = pageText.match(/([€£$][\d,]+)\s*pledged/i) ||
            pageText.match(/pledged\s*of\s*([€£$][\d,]+)/i);
        if (pledgedMatch) {
            pledged = pledgedMatch[1].replace(/[€£$,]/g, '');
        }

        // Funding goal (e.g., "of $10,000 goal")
        const goalMatch = pageText.match(/of\s*([€£$][\d,]+)\s*goal/i) ||
            pageText.match(/goal:\s*([€£$][\d,]+)/i);
        if (goalMatch) {
            funding_goal = goalMatch[1].replace(/[€£$,]/g, '');
        }

        // Backers count
        const backersMatch = pageText.match(/([\d,]+)\s*backers?/i);
        if (backersMatch) {
            backers = backersMatch[1].replace(/,/g, '');
        }

        // Days left
        const daysMatch = pageText.match(/(\d+)\s*days?\s*(?:to go|left)/i);
        if (daysMatch) {
            days_left = daysMatch[1];
        }

        // Percentage funded
        const percentMatch = pageText.match(/(\d+)%\s*funded/i);
        if (percentMatch) {
            percentage_funded = percentMatch[1];
        }

        // Try extracting from specific elements
        const statsText = $('.project-stats, .NS_projects__progress_statistics, [class*="stats"]').text();
        if (statsText) {
            if (!pledged) {
                const m = statsText.match(/([€£$][\d,]+)/);
                if (m) pledged = m[1].replace(/[€£$,]/g, '');
            }
            if (!backers) {
                const m = statsText.match(/([\d,]+)\s*backers?/i);
                if (m) backers = m[1].replace(/,/g, '');
            }
        }

        // Try meta tags
        const ogDescription = $('meta[property="og:description"]').attr('content') || '';
        if (!pledged && ogDescription) {
            const m = ogDescription.match(/([€£$][\d,]+)\s*pledged/i);
            if (m) pledged = m[1].replace(/[€£$,]/g, '');
        }

        return { pledged, backers, funding_goal, days_left, percentage_funded };
    } catch (err) {
        log.debug(`Detail fetch failed for ${projectUrl}: ${err.message}`);
        return { pledged: null, backers: null, funding_goal: null, days_left: null, percentage_funded: null };
    }
}

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            startUrl = 'https://www.kickstarter.com/discover',
            category = '',
            sort = 'magic',
            results_wanted: RESULTS_WANTED_RAW = 20,
            max_pages: MAX_PAGES_RAW = 5,
            collectDetails = true, // Default true for complete data
            proxyConfiguration: proxyConfig,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 20;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 5;

        const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig || {
            useApifyProxy: true,
            apifyProxyGroups: ['RESIDENTIAL'],
        });

        let saved = 0;
        const seenUrls = new Set();

        const buildUrl = () => {
            if (startUrl && startUrl !== 'https://www.kickstarter.com/discover') {
                return startUrl;
            }
            const url = new URL('https://www.kickstarter.com/discover/advanced');
            if (category) url.searchParams.set('category', category);
            if (sort) url.searchParams.set('sort', sort);
            return url.href;
        };

        const finalUrl = buildUrl();
        log.info(`Starting Kickstarter scraper with URL: ${finalUrl}`);
        log.info(`Target: ${RESULTS_WANTED} projects, Max pages: ${MAX_PAGES}, Details: ${collectDetails}`);

        const crawler = new PlaywrightCrawler({
            proxyConfiguration,
            maxRequestRetries: 5,
            useSessionPool: true,
            sessionPoolOptions: {
                maxPoolSize: 5,
                sessionOptions: { maxUsageCount: 3 },
            },
            maxConcurrency: 2,
            requestHandlerTimeoutSecs: 180,
            navigationTimeoutSecs: 60,

            browserPoolOptions: {
                useFingerprints: true,
                fingerprintOptions: {
                    fingerprintGeneratorOptions: {
                        browsers: ['chrome'],
                        operatingSystems: ['windows', 'macos'],
                        devices: ['desktop'],
                    },
                },
            },

            preNavigationHooks: [
                async ({ page }) => {
                    // Resource blocking for faster loads
                    await page.route('**/*', (route) => {
                        const type = route.request().resourceType();
                        const url = route.request().url();
                        if (['image', 'font', 'media'].includes(type) ||
                            url.includes('google-analytics') ||
                            url.includes('googletagmanager') ||
                            url.includes('facebook') ||
                            url.includes('doubleclick')) {
                            return route.abort();
                        }
                        return route.continue();
                    });

                    // Stealth
                    await page.addInitScript(() => {
                        Object.defineProperty(navigator, 'webdriver', { get: () => false });
                        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                        window.chrome = { runtime: {} };
                    });

                    await randomDelay(1000, 2000);
                },
            ],

            async requestHandler({ page }) {
                await page.waitForLoadState('domcontentloaded');
                await page.waitForLoadState('networkidle').catch(() => { });

                log.info('Page loaded, starting extraction...');

                // Handle cookies
                try {
                    const cookieBtn = page.locator('button:has-text("Accept"), button:has-text("OK")').first();
                    if (await cookieBtn.isVisible({ timeout: 2000 })) {
                        await cookieBtn.click();
                        await randomDelay(500, 1000);
                    }
                } catch { }

                // SCROLL-BASED PAGINATION - Load all projects by scrolling
                let previousHeight = 0;
                let scrollAttempts = 0;
                const maxScrollAttempts = MAX_PAGES * 3;

                while (saved < RESULTS_WANTED && scrollAttempts < maxScrollAttempts) {
                    // Extract visible projects
                    const projects = await page.evaluate(() => {
                        const cards = Array.from(document.querySelectorAll('.js-react-proj-card'));
                        return cards.map(card => {
                            try {
                                const titleLink = card.querySelector('.project-card__title');
                                const title = titleLink?.innerText?.trim() || null;
                                const href = titleLink?.getAttribute('href');
                                const url = href ? (href.startsWith('http') ? href : `https://www.kickstarter.com${href}`) : null;

                                const creatorEl = card.querySelector('.project-card__creator');
                                const creator = creatorEl?.innerText?.trim()?.replace(/^by\s+/i, '') || null;

                                const img = card.querySelector('img');
                                const image_url = img?.src || img?.getAttribute('data-src') || null;

                                // Parse text for basic stats
                                const text = card.innerText || '';
                                const percentMatch = text.match(/(\d+)%\s*funded/i);
                                const daysMatch = text.match(/(\d+)\s*days?\s*(?:left|to go)/i);
                                const categoryLink = card.querySelector('a[href*="/discover/categories/"]');

                                return {
                                    title,
                                    creator,
                                    url,
                                    image_url,
                                    percentage_funded: percentMatch ? percentMatch[1] : null,
                                    days_left: daysMatch ? daysMatch[1] : null,
                                    category: categoryLink?.innerText?.trim() || null,
                                    // These will be filled by detail page
                                    pledged: null,
                                    backers: null,
                                    funding_goal: null,
                                    location: null,
                                };
                            } catch { return null; }
                        }).filter(p => p && p.title && p.url);
                    });

                    // Filter duplicates
                    const newProjects = projects.filter(p => !seenUrls.has(p.url));
                    newProjects.forEach(p => seenUrls.add(p.url));

                    if (newProjects.length > 0) {
                        const toProcess = newProjects.slice(0, RESULTS_WANTED - saved);

                        // HYBRID: Fetch details with got-scraping (FAST & CHEAP)
                        if (collectDetails) {
                            log.info(`Fetching details for ${toProcess.length} projects with got-scraping...`);

                            // Process in batches of 5 for speed
                            for (let i = 0; i < toProcess.length; i += 5) {
                                const batch = toProcess.slice(i, i + 5);
                                await Promise.all(batch.map(async (project) => {
                                    const details = await fetchProjectDetails(project.url);
                                    project.pledged = details.pledged || project.pledged;
                                    project.backers = details.backers || project.backers;
                                    project.funding_goal = details.funding_goal || project.funding_goal;
                                    // Override if better data from detail
                                    if (details.days_left) project.days_left = details.days_left;
                                    if (details.percentage_funded) project.percentage_funded = details.percentage_funded;
                                }));
                            }
                        }

                        await Dataset.pushData(toProcess);
                        saved += toProcess.length;
                        log.info(`Saved ${toProcess.length} projects (total: ${saved}/${RESULTS_WANTED})`);
                    }

                    if (saved >= RESULTS_WANTED) {
                        log.info('✅ Reached target');
                        break;
                    }

                    // Scroll down for more projects
                    const currentHeight = await page.evaluate(() => document.body.scrollHeight);

                    if (currentHeight === previousHeight) {
                        // Try clicking "Load more" button as fallback
                        try {
                            const loadMore = page.locator('a:has-text("Load more"), button:has-text("Load more"), .bttn-primary').first();
                            if (await loadMore.isVisible({ timeout: 2000 })) {
                                await loadMore.click();
                                await randomDelay(2000, 3000);
                            } else {
                                log.info('No more content to load');
                                break;
                            }
                        } catch {
                            log.info('Pagination complete');
                            break;
                        }
                    }

                    previousHeight = currentHeight;

                    // Scroll to bottom
                    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                    await randomDelay(2000, 3000);
                    scrollAttempts++;
                }

                log.info(`Finished. Total: ${saved} projects`);
            },

            failedRequestHandler({ request }, error) {
                log.error(`Failed: ${request.url} - ${error.message}`);
            },
        });

        await crawler.run([{ url: finalUrl }]);
        log.info(`✅ Complete! Saved ${saved} Kickstarter projects`);

    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
