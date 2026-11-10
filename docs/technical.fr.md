# StayBench : documentation technique

*[English version](technical.en.md) · [Présentation](presentation.fr.md) · [Méthodologie (EN)](../METHODOLOGY.md)*

Ce guide décrit la construction de StayBench : architecture, formats de données, déroulé d'un run et manières de
l'étendre. Chaque choix de conception assorti d'un compromis est consigné dans [DECISIONS.md](../DECISIONS.md)
(en anglais).

## 1. Stack

| Sujet | Choix |
|---|---|
| Langage, runtime | TypeScript (strict), Node.js 22+, ESM |
| Gestionnaire de paquets | pnpm 12 (workspace : paquet racine + `site/`) |
| MCP | SDK TypeScript officiel v2 : `@modelcontextprotocol/server`, `/client`, `/node` (spec 2026-07-28) |
| Validation | Zod v4 (`zod/v4`) : schémas des outils, des scénarios, des métadonnées de soumission |
| Scénarios | YAML (paquet `yaml`) |
| Tests | Vitest |
| Site | Astro 7, sortie statique |
| CI et hébergement | GitHub Actions, GitHub Pages |

Aucune dépendance n'appelle une API de modèle. Le seul client réseau est l'adaptateur optionnel compatible OpenAI,
qui parle à l'URL qu'on lui donne.

## 2. Architecture

```
                 ┌──────────────────────── staybench (CLI) ────────────────────────┐
                 │  list   serve   grade   run   verify                             │
                 └────┬───────┬───────┬──────┬──────┬───────────────────────────────┘
                      │       │       │      │      │
  scenarios/*.yaml ──▶ scenarios/loader ──▶ RunConfig ──────────────┐
                              │                                     ▼
  client MCP ──stdio/HTTP──▶ mcp/server ──┐                 session/RunSession
  agents scriptés ─────────────────────────┼──▶ call(tool,args) ──┬─▶ simulator/HotelProvider
  modèle local (compatible OpenAI) ───────┘                      │      └─ faults/FaultEngine
                                                                  ├─▶ traveler/Traveler
                                                                  ├─▶ core/VirtualClock
                                                                  └─▶ trace (JSONL)
                                                                          │
                                  trace/replay ◀──────────────────────────┘
                                       │
                                  grader/grade ──▶ GradeResult ──▶ leaderboard/verify ──▶ site/
```

L'idée centrale : **`RunSession.call(tool, args)` est le point d'entrée unique de tout appel d'outil**, quel que soit
l'appelant (serveur MCP, agent scripté, adaptateur de modèle local, rejeu). Il avance l'horloge, valide les
arguments, dispatche, et écrit la ligne de trace. Rien d'autre ne pouvant modifier l'état du run, la trace en est
un enregistrement complet et rejouable.

### Organisation du code

| Dossier | Rôle | Exports principaux |
|---|---|---|
| `src/core/` | Primitives déterministes | `Rng` (mulberry32 + `fork`), `VirtualClock`, monnaie (unités mineures entières), dates UTC |
| `src/simulator/` | Monde et comportement du fournisseur | `generateWorld(spec)`, `HotelProvider`, types du catalogue, `ERROR_CODES` |
| `src/faults/` | Définition et déclenchement des pannes | union `FaultSpec`, `FaultEngine` |
| `src/traveler/` | Voyageur simulé | `Traveler`, `PRICE_KEYWORDS`, `containsKeyword` |
| `src/session/` | Session de run et contrat des outils | `RunSession`, `TOOL_SCHEMAS`, `TOOL_DESCRIPTIONS`, `finalReportSchema` |
| `src/mcp/` | Serveur MCP et transports | `buildMcpServer`, `serveSessionStdio`, `serveSessionHttp` |
| `src/scenarios/` | Schéma et chargement des scénarios | `scenarioSchema`, `loadScenarios`, `toRunConfig`, `scenarioHash` |
| `src/trace/` | Format, lecture/écriture, rejeu | types `TraceLine`, `TraceWriter`, `parseTrace`, `replayTrace` |
| `src/grader/` | Notation déterministe | `gradeSession`, `gradeTrace`, `explain`, `WEIGHTS`, `CAPS` |
| `src/agents/` | Agents et appelants | `ScriptedGoodAgent`, `ScriptedBadAgent`, `OpenAICompatibleAgent`, `runAgent`, `sessionCaller`, `mcpCaller` |
| `src/leaderboard/` | Vérification des soumissions | `verifySubmission`, `buildLeaderboard`, `submissionMetaSchema` |
| `src/cli/` | Ligne de commande | `cmdList`, `cmdServe`, `cmdGrade`, `cmdRun`, `cmdVerify` |

