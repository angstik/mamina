"""
Extraction complete d'une gazette Famileo (TCPDF, gabarit constant).
Implementation de reference de SPEC.md. Sortie : un JSON unique.

Usage : python extract.py gazette.pdf [-o gazette.json] [--no-emoji]
"""
from __future__ import annotations

import argparse
import datetime
import json
import re

import pdfplumber
import pymupdf

import emoji_resolver

CYAN = (0.431373, 0.745098, 0.850980)      # #6EBED9  tuile anniversaire / encart couverture
NAVY = (0.192157, 0.384314, 0.525490)      # #316286  tuile fete / bordures / libelles
CELL = 107.7                               # cote des tuiles de la grille 4 colonnes
COLS = (56.7, 181.4, 306.1, 430.9)
FULL_PAGE_RATIO = 0.6                      # boite > 60% de la hauteur page => article pleine page

MONTHS = {"janvier": 1, "fevrier": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6,
          "juillet": 7, "aout": 8, "septembre": 9, "octobre": 10, "novembre": 11,
          "decembre": 12}
_ACCENTS = str.maketrans("àâäéèêëîïôöûüùç", "aaaeeeeiioouuuc")


def month_number(label: str) -> int | None:
    """'AOÛT', 'août', 'sept.' -> 8 / 9. Insensible a la casse et aux accents."""
    key = label.strip().lower().translate(_ACCENTS).rstrip(".")
    if key in MONTHS:
        return MONTHS[key]
    for name, num in MONTHS.items():            # abreviations : 'sept', 'janv'
        if len(key) >= 3 and name.startswith(key):
            return num
    return None


def _safe_date(year: int, month: int, day: int):
    try:
        return datetime.date(year, month, day)
    except ValueError:                          # 29 fevrier hors annee bissextile
        return None


def resolve_years(posts: list[dict], cover_iso: str | None) -> bool:
    """
    Les dates de post ne portent PAS d'annee ('le 31 aout'). On remonte la liste
    depuis la date de couverture, qui est la borne superieure du numero, en
    decrementant l'annee des qu'une date depasserait la precedente. Gere le
    passage decembre -> janvier. Renvoie True si la suite est chronologique.
    """
    if not cover_iso:
        return False
    upper = datetime.date.fromisoformat(cover_iso)
    year, prev, ordered = upper.year, upper, True
    for post in reversed(posts):
        m = re.match(r"^le\s+(\d{1,2})\s+(.+?)\s*$", post["date_label"], re.I)
        num = month_number(m.group(2)) if m else None
        if not num:
            post["date_iso"] = None
            ordered = False
            continue
        day = int(m.group(1))
        d = _safe_date(year, num, day)
        while d is None or d > prev:
            year -= 1
            d = _safe_date(year, num, day)
        post["date_iso"] = d.isoformat()
        prev = d
    return ordered


def _close(a, b, tol=0.02):
    return a is not None and len(a) == 3 and all(abs(x - y) < tol for x, y in zip(a, b))


def _style(fontname: str) -> str:
    """'AAAABB+NotoSans-SemiBold' -> 'SemiBold' (comparaison EXACTE : 'Bold'
    est un sous-mot de 'SemiBold', un `contains` melange les deux styles)."""
    return fontname.split("+")[-1].split("-", 1)[-1] if "-" in fontname else "Regular"


def _pick(chars, size, style, tol=0.3):
    return [c for c in chars if abs(c["size"] - size) < tol and _style(c["fontname"]) == style]


def _in_box(obj, box, pad=2.0):
    return (box["x0"] - pad <= obj["x0"] and obj["x1"] <= box["x0"] + box["width"] + pad
            and box["top"] - pad <= obj["top"] and obj["bottom"] <= box["top"] + box["height"] + pad)


def _lines(chars, emoji=()):
    """Regroupe par ligne (top arrondi) et reinsere les emoji par abscisse."""
    buckets: dict[int, list] = {}
    for c in chars:
        buckets.setdefault(round(c["top"]), []).append(c)
    out = []
    for top in sorted(buckets):
        cs = sorted(buckets[top], key=lambda c: c["x0"])
        h = cs[0]["bottom"] - cs[0]["top"]
        toks = [(c["x0"], c["text"]) for c in cs]
        toks += [(e["x0"], e["char"]) for e in emoji
                 if top - 0.4 * h <= e["y"] <= top + 1.4 * h]
        out.append("".join(t for _, t in sorted(toks)))
    return out


