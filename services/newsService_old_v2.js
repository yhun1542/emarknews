/**
 * Emark 뉴스 서비스 (섹션 통합 + 가중치 프로필 포함 완성본)
 * - 섹션: buzz, world, korea, japan, business, tech
 * - 소스: NewsAPI, GNews, Reddit, YouTube(mostPopular), RSS 화이트리스트
 * - 빠른 길: Phase1(600ms) → Phase2(1500ms) 백필(캐시: Redis)
 * - 랭킹: 섹션별 가중치 프로필(신선도/가속도/참여/신뢰/다양성/로케일)
 *
 * 환경변수(.env)
 *   REDIS_URL=redis://localhost:6379
 *   NEWS_API_KEY=...
 *   GNEWS_API_KEY=...
 *   REDDIT_TOKEN=...
 *   REDDIT_USER_AGENT=emark-buzz/1.0
 *   YOUTUBE_API_KEY=...
 *
 *   FAST_PHASE1_DEADLINE_MS=600
 *   FAST_PHASE2_DEADLINE_MS=1500
 *   FAST_FIRST_BATCH_SIZE=24
 *   FAST_FULL_MAX=100
 *   FAST_REDIS_TTL_SEC=60
 *   FULL_REDIS_TTL_SEC=600
 *   RANK_TAU_MIN=90
 *
 *   # (선택) 섹션별 가중치 오버라이드: "f,v,e,s,d,l" 형식으로 지정
 *   WEIGHTS_BUZZ=0.25,0.40,0.15,0.10,0.05,0.05
 *   WEIGHTS_WORLD=0.35,0.15,0.10,0.30,0.05,0.05
 *   WEIGHTS_KOREA=0.30,0.20,0.10,0.30,0.05,0.05
 *   WEIGHTS_JAPAN=0.30,0.20,0.10,0.30,0.05,0.05
 *   WEIGHTS_BUSINESS=0.25,0.20,0.20,0.30,0.03,0.02
 *   WEIGHTS_TECH=0.20,0.40,0.20,0.15,0.03,0.02
 */

const axios = require('axios');
const Parser = require('rss-parser');
const logger = require('../utils/logger');

// Redis 클라이언트 (ioredis 대신 기존 redis 사용)
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
const crypto = require('crypto');
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
// 섹션별 가중치 프로필 (기본값)
// w = { f:신선도, v:가속도, e:참여도, s:신뢰, d:다양성 패널티, l:로케일 }
// -------------------------------
const DEFAULT_WEIGHTS = {
  buzz:     { f:0.25, v:0.40, e:0.15, s:0.10, d:0.05, l:0.05 }, // 속도·바이럴 중심
  world:    { f:0.35, v:0.15, e:0.10, s:0.30, d:0.05, l:0.05 }, // 신뢰·확증 중심
  korea:    { f:0.30, v:0.20, e:0.10, s:0.30, d:0.05, l:0.05 }, // 로컬 신뢰·신선도
  kr:       { f:0.30, v:0.20, e:0.10, s:0.30, d:0.05, l:0.05 }, // korea 별칭
  japan:    { f:0.30, v:0.20, e:0.10, s:0.30, d:0.05, l:0.05 }, // 로컬 신뢰·신선도
  business: { f:0.25, v:0.20, e:0.20, s:0.30, d:0.03, l:0.02 }, // 공시·리포트·신뢰·참여
  tech:     { f:0.20, v:0.40, e:0.20, s:0.15, d:0.03, l:0.02 }, // 릴리즈/이슈 가속
};

// 환경변수 오버라이드 파서
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
  kr:       parseWeight(process.env.WEIGHTS_KOREA, DEFAULT_WEIGHTS.kr), // korea 별칭
  japan:    parseWeight(process.env.WEIGHTS_JAPAN, DEFAULT_WEIGHTS.japan),
  business: parseWeight(process.env.WEIGHTS_BUSINESS, DEFAULT_WEIGHTS.business),
  tech:     parseWeight(process.env.WEIGHTS_TECH, DEFAULT_WEIGHTS.tech),
};

// -------------------------------
// 섹션별 소스/키워드/화이트리스트
// -------------------------------

