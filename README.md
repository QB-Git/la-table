# La Table

Petit outil de jeu de rôle auto-hébergé : dossiers de groupes, fiches synchronisées, informations privées pour le MJ et dé à 20 faces.

## Lancer sur l’ordinateur du MJ

1. Installer **Node.js 20 ou plus récent**.
2. Double-cliquer sur `Demarrer La Table.bat` ou lancer `npm start` dans ce dossier.
3. Ouvrir <http://localhost:3000> et créer le compte MJ.
4. Garder la fenêtre du serveur ouverte pendant la partie.

Les données sont enregistrées dans `data/db.json`, à côté de l’application. Pense à en faire des copies de sauvegarde. Les mots de passe sont hachés ; les mots de passe en clair ne sont pas conservés dans ce fichier.

Sur le même réseau local, les joueurs peuvent ouvrir `http://ADRESSE-LOCALE-DU-PC-DU-MJ:3000`.

## Accès depuis Internet

Crée d’abord le compte MJ depuis l’ordinateur, avant d’exposer l’application à Internet. Le serveur peut ensuite écouter sur un port de la box redirigé vers le PC du MJ. Avant d’ouvrir un port sur Internet :

- réserve une adresse locale fixe au PC du MJ dans la box ;
- utilise HTTPS. Le serveur accepte un certificat TLS si `TLS_KEY` et `TLS_CERT` pointent vers les fichiers de clé et de certificat ;
- configure un nom DNS/DDNS si l’adresse IP publique change ;
- vérifie que le fournisseur Internet ne bloque pas l’accès entrant ou n’utilise pas de CGNAT.

Sans certificat HTTPS valide, **ne saisis pas de vrais mots de passe sur une connexion exposée à Internet**. Si la redirection de port ou le certificat est trop compliqué, un VPN privé/tunnel est une solution de secours. Ne redirige jamais l’accès Bureau à distance ou les fichiers Windows : uniquement le port de cette application.

Le port actuel est défini par `PORT` dans `.env` (ici `3456`, repris de l’adresse qui était dans le `.bat`). Pour le changer, modifie cette valeur puis relance l’application : le serveur et `Demarrer La Table.bat` utiliseront le même port. Si `.env` est absent, le port par défaut est `3000` (`.env.example` sert de modèle). Une variable d’environnement `PORT` déjà définie est prioritaire. Si tu as configuré une redirection de port sur la box, pense à mettre à jour son port de destination. Pour HTTPS direct, définis aussi `TLS_KEY` et `TLS_CERT` dans l’environnement avant de lancer l’application.

## Fonctionnalités actuelles

- Compte MJ initial et comptes joueurs avec mot de passe.
- Mot de passe de 6 caractères minimum.
- Plusieurs dossiers de groupes ; un compte joueur peut participer à plusieurs dossiers.
- Fiche par joueur et par dossier ; le MJ peut consulter et modifier toutes les fiches.
- Les joueurs ne reçoivent que leur propre fiche. Les indicateurs privés MJ ne sont jamais renvoyés à leur navigateur.
- Vue d’ensemble limitée au groupe sélectionné, avec les caractéristiques, atouts, défauts, chance et informations privées visibles du MJ.
- Inventaire dans la fiche ; le joueur définit lui-même son nom, prénom et métier.
- Six caractéristiques (Physique, Dextérité, Agilité, Intelligence, Volonté, Perception), toutes réglables de 4 à 19.
- À la création d’une fiche, le MJ fixe le budget initial des caractéristiques ; il peut ensuite ajouter des points bonus. Le joueur ne voit que son solde à distribuer, et le serveur empêche de dépasser le budget.
- Indicateurs privés personnalisables par le MJ.
- Tooltip de règle : sur Roll20, le calcul d’action est `d20 − caractéristique` ; une caractéristique basse est favorable. Aucun dé ni bouton de jet n’est intégré à La Table.
- Le joueur peut changer son mot de passe ; le MJ peut en réinitialiser un depuis l’aperçu du groupe.
- Menu latéral repliable sur ordinateur et navigation en tiroir sur mobile.
- Mises à jour en direct dans le groupe.

## Limites du prototype

L’ordinateur et le programme du MJ doivent rester allumés pendant la partie. Les sessions sont réinitialisées au redémarrage. Le serveur n’est pas encore accompagné d’un installateur Windows ni d’un assistant de configuration réseau ; l’ouverture de port et les certificats restent à configurer séparément.