def _flow(chars, emoji=()):
    return " ".join(" ".join(_lines(chars, emoji)).split())


# --------------------------------------------------------------------------- couverture
def parse_cover(page) -> dict:
    up = [c for c in page.chars if c["upright"]]
    rot = [c for c in page.chars if not c["upright"]]

    date = _flow(_pick(up, 13.0, "Regular"))            # "31 AOÛT 2026"
    title = _flow(_pick(up, 17.0, "Light"))             # sous-titre libre
    issue = _flow(_pick(up, 25.0, "Regular"))           # "N°42"
    code = "".join(c["text"] for c in sorted(rot, key=lambda c: -c["top"]))

    thumbs = [{"col": min(range(4), key=lambda k: abs(COLS[k] - i["x0"])),
               "row": round((i["top"] - 62.4) / 124.7),
               "src_px": list(i["srcsize"])}
              for i in page.images if abs(i["width"] - CELL) < 2]
    m = re.match(r"^(\d{1,2})\s+(.+?)\s+(\d{4})$", date)
    iso = None
    if m:
        num = month_number(m.group(2))
        if num:
            d = _safe_date(int(m.group(3)), num, int(m.group(1)))
            iso = d.isoformat() if d else None
    return {
        "issue_label": issue,
        "issue_number": int(re.sub(r"\D", "", issue)) if issue else None,
        "date_label": date,
        "date_parts": {"day": int(m.group(1)), "month": m.group(2), "year": int(m.group(3))} if m else None,
        "date_iso": iso,
        "title": title,
        "client_code": code,
        "thumbnails": sorted(thumbs, key=lambda t: (t["row"], t["col"])),
    }


# --------------------------------------------------------------------------- page posts
def _layout(body_chars, collages, box) -> str:
    """
    Classification GEOMETRIQUE, independante des dimensions du gabarit :
    le texte est a droite du collage s'il commence apres son bord droit,
    en dessous s'il commence apres son bord inferieur.
    """
    if not collages or not body_chars:
        return "text_right"
    left = min(c["x0"] for c in body_chars)
    top = min(c["top"] for c in body_chars)
    right_edge = max(i["x0"] + i["width"] for i in collages)
    bottom_edge = max(i["top"] + i["height"] for i in collages)
    if left >= right_edge - 2:
        return "text_right"
    if top >= bottom_edge - 2:
        return "text_below"
    return "text_right" if left >= box["x0"] + box["width"] / 2 else "text_below"


def parse_posts(page, emoji) -> list[dict]:
    posts = []
    boxes = [r for r in page.rects if r["width"] > 400 and r["height"] > 100]
    n_boxes = len(boxes)
    for box in sorted(boxes, key=lambda r: r["top"]):
        b = {"x0": box["x0"], "top": box["top"], "width": box["width"], "height": box["height"]}
        chars = [c for c in page.chars if _in_box(c, b)]
        marks = [e for e in emoji if b["top"] <= e["y"] <= b["top"] + b["height"]]
        imgs = [i for i in page.images if _in_box(i, b)]
        collages = [i for i in imgs if i["width"] > 100]
        avatar = next((i for i in imgs if abs(i["width"] - 62.4) < 3), None)
        body = _pick(chars, 13.3, "Regular")
        posts.append({
            "page": page.page_number,
            "author": _flow(_pick(chars, 14.0, "SemiBold")),
            "date_label": _flow(_pick(chars, 11.0, "Regular")),
            "text": _flow(body, marks),
            "lines": _lines(body, marks),
            "emoji": [{"char": e["char"], "unified": e["unified"], "via": e["via"]}
                      for e in sorted(marks, key=lambda e: (e["y"], e["x0"]))],
            "slot": ("full" if box["height"] > FULL_PAGE_RATIO * page.height
                     else ("top" if n_boxes == 1 or box["top"] < page.height / 2 else "bottom")),
            "box_pt": [round(box["x0"], 2), round(box["top"], 2),
                       round(box["width"], 2), round(box["height"], 2)],
            "layout": _layout(body, collages, b),
            "avatar": {"src_px": list(avatar["srcsize"])} if avatar else None,
            "collages": [{"src_px": list(i["srcsize"]),
                          "box_pt": [round(i["x0"], 2), round(i["top"], 2),
                                     round(i["width"], 2), round(i["height"], 2)]}
                         for i in collages],
        })
    return posts


