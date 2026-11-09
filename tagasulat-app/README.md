# Tagasulat (live-selling order recorder)

Node.js + Express + plain HTML/CSS/JS. No database server needed: data is saved to `data/db.json`.

## Run it
```bash
npm install
npm start
# open http://localhost:3000
```

## How it works
1. Click **Start live**.
2. Comments come in on the left. A comment like `mine 12`, `m12`, `#12 x2`, or `pin 5 2pcs` becomes an order on the board.
3. Add **item prices** (pin number, name, price) so labels show the item and total.
4. **Confirm** an order to print its 58mm label. **Checked out** moves it to the last column.
5. **Ban** adds a buyer to the blacklist; their later pins are ignored.
6. Buyer badges: NEW (no checked-out orders), OLD (1 to 4), JOY (5+ orders or ₱3,000+ spent).

Use **Simulate buyers** to test without going live.

## Connect to your own TikTok Live (optional)
```bash
npm install tiktok-live-connector
TIKTOK_USERNAME=your_username npm start      # Windows PowerShell: $env:TIKTOK_USERNAME="your_username"; npm start
```
This uses an unofficial library that can break when TikTok changes things. Any other source can feed the app by POSTing `{ "user": "...", "text": "..." }` to `/api/chat`.

## Printing
- **Browser print:** the label prints at 58mm width. For one-click printing with no dialog, start Chrome with `--kiosk-printing` and set your thermal printer as the default.
- **Raw ESC/POS:** `GET /api/orders/:id/escpos` returns raw printer bytes, which you can send with a raw-print tool or a Web Serial/Bluetooth bridge.

## Files
- `server.js` API, pin parser, buyer badges, live updates (Server-Sent Events), ESC/POS output
- `connector.js` optional TikTok Live chat reader
- `public/` the interface (`index.html`, `style.css`, `app.js`)
