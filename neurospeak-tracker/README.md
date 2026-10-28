# NeuroSpeak COD Tracker (Netlify)

Shared tracker for the 1,027 unfulfilled NeuroSpeak COD orders: call status, call attempts, customer decision, delivery stage, tracking number, notes, and who updated each order. Updates sync to everyone about every 12 seconds.

Access is protected by one team passcode. Customer names and phone numbers are never in the public files; they are only served after the passcode is checked.

## Deploy (one time, about 10 minutes)

You need Node.js 18 or newer (https://nodejs.org, LTS installer) and a free Netlify account.

Open a terminal in this folder, then run these one at a time:

```
npm install
npx netlify-cli login
npx netlify-cli sites:create --name neurospeak-cod-tracker
npx netlify-cli env:set TRACKER_PASSCODE "pick-a-strong-passcode"
npx netlify-cli deploy --prod
```

- `login` opens your browser to authorize the CLI.
- `sites:create` asks which Netlify team to use. If the name is taken, try another (e.g. `ns-cod-tracker-amira`). Your link will be `https://<name>.netlify.app`.
- The passcode must be at least 6 characters. The site refuses all access until it is set. Use something that isn't guessable, like 3 random words.
- The last command prints the live URL.

Drag-and-drop deploy on Netlify will NOT work for this site. It skips the server function that stores the updates.

## Daily use

- Each person signs in with their name and the team passcode. Their name appears on every order they update.
- Click a pipeline tile (e.g. "No answer / busy") to filter to that queue. Click it again to clear.
- Choosing a delivery stage on an undecided order marks it Confirmed automatically.
- "+1" logs another call attempt.
- Export CSV saves the currently filtered list.
- Orders with the same customer name are tagged "Duplicate on [date of the other order]".

## Changing the passcode

```
npx netlify-cli env:set TRACKER_PASSCODE "new-passcode"
npx netlify-cli deploy --prod
```

Everyone is signed out on their next save or refresh and must enter the new passcode. Change it whenever someone leaves the team.

## Where the data lives

- Base order list: `netlify/functions/api/orders-data.mjs` (private, inside the function).
- All tracking updates and added orders: Netlify Blobs store `neurospeak-tracker` on your site. Redeploying does not erase them.
