// services/cacheService.js - Cache Service with Redis/Memory fallback
const Redis = require('ioredis');
const logger = require('../utils/logger');

class CacheService {
  constructor() {
    this.redis = null;
    this.memoryCache = new Map();
    this.useMemory = false;
    
    this.initRedis();
  }

  initRedis() {
    try {
      if (process.env.REDIS_URL) {
        this.redis = new Redis(process.env.REDIS_URL, {
          maxRetriesPerRequest: 3,
          retryStrategy: (times) => {
            if (times > 3) {
              logger.warn('Redis connection failed, falling back to memory cache');
              this.useMemory = true;
              return null;
            }
            return Math.min(times * 100, 3000);
          }
        });

        this.redis.on('connect', () => {
          logger.info('Redis connected successfully');
          this.useMemory = false;
        });

        this.redis.on('error', (err) => {
          logger.error('Redis error:', err);
          this.useMemory = true;
        });
      } else {
        logger.info('Redis URL not configured, using memory cache');
        this.useMemory = true;
      }
    } catch (error) {
      logger.error('Redis initialization error:', error);
      this.useMemory = true;
    }
  }

  async get(key) {
    try {
      if (!this.useMemory && this.redis) {
        const value = await this.redis.get(key);
        return value ? JSON.parse(value) : null;
      } else {
        const item = this.memoryCache.get(key);
        if (item) {
          if (item.expiry && item.expiry < Date.now()) {
            this.memoryCache.delete(key);
            return null;
          }
          return item.value;
        }
        return null;
      }
    } catch (error) {
      logger.error('Cache get error:', error);
      return null;
    }
  }

  async set(key, value, ttl = 600) {
    try {
      if (!this.useMemory && this.redis) {
        await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
      } else {
        this.memoryCache.set(key, {
          value,
          expiry: Date.now() + (ttl * 1000)
        });
        
        // Limit memory cache size
        if (this.memoryCache.size > 1000) {
          const firstKey = this.memoryCache.keys().next().value;
          this.memoryCache.delete(firstKey);
        }
      }
      return true;
    } catch (error) {
      logger.error('Cache set error:', error);
      return false;
    }
  }

  async delete(key) {
    try {
      if (!this.useMemory && this.redis) {
        await this.redis.del(key);
      } else {
        this.memoryCache.delete(key);
      }
      return true;
    } catch (error) {
      logger.error('Cache delete error:', error);
      return false;
    }
  }

  async clear() {
    try {
      if (!this.useMemory && this.redis) {
        await this.redis.flushdb();
      } else {
        this.memoryCache.clear();
      }
      logger.info('Cache cleared successfully');
      return true;
    } catch (error) {
      logger.error('Cache clear error:', error);
      return false;
    }
  }

  getStatus() {
    if (!this.useMemory && this.redis) {
      return {
        type: 'redis',
        connected: this.redis.status === 'ready',
        status: this.redis.status
      };
    } else {
      return {
        type: 'memory',
        size: this.memoryCache.size,
        maxSize: 1000
      };
    }
  }

  async disconnect() {
    if (this.redis) {
      await this.redis.quit();
    }
    this.memoryCache.clear();
  }
}

module.exports = CacheService;