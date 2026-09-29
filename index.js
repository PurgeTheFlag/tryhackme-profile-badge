const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BADGE_URL = 'https://tryhackme.com/badge/2437045';
const OUTPUT_PATH = path.join(__dirname, 'assets', 'uploadme.png');
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '';

const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
function debugLog(...args) { if (DEBUG) console.log('[DEBUG]', ...args); }
function debugFile(name, content) {
  if (!DEBUG) return;
  const dir = path.join(__dirname, 'debug');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  console.log(`[DEBUG] Saved ${fp} (${content.length || 0} bytes)`);
}

// ─── Fetch via ScraperAPI (or direct if no key) ───────────────────────
function fetchViaScraperAPI(url) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const https = require('https');

    if (!SCRAPER_API_KEY) {
      // Direct fetch with browser-like headers
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
        },
      }, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      }).on('error', reject);
      return;
    }

    console.log(`Fetching via ScraperAPI (render=true)...`);
    const scraperUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}&render=true`;
    http.get(scraperUrl, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    }).on('error', reject);
  });
}

// ─── Launch options for Puppeteer ─────────────────────────────────────
function getLaunchOptions() {
  const { execSync } = require('child_process');
  let chromiumPath;
  try { chromiumPath = execSync('which chromium-browser', { encoding: 'utf8' }).trim(); } catch {}
  if (!chromiumPath) {
    try { chromiumPath = execSync('which chromium', { encoding: 'utf8' }).trim(); } catch {}
  }
  if (!chromiumPath) {
    try { chromiumPath = execSync('which google-chrome', { encoding: 'utf8' }).trim(); } catch {}
  }
  if (!chromiumPath) {
    try { chromiumPath = execSync('which google-chrome-stable', { encoding: 'utf8' }).trim(); } catch {}
  }

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=VizDisplayCompositor',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process'
  ];
  const launchOpts = { args: launchArgs, headless: 'new', ignoreDefaultArgs: ['--enable-automation'] };

  if (chromiumPath) {
    launchOpts.executablePath = chromiumPath;
    console.log(`Using system Chromium: ${chromiumPath}`);
  } else {
    console.log('No system Chromium found — using Puppeteer bundled Chromium');
  }

  return launchOpts;
}

// ─── Badge HTML fetch via Puppeteer ───────────────────────────────────
async function fetchBadgeHTML() {
  const rawHtml = await fetchViaScraperAPI(BADGE_URL);
  debugFile('badge-raw.html', rawHtml);

  // Check for Vercel challenge (should not happen with ScraperAPI render=true)
  if (rawHtml.includes('Vercel Security Checkpoint') || rawHtml.includes('Just a moment')) {
    throw new Error('Got Vercel challenge page — ScraperAPI may have failed');
  }

  // TryHackMe badge page returns base64-encoded HTML: document.write(window.atob("..."))
  const atobMatch = rawHtml.match(/document\.write\(window\.atob\("([^"]+)"\)\)/);
  if (atobMatch) {
    const decoded = Buffer.from(atobMatch[1], 'base64').toString('utf-8');
    debugLog('Decoded badge HTML:', decoded.length, 'bytes');
    debugFile('badge-decoded.html', decoded);
    return decoded;
  }

  // Maybe the HTML is not encoded but still contains the badge
  if (rawHtml.includes('thm_badge') || rawHtml.includes('thm_nickname')) {
    debugLog('Badge HTML not encoded, using raw');
    return rawHtml;
  }

  console.warn('Could not decode badge HTML via atob');
  console.warn('First 500 chars:', rawHtml.substring(0, 500));
  debugFile('badge-decode-failure.html', rawHtml);
  throw new Error('Badge page did not contain expected content');
}

// ─── Stats extraction from badge HTML ───────────────────────────────
function extractStatsFromBadgeHTML(html) {
  // Pattern 1: <span class="thm_stat...">value</span>
  let statsMatches = [...html.matchAll(/<span class="thm_stat[^"]*">([^<]+)<\/span>/g)];
  if (statsMatches.length >= 3) {
    debugLog('Stats via thm_stat:', statsMatches.map(m => m[1]));
    return statsMatches.map(m => m[1]);
  }

  // Pattern 2: <span class="details-text">value</span>
  statsMatches = [...html.matchAll(/<span class="details-text">([^<]+)<\/span>/g)];
  if (statsMatches.length >= 3) {
    debugLog('Stats via details-text:', statsMatches.map(m => m[1]));
    return statsMatches.map(m => m[1]);
  }

  // Pattern 3: Any three consecutive numbers in spans
  const allNums = [...html.matchAll(/<span[^>]*>\s*(\d[\d,]*)\s*<\/span>/g)].map(m => m[1].replace(/,/g, ''));
  if (allNums.length >= 3) {
    debugLog('Stats via all spans:', allNums.slice(0, 5));
    return allNums.slice(0, 3);
  }

  debugLog('No stats found in HTML. First 1000 chars:', html.substring(0, 1000));
  return [];
}

// ─── Avatar download ────────────────────────────────────────────────
async function downloadImageAsDataUri(url) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
        const base64 = Buffer.concat(data).toString('base64');
        const mime = res.headers['content-type'] || 'image/png';
        resolve(`data:${mime};base64,${base64}`);
      });
    }).on('error', reject);
  });
}

// ─── Badge HTML builder ─────────────────────────────────────────────
async function buildHTML(stats) {
  // 1. Download avatar from S3 (not behind Vercel)
  let avatarDataUri;
  try {
    avatarDataUri = await downloadImageAsDataUri(stats.avatarUrl);
  } catch (err) {
    console.warn('Avatar download failed, using fallback:', err.message);
    avatarDataUri = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60"%3E%3Ccircle cx="30" cy="30" r="30" fill="%23333"/%3E%3C/svg%3E';
  }

  // 2. Load background SVG from local asset (committed to repo)
  const bgSvgPath = path.join(__dirname, 'assets', 'thm_public_badge_bg.svg');
  let bgDataUri;
  try {
    if (fs.existsSync(bgSvgPath)) {
      const svgContent = fs.readFileSync(bgSvgPath, 'utf8');
      bgDataUri = `data:image/svg+xml;base64,${Buffer.from(svgContent).toString('base64')}`;
    } else {
      throw new Error('SVG file not found');
    }
  } catch (err) {
    console.warn('Background SVG load failed, using fallback:', err.message);
    bgDataUri = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="329" height="88"%3E%3Crect width="329" height="88" fill="%23121212" rx="12"/%3E%3C/svg%3E';
  }

  // Load exact THM icon PNGs as data URIs (no external CDN needed)
  const iconTrophyUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAC10lEQVR42oxTXUhTYRh+v/N952xzus2cujl/1haSmEZlhQVeJBoUaXhRgdBNIHTTXVfRRdBNdV/QRdFFCV2EREFpgkqaRaupaek8buZs6OZfcz9nbuf0fgvyB4oO54XvO8/zvDzf856P9N2gegBoxjqEZYD/exJYHqxuxsUllQ2XSvedatSAGePxOBQ4HKCkUhBdDcPaog8suRkw5RJY8E+B2WwGSoXY/IyvN/TdDyyjwhHn/pbGJ4/uBWf9U1He/trNu3XJaBR+Li9BJBwBliaQQyR42Dn8keMVZda8C231jcGAf0xYiWkOJhmMobmpsMTIYYlB8m++OcY5oVAkzJho5FphNaZRJRFT3O5K0aCD23qJxDmZEJIt4C/53YBjnOOqsIqKklK4liUU6B/uf36gqfVizbfRd+bQ3PQSF1JKQRCwUMyogGuAUrvFWOIoPLO30ln+/sOEj2tpcy2ZDAZndaH5WVu5q9putVe6C4uKqaqqoCgJWI8uQEEeBYOOQlpjdr1E6dvhr7JPDj1GUw/4FOKqqt2ZDcg9Ab98FvfHki3ttbUH64sZFbMOJFGAkbGZhe7eT6OID6HBLiaAl4NsS0ZeVQOvpoG791XXfVXTyO49VUX8/F8m/IuDQ+PjOLHLuJcp2RQJO5PGBnIiEet487LTR4jAM4S+/s+BRDLVwbGd/KwDgoNjmL0+BRgefnAQOZ3J/m3ZBzPM4PhkaVGDTAYgLaEmB4FcdJCZ0kD4gaRV3GAjEZvoRGgtKXNbkhgi2gabzWoSKZznGOdkuajJanc4qsIcBtKT2vWW9it1ktEAll1WOHn6RDULaFc5xjlbBeTW0W0NBprazh33jowIG3gXTCYTEMZgHdeiTgc1Lpfa8+zpIPIa/mSwFtvWIGdaloUKpxPsNhtY8vPxzBlYWV6GcCQCM36/gPycbSGuJzY3G2nwvH7h+ec9lkTwiFuG/0uAAQACpyKt1/ib3gAAAABJRU5ErkJggg==';
  const iconDoorUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABYElEQVR42oRTPU6GQBAd/gKEhgQbY2JhY0LLCQyFna2lhYWJJ/AS5kssTEw8gAewsCGegHNIrBTIB8Iu687C4vIJH5uQt7sz8+bNAzTGGOB6PNOeOESwvtLbd3YjD6bcdAyi88vryDAMcBwHbNsGXdeBEAJN00Bd14DN3l6eJ2x/BB2IxCRJwHVdqKrqH8ZxLPLUpcsN7ZCkj/q+P4sYpzsEpkpAKQXP80QBylUxz3MRp4sKaE+Ac2On3QfvBQFdICDDCJgo3wwimpdlmTAT42RNgaZpk84fXyUcXT3AZ75dUcAD2AUJMLHj3RENjq93F2Dye4wTumAiGRRIt9mg4PDAh9OT49FEsk8BFsgRJJFEeb+XQCpQTVRxVcFkBF6k4hLB6MH2py/EWbGoLEshW2JRFBAEgcibJfgu+cE0IQxD8TNZljXKb9tWfA+oAPNmCcoK0vtNsvovczGpev4VYAAZAytXIbWINQAAAABJRU5ErkJggg==';
  const iconTargetUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAMAAADXqc3KAAACLlBMVEWVAACbAACcAACjAACoAADhAQHiAQHkAQHlAQH////lAQHjAQGhAACVAADlAQHeAQGwAACVAADlAQGVAACYAADlAQHbAQG8AQGVAADlAQHhAQGmAACVAADlAQHXAQHBAQHkAgLlAgKVAADlAQHnCQnTAQHFAQGdAADnDg6VAADhDQ3lAQHOAQHKAQGVAAC0BwebBASbBgaVAADvQ0PtQkLwRkbpOzvRKSnDJib1Zmb2aGi2ICC4IyP5fX3zamrQNzfNNjboUlLVPj77iYn9lpb9mZn4e3vsWVnyaWnkTEzlTU35eXn6gID/pqbsVFTe2Nje2dne2trf1NTgx8fg3Nzh19fjtrbjurrkqKjk29vlqKjl19fl2NjmoqLmqanmubnnoaHopKTp3NzqsLDq0tLrjY3sdHTswMDt5OTt6OjvV1fwWVnwYmLwZGTwZmbwdXXwenrxWlrxXFzxXV3xsLDxuLjyXl7yeHjzX1/zYGDzbGzz6enz7e30YmL0dHT1ZGT1Zmb1Z2f1tLT1vLz2Zmb2Z2f34OD4aGj4aWn4zMz4zc346+v5amr5fHz6bGz6b2/6d3f6hIT7bm77eHj7wsL7w8P77u778vL8cHD8cnL8hob8jIz9enr9fX39f3/9ior9paX9u7v+gYH+l5f+vb3+wMD+xcX+09P/d3f/fX3/gID/h4f/kpL/lZX/mpr/nZ3/x8f/yMj/1dX/2dn/6Oj/9fX/9vb/+vr/+/v//PyPL9vPAAAAT3RSTlMAAAAAAAAAAAAACwwNDhESExQZHR1HSE1UWVpkant+g4yMkpabnJ+ipaenp66ws7O2wcfJysrL0tjc3N7f5ufo6erw9PT09fb2+Pj9/f3+mAThwgAAAaRJREFUGBkFwTFy00AYgNFvpV/WSrYlx4lJSnoqOE9qirQZTgENDdwoVWZyAiYVQ8BRlJUsZVe70vKeFAAAAAAAgBABWOV6pbGTdRMASgBI6npdao2142DMAiAAZX1R38xLRCXpj602IyBE1vt3X/yySlPm2X/OvqYMKCFm1eG2r4o5GLaZfutuvwXnEWJ9cWMO2dEFOEl+kR5vvk9HhHJXuzJ7sgB4H670WI/DJOSb67D/26G3FV1vJ3U5XP/MJ0Hrk3p0SxraFxRxbsfZat0LuQ5vkuCnJKKWJV2mUOgcIV+5cZVx0gIEu8FPySpHUHFu1juabQ10fUE3FFEhuDn6fk1sCkVsMk8/x9khOBdid57ufv/SWHVY5q4MziHYUW3Nn6vk/LWj3CXhyW/VaBGcvftYtnKWXwLMbVvpO+sQTs+Fr93RVwKE7jWvvXk+ZUI0m/tPhxfTSY4LsdzLfWsiQhya4uHD2abzHbKqsvhgmkEhLDxHF6r3ewB47Jp/DREBaKb+YPI8wzs3Hk0PIAD0/ZCXGyGcRtcCgFAAYK0BAAoA+A9ptOQPOkyFSAAAAABJRU5ErkJggg==';

  // Inline CSS to avoid external requests
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { width: 329px; height: 88px; margin: 0; background: transparent; font-family: Ubuntu, sans-serif; }
    #thm-badge { width: 327px; height: 84px; background-image: url('${bgDataUri}'); background-size: cover; display: flex; align-items: center; gap: 12px; border-radius: 12px; }
    .thm-avatar-outer { width: 60px; height: 60px; border-radius: 50%; background: linear-gradient(to bottom left, #a3ea2a, #2e4463); padding: 2px; margin-left: 10px; display: flex; align-items: center; justify-content: center; }
    .thm-avatar { width: 60px; height: 60px; background-image: url('${avatarDataUri}'); background-size: cover; background-position: center; border-radius: 50%; background-color: #121212; box-shadow: 0 0 3px 0 #303030; }
    .badge-user-details { display: flex; flex-direction: column; gap: 8px; }
    .title-wrapper { display: flex; align-items: center; gap: 6px; }
    .user_name { font-weight: 500; font-size: 14px; color: #f9f9fb; max-width: 135px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rank-title { font-weight: 500; font-size: 12px; color: #ffffff; }
    .details-wrapper { display: flex; gap: 8px; }
    .details-icon-wrapper { display: flex; gap: 4px; align-items: center; }
    .details-icon-wrapper img { flex-shrink: 0; height: 16px; opacity: 0.85; }
    .details-text { font-weight: 400; font-size: 11px; color: #ffffff; }
    .thm-link { font-weight: 400; font-size: 11px; color: #f9f9fb; text-decoration: none; }
  </style>
</head>
<body>
  <div id="thm-badge">
    <div class="thm-avatar-outer"><div class="thm-avatar"></div></div>
    <div class="badge-user-details">
      <div class="title-wrapper">
        <span class="user_name">${stats.username}</span>
        <span class="rank-title">${stats.rankTitle}</span>
      </div>
      <div class="details-wrapper">
        <div class="details-icon-wrapper"><img src="${iconTrophyUri}" alt="trophy" /><span class="details-text">${stats.points}</span></div>
        <div class="details-icon-wrapper"><img src="${iconDoorUri}" alt="door" /><span class="details-text">${stats.rooms}</span></div>
        <div class="details-icon-wrapper"><img src="${iconTargetUri}" alt="target" /><span class="details-text">${stats.rank}</span></div>
      </div>
      <a href="https://tryhackme.com" class="thm-link" target="_blank">tryhackme.com</a>
    </div>
  </div>
</body>
</html>`;
}

