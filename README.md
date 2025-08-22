# EmarkNews - AI-Powered Real-time News Aggregator

## 🚀 Features

- **Multi-source News Aggregation**: NewsAPI, GNews, Naver API, RSS feeds, X (Twitter) API
- **AI-powered Translation & Summary**: OpenAI GPT-4 integration for Korean translation and smart summaries
- **Smart Rating System**: Automatic importance scoring based on keywords, recency, and source reliability
- **Tag System**: 중요, 긴급, Buzz, Hot tags only (as specified)
- **Responsive Design**: Optimized for both desktop and mobile
- **Redis Caching**: Fast performance with intelligent caching
- **Section-specific Sources**:
  - World: NewsAPI + GNews (multiple countries) + RSS
  - Korea: Naver API + RSS (no NewsAPI/GNews)
  - Japan: RSS feeds + scraping support
  - Buzz: X API + RSS
  - Tech/Business: NewsAPI + GNews + RSS

## 📋 Prerequisites

- Node.js 18.x or higher
- npm 9.x or higher
- Redis (optional, falls back to memory cache)
- API Keys (see Environment Variables)

## 🔧 Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/emarknews.git
cd emarknews
```

2. Install dependencies:
```bash
npm ci
```

3. Copy `.env.example` to `.env` and configure:
```bash
cp .env.example .env
```

4. Edit `.env` with your API keys:
```env
OPENAI_API_KEY=your_key_here
NEWS_API_KEY=your_key_here
GNEWS_API_KEY=your_key_here
NAVER_CLIENT_ID=your_id_here
NAVER_CLIENT_SECRET=your_secret_here
X_BEARER_TOKEN=your_token_here (optional)
REDIS_URL=redis://localhost:6379 (optional)
```

## 🚀 Deployment

### Local Development
```bash
npm run dev
```
Visit http://localhost:8080

### Production
```bash
npm start
```

### Railway Deployment

1. Push to GitHub:
```bash
git add .
git commit -m "Initial commit"
git push origin main
```

2. In Railway:
   - Create new project from GitHub repo
   - Add Redis service (optional)
   - Configure environment variables
   - Deploy

Railway will automatically:
- Detect Node.js project
- Install dependencies
- Build and start the application
- Set up health checks

## 🔑 API Endpoints

- `GET /health` - Health check
- `GET /api/news/:section` - Get news by section
- `GET /api/article/:section/:id` - Get specific article
- `GET /api/search?q=query` - Search news
- `POST /api/translate` - Translate text
- `POST /api/summarize` - Generate summary
- `GET /api/stats` - Service statistics

## 📁 Project Structure

```
emarknews/
├── server.js                 # Main server file
├── services/
│   ├── newsService.js       # News aggregation logic
│   ├── aiService.js         # OpenAI integration
│   ├── cacheService.js      # Redis/Memory caching
│   └── ratingService.js     # Article rating system
├── utils/
│   └── logger.js            # Winston logger
├── public/
│   ├── index.html          # Main page
│   ├── detail.html         # Article detail page
│   └── logo.svg            # Logo file
├── package.json            # Dependencies
├── railway.toml            # Railway config
├── .env.example            # Environment template
└── README.md               # This file
```

## 🐛 Troubleshooting

### Common Issues

1. **Redis connection failed**
   - The app will automatically fall back to memory cache
   - For production, use Railway's Redis service

2. **API rate limits**
   - Configure rate limiting in environment variables
   - The system includes automatic retry with exponential backoff

3. **Korean text encoding issues**
   - Ensure UTF-8 encoding in all files
   - Check Content-Type headers

4. **Missing news in sections**
   - Verify API keys are configured
   - Check section-specific source configuration

## 📝 Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| PORT | Server port (default: 8080) | No |
| NODE_ENV | Environment (development/production) | No |
| OPENAI_API_KEY | OpenAI API key for AI features | Yes |
| NEWS_API_KEY | NewsAPI.org API key | Yes |
| GNEWS_API_KEY | GNews.io API key | Yes |
| NAVER_CLIENT_ID | Naver API client ID | Yes |
| NAVER_CLIENT_SECRET | Naver API client secret | Yes |
| X_BEARER_TOKEN | X (Twitter) API bearer token | No |
| REDIS_URL | Redis connection URL | No |
| MAX_REQUESTS_PER_MINUTE | Rate limit (default: 100) | No |
| LOG_LEVEL | Logging level (default: info) | No |

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## 📄 License

MIT License - see LICENSE file for details

## 🆘 Support

For issues, please open a GitHub issue or contact the development team.

---

Built with ❤️ by EmarkNews Team