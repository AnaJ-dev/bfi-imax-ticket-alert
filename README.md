# BFI IMAX Ticket Alert

Chrome extension that watches BFI IMAX screenings for sold-out slots that open up, for any number of films at once. Checking happens fully in the background — a routine check normally opens no window or tab. The exception is a Cloudflare block: the extension then opens a short-lived minimized window to refresh its session, and closes it again. When a screening flips from sold out to bookable, it:

1. Fires a desktop notification immediately.
2. Shows a red badge on the extension's toolbar icon, so it's visible even if the notification gets missed or dismissed — clears once you open the popup. **This needs the extension pinned:** Chrome hides new extensions behind the puzzle-piece icon, and it draws no badge there. Click the puzzle-piece icon and pin this extension; the popup and the options page will remind you until you do.
3. Opens a background tab on the booking page, jumped straight to that screening, and brings it to the front once it lands there — so you can finish checkout yourself.

The extension only ever clicks the Buy link whose date and time match the screening you picked. If it can't find that exact link, it clicks nothing and tells you instead, leaving the film page open so you can book manually.

**It acts inside your signed-in BFI session.** Requests are made with your own cookies, so if you're logged in to BFI, the extension browses as you. It never completes a purchase — it stops at seat selection, and payment always happens on BFI's own site with you at the keyboard.

## Setup

- Go to `chrome://extensions`
- Enable **Developer mode** (top right)
- Click **Load unpacked**, select this folder

Pick a film from the dropdown in the popup and tap "Get notified for all screenings" (or 🔕 next to a specific sold-out time) to start watching it. You can watch several films at once.

## Settings
- **Auto-check**: on by default — checks every few minutes by itself. Turn off to only check when you click "Check now". Applies instantly.
- **Desktop notification**: on by default — pop-up + toolbar badge when a slot opens. Applies instantly. "Send test notification" in Settings lets you confirm it actually shows up, since Chrome can't reliably report whether macOS is silently blocking it.

## Known limitations
- Desktop notifications and the badge only work while Chrome is running.
- Scraping relies on BFI's page embedding its screening data as a JS array literal — if they change that structure, checks will start failing (visible as "Last check failed" in the popup).
