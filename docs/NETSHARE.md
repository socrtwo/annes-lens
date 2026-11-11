# Network sharing: shared views and shared albums

Anne's Lens can show other devices what one window shows (**View ▸ Share View on the Network**) and
hand an album to them (**Browse ▸ Share Album**). Guests are either a plain browser, which gets a page,
or another Anne's Lens (**View ▸ Follow a Shared View**, **Browse ▸ Open Shared Album**).

## Where it runs

- **The desktop app** starts a small HTTP server on the local network (`electron/netshare.cjs`) the
  first time something is shared, and stops it when the last share ends or the app quits. Every share is
  a *room* behind a random 128-bit token: `http://<this computer>:<port>/s/<token>/` for a view,
  `/a/<token>/` for an album. Nothing without the token is answered. The address is shown as a QR code
  and as text.
- **The relay** (`node scripts/relay.mjs [port]`, self-hosted; set its address under View ▸ Network
  Relay) carries the same rooms for guests who cannot reach the computer directly. The web app, which
  has no server of its own, shares through the relay alone. A room on the relay belongs to the key the
  host sends with its first update; other keys cannot overwrite it; rooms vanish 15 minutes after the
  host's last update. The relay keeps everything in memory and logs nothing.
- The **Phone Remote** (slideshows) keeps its own server and `/r/<token>/` rooms; the two do not mix.

## Protocol

Both servers answer the same requests under a room's base URL, with CORS open to any origin (the token is
the secret), `cache-control: no-store`, and no cookies.

| Request | Answer |
|---|---|
| `GET` (the base) and `GET app.js` | the guest page for a browser (view or album) |
| `GET state` | the room's current state as JSON; with `?since=<sig>` equal to the state's `sig`, `304` instead |
| `GET events` | server-sent events: the state at once, then every change (`data: <json>`) |
| `PUT` or `POST state` with `authorization: Bearer <key>` | *relay only*: the host's update (the desktop server is fed in-process); `401` without a key, `403` with another room's key, `400` for non-JSON, at most 8 MB |
| `GET thumb/<id>`, `GET file/<id>` | *album, desktop server only*: a JPEG thumbnail; the picture file itself |
| `POST add?name=<file name>` (body: the file) | *album, desktop server only, when additions are allowed*: saves into the chosen folder (names made safe, never overwriting, at most 64 MB, streamed to disk) and adds the picture to the album. Pictures only, by name (`415` for anything else: programs, pages, SVG); at most 3 uploads at once and 500 per shared album (`429`); `413` when too large or empty; `410` when sharing stopped while the upload was on its way (nothing is kept); `403` when additions are not allowed |

**Limits.** A request whose address does not parse is answered `400` by every server. Each room serves at most 64 event streams (`503` beyond that); a guest that stops reading gets the latest state when it catches up, not every state in between. The relay holds at most 64 rooms, 8 made from one address (`429` with `retry-after`; set `RELAY_MAX_ROOMS`, `RELAY_ROOMS_PER_ADDRESS`, `RELAY_MAX_GUESTS` to change them), and frees a room a minute after its host says it has stopped. In the desktop app, rooms and the phone remote end with the window that started them.

**View state**: `{ kind: "view", name, index, total, caption, rel, nx, ny, key, picture, size, sig }` —
`rel` is the zoom relative to fitting the whole picture, `nx`/`ny` the view's center as fractions of the
picture, `key` identifies the picture (guests fetch it only when the key changes), `picture` is a JPEG data
URL of what is on screen (long side 1600 px), `size` the file's size, `sig` the signature guests send back
with `since`. The host sends `{ kind: "view", ended: true }` when it stops.

**Album state**: `{ kind: "album", name, contribute, files, items: [{ id, name, size, mtime, thumb? }], sig }`
— `files` is true where `file/<id>` works (the desktop server), false on the relay, where each item carries
its thumbnail inline instead; `contribute` says whether `add` is allowed.

## In Anne's Lens

- **Share View on the Network** (toggle) publishes the active window: its picture as a rendition, the zoom
  and the pan, at most four times a second through the relay, at once on the local server. Share View needs
  a picture; the window followed is the one the command is run in.
- **Follow a Shared View** (toggle) takes a room address and opens a *Shared view* window that shows the
  host's pictures (the last sixty kept as a history) at the host's zoom and pan. When the same file (by name
  and size) is open in another window here, that full-quality copy is shown instead of the rendition. On the
  desktop and Android the state is polled through the native layer (every 400 ms, conditional); in a browser
  the event stream is used.
- **Share Album** (toggle) publishes one album: its listing at once, thumbnails as they are made. On the
  desktop, guests download the files (only files the app may read are served) and, when the box is ticked,
  add pictures into a folder chosen in the system dialog; each addition is saved there, added to the album,
  and announced. Through the relay, guests get the listing and thumbnails only.
- **Open Shared Album** takes a room address and opens the album as a folder (*Shared album: name*) whose
  pictures download from the host as they are shown; through a relay they are the thumbnails.
- **Network Relay** stores the relay address (empty: local network only). It is kept with the other
  preferences, not written into any shared data.

## Privacy

Sharing is off until a command turns it on, shows the address it created, and stays visible as an active
toggle until turned off. Guests see renditions of what the host shows and the files of the one shared
album; nothing else on the host's computer is reachable. The relay sees the same data in transit and keeps
it only while the room lives; run your own for anything private.
