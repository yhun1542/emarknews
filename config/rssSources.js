// RSS 소스 설정 - 안정적이고 신뢰할 수 있는 뉴스 피드들
const rssSources = {
  world: [
    { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
    { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
    { name: 'NPR World', url: 'https://feeds.npr.org/1004/rss.xml' },
    { name: 'The Guardian World', url: 'https://www.theguardian.com/world/rss' },
    { name: 'ABC News International', url: 'https://abcnews.go.com/abcnews/internationalheadlines/rss' },
    // 기존 소스들 (페일오버용)
    { name: 'Reuters World', url: 'https://feeds.reuters.com/reuters/worldNews' },
    { name: 'CNN World', url: 'http://rss.cnn.com/rss/edition_world.rss' }
  ],
  korea: [
    { name: 'Yonhap News', url: 'https://www.yna.co.kr/rss/news.xml' },
    { name: 'Kyunghyang', url: 'http://www.khan.co.kr/rss/rssdata/total_news.xml' },
    { name: 'Hankyung', url: 'https://rss.hankyung.com/news/economy.xml' },
    // 추가 대체 소스
    { name: 'Chosun Ilbo', url: 'https://www.chosun.com/arc/outboundfeeds/rss/?outputType=xml' }
  ],
  japan: [
    { name: 'NHK World', url: 'https://www3.nhk.or.jp/rss/news/cat0.xml' },
    { name: 'Japan Times', url: 'https://www.japantimes.co.jp/feed/' },
    { name: 'Kyodo News', url: 'https://english.kyodonews.net/rss/all.xml' }
  ],
  tech: [
    { name: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
    { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
    { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
    { name: 'Wired', url: 'https://www.wired.com/feed/rss' }
  ],
  business: [
    { name: 'Reuters Business', url: 'https://feeds.reuters.com/reuters/businessNews' },
    { name: 'Bloomberg', url: 'https://feeds.bloomberg.com/markets/news.rss' },
    { name: 'Financial Times', url: 'https://www.ft.com/rss/home' },
    { name: 'Wall Street Journal', url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml' }
  ],
  buzz: [
    { name: 'BBC Trending', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml' },
    { name: 'Buzzfeed News', url: 'https://www.buzzfeednews.com/news.xml' },
    { name: 'Vice News', url: 'https://www.vice.com/en/rss' }
  ]
};

module.exports = { rssSources };

