import { executeResult } from "../../db/pool.js";
import { vnCloudService } from "../vncloud/vncloud.service.js";
import { normalizeInstanceStatus } from "./vps-status.js";

type ProviderVpsInfo = Record<string, unknown> & {
  id?: number | string | null;
  vps_id?: number | string | null;
  ip?: string | null;
  username?: string | null;
  password?: string | null;
  "vps-status"?: string | null;
  status?: string | null;
  power_status?: string | null;
  "power-status"?: string | null;
  state?: string | null;
  state_text?: string | null;
  "state-text"?: string | null;
  status_text?: string | null;
  "status-text"?: string | null;
  next_due_date?: string | null;
  next_due_date_vps?: string | null;
  "auto-renew"?: number | string | null;
};

export const DEFAULT_INSTANCE_SYNC_DELAYS_MS = [2000, 6500, 15000, 30000, 60000] as const;
export const LONG_REBUILD_SYNC_DELAYS_MS = [
  2000,
  6500,
  15000,
  30000,
  60000,
  120000,
  180000,
  300000,
] as const;
const RECENT_SYNC_WINDOW_MS = 15000;
const lastScheduledAtByInstance = new Map<number, number>();

function pickProviderString(
  payload: ProviderVpsInfo,
  keys: string[],
) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function extractProviderPayloads(
  detail: Awaited<ReturnType<typeof vnCloudService.getVpsInfo>>,
) {
  const rawData = detail.data;

  if (Array.isArray(rawData)) {
    return rawData.filter((item): item is ProviderVpsInfo => Boolean(item && typeof item === "object"));
  }

  if (rawData && typeof rawData === "object") {
    return [rawData as ProviderVpsInfo];
  }

  return [];
}

function resolvePayloadVpsId(payload: ProviderVpsInfo) {
  const candidates = [
    payload["vps-id"],
    payload.vps_id,
    payload.id,
  ];

  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isInteger(value) && value > 0) {
      return value;
    }
  }

  return 0;
}

async function updateInstanceFromPayload(
  instanceId: number,
  payload: ProviderVpsInfo,
) {
  const nextDueDate =
    typeof payload.next_due_date_vps === "string" && payload.next_due_date_vps.trim()
      ? payload.next_due_date_vps
      : typeof payload.next_due_date === "string" && payload.next_due_date.trim()
        ? payload.next_due_date
        : null;

  const providerStatus = normalizeInstanceStatus(
    pickProviderString(payload, [
      "vps-status",
      "status",
      "power_status",
      "power-status",
      "state",
      "state_text",
      "state-text",
      "status_text",
      "status-text",
    ]),
  );
  const autoRenewValue = Number(payload["auto-renew"] ?? 0);

  await executeResult(
    `UPDATE vps_instances
     SET ip_address = ?,
         username = ?,
         password = ?,
         status = COALESCE(?, status),
         next_due_date = ?,
         auto_renew = ?,
         raw_payload = ?
     WHERE id = ?`,
    [
      payload.ip ? String(payload.ip) : null,
      payload.username ? String(payload.username) : null,
      payload.password ? String(payload.password) : null,
      providerStatus,
      nextDueDate,
      Number.isNaN(autoRenewValue) ? 0 : autoRenewValue,
      JSON.stringify(payload),
      instanceId,
    ],
  );
}

export async function syncInstancesFromProvider(
  instances: Array<{ id: number; vncloud_vps_id: number }>,
) {
  const validInstances = instances.filter(
    (instance) => Number(instance.id) > 0 && Number(instance.vncloud_vps_id) > 0,
  );

  if (validInstances.length === 0) {
    return;
  }

  const detail = await vnCloudService.getVpsInfo(
    validInstances.map((instance) => Number(instance.vncloud_vps_id)),
  );
  const payloads = extractProviderPayloads(detail);

  if (payloads.length === 0) {
    return;
  }

  const payloadByVpsId = new Map<number, ProviderVpsInfo>();

  for (const payload of payloads) {
    const vpsId = resolvePayloadVpsId(payload);
    if (vpsId > 0) {
      payloadByVpsId.set(vpsId, payload);
    }
  }

  await Promise.all(
    validInstances.map(async (instance) => {
      const payload = payloadByVpsId.get(Number(instance.vncloud_vps_id));
      if (!payload) {
        return;
      }

      await updateInstanceFromPayload(Number(instance.id), payload);
    }),
  );
}

export async function syncInstanceFromProvider(
  instanceId: number,
  vncloudVpsId: number,
) {
  await syncInstancesFromProvider([{ id: instanceId, vncloud_vps_id: vncloudVpsId }]);
}

export function scheduleInstanceSync(
  instanceId: number,
  vncloudVpsId: number,
  delays: readonly number[] = DEFAULT_INSTANCE_SYNC_DELAYS_MS,
) {
  const now = Date.now();
  const lastScheduledAt = lastScheduledAtByInstance.get(instanceId) ?? 0;

  if (now - lastScheduledAt < RECENT_SYNC_WINDOW_MS) {
    return;
  }

  lastScheduledAtByInstance.set(instanceId, now);

  for (const delay of delays) {
    const timer = setTimeout(() => {
      void syncInstanceFromProvider(instanceId, vncloudVpsId).catch((error) => {
        console.warn(
          `Không thể đồng bộ lại VPS ${vncloudVpsId} sau thao tác.`,
          error instanceof Error ? error.message : error,
        );
      });
    }, delay);

    timer.unref?.();
  }
}
