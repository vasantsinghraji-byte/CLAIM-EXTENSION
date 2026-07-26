# Reload After an Update

1. Run `npm run build` if you are developing locally.
2. Open `chrome://extensions`.
3. Find **Claim Amount Auto-Fill**.
4. Select **Reload**.
5. Refresh every open RGHS tab.

If Chrome reports **Extension context invalidated**, the RGHS tab still holds
the old content-script context. Refreshing that tab is required.

For a distributed ZIP, extract the new package over a dedicated release folder
before selecting **Reload**. Never load the ZIP directly.
