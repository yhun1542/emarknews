// services/aiService.js - AI Service with OpenAI
const { OpenAI } = require('openai');
const logger = require('../utils/logger');
const CacheService = require('./cacheService');

class AIService {
  constructor() {
    this.client = null;
    this.cache = new CacheService();
    this.queue = [];
    this.processing = false;
    this.concurrency = 5;
    
    if (process.env.OPENAI_API_KEY) {
      this.client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    } else {
      logger.warn('OpenAI API key not configured');
    }

    // Start queue processor
    this.startQueueProcessor();
  }

  startQueueProcessor() {
    setInterval(() => {
      if (!this.processing && this.queue.length > 0) {
        this.processQueue();
      }
    }, 1000);
  }

  async processQueue() {
    if (this.queue.length === 0 || this.processing) return;
    
    this.processing = true;
    const batch = this.queue.splice(0, this.concurrency);
    
    try {
      await Promise.all(batch.map(task => this.executeTask(task)));
    } catch (error) {
      logger.error('Queue processing error:', error);
    } finally {
      this.processing = false;
    }
  }

  async executeTask(task) {
    try {
      const result = await task.fn();
      task.resolve(result);
    } catch (error) {
      task.reject(error);
    }
  }

  async translateText(text, targetLang = 'ko') {
    if (!this.client) {
      logger.warn('Translation skipped - OpenAI not configured');
      return text;
    }

    // Check if already in target language
    if (targetLang === 'ko' && this.isKorean(text)) {
      return text;
    }

    // Check cache
    const cacheKey = `translate:${targetLang}:${this.hashText(text)}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        fn: async () => {
          try {
            const completion = await this.client.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [
                {
                  role: 'system',
                  content: `You are a professional news translator. Translate the following text to ${targetLang === 'ko' ? 'Korean' : targetLang}. Maintain the journalistic tone and accuracy. Only return the translated text without any explanation.`
                },
                {
                  role: 'user',
                  content: text.substring(0, 2000) // Limit length
                }
              ],
              max_tokens: 500,
              temperature: 0.3
            });

            const translated = completion.choices[0]?.message?.content?.trim() || text;
            
            // Cache result
            await this.cache.set(cacheKey, translated, 86400); // 24 hours
            
            return translated;
          } catch (error) {
            logger.error('Translation error:', error);
            return text;
          }
        },
        resolve,
        reject
      });
    });
  }

  async generateSummary(text, maxPoints = 5, detailed = false) {
    if (!this.client) {
      logger.warn('Summary generation skipped - OpenAI not configured');
      return ['AI summary service not available'];
    }

    // Check cache
    const cacheKey = `summary:${detailed}:${maxPoints}:${this.hashText(text)}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        fn: async () => {
          try {
            const systemPrompt = detailed ? `
너는 신문 기사를 요약하는 전문 에디터다.
상세요약을 작성한다:
- 블릿포인트 ${maxPoints}개 이상
- 각 항목은 2~3문장으로 충분히 설명
- 배경, 전개, 의미가 머릿속에 그려지도록 서술
- 말줄임표(...) 사용 금지
- 기사의 맥락을 충실히 반영` : `
너는 신문 기사를 요약하는 전문 에디터다.
카드뉴스용 핵심 요약을 작성한다:
- 블릿포인트 정확히 ${maxPoints}개
- 한눈에 핵심이 드러나야 함
- 간결하고 직관적인 표현
- 말줄임표(...) 사용 금지`;

            const completion = await this.client.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [
                {
                  role: 'system',
                  content: systemPrompt
                },
                {
                  role: 'user',
                  content: `다음 뉴스 기사를 요약해줘:\n\n${text.substring(0, 3000)}`
                }
              ],
              max_tokens: detailed ? 800 : 400,
              temperature: 0.3
            });

            const response = completion.choices[0]?.message?.content?.trim() || '';
            
            // Parse bullet points
            const points = response
              .split('\n')
              .filter(line => line.trim().startsWith('•') || line.trim().startsWith('-'))
              .map(line => line.replace(/^[•\-]\s*/, '').trim())
              .filter(point => point.length > 0);

            const result = points.length > 0 ? points : ['요약 생성 실패'];
            
            // Cache result
            await this.cache.set(cacheKey, result, 86400);
            
            return result;
          } catch (error) {
            logger.error('Summary generation error:', error);
            return ['요약 생성 중 오류 발생'];
          }
        },
        resolve,
        reject
      });
    });
  }

  async processArticle(article) {
    const tasks = [];
    
    // Translate if not Korean
    if (!this.isKorean(article.title)) {
      tasks.push(
        this.translateText(article.title, 'ko').then(titleKo => {
          article.titleKo = titleKo;
        })
      );
    }
    
    if (article.description && !this.isKorean(article.description)) {
      tasks.push(
        this.translateText(article.description, 'ko').then(descKo => {
          article.descriptionKo = descKo;
        })
      );
    }
    
    // Generate summary
    const contentForSummary = article.descriptionKo || article.description || article.content || '';
    if (contentForSummary) {
      tasks.push(
        this.generateSummary(contentForSummary, 3, false).then(points => {
          article.summaryPoints = points;
        })
      );
      
      // Generate detailed summary for high-rated articles
      if (article.rating >= 4.0) {
        tasks.push(
          this.generateSummary(contentForSummary, 5, true).then(points => {
            article.fullSummaryPoints = points;
          })
        );
      }
    }
    
    await Promise.all(tasks);
    return article;
  }

  isKorean(text) {
    if (!text) return false;
    const koreanChars = text.match(/[\u3131-\uD79D]/g) || [];
    const totalChars = text.replace(/\s+/g, '').length;
    return totalChars > 0 && (koreanChars.length / totalChars) > 0.3;
  }

  hashText(text) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(text).digest('hex').substring(0, 16);
  }

  getStatus() {
    return {
      configured: !!this.client,
      queueLength: this.queue.length,
      processing: this.processing,
      cacheSize: this.cache.getStatus().size || 0
    };
  }

  async disconnect() {
    this.queue = [];
    await this.cache.disconnect();
  }
}

module.exports = AIService;