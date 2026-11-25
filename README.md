# Melvor Ledger

A companion for **Melvor Idle 2**. Paste the save string from the game's main menu (*Copy save string to clipboard*). It reads your levels, shop upgrades, equipped tools, mastery guild progress and bank, then tells you what to do next: the best money makers, the fastest route to any level, and which upgrade pays for itself first.

**Live site: https://zootzootzoot.github.io/melvor2/**

Everything runs in the browser. Your save is decoded locally and never uploaded. The last import, and a small history of previous imports used for "since last time" progress, stay in `localStorage` on your own device.

## Features

- **Plan (your route).** A speedrun-style, step-by-step plan from your save. Each step (quest, upgrade, gear, or a method to unlock) is chosen by how quickly it pays back the time it costs. What it depends on is resolved one layer down: training to the levels it needs, saving up the gold, the earlier quests in a chain, and recipes behind guild ranks. Training for one step counts toward the next, and a chart shows your gold per hour over play time.
- **Quests.** The quest line from your save with every remaining task: progress per goal, the fastest way to do it at your rates, the training it needs first, items to hand in (what you have, how to make the rest), rewards, and the shop upgrades and combat areas each quest unlocks. Quest requirements are read from the save.
- **Money makers.** Every method ranked by gold per hour. Open any row for the full per-hour ledger, the production chain and which of your upgrades affect it. There are five views:
  - **Best overall** (default). For each method, whichever pays more: from scratch, or from what's already in your bank.
  - **From scratch.** Full production chains. Each input is gathered by you (its time counts) or bought from the shop, whichever is cheaper. Shows where each minute of the hour goes.
  - **From your bank.** Only what your current bank can fuel, how long it lasts, and the total profit.
  - **Leave it running.** Single actions to leave going for 1 to 24 hours (gathering, or working through your bank), ranked by total gold over that time. Accounts for stock running out.
  - **Value added.** The best crafts, with inputs priced at their sell value.
- **Training.** For each skill: the fastest route to a target level, switching methods as better ones unlock. Shows total time, the gold it makes or costs, and the supplies it needs against what you have. Also lists every way to train the skill at any level. A **guild task planner** shows every mastery guild task with live progress from your save, how long each takes at your rates, and the fastest set of tasks to the next rank.
- **Upgrades.** Every shop upgrade you can buy next, priced against what it earns. Each card shows the gain in gold/hr and XP/hr on your best method for that skill, the payback time, whether you can afford it now, and how long your best method takes to earn the rest. Also lists every upgrade you own and what it does, **combat gear worth getting** (pieces you can craft or buy, each tested in the best loadout against your top combat targets and shown for the enemy it helps), and **potions worth drinking**.
- **Bank.** *Process first* shows what to turn each stack into before selling, and how much extra that earns. *Safe to sell* lists stacks nothing you can do (now or within 15 levels) uses, so you can free bank slots. *Everything* shows your bank's value, with sorting and search.
- **Next unlocks.** The most lucrative methods you're a few levels away from, with the XP and estimated time to get there.
- **Item lookup** (Ctrl K, or click any item icon). Where an item comes from, what it's used for, its value, how much you have, and what it does when equipped.
- **Copy summary.** One click copies your best money maker, best idle action and next upgrade, ready to paste into Discord.
- **Collection** (in Bank). Items you've found against all items, per source skill, with the quickest missing items to get at your rates and what's blocking the rest.
- **Your pace** (in Plan). With two or more imports, your total level and wealth over time, XP per day per skill, and when you'll reach each next milestone.
- **Explore at 99.** A sandbox with every skill at 99 and every upgrade, for browsing without a save. The landing page previews it.

## Layout

