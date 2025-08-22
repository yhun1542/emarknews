/**
 * Emark 뉴스 서비스 - 최종 완성본 (AI 서비스 연동 포함)
 * - 프론트엔드 호환성 문제를 해결하고, 백엔드 버그를 수정했으며, AIService를 연동한 최종 버전입니다.
 */

const axios = require('axios');
const Parser = require('rss-parser');
const logger = require('../utils/logger');
const crypto = require('crypto');
const AIService = require('./aiService'); // AI 서비스 import

// Redis 클라이언트
let redis;
try {
  const { createClient } = require('redis');
  const REDIS_URL = process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  if (REDIS_URL) {
    redis = createClient({ url: REDIS_URL });
    redis.on('error', (e) => logger.error('Redis error:', e));
    redis.connect().catch(() => logger.warn('Redis connection failed, using memory cache'));
  }
} catch (e) {
  logger.warn('Redis not available, using memory cache');
}

// 메모리 캐시 폴백
const memoryCache = new Map();

// -------------------------------
// 공통 유틸
// -------------------------------
const sha1 = (s) => crypto.createHash('sha1').update(s || '').digest('hex');
const domainFromUrl = (u) => { try { return new URL(u).hostname.replace(/^www\./,''); } catch { return ''; } };
const minutesSince = (iso) => { const t = new Date(iso).getTime(); if (!t) return 99999; return Math.max(0, (Date.now() - t) / 60000); };

const FAST = {
  PHASE1_MS: Number(process.env.FAST_PHASE1_DEADLINE_MS || 600),
  PHASE2_MS: Number(process.env.FAST_PHASE2_DEADLINE_MS || 1500),
  FIRST_BATCH: Number(process.env.FAST_FIRST_BATCH_SIZE || 24),
  FULL_MAX: Number(process.env.FAST_FULL_MAX || 100),
  TTL_FAST: Number(process.env.FAST_REDIS_TTL_SEC || 60),
  TTL_FULL: Number(process.env.FULL_REDIS_TTL_SEC || 600),
};

const RANK_TAU_MIN = Number(process.env.RANK_TAU_MIN || 90);
const freshness = (ageMin) => Math.exp(-ageMin / RANK_TAU_MIN);
const deduplicate = (items) => { const seen=new Set(); const out=[]; for(const it of items){ const k=sha1((it.title||'')+(it.url||'')); if(seen.has(k)) continue; seen.add(k); out.push(it);} return out; };
const filterRecent = (items,h=12)=> items.filter(it=>minutesSince(it.publishedAt)<=h*60);

// -------------------------------
// 섹션별 가중치 프로필
// -------------------------------
const DEFAULT_WEIGHTS = {
  buzz:     { f:0.25, v:0.40, e:0.15, s:0.10, d:0.05, l:0.05 },
  world:    { f:0.35, v:0.15, e:0.10, s:0.30, d:0.05, l:0.05 },
  korea:    { f:0.30, v:0.20, e:0.10, s:0.30, d:0.05, l:0.05 },
  kr:       { f:0.30, v:0.20, e:0.10, s:0.30, d:0.05, l:0.05 },
  japan:    { f:0.30, v:0.20, e:0.10, s:0.30, d:0.05, l:0.05 },
  business: { f:0.25, v:0.20, e:0.20, s:0.30, d:0.03, l:0.02 },
  tech:     { f:0.20, v:0.40, e:0.20, s:0.15, d:0.03, l:0.02 },
};
function parseWeight(envVal, fallback) {
  if (!envVal) return fallback;
  try {
    const [f,v,e,s,d,l] = envVal.split(',').map(Number);
    if ([f,v,e,s,d,l].some(x => Number.isNaN(x))) return fallback;
    return { f,v,e,s,d,l };
  } catch { return fallback; }
}
const SECTION_WEIGHTS = {
  buzz:     parseWeight(process.env.WEIGHTS_BUZZ, DEFAULT_WEIGHTS.buzz),
  world:    parseWeight(process.env.WEIGHTS_WORLD, DEFAULT_WEIGHTS.world),
  korea:    parseWeight(process.env.WEIGHTS_KOREA, DEFAULT_WEIGHTS.korea),
  kr:       parseWeight(process.env.WEIGHTS_KOREA, DEFAULT_WEIGHTS.kr),
  japan:    parseWeight(process.env.WEIGHTS_JAPAN, DEFAULT_WEIGHTS.japan),
  business: parseWeight(process.env.WEIGHTS_BUSINESS, DEFAULT_WEIGHTS.business),
  tech:     parseWeight(process.env.WEIGHTS_TECH, DEFAULT_WEIGHTS.tech),
};

