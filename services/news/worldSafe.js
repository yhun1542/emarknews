// services/news/worldSafe.js
const Parser = require('rss-parser');
const { fetchWithRetry, logAxiosError } = require('../rss/httpClient');
const NewsService = require('../newsService');

const { createClient } = require('redis');

const parser = new Parser();
const WORLD_PAGE_SIZE = Number(process.env.WORLD_PAGE_SIZE ?? 30);
const SWR_TTL_SEC = Number(process.env.SWR_TTL_SEC ?? 1800);   // 신선 30m
const STALE_TTL_SEC = Number(process.env.STALE_TTL_SEC ?? 7200); // 스테일 2h

const REDIS_URL = process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL || '';

let redis;
let memoryCache = { ts: 0, data: [] };

async function getRedis() {
  if (!REDIS_URL) return null;
  if (!redis) {
    redis = createClient({ url: REDIS_URL });
    redis.on('error', (e) => console.error('[redis-error]', e));
    await redis.connect();
  }
  return redis;
}

function normalizeRssItem(item, source) {
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60); // 30일 -> 60일로 완화
  
  const publishedDate = new Date(item.isoDate || item.pubDate || new Date().toISOString());
  
  // 60일 이내 뉴스만 반환
  if (isNaN(publishedDate.getTime()) || publishedDate < sixtyDaysAgo) {
    return null;
  }
  
  return {
    title: item.title,
    link: item.link,
    source,
    description: item.contentSnippet || item.content || '',
    publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
  };
}

function filterRecentNews(items) {
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60); // 30일 -> 60일로 완화
  
  return items.filter(item => {
    if (!item.publishedAt) return false;
    
    const publishedDate = new Date(item.publishedAt);
    if (isNaN(publishedDate.getTime())) return false;
    
    return publishedDate >= sixtyDaysAgo;
  });
}

async function fetchReutersWorld() {
  const urls = [
    'https://feeds.reuters.com/reuters/worldNews',
    'https://www.reuters.com/markets/world/rss',
  ];
  for (const url of urls) {
    try {
      const res = await fetchWithRetry(url, 3);
      const feed = await parser.parseString(res.data);
      if (feed?.items?.length) {
        return feed.items
          .map((it) => normalizeRssItem(it, 'Reuters'))
          .filter(item => item !== null); // null 값 필터링
      }
    } catch (e) {
      logAxiosError(e, { source: 'Reuters', url });
      continue;
    }
  }
  return [];
}

function dedupeAndSort(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = it.link || it.title;
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  out.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return out.slice(0, WORLD_PAGE_SIZE);
}

async function getWorldNewsFresh() {
  console.log('[DEBUG] getWorldNewsFresh started');
  
  // NewsService 클래스 인스턴스 사용
  const newsService = new NewsService();
  console.log('[DEBUG] NewsService instance created');
  
  const result = await newsService.getNews('world');
  const rssItems = result?.data || [];
  console.log('[DEBUG] NewsService.getNews result:', { 
    success: result?.success, 
    itemCount: rssItems.length,
    firstItem: rssItems[0]?.title 
  });
  
  // 기존 개별 소스도 시도 (추가 백업) - CNN 제거
  const [reuters] = await Promise.allSettled([fetchReutersWorld()]);
  const additionalItems = [
    ...(reuters.status === 'fulfilled' ? reuters.value : []),
  ];
  console.log('[DEBUG] Additional items:', { 
    reutersStatus: reuters.status,
    additionalCount: additionalItems.length 
  });
  
  // 모든 아이템 합치기 (rssItems가 배열인지 확인)
  const safeRssItems = Array.isArray(rssItems) ? rssItems : [];
  const allItems = [...safeRssItems, ...additionalItems];
  console.log('[DEBUG] All items combined:', allItems.length);
  
  // 날짜 필터링 적용
  const recentItems = filterRecentNews(allItems);
  console.log('[DEBUG] After date filtering:', recentItems.length);
  
  const finalResult = dedupeAndSort(recentItems);
  console.log('[DEBUG] Final result:', finalResult.length);
  
  return finalResult;
}

async function getWorldNewsSWR() {
  const r = await getRedis();
  const now = Math.floor(Date.now() / 1000);

  // 1) Redis에서 신선 캐시
  if (r) {
    const json = await r.get('news:world:v1');
    const ts = Number((await r.get('news:world:v1:ts')) || 0);
    if (json) {
      const data = JSON.parse(json);
      // 스테일 허용
      if (now - ts <= STALE_TTL_SEC) return { data, ts, stale: now - ts > SWR_TTL_SEC };
    }
  } else {
    // 메모리 캐시
    if (memoryCache.data.length && (now - memoryCache.ts <= STALE_TTL_SEC)) {
      return { data: memoryCache.data, ts: memoryCache.ts, stale: now - memoryCache.ts > SWR_TTL_SEC };
    }
  }

  // 2) 상류 fetch
  const fresh = await getWorldNewsFresh();

  // 3) 캐시 저장
  if (fresh.length) {
    if (r) {
      await r.set('news:world:v1', JSON.stringify(fresh), { EX: STALE_TTL_SEC });
      await r.set('news:world:v1:ts', String(now), { EX: STALE_TTL_SEC });
    } else {
      memoryCache = { ts: now, data: fresh };
    }
    return { data: fresh, ts: now, stale: false };
  }

  // 4) NewsAPI 페일백 시도 (키 없으면 throw)
  try {
    const newsService = new NewsService();
    const fb = await newsService.fetchFromNewsAPI('world');
    if (fb.length) {
      if (r) {
        await r.set('news:world:v1', JSON.stringify(fb), { EX: STALE_TTL_SEC });
        await r.set('news:world:v1:ts', String(now), { EX: STALE_TTL_SEC });
      } else {
        memoryCache = { ts: now, data: fb };
      }
      return { data: fb, ts: now, stale: false };
    }
  } catch (e) {
    console.error('[news-fallback-error]', e.message || e);
  }

  // 5) 그래도 없으면 빈 배열(프론트가 에러 UI 대신 빈 리스트를 그리게)
  return { data: [], ts: now, stale: true };
}

async function worldHandler(req, res) {
  try {
    const { data } = await getWorldNewsSWR();
    
    // 데이터가 없으면 NewsService로 즉시 페일백
    if (!data || data.length === 0) {
      try {
        const newsService = new NewsService();
        const result = await newsService.getNews('world');
        const articles = Array.isArray(result?.data) ? result.data : [];
        
        return res.status(200).json({
          success: true,
          data: {
            articles: articles.slice(0, WORLD_PAGE_SIZE)
          }
        });
      } catch (e) {
        console.error('[newsapi-fallback-error]', e);
        // NewsService도 실패하면 빈 배열 반환 (프론트 에러 UI 방지)
        return res.status(200).json({
          success: true,
          data: {
            articles: []
          }
        });
      }
    }
    
    // RSS 데이터가 있으면 반환
    return res.status(200).json({
      success: true,
      data: {
        articles: data
      }
    });
  } catch (e) {
    console.error('[worldHandler-error]', e);
    // 최후 방어선: NewsAPI 시도 후 실패해도 200 반환
    try {
      const newsService = new NewsService();
      const fb = await newsService.fetchFromNewsAPI('newsapi', 'world');
      return res.status(200).json({
        success: true,
        data: {
          articles: fb.slice(0, WORLD_PAGE_SIZE)
        }
      });
    } catch {
      return res.status(200).json({
        success: true,
        data: {
          articles: []
        }
      });
    }
  }
}

module.exports = { worldHandler };
