const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const BADGE_URL = 'https://tryhackme.com/badge/2437045';
const PROFILE_URL = 'https://tryhackme.com/p/PurgeTheFlag';
const OUTPUT_PATH = path.join(__dirname, 'assets', 'uploadme.png');

// ScraperAPI configuration
const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY || '';
const USE_SCRAPERAPI = SCRAPERAPI_KEY.length > 0;

function buildScraperAPIUrl(targetUrl, options = {}) {
  if (!USE_SCRAPERAPI) return targetUrl;

  const params = new URLSearchParams({
    api_key: SCRAPERAPI_KEY,
    url: targetUrl,
    render: options.render !== undefined ? options.render : 'true',
    country_code: options.country_code || 'us',
    premium: options.premium !== undefined ? options.premium : 'true',
    retry_404: 'false',
    session_number:
      options.session || Math.floor(Math.random() * 10000),
    keep_headers: 'true',
    wait_for_selector: options.waitFor || '',
  });

  for (const [key, value] of params.entries()) {
    if (value === '') {
      params.delete(key);
    }
  }

  return `https://api.scraperapi.com/?${params.toString()}`;
}

async function fetchWithScraperAPI(url, options = {}) {
  if (!USE_SCRAPERAPI) {
    throw new Error('SCRAPERAPI_KEY not set');
  }

  const scraperUrl = buildScraperAPIUrl(url, options);

  console.log(`Fetching via ScraperAPI: ${url}`);
  console.log(`ScraperAPI URL: ${scraperUrl.substring(0, 100)}...`);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('ScraperAPI timeout')),
      60000
    );

    https
      .get(scraperUrl, res => {
        clearTimeout(timeout);

        let data = '';

        res.on('data', chunk => {
          data += chunk;
        });

        res.on('end', () => {
          console.log(
            `ScraperAPI response: HTTP ${res.statusCode}, length: ${data.length}`
          );

          if (res.statusCode === 200) {
            console.log(
              `ScraperAPI preview: ${data.substring(0, 500)}`
            );
            resolve(data);
          } else {
            console.log(
              `ScraperAPI error body: ${data.substring(0, 500)}`
            );
            reject(
              new Error(`ScraperAPI HTTP ${res.statusCode}`)
            );
          }
        });
      })
      .on('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

async function fetchBadgeHTML() {
  console.log('Fetching badge...');

  if (USE_SCRAPERAPI) {
    try {
      const html = await fetchWithScraperAPI(BADGE_URL, {
        render: 'true',
        premium: 'true',
      });

      if (
        !html.includes('Vercel Security Checkpoint') &&
        html.includes('thm_badge')
      ) {
        console.log(
          'Badge fetched successfully via ScraperAPI'
        );
        return decodeBadgeHTML(html);
      }

      console.log(
        'ScraperAPI returned challenge page, falling back to Puppeteer'
      );
    } catch (error) {
      console.log(
        'ScraperAPI failed:',
        error.message
      );
    }
  }

  return fetchBadgeHTMLPuppeteer();
}

async function launchBrowser() {
  return puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=VizDisplayCompositor',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    ignoreDefaultArgs: ['--enable-automation'],
  });
}

async function configurePage(page) {
  await page.setViewport({
    width: 1366,
    height: 768,
  });

  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36'
  );

  await page.setExtraHTTPHeaders({
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,' +
      'image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
  });
}

async function fetchBadgeHTMLPuppeteer() {
  console.log(
    'Launching stealth browser to fetch badge...'
  );

  const browser = await launchBrowser();
  const page = await browser.newPage();

  await configurePage(page);

  let html;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(BADGE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 120000,
      });
      break;
    } catch (error) {
      if (attempt === 2) {
        await browser.close();
        throw error;
      }

      console.log(
        `Navigation attempt ${attempt} failed, retrying...`
      );

      await new Promise(resolve =>
        setTimeout(resolve, 10000 * attempt)
      );
    }
  }

  console.log('Waiting for badge content to load...');

  try {
    await page.waitForFunction(
      () => {
        const pageHTML =
          document.documentElement.innerHTML;

        return (
          pageHTML.includes('thm_badge') &&
          !pageHTML.includes(
            'Vercel Security Checkpoint'
          )
        );
      },
      { timeout: 120000 }
    );

    console.log('Badge content detected');
  } catch {
    console.log(
      'Timeout waiting for badge content, checking anyway...'
    );
  }

  await new Promise(resolve =>
    setTimeout(resolve, 5000)
  );

  html = await page.content();

  console.log('Page HTML length:', html.length);

  if (html.includes('Vercel Security Checkpoint')) {
    console.log(
      'WARNING: Still on Vercel challenge page'
    );
  }

  await browser.close();

  return decodeBadgeHTML(html);
}