// -------------------------------
// 섹션별 소스/키워드/화이트리스트
// -------------------------------
const TW_QUERIES = {
  buzz: [
    '(breaking OR "breaking news" OR 속보 OR 緊急 OR 速報) (video OR live OR stream) -is:retweet lang:en OR lang:ko OR lang:ja',
    '(viral OR meme OR 밈 OR ミーム OR 炎上 OR buzz) -is:retweet lang:en OR lang:ko OR lang:ja',
    '(leak OR "leaked" OR 유출 OR 流出) (policy OR model OR product OR 영상) -is:retweet lang:en OR lang:ko OR lang:ja',
    '(apology OR 사과 OR 炎上) (celebrity OR 인플루언서 OR タレント) -is:retweet lang:en OR lang:ko OR lang:ja'
  ],
  world: [
    '(breaking OR "just in" OR "developing") -is:retweet lang:en',
    '(earthquake OR hurricane OR typhoon OR 지진 OR 地震) -is:retweet lang:en OR lang:ja OR lang:ko'
  ],
  korea: [
    '(속보 OR 긴급 OR 단독) -is:retweet lang:ko',
    '(지진 OR 화재 OR 경찰 OR 검찰 OR 증시) -is:retweet lang:ko'
  ],
  kr: [
    '(속보 OR 긴급 OR 단독) -is:retweet lang:ko',
    '(지진 OR 화재 OR 경찰 OR 검찰 OR 증시) -is:retweet lang:ko'
  ],
  japan: [
    '(速報 OR 緊急 OR 号外) -is:retweet lang:ja',
    '(地震 OR 台風 OR 火災 OR 株価) -is:retweet lang:ja'
  ],
  business: [
    '("earnings" OR "results" OR "guidance") -is:retweet lang:en',
    '("merger" OR "acquisition" OR "M&A") -is:retweet lang:en'
  ],
  tech: [
    '(AI OR LLM OR "model" OR "open-source") -is:retweet lang:en',
    '(chip OR semiconductor OR GPU OR 파운드리) -is:retweet lang:en OR lang:ko OR lang:ja'
  ]
};
const REDDIT_EP = {
  buzz:    [{ path:'/r/all/new', limit:100 }, { path:'/r/all/hot', limit:100 }],
  world:   [{ path:'/r/worldnews/new', limit:100 }],
  korea:   [{ path:'/r/korea/new', limit:100 }],
  kr:      [{ path:'/r/korea/new', limit:100 }],
  japan:   [{ path:'/r/japannews/new', limit:100 }, { path:'/r/japan/new', limit:100 }],
  business:[{ path:'/r/business/new', limit:100 }, { path:'/r/finance/new', limit:100 }],
  tech:    [{ path:'/r/technology/new', limit:100 }, { path:'/r/programming/new', limit:100 }, { path:'/r/MachineLearning/new', limit:100 }]
};
const YT_REGIONS = {
  buzz:    [{ regionCode:'KR', maxResults:30 }, { regionCode:'JP', maxResults:30 }, { regionCode:'US', maxResults:30 }],
  world:   [{ regionCode:'US', maxResults:30 }, { regionCode:'GB', maxResults:30 }],
  korea:   [{ regionCode:'KR', maxResults:30 }],
  kr:      [{ regionCode:'KR', maxResults:30 }],
  japan:   [{ regionCode:'JP', maxResults:30 }],
  business:[{ regionCode:'US', maxResults:30 }],
  tech:    [{ regionCode:'US', maxResults:30 }]
};
const RSS_FEEDS = {
  buzz: [
    { url:'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', name:'BBC Entertainment', lang:'en' },
    { url:'https://www.theverge.com/rss/index.xml',                        name:'The Verge',        lang:'en' },
    { url:'https://www.wired.com/feed/rss',                               name:'Wired',            lang:'en' },
    { url:'https://rss.cnn.com/rss/edition_entertainment.rss',            name:'CNN Entertainment',lang:'en' },
    { url:'https://www.yna.co.kr/rss/entertainment.xml',                  name:'Yonhap Ent',       lang:'ko' },
    { url:'https://www3.nhk.or.jp/rss/news/cat8.xml',                     name:'NHK エンタメ',        lang:'ja' }
  ],
  world: [
    { url:'https://feeds.bbci.co.uk/news/world/rss.xml',                   name:'BBC World',        lang:'en' },
    { url:'https://www.aljazeera.com/xml/rss/all.xml',                     name:'Al Jazeera',       lang:'en' },
    { url:'https://feeds.skynews.com/feeds/rss/world.xml',                 name:'Sky News World',   lang:'en' },
    { url:'https://feeds.theguardian.com/theguardian/world/rss',           name:'The Guardian World', lang:'en' }
  ],
  korea: [
    { url:'http://www.khan.co.kr/rss/rssdata/total_news.xml',              name:'Kyunghyang',       lang:'ko' },
    { url:'https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=01',    name:'SBS Politics',     lang:'ko' },
    { url:'https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=02',    name:'SBS Economy',      lang:'ko' },
    { url:'https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=03',    name:'SBS Society',      lang:'ko' }
  ],
  kr: [
    { url:'http://www.khan.co.kr/rss/rssdata/total_news.xml',              name:'Kyunghyang',       lang:'ko' },
    { url:'https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=01',    name:'SBS Politics',     lang:'ko' },
    { url:'https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=02',    name:'SBS Economy',      lang:'ko' },
    { url:'https://news.sbs.co.kr/news/SectionRssFeed.do?sectionId=03',    name:'SBS Society',      lang:'ko' }
  ],
  japan: [
    { url:'https://www3.nhk.or.jp/rss/news/cat0.xml',                     name:'NHK 総合',            lang:'ja' },
    { url:'https://www.asahi.com/rss/asahi/newsheadlines.rdf',            name:'Asahi',            lang:'ja' },
    { url:'https://mainichi.jp/rss/etc/flash.rss',                        name:'Mainichi Flash',   lang:'ja' }
  ],
  business: [
    { url:'https://www.ft.com/?format=rss',                               name:'Financial Times',  lang:'en' },
    { url:'https://www.wsj.com/xml/rss/3_7014.xml',                       name:'WSJ Business',     lang:'en' },
    { url:'https://www.bloomberg.com/feed/podcast/etf-report.xml',        name:'Bloomberg (ETFs)', lang:'en' },
    { url:'https://www.cnbc.com/id/10001147/device/rss/rss.html',         name:'CNBC Business',    lang:'en' }
  ],
  tech: [
    { url:'https://www.theverge.com/rss/index.xml',                        name:'The Verge',        lang:'en' },
    { url:'https://feeds.arstechnica.com/arstechnica/index',              name:'Ars Technica',     lang:'en' },
    { url:'https://techcrunch.com/feed/',                                 name:'TechCrunch',       lang:'en' },
    { url:'https://www.wired.com/feed/rss',                               name:'Wired',            lang:'en' }
  ],
};
const SOURCE_WEIGHTS = {
  'bbc.co.uk':5,'reuters.com':5,'aljazeera.com':4,'cnn.com':4,
  'yna.co.kr':4,'khan.co.kr':3,'hani.co.kr':3,
  'nhk.or.jp':5,'asahi.com':4,'mainichi.jp':4,
  'theguardian.com':4,'skynews.com':3,'ft.com':5,'wsj.com':5,
  'bloomberg.com':4,'cnbc.com':3,'techcrunch.com':4,'arstechnica.com':4,
  'theverge.com':4,'wired.com':4,'mashable.com':3,'engadget.com':3,
  'reddit.com':2,'youtube.com':2,'twitter.com':1,'tiktok.com':1
};