Tout est réexporté depuis `src/index.ts` : StayBench s'utilise aussi comme bibliothèque.

## 3. Le simulateur

### Génération du monde

`generateWorld({ seed, generate_cities?, hotels_per_city?, hotels? })` construit le catalogue :

- Huit villes, chacune avec une devise et un taux de taxe (fictif) : LIS, PAR, BCN, ROM, BER (EUR), LON (GBP),
  NYC (USD), ZRH (CHF).
- Chaque ville tire dans son propre flux aléatoire, `rng.fork("city:<code>")` : modifier une ville ne rebat jamais
  les cartes d'une autre.
- Un hôtel généré reçoit 2 à 4 types de chambre et jusqu'à trois plans : `FLEX` (remboursable, annulation gratuite
  1 à 7 jours avant l'arrivée), `NR` (non remboursable, 10 à 20 % moins cher), `BB` (petit-déjeuner, remboursable).
- Les hôtels écrits à la main dans le scénario s'ajoutent (ou remplacent un hôtel généré de même id). Leurs ids de
  chambre et codes de plan sont locaux et préfixés : `H-LIS-101` + `R1` + `FLEX` donne le plan `H-LIS-101-R1-FLEX`.

### Identifiants et prix

- **Id de tarif** = `<plan_id>~<check_in>~<check_out>~<adults>`, par exemple
  `H-LIS-101-R1-FLEX~2026-03-12~2026-03-14~2`. Il est propre au séjour et analysable : `prebook` n'a besoin d'aucun
  état caché issu de `get_rates`.
- **Ids de prebook** `PB-0001`, **ids de réservation** `BK-0001` : séquentiels, donc déterministes.
- **Les montants** sont stockés en unités mineures entières. Prix = net par nuit × nuits, taxes = arrondi(net ×
  taux), total = net + taxes. Une variation de prix s'applique au net, les taxes sont recalculées. L'agent voit des
  décimaux à 2 chiffres.
- **Date limite d'annulation gratuite** = minuit UTC du jour d'arrivée moins N jours.

### Comportement du fournisseur

| Opération | Comportement |
|---|---|
| `search_hotels` | Hôtels de la ville ayant au moins une chambre adaptée à l'occupation ; `from_price` = tarif affiché le moins cher |
| `get_rates` | Chambres adaptées et leurs tarifs : prix affiché, `taxes_included`, étiquette `refundable` |
| `get_cancellation_policy` | La vraie politique du plan |
| `prebook` | Total final taxes comprises, `price_changed` et `previous_price` s'il diffère du prix affiché ; expire après 15 minutes ; usage unique |
| `book` | Vérifie dans l'ordre : rate limit, champs requis, dédoublonnage de la référence client, existence/usage/expiration du prebook, erreurs injectées, sold-out, sur demande |
| `get_booking` | Par `booking_id` ou `client_reference` ; renvoie une liste |
| `cancel_booking` | Remboursement total jusqu'à la date limite, rien après |

Les prix affichés sont **périmés par construction** : après une hausse ou un sold-out découvert au prebook,
`search_hotels` et `get_rates` continuent d'afficher l'ancienne donnée, comme le cache d'un vrai fournisseur.

### Moteur de pannes

Les pannes sont déclarées dans le scénario et évaluées à des points de contrôle fixes du fournisseur :

