# RestaurantOS Live Trial

A local, multi-page restaurant operations trial for **one restaurant**. Unlike a standalone HTML mockup, all pages use one Node.js server, one persistent SQLite database and Socket.IO for live updates across browser windows/devices on the same Wi-Fi network.

## Included role pages

### Owner / bill counter
- `public/owner/index.html` — live overview and occupied tables
- `public/owner/tables.html` — add tables, preview/print real QR codes, open a table menu
- `public/owner/menu.html` — add/edit menu items, prices, categories and availability
- `public/owner/billing.html` — consolidate every order in a table's active session, generate a bill, record manual cash/UPI/card/other payments, print a receipt
- `public/owner/reports.html` — recorded collections, outstanding bills, popular dishes and CSV export

### Waiter / floor team
- `public/waiter/index.html` — floor overview
- `public/waiter/order.html` — staff-assisted order entry; new orders join the table's existing session
- `public/waiter/tables.html` — table occupancy, estimated session totals and order shortcuts

### Customer
- `public/customer/menu.html?table=1` — responsive QR menu, cart and order submission
- `public/customer/status.html?table=1` — live order progress and estimated table-session bill

### Kitchen
- `public/kitchen/index.html` — colored ticket cards and live preparation status
- `public/kitchen/history.html` — served/cancelled tickets

### Technical Super Admin
- `public/super-admin/index.html` — uptime, database status, connected browsers and technical health only
- `public/super-admin/events.html` — technical audit events only

The technical dashboard intentionally does not return sales, customer orders, invoice details, payment amounts or business analytics. Staff pages require a server-managed account session; role permissions are determined by the authenticated account, not by client-supplied role headers.

## Requirements

- Node.js 20 or newer
- npm
- Network access for the first `npm install` (Tailwind, Socket.IO client and food photos use CDN/remote assets)

## Run on your laptop

1. Extract this folder.
2. Open a terminal in the `RestaurantOS-Live` folder.
3. Copy `.env.example` to `.env` if you want to change the restaurant name, port, or tax rate.
4. Install dependencies:

   ```bash
   npm install
   ```

5. Start the server:

   ```bash
   npm start
   ```

6. Open the local owner page shown in the terminal, normally `http://localhost:3000/owner/index.html`.

The server binds to `0.0.0.0` by default and prints its local and LAN URLs, plus the customer QR base URL. Use the LAN URL from another device on the café network. Allow Node.js through the Windows Firewall on a **Private network** if prompted.

## Staff accounts

On the first start, the app creates these accounts if they do not already exist:

| Role | Username | Initial password | First-login behavior |
|---|---|---|---|
| Owner | `owner` | `12345` | Must change both username and password |
| Kitchen | `kitchen` | `12345` | Can change username/password from Account settings |
| Waiter | `waiter` | `12345` | Can change username/password from Account settings |
| Super admin | `super-admin` | `admin@pass123` | Must change the initial password; password expires every 10 days |

New passwords must be at least 12 characters. Staff sessions expire after 7 days. Passwords are stored as salted scrypt hashes; session tokens are random, stored hashed in SQLite, and carried in HttpOnly, SameSite cookies. Authenticated state-changing requests require a CSRF token, and sign-in attempts are rate limited.

The initial kitchen and waiter credentials are intentionally available for quick local setup and are not forced to change. Change them in **Account settings** before granting access to untrusted staff or exposing the server to the internet. This application is still a small single-server deployment; use HTTPS, keep the host and database secured, configure `PUBLIC_URL`/`TRUST_PROXY` correctly when behind a trusted HTTPS proxy, and obtain a security review before public production deployment.

## Test the complete workflow across browser windows

1. Owner: open `/owner/tables.html`, create a table, then preview/print its QR.
2. Customer: open the QR link or `/customer/menu.html?table=1`, add food and place the order.
3. Kitchen: open `/kitchen/index.html`; the ticket appears without refreshing. Move it through Preparing and Ready.
4. Waiter: open `/waiter/order.html?table=1`, add another dish and send it to the kitchen. This second order belongs to the same active table session.
5. Customer: open `/customer/status.html?table=1` to see live status and an estimated total.
6. Owner: open `/owner/billing.html?table=1`; all orders for that session are consolidated into one bill. Record the amount actually received as Cash, UPI, Card or Other.
7. Once the full balance is recorded, the bill becomes paid and the table session closes. The table becomes available again.

