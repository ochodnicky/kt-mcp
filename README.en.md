# kt-mcp

[🇨🇿 Česky](README.md) · **🇬🇧 English**

A self-hosted [MCP](https://modelcontextprotocol.io) server that connects an AI agent to your **kaloricketabulky.cz** food diary.

You say *"I ate 3 eggs and a banana"* — the agent searches the Czech food database, picks the right portion unit, and writes the entries into your real diary. The official app stays the source of truth, so premium features keep working.

Built and tested with **Claude** (desktop, mobile and web via a custom connector), but it speaks standard MCP over HTTPS with OAuth 2.1, so any agent that supports remote MCP servers can connect.

> ## Unofficial, and not affiliated with Dine4Fit
>
> kaloricketabulky.cz is operated by **Dine4Fit, a.s.**, who are not involved in
> this project and do not endorse it. There is no public API; the endpoints used
> here were read out of the site's own frontend JavaScript and may change or
> break without notice.
>
> Dine4Fit's terms grant a **personal, non-commercial** licence. This software is
> published so that you can automate access to **your own account** — which is
> what that licence permits. Running it as a paid or multi-tenant service, or
> redistributing the food data it returns, is a different matter and is on you.
> The database is Dine4Fit's and is protected by EU database rights.
>
> Keep the request rate human. Don't build a competing client on it.

## What you can do with it

Once connected, food logging stops being a chore of tapping through search screens — and the diary can be read, analysed and corrected too. Some patterns that work well in practice:

- **Log by talking.** "I had a rohlík with ham and two eggs for breakfast." The agent searches, resolves natural portions (*kus (55 g)* instead of guessed grams) and logs each item under the right meal.

- **Log your favourites.** "Add my favourite sourdough bread, two slices, for breakfast." The agent finds it among your favourite foods (`list_favorite_foods`), picks the portion and logs it after you confirm.

- **Repeat yesterday.** "Copy yesterday's lunch to today." or "Copy all of yesterday to tomorrow."

- **Automate your routine.** You drink two coffees with milk every day — why type it? If your agent supports scheduled tasks (Claude does), tell it once: *"Every day at 9:00 log two espressos with milk."* Daily constants log themselves.

- **Photograph your plate.** Send the agent a photo of your lunch and ask what's on it. It identifies the foods, estimates real gram weights from the image, computes the calories — and logs it once you confirm. An estimate is an estimate, but for mixed plates it beats logging nothing.

- **Photograph a recipe.** Snap a recipe from a cookbook or a screenshot from the web and say *"save this as a meal"*. The agent reads the ingredients, finds each one in the database, and creates a reusable saved recipe — one entry to log next time you cook it. You can edit on the way in: *"swap the cream for white yogurt and halve the sugar."*

- **Find out what gives you the most.** "Which foods gave me the most protein this week?" The server adds up each nutrient per food exactly (a language model would slip) and never counts unknown values as zero. You can look inside a saved recipe too: "Where does the protein in my carrot cake come from?"

- **Ask how your day, week or month is going.** "How many calories and how much protein do I have left today?" "What was my average deficit over the last month?" "How is my weight trending?"

- **Correct and complete.** "That quark was 250 g, not 200." "Delete today's afternoon snack." "Log a half-hour walk." "Add a note to lunch that it was a restaurant." "Record today's weight as 81.7 kg."

- **Work out why your weight is stuck.** "My weight isn't moving, find out why and suggest changes to my goals." The agent reads your goals (`get_goals`), estimates from your diary and weight trend what your body really spends and compares it with what the site assumes (`get_energy_model`). It then proposes a concrete change (activity level, own basal, macros) and **writes it only after you agree** (`update_goals`). The `plateau_review` prompt does this in one go.

- **Get the data into a spreadsheet.** "Export the last 30 days as CSV." Paste the result into Excel or Google Sheets.

## Tools

Tools that **change the diary** are marked ✏️. The agent should call them only after you confirm whenever anything is ambiguous; writes are never retried blindly.

### Finding and logging food

| Tool | Purpose |
|---|---|
| `search_food` | Find foods by Czech name or 13-digit EAN barcode. Returns the food id the other tools need. |
| `get_food_portions` | List a food's natural portion units (`kus (55 g)`, `velký kus (60 g)`) so "3 eggs" logs as three pieces rather than an estimated weight. |
| `get_food_nutrition` | Calories and macros for a quantity, scaled by the site itself. Read-only. |
| `log_food` ✏️ | Write an eating record into the diary. |
| `list_favorite_foods` | Favourite foods, optionally filtered by name (accents and case ignored). The id works with `get_food_portions` and `log_food`. Read-only. |
| `list_common_foods` | The foods you log most often. Read-only. |
| `add_favorite_food` ✏️ / `remove_favorite_food` ✏️ | Mark / unmark a food as a favourite and confirm the result. Touches no entries. |

### What I ate (reading)

| Tool | Purpose |
|---|---|
| `get_day_summary` | The site's raw day totals, goals and weekly charts, passed through. Contains no individual entries. |
| `get_day_entries` | The individual entries logged on one day (foods and saved recipes), grouped by meal: name, logged quantity and nutrients; plus the day's activities and notes. Each entry carries an `entry_id`, each activity an `activity_id`, each note a `note_id`. |
| `get_diary_range` | The same for a range of days `from`–`to` (both end days included, at most **14** days). Each day is reported as filled, empty or failed to load. |
| `get_nutrient_ranking` | Rank foods by the summed amount of one nutrient (protein, energy, carbohydrate, fat, fibre, sugar, saturated fat, salt) over up to **90** days. |
| `get_day_balance` | The site's balance for one day: intake against the goal, energy spent (basal + activity), net balance, and goal-vs-actual for protein, carbohydrate, fat and more, each with its unit. |
| `get_balance_range` | The same over up to **90** days, with averages (over days where something was logged) and the number of days loaded and failed. |
| `get_weight_history` | Recorded weights for the month around a day, plus current and target weight. |
| `export_diary_csv` | Every entry over up to **31** days as CSV (dot as decimal separator, unknown value = empty cell). |

### Changing the diary

| Tool | Purpose |
|---|---|
| `update_diary_entry` ✏️ | Change the logged quantity (and optionally the unit) of one entry. The site cannot edit entries logged from a saved recipe. |
| `delete_diary_entry` ✏️ | Delete one entry. It first checks the entry is on that day, then re-reads the day and confirms it is gone. |
| `copy_meal` ✏️ | Copy a whole meal (e.g. yesterday's lunch) onto another day, optionally into a different meal. **Not idempotent** — a second call creates duplicates. |
| `copy_day` ✏️ | Copy every meal of a day, meal by meal into the same slots (activities and notes are not copied). On a failure it stops and says what was already copied. Not idempotent. |
| `search_activity` | Find an activity in the site's catalogue (walking, cycling, …). |
| `log_activity` ✏️ | Log an activity for a number of minutes; the site computes the energy. Supports activities measured in hours (walking, cycling and the like). |
| `delete_activity` ✏️ | Delete one activity from a day. Activities imported from a watch or phone may come back on the next sync. |
| `add_diary_note` ✏️ / `delete_diary_note` ✏️ | Add a note to a whole day or to one meal / delete it. |
| `log_weight` ✏️ | Record a body weight. The site keeps one value per date, so it replaces any existing one. |

### Goals and energy estimate

| Tool | Purpose |
|---|---|
| `get_goals` | Goal (lose / maintain / gain), weight and target weight, activity level, basal metabolism and daily energy goal (the site's calculation and the user's own override), nutrient goals in grams and %, and the drinking goal. `in_use_today` shows what the diary really applies today. Warnings flag things such as macros that do not add up to the energy goal. Reads a fixed set of fields only; e-mail, password, agreements and tokens are never returned. |
| `update_goals` ✏️ | Change the goal, target weight, activity level (1; 1.2; 1.375; 1.55; 1.725; 1.9), own basal, own energy goal, nutrient goals (grams, or % for protein, carbohydrate and fat together) and the drinking goal. Only the fields passed change; `null` clears an own value. Returns before, after, what the site did not take and warnings. It never touches weight, e-mail or password. |
| `get_energy_model` (`weeks`, `to`) | Estimates what the body really spends: average intake plus the energy released by the weight trend (1 kg ≈ 7,700 kcal), set against the expenditure the site assumes. Returns the margin, a confidence (`low` / `medium` / `high`) and caveats. Today is not counted. |

### Recipes

| Tool | Purpose |
|---|---|
| `create_meal` ✏️ | Save a recipe built from existing foods. |
| `list_my_meals` | List saved recipes with their ids and total energy. |
| `get_meal_details` | A saved recipe's ingredients with amounts and nutrition, plus totals for the whole recipe (not per portion). |
| `log_meal` ✏️ | Log a whole saved recipe into the diary as one entry. |
| `delete_meal` ✏️ | Delete a saved recipe. |

### Prompts

Clients that support MCP prompts offer these as ready-made shortcuts:

| Prompt | What it does |
|---|---|
| `weekly_review` (`from`, `to` optional) | A weekly review (default: the last 7 days): average intake, energy spent and balance, protein against goal, main protein sources and weight trend. |
| `plateau_review` (`weeks` optional, 2–12, default 4) | "Why is my weight not moving?": goals, expenditure estimate, logged days and weight trend → the most likely cause → at most two concrete changes. **Changes nothing until you confirm.** |
| `log_favorite` (`food`, `amount`, `meal`, `date`) | Finds a favourite food, picks the portion and asks for confirmation before logging. |

### Examples: what you say and what the agent calls

| You say | The agent uses |
|---|---|
| "Add my favourite sourdough bread, two slices, for breakfast." | `list_favorite_foods` → `get_food_portions` → `log_food` |
| "Which foods gave me the most protein over the last week?" | `get_nutrient_ranking` |
| "What is my carrot cake made of, and how much protein does it have?" | `list_my_meals` → `get_meal_details` |
| "How much protein do I still need today?" | `get_day_balance` |
| "What was my average deficit over the last month, and how did my weight change?" | `get_balance_range` + `get_weight_history` |
| "Copy yesterday's lunch to today." | `copy_meal` |
| "That quark this morning was 250 g." | `get_day_entries` → `update_diary_entry` |
| "Delete today's afternoon snack." | `get_day_entries` → `delete_diary_entry` (after confirmation) |
| "Log a half-hour walk." | `search_activity` → `log_activity` |
| "Note on tonight's dinner that it was a restaurant." | `add_diary_note` |
| "Record my weight as 81.7 kg." | `log_weight` |
| "Export the last 30 days as CSV." | `export_diary_csv` |
| "Give me a weekly review." | the `weekly_review` prompt |
| "What are my goals, and do the macros match the calories?" | `get_goals` |
| "My weight is stuck, find out why and suggest changes." | the `plateau_review` prompt → `get_goals` → `get_energy_model` → (after you agree) `update_goals` |
| "Set carbs to 178 g so it matches the goal." | `get_goals` → `update_goals` |
| "Change my activity level to lightly active." | `get_goals` → `update_goals` |

### How writes are guarded

- Tools that change or delete an existing record (`update_*`, `delete_*`) always **re-read the day first** and check that the `entry_id`, `activity_id` or `note_id` is really on it. Only **one** item is changed or deleted per call; a comma-separated list of ids is refused.
- After a write the day is **re-read** and the result (`confirmed_gone`, `entries_added_to_target_day`, …) goes back to the agent. If only that follow-up read fails, the write is **not reported as an error**, so the agent doesn't repeat it; the result is `null` with a note to check it.
- `update_goals` reads the profile fresh, changes only the fields passed and sends the rest of the form back as it came (the site saves the whole form at once). Out-of-range values and impossible combinations (for example percentages for only some macros, or a sum above 100) are refused before anything is sent. After the write the profile is read again and any field the site did not take is reported.
- Every tool that takes a date rejects days that do not exist; the site silently rolls `31.02.2026` over to 3 March.
- Copying and adding notes or activities is not idempotent. The tool descriptions tell the agent so, and a failed `copy_day` reports what was already copied.

### Limits and cache

| Tool | Longest range |
|---|---|
| `get_diary_range` | 14 days (returns every entry) |
| `export_diary_csv` | 31 days |
| `get_nutrient_ranking`, `get_balance_range` | 90 days (aggregates only) |

Days are fetched one at a time. Days that are over are **kept in memory for 5 minutes**, so a repeated query over a long range is fast (30 days: ~3 s → ~0.2 s). Today and the future are never cached, every write made through this server empties the cache, and the reads that verify a write bypass it. A change made outside this server (in the app) can therefore take up to 5 minutes to show in past days.

### Smoke test

The shape of the site's responses is inferred from observation, not documentation, and the site can change it. `scripts/smoke.mjs` runs the client against your real account to check it still understands the replies:

```bash
npm run build
export KT_EMAIL='you@example.com' KT_PASSWORD='your-password'
npm run smoke              # read-only
npm run smoke -- --write   # also the write paths, see below
```

With `--write`, every write happens on **tomorrow only**, which must be completely empty (the script stops otherwise). It logs and edits a food, adds notes and an activity, copies a meal — and deletes all of it again; it adds and removes a favourite food that was not one, and re-saves the latest weight with its own value. It also temporarily changes the drinking goal, an own basal and one carbohydrate goal, checks they show up in the diary's energy goal, puts them back and compares the whole goals block with its original state (including checking that saving the profile did not add a weigh-in). It ends by checking tomorrow is empty again. Today and earlier days are never modified. Exit code 1 means a check failed.

### Not implemented yet

The site can do more than is offered here. Deliberately missing: editing a saved recipe or lines logged from one (the site handles them with an intricate form), custom foods and custom activities entered by hand, editing activities (only add and delete), logging litres drunk (setting the drinking goal works), tracked measurements (waist and so on), regular activities, e-mail, password and other account settings, sharing, day templates, and the site's native XLS/PDF export (`export_diary_csv` replaces it).

### Recipes: quantities

The site calls a saved recipe a *meal*. `create_meal` composes one from
existing foods, so "3 eggs and 200 ml milk" becomes a single reusable item
rather than two entries typed out every time.

Quantities follow the same rule as `log_food`: `amount` counts **units**, not
grams. Omitting `unit_id` selects the food's own base unit, which is grams for
solids and millilitres for liquids — what recipes are normally written in. Pass
a `unit_id` from `get_food_portions` and the count multiplies it, so 2 of
`porce (250 ml)` is 500 ml. Getting this backwards is easy: an early test asked
for 100 of the `100 ml` unit and quietly created a recipe containing ten litres
of milk.

## How it works

kaloricketabulky.cz is a Spring MVC app where every route also answers JSON if you append `?format=json`, returning a `{code, data, message}` envelope. There is no official or documented API — these endpoints were recovered from the site's own frontend JavaScript. See `src/kt/client.ts` for the full map.

```
Agent  ──OAuth 2.1──►  kt-mcp  ──JSESSIONID──►  kaloricketabulky.cz
       ──MCP/HTTPS─►
```

Two credentials, doing different jobs:

| Secret | Guards |
|---|---|
| `MCP_AUTH_PASSWORD` | Who may connect this server to an agent. You type it once in a browser during the OAuth consent step. |
| `KT_PASSWORD` | The kaloricketabulky.cz account the tools write to. Never leaves the server. |

### What happens when you connect

You never create or copy a token by hand — OAuth does it for you:

1. You put your **kaloricketabulky.cz login** (`KT_EMAIL` / `KT_PASSWORD`) and a
   **passphrase you invent** (`MCP_AUTH_PASSWORD`) into the server's environment
   (`.env`). The kaloricketabulky.cz credentials stay on your server; the agent
   never sees them.
2. In your agent you add the connector URL, `https://<your-host>/mcp`. The agent
   registers itself with your server automatically (dynamic client registration).
3. A browser page opens — your server's consent screen. You type
   `MCP_AUTH_PASSWORD` once.
4. Your server mints a unique, random access token and hands it to the agent,
   which stores it and refreshes it automatically. From then on every tool call
   is authenticated with that token.

Because every person runs their own instance, every token is theirs alone: your
server knows only your diary and only mints tokens for whoever knows your
passphrase. Nothing is shared between installations, and there is no central
service.

## Local development

```bash
npm install
cp .env.example .env      # fill in your credentials
npm run build
npm test

set -a; source .env; set +a
PUBLIC_URL=https://localhost:8092 node dist/index.js
```

`GET /healthz` returns the resolved public MCP endpoint, which is the quickest way to confirm `PUBLIC_URL` is what you think it is.

## Self-hosting

> ⚠️ The server should run around the clock — on a PC that sleeps, scheduled
> logging fails. Details and recommendations in [HOSTING.md](HOSTING.md).

The reference deployment uses Docker, nginx, and a free Cloudflare Tunnel — no inbound port is opened on your host or router. Any other way of putting an HTTPS hostname in front of the container works too; the tunnel is just the cheapest safe default.

Request path:

```
Cloudflare → cloudflared (host network) → 127.0.0.1:80 → nginx → kt-mcp:8092
```

nginx publishes on the host loopback only and `cloudflared` dials out. The nginx config
(`deploy/nginx.conf.template`) disables proxy buffering, without which Server-Sent
Events would be held until the stream closed and tool calls would stall.

**1. Create the tunnel** (once), in the Cloudflare Zero Trust dashboard → Networks → Tunnels:

- Create a tunnel, copy the **tunnel token**.
- Add a public hostname with service **`HTTP`** → **`localhost:80`**. The
  stack's `cloudflared` runs in host network mode, so `localhost:80` is the
  nginx published on the host loopback. Plain `http`, because the tunnel
  terminates TLS.

The hostname you choose is referred to below as `<your-host>`; any domain on
your Cloudflare account works, and nothing in the code is tied to it.

**2. Build the image**, from this directory:

```bash
docker compose build
```

**3. Deploy the stack.** `deploy/stack.yml` is the runtime compose file (works standalone or as a Portainer stack); set these environment variables:

| Variable | Value |
|---|---|
| `KT_EMAIL` / `KT_PASSWORD` | Your kaloricketabulky.cz login |
| `MCP_HOSTNAME` | `<your-host>` — the bare hostname, no scheme. nginx renders it into its config at start-up |
| `MCP_AUTH_PASSWORD` | A long passphrase you choose (min 12 chars) |
| `PUBLIC_URL` | `https://<your-host>` — must match the tunnel hostname exactly |
| `TUNNEL_TOKEN` | From step 1 |

Keep `docker-compose.yml` and `deploy/stack.yml` in sync — the first builds the image, the second runs it.

**4. Check the deployment** before wiring it into an agent:

```bash
./scripts/verify-deployment.sh https://<your-host>
```

**5. Connect your agent.** In Claude: Settings → Connectors → Add custom connector → enter `https://<your-host>/mcp`. The agent registers itself, opens the consent page, and you enter `MCP_AUTH_PASSWORD` once. Other MCP clients follow their own "add remote MCP server" flow with the same URL.

### Changing the domain later

The hostname is not baked into the image — only `PUBLIC_URL` and the tunnel's
public hostname need to agree. To move:

1. Point the tunnel's public hostname at the new domain (or create a new tunnel
   and swap `TUNNEL_TOKEN`).
2. Update `PUBLIC_URL` on the stack and redeploy.
3. Re-run the verification script, then remove and re-add the connector in
   your agent.

Step 3 is required: `PUBLIC_URL` is the OAuth issuer and the RFC 8707 resource
identifier, so tokens issued under the old hostname are correctly rejected
after the move.

### Stuck, or nowhere to run it?

If you hit a wall self-hosting, open a [GitHub issue](../../issues) — happy to
help you get unstuck, that's what the issue tracker is for.

Self-hosting does need a machine that is always on (see
[HOSTING.md](HOSTING.md)) and a Cloudflare account. If you have no way to run
it at all, you can reach me at **kt-mcp@stanwhy.me** and we can figure
something out — just know that running a private instance means real server
costs, which would be yours to cover.

## Authentication

The server is its own OAuth 2.1 authorization server, implementing what the MCP spec requires of a protected resource:

- `/.well-known/oauth-protected-resource/mcp` — RFC 9728 discovery
- `/.well-known/oauth-authorization-server` — RFC 8414 discovery
- `/authorize`, `/token`, `/register`, `/revoke` — authorization code + PKCE, dynamic client registration, refresh-token rotation

Access tokens live 30 days and are persisted to `/data` on a volume, so redeploying does not force you to reconnect.

### What the passphrase protects

`MCP_AUTH_PASSWORD` is the only way to obtain a token. Every request to `/mcp`
requires a valid bearer token, and tokens are minted solely by the consent form
after a constant-time comparison against that passphrase. Verified by audit
(`scripts/security-audit.sh`): unauthenticated and forged-token calls are
rejected, fabricated authorization codes and refresh tokens are rejected, no
public endpoint exposes a credential, and no verb or path variation reaches the
tools without a token.

Two things are public by design and safe to be so: OAuth discovery documents
(the spec requires them) and dynamic client registration. Registering a client
gets an attacker no further — they still cannot obtain a token without the
passphrase.

Brute force is bounded by a 100-requests-per-15-minutes limit on `/authorize`.
That limiter keys on client IP, so nginx **overwrites** `X-Forwarded-For` with
Cloudflare's verified `CF-Connecting-IP` and the app trusts exactly one proxy
hop. Appending to a caller-supplied header instead — or setting
`trust proxy: true` — lets an attacker forge a fresh bucket per request and
removes the limit entirely.

Residual risks worth knowing: anyone holding the passphrase has full access;
tokens cannot be revoked individually short of deleting `/data/oauth-state.json`;
and because client registration is open, a phishing link to the consent page
could capture the passphrase if you typed it there — check the client name shown
on the form before authorizing.

## Caveats

- **Undocumented upstream.** Dine4Fit guarantees nothing here; a frontend refactor could change payload shapes without warning. The client throws on anything unexpected rather than guessing, so breakage surfaces as a loud error rather than a wrong calorie count.
- **`md5(password)` is password-equivalent.** The site hashes the password client-side, so the hash is as sensitive as the password. Treat `KT_PASSWORD` accordingly.
- **One account per instance.** The server logs into a single kaloricketabulky.cz account. Two people, two containers.
- **Personal use.** Automating entry into your own account is a far softer position than bulk scraping, but it is still outside anything Dine4Fit has sanctioned. Keep the request rate human, and don't build a competing client on it.
- **`get_day_summary` does not contain individual entries.** It returns day totals, goals, profile values and weekly charts, and passes the site's response through unmodified because its shape isn't fully documented. The entries come from `get_day_entries` and `get_diary_range`, which read `/user/diary/{dd.MM.yyyy}/get`, the endpoint the site's own diary page uses.
- **Reading a day's entries is based on observation, not documentation.** The response shape was derived from one account over 30 days, and the client throws on any deviation. The site sends the quantity only as display text (`3 x kus (19 g)`); `quantity.raw` is always that text, and the numbers derived from it are `null` when it could not be read (some entries have no quantity at all). A saved recipe is recognised by the line carrying a saved-meal id, which has been confirmed on only a handful of entries. An empty day cannot tell "ate nothing" from "logged nothing". The day-level totals the site sends in the same response were 0 on days that had entries, so they are not used.
- **Every tool that takes a date rejects days that do not exist.** The site silently rolls `31.02.2026` over to 3 March, so a write or read would land on a different day.
- **How the site works out goals (measured on a real account).** Maintenance intake = basal metabolism × activity level; in "lose" mode the goal is a fixed 15 % lower. Changing the activity level from 1.2 to 1.375 raised the goal from 1,783 to 2,043 kcal; an own basal of 1,600 lowered it to 1,632. **An own energy goal switches the model off:** the site then shows no maintenance intake or deficit and reports the goal itself as "energy spent". Days on which the account had an own goal are therefore left out of `site_expenditure` in `get_energy_model`. The "computed" values in the profile form are not recalculated once an own basal is set, which is why `get_goals` also returns `in_use_today` from the day balance. The site stores energy in kJ, so a value can come back off by one (1,750 → 1,749).
- **`get_energy_model` is an estimate, not a measurement.** It needs a nearly complete diary and several weigh-ins under comparable conditions; day-to-day water swings of a kilogram can outweigh real change over a short period. The result always carries a confidence, the margin of the weight trend and a list of caveats. Days with nothing logged are skipped, so with an incomplete diary the real intake and expenditure are higher than shown.
- **Writing goals was verified live on a real account**: the drinking goal, an own basal and a carbohydrate goal were changed, showed up in the diary's energy goal, and were then put back to their original state; saving the profile did not add a weigh-in. Not verified: setting macros as percentages, changing the goal mode (lose/maintain/gain), and an own energy goal beyond an immediate revert.
- **Writes use the endpoints the site's own pages use and were verified live on a real account**, always reversibly: changing a quantity (including switching unit) and deleting an entry, copying a meal, adding and deleting a note (whole-day and per-meal), adding and deleting an activity, adding and removing a favourite food. `log_weight` was verified only by re-saving the same value for the same date (the site keeps one value per date; writing a new value could not be undone, so it was not tried). Not verified: deleting a line logged from a saved recipe, a `copy_day` over more than the test covered, and activities measured in a unit other than hours (`log_activity` refuses those).
- **The site deletes through a plain `GET`.** So the `delete_*` tools always check that the id is on the given day before deleting and re-read the day afterwards.
- **Balance.** `planned_deficit` is the site's "Kalorický deficit", i.e. goal minus maintenance intake, not how the day actually came out; the actual difference is `net_balance` (intake minus output, computed by the server). An intake of 0 means nothing was logged; the site cannot tell "ate nothing" from "logged nothing", so the averages in `get_balance_range` cover only days with a non-zero intake.
- **Recipe details** look up each ingredient's nutrition separately (one request per ingredient). An ingredient the site gives no figures for has `null`, and the totals then cover the known ones only.
- **Day notes carry the whole user record.** The site's response attaches the e-mail and a password hash to every note. The client reads only the `id`, `text` and date and passes nothing else on. Activities from different sources (phone, watch) can overlap. The `drinkRegime` field was always 0 over 30 days, so it is not exposed.
- **Partial portions of a recipe cannot be logged.** The meal-add form offers a `count` against portion, percent and gram pseudo-units, but the server ignores it and logs the whole recipe regardless — measured against a 249 kcal recipe, both 0.5 portions and half the total weight added the full 249. `log_meal` therefore takes no `portions` argument; log the ingredients individually with `log_food` when only part of a recipe was eaten.

## License

[MIT](LICENSE). The food database and the kaloricketabulky.cz service belong to Dine4Fit, a.s. — this licence covers only the code in this repository.
