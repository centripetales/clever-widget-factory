---
inclusion: manual
---

# Azolla Weekly Report Skill

When the user invokes this skill, produce the weekly azolla/duckweed experiment
observation report AND, unless the user only asked for the raw numbers, the
full payment email: stats table, photo montage, and draft text ready to
paste into Gmail. Default to last week's (Sunday-Saturday) window unless the
user names a different range.

## Fast path: the whole email in three commands

```bash
node scripts/azolla-weekly-report.js --last-week          # table + retry flags, for your own review
node scripts/azolla-weekly-heatmap.js --last-week          # phone-labeled heatmap HTML, paste into Gmail
node scripts/azolla-weekly-montage.js --no-upload           # compose montage; check tiles before uploading
```

Look at the montage before uploading — Stefan's and Mae's tiles can pick up
a photo that isn't actually representative of the experiment (this has
happened: a GCash receipt got mis-linked to Stefan's action once). If a tile
looks wrong, rerun with `--stefan-skip=1` / `--mae-skip=1` (2nd most recent)
until it looks right, THEN drop `--no-upload` to actually push it to S3 and
get the public URL:

```bash
node scripts/azolla-weekly-montage.js --stefan-skip=1
```

Paste the heatmap table and the montage's S3 URL (via Insert > Image > Web
Address in Gmail, not as an attachment — see the email template below for
why) into the draft, using the template's structure. Always show the user
the full draft and wait for their go-ahead — this goes to real people with
real payment amounts, never send it without an explicit "send it."

## Step 1: Run the report script

```bash
node scripts/azolla-weekly-report.js --last-week
```

Or for an explicit range:

```bash
node scripts/azolla-weekly-report.js --start=YYYY-MM-DD --end=YYYY-MM-DD
```

This handles the two bugs that bit us building this the first time — don't
recreate the query by hand:
- `organization_members` has one row per org a person belongs to. A naive
  join on `cognito_user_id` fans out every real observation by however many
  orgs that person is in (this turned Stefan's 117 real observations into
  1638 the first time). The script dedupes before joining.
- Some `organization_members.full_name` values are `''` (empty string, not
  `NULL`) — `COALESCE` alone won't catch that and several distinct people
  silently merge into one blank row.

## Step 2: Report the table and flag retries

Present the table the script prints. If it prints a "possible retry-duplicate
submissions" section, call those out explicitly rather than folding the
inflated count silently into the table — a person's raw observation count can
be padded by connectivity-retry resubmissions (confirmed for Buboy: 7 raw
rows were actually 2 real observations, same photos re-uploaded to new S3
keys after failed attempts). Automated system entries (e.g.
`[growth_color_metrics]`, `[azolla_duckweed_observation]`) firing many times
in under a minute are pipeline noise, not a person retrying — mention them
separately, don't imply a human resubmitted.

## Step 3: Add phone/email if asked

The script's `WORKER_MAP` already has phone numbers for active workers. If
the user wants email too, it's in `organization_members.email` for each
`cognito_user_id` — query directly, or ask the user for the roster (they keep
one; see the mapping given 2026-08-02 covering Wilfred, John_Kenneth,
Chael, Jusua, John_Marvin, Renzel, Buboy, LesterLuna, allan).

## Step 4: Update the roster when it drifts

If a worker's phone/GCash recipient changes, or a new worker joins, edit
`WORKER_MAP` in `scripts/azolla-weekly-report.js` directly — it's a plain
object keyed by `cognito_user_id`. People with zero observations in a given
week won't appear in the table at all (the query only returns people with
≥1 observation) — that's expected, not a bug.

## Step 5 (optional): Latest-photo montage

If the user wants a visual montage of each person's latest photo, pull the
most recent `state_photos.photo_url` per person (scope Stefan/Mae to their
azolla action via `state_links`, not raw `captured_by`, for the same reason
as the main report), download them, and compose a labeled grid with Pillow
(`ImageOps.fit` + `ImageDraw.text` under each tile). Flag any photo whose
content doesn't match its label (e.g. a payment receipt screenshot under an
azolla action) rather than presenting it as normal — that's happened before
(GCash receipt mis-linked to Stefan's azolla action) and is worth a second
set of eyes, not a silent pass-through.

## Step 6 (optional): EXIF timestamp spot-check

If asked whether submission dates match image dates, join
`photo_metadata_extractions` on `photo_url` and compare its `captured_at`
against `states.captured_at`, both converted `AT TIME ZONE 'Asia/Manila'`,
comparing calendar dates (not raw timestamps — a consistent several-hour
offset is normal EXIF/app timezone-tagging noise, not a real mismatch; only
flag it if the calendar day actually differs). A photo with EXIF metadata
years off from the app date usually means the phone's clock is broken (dead
battery resets old Android phones to a fixed date) — that's a device issue,
not evidence of anything wrong with the submission, and it means EXIF can't
be used to verify timing for that person going forward.

## Email template

```
Subject: Weekly Research Observation Update

Hi all,

Payments for this week's research observations (Sunday [start] through
Saturday [end]) were sent via GCash to the numbers below. Let me know if
anything looked off.

The next payout will be next Sunday, [start + 14 days].

Here are some group stats.

[paste heatmap table HTML here]

The most recent images from those participating this week:

[paste montage S3 URL here via Insert > Image > Web Address — NOT as an
attachment, which would store the full image in every recipient's mailbox
instead of once]

-- Stefan
```

Bcc field: use plain email addresses only, no display names — Gmail's bcc
parser breaks on duplicate/parenthetical display names (hit this exact
error with two "John Lester Luna" entries). Current roster:

```
salazarwilfred675@gmail.com, naragjohnkenneth224@gmail.com, lascunachael134@gmail.com, jusuanatabio17@gmail.com, jmlayos4@gmail.com, xenzeluna3@gmail.com, johnlesterluna2@gmail.com, johnlester.luna@student.capsu.edu.ph, lanshomemadeproduct@gmail.com, mae@stargazer-farm.com
```

## Known people (as of 2026-08-02)

| Name | Phone | Email | Notes |
|---|---|---|---|
| Wilfred Salazar | 09388211690 | salazarwilfred675@gmail.com | |
| John Kenneth Narag | 09455185997 | naragjohnkenneth224@gmail.com | shares phone with John Marvin |
| Chael Lascuna | 09667334615 | lascunachael134@gmail.com | |
| Jusua Natabio | 09158545941 | jusuanatabio17@gmail.com | phone EXIF unreliable (old device, clock stuck ~2017) |
| John Marvin Layos | 09455185997 | jmlayos4@gmail.com | shares phone with John Kenneth |
| Renzel Luna | 09062303099 | xenzeluna3@gmail.com | |
| John Lester Luna (Buboy) | 09487149611 | johnlesterluna2@gmail.com | shares phone with LesterLuna; same physical person as LesterLuna row, tracked as two accounts |
| John Lester Luna (LesterLuna) | 09487149611 | johnlester.luna@student.capsu.edu.ph | see above |
| Allan de Domingo | 09100070209 | lanshomemadeproduct@gmail.com | |
| Stefan Hamilton | — | stefan@stargazer-farm.com | scope to action `7d5553bb-14ae-485d-9014-7f84ed49841f`, not raw captured_by |
| Mae Dela Torre | — | mae@stargazer-farm.com | scope to action `a98acb69-687e-4bad-aad4-34c1d35d3a58`, not raw captured_by |
| Lester Paniel | — | — | not running this experiment — exclude from the report |
