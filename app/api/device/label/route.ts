import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

const DEVICE_LABEL_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 dias

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
    const body = (await req.json()) as { deviceId?: string; deviceLabel?: string };
    const deviceId = normalizeDeviceId(body?.deviceId);
    const deviceLabel = normalizeDeviceLabel(body?.deviceLabel);

    if (!deviceId || !deviceLabel) {
      return NextResponse.json({ error: "deviceId and deviceLabel are required" }, { status: 400 });
    }

    // 1. Guardar el nombre actualizado del dispositivo en Redis
    await redis.set(`clipcode:device:label:${deviceId}`, deviceLabel, {
      ex: DEVICE_LABEL_TTL_SECONDS,
    });

    // 2. Si tiene una vinculacion activa, actualizar la etiqueta en su pareja
    const raw = await redis.get<string | Record<string, unknown>>(`clipcode:pair:sender:${deviceId}`);
    if (raw) {
      try {
        const parsed = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : raw;
        const receiverDeviceId = normalizeDeviceId(parsed?.receiverDeviceId);
        if (receiverDeviceId) {
          const receiverPairRaw = await redis.get<string | Record<string, unknown>>(
            `clipcode:pair:sender:${receiverDeviceId}`
          );
          if (receiverPairRaw) {
            const receiverPair =
              typeof receiverPairRaw === "string"
                ? (JSON.parse(receiverPairRaw) as Record<string, unknown>)
                : receiverPairRaw;
            receiverPair.receiverDeviceLabel = deviceLabel;
            await redis.set(
              `clipcode:pair:sender:${receiverDeviceId}`,
              JSON.stringify(receiverPair),
              { ex: DEVICE_LABEL_TTL_SECONDS }
            );
          }
        }
      } catch (err) {
        console.error("Error updating pairing label:", err);
      }
    }

    return NextResponse.json({ success: true, deviceLabel }, { status: 200 });
  } catch (error: unknown) {
    console.error("POST /api/device/label error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
