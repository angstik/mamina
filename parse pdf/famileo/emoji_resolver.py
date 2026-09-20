"""
Resolution des emoji d'une gazette Famileo (implementation de reference).

Les emoji ne sont pas dans la couche texte : Famileo les remplace par des
images JPEG 64x64 (assets Apple Color Emoji) posees en absolu dans la page.

Deux etages, cf. SPEC.md section 6 :
  1. SHA-256 du flux image BRUT -> table catalog/emoji-sha256.json  (O(1), exact)
  2. descripteur 8x8x3 par moyenne de blocs -> catalog/emoji-catalog.bin
     (cosinus, seuil absolu 0.999)
Tout hit de l'etage 2 doit etre reinjecte dans la table SHA-256.
"""
from __future__ import annotations

import hashlib
import io
import json
import pathlib

import numpy as np
from PIL import Image

CAT = pathlib.Path(__file__).with_name("catalog")
GRID, CH, SIZE = 8, 3, 64
MIN_SIM = 0.999
MAX_PX = 80          # un emoji fait 64x64 ; avatars 170, collages >= 900


def descriptor_u8(im: Image.Image) -> np.ndarray:
    """64x64 -> 8x8x3 uint8 par moyenne de blocs 8x8 exacts (deterministe)."""
    if im.mode == "RGBA":
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[3])
        im = bg
    im = im.convert("RGB")
    if im.size != (SIZE, SIZE):
        im = im.resize((SIZE, SIZE), Image.BILINEAR)
    a = np.asarray(im, np.float64).reshape(GRID, SIZE // GRID, GRID, SIZE // GRID, CH)
    return np.round(a.mean((1, 3))).astype(np.uint8)


def _unit(q: np.ndarray) -> np.ndarray:
    v = q.astype(np.float32).ravel()
    v -= v.mean()
    n = np.linalg.norm(v)
    return v / n if n else v


class Catalog:
    def __init__(self) -> None:
        meta = json.loads((CAT / "emoji-catalog.json").read_text())
        raw = np.fromfile(CAT / "emoji-catalog.bin", np.uint8)
        self.unified = [e["u"] for e in meta["entries"]]
        self.sets = [e["s"] for e in meta["entries"]]
        self.matrix = np.vstack([_unit(r) for r in
                                 raw.reshape(meta["count"], GRID, GRID, CH)])
        self.sha = json.loads((CAT / "emoji-sha256.json").read_text())["entries"]

    def lookup(self, raw_stream: bytes) -> tuple[str | None, float, str, str | None]:
        digest = hashlib.sha256(raw_stream).hexdigest()
        if digest in self.sha:
            e = self.sha[digest]
            return e["u"], 1.0, "sha256", e.get("set")
        sims = self.matrix @ _unit(descriptor_u8(Image.open(io.BytesIO(raw_stream))))
        i = int(np.argmax(sims))
        if sims[i] < MIN_SIM:
            return None, float(sims[i]), "reject", None
        return self.unified[i], float(sims[i]), "descriptor", self.sets[i]


def to_char(unified: str) -> str:
    return "".join(chr(int(c, 16)) for c in unified.split("-"))


def resolve(doc) -> list[dict]:
    """doc : document pymupdf ouvert -> une entree par emoji place."""
    cat, cache, out = Catalog(), {}, []
    for pno in range(len(doc)):
        page = doc[pno]
        for xref, _, w, h, *_ in page.get_images(full=True):
            if w > MAX_PX or h > MAX_PX:
                continue
            if xref not in cache:
                cache[xref] = cat.lookup(doc.extract_image(xref)["image"])
            unified, sim, via, eset = cache[xref]
            if unified is None:
                continue
            for r in page.get_image_rects(xref):
                out.append({"page": pno + 1, "x0": r.x0, "y": (r.y0 + r.y1) / 2,
                            "unified": unified, "char": to_char(unified),
                            "sim": sim, "via": via, "set": eset, "xref": xref})
    return out
