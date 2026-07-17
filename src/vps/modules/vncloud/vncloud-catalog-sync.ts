import { RowDataPacket } from "mysql2/promise";
import { executeResult, queryRows } from "../../db/pool.js";
import {
  pickNumber,
  pickText,
  slugify,
  toArrayPayload,
} from "../../utils/helpers.js";
import { vnCloudService } from "./vncloud.service.js";

type RemoteProductRow = RowDataPacket & {
  vncloud_product_id: number;
};

type RemoteOsRow = RowDataPacket & {
  vncloud_os_id: number;
};

type RemoteCycleRow = RowDataPacket & {
  cycle_code: string;
};

type NormalizedProduct = {
  vncloudProductId: number;
  name: string;
  category: string;
  region: string;
  description: string;
  cpuLabel: string;
  ramLabel: string;
  diskLabel: string;
  bandwidthLabel: string;
  basePrice: number;
  rawPayload: Record<string, unknown>;
};

type NormalizedBillingCycle = {
  cycleCode: string;
  label: string;
  months: number;
  rawPayload: Record<string, unknown>;
};

const gradients = [
  ["#356dff", "#6d8ff2"],
  ["#0f766e", "#2563eb"],
  ["#0f172a", "#f97316"],
  ["#1e293b", "#14b8a6"],
  ["#1d4ed8", "#8b5cf6"],
];

function pickGradient(index: number) {
  return gradients[index % gradients.length] ?? gradients[0];
}

function buildAutoDescription(product: Record<string, unknown>) {
  const category = pickText(product, ["category", "product-group"], "");
  const region = pickText(product, ["region", "location", "zone"], "");
  const specs = [
    pickText(product, ["cpu", "cpu-label", "cpu_label"], ""),
    pickText(product, ["ram", "ram-label", "ram_label"], ""),
    pickText(product, ["disk", "disk-label", "disk_label"], ""),
    pickText(product, ["bandwidth", "traffic", "network"], ""),
  ].filter(Boolean);

  return [category, region, ...specs].filter(Boolean).join(" • ");
}

function formatUnitLabel(value: number, singular: string, plural = singular) {
  if (!value) {
    return "";
  }

  return `${value} ${value === 1 ? singular : plural}`;
}

function extractPricingAmount(pricing: unknown) {
  if (!pricing || typeof pricing !== "object") {
    return 0;
  }

  const pricingMap = pricing as Record<string, unknown>;
  const preferredKeys = [
    "monthly",
    "twomonthly",
    "quarterly",
    "semi_annually",
    "annually",
    "biennially",
    "triennially",
  ];

  for (const key of preferredKeys) {
    const entry = pricingMap[key];

    if (entry && typeof entry === "object") {
      const amount = pickNumber(entry as Record<string, unknown>, ["amount", "price"], 0);

      if (amount > 0) {
        return amount;
      }
    }
  }

  for (const entry of Object.values(pricingMap)) {
    if (entry && typeof entry === "object") {
      const amount = pickNumber(entry as Record<string, unknown>, ["amount", "price"], 0);

      if (amount > 0) {
        return amount;
      }
    }
  }

  return 0;
}

function extractVpsProducts(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return [] as NormalizedProduct[];
  }

  const root = payload as Record<string, unknown>;
  const vpsGroups = Array.isArray(root.vps)
    ? (root.vps as Record<string, unknown>[])
    : toArrayPayload<Record<string, unknown>>(root.vps);
  const products: NormalizedProduct[] = [];

  for (const group of vpsGroups) {
    const category =
      pickText(group, ["group_product_name", "category", "name"], "Cloud VPS");
    const productContainer = group.product;

    if (!productContainer || typeof productContainer !== "object") {
      continue;
    }

    const productEntries = Array.isArray(productContainer)
      ? productContainer
      : Object.entries(productContainer as Record<string, unknown>)
          .filter(([key, value]) => key !== "limit-os" && value && typeof value === "object")
          .map(([, value]) => value as Record<string, unknown>);

    for (const item of productEntries) {
      const vncloudProductId = pickNumber(item, ["product_id", "product-id", "id"]);

      if (!vncloudProductId) {
        continue;
      }

      const cpuAmount = pickNumber(item, ["cpu"], 0);
      const ramAmount = pickNumber(item, ["ram"], 0);
      const diskAmount = pickNumber(item, ["disk"], 0);
      const basePrice = extractPricingAmount(item.pricing);
      const rawPayload = {
        ...item,
        group_product_name: category,
      };

      products.push({
        vncloudProductId,
        name: pickText(item, ["name", "product-name", "title"], `VPS ${vncloudProductId}`),
        category,
        region: pickText(item, ["region", "location", "zone"], "Việt Nam"),
        description: pickText(item, ["description", "note", "content"], ""),
        cpuLabel:
          pickText(item, ["cpu-label", "cpu_label"], "") ||
          formatUnitLabel(cpuAmount, "Core", "Core"),
        ramLabel:
          pickText(item, ["ram-label", "ram_label"], "") ||
          formatUnitLabel(ramAmount, "GB RAM", "GB RAM"),
        diskLabel:
          pickText(item, ["disk-label", "disk_label"], "") ||
          formatUnitLabel(diskAmount, "GB SSD", "GB SSD"),
        bandwidthLabel: pickText(item, ["bandwidth", "traffic", "network"], ""),
        basePrice,
        rawPayload,
      });
    }
  }

  return products;
}

