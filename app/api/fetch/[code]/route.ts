import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

type StoredPayload =
  | { text: string; createdAt?: number; reads?: number }
  | string
  | null;

/**
 * Rate limit PRO (serverless-safe) usando Redis.
 * Ventana fija: cuenta requests por key (ej IP) en windowSeconds.
 */
async function rateLimitOrThrow(params: {
  prefix: string;        // Ej: "fetch"
  key: string;           // Ej: ip
  limit: number;         // Ej: 60
  windowSeconds: number; // Ej: 60
}): Promise<{ remaining: number; resetSeconds: number }> {
  const redisKey = `rl:${params.prefix}:${params.key}`;

  const count = await redis.incr(redisKey);

  if (count === 1) {
    await redis.expire(redisKey, params.windowSeconds);
  }

  const ttl = await redis.ttl(redisKey);
  const resetSeconds = ttl > 0 ? ttl : params.windowSeconds;

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

/**
 * GET /api/fetch/:code
 * - Recupera el texto asociado al código.
 * - Por defecto, se destruye al leer (1 sola lectura).
 */
export async function GET(
  req: Request,
  context: { params: Promise<{ code: string }> }
) {
  try {
    // ✅ Rate limit PRO por IP (anti fuerza bruta)
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip")?.trim() ||
      "anonymous";

    // Recomendación: 60 req/min por IP
    // (suficiente para uso normal, frena brute-force)
    await rateLimitOrThrow({
      prefix: "fetch",
      key: ip,
      limit: 60,
      windowSeconds: 60,
    });

    const { code: rawCode } = await context.params;

    const code = String(rawCode ?? "").trim().toUpperCase();
    if (!code || code.length > 12) {
      return NextResponse.json({ error: "Invalid code" }, { status: 400 });
    }

    const key = `clipcode:${code}`;
    const raw = await redis.get<StoredPayload>(key);

    if (!raw) {
      return NextResponse.json(
        { error: "Code not found or expired" },
        { status: 404 }
      );
    }

    // ✅ Normalizar payload (puede venir como string JSON o como objeto)
    let payload: { text?: string } = {};
    if (typeof raw === "string") {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { text: raw }; // fallback: tratar string como texto directo
      }
    } else {
      payload = raw as any;
    }

    if (!payload?.text) {
      return NextResponse.json(
        { error: "Code not found or expired" },
        { status: 404 }
      );
    }

    // ✅ Auto-destruir (1 lectura)
    await redis.del(key);

    return NextResponse.json({
      code,
      text: payload.text,
      consumed: true,
    });
  } catch (error: any) {
    // ✅ Rate limit error
    if (error?.message === "RATE_LIMIT") {
      const resetSeconds = Number(error?.resetSeconds ?? 60);

      return NextResponse.json(
        {
          error: "Too many requests",
          retryAfterSeconds: resetSeconds,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(resetSeconds),
          },
        }
      );
    }

    console.error("❌ /api/fetch error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
