---
id: code-elision-milestone-a-results
kind: historical-evidence
initiative: code-elision
updated: 2026-08-01
archived: 2026-08-12
areas:
  - front-end
  - mcp-server
  - converted
---

# Milestone A — Testing foundation: risultati e bug register

> **Nota di lifecycle:** questo documento è un'evidenza storica della
> Milestone A e non possiede lo stato corrente dell'iniziativa. Lo stato
> autorevole durante l'esecuzione era nel [piano archiviato](../plan.md).

**Snapshot registrato:** decisioni D1/D3/D4/D5/D7 implementate; review locale
approvata; CI remota verde su
[PR #33](https://github.com/LucaSforza/NNModelling/pull/33); al momento della
registrazione, la Milestone B non era ancora autorizzata né iniziata.

**Branch:** `milestone-a-testing-foundation`

**Base:** `0d3e2d4`

**Data:** 2026-08-01

## 1. Decisioni e confini applicati

La Milestone A è stata eseguita prima di qualsiasi attività di elisione. La
copertura model-to-training introdotta o rafforzata usa esclusivamente:

- `examples/diagrams/mninst.json` per classificazione MNIST;
- `examples/diagrams/autoencoder_mnist.json` per ricostruzione MNIST.

Non sono stati modificati file, configurazioni, fixture, stereotype o metadata
del Transformer. Non è iniziata alcuna tranche della Milestone B.

**Emendamento di accettazione esplicito dell'utente:** la matrice espansa
obbligatoria della Milestone A è composta soltanto da `mninst` e
`autoencoder_mnist`. Non è richiesto alcun modello Transformer e nessun
modello con join non commutativo come gate della milestone. I difetti rimasti
aperti sono deferiti come lavoro futuro: D2 (NNTree malformato accettato da
`convert.py`) a
[#31](https://github.com/LucaSforza/NNModelling/issues/31), D6 (errori hard
degli esempi fuori perimetro) a
[#30](https://github.com/LucaSforza/NNModelling/issues/30) e D8 (dtype nel
JSON di inference) a
[#32](https://github.com/LucaSforza/NNModelling/issues/32). I criteri di
accettazione del piano che richiedevano questi elementi nella Milestone A
sono stati contrassegnati come superati nel [piano](../plan.md) (T2 e sezione
7).

`resolveConcatOutput()` rimane una primitiva semantica generica del type engine.
La configurazione seleziona l'azione `concat`; il motore ne implementa la
semantica senza controlli basati sul nome dello stereotype.

## 2. Baseline precedente

Prima della Milestone A il repository disponeva di test reali ma frammentati:

- i tier Vitest locali eseguivano conversione, forward, training e inference;
- il percorso completo sorgente-modello non era eseguito dalla CI;
- il job Python CI eseguiva quattro training reali chiamando direttamente gli
  script, senza attraversare il backend remoto;
- FastAPI era testato in-process, ma Valkey, executor ed exporter erano
  sostituiti da fake nei test del job manager;
- non esisteva un test unico da `POST /jobs` a package importabile e
  `predict()`;
- backward, parameter update, exact shape/dtype e claim atomico Valkey non
  costituivano invarianti di integrazione.

Baseline osservata:

| Area | Risultato precedente |
| --- | --- |
| Frontend check | 0 errori, 11 warning |
| Frontend unit | 311 passed, 5 skipped |
| Python fast | 153 passed |
| Python training | 2 passed, circa 42 s |
| Python training + inference | 2 passed, circa 97 s |
| Autoencoder Vitest train/infer | fallimento per dataset MNIST classificazione usato con MSE reconstruction |

## 3. Testing foundation risultante

### 3.1 Pipeline sorgente → modello

Per `mninst` e `autoencoder_mnist` vengono ora verificate:

1. import del diagramma sorgente;
2. type inference senza errori hard;
3. compilazione NNTree e integrità dei riferimenti;
4. conversione reale tramite `convert.py` con dataset appropriato;
5. forward con forma, dtype e valori finiti esatti;
6. backward reale con loss finita;
7. gradienti finiti, almeno un gradiente non nullo e parameter update;
8. training reale;
9. produzione e caricamento di `weights.pt` e `weights.safetensors`;
10. equivalenza dell'output in `eval()` prima e dopo il reload;
11. inference con schema, cardinalità e forma delle predizioni; il dtype è
    verificato sul tensore prima della serializzazione JSON, che non conserva
    questa informazione;
12. produzione delle immagini per il dataset che la supporta.

Il manifest dichiara ora metadata di input/output e dataset soltanto per i due
modelli scelti. La modalità `NNM_REQUIRE_PYTHON=true` trasforma l'assenza del
runtime Python in un fallimento nei gate obbligatori, anziché in uno skip
silenzioso.

### 3.2 Pytest e Valkey reale

La suite Python espone marker registrati e separati:

- `fast`: test deterministici senza servizi o training;
- `service`: integrazione con Valkey reale;
- `e2e`: i tre job backend canonici, deterministici e network-independent;
- `legacy_e2e`: quattro training/inference storici su MNIST reale, disponibili
  soltanto come comando manuale opzionale.

I test Valkey reali coprono:

- persistenza job e autenticazione fra istanze;
- priority/FIFO e rimozione dalla coda;
- claim Lua concorrente senza doppia assegnazione;
- stream con più di 1.000 eventi e cursor reali;
- pairing, approvazione, autenticazione e revoca;
- recovery di job queued/running e coerenza dell'evento terminale;
- fallimento dell'esportazione package su Valkey reale con stato/evento
  terminale coerente (D4).

Con `NNM_REQUIRE_VALKEY=1`, l'assenza del servizio fallisce il gate. In modalità
locale non obbligatoria i test service possono essere saltati esplicitamente.

### 3.3 Job backend end-to-end

Entrambi i modelli attraversano il percorso reale:

```text
POST /jobs autenticato
  -> ValkeyJobStore
  -> scheduler claim
  -> LocalExecutor
  -> main.py
  -> weights.safetensors
  -> build_model_wheel
  -> GET /jobs/{id}/package
  -> verifica digest
  -> salvataggio client dei bytes scaricati
  -> installazione della wheel scaricata in venv isolato
  -> load_model().predict()
```

Store, executor, exporter e wheel scaricata non sono simulati. W&B online e un
cluster Slurm reale restano intenzionalmente fuori dal percorso canonico. Il
dataset E2E è locale, piccolo, deterministico e MNIST-shaped: classificazione a
10 classi e ricostruzione immagine.

Le invarianti includono:

- transizioni `queued < running < package_ready < succeeded`;
- stato terminale coerente in caso di job realmente fallito;
- artifact root e pesi sicuri;
- architettura e state dict compatibili;
- digest manifest, file e bytes scaricati equivalenti;
- package installabile dai bytes HTTP e importabile in subprocess isolato;
- output classificatore `(2, 10)` `float32` finito;
- output autoencoder `(2, 1, 28, 28)` `float32` finito.

### 3.4 CI

Il workflow definisce sei gate:

1. `frontend-ci`: check, unit e build;
2. `frontend-integration`: smoke, convert e forward/backward per `mninst` e
   `autoencoder_mnist` con Python obbligatorio;
3. `backend-fast`;
4. `backend-service` con container Valkey reale;
5. `backend-e2e`, serializzato, con Valkey reale, CPU e W&B disabilitato;
6. `mcp-ci`.

I comandi sono stati riprodotti localmente e poi eseguiti da remoto: il run
[30703415396](https://github.com/LucaSforza/NNModelling/actions/runs/30703415396)
della [PR #33](https://github.com/LucaSforza/NNModelling/pull/33) (head
`382651c`) è concluso con successo su tutti e sei i gate in circa 2 minuti e
8 secondi:

| Gate | Esito | Durata |
| --- | --- | --- |
| `frontend-ci` (check · unit · build) | success | 27 s |
| `frontend-integration` (mninst + autoencoder_mnist) | success | 2 min 5 s |
| `backend-fast` (`-m fast`) | success | 1 min 22 s |
| `backend-service` (Valkey reale) | success | 1 min 32 s |
| `backend-e2e` (serializzato, Valkey reale) | success | 2 min 1 s |
| `mcp-ci` | success | 24 s |

La PR #33 resta aperta; non è stato richiesto o effettuato alcun merge.

## 4. Evidenza di validazione locale

| Gate | Risultato |
| --- | --- |
| `git diff --check` | clean |
| Frontend check | 0 errori, 11 warning preesistenti |
| Frontend unit | 329 passed, 5 skipped |
| Frontend build | passed |
| Frontend integration completa | 151 passed, 3 skipped, circa 210 s (rieseguita dopo le modifiche client-only) |
| Backend fast (`-m fast`) | 188 passed, circa 9 s |
| Backend service, Valkey reale | 13 passed, circa 4 s |
| Backend E2E canonico | 3 passed, circa 27 s |
| Backend E2E legacy opzionale | 4 passed, circa 107 s |
| MCP build | passed |
| MCP test | 51 passed |

I conteggi di backend fast (188), service (13), E2E canonico (3) e frontend
unit (329 passed, 5 skipped) sono stati riconfermati localmente dopo le
correzioni D3/D4 e le riparazioni finali su ordinamento degli eventi terminali
(`fd854f0`) e cleanup degli snapshot (`04b9564`). La suite di integrazione
frontend completa è stata rieseguita per intero dopo le modifiche client-only
(`68074f6`/`524762c`/`e87789f`): `pnpm --dir front-end run
test:integration:all` ha concluso con 151 passed, 3 skipped in circa 210 s,
senza leak di processi o directory temporanee.

Sono stati verificati cleanup di processi e directory temporanee. Pesi,
prediction JSON, credenziali e processi Valkey/training non sono rimasti nel
working tree tracciato.

## 5. Bug banali corretti

Queste correzioni non hanno richiesto decisioni architetturali.

| ID | Bug | Correzione e regressione |
| --- | --- | --- |
| F1 | Il test autoencoder usava il dataset MNIST di classificazione, causando target MSE incompatibili | Dataset dichiarato nel manifest e propagato alla conversione; train/infer classifier e autoencoder verdi |
| F2 | I test training/inference lasciavano `weights.safetensors` nel repository | Assertion sull'artefatto e cleanup esplicito; nessun leak dopo il gate E2E |
| F3 | `schema_version` accettava qualsiasi intero `>=1`, pur esistendo soltanto v1 | Validazione `schema_version == 1` e regressioni diretta/API 422 |
| F4 | Il client MCP non inviava il bearer token richiesto dal backend | Token opzionale da costruttore o `NNM_BACKEND_TOKEN`, header Bearer su REST/SSE, sei contract test; nessuna credenziale hardcoded |
| F5 | L'helper `test_valkey_url` veniva raccolto da pytest come test fantasma | Rinominato `get_test_valkey_url`; raccolta esatta |
| F6 | Il JSON autoencoder poteva superare il limite stringa di Node | Validazione streaming della cardinalità e campionamento dei record |
| F7 | I training con `hydra.job.chdir=true` riscaricavano MNIST nella directory temporanea | Cache locale gitignored collegata/coperta nella directory del job; suite resa offline e più veloce |
| F8 | Il test MCP aveva whitespace non valido a fine file | Rimosso; `git diff --check` verde |
| F9 | Gli helper di integrazione creavano directory temporanee non possedute dal teardown | Config, training output e prediction sono ora figli del `workDir` del test; regressioni verificano cleanup e `NNM_KEEP_TEMP` |
| F10 | Il backend E2E usava il path server della wheel invece dei bytes scaricati | I bytes HTTP vengono salvati lato client, installati con pip in un venv isolato e usati da quel Python per `predict()` |
| F11 | Il marker pytest `fast` era registrato ma non selezionava test | I test senza marker service/E2E ricevono esplicitamente `fast`; le quattro classi sono disgiunte e coprono 191 test |
| F12 | I quattro training MNIST legacy facevano parte del gate E2E canonico | Spostati in `legacy_e2e`, disponibile manualmente ma escluso dalla CI obbligatoria |
| F13 | Il cleanup dei pesi legacy non era garantito dopo un'asserzione fallita | Training, assertion e rimozione di entrambi i file sono protetti da `try/finally` |
| F14 | Il workflow conservava soltanto il log aggregato in caso di E2E fallito | Contratto `NNM_E2E_ARTIFACT_DIR` e upload failure-only di log e artifact diagnostici senza token/Valkey data |
| F15 | Risposte di refresh training in ritardo potevano sovrascrivere lo stato corrente dopo forget/riconnessione | `RefreshGate` (epoch della connessione + sequenza richieste) in `front-end/src/training/refreshGate.ts`; `TrainingSidebar` invalida il gate su cleanup/attivazione e applica job/errori/loading soltanto dalla richiesta corrente; 6 regressioni dedicate (`refreshGate.test.ts`) |
| F16 | Un executor che completava sincronicamente dentro `submit()` lasciava un evento `running` stantio dopo la catena terminale | L'evento `running` viene emesso prima di invocare `executor.submit()`; se il record risulta già terminale al ritorno, il manager non scrive `executor_details`, non registra l'esecuzione come active e non emette alcun `running` successivo. L'ordine contratto è `queued < running < package_ready < succeeded` (o `... < package_failed < failed`), con l'evento terminale sempre per ultimo. Regressioni sincrone (`ImmediateExecutor`) in `test_remote_backend.py` e su Valkey reale in `test_service_valkey.py` (`fd854f0`) |

## 6. Decisioni sui bug di design

Questi finding sono stati discussi con l'utente. D1, D3, D4, D5 e D7 hanno
ricevuto una decisione e sono stati corretti; D2, D6 e D8 sono tracciati come
lavoro futuro.

### D1 — Cicli top-level accettati — risolto

L'editor ora rifiuta una connessione che chiuderebbe un ciclo diretto. `NNTree`
esegue inoltre una verifica indipendente prima della compilazione, così anche un
diagramma ciclico importato da JSON viene rifiutato.

La cycle detection distingue nodi sul percorso DFS corrente da nodi già
completati, preservando i grafi DAG con rami che si ricongiungono. Test unitari e
di integrazione coprono editor, NNTree, join e subflow.

### D2 — `convert.py` accetta un NNTree strutturalmente invalido — issue futura

Un documento come `{"not": "valid nntree"}` può terminare con exit code zero e
produrre una directory di configurazione apparentemente valida. Il comportamento
è caratterizzato in `convert.test.ts`.

Il lavoro futuro è tracciato in
[#31 — Reject structurally invalid NNTree documents in convert.py](https://github.com/LucaSforza/NNModelling/issues/31).

### D3 — Integrità della wheel non rivalidata al download — risolto

La decisione adottata è la doppia verifica su uno snapshot immutabile, senza
overclaim TOCTOU: entrambi i lati eseguono il controllo e nessuno dei due
serve bytes non verificati.

Il server, in `package_download`, apre il wheel una sola volta e lo copia in
uno snapshot privato (`tempfile.mkstemp`, permessi `0600`, directory mai
esposta via API) calcolando lo SHA-256 in un unico passaggio di lettura a
blocchi di 1 MiB (`_create_package_snapshot`). Il digest dello snapshot viene
confrontato in tempo costante con il digest autorevole
`model_package.sha256` registrato all'esportazione. Viene servito soltanto lo
snapshot verificato — mai il path dell'artefatto mutabile — quindi bytes
sostituiti su disco dopo la verifica non possono influenzare il
trasferimento. Se il digest dichiarato è mancante o malformato, o se i bytes
copiati non coincidono, l'endpoint risponde `409 Conflict` con codice
`package_integrity_error`, elimina lo snapshot e non serve alcun byte; la
risposta non rivela mai path del filesystem. Lo snapshot viene rimosso al
termine della risposta, anche in caso di errore di streaming o disconnessione
del client (cleanup in `finally`, idempotente). In caso di successo il digest
verificato è esposto nell'header `X-NNM-SHA256`, incluso negli
`expose_headers` CORS.

Il browser richiede un contesto sicuro del frontend (HTTPS o localhost, dove
Web Crypto è disponibile): se manca, il download viene rifiutato con
`package_verification_unavailable` e nessun file è offerto. Con Web Crypto
disponibile, il browser considera autorevole il digest autenticato del job
(`job.model_package.sha256`): verifica che l'header `X-NNM-SHA256` sia
presente, ben formato e uguale al digest atteso, poi digesta i bytes
scaricati con Web Crypto e offre il file soltanto se ogni controllo passa.
Non esiste un fallback non verificato: se un'operazione di digest fallisce o
manca, l'errore punta al contesto del frontend, non a CORS o raggiungibilità
del backend. Errori client: `package_verification_unavailable`,
`package_digest_missing`, `package_digest_invalid`,
`package_digest_mismatch`, `package_corrupted`.

Nota di deployment: il backend può restare su HTTP quando la pagina del
frontend è HTTPS o localhost e CORS consente l'Origin; la verifica lato
browser dipende dal contesto del frontend, non dal protocollo del backend.

Commit: `4813042` (digest all'esportazione), `68074f6` (verifica lato
browser), `de32677` (snapshot immutabile lato server), `e87789f` (contesto
sicuro richiesto lato browser).
Regressioni in `test_remote_backend.py` (wheel sostituita, digest mancante,
digest malformato, header esposto via CORS, ownership del download, snapshot
pinnato ai bytes verificati, `409` senza body, cleanup dello snapshot,
rimozione dello snapshot quando `send` fallisce durante lo streaming del body
con permessi privati `0600` verificati su POSIX e rimozione dello snapshot
quando il task di download viene cancellato a metà stream — `04b9564`) e
`trainingApi.test.ts` (header e body verificati prima di restituire il Blob,
Web Crypto assente e digest rifiutato mappati su
`package_verification_unavailable`).

### D4 — Pesi mancanti nel percorso package legacy — risolto

La decisione adottata è la politica strict current-project senza fallback
legacy: la wheel è un output promesso di ogni job riuscito, quindi un job
senza `weights.safetensors` non è un successo silenzioso.

Il manager esporta la wheel prima di persistere `succeeded`: l'ordine degli
eventi felici è `package_ready` poi `succeeded`. Se l'esportazione fallisce —
pesi sicuri mancanti o corrotti (file non apribile come contenitore
safetensors o contenitore vuoto), adapter non supportato, eccezione
dell'exporter — il job registra `package_error`, emette l'evento
`package_failed` e transita allo stato terminale `failed` con la stessa
transizione atomica degli altri failure. Artefatti, log ed errore restano
visibili al proprietario e all'amministratore; il job fallito non ha manifest
e il download risponde `404`.

Commit: `cf3f677`. Regressioni in `test_negative_cases.py` (config mancante,
config corrotta, pesi corrotti, pesi mancanti, eccezione exporter, superficie
API) e in `test_remote_backend.py` per l'ordine `package_ready < succeeded`.

Evidenza service su Valkey reale (`a9fb6e4`, rafforzata da `fd854f0`): il
nuovo test
`test_service_valkey.py::test_package_export_failure_on_real_valkey_fails_job_atomically`
esercita il percorso D4 contro lo store e l'auth Valkey reali, senza
monkeypatch dell'exporter: un executor double riporta successo senza scrivere
`weights.safetensors`, l'exporter fallisce deterministicamente sui pesi
mancanti. Il test verifica lo stato `failed` con `finished_at` valorizzato e
`model_package` None, `package_error` e `error` visibili, la rimozione
atomica dalla coda/indici sullo store reale, l'ordine completo degli eventi
`queued < running < package_failed < failed` con il terminale per ultimo
(sia sul registro eventi sia sullo stream SSE), la visibilità di
job/list/events/logs al proprietario e il download `404` sull'API reale
(ASGI).

### D5 — Job fallito ancora presente in coda — risolto

Ogni transizione a `failed` salva ora il record e lo rimuove dalla coda e dagli
indici di priorità con una sola operazione atomica, sia nello store in-memory
sia in Valkey. La rimozione è idempotente.

Il record non viene cancellato: il client proprietario continua a vedere job,
stato `failed`, evento terminale, errore e log tramite list/get/events/logs. I
test coprono recovery, executor failure, store reale e job E2E fallito. Se la
persistenza fallisce temporaneamente, il manager ritenta; se continua a fallire,
non lascia uno stato a metà e mantiene il job recuperabile come `running` fino
alla riconciliazione successiva.

### D6 — Type error su diagrammi fuori dal perimetro — issue futura

Cinque esempi non inclusi nel nuovo gate type-clean presentano errori hard
preesistenti:

- `auto_encoder_submodels`;
- `auto_encoder_submodels_with_submodels`;
- `single_head_attention`;
- `multihead_attention`;
- `horizontal_multihead_attention`.

Non sono stati modificati. I diagrammi attention non rientrano nel perimetro
autorizzato di questa milestone; il Transformer è rimasto completamente
invariato e non fa parte di questo elenco.

L'analisi futura è tracciata in
[#30 — Resolve hard type errors in maintained example diagrams](https://github.com/LucaSforza/NNModelling/issues/30).

### D7 — Falso “loop” sulla riconvergenza dell'autoencoder — risolto

Spiegazione semplice: nell'autoencoder due strade diverse arrivano allo stesso
nodo Addition. Il vecchio algoritmo vedeva quel nodo una seconda volta e
concludeva “sono tornato indietro, quindi c'è un ciclo”. In realtà le due strade
stavano semplicemente confluendo nello stesso punto, come due corsie che si
uniscono.

La nuova verifica considera ciclo soltanto il ritorno a un nodo ancora presente
nel percorso corrente. Se il nodo era già stato completato, la seconda visita è
una riconvergenza valida. Il falso warning è stato eliminato e
`autoencoder_mnist` e fixture unitarie sintetiche hanno regressioni dedicate.

### D8 — Il JSON di inference non conserva il dtype — issue futura

`infer.py` serializza i tensori con `.tolist()`. Il JSON permette di verificare
schema, cardinalità e forma annidata delle predizioni, ma non distingue
`float32` da `float64`. Il dtype esatto è verificato nel gate forward e nel
package E2E; il gate backward verifica loss finita, gradienti e aggiornamento
dei parametri, non il dtype; il JSON di inference verifica struttura, forma e
cardinalità, senza asserzioni di dtype.

Per ora il dtype dell'artefatto JSON viene intenzionalmente ignorato. Il lavoro
futuro è tracciato in
[#32 — Add versioned dtype metadata to inference artifacts](https://github.com/LucaSforza/NNModelling/issues/32).

## 7. Limiti e rischi residui

- Il workflow CI è stato eseguito da remoto: tutti e sei i gate sono verdi sul
  run [30703415396](https://github.com/LucaSforza/NNModelling/actions/runs/30703415396)
  della [PR #33](https://github.com/LucaSforza/NNModelling/pull/33).
- Quattro E2E Python legacy continuano a usare MNIST reale e possono dipendere
  dal download; sono esclusi dai gate CI obbligatori e restano manuali.
- La matrice obbligatoria copre soltanto il classificatore MNIST e
  l'autoencoder richiesti dall'emendamento di accettazione: join non
  commutativi e Transformer non sono gate della Milestone A. I difetti
  residuali sono tracciati come lavoro futuro (D2 → #31, D6 → #30, D8 → #32).
- Slurm è contract-tested ma non viene inviato un job a un cluster reale.
- Il client MCP trasporta un token fornito esternamente (`NNM_BACKEND_TOKEN`),
  ma pairing e rinnovo automatico per un processo MCP restano responsabilità
  operativa dell'operatore e non sono stati ridisegnati.

## 8. Gate registrato verso la Milestone B

Al momento di questo report la Milestone B restava bloccata e non era iniziata.
Prima dell'elisione erano ancora richiesti:

1. ~~esecuzione verde dei sei job GitHub dopo autorizzazione a commit/push~~
   **COMPLETATO:** tutti e sei i gate sono verdi sul run
   [30703415396](https://github.com/LucaSforza/NNModelling/actions/runs/30703415396)
   della [PR #33](https://github.com/LucaSforza/NNModelling/pull/33). La CI
   remota non è più in attesa.
2. presentazione di questo report all'utente;
3. seconda approvazione esplicita dell'utente.

La review locale è conclusa con verdetto **Approved** e senza finding locali
aperti. Il qualificatore "pending remote CI" del verdetto precedente è
decaduto perché la CI remota è ora verde.
