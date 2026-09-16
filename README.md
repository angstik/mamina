# Mamina — prototype mtcute

Prototype isolé pour valider `@mtcute/web` sur Safari iOS avant de le réintégrer à Mamina.

## Ce qu'il teste

- connexion Telegram utilisateur avec `api_id` + `api_hash` ;
- stockage de session dans IndexedDB via `@mtcute/web` ;
- lecture des 20 derniers messages d'un groupe avec `getHistory()` ;
- récupération du message parent avec `getReplyTo()` ;
- remontée récursive jusqu'à la racine de la discussion ;
- regroupement visuel par racine.

`getReplyTo()` est volontairement utilisé plutôt que de dépendre d'un nom de champ interne :
il permet aussi de récupérer un parent plus ancien que la fenêtre des 20 messages.

## Déploiement GitHub Pages

Le repo utilise maintenant GitHub Actions pour construire Vite.

Dans GitHub :

1. pousser ces fichiers sur `main`;
2. Settings → Pages;
3. Source / Build and deployment : **GitHub Actions**.

Le workflow `.github/workflows/pages.yml` installe les dépendances, lance `vite build` puis publie `dist/`.

## Test

1. Ouvrir la page.
2. Entrer `api_id` et `api_hash`.
3. Connexion Telegram.
4. Entrer l'ID du groupe, par exemple `-100...`.
5. Lire les 20 derniers messages.
6. Vérifier les regroupements `racine`.

La session Telegram utilisateur est sensible. Ce prototype la laisse dans l'IndexedDB du navigateur,
ce qui évite `localStorage`, mais ce n'est pas encore le modèle de sécurité final.

## Développement local

```bash
npm install
npm run dev
```

## Version mtcute

Le prototype épingle `@mtcute/web` à `0.32.1`, version correspondant à la documentation utilisée.


## Correctif GitHub Actions
Le cache npm a été retiré du workflow pour ne pas exiger de `package-lock.json` dans ce prototype.


## Correctif peer / access hash

Un ID `-100...` ne suffit pas toujours à MTProto lors du premier accès.
Cette version appelle d'abord :

```js
const [dialog] = await client.findDialogs(chatId)
```

puis utilise :

```js
await client.getHistory(dialog.peer, { limit: 20 })
```

`findDialogs` parcourt les dialogs de l'utilisateur et permet à mtcute de récupérer / mettre en cache
l'`access_hash` du groupe.


## Diagnostic des dialogs

Cette version ajoute **Lister les dialogs visibles**.

Elle affiche pour chaque dialog :
- titre ;
- ID mtcute ;
- type de peer ;
- username éventuel.

Le but est de vérifier exactement quel ID mtcute associe au groupe familial avant d'appeler `findDialogs()` / `getHistory()`.
