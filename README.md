# Mamina V3 — Bot API + lecture MTProto

La V3 conserve le générateur Bot API et ajoute une lecture comme utilisateur via MTProto.

## Test de rattachement des discussions

Dans un sujet Forum, plusieurs publications racines peuvent exister. Les commentaires sont rattachés en remontant `reply_to_msg_id` jusqu'à la racine. `reply_to_top_id` sert surtout à identifier le thread/topic Telegram.

Le lecteur affiche :
- `msg X` : message courant ;
- `reply→Y` : parent immédiat ;
- `topic Z` : sujet Telegram ;
- `file→R` : racine calculée de la discussion.

Le générateur crée aussi des messages additionnels qui alternent : réponse directe à la racine / réponse au commentaire précédent. Cela permet de tester la remontée d'ancêtres.

## Préparation MTProto

Sur `my.telegram.org` → API development tools, créer une application et récupérer `api_id` et `api_hash`.

Le prototype charge GramJS depuis `esm.sh`, pour éviter un build. Une version durable devra embarquer la dépendance dans le repo.

## Sécurité

La StringSession utilisateur est sensible. Le bouton de sauvegarde la met en `localStorage` uniquement pour ce prototype. Ne jamais publier `api_hash`, session ou token dans Git.

## Test conseillé

1. Créer 1 à 3 sujets de test.
2. Ajouter 4 messages additionnels dans l'un d'eux.
3. Se connecter via MTProto.
4. Utiliser le même groupe.
5. Lire les 20 derniers messages.
6. Vérifier que les commentaires aboutissent à la même valeur `file→...` que leur publication racine.

## GitHub Pages

Déployer `index.html` et `.nojekyll` à la racine de `main`.
