"""Build docs/data/game.json and docs/icons/*.webp from a local Melvor Idle 2 install.

Usage:  python -I tools/build_data.py ["C:/.../Melvor Idle 2/Melvor2.exe"]

Everything is read from the Godot pack embedded in Melvor2.exe:
  * Data/Packages/MelvorBase.json  -> items, recipes, shop
  * .godot/imported/*.ctex          -> icons (GST2 container wrapping a WebP)
Rates follow the game's own formulas (decompiled from GamesByMalcs.Melvor2.dll);
see README.md ("How the numbers are computed").
"""
import io
import json
import os
import re
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs")
EXE = sys.argv[1] if len(sys.argv) > 1 else r"C:\Program Files (x86)\Steam\steamapps\common\Melvor Idle 2\Melvor2.exe"
NS = "MelvorBase:"
ICON_PX = 64


# ---------------------------------------------------------------- PCK access
def find_pck(f):
    """Locate the embedded GDPC header (format v3+/v4: magic, ver, maj, min, patch, flags, file_base, dir_offset)."""
    import mmap
    m = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    pos = 0
    while True:
        pos = m.find(b"GDPC", pos)
        if pos < 0:
            raise SystemExit("No Godot pack found in exe")
        ver, maj, mnr = struct.unpack_from("<III", m, pos + 4)
        if ver in (2, 3, 4) and maj == 4 and mnr < 20:
            return pos
        pos += 4


def pck_entries(f, base):
    f.seek(base + 20)
    _flags, file_base, dir_off = struct.unpack("<IQQ", f.read(20))
    f.seek(base + dir_off)
    (n,) = struct.unpack("<I", f.read(4))
    out = {}
    for _ in range(n):
        (ln,) = struct.unpack("<I", f.read(4))
        p = f.read(ln).rstrip(b"\0").decode("utf8", "replace")
        off, size = struct.unpack("<QQ", f.read(16))
        f.read(20)  # md5 + flags
        out[p] = (base + file_base + off, size)
    return out


class Pack:
    def __init__(self, exe):
        self.f = open(exe, "rb")
        self.base = find_pck(self.f)
        self.e = pck_entries(self.f, self.base)

    def read(self, path):
        path = path.replace("res://", "")
        o, s = self.e[path]
        self.f.seek(o)
        return self.f.read(s)

    def has(self, path):
        return path.replace("res://", "") in self.e

    def icon_webp(self, res_path):
        imp = res_path.replace("res://", "") + ".import"
        if imp not in self.e:
            return None
        m = re.search(r'path="([^"]+\.ctex)"', self.read(imp).decode("utf8", "replace"))
        if not m or not self.has(m.group(1)):
            return None
        b = self.read(m.group(1))
        i = b.find(b"RIFF")
        if b[:4] != b"GST2" or i < 0:
            return None
        (riff_len,) = struct.unpack_from("<I", b, i + 4)
        return b[i : i + 8 + riff_len]


# ---------------------------------------------------------------- helpers
def short(x):
    return x[len(NS):] if isinstance(x, str) and x.startswith(NS) else x


def reqs_of(*lists):
    out = []
    for lst in lists:
        start = len(out)
        for r in lst or []:
            n0 = len(out)
            reqs_one(r, out)
            # IsOr: this requirement is an alternative to the previous one in the same list
            if (r.get("Data") or {}).get("IsOr") and len(out) > n0 and n0 > start:
                cur = out.pop()
                prev = out.pop()
                out.append({"t": "any", "of": (prev["of"] if prev.get("t") == "any" else [prev]) + [cur]})
    return out


def reqs_one(r, out):
    if True:
        if True:
            t, dd = short(r["Type"]), r["Data"]
            if t == "Level":
                out.append({"t": "lvl", "s": short(dd["Component"]["Entity"]), "l": dd["Level"]})
            elif t == "ShopPurchase":
                out.append({"t": "shop", "id": short(dd["ShopPurchase"]), "n": dd.get("Amount", 1)})
            elif t == "ToolbeltItemEquipped":
                out.append({"t": "tool", "item": short(dd["Item"])})
            elif t == "QuestComplete":
                out.append({"t": "quest", "id": short(dd["Quest"])})
            elif t in ("EnemyStatistic", "SlayerMasterStatistic"):
                key = short(dd.get("Enemy") or dd.get("Master"))
                label = (f"Kill {dd.get('Value')} " if t == "EnemyStatistic" else f"{dd.get('Value')} slayer tasks for ") + re.sub(r"([a-z])([A-Z])", r"\1 \2", key or "")
                out.append({"t": "stat", "stat": short(dd.get("Statistic")), "key": key, "n": dd.get("Value", 1), "text": label})
            elif t == "MasteryGuildRank":
                out.append({"t": "rank", "s": short(dd["Component"]["Entity"]), "id": short(dd["Rank"])})
            else:
                label = {
                    "AstrologyMajorNodeUnlocked": "Astrology node " + short(dd.get("MajorNode", "")),
                    "AgilityCourseStatistic": "Complete " + short(dd.get("Course", "")) + f" x{dd.get('Value')}",
                    "AstrologyEventStatistic": "Observe " + short(dd.get("Event", "")),
                    "ItemStatistic": f"Brew {dd.get('Value')} " + short(dd.get("Item", "")),
                    "DungeonStatistic": f"Clear {short(dd.get('Dungeon',''))} x{dd.get('Value')}",
                    "SlayerMasterStatistic": f"{dd.get('Value')} tasks for {short(dd.get('Master',''))}",
                    "EnemyStatistic": f"Kill {dd.get('Value')} " + re.sub(r"([a-z])([A-Z])", r"\1 \2", short(dd.get('Enemy', ''))),
                    "QuestStepActive": "During quest " + short(dd.get('Quest', '')),
                    "AgilityTechniqueLevel": "Agility technique level " + str(dd.get('Level', '')),
                }.get(t, t)
                out.append({"t": "other", "k": t, "text": label})


def iq(lst, qty="Quantity"):
    return [[short(x["Item"]), x[qty]] for x in lst or []]


CTX_KEYS = {"Recipe": "r", "Category": "cat", "Subcategory": "sub", "Item": "it", "Location": "loc", "Currency": "cur", "Constellation": "r"}


def bonuses_of(B):
    """Flatten a Bonuses block into [statsType, statName, value, ctx]. ctx keys: e (entity), c (component),
    r/cat/sub/it/loc/cur. Conditional bonuses and contexts we can't evaluate are marked with ctx.x."""
    out = []
    for x in (B or {}).get("Component") or []:
        st = x.get("Stat") or {}
        if not st:
            continue
        ctx = {}
        for k, v in (x.get("LocalContext") or {}).items():
            if not v:
                continue
            if k == "Component":
                ctx["e"] = short(v.get("Entity"))
                ctx["c"] = v.get("Component")
            elif k in CTX_KEYS:
                ctx[CTX_KEYS[k]] = short(v)
            else:
                ctx["x"] = 1
        if x.get("Condition") or x.get("Scaling") or x.get("FromContext"):
            ctx["x"] = 1
        out.append([short(st["StatsType"]), st["Name"], x["Value"], ctx])
    for x in (B or {}).get("Global") or []:
        if x.get("StatGroup") and not x.get("Condition"):
            out.append(["G", x["StatGroup"], x["Value"], {}])
    return out


def table(lst):
    """Weighted drop table -> [[item, weight, min, max]]"""
    return [[short(x["Item"]), x["Weight"], x.get("MinQuantity", x.get("Quantity", 1)), x.get("MaxQuantity", x.get("Quantity", 1))]
            for x in lst or []]