// -------------------------------
// NewsService
// -------------------------------
class NewsService {
  constructor(opts = {}) {
    this.logger = opts.logger || logger;
    this.API_TIMEOUT = 5000;
    this.aiService = new AIService();
    
    this.newsApiClient = axios.create({ baseURL:'https://newsapi.org/v2/', timeout:this.API_TIMEOUT, headers:{ 'X-Api-Key': process.env.NEWS_API_KEY || '' }});
    this.gnewsApi = axios.create({ baseURL:'https://gnews.io/api/v4/', timeout:this.API_TIMEOUT });
    this.naverClient = axios.create({ baseURL: 'https://openapi.naver.com/v1/search/', timeout: this.API_TIMEOUT, headers: { 'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID || '', 'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET || '' }});
    this.redditApi = axios.create({ baseURL:'https://oauth.reddit.com', timeout:this.API_TIMEOUT, headers:{ Authorization:`Bearer ${process.env.REDDIT_TOKEN||''}`, 'User-Agent':process.env.REDDIT_USER_AGENT||'emark-buzz/1.0' }});
    this.youtubeApi = axios.create({ baseURL:'https://www.googleapis.com/youtube/v3', timeout:this.API_TIMEOUT });
    this.rssParser = new Parser({ timeout: 5000, headers: { 'User-Agent': 'EmarkNews/2.0 (News Aggregator)' }});
  }

