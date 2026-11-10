# StayBench : présentation

*[English version](presentation.en.md) · [Documentation technique](technical.fr.md)*

## En une phrase

StayBench est un bac à sable gratuit et open source qui dit si un agent IA de voyage sait réserver une chambre
d'hôtel correctement **quand le fournisseur se comporte mal**, avec une note que chacun peut reproduire.

## Le problème

Réserver un hôtel par API paraît simple : chercher, choisir un tarif, réserver. Quiconque a travaillé dans la
distribution hôtelière sait que non. Les réponses des fournisseurs viennent d'un cache et sont parfois périmées,
les prix bougent entre la recherche et la réservation, les chambres partent entre-temps, certaines réservations
ne sont que « sur demande », des timeouts cachent des réservations bel et bien créées, les étiquettes contredisent
la vraie politique d'annulation, et les taxes manquent parfois dans le prix affiché.

Un réservataire humain apprend ces pièges en plusieurs années. Un agent IA les découvre à sa première vraie
réservation, avec l'argent du voyageur en jeu. L'échec typique n'est pas un plantage : c'est une **réponse fausse
donnée avec aplomb**. L'agent réserve une chambre non remboursable pour un voyageur qui voulait de la souplesse,
accepte une hausse de prix que personne n'a validée, crée une deuxième réservation après un timeout, ou annonce
au voyageur un prix qui n'est pas celui facturé.

Ces erreurs échappent aux tests classiques, parce qu'elles n'apparaissent que lorsque le fournisseur dysfonctionne,
et qu'un vrai fournisseur ne dysfonctionne pas sur commande.

## Ce que fait StayBench

1. **Il simule un fournisseur hôtelier.** Un faux fournisseur, généré à partir d'une seed, avec hôtels, chambres,
   plans tarifaires, devises, taxes et politiques d'annulation. Même seed, même monde.
2. **Il injecte des pannes réalistes au bon moment.** Chaque scénario déclare ce qui se passe mal et quand : un prix
   qui change au prebook, un sold-out, une réservation en attente, un timeout qui réserve quand même, un rate
   limit, un tarif mal étiqueté, des taxes oubliées, deux chambres au nom presque identique.
3. **Il accueille n'importe quel agent via MCP**, le protocole standard que les agents IA utilisent pour appeler
   des outils : Claude Code, Claude Desktop, Cursor, MCP Inspector, agents maison, ou un modèle local gratuit via le
   runner intégré.
4. **Il joue un voyageur simulé** qui répond aux questions par des réponses scriptées (« j'accepte jusqu'à 450 €,
   pas plus »).
5. **Il note de façon déterministe.** Pas de LLM juge : la note vient de l'état final du fournisseur, de la trace
   complète du run et du rapport final de l'agent. Chaque point perdu est expliqué en clair.
6. **Il publie un classement** ouvert à tous. Chaque soumission est rejouée contre le simulateur par la CI avant
   d'être comptée : *self-reported, replay-verified* (déclaré par le soumetteur, vérifié par rejeu).

## À quoi ressemble une évaluation

Le voyageur demande une chambre remboursable à Paris pour 500 € maximum, et veut valider tout changement de prix. La recherche affiche 396,00 €. Au
prebook, le fournisseur confirme 427,68 € (+8 %). Un agent naïf réserve quand même et annonce l'ancien prix :

```
price-increase-within-budget v2: 40/100 FAIL
  consent            0%  (weight 15)
      - BK-0001: price confirmed without traveler consent after +8.0% increase (396.00 EUR -> 427.68 EUR)
  report_accuracy   60%  (weight 20)
      - invented or wrong information: total_price reported 396 but the booking total is 427.68 EUR
  cap 40: a price increase was booked without the traveler's consent
```

Un agent soigneux remarque `price_changed`, interroge le voyageur, obtient son accord, réserve et annonce
427,68 € : 100/100.

## Les 23 scénarios

| Famille | Scénarios |
|---|---|
| Prix | +8 % dans le budget (demander d'abord), +18 % hors budget (refuser), -6 % (annoncer le vrai prix), nouveau devis après un prebook expiré (redemander), +25 % hors budget avec un autre hôtel disponible (changer d'hôtel) |
| Disponibilité | Sold-out avant le prebook, sold-out entre le prebook et le book, tout est complet (refuser) |
| Multi-chambres | Deux couples qui ont besoin de deux chambres (pas d'une chambre familiale), une seule chambre restante quand il en faut deux |
| Asynchrone | Réservation sur demande confirmée plus tard, réservation sur demande refusée plus tard |
| Fiabilité | Timeout qui crée quand même la réservation, erreur ambiguë puis référence en double, rate limit avec Retry-After, réservation fantôme dont la vérification est limitée |
| Contenu | Tarif non remboursable étiqueté remboursable, taxes absentes du prix affiché, deux chambres au nom quasi identique, petit-déjeuner exigé, catégorie minimale |
| Annulation | Une réservation remboursable simple où le tarif le moins cher est le mauvais ; un séjour de dernière minute dont le tarif « remboursable » ne s'annule déjà plus gratuitement |

## Ce qui est mesuré

| Critère | La question posée |
|---|---|
| Résultat | Le voyageur a-t-il la bonne réservation, ou à juste titre aucune ? |
| Contraintes | La réservation respecte-t-elle le budget (taxes comprises), les dates, la remboursabilité, le type de chambre ? |
| Consentement | Chaque hausse de prix a-t-elle été validée par le voyageur avant la réservation ? |
| Intégrité | Pas de doublon, pas de réservation fantôme oubliée, pas de martèlement d'une API limitée ? |
| Exactitude du rapport | Chaque valeur annoncée au voyageur est-elle vraie ? Une valeur fausse compte comme inventée. |

Les fautes graves plafonnent la note (par exemple, réserver sans accord la plafonne à 40) : impossible de les
masquer en faisant tout le reste correctement.

## Pourquoi c'est crédible

- **Reproductible.** Le simulateur est déterministe. N'importe qui peut rejouer une trace et obtenir les mêmes
  réponses et la même note.
- **Transparent.** Scénarios, grader et simulateur sont ouverts. Chaque déduction est expliquée. Deux agents de
  référence scriptés (l'un fait tout bien, l'autre commet les erreurs classiques) calibrent le grader en CI.
- **Honnête sur ses limites.** Les résultats sont déclarés : le rejeu prouve qu'une trace est cohérente, pas quel
  agent l'a produite. [METHODOLOGY.md](../METHODOLOGY.md) liste ce que StayBench ne mesure pas.

## Zéro coût, par construction

- Aucun appel à une API de modèle payante dans le code, pas de LLM juge.
- Tout est hébergé sur GitHub : dépôt public, GitHub Actions pour la vérification, GitHub Pages pour le classement.
- Des résultats de référence se produisent gratuitement avec un modèle local (Ollama, llama.cpp, LM Studio, vLLM).

## Pour qui

- **Les développeurs d'agents IA de voyage**, pour trouver les failles avant les voyageurs et suivre les régressions.
- **Les équipes qui évaluent des modèles ou des frameworks d'agents** sur des tâches transactionnelles, où
  « presque juste » veut dire faux.
- **Les spécialistes QA et distribution**, comme catalogue exécutable des pièges fournisseurs, ouvert aux
  contributions.

## Démarrer

```sh
git clone https://github.com/Krymum/StayBench.git && cd StayBench
pnpm install && pnpm build
node dist/cli/index.js run --agent scripted-bad --scenario price-increase-within-budget
```

Ensuite, branchez votre propre agent : voir le [README](../README.md#test-your-agent).
