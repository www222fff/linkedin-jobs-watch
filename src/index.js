// Cloudflare Worker for LinkedIn Guest Jobs Search & Web Explorer
// With Cloudflare KV 1-Day Caching Layer & Enhanced Fetch Resilience

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
];

const CACHE_TTL_SECONDS = 86400; // 1 day (24 hours)

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getRequestHeaders() {
  return {
    'User-Agent': getRandomUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'no-cache'
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseJobCards(html) {
  const cards = [];
  // Match <li> blocks or base-card divs
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = liRegex.exec(html)) !== null) {
    cards.push(match[1]);
  }

  // Fallback if no <li> tags
  if (cards.length === 0) {
    const cardSplits = html.split(/<div[^>]+class="[^"]*base-card[^"]*"/i);
    for (let i = 1; i < cardSplits.length; i++) {
      cards.push('<div class="base-card ' + cardSplits[i]);
    }
  }

  const results = [];
  for (const card of cards) {
    // Job ID
    const urnMatch = card.match(/data-entity-urn="urn:li:jobPosting:(\d+)"/i);
    const id = urnMatch ? urnMatch[1] : null;

    // Title
    const titleMatch = card.match(/<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/h3>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]) : '';

    // Company
    const compMatch = card.match(/<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>[\s\S]*?<a[^>]*>\s*([\s\S]*?)\s*<\/a>/i) ||
                      card.match(/<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/h4>/i);
    const company = compMatch ? stripHtml(compMatch[1]) : '';

    // Company URL
    const compUrlMatch = card.match(/<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"/i);
    const company_url = compUrlMatch ? compUrlMatch[1].split('?')[0] : '';

    // Logo
    const logoMatch = card.match(/<img[^>]+(?:data-delayed-url|src)="([^"]+)"[^>]*class="[^"]*artdeco-entity-image[^"]*"/i) ||
                      card.match(/<img[^>]+(?:data-delayed-url|src)="([^"]+)"/i);
    const logo = logoMatch ? logoMatch[1].replace(/&amp;/g, '&') : '';

    // Location
    const locMatch = card.match(/<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/span>/i);
    const location = locMatch ? stripHtml(locMatch[1]) : '';

    // Date
    const dateMatch = card.match(/<time[^>]*class="[^"]*job-search-card__listdate[^"]*"[^>]*datetime="([^"]*)"[^>]*>\s*([\s\S]*?)\s*<\/time>/i) ||
                      card.match(/<time[^>]*class="[^"]*job-search-card__listdate[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/time>/i);
    const date_iso = dateMatch && dateMatch[1] ? dateMatch[1] : '';
    const date_text = dateMatch ? stripHtml(dateMatch[2] || dateMatch[1]) : '';

    // Job URL (normalize to standard https://www.linkedin.com/jobs/view/{id})
    const urlMatch = card.match(/<a[^>]+class="[^"]*base-card__full-link[^"]*"[^>]+href="([^"]+)"/i);
    let job_url = id ? `https://www.linkedin.com/jobs/view/${id}` : '';
    if (!job_url && urlMatch) {
      job_url = urlMatch[1].split('?')[0].replace(/https?:\/\/[a-z]{2,3}\.linkedin\.com/i, 'https://www.linkedin.com');
    }

    // Salary
    const salaryMatch = card.match(/<span[^>]*class="[^"]*job-search-card__salary-info[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/span>/i);
    const salary = salaryMatch ? stripHtml(salaryMatch[1]) : '';

    // Benefits / Easy apply badge
    const badgeMatch = card.match(/<span[^>]*class="[^"]*result-benefits__text[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/span>/i);
    const badge = badgeMatch ? stripHtml(badgeMatch[1]) : '';

    if (title || id) {
      results.push({
        id,
        title,
        company,
        company_url,
        logo,
        location,
        date_iso,
        date_text,
        url: job_url,
        salary,
        badge
      });
    }
  }

  return results;
}

function parseJobDetail(html) {
  // Description Markup
  const descMatch = html.match(/<div[^>]*class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/section>/i) ||
                    html.match(/<section[^>]*class="[^"]*description[^"]*"[^>]*>[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/i);
  const description_html = descMatch ? descMatch[1].trim() : '';

  // Criteria
  const criteria = {};
  const itemRegex = /<li[^>]*class="[^"]*description__job-criteria-item[^"]*"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = itemRegex.exec(html)) !== null) {
    const k = stripHtml(m[1]);
    const v = stripHtml(m[2]);
    if (k && v) {
      criteria[k] = v;
    }
  }

  return {
    description_html,
    criteria
  };
}

