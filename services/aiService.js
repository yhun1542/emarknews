const { OpenAI } = require('openai');
const logger = require('../utils/logger');
const CacheService = require('./cacheService');

class AIService {
  constructor() {
    this.client = null;
    this.cache = new CacheService();
    this.queue = [];
    this.processing = false;
    this.concurrency = 3; // Responses API는 더 안정적이므로 동시성 줄임
    
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

  /** -------- 유틸: 지수 백오프 재시도 with Jitter -------- */
  async retryWithBackoff(fn, {
    retries = 4,
    baseDelayMs = 500,
    factor = 2,
    jitterRatio = 0.25,
    onRetry = () => {}
  } = {}) {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err) {
        attempt++;
        const status = err.status ?? err.code ?? "unknown";
        // 429, 5xx만 재시도
        if (attempt > retries || !(status === 429 || (Number(status) >= 500))) {
          throw err;
        }
        const delayBase = baseDelayMs * Math.pow(factor, attempt - 1);
        const jitter = delayBase * jitterRatio * (Math.random() * 2 - 1);
        const delay = Math.max(0, Math.round(delayBase + jitter));
        await onRetry({ attempt, delay, status, err });
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  /** -------- 유틸: AbortController로 타임아웃 제어 -------- */
  withTimeout(signal, timeoutMs) {
    if (!timeoutMs) return { signal };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
    const cleanup = () => clearTimeout(timeout);

    // 외부 signal과 연결(선택)
    if (signal) {
      if (signal.aborted) controller.abort("upstream-abort");
      signal.addEventListener("abort", () => controller.abort("upstream-abort"));
    }
    return { signal: controller.signal, cleanup };
  }

  /** -------- 프롬프트(요약 정책 고정) -------- */
  getSystemMessage() {
    return `
너는 신문 기사를 요약하는 전문 에디터다.
핵심 요약은 카드뉴스용으로 간결하고 직관적으로,
상세요약은 기사 내용을 충분히 풀어내되 이해하기 쉽게 정리한다.
모든 문장은 말줄임표(...)로 끝나면 안 된다.
`;
  }

  buildUserMessage(article, detailed = false) {
    if (detailed) {
      return `
아래 뉴스 기사를 두 가지 형태로 요약해줘.

1) 카드뉴스용 핵심 요약:
- 블릿포인트 3개 (항상 3개 고정)
- 한눈에 핵심이 드러나야 함
- 줄임표 금지, 과도한 축약 금지
- 직관적이고 이해하기 쉬운 단어 사용

2) 상세요약:
- 블릿포인트, 개수 제한 없음 (기사 길이에 맞게 충분히 설명)
- 각 항목은 2~3문장 이상, 배경·전개·의미가 머릿속에 그려지도록 서술
- 말줄임표 금지
- 축약하지 말고 기사의 맥락을 충실히 반영

주의사항:
- 영어면 자연스러운 한국어 번역으로 요약
- 한국어면 한국어로 요약
- 직역 대신 한국 독자가 매끄럽게 이해할 수 있는 표현 사용

[기사 원문]
${article}
`;
    } else {
      return `
다음 뉴스 기사를 3개의 핵심 포인트로 요약해줘:
- 간결하고 명확하게
- 말줄임표(...) 사용 금지
- 영어면 한국어로 번역해서 요약

[기사 원문]
${article}
`;
    }
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

  async queueTask(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
    });
  }

  /** -------- 향상된 Chat Completions API 요약 -------- */
  async summarizeArticleStreaming(article, {
    model = "gpt-4.1-mini",
    timeoutMs = 60_000,
    retries = 4,
    detailed = false
  } = {}) {
    if (!this.client) {
      throw new Error('OpenAI client not initialized');
    }

    const startedAt = Date.now();
    const reqId = `req_${startedAt}_${Math.random().toString(36).slice(2, 8)}`;

    logger.info({ reqId, model, timeoutMs }, "summarize start");

    const { signal, cleanup } = this.withTimeout(undefined, timeoutMs);

    try {
      const response = await this.retryWithBackoff(async () => {
        return await this.client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: this.getSystemMessage() },
            { role: "user", content: this.buildUserMessage(article, detailed) }
          ],
          temperature: 0.3,
          max_tokens: detailed ? 2000 : 1000,
        }, { signal });
      }, {
        retries,
        onRetry: ({ attempt, delay, status, err }) => {
          logger.warn({ reqId, attempt, delay, status, err: String(err) }, "retrying after error");
        }
      });

      const finalText = response.choices[0]?.message?.content?.trim();
      
      if (!finalText) {
        throw new Error('Empty response from OpenAI');
      }

      logger.info({
        reqId,
        elapsedMs: Date.now() - startedAt,
        request_id: response?.id,
        textLength: finalText?.length || 0
      }, "summarize done");

      return finalText;
    } finally {
      cleanup?.();
    }
  }

  // 기존 API 호환성을 위한 래퍼 메서드들
  async summarize(text, options = {}) {
    const cacheKey = `summary:${Buffer.from(text).toString('base64').substring(0, 32)}`;
    
    try {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return { success: true, data: { summary: cached } };
      }

      const summary = await this.queueTask(() => 
        this.summarizeArticleStreaming(text, { detailed: options.detailed || false })
      );

      // 캐시 저장 (1시간)
      await this.cache.set(cacheKey, summary, 3600);

      return {
        success: true,
        data: { summary }
      };
    } catch (error) {
      logger.error('Summarization failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async translate(text, targetLang = 'ko') {
    const cacheKey = `translate:${targetLang}:${Buffer.from(text).toString('base64').substring(0, 32)}`;
    
    try {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return { success: true, data: { translated: cached } };
      }

      if (!this.client) {
        throw new Error('OpenAI client not initialized');
      }

      const response = await this.retryWithBackoff(async () => {
        return await this.client.chat.completions.create({
          model: 'gpt-4.1-mini',
          messages: [
            {
              role: 'system',
              content: `You are a professional translator. Translate the following text to ${targetLang === 'ko' ? 'Korean' : targetLang}. Maintain the original meaning and tone. Do not add explanations.`
            },
            {
              role: 'user',
              content: text
            }
          ],
          temperature: 0.3,
          max_tokens: 2000
        });
      });

      const translated = response.choices[0]?.message?.content?.trim();
      
      if (!translated) {
        throw new Error('Empty translation response');
      }

      // 캐시 저장 (1시간)
      await this.cache.set(cacheKey, translated, 3600);

      return {
        success: true,
        data: { translated }
      };
    } catch (error) {
      logger.error('Translation failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async generateSummaryPoints(text, maxPoints = 5) {
    try {
      const result = await this.summarize(text, { detailed: true });
      if (!result.success) {
        return [];
      }

      // 응답에서 블릿포인트 추출
      const summary = result.data.summary;
      const lines = summary.split('\n').filter(line => line.trim());
      const points = [];

      for (const line of lines) {
        if (line.includes('•') || line.includes('-') || line.includes('*')) {
          const point = line.replace(/^[•\-*]\s*/, '').trim();
          if (point && points.length < maxPoints) {
            points.push(point);
          }
        }
      }

      return points.length > 0 ? points : [summary.substring(0, 200) + '...'];
    } catch (error) {
      logger.error('Summary points generation failed:', error);
      return ['요약 정보를 생성할 수 없습니다.'];
    }
  }

  getStatus() {
    return {
      initialized: !!this.client,
      queueLength: this.queue.length,
      processing: this.processing,
      concurrency: this.concurrency
    };
  }
}

module.exports = AIService;

