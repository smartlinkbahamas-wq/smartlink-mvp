# Working in this frontend

Next.js 15.5.29, App Router, TypeScript, Tailwind.

This file previously claimed the Next.js here was modified and told you to read
`node_modules/next/dist/docs/`. Both were wrong: that directory does not exist,
and the installed `next` is the stock 15.5.29 package from the registry. Your
normal knowledge of Next.js 15 App Router applies.

## A passing build does NOT mean the code is correct

`next.config.ts` sets both of these:

```ts
eslint:     { ignoreDuringBuilds: true }
typescript: { ignoreBuildErrors: true }
```

So `npm run build` succeeds with type errors and lint errors still in the code.
This is not theoretical — it hid a `nextRole is not defined` ReferenceError in
the auth callback that broke sign-in after a correct MFA code, and the build
was green the whole time.

Run these yourself; the build will not run them for you:

```bash
npx tsc --noEmit
npx eslint src/path/to/changed-file.tsx
```

`backend-api.ts` already has pre-existing `no-explicit-any` errors. Check
whether a lint failure is yours before fixing it.

## Things that are easy to get wrong here

- **Dates.** Bookings and jobs are a local date plus a clock time with no
  timezone. `new Date("2026-12-01")` is UTC midnight, which is the previous day
  anywhere west of Greenwich. Parse at local noon: ``new Date(`${value}T12:00:00`)``.
- **Money.** Integers in cents. Round each line before summing, or displayed
  line totals will not add up to the displayed total.
- **No RLS.** Supabase row-level security is not enabled anywhere, and the
  browser ships the anon key. Never query a table holding other people's data
  directly from the client — go through the backend, which scopes by owner.
- **API base.** The backend mounts `/api`, not `/api/v1`. A `/api/v1/...` path
  returns a silent 404.
