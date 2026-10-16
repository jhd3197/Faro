# Dépôt Windows et fiabilité des uploads

## Audit et causes identifiées

Faro utilise React/Zustand pour l’interface, le package partagé `packages/file-ui`
pour les panneaux et Tauri 2 pour l’IPC. `FileBrowser` affiche un panneau local ou
distant ; `DualPaneBrowser` affiche les deux. `transfersStore` résout les conflits
puis appelle les commandes Rust. `TransferManager` possède déjà la concurrence,
la pause, l’annulation, les reprises et les réessais. `RemoteFs` gère les opérations
de métadonnées ; les implémentations du moteur assurent les transferts de contenu.

L’ancien dépôt interne utilisait un payload HTML avec des entrées Faro. Aucun
gestionnaire ne consommait les chemins natifs d’Explorer. Le parcours d’upload
ignorait les erreurs de métadonnées (`Err(_) => continue`) et de création des
dossiers (`let _ = create_dir(...)`). La boucle frontend masquait les erreurs de
lancement avec `catch(() => {})`. Ces défauts permettent une omission ou un lot
partiel sans récapitulatif fiable. Sans journaux du déploiement original, on ne
peut pas attribuer avec certitude l’incident `assets` à un défaut particulier.

## Changements

- Gestionnaire natif Tauri `onDragDropEvent` avec chemins absolus, sélection mixte,
  détection du panneau distant et du dossier survolé. Les coordonnées physiques
  sont converties en coordonnées CSS. Les dépôts hors d’un panneau connecté sont
  refusés. Aucun second traitement HTML des fichiers externes n’est ajouté.
- Inventaire asynchrone et itératif avant modification distante. Il inclut les
  fichiers cachés, les fichiers sans extension ou vides et les dossiers vides.
  Il ne charge pas les contenus en mémoire. Les totaux utilisent des `u64` côté Rust.
- Empreinte des chemins/types/tailles/dates : une sélection modifiée entre le
  préinventaire et la préparation ne peut pas être acceptée discrètement, même
  si son nombre de fichiers reste identique. Cette empreinte de métadonnées
  n’est pas un checksum des contenus.
- Politique explicite : liens symboliques, jonctions et autres reparse points
  Windows refusés avec erreur ; aucun suivi pouvant provoquer une boucle ou une
  sortie de la sélection. Les noms non UTF-8 et noms incompatibles avec les
  séparateurs distants ou contenant CR/LF sont également refusés explicitement.
- Création des dossiers parents avant leurs enfants et avant la mise en file
  des fichiers. Un échec de création n’est toléré que si le dossier existe et
  peut être listé. Les collisions fichier/dossier ne sont pas masquées.
- Vérification indépendante de la taille distante avant le statut `done`.
  SFTP utilise les métadonnées, FTP `SIZE` avec repli sur le listing et S3 HEAD.
  Les autres fournisseurs utilisent le listing. En l’absence de métadonnées
  exploitables, le fichier échoue explicitement plutôt que recevoir un succès
  invérifiable. Le contrôle de checksum optionnel existant est conservé.
- Récapitulatif des lots dérivé des états du moteur, des octets et de la
  vérification finale des dossiers. Succès complet, partiel, échec et annulation
  sont distingués. Un succès sur `index.html` ne valide pas le lot à lui seul.
- Le récapitulatif dispose d’une croix pour le masquer. Fermer le panneau des
  transferts masque également les récapitulatifs ; le bouton « Transfers » les
  rouvre avec les résultats et erreurs conservés. Un nouvel upload les rouvre.
  Les fichiers échoués réutilisent les réessais existants ; les
  sélections non démarrées peuvent être soumises à nouveau à la même destination.
  Les lignes référencées par un lot ne sont pas effacées par « Clear finished ».

## Préparation facultative d’une release

Dans la vue à panneau unique, menu Upload → **Stage folder as a new release…**.
Ce choix explicite applique le mode à cette opération uniquement. Aucun réglage
par défaut n’est changé. Il exige les capacités dossiers et renommage.

Le dossier est envoyé dans `.faro-staging-<uuid>` sous la destination choisie.
Une fois tous les fichiers validés et les dossiers revérifiés, le conteneur est
renommé en `release-<uuid>`. Une destination de publication déjà existante est
refusée. Aucun nettoyage automatique ni suppression de contenu distant n’a lieu.
Les dossiers temporaires d’un échec restent disponibles pour inspection.

Il s’agit de publier **une nouvelle arborescence de release**, et non de remplacer
un site existant. La bascule d’un serveur web, d’un lien `current` ou d’un document
root reste à réaliser séparément. Aucune atomicité du déploiement n’est annoncée :
les garanties du renommage dépendent du serveur et du protocole. La vérification
préalable d’absence ne constitue pas un verrou distribué contre un tiers qui
créerait exactement le même nom UUID simultanément.

## Vérification automatisée

Commandes depuis la racine, sauf mention contraire :

```text
node --test scripts/upload-outcome.test.mjs scripts/upload-store.test.mjs
npm run build
node scripts/verify-transfers.mjs
cd src-tauri
cargo check -p faro --locked
cargo test -p faro --lib -- --test-threads=4
```

