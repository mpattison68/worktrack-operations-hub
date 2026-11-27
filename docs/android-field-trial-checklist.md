# WorkTrack — Android Field Trial Checklist (Acceptance Test T26)

Use this checklist on an actual inexpensive Android phone over mobile data before production rollout.

## Prerequisites
- Production or staging WorkTrack URL served over HTTPS from your Linux VM (not the Lovable preview URL; service workers intentionally refuse registration on Lovable preview hostnames).
- Test accounts invited for **Owner** and **Supervisor** on a staging business (never production worker or loan records).

## 1. Install on Android (Chrome)
- [ ] Open WorkTrack HTTPS URL in Chrome on Android.
- [ ] Tap browser menu -> **Add to Home screen** / **Install app**.
- [ ] Launch WorkTrack from the home-screen icon and confirm standalone display (no browser address bar).
- [ ] Verify top bar shows **Online**, **Connected to Supabase**, and **All synced**.

## 2. Offline Capture & Persistence Across App Restart (T19, T22, T26)
- [ ] Turn on **Airplane Mode** (or toggle **Work offline** inside the Sync Center popover).
- [ ] Confirm top bar updates to **Offline**.
- [ ] Open **Expenses** -> capture a fuel or supplies expense with a missing-receipt reason -> confirm toast says **Saved on phone — pending sync** (not uploaded).
- [ ] Open **More -> Photos** -> take a site/receipt photo -> confirm badge says **Saved on phone** and **EXIF stripped**.
- [ ] Open **More -> Truck check** -> mark **Engine oil** as **Problem** -> confirm **STOP — DO NOT USE THIS VEHICLE** displays immediately offline and saves to queue.
- [ ] Force-close the WorkTrack app completely and reopen it while still in Airplane Mode.
- [ ] Confirm pending sync badge and queued items/photos are still intact after restart.

## 3. Reconnect, Deduplicated Sync & Conflict Check (T19, T20)
- [ ] Turn off Airplane Mode and wait for the app to reconnect (or tap **Sync now**).
- [ ] Confirm each queued expense creates **exactly one** expense and **one** balanced ledger posting (no duplicates).
- [ ] Confirm the offline truck check marks the vehicle unavailable and raises one deduplicated critical alert.
- [ ] Confirm the photo badge changes from **Saved on phone** to **Uploaded**.
- [ ] Trigger a stale-revision edit (edit the same record from desktop Admin while offline on Android) -> reconnect -> confirm **Revision conflict — review required** opens showing both versions side-by-side with no silent overwrite.

## 4. Shared-Device Logout Safety
- [ ] Queue one offline record while offline, then tap **Sign out**.
- [ ] Confirm the warning dialog appears (**Unsynced records on this device**) with **Stay signed in** and **Discard & sign out**.
- [ ] Choose **Discard & sign out**, sign in as a different user on the same phone, and confirm none of the previous user's drafts or photos appear.