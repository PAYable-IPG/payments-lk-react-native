/**
 * The hosted checkout, opened from an app. The app's server creates the
 * checkout with its secret key and sets successUrl and cancelUrl to the app's
 * own scheme, such as myshop://payments-lk/return. When the checkout ends the
 * page sends the browser there with checkout=<id> and status=<outcome>.
 *
 * Written without URL or URLSearchParams, which older React Native versions
 * implement only in part.
 */

export type CheckoutOutcome = "succeeded" | "failed" | "canceled" | "expired" | "dismissed";

export type CheckoutResult = {
  status: CheckoutOutcome;
  /** The checkout's id, or null when the customer closed the browser before it finished. */
  checkoutId: string | null;
};

export type CheckoutErrorCode = "insecure_checkout_url" | "invalid_return_url" | "already_open" | "unexpected_return" | "could_not_open" | "invalid_link";

export class PaymentsLkCheckoutError extends Error {
  constructor(
    readonly code: CheckoutErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PaymentsLkCheckoutError";
  }
}

export interface Subscription {
  remove(): void;
}

/** The part of expo-web-browser this library calls. Pass the module itself. */
export interface AuthSessionBrowser {
  openAuthSessionAsync(url: string, redirectUrl?: string | null): Promise<{ type: string; url?: string }>;
}

export interface LinkingLike {
  openURL(url: string): Promise<unknown>;
  addEventListener(type: "url", listener: (event: { url: string }) => void): Subscription;
}

export interface AppStateLike {
  addEventListener(type: "change", listener: (state: string) => void): Subscription;
}

export type NativeDeps = {
  linking: LinkingLike;
  appState: AppStateLike;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type OpenCheckoutOptions = {
  /** checkout.url from your server. */
  checkoutUrl: string;
  /** The successUrl or cancelUrl your server set, in your app's scheme. Only its scheme is matched. */
  returnUrl: string;
  /** expo-web-browser, to show the checkout in an authentication sheet that closes itself on return. */
  browser?: AuthSessionBrowser;
};

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const APP_SCHEME = /^[a-z][a-z0-9+.-]{2,39}$/;
const REFUSED_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "javascript", "data", "vbscript", "file", "blob", "about", "intent"]);
const OUTCOMES: ReadonlySet<string> = new Set(["succeeded", "failed", "canceled", "expired"]);
const CHECKOUT_ID = /^chk_[0-9a-z]{1,64}$/;

/** After the app comes back to the foreground without a return URL, how long to wait for one before calling it dismissed. */
export const DISMISS_GRACE_MS = 1_500;

function schemeOf(url: string): string | null {
  const match = SCHEME.exec(url);
  return match?.[1] ? match[1].toLowerCase() : null;
}

function hasSpaceOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** An app scheme return URL, such as myshop://payments-lk/return. */
export function isValidReturnUrl(returnUrl: string): boolean {
  if (typeof returnUrl !== "string" || hasSpaceOrControl(returnUrl)) return false;
  const scheme = schemeOf(returnUrl);
  return scheme !== null && APP_SCHEME.test(scheme) && !REFUSED_SCHEMES.has(scheme);
}

/** https without credentials, or plain http on this machine or the Android emulator's host, for local testing. */
export function isAllowedCheckoutUrl(url: string): boolean {
  if (typeof url !== "string" || hasSpaceOrControl(url) || url.includes("\\")) return false;
  const match = /^(https?):\/\/([^/?#]*)/i.exec(url);
  const scheme = match?.[1]?.toLowerCase();
  const authority = match?.[2];
  if (!scheme || !authority || authority.includes("@")) return false;
  if (scheme === "https") return true;
  const host = authority.replace(/:[0-9]{1,5}$/, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "10.0.2.2";
}

/** The outcome in a return URL, or null for any URL that is not a well formed return in this scheme. */
export function parseCheckoutReturn(url: string, returnUrl: string): CheckoutResult | null {
  const expected = schemeOf(returnUrl);
  if (!expected || typeof url !== "string" || schemeOf(url) !== expected) return null;
  const start = url.indexOf("?");
  if (start === -1) return null;
  const end = url.indexOf("#", start);
  const query = url.slice(start + 1, end === -1 ? undefined : end);

  const values = new Map<string, string[]>();
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, " "));
      value = decodeURIComponent((eq === -1 ? "" : pair.slice(eq + 1)).replace(/\+/g, " "));
    } catch {
      return null;
    }
    values.set(key, [...(values.get(key) ?? []), value]);
  }

  const ids = values.get("checkout");
  const statuses = values.get("status");
  if (ids?.length !== 1 || statuses?.length !== 1) return null;
  const [checkoutId] = ids;
  const [status] = statuses;
  if (!checkoutId || !CHECKOUT_ID.test(checkoutId) || !status || !OUTCOMES.has(status)) return null;
  return { status: status as CheckoutOutcome, checkoutId };
}