// 트위터(=X) 쿼리(섹션별)
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

// Reddit 엔드포인트(섹션별)
const REDDIT_EP = {
  buzz:    [{ path:'/r/all/new', limit:100 }, { path:'/r/all/hot', limit:100 }],
  world:   [{ path:'/r/worldnews/new', limit:100 }],
  korea:   [{ path:'/r/korea/new', limit:100 }],
  kr:      [{ path:'/r/korea/new', limit:100 }],
  japan:   [{ path:'/r/japannews/new', limit:100 }, { path:'/r/japan/new', limit:100 }],
  business:[{ path:'/r/business/new', limit:100 }, { path:'/r/finance/new', limit:100 }],
  tech:    [{ path:'/r/technology/new', limit:100 }, { path:'/r/programming/new', limit:100 }, { path:'/r/MachineLearning/new', limit:100 }]
};

// YouTube 지역(섹션별)
const YT_REGIONS = {
  buzz:    [{ regionCode:'KR', maxResults:30 }, { regionCode:'JP', maxResults:30 }, { regionCode:'US', maxResults:30 }],
  world:   [{ regionCode:'US', maxResults:30 }, { regionCode:'GB', maxResults:30 }],
  korea:   [{ regionCode:'KR', maxResults:30 }],
  kr:      [{ regionCode:'KR', maxResults:30 }],
  japan:   [{ regionCode:'JP', maxResults:30 }],
  business:[{ regionCode:'US', maxResults:30 }],
  tech:    [{ regionCode:'US', maxResults:30 }]
};

// RSS 화이트리스트(섹션별)
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

// 도메인 가중(공통): trust 보정용
const SOURCE_WEIGHTS = {
  'bbc.co.uk':5,'reuters.com':5,'aljazeera.com':4,'cnn.com':4,
  'yna.co.kr':4,'khan.co.kr':3,'hani.co.kr':3,
  'nhk.or.jp':5,'asahi.com':4,'mainichi.jp':4,
  'ft.com':5,'wsj.com':5,'bloomberg.com':5,'cnbc.com':4,
  'theverge.com':4,'arstechnica.com':4,'techcrunch.com':4,'wired.com':4,
  'reddit.com':3,'x.com':3,'youtube.com':4
};

// -------------------------------
// NewsService
// -------------------------------
class NewsService {
  constructor(opts = {}) {
    this.logger = opts.logger || logger;
    this.API_TIMEOUT = 5000;
    
    // API clients
    this.newsApiClient = axios.create({ 
      baseURL:'https://newsapi.org/v2/', 
      timeout:this.API_TIMEOUT, 
      headers:{ 'X-Api-Key': process.env.NEWS_API_KEY || '' }
    });
    
    this.gnewsApi = axios.create({ 
      baseURL:'https://gnews.io/api/v4/', 
      timeout:this.API_TIMEOUT
    });
    
    this.naverClient = axios.create({
      baseURL: 'https://openapi.naver.com/v1/search/',
      timeout: this.API_TIMEOUT,
      headers: {
        'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID || '',
        'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET || ''
      }
    });
    
    this.redditApi = axios.create({ 
      baseURL:'https://oauth.reddit.com', 
      timeout:this.API_TIMEOUT, 
      headers:{ 
        Authorization:`Bearer ${process.env.REDDIT_TOKEN||''}`, 
        'User-Agent':process.env.REDDIT_USER_AGENT||'emark-buzz/1.0'
      }
    });
    
    this.youtubeApi = axios.create({ 
      baseURL:'https://www.googleapis.com/youtube/v3', 
      timeout:this.API_TIMEOUT 
    });
    
    this.rssParser = new Parser({
      timeout: 5000,
      headers: {
        'User-Agent': 'EmarkNews/2.0 (News Aggregator)'
      }
    });
  }

  // ====== 공개 API ======
  async getSectionFast(section='buzz'){ return this._getFast(section); }
  async getSectionFull(section='buzz'){ return this._getFull(section); }
  async getBuzzFast(){ return this._getFast('buzz'); }
  async getBuzzFull(){ return this._getFull('buzz'); }

  // 기존 API 호환성
  async getNews(section) {
    return this.getSectionFull(section);
  }

