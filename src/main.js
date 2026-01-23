import { CheerioCrawler, Dataset } from 'crawlee';
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

const makeAbsoluteUrl = (href) => {
    if (!href) return null;
    if (href.startsWith('http://') || href.startsWith('https://')) return href;
    if (href.startsWith('//')) return `https:${href}`;
    return `https://www.kickstarter.com${href}`;
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

const parseNumberFromText = (text, regex) => {
    const match = text.match(regex);
    return match ? match[1].replace(/,/g, '') : null;
};

const extractProject = ($card) => {
    const titleLink = $card.find('.project-card__title').first();
    const title = titleLink.text().trim() || null;
    const href = titleLink.attr('href');
    const url = makeAbsoluteUrl(href);

    const creatorEl = $card.find('.project-card__creator').first();
    const creator = creatorEl.text().trim().replace(/^by\s+/i, '') || null;

    const img = $card.find('img').first();
    let imageUrl = img.attr('src') || img.attr('data-src') || null;
    const srcset = img.attr('srcset');
    if (!imageUrl && srcset) {
        imageUrl = srcset.split(',')[0].trim().split(' ')[0];
    }

    const categoryLink = $card.find('a[href*="/discover/categories/"]').first();
    const category = categoryLink.text().trim() || null;

    const locationEl = $card.find('.project-card__location, [data-test-id="project-location"]').first();
    const location = locationEl.text().trim() || null;

    const allText = $card.text() || '';
    const lines = allText.split('\n').map((line) => line.trim()).filter(Boolean);

    let daysLeft = null;
    let percentageFunded = null;
    let pledged = null;
    let backers = null;
    let fundingGoal = null;

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
            backers = parseNumberFromText(line, /([\d,]+)\s*backers?/i);
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
};

const parsePositiveInt = (value, fallback) => {
    const numberValue = Number.parseInt(value, 10);
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
};

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

        const crawler = new CheerioCrawler({
            requestQueue,
            proxyConfiguration,
            maxRequestRetries: 3,
            maxConcurrency: 5,
            minConcurrency: 1,
            maxRequestsPerMinute: 30,
            requestHandlerTimeoutSecs: 120,
            async requestHandler({ request, $, response }) {
                const page = request.userData.page || 1;

                if (!response || response.statusCode >= 400) {
                    log.warning(`Request failed: ${request.url} (status ${response?.statusCode || 'n/a'})`);
                    return;
                }

                const cards = $('.js-react-proj-card');
                if (!cards.length) {
                    log.warning(`No project cards found on page ${page}`);
                    return;
                }

                const projects = [];
                cards.each((_, el) => {
                    const project = extractProject($(el));
                    if (project && project.title && project.url) {
                        projects.push(project);
                    }
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

                if (page >= maxPages) {
                    log.info(`Reached max pages limit (${maxPages}).`);
                    return;
                }

                if (newProjects.length === 0) {
                    log.warning('No new projects detected; stopping pagination.');
                    return;
                }

                const nextPage = page + 1;
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
