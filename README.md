# Melvor Ledger

A money planner for **Melvor Idle 2**. Paste the save string from the game's main menu (*Copy save string to clipboard*) and see every way your account can make gold, ranked by GP per hour.

**Live site: https://zootzootzoot.github.io/melvor2/**

Everything runs in the browser. Your save is decoded locally and never uploaded. The last import is kept in `localStorage` on your own device.

## Features

- **Money makers**, with three pricing modes:
  - **From scratch.** Full production chains. Each input is either gathered by you (the time counts) or bought from the shop, whichever is cheaper. The expanded row shows where each minute of the hour goes.
  - **Value added.** Inputs are priced at their sell value, so the number is pure processing profit.
  - **From my bank.** Only what your current bank can fuel, how long it lasts, and the total profit.
- **Bank alchemy.** For every stack: sell it now, or what to process it into first, and how much extra that earns.
- **Your bank.** Value of every stack, with sorting and search.
- **Next unlocks.** The most lucrative methods you're a few levels away from.
- **Explore at 99.** A sandbox for browsing without a save.

## Layout

```
docs/                 the static site (GitHub Pages serves this folder)
  index.html
  css/app.css
  js/app.js           UI
  js/engine.js        rates, chain solver, bank analysis
  js/save.js          save-string decoder
  js/vendor/          brotli-dec-wasm (MIT/Apache-2.0), streaming Brotli decoder
  data/game.json      generated from the game install
  icons/*.webp        generated from the game install
tools/build_data.py   regenerates data/ and icons/ from your local Melvor2.exe
tools/test/           node smoke test against a real save
```

## Regenerating game data after a patch

```powershell
python -I tools/build_data.py "C:\Program Files (x86)\Steam\steamapps\common\Melvor Idle 2\Melvor2.exe"
node tools/test/engine.test.mjs path\to\save_xxx.sav
```

The script finds the Godot pack embedded in `Melvor2.exe` (format v4, unencrypted). It reads `Data/Packages/MelvorBase.json` for items, recipes and the shop, and unwraps item icons from Godot `GST2` textures. Those textures hold lossless WebP data.

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
- Levels use the game's `StandardExperienceTable(0.25, 300, 2^(1/7))`, capped at 99.

## How the numbers are computed

These are base rates from the game's own formulas. Tool, mastery, potion, pet and astrology modifiers are not applied yet.

| Skill | Model |
|---|---|
| Woodcutting | One log per tree "cut" of `BaseMaxHealth` hits at `BaseInterval`. Per-hit drops roll every hit. |
| Mining | Each hit breaks the rock with chance `p`, otherwise progress += `p`. The rock always breaks once progress ≥ 0.9999. The expected number of hits is computed exactly. |
| Fishing | Uniform interval `(min+max)/2`. Fish vs junk by `FishChance`, weighted fish table. Special items roll in ascending-chance order and the first success wins. |
| Thieving | Success = `min(1, (100+level)/(100+perception))`. Each failure adds a 2 s stun. Currency, common and rare tables give their expected values. |
| Cooking | Success = `clamp((69+level)/(69+difficulty))`. Ingredients are spent on failure. |
| Smithing, Crafting, Fletching, Runecrafting, Beastcrafting | `BaseInterval × Steps` per craft. Each product rolls independently by its chance. |
| Herblore | Preparing + heating + stirring + bottling intervals per batch. |
| Farming | Passive, per plot. |

The **From scratch** mode uses a Dinkelbach-style fixed point. Your time is valued at the best rate you can reach (λ gp/ms). Each item's cost is then `min(shop price, Σ input costs + λ·time − by-product value)`, relaxed until it stops changing. Each method's chain rate is `(output value − gold spent) / total time`.

## Deploying

GitHub Pages: **Settings → Pages → Deploy from a branch → `main` / `docs`**.

## Disclaimer

Fan-made and unofficial. Not affiliated with Games by Malcs. Game names, data and artwork belong to their owners.
