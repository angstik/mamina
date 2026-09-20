# SPEC_v1_CG — Parsing d'une gazette Famileo (PDF → JSON)

Version CG consolidée pour MamiNa. Cette spécification reprend le contrat vérifié sur les n°42 et n°43 et ajoute les clarifications nécessaires à une implémentation déterministe, portable et exploitable par la PWA.

## 0. Principes impératifs

1. Ne jamais reconstruire un post depuis l'ordre du flux de contenu PDF. Utiliser géométrie + styles.
2. Ne jamais utiliser d'OCR : la couche texte est la source de vérité, sauf emoji qui sont des images.
3. Compter les boîtes de posts ; ne jamais supposer deux posts par page.
4. Ne jamais segmenter un collage photo : le JPEG préassemblé est l'unité exposée.
5. Comparer les styles de police par égalité exacte (`Regular`, `SemiBold`, `Bold`, `Light`).
6. Échouer explicitement dès qu'un invariant A1…A12 casse.
7. Les emoji sont des placements d'images, réinjectés ensuite dans les lignes de texte.
8. Attribuer les images uniquement depuis leurs placements réels, jamais depuis la liste globale de ressources.
9. Toutes les collections de sortie ont un ordre déterministe défini ci-dessous.
10. Le parseur maître produit un JSON une seule fois. Les clients lecteurs consomment ce JSON ; ils ne reparsent pas le PDF pour comprendre la revue.

## 1. Capacités PDF requises

Le moteur doit fournir : texte positionné (Unicode, bbox, police, taille, couleur, rotation), rectangles vectoriels (bbox, fill/stroke séparés et couleurs), placements d'images (bbox, dimensions source), flux brut de l'XObject image, identifiant stable de l'XObject.

Coordonnées normalisées par la spec : origine haut-gauche, `top` croissant vers le bas, unités en points PDF.

Le parseur MamiNa peut combiner PDF.js pour le texte/rendu et un index bas niveau des objets TCPDF pour rectangles, placements et flux image brut.

## 2. Identité du document

- Producer attendu : `TCPDF 6.x`.
- A4 : `595.276 × 841.89 pt`, rotation 0.
- Pages : variable, au minimum 3.
- Polices utilisées : `NotoSans-{Light,Regular,SemiBold,Bold}` ; `OpenSans` pour le code client pivoté.
- Couleurs de référence avec tolérance 0,02 par canal :
  - NAVY `#316286` = `(0.192157, 0.384314, 0.525490)`
  - CYAN `#6EBED9` = `(0.431373, 0.745098, 0.850980)`

## 3. Taxonomie des pages

- page 1 : couverture ;
- pages 2…N−1 : pages de posts, détectées par au moins un rectangle `width > 400 pt && height > 100 pt` ;
- page N : quatrième de couverture.

Ne jamais coder `N=16` en dur.

## 4. Modèle JSON de référence

Le JSON de référence reste strictement compatible avec `tests/golden/gazette-42.json` et `gazette-43.json` : `source`, `cover`, `posts`, `back`, `stats` avec les champs décrits dans la spec d'origine.

### Ordre déterministe ajouté par v1_CG

- `posts` : `page` croissante, puis `box.top` croissant ;
- `post.emoji` : ordre d'apparition dans `post.text`, doublons conservés ;
- `cover.thumbnails` : `row` puis `col` croissants ; `row` est 0-based sur la grille logique Famileo (0,1,4,5 observés) ;
- `back.thumbnails` : ordre top puis x croissants ;
- `back.events` : ordre top puis x des tuiles ;
- `stats.contributors` : auteurs exacts, trim uniquement pour la déduplication, tri Unicode/locale stable ; aucune normalisation de casse ou d'orthographe.

### Enveloppe MamiNa

Le fichier publié dans le topic magazine peut être une enveloppe :

```json
{
  "schema": "mamina-gazette-v1",
  "spec": "SPEC_v1_CG",
  "gazette": { "...": "JSON golden-compatible" },
  "geometry": {
    "<page>:<slot>": {
      "avatar_box_pt": [x0, top, width, height],
      "body_box_pt": [x0, top, width, height]
    }
  }
}
```

