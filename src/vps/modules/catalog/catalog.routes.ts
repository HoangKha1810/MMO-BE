import { Router } from "express";
import { RowDataPacket } from "mysql2/promise";
import { queryRows, queryRowsOrFallback } from "../../db/pool.js";
import { asyncHandler } from "../../utils/http.js";
import { normalizeStoreSettings, resolveOperatingSystemName } from "../../utils/helpers.js";

type CatalogRow = RowDataPacket & {
  id: number;
  sku: string;
  title: string;
  slug: string;
  short_description: string | null;
  description: string | null;
  sale_price: number;
  compare_price: number | null;
  billing_cycle_code: string;
  billing_cycle_label: string | null;
  addon_cpu: number;
  addon_ram: number;
  addon_disk: number;
  badge_text: string | null;
  hero_gradient_from: string;
  hero_gradient_to: string;
  is_featured: number;
  cpu_label: string | null;
  ram_label: string | null;
  disk_label: string | null;
  bandwidth_label: string | null;
  operating_system_name: string | null;
  operating_system_payload?: string | null;
};

type SettingRow = RowDataPacket & {
  setting_key: string;
  setting_value: string | null;
};

type CountRow = RowDataPacket & {
  total_orders?: number;
  live_instances?: number;
  total_customers?: number;
};

type OperatingSystemRow = RowDataPacket & {
  name: string;
  raw_payload?: string | null;
};

const router = Router();

router.get(
  "/",
  asyncHandler(async (_request, response) => {
    const [items, settingsRows, orderRows, liveRows, customerRows, operatingSystemsRows] =
      await Promise.all([
        queryRowsOrFallback<CatalogRow[]>(
          `SELECT
             c.id,
             c.sku,
             c.title,
             c.slug,
             c.short_description,
             c.description,
             c.sale_price,
             c.compare_price,
             c.billing_cycle_code,
             bc.label AS billing_cycle_label,
             c.addon_cpu,
             c.addon_ram,
             c.addon_disk,
             c.badge_text,
             c.hero_gradient_from,
             c.hero_gradient_to,
             c.is_featured,
             rp.cpu_label,
             rp.ram_label,
             rp.disk_label,
             rp.bandwidth_label,
             os.name AS operating_system_name,
             os.raw_payload AS operating_system_payload
           FROM vps_catalog_items c
           LEFT JOIN vps_remote_products rp ON rp.vncloud_product_id = c.vncloud_product_id
           LEFT JOIN vps_remote_operating_systems os ON os.vncloud_os_id = c.vncloud_os_id
           LEFT JOIN vps_remote_billing_cycles bc ON bc.cycle_code = c.billing_cycle_code
           WHERE c.is_active = 1
           ORDER BY c.is_featured DESC, c.sort_order ASC, c.id DESC`,
          [],
          [],
        ),
        queryRowsOrFallback<SettingRow[]>(
          `SELECT setting_key, setting_value
           FROM vps_store_settings`,
          [],
          [],
        ),
        queryRowsOrFallback<CountRow[]>(
          `SELECT COUNT(*) AS total_orders FROM vps_orders`,
          [],
          [{ total_orders: 0 } as CountRow],
        ),
        queryRowsOrFallback<CountRow[]>(
          `SELECT COUNT(*) AS live_instances
           FROM vps_instances
           WHERE status NOT IN ('failed','cancelled')`,
          [],
          [{ live_instances: 0 } as CountRow],
        ),
        queryRows<CountRow[]>(
          `SELECT COUNT(*) AS total_customers
           FROM users
           WHERE role <> 'admin'`,
        ),
        queryRowsOrFallback<OperatingSystemRow[]>(
          `SELECT DISTINCT name, raw_payload
           FROM vps_remote_operating_systems
           WHERE is_active = 1
           ORDER BY name ASC
           LIMIT 24`,
          [],
          [],
        ),
      ]);

    const settings = normalizeStoreSettings(
      Object.fromEntries(
        settingsRows.map((item) => [item.setting_key, item.setting_value ?? ""]),
      ),
    );

    response.json({
      settings,
      stats: {
        total_orders: Number(orderRows[0]?.total_orders ?? 0),
        live_instances: Number(liveRows[0]?.live_instances ?? 0),
        total_customers: Number(customerRows[0]?.total_customers ?? 0),
      },
      operatingSystems: operatingSystemsRows
        .map((item) =>
          resolveOperatingSystemName(
            typeof item.name === "string" ? item.name : null,
            typeof item.raw_payload === "string" ? item.raw_payload : null,
          ),
        )
        .filter((item): item is string => Boolean(item)),
      items: items.map((item) => ({
        ...item,
        operating_system_name: resolveOperatingSystemName(
          typeof item.operating_system_name === "string" ? item.operating_system_name : null,
          typeof item.operating_system_payload === "string"
            ? item.operating_system_payload
            : null,
        ),
      })),
    });
  }),
);

export default router;
