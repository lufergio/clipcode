import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

const ROOM_TTL_SECONDS = 60 * 60 * 2; // 2 horas

type RoomJoinBody = {
  roomCode?: unknown;
  deviceId?: unknown;
  deviceLabel?: unknown;
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

function normalizeRoomCode(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\D/g, "")
    .slice(0, 6);
}

function normalizeMembers(input: unknown): RoomMember[] {
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
      joinedAt: Number.isFinite(joinedAt) && joinedAt > 0 ? joinedAt : Date.now(),
    });
  }

  return [...dedupe.values()];
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as RoomJoinBody;
    const roomCode = normalizeRoomCode(body.roomCode);
    const deviceId = normalizeDeviceId(body.deviceId);
    const deviceLabel = normalizeDeviceLabel(body.deviceLabel);

    if (!roomCode || !deviceId) {
      return NextResponse.json({ error: "roomCode and deviceId are required" }, { status: 400 });
    }

    const roomKey = `clipcode:room:${roomCode}`;
    const raw = await redis.get<string | RoomPayload>(roomKey);
    if (!raw) {
      return NextResponse.json({ error: "Room not found or expired" }, { status: 404 });
    }

    let payload: RoomPayload | null = null;
    if (typeof raw === "string") {
      try {
        payload = JSON.parse(raw) as RoomPayload;
      } catch {
        payload = null;
      }
    } else {
      payload = raw;
    }

    if (!payload) {
      return NextResponse.json({ error: "Invalid room payload" }, { status: 500 });
    }

    const members = normalizeMembers(payload.members);
    const existing = members.find((entry) => entry.deviceId === deviceId);
    if (existing) {
      existing.deviceLabel = deviceLabel || existing.deviceLabel;
    } else {
      members.push({
        deviceId,
        deviceLabel: deviceLabel || undefined,
        joinedAt: Date.now(),
      });
    }

    const ttl = await redis.ttl(roomKey);
    const expiresIn = ttl > 0 ? ttl : ROOM_TTL_SECONDS;
    const nextPayload: RoomPayload = {
      hostDeviceId: normalizeDeviceId(payload.hostDeviceId) || deviceId,
      hostDeviceLabel: normalizeDeviceLabel(payload.hostDeviceLabel) || undefined,
      createdAt: Number(payload.createdAt) || Date.now(),
      members,
    };

    await redis.set(roomKey, JSON.stringify(nextPayload), {
      ex: expiresIn,
    });

    return NextResponse.json({
      roomCode,
      expiresIn,
      memberCount: members.length,
    });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