# --------------------------------------------------------------------------- 4e de couverture
def parse_back(page) -> dict:
    addr = _lines(_pick(page.chars, 10.0, "Regular"))
    tiles = []
    for r in page.rects:
        if abs(r["width"] - CELL) > 2 or abs(r["height"] - CELL) > 2:
            continue
        if not r["fill"]:                             # tuile-libelle : contour seul
            continue
        key = (round(r["x0"], 1), round(r["top"], 1))
        fill = CYAN if _close(r["non_stroking_color"], CYAN) else (
               NAVY if _close(r["non_stroking_color"], NAVY) else None)
        if fill is None:
            continue
        tiles.append((key, "birthday" if fill is CYAN else "nameday", r))

    events, seen = [], set()
    for key, kind, r in sorted(tiles, key=lambda t: (t[0][1], t[0][0])):
        if key in seen:
            continue
        seen.add(key)
        b = {"x0": r["x0"], "top": r["top"], "width": r["width"], "height": r["height"]}
        chars = [c for c in page.chars if _in_box(c, b)]
        name = _flow(_pick(chars, 11.0, "Bold"))
        detail = _lines(_pick(chars, 11.0, "SemiBold"))
        if not name:                                  # tuile-libelle ("Le prochain anniversaire")
            continue
        age = next((int(m.group(1)) for d in detail
                    if (m := re.match(r"^(\d+)\s*ans?\b", d))), None)
        when = next((d for d in detail if re.match(r"^le\s", d, re.I)), None)
        events.append({"kind": kind, "name": name, "age": age, "date_label": when})

    return {
        "recipient": {"name": addr[0] if addr else None, "address_lines": addr[1:]},
        "events": events,
        "thumbnails": [{"src_px": list(i["srcsize"])} for i in page.images
                       if abs(i["width"] - CELL) < 2],
    }


# --------------------------------------------------------------------------- pipeline
def extract(path: str, with_emoji: bool = True) -> dict:
    emoji = []
    if with_emoji:
        with pymupdf.open(path) as doc:
            emoji = emoji_resolver.resolve(doc)

    with pdfplumber.open(path) as pdf:
        n = len(pdf.pages)
        posts = []
        for pno in range(2, n):
            page = pdf.pages[pno - 1]
            posts += parse_posts(page, [e for e in emoji if e["page"] == pno])
        doc = {
            "source": {"pages": n, "page_size_pt": [round(pdf.pages[0].width, 3),
                                                    round(pdf.pages[0].height, 3)],
                       "producer": pdf.metadata.get("Producer"),
                       "title": pdf.metadata.get("Title"),
                       "created": pdf.metadata.get("CreationDate")},
            "cover": parse_cover(pdf.pages[0]),
            "posts": posts,
            "back": parse_back(pdf.pages[n - 1]),
        }
    chronological = resolve_years(posts, doc["cover"]["date_iso"])
    doc["stats"] = {"posts": len(posts),
                    "chronological": chronological,
                    "date_range": [posts[0].get("date_iso"), posts[-1].get("date_iso")] if posts else None,
                    "emoji_occurrences": sum(len(p["emoji"]) for p in posts),
                    "contributors": sorted({p["author"] for p in posts})}
    return doc


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("-o", "--out")
    ap.add_argument("--no-emoji", action="store_true")
    a = ap.parse_args()
    data = extract(a.pdf, with_emoji=not a.no_emoji)
    txt = json.dumps(data, ensure_ascii=False, indent=2)
    if a.out:
        open(a.out, "w", encoding="utf-8").write(txt)
        print(f"{data['stats']['posts']} posts, "
              f"{data['stats']['emoji_occurrences']} emoji -> {a.out}")
    else:
        print(txt)
