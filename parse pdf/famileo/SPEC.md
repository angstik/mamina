# SPEC — Parsing d'une gazette Famileo (PDF → JSON)

Document d'implémentation. Autoportant : tout ce qui suit est **vérifié sur
deux numéros** (n° 42 et n° 43, 16 pages / 28 posts chacun, 26 et 21 emoji).
Aucun langage ni plateforme imposé. Contrat de test : `tests/checks.json` et
`tests/golden/*.json`.

---

## 0. Directives impératives

1. **Ne jamais utiliser l'ordre de lecture du flux de contenu.** Le gabarit
   place l'auteur *après* le message dans certaines mises en page. Toute
   reconstruction doit passer par la **géométrie** (boîtes, coordonnées) et par
   le **style de police**, jamais par l'ordre des opérateurs `Tj`.
2. **Ne jamais faire d'OCR.** La couche texte est propre et complète (hors
   emoji). Un pipeline qui rasterise est un bug.
3. **Ne pas supposer 2 posts par page.** Un article peut occuper la page
   entière (une seule boîte, photo plus grande, texte identique). Le nombre de
   boîtes se compte, il ne se présume pas.
4. **Ne jamais découper les collages photo.** Les 2 à 4 photos d'un post sont
   pré-assemblées côté serveur en **une seule image JPEG**. On expose l'image
   telle quelle ; sa segmentation est hors périmètre.
5. **Comparer les styles de police par égalité exacte, pas par `contains`.**
   `"Bold"` est un sous-mot de `"SemiBold"` : un `contains` confond le nom d'un
   contact et sa date de fête sur la 4ᵉ de couverture.
6. **Échouer bruyamment.** Les invariants de la section 8 doivent être assertés.
   Un gabarit qui dérive doit produire une erreur, pas un JSON silencieusement
   amputé.
7. **Les emoji ne sont pas du texte.** Ils sont des images ; voir section 6.
8. **Ne jamais compter ni attribuer les images depuis la liste des ressources.**
   TCPDF déclare les XObjects dans un dictionnaire partagé par toutes les pages :
   l'énumération brute annonce 1 296 images là où il n'y a que 104 placements
   réels. Seuls les **rectangles de placement** font foi ; voir §5.5.

---

## 1. Capacités requises de la bibliothèque PDF

Le parseur a besoin d'un accès bas niveau. Quelle que soit la bibliothèque
retenue, elle doit exposer :

| Besoin | Détail |
| --- | --- |
| Caractères positionnés | `x0, x1, top, bottom`, texte Unicode, nom de police, taille en pt, couleur de remplissage, flag « droit / pivoté » |
| Rectangles vectoriels | `x0, top, width, height`, **couleur de remplissage**, **couleur de trait**, **booléens `fill` / `stroke` séparés** |
| Images placées | rectangle de placement en pt **et** dimensions source en px |
| Flux image brut | les octets **non décodés** de l'XObject (SHA-256 des emoji §6.3 et des avatars §5.5) |
| Identité d'XObject | un identifiant stable par image (`xref` ou équivalent) pour dédupliquer |

Système de coordonnées de cette spec : **origine en haut à gauche, `top`
croissant vers le bas**, unité = point PDF. Si la bibliothèque utilise
l'origine PDF native (bas-gauche), convertir par `top = page_height − y_haut`.

---

## 2. Identité du document

```
Producer     TCPDF 6.x
Page size    595.276 × 841.89 pt (A4), rotation 0
Pages        16 (variable : 1 couverture + N pages de posts + 1 dos)
Polices      NotoSans-{Light,Regular,SemiBold,Bold}  (CID TrueType, Identity-H,
             embarquées, ToUnicode présent → extraction propre, pas de mojibake)
             OpenSans 5.1 pt (code client de couverture uniquement)
```

`Raleway*`, `Rockwell-Light` et `Helvetica` sont **déclarées dans les ressources
mais jamais utilisées** par le contenu. Les ignorer.

Couleurs de marque (référence unique pour tous les tests de couleur) :

```
NAVY  = #316286  = (0.192157, 0.384314, 0.525490)   bordures, libellés, tuiles « fête »
CYAN  = #6EBED9  = (0.431373, 0.745098, 0.850980)   encarts couverture, tuiles « anniversaire »
```

Comparer avec une tolérance de `0.02` par canal.

