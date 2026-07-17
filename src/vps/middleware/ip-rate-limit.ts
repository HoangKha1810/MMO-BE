import { NextFunction, Request, Response } from "express";
import { getIpAddress } from "../utils/http.js";

type RateLimitOptions = {
  scope: string;
  windowMs: number;
  maxRequests: number;
  message: string;
  skip?: (request: Request) => boolean;
};

type RateLimitBucket = {
  count: number;
  resetAt: number;
  lastSeenAt: number;
};

const bucketsByScope = new Map<string, Map<string, RateLimitBucket>>();

function getScopeBuckets(scope: string) {
  let buckets = bucketsByScope.get(scope);

  if (!buckets) {
    buckets = new Map<string, RateLimitBucket>();
    bucketsByScope.set(scope, buckets);
  }

  return buckets;
}

function cleanupExpiredBuckets(
  buckets: Map<string, RateLimitBucket>,
  windowMs: number,
  now: number,
) {
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now && now - bucket.lastSeenAt > windowMs) {
      buckets.delete(key);
    }
  }
}

function setRateLimitHeaders(
  response: Response,
  maxRequests: number,
  remaining: number,
  resetAt: number,
) {
  response.setHeader("X-RateLimit-Limit", String(maxRequests));
  response.setHeader("X-RateLimit-Remaining", String(Math.max(0, remaining)));
  response.setHeader("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
}

export function createIpRateLimit(options: RateLimitOptions) {
  const { scope, windowMs, maxRequests, message, skip } = options;
  const buckets = getScopeBuckets(scope);

  return (request: Request, response: Response, next: NextFunction) => {
    if (request.method === "OPTIONS" || skip?.(request)) {
      next();
      return;
    }

    const ipAddress = getIpAddress(request);
    const now = Date.now();

    cleanupExpiredBuckets(buckets, windowMs, now);

    const currentBucket = buckets.get(ipAddress);
    const bucket =
      !currentBucket || currentBucket.resetAt <= now
        ? {
            count: 0,
            resetAt: now + windowMs,
            lastSeenAt: now,
          }
        : currentBucket;

    bucket.lastSeenAt = now;

    if (bucket.count >= maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      setRateLimitHeaders(response, maxRequests, 0, bucket.resetAt);
      response.setHeader("Retry-After", String(retryAfterSeconds));
      response.status(429).json({
        message,
        retry_after_sec: retryAfterSeconds,
      });
      return;
    }

    bucket.count += 1;
    buckets.set(ipAddress, bucket);
    setRateLimitHeaders(response, maxRequests, maxRequests - bucket.count, bucket.resetAt);
    next();
  };
}