Use separate browser windows/tabs to simulate the different roles. They all connect to the same server and database.

## QR codes and customer access

QR images are generated server-side with the `qrcode` package. By default, they point to the laptop's detected LAN address, so customers must be connected to the same Wi-Fi/LAN. To use QR links from mobile internet, set `PUBLIC_URL` in `.env` to the public HTTPS origin that routes back to this server (for example `https://orders.example.com`). The endpoint may be provided by a properly configured tunnel or a public reverse proxy/router setup; it must forward normal HTTP requests and Socket.IO WebSocket traffic. The server and that route must remain available while customers use the links. QR codes, copied menu links, and pickup links all use this same configured origin. When `PUBLIC_URL` is unset, startup logs state that QR links are LAN-only.

If the LAN IP changes, regenerate/print the QR code when operating LAN-only.

**Public deployment warning:** authentication does not by itself make this trial production-ready. The initial kitchen and waiter passwords are predictable, the default owner/super-admin accounts must be changed immediately, and internet deployment needs HTTPS, secure server/database operations, monitoring, backups, and an independent security review. Do not expose it publicly with unchanged defaults.

## Data and configuration

- Database: `data/restaurant.sqlite` (created automatically on first start)
- Initial sample tables and sample food menu are seeded only when their respective tables are empty.
- `PORT` default: `3000`
- `HOST` default: `0.0.0.0`
- `RESTAURANT_NAME` default: `Maison Table`
- `CURRENCY` default: `INR`
- `TAX_RATE` default: `5` (demo tax rate; confirm applicable GST rules with an accountant before real use)

To reset the local trial, stop the server and delete `data/restaurant.sqlite`, then restart it. This permanently deletes local trial data. To back up, stop the server and copy the database file; restore by replacing the file while the server is stopped.

## Notes and current boundaries

- Orders, order item snapshots, sessions, bills and manual payments persist in SQLite.
- Socket.IO broadcasts order, menu, table and billing updates to connected browser tabs.
- Customer totals are estimates until the cashier generates/confirms the bill.
- Payments are **manual records only**; this project does not collect online payments or verify UPI/card transactions.
- This is a runnable local trial, not a certified GST invoice system or a hardened public production deployment. The role picker is not authentication; do not publish it as-is.
- Tailwind and Socket.IO client scripts load from the local server/CDN path; food photos are served from Unsplash image URLs and need internet access.

## Troubleshooting

- `Cannot find package ...`: run `npm install` in the project root.
- `EADDRINUSE`: set a different `PORT` in `.env` or stop the process already using port 3000.
- QR opens on laptop but not phone: use the LAN IP URL, ensure both devices share Wi-Fi, keep the server running, and permit Node.js through Windows Firewall.
- Browser shows stale page or no live updates: refresh after checking the terminal; the socket connection indicator should say `Connected · live sync on`.
- SQLite is locked or data seems missing: stop duplicate server processes and ensure all browser windows use the same laptop server URL/database folder.

## Payment completion, reviews and WhatsApp

- Once the cashier records the full payment, the bill is marked paid and the table session is closed. The customer's status/menu tab receives the live payment event and redirects to `/review/index.html` using `location.replace`.
- The review screen asks the customer to rate the restaurant on Google and optionally request the itemised e-bill on WhatsApp. Configure `GOOGLE_REVIEW_URL` in `.env` with the restaurant's direct Google review link.
- The e-bill form requires an explicit checkbox consent before storing a phone number in SQLite. The consent covers delivery of the e-bill and optional restaurant updates; only opted-in numbers are eligible for broadcasts.
- Without WhatsApp Cloud API credentials, the app stores the request and offers a prefilled `wa.me` link for the customer to send the bill manually. Automatic bill delivery and broadcasts require a Meta WhatsApp Cloud API setup: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and optionally `WHATSAPP_API_VERSION` in `.env`.
- Technical Super Admin → **Broadcasts** supports drafting, editing, creating and sending campaigns to opted-in contacts. The screen shows only aggregate audience/delivery counts and campaign content, never the underlying phone numbers or sales details. Sending is disabled until the WhatsApp Cloud API is configured. Failed deliveries can be retried without re-sending to contacts already recorded as successful.