| Type | Point de contrôle | Effet |
|---|---|---|
| `price_change` | `prebook` | Applique `percent` au prix net. Persistant pour ce tarif. |
| `sold_out` | `prebook` (`search_to_prebook`) ou `book` (`prebook_to_book`) | `SOLD_OUT`. Persistant pour ce tarif. |
| `on_request` | `book` | Réservation créée en `pending`, résolue en `outcome` après `resolve_after_s` |
| `error` | tout outil fournisseur (`on`) | Erreur typée `code`. Avec `booking_created: true` sur `book`, la réservation existe quand même (réservation fantôme) |
| `duplicate_reference` | `book` | Désactive le dédoublonnage des références client |
| `rate_limit` | chaque appel fournisseur (`on`, ou `any`) | `RATE_LIMITED` avec `retry_after_s` ; les appels pendant la fenêtre sont à nouveau refusés |
| `mislabeled_refundable` | affichage | Remplace l'étiquette `refundable` dans `get_rates` |
| `taxes_excluded` | affichage | Prix affichés hors taxes, `taxes_included: false` |

`where` restreint une panne à un hôtel, une chambre ou un plan. `occurrence` vaut `first` (défaut), `always` ou
`n` (le n-ième appel concerné). Règle de comptage : le compteur d'une panne augmente une fois par appel qui atteint
son point de contrôle et correspond à `where`. Un appel rejeté plus tôt (rate limit, validation) ne compte pas.
Chaque déclenchement est journalisé (`FaultEvent`) et recopié dans le `meta` caché de la ligne de trace.

## 4. La session de run

`new RunSession(runConfig, { tracePath?, agent?, onEnd? })` crée l'horloge, le monde généré, le fournisseur et son
moteur de pannes, et le voyageur. Puis, pour chaque `call(tool, args)` :

1. Si le run est terminé : renvoie `RUN_FINISHED` (non tracé).
2. Avance l'horloge de `tick_s` (2 s par défaut).
3. Valide `args` avec le schéma Zod de l'outil (`UNKNOWN_TOOL` / `INVALID_ARGUMENTS` en cas d'échec, tracé).
4. Dispatche vers le fournisseur, le voyageur, `wait` ou le rapport final.
5. Collecte les annotations cachées : pannes déclenchées pendant l'appel, classification et décision du voyageur.
6. Ajoute une ligne `call` à la trace (en mémoire et, si `tracePath` est fourni, sur disque de façon synchrone).
7. Sur un `submit_final_report` valide, écrit la ligne `end` et appelle `onEnd`.

`close()` termine un run sans rapport (utilisé quand un client MCP se déconnecte).

### Outils

| Outil | Arguments |
|---|---|
| `search_hotels` | `city`, `check_in`, `check_out`, `adults` |
| `get_rates` | `hotel_id`, `check_in`, `check_out`, `adults` |
| `get_cancellation_policy` | `rate_id` |
| `prebook` | `rate_id` |
| `book` | `prebook_id`, `client_reference`, `guest_name` |
| `get_booking` | `booking_id?`, `client_reference?` |
| `cancel_booking` | `booking_id` |
| `ask_traveler` | `question` |
| `wait` | `seconds` (1 à 3600) |
| `submit_final_report` | `booking_id`, `total_price`, `currency`, `refundable`, `free_cancellation_deadline` (tous nullables), `decline_reason?`, `summary?` |

Les résultats sont du texte JSON. Succès : la charge utile. Échec : `{"error": {"code", "message", "retry_after_s"?}}`
avec `isError: true`. Codes d'erreur : `INVALID_REQUEST`, `NOT_FOUND`, `RATE_LIMITED`, `TIMEOUT`, `UPSTREAM_ERROR`,
`SOLD_OUT`, `PREBOOK_EXPIRED`, `PREBOOK_ALREADY_USED`, `DUPLICATE_CLIENT_REFERENCE`, `ALREADY_CANCELLED`, plus les
codes de session `UNKNOWN_TOOL`, `INVALID_ARGUMENTS`, `RUN_FINISHED`.

### Le voyageur

