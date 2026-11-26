# Melvor Ledger

A companion for **Melvor Idle 2**. Paste the save string from the game's main menu (*Copy save string to clipboard*). It reads your levels, shop upgrades, equipped tools, mastery guild progress and bank, then tells you what to do next: the best money makers, the fastest route to any level, and which upgrade pays for itself first.

**Live site: https://zootzootzoot.github.io/melvor2/**

Everything runs in the browser. Your save is decoded locally and never uploaded. The latest save of each character you import, and a small history of previous imports used for "since last time" progress, stay in `localStorage` on your own device.

## Features

- **Plan (your route).** A speedrun-style, step-by-step plan from your save. Each step (quest, upgrade, gear, or a method to unlock) is chosen by how quickly it pays back the time it costs. What it depends on is resolved one layer down: training to the levels it needs, saving up the gold, the earlier quests in a chain, and recipes behind guild ranks. Training for one step counts toward the next, and a chart shows your gold per hour over play time. You can also pick a **goal** (a quest, a skill level, a method or dungeon to unlock, or **any item**) and get the full dependency-resolved route to it, including upgrades worth buying on the way because they save more time than they cost.
- **Getting ready for a fight.** For an enemy you can't farm safely yet, the site searches for the cheapest way there: equipment you could make, buy or farm (each costed with the item resolver below) and training in the combat skills, taking at each step whatever cuts the danger fastest per hour of effort (including bigger level jumps, so plateaus like armour soaking every hit can be crossed). Once it's safe, it keeps going while gear or levels pay back their time in gold within about 20 hours of farming. Pick **A fight** as a goal on the Plan tab for the full route (area requirements, training, each piece of gear with its own chain, then the fight with kills/hr and gold/hr after food), or use **Fights within reach** on Money makers → Combat. When an enemy is out of reach it says why (too much damage, or armour and resistance soaking your hits), and when a fight would cost more in food than it drops it says that too. The item resolver uses the same search: if an item only drops from an enemy you can't farm yet, the route includes getting ready for it.
- **How to get any item.** Pick an item (on the Plan tab, or *Plan how to get it* on any item card) and the site resolves the whole chain behind it, across every system: your bank, the shop, any recipe or gathering spot, thieving, enemy drops and dungeons, bank upgrades and chests, including sources you haven't unlocked. Each source's levels, quests, kills and shop purchases are resolved the same way, and so are its materials, down to the raw resources. The result is one ordered plan: your bank stock used once across the whole tree (leftovers like Geodes get opened for the ore), by-products kept for later steps, training merged per skill and shortened by the XP the plan's own steps give, food for fights chosen by the least time per HP healed, and the gold for anything cheaper to buy. When something can't be had yet, it says why, at the root: for example *Blackstone Golem Core drops from Blackstone Golem, which isn't safe with your gear yet*.
- **Quests.** The quest line from your save with every remaining task: progress per goal, the fastest way to do it at your rates, the training it needs first, items to hand in (what you have, how to make the rest), rewards, and the shop upgrades and combat areas each quest unlocks. Quest requirements are read from the save.
- **Money makers.** Every method ranked by gold per hour. Open any row for the full per-hour ledger, the production chain and which of your upgrades affect it. There are five views:
  - **Best overall** (default). For each method, whichever pays more: from scratch, or from what's already in your bank.
  - **From scratch.** Full production chains. Each input is gathered by you (its time counts) or bought from the shop, whichever is cheaper. Shows where each minute of the hour goes.
  - **From your bank.** Only what your current bank can fuel, how long it lasts, and the total profit.
  - **Leave it running.** Single actions to leave going for 1 to 24 hours (gathering, or working through your bank), ranked by total gold over that time. Accounts for stock running out.
  - **Value added.** The best crafts, with inputs priced at their sell value.
