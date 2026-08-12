---
id: code-elision
kind: historical-plan
status: done
updated: 2026-08-12
archived: 2026-08-12
areas:
  - front-end
  - mcp-server
  - converted
  - docs
---

# Fase di elisione e semplificazione

> **Archived:** the implementation and documentation tranches landed on
> `master` through PR #33. This plan is retained as execution evidence and is
> not an active assignment source.

**Stato:** decisioni D1/D3/D4/D5/D7 implementate; review locale approvata;
CI remota verde su [PR #33](https://github.com/LucaSforza/NNModelling/pull/33)
(sei gate, run
[30703415396](https://github.com/LucaSforza/NNModelling/actions/runs/30703415396));
Milestone B esplicitamente approvata dall'utente e in avvio

**Data:** 2026-08-01

**Emendamento di accettazione utente (Milestone A):** la matrice espansa
obbligatoria è soltanto `mninst` + `autoencoder_mnist`; nessun modello
Transformer e nessun modello con join non commutativo richiesto. D2 → #31,
D6 → #30, D8 → #32 (vedi T2 e sezione 7).

**Approvazione Milestone B:** la seconda approvazione esplicita è stata
concessa; le Tranche 1-5 sono autorizzate e la Milestone B inizia dalla
Tranche 1. La PR #33 resta aperta: non è stato richiesto o effettuato alcun
merge e push/pull request richiedono ancora un'autorizzazione separata.

**Risultati Milestone A:**
[evidence/milestone-a-results.md](evidence/milestone-a-results.md)

**Vincolo di esecuzione:** l'approvazione di questo piano è avvenuta; le tranche
procedono secondo il contratto di orchestrazione neutrale della sezione 9.
Nessuna modifica fuori perimetro o non autorizzata deve essere introdotta.

## 1. Obiettivo

Ridurre il codice e la superficie di manutenzione di NNModelling senza cambiare
il comportamento osservabile, i formati supportati o i confini architetturali.
La fase deve eliminare codice morto, compatibilità interne ormai inutilizzate e
astrazioni rimaste dopo precedenti refactoring. Se un'elisione richiede un
refactoring, il refactoring deve essere il più piccolo necessario per rendere
possibile la rimozione.

Il risultato atteso non è un numero arbitrario di righe cancellate. Ogni
rimozione deve avere una prova di inutilizzo e deve lasciare il repository con
un saldo negativo di codice prodotto nella tranche interessata. Test aggiunti
per proteggere un comportamento esistente e aggiornamenti documentali non
contano nel saldo.

La fase è divisa in due milestone con un gate esplicito fra loro:

1. **Milestone A — testing foundation:** correggere la strategia di test,
   portare in CI le pipeline rilevanti e verificare le invarianti oggi mancanti;
2. **Milestone B — elisione:** iniziare le rimozioni soltanto dopo che la
   Milestone A è verde, revisionata e nuovamente approvata dall'utente.

La Milestone A può richiedere correzioni di prodotto quando un nuovo test
dimostra una violazione di un contratto già esistente. Queste correzioni devono
essere minime e non possono essere usate per anticipare il refactoring di
elisione.

## 2. Invarianti architetturali

La fase deve preservare questi vincoli:

1. Il browser rimane l'unica fonte di verità per lo stato del diagramma.
2. `mcp-server/` rimane un proxy RPC sottile e non acquisisce una copia di
   `DiagramCore`.
3. Il percorso `Stereotypes -> DiagramCore -> NNTree -> convert.py -> Hydra`
   non cambia semanticamente.
4. I nomi e gli schemi pubblici degli strumenti MCP non cambiano.
5. I diagrammi sorgente correnti e la normalizzazione degli handle dei vecchi
   diagrammi continuano a funzionare.
6. Undo/redo, aggiornamento reattivo, type inference e auto-fit dopo mutazioni
   RPC continuano a essere eseguiti una sola volta per mutazione logica.
7. Il backend di training remoto, gli executor e il formato dei model package
   non vengono ridisegnati in questa fase.
8. Non vengono aggiunte dipendenze per giustificare o realizzare le rimozioni.
9. Una primitiva semantica generica può essere implementata nel motore, ma non
   può dipendere dal nome dello stereotype. I dati selezionano l'operazione;
   l'interprete ne implementa la semantica.
10. Nessuna tranche di elisione può iniziare finché i gate di integrazione e
    backend definiti in questo documento non sono verdi in CI.

## 3. Fuori ambito

- Nuove funzionalità, modifiche visuali o redesign dell'editor.
- Spostamento di responsabilità tra frontend, MCP server e backend Python.
- Modifiche distruttive ad artefatti locali, job di training, dataset, ambienti
  virtuali o file ignorati da Git.
- Cancellazione automatica di documenti storici, report accademici o diagrammi
  di esempio: questi elementi richiedono una decisione separata del
  proprietario.
- Pulizia di branch o riferimenti Git.
- Il lavoro non integrato del branch `observable`.
- Rimozione di componenti attivi solo perché piccoli o raramente usati, in
  particolare operatori Python, dataset, model package, training UI, barrel
  usati da TypeDoc ed espressioni del type system.

## 4. Metodo di prova

Una rimozione può entrare in implementazione soltanto se supera tutti i gate
applicabili:

1. **Prova statica:** nessun call site/import/consumer nel codice, nei test,
   nelle configurazioni e nella documentazione eseguibile.
2. **Prova di contratto:** il simbolo non fa parte di un contratto pubblico
   intenzionale. I package `private` non sono automaticamente considerati
   pubblici, ma gli entry point di TypeDoc e gli schemi MCP sì.
3. **Prova su fixture:** nessun esempio o formato persistito richiede il
   percorso da eliminare.
4. **Baseline verde:** i test pertinenti passano prima della tranche. Un test
   già rosso viene registrato e non può essere attribuito alla tranche.
5. **Differenziale verde:** gli stessi controlli passano dopo la tranche.
6. **Revisione:** il revisore selezionato conferma che non è stata eliminata
   compatibilità necessaria e che il refactoring non introduce un'astrazione
   sostitutiva più complessa.

In caso di dubbio, il codice rimane. Questa fase privilegia falsi negativi
(mancata rimozione) rispetto a falsi positivi (rimozione regressiva).

## 5. Risultati dell'ispezione preliminare

L'ispezione preliminare è stata svolta sul branch `master`, commit `0d3e2d4`
(working tree pulito al momento della progettazione). In avvio della Milestone
B l'audit dei candidati è stato ribasato sul HEAD pre-B corrente della PR #33
— commit `dd05b35` sul branch `milestone-a-testing-foundation`, working tree
pulito — che include i 22 commit della Milestone A. Tutti i candidati H1-H6 e
R1-R3 sono stati riconfermati sul nuovo HEAD: nessuno dei cambiamenti di test,
CI e fixing della Milestone A ha creato o riattivato consumer per le API
candidate, e i punti di rimozione descritti in 5.1 e 5.2 sono ancora presenti
nel codice (verificati su `dd05b35`). Al momento di ogni implementazione lo
stato Git deve essere ricontrollato per proteggere modifiche utente
sopravvenute.

### 5.1 Candidati ad alta confidenza

| ID | Area | Candidato | Evidenza attuale | Trattamento proposto |
| --- | --- | --- | --- | --- |
| H1 | MCP/workspace | Dipendenza `@nnmodelling/front-end` in `mcp-server/package.json`, export map in `front-end/package.json` e `mcp-server/src/vite-types.d.ts` | Il server non importa più il package frontend; sono residui dell'architettura con stato duplicato | Rimuovere insieme e rigenerare solo il lockfile necessario |
| H2 | MCP | `CompilationFailedError` e `MCPServerError.toJSON()` in `mcp-server/src/errors.ts` | Non hanno consumer; gli errori usati sono conversion, training e inference | Rimuovere senza cambiare il payload degli errori MCP |
| H3 | Frontend | Context stringa `"diagram"`, relativo import `DiagramCore` e commento TODO morto in `FlowCanvas.svelte` | Il consumer attuale usa esclusivamente `DIAGRAM_CONTEXT_KEY` | Rimuovere; nessun cambiamento visuale |
| H4 | Frontend | Getter `layerStereotypes` e `joinStereotypes` in `DiagramCore` | Nessun call site nel codice | Rimuovere dopo una ricerca finale sull'intero repository |
| H5 | Frontend | Campo top-level `expr` di `StereotypeJson`/`StereotypeCore` | Rimosso dagli stereotype; `Einsum.params.expr` è un parametro diverso e va preservato | Rimuovere campo e assegnazione, mantenendo il parametro Einsum |
| H6 | Frontend | Wrapper `Stereotype` in `front-end/src/stereotype.ts` | Delega integralmente a `StereotypeCore` ed è costruito solo tramite cast | Usare direttamente `StereotypeCore`, poi eliminare il wrapper |

### 5.2 Candidati che richiedono refactoring controllato

| ID | Area | Candidato | Rischio | Decisione progettuale |
| --- | --- | --- | --- | --- |
| R1 | Frontend | `EventBus`, eventi di dominio non consumati, sequence number, ring buffer, `onAny`, replay e transaction id | `graph_changed` alimenta reattività, type inference e auto-fit | Sostituire l'event-sourcing residuo con un solo segnale tipizzato di cambiamento del grafo. Non introdurre un bus generico sostitutivo. Conservare sottoscrizione/unsubscribe sincroni e i due consumer correnti |
| R2 | Frontend/MCP | `StereotypeCore.loadFromDirectoryNode()` | Il loader usa `require` ed è incompatibile con ESM; il server possiede già una proiezione locale ESM-safe | Eliminare il loader Node dal frontend. Mantenere il loader locale MCP, documentandolo come proiezione intenzionale dei soli campi richiesti dal server; non creare un nuovo package condiviso |
| R3 | Type system | `computed.formula`, `computed.args`, `TypeSignature.constraints` e ramo `LEGACY` | Fixture o test potrebbero ancora formalizzare la vecchia forma dichiarativa | Verificare tutti gli stereotype e i test. Se non esistono consumer, mantenere solo `computed.expr` e `join`/`subflow`; altrimenti separare una migrazione esplicita e non cancellare in questa fase |

`resolveConcatOutput()` non è un candidato di rimozione in questa fase. La
decisione approvata durante la progettazione è di mantenerlo come primitiva
semantica generica del type engine: `Concat.json` seleziona dichiarativamente
`join.action: "concat"` e `dim_expr`, mentre il motore implementa rank,
uguaglianza delle dimensioni non concatenate e somma sull'asse. La funzione
non deve contenere controlli sul nome `Concat` o sulla classe Python. La
documentazione deve descrivere correttamente questo confine come
**data-selected**, non come operazione interamente **data-defined**.

### 5.3 Stato reale dell'integration testing (evidenza pre-Milestone A)

> **Evidenza storica:** questa sottosezione fotografa lo stato dell'integration
> testing osservato al momento della progettazione (baseline `0d3e2d4`),
> *prima* della Milestone A. Le conclusioni qui riportate non descrivono più lo
> stato corrente del repository: la Milestone A ha costruito la testing
> foundation documentata in
> [evidence/milestone-a-results.md](evidence/milestone-a-results.md) — marker pytest `fast`/
> `service`/`e2e`/`legacy_e2e`, Valkey reale, job backend E2E serializzato e CI
> a sei gate — affrontando i punti 3-6 qui sotto. La sezione resta nel piano
> come motivazione storica delle tranche di testing.

L'esplorazione dei test condotta in fase di progettazione aveva concluso:

1. I tier Vitest `smoke`, `convert`, `forward`, `train` e `infer` eseguono
   realmente gli script Python; non simulano conversione, modello o training.
2. `infer.test.ts` contiene un percorso sorgente completo
   `diagramma -> NNTree -> convert.py -> main.py -> infer.py`, ma riguarda solo
   tre modelli MNIST marcati `trainingSmoke` e non viene eseguito dalla CI.
3. Il job Python della CI esegue training reali tramite `test_main.py` e
   `test_infer.py`, ma parte da fixture NNTree e chiama direttamente gli script:
   non attraversa API, coda, scheduler o executor del backend remoto.
4. FastAPI viene testato in-process con ASGI transport. Questo è adeguato per il
   contratto applicativo HTTP, ma la CI non avvia Valkey e usa store, stream ed
   executor fake.
5. Non esiste un test unico del percorso produttivo
   `POST /jobs -> persistenza Valkey -> claim -> LocalExecutor -> training ->
   safetensors -> wheel -> download -> import -> predict`.
6. Il client MCP del training è testato con HTTP simulato e non dimostra la
   parità di autenticazione con il client browser.

#### Copertura attuale delle invarianti

| Invariante | Stato attuale | Lacuna principale |
| --- | --- | --- |
| Import del diagramma e compilazione NNTree | Coperta strutturalmente per gli esempi del manifest | Il type check non è eseguito su tutti gli esempi; ciclo top-level e golden contract non sono garantiti |
| Generazione Hydra | `convert.py` reale e test Python dettagliati | Il tier Vitest controlla soprattutto la presenza dei file e accetta anche un NNTree malformato |
| Costruzione e forward del modello | Reale con tensori sintetici | Forma attesa e dtype non sono dichiarati nel manifest; alcuni diagrammi attention/non commutativi non eseguono il forward |
| Ordinamento degli input dei join | Coperto da unit test Python | Non coperto end-to-end da un join non commutativo compilato da diagramma |
| Backward e aggiornamento parametri | Non coperti | Nessuna asserzione su gradienti, loss finita o variazione dei pesi |
| Training completo | Un'epoca reale in test locali e Python CI | Si verificano soprattutto exit code e presenza del file, non le invarianti numeriche |
| Checkpoint e reload | Il peso prodotto viene caricato dall'infer tier | Nessuna equivalenza dell'output prima/dopo reload; safetensors e checkpoint non sono entrambi verificati sistematicamente |
| Inferenza e artefatti | JSON di predizione verificato superficialmente | Mancano cardinalità, forma/dtype, immagini e corrispondenza con il dataset |
| API e lifecycle job | Coperti con app reale e fake di infrastruttura | Nessun servizio Valkey o executor produttivo nel test |
| Priority/FIFO e claim atomico | Coperti sullo store in-memory | Il Lua claim e gli stream Valkey non sono testati realmente o in concorrenza |
| Wheel esportata | Exporter testato separatamente | La wheel scaricata dall'API è finta e non proviene dal job appena eseguito |
| Autenticazione browser/MCP | Client testati separatamente con mock | Nessun contract test contro un backend autenticato reale |
| Riproducibilità | Seed presenti nel codice | Nessuna prova automatizzata di equivalenza deterministica |
| Errori negativi | Copertura parziale | Mancano almeno NNTree invalido, ciclo top-level, pesi mancanti e fallimento del job reale |

La conclusione è che il progetto possiede molte parti di integration testing,
ma non una garanzia continua e coerente delle invarianti necessarie per una
fase sottrattiva. La copertura deve essere corretta prima di usare i test come
rete di sicurezza per l'elisione.

### 5.4 Candidati opzionali, esclusi dal nucleo

Questi elementi possono essere affrontati soltanto con un'approvazione
specifica successiva:

- esempi `mcp_mnist_classifier.json` non presenti nel manifest;
- `converted/TODO.md` e `converted/TODO-stereotype-extensions.md`;
- report e review storici sotto `docs/report/` e `docs/reviews/`;
- convergenza di `docs/design/` nella directory canonica `docs/designs/`;
- artefatti accademici e backup sotto `analysis/`;
- sostituzione del README template in `front-end/`;
- metadata placeholder in `converted/pyproject.toml`;
- ampliamento dei `.gitignore` per cache e ambienti locali.

Sono attività di igiene, documentazione o ownership, non prove di codice morto,
e non devono gonfiare il diff principale.

## 6. Piano di esecuzione proposto

Ogni tranche è indipendente, deve essere revisionabile e termina con un gate
go/no-go. Non si procede alla tranche successiva se quella corrente non è
verde.

### Milestone A — Testing foundation (bloccante)

Questa milestone deve essere completata prima di modificare codice con finalità
di elisione. Le sue modifiche possono riguardare test, fixture, CI e correzioni
minime dei difetti dimostrati dai nuovi test. Non possono rimuovere API o
comportamenti candidati nelle sezioni 5.1 e 5.2.

#### T0 — Baseline e inventario definitivo

**Obiettivo:** congelare il comportamento e convertire i candidati preliminari
in un inventario verificato.

**File/aree:** intero repository in sola lettura; output di test non versionati.

**Attività:**

1. Ricontrollare `git status` e registrare commit e modifiche utente da
   preservare.
2. Eseguire i controlli attualmente disponibili e registrare quali sono locali,
   quali sono in CI e quali vengono saltati.
3. Per ogni candidato, registrare definizione, consumer, fixture e contratto.
4. Misurare righe di codice prodotto per area prima delle modifiche, senza
   imporre un target quantitativo.
5. Scartare dall'inventario qualsiasi candidato non dimostrato.

**Accettazione:** baseline registrata; matrice keep/remove motivata; nessun file
prodotto modificato.

#### T1 — Tassonomia, marker e CI

**Obiettivo:** rendere espliciti costo e responsabilità di ogni classe di test,
evitando sia skip silenziosi sia quattro training duplicati non coordinati.

**File previsti:**

- `.github/workflows/ci.yml`
- `front-end/package.json`
- `front-end/vitest.integration.config.ts`
- `converted/pyproject.toml` o configurazione pytest equivalente
- helper di integrazione strettamente necessari

**Attività:**

1. Definire gate distinti `unit`, `integration`, `service` ed `e2e/slow`.
2. Portare in CI almeno `smoke`, `convert` e `forward` del frontend.
3. Introdurre marker pytest reali, evitando che la selezione fast/slow dipenda
   dalla conoscenza implicita dei nomi file.
4. Creare un job CI serializzato e obbligatorio per i percorsi E2E canonici.
5. Rendere esplicito il motivo di ogni skip e fallire quando un prerequisito
   obbligatorio della CI non è disponibile.
6. Conservare artefatti e log del job E2E in caso di fallimento, senza
   versionarli.

**Accettazione:** la CI mostra separatamente test veloci, integrazione senza
training, servizi reali ed E2E; nessun tier richiesto è escluso dal workflow;
la selezione locale riproduce quella CI.

#### T2 — Invarianti dal diagramma al modello

**Obiettivo:** trasformare la pipeline esistente in una prova semantica, non
soltanto in una prova di assenza di crash.

**File previsti:**

- `examples/manifest.json`
- `front-end/src/__tests__/integration/helpers.ts`
- test `smoke`, `convert`, `forward`, `train`, `infer` e `model-validation`
- test Python di conversione/runtime solo quando la stessa invariante appartiene
  al backend

**Invarianti obbligatorie:**

1. La matrice obbligatoria (`mninst` e `autoencoder_mnist`) esegue import,
   type check senza errori hard e compilazione NNTree con riferimenti validi.
   ~~Tutti i diagrammi sorgente del manifest~~ **SUPERSEDUTO:** gli errori
   hard preesistenti degli altri esempi del manifest sono rimandati a #30 (D6)
   e non sono un gate della Milestone A.
2. Il manifest dichiara forma e dtype di input e output attesi; il forward li
   verifica esattamente, insieme all'assenza di NaN/Inf.
3. ~~Almeno un diagramma con join non commutativo attraversa compilazione e
   forward, verificando l'ordinamento per targetHandle.~~ **SUPERSEDUTO
   dall'emendamento di accettazione utente:** nessun modello con join non
   commutativo è richiesto nella Milestone A; l'ordinamento per `targetHandle`
   resta coperto dagli unit test Python esistenti.
4. Un modello canonico esegue almeno un vero backward: loss e gradienti sono
   finiti, almeno un gradiente è non nullo e almeno un parametro cambia dopo
   l'optimizer step.
5. Il training E2E produce gli artefatti attesi; il formato sicuro dei pesi è
   caricabile e l'output in `eval()` è equivalente prima e dopo il reload sullo
   stesso input deterministico.
6. L'inferenza verifica schema, cardinalità e forma delle predizioni e il
   dtype sul tensore prima della serializzazione JSON, che non lo conserva.
   ~~...e dtype delle predizioni...~~ **SUPERSEDUTO (solo artefatto JSON):** il
   metadata dtype dell'artefatto JSON è rimandato a #32 (D8). Il percorso
   immagini viene verificato per il dataset che lo supporta.
7. I casi negativi includono almeno ciclo top-level, parametro invalido e pesi
   mancanti. ~~NNTree malformato~~ **SUPERSEDUTO:** il comportamento di
   `convert.py` su un NNTree strutturalmente invalido è caratterizzato in
   `convert.test.ts`, ma la correzione è rimandata a #31 (D2).

Non è richiesto che la loss diminuisca in una singola epoca: sarebbe
un'asserzione fragile. Sono invece obbligatorie loss finita, backward valido e
modifica effettiva dei parametri.

**Accettazione:** un diagramma sorgente canonico della matrice obbligatoria
(`mninst` o `autoencoder_mnist`) attraversa realmente
`type check -> NNTree -> Hydra -> forward/backward -> training -> reload ->
inference`; gli esempi della matrice coprono type check, compilazione e le
invarianti di forma dichiarate per il loro tier. ~~gli altri esempi coprono
almeno type check, compilazione e le invarianti di forma dichiarate per il
loro tier~~ **SUPERSEDUTO:** gli altri esempi con errori hard preesistenti
sono rimandati a #30 (D6).

#### T3 — Infrastruttura backend reale

**Obiettivo:** verificare i componenti per i quali gli store e gli executor
fake non sono una prova sufficiente.

**File/aree previste:**

- workflow CI con servizio Valkey isolato
- test di `ValkeyJobStore` e `ValkeyAuthStore`
- test di scheduler, stream eventi ed executor
- configurazione temporanea e fixture backend

**Invarianti obbligatorie:**

1. Persistenza round-trip di job, autenticazione ed eventi su Valkey reale.
2. Ordinamento priority/FIFO e rimozione dalla coda sul percorso Valkey.
3. Claim atomico sotto richieste concorrenti: un job può essere assegnato una
   sola volta.
4. Cursor degli stream, inclusi più di 1.000 eventi, con ID Valkey reali.
5. Recovery dopo restart su stato persistito e coerenza degli eventi terminali.
6. `can_run`, comando, directory artefatti, heartbeat e cancellazione degli
   executor reali sono coperti al livello appropriato; Slurm non richiede un
   cluster reale, ma parsing e comandi devono essere contract-tested.

FastAPI può continuare a essere chiamato in-process tramite ASGI transport: non
serve avviare Uvicorn per dimostrare la logica applicativa. Valkey e almeno il
percorso di successo di `LocalExecutor`, invece, devono essere reali.

**Accettazione:** la CI avvia Valkey come servizio, esercita store/auth reali e
dimostra atomicità e persistenza; i fake restano soltanto per errori difficili
da produrre deterministicamente.

#### T4 — Job remoto end-to-end

**Obiettivo:** coprire una singola volta, senza monkeypatch dei componenti
centrali, il percorso produttivo di un job inviato.

**Percorso richiesto:**

```text
source diagram / NNTree verificato
  -> POST /jobs autenticato
  -> ValkeyJobStore
  -> scheduler claim
  -> LocalExecutor
  -> main.py
  -> weights.safetensors
  -> build_model_wheel
  -> GET /jobs/{id}/package
  -> verifica sha256
  -> install/import isolato
  -> load_model().predict()
```

**Invarianti obbligatorie:**

- transizioni `queued -> running -> succeeded` ed eventi coerenti;
- configurazione e artifact root corretti;
- training reale su un dataset deterministico e piccolo;
- wheel realmente prodotta dal job, non creata a mano dal test;
- digest della wheel coerente con il manifest;
- package installabile/importabile e predizione con forma/dtype attese;
- ownership e autenticazione applicate anche al download;
- parità del contratto di autenticazione tra browser e client MCP.

Il dataset E2E deve essere piccolo, deterministico e disponibile nel repository
o come fixture importabile, così il gate non dipende dalla rete. I test separati
su MNIST/Enron possono restare smoke specifici, ma non devono essere l'unica
prova del percorso produttivo.

**Accettazione:** il job E2E passa in un ambiente pulito e serializzato senza
fake di store, executor, exporter o download. Gli unici stub ammessi sono
integrazioni esterne non essenziali, per esempio W&B online o un cluster Slurm.

#### T5 — Riparazione dei contratti scoperti

**Obiettivo:** rendere verdi i nuovi test correggendo soltanto difetti di
contratti già stabiliti.

**Difetti già evidenziati da formalizzare con test prima della correzione:**

- il client MCP deve poter autenticare le richieste verso il backend come il
  client browser;
- un NNTree strutturalmente invalido non deve produrre silenziosamente una
  configurazione apparentemente valida;
- un ciclo top-level non deve essere accettato come compilazione riuscita;
- una versione di schema non supportata deve essere rifiutata esplicitamente;
- artefatti mancanti o corrotti devono produrre stato ed evento di fallimento
  coerenti.

Qualsiasi finding che richieda una nuova policy, per esempio una allowlist Hydra
più restrittiva, viene presentato all'utente come decisione separata e non viene
inserito implicitamente nell'hardening dei test.

**Accettazione della Milestone A:** tutti i gate della sezione 7 sono verdi;
gli implementatori riportano evidenza concreta; i revisori selezionati
approvano; viene presentato all'utente un report con tempi, copertura delle
invarianti e rischi residui. Solo dopo una seconda approvazione esplicita può
iniziare la Milestone B.

### Milestone B — Elisione

La Milestone A è completata, revisionata e nuovamente approvata dall'utente:
le tranche seguenti sono autorizzate e la Milestone B inizia dalla Tranche 1.

**Regola di esecuzione:** la Milestone B usa task isolati con contesto fresco,
perimetro di scrittura esplicito, verifica e revisione. Ogni task termina con un
handoff verificabile all'orchestratore; commit, push e pull request restano
responsabilità dell'orchestratore e richiedono le autorizzazioni applicabili.
Il contratto completo è nella sezione 9.

### Tranche 1 — Residui MCP e superficie workspace

**Obiettivo:** completare l'elisione dei residui della vecchia dipendenza dal
core frontend.

**File previsti:**

- `mcp-server/package.json`
- `front-end/package.json`
- `mcp-server/src/vite-types.d.ts`
- `mcp-server/src/errors.ts`
- lockfile workspace, solo se modificato dal package manager

**Vincoli:** nessun cambiamento ai tool MCP, al protocollo WebSocket o ai tipi
di errore effettivamente usati.

**Accettazione:** H1 e H2 non hanno più definizioni o riferimenti; build e test
MCP verdi; build, check e test frontend verdi; saldo negativo di codice e
configurazione mantenuta.

### Tranche 2 — Stereotype e dead code frontend

**Obiettivo:** rimuovere wrapper, loader e API frontend senza consumer.

**File previsti:**

- `front-end/src/stereotype.ts`
- `front-end/src/Diagram.svelte.ts`
- `front-end/src/core/StereotypeCore.ts`
- `front-end/src/core/DiagramCore.ts`
- `front-end/src/FlowCanvas.svelte`
- test direttamente coinvolti, solo se necessari a preservare contratti

**Vincoli:** non duplicare il parser degli stereotype nel frontend; non spostare
il loader MCP nel browser; preservare `Einsum.params.expr` e il context a
simbolo.

**Accettazione:** H3-H6 e R2 rimossi; caricamento degli stereotype invariato;
creazione di moduli/join e caricamento diagrammi coperti dai test; nessuna
variazione visuale rilevata.

### Tranche 3 — Riduzione del sistema eventi

**Obiettivo:** eliminare l'event-sourcing residuo lasciando un solo contratto di
notifica necessario al browser.

**File previsti:**

- `front-end/src/core/EventBus.ts` (eliminazione attesa)
- `front-end/src/core/types.ts`
- `front-end/src/core/DiagramCore.ts`
- `front-end/src/Diagram.svelte.ts`
- `front-end/src/FlowCanvas.svelte`
- test di `DiagramCore`, RPC, undo/redo e reattività interessati

**Design:** `DiagramCore` espone una sottoscrizione dedicata ai cambiamenti del
grafo e una notifica sincrona protetta. Il payload viene mantenuto solo se un
consumer dimostrato lo usa; altrimenti la notifica non trasporta dati. Vengono
eliminati eventi specifici non osservati, buffer, sequenze, replay, catch-all e
transaction id. Non viene introdotta una nuova gerarchia di eventi.

**Vincoli:** una mutazione RPC deve ancora aggiornare gli array Svelte, eseguire
il type check e richiamare `fitView`; undo/redo e import devono notificare una
sola volta per operazione pubblica.

**Accettazione:** R1 completato; una sola notifica sincrona di cambiamento del
grafo, inviata una sola volta per operazione pubblica (mutazione RPC, undo/redo
e import inclusi); nessun `DomainEvent` o API di replay rimasta; test frontend
e MCP verdi (DiagramCore, RPC, undo/redo e reattività); smoke browser verificato
per create/connect/update, undo/redo e caricamento diagramma; nessun errore
console. La tranche modifica gli entry point TypeDoc (`front-end/src/core/index.ts`
e `front-end/src/sync/index.ts`), quindi deve superare anche il gate locale
della documentazione (sezione 7).

### Tranche 4 — Compatibilità interna del type system

**Obiettivo:** rimuovere esclusivamente le forme dichiarative pre-expression
che non hanno più producer o fixture.

**File previsti:**

- `front-end/src/conversion/tensortypes.ts`
- `front-end/src/conversion/typeEngine.ts`
- `front-end/src/core/StereotypeCore.ts`
- test del type system eventualmente ancora espressi nella forma legacy
- stereotype JSON solo se T0 trova forme legacy reali

**Vincoli:** nessun algoritmo corrente di inferenza viene riscritto;
`computed.expr`, join dichiarativi, subflow, advisories, dtype ed Einsum restano
invariati. `resolveConcatOutput()` resta una primitiva semantica generica e non
deve acquisire dipendenze dal nome dello stereotype.

**Accettazione:** nessun `formula`/`args` legacy o `constraints` deprecato nel
modello e nel motore; suite del type system e fuzz test verdi; esempi compilati
con lo stesso esito precedente. Se una fixture reale usa il formato, la
tranche viene rinviata invece di introdurre una migrazione non approvata.

### Tranche 5 — Allineamento documentale minimo

**Obiettivo:** fare in modo che la documentazione operativa descriva soltanto
l'architettura risultante.

**File previsti:** `AGENTS.md`, `docs2/source/typescript_api.rst` e documenti
architetturali che nominano API effettivamente rimosse.

**Contenuti attesi:**
- `docs2/source/typescript_api.rst` documenta oggi `EventBus` (emitter tipizzato
  con sequenza monotona), il dual loader di `StereotypeCore` (Vite + Node
  `fs`), i tipi `DomainEvent`, `WSSnapshotMessage`, `WSDeltaMessage` e
  `DeltaOperation` e il wrapper `Stereotype`: i riferimenti ai simboli rimossi
  dalle Tranche 2-4 vanno aggiornati o eliminati, mantenendo la pagina in linea
  con gli entry point TypeDoc reali (`front-end/typedoc.json`).
- `AGENTS.md` riporta conteggi di test pre-Milestone A ("293 tests passed,
  5 skipped" per i unit test frontend; "112 fast non-training Python tests" per
  la suite Python): vanno riallineati alla baseline reale registrata in
  `milestone-a-results.md` (329 unit frontend, 188 fast backend) o rimossi se
  non più di competenza del file.

**Vincoli:** niente cancellazione di archivi o report storici; i documenti
storici possono ricevere una nota di stato anziché essere riscritti.

**Accettazione:** nessuna istruzione operativa afferma l'esistenza di loader,
eventi, tipi delta o dipendenze rimossi; gate locale della documentazione verde
(`bash gendocs.sh` più `check`/`build` frontend, sezione 7).

## 7. Matrice di validazione

La Milestone A deve creare nomi di script e marker stabili per questi gate. I
comandi sotto rappresentano il contratto desiderato; dove uno script non esiste
ancora, T1 deve introdurlo senza nascondere i comandi effettivamente eseguiti.

### Gate veloci obbligatori

```bash
git status --short
pnpm --dir front-end run check
pnpm --dir front-end run test
pnpm --dir front-end run build
pnpm --dir mcp-server run build
pnpm --dir mcp-server run test
cd converted && uv run pytest src/tests/ -m fast -q
```

Il gate backend usa la selezione positiva `-m fast`: il marker è applicato
automaticamente da `conftest.py` a ogni test senza marker di gate esplicito e
la selezione non include mai la suite `legacy_e2e` (MNIST reale,
network-dependent), che un selettore negativo come `"not service and not e2e"`
includerebbe. `legacy_e2e` resta un comando manuale opzionale, fuori dalla CI
obbligatoria.

### Integrazione senza training obbligatoria

```bash
pnpm --dir front-end run test:integration:smoke
pnpm --dir front-end run test:integration:convert
pnpm --dir front-end run test:integration:forward
```

Questi tier devono essere eseguiti dalla CI su tutti gli esempi applicabili del
manifest. La mancanza del runtime Python nel job CI è un errore, non uno skip.

### Servizi reali ed E2E obbligatori

```bash
cd converted && uv run pytest src/tests/ -m service -q
cd converted && uv run pytest src/tests/ -m e2e -q
```

Il job `service` usa Valkey reale. Il job `e2e` è serializzato e contiene almeno
il percorso modello completo e il job remoto completo definiti in T2 e T4. I
nomi esatti dei file possono cambiare durante T1, ma la separazione semantica e
l'esecuzione CI sono criteri di accettazione.

Il percorso canonico training/reload/inference — loss finita, gradienti e
parameter update, produzione e caricamento dei pesi, equivalenza dell'output in
`eval()` prima e dopo il reload, schema/cardinalità/forma delle predizioni — è
coperto dal gate backend `-m e2e` della CI, che attraversa realmente
`main.py -> weights -> wheel -> install -> predict()`. I tier Vitest `train` e
`infer` restano disponibili localmente come opzione, ma non fanno più parte dei
gate obbligatori della Milestone B.

### Gate documentazione e browser

```bash
bash gendocs.sh
pnpm --dir front-end run check
pnpm --dir front-end run build
```

- **Nota sul gap TypeDoc preesistente:** `pnpm run docs` (root) non può essere
  usato come gate locale: il passo `docs:typedoc` fallisce con
  `Command "typedoc" not found` perché `typedoc` non è una dipendenza dichiarata
  di `front-end/` né del root e non esiste alcun binario nel workspace. In
  questa fase non viene aggiunta alcuna dipendenza per sanare il gap; la
  coerenza di `front-end/typedoc.json` e degli entry point
  (`front-end/src/core/index.ts`, `front-end/src/sync/index.ts`) è verificata
  con una revisione esplicita e manuale in ogni tranche che modifica export o
  barrel.
- Il gate locale della documentazione è quindi `bash gendocs.sh` (Sphinx con
  `-W`, include la pagina `typescript_api.rst`) più `check`/`build` del
  frontend; la build docs è obbligatoria quando cambiano entry point TypeDoc,
  `AGENTS.md` o documenti architetturali.
- Dopo la Tranche 3 è obbligatorio uno smoke browser-backed. Prima di modificare
  frontend va acquisita la baseline visuale richiesta dagli strumenti del
  repository; dopo il diff vanno controllati DOM, console e assenza di
  regressioni. L'orchestratore assegna questa verifica a un task fresco che
  possa usare lo skill browser-backed previsto dalle istruzioni del repository
  (sezione 9).
- Il browser smoke non sostituisce i test deterministici di T2-T4.

### Prove focalizzate

- ~~Tutti i diagrammi del manifest superano type check e compilazione.~~
  **SUPERSEDUTO dall'emendamento:** la matrice obbligatoria (`mninst`,
  `autoencoder_mnist`) supera type check e compilazione; gli altri esempi con
  errori hard preesistenti sono rimandati a #30 (D6).
- Un modello canonico supera forward, backward, parameter update, training,
  reload e inferenza con invarianti numeriche esplicite.
- Valkey reale supera persistenza, FIFO, atomic claim e stream cursor.
- Un job API reale produce e distribuisce la wheel realmente costruita.
- Browser e MCP presentano lo stesso contratto di autenticazione al backend.
- Nessuna importazione di `@nnmodelling/front-end` da `mcp-server/`.
- Nessun consumer delle API candidate prima della loro eliminazione.
- Un solo meccanismo di notifica del cambiamento grafo dopo la Tranche 3.
- Zero forme legacy negli stereotype prima della Tranche 4.
- Compilazione degli esempi e risultato del type check invariati.

## 8. Strategia di revisione e riparazione

1. T1-T5 vengono implementati e revisionati prima di qualsiasi tranche di
   elisione. I finding prodotti dai nuovi test vengono riparati e revisionati
   nella Milestone A.
2. Il passaggio alla Milestone B richiede evidenza dei gate verdi, approvazione
   dei revisori selezionati e una seconda approvazione esplicita dell'utente.
   **COMPLETATO:** gate CI verdi sul run
   [30703415396](https://github.com/LucaSforza/NNModelling/actions/runs/30703415396),
   review locale approvata e seconda approvazione esplicita concessa; la
   Milestone B inizia.
3. Le Tranche 1 e 2 possono formare un primo diff coerente ma restano unità di
   lavoro logicamente separabili.
4. Le Tranche 3 e 4 sono revisionate separatamente perché hanno rischi diversi:
   reattività browser e compatibilità del type system.
5. Ogni finding azionabile viene corretto dall'implementatore dell'area e
   seguito da un nuovo test mirato e da una nuova revisione.
6. Non si chiude una milestone con finding correggibili aperti.
7. Se una rimozione richiede una nuova funzionalità, una dipendenza o una
   migrazione di formato, viene estratta in un nuovo piano e non eseguita qui.

## 9. Contratto di orchestrazione neutrale

Il piano descrive capacità e confini, non provider, modelli o nomi di agenti.
Codex e OpenCode traducono i ruoli seguenti secondo le rispettive regole di
orchestrazione e le scelte esplicite dell'utente:

- `implementation`: modifica soltanto il `write_scope` della tranche assegnata;
- `review`: controlla correttezza, regressioni, perimetro e prove prodotte;
- `browser-validation`: esegue esclusivamente le verifiche live richieste,
  caricando lo skill browser-backed applicabile dalle istruzioni del repository.

Per ogni tranche l'orchestratore deve produrre un task atomico che specifichi:

1. obiettivo osservabile e dipendenze;
2. contesto e invarianti necessari;
3. `write_scope` e fuori ambito;
4. criteri di accettazione e comandi di verifica;
5. handoff richiesto con file modificati, risultati e rischi residui.

Le operazioni Git e le decisioni su provider o modello non fanno parte del
contratto del task e restano responsabilità dell'orchestratore. I task di
implementazione non eseguono verifiche browser-backed se non dispongono delle
capacità previste dalle istruzioni del repository; in quel caso la verifica
viene assegnata separatamente al ruolo `browser-validation`.

Non è previsto un ruolo di design perché non sono ammesse modifiche visuali. Se
l'esecuzione produce una necessità visuale, il lavoro si ferma e il piano deve
essere aggiornato prima di procedere.

## 10. Gate di approvazione

La prima approvazione di questo documento autorizza soltanto la Milestone A,
T0-T5. Non autorizza alcuna rimozione della Milestone B. I candidati opzionali
della sezione 5.4 restano esclusi.

Dopo l'approvazione e la scelta degli agenti, l'esecuzione inizia dalla
baseline T0 e prosegue con l'hardening del testing. Prima di tali decisioni non
devono essere modificati file prodotto, test, configurazioni o lockfile.

Al termine della Milestone A vengono presentati:

- comandi e risultati CI;
- matrice aggiornata delle invarianti;
- difetti di prodotto trovati e corretti;
- tempi e stabilità dei gate E2E;
- rischi residui.

Solo una seconda approvazione esplicita autorizza le Tranche 1-5 della
Milestone B.

**Approvazione Milestone B concessa:** la seconda approvazione è stata espressa
dall'utente e la Milestone B inizia dalle Tranche 1-5. La PR #33 resta aperta e
non è stato richiesto o effettuato alcun merge; push e pull request richiedono
comunque un'autorizzazione separata dell'utente.