def iqc(lst):
    return [[short(x["Item"]), x["Quantity"], x["Chance"]] for x in lst or []]


def weighted_ev(table):
    """Expected (item -> qty) from a single roll of a weighted table with MinQuantity/MaxQuantity."""
    tot = sum(x["Weight"] for x in table) or 1
    out = {}
    for x in table:
        avg = (x.get("MinQuantity", x.get("Quantity", 1)) + x.get("MaxQuantity", x.get("Quantity", 1))) / 2
        k = short(x["Item"])
        out[k] = out.get(k, 0) + x["Weight"] / tot * avg
    return out


def addmap(dst, src, mult=1.0):
    for k, v in src.items():
        dst[k] = dst.get(k, 0) + v * mult


def tolist(m):
    return [[k, round(v, 6)] for k, v in m.items() if v > 0]


def mining_expected_hits(p):
    """Rock progress += p each hit, or an early break with chance p; guaranteed break once progress >= 0.9999."""
    if p >= 1:
        return 1.0
    n = 1
    while n * p < 0.9999:
        n += 1
    e = sum(i * (1 - p) ** (i - 1) * p for i in range(1, n))
    return e + n * (1 - p) ** (n - 1)


# ---------------------------------------------------------------- build
def main():
    pk = Pack(EXE)
    data = json.loads(pk.read("Data/Packages/MelvorBase.json").decode("utf-8-sig"))
    O, EC = data["Objects"], data["EntityConfig"]
    os.makedirs(os.path.join(OUT, "data"), exist_ok=True)
    os.makedirs(os.path.join(OUT, "icons"), exist_ok=True)

    icons = {}  # res path -> file name

    def icon(res):
        if not res or "missing_artwork" in res:
            return None
        if res in icons:
            return icons[res]
        name = re.sub(r"[^A-Za-z0-9_]+", "_", res.replace("res://Assets/", "").rsplit(".", 1)[0]).strip("_") + ".webp"
        icons[res] = name
        return name

    # skill membership from entity config
    skill_of = {}
    for ent, cfg in EC.items():
        for r in cfg.get("Recipes", []) or []:
            skill_of.setdefault(short(r["Id"]), short(ent))
    quest_cats = {"Quests"}

    items = {}
    for it in O["Item"]:
        dn = it["DisplayName"]
        items[it["Id"]] = {
            "n": dn["Singular"] if isinstance(dn, dict) else dn,
            "v": it["SellsFor"]["Quantity"],
            "i": icon(it.get("Icon")),
            "c": [short(c) for c in (it.get("Capabilities") or {})],
            "t": [short(b["BankTag"]) for b in it.get("BankTags") or [] if b.get("IsProduct")],
        }
        if it.get("IgnoreCompletion"):
            items[it["Id"]]["ic"] = 1
        caps = it.get("Capabilities") or {}
        op = caps.get(NS + "Openable")
        if op:
            items[it["Id"]]["open"] = {"fixed": [[short(x["Item"]), x.get("MinQuantity", x.get("Quantity", 1)), x.get("MaxQuantity", x.get("Quantity", 1))] for x in op.get("AlwaysDrops") or []],
                                       "table": table(op.get("DropTable"))}
        eq = caps.get(NS + "Equipment")
        if eq:
            st = eq.get("Stats") or {}
            items[it["Id"]]["eq"] = {
                "slot": short(eq.get("Type")),
                "st": {short(x["Stat"]): x["Value"] for x in st.get("Stats") or []},
                "pow": sum(x["Value"] for x in st.get("PowerRatings") or []),
                "prot": sum(x["Value"] for x in st.get("ProtectionRatings") or []),
                "ammo": short(eq.get("AmmoType")),
                "occ": [short(x) for x in eq.get("OccupiesSlots") or []],
                "r": reqs_of(eq.get("Requirements")),
            }
            # bonuses the item gives while worn: [stat, value, {style, stat, rune, ammo, effect, cond}]
            eb = []
            for b in ((eq.get("Bonuses") or {}).get("Component") or []):
                if not b.get("Stat"):
                    continue
                lc = b.get("LocalContext") or {}
                ctx = {k2: short(lc.get(k1)) for k1, k2 in (("CombatStyle", "style"), ("CombatStat", "stat"), ("Rune", "rune"), ("AmmoType", "ammo"), ("Effect", "effect")) if lc.get(k1)}
                if b.get("Condition"):
                    ctx["cond"] = short(b["Condition"]["Type"])
                eb.append([b["Stat"]["Name"], b["Value"], ctx])
            if eb:
                items[it["Id"]]["eq"]["b"] = eb
        wp = caps.get(NS + "Weapon")
        if wp:
            items[it["Id"]]["wp"] = {"type": short(wp.get("Type")), "ammo": short(wp.get("RequiredAmmoType")),
                                     "el": [short(x) for x in wp.get("Elements") or []]}
        food = caps.get(NS + "Food")
        if food and food.get("BaseHealing"):
            items[it["Id"]]["heal"] = food["BaseHealing"]
        tb = (it.get("Capabilities") or {}).get(NS + "Toolbelt")
        if tb:
            items[it["Id"]]["slot"] = short(tb.get("FitsInSlot"))
            bb = bonuses_of(tb.get("Bonuses"))
            if bb:
                items[it["Id"]]["tb"] = bb

    # shop: buyable items priced in GP (unlimited, single currency).
    # Only purchases registered in the Shop entity config actually appear in the game's
    # shop; the rest (e.g. GrainStarterPack, Cowhide) are defined but unused.
    listed = {short(p["Id"]) for p in EC["MelvorBase:Shop"]["Purchases"]}
    shop = {}
    buy = {}
    for s in O["ShopPurchase"]:
        if s["Id"] not in listed:
            continue
        cur = [[short(c["Currency"]), c["Quantity"]] for c in s["Costs"]["Currencies"]]
        shop[s["Id"]] = {"n": s["DisplayName"], "i": icon(s.get("Icon")), "cost": cur,
                         "ci": iq(s["Costs"]["Items"]), "r": reqs_of(s.get("Requirements")),
                         "sub": short(s.get("Subcategory")), "lim": s.get("DefaultBuyLimit", 0),
                         "pi": iq((s.get("Provides") or {}).get("Items"))}
        bb = bonuses_of((s.get("Provides") or {}).get("Bonuses"))
        if bb:
            shop[s["Id"]]["b"] = bb
        prov = s["Provides"]["Items"]
        if (len(prov) == 1 and not s["Costs"]["Items"] and len(cur) == 1 and cur[0][0] == "GoldPieces"
                and s.get("DefaultBuyLimit", 0) == 0):
            iid, q = short(prov[0]["Item"]), prov[0]["Quantity"]
            price = cur[0][1] / q
            if iid not in buy or buy[iid]["p"] > price:
                buy[iid] = {"p": price, "shop": s["Id"]}

    shop_order = {short(p["Id"]): p["Priority"] for p in EC[NS + "Shop"]["Purchases"]}
    for k, v in shop.items():
        v["o"] = shop_order.get(k, 0)
    sub_order = {short(p["Id"]): p["Priority"] for p in EC[NS + "Shop"].get("Subcategories") or []}
    cat_order = {short(p["Id"]): p["Priority"] for p in EC[NS + "Shop"].get("Categories") or []}
    shop_cats = {c["Id"]: {"n": c["DisplayName"], "i": icon(c.get("Icon")), "o": cat_order.get(c["Id"], 0)} for c in O["ShopCategory"]}
    shop_subs = {c["Id"]: {"n": c["DisplayName"], "cat": short(c.get("Category")), "o": sub_order.get(c["Id"], 0)} for c in O["ShopSubcategory"]}

    cat_reqs = {c["Id"]: c.get("Requirements") for c in O["RecipeCategory"]}
    cat_names = {c["Id"]: c["DisplayName"] for c in O["RecipeCategory"]}
    fish_loc = {c["Id"]: c for c in O["FishingLocation"]}
    thv_loc = {c["Id"]: c for c in O["ThievingLocation"]}
    methods = []

    def base_level(rq, skill):
        return max([r["l"] for r in rq if r["t"] == "lvl" and r["s"] == skill] or [1])

    def push(skill, r, kind, ms, xp, ins, outs, gp=0.0, reqs=None, extra=None, icon_res=None, name=None):
        cat = short(r.get("Category"))
        is_quest = cat in quest_cats  # quest-only actions: kept for quest estimates, hidden from rankings
        rq = reqs if reqs is not None else reqs_of(r.get("Requirements"), cat_reqs.get(cat))
        m = {
            "id": f"{skill}:{r['Id']}", "s": skill, "n": name or (r["DisplayName"] if isinstance(r["DisplayName"], str) else r["DisplayName"]["Singular"]),
            "i": icon(icon_res or r.get("Icon") or r.get("Media")), "k": kind, "ms": round(ms, 3), "xp": xp,
            "in": [[a, b] for a, b in ins], "out": tolist(outs) if isinstance(outs, dict) else outs, "gp": round(gp, 4),
            "lv": base_level(rq, skill), "r": rq, "cat": cat, "rid": r["Id"],
        }
        if r.get("Subcategory"):
            m["sub"] = short(r["Subcategory"])
        if extra:
            m.update(extra)
        if is_quest:
            m["quest"] = True
        methods.append(m)

    # Woodcutting: one log per tree "cut" = MaxHealth hits; per-hit drops roll every hit.
    for r in O["WoodcuttingRecipe"]:
        hp = r["BaseMaxHealth"]
        outs = {short(r["Product"]["Item"]): r["Product"]["Quantity"]}
        for x in r["RandomProductsPerHit"]:
            addmap(outs, {short(x["Item"]): x["Quantity"] * x["Chance"] * hp})
        for x in r["RandomProductsPerCut"]:
            addmap(outs, {short(x["Item"]): x["Quantity"] * x["Chance"]})
        push("Woodcutting", r, "active", r["BaseInterval"] * hp, r["BaseExperience"], [], outs,
             extra={"note": f"{hp} hits per log",
                    "x": {"t": "wc", "iv": r["BaseInterval"], "hp": hp, "p": short(r["Product"]["Item"]), "q": r["Product"]["Quantity"],
                          "hit": iqc(r["RandomProductsPerHit"]), "cut": iqc(r["RandomProductsPerCut"])}})

    # Mining: expected hits to break a rock given BaseProductChance.
    for r in O["MiningRecipe"]:
        hits = mining_expected_hits(r["BaseProductChance"])
        outs = {short(r["Product"]["Item"]): r["Product"]["Quantity"]}
        for x in r["RandomProductsPerHit"] or []:
            addmap(outs, {short(x["Item"]): x["Quantity"] * x["Chance"] * hits})
        push("Mining", r, "active", r["BaseInterval"] * hits, r["BaseExperience"], [], outs,
             extra={"note": f"~{hits:.1f} swings per ore",
                    "x": {"t": "mine", "iv": r["BaseInterval"], "pc": r["BaseProductChance"], "p": short(r["Product"]["Item"]),
                          "q": r["Product"]["Quantity"], "hit": iqc(r["RandomProductsPerHit"]), "bar": short(r.get("BarItem")),
                          "stone": short(r.get("StoneItem")), "ess": short(r.get("EssenceItem"))}})

    # Fishing: uniform interval; fish vs junk; special items rolled in ascending-chance order, first success wins.
    for r in O["FishingRecipe"]:
        loc = fish_loc.get(short(r["Location"]), {})
        fc = r["FishChance"]
        outs = {}
        addmap(outs, weighted_ev(r["RandomProducts"]), fc)
        if r.get("JunkItem") and fc < 1:
            addmap(outs, {short(r["JunkItem"]): 1}, 1 - fc)
        miss = 1.0
        for x in sorted(r["SpecialProducts"], key=lambda x: x["Chance"]):
            addmap(outs, {short(x["Item"]): x["Quantity"] * x["Chance"] * miss})
            miss *= 1 - x["Chance"]
        push("Fishing", r, "active", (r["BaseMinInterval"] + r["BaseMaxInterval"]) / 2, r["BaseExperience"], [], outs,
             reqs=reqs_of(r.get("Requirements"), loc.get("Requirements")),
             extra={"loc": loc.get("DisplayName"), "locId": short(r["Location"]),
                    "x": {"t": "fish", "min": r["BaseMinInterval"], "max": r["BaseMaxInterval"], "fc": fc,
                          "fish": table(r["RandomProducts"]), "junk": short(r.get("JunkItem")), "sp": iqc(r["SpecialProducts"])}})

    # Thieving: success depends on level -> stored raw, resolved client-side.
    for r in O["ThievingRecipe"]:
        loc = thv_loc.get(short(r["Category"]), {})
        loot = {}
        addmap(loot, weighted_ev(r["CommonDropTable"]), r["BaseCommonLootChance"])
        addmap(loot, weighted_ev(r["RareDropTable"]), r["BaseRareLootChance"])
        comp = {}
        if r["CompletionDropTable"]:
            addmap(comp, weighted_ev(r["CompletionDropTable"]), 1 / max(1, r["Stages"]))
        addmap(loot, comp)
        cr = r.get("CurrencyReward") or {}
        gp = 0.0
        if cr and short(cr["Currency"]) == "GoldPieces":
            gp = r["BaseCurrencyLootChance"] * (cr["MinQuantity"] + cr["MaxQuantity"]) / 2
        push("Thieving", r, "active", r["BaseInterval"], r["BaseExperience"] / max(1, r["Stages"]), [], loot, gp=gp,
             reqs=reqs_of(r.get("Requirements"), r.get("AccessRequirements"), loc.get("Requirements")),
             extra={"succ": {"t": "thieving", "p": r["Perception"]}, "dmg": r["Damage"], "loc": loc.get("DisplayName"),
                    **({"pick": short(acc[0]["Data"]["Item"]), "key": short(acc[1]["Data"]["Item"])} if (acc := [a for a in (r.get("AccessRequirements") or []) if short(a["Type"]) == "ToolbeltItemEquipped"]) and len(acc) >= 2 else {}),
                    "stages": r["Stages"], "rt": short(r["RecipeType"]),
                    "x": {"t": "thv", "iv": r["BaseInterval"], "perc": r["Perception"], "st": max(1, r["Stages"]),
                          "cc": r["BaseCommonLootChance"], "rc": r["BaseRareLootChance"], "gc": r["BaseCurrencyLootChance"],
                          "g": [short(cr.get("Currency")), cr.get("MinQuantity", 0), cr.get("MaxQuantity", 0)] if cr else None,
                          "common": table(r["CommonDropTable"]), "rare": table(r["RareDropTable"]), "comp": table(r["CompletionDropTable"])}})

    # Cooking: success = clamp((69+level)/(69+difficulty)); ingredients spent on failure.
    for r in O["CookingRecipe"]:
        outs = {short(p["Item"]): p["Quantity"] * p["Chance"] for p in r["Products"]}
        push("Cooking", r, "active", r["BaseInterval"], r["BaseExperience"], iq(r["Ingredients"]["Items"]), outs,
             extra={"succ": {"t": "cooking", "d": r["Difficulty"]},
                    "x": {"t": "cook", "iv": r["BaseInterval"], "diff": r["Difficulty"], "pr": iqc(r["Products"])}})

    # Artisan skills: Steps intervals per craft; each product rolled independently by chance.
    for r in O["ArtisanRecipe"]:
        skill = skill_of.get(r["Id"])
        if not skill:
            continue
        outs = {}
        for p in r["Products"]:
            addmap(outs, {short(p["Item"]): p["Quantity"] * p["Chance"]})
        steps = max(1, r.get("Steps") or 1)
        push(skill, r, "active", r["BaseInterval"] * steps, r["BaseExperience"], iq(r["Ingredients"]["Items"]), outs,
             extra={"note": f"{steps} steps" if steps > 1 else None,
                    "x": {"t": "art", "iv": r["BaseInterval"], "steps": steps, "pr": iqc(r["Products"])}})

    # Herblore: a batch is prepare + heat + stir once, then 10 bottlings. Each bottling spends the
    # ingredients and yields the products + XP (ActiveHerbloreRecipe.MaxBottledCount = 10).
    BOTTLES = 10
    for r in O["HerbloreRecipe"]:
        ms = (r["BasePreparingInterval"] + r["BaseHeatingInterval"] + r["BaseStirringInterval"]) / BOTTLES + r["BaseBottlingInterval"]
        outs = {}
        for p in r["Products"]:
            addmap(outs, {short(p["Item"]): p["Quantity"] * p["Chance"]})
        push("Herblore", r, "active", ms, r["BaseExperience"], iq(r["Ingredients"]["Items"]), outs,
             extra={"note": f"{BOTTLES} bottles per brew",
                    "x": {"t": "herb", "p": r["BasePreparingInterval"], "h": r["BaseHeatingInterval"], "s": r["BaseStirringInterval"],
                          "b": r["BaseBottlingInterval"], "n": BOTTLES, "pr": iqc(r["Products"])}})

    # Firemaking: burn a log, by-products by chance.
    for r in O["FiremakingRecipe"]:
        outs = {}
        for p in r["Products"]:
            addmap(outs, {short(p["Item"]): p["Quantity"] * p["Chance"]})
        cr = r.get("CurrencyReward") or {}
        push("Firemaking", r, "active", r["BaseInterval"], r["BaseExperience"], iq(r["Ingredients"]["Items"]), outs,
             gp=cr.get("Quantity", 0) if short(cr.get("Currency")) == "GoldPieces" else 0,
             extra={"x": {"t": "fm", "iv": r["BaseInterval"], "pr": iqc(r["Products"]),
                          "cur": [short(cr["Currency"]), cr["Quantity"]] if cr else None}})

    # Farming: passive, per plot. x holds what the yield formula needs (FarmingActionStats):
    # qty = max(1, floor((Q + flat) * (1 + pct) * (1 - (max(0, pest - pestProt) + max(0, disease - diseaseProt)) / 100)))
    fcats = {c["Id"]: c for c in O["FarmingCategory"]}
    for r in O["FarmingRecipe"]:
        outs = {short(r["Product"]["Item"]): r["Product"]["Quantity"]}
        fc = fcats.get(short(r["Category"])) or {}
        water = sum(t["Value"] for t in fc.get("WateringModifierTemplate") or [] if t["Stat"]["Name"] == "FlatDiseaseProtection")
        push("Farming", r, "passive", r["BaseInterval"], r["BaseExperience"], iq(r["Ingredients"]["Items"]), outs,
             extra={"note": "per plot, passive", "x": {
                 "t": "farm", "q": r["Product"]["Quantity"], "p": short(r["Product"]["Item"]), "iv": r["BaseInterval"],
                 "rg": r.get("Regrows") or 0, "rgiv": r.get("RegrowInterval") or 0,
                 "dis": (r.get("DiseaseValueAdjuster", 0) + fc.get("DiseaseValueAdjuster", 0)) if fc.get("AttractsDisease") else 0,
                 "pest": (r.get("PestValueAdjuster", 0) + fc.get("PestValueAdjuster", 0)) if fc.get("AttractsPests") else 0,
                 "water": water if fc.get("CanWater") else 0, "comp": bool(fc.get("CanCompost")),
                 "fb": bonuses_of(r.get("BonusesWhenGrown")) if r.get("BonusesWhenGrown") else None, "giv": r.get("GrownInterval") or 0,
                 "auto": iq((r.get("AutomationCosts") or {}).get("Items"))}})
    farm = {"cats": {short(c["Id"]): {"n": c["DisplayName"], "i": icon(c.get("Icon")), "water": bool(c.get("CanWater")), "comp": bool(c.get("CanCompost"))} for c in O["FarmingCategory"]},
            "plots": {}, "compost": {}}
    for pl in O["FarmingPlot"]:
        gp = sum(c["Quantity"] for c in (pl.get("Costs") or {}).get("Currencies") or [] if short(c["Currency"]) == "GoldPieces")
        farm["plots"][pl["Id"]] = {"n": pl["DisplayName"], "c": short(pl["Category"]), "gp": gp, "ci": iq((pl.get("Costs") or {}).get("Items")), "r": reqs_of(pl.get("Requirements"))}
    for it in O["Item"]:
        cap = (it.get("Capabilities") or {}).get(NS + "Compost")
        if cap:
            farm["compost"][it["Id"]] = {"b": bonuses_of({"Component": cap.get("CompostModifierTemplate") or []})}

    # Agility: each course path is a method. A lap is a run of obstacles; a failed obstacle sends you back to the start.
    # Success per obstacle = 0.95^((difficulty - technique level + 1) / 2), certain once the technique level reaches it;
    # traps 0.8 (+ bonuses, max 0.95). Entry costs are paid on every start, including restarts after a fall.
    ag_paths = {p["Id"]: p for p in O.get("AgilityCoursePath") or []}
    ag_obs = {x["Id"]: x for x in O.get("AgilityObstacle") or []}
    ag_loc = {x["Id"]: x for x in O.get("AgilityLocation") or []}
    for c in O.get("AgilityCourse") or []:
        loc = ag_loc.get(short(c.get("Location")), {})
        for pid in c.get("Paths") or []:
            p = ag_paths.get(short(pid))
            if not p:
                continue
            obs = []
            for oid in p.get("Obstacles") or []:
                x = ag_obs.get(short(oid))
                if x:
                    obs.append([x["BaseInterval"], short(x.get("Technique")), x.get("Difficulty", 0), x.get("Damage", 0), bool(x.get("IsTrap"))])
            if not obs:
                continue
            ec = c.get("EntryCost") or {}
            cr = c.get("CompletionRewards") or {}
            timed = [[t["TimeInMS"], t.get("Chance", 1), iq(t.get("Items"))] for t in sorted(c.get("TimedCompletionRewards") or [], key=lambda t: t["TimeInMS"])]
            name = c["DisplayName"] + ("" if len(c.get("Paths") or []) == 1 else " · " + (p.get("DisplayName") or ""))
            push("Agility", {**c, "Id": c["Id"] + "_" + p["Id"], "Category": c.get("Location"), "Icon": loc.get("Icon")}, "active",
                 sum(o[0] for o in obs), p.get("BaseExperience", 0), [], {}, name=name,
                 reqs=reqs_of(c.get("Requirements"), loc.get("Requirements")),
                 extra={"loc": loc.get("DisplayName"), **({"quest": True} if any(short(d.get("Type")) == "QuestStepActive" for d in loc.get("DisplayRequirements") or []) else {}), "x": {
                     "t": "agil", "obs": obs, "txp": p.get("BaseTechniqueExperience", 0), "gtx": bool(c.get("GivesTechniqueXP")),
                     "rand": iqc(p.get("RandomObstacleProducts")), "rew": iq(cr.get("Items")),
                     "gp": sum(x["Quantity"] for x in cr.get("Currencies") or [] if short(x["Currency"]) == "GoldPieces"),
                     "entry": iq(ec.get("Items")), "timed": timed}})
    agility = {"tech": {t["Id"]: {"n": t["DisplayName"], "i": icon(t.get("Icon")), "cap": t.get("LevelCap", 40),
                                  "r": reqs_of(t.get("UnlockRequirements")), "b": bonuses_of({"Component": t.get("DifficultyMetBonuses") or []})}
                        for t in O.get("AgilityTechnique") or []}}

    # Hunting: survey (3rd always succeeds) -> track N steps -> trap attempts; each attempt uses a trap.
    hunt_loc = {c["Id"]: c for c in O["HuntingLocation"]}
    traps_by_type = {}
    for it in O["Item"]:
        cap = (it.get("Capabilities") or {}).get(NS + "HuntingTrap")
        if cap:
            traps_by_type.setdefault(short(cap["TrapType"]), []).append((it["SellsFor"]["Quantity"], it["Id"]))
    for a in O["HuntingAnimal"]:
        loc = hunt_loc.get(short(a["Location"]), {})
        if not loc or "Quest" in loc.get("Id", ""):
            continue
        trap = sorted(traps_by_type.get(short(a.get("TrapType")), [(0, None)]))[0][1]
        outs = {}
        for p_ in a["Products"]:
            addmap(outs, {short(p_["Item"]): p_["Quantity"] * p_["Chance"]})
        r = {"Id": a["Id"], "DisplayName": a["DisplayName"], "Icon": a.get("Icon"), "Category": a["Location"],
             "Requirements": (a.get("Requirements") or []) + (loc.get("Requirements") or [])}
        push("Hunting", r, "active", (a["BaseMinTrapInterval"] + a["BaseMaxTrapInterval"]) / 2 / a["BaseTrapSuccessChance"],
             a["BaseExperience"], [[trap, 1 / a["BaseTrapSuccessChance"]]] if trap else [], outs,
             extra={"loc": loc.get("DisplayName"), "locId": short(a["Location"]), "note": "per animal caught",
                    "x": {"t": "hunt", "sv": loc.get("BaseSurveyInterval", 4000), "svXp": loc.get("BaseSurveyingExperience", 0),
                          "tc": a["BaseTrackSuccessChance"], "pc": a["BaseTrapSuccessChance"],
                          "smin": a["BaseMinTrackingSteps"], "smax": a["BaseMaxTrackingSteps"],
                          "tmin": a["BaseMinTrackInterval"], "tmax": a["BaseMaxTrackInterval"],
                          "pmin": a["BaseMinTrapInterval"], "pmax": a["BaseMaxTrapInterval"],
                          "pr": iqc(a["Products"]), "sp": iqc(a.get("SurveyingProducts")), "trap": short(trap)}})

    # Ranching: passive, per adult animal per product interval (before happiness, variants and feed bonuses).
    encl_lvl = {}
    for en in O["RanchingEnclosure"]:
        lv = min([q["Data"]["Level"] for q in en.get("Requirements") or [] if short(q["Type"]) == "Level"] or [1])
        for an in en.get("Animals") or []:
            encl_lvl[short(an)] = min(encl_lvl.get(short(an), 99), lv)
    for a in O["RanchingAnimal"]:
        hrs = a["ProductInterval"] / 3_600_000
        dn = a["DisplayName"]
        r = {"Id": a["Id"], "DisplayName": (dn["Singular"] if isinstance(dn, dict) else dn), "Icon": a.get("Icon"),
             "Category": a.get("Category"), "Requirements": [{"Type": NS + "Level", "Data": {"Component": {"Entity": NS + "Ranching"}, "Level": encl_lvl.get(a["Id"], 1)}}]}
        push("Ranching", r, "passive", a["ProductInterval"], a["BaseExperience"], iq((a.get("Eats") or [])), {short(p_["Item"]): p_["Quantity"] for p_ in a["Products"]},
             extra={"note": "per adult animal, passive", "buy": next((c["Quantity"] for c in (a.get("PurchaseCosts") or {}).get("Currencies") or [] if short(c["Currency"]) == "GoldPieces"), 0),
                    "life": a.get("LifespanInterval")})

    for m in methods:
        if m.get("note") is None:
            m.pop("note", None)

    skills = {}
    for ent in EC:
        s = short(ent)
        for res in (f"res://Assets/Icons/{s}.png", f"res://Assets/Icons/{s}_64.png", f"res://Assets/{s}_64.png"):
            if pk.has(res.replace("res://", "") + ".import"):
                skills[s] = {"i": icon(res)}
                break
    for extra_icon in ["GoldPieces", "SlayerCoins", "Bank", "Shop", "Combat"]:
        res = f"res://Assets/Icons/{extra_icon}.png"
        if pk.has(res.replace("res://", "") + ".import"):
            skills.setdefault("_" + extra_icon, {"i": icon(res)})
    cur_icons = {short(c["Id"]): icon(c.get("Icon")) for c in O["Currency"]}

    pets = {}
    for pt in O["Pet"]:
        tr = pt.get("Trigger") or {}
        td = tr.get("Data") or {}
        pets[pt["Id"]] = {"n": pt["DisplayName"], "i": icon(pt.get("Icon")), "b": bonuses_of(pt.get("Bonuses")),
                          "skill": short((td.get("Component") or {}).get("Entity")), "scale": td.get("ScaleFactor") if short(tr.get("Type")) == "ChancePerExperience" else None,
                          "how": re.sub(r"([a-z])([A-Z])", r"\1 \2", short(tr.get("Type")) or short((pt.get("Goal") or {}).get("Type")) or "")}

    # ---- astrology: constellations (studied like recipes), their minor/major nodes and bonuses
    astro = {"cons": [], "nodes": {}}
    for c in O.get("AstrologyConstellation") or []:
        cid = c["Id"]
        sec = [{"t": "lvl", "s": short(r["Data"]["Component"]["Entity"]), "l": r["Data"]["Level"]} for r in c.get("SecondaryRequirements") or [] if short(r["Type"]) == "Level"]
        r = reqs_of(c.get("Requirements")) + ([{"t": "any", "of": sec}] if sec else [])
        lv = max([q["l"] for q in r if q.get("t") == "lvl" and q["s"] == "Astrology"] or [1])
        astro["cons"].append({"id": cid, "n": c["DisplayName"], "i": icon(c.get("Icon")), "minor": [short(x) for x in c["MinorNodes"]], "major": [short(x) for x in c["MajorNodes"]],
                              "thr": c["MinorNodeUnlockKnowledge"], "per": c.get("MinorNodesPerMajorNode") or 4, "pmb": bonuses_of(c.get("PerMinorNodeBonuses"))})
        for kind in ("MinorNodes", "MajorNodes"):
            for nid in c[kind]:
                astro["nodes"][short(nid)] = {"c": cid}
        methods.append({"id": "Astrology:" + cid, "s": "Astrology", "n": c["DisplayName"], "i": icon(c.get("Icon")), "k": "active", "ms": c["BaseInterval"], "xp": c["BaseExperience"],
                        "in": [], "out": [], "gp": 0, "lv": lv, "r": r, "cat": "Constellations", "rid": cid, "x": {"t": "astro", "iv": c["BaseInterval"], "k": c.get("BaseKnowledge", 1)}})
    for nd in O.get("AstrologyNode") or []:
        if nd["Id"] not in astro["nodes"]:
            continue
        astro["nodes"][nd["Id"]].update({"n": nd["DisplayName"], "t": nd["NodeType"], "b": bonuses_of(nd.get("Bonuses")), "d": nd.get("Description"), "r": reqs_of(nd.get("UnlockRequirements"))})

    # ---- combat: styles, stances, weapon types, enemies, areas
    def lvl_ratios(lst):
        return [[short(x["Level"]), x["Ratio"]] for x in lst or []]

    combat = {"styles": {}, "stances": {}, "weapons": {}, "enemies": {}, "areas": {}}
    for cs in O["CombatStyle"]:
        mf = cs.get("MaxHitFormula") or {}
        md = mf.get("Data") or {}
        combat["styles"][cs["Id"]] = {
            "acc": lvl_ratios(cs.get("AccuracyRatingLevels")), "eva": lvl_ratios(cs.get("EvasionLevels")),
            "max": {"t": short(mf.get("Type")), "str": short(md.get("StrengthBonusStat")), "stat": short(md.get("MaxHitStat")),
                    "dmg": short(md.get("DamageBonusStat")), "lv": lvl_ratios(md.get("Levels"))},
            "hp": short(cs.get("MaxHitpointsLevel")), "i": icon(cs.get("Icon")), "n": cs["DisplayName"]}
    for stn in O["AttackStance"]:
        combat["stances"][stn["Id"]] = {"n": stn["DisplayName"], "style": short(stn["CombatStyle"]), "acc": short(stn["AccuracyStat"]),
                                         "eva": short(stn["EvasionStat"]),
                                         "xp": [[short(x["Component"]["Entity"]), x["ExperiencePerDamage"]] for x in stn.get("ExperienceGain") or []]}
    for wt in O["WeaponType"]:
        combat["weapons"][wt["Id"]] = [short(x) for x in wt.get("Stances") or []]

    def drops_of(dr):
        dr = dr or {}
        return {"fixed": [[short(x["Item"]), x.get("MinQuantity", 1), x.get("MaxQuantity", 1)] for x in dr.get("FixedItems") or []],
                "tables": [{"ch": t.get("Chance", 1), "rows": table(t.get("Table"))} for t in dr.get("ItemTables") or []],
                "gp": next(([x.get("MinQuantity", 0), x.get("MaxQuantity", 0)] for x in dr.get("FixedCurrencies") or [] if short(x["Currency"]) == "GoldPieces"), None),
                "cur": [[short(x["Currency"]), x.get("MinQuantity", 0), x.get("MaxQuantity", 0)] for x in dr.get("FixedCurrencies") or [] if short(x["Currency"]) != "GoldPieces"]}

    # special attacks: chance per attack turn, hits (count, formula, percent), whether they can miss,
    # and damage-over-time / stun riders (DoT total as a fraction of the attacker's max hit)
    dots = {d["Id"]: d for d in O.get("DamageOverTimeEffect") or []}
    attacks = {}
    for a in O.get("Attack") or []:
        hits = []
        for h in a.get("Hits") or []:
            for dm in h.get("Damage") or []:
                f = dm.get("Formula") or {}
                kind = {"NormalDamage": "n", "MaxHit": "m", "CurrentHitpoints": "hp"}.get(short(f.get("Type")), "n")
                hits.append([h.get("Count", 1), kind, (f.get("Data") or {}).get("Percent", 1)])
        dot = stun = 0.0
        for e in (a.get("OnHitEffects") or []) + (a.get("PreHitEffects") or []):
            t = short((e.get("Effect") or {}).get("Type"))
            data = (e.get("Effect") or {}).get("Data") or {}
            if t == "DamageOverTime":
                dd = dots.get(short(data.get("Effect")))
                if dd and short(((dd.get("DamagePerProc") or {}).get("Formula") or {}).get("Type")) == "MaxHit":
                    dot += e.get("Chance", 1) * dd.get("ProcCount", 1) * (dd["DamagePerProc"]["Formula"].get("Data") or {}).get("Percent", 0)
            elif t == "Stun":
                stun = max(stun, e.get("Chance", 1))
        attacks[a["Id"]] = {"n": a["DisplayName"], "hits": hits, "av": bool(a.get("IsAvoidable", True)), "dot": round(dot, 4), "stun": stun}
    passives = {p["Id"]: p["DisplayName"] for p in O.get("CombatPassive") or []}
    for en in O["Enemy"]:
        st = en.get("Stats") or {}
        combat["enemies"][en["Id"]] = {
            "n": en["DisplayName"], "i": icon(en.get("Sprite")),
            "lv": {short(x["Key"]): x["Value"] for x in en.get("Levels") or []},
            "st": {short(x["Stat"]): x["Value"] for x in st.get("Stats") or []},
            "pow": sum(x["Value"] for x in st.get("PowerRatings") or []),
            "prot": sum(x["Value"] for x in st.get("ProtectionRatings") or []),
            "stances": [[short(x["Stance"]), x.get("Weight", 1)] for x in en.get("Stances") or []],
            "drops": drops_of(en.get("Drops")), "special": bool(en.get("Attacks") or en.get("Passives")), "el": short(en.get("Element")),
            "atk": [[x.get("Chance", 0), attacks[short(x["Attack"])]] for x in en.get("Attacks") or [] if short(x.get("Attack")) in attacks],
            "pas": [passives.get(short(p), short(p)) for p in en.get("Passives") or []],
            "r": reqs_of(en.get("Requirements")),
        }
    combat["spells"] = {}
    for sp in O.get("MagicSpell", []):
        st = (sp.get("Stats") or {}).get("Stats") or []
        lv = min([q["Data"]["Level"] for q in sp.get("UnlockRequirements") or [] if short(q["Type"]) == "Level"] or [1])
        combat["spells"][sp["Id"]] = {"n": sp["DisplayName"], "i": icon(sp.get("Icon")), "el": short(sp.get("Element")), "book": short(sp.get("Book")),
                                      "st": {short(x["Stat"]): x["Value"] for x in st}, "runes": iq(sp.get("RuneCosts")), "lv": lv,
                                      "r": reqs_of(sp.get("UnlockRequirements"))}
    combat["triangle"] = {}
    for t in O.get("CombatTriangleBonus", []):
        combat["triangle"][short(t["PlayerStyle"]) + "|" + short(t["EnemyStyle"])] = {b["Stat"]["Name"]: b["Value"] for b in t["Bonuses"]["Component"]}
    combat["elements"] = {}
    for t in O.get("ElementalBonus", []):
        combat["elements"][short(t["PlayerElement"]) + "|" + short(t["EnemyElement"])] = sum(b["Value"] for b in t["Bonuses"]["Component"] if b["Stat"]["Name"] == "PercentMaxHit")
    combat["dungeons"] = {}
    for dg in O.get("Dungeon", []):
        combat["dungeons"][dg["Id"]] = {
            "n": dg["DisplayName"], "i": icon(dg.get("CoverBackground")) if False else None, "diff": short(dg.get("Difficulty")),
            "waves": [[[[short(x["Enemy"]), x.get("Weight", 1)] for x in w.get("Enemies") or []], w.get("Count", 1)] for w in dg.get("Enemies") or []],
            "rewards": drops_of(dg.get("Rewards")), "r": reqs_of(dg.get("UnlockRequirements")), "dark": dg.get("Darkness", 0),
        }
    combat["slayer"] = {}
    for sm in O.get("SlayerMaster", []):
        combat["slayer"][sm["Id"]] = {"n": sm["DisplayName"], "i": icon(sm.get("Icon")), "areas": [short(a) for a in sm.get("Areas") or []],
                                      "len": sm.get("BaseTaskLength", 15), "reroll": (sm.get("RerollCost") or {}).get("Quantity", 0),
                                      "r": reqs_of(sm.get("UnlockRequirements"))}
    area_cats = {c["Id"]: c.get("DisplayName") for c in O.get("CombatAreaCategory", [])}
    for ar in O["CombatArea"]:
        combat["areas"][ar["Id"]] = {"n": ar["DisplayName"], "cat": area_cats.get(short(ar.get("Category")), short(ar.get("Category"))),
                                     "diff": short(ar.get("Difficulty")), "dark": ar.get("Darkness", 0),
                                     "enemies": [short(x) for x in ar.get("Enemies") or []], "r": reqs_of(ar.get("UnlockRequirements"))}

    # ---- icons
    from PIL import Image
    written = 0
    missing = 0
    for res, name in icons.items():
        dst = os.path.join(OUT, "icons", name)
        if os.path.exists(dst):
            written += 1
            continue
        w = pk.icon_webp(res)
        if not w:
            missing += 1
            continue
        im = Image.open(io.BytesIO(w)).convert("RGBA")
        if max(im.size) > ICON_PX:
            im.thumbnail((ICON_PX, ICON_PX), Image.LANCZOS)
        im.save(dst, "WEBP", lossless=True, method=6)
        written += 1
    have = set(os.listdir(os.path.join(OUT, "icons")))
    for coll in (items.values(), methods, shop.values(), skills.values(), shop_cats.values(), pets.values(), combat["enemies"].values(), combat["styles"].values(), combat["slayer"].values()):
        for x in coll:
            if x.get("i") and x["i"] not in have:
                x["i"] = None
    cur_icons = {k: (v if v in have else None) for k, v in cur_icons.items()}

    # ---- mastery guilds: rank thresholds, task points + how to check each task, rank bonuses
    task_by_id = {t["Id"]: t for t in O["MasteryGuildTask"]}
    rec_name = {(m["s"], m["rid"]): m["n"] for m in methods}
    sub_names = {c["Id"]: c["DisplayName"] for c in O.get("RecipeSubcategory", [])}
    goal_cat_names = {c["Id"]: c["DisplayName"] for c in O.get("RecipeGoalCategory", [])}
    loc_names = {**{k: v.get("DisplayName") for k, v in fish_loc.items()}, **{k: v.get("DisplayName") for k, v in thv_loc.items()}}

    def human(x):
        return re.sub(r"([a-z])([A-Z0-9])", r"\1 \2", short(x) or "")

    def task_goal(t, sk):
        g = t["Goal"]
        ty, dd = short(g["Type"]), g["Data"] or {}
        n = dd.get("MaxProgress", 1)
        q = {"t": ty, "n": n}
        for k, key in (("Recipe", "r"), ("Category", "cat"), ("Subcategory", "sub"), ("Item", "it"), ("Location", "loc"),
                       ("TargetType", "tt"), ("GoalCategory", "gc"), ("Animal", "r"), ("Enemy", "en"), ("Area", "area")):
            if dd.get(k):
                q[key] = short(dd[k])
        ent = short((dd.get("Component") or {}).get("Entity")) or sk
        q["e"] = ent
        parts = [cat_names.get(q["cat"]) if q.get("cat") else None, sub_names.get(q["sub"]) if q.get("sub") else None]
        what = (rec_name.get((ent, q.get("r"))) if q.get("r") else None) or ": ".join(x for x in parts if x)             or (goal_cat_names.get(q.get("gc")) if q.get("gc") else None)
        what = what or (human(q.get("r")) if q.get("r") else None)
        item = items.get(q.get("it"), {}).get("n") if q.get("it") else None
        num = f"{n:,}"
        text = {
            "WoodcuttingCutTree": f"Cut {num} {what or 'logs'}",
            "MiningMineRock": f"Mine {num} {what or 'ore'}",
            "FishingFishRecipe": f"Catch {num} fish at {what or 'any spot'}",
            "CookRecipe": f"Cook {num} {what or 'dishes'}",
            "FiremakingBurnRecipe": f"Burn {num} {what or 'logs'}",
            "ArtisanCreateRecipe": f"Make {num} {what or 'items'}",
            "ArtisanCreateRecipeGoalCategory": f"Make {num} {what or 'items'}",
            "ArtisanCompleteStep": f"Complete {num} steps of {what or 'any recipe'}",
            "ActionGainItem": f"Get {num} {item or 'items'}",
            "ActionGainItemValue": f"Gain {num} gold worth of items",
            "ThievingPickpocketTargetType": f"Pickpocket {num} {human(q.get('tt')) or 'targets'}{' in ' + (loc_names.get(q.get('loc')) or human(q.get('loc'))) if q.get('loc') else ''}",
            "HerbloreBrewPotionGroup": f"Brew {human(dd.get('PotionGroup'))} ({human(dd.get('Potency'))}) to {num}",
            "HerbloreBrewPotionCategory": f"Brew {human(q.get('cat'))} ({human(dd.get('Potency'))}) to {num}",
            "FarmingHarvestRecipe": f"Harvest {what or human(q.get('r')) or 'crops'} x{num}",
            "ArtisanSkipStep": f"Skip {num} steps",
            "ArtisanPreserveItem": f"Preserve {num} {item or 'ingredients'}",
            "PreserveCookingItem": f"Preserve {num} ingredients",
            "PreserveHerbloreItem": f"Preserve {num} {item or 'herbs'}",
            "WoodcuttingDamageTree": f"Deal {num} damage to trees",
            "WoodcuttingInstantCut": f"Instantly fell {num} trees",
            "MiningEarlyBreak": f"Break {num} rocks early",
            "HuntingTrapAnimal": f"Trap {num} {what or 'animals'}",
            "CombatKillEnemy": f"Kill {num} {combat['enemies'].get(q.get('en'), {}).get('n') or 'enemies'}",
            "CompleteDungeon": f"Complete a dungeon x{num}",
            "ThievingPickpocketTarget": f"Pickpocket {num} {rec_name.get(('Thieving', q.get('r'))) or 'targets'}",
            "FarmingPlantRecipe": f"Plant {num} {what or 'crops'}",
            "HuntingTrapAnimalLocation": f"Trap {num} animals in {human(q.get('loc'))}",
        }.get(ty) or f"{human(ty)} x{num}"
        return q, text

    def human_cond(cg):
        ty, dd = short(cg.get("Type")), cg.get("Data") or {}
        if ty == "Level":
            return f"Reach {short(dd['Component']['Entity'])} level {dd['Level']}"
        if ty == "ItemStatistic":
            return f"{human(dd.get('Statistic'))}: {items.get(short(dd.get('Item')), {}).get('n', human(dd.get('Item')))} x{dd.get('Value', 1):,}"
        if ty == "PetUnlocked":
            return f"Find the pet {human(dd.get('Pet'))}"
        return human(ty)
    cat_points = {c["Id"]: c["BasePoints"] for c in O["MasteryGuildCategory"]}
    rank_pct = {r["Id"]: r["PointPercentRequired"] for r in O["MasteryGuildRank"]}
    guild = {}
    for ent, cfg in EC.items():
        sk = short(ent)
        if not cfg.get("MasteryGuildTasks"):
            continue
        tasks = {}
        for ref in cfg["MasteryGuildTasks"]:
            t = task_by_id.get(short(ref["Id"]))
            if not t:
                continue
            pts = cat_points.get(short(t["Category"]), 1)
            if t.get("Goal"):
                q, text = task_goal(t, sk)
                tasks[t["Id"]] = [pts, "g", text, q]
                continue
            elif t.get("TriggerGoal"):
                tasks[t["Id"]] = [pts, "t", human(t["TriggerGoal"]["Type"])]
            else:
                cg = t.get("ConditionGoal") or {}
                ty, dd = short(cg.get("Type")), cg.get("Data") or {}
                if ty == "Level":
                    tasks[t["Id"]] = [pts, "l", short(dd["Component"]["Entity"]), dd["Level"]]
                elif ty == "ItemStatistic":
                    tasks[t["Id"]] = [pts, "i", short(dd.get("Statistic")), short(dd.get("Item")), dd.get("Value", 1)]
                elif ty == "PetUnlocked":
                    tasks[t["Id"]] = [pts, "p", short(dd.get("Pet"))]
                elif ty == "ValueStatistic":
                    tasks[t["Id"]] = [pts, "v", short(dd.get("Statistic")), dd.get("Value", 1)]
                else:
                    tasks[t["Id"]] = [pts, "u", ty]
        ranks = {short(r["Id"]): rank_pct.get(short(r["Id"]), 0) for r in cfg.get("MasteryGuildRanks") or []}
        bonuses = []
        for ref in cfg.get("MasteryGuildBonuses") or []:
            b = next((x for x in O["MasteryGuildBonus"] if x["Id"] == short(ref["Id"])), None)
            if not b:
                continue
            bb = bonuses_of((b.get("Rewards") or {}).get("Bonuses"))
            rr = [short(q["Data"].get("Rank")) for q in b.get("Requirements") or [] if short(q["Type"]) == "MasteryGuildRank"]
            if bb and rr:
                bonuses.append({"id": b["Id"], "n": b["DisplayName"], "rank": rr[0], "b": bb})
        for tid, row in tasks.items():
            if row[1] in ("l", "i", "v", "u", "p"):
                row.append(human_cond(task_by_id[tid].get("ConditionGoal") or {}))
        guild[sk] = {"ranks": ranks, "tasks": tasks, "bonuses": bonuses,
                     "rankNames": {short(r["Id"]): next((x["DisplayName"] for x in O["MasteryGuildRank"] if x["Id"] == short(r["Id"])), r["Id"]) for r in cfg.get("MasteryGuildRanks") or []}}

    # ---- quests: steps -> tasks -> goals / hand-ins, rewards, and what each quest unlocks
    quest_cat_names = {c["Id"]: c["DisplayName"] for c in O.get("QuestCategory", [])}
    quests = {}
    registered = {short(x["Id"]) for x in EC.get(NS + "Quests", {}).get("Quests") or []}
    for qd in O["Quest"]:
        if registered and qd["Id"] not in registered:
            continue  # defined in the data but not offered by the game (placeholders)
        steps = []
        for st in qd.get("Steps") or []:
            tasks = []
            for tk in st.get("TasksInOrder") or []:
                goals = []
                for gl in tk.get("Goals") or []:
                    q, text = task_goal({"Goal": gl}, None)
                    goals.append({"id": str((gl.get("Data") or {}).get("Id", len(goals))), "text": text, "q": q})
                conds = [human_cond(c) for c in tk.get("ConditionGoals") or []]
                tasks.append({"id": str(tk["Id"]), "goals": goals, "cost": iq((tk.get("Costs") or {}).get("Items")),
                              "gp": sum(c["Quantity"] for c in (tk.get("Costs") or {}).get("Currencies") or [] if short(c["Currency"]) == "GoldPieces"),
                              "cond": conds})
            steps.append({"id": str(st["Id"]), "desc": st.get("Description") or "", "tasks": tasks})
        rw = qd.get("Rewards") or {}
        quests[qd["Id"]] = {
            "n": qd["DisplayName"], "cat": quest_cat_names.get(short(qd.get("Category")), short(qd.get("Category"))),
            "desc": (qd.get("Description") or "").split(" - ", 1)[-1][:400], "r": reqs_of(qd.get("Requirements")),
            "steps": steps,
            "rw": {"items": iq(rw.get("Items")),
                   "gp": sum(c["Quantity"] for c in rw.get("Currencies") or [] if short(c["Currency"]) == "GoldPieces"),
                   "cur": [[short(c["Currency"]), c["Quantity"]] for c in rw.get("Currencies") or [] if short(c["Currency"]) != "GoldPieces"],
                   "text": rw.get("CustomRewards") if isinstance(rw.get("CustomRewards"), str) else None},
            "unlocks": [], "order": len(quests),
        }
    def note_unlock(reqs, kind, oid, name):
        for r in reqs or []:
            if r.get("t") == "quest" and r["id"] in quests:
                quests[r["id"]]["unlocks"].append([kind, oid, name])
    for sid, sp in shop.items():
        note_unlock(sp["r"], "shop", sid, sp["n"])
    for aid, ar in combat["areas"].items():
        note_unlock(ar["r"], "area", aid, ar["n"])
    for eid, en in combat["enemies"].items():
        note_unlock(en["r"], "enemy", eid, en["n"])
    for qid, qd in quests.items():
        note_unlock(qd["r"], "quest", qid, qd["n"])

    game = {
        "v": 1,
        "gameVersion": "Alpha 0.11.7 (save v32)",
        "items": items, "buy": buy, "shop": shop, "methods": methods, "skills": skills, "currencies": cur_icons,
        "shopCats": shop_cats, "shopSubs": shop_subs, "recipeCats": cat_names, "guild": guild, "pets": pets, "combat": combat, "quests": quests, "astro": astro, "farm": farm, "agility": agility,
        # prayers: cost in prayer points, spent on your attack turn ("p") or the enemy's ("e"); bones give points when buried
        "prayer": {
            "prayers": {pr["Id"]: {"n": pr["DisplayName"], "i": icon(pr.get("Icon")), "slot": short(pr.get("FitsInSlot")), "cost": (pr.get("Cost") or {}).get("Quantity", 1),
                                   "on": "e" if short(((((pr.get("ConsumesOn") or {}).get("Data") or {}).get("Character") or {}).get("Component"))) == "Enemy" else "p",
                                   "r": reqs_of(pr.get("UnlockRequirements")), "b": bonuses_of(pr.get("Bonuses"))} for pr in O.get("Prayer") or []},
            "bones": {it["Id"]: ((it.get("Capabilities") or {}).get(NS + "Bury") or {}).get("CurrencyGain", {}).get("Quantity", 0)
                      for it in O["Item"] if (it.get("Capabilities") or {}).get(NS + "Bury")},
        },
        # bank upgrades: combine items into an upgraded item (instant)
        "upgrades": [{"id": u["Id"], "out": short(u["UpgradedItem"]), "q": u.get("QuantityPerUpgrade") or 1, "in": iq((u.get("Costs") or {}).get("Items")),
                      "gp": sum(c["Quantity"] for c in (u.get("Costs") or {}).get("Currencies") or [] if short(c["Currency"]) == "GoldPieces"),
                      "r": reqs_of(u.get("Requirements"))} for u in O.get("ItemUpgrade") or []],
    }
    with open(os.path.join(OUT, "data", "game.json"), "w", encoding="utf-8") as f:
        json.dump(game, f, separators=(",", ":"), ensure_ascii=False)
    print(f"items={len(items)} methods={len(methods)} shopItems={len(buy)} icons={written} missingIcons={missing}")


if __name__ == "__main__":
    main()