  // ====== 공개 API ======
  async getSectionFast(section='buzz'){ return this._getFast(section); }
  async getSectionFull(section='buzz'){ return this._getFull(section); }
  
  // ====== AI 연동 메서드 ======
  async _enrichArticlesWithAI(articles) {
    if (!this.aiService.client) {
      this.logger.warn('AI Service is not initialized. Skipping enrichment.');
      return articles;
    }

    const enrichmentPromises = articles.map(async (article) => {
      try {
        const [summaryResult, translationResult] = await Promise.all([
          this.aiService.summarize(article.title + '\n' + (article.description || ''), { detailed: true }),
          this.aiService.translate(article.title, 'ko')
        ]);
        
        let summaryPoints = [];
        if (summaryResult.success && summaryResult.data.summary) {
            summaryPoints = summaryResult.data.summary.split('\n').map(line => line.replace(/^[•\-*]\s*/, '').trim()).filter(point => point);
        }

        const titleKo = (translationResult.success && translationResult.data.translated) ? translationResult.data.translated : article.title;

        return { ...article, summaryPoints: summaryPoints.length > 0 ? summaryPoints : [article.description], titleKo };
      } catch (error) {
        this.logger.warn(`AI enrichment failed for article ${article.id}:`, error.message);
        return article; 
      }
    });

    return Promise.all(enrichmentPromises);
  }

  // ====== 내부: 빠른 길 ======
  async _getFast(section){
    const key=`${section}_fast`;
    let cached = null;
    if (redis) { try { cached = await redis.get(key); } catch (e) { this.logger.warn('Redis get failed:', e.message); } }
    else { cached = memoryCache.get(key); }
    if (cached) return JSON.parse(cached);

    const rd = REDDIT_EP[section] || [];
    const rs = RSS_FEEDS[section] || [];
    let phase1 = [];
    
    // NewsAPI + GNews + RSS 조합 전략
    if (section === 'kr' || section === 'korea') { 
      phase1 = [ 
        this.fetchFromNaver(section), // 네이버 API
        ...(rs.slice(0,3).map(r=>this.fetchFromRSS(r.url))) // RSS 3개
      ];
    }
    else if (section === 'japan') { 
      phase1 = [ ...(rs.slice(0,3).map(r=>this.fetchFromRSS(r.url))) ]; // 일본: RSS만
    }
    else { 
      phase1 = [ 
        this.fetchFromNewsAPI(section), // NewsAPI
        this.fetchFromGNews(section),   // GNews API
        ...(rs.slice(0,2).map(r=>this.fetchFromRSS(r.url))) // RSS 2개
      ];
    }
    
    const p1 = await Promise.race([ Promise.allSettled(phase1), new Promise(r=>setTimeout(()=>r([]), FAST.PHASE1_MS)) ]);
    const first = (Array.isArray(p1)?p1:[]).filter(x=>x.status==='fulfilled').flatMap(x=>x.value||[]);
    const ranked = this.rankAndSort(section, deduplicate(filterRecent(first,12))).slice(0,FAST.FIRST_BATCH);
    const initial = { success: true, data: ranked, section, total:ranked.length, partial:true, timestamp:new Date().toISOString() };
    
    try {
      if (redis) { await redis.set(key, JSON.stringify(initial), 'EX', FAST.TTL_FAST); } 
      else { memoryCache.set(key, initial); setTimeout(() => memoryCache.delete(key), FAST.TTL_FAST * 1000); }
    } catch (e) { this.logger.warn('Cache save failed:', e.message); }

    (async()=>{
      try {
        const yt = YT_REGIONS[section] || [];
        let phase2 = [];
        
        // Phase2: 추가 RSS + 보조 API
        if (section === 'kr' || section === 'korea') { 
          phase2 = [ ...rs.slice(3).map(r=>this.fetchFromRSS(r.url)) ]; // 추가 RSS
        }
        else if (section === 'japan') { 
          phase2 = [ ...rs.slice(3).map(r=>this.fetchFromRSS(r.url)) ]; // 추가 RSS
        }
        else { 
          phase2 = [ 
            ...rs.slice(2).map(r=>this.fetchFromRSS(r.url)) // 추가 RSS
          ];
        }
        
        const p2 = await Promise.race([ Promise.allSettled(phase2), new Promise(r=>setTimeout(()=>r([]), FAST.PHASE2_MS)) ]);
        const extra = (Array.isArray(p2)?p2:[]).filter(x=>x.status==='fulfilled').flatMap(x=>x.value||[]);
        const merged = deduplicate(filterRecent([...ranked,...extra],12));
        
        const enriched = await this._enrichArticlesWithAI(merged);
        const full = this.rankAndSort(section, enriched).slice(0,FAST.FULL_MAX);
        const payload = { success: true, data: full, section, total:full.length, partial:false, timestamp:new Date().toISOString() };
        
        if (redis) { await redis.set(key, JSON.stringify(payload), 'EX', FAST.TTL_FULL); }
        else { memoryCache.set(key, payload); setTimeout(() => memoryCache.delete(key), FAST.TTL_FULL * 1000); }
      } catch (e) { this.logger.warn('Phase2 with AI failed:', e.message); }
    })();

    return initial;
  }

