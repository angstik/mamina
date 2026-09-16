# mamina

Prototype minimal : envoyer une image et une légende dans un groupe Telegram depuis Safari/iPhone, sans backend.

## Déploiement GitHub Pages

1. Déposer à la racine de la branche `main` : `index.html`, `.nojekyll`, `README.md`.
2. GitHub → **Settings** → **Pages**.
3. **Build and deployment** → **Deploy from a branch**.
4. Branch : **main** ; folder : **/(root)**.
5. Sauvegarder.

L’URL sera normalement de la forme :

`https://<username>.github.io/mamina/`

## Configuration Telegram

1. Créer un bot avec `@BotFather` via `/newbot`.
2. Ajouter le bot au groupe Telegram privé de test.
3. Envoyer dans le groupe `/test@NomDuBot`.
4. Ouvrir la page Mamina.
5. Saisir le token puis **Tester le token**.
6. **Détecter les groupes récents**.
7. Sélectionner / mémoriser le groupe.
8. Choisir une image, saisir une légende puis envoyer.

## Token

Le token n’est jamais enregistré par la page. Pour iOS Passwords / Safari AutoFill, créer une entrée liée au domaine GitHub Pages :

- utilisateur : `telegram-bot`
- mot de passe : le token BotFather

Le `chat_id` peut être conservé dans `localStorage`.

## Étape suivante

Une fois ce test validé : activation du mode Forum, création automatique de topics, puis traitement du PDF Famileo.