---

## 3. Taxonomie des pages

| Page | Rôle | Détection robuste |
| --- | --- | --- |
| 1 | Couverture | première page |
| 2 … N−1 | Posts (**1 ou 2 par page**) | contient ≥ 1 rectangle de largeur > 400 pt et hauteur > 100 pt |
| N | 4ᵉ de couverture (adresse + événements) | dernière page |

Ne pas coder en dur `N = 16`.

---

## 4. Modèle de sortie

Schéma exprimé en TypeScript à titre de notation uniquement — implémenter dans
le langage cible avec les mêmes noms de champs.

```ts
type Gazette = {
  source: {
    pages: number;
    page_size_pt: [number, number];
    producer: string | null;
    title: string | null;          // métadonnée PDF, ex. "La gazette de Nadia Weiss"
    created: string | null;        // métadonnée PDF brute (D:YYYYMMDDHHmmSSZ)
  };
  cover: Cover;
  posts: Post[];
  back: Back;
  stats: {
    posts: number;
    chronological: boolean;        // les posts se suivent-ils dans le temps ?
    date_range: [string | null, string | null];
    emoji_occurrences: number;
    contributors: string[];        // auteurs distincts, triés
  };
};

type Cover = {
  issue_label: string;             // "N°42"
  issue_number: number | null;     // 42
  date_label: string;              // "31 AOÛT 2026"
  date_parts: { day: number; month: string; year: number } | null;
  date_iso: string | null;         // "2026-08-31" — borne haute du numéro, §5.4
  title: string;                   // sous-titre libre, ex. "De Nadia eihri Zidung"
  client_code: string;             // "854397" — texte pivoté 90°, voir §5.1
  thumbnails: { col: 0|1|2|3; row: number; src_px: [number, number] }[];
};

type Post = {
  page: number;                    // 1-based
  author: string;
  date_label: string;              // "le 17 août" — jour+mois, PAS d'année
  date_iso: string | null;         // année déduite, §5.4
  text: string;                    // lignes jointes par un espace, emoji réinjectés
  lines: string[];                 // découpage typographique d'origine
  emoji: { char: string; unified: string; via: "sha256" | "descriptor" }[];
  slot: "top" | "bottom" | "full"; // "full" = article occupant la page entière
  box_pt: [number, number, number, number];
  layout: "text_right" | "text_below";
  avatar: { src_px: [number, number] } | null;
  collages: { src_px: [number, number]; box_pt: [number, number, number, number] }[];
};

type Back = {
  recipient: { name: string | null; address_lines: string[] };
  events: {
    kind: "birthday" | "nameday";
    name: string;
    age: number | null;            // renseigné pour birthday uniquement
    date_label: string | null;     // "le 9 sept."
  }[];
  thumbnails: { src_px: [number, number] }[];
};
```

Règles de normalisation du texte :
- `lines` = une entrée par ligne typographique, sans retouche.
- `text` = `lines` jointes par `" "`, puis **compactage de tous les espaces
  consécutifs en un seul**, et trim.
- Ne pas « corriger » la ponctuation, les fautes ni les espaces manquants avant
  un emoji : le corpus est de l'écriture familiale, il doit rester fidèle.
- Le texte contient de l'alsacien et des apostrophes typographiques `’` (U+2019)
  mêlées à des apostrophes droites `'` : **ne pas normaliser**.

---

## 5. Algorithmes

### 5.0 Primitives communes

```
STYLE(fontname):
    # "AAAABB+NotoSans-SemiBold" -> "SemiBold"
    base = partie après "+" si présente sinon fontname
    retourner partie après le premier "-" si présente sinon "Regular"

PICK(chars, size, style, tol = 0.3):
    retourner [c pour c dans chars si |c.size - size| < tol et STYLE(c.font) == style]
    # égalité EXACTE sur le style — cf. directive 4

IN_BOX(obj, box, pad = 2.0):
    retourner box.x0 - pad <= obj.x0 et obj.x1 <= box.x0 + box.width + pad
          et box.top - pad <= obj.top et obj.bottom <= box.top + box.height + pad

LINES(chars, emoji = []):
    buckets = grouper chars par round(c.top)              # 1 bucket = 1 ligne
    pour chaque bucket dans l'ordre croissant de top:
        cs = bucket trié par x0
        h  = cs[0].bottom - cs[0].top
        tokens = [(c.x0, c.text) pour c dans cs]
        tokens += [(e.x0, e.char) pour e dans emoji
                   si top - 0.4*h <= e.y_center <= top + 1.4*h]
        émettre concat(tokens triés par abscisse)

FLOW(chars, emoji = []):
    retourner compacter_espaces(join(LINES(chars, emoji), " "))
```

