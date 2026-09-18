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
