"""
Runner de reference du contrat tests/checks.json.

    python tests/run_golden.py /repertoire/contenant/les/pdf

Toute implementation (Rust, Node, navigateur…) doit produire un JSON
strictement egal a tests/golden/*.json et passer les cas `unit`.
"""
from __future__ import annotations

import datetime
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import extract                                    # noqa: E402
import emoji_resolver                             # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
CHECKS = json.loads((HERE / "checks.json").read_text())

ok, ko = 0, 0


def check(label, got, want):
    global ok, ko
    if got == want:
        ok += 1
        print(f"  ok   {label}")
    else:
        ko += 1
        print(f"  FAIL {label}\n       attendu {want!r}\n       obtenu  {got!r}")


# `via` indique quel etage a resolu l'emoji (sha256 ou descriptor) : c'est un
# etat de cache, pas un resultat de parsing. Une implementation partant d'une
# table SHA vide doit produire le meme JSON par ailleurs.
IGNORED_KEYS = {"via"}


def diff_paths(a, b, path=""):
    """Chemins ou deux structures JSON divergent (10 premiers)."""
    out = []
    if type(a) is not type(b):
        return [f"{path}: type {type(a).__name__} != {type(b).__name__}"]
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k in IGNORED_KEYS:
                continue
            if k not in a:
                out.append(f"{path}.{k}: manquant a gauche")
            elif k not in b:
                out.append(f"{path}.{k}: manquant a droite")
            else:
                out += diff_paths(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append(f"{path}: longueur {len(a)} != {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            out += diff_paths(x, y, f"{path}[{i}]")
    elif a != b:
        out.append(f"{path}: {a!r} != {b!r}")
    return out[:10]


def run_fixtures(pdf_dir: pathlib.Path):
    for fx in CHECKS["fixtures"]:
        pdf = pdf_dir / fx["pdf"]
        print(f"\n[fixture] numero {fx['issue']} — {pdf.name}")
        if not pdf.exists():
            print(f"  SKIP  introuvable : {pdf}")
            continue
        got = extract.extract(str(pdf))
        want = json.loads((HERE / fx["golden"]).read_text())
        d = diff_paths(json.loads(json.dumps(got, ensure_ascii=False)), want, "$")
        check("JSON identique au golden", d or "identique", "identique")
        for line in d:
            print(f"       {line}")

        e = fx["expect"]
        check("posts", got["stats"]["posts"], e["posts"])
        check("emoji", got["stats"]["emoji_occurrences"], e["emoji_occurrences"])
        check("contributeurs", got["stats"]["contributors"], e["contributors"])
        check("plage de dates", got["stats"]["date_range"], e["date_range"])
        check("numero", got["cover"]["issue_number"], e["issue_number"])
        check("code client", got["cover"]["client_code"], e["client_code"])
        check("destinataire", got["back"]["recipient"]["name"], e["recipient_name"])
        check("evenements", got["back"]["events"], e["events"])
        check("emoji uniques",
              sorted({x["unified"] for p in got["posts"] for x in p["emoji"]}),
              e["emoji_unique"])


def run_unit():
    print("\n[unit] mois francais")
    for label, want in CHECKS["unit"]["month_number"]:
        check(f"month_number({label!r})", extract.month_number(label), want)

    print("\n[unit] codepoints -> caractere")
    for uni, want in CHECKS["unit"]["codepoints"]:
        check(uni, emoji_resolver.to_char(uni), want)

    print("\n[unit] resolution des annees")
    for case in CHECKS["unit"]["year_rollover"]:
        posts = [{"date_label": lab} for lab in case["labels"]]
        extract.resolve_years(posts, case["cover_iso"])
        check(case["why"], [p["date_iso"] for p in posts], case["expect"])

    print("\n[unit] mise en page et emplacement (dont ARTICLE PLEINE PAGE)")
    page_h = 841.89
    for case in CHECKS["unit"]["layout"]:
        x0, top, w, h = case["box"]
        box = {"x0": x0, "top": top, "width": w, "height": h}
        collages = [{"x0": c[0], "top": c[1], "width": c[2], "height": c[3]}
                    for c in case["collages"]]
        body = [{"x0": case["body_origin"][0], "top": case["body_origin"][1]}]
        check(case["why"] + " / layout", extract._layout(body, collages, box),
              case["expect_layout"])
        slot = ("full" if h > extract.FULL_PAGE_RATIO * page_h
                else ("top" if top < page_h / 2 else "bottom"))
        check(case["why"] + " / slot", slot, case["expect_slot"])

    print("\n[unit] seuil emoji")
    t = CHECKS["unit"]["emoji_threshold"]
    check("MIN_SIM", emoji_resolver.MIN_SIM, t["min_sim"])
    check("seuil < plus bas vrai positif observe",
          emoji_resolver.MIN_SIM < t["observed_min_true_positive"], True)


if __name__ == "__main__":
    pdf_dir = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    run_unit()
    run_fixtures(pdf_dir)
    print(f"\n{ok} ok, {ko} echec(s)")
    sys.exit(1 if ko else 0)
