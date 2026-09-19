# CHANGELOG MamiNa

## v0.9.2
**Synthèse :** toggle de style/couleur rétabli pour la frappe, messages différés normalisés immédiatement et bouton Revue/Récent restauré.

La v0.9.2 conserve tel quel le mécanisme déjà fiable lorsqu’un texte est sélectionné. Pour une sélection vide, G/I/S/B utilisent maintenant un état de frappe explicite et créent un petit conteneur de saisie au curseur : le style reste donc actif pour les caractères suivants jusqu’au prochain toggle. La couleur suit exactement la même logique et reste active pendant la frappe.

Lorsqu’un message de l’outbox est effectivement envoyé à Telegram, le message retourné par Telegram est immédiatement écrit dans IndexedDB avant de supprimer le brouillon local. L’affichage de la revue ouverte est ensuite relu depuis le cache local : le contour pointillé disparaît sans attendre une propagation ultérieure de l’historique Telegram.

Le bouton d’ordre des articles `Revue / Récent` est restauré dans l’en-tête de la vue Article. Il conserve l’article courant lorsqu’on change d’ordre et disparaît en vue Message.

## v0.9.1
**Synthèse :** stabilisation de la vue Message, toolbar déterministe, activité dans la pastille article et collage cité sans propagation du style.

La v0.9.1 sépare plus strictement les quatre vues. En vue Message, la liste des réactions disparaît : il ne reste que l’article manipulable et la saisie ; le swipe entre articles est bloqué jusque dans la logique gestuelle et le bouton + reste visible mais inopérant.

La barre de formatage a été réécrite autour d’un seul événement `pointerup` par bouton, avec verrou de sélection pendant l’interaction. Les clics synthétiques iOS ne peuvent donc plus rejouer la commande. Le focus revient immédiatement dans l’éditeur après G/I/S/B ou une couleur. Le bouton envoyer n’a plus l’apparence permanente d’un bouton appuyé.

Un extrait copié depuis le texte de l’article reste surligné uniquement pour l’extrait collé : le curseur est explicitement déplacé dans un nœud neutre après ce contenu, de sorte que la saisie suivante reprend la casse et la couleur courantes.

En vue Article, les activités (`local`, `PDF`, synchronisation, etc.) utilisent désormais la petite pastille superposée à l’article et disparaissent automatiquement ; elles ne créent plus de ligne qui déplace l’article. La pastille `local/PDF` est elle aussi transitoire. Le changement de sens des messages ne reconstruit pas l’article.

Le contraste des séparateurs, panneaux et contrôles a été légèrement renforcé. Les boutons flottants sont semi-transparents en vue Article et restent suffisamment visibles en vue Message.

## v0.9.0
**Synthèse :** stabilisation iOS/mémoire, restauration après reload, éditeur fiabilisé, ordre des messages sans rerendu, contraste renforcé.

v0.9 : stabilise iOS, réduit la mémoire PDF/canvas, restaure la revue après reload, fiabilise l’éditeur et inverse les messages sans rerendu.

La v0.9 est volontairement une version de stabilisation avant la v1. Le symptôme de rechargement sans message est très compatible avec une mise à mort du processus WebKit pour pression mémoire : notre code pouvait ouvrir/rendre plusieurs PDF en parallèle et, surtout, reparsait les deux revues complètes à chaque synchronisation de 30 secondes.

Les rendus PDF sont maintenant sérialisés, les canvases sont libérés explicitement, les PDF temporaires sont détruits après usage, le préchargement ne concerne plus que les voisins immédiats et une revue déjà entièrement en cache n’est plus reparsée lors des synchronisations suivantes. L’état revue/article est conservé pour revenir automatiquement au même endroit après un reload iOS inattendu.

Le double-tap de la vue texte est rétabli avec un gestionnaire tactile dédié. Le changement d’ordre des messages ne reconstruit plus l’article : seules les réactions sont rerendues. Une pastille `local` ou `PDF` est affichée directement sur l’article. Les traits, panneaux et boutons flottants ont plus de contraste.

L’éditeur prend maintenant le focus de manière synchrone dès l’ouverture. La première couleur est noire en clair et blanche en sombre. Les commandes G/I/S/B restaurent la sélection après avoir remis le focus dans l’éditeur, et leur état visuel est verrouillé brièvement pour éviter les retours incohérents de Safari. L’envoi met à jour uniquement la liste de réactions courante avant de fermer l’éditeur, sans reconstruire le lecteur sous le clavier.