### 5.1 Couverture

Grille 4 colonnes, cellules carrées de **107.7 pt** :

```
colonnes x0 = 56.7 | 181.4 | 306.1 | 430.9      (pas 124.7)
lignes   top = 62.4 | 187.1 | 547.0 | 671.7     (bloc haut et bloc bas, logo au milieu)
```

Une cellule est soit une vignette photo (image 437×437 px), soit un **encart
CYAN** portant du texte. Les deux encarts observés sont la date (ligne 2,
col 4) et le numéro (ligne 4, col 4) — ne pas coder leur position en dur, les
identifier par le texte qu'ils contiennent.

```
chars_droits  = chars avec flag "droit" = vrai
chars_pivotés = chars avec flag "droit" = faux

date_label  = FLOW(PICK(chars_droits, 13.0, "Regular"))     # "31 AOÛT 2026"
title       = FLOW(PICK(chars_droits, 17.0, "Light"))       # sous-titre libre
issue_label = FLOW(PICK(chars_droits, 25.0, "Regular"))     # "N°42"
issue_number = premier entier extrait de issue_label

# code client : OpenSans 5.1 pt, matrice (0,1,-1,0) = rotation 90° anti-horaire,
# colonne à x ≈ 45.8. Les glyphes sont émis du BAS vers le HAUT :
client_code = concat(chars_pivotés triés par top DÉCROISSANT)
```

`date_parts` : parser `^(\d{1,2})\s+(.+?)\s+(\d{4})$` sur `date_label`. Le mois
est en capitales et en français (`AOÛT`) ; conserver le libellé brut et laisser
la conversion en numéro de mois à la couche appelante (table de correspondance
FR, accents inclus).

### 5.2 Page de posts

```
boîtes = [r pour r dans page.rects si r.width > 400 et r.height > 100]
trier boîtes par top
```

Valeurs observées sur les 28 pages de posts des deux numéros : `x0 = 45.35`,
`width = 504.57`, `height = 381.26`, `top ∈ {31.2, 426.6}`.

**Utiliser le prédicat, pas les constantes.** Une page peut porter une seule
boîte : dernière page incomplète, ou **article pleine page** (même gabarit, photo
plus grande, texte inchangé). Emplacement :

```
slot = "full"   si box.height > 0.6 × page_height
       "top"    si une seule boîte, ou box.top < page_height / 2
       "bottom" sinon
```

Une boîte pleine page occupe l'intervalle `[31.2 , 807.86]`, soit
`height ≈ 776.66 = 2 × 381.26 + 14.14` (le gouttière inter-boîtes). Cette valeur
est **déduite du gabarit, non observée** : ne pas l'asserter, seul le seuil de
0,6 × hauteur page fait foi.

Pour chaque boîte :

```
chars  = [c pour c dans page.chars si IN_BOX(c, boîte)]
images = [i pour i dans page.images si IN_BOX(i, boîte)]
marks  = [e pour e dans emoji_de_la_page si boîte.top <= e.y_center <= boîte.top + boîte.height]

author     = FLOW(PICK(chars, 14.0, "SemiBold"))
date_label = FLOW(PICK(chars, 11.0, "Regular"))
body_chars = PICK(chars, 13.3, "Regular")
text       = FLOW(body_chars, marks)
lines      = LINES(body_chars, marks)

avatar   = image dont width ≈ 62.36 pt           (source 170×170 px)
collages = images dont width > 100 pt            (source ≈ 918×1322 ou 1751×926)
layout   = LAYOUT(body_chars, collages, boîte)
```

**La mise en page se déduit de la géométrie, jamais d'une largeur seuil**, sans
quoi un article pleine page est mal classé :

