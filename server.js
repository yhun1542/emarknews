// server.js - EmarkNews Main Server
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const morgan = require('morgan');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');
const NewsService = require('./services/newsService');
const AIService = require('./services/aiService');

const app = express();
const PORT = process.env.PORT || 8080;

// 1) 프록시 신뢰 (Railway/Nginx 등 1-hop 프록시 환경)
//   - 반드시 rate-limit, logger 등 어떤 미들웨어보다 먼저 실행
app.set('trust proxy', true); // Railway 프록시 환경에서 X-Forwarded-For 헤더 신뢰

// Initialize services
const newsService = new NewsService();
const aiService = new AIService();

// 2) rate-limit: 표준 헤더만 사용하고, proxy 신뢰 기반 IP 추출
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_WINDOW_MS ?? 60_000),
  limit: Number(process.env.RATE_LIMIT ?? 120),
  standardHeaders: true,    // RFC 표준 헤더
  legacyHeaders: false,     // 레거시 헤더 비활성
  keyGenerator: (req) => req.ip, // trust proxy 설정 시 client IP 정확히 인식
  message: 'Too many requests, please try again later.'
  // validate 옵션 제거 - trust proxy true로 설정했으므로 기본 동작 사용
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https:"],
      imgSrc: ["'self'", "data:", "https:"],
      fontSrc: ["'self'", "https:", "data:"],
      connectSrc: ["'self'"]
    }
  }
}));

// Performance middleware
app.use(compression());
app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) }}));

// Basic middleware
app.use(cors());
app.use(express.json());

// (2) /api 에서는 304가 나오지 않도록 강제 no-store + 변동 ETag
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  // Express는 ETag가 이미 있으면 새로 계산하지 않음 → 304 방지
  res.set('ETag', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  next();
});

app.use('/api/', limiter);

// Static files with proper caching
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1y',
  immutable: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
    // Add versioning for CSS/JS files
    if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    services: {
      server: 'running',
      redis: newsService.getCacheStatus(),
      ai: aiService.getStatus()
    }
  });
});

// Main news endpoint