function parseBillingMonths(cycleCode: string, label: string) {
  const normalizedLabel = label.toLowerCase();
  const normalizedCode = cycleCode.toLowerCase();
  const monthMatch = normalizedLabel.match(/(\d+)\s*th[aá]ng/u);
  const yearMatch = normalizedLabel.match(/(\d+)\s*n[aă]m/u);

  if (monthMatch) {
    return Number.parseInt(monthMatch[1] ?? "1", 10);
  }

  if (yearMatch) {
    return Number.parseInt(yearMatch[1] ?? "1", 10) * 12;
  }

  if (normalizedCode.includes("monthly")) return 1;
  if (normalizedCode.includes("quarter")) return 3;
  if (normalizedCode.includes("semi")) return 6;
  if (normalizedCode.includes("annually")) return 12;
  if (normalizedCode.includes("biennially")) return 24;
  if (normalizedCode.includes("triennially")) return 36;

  return 1;
}

function extractBillingCycles(payload: unknown) {
  const cycles = toArrayPayload<Record<string, unknown>>(payload);

  return cycles
    .map<NormalizedBillingCycle | null>((cycle) => {
      const cycleCode = pickText(cycle, [
        "billing-key",
        "code",
        "billing-cycle",
        "cycle",
        "value",
      ]);
      const label = pickText(cycle, ["billing-name", "label", "name", "title"], cycleCode);

      if (!cycleCode) {
        return null;
      }

      return {
        cycleCode,
        label,
        months: parseBillingMonths(cycleCode, label),
        rawPayload: cycle,
      };
    })
    .filter((cycle): cycle is NormalizedBillingCycle => Boolean(cycle));
}

