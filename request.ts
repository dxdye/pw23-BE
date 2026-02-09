const DEFAULT_HEADERS: HeadersInit = {
  Accept: "application/vnd.github+json",
  "User-Agent": "pw23-backend-cache",
};

const buildHeaders = (): HeadersInit => {
  const token = Deno.env.get("GITHUB_TOKEN");
  if (!token) return DEFAULT_HEADERS;
  return {
    ...DEFAULT_HEADERS,
    Authorization: `Bearer ${token}`,
  };
};

export const getData = async <S = unknown>(url: string): Promise<S> => {
  const response = await fetch(url, { method: "GET", headers: buildHeaders() });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(
      `GitHub API error ${response.status}: ${message || response.statusText}`,
    );
  }
  return response.json();
};
