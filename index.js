const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const https = require('https');
const fs = require('fs');
const path = require('path');
const { URLSearchParams } = require('url');


// ============================================================
// CONFIGURATION
// ============================================================

// Your TryHackMe badge ID
const BADGE_URL = 'https://tryhackme.com/badge/2437045';

// Your TryHackMe profile
const PROFILE_URL = 'https://tryhackme.com/p/PurgeTheFlag';

// Generated badge image
const OUTPUT_PATH = path.join(
  __dirname,
  'assets',
  'uploadme.png'
);


// ============================================================
// SCRAPERAPI CONFIGURATION
// ============================================================

// DO NOT put the actual API key here.
//
// GitHub secret must be named:
//
// SCRAPERAPI_KEY
//
const SCRAPERAPI_KEY =
  process.env.SCRAPERAPI_KEY || '';

const USE_SCRAPERAPI =
  SCRAPERAPI_KEY.length > 0;


// ============================================================
// SCRAPERAPI URL BUILDER
// ============================================================

function buildScraperAPIUrl(
  targetUrl,
  options = {}
) {
  if (!USE_SCRAPERAPI) {
    return targetUrl;
  }

  const params = new URLSearchParams({
    api_key: SCRAPERAPI_KEY,

    url: targetUrl,

    render:
      options.render !== undefined
        ? String(options.render)
        : 'true',

    country_code:
      options.country_code || 'us',

    premium:
      options.premium !== undefined
        ? String(options.premium)
        : 'true',

    retry_404: 'false',

    session_number: String(
      options.session ||
        Math.floor(
          Math.random() * 10000
        )
    ),

    keep_headers: 'true',

    wait_for_selector:
      options.waitFor || '',
  });

  // Remove empty query parameters
  for (const [key, value] of params.entries()) {
    if (value === '') {
      params.delete(key);
    }
  }

  return (
    'https://api.scraperapi.com/?' +
    params.toString()
  );
}


// ============================================================
// FETCH USING SCRAPERAPI
// ============================================================

async function fetchWithScraperAPI(
  url,
  options = {}
) {
  if (!USE_SCRAPERAPI) {
    throw new Error(
      'SCRAPERAPI_KEY not set'
    );
  }

  const scraperUrl =
    buildScraperAPIUrl(
      url,
      options
    );

  console.log(
    `Fetching via ScraperAPI: ${url}`
  );

  // Do NOT print the whole ScraperAPI URL,
  // because that would expose the API key.
  console.log(
    'ScraperAPI request prepared'
  );

  return new Promise(
    (resolve, reject) => {
      const timeout =
        setTimeout(
          () => {
            reject(
              new Error(
                'ScraperAPI timeout'
              )
            );
          },
          90000
        );

      https
        .get(
          scraperUrl,
          res => {
            let data = '';

            res.on(
              'data',
              chunk => {
                data += chunk;
              }
            );

            res.on(
              'end',
              () => {
                clearTimeout(timeout);

                console.log(
                  `ScraperAPI response: HTTP ${res.statusCode}, length: ${data.length}`
                );

                if (
                  res.statusCode >= 200 &&
                  res.statusCode < 300
                ) {
                  resolve(data);
                } else {
                  console.log(
                    'ScraperAPI error preview:',
                    data.substring(
                      0,
                      500
                    )
                  );

                  reject(
                    new Error(
                      `ScraperAPI HTTP ${res.statusCode}`
                    )
                  );
                }
              }
            );
          }
        )
        .on(
          'error',
          error => {
            clearTimeout(timeout);
            reject(error);
          }
        );
    }
  );
}


// ============================================================
// DECODE TRYHACKME BADGE RESPONSE
// ============================================================

function decodeBadgeHTML(html) {
  if (!html) {
    return '';
  }

  /*
   * TryHackMe may return something like:
   *
   * document.write(window.atob("BASE64..."))
   *
   * The actual badge HTML is inside the
   * Base64 string.
   */

  const match = html.match(
    /document\.write\s*\(\s*window\.atob\s*\(\s*["']([^"']+)["']\s*\)\s*\)/i
  );

  if (!match) {
    console.log(
      'No Base64 wrapper found; using raw HTML'
    );

    return html;
  }

  try {
    const decoded =
      Buffer.from(
        match[1],
        'base64'
      ).toString('utf8');

    console.log(
      `Decoded badge HTML length: ${decoded.length}`
    );

    return decoded;
  } catch (error) {
    console.log(
      'Failed to decode badge HTML:',
      error.message
    );

    return html;
  }
}


