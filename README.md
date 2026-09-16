# Mamina V3.2

Correction MTProto: un seul bundle GramJS est chargé.

La V3/V3.1 chargeait TelegramClient et StringSession depuis des graphes de modules différents,
ce qui cassait le test `instanceof Session` de GramJS.

V3.2 fait :

```js
const gram = await import('https://esm.sh/telegram@2.26.10?bundle');
TelegramClient = gram.TelegramClient;
StringSession = gram.sessions.StringSession;
```

Les deux classes proviennent donc de la même instance de GramJS.

Déploiement GitHub Pages identique aux versions précédentes.
