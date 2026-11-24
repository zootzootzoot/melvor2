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
        for r in lst or []:
            t, dd = short(r["Type"]), r["Data"]
            if t == "Level":
                out.append({"t": "lvl", "s": short(dd["Component"]["Entity"]), "l": dd["Level"]})
            elif t == "ShopPurchase":
                out.append({"t": "shop", "id": short(dd["ShopPurchase"]), "n": dd.get("Amount", 1)})
            elif t == "ToolbeltItemEquipped":
                out.append({"t": "tool", "item": short(dd["Item"])})
            elif t == "QuestComplete":
                out.append({"t": "quest", "id": short(dd["Quest"])})
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
                }.get(t, t)
                out.append({"t": "other", "k": t, "text": label})
    return out


def iq(lst, qty="Quantity"):
    return [[short(x["Item"]), x[qty]] for x in lst or []]


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

    # shop: buyable items priced in GP (unlimited, single currency)
    shop = {}
    buy = {}
    for s in O["ShopPurchase"]:
        cur = [[short(c["Currency"]), c["Quantity"]] for c in s["Costs"]["Currencies"]]
        shop[s["Id"]] = {"n": s["DisplayName"], "i": icon(s.get("Icon")), "cost": cur,
                         "ci": iq(s["Costs"]["Items"]), "r": reqs_of(s.get("Requirements"))}
        prov = s["Provides"]["Items"]
        if (len(prov) == 1 and not s["Costs"]["Items"] and len(cur) == 1 and cur[0][0] == "GoldPieces"
                and s.get("DefaultBuyLimit", 0) == 0):
            iid, q = short(prov[0]["Item"]), prov[0]["Quantity"]
            price = cur[0][1] / q
            if iid not in buy or buy[iid]["p"] > price:
                buy[iid] = {"p": price, "shop": s["Id"]}

    cat_reqs = {c["Id"]: c.get("Requirements") for c in O["RecipeCategory"]}
    fish_loc = {c["Id"]: c for c in O["FishingLocation"]}
    thv_loc = {c["Id"]: c for c in O["ThievingLocation"]}
    methods = []

    def base_level(rq, skill):
        return max([r["l"] for r in rq if r["t"] == "lvl" and r["s"] == skill] or [1])

    def push(skill, r, kind, ms, xp, ins, outs, gp=0.0, reqs=None, extra=None, icon_res=None, name=None):
        cat = short(r.get("Category"))
        if cat in quest_cats:
            return
        rq = reqs if reqs is not None else reqs_of(r.get("Requirements"), cat_reqs.get(cat))
        m = {
            "id": f"{skill}:{r['Id']}", "s": skill, "n": name or (r["DisplayName"] if isinstance(r["DisplayName"], str) else r["DisplayName"]["Singular"]),
            "i": icon(icon_res or r.get("Icon") or r.get("Media")), "k": kind, "ms": round(ms, 3), "xp": xp,
            "in": [[a, b] for a, b in ins], "out": tolist(outs) if isinstance(outs, dict) else outs, "gp": round(gp, 4),
            "lv": base_level(rq, skill), "r": rq, "cat": cat,
        }
        if extra:
            m.update(extra)
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
             extra={"note": f"{hp} hits per log"})

    # Mining: expected hits to break a rock given BaseProductChance.
    for r in O["MiningRecipe"]:
        hits = mining_expected_hits(r["BaseProductChance"])
        outs = {short(r["Product"]["Item"]): r["Product"]["Quantity"]}
        for x in r["RandomProductsPerHit"] or []:
            addmap(outs, {short(x["Item"]): x["Quantity"] * x["Chance"] * hits})
        push("Mining", r, "active", r["BaseInterval"] * hits, r["BaseExperience"], [], outs,
             extra={"note": f"~{hits:.1f} swings per ore"})

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
             extra={"loc": loc.get("DisplayName")})

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
                    "stages": r["Stages"], "rt": short(r["RecipeType"])})

    # Cooking: success = clamp((69+level)/(69+difficulty)); ingredients spent on failure.
    for r in O["CookingRecipe"]:
        outs = {short(p["Item"]): p["Quantity"] * p["Chance"] for p in r["Products"]}
        push("Cooking", r, "active", r["BaseInterval"], r["BaseExperience"], iq(r["Ingredients"]["Items"]), outs,
             extra={"succ": {"t": "cooking", "d": r["Difficulty"]}})

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
             extra={"note": f"{steps} steps" if steps > 1 else None})

    # Herblore: four timed stages per batch.
    for r in O["HerbloreRecipe"]:
        ms = r["BasePreparingInterval"] + r["BaseHeatingInterval"] + r["BaseStirringInterval"] + r["BaseBottlingInterval"]
        outs = {}
        for p in r["Products"]:
            addmap(outs, {short(p["Item"]): p["Quantity"] * p["Chance"]})
        push("Herblore", r, "active", ms, r["BaseExperience"], iq(r["Ingredients"]["Items"]), outs)

    # Firemaking: burn a log, by-products by chance.
    for r in O["FiremakingRecipe"]:
        outs = {}
        for p in r["Products"]:
            addmap(outs, {short(p["Item"]): p["Quantity"] * p["Chance"]})
        push("Firemaking", r, "active", r["BaseInterval"], r["BaseExperience"], iq(r["Ingredients"]["Items"]), outs)

    # Farming: passive, per plot.
    for r in O["FarmingRecipe"]:
        outs = {short(r["Product"]["Item"]): r["Product"]["Quantity"]}
        push("Farming", r, "passive", r["BaseInterval"], r["BaseExperience"], iq(r["Ingredients"]["Items"]), outs,
             extra={"note": "per plot, passive"})

    for m in methods:
        if m.get("note") is None:
            m.pop("note", None)

    skills = {}
    for ent in EC:
        s = short(ent)
        res = f"res://Assets/Icons/{s}.png"
        if pk.has(res.replace("res://", "") + ".import"):
            skills[s] = {"i": icon(res)}
    for extra_icon in ["GoldPieces", "SlayerCoins", "Bank", "Shop", "Combat"]:
        res = f"res://Assets/Icons/{extra_icon}.png"
        if pk.has(res.replace("res://", "") + ".import"):
            skills.setdefault("_" + extra_icon, {"i": icon(res)})
    cur_icons = {short(c["Id"]): icon(c.get("Icon")) for c in O["Currency"]}

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
    for coll in (items.values(), methods, shop.values(), skills.values()):
        for x in coll:
            if x.get("i") and x["i"] not in have:
                x["i"] = None
    cur_icons = {k: (v if v in have else None) for k, v in cur_icons.items()}

    game = {
        "v": 1,
        "gameVersion": "Alpha 0.11.5.5 (save v31)",
        "items": items, "buy": buy, "shop": shop, "methods": methods, "skills": skills, "currencies": cur_icons,
    }
    with open(os.path.join(OUT, "data", "game.json"), "w", encoding="utf-8") as f:
        json.dump(game, f, separators=(",", ":"), ensure_ascii=False)
    print(f"items={len(items)} methods={len(methods)} shopItems={len(buy)} icons={written} missingIcons={missing}")


if __name__ == "__main__":
    main()
