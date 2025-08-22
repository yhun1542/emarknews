// services/news/worldSafe.js
const Parser = require('rss-parser');
const { fetchWithRetry, logAxiosError } = require('../rss/httpClient');
const { fetchFromNewsAPI } = require('./newsapi');

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
  return {
    title: item.title,
    link: item.link,
    source,
    description: item.contentSnippet || item.content || '',
    publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
  };
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
        return feed.items.map((it) => normalizeRssItem(it, 'Reuters'));
      }
    } catch (e) {
      logAxiosError(e, { source: 'Reuters', url });
      continue;
    }
  }
  return [];
}

async function fetchCnnWorld() {
  const urls = [
    'http://rss.cnn.com/rss/edition_world.rss',
  ];
  for (const url of urls) {
    try {
      const res = await fetchWithRetry(url, 3);
      const feed = await parser.parseString(res.data);
      if (feed?.items?.length) {
        return feed.items.map((it) => normalizeRssItem(it, 'CNN'));
      }
    } catch (e) {
      logAxiosError(e, { source: 'CNN', url });
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
  const [reuters, cnn] = await Promise.allSettled([fetchReutersWorld(), fetchCnnWorld()]);
  const items = [
    ...(reuters.status === 'fulfilled' ? reuters.value : []),
    ...(cnn.status === 'fulfilled' ? cnn.value : []),
  ];
  return dedupeAndSort(items);
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
    const fb = await fetchFromNewsAPI({ pageSize: WORLD_PAGE_SIZE });
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
    // 다운 방지: 어떤 경우에도 200 반환 (콘텐츠 없으면 [])
    res.json(data);
  } catch (e) {
    console.error('[worldHandler-error]', e);
    // 최후: NewsAPI 한 번 더 시도 후, 실패해도 200 []
    try {
      const fb = await fetchFromNewsAPI({ pageSize: WORLD_PAGE_SIZE });
      return res.json(fb);
    } catch {
      return res.json([]);
    }
  }
}

module.exports = { worldHandler };
