# Mamina — core v1

Objectif de cette étape : **backend propre, front volontairement minimal**.

## Séparation

`src/backend/`
- `crypto.js` : PBKDF2-SHA256 + AES-256-GCM, aucun secret en clair persisté.
- `telegram.js` : toute la couche mtcute/Telegram.
- `protocol.js` : protocole MAMINA, article keys, typage `kind/type`, canonicalisation lazy des roots.
- `pdf.js` : parsing Famileo via PDF.js, SHA-256, magazineId, détection `h/b/p`, rendu/crop des articles.
- `storage.js` : cache IndexedDB cumulatif messages + PDF + curseurs.
- `service.js` : orchestration métier, sans DOM de présentation.

`src/frontend/`
- `app.js` + `styles.css` : UI minimale de test.

## Secrets — pas de config.js

Aucun `config.js` n'est fourni.

1. Lance le projet (`npm install && npm run dev`).
2. Ouvre `/secret-tool.html`.
3. Entre `apiId`, `apiHash` et le mot de passe partagé.
4. Le navigateur télécharge `telegram-secret.json`.
5. Place ce fichier dans `public/telegram-secret.json`.

Le fichier contient uniquement un blob AES-GCM chiffré. La clé AES est dérivée du mot de passe avec PBKDF2-SHA256, sel aléatoire 128 bits, 600000 itérations. Le mot de passe n'est pas stocké.

## Protocole

### Slots article
- `h` : demi-page haute
- `b` : demi-page basse
- `p` : page entière

`articleKey = <magazineId>:p<NN>:<h|b|p>`

### Métadonnées Telegram
Les messages machine terminent par une ligne `MAMINA::<base64url(JSON)>`.

`kind` :
- `pdf`
- `root`
- `message`

`type` pour `kind=message` :
- `text`
- `img`
- extensible ensuite (`icon`, etc.)

### Lazy init des files
Au premier commentaire d'un article :
1. resynchronisation du sujet ;
2. recherche d'une racine `kind=root` pour `articleKey` ;
3. création si absente ;
4. nouvelle lecture ;
5. si plusieurs racines existent, **la plus petite `message_id` est canonique** ;
6. le commentaire est publié en réponse à cette racine.

## PDF

Le PDF est publié une seule fois dans le sujet. Chaque client :
- retrouve le message `kind=pdf` ;
- télécharge le PDF si absent du cache local ;
- vérifie son SHA-256 ;
- le parse avec PDF.js ;
- construit les articles ;
- rend chaque article localement en canvas.

La détection `h/b/p` utilise actuellement la position verticale des lignes de date `le <jour> ...` dans le PDF Famileo. Si deux zones contiennent une date : `h+b`, sinon `p`. Ce point est isolé dans `pdf.js` pour pouvoir être amélioré sans toucher Telegram.

## Telegram

- sujets existants : `iterForumTopics()` ;
- lecture d'un sujet précis : `iterSearchMessages({ chatId, threadId })` ;
- création sujet : `createForumTopic()` ;
- publication : `sendText()` / `sendMedia()` avec `threadId` et `replyTo`.

## Déploiement GitHub Pages

Settings → Pages → Source = **GitHub Actions**.

Le workflow est inclus.


## v1.1 — correctifs

- Upload PDF navigateur : le `File` est converti en `Uint8Array` avant `InputMedia.document`, afin d'éviter le chemin `File.stream()` problématique sur certains Safari/iOS.
- La liste des dialogs distingue maintenant les **Groupes avec sujets** (`peer.isForum`) des autres dialogues.

## v1.2 — diagnostic publication PDF

La publication admin est maintenant découpée en étapes explicitement tracées : analyse PDF, création du sujet, préparation du média, upload Telegram, envoi dans le sujet, résolution du sujet et cache local.

L'upload et l'envoi sont séparés : `uploadMedia()` reçoit le `File` natif du navigateur, puis `sendMedia()` reçoit `uploaded.inputMedia`. Le front affiche le stack complet si une étape échoue.

La liste des dialogs sépare visuellement les forums (`isForum`) des autres conversations.

## v1.3

PDF.js utilise explicitement le build `legacy` et le worker `legacy`, pour compatibilité Safari/iOS.


## v1.4 — correctif Safari getTextContent

PDF.js 6.x appelle en interne `for await...of` dans `getTextContent()`.
Certaines versions de Safari fournissent `ReadableStream.getReader()` mais pas
l'itérateur asynchrone attendu. La v1.4 contourne ce bug en consommant
`page.streamTextContent()` explicitement via `getReader()` et en reconstruisant
le même objet `{items, styles, lang}`.

Aucun changement Telegram dans cette version.