// Handler for API search requests with KV Cache
async function handleApiSearch(url, env, ctx) {
  const params = url.searchParams;
  const keywords = params.get('keywords') || 'full stack developer';
  const location = params.get('location') || 'Remote';
  const start = params.get('start') || '0';
  const timePosted = params.get('f_TPR') || 'r604800'; // default: past week (r604800)
  const workType = params.get('f_WT') || ''; // 1=On-site, 2=Remote, 3=Hybrid
  const expLevel = params.get('f_E') || ''; // 1..6
  const jobType = params.get('f_JT') || ''; // F, P, C...
  const forceRefresh = params.get('refresh') === '1' || params.get('refresh') === 'true';

  // Build normalized cache key
  const cacheKey = `search:v1:${keywords.toLowerCase().trim()}:${location.toLowerCase().trim()}:${timePosted}:${workType}:${expLevel}:${jobType}:${start}`;

  // 1. Check KV Cache first (unless forceRefresh is set)
  if (env && env.KV && !forceRefresh) {
    try {
      const cached = await env.KV.get(cacheKey, { type: 'json' });
      if (cached && Array.isArray(cached.jobs) && cached.jobs.length > 0) {
        return new Response(JSON.stringify({
          ...cached,
          from_cache: true
        }), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'X-Data-Source': 'KV-Cache'
          }
        });
      }
    } catch (e) {
      console.warn('KV get cache error:', e);
    }
  }

  // 2. Cache miss -> Fetch from LinkedIn
  const targetUrl = new URL('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search');
  targetUrl.searchParams.set('keywords', keywords);
  targetUrl.searchParams.set('location', location);
  targetUrl.searchParams.set('start', start);
  if (timePosted) targetUrl.searchParams.set('f_TPR', timePosted);
  if (workType) targetUrl.searchParams.set('f_WT', workType);
  if (expLevel) targetUrl.searchParams.set('f_E', expLevel);
  if (jobType) targetUrl.searchParams.set('f_JT', jobType);

  try {
    let res = await fetch(targetUrl.toString(), {
      headers: getRequestHeaders()
    });

    // If rate limited, wait 800ms and try one more time
    if (res.status === 429) {
      await sleep(800);
      res = await fetch(targetUrl.toString(), {
        headers: getRequestHeaders()
      });
    }

    if (res.status === 429) {
      return new Response(JSON.stringify({
        error: 'LinkedIn Rate Limit (429)',
        message: 'LinkedIn 对公开搜索频次有限制，已启用自动保护。请稍等几秒后再试。',
        jobs: [],
        from_cache: false
      }), {
        status: 429,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (!res.ok) {
      return new Response(JSON.stringify({
        error: `LinkedIn HTTP ${res.status}`,
        message: `从 LinkedIn 获取数据失败 (${res.statusText})`,
        jobs: [],
        from_cache: false
      }), {
        status: res.status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const html = await res.text();
    const jobs = parseJobCards(html);

    const payload = {
      status: 'success',
      query: {
        keywords,
        location,
        timePosted,
        workType,
        start: parseInt(start, 10)
      },
      count: jobs.length,
      jobs,
      cached_at: new Date().toISOString()
    };

    // 3. Save to KV with 1-day expiration (86400s)
    if (env && env.KV && jobs.length > 0) {
      const putPromise = env.KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: CACHE_TTL_SECONDS });
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(putPromise);
      } else {
        await putPromise;
      }
    }

    return new Response(JSON.stringify({
      ...payload,
      from_cache: false
    }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-Data-Source': 'LinkedIn-Live'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: 'Fetch Exception',
      message: err.message,
      jobs: [],
      from_cache: false
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

// Handler for API detail requests with KV Cache
async function handleApiDetail(url, env, ctx) {
  const jobId = url.searchParams.get('id');
  const forceRefresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';

  if (!jobId) {
    return new Response(JSON.stringify({ error: 'Missing id parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const cacheKey = `detail:v1:${jobId}`;

  // 1. Check KV Cache first
  if (env && env.KV && !forceRefresh) {
    try {
      const cached = await env.KV.get(cacheKey, { type: 'json' });
      if (cached && (cached.description_html || cached.criteria)) {
        return new Response(JSON.stringify({
          ...cached,
          from_cache: true
        }), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'X-Data-Source': 'KV-Cache'
          }
        });
      }
    } catch (e) {
      console.warn('KV get detail cache error:', e);
    }
  }

  // 2. Fetch from LinkedIn detail endpoint
  const targetUrl = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
  try {
    let res = await fetch(targetUrl, {
      headers: getRequestHeaders()
    });

    if (res.status === 429) {
      await sleep(800);
      res = await fetch(targetUrl, {
        headers: getRequestHeaders()
      });
    }

    if (!res.ok) {
      return new Response(JSON.stringify({ error: `LinkedIn detail returned ${res.status}`, from_cache: false }), {
        status: res.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const html = await res.text();
    const detail = parseJobDetail(html);

    const payload = {
      status: 'success',
      id: jobId,
      ...detail,
      cached_at: new Date().toISOString()
    };

    // 3. Save to KV with 1-day expiration (86400s)
    if (env && env.KV && (detail.description_html || Object.keys(detail.criteria).length > 0)) {
      const putPromise = env.KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: CACHE_TTL_SECONDS });
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(putPromise);
      } else {
        await putPromise;
      }
    }

    return new Response(JSON.stringify({
      ...payload,
      from_cache: false
    }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-Data-Source': 'LinkedIn-Live'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, from_cache: false }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

function getHtmlPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LinkedIn 职位实时雷达 | Guest Jobs Explorer</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
    body { font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif; }
    .glass { background: rgba(255, 255, 255, 0.85); backdrop-filter: blur(12px); }
    .job-desc, .job-desc * { color: #cbd5e1 !important; }
    .job-desc h1, .job-desc h2, .job-desc h3, .job-desc h4, .job-desc h5, .job-desc h6 {
      font-weight: 700;
      margin-top: 1rem;
      margin-bottom: 0.5rem;
      color: #f8fafc !important;
      font-size: 1.05rem;
    }
    .job-desc strong, .job-desc b {
      font-weight: 600;
      color: #ffffff !important;
    }
    .job-desc p {
      margin-bottom: 0.65rem;
      line-height: 1.65;
      color: #cbd5e1 !important;
    }
    .job-desc ul, .job-desc ol {
      padding-left: 1.25rem;
      margin: 0.65rem 0;
      color: #cbd5e1 !important;
    }
    .job-desc ul { list-style-type: disc; }
    .job-desc ol { list-style-type: decimal; }
    .job-desc li {
      margin-bottom: 0.3rem;
      color: #cbd5e1 !important;
    }
    .job-desc a {
      color: #60a5fa !important;
      text-decoration: underline;
    }
    .custom-scrollbar::-webkit-scrollbar { width: 5px; }
    .custom-scrollbar::-webkit-scrollbar-thumb { background: #475569; border-radius: 4px; }
    .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #64748b; }
    .no-scrollbar::-webkit-scrollbar { display: none; }
    .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
    button, a { -webkit-tap-highlight-color: transparent; }
  </style>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen flex flex-col antialiased">
  <!-- Top Navigation -->
  <header class="border-b border-slate-800 bg-slate-900/95 backdrop-blur sticky top-0 z-40">
    <div class="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 h-14 sm:h-16 flex items-center justify-between">
      <div class="flex items-center space-x-2.5 sm:space-x-3 min-w-0">
        <div class="w-8 h-8 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-tr from-blue-600 via-indigo-500 to-sky-400 flex items-center justify-center shadow-lg shadow-blue-500/20 shrink-0">
          <i class="fa-brands fa-linkedin text-white text-base sm:text-xl"></i>
        </div>
        <div class="min-w-0">
          <h1 class="text-sm sm:text-lg font-bold tracking-tight text-white flex items-center gap-1.5 truncate">
            <span>LinkedIn 职位雷达</span>
            <span class="text-[10px] sm:text-xs font-semibold px-1.5 py-0.2 sm:px-2 sm:py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">Guest API</span>
          </h1>
          <p class="text-[11px] sm:text-xs text-slate-400 truncate hidden sm:block">免登录实时检索 • Cloudflare KV 1天持久化缓存</p>
        </div>
      </div>
      <div class="flex items-center space-x-1.5 sm:space-x-3 text-[11px] sm:text-xs shrink-0">
        <span id="cacheStatusBadge" class="hidden items-center gap-1 px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/20">
          <i class="fa-solid fa-bolt text-[10px]"></i>
          <span class="hidden sm:inline">KV 缓存已命中</span>
          <span class="sm:hidden">缓存</span>
        </span>
        <span class="inline-flex items-center gap-1.5 px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
          <span class="hidden sm:inline">KV 数据库就绪</span>
          <span class="sm:hidden">就绪</span>
        </span>
      </div>
    </div>
  </header>

  <!-- Main Container -->
  <main class="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6 flex-1 w-full flex flex-col gap-4 sm:gap-6">
    <!-- Search Controls Card -->
    <section class="bg-slate-800/80 border border-slate-700/80 rounded-2xl p-4 sm:p-5 shadow-xl">
      <form id="searchForm" class="grid grid-cols-2 md:grid-cols-12 gap-3 sm:gap-4 items-end">
        <!-- Keywords (Full width on mobile: col-span-2, on desktop: md:col-span-4) -->
        <div class="col-span-2 md:col-span-4 flex flex-col gap-1.5">
          <label class="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <i class="fa-solid fa-briefcase text-blue-400"></i> 职位关键词
          </label>
          <div class="relative">
            <input type="text" id="keywordsInput" value="Full Stack Developer" placeholder="例如：Full Stack Developer, AI Agent..." 
                   class="w-full bg-slate-900/90 border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition shadow-inner">
          </div>
        </div>

        <!-- Location Selection (col-span-1 on mobile, md:col-span-3 on desktop) -->
        <div class="col-span-1 md:col-span-3 flex flex-col gap-1.5">
          <label class="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <i class="fa-solid fa-location-dot text-rose-400"></i> 目标地区
          </label>
          <select id="locationSelect" class="w-full bg-slate-900/90 border border-slate-700 rounded-xl px-2.5 sm:px-3 py-2.5 text-xs sm:text-sm text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition">
            <option value="China" selected>🇨🇳 China (中国)</option>
            <option value="Remote">🌐 Remote (全球)</option>
            <option value="United States">🇺🇸 United States (美国)</option>
            <option value="Singapore">🇸🇬 Singapore (新加坡)</option>
            <option value="Japan">🇯🇵 Japan (日本)</option>
            <option value="United Kingdom">🇬🇧 UK (英国)</option>
            <option value="Germany">🇩🇪 Germany (德国)</option>
            <option value="Brazil">🇧🇷 Brazil (巴西)</option>
            <option value="Worldwide">🌍 Worldwide (全球)</option>
          </select>
        </div>

        <!-- Work Model (col-span-1 on mobile, md:col-span-2 on desktop) -->
        <div class="col-span-1 md:col-span-2 flex flex-col gap-1.5">
          <label class="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <i class="fa-solid fa-laptop-house text-emerald-400"></i> 办公形式
          </label>
          <select id="workTypeSelect" class="w-full bg-slate-900/90 border border-slate-700 rounded-xl px-2.5 sm:px-3 py-2.5 text-xs sm:text-sm text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition">
            <option value="">全部形式</option>
            <option value="2" selected>🏠 纯远程 (Remote)</option>
            <option value="1">📍 现场 (On-site)</option>
            <option value="3">🏢 混合 (Hybrid)</option>
          </select>
        </div>

        <!-- Time Range (col-span-1 on mobile, md:col-span-2 on desktop) -->
        <div class="col-span-1 md:col-span-2 flex flex-col gap-1.5">
          <label class="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
            <i class="fa-regular fa-clock text-amber-400"></i> 发布时间
          </label>
          <select id="timePostedSelect" class="w-full bg-slate-900/90 border border-slate-700 rounded-xl px-2.5 sm:px-3 py-2.5 text-xs sm:text-sm text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition">
            <option value="r86400">⚡ 24 小时内</option>
            <option value="r604800" selected>📅 1 周内 (默认)</option>
            <option value="r2592000">🗓️ 1 个月内</option>
            <option value="">♾️ 不限时间</option>
          </select>
        </div>

        <!-- Submit & Refresh Buttons (col-span-1 on mobile, md:col-span-1 on desktop) -->
        <div class="col-span-1 md:col-span-1 flex gap-2">
          <button type="submit" id="searchBtn" title="搜索" class="flex-1 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-semibold py-2.5 px-3 rounded-xl shadow-lg shadow-blue-600/30 flex items-center justify-center gap-1.5 transition active:scale-95">
            <i class="fa-solid fa-magnifying-glass"></i>
            <span class="text-xs md:hidden font-medium">搜索</span>
          </button>
          <button type="button" id="refreshBtn" title="强制刷新 (重新拉取)" class="bg-slate-700/80 hover:bg-slate-700 text-slate-300 font-semibold py-2.5 px-3 rounded-xl border border-slate-600/60 flex items-center justify-center transition active:scale-95">
            <i class="fa-solid fa-rotate"></i>
          </button>
        </div>
      </form>

      <!-- Quick Preset Tags -->
      <div class="mt-3.5 pt-3 border-t border-slate-700/60 flex items-center gap-2 text-xs">
        <span class="text-slate-400 font-medium shrink-0 text-xs">快捷搜索：</span>
        <div class="flex items-center gap-2 overflow-x-auto no-scrollbar py-0.5 whitespace-nowrap scroll-smooth">
          <button class="preset-tag shrink-0 px-2.5 py-1 rounded-lg bg-slate-700/60 hover:bg-slate-700 text-slate-200 border border-slate-600/50 transition active:scale-95" data-kw="Full Stack Developer" data-loc="China" data-wt="2">🇨🇳 全栈 (中国 Remote)</button>
          <button class="preset-tag shrink-0 px-2.5 py-1 rounded-lg bg-slate-700/60 hover:bg-slate-700 text-slate-200 border border-slate-600/50 transition active:scale-95" data-kw="AI Agent" data-loc="China" data-wt="2">🤖 AI Agent (中国 Remote)</button>
          <button class="preset-tag shrink-0 px-2.5 py-1 rounded-lg bg-slate-700/60 hover:bg-slate-700 text-slate-200 border border-slate-600/50 transition active:scale-95" data-kw="Full Stack Developer" data-loc="China" data-wt="1">🏢 全栈 (中国 On-site)</button>
          <button class="preset-tag shrink-0 px-2.5 py-1 rounded-lg bg-slate-700/60 hover:bg-slate-700 text-slate-200 border border-slate-600/50 transition active:scale-95" data-kw="AI Agent" data-loc="China" data-wt="1">📍 AI Agent (中国 On-site)</button>
        </div>
      </div>
    </section>

    <!-- Mobile View Switcher Tabs (Visible only on mobile/tablet screens < lg) -->
    <div class="lg:hidden flex items-center bg-slate-800/90 p-1 rounded-xl border border-slate-700/80 shadow-md">
      <button type="button" id="mobileTabList" onclick="switchMobileView('list')" class="flex-1 py-2 px-3 text-xs font-semibold rounded-lg bg-blue-600 text-white shadow transition flex items-center justify-center gap-1.5">
        <i class="fa-solid fa-list-ul"></i>
        <span>职位列表</span>
        <span id="mobileListCount" class="px-1.5 py-0.2 rounded-full bg-white/20 text-[10px]">0</span>
      </button>
      <button type="button" id="mobileTabDetail" onclick="switchMobileView('detail')" class="flex-1 py-2 px-3 text-xs font-semibold rounded-lg text-slate-400 hover:text-slate-200 transition flex items-center justify-center gap-1.5">
        <i class="fa-regular fa-file-lines"></i>
        <span>职位详情</span>
      </button>
    </div>

    <!-- Main Results Grid (Split view on desktop, tabbed switch on mobile) -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 flex-1 items-start min-h-[480px]">
      <!-- Left Column: Job List -->
      <div id="jobListColumn" class="flex flex-col gap-3 lg:col-span-5">
        <div class="flex items-center justify-between px-1">
          <div class="flex items-center gap-2">
            <h2 class="text-xs sm:text-sm font-bold text-slate-200 uppercase tracking-wider">职位结果</h2>
            <span id="resultsCountBadge" class="text-xs px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-slate-400">0 条</span>
            <span id="cacheTag" class="hidden text-[10px] sm:text-[11px] px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 flex items-center gap-1">
              <i class="fa-solid fa-database text-[10px]"></i> KV 1天缓存
            </span>
          </div>
          <div id="pageIndicator" class="text-xs text-slate-400">第 1 页</div>
        </div>

        <!-- Job Cards Container -->
        <div id="jobListContainer" class="flex flex-col gap-2.5 max-h-[600px] lg:max-h-[720px] overflow-y-auto custom-scrollbar pr-0.5 sm:pr-1">
          <div class="p-8 text-center bg-slate-800/40 border border-dashed border-slate-700 rounded-2xl text-slate-400">
            <i class="fa-solid fa-magnifying-glass-location text-3xl mb-3 text-slate-500"></i>
            <p class="text-sm font-medium">点击上方搜索或选择快捷标签即可开始查找</p>
            <p class="text-xs text-slate-500 mt-1">自动查询并同步持久化到 Cloudflare KV 数据库（保存 24 小时）</p>
          </div>
        </div>

        <!-- Pagination Controls -->
        <div id="paginationContainer" class="hidden flex items-center justify-between pt-2 px-1">
          <button id="prevPageBtn" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:pointer-events-none text-xs font-semibold text-slate-300 border border-slate-700 flex items-center gap-1.5 transition active:scale-95">
            <i class="fa-solid fa-chevron-left"></i> 上一页
          </button>
          <button id="nextPageBtn" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:pointer-events-none text-xs font-semibold text-slate-300 border border-slate-700 flex items-center gap-1.5 transition active:scale-95">
            下一页 <i class="fa-solid fa-chevron-right"></i>
          </button>
        </div>
      </div>

      <!-- Right Column: Job Detail View -->
      <div id="jobDetailColumn" class="hidden lg:flex lg:col-span-7 bg-slate-800/90 border border-slate-700/80 rounded-2xl p-4 sm:p-6 shadow-xl lg:sticky lg:top-24 min-h-[420px] flex-col">
        <!-- Mobile Back Button Bar -->
        <div class="lg:hidden pb-3 mb-3 border-b border-slate-700/70 flex items-center justify-between">
          <button type="button" onclick="switchMobileView('list')" class="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-400 hover:text-blue-300 bg-blue-500/10 px-3 py-1.5 rounded-lg border border-blue-500/20 active:scale-95 transition">
            <i class="fa-solid fa-arrow-left"></i> 返回职位列表
          </button>
          <span class="text-[11px] text-slate-400">职位详情</span>
        </div>

        <div id="detailPlaceholder" class="m-auto text-center py-12 sm:py-16 text-slate-400">
          <div class="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-slate-700/40 border border-slate-700 flex items-center justify-center mx-auto mb-3 sm:mb-4 text-slate-500">
            <i class="fa-regular fa-file-lines text-2xl"></i>
          </div>
          <h3 class="text-sm sm:text-base font-semibold text-slate-300">选择职位查看完整详情</h3>
          <p class="text-xs text-slate-500 mt-1 max-w-sm">左侧点击任意职位卡片，优先从 KV 数据库毫秒级读取，未命中则实时请求 LinkedIn</p>
        </div>

        <div id="detailContent" class="hidden flex-col gap-4">
          <!-- Detail Header -->
          <div class="border-b border-slate-700 pb-4 sm:pb-5">
            <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
              <div class="flex items-start gap-3 min-w-0">
                <img id="detailCompanyLogo" src="" alt="" class="w-11 h-11 sm:w-12 sm:h-12 rounded-xl object-cover border border-slate-700 bg-slate-900 shrink-0">
                <div class="min-w-0 flex-1">
                  <h2 id="detailTitle" class="text-base sm:text-xl font-bold text-white leading-snug break-words"></h2>
                  <div class="flex items-center gap-2 mt-1 flex-wrap text-xs sm:text-sm">
                    <span id="detailCompany" class="font-semibold text-blue-400 truncate max-w-[200px]"></span>
                    <span class="text-slate-500">•</span>
                    <span id="detailLocation" class="text-xs text-slate-400 flex items-center gap-1">
                      <i class="fa-solid fa-location-dot text-rose-400"></i> <span></span>
                    </span>
                  </div>
                </div>
              </div>
              <!-- Action buttons: Full width grid on mobile, inline flex on desktop -->
              <div class="grid grid-cols-2 sm:flex sm:items-center gap-2 shrink-0 w-full sm:w-auto">
                <button id="copyLinkBtn" onclick="copyJobLink()" class="bg-slate-700/80 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-3 py-2.5 rounded-xl flex items-center justify-center gap-1.5 border border-slate-600 transition active:scale-95" title="复制职位直达链接">
                  <i class="fa-regular fa-copy"></i>
                  <span id="copyBtnText">复制链接</span>
                </button>
                <a id="detailExternalLink" href="#" target="_blank" rel="noopener noreferrer" 
                   class="bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold px-3.5 py-2.5 rounded-xl flex items-center justify-center gap-1.5 shadow-md shadow-blue-600/20 transition active:scale-95">
                  <span>前往投递</span>
                  <i class="fa-solid fa-arrow-up-right-from-square"></i>
                </a>
              </div>
            </div>

            <!-- Notice about LinkedIn China 451 -->
            <div class="mt-3 px-3 py-2 sm:px-3.5 sm:py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-start gap-2 text-[11px] sm:text-xs text-amber-200/90 leading-relaxed">
              <i class="fa-solid fa-triangle-exclamation text-amber-400 mt-0.5 shrink-0 text-xs sm:text-sm"></i>
              <span><b>451 提示：</b>LinkedIn 官方检测到中国大陆直连 IP 时，会自动跳转至已停服的中国站并报错 451。点击投递前请确保浏览器代理已开启，或点击「复制链接」在代理环境中打开。</span>
            </div>

            <!-- Badges & Criteria Tags -->
            <div id="detailCriteria" class="flex flex-wrap gap-1.5 sm:gap-2 mt-3.5 pt-3 border-t border-slate-700/60">
            </div>
          </div>

          <!-- Description Body -->
          <div class="flex-1 max-h-[500px] lg:max-h-[500px] overflow-y-auto custom-scrollbar pr-1 sm:pr-2 mt-1 bg-slate-900/50 p-3.5 sm:p-4 rounded-xl border border-slate-700/60">
            <div id="detailBody" class="job-desc text-xs sm:text-sm text-slate-300 space-y-2 leading-relaxed"></div>
          </div>
        </div>
      </div>
    </div>
  </main>

  <!-- Footer -->
  <footer class="border-t border-slate-800 py-4 text-center text-xs text-slate-500">
    <div class="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
      <p>Powered by LinkedIn Guest Jobs API • Cloudflare KV Caching (1-Day TTL) • Cloudflare Workers</p>
      <p class="text-slate-600">仅供个人求职检索与技术验证使用</p>
    </div>
  </footer>

  <script>
    let currentStart = 0;
    let selectedJobId = null;
    let currentJobs = [];
    let mobileCurrentView = 'list';

    const searchForm = document.getElementById('searchForm');
    const refreshBtn = document.getElementById('refreshBtn');
    const keywordsInput = document.getElementById('keywordsInput');
    const locationSelect = document.getElementById('locationSelect');
    const timePostedSelect = document.getElementById('timePostedSelect');
    const workTypeSelect = document.getElementById('workTypeSelect');
    const searchBtn = document.getElementById('searchBtn');
    const jobListContainer = document.getElementById('jobListContainer');
    const resultsCountBadge = document.getElementById('resultsCountBadge');
    const pageIndicator = document.getElementById('pageIndicator');
    const paginationContainer = document.getElementById('paginationContainer');
    const prevPageBtn = document.getElementById('prevPageBtn');
    const nextPageBtn = document.getElementById('nextPageBtn');
    const cacheTag = document.getElementById('cacheTag');
    const cacheStatusBadge = document.getElementById('cacheStatusBadge');

    const detailPlaceholder = document.getElementById('detailPlaceholder');
    const detailContent = document.getElementById('detailContent');
    const detailCompanyLogo = document.getElementById('detailCompanyLogo');
    const detailTitle = document.getElementById('detailTitle');
    const detailCompany = document.getElementById('detailCompany');
    const detailLocation = document.getElementById('detailLocation').querySelector('span');
    const detailExternalLink = document.getElementById('detailExternalLink');
    const detailCriteria = document.getElementById('detailCriteria');
    const detailBody = document.getElementById('detailBody');

    window.switchMobileView = function(view) {
      mobileCurrentView = view;
      const listCol = document.getElementById('jobListColumn');
      const detailCol = document.getElementById('jobDetailColumn');
      const tabList = document.getElementById('mobileTabList');
      const tabDetail = document.getElementById('mobileTabDetail');

      if (!listCol || !detailCol) return;

      if (view === 'list') {
        listCol.classList.remove('hidden');
        detailCol.classList.add('hidden');
        
        if (tabList && tabDetail) {
          tabList.className = 'flex-1 py-2 px-3 text-xs font-semibold rounded-lg bg-blue-600 text-white shadow transition flex items-center justify-center gap-1.5';
          tabDetail.className = 'flex-1 py-2 px-3 text-xs font-semibold rounded-lg text-slate-400 hover:text-slate-200 transition flex items-center justify-center gap-1.5';
        }
      } else {
        listCol.classList.add('hidden');
        detailCol.classList.remove('hidden');
        
        if (tabList && tabDetail) {
          tabDetail.className = 'flex-1 py-2 px-3 text-xs font-semibold rounded-lg bg-blue-600 text-white shadow transition flex items-center justify-center gap-1.5';
          tabList.className = 'flex-1 py-2 px-3 text-xs font-semibold rounded-lg text-slate-400 hover:text-slate-200 transition flex items-center justify-center gap-1.5';
        }

        if (window.innerWidth < 1024) {
          window.scrollTo({ top: detailCol.offsetTop - 65, behavior: 'smooth' });
        }
      }
    };

    window.addEventListener('resize', () => {
      const listCol = document.getElementById('jobListColumn');
      const detailCol = document.getElementById('jobDetailColumn');
      if (window.innerWidth >= 1024) {
        if (listCol) {
          listCol.classList.remove('hidden');
        }
        if (detailCol) {
          detailCol.classList.remove('hidden');
        }
      } else {
        switchMobileView(mobileCurrentView);
      }
    });

    // Preset button click
    document.querySelectorAll('.preset-tag').forEach(btn => {
      btn.addEventListener('click', () => {
        keywordsInput.value = btn.dataset.kw;
        locationSelect.value = btn.dataset.loc;
        workTypeSelect.value = btn.dataset.wt || '';
        currentStart = 0;
        executeSearch(false);
      });
    });

    searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      currentStart = 0;
      executeSearch(false);
    });

    refreshBtn.addEventListener('click', () => {
      currentStart = 0;
      executeSearch(true);
    });

    prevPageBtn.addEventListener('click', () => {
      if (currentStart >= 25) {
        currentStart -= 25;
        executeSearch(false);
      }
    });

    nextPageBtn.addEventListener('click', () => {
      currentStart += 25;
      executeSearch(false);
    });

    async function executeSearch(forceRefresh = false) {
      const kw = keywordsInput.value.trim();
      const loc = locationSelect.value;
      const tpr = timePostedSelect.value;
      const wt = workTypeSelect.value;

      if (!kw) return;

      searchBtn.disabled = true;
      searchBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
      cacheTag.classList.add('hidden');
      cacheStatusBadge.classList.add('hidden');

      jobListContainer.innerHTML = \`
        <div class="space-y-2.5">
          \${[1, 2, 3, 4, 5].map(() => \`
            <div class="p-3.5 sm:p-4 bg-slate-800/40 border border-slate-700/60 rounded-xl animate-pulse flex items-start gap-3">
              <div class="w-10 h-10 rounded-lg bg-slate-700 shrink-0"></div>
              <div class="flex-1 space-y-2">
                <div class="h-4 bg-slate-700 rounded w-3/4"></div>
                <div class="h-3 bg-slate-700/60 rounded w-1/2"></div>
                <div class="h-3 bg-slate-700/40 rounded w-1/4"></div>
              </div>
            </div>
          \`).join('')}
        </div>
      \`;

      try {
        const queryParams = new URLSearchParams({
          keywords: kw,
          location: loc,
          start: currentStart.toString(),
          f_TPR: tpr
        });
        if (wt) queryParams.set('f_WT', wt);
        if (forceRefresh) queryParams.set('refresh', '1');

        const res = await fetch('/api/search?' + queryParams.toString());
        const data = await res.json();

        searchBtn.disabled = false;
        searchBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i><span class="text-xs md:hidden font-medium ml-1">搜索</span>';

        if (data.error) {
          jobListContainer.innerHTML = \`
            <div class="p-6 bg-rose-500/10 border border-rose-500/20 rounded-xl text-center">
              <i class="fa-solid fa-triangle-exclamation text-rose-400 text-2xl mb-2"></i>
              <h4 class="text-sm font-bold text-rose-300">\${data.error}</h4>
              <p class="text-xs text-rose-400 mt-1">\${data.message || '请求 LinkedIn 失败'}</p>
            </div>
          \`;
          return;
        }

        currentJobs = data.jobs || [];
        resultsCountBadge.textContent = \`\${currentJobs.length} 条\`;
        const mobileListCount = document.getElementById('mobileListCount');
        if (mobileListCount) mobileListCount.textContent = currentJobs.length.toString();

        pageIndicator.textContent = \`第 \${Math.floor(currentStart / 25) + 1} 页\`;
        paginationContainer.classList.remove('hidden');
        prevPageBtn.disabled = currentStart === 0;
        nextPageBtn.disabled = currentJobs.length < 10;

        if (data.from_cache) {
          cacheTag.classList.remove('hidden');
          cacheStatusBadge.classList.remove('hidden');
        }

        if (currentJobs.length === 0) {
          jobListContainer.innerHTML = \`
            <div class="p-8 text-center bg-slate-800/40 border border-slate-700 rounded-2xl text-slate-400">
              <i class="fa-solid fa-inbox text-3xl mb-2 text-slate-500"></i>
              <p class="text-sm font-medium">未找到匹配职位</p>
              <p class="text-xs text-slate-500 mt-1">尝试放宽关键词或调整发布时间范围</p>
            </div>
          \`;
          return;
        }

        renderJobList();
        // Automatically select the first job for desktop preview, but don't force mobile tab switch
        if (currentJobs.length > 0) {
          selectJob(currentJobs[0], false);
        }
        if (window.innerWidth < 1024) {
          switchMobileView('list');
        }
      } catch (err) {
        searchBtn.disabled = false;
        searchBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i><span class="text-xs md:hidden font-medium ml-1">搜索</span>';
        jobListContainer.innerHTML = \`
          <div class="p-6 bg-rose-500/10 border border-rose-500/20 rounded-xl text-center">
            <i class="fa-solid fa-circle-xmark text-rose-400 text-2xl mb-2"></i>
            <h4 class="text-sm font-bold text-rose-300">网络请求错误</h4>
            <p class="text-xs text-rose-400 mt-1">\${err.message}</p>
          </div>
        \`;
      }
    }

    function renderJobList() {
      jobListContainer.innerHTML = currentJobs.map(job => {
        const isSelected = selectedJobId === job.id;
        return \`
          <div class="job-card cursor-pointer p-3.5 sm:p-4 rounded-xl border transition-all duration-150 \${
            isSelected 
              ? 'bg-blue-600/15 border-blue-500/80 shadow-md shadow-blue-500/10' 
              : 'bg-slate-800/50 hover:bg-slate-800 border-slate-700/70'
          }" onclick="handleJobCardClick('\${job.id}')">
            <div class="flex items-start gap-3">
              <div class="w-10 h-10 rounded-lg bg-slate-900 border border-slate-700 shrink-0 overflow-hidden flex items-center justify-center">
                \${job.logo 
                  ? \`<img src="\${job.logo}" alt="" class="w-full h-full object-cover">\` 
                  : \`<i class="fa-solid fa-building text-slate-600"></i>\`
                }
              </div>
              <div class="flex-1 min-w-0">
                <h3 class="text-sm font-bold text-white truncate leading-snug">\${escapeHtml(job.title)}</h3>
                <p class="text-xs font-medium text-slate-300 truncate mt-0.5">\${escapeHtml(job.company || '未知公司')}</p>
                
                <div class="flex items-center gap-2.5 sm:gap-3 mt-2 text-[11px] text-slate-400 flex-wrap">
                  <span class="flex items-center gap-1">
                    <i class="fa-solid fa-location-dot text-rose-400"></i> \${escapeHtml(job.location || 'Remote')}
                  </span>
                  \${job.date_text ? \`
                    <span class="flex items-center gap-1 text-slate-500">
                      <i class="fa-regular fa-clock text-amber-400"></i> \${escapeHtml(job.date_text)}
                    </span>
                  \` : ''}
                  \${job.salary ? \`
                    <span class="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-medium">
                      \${escapeHtml(job.salary)}
                    </span>
                  \` : ''}
                </div>
              </div>
            </div>
          </div>
        \`;
      }).join('');
    }

    window.handleJobCardClick = function(id) {
      const job = currentJobs.find(j => j.id === id);
      if (job) selectJob(job, true);
    };

    async function selectJob(job, fromUserClick = false) {
      selectedJobId = job.id;
      renderJobList();

      if (fromUserClick && window.innerWidth < 1024) {
        switchMobileView('detail');
      }

      detailPlaceholder.classList.add('hidden');
      detailContent.classList.remove('hidden');

      detailTitle.textContent = job.title;
      detailCompany.textContent = job.company || '未知公司';
      detailLocation.textContent = job.location || 'Remote';
      detailExternalLink.href = job.url || \`https://www.linkedin.com/jobs/view/\${job.id}\`;
      
      if (job.logo) {
        detailCompanyLogo.src = job.logo;
        detailCompanyLogo.classList.remove('hidden');
      } else {
        detailCompanyLogo.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="%2364748b"><path d="M12 7V3H2v18h20V7H12zM6 19H4v-2h2v2zm0-4H4v-2h2v2zm0-4H4V9h2v2zm0-4H4V5h2v2zm4 12H8v-2h2v2zm0-4H8v-2h2v2zm0-4H8V9h2v2zm0-4H8V5h2v2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8v10zm-2-8h-2v2h2v-2zm0 4h-2v2h2v-2z"/></svg>';
      }

      // Populate basic criteria tags
      detailCriteria.innerHTML = \`
        <span class="px-2.5 py-1 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20 text-xs font-medium">
          <i class="fa-regular fa-calendar-check mr-1"></i> 发布时间：\${job.date_text || job.date_iso || '近期'}
        </span>
        \${job.badge ? \`<span class="px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 text-xs font-medium">\${escapeHtml(job.badge)}</span>\` : ''}
        \${job.salary ? \`<span class="px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-medium">\${escapeHtml(job.salary)}</span>\` : ''}
      \`;

      detailBody.innerHTML = \`
        <div class="py-8 text-center text-slate-400">
          <i class="fa-solid fa-spinner fa-spin text-2xl text-blue-400 mb-2"></i>
          <p class="text-xs">正在从 KV 数据库 / LinkedIn 获取岗位详情...</p>
        </div>
      \`;

      if (!job.id) {
        detailBody.innerHTML = '<p class="text-xs text-slate-400">暂无此职位的独立 ID 详情</p>';
        return;
      }

      try {
        const res = await fetch(\`/api/detail?id=\${job.id}\`);
        const data = await res.json();
        if (data.description_html) {
          detailBody.innerHTML = data.description_html;
          
          // Append criteria items if any
          if (data.criteria && Object.keys(data.criteria).length > 0) {
            for (const [key, val] of Object.entries(data.criteria)) {
              const tag = document.createElement('span');
              tag.className = 'px-2.5 py-1 rounded-lg bg-slate-700/60 text-slate-300 border border-slate-600/50 text-xs font-medium';
              tag.textContent = \`\${key}: \${val}\`;
              detailCriteria.appendChild(tag);
            }
          }

          if (data.from_cache) {
            const cacheSpan = document.createElement('span');
            cacheSpan.className = 'px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-medium';
            cacheSpan.innerHTML = '<i class="fa-solid fa-bolt mr-1"></i> KV 缓存秒级响应';
            detailCriteria.appendChild(cacheSpan);
          }
        } else {
          detailBody.innerHTML = \`
            <p class="text-sm text-slate-400">未获取到正文内容，您可以直接点击右上角前往 LinkedIn 官方页面查看。</p>
          \`;
        }
      } catch (e) {
        detailBody.innerHTML = \`
          <p class="text-xs text-rose-400">详情加载失败：\${e.message}。请点击右上角前往 LinkedIn 原文查看。</p>
        \`;
      }
    }

    window.copyJobLink = function() {
      const href = detailExternalLink.href;
      if (!href || href === '#') return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(href).then(() => {
          const btnText = document.getElementById('copyBtnText');
          btnText.textContent = '已复制！';
          setTimeout(() => { btnText.textContent = '复制链接'; }, 2000);
        }).catch(() => {
          prompt('请复制职位直达链接：', href);
        });
      } else {
        prompt('请复制职位直达链接：', href);
      }
    };

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // Run search on initial page load
    window.addEventListener('DOMContentLoaded', () => {
      // Default to China Remote Full Stack
      keywordsInput.value = 'Full Stack Developer';
      locationSelect.value = 'China';
      workTypeSelect.value = '2';
      executeSearch(false);
    });
  </script>
</body>
</html>
`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/search') {
      return handleApiSearch(url, env, ctx);
    }

    if (url.pathname === '/api/detail') {
      return handleApiDetail(url, env, ctx);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(getHtmlPage(), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};
