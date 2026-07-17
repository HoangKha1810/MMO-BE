import { AppError } from "../../utils/app-error.js";
import { env } from "../../config/env.js";

type HttpMethod = "GET" | "POST";
type VnCloudResponseEnvelope = {
  error?: number | string;
  message?: string;
};

class VnCloudService {
  private cachedToken: {
    value: string;
    expiresAt: number;
    refreshAt: number;
  } | null = null;
  private tokenPromise: Promise<string> | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  private get apiApp() {
    return env.VNCLOUD_API_PASSWORD;
  }

  private get apiSecret() {
    return env.VNCLOUD_API_TOKEN;
  }

  private get hasCredentials() {
    return Boolean(
      env.VNCLOUD_API_USERNAME &&
        this.apiApp &&
        this.apiSecret,
    );
  }

  private clearRefreshTimer() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private clearCachedToken() {
    this.cachedToken = null;
    this.clearRefreshTimer();
  }

  private get tokenRotationHours() {
    const parsed = env.VNCLOUD_TOKEN_ROTATION_HOURS
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 23);

    return parsed.length > 0
      ? [...new Set(parsed)].sort((left, right) => left - right)
      : [2, 14];
  }

  private getTimeZoneParts(date: Date) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: env.VNCLOUD_TOKEN_TIMEZONE,
      hour12: false,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const mapped = Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    ) as Record<string, string>;

    return {
      year: Number(mapped.year),
      month: Number(mapped.month),
      day: Number(mapped.day),
      hour: Number(mapped.hour),
      minute: Number(mapped.minute),
      second: Number(mapped.second),
    };
  }

  private zonedDateTimeToUtcMillis(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
  ) {
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, 0);
    const actual = this.getTimeZoneParts(new Date(utcGuess));
    const actualUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      0,
    );

    return utcGuess - (actualUtc - utcGuess);
  }

  private getNextRotationAt(fromMillis = Date.now()) {
    const candidates = [0, 1, 2]
      .flatMap((dayOffset) => {
        const base = this.getTimeZoneParts(
          new Date(fromMillis + dayOffset * 24 * 60 * 60 * 1000),
        );

        return this.tokenRotationHours.map((hour) =>
          this.zonedDateTimeToUtcMillis(
            base.year,
            base.month,
            base.day,
            hour,
            0,
            0,
          ),
        );
      })
      .filter((timestamp) => timestamp > fromMillis + 1000)
      .sort((left, right) => left - right);

    return candidates[0] ?? null;
  }

  private shouldRetryWithFreshToken(
    status: number,
    data: VnCloudResponseEnvelope,
  ) {
    const normalizedMessage = `${data.message ?? ""}`.toLowerCase();

    return (
      status === 401 ||
      status === 403 ||
      normalizedMessage.includes("auth token") ||
      normalizedMessage.includes("auth-token") ||
      normalizedMessage.includes("mã kết nối") ||
      normalizedMessage.includes("ma ket noi")
    );
  }

  private buildTokenLifetime(now = Date.now()) {
    const nextRotationAt = this.getNextRotationAt(now);

    if (!nextRotationAt) {
      const expiresAt = now + env.VNCLOUD_TOKEN_CACHE_MINUTES * 60 * 1000;

      return {
        expiresAt,
        refreshAt: Math.max(
          now + 5 * 60 * 1000,
          expiresAt - env.VNCLOUD_TOKEN_REFRESH_AHEAD_MINUTES * 60 * 1000,
        ),
      };
    }

    const refreshAheadMs =
      env.VNCLOUD_TOKEN_REFRESH_AHEAD_MINUTES * 60 * 1000;
    const refreshAt =
      nextRotationAt - now > refreshAheadMs
        ? nextRotationAt - refreshAheadMs
        : nextRotationAt + 30 * 1000;

    return {
      expiresAt: nextRotationAt + 2 * 60 * 1000,
      refreshAt,
    };
  }

  private scheduleTokenRefresh() {
    this.clearRefreshTimer();

    if (!this.cachedToken || !this.hasCredentials) {
      return;
    }

    const safeDelay = Math.max(
      this.cachedToken.refreshAt - Date.now(),
      30 * 1000,
    );

    this.refreshTimer = setTimeout(() => {
      void this.refreshTokenInBackground();
    }, safeDelay);

    this.refreshTimer.unref?.();
  }

  private async refreshTokenInBackground() {
    try {
      await this.getTokenInternal(true);
    } catch (error) {
      console.warn(
        "Không thể làm mới token VNCloud theo lịch.",
        error instanceof Error ? error.message : error,
      );

      this.refreshTimer = setTimeout(() => {
        void this.refreshTokenInBackground();
      }, 15 * 60 * 1000);
      this.refreshTimer.unref?.();
    }
  }

  private buildHeaders(authToken?: string) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "api-username": env.VNCLOUD_API_USERNAME,
      "api-app": this.apiApp,
      "api-secret": this.apiSecret,
    };

    if (authToken) {
      headers["auth-token"] = authToken;
    }

    return headers;
  }

  private buildUrl(path: string, payload?: Record<string, unknown>) {
    const url = new URL(path, env.VNCLOUD_BASE_URL);

    if (payload) {
      for (const [key, rawValue] of Object.entries(payload)) {
        if (rawValue === undefined || rawValue === null || rawValue === "") {
          continue;
        }

        if (Array.isArray(rawValue)) {
          url.searchParams.set(key, rawValue.join(","));
          continue;
        }

        url.searchParams.set(key, String(rawValue));
      }
    }

    return url.toString();
  }

  private async request<T>(
    method: HttpMethod,
    path: string,
    payload?: Record<string, unknown>,
    requireToken = true,
    retriedWithFreshToken = false,
  ): Promise<T> {
    if (!this.hasCredentials) {
      throw new AppError(
        "Bạn chưa điền đủ VNCLOUD_API_USERNAME, VNCLOUD_API_PASSWORD, VNCLOUD_API_TOKEN trong file .env.",
        503,
      );
    }

    const authToken = requireToken ? await this.getToken() : undefined;
    const response = await fetch(
      method === "GET" ? this.buildUrl(path, payload) : this.buildUrl(path),
      {
        method,
        headers: this.buildHeaders(authToken),
        body: method === "POST" ? JSON.stringify(payload ?? {}) : undefined,
      },
    );

    const text = await response.text();
    let data: T & VnCloudResponseEnvelope;

    try {
      data = JSON.parse(text) as T & VnCloudResponseEnvelope;
    } catch {
      throw new AppError("VNCloud trả về dữ liệu không hợp lệ.", 502, text);
    }

    if (
      requireToken &&
      !retriedWithFreshToken &&
      this.shouldRetryWithFreshToken(response.status, data)
    ) {
      this.clearCachedToken();
      await this.getTokenInternal(true);

      return this.request<T>(method, path, payload, requireToken, true);
    }

    if (!response.ok) {
      throw new AppError(
        data.message || "Không thể kết nối tới VNCloud.",
        response.status,
        data,
      );
    }

    const errorCode =
      typeof data.error === "string"
        ? Number.parseInt(data.error, 10)
        : data.error;

    if (typeof errorCode === "number" && !Number.isNaN(errorCode) && errorCode !== 0) {
      throw new AppError(
        data.message || "VNCloud trả về lỗi nghiệp vụ.",
        400,
        data,
      );
    }

    return data;
  }

  async getToken() {
    return this.getTokenInternal(false);
  }

  async warmToken() {
    if (!this.hasCredentials) {
      return null;
    }

    return this.getTokenInternal(false);
  }

  private async getTokenInternal(forceRefresh: boolean) {
    const now = Date.now();

    if (
      !forceRefresh &&
      this.cachedToken &&
      this.cachedToken.expiresAt > now + 15 * 1000
    ) {
      return this.cachedToken.value;
    }

    if (this.tokenPromise) {
      return this.tokenPromise;
    }

    this.tokenPromise = (async () => {
      const data = await this.request<{ "auth-token": string }>(
        "POST",
        "/api/agency/get-token",
        {
          "api-username": env.VNCLOUD_API_USERNAME,
          "api-app": this.apiApp,
          "api-secret": this.apiSecret,
        },
        false,
      );

      if (!data["auth-token"]) {
        throw new AppError("VNCloud không trả về auth-token hợp lệ.", 502, data);
      }

      const lifetime = this.buildTokenLifetime(Date.now());

      this.cachedToken = {
        value: data["auth-token"],
        expiresAt: lifetime.expiresAt,
        refreshAt: lifetime.refreshAt,
      };

      this.scheduleTokenRefresh();
      return data["auth-token"];
    })();

    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }

  async getAgencyInfo() {
    return this.request<{
      data?: Record<string, unknown>;
      message?: string;
    }>("GET", "/api/agency/get-info");
  }

  async getProducts() {
    return this.request<{ products: unknown }>("GET", "/api/agency/get-product");
  }

  async getOperatingSystems() {
    return this.request<{ "os-vps": unknown }>(
      "GET",
      "/api/agency/get-list-os",
    );
  }

  async getBillingCycles() {
    return this.request<{ "billing-cycle": unknown }>(
      "GET",
      "/api/agency/get-list-billing-cycle",
    );
  }

  async createOrder(payload: {
    "product-id": number;
    "billing-cycle": string;
    os: number;
    quantity: number;
    "addon-cpu": number;
    "addon-ram": number;
    "addon-disk": number;
  }) {
    return this.request<{
      credit?: number;
      total?: number;
      data?: Record<string, unknown>[];
      message?: string;
    }>("POST", "/api/agency/order/create-order", payload);
  }

  async getVpsList(payload?: { type?: string; qtt?: number; page?: number }) {
    return this.request<{ "list-service": unknown }>(
      "GET",
      "/api/agency/vps/get-list-vps",
      payload,
    );
  }

  async getVpsInfo(vpsId: number | number[]) {
    return this.request<{ data?: unknown; message?: string }>(
      "GET",
      "/api/agency/vps/get-info-vps",
      {
        "vps-id": Array.isArray(vpsId) ? vpsId : [vpsId],
      },
    );
  }

  async actionVps(payload: Record<string, unknown>) {
    return this.request<{ message?: string; [key: string]: unknown }>(
      "POST",
      "/api/agency/vps/action-vps",
      payload,
    );
  }
}

export const vnCloudService = new VnCloudService();
