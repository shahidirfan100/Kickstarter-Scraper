# Kickstarter Projects Scraper

Extract project data from Kickstarter's discover page with ease. This powerful scraper collects project titles, creators, funding information, backers, images, and more from any Kickstarter category or custom search URL.

## Features

- 🚀 **Fast & Reliable** - Automated browser scraping with intelligent pagination
- 📊 **Comprehensive Data** - Extracts all key project metrics including funding goals, pledges, backers, and deadlines
- 🎯 **Flexible Filtering** - Search by category, sort order, or provide custom Kickstarter URLs
- 🔄 **Smart Pagination** - Automatically loads more results until target is reached
- 🛡️ **Stealth Mode** - Built-in anti-detection features for reliable scraping
- 💾 **Structured Output** - Clean JSON data ready for analysis or integration

---

## Use Cases

- **Market Research** - Analyze trending projects and successful campaigns
- **Competitive Analysis** - Track competitors and industry trends
- **Investment Research** - Discover promising projects in specific categories
- **Data Analysis** - Build datasets for machine learning or statistical analysis
- **Campaign Planning** - Research successful patterns before launching your own project
- **Monitoring** - Track project performance and funding progress over time

---

## Input Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `startUrl` | String | `https://www.kickstarter.com/discover` | Kickstarter discover page URL to start scraping from |
| `category` | String | - | Filter by category (Art, Comics, Design, Fashion, Film, Food, Games, Music, Photography, Publishing, Tech, Theater) |
| `sort` | String | `magic` | Sort order: `magic`, `popularity`, `newest`, `end_date`, `most_funded` |
| `collectDetails` | Boolean | `false` | Enable to scrape full project detail pages (slower but more complete) |
| `results_wanted` | Integer | `20` | Maximum number of projects to collect |
| `max_pages` | Integer | `5` | Safety cap on number of "Load More" clicks |
| `proxyConfiguration` | Object | Residential | Apify Proxy configuration (residential recommended) |

---

## Output Data

Each project in the dataset contains:

| Field | Type | Description |
|-------|------|-------------|
| `title` | String | Project title |
| `creator` | String | Project creator name |
| `url` | String | Full URL to the project page |
| `image_url` | String | Project main image URL |
| `funding_goal` | String | Target funding amount |
| `pledged` | String | Amount pledged so far |
| `backers` | String | Number of backers |
| `days_left` | String | Days remaining in campaign |
| `percentage_funded` | String | Percentage of goal achieved |
| `category` | String | Project category |
| `location` | String | Creator location (if available) |

---

## Usage Examples

### Basic Usage - Get 20 Projects

```json
{
  "startUrl": "https://www.kickstarter.com/discover",
  "results_wanted": 20
}
```

### Filter by Game Category

```json
{
  "category": "Games",
  "sort": "popularity",
  "results_wanted": 50,
  "max_pages": 10
}
```

### Custom Search URL

```json
{
  "startUrl": "https://www.kickstarter.com/discover/advanced?category_id=12&sort=magic",
  "results_wanted": 100,
  "max_pages": 20
}
```

### Scrape Newest Tech Projects

```json
{
  "category": "Tech",
  "sort": "newest",
  "results_wanted": 30
}
```

---

## Sample Output

```json
{
  "title": "Revolutionary Smart Home Device",
  "creator": "TechInnovators",
  "url": "https://www.kickstarter.com/projects/techinnovators/revolutionary-smart-home-device",
  "image_url": "https://ksr-ugc.imgix.net/assets/...",
  "funding_goal": "50000",
  "pledged": "87500",
  "backers": "1245",
  "days_left": "15",
  "percentage_funded": "175",
  "category": "Technology",
  "location": "San Francisco, CA"
}
```

---

## Tips for Best Results

- **Use Residential Proxies** - Kickstarter has Cloudflare protection; residential proxies work best
- **Set Realistic Limits** - Start with 20-50 results to test before scaling up
- **Respect Rate Limits** - Don't set `max_pages` too high to avoid blocks
- **Filter Strategically** - Use category and sort filters to get more relevant results
- **Monitor Performance** - Check logs for any blocking or errors during runs

---

## Integrations

This Kickstarter scraper integrates seamlessly with the Apify ecosystem:

- **Apify Storage** - Automatic dataset storage with API access
- **Apify Scheduler** - Schedule regular scraping runs for monitoring
- **Apify Webhooks** - Trigger actions when scraping completes
- **Apify API** - Programmatic access to start runs and fetch data
- **Make, Zapier, n8n** - Connect to thousands of apps via integrations

---

## FAQ

**Q: How many projects can I scrape?**  
A: There's no hard limit, but for better performance start with 20-100 results. Kickstarter's discover page typically shows hundreds of active projects.

**Q: Why use browser automation instead of API calls?**  
A: Kickstarter doesn't provide a public API for their discover page, and the site uses Cloudflare protection. Browser automation ensures reliable data extraction.

**Q: How long does it take to scrape 100 projects?**  
A: Typically 2-5 minutes depending on pagination and proxy performance.

**Q: Can I scrape project details?**  
A: Yes, set `collectDetails: true`, but note this significantly increases runtime as each project's detail page must be visited.

**Q: What if I get blocked?**  
A: Ensure you're using residential proxies and don't set concurrency or pagination too aggressively. The built-in stealth features help avoid detection.

**Q: Can I filter by funding status?**  
A: Kickstarter's discover page shows mostly active campaigns. For more advanced filtering, use custom `startUrl` parameters.

---

## Legal Notice

This scraper is provided for educational and research purposes. Users are responsible for ensuring their use complies with Kickstarter's Terms of Service and applicable laws. Always respect robots.txt, rate limits, and website policies. The scraper should not be used to violate privacy, intellectual property rights, or for any malicious purposes.

---

## Support

For issues, questions, or feature requests, please contact the actor developer or consult the Apify documentation.

**Developed with ❤️ using Apify Platform**