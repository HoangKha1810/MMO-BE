import { env } from "../config/env.js";

export function buildPublicAssetUrl(pathname: string | null | undefined) {
  if (!pathname) {
    return null;
  }

  if (/^https?:\/\//i.test(pathname)) {
    return pathname;
  }

  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return new URL(normalizedPath, env.PUBLIC_ASSET_BASE_URL).toString();
}
