# BFI Movie Catcher

Chrome extension that watches BFI IMAX screenings for sold-out slots that open up, for any number of films at once. Checking happens fully in the background — no window or tab ever opens for a routine check. When a screening flips from sold out to bookable, it:

1. Fires a desktop notification immediately.
2. Shows a red badge on the extension's toolbar icon, so it's visible even if the notification gets missed or dismissed — clears once you open the popup.
3. Opens a real window on the booking page, jumped straight to that screening, so you can finish checkout yourself.

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
