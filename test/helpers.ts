import { stub } from "@std/testing/mock";
import type { GithubCrawlerInfo } from "../src/types.ts";

/** Eine Repo-Antwort in der Rohform, die GitHub tatsächlich liefert. */
export const rawRepo = (
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  id: 1309356314,
  node_id: "R_kgDOTgsxGg",
  name: "blackhole",
  full_name: "dxdye/blackhole",
  private: false,
  owner: { login: "dxdye", id: 1621217, type: "User" },
  html_url: "https://github.com/dxdye/blackhole",
  description: "demo",
  fork: false,
  // Stellvertretend für die 43 URL-Templates, die GitHub pro Repo mitschickt.
  archive_url: "https://api.github.com/repos/dxdye/blackhole/{archive_format}",
  assignees_url:
    "https://api.github.com/repos/dxdye/blackhole/assignees{/user}",
  blobs_url: "https://api.github.com/repos/dxdye/blackhole/git/blobs{/sha}",
  created_at: "2024-08-06T10:00:00Z",
  updated_at: "2026-08-01T10:00:00Z",
  pushed_at: "2026-08-01T09:00:00Z",
  size: 1234,
  stargazers_count: 3,
  forks_count: 1,
  language: "TypeScript",
  archived: false,
  topics: ["demo"],
  ...overrides,
});

export const summary = (
  overrides: Partial<GithubCrawlerInfo> = {},
): GithubCrawlerInfo => ({
  id: 1309356314,
  name: "blackhole",
  full_name: "dxdye/blackhole",
  html_url: "https://github.com/dxdye/blackhole",
  description: "demo",
  language: "TypeScript",
  created_at: "2024-08-06T10:00:00Z",
  pushed_at: "2026-08-01T09:00:00Z",
  updated_at: "2026-08-01T10:00:00Z",
  stargazers_count: 3,
  forks_count: 1,
  size: 1234,
  archived: false,
  fork: false,
  topics: ["demo"],
  ...overrides,
});

export type StubbedResponse = {
  status?: number;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
};

export type FetchRecorder = {
  /** Alle angefragten URLs, in Reihenfolge. */
  urls: string[];
  /** Die Header jedes Requests, in Reihenfolge. */
  headers: Headers[];
  calls: number;
  restore: () => void;
};

/**
 * Ersetzt `globalThis.fetch` durch eine Abfolge vorgegebener Antworten.
 * Reicht die Abfolge nicht, wird die letzte wiederholt.
 */
export const stubFetch = (
  responses: StubbedResponse[] | ((url: string) => StubbedResponse),
): FetchRecorder => {
  const urls: string[] = [];
  const headers: Headers[] = [];

  const fetchStub = stub(
    globalThis,
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      urls.push(url);
      headers.push(new Headers(init?.headers));

      const spec = typeof responses === "function"
        ? responses(url)
        : responses[Math.min(urls.length - 1, responses.length - 1)];

      const body = spec.rawBody ??
        (spec.body === undefined ? "" : JSON.stringify(spec.body));
      const status = spec.status ?? 200;

      return Promise.resolve(
        new Response(status === 304 || status === 204 ? null : body, {
          status,
          headers: { "Content-Type": "application/json", ...spec.headers },
        }),
      );
    },
  );

  return {
    urls,
    headers,
    get calls() {
      return urls.length;
    },
    restore: () => fetchStub.restore(),
  };
};

/** Führt `fn` aus und stellt `fetch` danach in jedem Fall wieder her. */
export const withFetch = async <T>(
  responses: StubbedResponse[] | ((url: string) => StubbedResponse),
  fn: (recorder: FetchRecorder) => Promise<T> | T,
): Promise<T> => {
  const recorder = stubFetch(responses);
  try {
    return await fn(recorder);
  } finally {
    recorder.restore();
  }
};