async function fetchStreak() {
  console.log('Fetching streak...');

  if (USE_SCRAPERAPI) {
    try {
      const html = await fetchWithScraperAPI(
        PROFILE_URL,
        {
          render: 'true',
          premium: 'true',
        }
      );

      if (
        !html.includes('Vercel Security Checkpoint')
      ) {
        const match = html.match(
          /Streak\s+(\d+)/i
        );

        const streak = match ? match[1] : null;

        console.log(
          'Extracted streak via ScraperAPI:',
          streak
        );

        return streak || '0';
      }

      console.log(
        'ScraperAPI returned challenge page for profile'
      );
    } catch (error) {
      console.log(
        'ScraperAPI streak fetch failed:',
        error.message
      );
    }
  }

  return fetchStreakPuppeteer();
}

async function fetchStreakPuppeteer() {
  console.log(
    'Launching stealth browser to fetch streak from profile...'
  );

  const browser = await launchBrowser();
  const page = await browser.newPage();

  await configurePage(page);

  try {
    await page.goto(PROFILE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });

    console.log(
      'Waiting for profile page to load...'
    );

    try {
      await page.waitForFunction(
        () => {
          const text = document.body.innerText;

          if (
            text.includes(
              'Vercel Security Checkpoint'
            ) ||
            text.includes('spinner')
          ) {
            return false;
          }

          return (
            text.includes('PurgeTheFlag') &&
            text.match(/Streak\s+(\d+)/i) !== null
          );
        },
        { timeout: 180000 }
      );

      console.log(
        'Profile page loaded with stats'
      );
    } catch {
      console.log(
        'Profile page did not load stats in time, trying anyway...'
      );
    }

    let html = '';

    try {
      html = await page.mainFrame().content();

      console.log(
        'Profile page HTML length:',
        html.length
      );

      if (
        html.includes(
          'Vercel Security Checkpoint'
        )
      ) {
        console.log(
          'WARNING: Still on Vercel challenge on profile page'
        );
      }
    } catch (error) {
      console.log(
        'Could not get page content:',
        error.message
      );
    }

    const streakMatch = html.match(
      /Streak\s+(\d+)/i
    );

    const streak = streakMatch
      ? streakMatch[1]
      : null;

    await browser.close();

    console.log('Extracted streak:', streak);

    return streak || '0';
  } catch (error) {
    console.log(
      'Error fetching streak:',
      error.message
    );

    try {
      await browser.close();
    } catch {
      // Browser was already closed.
    }

    return '0';
  }
}

function decodeBadgeHTML(html) {
  const match = html.match(
    /document\.write\(window\.atob\("([^"]+)"\)\)/
  );

  if (!match) {
    console.log(
      'No base64 encoding found, using raw HTML'
    );
    return html;
  }

  const encoded = match[1];

  const decoded = Buffer.from(
    encoded,
    'base64'
  ).toString('utf-8');

  console.log(
    'Decoded HTML length:',
    decoded.length
  );

  return decoded;
}

