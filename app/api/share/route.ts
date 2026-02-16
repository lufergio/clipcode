import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { generateNumericCode } from "@/lib/code-generator";

const DEFAULT_TTL_SECONDS = 300; // 5 minutos
const ALLOWED_TTLS = new Set([180, 300, 600, 1800, 3600]); // 3, 5, 10, 30, 60 min
const MAX_TEXT_SIZE = 5_000;
const MAX_LINKS = 10;
const MAX_LINK_SIZE = 2_000;
const PAIRING_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 dias
const MIN_MANUAL_CODE_LENGTH = 3;
const MAX_MANUAL_CODE_LENGTH = 5;
const DEBUG_TRACE = process.env.NODE_ENV !== "production";
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
  senderDeviceLabel?: unknown;
  roomCode?: unknown;
};

type StoredClipPayload = {
  links: string[];
  text?: string;
  createdAt: number;
  reads: number;
};

type SenderPairPayload = {
  receiverDeviceId: string;
  receiverDeviceLabel?: string;
  senderDeviceLabel?: string;
};

type RoomMember = {
  deviceId: string;
  deviceLabel?: string;
  joinedAt?: number;
};

type RoomPayload = {
  hostDeviceId: string;
  hostDeviceLabel?: string;
  createdAt?: number;
  members?: RoomMember[];
};

type NearbyPayload = {
  messageId: string;
  code: string;
  links: string[];
  text?: string;
  senderDeviceLabel?: string;
  createdAt: number;
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

function normalizeDeviceLabel(value: unknown): string {
  return String(value ?? "").trim().slice(0, 40);
}

function normalizeRoomCode(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\D/g, "")
    .slice(0, 6);
}

function normalizeRoomMembers(input: unknown): RoomMember[] {
  if (!Array.isArray(input)) return [];
  const dedupe = new Map<string, RoomMember>();

  for (const item of input) {
    const deviceId = normalizeDeviceId((item as RoomMember | undefined)?.deviceId);
    if (!deviceId) continue;
    const deviceLabel = normalizeDeviceLabel((item as RoomMember | undefined)?.deviceLabel);
    const joinedAt = Number((item as RoomMember | undefined)?.joinedAt);
    dedupe.set(deviceId, {
      deviceId,
      deviceLabel: deviceLabel || undefined,
      joinedAt: Number.isFinite(joinedAt) && joinedAt > 0 ? joinedAt : undefined,
    });
  }

  return [...dedupe.values()];
}

function createMessageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function debugTrace(event: string, details: Record<string, unknown>) {
  if (!DEBUG_TRACE) return;
  console.info("[clipcode][api][share]", event, details);
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
    const senderDeviceLabel = normalizeDeviceLabel(body?.senderDeviceLabel);
    const roomCode = normalizeRoomCode(body?.roomCode);
    debugTrace("request", {
      linksCount: links.length,
      hasText: Boolean(text),
      ttlSeconds,
      senderDeviceId: senderDeviceId || null,
      hasSenderDeviceLabel: Boolean(senderDeviceLabel),
      roomCode: roomCode || null,
    });

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
      const length =
        MIN_MANUAL_CODE_LENGTH +
        Math.floor(Math.random() * (MAX_MANUAL_CODE_LENGTH - MIN_MANUAL_CODE_LENGTH + 1));
      const candidate = generateNumericCode(length);
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
    debugTrace("stored-code", {
      code,
      codeLength: code.length,
      ttlSeconds,
    });

    let nearbyQueued = false;
    let nearbyReason:
      | "queued"
      | "not_paired"
      | "invalid_pair_payload"
      | "no_sender_device"
      | "room_not_found"
      | "room_empty" = "no_sender_device";
    let pairingReceiverFound = false;
    let roomReceiverFound = false;
    let roomMatched = false;
    const nearbyTargetIds = new Set<string>();
    let resolvedSenderLabel = senderDeviceLabel;

    // Si el emisor esta emparejado, publica ultimo item en la bandeja del receptor.
    if (senderDeviceId) {
      const rawSenderPairPayload = await redis.get<string | SenderPairPayload>(
        `clipcode:pair:sender:${senderDeviceId}`
      );
      debugTrace("pair:lookup", {
        senderDeviceId,
        found: Boolean(rawSenderPairPayload),
      });

      let receiverDeviceId = "";
      if (typeof rawSenderPairPayload === "string") {
        try {
          const parsed = JSON.parse(rawSenderPairPayload) as SenderPairPayload;
          receiverDeviceId = normalizeDeviceId(parsed?.receiverDeviceId);
          const payloadSenderLabel = normalizeDeviceLabel(parsed?.senderDeviceLabel);
          if (!resolvedSenderLabel && payloadSenderLabel) {
            resolvedSenderLabel = payloadSenderLabel;
          }
        } catch {
          // Compatibilidad con formato legado (string = receiverDeviceId)
          receiverDeviceId = normalizeDeviceId(rawSenderPairPayload);
        }
      } else {
        receiverDeviceId = normalizeDeviceId(rawSenderPairPayload?.receiverDeviceId);
        const payloadSenderLabel = normalizeDeviceLabel(rawSenderPairPayload?.senderDeviceLabel);
        if (!resolvedSenderLabel && payloadSenderLabel) {
          resolvedSenderLabel = payloadSenderLabel;
        }
      }

      if (receiverDeviceId) {
        nearbyTargetIds.add(receiverDeviceId);
        pairingReceiverFound = true;

        // Refresca vigencia del pairing activo.
        await redis.expire(
          `clipcode:pair:sender:${senderDeviceId}`,
          PAIRING_TTL_SECONDS
        );
        debugTrace("pair:ttl-refreshed", {
          senderDeviceId,
          pairingTtlSeconds: PAIRING_TTL_SECONDS,
        });
      } else {
        nearbyReason = "invalid_pair_payload";
      }
    } else {
      nearbyReason = "no_sender_device";
    }

    if (senderDeviceId && roomCode) {
      const roomKey = `clipcode:room:${roomCode}`;
      const rawRoomPayload = await redis.get<string | RoomPayload>(roomKey);
      roomMatched = Boolean(rawRoomPayload);

      if (rawRoomPayload) {
        let roomPayload: RoomPayload | null = null;
        if (typeof rawRoomPayload === "string") {
          try {
            roomPayload = JSON.parse(rawRoomPayload) as RoomPayload;
          } catch {
            roomPayload = null;
          }
        } else {
          roomPayload = rawRoomPayload;
        }

        const members = normalizeRoomMembers(roomPayload?.members);
        const targetMembers = members.filter((member) => member.deviceId !== senderDeviceId);
        for (const member of targetMembers) {
          nearbyTargetIds.add(member.deviceId);
        }
        roomReceiverFound = targetMembers.length > 0;
      }
    }

    if (nearbyTargetIds.size > 0) {
      for (const receiverDeviceId of nearbyTargetIds) {
        const nearbyPayload: NearbyPayload = {
          messageId: createMessageId(),
          code,
          links,
          text: text || undefined,
          senderDeviceLabel: resolvedSenderLabel || undefined,
          createdAt: Date.now(),
        };
        await redis.set(
          `clipcode:nearby:${receiverDeviceId}`,
          JSON.stringify(nearbyPayload),
          { ex: ttlSeconds }
        );
        debugTrace("nearby:stored", {
          senderDeviceId,
          receiverDeviceId,
          code,
          ttlSeconds,
          messageId: nearbyPayload.messageId,
        });
      }
      nearbyQueued = true;
      nearbyReason = "queued";
    }

    if (senderDeviceId && nearbyReason === "no_sender_device") {
      nearbyReason = "not_paired";
    }

    if (!nearbyQueued && senderDeviceId && roomCode) {
      if (!roomMatched) {
        nearbyReason = "room_not_found";
      } else if (!roomReceiverFound) {
        nearbyReason = "room_empty";
      } else if (!pairingReceiverFound && nearbyReason !== "invalid_pair_payload") {
        nearbyReason = "not_paired";
      }
    }

    if (
      senderDeviceId &&
      !nearbyQueued &&
      !roomCode &&
      nearbyReason !== "invalid_pair_payload"
    ) {
      nearbyReason = "not_paired";
    }

    return NextResponse.json({
      code,
      expiresIn: ttlSeconds,
      nearbyQueued,
      nearbyReason,
      nearbyTargets: nearbyTargetIds.size,
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