- **Slayer & dungeons.** Dungeons are ranked as money makers: each wave is fought with its best loadout, and the loot comes only at the end (chests are valued at their contents). Slayer shows your current task from the save, and each master's coins, XP and gold per hour over the tasks you can safely do. Slayer is also trainable in the Training tab.
- **Training.** For each skill: the fastest route to a target level, switching methods as better ones unlock. Shows total time, the gold it makes or costs, and the supplies it needs against what you have. Also lists every way to train the skill at any level. A **guild task planner** shows every mastery guild task with live progress from your save, how long each takes at your rates, and the fastest set of tasks to the next rank.
- **Astrology.** Your constellations from the save: knowledge, picks waiting to be spent, time to the next pick, and every node you could pick next ranked by what it adds to your best gold/hr or XP/hr in the skill it boosts (identical nodes are grouped). Astrology is trainable in the Training tab, its best picks appear in Upgrades, and the Plan adds a node pick as a step when it lifts your best rate.
- **Farm.** Your plots from the save: what's growing, watered and composted, and a countdown to when each is ready, with what to plant next. The best crop for each plot type with your bonuses and the best compost, using the game's yield formula (pests and disease above your protection cut the harvest, watering adds protection, regrowing trees count every harvest). What compost is really worth (the extra harvest it gives, not its 1 gp sell price), how many compost bins your plots need, what each flower adds across your farm, and which plot to buy next with its payback time.
- **Upgrades.** Every shop upgrade you can buy next, priced against what it earns. Each card shows the gain in gold/hr and XP/hr on your best method for that skill, the payback time, whether you can afford it now, and how long your best method takes to earn the rest. Also lists every upgrade you own and what it does, **combat gear worth getting** (pieces you can craft or buy, each tested in the best loadout against your top combat targets and shown for the enemy it helps), and **potions worth drinking**.
- **Bank.** *Put to use* turns your leftovers into progress: what to keep for unfinished quests, and per skill how much XP processing your stock gives (chains included, each product feeding the next step), how many levels that is, how much from-scratch training it saves, and whether it covers a level your route needs (the Plan's training steps say so too). *Process first* shows what to turn each stack into before selling, and how much extra that earns. *Safe to sell* lists stacks nothing you can do (now or within 15 levels) uses, so you can free bank slots. *Everything* shows your bank's value, with sorting and search.
- **Next unlocks.** The most lucrative methods you're a few levels away from, with the XP and estimated time to get there.
- **Items & recipes.** A browser for every item and recipe in the game. Filter items by category (equipment, weapons, food, chests, traps, compost) and by the skill that makes them, or show only what's in your bank. Each item shows its sell value, what it costs you to make (your time valued at your best rate) or buy, how many recipes use it, and how many you have. Recipes show inputs and products, gold/hr and XP/hr (at the level they unlock, if you can't do them yet) and what's missing. Sort by value, profit to make, bank value, uses or name. Works in the level-99 explorer too.
- **Item lookup** (Ctrl K, or click any item icon). Where an item comes from, what it's used for, its value, how much you have, and what it does when equipped.
- **Characters.** Every save you import is kept on this device, one per character (the newest save wins). Switch between them from the top bar, remove one, or compare up to six side by side: total level, gold, bank value, best gold/hr and method, farm income, quests done, and every skill level, with the leader in each row highlighted.
- **Copy summary.** One click copies your best money maker, best idle action and next upgrade, ready to paste into Discord.
- **Share card.** A 1200×630 picture of your profile (best gold/hr and method, bank value, farm income, the next step on your route, and your top 20 skills), drawn in your browser. Copy it or download it as a PNG.
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
  js/card.js          shareable profile card (canvas)
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

## Save format (Alpha 0.11.7, save version 32)

- Save string = `Base64(file bytes)`, the same bytes as `%APPDATA%\Games By Malcs\Melvor Idle 2\steam\<id>\saves\save_<uuid>.sav`.
- The file is a **Brotli** stream. The game flushes it without closing it, so it has no final block. A streaming decoder must accept "needs more input" at the end.
- The payload is a .NET `BinaryWriter` stream: little-endian ints, 7-bit length-prefixed UTF-8 strings.
  - `int32 version`, then the header: GUID, character name, gamemode, timestamp, active action, total level, GP, slayer coins, demo flag.
  - `int32 entityCount`, then for each entity: `string id`, `int32 regionLength`, `int32 componentCount`, and for each component `string id`, `int32 length`, `bytes`.
  - The parts this site reads:
    - `Bank/Inventory`: tabs of item stacks (`int32 qty, bool placeholder, bool locked, string item`), then the tab label, tag list and (from save version 32) `bool hasIcon [string item]`.
    - `Bank/Wallet`: `int64 qty, string currency`.
    - `Shop/Shop`: purchase counts.
    - `<Skill>/Experience`: `double xp`.
    - `<Skill>/Toolbelt`: equipped tools.
    - `<Skill>/MasteryGuild`: `bool hasCategory [string]`, `int32 n`, then per task `string id` plus a region. The region holds `bool hasGoal [string goalId, region{double progress, bool complete, bool active}]` and `bool triggerMet`.
    - `Astrology/Action`: action timer, then per constellation `string id` + region `{double knowledge, int32 n × string minorNode, int32 m × string majorNode}`. Each knowledge threshold gives one minor pick; every 4 minor nodes give one major pick.
    - `Farming/Passive`: `[bool + string category]`, `int64 currentTick`, then per plot `string id` + region `{bool watered, 4 × bool auto, bool [string selectedRecipe], bool [string selectedCompost], bool [string currentCompost], int32 state, ...}`. States: 0 locked, 1 empty, 2 growing `(string recipe, timer)`, 3 grown `(string recipe, int32 qty, string item, int32 regrows)`, 4 regrowing `(string recipe, timer, int32 regrows)`, 5 flower bonus `(string recipe, timer)`. A timer is `bool autoRestart, int32 state (0 stopped, 1 paused, 2 running), int32 waitTicks, int64 scheduledTick, int32 pausedTicksLeft`; time left = `(scheduledTick − currentTick) / waitTicks × interval`.
    - `*/Statistics`: simple values (`string id`, region `double`), then item and currency tables (`string stat`, region `int32 n × (double value, string item)`). Combat saves add enemy, dungeon, style, effect and prayer tables in the same shape (e.g. `CombatEnemyKilled` per enemy), which resolve kill-count unlocks.
