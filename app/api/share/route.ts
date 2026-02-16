import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { generateCode } from "@/lib/code-generator";

const DEFAULT_TTL_SECONDS = 300; // 5 minutos
const ALLOWED_TTLS = new Set([180, 300, 600, 1800, 3600]); // 3, 5, 10, 30, 60 min
const MAX_TEXT_SIZE = 5_000;
const MAX_LINKS = 10;
const MAX_LINK_SIZE = 2_000;
const PAIRING_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 dias
type RateLimitError = Error & { resetSeconds?: number };

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
    const err = new Error("RATE_LIMIT") as RateLimitError;
    err.resetSeconds = resetSeconds;
    throw err;
  }

  return {
    remaining: Math.max(0, params.limit - count),
    resetSeconds,
  };
}

type ShareRequestBody = {
  links?: unknown;
  text?: unknown;
  ttlSeconds?: unknown;
  senderDeviceId?: unknown;
};

type StoredClipPayload = {
  links: string[];
  text?: string;
  createdAt: number;
  reads: number;
};

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeDeviceId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(normalized)) return "";
  return normalized;
}

/**
 * POST /api/share
 * Body: { links: string[]; text?: string; ttlSeconds: number; senderDeviceId?: string }
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

    const body = (await req.json()) as ShareRequestBody;

    const rawLinks = Array.isArray(body?.links) ? body.links : [];
    const links = rawLinks
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);

    const text = String(body?.text ?? "").trim();
    const ttlCandidate = Number(body?.ttlSeconds ?? DEFAULT_TTL_SECONDS);
    const ttlSeconds = ALLOWED_TTLS.has(ttlCandidate)
      ? ttlCandidate
      : DEFAULT_TTL_SECONDS;
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId);

    if (links.length > MAX_LINKS) {
      return NextResponse.json(
        { error: `Too many links. Max ${MAX_LINKS}` },
        { status: 400 }
      );
    }

    if (!links.length && !text) {
      return NextResponse.json(
        { error: "At least one link or text is required" },
        { status: 400 }
      );
    }

    const hasInvalidLink = links.some(
      (link) => link.length > MAX_LINK_SIZE || !isHttpUrl(link)
    );
    if (hasInvalidLink) {
      return NextResponse.json(
        { error: "Invalid links. Use valid http/https URLs." },
        { status: 400 }
      );
    }

    if (text.length > MAX_TEXT_SIZE) {
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

    const payload: StoredClipPayload = {
      links,
      text,
      createdAt: Date.now(),
      reads: 0,
    };

    // Guardar con TTL
    await redis.set(`clipcode:${code}`, JSON.stringify(payload), {
      ex: ttlSeconds,
    });

    // Si el emisor esta emparejado, publica ultimo item en la bandeja del receptor.
    if (senderDeviceId) {
      const receiverDeviceId = await redis.get<string>(
        `clipcode:pair:sender:${senderDeviceId}`
      );

      if (receiverDeviceId) {
        await redis.set(
          `clipcode:nearby:${receiverDeviceId}`,
          JSON.stringify({
            code,
            links,
            text: text || undefined,
            createdAt: Date.now(),
          }),
          { ex: ttlSeconds }
        );

        // Refresca vigencia del pairing activo.
        await redis.expire(
          `clipcode:pair:sender:${senderDeviceId}`,
          PAIRING_TTL_SECONDS
        );
      }
    }

    return NextResponse.json({
      code,
      expiresIn: ttlSeconds,
    });
  } catch (error: unknown) {
    // ✅ Rate limit error
    if (error instanceof Error && error.message === "RATE_LIMIT") {
      const resetSeconds = Number((error as RateLimitError).resetSeconds ?? 60);

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
