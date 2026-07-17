import { Router } from "express";
import { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { adminMiddleware, authMiddleware } from "../../middleware/auth.js";
import { executeResult, queryRows } from "../../db/pool.js";
import { asyncHandler, getIpAddress } from "../../utils/http.js";
import {
  DEFAULT_STORE_SETTINGS,
  normalizeStoreSettings,
  resolveOperatingSystemName,
  slugify,
} from "../../utils/helpers.js";
import { AppError } from "../../utils/app-error.js";
import { vnCloudService } from "../vncloud/vncloud.service.js";
import { syncVnCloudCatalog } from "../vncloud/vncloud-catalog-sync.js";
import {
  LONG_REBUILD_SYNC_DELAYS_MS,
  scheduleInstanceSync,
  syncInstancesFromProvider,
} from "../vps/vps-instance-sync.js";
import { isProcessingInstanceStatus } from "../vps/vps-status.js";

const settingsSchema = z.object({
  brand_name: z.string().min(2).max(120),
  hero_title: z.string().min(10).max(180),
  hero_subtitle: z.string().min(10).max(300),
  hero_badge: z.string().min(2).max(80),
  support_link: z.string().url(),
  announcement: z.string().min(10).max(300),
  theme_default: z.enum(["light", "dark"]),
  intro_customer_count: z
    .string()
    .trim()
    .max(20)
    .regex(/^\d*$/, "Số khách hàng PR chỉ được nhập số hoặc để trống."),
  addon_cpu_price: z.coerce.number().int().positive(),
  addon_ram_price: z.coerce.number().int().positive(),
  addon_disk_price: z.coerce.number().int().positive(),
  addon_disk_step: z.coerce.number().int().positive(),
});

const catalogItemSchema = z.object({
  title: z.string().min(4).max(255),
  slug: z.string().optional(),
  sku: z.string().min(3).max(60),
  shortDescription: z.string().max(255).optional().or(z.literal("")),
  description: z.string().optional().or(z.literal("")),
  vncloudProductId: z.coerce.number().int().positive(),
  vncloudOsId: z.coerce.number().int().positive(),
  billingCycleCode: z.string().min(1).max(50),
  salePrice: z.coerce.number().positive(),
  comparePrice: z.coerce.number().positive().optional(),
  addonCpu: z.coerce.number().int().min(0).default(0),
  addonRam: z.coerce.number().int().min(0).default(0),
  addonDisk: z.coerce.number().int().min(0).default(0),
  badgeText: z.string().max(80).optional().or(z.literal("")),
  heroGradientFrom: z.string().min(4).max(20).default("#0f766e"),
  heroGradientTo: z.string().min(4).max(20).default("#2563eb"),
  sortOrder: z.coerce.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
  isFeatured: z.boolean().default(false),
});

const adminActionSchema = z.object({
  action: z.enum([
    "on",
    "off",
    "restart",
    "cancel",
    "on-auto-renew",
    "off-auto-renew",
    "check-os-when-rebuild-vps",
    "confirm-rebuild-vps",
    "addon-vps",
    "renew-vps",
  ]),
  osId: z.coerce.number().int().optional(),
  billingCycleCode: z.string().optional(),
  addonCpu: z.coerce.number().int().min(0).optional(),
  addonRam: z.coerce.number().int().min(0).optional(),
  addonDisk: z.coerce.number().int().min(0).optional(),
});

function getAdminOptimisticStatus(action: z.infer<typeof adminActionSchema>["action"]) {
  if (action === "on") {
    return "starting";
  }

  if (action === "off") {
    return "stopping";
  }

  if (action === "restart") {
    return "restarting";
  }

  if (action === "confirm-rebuild-vps") {
    return "rebuild";
  }

  if (action === "cancel") {
    return "cancelled";
  }

  return null;
}

function getAdminSyncDelays(action: z.infer<typeof adminActionSchema>["action"]) {
  if (action === "confirm-rebuild-vps") {
    return LONG_REBUILD_SYNC_DELAYS_MS;
  }

  return undefined;
}

const router = Router();

router.use(authMiddleware, adminMiddleware);

router.get(
  "/dashboard",
  asyncHandler(async (_request, response) => {
    const [summaryRows, recentOrders, recentInstances, settingsRows] = await Promise.all([
      queryRows<RowDataPacket[]>(
        `SELECT
           (SELECT COUNT(*) FROM vps_catalog_items WHERE is_active = 1) AS active_catalog,
           (SELECT COUNT(*) FROM vps_orders) AS total_orders,
           (SELECT COUNT(*) FROM vps_instances) AS total_instances,
           (SELECT IFNULL(SUM(total_price), 0) FROM vps_orders WHERE status IN ('active','processing','provisioning')) AS gross_revenue,
           (SELECT COUNT(*) FROM users WHERE role <> 'admin') AS customers`,
      ),
      queryRows<RowDataPacket[]>(
        `SELECT o.id, o.order_code, o.status, o.total_price, o.created_at, u.username, u.email, c.title
         FROM vps_orders o
         INNER JOIN users u ON u.id = o.user_id
         INNER JOIN vps_catalog_items c ON c.id = o.catalog_item_id
         ORDER BY o.created_at DESC
         LIMIT 6`,
      ),
      queryRows<RowDataPacket[]>(
        `SELECT i.id, i.vncloud_vps_id, i.status, i.ip_address, i.next_due_date, u.username, o.order_code
         FROM vps_instances i
         INNER JOIN users u ON u.id = i.user_id
         INNER JOIN vps_orders o ON o.id = i.order_id
         ORDER BY i.updated_at DESC
         LIMIT 6`,
      ),
      queryRows<RowDataPacket[]>(
        `SELECT setting_key, setting_value FROM vps_store_settings`,
      ),
    ]);

    let agency: unknown = null;
    try {
      agency = await vnCloudService.getAgencyInfo();
    } catch (error) {
      agency = {
        warning: error instanceof Error ? error.message : "Chưa kết nối được nhà cung cấp.",
      };
    }

    response.json({
      summary: summaryRows[0] ?? {},
      recentOrders,
      recentInstances,
      agency,
      settings: normalizeStoreSettings(
        Object.fromEntries(
          settingsRows.map((item) => [item.setting_key, item.setting_value ?? ""]),
        ),
      ),
    });
  }),
);

router.get(
  "/catalog/resources",
  asyncHandler(async (_request, response) => {
    const [products, billingCycles, operatingSystems] = await Promise.all([
      queryRows<RowDataPacket[]>(
        `SELECT vncloud_product_id, name, category, region, base_price, cpu_label, ram_label, disk_label, bandwidth_label
         FROM vps_remote_products
         ORDER BY name ASC`,
      ),
      queryRows<RowDataPacket[]>(
        `SELECT cycle_code, label, months
         FROM vps_remote_billing_cycles
         ORDER BY months ASC, label ASC`,
      ),
      queryRows<RowDataPacket[]>(
        `SELECT vncloud_os_id, name, group_name, is_active, raw_payload
         FROM vps_remote_operating_systems
         ORDER BY name ASC`,
      ),
    ]);

    response.json({
      products,
      billingCycles,
      operatingSystems: operatingSystems.map((item) => ({
        ...item,
        name: resolveOperatingSystemName(
          typeof item.name === "string" ? item.name : null,
          typeof item.raw_payload === "string" ? item.raw_payload : null,
        ),
      })),
    });
  }),
);

router.post(
  "/catalog/sync",
  asyncHandler(async (_request, response) => {
    const synced = await syncVnCloudCatalog({
      ensureListings: true,
    });

    response.json({
      message:
        synced.autoCatalogItems > 0
          ? "Đã đồng bộ danh mục VPS và tự tạo listing mặc định."
          : "Đã đồng bộ danh mục VPS.",
      synced,
    });
  }),
);

router.get(
  "/catalog/items",
  asyncHandler(async (_request, response) => {
    const items = await queryRows<RowDataPacket[]>(
      `SELECT
         c.*,
         rp.name AS product_name,
         os.name AS operating_system_name,
         os.raw_payload AS operating_system_payload,
         bc.label AS billing_cycle_label
       FROM vps_catalog_items c
       LEFT JOIN vps_remote_products rp ON rp.vncloud_product_id = c.vncloud_product_id
       LEFT JOIN vps_remote_operating_systems os ON os.vncloud_os_id = c.vncloud_os_id
       LEFT JOIN vps_remote_billing_cycles bc ON bc.cycle_code = c.billing_cycle_code
       ORDER BY c.sort_order ASC, c.updated_at DESC`,
    );

    response.json({
      items: items.map((item) => ({
        ...item,
        operating_system_name: resolveOperatingSystemName(
          typeof item.operating_system_name === "string" ? item.operating_system_name : null,
          typeof item.operating_system_payload === "string" ? item.operating_system_payload : null,
        ),
      })),
    });
  }),
);

router.post(
  "/catalog/items",
  asyncHandler(async (request, response) => {
    const payload = catalogItemSchema.parse(request.body);
    const slug = payload.slug?.trim() || slugify(payload.title);

    await executeResult(
      `INSERT INTO vps_catalog_items (
         sku, title, slug, short_description, description,
         vncloud_product_id, vncloud_os_id, billing_cycle_code,
         sale_price, compare_price, addon_cpu, addon_ram, addon_disk,
         badge_text, hero_gradient_from, hero_gradient_to, sort_order, is_active, is_featured
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.sku,
        payload.title,
        slug,
        payload.shortDescription || null,
        payload.description || null,
        payload.vncloudProductId,
        payload.vncloudOsId,
        payload.billingCycleCode,
        payload.salePrice,
        payload.comparePrice ?? null,
        payload.addonCpu,
        payload.addonRam,
        payload.addonDisk,
        payload.badgeText || null,
        payload.heroGradientFrom,
        payload.heroGradientTo,
        payload.sortOrder,
        payload.isActive ? 1 : 0,
        payload.isFeatured ? 1 : 0,
      ],
    );

    response.status(201).json({
      message: "Đã tạo gói VPS mới.",
    });
  }),
);

router.put(
  "/catalog/items/:itemId",
  asyncHandler(async (request, response) => {
    const payload = catalogItemSchema.parse(request.body);
    const itemId = Number(request.params.itemId);
    const slug = payload.slug?.trim() || slugify(payload.title);

    await executeResult(
      `UPDATE vps_catalog_items
       SET sku = ?,
           title = ?,
           slug = ?,
           short_description = ?,
           description = ?,
           vncloud_product_id = ?,
           vncloud_os_id = ?,
           billing_cycle_code = ?,
           sale_price = ?,
           compare_price = ?,
           addon_cpu = ?,
           addon_ram = ?,
           addon_disk = ?,
           badge_text = ?,
           hero_gradient_from = ?,
           hero_gradient_to = ?,
           sort_order = ?,
           is_active = ?,
           is_featured = ?
       WHERE id = ?`,
      [
        payload.sku,
        payload.title,
        slug,
        payload.shortDescription || null,
        payload.description || null,
        payload.vncloudProductId,
        payload.vncloudOsId,
        payload.billingCycleCode,
        payload.salePrice,
        payload.comparePrice ?? null,
        payload.addonCpu,
        payload.addonRam,
        payload.addonDisk,
        payload.badgeText || null,
        payload.heroGradientFrom,
        payload.heroGradientTo,
        payload.sortOrder,
        payload.isActive ? 1 : 0,
        payload.isFeatured ? 1 : 0,
        itemId,
      ],
    );

    response.json({
      message: "Đã cập nhật gói VPS.",
    });
  }),
);

router.get(
  "/orders",
  asyncHandler(async (_request, response) => {
    const rows = await queryRows<RowDataPacket[]>(
      `SELECT
         o.id,
         o.order_code,
         o.status,
         o.total_price,
         o.quantity,
         o.created_at,
         o.failure_reason,
         o.refund_requested_at,
         o.refund_amount,
         u.username,
         u.email,
         c.title
       FROM vps_orders o
       INNER JOIN users u ON u.id = o.user_id
       INNER JOIN vps_catalog_items c ON c.id = o.catalog_item_id
       ORDER BY o.created_at DESC`,
    );

    response.json({ orders: rows });
  }),
);

router.get(
  "/instances",
  asyncHandler(async (_request, response) => {
    let rows = await queryRows<RowDataPacket[]>(
      `SELECT
         i.id,
         i.vncloud_vps_id,
         i.status,
         i.ip_address,
         i.username,
         i.password,
         i.next_due_date,
         i.auto_renew,
         u.username AS owner_username,
         u.email AS owner_email,
         o.order_code
       FROM vps_instances i
       INNER JOIN users u ON u.id = i.user_id
       INNER JOIN vps_orders o ON o.id = i.order_id
      ORDER BY i.updated_at DESC`,
    );

    const processingInstances = rows.filter((instance) =>
      isProcessingInstanceStatus(String(instance.status ?? "")),
    );

    if (processingInstances.length > 0) {
      await Promise.allSettled([
        syncInstancesFromProvider(
          processingInstances.slice(0, 10).map((instance) => ({
            id: Number(instance.id),
            vncloud_vps_id: Number(instance.vncloud_vps_id),
          })),
        ),
      ]);

      rows = await queryRows<RowDataPacket[]>(
        `SELECT
           i.id,
           i.vncloud_vps_id,
           i.status,
           i.ip_address,
           i.username,
           i.password,
           i.next_due_date,
           i.auto_renew,
           u.username AS owner_username,
           u.email AS owner_email,
           o.order_code
         FROM vps_instances i
         INNER JOIN users u ON u.id = i.user_id
         INNER JOIN vps_orders o ON o.id = i.order_id
        ORDER BY i.updated_at DESC`,
      );
    }

    for (const instance of rows) {
      if (isProcessingInstanceStatus(String(instance.status ?? ""))) {
        scheduleInstanceSync(Number(instance.id), Number(instance.vncloud_vps_id));
      }
    }

    response.json({ instances: rows });
  }),
);

router.get(
  "/settings",
  asyncHandler(async (_request, response) => {
    const rows = await queryRows<RowDataPacket[]>(
      `SELECT setting_key, setting_value FROM vps_store_settings`,
    );

    response.json({
      settings: normalizeStoreSettings(
        Object.fromEntries(
          rows.map((item) => [item.setting_key, item.setting_value ?? ""]),
        ),
      ),
    });
  }),
);

router.put(
  "/settings",
  asyncHandler(async (request, response) => {
    const payload = settingsSchema.parse(request.body);

    for (const [settingKey, settingValue] of Object.entries(payload)) {
      await executeResult(
        `INSERT INTO vps_store_settings (setting_key, setting_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [settingKey, settingValue],
      );
    }

    response.json({
      message: "Đã cập nhật cấu hình storefront.",
    });
  }),
);

router.post(
  "/instances/:instanceId/action",
  asyncHandler(async (request, response) => {
    const payload = adminActionSchema.parse(request.body);
    const instanceId = Number(request.params.instanceId);
    const instances = await queryRows<RowDataPacket[]>(
      `SELECT id, vncloud_vps_id
       FROM vps_instances
       WHERE id = ?
       LIMIT 1`,
      [instanceId],
    );
    const instance = instances[0];

    if (!instance) {
      throw new AppError("Không tìm thấy VPS cần thao tác.", 404);
    }

    const actionPayload: Record<string, unknown> = {
      action: payload.action,
      "vps-id": instance.vncloud_vps_id,
    };

    if (payload.action === "confirm-rebuild-vps") {
      if (!payload.osId) {
        throw new AppError("Cần truyền osId khi cài đặt lại VPS.", 400);
      }
      actionPayload["os-id"] = payload.osId;
    }

    if (payload.action === "addon-vps") {
      actionPayload["addon-cpu"] = payload.addonCpu ?? 0;
      actionPayload["addon-ram"] = payload.addonRam ?? 0;
      actionPayload["addon-disk"] = payload.addonDisk ?? 0;
    }

    if (payload.action === "renew-vps") {
      if (!payload.billingCycleCode) {
        throw new AppError("Cần truyền billingCycleCode khi gia hạn VPS.", 400);
      }
      actionPayload["billing-cycle"] = payload.billingCycleCode;
    }

    const result = await vnCloudService.actionVps(actionPayload);

    await executeResult(
      `INSERT INTO vps_instance_logs (vps_instance_id, user_id, action, status, message, payload)
       VALUES (?, ?, ?, 'success', ?, ?)`,
      [
        instance.id,
        request.authUser!.id,
        payload.action,
        String(result.message ?? "Admin action success"),
        JSON.stringify(result),
      ],
    );

    if (payload.action === "on-auto-renew" || payload.action === "off-auto-renew") {
      await executeResult(
        `UPDATE vps_instances SET auto_renew = ? WHERE id = ?`,
        [payload.action === "on-auto-renew" ? 1 : 0, instance.id],
      );
    }

    const optimisticStatus = getAdminOptimisticStatus(payload.action);

    if (optimisticStatus) {
      await executeResult(
        `UPDATE vps_instances SET status = ? WHERE id = ?`,
        [optimisticStatus, instance.id],
      );
      scheduleInstanceSync(
        instance.id,
        instance.vncloud_vps_id,
        getAdminSyncDelays(payload.action),
      );
    }

    if (payload.action === "check-os-when-rebuild-vps") {
      response.json({
        message: "Đã lấy danh sách hệ điều hành có thể rebuild.",
        result,
      });
      return;
    }

    response.json({
      message: "Đã gửi lệnh quản trị VPS lên hệ thống.",
      result,
    });
  }),
);

router.post(
  "/audit",
  asyncHandler(async (request, response) => {
    const payload = z
      .object({
        action: z.string().min(2).max(100),
        description: z.string().max(500).optional(),
        targetUserId: z.coerce.number().optional(),
      })
      .parse(request.body);

    await executeResult(
      `INSERT INTO admin_audit_logs (admin_id, target_user_id, action, description, ip_address)
       VALUES (?, ?, ?, ?, ?)`,
      [
        request.authUser!.id,
        payload.targetUserId ?? null,
        payload.action,
        payload.description ?? null,
        getIpAddress(request),
      ],
    );

    response.status(201).json({
      message: "Đã ghi log admin.",
    });
  }),
);

router.post(
  "/orders/:orderId/refund",
  asyncHandler(async (request, response) => {
    const orderId = Number(request.params.orderId);

    const [orderRows] = await queryRows<RowDataPacket[]>(
      `SELECT id, user_id, status, total_price, refund_requested_at
       FROM vps_orders
       WHERE id = ?`,
      [orderId],
    );
    const order = orderRows[0];

    if (!order) {
      throw new AppError("Không tìm thấy đơn hàng.", 404);
    }

    if (order.status !== "active") {
      throw new AppError("Chỉ có thể hoàn tiền đơn hàng đang hoạt động.", 400);
    }

    if (order.refund_requested_at) {
      throw new AppError("Đơn hàng này đã được yêu cầu hoàn tiền.", 400);
    }

    const [activeInstanceRows] = await queryRows<RowDataPacket[]>(
      `SELECT id FROM vps_instances
       WHERE order_id = ? AND status NOT IN ('cancelled','failed','deleted','terminated')`,
      [orderId],
    );
    if (activeInstanceRows.length > 0) {
      throw new AppError("Cần xóa tất cả VPS trước khi hoàn tiền.", 400);
    }

    await executeResult(
      `UPDATE vps_orders
       SET status = 'refund_requested',
           refund_requested_at = NOW()
       WHERE id = ?`,
      [orderId],
    );

    await executeResult(
      `UPDATE users
       SET balance = balance + ?
       WHERE id = ?`,
      [order.total_price, order.user_id],
    );

    await executeResult(
      `INSERT INTO vps_order_logs (order_id, user_id, action, status, message)
       VALUES (?, ?, 'admin_refund_request', 'refund_requested', 'Admin yêu cầu hoàn tiền.')`,
      [orderId, request.authUser!.id],
    );

    response.json({
      message: `Đã yêu cầu hoàn tiền ${order.total_price.toLocaleString("vi-VN")} VNĐ cho đơn hàng.`,
      refundAmount: order.total_price,
    });
  }),
);

export default router;