  // ====== 내부: 완전체 ======
  async _getFull(section){
    const key=`${section}_full`;
    let cached = null;
    if (redis) { try { cached = await redis.get(key); } catch (e) { this.logger.warn('Redis get failed:', e.message); } }
    else { cached = memoryCache.get(key); }
    if (cached) return JSON.parse(cached);

    const rd = REDDIT_EP[section] || [];
    const yt = YT_REGIONS[section] || [];
    const rs = RSS_FEEDS[section] || [];
    const tasks = [ this.fetchFromNewsAPI(section), this.fetchFromGNews(section), ...rd.map(r=>this.fetchFromRedditAPI(r)), ...yt.map(y=>this.fetchFromYouTubeTrending(y)), ...rs.map(r=>this.fetchFromRSS(r.url)) ];
    if (section === 'kr') tasks.push(this.fetchFromNaver(section));

    const settled = await Promise.allSettled(tasks);
    const raw = settled.filter(s=>s.status==='fulfilled').flatMap(s=>s.value||[]);
    const uniqueRaw = deduplicate(filterRecent(raw, 12));
    
    const enriched = await this._enrichArticlesWithAI(uniqueRaw);
    const full = this.rankAndSort(section, enriched).slice(0,FAST.FULL_MAX);
    const payload = { success: true, data: full, section, total:full.length, partial:false, timestamp:new Date().toISOString() };
    
    try {
      if (redis) { await redis.set(key, JSON.stringify(payload), 'EX', FAST.TTL_FULL); }
      else { memoryCache.set(key, payload); setTimeout(() => memoryCache.delete(key), FAST.TTL_FULL * 1000); }
    } catch (e) { this.logger.warn('Cache save failed:', e.message); }
    
    return payload;
  }

  // -----------------------------
  // Fetchers
  // -----------------------------
  async fetchFromNewsAPI(section) {
    if (!process.env.NEWS_API_KEY) return [];
    try {
      const params = { pageSize: 50, sortBy: 'publishedAt' };
      params.language = (section === 'kr' || section === 'korea') ? 'ko' : 'en';

      if (section === 'world') {
        const countries = ['us', 'gb', 'jp', 'au', 'ca'];
        const promises = countries.map(country => this.newsApiClient.get('top-headlines', { params: { ...params, country } }).catch(err => { this.logger.warn(`NewsAPI failed for country ${country}:`, err.message); return { data: { articles: [] }}; }));
        const results = await Promise.all(promises);
        return results.flatMap(r => this.normalizeNewsAPIArticles(r.data.articles || []));
      } else if (['tech', 'business'].includes(section)) {
        params.category = section;
      }
      
      const response = await this.newsApiClient.get('top-headlines', { params });
      return this.normalizeNewsAPIArticles(response.data.articles || []);
    } catch (error) {
      this.logger.error('NewsAPI error:', error.message);
      return [];
    }
  }
  