  // ====== 내부: 빠른 길 ======
  async _getFast(section){
    const key=`${section}_fast`;
    
    // 캐시 확인
    let cached = null;
    if (redis) {
      try {
        cached = await redis.get(key);
      } catch (e) {
        this.logger.warn('Redis get failed:', e.message);
      }
    } else {
      cached = memoryCache.get(key);
    }
    
    if (cached) {
      return typeof cached === 'string' ? JSON.parse(cached) : cached;
    }

    const tw = TW_QUERIES[section] || [];
    const rd = REDDIT_EP[section] || [];
    const rs = RSS_FEEDS[section] || [];
    const yt = YT_REGIONS[section] || [];

    // Phase1(600ms): 섹션별 우선순위 적용
    let phase1 = [];
    
    if (section === 'kr') {
      // 한국: 네이버 API 우선, RSS 보조
      phase1 = [
        this.fetchFromNaver(section),
        ...(rs.slice(0,2).map(r=>this.fetchFromRSS(r.url)))
      ];
    } else if (section === 'japan') {
      // 일본: RSS 우선
      phase1 = [
        ...(rs.slice(0,3).map(r=>this.fetchFromRSS(r.url)))
      ];
    } else {
      // 기타 (세계/테크/비즈니스): NewsAPI + Reddit + RSS
      phase1 = [
        this.fetchFromNewsAPI(section),
        ...(rd.slice(0,2).map(r=>this.fetchFromRedditAPI(r))),
        ...(rs.slice(0,2).map(r=>this.fetchFromRSS(r.url)))
      ];
    }
    
    const p1=await Promise.race([
      Promise.allSettled(phase1), 
      new Promise(r=>setTimeout(()=>r([]), FAST.PHASE1_MS))
    ]);
    
    const first=(Array.isArray(p1)?p1:[]).filter(x=>x.status==='fulfilled').flatMap(x=>x.value||[]);
    const ranked=this.rankAndSort(section, deduplicate(filterRecent(first,12))).slice(0,FAST.FIRST_BATCH);
    const initial={
      success: true,
      data: ranked,
      section, 
      total:ranked.length, 
      partial:true, 
      timestamp:new Date().toISOString()
    };
    
    // 캐시 저장
    try {
      if (redis) {
        await redis.set(key, JSON.stringify(initial), 'EX', FAST.TTL_FAST);
      } else {
        memoryCache.set(key, initial);
        setTimeout(() => memoryCache.delete(key), FAST.TTL_FAST * 1000);
      }
    } catch (e) {
      this.logger.warn('Cache save failed:', e.message);
    }

    // Phase2(1500ms): YouTube + 나머지 RSS + 나머지 트위터 쿼리
    (async()=>{
      try {
        let phase2 = [];
        
        if (section === 'kr') {
          // 한국: 나머지 RSS
          phase2 = [
            ...rs.slice(2).map(r=>this.fetchFromRSS(r.url))
          ];
        } else if (section === 'japan') {
          // 일본: 나머지 RSS + 일본 신문사 웹크롤링 (TODO: 구현 필요)
          phase2 = [
            ...rs.slice(3).map(r=>this.fetchFromRSS(r.url))
          ];
        } else {
          // 기타: YouTube + 나머지 RSS + GNews
          phase2 = [
            ...yt.map(y=>this.fetchFromYouTubeTrending(y)),
            ...rs.slice(2).map(r=>this.fetchFromRSS(r.url)),
            this.fetchFromGNews(section)
          ];
        }
        
        const p2=await Promise.race([
          Promise.allSettled(phase2), 
          new Promise(r=>setTimeout(()=>r([]), FAST.PHASE2_MS))
        ]);
        
        const extra=(Array.isArray(p2)?p2:[]).filter(x=>x.status==='fulfilled').flatMap(x=>x.value||[]);
        const merged=deduplicate(filterRecent([...ranked,...extra],12));
        const full=this.rankAndSort(section, merged).slice(0,FAST.FULL_MAX);
        const payload={
          success: true,
          data: full,
          section, 
          total:full.length, 
          partial:false, 
          timestamp:new Date().toISOString()
        };
        
        // 캐시 업데이트
        if (redis) {
          await redis.set(key, JSON.stringify(payload), 'EX', FAST.TTL_FULL);
        } else {
          memoryCache.set(key, payload);
          setTimeout(() => memoryCache.delete(key), FAST.TTL_FULL * 1000);
        }
      } catch (e) {
        this.logger.warn('Phase2 failed:', e.message);
      }
    })();

    return initial;
  }

