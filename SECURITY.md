# Security

Please report a vulnerability privately: use Report a vulnerability on this repository's Security tab, or email hello@payments.lk with "Security" in the subject. Please do not open a public issue. We reply to every report and tell you when a fix is released.

This SDK never handles card details: customers pay on the Payments.lk hosted checkout. Keep your secret key (`sk_live_...`) on your server only, and confirm every payment from the API or a signed webhook, never from the customer's return to your site or app.