let presenting = false;

/** openCheckout with its native modules passed in. openCheckout is what an app calls. */
export async function openCheckoutWith(deps: NativeDeps, options: OpenCheckoutOptions): Promise<CheckoutResult> {
  if (!isAllowedCheckoutUrl(options.checkoutUrl)) {
    throw new PaymentsLkCheckoutError("insecure_checkout_url", "The checkout URL must be https. Use checkout.url exactly as your server received it.");
  }
  if (!isValidReturnUrl(options.returnUrl)) {
    throw new PaymentsLkCheckoutError("invalid_return_url", "The return URL must use your app's own scheme, such as myshop://payments-lk/return.");
  }
  if (presenting) throw new PaymentsLkCheckoutError("already_open", "A checkout is already open.");
  presenting = true;
  try {
    return options.browser ? await viaAuthSession(options.browser, options) : await viaLinking(deps, options);
  } finally {
    presenting = false;
  }
}

async function viaAuthSession(browser: AuthSessionBrowser, options: OpenCheckoutOptions): Promise<CheckoutResult> {
  let result: { type: string; url?: string };
  try {
    result = await browser.openAuthSessionAsync(options.checkoutUrl, options.returnUrl);
  } catch (error) {
    throw new PaymentsLkCheckoutError("could_not_open", "The checkout could not be opened.", { cause: error });
  }
  if (result.type !== "success") return { status: "dismissed", checkoutId: null };
  const parsed = result.url ? parseCheckoutReturn(result.url, options.returnUrl) : null;
  if (!parsed) throw new PaymentsLkCheckoutError("unexpected_return", "The checkout returned to the app without an outcome.");
  return parsed;
}

function viaLinking(deps: NativeDeps, options: OpenCheckoutOptions): Promise<CheckoutResult> {
  return new Promise<CheckoutResult>((resolve, reject) => {
    let settled = false;
    let left = false;
    let timer: unknown = null;
    const subscriptions: Subscription[] = [];

    const cleanUp = () => {
      settled = true;
      for (const subscription of subscriptions) subscription.remove();
      if (timer !== null) deps.clearTimeout(timer);
      timer = null;
    };
    const finish = (result: CheckoutResult) => {
      if (settled) return;
      cleanUp();
      resolve(result);
    };

    subscriptions.push(
      deps.linking.addEventListener("url", ({ url }) => {
        const parsed = parseCheckoutReturn(url, options.returnUrl);
        if (parsed) finish(parsed);
      }),
    );
    subscriptions.push(
      deps.appState.addEventListener("change", (state) => {
        if (state === "background") {
          left = true;
          if (timer !== null) deps.clearTimeout(timer);
          timer = null;
        } else if (state === "active" && left && timer === null) {
          // The return URL can arrive just after the app wakes, so give it a moment.
          timer = deps.setTimeout(() => finish({ status: "dismissed", checkoutId: null }), DISMISS_GRACE_MS);
        }
      }),
    );

    deps.linking.openURL(options.checkoutUrl).catch((error: unknown) => {
      if (settled) return;
      cleanUp();
      reject(new PaymentsLkCheckoutError("could_not_open", "The checkout could not be opened.", { cause: error }));
    });
  });
}

/*
 * Subscriptions. A subscription's first payment is an ordinary hosted checkout, so an app opens it with openCheckout
 * exactly as a one-time payment. Two more pages have no checkout id to return: a subscription link, where the
 * customer chooses a plan, and the customer portal, where they manage it. Both end by sending the browser to a URL
 * in the app's scheme (the link's success address, the portal session's return address), so the app only needs to
 * know it was returned to.
 */

export type PageResult = {
  /** returned: the page sent the browser back to the app's scheme. dismissed: the customer closed the browser instead. */
  status: "returned" | "dismissed";
  /** The URL the page returned to, or null when dismissed. Its query is the page's own; never proof of anything. */
  url: string | null;
};

export type OpenPageOptions = {
  /** The page's https address: a subscription link, or a portal session's url. */
  url: string;
  /** An address in your app's scheme, the one the page will return to. Only its scheme is matched. */
  returnUrl: string;
  browser?: AuthSessionBrowser;
};

export type SubscriptionLinkOptions = {
  /** The link's code, the last part of its address. */
  code: string;
  /** A plan of the link's to choose first, a price id. */
  plan?: string;
  /** The customer's email, filled in for them. */
  email?: string;
  /** The page's language. */
  lang?: "en" | "si" | "ta";
  /** The site the link lives on: https://payments.lk unless you are testing against a staging site. */
  site?: string;
};