  // ====== 내부: 완전체 ======
  async _getFull(section){
    const key=`${section}_full`;
    
    // 캐시 확인
    let cached = null;
    if (redis) {
      try {
        cached = await redis.get(key);
      } catch (e) {
        this.logger.warn('Redis get failed:', e.message);
      }
    } else {
      cached = memoryCache.get(key);
    }
    
    if (cached) {
      return typeof cached === 'string' ? JSON.parse(cached) : cached;
    }

    const tw = TW_QUERIES[section] || [];
    const rd = REDDIT_EP[section] || [];
    const yt = YT_REGIONS[section] || [];
    const rs = RSS_FEEDS[section] || [];

    const tasks = [
      ...tw.map(q=>this.fetchFromXRecent({query:q})),
      ...rd.map(r=>this.fetchFromRedditAPI(r)),
      ...yt.map(y=>this.fetchFromYouTubeTrending(y)),
      ...rs.map(r=>this.fetchFromRSS(r.url))
    ];

    const settled = await Promise.allSettled(tasks);
    const raw = settled.filter(s=>s.status==='fulfilled').flatMap(s=>s.value||[]);
    const full = this.rankAndSort(section, deduplicate(filterRecent(raw,12))).slice(0,FAST.FULL_MAX);
    const payload = { 
      success: true,
      data: full,
      section, 
      total:full.length, 
      partial:false, 
      timestamp:new Date().toISOString() 
    };
    
    // 캐시 저장
    try {
      if (redis) {
        await redis.set(key, JSON.stringify(payload), 'EX', FAST.TTL_FULL);
      } else {
        memoryCache.set(key, payload);
        setTimeout(() => memoryCache.delete(key), FAST.TTL_FULL * 1000);
      }
    } catch (e) {
      this.logger.warn('Cache save failed:', e.message);
    }
    
    return payload;
  }

  // -----------------------------
  // Fetchers
  // -----------------------------
  async fetchFromNewsAPI(section) {
    if (!process.env.NEWS_API_KEY) return [];

    try {
      const params = {
        language: section === 'kr' ? 'ko' : 'en',
        pageSize: 50,
        sortBy: 'publishedAt'
      };

      // Section-specific parameters
      if (section === 'world') {
        // Get news from multiple countries, not just US
        const countries = ['gb', 'de', 'fr', 'jp', 'au', 'ca', 'in'];
        const promises = countries.map(country => 
          this.newsApiClient.get('top-headlines', {
            params: { ...params, country }
          }).catch(() => ({ data: { articles: [] }}))
        );
        const results = await Promise.all(promises);
        return results.flatMap(r => this.normalizeNewsAPIArticles(r.data.articles || []));
      } else if (section === 'tech') {
        params.category = 'technology';
      } else if (section === 'business') {
        params.category = 'business';
      }

      const response = await this.newsApiClient.get('top-headlines', { params });
      return this.normalizeNewsAPIArticles(response.data.articles || []);
    } catch (error) {
      this.logger.error('NewsAPI error:', error.message);
      return [];
    }
  }

  async fetchFromRedditAPI({path='/r/all/new',limit=100}){
    if (!process.env.REDDIT_TOKEN) return [];
    
    try{
      const {data}=await this.redditApi.get(`${path}?limit=${Math.min(limit,100)}`);
      return (data?.data?.children||[]).map(p=>{
        const d=p.data||{};
        return this.normalizeItem({
          title:d.title, url:`https://reddit.com${d.permalink}`,
          source:'Reddit', lang:'en',
          publishedAt:new Date((d.created_utc||0)*1000).toISOString(),
          reactions:(d.ups||0)+(d.num_comments||0),
          followers:d.subreddit_subscribers||0,
          domain:'reddit.com', _srcType:'reddit'
        });
      });
    }catch(e){ 
      this.logger.warn('Reddit fail:', e.message); 
      return []; 
    }
  }

