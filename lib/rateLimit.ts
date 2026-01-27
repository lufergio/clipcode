import { redis } from "./redis";

/**
 * Rate limit PRO (serverless-safe) usando Redis.
 * Ventana fija: cuenta requests por key (ej IP) en windowSeconds.
 */
async function rateLimitOrThrow(params: {
  prefix: string;        // Ej: "share"
  key: string;           // Ej: ip
  limit: number;         // Ej: 20
  windowSeconds: number; // Ej: 60
}): Promise<{ remaining: number; resetSeconds: number }> {
  const redisKey = `rl:${params.prefix}:${params.key}`;

  // INCR es atómico => ideal para rate limit
  const count = await redis.incr(redisKey);

  // Si es el primer hit, seteamos TTL
  if (count === 1) {
    await redis.expire(redisKey, params.windowSeconds);
  }

  // TTL restante
  const ttl = await redis.ttl(redisKey);
  const resetSeconds = ttl > 0 ? ttl : params.windowSeconds;

  // Si supera el límite, lanzamos error controlado
  if (count > params.limit) {
    const err = new Error("RATE_LIMIT");
    (err as any).resetSeconds = resetSeconds;
    throw err;
  }

  return {
    remaining: Math.max(0, params.limit - count),
    resetSeconds,
  };
}
