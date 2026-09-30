import { describe, expect, it, vi } from "vitest";
import {
  DISMISS_GRACE_MS,
  PaymentsLkCheckoutError,
  isAllowedCheckoutUrl,
  isValidReturnUrl,
  openCheckoutWith,
  parseCheckoutReturn,
  type NativeDeps,
} from "../src/checkout.js";

const CHECKOUT = "https://payments.lk/checkout/chk_0123456789abcdefghijklmn";
const RETURN = "myshop://payments-lk/return";
const ID = "chk_0123456789abcdefghijklmn";

function fakeNative(options: { openFails?: boolean } = {}) {
  const urlListeners: Array<(event: { url: string }) => void> = [];
  const stateListeners: Array<(state: string) => void> = [];
  const removed = { url: 0, state: 0 };
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  const opened: string[] = [];
  const deps: NativeDeps = {
    linking: {
      openURL: async (url) => {
        opened.push(url);
        if (options.openFails) throw new Error("no browser");
      },
      addEventListener: (_type, listener) => {
        urlListeners.push(listener);
        return { remove: () => void removed.url++ };
      },
    },
    appState: {
      addEventListener: (_type, listener) => {
        stateListeners.push(listener);
        return { remove: () => void removed.state++ };
      },
    },
    setTimeout: (callback, ms) => {
      timers.push({ callback, ms, cleared: false });
      return timers.length - 1;
    },
    clearTimeout: (handle) => {
      const timer = timers[handle as number];
      if (timer) timer.cleared = true;
    },
  };
  return {
    deps,
    opened,
    removed,
    timers,
    sendUrl: (url: string) => urlListeners.forEach((l) => l({ url })),
    setState: (state: string) => stateListeners.forEach((l) => l(state)),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("parsing a return", () => {
  it("reads the outcome and checkout id, keeping the app's own query", () => {
    expect(parseCheckoutReturn(`${RETURN}?order=77&checkout=${ID}&status=succeeded`, RETURN)).toEqual({ status: "succeeded", checkoutId: ID });
    expect(parseCheckoutReturn(`MYSHOP://payments-lk/return?checkout=${ID}&status=expired#x`, RETURN)).toEqual({ status: "expired", checkoutId: ID });
  });

  it("refuses another scheme, a bad id, an unknown status, duplicates and missing values", () => {
    for (const url of [
      `othershop://return?checkout=${ID}&status=succeeded`,
      `${RETURN}?checkout=pay_123&status=succeeded`,
      `${RETURN}?checkout=${ID}&status=paid`,
      `${RETURN}?checkout=${ID}&status=dismissed`,
      `${RETURN}?checkout=${ID}&status=succeeded&status=failed`,
      `${RETURN}?checkout=${ID}`,
      `${RETURN}`,
      `${RETURN}?checkout=%E0%A4%A&status=succeeded`,
    ]) {
      expect(parseCheckoutReturn(url, RETURN), url).toBeNull();
    }
  });
});

describe("validation", () => {
  it("allows https and local http checkout URLs only", () => {
    expect(isAllowedCheckoutUrl(CHECKOUT)).toBe(true);
    expect(isAllowedCheckoutUrl("http://10.0.2.2:3311/checkout/chk_1")).toBe(true);
    expect(isAllowedCheckoutUrl("http://localhost:3311/checkout/chk_1")).toBe(true);
    for (const url of ["http://payments.lk/checkout/chk_1", "https://user@payments.lk/", "javascript:alert(1)", "https://payments.lk/a b", "https:\\\\payments.lk"]) {
      expect(isAllowedCheckoutUrl(url), url).toBe(false);
    }
  });

  it("allows an app scheme return URL only", () => {
    expect(isValidReturnUrl(RETURN)).toBe(true);
    expect(isValidReturnUrl("lk.kottuhut.app://paid")).toBe(true);
    for (const url of ["https://shop.example/paid", "javascript://x", "ab://x", "not a url", "myshop://paid now"]) {
      expect(isValidReturnUrl(url), url).toBe(false);
    }
  });
});

describe("opening a checkout", () => {
  it("uses the authentication sheet when expo-web-browser is passed", async () => {
    const native = fakeNative();
    const browser = { openAuthSessionAsync: vi.fn(async () => ({ type: "success", url: `${RETURN}?checkout=${ID}&status=failed` })) };
    await expect(openCheckoutWith(native.deps, { checkoutUrl: CHECKOUT, returnUrl: RETURN, browser })).resolves.toEqual({ status: "failed", checkoutId: ID });
    expect(browser.openAuthSessionAsync).toHaveBeenCalledWith(CHECKOUT, RETURN);
    expect(native.opened).toEqual([]);
  });

  it("reports a closed sheet as dismissed and a return without an outcome as an error", async () => {
    const native = fakeNative();
    const dismissed = { openAuthSessionAsync: async () => ({ type: "cancel" }) };
    await expect(openCheckoutWith(native.deps, { checkoutUrl: CHECKOUT, returnUrl: RETURN, browser: dismissed })).resolves.toEqual({ status: "dismissed", checkoutId: null });
    const odd = { openAuthSessionAsync: async () => ({ type: "success", url: `${RETURN}?nothing=here` }) };
    await expect(openCheckoutWith(native.deps, { checkoutUrl: CHECKOUT, returnUrl: RETURN, browser: odd })).rejects.toMatchObject({ code: "unexpected_return" });
  });

  it("opens the system browser and resolves on the return URL, ignoring other links", async () => {
    const native = fakeNative();
    const pending = openCheckoutWith(native.deps, { checkoutUrl: CHECKOUT, returnUrl: RETURN });
    await tick();
    expect(native.opened).toEqual([CHECKOUT]);
    native.setState("background");
    native.sendUrl("myshop://somewhere-else");
    native.setState("active");
    native.sendUrl(`${RETURN}?checkout=${ID}&status=succeeded`);
    await expect(pending).resolves.toEqual({ status: "succeeded", checkoutId: ID });
    expect(native.removed).toEqual({ url: 1, state: 1 });
    expect(native.timers[0]?.cleared).toBe(true);
  });

  it("calls it dismissed when the app comes back with no return URL", async () => {
    const native = fakeNative();
    const pending = openCheckoutWith(native.deps, { checkoutUrl: CHECKOUT, returnUrl: RETURN });
    await tick();
    native.setState("active");
    expect(native.timers).toHaveLength(0);
    native.setState("background");
    native.setState("active");
    expect(native.timers[0]?.ms).toBe(DISMISS_GRACE_MS);
    native.timers[0]?.callback();
    await expect(pending).resolves.toEqual({ status: "dismissed", checkoutId: null });
  });

  it("refuses bad URLs, a second checkout at once, and reports a browser that will not open", async () => {
    const native = fakeNative();
    await expect(openCheckoutWith(native.deps, { checkoutUrl: "http://payments.lk/x", returnUrl: RETURN })).rejects.toBeInstanceOf(PaymentsLkCheckoutError);
    await expect(openCheckoutWith(native.deps, { checkoutUrl: CHECKOUT, returnUrl: "https://shop.example" })).rejects.toMatchObject({ code: "invalid_return_url" });

    const first = openCheckoutWith(native.deps, { checkoutUrl: CHECKOUT, returnUrl: RETURN });
    await expect(openCheckoutWith(native.deps, { checkoutUrl: CHECKOUT, returnUrl: RETURN })).rejects.toMatchObject({ code: "already_open" });
    native.sendUrl(`${RETURN}?checkout=${ID}&status=canceled`);
    await expect(first).resolves.toMatchObject({ status: "canceled" });

    const broken = fakeNative({ openFails: true });
    await expect(openCheckoutWith(broken.deps, { checkoutUrl: CHECKOUT, returnUrl: RETURN })).rejects.toMatchObject({ code: "could_not_open" });
    expect(broken.removed).toEqual({ url: 1, state: 1 });
  });
});