  async fetchFromYouTubeTrending({regionCode='US', maxResults=30}){
    if (!process.env.YOUTUBE_API_KEY) return [];
    
    try{
      const params={ part:'snippet,statistics', chart:'mostPopular', regionCode, maxResults:Math.min(maxResults,50), key:process.env.YOUTUBE_API_KEY };
      const {data}=await this.youtubeApi.get('/videos',{params});
      return (data?.items||[]).map(v=>{
        const s=v.snippet||{}, st=v.statistics||{};
        return this.normalizeItem({
          title:s.title, url:`https://youtube.com/watch?v=${v.id}`,
          source:'YouTube', lang:(s.defaultAudioLanguage||s.defaultLanguage||'und').slice(0,2),
          publishedAt:s.publishedAt,
          reactions:(+st.viewCount||0)+(+st.likeCount||0)+(+st.commentCount||0),
          followers:0, domain:'youtube.com', _srcType:'yt'
        });
      });
    }catch(e){ 
      this.logger.warn('YouTube fail:', e.message); 
      return []; 
    }
  }

  async fetchFromGNews(section) {
    if (!process.env.GNEWS_API_KEY) return [];

    try {
      const params = {
        token: process.env.GNEWS_API_KEY,
        max: 50,
        lang: section === 'kr' ? 'ko' : 'en'
      };

      if (section === 'tech') {
        params.topic = 'technology';
      } else if (section === 'business') {
        params.topic = 'business';
      } else if (section === 'world') {
        params.topic = 'world';
      }

      const response = await this.gnewsApi.get('top-headlines', { params });
      return this.normalizeGNewsArticles(response.data.articles || []);
    } catch (error) {
      this.logger.error('GNews error:', error.message);
      return [];
    }
  }

  async fetchFromNaver(section) {
    if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) return [];

