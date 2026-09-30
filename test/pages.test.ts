import { describe, expect, it } from "vitest";
import { DISMISS_GRACE_MS, PaymentsLkCheckoutError, openPageWith, subscriptionLinkUrl, type NativeDeps } from "../src/checkout.js";

/**
 * The two pages with no checkout id to return: a subscription link, whose address the library builds, and the
 * customer portal. Both resolve when the app is returned to on its own scheme, or when the customer closes the
 * browser instead.
 */
const CODE = "aB3_dEf9-gh12";
const PLAN = "price_0123456789abcdefghij";
const RETURN = "myshop://payments-lk/return";

function fakeNative(options: { openFails?: boolean } = {}) {
  const urlListeners: Array<(event: { url: string }) => void> = [];
  const stateListeners: Array<(state: string) => void> = [];
  const timers: Array<{ callback: () => void; cleared: boolean }> = [];
  const opened: string[] = [];
  const deps: NativeDeps = {
    linking: {
      openURL: async (url) => {
        opened.push(url);
        if (options.openFails) throw new Error("no browser");
      },
      addEventListener: (_type, listener) => {
        urlListeners.push(listener);
        return { remove: () => undefined };
      },
    },
    appState: {
      addEventListener: (_type, listener) => {
        stateListeners.push(listener);
        return { remove: () => undefined };
      },
    },
    setTimeout: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  return { deps, opened, url: (url: string) => urlListeners.forEach((l) => l({ url })), state: (s: string) => stateListeners.forEach((l) => l(s)), timers };
}

describe("a subscription link's address", () => {
  it("names the site, the language, the plan and the email", () => {
    expect(subscriptionLinkUrl({ code: CODE })).toBe(`https://payments.lk/s/${CODE}`);
    expect(subscriptionLinkUrl({ code: CODE, plan: PLAN, lang: "si", email: "nimali@example.com" })).toBe(`https://payments.lk/si/s/${CODE}?plan=${PLAN}&email=nimali%40example.com`);
    expect(subscriptionLinkUrl({ code: CODE, site: "https://web-staging.example.test/" })).toBe(`https://web-staging.example.test/s/${CODE}`);
    expect(subscriptionLinkUrl({ code: CODE, lang: "en" })).toBe(`https://payments.lk/s/${CODE}`);
  });

  it("refuses a code, a plan or a site that is not shaped like one", () => {
    expect(() => subscriptionLinkUrl({ code: "short" })).toThrow(PaymentsLkCheckoutError);
    expect(() => subscriptionLinkUrl({ code: "../admin/x" })).toThrow(PaymentsLkCheckoutError);
    expect(() => subscriptionLinkUrl({ code: CODE, plan: "price_x" })).toThrow(PaymentsLkCheckoutError);
    expect(() => subscriptionLinkUrl({ code: CODE, site: "http://payments.lk" })).toThrow(PaymentsLkCheckoutError);
    expect(() => subscriptionLinkUrl({ code: CODE, site: "https://payments.lk/?x" })).toThrow(PaymentsLkCheckoutError);
  });
});

describe("opening a page", () => {
  it("resolves returned with the URL the page came back on, in the app's scheme", async () => {
    const native = fakeNative();
    const pending = openPageWith(native.deps, { url: `https://payments.lk/s/${CODE}`, returnUrl: RETURN });
    await Promise.resolve();
    expect(native.opened).toEqual([`https://payments.lk/s/${CODE}`]);
    native.url("https://elsewhere.example/ignored");
    native.url("myshop://payments-lk/return?subscribed=1");
    await expect(pending).resolves.toEqual({ status: "returned", url: "myshop://payments-lk/return?subscribed=1" });
  });

  it("resolves dismissed when the app comes back without a return, after the grace period", async () => {
    const native = fakeNative();
    const pending = openPageWith(native.deps, { url: "https://payments.lk/billing/tok", returnUrl: RETURN });
    await Promise.resolve();
    native.state("background");
    native.state("active");
    expect(native.timers).toHaveLength(1);
    expect(DISMISS_GRACE_MS).toBeGreaterThan(0);
    native.timers[0]?.callback();
    await expect(pending).resolves.toEqual({ status: "dismissed", url: null });
  });

  it("uses an authentication sheet when given one, and refuses a page that is not https", async () => {
    const browser = { openAuthSessionAsync: async () => ({ type: "success", url: "myshop://payments-lk/return" }) };
    await expect(openPageWith(fakeNative().deps, { url: "https://payments.lk/billing/tok", returnUrl: RETURN, browser })).resolves.toEqual({ status: "returned", url: "myshop://payments-lk/return" });
    const dismissed = { openAuthSessionAsync: async () => ({ type: "cancel" }) };
    await expect(openPageWith(fakeNative().deps, { url: "https://payments.lk/billing/tok", returnUrl: RETURN, browser: dismissed })).resolves.toEqual({ status: "dismissed", url: null });
    await expect(openPageWith(fakeNative().deps, { url: "http://payments.lk/billing/tok", returnUrl: RETURN })).rejects.toMatchObject({ code: "insecure_checkout_url" });
    await expect(openPageWith(fakeNative().deps, { url: "https://payments.lk/billing/tok", returnUrl: "https://myshop.example" })).rejects.toMatchObject({ code: "invalid_return_url" });
    await expect(openPageWith(fakeNative({ openFails: true }).deps, { url: "https://payments.lk/billing/tok", returnUrl: RETURN })).rejects.toMatchObject({ code: "could_not_open" });
  });
});
