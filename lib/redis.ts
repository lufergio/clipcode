import { Redis } from "@upstash/redis";

/**
 * Cliente Redis (Upstash) para almacenamiento temporal.
 * Las credenciales se leen desde .env.local
 */
const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

function missingRedisEnvError(): Error {
  return new Error(
    "Missing Redis env vars: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN."
  );
}

export const redis: Redis =
  redisUrl && redisToken
    ? new Redis({
        url: redisUrl,
        token: redisToken,
      })
    : new Proxy({} as Redis, {
        get() {
          throw missingRedisEnvError();
        },
      });
