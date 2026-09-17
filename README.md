# Mamina — prototype complet

Fonctions :
- config Telegram App dans `src/config.js`
- session mtcute en IndexedDB
- sélection du dialog
- création d’un sujet mensuel
- envoi texte, image ou PDF
- limite d’upload lue dynamiquement depuis Telegram
- publication dans le sujet sélectionné
- réponse à un message synchronisé
- synchronisation incrémentale
- cache cumulatif IndexedDB par dialog
- vidage du cache local

## Configuration
Remplacer `apiId` et `apiHash` dans `src/config.js`.

## Déploiement
GitHub Pages → Source = GitHub Actions.

## Notes
La création de sujet demande le droit Telegram `manageTopics`.
La limite d’upload est dérivée de `upload_max_fileparts_default/premium × 524288`.
Les éditions/suppressions/réactions d’anciens messages ne sont pas encore resynchronisées.