const LINK_CODE = /^[A-Za-z0-9_-]{8,64}$/;
const PRICE_ID = /^price_[0-9a-z]{20,32}$/;

/** The address of a subscription link, with the plan to choose first and the email to fill in. */
export function subscriptionLinkUrl(options: SubscriptionLinkOptions): string {
  if (typeof options.code !== "string" || !LINK_CODE.test(options.code)) {
    throw new PaymentsLkCheckoutError("invalid_link", "A subscription link's code is the last part of its address, such as the dashboard shows it.");
  }
  if (options.plan !== undefined && !PRICE_ID.test(options.plan)) {
    throw new PaymentsLkCheckoutError("invalid_link", "A plan is a price id, such as price_0123456789abcdefghij.");
  }
  const site = (options.site ?? "https://payments.lk").replace(/\/+$/, "");
  if (!isAllowedCheckoutUrl(site) || /[?#]/.test(site)) {
    throw new PaymentsLkCheckoutError("insecure_checkout_url", "The site must be an https origin.");
  }
  const lang = options.lang === "si" || options.lang === "ta" ? `/${options.lang}` : "";
  const query: string[] = [];
  if (options.plan !== undefined) query.push(`plan=${options.plan}`);
  if (options.email && options.email.length <= 254 && options.email.indexOf("@") > 0) query.push(`email=${encodeURIComponent(options.email)}`);
  return `${site}${lang}/s/${options.code}${query.length > 0 ? `?${query.join("&")}` : ""}`;
}

/** Opens a hosted page and resolves when the app is returned to, or when the customer closes the browser. */
export async function openPageWith(deps: NativeDeps, options: OpenPageOptions): Promise<PageResult> {
  if (!isAllowedCheckoutUrl(options.url)) {
    throw new PaymentsLkCheckoutError("insecure_checkout_url", "The page's URL must be https.");
  }
  if (!isValidReturnUrl(options.returnUrl)) {
    throw new PaymentsLkCheckoutError("invalid_return_url", "The return URL must use your app's own scheme, such as myshop://payments-lk/return.");
  }
  if (presenting) throw new PaymentsLkCheckoutError("already_open", "A checkout is already open.");
  presenting = true;
  try {
    return options.browser ? await pageViaAuthSession(options.browser, options) : await pageViaLinking(deps, options);
  } finally {
    presenting = false;
  }
}

async function pageViaAuthSession(browser: AuthSessionBrowser, options: OpenPageOptions): Promise<PageResult> {
  let result: { type: string; url?: string };
  try {
    result = await browser.openAuthSessionAsync(options.url, options.returnUrl);
  } catch (error) {
    throw new PaymentsLkCheckoutError("could_not_open", "The page could not be opened.", { cause: error });
  }
  if (result.type !== "success") return { status: "dismissed", url: null };
  if (!result.url || schemeOf(result.url) !== schemeOf(options.returnUrl)) {
    throw new PaymentsLkCheckoutError("unexpected_return", "The page returned to the app on another scheme.");
  }
  return { status: "returned", url: result.url };
}

function pageViaLinking(deps: NativeDeps, options: OpenPageOptions): Promise<PageResult> {
  return new Promise<PageResult>((resolve, reject) => {
    let settled = false;
    let left = false;
    let timer: unknown = null;
    const subscriptions: Subscription[] = [];
    const cleanUp = () => {
      settled = true;
      for (const subscription of subscriptions) subscription.remove();
      if (timer !== null) deps.clearTimeout(timer);
      timer = null;
    };
    const finish = (result: PageResult) => {
      if (settled) return;
      cleanUp();
      resolve(result);
    };
    subscriptions.push(
      deps.linking.addEventListener("url", ({ url }) => {
        if (typeof url === "string" && schemeOf(url) === schemeOf(options.returnUrl)) finish({ status: "returned", url });
      }),
    );
    subscriptions.push(
      deps.appState.addEventListener("change", (state) => {
        if (state === "background") {
          left = true;
          if (timer !== null) deps.clearTimeout(timer);
          timer = null;
        } else if (state === "active" && left && timer === null) {
          timer = deps.setTimeout(() => finish({ status: "dismissed", url: null }), DISMISS_GRACE_MS);
        }
      }),
    );
    deps.linking.openURL(options.url).catch((error: unknown) => {
      if (settled) return;
      cleanUp();
      reject(new PaymentsLkCheckoutError("could_not_open", "The page could not be opened.", { cause: error }));
    });
  });
}