  async fetchFromGNews(section) { /* ... 기존 내용과 동일 ... */ }
  async fetchFromNaver(section) { /* ... 기존 내용과 동일 ... */ }
  async fetchFromRedditAPI({path='/r/all/new',limit=100}){ /* ... 기존 내용과 동일 ... */ }
  async fetchFromYouTubeTrending({regionCode='US', maxResults=30}){ /* ... 기존 내용과 동일 ... */ }
  async fetchFromRSS(url){ /* ... 기존 내용과 동일 ... */ }

  // -----------------------------
  // 정규화 & 랭킹
  // -----------------------------
  normalizeNewsAPIArticles(articles) { /* ... 기존 내용과 동일 ... */ }
  normalizeGNewsArticles(articles) { /* ... 기존 내용과 동일 ... */ }
  normalizeNaverArticles(articles) { /* ... 기존 내용과 동일 ... */ }
  stripHtml(text) { if (!text) return ''; return text.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim(); }

  normalizeItem(raw){
    const ageMin = minutesSince(raw.publishedAt);
    const domain = raw.domain || domainFromUrl(raw.url);
    return { id: this.generateArticleId(raw.url, raw.source), title: raw.title || '', link: raw.url || '', source: raw.source || 'Unknown', description: raw.description || raw.title || '', publishedAt: raw.publishedAt, domain, reactions: raw.reactions || 0, followers: raw.followers || 0, ageMinutes: ageMin, _srcType: raw._srcType || 'unknown' };
  }

  generateArticleId(url, source) {
    const combined = `${source}_${url}`;
    return Buffer.from(combined).toString('base64').replace(/[/+=]/g, '').substring(0, 16);
  }

  generateTags(item, section) {
    const tags = new Set();
    const title = item.title.toLowerCase();
    if (section === 'buzz') tags.add('Buzz');
    if (item.score > 0.65) tags.add('Hot');
    if (title.includes('속보') || title.includes('긴급') || title.includes('breaking')) tags.add('긴급');
    if (title.includes('중요') || title.includes('important')) tags.add('중요');
    return Array.from(tags).slice(0, 2);
  }

  rankAndSort(section, items) {
    const w = SECTION_WEIGHTS[section] || DEFAULT_WEIGHTS.world;
    return items.map(it => {
      const ageMin = it.ageMinutes || 0;
      const domain = it.domain || '';
      const f_score = freshness(ageMin);
      const v_score = Math.min(1, (it.reactions || 0) / 1000);
      const e_score = Math.min(1, Math.log10((it.reactions || 0) + 1) / 4);
      const s_score = (SOURCE_WEIGHTS[domain] || 1) / 5;
      const score = (w.f * f_score) + (w.v * v_score) + (w.e * e_score) + (w.s * s_score);
      const rating = Math.max(1.0, Math.min(5.0, (score * 4) + 1)).toFixed(1);
      
      return { 
          ...it, 
          score,
          rating,
          titleKo: it.titleKo || it.title, 
          summaryPoints: (it.summaryPoints && it.summaryPoints.length > 0) ? it.summaryPoints : (it.description ? [it.description] : []),
          tags: this.generateTags(it, section)
      };
    }).sort((a, b) => b.score - a.score);
  }

  // ====== 기타 유틸리티 ======
  getStatus() {
    return { initialized: true, sections: Object.keys(DEFAULT_WEIGHTS), cache: redis ? 'redis' : 'memory' };
  }

  getCacheStatus() {
    return {
      type: redis ? 'redis' : 'memory',
      connected: redis ? redis.isOpen : false
    };
  }

  async clearCache() {
    if (redis) {
      try {
        await redis.flushAll();
        this.logger.info('Redis cache cleared.');
      } catch (e) {
        this.logger.warn('Redis clear failed:', e.message);
      }
    } else {
      memoryCache.clear();
      this.logger.info('Memory cache cleared.');
    }
  }
}

module.exports = NewsService;