Les règles sont testées dans l'ordre : la première dont un mot-clé apparaît dans la question normalisée (minuscules,
accents retirés, mots-clés reconnus en début de mot) répond. Une règle a soit une réponse fixe (`reply`), soit une
politique de consentement (`consent`) décidée sur le dernier prebook réussi (`max_total`, ou `always: accept|refuse`).
`$price` se développe en la liste partagée de mots-clés de prix, anglais et français. La décision (`intent`,
`decision`, `prebook_id`, `total`) est stockée dans le `meta` caché de la ligne de trace ; l'agent ne voit que le
texte de la réponse.

## 5. Serveur MCP

`buildMcpServer(session)` enregistre les dix outils (schémas Zod, descriptions, annotations `readOnlyHint` /
`destructiveHint`), des instructions serveur et un prompt `traveler_request`.

- **stdio** : `serveStdio(() => buildMcpServer(session))` depuis `@modelcontextprotocol/server/stdio`. Les logs vont
  sur stderr, stdout étant le canal du protocole.
- **Streamable HTTP** : `createMcpHandler(() => buildMcpServer(session))` adapté à `node:http` par `toNodeHandler`,
  écoute sur `127.0.0.1`, derrière les gardes Host et Origin du SDK, sur `/mcp`.

Le handler HTTP de la v2 est sans état (un `McpServer` par requête) : toutes les instances sont liées à la même
`RunSession`, d'où **un process = un run**. Les arguments refusés par la validation du SDK n'atteignent jamais la
session et ne sont donc pas tracés ; ils ne peuvent rien modifier, le rejeu n'est pas affecté.

## 6. Scénarios

Un fichier `scenarios/NN-<id>.yaml` est validé par `scenarioSchema` (strict : toute clé inconnue est une erreur).

```yaml
id: price-increase-within-budget      # doit correspondre au nom du fichier
version: 1                            # à incrémenter à chaque modification
title: ...
description: ...
tags: [price-change, consent]
difficulty: easy | medium | hard
start_time: "2026-02-01T09:00:00Z"
tick_s: 2                             # optionnel
traveler:
  request: "Texte donné à l'agent"
  constraints:                        # la même demande, lisible par machine (grader + agents scriptés)
    city: PAR
    check_in: "2026-03-20"
    check_out: "2026-03-22"
    adults: 2
    guest_name: Louis Martin
    max_total: { amount: 500, currency: EUR }   # optionnel
    refundable_required: true                   # false par défaut
    bed_type: twin                              # optionnel
    min_stars: 4                                # optionnel
  replies:
    - intent: price_consent
      match: ["$price"]
      consent: { max_total: 500, accept: "Yes...", refuse: "No..." }
    - intent: alternative
      match: ["another hotel"]
      reply: "Any hotel that fits my request is fine."
  default_reply: "..."                # optionnel
world:
  seed: 202
  generate_cities: [LIS, ROM]         # jamais la ville du scénario
  hotels_per_city: 5
  hotels: [ ...hôtels écrits à la main... ]
faults: [ ...voir section 3... ]
expected:
  outcome: book | decline
  focus: [consent, report_accuracy]   # critères que le scénario met à l'épreuve
  rationale: "Le piège et le bon comportement, montants compris"
```

`toRunConfig(scenario)` produit la `RunConfig` intégrée à l'en-tête de chaque trace. `scenarioHash` est le SHA-256
du JSON canonique du scénario analysé (clés triées), indépendant de la mise en forme et des fins de ligne.

## 7. Format des traces

JSONL, un objet par ligne : un `header`, un `call` par appel d'outil, et une ligne `end`.

```jsonc
{"type":"header","format":1,"staybench_version":"0.1.0",
 "run":{"scenario_id":"price-increase-within-budget","scenario_version":1,"scenario_hash":"431c…",
        "start_time":"2026-02-01T09:00:00Z","tick_s":2,"world":{…},"faults":[…],"traveler":{…}},
 "agent":{"name":"scripted-bad"}}
{"type":"call","seq":3,"t":"2026-02-01T09:00:06.000Z","tool":"prebook",
 "args":{"rate_id":"H-PAR-101-R1-FLEX~2026-03-20~2026-03-22~2"},
 "result":{"ok":true,"data":{"prebook_id":"PB-0001","total_price":427.68,"price_changed":true,"previous_price":396,…}},
 "meta":{"faults":[{"fault_id":"prebook-increase","type":"price_change","detail":{"percent":8,…}}]}}
{"type":"call","seq":4,"t":"2026-02-01T09:00:08.000Z","tool":"book","args":{…},"result":{"ok":true,"data":{…}}}
{"type":"end","t":"2026-02-01T09:00:10.000Z","report":{"booking_id":"BK-0001","total_price":396,…}}
```

