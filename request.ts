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

export const getData = <S = unknown>(url: string): Promise<S> =>
  fetch(url, { method: "GET", headers: buildHeaders() }).then((res) =>
    res.json(),
  );