function extractStats(html, streak) {
  const nicknameMatch = html.match(
    /<span class="thm_nickname">([^<]+)<\/span>/
  );

  const username = nicknameMatch
    ? nicknameMatch[1]
    : 'PurgeTheFlag';

  const rankMatch = html.match(
    /<span class="thm_rank">([^<]+)<\/span\s*>/
  );

  const rankTitle = rankMatch
    ? rankMatch[1]
    : '[0xD]';

  let avatarUrl = null;

  const avatarMatch = html.match(
    /class="thm_avatar"[^>]*style="[^"]*background-image:\s*url\(['"]?([^'")]+)['"]?\)/
  );

  if (avatarMatch) {
    avatarUrl = avatarMatch[1];

    if (avatarUrl.startsWith('user-avatars/')) {
      avatarUrl =
        'https://tryhackme-images.s3.amazonaws.com/' +
        avatarUrl;
    }
  } else {
    const anyUrlMatch = html.match(
      /user-avatars\/([^'")]+)/
    );

    avatarUrl = anyUrlMatch
      ? 'https://tryhackme-images.s3.amazonaws.com/user-avatars/' +
        anyUrlMatch[1]
      : null;
  }

  if (!avatarUrl) {
    avatarUrl =
      'https://cdn-images.tryhackme.com/' +
      'user-avatars/' +
      '65436f8f94e24dd0e6524a8d-1789039927888';
  }

  const stats = extractStatsFromBadgeHTML(html);

  if (stats.length < 3) {
    throw new Error(
      `Expected at least 3 stats, found ${stats.length}`
    );
  }

  const [points, rooms, rank] = stats;

  return {
    username,
    rankTitle,
    avatarUrl,
    points,
    streak,
    rank,
    rooms,
  };
}

function extractStatsFromBadgeHTML(html) {
  let statsMatches = [
    ...html.matchAll(
      /<span class="thm_stat[^"]*">([^<]+)<\/span>/g
    ),
  ];

  if (statsMatches.length >= 3) {
    return statsMatches.map(match => match[1]);
  }

  statsMatches = [
    ...html.matchAll(
      /<span class="details-text">([^<]+)<\/span>/g
    ),
  ];

  if (statsMatches.length >= 3) {
    return statsMatches.map(match => match[1]);
  }

  const trophyMatch = html.match(
    /trophy[^>]*>\s*(\d+)/i
  );

  const doorMatch = html.match(
    /door[^>]*>\s*(\d+)/i
  );

  const targetMatch = html.match(
    /target[^>]*>\s*(\d+)/i
  );

  if (
    trophyMatch &&
    doorMatch &&
    targetMatch
  ) {
    return [
      trophyMatch[1],
      doorMatch[1],
      targetMatch[1],
    ];
  }

  const allStats = [
    ...html.matchAll(
      /(?:trophy|door|target)[^>]*>\s*(\d+)/gi
    ),
  ];

  if (allStats.length >= 3) {
    return allStats.map(match => match[1]);
  }

  return [];
}

async function downloadImageAsBase64(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, res => {
        if (res.statusCode !== 200) {
          reject(
            new Error(
              `Failed to download image: ${res.statusCode}`
            )
          );
          return;
        }

        const data = [];

        res.on('data', chunk => {
          data.push(chunk);
        });

        res.on('end', () => {
          const base64 = Buffer.concat(
            data
          ).toString('base64');

          const mime =
            res.headers['content-type'] ||
            'image/png';

          resolve(
            `data:${mime};base64,${base64}`
          );
        });
      })
      .on('error', reject);
  });
}