```
LAYOUT(body_chars, collages, boîte):
    si collages vide ou body_chars vide : retourner "text_right"
    gauche       = min(c.x0  pour c dans body_chars)
    haut         = min(c.top pour c dans body_chars)
    bord_droit   = max(i.x0  + i.width  pour i dans collages)
    bord_bas     = max(i.top + i.height pour i dans collages)
    si gauche >= bord_droit - 2 : retourner "text_right"     # texte à droite du collage
    si haut   >= bord_bas   - 2 : retourner "text_below"     # texte sous le collage
    # départage de repli
    retourner "text_right" si gauche >= boîte.x0 + boîte.width/2 sinon "text_below"
```

Contrôle de non-régression : sur le n° 42 cette règle reproduit exactement la
répartition 21 `text_right` / 7 `text_below` obtenue par la règle de largeur ;
sur le n° 43 elle donne 17 / 11.

**Résolution dynamique des tailles (recommandé).** La taille de corps `13.3` est
constante sur ce numéro mais Famileo peut l'ajuster pour les messages longs.
Implémentation robuste, à préférer au codage en dur :

> Dans une boîte, les chars se répartissent en exactement trois grappes de
> `(taille, style)`. L'auteur est **l'unique grappe `SemiBold`**. Parmi les
> grappes `Regular`, la date est celle dont les chars sont **immédiatement sous
> l'auteur** (même colonne, écart vertical < 20 pt) ; le corps est l'autre.

Garder `13.3 / 14.0 / 11.0` comme valeurs par défaut et comme assertion.

### 5.3 Quatrième de couverture

```
adresse = LINES(PICK(page.chars, 10.0, "Regular"))
          # x0 ≈ 283.5 ; adresse[0] = destinataire, le reste = lignes postales
```

Les événements sont portés par des tuiles carrées de 107.7 pt, sur la même
grille de colonnes que la couverture.

```
pour chaque rect r avec |r.width - 107.7| < 2 et |r.height - 107.7| < 2 :
    si NON r.fill : ignorer          # tuile-LIBELLÉ ("Le prochain anniversaire"),
                                     # tracée en contour seul (fill=false, stroke=true)
    kind = "birthday" si r.fill_color ≈ CYAN
           "nameday"  si r.fill_color ≈ NAVY
           sinon ignorer
    dédupliquer par (x0, top) : le gabarit empile plusieurs rects identiques

    chars  = chars dans la tuile
    name   = FLOW(PICK(chars, 11.0, "Bold"))         # 1 ou 2 mots, peut tenir sur 2 lignes
    detail = LINES(PICK(chars, 11.0, "SemiBold"))
    age        = entier de la ligne de detail matchant ^(\d+)\s*ans?\b
    date_label = ligne de detail matchant ^le\s
```

**C'est `fill` qui sépare une tuile de données d'une tuile de libellé, pas la
couleur** : les deux portent la même couleur dans l'état graphique.

Les vignettes photo de cette page sont sur les lignes `top = 297.6` et `422.4`
(cellules 107.7 pt, sources 437×437 px).

### 5.4 Datation des posts

Les posts ne portent **ni année ni mois normalisé** (`le 31 août`). La date de
couverture est la **borne supérieure** du numéro : un numéro agrège les posts
publiés depuis le précédent.

```
MONTHS = janvier..décembre   # comparaison en minuscules, accents dépouillés,
                             # point final retiré : "AOÛT"→8, "sept."→9

RESOLVE_YEARS(posts, cover_iso):
    année = année(cover_iso)
    borne = cover_iso
    pour chaque post en ordre INVERSE (du plus récent au plus ancien):
        (jour, mois) = parse("^le\s+(\d{1,2})\s+(.+)$", post.date_label)
        d = date(année, mois, jour)
        tant que d invalide ou d > borne:        # invalide = 29 février non bissextile
            année = année - 1
            d = date(année, mois, jour)
        post.date_iso = d
        borne = d
```

La remontée à l'envers gère le passage d'année (décembre → janvier) sans table
de cas particuliers, et la boucle `tant que` fait reculer jusqu'à une année
bissextile pour un 29 février.

Vérifié : n° 42 couvre `2026-08-17 → 2026-08-30` (couverture `2026-08-31`),
n° 43 couvre `2026-08-31 → 2026-09-13` (couverture `2026-09-14`, à cheval sur
deux mois). Les posts sont chronologiquement ordonnés dans les deux numéros.
Exposer `stats.chronological` plutôt que d'échouer si ce n'est plus le cas.