// ============================================================
// FETCH BADGE HTML
// ============================================================

async function fetchBadgeHTML() {
  console.log(
    'Fetching badge...'
  );

  /*
   * First try ScraperAPI.
   *
   * IMPORTANT:
   * Decode the response BEFORE checking
   * for "thm_badge".
   *
   * This fixes the problem from your
   * GitHub Actions log.
   */

  if (USE_SCRAPERAPI) {
    try {
      const html =
        await fetchWithScraperAPI(
          BADGE_URL,
          {
            render: 'true',
            premium: 'true',
          }
        );

      const decoded =
        decodeBadgeHTML(html);

      const isVercelChallenge =
        decoded.includes(
          'Vercel Security Checkpoint'
        );

      const hasBadge =
        decoded.includes(
          'thm_badge'
        );

      if (
        !isVercelChallenge &&
        hasBadge
      ) {
        console.log(
          'Badge fetched successfully via ScraperAPI'
        );

        return decoded;
      }

      console.log(
        'ScraperAPI response did not contain a usable badge'
      );
    } catch (error) {
      console.log(
        'ScraperAPI badge fetch failed:',
        error.message
      );
    }
  } else {
    console.log(
      'SCRAPERAPI_KEY not found'
    );
  }

  console.log(
    'Falling back to Puppeteer for badge...'
  );

  return fetchBadgeHTMLPuppeteer();
}


// ============================================================
// BROWSER
// ============================================================

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

    executablePath:
      '/usr/bin/chromium',

    headless: 'new',

    ignoreDefaultArgs: [
      '--enable-automation',
    ],
  });
}


// ============================================================
// CONFIGURE PUPPETEER PAGE
// ============================================================

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
      'text/html,application/xhtml+xml,' +
      'application/xml;q=0.9,' +
      'image/avif,image/webp,image/apng,' +
      '*/*;q=0.8',

    'Accept-Language':
      'en-US,en;q=0.9',

    'Cache-Control':
      'no-cache',

    Pragma:
      'no-cache',

    'Upgrade-Insecure-Requests':
      '1',
  });
}


// ============================================================
// FETCH BADGE USING PUPPETEER
// ============================================================

async function fetchBadgeHTMLPuppeteer() {
  console.log(
    'Launching stealth browser to fetch badge...'
  );

  const browser =
    await launchBrowser();

  const page =
    await browser.newPage();

  try {
    await configurePage(page);

    for (
      let attempt = 1;
      attempt <= 2;
      attempt++
    ) {
      try {
        console.log(
          `Badge navigation attempt ${attempt}`
        );

        await page.goto(
          BADGE_URL,
          {
            waitUntil:
              'domcontentloaded',

            timeout:
              120000,
          }
        );

        break;
      } catch (error) {
        console.log(
          `Navigation attempt ${attempt} failed:`,
          error.message
        );

        if (attempt === 2) {
          throw error;
        }

        await sleep(
          10000 * attempt
        );
      }
    }

    console.log(
      'Waiting for badge content...'
    );

    try {
      await page.waitForFunction(
        () => {
          const html =
            document.documentElement
              .innerHTML;

          return (
            html.includes(
              'thm_badge'
            ) &&
            !html.includes(
              'Vercel Security Checkpoint'
            )
          );
        },
        {
          timeout: 60000,
        }
      );
    } catch {
      console.log(
        'Badge wait timed out'
      );
    }

    await sleep(3000);

    const html =
      await page.content();

    console.log(
      'Browser badge HTML length:',
      html.length
    );

    if (
      html.includes(
        'Vercel Security Checkpoint'
      )
    ) {
      throw new Error(
        'TryHackMe returned Vercel Security Checkpoint'
      );
    }

    return decodeBadgeHTML(
      html
    );
  } finally {
    await browser.close();
  }
}