Les tests d’inventaire couvrent fichier unique, fichiers multiples, sélection
mixte, dossiers multiples, 12 niveaux, accents/espaces, cachés, zéro octet, fichier
de 64 Mio, dossiers vides, collisions, sélection modifiée et boucle de jonction
Windows. Les tests d’ordonnancement existants couvrent concurrence, pause,
annulation, fichiers partiels et réessais/ranges interrompus. Les tests frontend
de statut vérifient qu’aucun élément absent/échoué/ignoré/annulé, dossier non
vérifié ou volume différent ne permet un succès complet. Le test d’interface
existant vérifie la file, les pauses, reprises, réessais, ordre et débit. Un test Rust vérifie également que deux réessais concurrents ne peuvent réclamer la même tâche.

FTP local, dans un dossier de test dédié :

```text
python -m pip install pyftpdlib
python scripts/upload-ftp-lab.py --root <dossier-temporaire-vide>
```

Puis, dans `src-tauri`, définir `FARO_LIVE_FTP=127.0.0.1:2121:faro:farotest` :

```text
cargo test -p faro --lib live_ftp_manifest_assets_regression -- --ignored --nocapture
```

Ce test prépare les dossiers avec la même fonction que le moteur, envoie 352
fichiers (dont 350 assets), vérifie les états/tailles et les dossiers, puis relit
les 352 fichiers pour une comparaison indépendante octet par octet. Avec
`FARO_LIVE_FTP=127.0.0.1:2121:readonly:farotest`, exécuter :

```text
cargo test -p faro --lib live_ftp_manifest_permission_denied -- --ignored --nocapture
```

Résultats obtenus et limites de la session :

- Tests frontend : 16 tests de statuts et 9 tests du store réel avec IPC simulée, tous réussis. La publication est bloquée en cas d’erreur de fichier, de dossier ou de volume.
- Test d’interface de file sous Edge : toutes les assertions réussies, y compris
  fermeture du récapitulatif, réouverture via Transfers et conservation des erreurs.
- Suite Rust : 279 réussis, 33 ignorés ; les tests d’intégration FTP sont exécutés
  séparément. Un premier échec OpenSSH venait des ACL du dossier temporaire de
  l’environnement ; le même test et la suite passent avec un dossier temporaire
  privé, sans modification du code des clés.
- FTP réel `assets` : réussi, 352 allers-retours comparés.
- FTP réel sans permission d’écriture : réussi, aucun upload lancé.
- Build frontend et compilation Rust : réussis pendant la session ; les étapes
  finales de génération NSIS sont consignées dans le rapport de livraison.

Couverture des scénarios demandés :

| Scénario | Vérification effectuée |
| --- | --- |
| Fichier unique | Inventaire Rust, fichier vide et fichier de 64 Mio |
| Fichiers multiples | Commande d’inventaire, test Rust |
| Dossier avec fichiers | Préparation Rust et FTP réel |
| Plusieurs dossiers | Commande d’inventaire, test Rust |
| Sélection mixte | Inventaire Rust et ordonnancement du store |
| Plus de 10 niveaux | Arborescence de 12 niveaux, test Rust |
| Dossiers vides | Tests Rust et FTP réel |
| Accents et espaces | Inventaire Rust ; dossier accentué en FTP réel |
| Gros fichier | Inventaire de 64 Mio ; transfert de gros volume à tester sur le serveur cible |
| Zéro octet | Inventaire Rust et aller-retour FTP réel |
| Cachés | Fichier `.hidden` inventorié et transféré ; attribut Hidden Windows à tester manuellement |
| Collisions | Doublons de noms, collision fichier/dossier et politique existante ; dialogue à tester sur le serveur cible |
| Interruption réseau | Simulations du moteur de reprise/ranges ; coupure réelle pendant upload à tester manuellement |
| Permission distante | Compte FTP réellement limité en lecture |
| Annulation | Tests existants du moteur et de l’interface ; annulation d’un upload réel à tester manuellement |
| Réessai | Interface de file, moteur et verrou contre réessais concurrents |
| `assets` volumineux | 350 assets et 2 autres fichiers envoyés puis relus, contenus comparés |
| Explorer → sous-dossier distant | Résolution implémentée ; geste natif à valider manuellement |

## Limites et validation manuelle Windows obligatoire

L’automatisation exécutée ne pilote pas Explorer ni le bureau Windows. Elle ne
valide donc pas à elle seule le geste natif, son curseur Windows, les différents
DPI/zooms, les chemins UNC/longs ou la coexistence du drag interne HTML et du
gestionnaire natif WebView2. Tauri signale aussi une imprécision possible des
coordonnées avec les DevTools ouverts. Il faut valider ces scénarios sur le poste.

1. Ouvrir Faro avec une connexion FTP ou SFTP de test et choisir une destination
   vide. Tester les vues simple et double panneau.
2. Depuis Explorer, déposer `dist` contenant `assets` avec plusieurs centaines
   de fichiers, un dossier vide, `.hidden`, un fichier vide et des noms accentués.