export async function syncVnCloudCatalog(options?: { ensureListings?: boolean }) {
  const ensureListings = options?.ensureListings ?? true;
  const [productsResponse, osResponse, billingCyclesResponse] = await Promise.all([
    vnCloudService.getProducts(),
    vnCloudService.getOperatingSystems(),
    vnCloudService.getBillingCycles(),
  ]);

  const products = extractVpsProducts(productsResponse.products);
  const operatingSystems = toArrayPayload<Record<string, unknown>>(osResponse["os-vps"]);
  const billingCycles = extractBillingCycles(billingCyclesResponse["billing-cycle"]);

  for (const product of products) {
    await executeResult(
      `INSERT INTO vps_remote_products (
         vncloud_product_id, name, slug, category, region, description,
         cpu_label, ram_label, disk_label, bandwidth_label, base_price, raw_payload
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         slug = VALUES(slug),
         category = VALUES(category),
         region = VALUES(region),
         description = VALUES(description),
         cpu_label = VALUES(cpu_label),
         ram_label = VALUES(ram_label),
         disk_label = VALUES(disk_label),
         bandwidth_label = VALUES(bandwidth_label),
         base_price = VALUES(base_price),
         raw_payload = VALUES(raw_payload),
         synced_at = CURRENT_TIMESTAMP`,
      [
        product.vncloudProductId,
        product.name,
        slugify(product.name),
        product.category || "VPS VN",
        product.region,
        product.description || buildAutoDescription(product.rawPayload),
        product.cpuLabel,
        product.ramLabel,
        product.diskLabel,
        product.bandwidthLabel,
        product.basePrice,
        JSON.stringify(product.rawPayload),
      ],
    );
  }

  for (const operatingSystem of operatingSystems) {
    const osId = pickNumber(operatingSystem, ["os-id", "id", "os_id"]);
    const name = pickText(operatingSystem, ["os-name", "name", "title"], `OS ${osId}`);

    if (!osId) {
      continue;
    }

    await executeResult(
      `INSERT INTO vps_remote_operating_systems (
         vncloud_os_id, name, slug, group_name, is_active, raw_payload
       )
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         slug = VALUES(slug),
         group_name = VALUES(group_name),
         is_active = VALUES(is_active),
         raw_payload = VALUES(raw_payload),
         synced_at = CURRENT_TIMESTAMP`,
      [
        osId,
        name,
        slugify(name),
        pickText(operatingSystem, ["group", "group-name", "category"], ""),
        pickNumber(operatingSystem, ["status", "active", "is-active"], 1) ? 1 : 0,
        JSON.stringify(operatingSystem),
      ],
    );
  }

  for (const billingCycle of billingCycles) {
    await executeResult(
      `INSERT INTO vps_remote_billing_cycles (
         cycle_code, label, months, raw_payload
       )
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         label = VALUES(label),
         months = VALUES(months),
         raw_payload = VALUES(raw_payload),
         synced_at = CURRENT_TIMESTAMP`,
      [
        billingCycle.cycleCode,
        billingCycle.label,
        billingCycle.months,
        JSON.stringify(billingCycle.rawPayload),
      ],
    );
  }

  let autoCatalogItems = 0;

  if (ensureListings) {
    const [existingCatalogRows, osRows, cycleRows] = await Promise.all([
      queryRows<RemoteProductRow[]>(
        `SELECT vncloud_product_id
         FROM vps_catalog_items`,
      ),
      queryRows<RemoteOsRow[]>(
        `SELECT vncloud_os_id
         FROM vps_remote_operating_systems
         WHERE is_active = 1
         ORDER BY name ASC`,
      ),
      queryRows<RemoteCycleRow[]>(
        `SELECT cycle_code
         FROM vps_remote_billing_cycles
         ORDER BY
           CASE WHEN LOWER(cycle_code) IN ('monthly', '1month', '1-month') THEN 0 ELSE 1 END,
           months ASC,
           label ASC`,
      ),
    ]);

    const existingProductIds = new Set(
      existingCatalogRows.map((row) => Number(row.vncloud_product_id)),
    );
    const defaultOsId = Number(osRows[0]?.vncloud_os_id ?? 0);
    const defaultCycleCode = String(cycleRows[0]?.cycle_code ?? "");

    if (defaultOsId && defaultCycleCode) {
      let productIndex = 0;

      for (const product of products) {
        if (
          !product.vncloudProductId ||
          existingProductIds.has(product.vncloudProductId)
        ) {
          continue;
        }

        const name = product.name;
        const basePrice = product.basePrice;
        const safePrice = basePrice > 0 ? basePrice : 1000;
        const [heroGradientFrom, heroGradientTo] = pickGradient(productIndex);
        const slugBase = slugify(name) || `vps-${product.vncloudProductId}`;
        const autoDescription =
          product.description ||
          `Gói ${name} đã được cập nhật tự động và sẵn sàng mở bán.`;

        await executeResult(
          `INSERT INTO vps_catalog_items (
             sku, title, slug, short_description, description,
             vncloud_product_id, vncloud_os_id, billing_cycle_code,
             sale_price, compare_price, addon_cpu, addon_ram, addon_disk,
             badge_text, hero_gradient_from, hero_gradient_to, sort_order, is_active, is_featured
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `AUTO-${product.vncloudProductId}-${defaultCycleCode}`.slice(0, 60),
            name,
            `${slugBase}-${defaultCycleCode}-${product.vncloudProductId}`.slice(0, 255),
            buildAutoDescription(product.rawPayload) || "Gói VPS đã được cập nhật tự động trên hệ thống.",
            autoDescription,
            product.vncloudProductId,
            defaultOsId,
            defaultCycleCode,
            safePrice,
            basePrice > 0 ? Math.round(basePrice * 1.15) : null,
            0,
            0,
            0,
            basePrice > 0 ? "Tự động" : "Cần chỉnh giá",
            heroGradientFrom,
            heroGradientTo,
            productIndex,
            basePrice > 0 ? 1 : 0,
            productIndex < 3 ? 1 : 0,
          ],
        );

        existingProductIds.add(product.vncloudProductId);
        autoCatalogItems += 1;
        productIndex += 1;
      }
    }
  }

  const catalogTotals = await queryRows<RowDataPacket[]>(
    `SELECT
       COUNT(*) AS total_items,
       SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_items
     FROM vps_catalog_items`,
  );

  return {
    products: products.length,
    operatingSystems: operatingSystems.length,
    billingCycles: billingCycles.length,
    autoCatalogItems,
    totalCatalogItems: Number(catalogTotals[0]?.total_items ?? 0),
    activeCatalogItems: Number(catalogTotals[0]?.active_items ?? 0),
  };
}
