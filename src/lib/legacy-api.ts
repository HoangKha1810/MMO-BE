function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function normalizeEndpoint(endpoint: string) {
  const trimmed = endpoint.trim();

  if (!trimmed) {
    throw new Error('Endpoint không được để trống');
  }

  if (/^https?:\/\//i.test(trimmed)) {
    throw new Error('Chỉ cho phép endpoint tương đối của API legacy');
  }

  return `/${trimmed.replace(/^\/+/, '')}`;
}

export function getLegacyApiConfig() {
  return {
    domain: trimTrailingSlash(process.env.API_DOMAIN?.trim() || 'https://trungtammmo.vn'),
    apiKey: process.env.API_KEY?.trim() || '',
  };
}

export async function callLegacyApi<T = unknown>(input: {
  endpoint: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  data?: Record<string, unknown> | null;
}) {
  const config = getLegacyApiConfig();
  const method = input.method || 'GET';
  const url = new URL(normalizeEndpoint(input.endpoint), `${config.domain}/`);
  const headers = new Headers({
    Accept: 'application/json',
  });

  if (config.apiKey) {
    headers.set('api-token', config.apiKey);
  }

  let body: string | undefined;
  if (method === 'GET') {
    Object.entries(input.data || {}).forEach(([key, value]) => {
      if (value === undefined || value === null) {
        return;
      }

      url.searchParams.set(key, String(value));
    });
  } else {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(input.data || {});
  }

  const response = await fetch(url, {
    method,
    headers,
    body,
  });

  const rawText = await response.text();
  let payload: T | string | null = null;

  if (rawText) {
    try {
      payload = JSON.parse(rawText) as T;
    } catch {
      payload = rawText;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    data: payload,
  };
}
