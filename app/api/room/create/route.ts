import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { generateNumericCode } from "@/lib/code-generator";

const ROOM_TTL_SECONDS = 60 * 60 * 2; // 2 horas

type RoomCreateBody = {
  hostDeviceId?: unknown;
  hostDeviceLabel?: unknown;
};

type RoomMember = {
  deviceId: string;
  deviceLabel?: string;
  joinedAt: number;
};

type RoomPayload = {
  hostDeviceId: string;
  hostDeviceLabel?: string;
  createdAt: number;
  members: RoomMember[];
};

function normalizeDeviceId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(normalized)) return "";
  return normalized;
}

function normalizeDeviceLabel(value: unknown): string {
  return String(value ?? "").trim().slice(0, 40);
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as RoomCreateBody;
    const hostDeviceId = normalizeDeviceId(body.hostDeviceId);
    const hostDeviceLabel = normalizeDeviceLabel(body.hostDeviceLabel);

    if (!hostDeviceId) {
      return NextResponse.json({ error: "Invalid hostDeviceId" }, { status: 400 });
    }

    let roomCode = "";
    for (let i = 0; i < 10; i++) {
      const candidate = generateNumericCode(6);
      const exists = await redis.exists(`clipcode:room:${candidate}`);
      if (!exists) {
        roomCode = candidate;
        break;
      }
    }

    if (!roomCode) {
      return NextResponse.json({ error: "Could not create room" }, { status: 500 });
    }

    const payload: RoomPayload = {
      hostDeviceId,
      hostDeviceLabel: hostDeviceLabel || undefined,
      createdAt: Date.now(),
      members: [
        {
          deviceId: hostDeviceId,
          deviceLabel: hostDeviceLabel || undefined,
          joinedAt: Date.now(),
        },
      ],
    };

    await redis.set(`clipcode:room:${roomCode}`, JSON.stringify(payload), {
      ex: ROOM_TTL_SECONDS,
    });

    return NextResponse.json({
      roomCode,
      expiresIn: ROOM_TTL_SECONDS,
      memberCount: payload.members.length,
    });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
