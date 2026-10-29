# Hobby Wizards Label Maker v3

Makes price labels from your card lists and prints them on a NIIMBOT D110 over Bluetooth.
Everything runs in the browser and nothing is uploaded anywhere. Your card files are saved on the device you use.

## What's new in v3

- **Saved files.** Import a CSV once and it stays saved. You can import several, then use the dropdown at the top to switch between them.
  The ••• button lets you rename a file, change its currency, export it as CSV (or share it on a phone), fix which column is which, or delete it. Deleting asks first.
- **Edit cards.** Tap a price or the pencil to edit the price, name, number, condition, set code, set, rarity, copies and QR link. The label preview updates as you type.
  "+ Card" adds a new card. Delete asks first, and you can undo it.
- **Change many prices at once.** "% Prices" raises or lowers the ticked cards (or every card showing) by a percentage.
  It can then round them, for example so every price ends in .99. You get a preview first and an Undo afterwards.
- **£, $ or €** per file. Prices always print with the symbol first, like €1.99. Euro prices written as "2,50" are read correctly.
- **Built for phones.** It works on a 360 px wide screen. There are big buttons, Cards / Label / Printer tabs, and a Print button always at the bottom.
  Print connects to the printer by itself if it isn't connected yet.
- **Connecting.** "Connect printer" opens a list of every nearby Bluetooth device; pick the D110-xxxx one (on iPhone it may be unnamed).
  Where the browser allows it, the app remembers that printer and shows a one-tap "Reconnect" button next time.
  The Bluetooth check, the printer log and the old "search by name" button live under "Troubleshooting" at the bottom of the Printer tab.
- **Dark and light mode.** It follows the phone's setting; the half-moon button switches it.
- **Install it like an app** and use it offline once it's on a web link (see below).

## Phones and computers

| Device | Direct Bluetooth printing? |
|---|---|
| Android phone, Chrome | Yes |
| Windows / Mac / ChromeOS, Chrome or Edge | Yes |
| iPhone / iPad, any browser (Safari, Chrome, Firefox) | No. Apple doesn't allow Web Bluetooth, and every iPhone browser uses Apple's engine. |
| iPhone with the free **Bluefy** browser app | Yes. Tested with the D110: tap Connect printer and pick the D110-xxxx (or unnamed) device from the list. |
| Any device | You can always download the labels as PNG pictures and print them from the official NIIMBOT app. |

## Using it on a phone (needs a web link)

Phones need the app on an **https** web address. Opening the file straight from storage won't give you Bluetooth, offline mode or the home-screen install.

1. Put this folder on any free static web host. Examples: Vercel (free Hobby plan), Netlify, Cloudflare Pages, or GitHub Pages.
   There's no server code and no database, just these files.
2. **Android:** open the link in Chrome, then tap ⋮ > *Add to Home screen* (or *Install app*). There's nothing else to install.
3. **iPhone:** install **Bluefy – Web BLE Browser** (free, App Store), open the link in Bluefy and connect.
   If it won't print, export PNGs and use the NIIMBOT app.
4. Before connecting, close the NIIMBOT app and any other label app (the printer only talks to one at a time), and switch the D110 on.

Each phone keeps its own saved files. If two of you want the same list, use ••• > Export CSV (or Share) and import it on the other phone.
Clearing the browser's site data deletes the saved files, so export a copy of anything you've edited a lot.

When you change the app files, bump `VERSION` in `sw.js` so installed copies update.

## Using it on a computer

Open `index.html` in Chrome or Edge, or for the full experience serve the folder:
`python3 -m http.server 8000`, then open http://localhost:8000.
On a Mac, Chrome needs Bluetooth permission: System Settings > Privacy & Security > Bluetooth > Google Chrome.
On desktop Chrome/Edge, "Open a folder" imports every CSV in a folder in one go.

## CSV

Any columns, any order. The app guesses which column is which, and you can change it under ••• > "Columns from the original CSV".
Useful columns are name, number, price, set, set code, rarity, condition, a QR link, and copies.

**Set code:** add a column called `Set Code` (also understood: `Expansion Code`, `set_code`, `Code`, `Expansion`) holding the short code, like OP05, SVI or MEW.
When "Set" is ticked on the Label tab, the label shows the code with the number on one line, e.g. "OP05 · 119", instead of the full set name.
Without a code it falls back to the set name, shortened if it's too long. A column called `Expansion` that holds full names (like "Scarlet & Violet 151") is treated as the set name, not the code.
Prices can be written as 4, 4.5, £4.50, "£1,250.00" or 2,50. If the price column header says €, $ or £ (for example "Price (€)"), the file starts in that currency.
Exported CSVs use the same columns, so they import straight back in.

Nothing is ticked when a file opens. Use search and the filters, then **All** ticks only the cards that are showing.
Only ticked cards that are showing get printed or downloaded.

## QR codes

Every label gets a QR code by default. If a card has a link, that link is used.
Otherwise the code opens a Cardmarket search for the card's name and number, and you can change that link on the Label tab.
Shorter links make the squares in the code bigger, which scans more easily.

## Files

- `index.html`, `style.css`, `app.js`: the page
- `labels.js`: CSV reading, prices and currency, label drawing, CSV and zip export
- `store.js`: the saved file library (IndexedDB in the browser)
- `manifest.webmanifest`, `sw.js`, `icons/`: home-screen install and offline mode
- `vendor/`: NiimBlueLib 0.48.0 (talks to the printer, MIT) and qrcode-generator 2.0.4 (MIT); see `vendor/LICENSES.txt`
- `sample-cards.csv`: made-up SAMPLE cards
- `previews/`: true-size example labels (01–04) and v3 screenshots
- `tests/`: headless Chrome checks. Run `NODE_PATH=<dir with puppeteer-core> tests/run-all.sh`. QR scan check: `python tests/decode-qr.py` (needs zxing-cpp, opencv, pillow)
