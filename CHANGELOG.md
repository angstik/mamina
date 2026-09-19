# CHANGELOG MamiNa

## v0.7.0
**Synthèse :** lecteur et éditeur mobile affinés, cache local accéléré/prédictif, commentaire hors-ligne éditable et icône d’application.

C’est fait. La v0.7 ajoute `CHANGELOG.md` et reprend le lecteur mobile autour du fonctionnement local.

La page d’accueil porte maintenant le bouton Paramètres ; l’en-tête d’une revue est volontairement réduit à retour, MamiNa, information de page, messages en attente et état Telegram. Le swipe horizontal fonctionne aussi directement sur l’article. Deux boutons semi-transparents flottent en bas à droite de l’article : changement d’ordre des messages et ajout de commentaire.

Le double-tap de l’article a trois comportements : si l’article est zoomé il revient à 1× ; sinon un double-tap dans la zone photo ouvre l’image en plein écran avec zoom/pan, et un double-tap dans la zone texte ouvre le texte en plein écran. Un double-tap ferme ensuite le plein écran.

L’éditeur est plus compact et ancré au bas du viewport visuel. La palette de couleurs n’apparaît qu’après le bouton couleur et remplace alors la barre d’outils sans fermer le clavier pour les couleurs rapides. Le rectangle affiche la couleur courante ; G/S/B ont un état appuyé explicite. La barre place les actions d’édition à gauche et `⋯ / ❌ / ✅` à droite. En édition, l’en-tête affiche par exemple `MamiNa 4/28 - page 2 bas`, sans seconde ligne.

Un commentaire hors ligne est affiché avec un contour pointillé, sans texte “en attente”. Il est cliquable pour être réédité ; le bouton `+` reprend également automatiquement ce brouillon. Il reste limité à un brouillon par article et part à la prochaine connexion.

Le chemin local est accéléré : l’ouverture d’une revue utilise directement les articles et messages indexés dans IndexedDB sans reparcourir le PDF ; PDF.js n’est chargé que si une image manque. Les articles courant, précédent/suivant et ±2 sont ensuite préchauffés de façon prédictive.

Enfin, le manifeste contient maintenant une icône MamiNa dérivée de la photo fournie, en 192 et 512 px, avec icône iOS/PWA.

## v0.6.0
**Synthèse :** mode hors-ligne avec file d’attente, paramètres/admin réunis, reconnexion par pastille et éditeur riche mobile.

C’est fait.

[📦 Télécharger `mamina-user-v0.6.zip`](sandbox:/mnt/data/mamina-user-v0.6.zip)

Cette version fait les changements demandés : la reconnexion passe uniquement par la pastille d’état ; pendant une reconnexion elle clignote et devient non cliquable. Le bouton de reconnexion séparé disparaît. Un compteur de messages en attente apparaît à gauche de la pastille.

Le mode hors-ligne accepte maintenant **un commentaire texte en attente par article**. Il est stocké dans IndexedDB, affiché comme « en attente », puis envoyé automatiquement au retour de Telegram. Si un deuxième commentaire est saisi sur le même article avant envoi, il remplace le précédent.

La saisie du téléphone Telegram utilise maintenant un vrai champ `type="tel"` avec `autocomplete="tel"`, et le code Telegram utilise `autocomplete="one-time-code"`, ce qui permet à iOS/Android de proposer leurs mécanismes d’autoremplissage.

J’ai aussi fusionné l’administration dans **Paramètres**. La page contient thème clair/sombre/système, ordre des réactions, état réseau/Telegram, messages en attente, logs, puis un volet **Administration / publication** avec nom `MamiNa`, groupe, sujets et publication du PDF. `/master.html` redirige désormais vers ce volet au lieu d’avoir une deuxième UI indépendante.

L’éditeur a également été repris : palette couleur masquée par défaut et affichée uniquement à la place de la barre d’options, clavier conservé pour les couleurs rapides, retour immédiat au focus après choix, boutons `G / S / B` visuellement actifs, `⋯`, `🧹`, `❌`, `✅`, suppression du bouton effacer, zone limitée à environ 1–3 lignes avec scroll interne, collée au clavier.

Enfin, pendant la saisie le changement d’article reste bloqué, mais l’image de l’article peut être pincée pour zoomer et déplacée indépendamment. La zone d’édition, elle, ne subit pas ce zoom.

Le premier test que je ferais maintenant est : couper le réseau, saisir un commentaire, vérifier le compteur `1`, puis réactiver le réseau et toucher la pastille pour vérifier que le compteur retombe à `0` après envoi.
