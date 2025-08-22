// services/ratingService.js - Article Rating Service
const logger = require('../utils/logger');

class RatingService {
  constructor() {
    // Keywords for different categories
    this.keywords = {
      urgent: [
        'breaking', 'urgent', 'alert', 'emergency', 'crisis',
        '긴급', '속보', '재난', '위기', '사고'
      ],
      important: [
        'president', 'government', 'election', 'economy', 'policy',
        'war', 'peace', 'summit', 'conference',
        '대통령', '정부', '선거', '경제', '정책', '전쟁', '평화', '정상회담'
      ],
      buzz: [
        'viral', 'trending', 'celebrity', 'entertainment', 'social',
        '바이럴', '트렌드', '연예인', '화제', '인기'
      ],
      hot: [
        'exclusive', 'revealed', 'shocking', 'amazing', 'first',
        '단독', '충격', '놀라운', '최초', '화제'
      ]
    };
  }

  async calculateRating(article) {
    try {
      if (!article || !article.title) {
        return 3.0;
      }

      let score = 3.0; // Base score
      const text = `${article.title} ${article.description || ''}`.toLowerCase();

      // Check for urgent keywords (+2.0)
      if (this.containsKeywords(text, this.keywords.urgent)) {
        score += 2.0;
      }

      // Check for important keywords (+1.0)
      if (this.containsKeywords(text, this.keywords.important)) {
        score += 1.0;
      }

      // Check for buzz/hot keywords (+0.5)
      if (this.containsKeywords(text, [...this.keywords.buzz, ...this.keywords.hot])) {
        score += 0.5;
      }

      // Recency bonus
      const publishedDate = new Date(article.publishedAt);
      const now = new Date();
      const hoursAgo = (now - publishedDate) / (1000 * 60 * 60);

      if (hoursAgo < 1) {
        score += 1.0; // Very recent
      } else if (hoursAgo < 6) {
        score += 0.5; // Recent
      } else if (hoursAgo < 24) {
        score += 0.2; // Today
      }

      // Source reliability bonus
      const reliableSources = [
        'BBC', 'Reuters', 'AP', 'CNN', 'Bloomberg',
        'Financial Times', 'WSJ', 'The Guardian',
        '연합뉴스', 'KBS', 'MBC', 'SBS',
        'NHK', 'Asahi', 'Yomiuri'
      ];

      if (reliableSources.some(source => 
        (article.source || '').toLowerCase().includes(source.toLowerCase())
      )) {
        score += 0.5;
      }

      // Content quality (has description and content)
      if (article.description && article.description.length > 100) {
        score += 0.3;
      }

      // Normalize to 1-5 range
      score = Math.min(5, Math.max(1, score));
      
      // Round to 0.5
      return Math.round(score * 2) / 2;

    } catch (error) {
      logger.error('Rating calculation error:', error);
      return 3.0;
    }
  }

  async generateTags(article, section) {
    try {
      if (!article || !article.title) {
        return [];
      }

      const tags = [];
      const text = `${article.title} ${article.description || ''}`.toLowerCase();

      // Only generate allowed tags: 중요, 긴급, Buzz, Hot
      
      // Check for 긴급 (Urgent)
      if (this.containsKeywords(text, this.keywords.urgent)) {
        tags.push('긴급');
      }

      // Check for 중요 (Important)
      if (this.containsKeywords(text, this.keywords.important)) {
        tags.push('중요');
      }

      // Check for Buzz
      if (this.containsKeywords(text, this.keywords.buzz) || section === 'buzz') {
        tags.push('Buzz');
      }

      // Check for Hot (recent and trending)
      const publishedDate = new Date(article.publishedAt);
      const now = new Date();
      const hoursAgo = (now - publishedDate) / (1000 * 60 * 60);
      
      if (hoursAgo < 2 || this.containsKeywords(text, this.keywords.hot)) {
        tags.push('Hot');
      }

      // Limit to 2 tags max for cleaner display
      return tags.slice(0, 2);

    } catch (error) {
      logger.error('Tag generation error:', error);
      return [];
    }
  }

  containsKeywords(text, keywords) {
    return keywords.some(keyword => text.includes(keyword.toLowerCase()));
  }

  // Calculate importance score for sorting
  getImportanceScore(article) {
    const rating = article.rating || 3.0;
    const tags = article.tags || [];
    
    let importance = rating;
    
    // Tag bonuses
    if (tags.includes('긴급')) importance += 3;
    if (tags.includes('중요')) importance += 2;
    if (tags.includes('Hot')) importance += 1;
    if (tags.includes('Buzz')) importance += 0.5;
    
    // Recency bonus
    const publishedDate = new Date(article.publishedAt);
    const now = new Date();
    const hoursAgo = (now - publishedDate) / (1000 * 60 * 60);
    
    if (hoursAgo < 1) importance += 2;
    else if (hoursAgo < 6) importance += 1;
    else if (hoursAgo < 24) importance += 0.5;
    
    return importance;
  }
}

module.exports = RatingService;