// services/newsService.js - News Aggregation Service
const axios = require('axios');
const Parser = require('rss-parser');
const logger = require('../utils/logger');
const CacheService = require('./cacheService');
const RatingService = require('./ratingService');

class NewsService {
  constructor() {
    this.parser = new Parser({
      timeout: 5000,
      headers: {
        'User-Agent': 'EmarkNews/2.0 (News Aggregator)'
      }
    });

    this.cache = new CacheService();
    this.ratingService = new RatingService();

    // API clients
    this.setupAPIClients();

    // Section-specific configurations
    this.sectionConfigs = {
      world: {
        sources: {
          api: ['newsapi', 'gnews'],
          rss: [
            { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC World' },
            { url: 'https://www.aljazeera.com/xml/rss/all.xml', name: 'Al Jazeera' },
            { url: 'https://feeds.skynews.com/feeds/rss/world.xml', name: 'Sky News World' },
            { url: 'https://feeds.theguardian.com/theguardian/world/rss', name: 'The Guardian World' }
          ]
        },
        ttl: 600
      },
      kr: {
        sources: {
          api: ['naver'],
          rss: [
            { url: 'https://www.yna.co.kr/rss/news.xml', name: 'Yonhap News' },
            { url: 'https://rss.hankyung.com/news/economy.xml', name: 'Hankyung' },
            { url: 'http://www.khan.co.kr/rss/rssdata/total_news.xml', name: 'Kyunghyang' }
          ]
        },
        ttl: 300
      },
      japan: {
        sources: {
          api: [],
          rss: [
            { url: 'https://www3.nhk.or.jp/rss/news/cat0.xml', name: 'NHK' },
            { url: 'https://assets.wor.jp/rss/rdf/asahi/top.rdf', name: 'Asahi' },
            { url: 'https://mainichi.jp/rss/etc/mainichi-flash.rss', name: 'Mainichi' }
          ],
          scraping: ['nhk', 'asahi'] // For additional content if needed
        },
        ttl: 300
      },
      buzz: {
        sources: {
          api: ['x'], // X (Twitter) API
          rss: [
            { url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', name: 'BBC Entertainment' },
            { url: 'https://www.buzzfeed.com/world.xml', name: 'BuzzFeed' }
          ]
        },
        ttl: 180
      },
      tech: {
        sources: {
          api: ['newsapi', 'gnews'],
          rss: [
            { url: 'https://www.theverge.com/rss/index.xml', name: 'The Verge' },
            { url: 'https://techcrunch.com/feed/', name: 'TechCrunch' },
            { url: 'https://www.wired.com/feed/rss', name: 'Wired' }
          ]
        },
        ttl: 900
      },
      business: {
        sources: {
          api: ['newsapi', 'gnews'],
          rss: [
            { url: 'https://feeds.bloomberg.com/markets/news.rss', name: 'Bloomberg' },
            { url: 'https://feeds.ft.com/rss/companies', name: 'Financial Times' },
            { url: 'https://www.wsj.com/xml/rss/3_7085.xml', name: 'WSJ' }
          ]
        },
        ttl: 900
      }
    };
  }

  setupAPIClients() {
    // NewsAPI client
    this.newsAPIClient = axios.create({
      baseURL: 'https://newsapi.org/v2/',
      timeout: 8000,
      headers: {
        'X-Api-Key': process.env.NEWS_API_KEY || ''
      }
    });

    // GNews client
    this.gnewsClient = axios.create({
      baseURL: 'https://gnews.io/api/v4/',
      timeout: 8000
    });

    // Naver API client
    this.naverClient = axios.create({
      baseURL: 'https://openapi.naver.com/v1/search/',
      timeout: 8000,
      headers: {
        'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID || '',
        'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET || ''
      }
    });

    // X (Twitter) API client
    if (process.env.X_BEARER_TOKEN) {
      this.xClient = axios.create({
        baseURL: 'https://api.twitter.com/2/',
        timeout: 8000,
        headers: {
          'Authorization': `Bearer ${process.env.X_BEARER_TOKEN}`
        }
      });
    }
  }

  async getNews(section = 'world', useCache = true, page = 1, limit = 30) {
    const cacheKey = `news:${section}:${page}:${limit}`;
    
    // Check cache
    if (useCache) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return {
          success: true,
          data: {
            ...cached,
            cached: true
          }
        };
      }
    }

    try {
      const config = this.sectionConfigs[section];
      if (!config) {
        throw new Error(`Invalid section: ${section}`);
      }

      // Fetch from all sources
      const articles = await this.fetchAllSources(section, config);
      
      // Process articles
      const processed = await this.processArticles(articles, section);
      
      // Sort by date and limit
      const sorted = processed
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
        .slice((page - 1) * limit, page * limit);

      const result = {
        articles: sorted,
        total: sorted.length,
        page: page,
        timestamp: new Date().toISOString(),
        cached: false
      };

      // Cache result
      if (useCache && sorted.length > 0) {
        await this.cache.set(cacheKey, result, config.ttl);
      }

      return {
        success: true,
        data: result
      };

    } catch (error) {
      logger.error(`Error fetching news for ${section}:`, error);
      throw error;
    }
  }

