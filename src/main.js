// Kickstarter Projects Scraper - Fixed extraction + proper deduplication
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { Actor, log } from 'apify';

await Actor.init();

const randomDelay = (min = 500, max = 2000) =>
    new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

// Normalize URL for deduplication (strip query params)
const normalizeUrl = (url) => {
    if (!url) return null;
    try {
        const u = new URL(url);
        // Keep only the path, remove query params like ?ref=
        return `${u.origin}${u.pathname}`;
    } catch {
        return url.split('?')[0];
    }
};

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            startUrl = 'https://www.kickstarter.com/discover',
            category = '',
            sort = 'magic',
            results_wanted: RESULTS_WANTED_RAW = 20,
            max_pages: MAX_PAGES_RAW = 5,
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
        log.info(`Starting Kickstarter scraper - Target: ${RESULTS_WANTED} projects`);

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
                    await page.route('**/*', (route) => {
                        const type = route.request().resourceType();
                        const url = route.request().url();
                        // Keep images for getting image URLs
                        if (['font', 'media'].includes(type) ||
                            url.includes('google-analytics') ||
                            url.includes('googletagmanager') ||
                            url.includes('facebook')) {
                            return route.abort();
                        }
                        return route.continue();
                    });

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

                log.info('Page loaded, extracting projects...');

                // Handle cookies
                try {
                    const cookieBtn = page.locator('button:has-text("Accept"), button:has-text("OK")').first();
                    if (await cookieBtn.isVisible({ timeout: 2000 })) {
                        await cookieBtn.click();
                        await randomDelay(500, 1000);
                    }
                } catch { }

                // Initial scroll to load content
                await page.evaluate(() => window.scrollTo(0, 500));
                await randomDelay(1500, 2500);

                let previousHeight = 0;
                let scrollAttempts = 0;
                const maxScrollAttempts = MAX_PAGES * 3;

                while (saved < RESULTS_WANTED && scrollAttempts < maxScrollAttempts) {
                    // Extract projects with FIXED regex patterns
                    const projects = await page.evaluate(() => {
                        const cards = Array.from(document.querySelectorAll('.js-react-proj-card'));

                        return cards.map(card => {
                            try {
                                // Title and URL
                                const titleLink = card.querySelector('.project-card__title');
                                const title = titleLink?.innerText?.trim() || null;
                                const href = titleLink?.getAttribute('href');
                                // Normalize URL - remove query params for deduplication
                                let url = href ? (href.startsWith('http') ? href : `https://www.kickstarter.com${href}`) : null;
                                if (url) {
                                    try {
                                        const u = new URL(url);
                                        url = `${u.origin}${u.pathname}`; // Strip query params
                                    } catch { }
                                }

                                // Creator
                                const creatorEl = card.querySelector('.project-card__creator');
                                const creator = creatorEl?.innerText?.trim()?.replace(/^by\s+/i, '') || null;

                                // Image - get actual src
                                const img = card.querySelector('img');
                                const image_url = img?.src || img?.getAttribute('data-src') ||
                                    img?.srcset?.split(',')[0]?.trim()?.split(' ')[0] || null;

                                // Category from link
                                const categoryLink = card.querySelector('a[href*="/discover/categories/"]');
                                const category = categoryLink?.innerText?.trim() || null;

                                // Get ALL text from the card for parsing
                                const allText = card.innerText || '';
                                const lines = allText.split('\n').map(l => l.trim()).filter(l => l);

                                // FIXED PARSING - Look for specific patterns
                                let days_left = null;
                                let percentage_funded = null;
                                let pledged = null;
                                let backers = null;
                                let funding_goal = null;

                                // Find the line with funding info (usually contains "days" and "%")
                                for (const line of lines) {
                                    // Days left pattern: "28 days left" or "28 days to go"
                                    if (!days_left) {
                                        const daysMatch = line.match(/^(\d+)\s*days?\s*(left|to go)?$/i) ||
                                            line.match(/(\d+)\s*days?\s*(left|to go)/i);
                                        if (daysMatch) days_left = daysMatch[1];
                                    }

                                    // Percentage funded: "459% funded" or just "459%"
                                    if (!percentage_funded) {
                                        const percentMatch = line.match(/(\d+)%\s*funded/i) ||
                                            line.match(/^(\d+)%$/);
                                        if (percentMatch) percentage_funded = percentMatch[1];
                                    }

                                    // Backers: "1,234 backers"
                                    if (!backers) {
                                        const backersMatch = line.match(/([\d,]+)\s*backers?/i);
                                        if (backersMatch) backers = backersMatch[1].replace(/,/g, '');
                                    }

                                    // Pledged amount: "$12,345 pledged" or "€5,000 pledged"
                                    if (!pledged) {
                                        const pledgedMatch = line.match(/([€£$][\d,]+)\s*pledged/i);
                                        if (pledgedMatch) pledged = pledgedMatch[1].replace(/[€£$,]/g, '');
                                    }

                                    // Funding goal: "of $10,000 goal"
                                    if (!funding_goal) {
                                        const goalMatch = line.match(/of\s*([€£$][\d,]+)\s*goal/i);
                                        if (goalMatch) funding_goal = goalMatch[1].replace(/[€£$,]/g, '');
                                    }
                                }

                                // Also check the combined text for patterns
                                if (!percentage_funded) {
                                    const m = allText.match(/(\d+)%/);
                                    if (m) percentage_funded = m[1];
                                }
                                if (!days_left) {
                                    const m = allText.match(/(\d+)\s*days?/i);
                                    if (m) days_left = m[1];
                                }

                                return {
                                    title,
                                    creator,
                                    url,
                                    image_url,
                                    pledged,
                                    backers,
                                    funding_goal,
                                    days_left,
                                    percentage_funded,
                                    category,
                                    location: null,
                                };
                            } catch {
                                return null;
                            }
                        }).filter(p => p && p.title && p.url);
                    });

                    // Filter duplicates using normalized URLs
                    const newProjects = projects.filter(p => {
                        const normalizedUrl = normalizeUrl(p.url);
                        if (seenUrls.has(normalizedUrl)) return false;
                        seenUrls.add(normalizedUrl);
                        return true;
                    });

                    if (newProjects.length > 0) {
                        const toSave = newProjects.slice(0, RESULTS_WANTED - saved);
                        await Dataset.pushData(toSave);
                        saved += toSave.length;
                        log.info(`Saved ${toSave.length} unique projects (total: ${saved}/${RESULTS_WANTED})`);
                    }

                    if (saved >= RESULTS_WANTED) {
                        log.info('✅ Reached target');
                        break;
                    }

                    // Check if page height changed
                    const currentHeight = await page.evaluate(() => document.body.scrollHeight);

                    if (currentHeight === previousHeight) {
                        // Try Load more button
                        try {
                            const loadMore = page.locator('a:has-text("Load more"), button:has-text("Load more"), a.bttn.bttn-primary').first();
                            if (await loadMore.isVisible({ timeout: 3000 })) {
                                log.info('Clicking Load more button...');
                                await loadMore.scrollIntoViewIfNeeded();
                                await randomDelay(500, 1000);
                                await loadMore.click();
                                await randomDelay(3000, 4000);
                            } else {
                                log.info('No more content available');
                                break;
                            }
                        } catch {
                            log.info('Pagination complete');
                            break;
                        }
                    } else {
                        // Just scroll
                        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                        await randomDelay(2000, 3000);
                    }

                    previousHeight = currentHeight;
                    scrollAttempts++;
                }

                log.info(`Finished extraction. Total: ${saved} unique projects`);
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
