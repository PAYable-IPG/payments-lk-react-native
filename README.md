# Payments.lk for React Native

Open a Payments.lk hosted checkout from a React Native or Expo app and get the outcome back through your app's own URL scheme. The customer pays on the hosted checkout, so card details never touch your app or your servers.

- React Native 0.72 or later
- Optional: `expo-web-browser` 12 or later, for an in-app authentication sheet that closes itself

## How it fits together

1. Your app asks your server for a checkout for an order.
2. Your server creates it with its secret key, setting `successUrl` and `cancelUrl` to your app's scheme, such as `myshop://payments-lk/return`, and answers with the checkout's `id` and `url`.
3. The app calls `openCheckout`. The customer pays, and the checkout sends the browser to your scheme with `checkout=<id>&status=<outcome>`.
4. The app shows the outcome while it asks your server to confirm. Your server trusts only the API or the signed `payment.succeeded` webhook.

A secret key never goes in an app, and the return URL is never proof of payment.

## Install

```bash
npm install @payments-lk/react-native
npx expo install expo-web-browser   # optional, recommended
```

The package is published to npm by GitHub Actions from [github.com/PAYable-IPG/payments-lk-react-native](https://github.com/PAYable-IPG/payments-lk-react-native), with provenance.

## Register your scheme

Expo: set `"scheme": "myshop"` in `app.json`.

Bare React Native: add a URL type with the scheme `myshop` in `ios/<App>/Info.plist`, and on Android an intent filter on your main activity:

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="myshop" android:host="payments-lk" />
</intent-filter>
```

## Your server

With the Node.js library:

```ts
app.post("/app/checkouts", requireSignedInCustomer, async (req, res) => {
  const order = await orders.forCustomer(req.user.id, req.body.orderId);
  const checkout = await lk.checkouts.create(
    { amountCents: order.totalCents, description: order.summary, reference: order.id, successUrl: "myshop://payments-lk/return", cancelUrl: "myshop://payments-lk/return" },
    { idempotencyKey: `order-${order.id}` },
  );
  res.json({ id: checkout.id, url: checkout.url });
});
```

## Saving a card for later

The checkout can ask the customer to keep their card, so your server charges it again later without them present: a subscription, instalments, or one tap repeat orders. Your server sets `saveCard` when it creates the checkout, and the customer decides on the hosted page; the app does nothing differently, and no card number ever reaches it.

```json
{ "amountCents": 250000, "description": "First month", "saveCard": true, "customer": { "name": "Ruwan", "email": "ruwan@example.lk" } }
```

When that first payment succeeds, your server receives the `card.saved` webhook with a card id (`card_...`) to keep against the customer, and charges it later with `POST /v1/cards/{id}/charge`. The card carries the month it expires and what the customer agreed to, so your server can show both. Only that first payment asks the cardholder to authenticate: a later charge is made without them, so a bank that insists on a check declines it, and you send the customer back to a checkout.

Saved cards use Payable's Advanced plan, switched on in the dashboard. The steps are at https://payments.lk/developers/guide#card-on-file.

## Your app

```tsx
import * as WebBrowser from "expo-web-browser";
import { openCheckout, PaymentsLkCheckoutError } from "@payments-lk/react-native";

const RETURN_URL = "myshop://payments-lk/return";

async function pay(orderId: string) {
  const checkout = await api.post("/app/checkouts", { orderId });
  try {
    const result = await openCheckout({ checkoutUrl: checkout.url, returnUrl: RETURN_URL, browser: WebBrowser });
    switch (result.status) {
      case "succeeded":
        return showConfirming(await api.get(`/orders/${orderId}`)); // your server has the final word
      case "failed":
        return showMessage("The payment did not go through. You have not been charged.");
      case "canceled":
      case "expired":
      case "dismissed":
        return showMessage("Payment not completed.");
    }
  } catch (error) {
    if (error instanceof PaymentsLkCheckoutError) return showMessage("The checkout could not be opened.");
    throw error;
  }
}
```

Leave out `browser` to open the system browser instead; the library then listens for your return URL and reports `dismissed` if the customer comes back without finishing.

## Subscriptions

A subscription's first payment is a hosted checkout, so the app opens it exactly as above. Your server creates the subscription instead of a checkout, with the same return addresses:

```ts
const customer = await lk.customers.create({ email: user.email, name: user.name });
const subscription = await lk.subscriptions.create(
  { customerId: customer.id, priceId: config.monthlyPriceId, successUrl: "myshop://payments-lk/return", cancelUrl: "myshop://payments-lk/return" },
  { idempotencyKey: "club-" + user.id },
);
res.json({ url: subscription.checkoutUrl }); // null when a card is already on file: the first period was charged
```

Two more pages have no checkout id to return, and resolve as `{ status: "returned" | "dismissed", url }` instead:

```ts
import { openPortal, openSubscriptionLink } from "@payments-lk/react-native";

// A subscription link made in the dashboard, with one of its plans chosen first. Give the link a success address in
// your app's scheme when you make it, so the customer comes back to the app after paying.
await openSubscriptionLink({ code: "LINKCODE", plan: "price_0123456789abcdefghij", email: user.email, returnUrl: RETURN_URL, browser: WebBrowser });

// The customer portal, from a session your server created with returnUrl in your app's scheme.
const session = await api.post("/app/portal"); // your server: lk.billingPortal.sessions.create({ customerId, returnUrl: RETURN_URL })
await openPortal({ portalUrl: session.url, returnUrl: RETURN_URL, browser: WebBrowser });
```

Give access from the subscription's status carried by the `customer.subscription.*` webhooks, never from the return to the app.

## Outcomes

| status | Meaning |
| --- | --- |
| `succeeded` | The checkout says the payment succeeded. Confirm on your server. |
| `failed` | The payment was declined or not completed. |
| `canceled` | The checkout was closed. |
| `expired` | Nobody paid before the checkout expired. |
| `dismissed` | The customer closed the browser before the checkout finished. `checkoutId` is null. |

## Errors

`PaymentsLkCheckoutError` has a `code`: `insecure_checkout_url` (not https), `invalid_return_url` (not an app scheme), `already_open`, `could_not_open` or `unexpected_return`.

## Development

```bash
pnpm --filter @payments-lk/react-native test
```

The library uses only `Linking` and `AppState` from React Native, and parses URLs itself because older React Native versions implement `URL` only in part.