  async fetchAllSources(section, config) {
    const promises = [];

    // Fetch from APIs
    if (config.sources.api) {
      for (const api of config.sources.api) {
        promises.push(this.fetchFromAPI(api, section));
      }
    }

    // Fetch from RSS
    if (config.sources.rss) {
      for (const rss of config.sources.rss) {
        promises.push(this.fetchFromRSS(rss));
      }
    }

    // Fetch from scraping (if configured)
    if (config.sources.scraping) {
      for (const site of config.sources.scraping) {
        promises.push(this.fetchFromScraping(site, section));
      }
    }

    const results = await Promise.allSettled(promises);
    const articles = [];

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        articles.push(...result.value);
      } else if (result.status === 'rejected') {
        logger.warn('Source fetch failed:', result.reason);
      }
    }

    // Deduplicate
    return this.deduplicateArticles(articles);
  }

  async fetchFromAPI(api, section) {
    try {
      switch (api) {
        case 'newsapi':
          return await this.fetchFromNewsAPI(section);
        case 'gnews':
          return await this.fetchFromGNews(section);
        case 'naver':
          return await this.fetchFromNaver(section);
        case 'x':
          return await this.fetchFromX(section);
        default:
          return [];
      }
    } catch (error) {
      logger.error(`API fetch failed (${api}):`, error.message);
      return [];
    }
  }

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
          this.newsAPIClient.get('top-headlines', {
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

      const response = await this.newsAPIClient.get('top-headlines', { params });
      return this.normalizeNewsAPIArticles(response.data.articles || []);
    } catch (error) {
      logger.error('NewsAPI error:', error.message);
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

      const response = await this.gnewsClient.get('top-headlines', { params });
      return this.normalizeGNewsArticles(response.data.articles || []);
    } catch (error) {
      logger.error('GNews error:', error.message);
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
      logger.error('Naver API error:', error.message);
      return [];
    }
  }

  async fetchFromX(section) {
    if (!this.xClient) return [];

    try {
      // Search for trending topics/news
      const response = await this.xClient.get('tweets/search/recent', {
        params: {
          query: 'news OR breaking -is:retweet lang:en',
          max_results: 50,
          'tweet.fields': 'created_at,author_id,public_metrics'
        }
      });

      return this.normalizeXPosts(response.data.data || []);
    } catch (error) {
      logger.error('X API error:', error.message);
      return [];
    }
  }

  async fetchFromRSS(source) {
    try {
      const feed = await this.parser.parseURL(source.url);
      return this.normalizeRSSArticles(feed.items || [], source.name);
    } catch (error) {
      logger.error(`RSS fetch failed (${source.name}):`, error.message);
      return [];
    }
  }

  async fetchFromScraping(site, section) {
    // Implement web scraping for Japanese news sites if needed
    // This is a placeholder - actual implementation would use puppeteer or cheerio
    logger.info(`Scraping ${site} for ${section} (not implemented)`);
    return [];
  }

  // Normalization methods
  normalizeNewsAPIArticles(articles) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    return articles
      .map(article => ({
        title: article.title,
        description: article.description,
        content: article.content,
        url: article.url,
        urlToImage: article.urlToImage,
        source: article.source?.name || 'NewsAPI',
        publishedAt: article.publishedAt,
        language: this.detectLanguage(article.title)
      }))
      .filter(article => {
        // 날짜 필터링: 최근 30일 이내의 뉴스만 포함
        if (!article.publishedAt) return false;
        
        const publishedDate = new Date(article.publishedAt);
        if (isNaN(publishedDate.getTime())) return false;
        
        return publishedDate >= thirtyDaysAgo;
      });
  }

  normalizeGNewsArticles(articles) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    return articles
      .map(article => ({
        title: article.title,
        description: article.description,
        content: article.content,
        url: article.url,
        urlToImage: article.image,
        source: article.source?.name || 'GNews',
        publishedAt: article.publishedAt,
        language: this.detectLanguage(article.title)
      }))
      .filter(article => {
        // 날짜 필터링: 최근 30일 이내의 뉴스만 포함
        if (!article.publishedAt) return false;
        
        const publishedDate = new Date(article.publishedAt);
        if (isNaN(publishedDate.getTime())) return false;
        
        return publishedDate >= thirtyDaysAgo;
      });
  }

  normalizeNaverArticles(articles) {
    return articles.map(article => ({
      title: this.stripHtml(article.title),
      description: this.stripHtml(article.description),
      content: this.stripHtml(article.description),
      url: article.originallink || article.link,
      urlToImage: null,
      source: 'Naver News',
      publishedAt: article.pubDate,
      language: 'ko'
    }));
  }

  normalizeXPosts(posts) {
    return posts.map(post => ({
      title: post.text.substring(0, 100),
      description: post.text,
      content: post.text,
      url: `https://twitter.com/i/status/${post.id}`,
      urlToImage: null,
      source: 'X (Twitter)',
      publishedAt: post.created_at,
      language: 'en'
    }));
  }

  normalizeRSSArticles(articles, sourceName) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    return articles
      .map(article => ({
        title: article.title,
        description: article.contentSnippet || article.content || '',
        content: article.content || article.contentSnippet || '',
        url: article.link,
        urlToImage: article.enclosure?.url || null,
        source: sourceName,
        publishedAt: article.pubDate || article.isoDate,
        language: this.detectLanguage(article.title)
      }))
      .filter(article => {
        // 날짜 필터링: 최근 30일 이내의 뉴스만 포함
        if (!article.publishedAt) return false;
        
        const publishedDate = new Date(article.publishedAt);
        if (isNaN(publishedDate.getTime())) return false;
        
        return publishedDate >= thirtyDaysAgo;
      });
  }

  async processArticles(articles, section) {
    const processed = [];

    for (const article of articles) {
      try {
        // Generate ID
        const id = this.generateArticleId(article, section);

        // Calculate rating and tags
        const rating = await this.ratingService.calculateRating(article);
        const tags = await this.ratingService.generateTags(article, section);

        // Filter tags to only include: 중요, 긴급, Buzz, Hot
        const allowedTags = ['중요', '긴급', 'Buzz', 'Hot'];
        const filteredTags = tags.filter(tag => allowedTags.includes(tag));

        processed.push({
          ...article,
          id,
          section,
          rating,
          tags: filteredTags,
          titleKo: article.language === 'ko' ? article.title : null,
          descriptionKo: article.language === 'ko' ? article.description : null
        });
      } catch (error) {
        logger.warn('Article processing failed:', error.message);
      }
    }

    return processed;
  }

  deduplicateArticles(articles) {
    const seen = new Set();
    return articles.filter(article => {
      const key = article.url || article.title;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  generateArticleId(article, section) {
    const str = `${section}_${article.url || article.title}`;
    return Buffer.from(str).toString('base64').substring(0, 16);
  }

  stripHtml(html) {
    if (!html) return '';
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'");
  }

  detectLanguage(text) {
    if (!text) return 'en';
    const korean = /[\u3131-\uD79D]/g;
    const japanese = /[\u3040-\u309F\u30A0-\u30FF]/g;
    
    if (text.match(korean)) return 'ko';
    if (text.match(japanese)) return 'ja';
    return 'en';
  }

  async getArticleById(section, id) {
    const cacheKey = `article:${section}:${id}`;
    const cached = await this.cache.get(cacheKey);
    
    if (cached) {
      return cached;
    }

    // If not in cache, try to fetch from current news
    const news = await this.getNews(section, true);
    if (news.success && news.data.articles) {
      const article = news.data.articles.find(a => a.id === id);
      if (article) {
        await this.cache.set(cacheKey, article, 3600);
        return article;
      }
    }

    return null;
  }

  async searchNews(query, section, limit = 20) {
    const allSections = section ? [section] : Object.keys(this.sectionConfigs);
    const results = [];

    for (const sec of allSections) {
      const news = await this.getNews(sec, true);
      if (news.success && news.data.articles) {
        const filtered = news.data.articles.filter(article => {
          const searchText = `${article.title} ${article.description}`.toLowerCase();
          return searchText.includes(query.toLowerCase());
        });
        results.push(...filtered);
      }
    }

    return results
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, limit);
  }

  async clearCache() {
    await this.cache.clear();
  }

  getCacheStatus() {
    return this.cache.getStatus();
  }

  getStatus() {
    return {
      sections: Object.keys(this.sectionConfigs),
      apis: {
        newsapi: !!process.env.NEWS_API_KEY,
        gnews: !!process.env.GNEWS_API_KEY,
        naver: !!process.env.NAVER_CLIENT_ID,
        x: !!process.env.X_BEARER_TOKEN
      }
    };
  }

  async disconnect() {
    await this.cache.disconnect();
  }
}

module.exports = NewsService;