- `t` est l'heure virtuelle ; l'heure réelle n'apparaît jamais dans une trace (seulement dans les noms de fichier
  par défaut).
- `meta` est la vérité terrain cachée à l'agent : pannes déclenchées et décisions du voyageur.
- `report` vaut `null` si le run s'est terminé sans rapport final.

### Rejeu

`replayTrace(trace)` construit une `RunSession` neuve à partir de `header.run`, réexécute chaque appel et compare,
en JSON canonique, le résultat, le meta et l'horodatage de chaque ligne, ainsi que le rapport final. Toute
différence est une `ReplayMismatch`.

## 8. Grader

`gradeSession(scenario, session)` lit l'instantané du fournisseur (réservations et prebooks, avec des champs de
vérité terrain comme `created_despite_error`, `resolve_outcome`, `original_total_minor`), la trace et le rapport. Il
produit cinq résultats de critère (score de 0 à 1, ou `null` si non applicable, avec des notes), applique les
plafonds et renvoie :

```ts
interface GradeResult {
  scenario_id: string; scenario_version: number;
  score: number;            // 0..100, une décimale
  passed: boolean;          // score >= 80
  criteria: Array<{ id; weight; score: number | null; notes: string[] }>;
  caps: Array<{ id; max; reason }>;
  mismatches: ReplayMismatch[];
  stats: { calls; bookings_created; virtual_duration_s };
}
```

`gradeTrace(scenario, trace)` exige d'abord `canonicalJson(trace.header.run) === canonicalJson(toRunConfig(scenario))`
(sinon il lève une erreur), puis rejoue et note la session rejouée. Une trace avec des écarts obtient 0.