J’ai effectué plusieurs passes de vérification : syntaxe Node de tous les modules cœur, contrôle de tous les IDs HTML référencés, absence de doublons, invariants ciblés sur les régressions ci-dessus, puis contrôle d’intégrité du ZIP. Le build Vite complet n’a pas pu être rejoué ici car `npm install` expire sur le réseau de l’environnement.

## v0.9.0
**Synthèse :** stabilisation iOS/mémoire, restauration après reload, éditeur fiabilisé, ordre des messages sans rerendu, contraste renforcé.

La v0.9 est une passe de stabilisation avant v1. Les rendus PDF sont maintenant sérialisés, les canvases sont explicitement libérés, le préchargement est limité aux voisins immédiats et le PDF est détruit en quittant une revue. L’état revue/article est persisté afin de restaurer automatiquement l’écran après un rechargement iOS inattendu.

Le double-tap de la vue texte est rétabli explicitement sur iOS. Les contrastes des traits, panneaux et boutons flottants sont renforcés. Le changement d’ordre des messages ne reconstruit plus l’article : seules les listes de commentaires et les flèches sont mises à jour. Une pastille `local` ou `PDF` est affichée directement sur l’article.

L’éditeur reçoit le focus synchroniquement à l’ouverture pour faire apparaître le clavier iOS. La première couleur est noire en mode clair et blanche en mode sombre. Les commandes G/I/S/B conservent la sélection, exécutent la commande après avoir remis le focus, et affichent immédiatement un état actif stabilisé. Le rectangle de couleur n’est mis à jour que depuis une couleur explicitement appliquée, pour éviter le faux noir renvoyé par Safari en mode sombre.

L’envoi d’un message ne reconstruit plus le lecteur sous le clavier : la liste courante est mise à jour en place, puis l’éditeur se ferme. Les erreurs globales et rejets de promesse sont journalisés ; en cas de kill mémoire iOS sans exception, la reprise se fait sur la dernière revue et le dernier article.

## v0.8.0
**Synthèse :** reprise Telegram/outbox fiabilisée, activité visible, profil/splash, lecteur photo/texte amélioré, éditeur et zoom stabilisés, icône iOS explicite.

C’est fait. La v0.8 corrige la reprise Telegram, ajoute une ligne d’activité sous les en-têtes, le splash de bienvenue avec profil Telegram, le formatage automatique des numéros français, la mise à jour forcée et l’affichage de la version.

L’icône iOS utilise maintenant un `apple-touch-icon` 180×180 explicite avec un nouveau nom de fichier pour éviter l’ancien cache. iOS conserve souvent l’icône d’une PWA déjà ajoutée : si le “M” reste après déploiement, il faut supprimer l’icône de l’écran d’accueil puis ajouter MamiNa à nouveau.

Le compteur de messages à transmettre reste toujours visible : vert à 0, orange clair au-dessus. Au retour réseau, MamiNa force la reconnexion, restaure le groupe si nécessaire, vide la file d’attente puis synchronise. La pastille manuelle fait la même chose.

Dans la revue, le double-tap hors texte ouvre maintenant uniquement la zone photo, tandis que le double-tap texte affiche une vue sélectionnable avec avatar, auteur et date en gras puis le corps. Une copie provenant de cette vue et recollée dans l’éditeur reçoit un léger surlignage bleu clair. L’italique a été ajouté.

L’éditeur garde maintenant le focus pendant l’envoi, les boutons de formatage préservent/restaurent explicitement la sélection, le rectangle de couleur suit la couleur courante et l’éditeur est ancré au bas du `visualViewport`. Le zoom/pan de l’article est conservé par article, borné pour ne pas montrer de vide et bénéficie d’une petite inertie. Pendant l’édition, la zone de revue est redimensionnée à la partie réellement visible au-dessus du clavier.

Enfin, les images d’articles sont toujours chargées localement et les voisines sont préchauffées. Une ligne d’activité indique les opérations en cours (`Connexion à Telegram`, lecture des sujets/messages, analyse PDF, cache local, écriture base, envoi différé, etc.).

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