// ─── Screenshot ─────────────────────────────────────────────────────
async function takeScreenshot(html) {
  const browser = await puppeteer.launch(getLaunchOptions());
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 329, height: 88 });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    // Wait a bit for any remaining layout
    await new Promise(resolve => setTimeout(resolve, 500));
    await page.screenshot({ path: OUTPUT_PATH, omitBackground: true });
  } finally {
    try { await browser.close(); } catch {}
  }
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  try {
    if (DEBUG) console.log('[DEBUG] Mode enabled — saving raw HTML to debug/');

    const html = await fetchBadgeHTML();

    // Extract username, rankTitle, avatarUrl from badge HTML
    const nicknameMatch = html.match(/<span class="thm_nickname">([^<]+)<\/span>/);
    const username = nicknameMatch ? nicknameMatch[1] : 'virtualISP';

    const rankMatch = html.match(/<span class="thm_rank">([^<]+)<\/span\s*>/);
    const rankTitle = rankMatch ? rankMatch[1] : '[0xE]';

    let avatarUrl = null;
    const avatarMatch = html.match(/class="thm_avatar"[^>]*style="[^"]*background-image:\s*url\(['"]?([^'")]+)['"]?\)/);
    if (avatarMatch) {
      avatarUrl = avatarMatch[1];
      if (avatarUrl.startsWith('user-avatars/')) {
        avatarUrl = 'https://tryhackme-images.s3.amazonaws.com/' + avatarUrl;
      }
    }
    if (!avatarUrl) {
      const anyUrlMatch = html.match(/user-avatars\/([^'")]+)/);
      avatarUrl = anyUrlMatch ? 'https://tryhackme-images.s3.amazonaws.com/user-avatars/' + anyUrlMatch[1] : null;
    }
    if (!avatarUrl) {
      avatarUrl = 'https://tryhackme-images.s3.amazonaws.com/user-avatars/9868455b210665b03783b489764e48df.png';
    }

    const statsArray = extractStatsFromBadgeHTML(html);
    if (statsArray.length < 3) {
      console.warn('Stats extraction failed. HTML length:', html.length);
      console.warn('Has thm_nickname:', html.includes('thm_nickname'));
      console.warn('Has thm_stat:', html.includes('thm_stat'));
      throw new Error(`Expected at least 3 stats from badge, got ${statsArray.length}`);
    }
    const [points, rooms, rank] = statsArray;

    const stats = { username, rankTitle, avatarUrl, points, rank, rooms };

    const badgeHTML = await buildHTML(stats);
    await takeScreenshot(badgeHTML);

    console.log('Badge generated successfully!');
    console.log(`   Username: ${stats.username}`);
    console.log(`   Points: ${stats.points}`);
    console.log(`   Rank: ${stats.rank}`);
    console.log(`   Rooms: ${stats.rooms}`);
  } catch (err) {
    console.error('Failed to generate badge:', err.message);
    process.exit(1);
  }
}

main();