```
docs/                 the static site (GitHub Pages serves this folder)
  index.html
  css/app.css
  js/app.js           UI: views, routing, drawer, search
  js/ui.js            shared helpers, bonus text
  js/engine.js        rates with modifiers, chain solver, training planner, upgrade advisor
  js/save.js          save-string decoder
  js/vendor/          brotli-dec-wasm (MIT/Apache-2.0), streaming Brotli decoder
  data/game.json      generated from the game install
  icons/*.webp        generated from the game install
tools/build_data.py   regenerates data/ and icons/ from your local Melvor2.exe
tools/bump_version.py stamps cache-busting ?v= on script/style URLs (run before deploying)
tools/test/           node smoke test against a real save
```

## Regenerating game data after a patch

```powershell
python -I tools/build_data.py "C:\Program Files (x86)\Steam\steamapps\common\Melvor Idle 2\Melvor2.exe"
node tools/test/engine.test.mjs path\to\save_xxx.sav
python -I tools/bump_version.py
```

The script finds the Godot pack embedded in `Melvor2.exe` (format v4, unencrypted) and reads `Data/Packages/MelvorBase.json` from it. It extracts:

- items, recipes and the shop;
- each recipe's raw parameters;
- every shop-upgrade and toolbelt bonus;
- mastery guild tasks, ranks and rank rewards.

It also unwraps item icons from Godot `GST2` textures, which hold lossless WebP data.

Only shop purchases registered in the Shop entity config count as buyable. Some purchases are defined in the data but never sold.

## Save format (Alpha 0.11.5.5, save version 31)

- Save string = `Base64(file bytes)`, the same bytes as `%APPDATA%\Games By Malcs\Melvor Idle 2\steam\<id>\saves\save_<uuid>.sav`.
- The file is a **Brotli** stream. The game flushes it without closing it, so it has no final block. A streaming decoder must accept "needs more input" at the end.
- The payload is a .NET `BinaryWriter` stream: little-endian ints, 7-bit length-prefixed UTF-8 strings.
  - `int32 version`, then the header: GUID, character name, gamemode, timestamp, active action, total level, GP, slayer coins, demo flag.
  - `int32 entityCount`, then for each entity: `string id`, `int32 regionLength`, `int32 componentCount`, and for each component `string id`, `int32 length`, `bytes`.
  - The parts this site reads:
    - `Bank/Inventory`: tabs of item stacks (`int32 qty, bool placeholder, bool locked, string item`).
    - `Bank/Wallet`: `int64 qty, string currency`.
    - `Shop/Shop`: purchase counts.
    - `<Skill>/Experience`: `double xp`.
    - `<Skill>/Toolbelt`: equipped tools.
    - `<Skill>/MasteryGuild`: `bool hasCategory [string]`, `int32 n`, then per task `string id` plus a region. The region holds `bool hasGoal [string goalId, region{double progress, bool complete, bool active}]` and `bool triggerMet`.
    - `*/Statistics`: simple values (`string id`, region `double`), then item and currency tables (`string stat`, region `int32 n × (double value, string item)`).
- Levels use the game's `StandardExperienceTable(0.25, 300, 2^(1/7))`, capped at 99.

## How the numbers are computed

Rates use the game's own stat computers and action handlers, with your bonuses applied. Bonuses come from:

- owned shop upgrades;
- equipped toolbelt items;
- mastery guild rank rewards.

Each bonus applies where its context matches: skill, recipe, category, subcategory, product item or fishing location. Astrology and agility bonuses are not applied yet.

