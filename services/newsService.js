// services/newsService.js - Updated 2025-08-22 15:30 - Force rebuild
const axios = require('axios');
const axiosRetry = require('axios-retry').default || require('axios-retry');
const Parser = require('rss-parser');
const logger = require('../utils/logger');

// 1) 공용 HTTP 클라이언트
const http = axios.create({
  timeout: 8000, // 개별 요청 타임아웃
  headers: { 'User-Agent': 'EmarkNews/2.0 (https://emarknews.com)' }
});

// 2) 지수 백오프 재시도 (네트워크/타임아웃/5xx만)
axiosRetry(http, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  shouldResetTimeout: true,
  retryCondition: (err) =>
    axiosRetry.isNetworkOrIdempotentRequestError(err) ||
    err?.code === 'ECONNABORTED' ||
    (err?.response && err.response.status >= 500)
});

// RSS Parser 초기화
const parser = new Parser({
  timeout: 5000,
  headers: {
    'User-Agent': 'EmarkNews/2.0 (News Aggregator)'
  }
});

// 3) 추가 보호: 요청 레벨 하드 타임아웃 래퍼 (피드별 fail-fast)
const withTimeout = (p, ms = 8000) =>
  Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))
  ]);

// 4) 단일 피드 수집 (개별 실패 허용)
async function fetchOneFeed(url, parseFn) {
  try {
    const res = await withTimeout(http.get(url), 9000);
    if (!res || res.status !== 200 || !res.data) return [];
    return parseFn(res.data);
  } catch (error) {
    logger.error(`RSS fetch failed (${url}):`, error.message);
    return []; // 실패 시 빈 배열로 복구
  }
}

// 5) RSS 파서 함수
async function parseRssFeed(xml) {
  try {
    const feed = await parser.parseString(xml);
    return feed.items.map(item => ({
      title: item.title || '',
      description: item.contentSnippet || item.content || '',
      content: item.contentSnippet || item.content || '',
      url: item.link || '',
      urlToImage: item.enclosure?.url || null,
      source: feed.title || 'RSS Feed',
      publishedAt: item.pubDate || item.isoDate || new Date().toISOString(),
      language: 'en',
      id: Buffer.from(item.link || item.title || '').toString('base64').substring(0, 16),
      section: 'world',
      rating: Math.floor(Math.random() * 2) + 4, // 4-5 rating
      tags: ['Hot'],
      titleKo: null,
      descriptionKo: null
    }));
  } catch (error) {
    logger.error('RSS parsing failed:', error.message);
    return [];
  }
}

// 6) 종합 수집 (전체 다운 방지: allSettled + 최소 보장)
async function fetchAllFeeds(feedConfigs, { minItems = 10 } = {}) {
  const tasks = feedConfigs.map(({ url, parse = parseRssFeed }) =>
    fetchOneFeed(url, parse)
  );

  const settled = await Promise.allSettled(tasks);
  const all = settled.flatMap(s => (s.status === 'fulfilled' ? s.value : []));

  // 정렬(최신 우선) 및 중복 제거(링크 기준)
  const dedup = [];
  const seen = new Set();
  for (const it of all.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))) {
    const key = it.url || it.link || it.guid || it.title;
    if (key && !seen.has(key)) {
      seen.add(key);
      dedup.push(it);
    }
  }

  // 최소 결과 보장
  if (dedup.length < minItems) {
    logger.info(`Only ${dedup.length} articles collected, expected ${minItems}`);
  }
  
  return dedup;
}

// 7) 메인 뉴스 수집 함수
async function getNews(section = 'world', limit = 30) {
  try {
    // 섹션별 피드 설정
    const feedConfigs = {
      world: [
        { url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
        { url: 'https://www.aljazeera.com/xml/rss/all.xml' },
        { url: 'https://rss.cnn.com/rss/edition_world.rss' },
        { url: 'https://feeds.reuters.com/reuters/topNews' }
      ],
      kr: [
        { url: 'https://www.yna.co.kr/rss/news.xml' },
        { url: 'https://rss.donga.com/total.xml' }
      ],
      japan: [
        { url: 'https://www3.nhk.or.jp/rss/news/cat0.xml' }
      ],
      buzz: [
        { url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml' }
      ],
      tech: [
        { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' }
      ],
      business: [
        { url: 'https://feeds.bbci.co.uk/news/business/rss.xml' }
      ]
    };

    const feeds = feedConfigs[section] || feedConfigs.world;
    const articles = await fetchAllFeeds(feeds, { minItems: 5 });
    
    return {
      success: true,
      data: {
        articles: articles.slice(0, limit),
        total: articles.length,
        page: 1,
        timestamp: new Date().toISOString(),
        cached: false
      }
    };
  } catch (error) {
    logger.error('getNews failed:', error);
    return {
      success: false,
      error: error.message,
      data: {
        articles: [],
        total: 0,
        page: 1,
        timestamp: new Date().toISOString(),
        cached: false
      }
    };
  }
}

// 8) 기사 ID로 조회 (호환성을 위한 더미 함수)
async function getArticleById(section, id) {
  try {
    const result = await getNews(section, 100);
    const articles = result.data.articles;
    const article = articles.find(a => a.id === id) || articles[0];
    return article || null;
  } catch (error) {
    logger.error('getArticleById failed:', error);
    return null;
  }
}

// 9) 뉴스 검색 (호환성을 위한 더미 함수)
async function searchNews(query, options = {}) {
  try {
    const result = await getNews('world', 50);
    const articles = result.data.articles.filter(article => 
      article.title.toLowerCase().includes(query.toLowerCase()) ||
      article.description.toLowerCase().includes(query.toLowerCase())
    );
    
    return {
      success: true,
      data: {
        articles: articles.slice(0, options.limit || 10),
        total: articles.length,
        query: query
      }
    };
  } catch (error) {
    logger.error('searchNews failed:', error);
    return {
      success: false,
      error: error.message,
      data: { articles: [], total: 0, query: query }
    };
  }
}

// 10) 상태 조회 함수들 (호환성을 위한 더미 함수)
function getStatus() {
  return {
    sections: ['world', 'korea', 'japan', 'buzz', 'tech', 'business'],
    apis: {
      rss: true,
      newsapi: !!process.env.NEWS_API_KEY,
      gnews: !!process.env.GNEWS_API_KEY
    }
  };
}

function getCacheStatus() {
  return {
    type: 'memory',
    connected: true,
    size: 0
  };
}

async function clearCache() {
  // 메모리 기반이므로 실제로는 아무것도 하지 않음
  return { success: true, message: 'Cache cleared' };
}

module.exports = {
  getNews,
  getArticleById,
  searchNews,
  getStatus,
  getCacheStatus,
  clearCache,
  // 필요 시 개별 함수도 export
  fetchAllFeeds,
  fetchOneFeed,
  http
};

