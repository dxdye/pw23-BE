const Accounts = ["dxdye", "d2tsb"];

export type GithubCrawlerInfo = {
  html_url: string;
  full_name: string;
  description: string;
  pushed_at: string;
  language: string;
};
export type GitHubApiRepositories = GithubCrawlerInfo[];

export type CacheEntry<T = unknown> = {
  url: string;
  data: T;
  updatedAt: Date;
};

export type Repository = {
  name: string;
  account: string;
};

export type ActivityRecord = Map<Repository, number[]>;
