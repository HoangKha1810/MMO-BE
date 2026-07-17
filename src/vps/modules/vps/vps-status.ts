export type InstanceStatusKey =
  | "on"
  | "off"
  | "progressing"
  | "waiting"
  | "rebuild"
  | "expire"
  | "delete_vps"
  | "starting"
  | "stopping"
  | "restarting"
  | "unknown";

function normalizeStatusInput(status: string | null | undefined) {
  return String(status ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_");
}

export function normalizeInstanceStatus(status: string | null | undefined) {
  const normalized = normalizeStatusInput(status);

  if (!normalized) {
    return null;
  }

  if (["on", "running", "active", "online", "created", "success"].includes(normalized)) {
    return "on";
  }

  if (["off", "stop", "stopped", "offline", "shut"].includes(normalized)) {
    return "off";
  }

  if (["progressing", "processing", "provision", "provisioning", "queue", "new", "creating"].includes(normalized)) {
    return "progressing";
  }

  if (["waiting", "pending", "wait"].includes(normalized)) {
    return "waiting";
  }

  if (["rebuild", "rebuilding", "reinstall", "reinstalling"].includes(normalized)) {
    return "rebuild";
  }

  if (["expire", "expired", "suspend", "het_han", "hết_hạn"].includes(normalized)) {
    return "expire";
  }

  if (["delete_vps", "deleted", "delete", "cancel", "cancelled", "terminate", "failed"].includes(normalized)) {
    return "delete_vps";
  }

  if (["starting", "powering_on", "booting"].includes(normalized)) {
    return "starting";
  }

  if (["stopping", "shutting_down", "powering_off"].includes(normalized)) {
    return "stopping";
  }

  if (["restarting", "rebooting"].includes(normalized)) {
    return "restarting";
  }

  return normalized;
}

export function isRunningInstanceStatus(status: string | null | undefined) {
  return normalizeInstanceStatus(status) === "on";
}

export function isStoppedInstanceStatus(status: string | null | undefined) {
  return normalizeInstanceStatus(status) === "off";
}

export function isProcessingInstanceStatus(status: string | null | undefined) {
  return ["progressing", "waiting", "rebuild", "starting", "stopping", "restarting"].includes(
    normalizeInstanceStatus(status) ?? "",
  );
}

export function formatInstanceStatusLabel(status: string | null | undefined) {
  const normalized = normalizeInstanceStatus(status);

  if (!normalized) {
    return "đang chờ tạo";
  }

  if (normalized === "progressing") {
    return "đang tạo";
  }

  if (normalized === "waiting") {
    return "đang chờ tạo";
  }

  if (normalized === "on") {
    return "bật";
  }

  if (normalized === "off") {
    return "tắt";
  }

  if (normalized === "rebuild") {
    return "đang cài lại";
  }

  if (normalized === "expire") {
    return "hết hạn";
  }

  if (normalized === "delete_vps") {
    return "đã xóa";
  }

  if (normalized === "starting") {
    return "đang bật VPS";
  }

  if (normalized === "stopping") {
    return "đang tắt VPS";
  }

  if (normalized === "restarting") {
    return "đang khởi động lại";
  }

  return normalized.replace(/_/g, " ");
}
