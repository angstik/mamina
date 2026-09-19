# Mamina — V0 utilisateurs + master

Cette version sépare les deux applications :

- `/index.html` : application utilisateurs V0 ;
- `/master.html` : application admin de publication PDF ;
- `/secret-tool.html` : génération du secret Telegram chiffré.

Il n'y a **pas de `config.js`**. Le déploiement doit conserver `public/telegram-secret.json`
créé séparément avec l'outil de secrets.

## Backend utilisateur

La logique est dans `src/backend/` :

- `crypto.js` : PBKDF2 + AES-GCM ;
- `telegram.js` : accès mtcute, sujets, messages, publication, updates Telegram ;
- `pdf.js` : parsing/rendu Famileo avec contournement Safari PDF.js ;
- `protocol.js` : protocole MAMINA, `h | b | p`, racines lazy ;
- `user-storage.js` : IndexedDB spécifique à la V0 utilisateur ;
- `user-service.js` : synchronisation et modèle métier utilisateur.

Le frontend V0 est dans `src/user/` et reste volontairement minimal.

## Synchronisation

- synchro complète au démarrage après authentification ;
- `catchUp: true` sur mtcute pour les updates manquées ;
- réaction aux nouveaux messages Telegram avec debounce ;
- resynchronisation de sécurité toutes les 30 secondes.

## Cache

- 10 dernières revues : couverture + métadonnées + compteurs total/non lus ;
- 2 dernières revues : PDF, articles et réactions en cache complet ;
- état lu/non lu local à l'appareil via `lastReadMessageId` par article.

## Messages V0

`kind=message`, `type=text`, `format=mamina-markdown-v1`.

Syntaxe affichée :

- `**gras**`
- `__souligné__`
- `~~barré~~`
- `[color=#RRGGBB]texte[/color]`

Les types `img`, `icon`, etc. restent réservés pour les versions suivantes.

## Build GitHub Pages

Vite est configuré en multi-page afin de générer `index.html`, `master.html` et
`secret-tool.html` dans `dist/`.

## V0.1 — diagnostic et reprise de connexion

- Erreurs de synchronisation affichées avec leur message réel.
- Journaux techniques persistants dans Réglages, copiables/effaçables.
- État réseau et état de connexion mtcute visibles.
- Option de logs mtcute détaillés (niveau 4, appliquée au prochain démarrage).
- Reprise de connexion + synchro au retour réseau, focus, pageshow et retour au premier plan.
- Polling de sécurité 30 s uniquement lorsque la PWA est visible et en ligne.


## Correctif v0.2

- Ajout de `FamileoPdf.renderCover()`, requis par l'application utilisateur.
- Diagnostic détaillé après analyse PDF : métadonnées, nombre d'articles, rendu et stockage de la couverture.
- Les valeurs lancées `null`/`undefined` sont maintenant représentées explicitement dans les logs.


## v0.3 — diagnostic PDF renforcé

- instrumentation de chaque sous-étape de `FamileoPdf.load()`;
- trace page par page;
- erreurs `null` / non-`Error` PDF.js encapsulées dans une vraie `Error`;
- chemin d'extraction texte Safari sans spread ni `for...of`;
- suppression du doublon `renderCover()` introduit en v0.2.


## v0.4 — stockage binaire Safari

- plus aucun `Blob` n'est écrit directement dans IndexedDB ;
- les images sont persistées comme `Uint8Array + MIME` puis reconstruites en `Blob` à la lecture ;
- PDF et autres octets sont stockés comme `Uint8Array` ;
- les erreurs `IDBRequest.error` sont capturées avant `transaction.error`, qui peut être `null` dans Safari.


## v0.5 — local-first + lecteur