- Levels use the game's `StandardExperienceTable(0.25, 300, 2^(1/7))`, capped at 99.

## How the numbers are computed

Rates use the game's own stat computers and action handlers, with your bonuses applied. Bonuses come from:

- owned shop upgrades;
- equipped toolbelt items;
- mastery guild rank rewards;
- found pets;
- unlocked astrology nodes (minor and major), plus each constellation's per-node knowledge bonus.

Each bonus applies where its context matches: skill, recipe, category, subcategory, product item, fishing location or constellation. Astrology's combat-stat nodes are listed but not yet fed into the combat model. Agility in Melvor Idle 2 only boosts Agility itself (techniques), so it adds nothing to other skills.

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
| Combat | Per enemy, every style is tried: melee, ranged and magic. For each, a loadout is built from the gear you own (equipped or in the bank): the top weapons with matching ammo or the best castable spell, then each armour slot improved in turn against that enemy. Accuracy and evasion are `⌊(level ratio + 9) × (stance bonus + 64)⌋`, and hit chance is `acc ≥ eva ? 1 − eva/(2·acc) : acc/(2·eva)`. Max hit is `⌊22 + L + (L+17)·strength bonus/64⌋` (melee/ranged) or `⌊spell max hit × (1 + damage bonus) × (1 + (L+1)/200)⌋` (magic), then × element (±15%) and × combat triangle (±10%). Damage rolls uniformly from 1 to max hit, minus resistance `clamp(prot/(pow+prot), 0, 0.7)` and armour. Your resistance is also scaled by the triangle. Kill time is HP ÷ DPS + 3 s respawn. Food (for damage taken), ammo per attack and runes per cast are costs. For training, only weapons and stances that give that skill's XP count. Fights where the enemy can deal ≥ 90% of your HP, or that take over 20 minutes per kill, are excluded. Enemy special attacks count: each has a chance per enemy turn to replace the normal attack, its hits deal a share of a normal roll or of max hit (missable or not), damage-over-time riders add their total, and the worst single special sets the danger. Enemy passives (healing, buffs) and prayers are not modelled. The loadout search ranks unsafe options by how far they are from safe (danger or kill time, whichever is worse), so it can climb toward a safe setup. |
| Farming | Per plot, planted and harvested promptly. Yield per harvest `max(1, ⌊(Q + flat) × (1 + % + compost) × (1 − (max(0, pests − protection) + max(0, disease − protection − watering))/100)⌋)` × (1 + doubling), times `1 + regrows` harvests over `interval + regrows × regrow interval`. Seeds use preservation and ingredient cost; compost is used once per planting. Flowers add their bonuses to every plot while they grow. |
| Ranching | Passive, per adult animal per product interval, before happiness, variant and feed bonuses. |

- **From scratch** uses a Dinkelbach-style fixed point. Your time is valued at the best rate you can reach (λ gp/ms). Each item's cost is then `min(shop price, Σ input costs + λ·time − by-product value)`, relaxed until it stops changing.
- **Mastery guild ranks** come from task points. Goal and trigger tasks are read from the save. Level, item-statistic and value-statistic conditions are evaluated. Anything else counts toward an upper bound only, and a requirement that falls between the bounds shows as "probably".
- **Training plans** step through level bands, re-evaluating whenever a new method unlocks. In each band they pick the method that reaches the band's XP soonest. Inputs come from your bank first, with no gathering time, until they run out. After that the inputs are made from scratch: the cheapest production chain's time is added, and XP earned in the same skill along the way counts (e.g. crafting Water Runes while training on Fire Wands). The same per-hour-of-play rates drive the XP/hr table, guild task estimates, pet estimates and unlock times.
- **Upgrade advice** re-runs the whole engine with the upgrade added. It compares your best money maker and best XP/hr in that skill before and after.

## Deploying

GitHub Pages: **Settings → Pages → Deploy from a branch → `main` / `docs`**. Run `tools/bump_version.py` before each deploy, so returning visitors don't mix cached modules.

## Disclaimer

Fan-made and unofficial. Not affiliated with Games by Malcs. Game names, data and artwork belong to their owners.