`gazette` seul est soumis à l'égalité stricte des goldens. `geometry` est un sidecar d'affichage MamiNa, destiné au crop exact de l'avatar et aux zones de zoom/copie.

## 5. Primitives

### STYLE

Préfixe de sous-ensemble (`AAAA+`) retiré, puis partie après le premier `-`. Comparaison exacte.

### IN_BOX

Un objet est dans une boîte si sa bbox tient dans la boîte avec `pad=2 pt`.

### LINES — clarification CG

Le regroupement par ligne ne doit pas utiliser `round(top)` strict. Utiliser un clustering vertical avec une tolérance maximale de 1 pt (ou une tolérance proportionnelle à la taille de police équivalente).

Les éléments d'une ligne sont triés par `x0` et concaténés sans modifier leur contenu Unicode.

Un emoji ne peut être affecté qu'à **une seule** ligne. Parmi les lignes dont la bande `[top−0,4h ; top+1,4h]` contient le centre de l'emoji, choisir celle dont le centre vertical est le plus proche. Cette règle supprime les doubles injections possibles entre deux lignes adjacentes et reproduit exactement les goldens 42/43.

### Espaces

Conserver les espaces présents dans les fragments de texte PDF. Ne pas inventer d'espace par seuil horizontal entre deux fragments. `text` est produit en joignant `lines` par un espace puis en compactant tous les espaces consécutifs et en trimant.

## 6. Couverture

Grille 4 colonnes, cellules 107,7 pt ; colonnes observées `56.7, 181.4, 306.1, 430.9`, lignes `62.4, 187.1, 547.0, 671.7`.

- date : 13 pt Regular ;
- titre : 17 pt Light ;
- numéro : 25 pt Regular ;
- code client : OpenSans pivoté, chiffres uniquement, ordre géométrique adapté à la rotation.

Les tailles sont complétées par un contrôle spatial : date et numéro doivent appartenir à des cellules de la grille ; le titre doit se situer dans la zone centrale du logo/sous-titre. Les vignettes sont les placements 437×437 px dans les cellules photo.