// New NewsService API Routes (빠른 로딩)
app.get('/api/:section/fast', async (req, res) => {
  try {
    const { section } = req.params;
    const validSections = ['world', 'kr', 'korea', 'japan', 'buzz', 'tech', 'business'];
    
    if (!validSections.includes(section)) {
      return res.status(400).json({
        success: false,
        error: `Invalid section. Must be one of: ${validSections.join(', ')}`
      });
    }

    const result = await newsService.getSectionFast(section);
    res.json(result);
  } catch (error) {
    logger.error(`API Error - /api/${req.params.section}/fast:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch news',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// New NewsService API Routes (완전체)
app.get('/api/:section', async (req, res) => {
  try {
    const { section } = req.params;
    const validSections = ['world', 'kr', 'korea', 'japan', 'buzz', 'tech', 'business'];
    
    if (!validSections.includes(section)) {
      return res.status(400).json({
        success: false,
        error: `Invalid section. Must be one of: ${validSections.join(', ')}`
      });
    }

    const result = await newsService.getSectionFull(section);
    res.json(result);
  } catch (error) {
    logger.error(`API Error - /api/${req.params.section}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch news',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// 4) 다운 방지용 fail-open 월드뉴스 라우트 (기존 호환성)
const { worldHandler } = require('./services/news/worldSafe');
app.get('/api/news/world', worldHandler); // 기존 동일 경로가 있어도 이 라인이 먼저면 우선 적용됨

// API Routes
app.get('/api/news/:section', async (req, res) => {
  try {
    const { section } = req.params;
    const { page = 1, limit = 30, useCache = 'true' } = req.query;
    
    const validSections = ['world', 'kr', 'japan', 'buzz', 'tech', 'business'];
    if (!validSections.includes(section)) {
      return res.status(400).json({
        success: false,
        error: `Invalid section. Must be one of: ${validSections.join(', ')}`
      });
    }

    const result = await newsService.getNews(
      section,
      useCache === 'true',
      parseInt(page),
      parseInt(limit)
    );

    res.json(result);
  } catch (error) {
    logger.error(`API Error - /api/news/${req.params.section}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch news',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get specific article
app.get('/api/article/:section/:id', async (req, res) => {
  try {
    const { section, id } = req.params;
    const article = await newsService.getArticleById(section, id);
    
    if (!article) {
      return res.status(404).json({
        success: false,
        error: 'Article not found'
      });
    }
    
    res.json({
      success: true,
      data: article
    });
  } catch (error) {
    logger.error(`API Error - /api/article/${req.params.section}/${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch article'
    });
  }
});

// Search endpoint
app.get('/api/search', async (req, res) => {
  try {
    const { q, section, limit = 20 } = req.query;
    
    if (!q || q.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Search query is required'
      });
    }
    
    const results = await newsService.searchNews(
      q.trim(),
      section,
      parseInt(limit)
    );
    
    res.json({
      success: true,
      query: q,
      count: results.length,
      data: results
    });
  } catch (error) {
    logger.error('API Error - /api/search:', error);
    res.status(500).json({
      success: false,
      error: 'Search failed'
    });
  }
});

// AI Translation endpoint
app.post('/api/translate', async (req, res) => {
  try {
    const { text, targetLang = 'ko' } = req.body;
    
    if (!text || text.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Text is required'
      });
    }
    
    const result = await aiService.translate(text, targetLang);
    const translated = result.success ? result.data.translated : 'Translation failed';
    
    res.json({
      success: true,
      data: {
        original: text,
        translated: translated,
        targetLanguage: targetLang
      }
    });
  } catch (error) {
    logger.error('API Error - /api/translate:', error);
    res.status(500).json({
      success: false,
      error: 'Translation failed'
    });
  }
});

// AI Summary endpoint
app.post('/api/summarize', async (req, res) => {
  try {
    const { text, maxPoints = 5, detailed = false } = req.body;
    
    if (!text || text.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Text is required'
      });
    }
    
    const result = await aiService.summarize(text, { detailed });
    const summary = result.success ? result.data.summary : 'Failed to generate summary';
    
    res.json({
      success: true,
      data: {
        summary: summary,
        points: Array.isArray(summary) ? summary.length : 1,
        detailed: detailed
      }
    });
  } catch (error) {
    logger.error('API Error - /api/summarize:', error);
    res.status(500).json({
      success: false,
      error: 'Summarization failed'
    });
  }
});

// Service statistics
app.get('/api/stats', (req, res) => {
  res.json({
    success: true,
    data: {
      uptime: Math.floor(process.uptime()),
      memory: {
        used: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.floor(process.memoryUsage().heapTotal / 1024 / 1024)
      },
      timestamp: new Date().toISOString(),
      services: {
        news: newsService.getStatus(),
        ai: aiService.getStatus(),
        cache: newsService.getCacheStatus()
      }
    }
  });
});

// Clear cache endpoint (admin only - add auth in production)
app.post('/api/cache/clear', async (req, res) => {
  try {
    await newsService.clearCache();
    res.json({
      success: true,
      message: 'Cache cleared successfully'
    });
  } catch (error) {
    logger.error('API Error - /api/cache/clear:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear cache'
    });
  }
});

// Serve HTML files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/detail.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'detail.html'));
});

// SPA를 위한 catch-all 라우트: 위에서 일치하는 라우트가 없을 경우
// 모든 GET 요청에 대해 index.html을 서빙합니다.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});



// Start server
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`EmarkNews server running on port ${PORT}`, { service: 'emarknews' });
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`, { service: 'emarknews' });
  logger.info(`Health check: http://localhost:${PORT}/health`, { service: 'emarknews' });
});