Les dates de la 4ᵉ de couverture (`le 5 oct.`) sont **à venir** : leur année est
celle de la couverture, ou l'année suivante si le jour est déjà passé. Cette
résolution est laissée à la couche appelante, le libellé brut étant conservé.

### 5.5 Avatars

L'avatar rond d'un post est **directement disponible**, sans aucune lecture de
pixels : c'est un XObject image autonome.

```
format        JPEG (DCTDecode), 170 × 170 px, DeviceRGB
SMask         aucun  -> pas de canal alpha
placement     carré de 62.362205 pt de côté
```

**L'image stockée est un carré plein, non rogné.** La rondeur est produite à
l'affichage par un tracé de découpe vectoriel, posé juste avant le placement :

```
q
  <m + 9 segments c>        # cercle approximé en Bézier
  W n                       # découpe non-zero, sans peinture
  q 62.362205 0 0 62.362205 <x> <y> cm /I15 Do Q
Q
```

Le cercle est **exactement inscrit** dans le carré de placement : centre = centre
du carré, rayon = 31.181 pt = 62.362205 / 2. Il est donc inutile de parser le
tracé : si un rendu circulaire est souhaité, générer le masque alpha à partir du
rectangle de placement. Sinon, exposer le carré tel quel, qui est ce que le PDF
contient réellement.

#### Clé d'identité des contributeurs

Propriété vérifiée sur les deux numéros :

- **un seul XObject par auteur**, partagé par tout le document — 10 avatars pour
  10 contributeurs au n° 42, 11 pour 11 au n° 43, correspondance 1:1 stricte ;
- **octets identiques d'un numéro à l'autre** : les 10 auteurs communs aux deux
  gazettes ont le même SHA-256.

Vecteur de test (avatar de Hugo Lienhart, présent dans les deux numéros) :

```
5538 octets
b4d49437d5f5d085ff27cd0ea31ad11e5b5131d05c56f78a80cd245468a932a1
```

Le SHA-256 de l'avatar est donc un **identifiant de contributeur stable**, plus
fiable que le nom affiché : celui-ci est saisi à la main et bruité (`ISA Gottar `
avec espace finale, casse incohérente entre `Denis W` et `Morgane GOTTAR`), et
rien n'empêche un contributeur de le changer. Pour toute agrégation
multi-numéros, indexer sur le hash et traiter le nom comme un alias.

Ces empreintes sont **des données propres à l'abonné, pas du gabarit** : elles
n'ont pas leur place dans un catalogue livré, contrairement à celui des emoji.
Chaque déploiement construit sa table au fil des numéros traités.

#### Piège : liste des ressources ≠ placements

TCPDF déclare tous les XObjects images dans un dictionnaire de ressources
partagé. Une énumération par page renvoie donc **chaque image sur chaque page** :

| | déclarés par l'énumération | placements réels |
| --- | --- | --- |
| collages | 800 | 50 |
| avatars | 160 | 28 |
| emoji | 336 | 26 |

81 XObjects images uniques, 104 placements, 1 296 déclarations. Un portage naïf
compte 160 avatars au lieu de 28 et attribue chaque emoji aux 16 pages.
**L'attribution à une page et à une boîte ne peut venir que des rectangles de
placement.**

*Note d'implémentation :* le parseur de référence n'expose aujourd'hui que
`avatar.src_px`. L'ajout d'un champ `avatar.sha256` et l'export des fichiers
sont une extension optionnelle, hors périmètre des goldens actuels.

---

## 6. Emoji — catalogue et appariement

### 6.1 Le problème

Famileo ne rend pas les emoji dans la couche texte : il les remplace par des
**images JPEG 64×64 issues du jeu Apple Color Emoji**, posées en absolu à
**12.37 pt** de côté. Un parseur texte pur les perd intégralement.

Un même emoji répété dans le document partage **un seul XObject**
(21 glyphes uniques pour 26 occurrences sur le n° 42) : **dédupliquer par
identifiant d'XObject avant tout calcul**.

### 6.2 Ce qui ne marche pas

Mesuré sur les visages jaunes réellement présents dans ce numéro :

| Méthode | Résultat |
| --- | --- |
| `aHash` 64 bits (N&B) | **collisions exactes** : `grinning` / `grin` / `smile` produisent le même hash, idem `kissing_closed_eyes` / `relaxed`. Or 😃 et 😄 coexistent dans le document. |
| `dHash` 64 bits (N&B) | distance minimale ≈ **5.9 bits / 64**, sous le seuil de tolérance usuel au bruit JPEG. Non fiable. |