3. Répéter avec fichiers seuls, dossiers multiples et sélection mixte. Déposer
   sur un sous-dossier puis dans le fond du panneau. Vérifier la destination
   affichée et la présence du dossier `dist` lui-même.
4. Répéter à DPI Windows 100/150/200 % et avec le zoom Faro ; fermer les DevTools.
   Tester un chemin UNC accessible et une arborescence dépassant 260 caractères.
5. Vérifier que les dépôts dans le panneau local ou hors connexion sont refusés
   et que le drag interne local → distant et distant → local reste fonctionnel.
6. Couper la connexion, provoquer un refus d’écriture, annuler puis réessayer.
   Vérifier l’absence de succès global, les erreurs après masquage du panneau et
   la conservation des chemins lors du réessai.
7. Tester collisions overwrite/rename/skip/cancel. Un skip doit empêcher le
   succès complet. Comparer indépendamment le nombre de fichiers et leurs hashes.
8. Tester le mode release : pas de `release-<uuid>` tant qu’un fichier échoue ;
   en succès, la nouvelle release contient `dist/assets`. Le site courant reste
   à basculer explicitement.

Les rapports de lots restent en mémoire pendant la session et après fermeture du
panneau ; ils ne sont pas persistés après redémarrage de l’application. La reprise
persistante des fichiers existante est conservée, mais un redémarrage ne
reconstitue pas automatiquement le récapitulatif global ni une publication en
attente. Une préparation de très grosse arborescence ne dispose pas encore d’un
bouton d’annulation dédié avant la création des tâches individuelles. Les
réessais de lignes qui n’avaient pas pu être mises en file peuvent nécessiter
une nouvelle sélection. Le staging et la bascule de publication doivent encore
être validés de bout en bout dans l’interface ; les tests de statut seuls ne
remplacent pas cette vérification.

La comparaison de tailles **ne garantit pas l’intégrité binaire**. Les checksums
optionnels du moteur restent nécessaires lorsqu’ils sont disponibles. Les tests
FTP de cette session comparent les contenus ; ce contrôle supplémentaire du test
ne signifie pas que le protocole FTP de production calcule systématiquement un
checksum distant.

## Installation et conservation des paramètres

L’identifiant `com.juandenis.faro`, le nom de l’application et les formats de
profils/paramètres ne sont pas modifiés. Sous Windows, `app_data_dir` désigne
normalement `%APPDATA%\com.juandenis.faro` : `faro.db`, `profiles.json` et les autres
fichiers d’état restent à cet emplacement. Les services du gestionnaire de
secrets ne changent pas. Aucun profil ou paramètre réel n’est ouvert/modifié par
la validation.

Fermer Faro puis exécuter le nouvel installateur dans le même compte Windows et
au même emplacement. Choisir la réinstallation/mise à jour en conservant les
données. Ne pas sélectionner « Delete the application data » dans un éventuel
désinstallateur. Une sauvegarde via l’outil de sauvegarde Faro existant permet de
vérifier ensuite le retour des connexions et réglages. La conservation effective
sur une installation utilisateur existante doit être vérifiée manuellement ;
l’installateur n’a pas été lancé contre les données réelles pendant cette session.

Références : [API native Tauri](https://v2.tauri.app/reference/javascript/api/namespacewebview/),
[installateur Windows Tauri](https://v2.tauri.app/distribute/windows-installer/).

Fichiers concernés : `packages/file-ui/src/components/FilePane.tsx`,
`src/components/{FileBrowser,NativeFileDrop,UploadReports}.tsx`, `src/App.tsx`,
`src/styles.css`, `src/lib/{ipc,uploadOutcome}.ts`, `src/stores/transfersStore.ts`,
`src-tauri/src/{commands,lib}.rs`, `src-tauri/src/transfer/{mod,manifest,live_tests}.rs`,
`scripts/{upload-outcome.test.mjs,upload-store.test.mjs,upload-ftp-lab.py}`, ce document et `.gitignore`.
`Cargo.lock` est resynchronisé sur les versions 1.3.48 déjà déclarées dans les
manifests (il portait encore 1.3.38) ; aucune nouvelle dépendance applicative.

## Installateur produit

Compilation release optimisée et génération NSIS réussies. Artefact final :

```text
src-tauri/target/release/bundle/nsis/Faro_1.3.48_x64-setup.exe
```

Taille : 7 605 582 octets. Application embarquée : Windows x64, version 1.3.48.
Le fichier de dépendances Rust référence le frontend final index-GaKBXxew.js.
Code source : commit 072506e sur dev, publié dans la PR #40 avec la correction
du panneau de résultats refermable.

SHA-256 de l’installateur :

```text
6E7279632DA429DF2C7902E82480A4F3DFC643353A2D33695DAD07B999F0FEFC
```

Une empreinte .sha256 est disponible à côté du .exe. Le script NSIS généré
conserve BUNDLEID=com.juandenis.faro et INSTALLMODE=currentUser ; sa suppression
AppData est conditionnée au choix explicite de suppression des données hors
mode mise à jour. L’installation sur le profil existant et les gestes Explorer
restent les étapes manuelles décrites ci-dessus.
