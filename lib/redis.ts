import { Redis } from "@upstash/redis";

/**
 * Cliente Redis (Upstash) para almacenamiento temporal.
 * Las credenciales se leen desde .env.local
 */
export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});