La chrominance est indispensable. Toute solution en niveaux de gris est à
rejeter.

### 6.3 Étage 1 — SHA-256 du flux brut (voie rapide)

Les images intégrées sont les assets Apple eux-mêmes. Hacher les **octets non
décodés** de l'XObject donne une correspondance exacte en O(1), **sans aucune
bibliothèque d'image**.

Fichier : `catalog/emoji-sha256.json`

```json
{ "entries": { "<sha256 hex>": { "u": "1F602", "ext": "jpeg", "bytes": 6928 } } }
```

**Hypothèse validée sur le n° 43** : les trois emoji communs aux deux numéros
(😂 `1F602`, 🤭 `1F92D`, 😲 `1F632`) produisent la **même empreinte SHA-256** dans
les deux PDF. Famileo réémet donc des flux JPEG octet pour octet identiques d'un
numéro à l'autre, et l'étage 1 se suffit pour tout glyphe déjà rencontré.

Le catalogue fourni contient **32 empreintes** (21 du n° 42 + 14 du n° 43, dont
3 communes). Sur le n° 43 : 6 occurrences résolues par SHA-256 héritées du
n° 42, **15 par l'étage 2** — les deux étages sont donc chacun exercés par le
jeu de validation.

### 6.4 Étage 2 — descripteur couleur 8×8×3

Utilisé quand le SHA-256 est inconnu. Le descripteur est défini pour être
**bit-à-bit reproductible dans n'importe quel langage** : aucun filtre de
rééchantillonnage n'intervient, uniquement des moyennes de blocs entiers.

```
DESCRIPTOR(image):
    1. si l'image a un canal alpha : composer sur fond BLANC opaque (255,255,255)
    2. convertir en RGB 8 bits
    3. si la taille n'est pas 64×64 : redimensionner en 64×64 (filtre libre —
       cas hors gabarit, ne se produit pas sur les numéros observés)
    4. découper en 64 blocs de 8×8 pixels exacts (8 lignes × 8 colonnes)
    5. par bloc et par canal : moyenne arithmétique, arrondi au plus proche entier
    6. sortie : 192 octets, ordre ligne-majeur  for gy in 0..7 { for gx in 0..7 { R,G,B } }
```

Appariement :

```
MATCH(descriptor d, catalogue C):
    v  = center_and_normalize(d)              # v = d - mean(d) ; v = v / ||v||
    s  = argmax sur C de  dot(v, center_and_normalize(c))
    si  max(s) < 0.999 : retourner INCONNU    # seuil ABSOLU
    sinon retourner le codepoint associé
```

**Le critère est le seuil absolu, pas la marge avec le second candidat.** Les
images du PDF étant les assets de référence eux-mêmes, le bon candidat sort à
`sim ≥ 0.9999` tandis que la marge avec le second peut descendre à `0.0017`
(cas 😄 / 😃). Rejeter sur la marge produirait des faux négatifs ; accepter au
seuil absolu donne 21/21 sur ce numéro.

Un hit de l'étage 2 **doit** être réinjecté dans `emoji-sha256.json` pour
accélérer les numéros suivants.

### 6.5 Format du catalogue

```
catalog/emoji-catalog.bin    3949 × 192 octets, uint8, sans en-tête (741 Ko ; ~410 Ko gzip)
                             entrée i = octets [i*192 , (i+1)*192)
catalog/emoji-catalog.json   { version, descriptor:{grid:8,channels:3,bytes_per_entry:192,layout},
                               count, entries:[{u:"1F602", n:"joy"}, …] }
```

`entries[i]` décrit **exactement** la i-ème entrée du `.bin` : même ordre, même
cardinalité. `u` est la séquence de codepoints séparés par `-` (variantes de
teinte de peau incluses).

Conversion codepoints → chaîne :

```
CHAR("1F408-200D-2B1B") = concat(codepoint(c) pour c dans split("-"))   →  🐈‍⬛
```

Gérer les séquences ZWJ (`200D`) et les sélecteurs de variante (`FE0F`) comme
de simples codepoints à concaténer : `☀️` = `2600-FE0F`, `🐈‍⬛` = `1F408-200D-2B1B`.
Ne **pas** tenter de reconstruire l'emoji depuis un nom court.

