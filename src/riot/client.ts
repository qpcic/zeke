import { parseLimitHeader, SlidingWindowLimiter, type Window } from './rateLimiter.ts';
import { accountRegion, matchRegion, type Platform } from './regions.ts';
import type { AccountDto, ChampionMasteryDto, LeagueEntryDto, LeagueListDto, MatchDto, SummonerDto } from './types.ts';

/**
 * PUUIDs are encrypted per API key's app. After switching keys (e.g. dev -> personal),
 * stored PUUIDs fail with 400 "Exception decrypting ...". Callers re-resolve by Riot ID.
 */
export function isStalePuuidError(e: unknown): boolean {
  return e instanceof RiotApiError && e.status === 400 && /decrypt/i.test(e.body);
}

export class RiotApiError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`Riot API ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}

export interface RiotClientOptions {
  apiKey: string;
  /** Override for tests: maps a routing host ("europe", "euw1") to a base URL. */
  baseUrl?: (host: string) => string;
  fetch?: typeof fetch;
  /** Initial app limit before the first response tells us the real one. Dev/personal keys: 20/1s, 100/2min. */
  defaultAppLimit?: Window[];
  maxRetries?: number;
  log?: (msg: string) => void;
}

const DEFAULT_APP_LIMIT: Window[] = [
  { count: 20, windowMs: 1_000 },
  { count: 100, windowMs: 120_000 },
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RiotClient {
  private readonly appLimiters = new Map<string, SlidingWindowLimiter>();
  private readonly methodLimiters = new Map<string, SlidingWindowLimiter>();
  private readonly baseUrl: (host: string) => string;
  private readonly fetchFn: typeof fetch;
  private readonly maxRetries: number;
  private readonly log: (msg: string) => void;
  /** Total HTTP requests sent; handy for budgeting. */
  requestCount = 0;

  constructor(private readonly opts: RiotClientOptions) {
    this.baseUrl = opts.baseUrl ?? ((host) => `https://${host}.api.riotgames.com`);
    this.fetchFn = opts.fetch ?? fetch;
    this.maxRetries = opts.maxRetries ?? 4;
    this.log = opts.log ?? (() => {});
  }

  private appLimiter(host: string): SlidingWindowLimiter {
    let l = this.appLimiters.get(host);
    if (!l) {
      l = new SlidingWindowLimiter(this.opts.defaultAppLimit ?? DEFAULT_APP_LIMIT);
      this.appLimiters.set(host, l);
    }
    return l;
  }

  private methodLimiter(key: string): SlidingWindowLimiter {
    let l = this.methodLimiters.get(key);
    if (!l) {
      l = new SlidingWindowLimiter([]); // unknown until first response headers
      this.methodLimiters.set(key, l);
    }
    return l;
  }

  /**
   * @param host     routing value, lowercase ("europe", "euw1")
   * @param method   stable endpoint key for method limits, e.g. "match-v5.getMatch"
   * @param path     path incl. leading slash, already URL-encoded
   * @returns parsed JSON, or null on 404
   */
  async request<T>(host: string, method: string, path: string, query?: Record<string, string | number | undefined>): Promise<T | null> {
    const qs = query
      ? '?' + Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
      : '';
    const url = `${this.baseUrl(host)}${path}${qs === '?' ? '' : qs}`;
    const app = this.appLimiter(host);
    const meth = this.methodLimiter(`${host}:${method}`);

    for (let attempt = 0; ; attempt++) {
      await app.acquire();
      await meth.acquire();
      this.requestCount++;

      let res: Response;
      try {
        res = await this.fetchFn(url, { headers: { 'X-Riot-Token': this.opts.apiKey, Accept: 'application/json' } });
      } catch (err) {
        if (attempt >= this.maxRetries) throw err;
        const backoff = 500 * 2 ** attempt;
        this.log(`network error on ${method}, retry in ${backoff}ms: ${(err as Error).message}`);
        await sleep(backoff);
        continue;
      }

      const appHdr = parseLimitHeader(res.headers.get('x-app-rate-limit'));
      if (appHdr) app.setWindows(appHdr);
      const methHdr = parseLimitHeader(res.headers.get('x-method-rate-limit'));
      if (methHdr) meth.setWindows(methHdr);

      if (res.ok) return (await res.json()) as T;
      if (res.status === 404) return null;

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '1');
        const ms = (Number.isFinite(retryAfter) ? retryAfter : 1) * 1000;
        const type = res.headers.get('x-rate-limit-type') ?? 'service';
        // application/method: we hit our own budget (limits changed, or another process uses the key).
        // service: Riot backend throttling, no Retry-After guaranteed.
        if (type === 'application') app.block(ms);
        else if (type === 'method') meth.block(ms);
        this.log(`429 (${type}) on ${method}, waiting ${ms}ms`);
        if (attempt >= this.maxRetries) throw new RiotApiError(429, url, await res.text());
        await sleep(type === 'service' ? Math.max(ms, 1000 * 2 ** attempt) : ms);
        continue;
      }

      if (res.status >= 500 && attempt < this.maxRetries) {
        const backoff = 1000 * 2 ** attempt;
        this.log(`${res.status} on ${method}, retry in ${backoff}ms`);
        await sleep(backoff);
        continue;
      }

      throw new RiotApiError(res.status, url, await res.text());
    }
  }

  // ---- endpoints ----

  getAccountByRiotId(platform: Platform, gameName: string, tagLine: string) {
    return this.request<AccountDto>(
      accountRegion(platform),
      'account-v1.byRiotId',
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
    );
  }

  getAccountByPuuid(platform: Platform, puuid: string) {
    return this.request<AccountDto>(accountRegion(platform), 'account-v1.byPuuid', `/riot/account/v1/accounts/by-puuid/${puuid}`);
  }

  async getLeagueEntries(platform: Platform, puuid: string): Promise<LeagueEntryDto[]> {
    return (await this.request<LeagueEntryDto[]>(platform.toLowerCase(), 'league-v4.byPuuid', `/lol/league/v4/entries/by-puuid/${puuid}`)) ?? [];
  }

  /** Newest first. startTime/endTime are epoch SECONDS. */
  async getMatchIds(
    platform: Platform,
    puuid: string,
    q: { startTime?: number; endTime?: number; queue?: number; type?: 'ranked' | 'normal' | 'tourney' | 'tutorial'; start?: number; count?: number } = {},
  ): Promise<string[]> {
    return (await this.request<string[]>(matchRegion(platform), 'match-v5.idsByPuuid', `/lol/match/v5/matches/by-puuid/${puuid}/ids`, q)) ?? [];
  }

  getSummoner(platform: Platform, puuid: string) {
    return this.request<SummonerDto>(platform.toLowerCase(), 'summoner-v4.byPuuid', `/lol/summoner/v4/summoners/by-puuid/${puuid}`);
  }

  /** All champion masteries, highest points first. */
  async getAllMastery(platform: Platform, puuid: string): Promise<ChampionMasteryDto[]> {
    return (await this.request<ChampionMasteryDto[]>(platform.toLowerCase(), 'champion-mastery-v4.all', `/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}`)) ?? [];
  }

  async getTopMastery(platform: Platform, puuid: string, count = 5): Promise<ChampionMasteryDto[]> {
    return (await this.request<ChampionMasteryDto[]>(platform.toLowerCase(), 'champion-mastery-v4.top', `/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top`, { count })) ?? [];
  }

  /** Apex ladders: tier = challenger | grandmaster | master. */
  getApexLeague(platform: Platform, tier: 'challenger' | 'grandmaster' | 'master', queue: string) {
    return this.request<LeagueListDto>(platform.toLowerCase(), `league-v4.${tier}`, `/lol/league/v4/${tier}leagues/by-queue/${queue}`);
  }

  getMatch(platform: Platform, matchId: string) {
    return this.request<MatchDto>(matchRegion(platform), 'match-v5.getMatch', `/lol/match/v5/matches/${matchId}`);
  }
}
