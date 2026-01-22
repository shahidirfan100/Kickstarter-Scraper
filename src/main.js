// Kickstarter Projects Scraper - Playwright Chrome with Maximum Stealth + Correct Selectors
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { Actor, log } from 'apify';

await Actor.init();

// Random delay utility for human-like behavior
const randomDelay = (min = 500, max = 2000) =>
    new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            startUrl = 'https://www.kickstarter.com/discover',
            category = '',
            sort = 'magic',
            results_wanted: RESULTS_WANTED_RAW = 20,
            max_pages: MAX_PAGES_RAW = 5,
            collectDetails = false,
            proxyConfiguration: proxyConfig,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 20;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 5;

        // Create proxy configuration (residential recommended for Kickstarter)
        const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig || {
            useApifyProxy: true,
            apifyProxyGroups: ['RESIDENTIAL'],
        });

        let saved = 0;
        let loadMoreClicks = 0;
        const seenUrls = new Set();

        // Build URL with filters if provided
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
        log.info(`Target: ${RESULTS_WANTED} projects, Max pages: ${MAX_PAGES}`);

        const crawler = new PlaywrightCrawler({
            proxyConfiguration,
            maxRequestRetries: 5,

            // Session pooling for IP rotation
            useSessionPool: true,
            sessionPoolOptions: {
                maxPoolSize: 5,
                sessionOptions: {
                    maxUsageCount: 3,
                },
            },

            maxConcurrency: 2,
            requestHandlerTimeoutSecs: 120,
            navigationTimeoutSecs: 60,

            // Advanced fingerprint generation for maximum stealth
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

            // Pre-navigation hooks for resource blocking and stealth
            preNavigationHooks: [
                async ({ page }) => {
                    // RESOURCE BLOCKING - Massive performance and cost savings
                    await page.route('**/*', (route) => {
                        const type = route.request().resourceType();
                        const url = route.request().url();

                        // Block images, fonts, media, and trackers
                        if (['image', 'font', 'media'].includes(type) ||
                            url.includes('google-analytics') ||
                            url.includes('googletagmanager') ||
                            url.includes('facebook') ||
                            url.includes('doubleclick') ||
                            url.includes('pinterest') ||
                            url.includes('adsense') ||
                            url.includes('tracking') ||
                            url.includes('analytics') ||
                            url.includes('adserver')) {
                            return route.abort();
                        }
                        return route.continue();
                    });

                    // ADVANCED STEALTH SCRIPTS
                    await page.addInitScript(() => {
                        Object.defineProperty(navigator, 'webdriver', { get: () => false });
                        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                        window.chrome = { runtime: {} };
                        const originalQuery = window.navigator.permissions.query;
                        window.navigator.permissions.query = (parameters) => (
                            parameters.name === 'notifications' ?
                                Promise.resolve({ state: Notification.permission }) :
                                originalQuery(parameters)
                        );
                    });

                    await randomDelay(1000, 3000);
                },
            ],

            async requestHandler({ page, request }) {
                const label = request.userData?.label || 'DISCOVER';

                if (label === 'DISCOVER') {
                    await page.waitForLoadState('domcontentloaded');
                    await page.waitForLoadState('networkidle').catch(() => { });

                    log.info('Page loaded, waiting for projects...');

                    // Handle cookie consent
                    try {
                        const cookieButton = page.locator('button:has-text("Accept all cookies"), button:has-text("Accept"), button:has-text("OK")').first();
                        if (await cookieButton.isVisible({ timeout: 3000 })) {
                            await cookieButton.click();
                            await randomDelay(1000, 2000);
                            log.info('Accepted cookies');
                        }
                    } catch (e) { }

                    // Scroll to trigger lazy loading
                    await page.evaluate(async () => {
                        const scrollStep = 300 + Math.random() * 200;
                        for (let y = 0; y < Math.min(800, document.body.scrollHeight); y += scrollStep) {
                            window.scrollTo(0, y);
                            await new Promise(r => setTimeout(r, 100 + Math.random() * 100));
                        }
                    });
                    await randomDelay(1500, 2500);

                    // Extract projects in a loop with pagination
                    while (saved < RESULTS_WANTED && loadMoreClicks < MAX_PAGES) {
                        // Wait for project cards to load - using CORRECT selector: .js-react-proj-card
                        let retries = 0;
                        const maxRetries = 10;
                        let projects = [];

                        while (retries < maxRetries && projects.length === 0) {
                            await page.waitForTimeout(1000);
                            retries++;

                            // Extract projects using CORRECT Kickstarter selectors
                            projects = await page.evaluate(() => {
                                // CORRECT SELECTOR: .js-react-proj-card is the project card container
                                const cards = Array.from(document.querySelectorAll('.js-react-proj-card'));

                                return cards.map(card => {
                                    try {
                                        // Title and URL from .project-card__title
                                        const titleLink = card.querySelector('.project-card__title');
                                        const title = titleLink?.innerText?.trim() || null;
                                        const relativeUrl = titleLink?.getAttribute('href');
                                        const url = relativeUrl ?
                                            (relativeUrl.startsWith('http') ? relativeUrl : `https://www.kickstarter.com${relativeUrl}`)
                                            : null;

                                        // Creator from .project-card__creator
                                        const creatorEl = card.querySelector('.project-card__creator');
                                        const creator = creatorEl?.innerText?.trim()?.replace(/^by\s+/i, '') || null;

                                        // Image from .project-card__media img
                                        const img = card.querySelector('.project-card__media img, img');
                                        const image_url = img?.src || img?.getAttribute('data-src') || img?.getAttribute('srcset')?.split(',')[0]?.trim()?.split(' ')[0] || null;

                                        // Data-pid for deduplication
                                        const dataPid = card.getAttribute('data-pid');

                                        // Extract funding info from all paragraphs and text content
                                        const allText = card.innerText || '';

                                        // Parse percentage funded (e.g., "459% funded")
                                        const percentMatch = allText.match(/(\d+)%\s*funded/i);
                                        const percentage_funded = percentMatch ? percentMatch[1] : null;

                                        // Parse days left (e.g., "28 days left")
                                        const daysMatch = allText.match(/(\d+)\s*days?\s*(?:left|to go)/i);
                                        const days_left = daysMatch ? daysMatch[1] : null;

                                        // Parse pledged amount (e.g., "$12,345")
                                        const pledgedMatch = allText.match(/\$([0-9,]+)/);
                                        const pledged = pledgedMatch ? pledgedMatch[1].replace(/,/g, '') : null;

                                        // Parse backers count
                                        const backersMatch = allText.match(/(\d+)\s*backers?/i);
                                        const backers = backersMatch ? backersMatch[1] : null;

                                        // Category from link or text
                                        const categoryLink = card.querySelector('a[href*="/discover/categories/"]');
                                        const category = categoryLink?.innerText?.trim() || null;

                                        // Location (if available)
                                        const locationMatch = card.querySelector('[class*="location"]');
                                        const location = locationMatch?.innerText?.trim() || null;

                                        return {
                                            title,
                                            creator,
                                            url,
                                            image_url,
                                            data_pid: dataPid,
                                            funding_goal: null,
                                            pledged,
                                            backers,
                                            days_left,
                                            percentage_funded,
                                            category,
                                            location
                                        };
                                    } catch (err) {
                                        return null;
                                    }
                                }).filter(p => p && p.title && p.url);
                            });

                            if (projects.length > 0) {
                                log.info(`Found ${projects.length} project cards with .js-react-proj-card selector`);
                            }
                        }

                        if (projects.length === 0) {
                            log.warning(`No projects found after ${maxRetries} attempts`);

                            // Debug: Save page HTML to key-value store
                            const html = await page.content();
                            await Actor.setValue('debug-page', html, { contentType: 'text/html' });
                            log.info('Saved debug HTML to key-value store');
                            break;
                        }

                        // Filter out duplicates and limit to remaining needed
                        const newProjects = projects.filter(p => {
                            const key = p.url || p.data_pid;
                            if (seenUrls.has(key)) return false;
                            seenUrls.add(key);
                            return true;
                        });

                        const toSave = newProjects.slice(0, RESULTS_WANTED - saved);

                        if (toSave.length > 0) {
                            // Remove data_pid from output
                            const cleanProjects = toSave.map(({ data_pid, ...rest }) => rest);
                            await Dataset.pushData(cleanProjects);
                            saved += cleanProjects.length;
                            log.info(`Saved ${cleanProjects.length} new projects (total: ${saved}/${RESULTS_WANTED})`);
                        }

                        if (saved >= RESULTS_WANTED) {
                            log.info('✅ Reached target number of results');
                            break;
                        }

                        // Pagination: Click "Load more" button
                        loadMoreClicks++;
                        if (loadMoreClicks >= MAX_PAGES) {
                            log.info('Reached maximum page limit');
                            break;
                        }

                        try {
                            const loadMoreButton = page.locator('a.bttn-primary, button:has-text("Load more"), a:has-text("Load more")').first();

                            if (await loadMoreButton.isVisible({ timeout: 5000 })) {
                                log.info(`Clicking "Load more" (click ${loadMoreClicks}/${MAX_PAGES})`);

                                await page.mouse.move(100 + Math.random() * 300, 100 + Math.random() * 300);
                                await loadMoreButton.scrollIntoViewIfNeeded();
                                await randomDelay(500, 1500);
                                await loadMoreButton.click();
                                await randomDelay(3000, 5000);

                                // Scroll to load new content
                                await page.evaluate(async () => {
                                    const scrollStep = 300 + Math.random() * 200;
                                    for (let y = window.scrollY; y < document.body.scrollHeight; y += scrollStep) {
                                        window.scrollTo(0, y);
                                        await new Promise(r => setTimeout(r, 100));
                                    }
                                });
                                await randomDelay(1000, 2000);
                            } else {
                                log.info('No "Load more" button found');
                                break;
                            }
                        } catch (e) {
                            log.info('Pagination ended');
                            break;
                        }
                    }

                    log.info(`Finished scraping. Total projects collected: ${saved}`);
                }
            },

            failedRequestHandler({ request }, error) {
                if (error.message?.includes('403')) {
                    log.warning(`⚠️ Blocked (403): ${request.url}`);
                } else {
                    log.error(`Request failed: ${request.url} - ${error.message}`);
                }
            },
        });

        await crawler.run([{ url: finalUrl, userData: { label: 'DISCOVER' } }]);
        log.info(`✅ Scraping complete! Saved ${saved} Kickstarter projects`);

    } finally {
        await Actor.exit();
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