- rendu de la liste et navigation depuis IndexedDB avant toute connexion Telegram ;
- Telegram se synchronise en arrière-plan et ne bloque plus l'affichage ;
- reprise/reconnexion sur focus, pageshow, visibilitychange, online + watchdog ;
- pastille connexion : vert connecté, sinon ancienneté depuis la dernière connexion, rouge après 9 h ;
- en-tête lecteur : nom d'application, date jour/mois, ordre des articles, connexion ;
- ordre d'articles : revue ou activité (non lus récents, lus récents, puis ordre revue) ;
- le changement d'ordre conserve l'article affiché ;
- éditeur contenteditable riche : gras, souligné, barré, couleur sans balises visibles ;
- palette couleur remplace temporairement la barre de formatage ;
- saisie fixée au-dessus du clavier ; le lecteur reste manipulable derrière mais le swipe horizontal est bloqué pendant l'édition ;
- `master.html` contient un paramètre de nom d'application (défaut `MamiNa`) ; il est embarqué dans les métadonnées des prochaines revues.


## v0.6

- en-tête compact sans superposition ;
- reconnexion uniquement via la pastille d'état, clignotante et non cliquable pendant la reconnexion ;
- compteur de commentaires en attente à gauche de la pastille ;
- file d'attente IndexedDB, maximum un commentaire texte par article ;
- flush automatique à la reconnexion ;
- page Paramètres intégrée : thème clair/sombre/système, explications, diagnostic et administration ;
- `/master.html` redirige vers le volet Administration de la même application ;
- saisie Telegram via formulaire `type=tel autocomplete=tel` et code `autocomplete=one-time-code` ;
- éditeur riche sans balises visibles, états actifs G/S/B, palette temporaire, boutons emoji ;
- palette couleur ne ferme pas le clavier pour les couleurs rapides ;
- éditeur compact 1 à 3 lignes, fixé juste au-dessus du clavier ;
- zoom/pan tactile de l'image article pendant la saisie, sans transformer la zone de saisie.


## v0.7

Voir `CHANGELOG.md`.

Points techniques principaux :
- ouverture locale d’une revue sans reparsing PDF systématique ;
- PDF.js chargé à la demande uniquement pour une image absente du cache ;
- préchauffage prédictif des articles courant ±2 ;
- article enrichi avec `articleText` et `textBounds` pour le double-tap photo/texte ;
- commentaire outbox rééditable avant envoi ;
- icônes PWA/iOS 192 et 512.


## v0.8

Voir `CHANGELOG.md`.

Points techniques :
- `apple-touch-icon` 180×180 versionné ;
- normalisation téléphone France vers `+33` ;
- profil utilisateur Telegram mis en cache localement ;
- ligne d’activité métier indépendante des logs ;
- reconnexion + vidage outbox avant synchronisation ;
- vue texte enrichie auteur/date/avatar et copie détectable ;
- italique + surlignage local des collages provenant d’un article ;
- zoom/pan borné, inertiel et persistant par article ;
- éditeur ancré sur `visualViewport` et sélection restaurée pour les commandes riches.


## v0.9

Voir `CHANGELOG.md`. Cette version est dédiée à la stabilité iOS, à la mémoire canvas/PDF.js et à la robustesse de l’éditeur.


## v0.9.1

Voir `CHANGELOG.md`.

Passes de vérification :
1. syntaxe de tous les fichiers JavaScript ;
2. vérification de toutes les références DOM ;
3. assertions ciblées sur navigation Message, toolbar, badge activité, collage et sérialisation mémoire ;
4. contrôle des identifiants HTML dupliqués.


## v0.9.2

Voir `CHANGELOG.md`.

Vérifications spécifiques :
- chemin sélection de texte inchangé pour G/I/S/B et couleur ;
- chemin caret vide testé séparément via `typingState` + `typing-carrier` ;
- persistance immédiate du message retourné par Telegram après flush outbox ;
- relecture locale de la revue ouverte après synchronisation ;
- conservation de l'article courant lors du changement Revue/Récent.


## v1.0.0

Finition cosmétique finale sans modification du backend ni du protocole :
- splash plus long ;
- grande icône MamiNa sur la vue Magazines ;
- icône MamiNa pour les boutons retour ;
- pastille multicolore animée.