// ============================================================
// STREAK EXTRACTION
// ============================================================

function extractStreakFromHTML(html) {
  if (!html) {
    return null;
  }

  /*
   * First try normal visible text.
   */
  const visiblePatterns = [
    /Streak\s*[:\-]?\s*(\d+)/i,
    /Current\s+Streak\s*[:\-]?\s*(\d+)/i,
  ];

  for (
    const pattern
    of visiblePatterns
  ) {
    const match =
      html.match(pattern);

    if (match) {
      return match[1];
    }
  }

  /*
   * Try common JSON / application-state
   * formats used by React pages.
   */
  const jsonPatterns = [
    /"streak"\s*:\s*(\d+)/i,
    /"currentStreak"\s*:\s*(\d+)/i,
    /"current_streak"\s*:\s*(\d+)/i,
    /&quot;streak&quot;\s*:\s*(\d+)/i,
    /&quot;currentStreak&quot;\s*:\s*(\d+)/i,
  ];

  for (
    const pattern
    of jsonPatterns
  ) {
    const match =
      html.match(pattern);

    if (match) {
      return match[1];
    }
  }

  return null;
}


// ============================================================
// FETCH STREAK
// ============================================================

async function fetchStreak() {
  console.log(
    'Fetching streak...'
  );

  if (USE_SCRAPERAPI) {
    try {
      const html =
        await fetchWithScraperAPI(
          PROFILE_URL,
          {
            render: 'true',
            premium: 'true',
          }
        );

      if (
        !html.includes(
          'Vercel Security Checkpoint'
        )
      ) {
        const streak =
          extractStreakFromHTML(
            html
          );

        if (streak !== null) {
          console.log(
            'Extracted streak via ScraperAPI:',
            streak
          );

          return streak;
        }

        /*
         * IMPORTANT FIX:
         *
         * Original code returned "0"
         * immediately here.
         *
         * Now, if ScraperAPI did not find
         * the streak, we try Puppeteer.
         */
        console.log(
          'Could not extract streak from ScraperAPI response; trying browser fallback'
        );
      } else {
        console.log(
          'ScraperAPI profile returned Vercel challenge'
        );
      }
    } catch (error) {
      console.log(
        'ScraperAPI streak fetch failed:',
        error.message
      );
    }
  }

  return fetchStreakPuppeteer();
}


// ============================================================
// FETCH STREAK USING PUPPETEER
// ============================================================

async function fetchStreakPuppeteer() {
  console.log(
    'Launching browser to fetch streak...'
  );

  const browser =
    await launchBrowser();

  const page =
    await browser.newPage();

  try {
    await configurePage(page);

    await page.goto(
      PROFILE_URL,
      {
        waitUntil:
          'domcontentloaded',

        timeout:
          120000,
      }
    );

    /*
     * Give React / client-side content
     * some time to render.
     */
    try {
      await page.waitForFunction(
        () => {
          const text =
            document.body
              .innerText;

          return (
            text.includes(
              'Streak'
            ) ||
            text.includes(
              'PurgeTheFlag'
            )
          );
        },
        {
          timeout:
            60000,
        }
      );
    } catch {
      console.log(
        'Profile content wait timed out'
      );
    }

    await sleep(3000);

    const html =
      await page.content();

    if (
      html.includes(
        'Vercel Security Checkpoint'
      )
    ) {
      console.log(
        'Profile blocked by Vercel'
      );

      return '0';
    }

    /*
     * Try HTML extraction.
     */
    let streak =
      extractStreakFromHTML(
        html
      );

    /*
     * If that fails, check visible
     * browser text too.
     */
    if (streak === null) {
      const text =
        await page.evaluate(
          () =>
            document.body
              .innerText
        );

      streak =
        extractStreakFromHTML(
          text
        );
    }

    console.log(
      'Extracted streak via browser:',
      streak
    );

    return streak || '0';
  } catch (error) {
    console.log(
      'Error fetching streak:',
      error.message
    );

    return '0';
  } finally {
    try {
      await browser.close();
    } catch {
      // Ignore close error
    }
  }
}


// ============================================================
// EXTRACT BADGE STATISTICS
// ============================================================

