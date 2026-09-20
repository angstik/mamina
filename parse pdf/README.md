# Déploiement du parsing v1_CG

Les ressources de développement de ce dossier ne sont pas sous `public/` et ne sont donc pas incluses dans la PWA servie par Vite.

Pour initialiser le nouveau groupe **famileo_recette** :

1. Connecter le compte administrateur et ouvrir Réglages → Administration.
2. Actualiser les groupes ; `famileo_recette` est sélectionné automatiquement s'il est présent.
3. Dans « Configuration du groupe », choisir les trois fichiers de `catalog-publish/` puis « Initialiser params + catalog ».
4. L'application crée les topics réservés `params` et `catalog`, publie les trois fichiers dans `catalog`, un manifeste ciblable par message ID, puis le message canonique `params`.
5. Publier `Document_PDF_2.pdf` (n°42) puis `Document_PDF.pdf` (n°43). Chaque publication crée son propre topic et y place le PDF original + `gazette-<n>.json` parsé.

Les lecteurs ordinaires ne chargent que `params` et le JSON de chaque revue. Ils ne téléchargent jamais `emoji-catalog.bin/json`.
