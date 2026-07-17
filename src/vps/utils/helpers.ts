import { randomBytes } from "crypto";

export const DEFAULT_SUPPORT_LINK = "https://zalo.me/3482369546728805278";

export const DEFAULT_STORE_SETTINGS = {
  brand_name: "TRUNGTAMMMO.VN",
  hero_title: "Thuê VPS tốc độ cao, quản lý dễ dàng tại TRUNGTAMMMO.VN",
  hero_subtitle:
    "Bảng giá rõ ràng, kích hoạt nhanh, giao diện mượt và khu quản lý máy chủ tập trung cho từng tài khoản.",
  hero_badge: "Hệ thống VPS tự động",
  support_link: DEFAULT_SUPPORT_LINK,
  announcement:
    "Danh mục VPS, giá bán và tình trạng máy chủ đều có thể quản lý tập trung trên một giao diện.",
  theme_default: "dark",
  intro_customer_count: "16890",
  addon_cpu_price: 15000,
  addon_ram_price: 15000,
  addon_disk_price: 5000,
  addon_disk_step: 10,
};

function normalizePositiveInteger(
  value: string | number | null | undefined,
  fallback: number,
) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.round(parsed);
}

export function slugify(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function toArrayPayload<T extends Record<string, unknown>>(input: unknown) {
  if (Array.isArray(input)) {
    return input as T[];
  }

  if (input && typeof input === "object") {
    return Object.values(input as Record<string, unknown>).filter(
      (item): item is T => Boolean(item) && typeof item === "object",
    );
  }

  return [] as T[];
}

export function safeJsonParse<T>(value: string | null | undefined, fallback: T) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function pickText(source: Record<string, unknown>, keys: string[], fallback = "") {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  return fallback;
}

export function normalizeSupportLink(value: string | null | undefined) {
  const normalized = typeof value === "string" ? value.trim() : "";

  if (!normalized || /t\.me\/your_support|telegram/i.test(normalized)) {
    return DEFAULT_SUPPORT_LINK;
  }

  return normalized;
}

export function normalizeStoreSettings(source: Record<string, unknown>) {
  return {
    ...DEFAULT_STORE_SETTINGS,
    ...source,
    support_link: normalizeSupportLink(
      typeof source.support_link === "string" ? source.support_link : undefined,
    ),
    intro_customer_count:
      typeof source.intro_customer_count === "string"
        ? source.intro_customer_count.trim()
        : DEFAULT_STORE_SETTINGS.intro_customer_count,
    addon_cpu_price: normalizePositiveInteger(
      typeof source.addon_cpu_price === "string" || typeof source.addon_cpu_price === "number"
        ? source.addon_cpu_price
        : null,
      DEFAULT_STORE_SETTINGS.addon_cpu_price,
    ),
    addon_ram_price: normalizePositiveInteger(
      typeof source.addon_ram_price === "string" || typeof source.addon_ram_price === "number"
        ? source.addon_ram_price
        : null,
      DEFAULT_STORE_SETTINGS.addon_ram_price,
    ),
    addon_disk_price: normalizePositiveInteger(
      typeof source.addon_disk_price === "string" || typeof source.addon_disk_price === "number"
        ? source.addon_disk_price
        : null,
      DEFAULT_STORE_SETTINGS.addon_disk_price,
    ),
    addon_disk_step: normalizePositiveInteger(
      typeof source.addon_disk_step === "string" || typeof source.addon_disk_step === "number"
        ? source.addon_disk_step
        : null,
      DEFAULT_STORE_SETTINGS.addon_disk_step,
    ),
  };
}

export function resolveOperatingSystemName(
  name: string | null | undefined,
  rawPayload?: string | null,
) {
  const fallbackName = typeof name === "string" ? name.trim() : "";
  const parsedPayload = safeJsonParse<Record<string, unknown>>(rawPayload, {});
  const payloadName = pickText(parsedPayload, ["os-name", "os_name", "name", "title"], "");
  const sourceName =
    payloadName ||
    (/^OS\s*\d+$/i.test(fallbackName) ? "" : fallbackName) ||
    fallbackName;

  if (!sourceName) {
    return null;
  }

  return sourceName
    .replace(/^Linux\s+/i, "")
    .replace(/Ubuntu-?(\d{2}\.\d{2})/i, "Ubuntu $1")
    .replace(/Ubuntu(\d{2}\.\d{2})/i, "Ubuntu $1")
    .replace(/Almalinux/gi, "AlmaLinux")
    .replace(/-AAPanel-Nginx/gi, " · aaPanel Nginx")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeOperatingSystemName(value: string) {
  return /(ubuntu|windows|debian|alma|almalinux|centos|rocky|fedora|oracle linux|linux|aapanel|nginx|docker|proxy)/i.test(
    value,
  );
}

function findNestedOperatingSystemName(
  source: unknown,
  depth = 0,
): string | null {
  if (depth > 4 || source === null || source === undefined) {
    return null;
  }

  if (typeof source === "string") {
    const normalized = source.trim();
    return normalized && looksLikeOperatingSystemName(normalized) ? normalized : null;
  }

  if (Array.isArray(source)) {
    for (const item of source) {
      const found = findNestedOperatingSystemName(item, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof source !== "object") {
    return null;
  }

  const record = source as Record<string, unknown>;
  const directKeys = [
    "os-name",
    "os_name",
    "operating-system",
    "operating_system",
    "template_name",
    "image_name",
    "os",
    "image",
  ];

  for (const key of directKeys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() && looksLikeOperatingSystemName(value.trim())) {
      return value.trim();
    }
  }

  for (const value of Object.values(record)) {
    const found = findNestedOperatingSystemName(value, depth + 1);
    if (found) {
      return found;
    }
  }

  return null;
}

export function resolveInstanceOperatingSystemName(
  rawPayload?: string | null,
  fallbackName?: string | null,
  fallbackRawPayload?: string | null,
) {
  const parsedPayload = safeJsonParse<unknown>(rawPayload, null);
  const liveName = findNestedOperatingSystemName(parsedPayload);

  if (liveName) {
    return resolveOperatingSystemName(liveName);
  }

  return resolveOperatingSystemName(fallbackName, fallbackRawPayload);
}

export function pickNumber(
  source: Record<string, unknown>,
  keys: string[],
  fallback = 0,
) {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && `${value}` !== "") {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }

  return fallback;
}

export function createOrderCode() {
  return `VPS-${randomBytes(5).toString("hex").toUpperCase()}`;
}

export function formatCurrency(value: number) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(value);
}