function extractStats(
  html,
  streak
) {
  if (!html) {
    throw new Error(
      'Badge HTML is empty'
    );
  }

  const nicknameMatch =
    html.match(
      /<span[^>]*class=["'][^"']*thm_nickname[^"']*["'][^>]*>([^<]+)<\/span>/i
    );

  const username =
    nicknameMatch
      ? nicknameMatch[1].trim()
      : 'PurgeTheFlag';


  const rankMatch =
    html.match(
      /<span[^>]*class=["'][^"']*thm_rank[^"']*["'][^>]*>([^<]+)<\/span>/i
    );

  const rankTitle =
    rankMatch
      ? rankMatch[1].trim()
      : '';


  // Avatar
  let avatarUrl = null;

  const avatarMatch =
    html.match(
      /class=["'][^"']*thm_avatar[^"']*["'][^>]*style=["'][^"']*background-image\s*:\s*url\(['"]?([^'")]+)['"]?\)/i
    );

  if (avatarMatch) {
    avatarUrl =
      avatarMatch[1];

    if (
      avatarUrl.startsWith(
        'user-avatars/'
      )
    ) {
      avatarUrl =
        'https://tryhackme-images.s3.amazonaws.com/' +
        avatarUrl;
    }
  }

  if (!avatarUrl) {
    const anyAvatarMatch =
      html.match(
        /user-avatars\/([^'")\s<>]+)/i
      );

    if (anyAvatarMatch) {
      avatarUrl =
        'https://tryhackme-images.s3.amazonaws.com/user-avatars/' +
        anyAvatarMatch[1];
    }
  }


  // Badge stats
  const stats =
    extractStatsFromBadgeHTML(
      html
    );

  console.log(
    'Raw badge stats:',
    stats
  );

  if (stats.length < 3) {
    console.log(
      'Badge HTML preview:',
      html.substring(
        0,
        1500
      )
    );

    throw new Error(
      `Expected at least 3 stats, found ${stats.length}`
    );
  }

  /*
   * Based on the original project:
   *
   * 1 = points
   * 2 = rooms
   * 3 = rank
   */

  const [
    points,
    rooms,
    rank,
  ] = stats;

  return {
    username,
    rankTitle,
    avatarUrl,
    points,
    streak:
      streak || '0',
    rank,
    rooms,
  };
}


// ============================================================
// EXTRACT STATS FROM BADGE HTML
// ============================================================

function extractStatsFromBadgeHTML(
  html
) {
  /*
   * Method 1:
   * original TryHackMe thm_stat spans
   */

  let matches = [
    ...html.matchAll(
      /<span[^>]*class=["'][^"']*thm_stat[^"']*["'][^>]*>([^<]+)<\/span>/gi
    ),
  ];

  if (matches.length >= 3) {
    return matches.map(
      match =>
        match[1].trim()
    );
  }


  /*
   * Method 2:
   * details-text spans
   */

  matches = [
    ...html.matchAll(
      /<span[^>]*class=["'][^"']*details-text[^"']*["'][^>]*>([^<]+)<\/span>/gi
    ),
  ];

  if (matches.length >= 3) {
    return matches.map(
      match =>
        match[1].trim()
    );
  }


  /*
   * Method 3:
   * Try specific icon-associated numbers
   */

  const trophyMatch =
    html.match(
      /trophy[\s\S]{0,300}?(\d[\d,]*)/i
    );

  const doorMatch =
    html.match(
      /door[\s\S]{0,300}?(\d[\d,]*)/i
    );

  const targetMatch =
    html.match(
      /target[\s\S]{0,300}?(\d[\d,]*)/i
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


  /*
   * Nothing worked.
   */

  return [];
}


// ============================================================
// DOWNLOAD AVATAR
// ============================================================

async function downloadImageAsBase64(
  url
) {
  if (!url) {
    throw new Error(
      'Avatar URL missing'
    );
  }

  return new Promise(
    (resolve, reject) => {
      const request =
        https.get(
          url,
          res => {
            /*
             * Handle redirects.
             */
            if (
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location
            ) {
              res.resume();

              downloadImageAsBase64(
                res.headers.location
              )
                .then(resolve)
                .catch(reject);

              return;
            }

            if (
              res.statusCode !== 200
            ) {
              reject(
                new Error(
                  `Failed to download image: HTTP ${res.statusCode}`
                )
              );

              return;
            }

            const chunks = [];

            res.on(
              'data',
              chunk => {
                chunks.push(chunk);
              }
            );

            res.on(
              'end',
              () => {
                const buffer =
                  Buffer.concat(
                    chunks
                  );

                const mime =
                  res.headers[
                    'content-type'
                  ] ||
                  'image/png';

                resolve(
                  `data:${mime};base64,${buffer.toString('base64')}`
                );
              }
            );
          }
        );

      request.on(
        'error',
        reject
      );

      request.setTimeout(
        30000,
        () => {
          request.destroy(
            new Error(
              'Avatar download timeout'
            )
          );
        }
      );
    }
  );
}


// ============================================================
// BUILD BADGE HTML
// ============================================================

async function buildHTML(stats) {
  let avatarDataUri;

  try {
    console.log(
      'Downloading avatar...'
    );

    avatarDataUri =
      await downloadImageAsBase64(
        stats.avatarUrl
      );
  } catch (error) {
    console.warn(
      'Failed to download avatar; using placeholder:',
      error.message
    );

    avatarDataUri =
      'data:image/svg+xml;base64,' +
      Buffer.from(`
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="60"
          height="60"
          viewBox="0 0 60 60"
        >
          <circle
            cx="30"
            cy="30"
            r="30"
            fill="#333333"
          />
        </svg>
      `).toString('base64');
  }


  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">

  <link
    rel="stylesheet"
    href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css"
  >

  <link
    rel="preconnect"
    href="https://fonts.googleapis.com"
  >

  <link
    rel="preconnect"
    href="https://fonts.gstatic.com"
    crossorigin
  >

  <link
    href="https://fonts.googleapis.com/css2?family=Ubuntu:wght@400;500&display=swap"
    rel="stylesheet"
  >

  <style>

    * {
      box-sizing: border-box;
    }

    html,
    body {
      width: 329px;
      height: 88px;
      margin: 0;
      padding: 0;
      background: transparent;
      overflow: hidden;
    }

    #thm-badge {
      width: 327px;
      height: 84px;

      background-image:
        url(
          'https://tryhackme.com/img/thm_public_badge_bg.svg'
        );

      background-size: cover;
      background-position: center;

      display: flex;
      align-items: center;

      gap: 12px;

      border-radius: 12px;
    }

    .thm-avatar-outer {
      width: 64px;
      height: 64px;

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

      flex-shrink: 0;
    }

    .thm-avatar {
      width: 60px;
      height: 60px;

      background-image:
        url('${avatarDataUri}');

      background-size: cover;
      background-position: center;

      border-radius: 50%;

      background-color:
        #121212;

      box-shadow:
        0 0 3px 0 #303030;
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
      font-family:
        'Ubuntu',
        sans-serif;

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
      font-family:
        'Ubuntu',
        sans-serif;

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
      font-family:
        'Ubuntu',
        sans-serif;

      font-weight: 400;
      font-size: 11px;

      color: #ffffff;
    }

    .thm-link {
      font-family:
        'Ubuntu',
        sans-serif;

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

        <span class="user_name">
          ${escapeHTML(stats.username)}
        </span>

        <div>

          <i
            class="fa-solid fa-bolt-lightning rank-icon"
          ></i>

          <span class="rank-title">
            ${escapeHTML(stats.rankTitle)}
          </span>

        </div>

      </div>


      <div class="details-wrapper">

        <div class="details-icon-wrapper">

          <i
            class="fa-solid fa-trophy detail-icons trophy-icon"
          ></i>

          <span class="details-text">
            ${escapeHTML(stats.points)}
          </span>

        </div>


        <div class="details-icon-wrapper">

          <i
            class="fa-solid fa-fire detail-icons fire-icon"
          ></i>

          <span class="details-text">
            ${escapeHTML(stats.streak)}
          </span>

        </div>


        <div class="details-icon-wrapper">

          <i
            class="fa-solid fa-award detail-icons award-icon"
          ></i>

          <span class="details-text">
            ${escapeHTML(stats.rank)}
          </span>

        </div>


        <div class="details-icon-wrapper">

          <i
            class="fa-solid fa-door-closed detail-icons door-closed-icon"
          ></i>

          <span class="details-text">
            ${escapeHTML(stats.rooms)}
          </span>

        </div>

      </div>


      <a
        href="${PROFILE_URL}"
        class="thm-link"
        target="_blank"
      >
        tryhackme.com
      </a>

    </div>

  </div>

</body>
</html>
`;
}


// ============================================================
// HTML ESCAPING
// ============================================================

function escapeHTML(value) {
  return String(
    value ?? ''
  )
    .replace(
      /&/g,
      '&amp;'
    )
    .replace(
      /</g,
      '&lt;'
    )
    .replace(
      />/g,
      '&gt;'
    )
    .replace(
      /"/g,
      '&quot;'
    )
    .replace(
      /'/g,
      '&#039;'
    );
}


// ============================================================
// SCREENSHOT BADGE
// ============================================================

async function takeScreenshot(
  html
) {
  /*
   * Make sure assets directory exists.
   */
  fs.mkdirSync(
    path.dirname(
      OUTPUT_PATH
    ),
    {
      recursive: true,
    }
  );

  const browser =
    await launchBrowser();

  const page =
    await browser.newPage();

  try {
    await page.setViewport({
      width: 329,
      height: 88,

      deviceScaleFactor: 1,
    });

    await page.setContent(
      html,
      {
        waitUntil:
          'networkidle0',

        timeout:
          120000,
      }
    );

    await page.waitForSelector(
      '#thm-badge',
      {
        timeout:
          30000,
      }
    );

    /*
     * Wait for fonts if possible.
     */
    await page.evaluate(
      async () => {
        if (
          document.fonts &&
          document.fonts.ready
        ) {
          await document.fonts.ready;
        }
      }
    );

    await sleep(1000);

    await page.screenshot({
      path:
        OUTPUT_PATH,

      omitBackground:
        true,

      type:
        'png',
    });
  } finally {
    await browser.close();
  }
}


// ============================================================
// HELPER
// ============================================================

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}


// ============================================================
// MAIN
// ============================================================

async function main() {
  try {
    console.log(
      'Fetching stats...'
    );

    console.log(
      `ScraperAPI enabled: ${USE_SCRAPERAPI}`
    );


    // --------------------------------------------------------
    // Fetch badge
    // --------------------------------------------------------

    const html =
      await fetchBadgeHTML();


    // --------------------------------------------------------
    // Fetch streak
    // --------------------------------------------------------

    const streak =
      await fetchStreak();

    console.log(
      'Final streak:',
      streak
    );


    // --------------------------------------------------------
    // Extract stats
    // --------------------------------------------------------

    const stats =
      extractStats(
        html,
        streak
      );

    console.log(
      'Stats extracted:',
      stats
    );


    // --------------------------------------------------------
    // Generate badge
    // --------------------------------------------------------

    const badgeHTML =
      await buildHTML(
        stats
      );


    // --------------------------------------------------------
    // Screenshot with retries
    // --------------------------------------------------------

    let screenshotSuccess =
      false;

    for (
      let attempt = 1;
      attempt <= 3;
      attempt++
    ) {
      try {
        console.log(
          `Screenshot attempt ${attempt}...`
        );

        await takeScreenshot(
          badgeHTML
        );

        console.log(
          `Badge screenshot saved to ${OUTPUT_PATH}`
        );

        screenshotSuccess =
          true;

        break;
      } catch (error) {
        console.log(
          `Screenshot attempt ${attempt} failed:`,
          error.message
        );

        if (attempt < 3) {
          await sleep(3000);
        }
      }
    }


    if (!screenshotSuccess) {
      throw new Error(
        'All screenshot attempts failed'
      );
    }


    console.log(
      'TryHackMe badge generation completed successfully.'
    );
  } catch (error) {
    console.error(
      'Failed:',
      error.message
    );

    if (error.stack) {
      console.error(
        error.stack
      );
    }

    process.exit(1);
  }
}


// ============================================================
// START
// ============================================================

main();
