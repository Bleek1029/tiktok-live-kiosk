# Tagasulat (live-selling order recorder)

Node.js + Express + plain HTML/CSS/JS, stored in PostgreSQL. Without a database URL it falls back to a local file, so you can develop on your PC with no setup.

## Run locally
```bash
npm install
npm start          # http://localhost:3000, saves to data/db.json
```
Optional login locally: `APP_PASSWORD=yourpassword npm start`

## Deploy on Render (with PostgreSQL)

### Option A: Blueprint (one step)
1. Push this folder to a GitHub repo (`render.yaml` must be in the repo root).
2. In Render: **New +** then **Blueprint**, pick the repo.
3. When asked, type a value for **APP_PASSWORD**. This is the password for the login page.
4. Click **Apply**. Render creates the web service and the database, and connects them.

### Option B: by hand
1. **New +** then **PostgreSQL**. Create it, then copy its **Internal Database URL**.
2. **New +** then **Web Service**, pick the repo. Build command `npm install --omit=optional`, start command `npm start`.
3. Add environment variables:
   - `DATABASE_URL` = the Internal Database URL
   - `APP_PASSWORD` = your login password
   - `SESSION_SECRET` = any long random text
   - `NODE_VERSION` = `20`
4. Set the health check path to `/healthz`.

The app creates its table on first start. In production (`NODE_ENV=production`) it refuses to start without `APP_PASSWORD`, so it can never be public without a login.

If you connect from your own PC to the database, use the **External** URL and also set `PGSSL=true`.

### Free plan warnings (check Render's current terms)
- A free database **expires 30 days after creation** and has **no backups**. Use the **Backup** button (downloads all records as JSON) often, or move to a paid database for real use.
- A free web service **sleeps after 15 minutes idle**, and the first request wakes it slowly. Use a paid instance if you will run it during a live.

## How it works
1. **Start live**, then comments appear on the left.
2. A comment like `mine 12`, `m12`, `#12 x2` or `pin 5 2pcs` becomes an order on the board.
3. Add **item prices** (pin number, name, price) so labels show the item and total.
4. **Confirm** prints a 58mm label. **Checked out** moves it to the last column.
5. **Ban** adds a buyer to the blacklist. Buyer badges: NEW, OLD (1 to 4 checkouts), JOY (5+ or ₱3,000+).
6. **Simulate buyers** sends fake comments for testing.

## Optional: TikTok Live chat
```bash
npm install tiktok-live-connector
TIKTOK_USERNAME=your_username npm start
```
Unofficial library, can break when TikTok changes things. Better run on your own PC than on Render. Anything else can feed the app by POSTing `{ "user": "...", "text": "..." }` to `/api/chat` (after logging in).

## Printing
- **Browser print:** 58mm label. For one-click printing, start Chrome with `--kiosk-printing` and set the thermal printer as default.
- **Raw ESC/POS:** `GET /api/orders/:id/escpos`.

## Files
- `server.js` API, pin parser, login, live updates (Server-Sent Events)
- `store.js` saves state to PostgreSQL (or `data/db.json` locally)
- `render.yaml` Render Blueprint
- `connector.js` optional TikTok chat reader
- `public/` the interface
