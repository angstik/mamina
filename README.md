# Mamina — prototype simple Telegram

Fonctions :
- credentials Telegram App dans `src/config.js`
- login utilisateur + session IndexedDB
- liste des dialogs + dernier dialog mémorisé
- publication texte seul, photo seule, photo + texte
- progression d'upload
- synchro incrémentale par `last_message_id` et par dialog
- affichage simple des nouveaux messages
- détection des réponses via `getReplyTo()` avec affichage du parent

## Configuration

Remplacer dans `src/config.js` :

```js
export const TELEGRAM_CONFIG = {
  apiId: 12345678,
  apiHash: '...',
}
```

## Déploiement

GitHub → Settings → Pages → Source = GitHub Actions.

## Limite volontaire du prototype

La synchro suit les nouveaux messages. Elle ne détecte pas encore les éditions,
suppressions ou changements de réactions sur d'anciens messages.
