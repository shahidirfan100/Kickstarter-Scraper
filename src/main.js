// Kickstarter Projects Scraper - Playwright Chrome with Maximum Stealth
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
                    maxUsageCount: 3, // Rotate sessions frequently
                },
            },

            maxConcurrency: 2, // Lower concurrency for stealth
            requestHandlerTimeoutSecs: 120,
            navigationTimeoutSecs: 60,

            // Advanced fingerprint generation for maximum stealth
            browserPoolOptions: {
                useFingerprints: true,
                fingerprintOptions: {
                    fingerprintGeneratorOptions: {
                        browsers: ['chrome'], // Chrome for best compatibility
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

                        // Block images, fonts, media, and trackers (keeps stylesheets for rendering)
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

                    // ADVANCED STEALTH SCRIPTS - Hide all automation traces
                    await page.addInitScript(() => {
                        // Hide webdriver property
                        Object.defineProperty(navigator, 'webdriver', { get: () => false });

                        // Mock plugins to avoid headless detection
                        Object.defineProperty(navigator, 'plugins', {
                            get: () => [1, 2, 3, 4, 5],
                        });

                        // Mock languages
                        Object.defineProperty(navigator, 'languages', {
                            get: () => ['en-US', 'en'],
                        });

                        // Add chrome runtime
                        window.chrome = { runtime: {} };

                        // Override permissions query to avoid detection
                        const originalQuery = window.navigator.permissions.query;
                        window.navigator.permissions.query = (parameters) => (
                            parameters.name === 'notifications' ?
                                Promise.resolve({ state: Notification.permission }) :
                                originalQuery(parameters)
                        );
                    });

                    // Human-like initial delay
                    await randomDelay(1000, 3000);
                },
            ],

            async requestHandler({ page, request }) {
                const label = request.userData?.label || 'DISCOVER';

                if (label === 'DISCOVER') {
                    // Wait for page to fully load
                    await page.waitForLoadState('domcontentloaded');
                    await page.waitForLoadState('networkidle').catch(() => { });

                    log.info('Page loaded, waiting for projects...');

                    // Handle cookie consent if present
                    try {
                        const cookieButton = page.locator('button:has-text("Accept all cookies"), button:has-text("OK")').first();
                        if (await cookieButton.isVisible({ timeout: 3000 })) {
                            await cookieButton.click();
                            await randomDelay(1000, 2000);
                            log.info('Accepted cookies');
                        }
                    } catch (e) {
                        // No cookie banner
                    }

                    // Human-like scrolling pattern
                    await page.evaluate(async () => {
                        const scrollStep = 300 + Math.random() * 200;
                        const delay = 100 + Math.random() * 150;

                        for (let y = 0; y < Math.min(500, document.body.scrollHeight); y += scrollStep) {
                            window.scrollTo(0, y);
                            await new Promise(r => setTimeout(r, delay));
                        }
                    });

                    await randomDelay(1000, 2000);

                    // Extract projects in a loop with "Load more" clicking
                    while (saved < RESULTS_WANTED && loadMoreClicks < MAX_PAGES) {
                        // Retry loop for data availability
                        let retries = 0;
                        const maxRetries = 10;
                        let projects = [];

                        while (retries < maxRetries && projects.length === 0) {
                            await page.waitForTimeout(1000);
                            retries++;

                            // Extract all visible projects
                            projects = await page.evaluate(() => {
                                const cards = Array.from(document.querySelectorAll('[data-test-id="project-card"]'));

                                return cards.map(card => {
                                    try {
                                        // Extract title and URL
                                        const titleLink = card.querySelector('a[href*="/projects/"]');
                                        const title = titleLink?.textContent?.trim() || null;
                                        const relativeUrl = titleLink?.getAttribute('href');
                                        const url = relativeUrl ? `https://www.kickstarter.com${relativeUrl}` : null;

                                        // Extract creator
                                        const creatorLink = card.querySelector('a[href*="/profile/"]');
                                        const creator = creatorLink?.textContent?.trim() || null;

                                        // Extract image (note: images blocked, but URL is still in DOM)
                                        const img = card.querySelector('img');
                                        const image_url = img?.src || img?.getAttribute('data-src') || img?.getAttribute('srcset')?.split(',')[0]?.trim()?.split(' ')[0] || null;

                                        // Extract funding info from text
                                        const fundingText = card.textContent || '';

                                        // Parse pledged amount
                                        const pledgedMatch = fundingText.match(/pledged/i);
                                        let pledged = null;
                                        if (pledgedMatch) {
                                            const amountMatch = fundingText.match(/\\$([\\d,]+)/);
                                            pledged = amountMatch ? amountMatch[1].replace(/,/g, '') : null;
                                        }

                                        // Parse percentage funded
                                        const percentMatch = fundingText.match(/(\\d+)%/);
                                        const percentage_funded = percentMatch ? percentMatch[1] : null;

                                        // Parse backers
                                        const backersMatch = fundingText.match(/(\\d+)\\s+backers/i);
                                        const backers = backersMatch ? backersMatch[1] : null;

                                        // Parse days left
                                        const daysMatch = fundingText.match(/(\\d+)\\s+days?\\s+(?:to go|left)/i);
                                        const days_left = daysMatch ? daysMatch[1] : null;

                                        // Extract category from link or text
                                        const categoryLink = card.querySelector('a[href*="/discover/categories/"]');
                                        const category = categoryLink?.textContent?.trim() || null;

                                        // Extract location if available
                                        const locationText = card.querySelector('[class*="location"]');
                                        const location = locationText?.textContent?.trim() || null;

                                        return {
                                            title,
                                            creator,
                                            url,
                                            image_url,
                                            funding_goal: null, // Not always visible on cards
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
                        }

                        if (projects.length === 0) {
                            log.warning(`No projects found after ${maxRetries} attempts`);
                            break;
                        }

                        // Filter and limit to remaining needed
                        const remaining = RESULTS_WANTED - saved;
                        const newProjects = projects.slice(0, remaining);

                        if (newProjects.length > 0) {
                            await Dataset.pushData(newProjects);
                            saved += newProjects.length;
                            log.info(`Extracted ${newProjects.length} projects (total: ${saved}/${RESULTS_WANTED})`);
                        }

                        // Check if we have enough
                        if (saved >= RESULTS_WANTED) {
                            log.info('✅ Reached target number of results');
                            break;
                        }

                        // Try to click "Load more" button
                        loadMoreClicks++;
                        if (loadMoreClicks >= MAX_PAGES) {
                            log.info('Reached maximum page limit');
                            break;
                        }

                        try {
                            // Look for "Load more" button
                            const loadMoreButton = page.locator('a.bttn-primary, button:has-text("Load more"), a:has-text("Load more")').first();

                            if (await loadMoreButton.isVisible({ timeout: 3000 })) {
                                log.info(`Clicking "Load more" (click ${loadMoreClicks}/${MAX_PAGES})`);

                                // Human-like mouse movement before clicking
                                await page.mouse.move(
                                    100 + Math.random() * 300,
                                    100 + Math.random() * 300
                                );

                                // Scroll to button with human-like behavior
                                await loadMoreButton.scrollIntoViewIfNeeded();
                                await randomDelay(500, 1500);

                                // Click and wait for new content
                                await loadMoreButton.click();
                                await randomDelay(3000, 5000); // 3-5 seconds

                                // Human-like scroll down to trigger lazy loading
                                await page.evaluate(async () => {
                                    const scrollStep = 300 + Math.random() * 200;
                                    const delay = 100 + Math.random() * 150;

                                    for (let y = window.scrollY; y < document.body.scrollHeight; y += scrollStep) {
                                        window.scrollTo(0, y);
                                        await new Promise(r => setTimeout(r, delay));
                                    }
                                });

                                await randomDelay(1000, 2000);
                            } else {
                                log.info('No "Load more" button found, pagination complete');
                                break;
                            }
                        } catch (e) {
                            log.info('Could not find or click "Load more" button, ending pagination');
                            break;
                        }
                    }

                    log.info(`Finished scraping. Total projects collected: ${saved}`);
                }

                if (label === 'DETAIL' && collectDetails) {
                    // TODO: Implement detail page scraping if needed
                    log.info(`Detail scraping not yet implemented for: ${request.url}`);
                }
            },

            failedRequestHandler({ request }, error) {
                if (error.message?.includes('403')) {
                    log.warning(`⚠️ Blocked (403): ${request.url} - Cloudflare may have detected automation`);
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
