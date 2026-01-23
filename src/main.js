import { PlaywrightCrawler, Dataset } from 'crawlee';
import { Actor, log } from 'apify';

await Actor.init();

const DEFAULT_START_URL = 'https://www.kickstarter.com/discover';

const normalizeUrl = (url) => {
    if (!url) return null;
    try {
        const u = new URL(url);
        u.search = '';
        u.hash = '';
        return u.toString();
    } catch {
        return url.split('?')[0];
    }
};

const buildBaseUrl = ({ startUrl, category, sort }) => {
    if (startUrl && startUrl !== DEFAULT_START_URL) return startUrl;
    const url = new URL('https://www.kickstarter.com/discover/advanced');
    if (category) url.searchParams.set('category', category);
    if (sort) url.searchParams.set('sort', sort);
    return url.toString();
};

const buildPageUrl = (baseUrl, page) => {
    const url = new URL(baseUrl);
    url.searchParams.set('page', String(page));
    return url.toString();
};

const parsePositiveInt = (value, fallback) => {
    const numberValue = Number.parseInt(value, 10);
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            startUrl = DEFAULT_START_URL,
            category = '',
            sort = 'magic',
            results_wanted: resultsWantedRaw = 20,
            max_pages: maxPagesRaw = 5,
            proxyConfiguration: proxyConfig,
            collectDetails = false,
        } = input;

        if (collectDetails) {
            log.warningOnce('collectDetails is enabled, but detail-page scraping is not implemented.');
        }

        const resultsWanted = parsePositiveInt(resultsWantedRaw, 20);
        const maxPages = parsePositiveInt(maxPagesRaw, 5);

        const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig || {
            useApifyProxy: true,
            apifyProxyGroups: ['RESIDENTIAL'],
        });

        const baseUrl = buildBaseUrl({ startUrl, category, sort });
        const requestQueue = await Actor.openRequestQueue();
        await requestQueue.addRequest({
            url: buildPageUrl(baseUrl, 1),
            userData: { page: 1, baseUrl },
        });

        let saved = 0;
        const seenUrls = new Set();

        log.info(`Starting Kickstarter scraper - Target: ${resultsWanted} projects`);

        const crawler = new PlaywrightCrawler({
            requestQueue,
            proxyConfiguration,
            maxRequestRetries: 3,
            maxConcurrency: 1,
            minConcurrency: 1,
            requestHandlerTimeoutSecs: 180,
            navigationTimeoutSecs: 60,
            useSessionPool: true,
            sessionPoolOptions: {
                maxPoolSize: 8,
                sessionOptions: { maxUsageCount: 3 },
            },
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
                        if (['image', 'stylesheet', 'font', 'media'].includes(type)
                            || url.includes('google-analytics')
                            || url.includes('googletagmanager')
                            || url.includes('facebook')) {
                            return route.abort();
                        }
                        return route.continue();
                    });

                    await page.addInitScript(() => {
                        Object.defineProperty(navigator, 'webdriver', { get: () => false });
                        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                        window.chrome = { runtime: {} };
                    });

                    await page.setExtraHTTPHeaders({
                        'accept-language': 'en-US,en;q=0.9',
                    });
                },
            ],
            async requestHandler({ request, page, response, session }) {
                const pageNumber = request.userData.page || 1;

                if (response && response.status && response.status() === 403) {
                    session?.markBad();
                    throw new Error('Request blocked - received 403 status code.');
                }

                if (response && response.status && response.status() >= 400) {
                    log.warning(`Request failed: ${request.url} (status ${response.status()})`);
                    return;
                }

                await page.waitForLoadState('domcontentloaded');
                await page.waitForSelector('.js-react-proj-card', { timeout: 15000 }).catch(() => {});

                const cards = await page.$$('.js-react-proj-card');
                if (!cards.length) {
                    log.warning(`No project cards found on page ${pageNumber}`);
                    return;
                }

                const projects = await page.evaluate(() => {
                    const cards = Array.from(document.querySelectorAll('.js-react-proj-card'));
                    return cards.map((card) => {
                        try {
                            const dataProjectRaw = card.getAttribute('data-project');
                            let dataProject = null;
                            if (dataProjectRaw) {
                                try {
                                    dataProject = JSON.parse(dataProjectRaw);
                                } catch {
                                    dataProject = null;
                                }
                            }

                            const titleLink = card.querySelector('.project-card__title');
                            const title = titleLink?.textContent?.trim() || null;
                            const href = titleLink?.getAttribute('href');
                            const url = href
                                ? (href.startsWith('http') ? href : `https://www.kickstarter.com${href}`)
                                : null;

                            const creatorEl = card.querySelector('.project-card__creator');
                            const creator = creatorEl?.textContent?.trim()?.replace(/^by\s+/i, '') || null;

                            const img = card.querySelector('img');
                            const imageUrl = img?.getAttribute('src')
                                || img?.getAttribute('data-src')
                                || img?.getAttribute('srcset')?.split(',')[0]?.trim()?.split(' ')[0]
                                || null;

                            const categoryLink = card.querySelector('a[href*="/discover/categories/"]');
                            const category = categoryLink?.textContent?.trim() || null;

                            const locationEl = card.querySelector('.project-card__location, [data-test-id="project-location"]');
                            const location = locationEl?.textContent?.trim()
                                || dataProject?.location?.displayable_name
                                || dataProject?.location?.short_name
                                || null;

                            const allText = card.textContent || '';
                            const lines = allText.split('\n').map((line) => line.trim()).filter(Boolean);

                            let daysLeft = dataProject?.deadline
                                ? String(Math.max(0, Math.ceil((dataProject.deadline * 1000 - Date.now()) / 86400000)))
                                : null;
                            let percentageFunded = dataProject?.percent_funded ? String(dataProject.percent_funded) : null;
                            let pledged = dataProject?.pledged ? String(dataProject.pledged) : null;
                            let backers = dataProject?.backers_count ? String(dataProject.backers_count) : null;
                            let fundingGoal = dataProject?.goal ? String(dataProject.goal) : null;

                            for (const line of lines) {
                                if (!daysLeft) {
                                    const daysMatch = line.match(/^(\d+)\s*days?\s*(left|to go)?$/i)
                                        || line.match(/(\d+)\s*days?\s*(left|to go)/i);
                                    if (daysMatch) daysLeft = daysMatch[1];
                                }

                                if (!percentageFunded) {
                                    const percentMatch = line.match(/(\d+)%\s*funded/i)
                                        || line.match(/^(\d+)%$/);
                                    if (percentMatch) percentageFunded = percentMatch[1];
                                }

                                if (!backers) {
                                    const backersMatch = line.match(/([\d,]+)\s*backers?/i);
                                    if (backersMatch) backers = backersMatch[1].replace(/,/g, '');
                                }

                                if (!pledged) {
                                    const pledgedMatch = line.match(/([€£$][\d,]+)\s*pledged/i);
                                    if (pledgedMatch) pledged = pledgedMatch[1].replace(/[€£$,]/g, '');
                                }

                                if (!fundingGoal) {
                                    const goalMatch = line.match(/of\s*([€£$][\d,]+)\s*goal/i);
                                    if (goalMatch) fundingGoal = goalMatch[1].replace(/[€£$,]/g, '');
                                }
                            }

                            if (!percentageFunded) {
                                const match = allText.match(/(\d+)%/);
                                if (match) percentageFunded = match[1];
                            }
                            if (!daysLeft) {
                                const match = allText.match(/(\d+)\s*days?/i);
                                if (match) daysLeft = match[1];
                            }

                            return {
                                title,
                                creator,
                                url,
                                image_url: imageUrl,
                                pledged,
                                backers,
                                funding_goal: fundingGoal,
                                days_left: daysLeft,
                                percentage_funded: percentageFunded,
                                category,
                                location,
                            };
                        } catch {
                            return null;
                        }
                    }).filter((project) => project && project.title && project.url);
                });

                const newProjects = projects.filter((project) => {
                    const normalized = normalizeUrl(project.url);
                    if (!normalized || seenUrls.has(normalized)) return false;
                    seenUrls.add(normalized);
                    return true;
                });

                if (newProjects.length > 0) {
                    const toSave = newProjects.slice(0, resultsWanted - saved);
                    await Dataset.pushData(toSave);
                    saved += toSave.length;
                    log.info(`Saved ${toSave.length} unique projects (total: ${saved}/${resultsWanted})`);
                }

                if (saved >= resultsWanted) {
                    log.info('Reached target number of projects.');
                    return;
                }

                if (pageNumber >= maxPages) {
                    log.info(`Reached max pages limit (${maxPages}).`);
                    return;
                }

                if (newProjects.length === 0) {
                    log.warning('No new projects detected; stopping pagination.');
                    return;
                }

                await sleep(1000 + Math.random() * 2000);
                const nextPage = pageNumber + 1;
                const nextUrl = buildPageUrl(request.userData.baseUrl, nextPage);
                await requestQueue.addRequest({
                    url: nextUrl,
                    userData: { page: nextPage, baseUrl: request.userData.baseUrl },
                });
                log.info(`Enqueued page ${nextPage}`);
            },
            failedRequestHandler({ request }, error) {
                log.error(`Failed: ${request.url} - ${error.message}`);
            },
        });

        await crawler.run();
        log.info(`Complete! Saved ${saved} Kickstarter projects`);
    } finally {
        await Actor.exit();
    }
}

main().catch((err) => {
    log.exception(err, 'Unhandled error');
    process.exit(1);
});