## Browser history limitation

The app replaces the active status entry with the review page and guards back navigation while the review page remains open. Browsers do not provide a supported API for deleting every earlier history entry, so this cannot literally erase the user's entire browser history. A short-lived tab-session marker also redirects a back-restored menu page to the review page after payment. The server closes the paid table session; ordering from a newly opened QR URL is a separate restaurant visit and is not globally blocked.

## WhatsApp configuration notes

Copy `.env.example` to `.env`, then set the Meta WhatsApp Cloud API credentials before using automatic sends. Confirm opt-in wording, Meta business verification/template requirements and local privacy/marketing rules before public deployment.

## Pickup QR, owner e-bills and payments (updated)

- Owner → Billing now has a separate **Pickup orders QR**. Print this QR for the pickup counter. It opens `/customer/pickup.html`, asks for customer name and phone, then displays the menu and submits a dedicated pickup ticket.
- Pickup orders get a separate SQLite session and invoice; they are not merged into dine-in table sessions. Kitchen tickets and waiter-ready queue identify them as `Pickup · Customer name`. The customer can keep the pickup status page open to follow kitchen progress. Pickup payment is collected by the cashier, not online.
- Owner → Payments lists generated bills including unpaid pickup bills. Use **Collect payment** for pickup bills, or **Send e-bill** for fully paid bills. Dine-in billing requires customer name, phone and payment method before recording the payment.
- Owner → Settings controls **Auto-send e-bill**. When off, send manually from Payments. Marketing broadcasts only include customers who separately checked the WhatsApp offers consent at billing; an e-bill phone number alone is not treated as marketing consent.
- The review page now contains only the Google review action; customers cannot request an e-bill from that page.

### WhatsApp Cloud API setup

Set these values in `.env` and restart the server:

```env
WHATSAPP_ACCESS_TOKEN=your_permanent_or_long_lived_access_token
WHATSAPP_PHONE_NUMBER_ID=your_meta_phone_number_id
WHATSAPP_API_VERSION=v23.0
WHATSAPP_EBILL_TEMPLATE=approved_ebill_template_name
WHATSAPP_BROADCAST_TEMPLATE=approved_broadcast_template_name
WHATSAPP_TEMPLATE_LANGUAGE=en
```

For reliable business-initiated delivery outside the 24-hour customer-service window, create and get Meta approval for WhatsApp message templates. The configured template must have one body placeholder that receives the message text. If a template name is blank, the app sends a free-form text message, which Meta may reject outside the 24-hour window. The app reports provider errors rather than claiming delivery. Configure a permanent token, correct phone-number ID, approved templates and webhook/opt-out handling before public launch.

### Existing database migration

The server adds the new order type, customer details, e-bill status and settings columns automatically at startup. Existing `data/restaurant.sqlite` records are preserved. Back up the `data/` directory before upgrading.


## Latest billing and pickup refinements

- Owner billing now lists every open dine-in session and every active pickup ticket in one selector.
- Before settlement, the owner can add an available menu item (which creates a fresh kitchen ticket) or remove one quantity from an existing bill line. Subtotal, GST and balance are recalculated. A paid bill is locked against edits, and removals cannot reduce the total below money already received.
- Pickup QR printing is available from **Owner → Tables & QR**.
- Waiter pages are service-only; billing APIs are restricted to the owner role.
- Pickup ordering uses the same live status visual language as dine-in, includes a Google review CTA after order placement, and redirects to the thank-you page after the cashier marks the bill paid. Pickup menu quantities can be reduced or removed from the cart.

The current project archive was syntax-checked with `node --check` for `server.js` and `public/assets/app.js`. Install dependencies with `npm install` before running `npm start`. Perform a local end-to-end test with a backup of `data/restaurant.sqlite` before using this trial with real transactions.
#   R e s t a u r a n t O S  
 