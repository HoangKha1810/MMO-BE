import { NextFunction, Request, Response, Router } from "express";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import { bootstrapVpsStoreSchema } from "./db/bootstrap.js";
import { isSchemaCompatibilityError, queryRows } from "./db/pool.js";
import { createIpRateLimit } from "./middleware/ip-rate-limit.js";
import adminRoutes from "./modules/admin/admin.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import catalogRoutes from "./modules/catalog/catalog.routes.js";
import orderRoutes from "./modules/orders/orders.routes.js";
import { syncVnCloudCatalog } from "./modules/vncloud/vncloud-catalog-sync.js";
import { vnCloudService } from "./modules/vncloud/vncloud.service.js";
import { AppError } from "./utils/app-error.js";

let startupPromise: Promise<void> | null = null;

export function createVpsRouter() {
  const router = Router();
  const apiRateLimit = createIpRateLimit({
    scope: "vps-api",
    windowMs: env.API_RATE_LIMIT_WINDOW_MS,
    maxRequests: env.API_RATE_LIMIT_MAX,
    message: "Bạn đang gửi quá nhiều request. Vui lòng chờ ít giây rồi thử lại.",
  });
  const authRateLimit = createIpRateLimit({
    scope: "vps-auth",
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
    maxRequests: env.AUTH_RATE_LIMIT_MAX,
    message: "Bạn đang thử đăng nhập hoặc đăng ký quá nhiều lần. Vui lòng đợi thêm rồi thử lại.",
  });

  router.get("/health", async (_request, response, next) => {
    try {
      await queryRows("SELECT 1 AS ok");
      response.json({
        status: "ok",
        module: "vps",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.use(apiRateLimit);
  router.use("/auth", authRateLimit, authRoutes);
  router.use("/catalog", catalogRoutes);
  router.use("/orders", orderRoutes);
  router.use("/admin", adminRoutes);

  router.use((_request, response) => {
    response.status(404).json({
      message: "Không tìm thấy endpoint VPS.",
    });
  });

  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      response.status(422).json({
        message: "Dữ liệu gửi lên không hợp lệ.",
        issues: error.issues,
      });
      return;
    }

    if (error instanceof AppError) {
      response.status(error.statusCode).json({
        message: error.message,
        details: error.details,
      });
      return;
    }

    if (isSchemaCompatibilityError(error)) {
      response.status(503).json({
        message:
          "Schema VPS trên backend đang thiếu bảng hoặc cột mới. Hãy restart backend để tự nâng schema, hoặc import lại `BE/database/vps_store_schema.sql`.",
      });
      return;
    }

    console.error(error);
    response.status(500).json({
      message: "Máy chủ gặp lỗi không mong muốn.",
    });
  });

  return router;
}

async function bootstrapIntegratedVpsBackend() {
  console.log(
    `[vps/env] MYSQL_HOST=${env.MYSQL_HOST} MYSQL_PORT=${env.MYSQL_PORT} MYSQL_DATABASE=${env.MYSQL_DATABASE} MYSQL_USER=${env.MYSQL_USER}`,
  );

  try {
    await bootstrapVpsStoreSchema();
    console.log("[vps] Đã kiểm tra và khởi tạo schema VPS nếu cần.");
  } catch (error) {
    console.warn(
      "[vps] Không thể khởi tạo schema VPS tự động. Backend web vẫn tiếp tục chạy.",
      error instanceof Error ? error.message : error,
    );
  }

  try {
    const token = await vnCloudService.warmToken();

    if (token) {
      console.log("[vps] Đã khởi động bộ nhớ đệm hoặc xác thực trực tiếp VNCloud.");
    } else {
      console.warn("[vps] Chưa cấu hình đủ credential VNCloud. Catalog sẽ rỗng cho tới khi đồng bộ lại.");
    }
  } catch (error) {
    console.warn("[vps] Chưa làm nóng được token VNCloud lúc khởi động.", error instanceof Error ? error.message : error);
  }

  try {
    const synced = await syncVnCloudCatalog({
      ensureListings: true,
    });

    if (synced.products > 0 || synced.totalCatalogItems > 0) {
      console.log(
        `[vps] Đã đồng bộ catalog VNCloud. products=${synced.products}, os=${synced.operatingSystems}, billing=${synced.billingCycles}, createdListings=${synced.autoCatalogItems}, totalListings=${synced.totalCatalogItems}, activeListings=${synced.activeCatalogItems}`,
      );
    } else {
      console.warn("[vps] Đồng bộ VNCloud chưa lấy được sản phẩm nào. Kiểm tra credential hoặc response từ VNCloud.");
    }
  } catch (error) {
    console.warn("[vps] Chưa đồng bộ được catalog VNCloud lúc khởi động.", error instanceof Error ? error.message : error);
  }
}

export function startIntegratedVpsBackend() {
  if (!startupPromise) {
    startupPromise = bootstrapIntegratedVpsBackend();
  }

  return startupPromise;
}