    try {
      const queries = ['속보', '긴급', '최신뉴스', '주요뉴스'];
      const promises = queries.map(query =>
        this.naverClient.get('news.json', {
          params: {
            query,
            display: 30,
            sort: 'date'
          }
        }).catch(() => ({ data: { items: [] }}))
      );

      const results = await Promise.all(promises);
      return results.flatMap(r => this.normalizeNaverArticles(r.data.items || []));
    } catch (error) {
      this.logger.error('Naver API error:', error.message);
      return [];
    }
  }

  async fetchFromRSS(url){
    try{
      const feed=await this.rssParser.parseURL(url);
      return (feed.items||[]).map(it=>this.normalizeItem({
        title:it.title||'', url:it.link||'', source:'RSS', lang:'und',
        publishedAt:it.isoDate||it.pubDate||new Date().toISOString(),
        reactions:0, followers:0, domain:domainFromUrl(it.link||''), _srcType:'rss'
      }));
    }catch(e){ 
      this.logger.warn('RSS fail:', url, e.message); 
      return []; 
    }
  }

  // -----------------------------
  // 정규화 & 랭킹
  // -----------------------------
  normalizeNewsAPIArticles(articles) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    return articles
      .filter(article => {
        // 날짜 필터링: 최근 30일 이내의 뉴스만 포함
        if (!article.publishedAt) return false;
        
        const publishedDate = new Date(article.publishedAt);
        if (isNaN(publishedDate.getTime())) return false;
        
        return publishedDate >= thirtyDaysAgo;
      })
      .map(article => this.normalizeItem({
        title: article.title,
        description: article.description,
        url: article.url,
        source: article.source?.name || 'NewsAPI',
        publishedAt: article.publishedAt,
        reactions: 0,
        followers: 0,
        domain: domainFromUrl(article.url),
        _srcType: 'newsapi'
      }));
  }

  normalizeGNewsArticles(articles) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    return articles
      .filter(article => {
        // 날짜 필터링: 최근 30일 이내의 뉴스만 포함
        if (!article.publishedAt) return false;
        
        const publishedDate = new Date(article.publishedAt);
        if (isNaN(publishedDate.getTime())) return false;
        
        return publishedDate >= thirtyDaysAgo;
      })
      .map(article => this.normalizeItem({
        title: article.title,
        description: article.description,
        url: article.url,
        source: article.source?.name || 'GNews',
        publishedAt: article.publishedAt,
        reactions: 0,
        followers: 0,
        domain: domainFromUrl(article.url),
        _srcType: 'gnews'
      }));
  }

  normalizeNaverArticles(articles) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    return articles
      .filter(article => {
        // 날짜 필터링: 최근 30일 이내의 뉴스만 포함
        if (!article.pubDate) return false;
        
        const publishedDate = new Date(article.pubDate);
        if (isNaN(publishedDate.getTime())) return false;
        
        return publishedDate >= thirtyDaysAgo;
      })
      .map(article => this.normalizeItem({
        title: this.stripHtml(article.title),
        description: this.stripHtml(article.description),
        url: article.originallink || article.link,
        source: 'Naver News',
        publishedAt: article.pubDate,
        reactions: 0,
        followers: 0,
        domain: domainFromUrl(article.originallink || article.link),
        _srcType: 'naver'
      }));
  }

  stripHtml(text) {
    if (!text) return '';
    return text.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
  }

  normalizeItem(raw){
    const ageMin = minutesSince(raw.publishedAt);
    const domain = raw.domain || domainFromUrl(raw.url);
    
    return {
      id: this.generateArticleId(raw.url, raw.source),
      title: raw.title || '',
      link: raw.url || '',
      source: raw.source || 'Unknown',
      description: raw.description || raw.title || '',
      publishedAt: raw.publishedAt,
      domain,
      reactions: raw.reactions || 0,
      followers: raw.followers || 0,
      ageMinutes: ageMin,
      _srcType: raw._srcType || 'unknown'
    };
  }

  generateArticleId(url, source) {
    const combined = `${source}_${url}`;
    return Buffer.from(combined).toString('base64').replace(/[/+=]/g, '').substring(0, 16);
  }

  rankAndSort(section, items) {
    const w = SECTION_WEIGHTS[section] || DEFAULT_WEIGHTS.world;
    
    return items.map(it => {
      const ageMin = it.ageMinutes || 0;
      const domain = it.domain || '';
      
      // 신선도 (0~1)
      const f_score = freshness(ageMin);
      
      // 가속도 (최근 활동 기반, 0~1)
      const v_score = Math.min(1, (it.reactions || 0) / 1000);
      
      // 참여도 (반응 수 기반, 0~1)  
      const e_score = Math.min(1, Math.log10((it.reactions || 0) + 1) / 4);
      
      // 신뢰도 (도메인 가중치, 0~1)
      const s_score = (SOURCE_WEIGHTS[domain] || 1) / 5;
      
      // 다양성 패널티 (0~1, 높을수록 패널티)
      const d_score = 0; // 구현 생략
      
      // 로케일 (0~1)
      const l_score = 0.5; // 구현 생략
      
      const score = (w.f * f_score) + (w.v * v_score) + (w.e * e_score) + 
                   (w.s * s_score) - (w.d * d_score) + (w.l * l_score);
      
      return { ...it, score };
    }).sort((a, b) => b.score - a.score);
  }

  // 기존 API 호환성을 위한 메서드들
  getStatus() {
    return {
      initialized: true,
      sections: Object.keys(DEFAULT_WEIGHTS),
      cache: redis ? 'redis' : 'memory'
    };
  }

  getCacheStatus() {
    return {
      type: redis ? 'redis' : 'memory',
      connected: redis ? true : false
    };
  }

  async clearCache() {
    if (redis) {
      try {
        const keys = await redis.keys('*_fast');
        const keys2 = await redis.keys('*_full');
        if (keys.length > 0) await redis.del(...keys);
        if (keys2.length > 0) await redis.del(...keys2);
      } catch (e) {
        this.logger.warn('Redis clear failed:', e.message);
      }
    } else {
      memoryCache.clear();
    }
  }

  // 기존 호환성을 위한 더미 메서드들
  async fetchFromNewsAPI() { return []; }
  async translateText(text, targetLang = 'ko') { return text; }
  async generateSummary(text) { return text; }
}

module.exports = NewsService;

