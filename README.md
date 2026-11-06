# La Table

Petit outil de jeu de rôle auto-hébergé : dossiers de groupes, fiches synchronisées, informations privées pour le MJ et dé à 20 faces.

## Lancer sur l’ordinateur du MJ

1. Installer **Node.js 20 ou plus récent**.
2. Double-cliquer sur `Demarrer La Table.bat` ou lancer `npm start` dans ce dossier.
3. Ouvrir `http://localhost:PORT` (la valeur de `PORT` dans `.env`) et créer le compte MJ.
4. Garder la fenêtre du serveur ouverte pendant la partie.

Les données sont enregistrées dans `data/db.json`, à côté de l’application. Pense à en faire des copies de sauvegarde. Les mots de passe sont hachés ; les mots de passe en clair ne sont pas conservés dans ce fichier.

Sur le même réseau local, les joueurs peuvent ouvrir `http://ADRESSE-LOCALE-DU-PC-DU-MJ:PORT`.

## Accès depuis Internet

Crée d’abord le compte MJ depuis l’ordinateur, avant d’exposer l’application à Internet. Le serveur peut ensuite écouter sur un port de la box redirigé vers le PC du MJ. Avant d’ouvrir un port sur Internet :

- réserve une adresse locale fixe au PC du MJ dans la box ;
- utilise HTTPS. Le serveur accepte un certificat TLS si `TLS_KEY` et `TLS_CERT` pointent vers les fichiers de clé et de certificat ;
- configure un nom DNS/DDNS si l’adresse IP publique change ;
- vérifie que le fournisseur Internet ne bloque pas l’accès entrant ou n’utilise pas de CGNAT.

Sans certificat HTTPS valide, **ne saisis pas de vrais mots de passe sur une connexion exposée à Internet**. Si la redirection de port ou le certificat est trop compliqué, un VPN privé/tunnel est une solution de secours. Ne redirige jamais l’accès Bureau à distance ou les fichiers Windows : uniquement le port de cette application.

Le port actuel est défini par `PORT` dans `.env` (ici `3456`, repris de l’adresse qui était dans le `.bat`). Pour le changer, modifie cette valeur puis relance l’application : le serveur et `Demarrer La Table.bat` utiliseront le même port. Si `.env` est absent, le port par défaut est `3000` (`.env.example` sert de modèle). Une variable d’environnement `PORT` déjà définie est prioritaire. Si tu as configuré une redirection de port sur la box, pense à mettre à jour son port de destination. Pour HTTPS direct, définis aussi `TLS_KEY` et `TLS_CERT` dans l’environnement avant de lancer l’application.

## Déployer sur OMV avec Docker et Nginx Proxy Manager

`compose.yaml` utilise directement l’image `node:22-alpine` et monte le code depuis le dossier OMV ; aucun Dockerfile ni étape de build n’est nécessaire. L’application n’expose aucun port sur l’hôte : seul Nginx Proxy Manager, sur un réseau Docker partagé, peut la joindre.

1. Copie le projet sur OMV. Si tu veux garder tes joueurs et fiches actuels, copie aussi le dossier `data` existant ; **ne remplace pas `data/db.json` si une base de données existe déjà sur OMV**.
2. À côté de `compose.yaml`, assure-toi que `.env` contient `PORT`, `PUID` et `PGID` (pars de `.env.example` si besoin). Règle `PUID` et `PGID` selon le propriétaire du dossier `data` sur OMV ; le port par défaut est 3456.
3. Assure-toi que le dossier `data` est accessible en écriture par `PUID:PGID` (par exemple `chown -R 1000:1000 ./data`, en adaptant les valeurs), puis lance `docker compose up -d` depuis ce dossier, ou déploie le fichier avec l’interface Compose d’OMV.
4. Dans Nginx Proxy Manager, ajoute un Proxy Host : domaine de jeu, **Scheme** `http`, **Forward Hostname/IP** `table`, **Forward Port** égal à `PORT`. Le conteneur NPM doit être connecté au réseau indiqué dans `NPM_NETWORK`.
5. Active SSL avec un certificat Let’s Encrypt et **Force SSL**. Pendant la première configuration, protège temporairement l’hôte par une Access List NPM, crée le compte MJ, puis retire cette protection si les joueurs doivent se connecter directement à l’application.

Le Compose utilise le réseau externe `qby_network`, comme ton exemple. NPM doit aussi être connecté à ce réseau. S’il ne l’est pas déjà, ajoute-le à son Compose.

Sur la box, redirige uniquement les ports **80 et 443 vers Nginx Proxy Manager** ; ne redirige pas `PORT` (3456 par défaut). Pour les mises à jour en direct via le proxy, si elles sont retardées, ajoute `proxy_buffering off;` dans la configuration avancée du Proxy Host. Les données persistantes restent dans `data/db.json` : sauvegarde ce fichier régulièrement.

## Fonctionnalités actuelles

- Compte MJ initial et comptes joueurs avec mot de passe.
- Mot de passe de 6 caractères minimum.
- Plusieurs dossiers de groupes ; un compte joueur peut participer à plusieurs dossiers.
- Une fiche par compte et par groupe ; un compte présent dans plusieurs groupes possède donc une fiche dans chacun. Le MJ peut consulter et modifier toutes les fiches.
- Depuis le bas d’une fiche, le MJ peut retirer le personnage du groupe ou supprimer le compte joueur et toutes ses fiches (confirmation requise).
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