| Skill | Model |
|---|---|
| Woodcutting | Interval `⌊(base + flat) × (1 + %)⌋`. Expected hits to fell a tree are computed exactly, including double-damage, weak-spot and instant-cut chances. Per-hit and per-log drops scale with doubling chance. |
| Mining | Rock break chance `p = base × (1 + %)`. Each hit breaks early with chance `p`, otherwise progress += `p`, with a guaranteed break at ≥ 0.9999 (starting from minimum prospecting). Expected hits are exact. Ore quantity includes the +1 chance, doubling and shatter (3× ore, 2× XP). |
| Fishing | Uniform interval between the modified min and max. Fish vs junk by fish chance (plus junk reroll). Weighted fish table, doubling. Special items roll in ascending-chance order and the first success wins, with a second roll if you have that bonus. |
| Thieving | Stealth `⌊(level + flat) × (1 + %)⌋`. Success = `min(1, (100+stealth)/(100+perception))`. Failures add the stun interval unless avoided. Loot uses fortune (`⌊q × (1 + F/100)⌋`, averaged exactly) and doubling. XP and completion drops come once per completed set of stages, with stage skipping. |
| Cooking | Success = `clamp((69 + proficiency)/(69 + difficulty))`. Ingredients are spent on failure unless preserved. |
| Smithing, Crafting, Fletching, Runecrafting, Beastcrafting | Interval × expected actions per craft (steps with skip-step chance). Preservation reduces ingredient use. Doubling and flat/percent quantity apply per product. |
| Herblore | One brew is prepare + heat + stir, then **10 bottlings**. Each bottling spends ingredients and yields products + XP, so time per potion = `(prepare + heat + stir)/10 + bottling`. |
| Firemaking | Interval, preservation, by-product chances, and currency rewards with doubling. |
| Hunting | Per animal caught: surveys until tracks are found (the third always succeeds), tracking steps (random between min and max, with skip chance), then trap attempts at the trap success chance. Each attempt uses one trap (the cheapest of the animal's trap type) unless preserved. A failed attempt re-tracks the minimum steps unless you reattempt. |
| Combat | Per enemy, every style is tried: melee, ranged and magic. For each, a loadout is built from the gear you own (equipped or in the bank): the top weapons with matching ammo or the best castable spell, then each armour slot improved in turn against that enemy. Accuracy and evasion are `⌊(level ratio + 9) × (stance bonus + 64)⌋`, and hit chance is `acc ≥ eva ? 1 − eva/(2·acc) : acc/(2·eva)`. Max hit is `⌊22 + L + (L+17)·strength bonus/64⌋` (melee/ranged) or `⌊spell max hit × (1 + damage bonus) × (1 + (L+1)/200)⌋` (magic), then × element (±15%) and × combat triangle (±10%). Damage rolls uniformly from 1 to max hit, minus resistance `clamp(prot/(pow+prot), 0, 0.7)` and armour. Your resistance is also scaled by the triangle. Kill time is HP ÷ DPS + 3 s respawn. Food (for damage taken), ammo per attack and runes per cast are costs. For training, only weapons and stances that give that skill's XP count. Fights where the enemy can deal ≥ 90% of your HP, or that take over 20 minutes per kill, are excluded. Special attacks, passives, prayers and slayer tasks are not modelled. |
| Farming | Passive, per plot (base rates). |
| Ranching | Passive, per adult animal per product interval, before happiness, variant and feed bonuses. |

- **From scratch** uses a Dinkelbach-style fixed point. Your time is valued at the best rate you can reach (λ gp/ms). Each item's cost is then `min(shop price, Σ input costs + λ·time − by-product value)`, relaxed until it stops changing.
- **Mastery guild ranks** come from task points. Goal and trigger tasks are read from the save. Level, item-statistic and value-statistic conditions are evaluated. Anything else counts toward an upper bound only, and a requirement that falls between the bounds shows as "probably".
- **Training plans** step through level bands, re-evaluating whenever a new method unlocks. In each band they pick the method that reaches the band's XP soonest. Inputs come from your bank first, with no gathering time, until they run out. After that the inputs are made from scratch: the cheapest production chain's time is added, and XP earned in the same skill along the way counts (e.g. crafting Water Runes while training on Fire Wands). The same per-hour-of-play rates drive the XP/hr table, guild task estimates, pet estimates and unlock times.
- **Upgrade advice** re-runs the whole engine with the upgrade added. It compares your best money maker and best XP/hr in that skill before and after.

## Deploying

GitHub Pages: **Settings → Pages → Deploy from a branch → `main` / `docs`**. Run `tools/bump_version.py` before each deploy, so returning visitors don't mix cached modules.

## Disclaimer

Fan-made and unofficial. Not affiliated with Games by Malcs. Game names, data and artwork belong to their owners.