### 6.6 Catalogue multi-jeux

Le catalogue indexe **trois jeux simultanément** — `apple`, `twitter` (Twemoji),
`google` (Noto) — et chaque entrée porte son jeu d'origine dans le champ `s`.
Famileo utilise aujourd'hui Apple ; si le fournisseur change, la résolution
continue sans modification de code et le champ `set` du résultat signale la
bascule.

Ce n'est pas gratuit en taille mais c'est **gratuit en risque** : sur les
14 glyphes du n° 43, l'écart entre le meilleur candidat Apple et le meilleur
candidat d'un autre jeu vaut au minimum **0,0593** — soit 35 fois la marge
intra-jeu la plus serrée (0,0017). Les jeux ne se confondent pas.

```
11 844 entrées = 3 946 apple + 3 949 twitter + 3 949 google
2 220 Ko brut, 1 138 Ko gzip
```

**Filtrer sur les drapeaux `has_img_<jeu>` de `emoji.json`**, et écarter toute
cellule de variance nulle : une case absente de la planche donne un descripteur
dégénéré qui pollue l'appariement. 3 glyphes n'ont pas d'image Apple.

Source : planches `sheet_<jeu>_64.png` du dépôt `iamcal/emoji-data`
(4158×4158, cellules de 66 px avec bordure de 1 px, glyphe utile
`crop(sx*66+1, sy*66+1, 64, 64)`), index `emoji.json` commun aux trois.

### 6.7 Collecte et réinjection

```
pour chaque page p, pour chaque image posée i :
    si i.src_width > 80 ou i.src_height > 80 : ignorer      # avatars = 170, collages ≥ 900
    résoudre une seule fois par XObject (cache)
    pour chaque rectangle de placement r de cet XObject sur p :
        émettre { page: p, x0: r.x0, y_center: (r.top + r.bottom)/2, char, unified, via }
```

La réinjection dans le texte se fait dans `LINES` (§5.0) : un emoji appartient à
la ligne dont la bande verticale `[top − 0.4·h , top + 1.4·h]` contient son
centre, et s'insère par tri sur l'abscisse. Résultat attendu sur le n° 42 :

```
p11  …je crois qu'il a été adopté 🤭 je te dis pas comme c'était difficile
     pour qu'elle se lève 😂 on dirait presque qu'elle imite Gribouille 🐈‍⬛
```

---

## 7. Ce qui n'est pas extractible

| Élément | Raison |
| --- | --- |
| Photos individuelles d'un post | collage pré-assemblé côté serveur en un seul JPEG — hors périmètre |
| Avatar **rond** | l'image stockée est carrée ; le cercle est une découpe vectorielle, reconstructible sans pixels (§5.5) |
| Année des posts, directement | absente du PDF ; déduite par remontée depuis la date de couverture (§5.4) — fiable tant que les posts restent ordonnés |
| Identité de l'expéditeur vs destinataire | seule l'adresse du destinataire figure (4ᵉ de couverture) |
| Logo Famileo, pictogrammes cœur / silhouette | tracés vectoriels, pas du texte ni des images |

---

## 8. Invariants à asserter

Échouer explicitement si l'un de ces contrôles casse — c'est le signal que le
gabarit Famileo a changé.

```
A1  page_size ≈ (595.276, 841.89) ± 1 pt
A2  producer commence par "TCPDF"
A3  pages >= 3
A4  chaque page de posts porte 1 ou 2 boîtes    ← PAS de contrainte sur le total
A5  toute boîte de post a width ≈ 504.57 (± 2 pt) et height > 100 pt ;
    les boîtes d'une page ne se chevauchent pas et tiennent dans la page
A6  tout post a author ≠ "" et date_label matchant ^le\s+\d{1,2}\s+\p{L}+\.?$
A7  tout post a exactement 1 avatar (src 170×170) et >= 1 collage
A8  les styles présents dans une boîte sont exactement {SemiBold, Regular}
A9  tout emoji accepté a sim >= 0.999
A10 back.recipient.name ≠ null et back.events non vide
A11 cover.issue_number est un entier et cover.client_code matche ^\d{6}$
A12 cover.date_iso est résolu, et tout post a date_iso <= cover.date_iso
```

