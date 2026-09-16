# Mamina — V2 Topics Telegram

Prototype statique pour tester l'usage familial avant l'import PDF.

## Ce que fait cette version

- vérifie le token du bot ;
- détecte le groupe Telegram ;
- vérifie que le groupe est en mode Forum / Topics ;
- choisit une image de test ;
- crée 3, 5, 8 ou 10 Topics en une seule action ;
- publie dans chaque Topic l'image + un texte de démonstration différent.

Le token du bot n'est jamais enregistré par la page.
Le `chat_id` du groupe peut être mémorisé dans le `localStorage` de Safari.

## Configuration Telegram

### 1. Activer les Topics dans le groupe

Dans le groupe Telegram de test :

- ouvrir les informations / réglages du groupe ;
- activer **Topics / Sujets / Forum**.

Le groupe devient alors un supergroupe Forum.

### 2. Donner les droits au bot

Ajouter le bot comme **administrateur** avec au minimum le droit :

- **Manage Topics / Gérer les sujets**.

Le bot doit aussi pouvoir envoyer des messages dans le groupe.

### 3. Rendre le groupe détectable

Envoyer dans le groupe :

`/test@NomDuBot`

Puis, dans Mamina :

- **Tester le bot**
- **Détecter les groupes récents**
- sélectionner le groupe
- **Vérifier Forum**
- mémoriser le groupe si souhaité.

## Test familial

1. Choisir une image quelconque.
2. Laisser `5` Topics pour le premier essai.
3. Appuyer sur **Créer les Topics + publier**.
4. Ouvrir Telegram avec les membres de la famille.
5. Tester :
   - navigation dans les Topics ;
   - réactions sur les photos ;
   - réponses dans chaque Topic ;
   - notifications ;
   - retour à la liste des Topics.

## GitHub Pages

Déployer `index.html` et `.nojekyll` à la racine de `main`.

Settings → Pages → Deploy from a branch → `main` → `/(root)`.

## Suite prévue

Après validation du test familial :

1. upload du PDF Famileo ;
2. extraction des ~28 publications ;
3. écran de prévisualisation/correction ;
4. création automatique des ~28 Topics ;
5. envoi de chaque image + texte dans son Topic.
