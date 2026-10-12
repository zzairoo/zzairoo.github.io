# doekoe.github.io
Doekoe bijhouden

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

The app stores players and match results in `localStorage` by default. If Supabase is configured, friends can join the same shared room with a room name and password.

Advanced mode calculates payouts from matches: choose winners, losers, the stake, and who each winner receives from.

Players can store their own IBAN and account holder name. The payouts page generates SEPA bank transfer QR codes in the browser, plus copyable payment details, so payment requests do not need an iDEAL provider or transaction fees.

## Supabase setup

1. Create a Supabase project.
2. Open the Supabase SQL editor.
3. Run the contents of `supabase-schema.sql`.
4. Copy `.env.example` to `.env`.
5. Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from Supabase project settings.
6. Restart `npm run dev`.

The room password and player PINs are hashed in the browser before being sent to Supabase. Tables are not directly readable by the anonymous key; access goes through security-definer RPC functions in `supabase-schema.sql`.