**Ne pas asserter** : le nombre total de posts, `height ≈ 381.26`, la présence
d'une tuile « anniversaire », le nombre de vignettes. Tous varient entre les
deux numéros observés ou peuvent varier (article pleine page).

---

## 9. Jeu de validation

Deux numéros du même abonné, `tests/golden/gazette-42.json` et
`gazette-43.json`. Le gabarit est **rigoureusement identique** : mêmes boîtes
(`45.35 / 504.57 / 381.26`), mêmes tailles de police, mêmes couleurs.

| | n° 42 | n° 43 |
| --- | --- | --- |
| posts | 28 | 28 |
| contributeurs | 10 | 11 |
| emoji (occurrences / uniques) | 26 / 21 | 21 / 14 |
| mise en page | {'text_right': 21, 'text_below': 7} | {'text_right': 17, 'text_below': 11} |
| date de couverture | 2026-08-31 | 2026-09-14 |
| plage des posts | 2026-08-17 → 2026-08-30 | 2026-08-31 → 2026-09-13 |
| vignettes couverture / dos | 14 / 8 | 14 / 12 |
| événements au dos | 4 (1 anniversaire + 3 fêtes) | 3 (3 fêtes, **aucun anniversaire**) |

Ce que la comparaison des deux numéros apprend :

- **Le gabarit tient.** Aucune constante géométrique ni typographique n'a bougé.
- **La 4ᵉ de couverture varie.** Le n° 43 n'a **pas** de tuile anniversaire et
  porte 12 vignettes au lieu de 8. Un parseur qui suppose une tuile
  « anniversaire » ou un nombre fixe de vignettes casse.
- **Les flux JPEG des emoji sont stables d'un numéro à l'autre** (§6.3).
- **Un numéro peut chevaucher deux mois** (n° 43 : août → septembre), ce qui
  rend la datation §5.4 obligatoire et non cosmétique.

Cas limites couverts par le jeu de validation :

| Cas | Où |
| --- | --- |
| Mise en page `text_below` (auteur sous le collage) | 7 posts au n° 42, 11 au n° 43 |
| Séquence ZWJ 3 codepoints `🐈‍⬛` | n° 42 p11 |
| Sélecteur de variante `☀️` `☠️` | n° 42 p12, n° 43 p9 |
| **Modificateur de teinte de peau** `👩🏼‍🍳` (`1F469-1F3FC-200D-1F373`) | n° 43 p13 |
| Glyphe Unicode 15 `🪮` | n° 42 p7 |
| `😃` et `😄` dans le même document | n° 42 p13 / p15 |
| 5 emoji consécutifs dans une phrase | n° 43 p9 (`🦴🦴 ☠️🦴🦴`) |
| Symbole présent, lui, dans la couche texte (`➘`) | n° 43 p5 |
| Texte en alsacien, apostrophes mixtes | n° 42 p10 |
| Guillemets doublés `''juste''`, mot coupé `appui-tête` | n° 43 p3 |
| Emoji collé au texte sans espace | n° 42 p9, n° 43 p15 |
| 4ᵉ de couverture sans anniversaire | n° 43 |

---

## 10. Contrat de test

```
tests/checks.json          assertions et cas unitaires, indépendants du langage
tests/golden/gazette-42.json
tests/golden/gazette-43.json   sorties attendues, à reproduire à l'identique
tests/run_golden.py            runner de référence
```

Une implémentation est conforme si :

1. elle produit un JSON **strictement égal** aux goldens, à l'exception du champ
   `emoji[].via` qui reflète l'état du cache SHA-256 et non le parsing ;
2. elle passe les cas `unit` de `checks.json` :
   - `month_number` : libellés français accentués, capitales, abréviations ;
   - `codepoints` : ZWJ, sélecteurs de variante, modificateurs de teinte ;
   - `year_rollover` : bascule décembre → janvier, bascule août → septembre,
     29 février ;
   - `layout` : quatre cas dont **deux articles pleine page**, qui ne figurent
     dans aucun des deux numéros disponibles et ne sont donc testés que par
     géométrie synthétique ;
   - `emoji_threshold` : seuil absolu strictement inférieur au plus bas vrai
     positif observé (0,99987).

Le runner de référence rapporte **46 contrôles, 0 échec** sur ces deux numéros.
