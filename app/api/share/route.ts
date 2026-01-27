import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { generateCode } from "@/lib/code-generator";

const TTL_SECONDS = 300; // 5 minutos
const MAX_SIZE = 5_000; // 5 KB aprox

/**
 * Rate limit PRO (serverless-safe) usando Redis.
 * Ventana fija: cuenta requests por IP en windowSeconds.
 */
async function rateLimitOrThrow(params: {
  prefix: string;        // "share"
  key: string;           // ip
  limit: number;         // 20
  windowSeconds: number; // 60
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
 * POST /api/share
 * Body: { text: string }
 */
export async function POST(req: Request) {
  try {
    // ✅ IP real (Vercel / proxies)
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip")?.trim() ||
      "anonymous";

    // ✅ Rate limit PRO: 20 req/min por IP
    await rateLimitOrThrow({
      prefix: "share",
      key: ip,
      limit: 20,
      windowSeconds: 60,
    });

    const body = await req.json();
    const text = String(body?.text ?? "").trim();

    if (!text) {
      return NextResponse.json({ error: "Text is required" }, { status: 400 });
    }

    if (text.length > MAX_SIZE) {
      return NextResponse.json({ error: "Text too large" }, { status: 413 });
    }

    // Intentamos generar un código único (máx 5 intentos)
    let code = "";
    for (let i = 0; i < 5; i++) {
      const candidate = generateCode(4);
      const exists = await redis.exists(`clipcode:${candidate}`);
      if (!exists) {
        code = candidate;
        break;
      }
    }

    if (!code) {
      return NextResponse.json(
        { error: "Could not generate unique code" },
        { status: 500 }
      );
    }

    const payload = {
      text,
      createdAt: Date.now(),
      reads: 0,
    };

    // Guardar con TTL
    await redis.set(`clipcode:${code}`, JSON.stringify(payload), {
      ex: TTL_SECONDS,
    });

    return NextResponse.json({
      code,
      expiresIn: TTL_SECONDS,
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

    console.error("❌ /api/share error:", error);

    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