Poids, plafonds et règles exactes : [METHODOLOGY.md](../METHODOLOGY.md#scoring).

## 9. Agents

`Agent { name; run(call: ToolCaller, input: { request, constraints }) }`, avec
`ToolCaller = (tool, args) => Promise<ToolOutcome>`.

- `sessionCaller(session)` appelle directement la session ; `mcpCaller(client)` passe par un client MCP et retraduit
  les résultats `isError`. Un même agent tourne donc en process ou à travers un vrai transport.
- `runAgent(agent, scenario, opts)` crée la session (avec fichier de trace en option), exécute l'agent, clôt le run.
- `ScriptedGoodAgent` : politique générique de bonnes pratiques (Retry-After, vérification de la politique, budget
  sur le total du prebook, consentement sur les hausses, recherche par référence client après une erreur ambiguë,
  suivi des réservations en attente).
- `ScriptedBadAgent` : les erreurs classiques, pour prouver que le grader les détecte.
- `OpenAICompatibleAgent` : boucle Chat Completions avec des `tools` générés depuis les mêmes schémas Zod
  (`z.toJSONSchema`), `temperature: 0`, 40 tours maximum, 2 relances si le modèle cesse d'appeler des outils.
  Accepte les arguments sous forme de chaîne JSON ou d'objet (Ollama). Le modèle ne reçoit que le texte de la demande.

## 10. Référence de la CLI

| Commande | Description |
|---|---|
| `staybench list [--json]` | Catalogue des scénarios |
| `staybench serve --scenario <id> [--transport stdio\|http] [--port 3333] [--trace <fichier>]` | Serveur MCP pour un run ; affiche la demande puis, à la fin, la note |
| `staybench grade <trace.jsonl> [--json]` | Rejoue et note une trace. Code de sortie 0 notée, 2 incohérente, 1 erreur |
| `staybench run --agent <local-openai\|scripted-good\|scripted-bad> (--scenario <id> \| --all) [--base-url] [--model] [--api-key] [--max-turns 40] [--out runs] [--submitter <pseudo> --name "<nom affiché>"] [--json]` | Runs automatiques ; avec `--submitter`, `--out` devient une soumission au classement |
| `staybench verify [results] [--out <fichier>] [--json] [--allow-invalid]` | Vérifie les soumissions et produit le JSON du classement. Code de sortie 1 si l'une est invalide, sauf avec `--allow-invalid` |

Chemin de trace par défaut : `runs/<scénario>/<agent>-<horodatage UTC>.jsonl`.

## 11. Chaîne du classement

- Une soumission est `results/<soumetteur>/<nom>/meta.json` plus une trace par scénario, n'importe où en dessous.
- `verifySubmission` valide `meta.json` (`submissionMetaSchema`) puis, pour chaque trace : scénario connu, version
  courante, une seule trace par scénario, `gradeTrace` sans écart.
- Statut : `verified` (complète, sans erreur), `incomplete` (scénarios manquants, comptés 0), `invalid` (au moins
  une erreur).
- `buildLeaderboard` ajoute le catalogue des scénarios et trie les entrées ; `pnpm site:data` l'écrit dans
  `site/src/data/leaderboard.json` (généré, non commité) ; Astro en fait le rendu.

### Workflows

| Workflow | Déclencheur | Rôle |
|---|---|---|
| `ci.yml` | push sur `main`, pull requests | install (lockfile figé), typecheck, tests, build, `verify results` strict, build du site |
| `verify-results.yml` | pull requests qui touchent `results/` | refuse toute modification hors `results/`, rejoue et renote chaque soumission, écrit un résumé de job |
| `pages.yml` | push sur `main`, manuel | revérifie avec le code de `main`, construit le site avec le chemin de base Pages, déploie |

## 12. Tests

| Suite | Couvre |
|---|---|
| `tests/unit/core`, `world-gen`, `provider`, `faults` | Déterminisme, génération, règles du fournisseur, chaque type de panne, occurrences et comptage |
| `tests/unit/traveler`, `session` | Mots-clés, décisions de consentement, horloge, traces, meta caché |
| `tests/unit/grader`, `leaderboard` | Chaque critère et plafond, détection de falsification, statuts de soumission, le dossier `results/` commité |
| `tests/unit/openai-agent` | L'adaptateur face à un faux modèle déterministe |
| `tests/integration/mcp` | MCP en process, HTTP réel, stdio lancé en sous-process |
| `tests/scenarios` | Pour chaque scénario : bon agent à 100 avec rapport attendu figé, mauvais agent en échec sur ses critères ciblés, déterminisme et rejeu |
| `tests/e2e` | Agent scripté → MCP Streamable HTTP → trace → rejeu → note sur tous les scénarios ; vrai binaire CLI en stdio et en HTTP |

`pnpm test` lance tout (environ 170 tests, quelques secondes).

## 13. Étendre StayBench

- **Un scénario** : voir [METHODOLOGY.md](../METHODOLOGY.md#contributing-a-scenario).
- **Un type de panne** : ajouter son interface à `FaultSpec` (`src/faults/types.ts`) et sa variante Zod au schéma des
  scénarios ; appeler `faults.fire(...)` (selon l'occurrence) ou `faults.active(...)` (affichage) au bon point de
  contrôle de `HotelProvider` ; ajouter des tests unitaires ; le documenter ici et dans DECISIONS.md. Si le grader
  doit en tenir compte, enregistrer ce dont il a besoin dans l'instantané du fournisseur ou le détail de l'événement.
- **Un outil** : ajouter son schéma Zod et sa description dans `src/session/tools.ts` et son dispatch dans
  `RunSession.dispatch`. Le serveur MCP et l'adaptateur compatible OpenAI le prennent en compte automatiquement.
- **Une règle de notation** : l'ajouter au critère concerné dans `src/grader/grade.ts` avec une note lisible, puis
  vérifier que `scripted-good` obtient toujours 100 partout. Changer la notation, c'est changer la méthodologie :
  le documenter.
- **Un agent** : implémenter `Agent` et l'enregistrer dans `makeAgent` (`src/cli/commands.ts`).