`MONTH_NUMBER` fait partie du parseur (et non d'une couche externe) afin que `cover.date_iso` soit déterministe. Accents et point final d'abréviation sont ignorés pour la comparaison du mois, sans modifier `date_label`.

## 7. Pages de posts

Boîtes : rectangles réels `width>400 && height>100`, triés par `top`.

Slot :
- `full` si `height > 0,6 × page_height` ;
- sinon `top` si le centre de la boîte est au-dessus du milieu de page ;
- sinon `bottom`.

Cette règle remplace l'ancienne hypothèse « une seule boîte = top ».

Dans chaque boîte :
- auteur = grappe `SemiBold` ;
- date = grappe `Regular` immédiatement sous l'auteur, même colonne, écart vertical < 20 pt ;
- corps = autre grappe `Regular` ;
- valeurs 14 / 11 / 13,3 pt conservées comme defaults/assertions de régression mais l'identification dynamique par grappes est prioritaire.

Avatar : placement image source 170×170 px, carré d'environ 62,36 pt.
Collages : placements image >100 pt de largeur, sources photo haute résolution. Un post doit avoir exactement un avatar et au moins un collage dans le gabarit actuel.

Layout : comparaison géométrique texte/collage (`text_right` ou `text_below`), jamais seuil de largeur seul.

## 8. Quatrième de couverture

Adresse : texte 10 pt Regular **dans le cluster géométrique droit** (`x0 > 250 pt` pour le gabarit observé), regroupé par lignes. Première ligne = destinataire.

Événements : tuiles 107,7×107,7 pt remplies ; `fill=true` est obligatoire. CYAN = birthday, NAVY = nameday. Dédupliquer les rectangles par `(x0,top)`. Nom 11 pt Bold ; détails 11 pt SemiBold.

## 9. Datation

La date de couverture est borne haute. Parcourir les posts à rebours, avec année initiale de la couverture ; pour chaque `le JJ mois`, reculer l'année tant que la date est invalide ou supérieure à la borne précédente. Ceci couvre changement d'année et 29 février.

`stats.chronological = true` si la séquence `date_iso` des posts dans l'ordre de sortie est non décroissante ; dates identiques autorisées. Ne pas échouer si elle est fausse.

## 10. Avatars et contributeurs

Le flux brut JPEG de l'avatar peut être SHA-256 afin d'obtenir un identifiant stable inter-numéros. Ce hash est une donnée propre à l'abonné et n'est pas inclus dans le catalogue global. L'enveloppe MamiNa peut le conserver localement comme clé de contributeur ; `gazette.stats.contributors` reste basé sur le nom affiché pour compatibilité golden.

## 11. Emoji

### Candidats

Un candidat emoji doit satisfaire simultanément :
- source ≤80×80 px ;
- placement voisin de 12,37 pt de côté (tolérance 2 pt) ;
- placement dans une boîte de post.

### Étage 1

SHA-256 des **octets du payload de stream image avant décodage des filtres**. Ne pas hacher l'objet PDF complet ni les pixels décodés.

### Étage 2

Descripteur RGB 8×8×3, 192 octets. Calcul du cosinus en float64. Cas norme nulle = erreur. Acceptation si et seulement si `sim >= 0.999`.

Le catalogue lourd est réservé au master. Il n'est pas inclus dans le chemin de lecture normal de la PWA.

## 12. Architecture Telegram dynamique

Un groupe contient :
- un topic par numéro de gazette ;
- topic réservé `params`, lu par tous ;
- topic réservé `catalog`, lu uniquement par le master lorsqu'un parsing le nécessite.

### `params`

Un message canonique mutable porte `kind=mamina-params`. Au premier accès, le client découvre `params` et mémorise `message_id`; ensuite il relit directement ce message avec `getMessages(chat,messageId)` sans scanner l'historique.

Exemple :

```json
{
  "kind":"mamina-params",
  "version":1,
  "parser":{"spec":"SPEC_v1_CG","emojiSet":"apple","emojiThreshold":0.999},
  "catalog":{"topicId":123,"manifestMessageId":456}
}
```

### `catalog`

Le manifeste canonique `kind=mamina-catalog-manifest` référence par ID les messages-fichiers : `emoji-sha256.json`, `emoji-catalog.json`, `emoji-catalog.bin`. Le master récupère ces messages directement par ID seulement lorsqu'il doit parser un PDF. Les lecteurs ordinaires ne téléchargent jamais ces fichiers.

### Topic magazine

Le master publie :
1. le PDF original (`kind=pdf`) ;
2. le JSON parsé/enveloppe (`kind=parse`, `schema=mamina-gazette-v1`).

Les clients lecteurs privilégient `kind=parse` et ne reparsent plus le PDF. Le PDF reste nécessaire au rendu fidèle/caches image, pas à l'extraction sémantique.

## 13. Invariants A1…A12

A1 taille A4 ±1 pt ; A2 producer TCPDF ; A3 pages≥3 ; A4 1 ou 2 boîtes par page posts ; A5 width≈504,57±2 et boîtes valides/non chevauchantes ; A6 auteur non vide + date regex ; A7 exactement 1 avatar + ≥1 collage ; A8 styles post exactement SemiBold+Regular ; A9 emoji accepté sim≥0,999 ; A10 destinataire non nul + événements non vides ; A11 numéro entier + client_code 6 chiffres ; A12 cover.date_iso et dates posts≤couverture.

Les erreurs doivent être structurées sous forme `A7_MEDIA:p12`, `A9_EMOJI_UNKNOWN:<sha>`, etc., pour être affichables dans la trace master.

A7/A8 sont des invariants de **gabarit actuellement connu** : leur échec signifie « gabarit Famileo modifié », pas « PDF corrompu ».

## 14. Tests

Contrat : `parse pdf/tests/checks.json`, `golden/gazette-42.json`, `golden/gazette-43.json`.

Les deux fixtures de référence sont incluses dans `tests/fixtures/` pour les tests de développement mais ne sont pas servies par Vite et ne font donc pas partie du poids de la PWA déployée.

Conformité : JSON `gazette` strictement égal aux goldens (sauf `emoji[].via`) + tests unitaires de `checks.json`. Les ressources lourdes du catalogue sont dans `parse pdf/catalog-publish/` et ne sont pas dans `public/`.