async function buildHTML(stats) {
  let avatarDataUri;

  try {
    console.log('Downloading avatar...');

    avatarDataUri =
      await downloadImageAsBase64(
        stats.avatarUrl
      );
  } catch (error) {
    console.warn(
      'Failed to download avatar, using fallback placeholder:',
      error.message
    );

    avatarDataUri =
      'data:image/svg+xml,' +
      '%3Csvg xmlns="http://www.w3.org/2000/svg" ' +
      'width="60" height="60" viewBox="0 0 60 60"%3E' +
      '%3Ccircle cx="30" cy="30" r="30" fill="%23333"/%3E' +
      '%3C/svg%3E';
  }

  return `<!DOCTYPE html>
<html>
<head>
  <link
    rel="stylesheet"
    href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css"
    crossorigin="anonymous"
  />
  <link
    rel="preconnect"
    href="https://fonts.googleapis.com"
  />
  <link
    rel="preconnect"
    href="https://fonts.gstatic.com"
    crossorigin
  />
  <link
    href="https://fonts.googleapis.com/css2?family=Ubuntu:ital,wght@0,400;0,500;1,400;1,500&display=swap"
    rel="stylesheet"
  />
  <style>
    body {
      width: 329px;
      height: 88px;
      margin: 0;
      background: transparent;
    }

    #thm-badge {
      width: 327px;
      height: 84px;
      background-image:
        url('https://tryhackme.com/img/thm_public_badge_bg.svg');
      background-size: cover;
      display: flex;
      align-items: center;
      gap: 12px;
      border-radius: 12px;
    }

    .thm-avatar-outer {
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background:
        linear-gradient(
          to bottom left,
          #a3ea2a,
          #2e4463
        );
      padding: 2px;
      margin-left: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .thm-avatar {
      width: 60px;
      height: 60px;
      background-image: url('${avatarDataUri}');
      background-size: cover;
      background-position: center;
      border-radius: 50%;
      background-color: #121212;
      box-shadow: 0 0 3px 0 #303030;
    }

    .badge-user-details {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .title-wrapper {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .user_name {
      font-family: 'Ubuntu', sans-serif;
      font-weight: 500;
      font-size: 14px;
      color: #f9f9fb;
      max-width: 135px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .rank-icon {
      color: #ffbb45;
      font-size: 10px;
    }

    .rank-title {
      font-family: Ubuntu, sans-serif;
      font-weight: 500;
      font-size: 12px;
      color: #ffffff;
    }

    .details-wrapper {
      display: flex;
      gap: 8px;
    }

    .details-icon-wrapper {
      display: flex;
      gap: 5px;
      align-items: center;
    }

    .detail-icons {
      font-weight: 900;
      font-size: 11px;
    }

    .trophy-icon {
      color: #9ca4b4;
    }

    .fire-icon {
      color: #a3ea2a;
      font-size: 13px;
    }

    .award-icon {
      color: #d752ff;
      font-size: 13px;
    }

    .door-closed-icon {
      color: #719cf9;
      font-size: 12px;
    }

    .details-text {
      font-family: Ubuntu, sans-serif;
      font-weight: 400;
      font-size: 11px;
      color: #ffffff;
    }

    .thm-link {
      font-family: Ubuntu, sans-serif;
      font-weight: 400;
      font-size: 11px;
      color: #f9f9fb;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div id="thm-badge">
    <div class="thm-avatar-outer">
      <div class="thm-avatar"></div>
    </div>

    <div class="badge-user-details">
      <div class="title-wrapper">
        <span class="user_name">${stats.username}</span>

        <div>
          <i class="fa-solid fa-bolt-lightning rank-icon"></i>
          <span class="rank-title">${stats.rankTitle}</span>
        </div>
      </div>

      <div class="details-wrapper">
        <div class="details-icon-wrapper">
          <i class="fa-solid fa-trophy detail-icons trophy-icon"></i>
          <span class="details-text">${stats.points}</span>
        </div>

        <div class="details-icon-wrapper">
          <i class="fa-solid fa-fire detail-icons fire-icon"></i>
          <span class="details-text">${stats.streak}</span>
        </div>

        <div class="details-icon-wrapper">
          <i class="fa-solid fa-award detail-icons award-icon"></i>
          <span class="details-text">${stats.rank}</span>
        </div>

        <div class="details-icon-wrapper">
          <i class="fa-solid fa-door-closed detail-icons door-closed-icon"></i>
          <span class="details-text">${stats.rooms}</span>
        </div>
      </div>

      <a
        href="https://tryhackme.com"
        class="thm-link"
        target="_blank"
      >
        tryhackme.com
      </a>
    </div>
  </div>
</body>
</html>`;
}

async function takeScreenshot(html) {
  const browser = await puppeteer.launch({
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=VizDisplayCompositor',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = await browser.newPage();

  await page.setViewport({
    width: 329,
    height: 88,
  });

  await page.setContent(html, {
    waitUntil: 'networkidle0',
  });

  await page.waitForSelector('.thm-avatar');

  await new Promise(resolve =>
    setTimeout(resolve, 500)
  );

  await page.screenshot({
    path: OUTPUT_PATH,
    omitBackground: true,
  });

  await browser.close();
}

async function main() {
  try {
    console.log('Fetching stats...');

    const html = await fetchBadgeHTML();

    const streak = await fetchStreak();

    console.log(
      'Extracted streak:',
      streak
    );

    const stats = extractStats(
      html,
      streak
    );

    console.log(
      'Stats extracted:',
      stats
    );

    const badgeHTML =
      await buildHTML(stats);

    let screenshotSuccess = false;

    for (
      let attempt = 1;
      attempt <= 3;
      attempt++
    ) {
      try {
        console.log(
          `Screenshot attempt ${attempt}...`
        );

        await takeScreenshot(badgeHTML);

        console.log(
          '✅ Exact badge screenshot saved!'
        );

        screenshotSuccess = true;
        break;
      } catch (error) {
        console.log(
          `Screenshot attempt ${attempt} failed:`,
          error.message
        );

        if (attempt < 3) {
          await new Promise(resolve =>
            setTimeout(resolve, 3000)
          );
        }
      }
    }

    if (!screenshotSuccess) {
      throw new Error(
        'All screenshot attempts failed'
      );
    }
  } catch (error) {
    console.error(
      '❌ Failed:',
      error.message
    );

    process.exit(1);
  }
}

main();