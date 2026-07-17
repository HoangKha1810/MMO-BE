import { Router } from "express";
import { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { PoolConnection } from "mysql2/promise";
import { authMiddleware } from "../../middleware/auth.js";
import {
  executeResult,
  isMissingTableError,
  isSchemaCompatibilityError,
  queryRows,
  queryRowsOrFallback,
  withTransaction,
} from "../../db/pool.js";
import { vnCloudService } from "../vncloud/vncloud.service.js";
import { AppError } from "../../utils/app-error.js";
import { asyncHandler } from "../../utils/http.js";
import {
  createOrderCode,
  formatCurrency,
  normalizeStoreSettings,
  resolveOperatingSystemName,
  resolveInstanceOperatingSystemName,
  safeJsonParse,
} from "../../utils/helpers.js";
import {
  LONG_REBUILD_SYNC_DELAYS_MS,
  scheduleInstanceSync,
  syncInstancesFromProvider,
} from "../vps/vps-instance-sync.js";
import {
  formatInstanceStatusLabel,
  isProcessingInstanceStatus,
  isRunningInstanceStatus,
  isStoppedInstanceStatus,
  normalizeInstanceStatus,
} from "../vps/vps-status.js";

const createOrderSchema = z.object({
  catalogItemId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().min(1).max(5).default(1),
  acceptedPolicy: z.boolean().default(false),
  note: z.string().max(400).optional().or(z.literal("")),
  customAddonCpu: z.coerce.number().int().min(0).max(64).default(0),
  customAddonRam: z.coerce.number().int().min(0).max(256).default(0),
  customAddonDisk: z.coerce.number().int().min(0).max(2000).default(0),
});

const instanceActionSchema = z.object({
  action: z.enum([
    "on",
    "off",
    "restart",
    "cancel",
    "on-auto-renew",
    "off-auto-renew",
    "check-os-when-rebuild-vps",
    "confirm-rebuild-vps",
  ]),
  osId: z.coerce.number().int().optional(),
});

type UserBalanceRow = RowDataPacket & {
  id: number;
  username: string;
  balance: number;
  status: string;
};

type CatalogItemRow = RowDataPacket & {
  id: number;
  title: string;
  sale_price: number;
  is_active: number;
  vncloud_product_id: number;
  billing_cycle_code: string;
  billing_cycle_months: number | null;
  vncloud_os_id: number;
  addon_cpu: number;
  addon_ram: number;
  addon_disk: number;
};

type OrderRow = RowDataPacket & {
  id: number;
  order_code: string;
  title: string;
  billing_cycle_code: string;
  unit_price: number;
  total_price: number;
  quantity: number;
  status: string;
  created_at: string;
  buyer_note: string | null;
  failure_reason: string | null;
};

type InstanceRow = RowDataPacket & {
  id: number;
  order_id: number;
  order_code: string | null;
  title: string | null;
  billing_cycle_code: string | null;
  order_created_at: string | null;
  unit_price: number | null;
  total_price: number | null;
  quantity: number | null;
  vncloud_vps_id: number;
  ip_address: string | null;
  username: string | null;
  password: string | null;
  status: string;
  next_due_date: string | null;
  auto_renew: number;
  raw_payload?: string | null;
  operating_system_name?: string | null;
  operating_system_payload?: string | null;
};

type TransactionRow = RowDataPacket & {
  id: number;
  amount: number;
  balance_after: number | null;
  content: string | null;
  type: string;
  status: string;
  created_at: string;
};

type SettingRow = RowDataPacket & {
  setting_key: string;
  setting_value: string | null;
};

type OperatingSystemResourceRow = RowDataPacket & {
  vncloud_os_id: number;
  name: string | null;
  group_name: string | null;
  raw_payload: string | null;
  is_active: number;
};

const PROVIDER_MAINTENANCE_MESSAGE =
  "Hệ thống bảo trì vui lòng liên hệ admin để có thể mua hàng.";

function normalizeSearchText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isProviderSensitiveMessage(message: string) {
  const text = normalizeSearchText(message);

  return (
    text.includes("dai ly") ||
    text.includes("agency") ||
    text.includes("so du tai khoan cua dai ly") ||
    text.includes("tai khoan cua dai ly") ||
    (text.includes("khong du") &&
      (text.includes("thuc hien thanh toan don dat hang") ||
        text.includes("credit") ||
        text.includes("so du tai khoan")))
  );
}

function getPublicOrderErrorMessage(message?: string | null) {
  if (!message) {
    return message ?? null;
  }

  return isProviderSensitiveMessage(message)
    ? PROVIDER_MAINTENANCE_MESSAGE
    : message;
}

function getOptimisticInstanceStatus(action: z.infer<typeof instanceActionSchema>["action"]) {
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

function getActionSuccessMessage(action: z.infer<typeof instanceActionSchema>["action"]) {
  if (action === "on") {
    return "Đã gửi lệnh bật VPS. Trạng thái sẽ được cập nhật sau ít giây.";
  }

  if (action === "off") {
    return "Đã gửi lệnh tắt VPS. Trạng thái sẽ được cập nhật sau ít giây.";
  }

  if (action === "restart") {
    return "Đã gửi lệnh khởi động lại VPS. Trạng thái sẽ được cập nhật sau ít giây.";
  }

  if (action === "on-auto-renew") {
    return "Đã bật tự gia hạn cho VPS.";
  }

  if (action === "off-auto-renew") {
    return "Đã tắt tự gia hạn cho VPS.";
  }

  if (action === "confirm-rebuild-vps") {
    return "Đã gửi lệnh cài lại VPS theo hệ điều hành mới. Quá trình này có thể mất vài phút.";
  }

  if (action === "cancel") {
    return "Đã gửi lệnh hủy VPS.";
  }

  return "Đã gửi lệnh lên VNCloud.";
}

function getSyncDelaysForAction(action: z.infer<typeof instanceActionSchema>["action"]) {
  if (action === "confirm-rebuild-vps") {
    return LONG_REBUILD_SYNC_DELAYS_MS;
  }

  return undefined;
}

function isActionAllowedForStatus(
  action: z.infer<typeof instanceActionSchema>["action"],
  status: string | null | undefined,
) {
  if (action === "on") {
    return isStoppedInstanceStatus(status);
  }

  if (action === "off" || action === "restart") {
    return isRunningInstanceStatus(status);
  }

  return true;
}

function getInvalidActionStatusMessage(
  action: z.infer<typeof instanceActionSchema>["action"],
  status: string | null | undefined,
) {
  const currentStatus = formatInstanceStatusLabel(status);

  if (isProcessingInstanceStatus(status)) {
    return `VPS đang ở trạng thái ${currentStatus}. Hệ thống cần đồng bộ xong trước khi gửi tiếp lệnh quản lý.`;
  }

  if (action === "on") {
    return `Chỉ có thể bật VPS đang ở trạng thái đã tắt. Trạng thái hiện tại là ${currentStatus}.`;
  }

  if (action === "off") {
    return `Chỉ có thể tắt VPS đang chạy. Trạng thái hiện tại là ${currentStatus}.`;
  }

  if (action === "restart") {
    return `Chỉ có thể khởi động lại VPS đang chạy. Trạng thái hiện tại là ${currentStatus}.`;
  }

  return `Trạng thái hiện tại (${currentStatus}) không phù hợp để thực hiện thao tác này.`;
}

function getProvisioningConfig(input: {
  baseCpu: number;
  baseRam: number;
  baseDisk: number;
  customCpu: number;
  customRam: number;
  customDisk: number;
  addonCpuPrice: number;
  addonRamPrice: number;
  addonDiskPrice: number;
  addonDiskStep: number;
}) {
  const addonDiskStep = Math.max(1, Number(input.addonDiskStep || 1));
  const customCpu = Math.max(0, Number(input.customCpu || 0));
  const customRam = Math.max(0, Number(input.customRam || 0));
  const customDisk = Math.max(0, Number(input.customDisk || 0));

  if (customDisk % addonDiskStep !== 0) {
    throw new AppError(
      `Dung lượng disk cộng thêm phải theo bậc ${addonDiskStep} GB.`,
      422,
    );
  }

  const addonPrice =
    customCpu * Number(input.addonCpuPrice || 0) +
    customRam * Number(input.addonRamPrice || 0) +
    (customDisk / addonDiskStep) * Number(input.addonDiskPrice || 0);

  return {
    totalCpu: Math.max(0, Number(input.baseCpu || 0)) + customCpu,
    totalRam: Math.max(0, Number(input.baseRam || 0)) + customRam,
    totalDisk: Math.max(0, Number(input.baseDisk || 0)) + customDisk,
    customCpu,
    customRam,
    customDisk,
    addonPrice,
  };
}

async function insertTransaction(
  connection: PoolConnection,
  userId: number,
  amount: number,
  balanceAfter: number,
  content: string,
  type: "order" | "refund",
) {
  await connection.execute(
    `INSERT INTO transactions (user_id, amount, balance_after, content, type, status)
     VALUES (?, ?, ?, ?, ?, 'success')`,
    [userId, amount, balanceAfter, content, type],
  );
}

const router = Router();

router.use(authMiddleware);

function createMissingSchemaError() {
  return new AppError(
    "Schema VPS trên backend đang thiếu bảng hoặc cột mới. Hãy restart backend để tự nâng schema, hoặc import lại `BE/database/vps_store_schema.sql`.",
    503,
  );
}

router.get(
  "/my",
  asyncHandler(async (request, response) => {
    const user = request.authUser!;
    const [orders, instances, transactions] = await Promise.all([
      queryRowsOrFallback<OrderRow[]>(
        `SELECT
           o.id,
           o.order_code,
           c.title,
           o.billing_cycle_code,
           o.unit_price,
           o.total_price,
           o.quantity,
           o.status,
           o.created_at,
           o.buyer_note,
           o.failure_reason
         FROM vps_orders o
         INNER JOIN vps_catalog_items c ON c.id = o.catalog_item_id
         WHERE o.user_id = ?
         ORDER BY o.created_at DESC`,
        [user.id],
        [],
      ),
      queryRowsOrFallback<InstanceRow[]>(
        `SELECT
           i.id,
           i.order_id,
           o.order_code,
           c.title,
           o.billing_cycle_code,
           o.created_at AS order_created_at,
           o.unit_price,
           o.total_price,
           o.quantity,
           i.vncloud_vps_id,
           i.ip_address,
           i.username,
           i.password,
           i.status,
           i.next_due_date,
           i.auto_renew,
           i.raw_payload,
           os.name AS operating_system_name,
           os.raw_payload AS operating_system_payload
         FROM vps_instances
         i
         LEFT JOIN vps_orders o ON o.id = i.order_id
         LEFT JOIN vps_catalog_items c ON c.id = o.catalog_item_id
         LEFT JOIN vps_remote_operating_systems os ON os.vncloud_os_id = o.vncloud_os_id
         WHERE i.user_id = ?
         ORDER BY i.created_at DESC`,
        [user.id],
        [],
      ),
      queryRowsOrFallback<TransactionRow[]>(
        `SELECT id, amount, balance_after, content, type, status, created_at
         FROM transactions
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 120`,
        [user.id],
        [],
      ),
    ]);

    let latestInstances = instances;
    const processingInstances = instances.filter((instance) =>
      isProcessingInstanceStatus(instance.status),
    );

    if (processingInstances.length > 0) {
      await Promise.allSettled([
        syncInstancesFromProvider(
          processingInstances.slice(0, 10).map((instance) => ({
            id: instance.id,
            vncloud_vps_id: instance.vncloud_vps_id,
          })),
        ),
      ]);

      latestInstances = await queryRowsOrFallback<InstanceRow[]>(
        `SELECT
           i.id,
           i.order_id,
           o.order_code,
           c.title,
           o.billing_cycle_code,
           o.created_at AS order_created_at,
           o.unit_price,
           o.total_price,
           o.quantity,
           i.vncloud_vps_id,
           i.ip_address,
           i.username,
           i.password,
           i.status,
           i.next_due_date,
           i.auto_renew,
           i.raw_payload,
           os.name AS operating_system_name,
           os.raw_payload AS operating_system_payload
         FROM vps_instances
         i
         LEFT JOIN vps_orders o ON o.id = i.order_id
         LEFT JOIN vps_catalog_items c ON c.id = o.catalog_item_id
         LEFT JOIN vps_remote_operating_systems os ON os.vncloud_os_id = o.vncloud_os_id
         WHERE i.user_id = ?
         ORDER BY i.created_at DESC`,
        [user.id],
        instances,
      );
    }

    latestInstances = latestInstances.map((instance) => ({
      ...instance,
      operating_system_name: resolveInstanceOperatingSystemName(
        typeof instance.raw_payload === "string" ? instance.raw_payload : null,
        typeof instance.operating_system_name === "string"
          ? instance.operating_system_name
          : null,
        typeof instance.operating_system_payload === "string"
          ? instance.operating_system_payload
          : null,
      ),
    }));

    const normalizedTransactions = transactions.map((transaction) => ({
      ...transaction,
      amount: Number(transaction.amount ?? 0),
      balance_after:
        transaction.balance_after === null ? null : Number(transaction.balance_after),
    }));

    const totalDeposited = normalizedTransactions.reduce((sum, transaction) => {
      if (transaction.type === "deposit" && transaction.status === "success") {
        return sum + Math.max(transaction.amount, 0);
      }

      return sum;
    }, 0);

    const totalSpent = normalizedTransactions.reduce((sum, transaction) => {
      if (transaction.type === "order" && transaction.status === "success") {
        return sum + Math.abs(Math.min(transaction.amount, 0));
      }

      return sum;
    }, 0);

    const activeInstances = latestInstances.filter((instance) => {
      const currentStatus = normalizeInstanceStatus(instance.status);
      return currentStatus !== "delete_vps" && currentStatus !== "expire";
    }).length;

    const expiredInstances = latestInstances.filter((instance) => {
      return normalizeInstanceStatus(instance.status) === "expire";
    }).length;

    const cancelledInstances = latestInstances.filter((instance) => {
      return normalizeInstanceStatus(instance.status) === "delete_vps";
    }).length;

    const enrichedOrders = orders.map((order) => ({
      ...order,
      failure_reason: getPublicOrderErrorMessage(order.failure_reason),
      instances: latestInstances.filter((instance) => instance.order_id === order.id),
    }));

    for (const instance of latestInstances) {
      if (isProcessingInstanceStatus(instance.status)) {
        scheduleInstanceSync(instance.id, instance.vncloud_vps_id);
      }
    }

    response.json({
      orders: enrichedOrders,
      instances: latestInstances,
      transactions: normalizedTransactions,
      summary: {
        total_orders: enrichedOrders.length,
        active_instances: activeInstances,
        expired_instances: expiredInstances,
        cancelled_instances: cancelledInstances,
        total_spent: totalSpent,
        total_deposited: totalDeposited,
        notifications: 0,
      },
    });
  }),
);

router.post(
  "/",
  asyncHandler(async (request, response) => {
    const user = request.authUser!;
    const payload = createOrderSchema.parse(request.body);

    if (!payload.acceptedPolicy) {
      throw new AppError("Bạn cần đồng ý Chính sách VPS trước khi thanh toán.", 422);
    }

    let userRows: UserBalanceRow[];
    let catalogRows: CatalogItemRow[];
    let settingsRows: SettingRow[];

    try {
      [userRows, catalogRows, settingsRows] = await Promise.all([
        queryRows<UserBalanceRow[]>(
          `SELECT id, username, balance, status
           FROM users
           WHERE id = ?
           LIMIT 1`,
          [user.id],
        ),
        queryRows<CatalogItemRow[]>(
          `SELECT
             c.id,
             c.title,
             c.sale_price,
             c.is_active,
             c.vncloud_product_id,
             c.billing_cycle_code,
             bc.months AS billing_cycle_months,
             c.vncloud_os_id,
             c.addon_cpu,
             c.addon_ram,
             c.addon_disk
           FROM vps_catalog_items c
           LEFT JOIN vps_remote_billing_cycles bc ON bc.cycle_code = c.billing_cycle_code
           WHERE c.id = ?
           LIMIT 1`,
          [payload.catalogItemId],
        ),
        queryRows<SettingRow[]>(
          `SELECT setting_key, setting_value
           FROM vps_store_settings`,
        ),
      ]);
    } catch (error) {
      if (isSchemaCompatibilityError(error)) {
        throw createMissingSchemaError();
      }

      throw error;
    }

    const userRow = userRows[0];
    const catalogItem = catalogRows[0];

    if (!userRow) {
      throw new AppError("Không tìm thấy tài khoản mua VPS.", 404);
    }

    if (userRow.status !== "active") {
      throw new AppError("Tài khoản của bạn đang bị khóa hoặc tạm dừng.", 403);
    }

    if (!catalogItem || catalogItem.is_active !== 1) {
      throw new AppError("Gói VPS này hiện không còn được mở bán.", 404);
    }

    const storeSettings = normalizeStoreSettings(
      Object.fromEntries(
        settingsRows.map((item) => [item.setting_key, item.setting_value ?? ""]),
      ),
    );
    const billingMonths = Math.max(1, Number(catalogItem.billing_cycle_months ?? 1));
    const provisioningConfig = getProvisioningConfig({
      baseCpu: Number(catalogItem.addon_cpu ?? 0),
      baseRam: Number(catalogItem.addon_ram ?? 0),
      baseDisk: Number(catalogItem.addon_disk ?? 0),
      customCpu: payload.customAddonCpu,
      customRam: payload.customAddonRam,
      customDisk: payload.customAddonDisk,
      addonCpuPrice: storeSettings.addon_cpu_price,
      addonRamPrice: storeSettings.addon_ram_price,
      addonDiskPrice: storeSettings.addon_disk_price,
      addonDiskStep: storeSettings.addon_disk_step,
    });
    const unitPrice =
      Number(catalogItem.sale_price) + provisioningConfig.addonPrice * billingMonths;
    const totalPrice = unitPrice * payload.quantity;

    if (Number(userRow.balance) < totalPrice) {
      throw new AppError("Số dư không đủ để thanh toán gói VPS này.", 400);
    }

    const orderCode = createOrderCode();
    const newBalance = Number(userRow.balance) - totalPrice;

    let order: { id: number };

    try {
      order = await withTransaction(async (connection) => {
        await connection.execute(
          `UPDATE users
           SET balance = ?
           WHERE id = ?`,
          [newBalance, user.id],
        );

        const [insertResult] = await connection.execute(
          `INSERT INTO vps_orders (
             order_code, user_id, catalog_item_id, vncloud_product_id, billing_cycle_code, vncloud_os_id,
             quantity, addon_cpu, addon_ram, addon_disk, unit_price, total_price, status, buyer_note
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?)`,
          [
            orderCode,
            user.id,
            catalogItem.id,
            catalogItem.vncloud_product_id,
            catalogItem.billing_cycle_code,
            catalogItem.vncloud_os_id,
            payload.quantity,
            provisioningConfig.totalCpu,
            provisioningConfig.totalRam,
            provisioningConfig.totalDisk,
            unitPrice,
            totalPrice,
            payload.note || null,
          ],
        );

        const insertId = (insertResult as { insertId: number }).insertId;
        await insertTransaction(
          connection,
          user.id,
          -totalPrice,
          newBalance,
          `[${user.username}] Đã mua: ${catalogItem.title}${
            provisioningConfig.customCpu > 0 ||
            provisioningConfig.customRam > 0 ||
            provisioningConfig.customDisk > 0
              ? ` | custom CPU +${provisioningConfig.customCpu}, RAM +${provisioningConfig.customRam}, Disk +${provisioningConfig.customDisk} GB`
              : ""
          }`,
          "order",
        );

        return {
          id: insertId,
        };
      });
    } catch (error) {
      if (isSchemaCompatibilityError(error)) {
        throw createMissingSchemaError();
      }

      throw error;
    }

    try {
      const vnCloudResponse = await vnCloudService.createOrder({
        "product-id": catalogItem.vncloud_product_id,
        "billing-cycle": catalogItem.billing_cycle_code,
        os: catalogItem.vncloud_os_id,
        quantity: payload.quantity,
        "addon-cpu": provisioningConfig.totalCpu,
        "addon-ram": provisioningConfig.totalRam,
        "addon-disk": provisioningConfig.totalDisk,
      });

      const services = Array.isArray(vnCloudResponse.data)
        ? (vnCloudResponse.data as Record<string, unknown>[])
        : [];

      await withTransaction(async (connection) => {
        await connection.execute(
          `UPDATE vps_orders
           SET status = 'active',
               agency_credit_after = ?,
               vncloud_response = ?
           WHERE id = ?`,
          [
            Number(vnCloudResponse.credit ?? 0),
            JSON.stringify(vnCloudResponse),
            order.id,
          ],
        );

        for (const service of services) {
          await connection.execute(
            `INSERT INTO vps_instances (
               order_id, user_id, vncloud_vps_id, ip_address, username, password, status, next_due_date, is_special, raw_payload
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               ip_address = VALUES(ip_address),
               username = VALUES(username),
               password = VALUES(password),
               status = VALUES(status),
               next_due_date = VALUES(next_due_date),
               is_special = VALUES(is_special),
               raw_payload = VALUES(raw_payload)`,
            [
              order.id,
              user.id,
              Number(service["vps-id"] ?? service.id ?? 0),
              service.ip ? String(service.ip) : null,
              service.username ? String(service.username) : null,
              service.password ? String(service.password) : null,
              normalizeInstanceStatus(
                typeof service["vps-status"] === "string" ? String(service["vps-status"]) : "progressing",
              ) ?? "progressing",
              service.next_due_date ? String(service.next_due_date) : null,
              Number(service["is-special"] ?? 0),
              JSON.stringify(service),
            ],
          );
        }
      });

      const insertedInstances = await queryRows<
        Array<
          RowDataPacket & {
            id: number;
            vncloud_vps_id: number;
            status: string;
          }
        >
      >(
        `SELECT id, vncloud_vps_id, status
         FROM vps_instances
         WHERE order_id = ?`,
        [order.id],
      );

      for (const instance of insertedInstances) {
        if (instance.vncloud_vps_id > 0) {
          scheduleInstanceSync(instance.id, instance.vncloud_vps_id, [1000, 4000, 10000, 30000, 60000]);
        }
      }

      response.status(201).json({
        message: "Đặt mua VPS thành công.",
        orderId: order.id,
        vncloud: vnCloudResponse,
      });
    } catch (error) {
      const rawFailureReason =
        error instanceof Error ? error.message : "Không thể provision VPS.";

      await withTransaction(async (connection) => {
        const latestUser = await connection.query<RowDataPacket[]>(
          `SELECT balance FROM users WHERE id = ? LIMIT 1`,
          [user.id],
        );
        const currentBalance = Number(latestUser[0][0]?.balance ?? newBalance);
        const refundedBalance = currentBalance + totalPrice;

        await connection.execute(
          `UPDATE users SET balance = ? WHERE id = ?`,
          [refundedBalance, user.id],
        );
        await connection.execute(
          `UPDATE vps_orders
           SET status = 'failed',
               failure_reason = ?
           WHERE id = ?`,
          [rawFailureReason, order.id],
        );
        await insertTransaction(
          connection,
          user.id,
          totalPrice,
          refundedBalance,
          `[${user.username}] Hoàn tiền đơn VPS lỗi`,
          "refund",
        );
      });

      const publicFailureReason =
        getPublicOrderErrorMessage(rawFailureReason) ?? "Không thể provision VPS.";

      if (publicFailureReason !== rawFailureReason) {
        throw new AppError(publicFailureReason, 503);
      }

      if (error instanceof AppError) {
        throw new AppError(publicFailureReason, error.statusCode);
      }

      throw new AppError(publicFailureReason, 400);
    }
  }),
);

router.get(
  "/resources",
  asyncHandler(async (_request, response) => {
    const operatingSystems = await queryRowsOrFallback<OperatingSystemResourceRow[]>(
      `SELECT vncloud_os_id, name, group_name, raw_payload, is_active
       FROM vps_remote_operating_systems
       WHERE is_active = 1
       ORDER BY name ASC`,
      [],
      [],
    );

    response.json({
      operatingSystems: operatingSystems.map((item) => ({
        vncloud_os_id: Number(item.vncloud_os_id),
        name:
          resolveOperatingSystemName(item.name, item.raw_payload) ||
          `Hệ điều hành #${item.vncloud_os_id}`,
        group_name: item.group_name,
        is_active: Number(item.is_active ?? 1),
      })),
    });
  }),
);

router.post(
  "/instances/:instanceId/action",
  asyncHandler(async (request, response) => {
    const user = request.authUser!;
    const payload = instanceActionSchema.parse(request.body);
    const instanceId = Number(request.params.instanceId);
    const instances = await queryRows<InstanceRow[]>(
      `SELECT id, order_id, vncloud_vps_id, ip_address, username, password, status, next_due_date, auto_renew
       FROM vps_instances
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
      [instanceId, user.id],
    );

    const instance = instances[0];

    if (!instance) {
      throw new AppError("Không tìm thấy VPS thuộc tài khoản của bạn.", 404);
    }

    if (
      (payload.action === "on" || payload.action === "off" || payload.action === "restart") &&
      !isActionAllowedForStatus(payload.action, instance.status)
    ) {
      scheduleInstanceSync(instance.id, instance.vncloud_vps_id);
      throw new AppError(getInvalidActionStatusMessage(payload.action, instance.status), 409, {
        currentStatus: instance.status,
      });
    }

    const actionPayload: Record<string, unknown> = {
      action: payload.action,
      "vps-id": instance.vncloud_vps_id,
    };

    if (payload.action === "confirm-rebuild-vps") {
      if (!payload.osId) {
        throw new AppError("Bạn cần chọn hệ điều hành mới để cài đặt lại VPS.", 400);
      }
      actionPayload["os-id"] = payload.osId;
    }

    let vnCloudResponse: Awaited<ReturnType<typeof vnCloudService.actionVps>>;

    try {
      vnCloudResponse = await vnCloudService.actionVps(actionPayload);
    } catch (error) {
      const errorMessage =
        error instanceof Error && error.message.trim()
          ? error.message
          : "Không thể gửi lệnh quản lý VPS lên nhà cung cấp.";

      await executeResult(
        `INSERT INTO vps_instance_logs (vps_instance_id, user_id, action, status, message, payload)
         VALUES (?, ?, ?, 'failed', ?, ?)`,
        [
          instance.id,
          user.id,
          payload.action,
          errorMessage,
          JSON.stringify({
            actionPayload,
            error:
              error instanceof AppError
                ? {
                    message: error.message,
                    statusCode: error.statusCode,
                    details: error.details,
                  }
                : {
                    message: errorMessage,
                  },
          }),
        ],
      );

      throw error;
    }

    await executeResult(
      `INSERT INTO vps_instance_logs (vps_instance_id, user_id, action, status, message, payload)
       VALUES (?, ?, ?, 'success', ?, ?)`,
      [
        instance.id,
        user.id,
        payload.action,
        String(vnCloudResponse.message ?? "Thực hiện thành công."),
        JSON.stringify(vnCloudResponse),
      ],
    );

    if (payload.action === "on-auto-renew" || payload.action === "off-auto-renew") {
      await executeResult(
        `UPDATE vps_instances
         SET auto_renew = ?
         WHERE id = ?`,
        [payload.action === "on-auto-renew" ? 1 : 0, instance.id],
      );
    }

    const optimisticStatus = getOptimisticInstanceStatus(payload.action);

    if (optimisticStatus) {
      await executeResult(
        `UPDATE vps_instances
         SET status = ?
         WHERE id = ?`,
        [optimisticStatus, instance.id],
      );
      scheduleInstanceSync(instance.id, instance.vncloud_vps_id, getSyncDelaysForAction(payload.action));
    }

    response.json({
      message: getActionSuccessMessage(payload.action),
      result: vnCloudResponse,
    });
  }),
);

router.get(
  "/instances/:instanceId/info",
  asyncHandler(async (request, response) => {
    const user = request.authUser!;
    const instanceId = Number(request.params.instanceId);
    const rows = await queryRows<RowDataPacket[]>(
      `SELECT id, vncloud_vps_id, raw_payload
       FROM vps_instances
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
      [instanceId, user.id],
    );

    const instance = rows[0];

    if (!instance) {
      throw new AppError("Không tìm thấy VPS thuộc tài khoản của bạn.", 404);
    }

    const detail = await vnCloudService.getVpsInfo(Number(instance.vncloud_vps_id));

    response.json({
      cached: safeJsonParse(instance.raw_payload, {}),
      live: detail,
    });
  }),
);

router.post(
  "/:orderId/request-refund",
  asyncHandler(async (request, response) => {
    const user = request.authUser!;
    const orderId = Number(request.params.orderId);

    const [orderRows] = await withTransaction(async (connection) => {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT o.id, o.user_id, o.total_price, o.status, o.refund_requested_at
         FROM vps_orders o
         WHERE o.id = ? AND o.user_id = ?
         FOR UPDATE`,
        [orderId, user.id],
      );
      return rows as OrderRow[];
    });

    const order = orderRows[0];

    if (!order) {
      throw new AppError("Không tìm thành đơn hàng thuộc tài khoản của bạn.", 404);
    }

    if (order.status !== "active") {
      throw new AppError("Chỉ có thể yêu cầu hoàn tiền cho đơn hàng đang hoạt động.", 400);
    }

    if (order.refund_requested_at) {
      throw new AppError("Đơn hàng này đã được yêu cầu hoàn tiền trước đó.", 400);
    }

    const instanceRows = await queryRows<InstanceRow[]>(
      `SELECT id, status, vncloud_vps_id
       FROM vps_instances
       WHERE order_id = ?`,
      [orderId],
    );

    const activeInstances = instanceRows.filter((inst) => {
      const status = String(inst.status ?? "").toLowerCase();
      return !/(cancelled?|failed?|delete|terminate)/i.test(status);
    });

    if (activeInstances.length > 0) {
      throw new AppError(
        "Vui lòng hủy tất cả VPS trước khi yêu cầu hoàn tiền. Các VPS đang hoạt động cần được xóa trước.",
        400,
      );
    }

    const refundAmount = Number(order.total_price);

    await withTransaction(async (connection) => {
      const [userRows] = await connection.query<RowDataPacket[]>(
        `SELECT balance FROM users WHERE id = ? FOR UPDATE`,
        [user.id],
      );
      const currentBalance = Number(userRows[0]?.balance ?? 0);
      const newBalance = currentBalance + refundAmount;

      await connection.execute(
        `UPDATE users SET balance = ? WHERE id = ?`,
        [newBalance, user.id],
      );

      await connection.execute(
        `UPDATE vps_orders
         SET status = 'refund_requested',
             refund_requested_at = NOW(),
             refund_amount = ?
         WHERE id = ?`,
        [refundAmount, orderId],
      );

      await connection.execute(
        `INSERT INTO transactions (user_id, amount, balance_after, content, type, status)
         VALUES (?, ?, ?, ?, 'refund', 'success')`,
        [user.id, refundAmount, newBalance, `[${user.username}] Yêu cầu hoàn tiền đơn hàng #${orderId}`],
      );
    });

    response.json({
      message: `Yêu cầu hoàn tiền thành công. Số tiền ${formatCurrency(refundAmount)} đã được hoàn vào tài khoản.`,
      refundAmount,
    });
  }),
);

export default router;
