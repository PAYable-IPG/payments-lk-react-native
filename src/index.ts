import { AppState, Linking } from "react-native";
import {
  openCheckoutWith,
  openPageWith,
  subscriptionLinkUrl,
  type AuthSessionBrowser,
  type CheckoutResult,
  type NativeDeps,
  type OpenCheckoutOptions,
  type PageResult,
  type SubscriptionLinkOptions,
} from "./checkout.js";

export * from "./checkout.js";

function native(): NativeDeps {
  return {
    linking: Linking,
    appState: AppState,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/**
 * Opens the hosted checkout and resolves with its outcome when the customer
 * returns to the app. Pass expo-web-browser as options.browser to show the
 * checkout in an in-app authentication sheet; without it the system browser
 * opens and the app listens for its return URL.
 *
 * A subscription's first payment is a checkout too: your server creates the
 * subscription and answers its checkoutUrl, and the app opens it here.
 *
 * The outcome is not proof of payment. Ask your server, which confirms with
 * the Payments.lk API or the payment.succeeded webhook.
 */
export function openCheckout(options: OpenCheckoutOptions): Promise<CheckoutResult> {
  return openCheckoutWith(native(), options);
}

/**
 * Opens a subscription link, made in the dashboard, with a plan chosen first
 * if you name one. The customer picks a plan, gives their email and pays the
 * first period; the link's success address, set to your app's scheme, brings
 * them back. Your server learns about the new member from the webhooks.
 */
export function openSubscriptionLink(options: SubscriptionLinkOptions & { returnUrl: string; browser?: AuthSessionBrowser }): Promise<PageResult> {
  return openPageWith(native(), { url: subscriptionLinkUrl(options), returnUrl: options.returnUrl, browser: options.browser });
}

/**
 * Opens the customer portal from a portal session your server created with
 * the app's scheme as its return address. The customer changes their card or
 * plan, pauses or cancels there, and the portal sends them back.
 */
export function openPortal(options: { portalUrl: string; returnUrl: string; browser?: AuthSessionBrowser }): Promise<PageResult> {
  return openPageWith(native(), { url: options.portalUrl, returnUrl: options.returnUrl, browser: options.browser });
}
