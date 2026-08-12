# Review di design — Remote Training Backend

**Target revisionato:** branch locale `feature/remote-training-backend` contro
`origin/master` (`3eb05f0`). Al momento della review GitHub non associava una PR
aperta alla branch; il report valuta quindi i 45 file del diff locale e li
confronta con l'[issue #14](https://github.com/LucaSforza/NNModelling/issues/14),
il design in `docs/archive/completed-plans/remote-training-backend/` e la documentazione
ufficiale in `docs2/source/remote_training.rst`.

**Esito:** richiedere modifiche prima di considerare il backend adatto a un
ambiente remoto condiviso. Il verticale editor → API → coda → esecutore è una
buona base, ma mancano una trust boundary e alcune proprietà di correttezza
fondamentali per una coda persistente.

## Cosa è ben fatto

- La separazione delle responsabilità è chiara: il browser mantiene il
  diagramma, FastAPI possiede job e scheduling, mentre MCP rimane un proxy
  HTTP sottile. È coerente con il design in
  `docs/archive/completed-plans/remote-training-backend/initial-plan.md:7-25`.
- Il contratto job unico e la materializzazione di `requested_config.json`,
  config Hydra risolta e log per job rendono il flusso riproducibile. La
  conversione riusa correttamente `build_hydra_configs` anziché duplicarne la
  logica.
- L'ordine della queue Valkey è progettato bene per il caso base:
  priorità, poi FIFO, con claim atomico Lua. La scelta di Valkey al posto del
  database leggero prospettato dall'issue è una miglioria ragionevole.
- Il caricamento del modello è più robusto: fallisce visibilmente senza
  sovrascrivere il diagramma e distingue JSON Svelte Flow da NNTree.
- `LocalExecutor` usa una lista di argomenti fissa, non una shell, e cattura
  stdout/stderr. L'idea di generare lo script Slurm dal server è corretta, ma
  la validazione attuale non la rende sicura (vedi F2).
- Docker Compose, AOF/RDB, il `justfile`, documentazione Sphinx e strumenti MCP
  sono un buon punto di partenza operativo.

## Finding bloccanti

### F1 — Critico: chi invia un job può eseguire target Hydra arbitrari

Il contratto espone `training` come `dict[str, Any]`
(`converted/src/backend/models.py:35-44`).
`normalize_training_config` richiede soltanto che `dataset` sia una mapping con
`_target_` (`config_service.py:15-29`), la scrive nella config, e
`main.py:61` chiama `hydra.utils.instantiate(cfg.dataset)`.

Quindi non esiste un collegamento effettivo tra `GET /datasets` e i target
accettati da `POST /jobs`. La riproduzione della review ha accettato
`schema_version: 999` e ha eseguito con successo il target innocuo
`os.system(command="true")`. I campi `optimizer`, le sezioni Hydra libere e
le override permettono lo stesso aggiramento anche se in futuro fosse limitato
solo `dataset`.

Questo contraddice l'ipotesi documentata che il backend scopra classi dal
pacchetto *trusted* (`docs2/source/remote_training.rst:124-130`) e rende
irrilevante il fatto che non venga caricato codice dal frontend. In più,
FastAPI è configurata con CORS `allow_origins=["*"]`
(`backend/app.py:36-42`) e non possiede autenticazione o autorizzazione.
Un sito terzo può perciò indurre il browser di un utente a inviare job al
backend raggiungibile.

**Richiesta:** definire prima la trust boundary. Per uso multiutente/remoto:
autenticazione, ownership dei job e autorizzazione per log/artifact; schema
chiuso per dataset/optimizer/trainer; allowlist server-side dei target; override
strutturate e allowlistate, oppure completamente disabilitate per i client. Se
il backend deve rimanere solo locale, documentarlo esplicitamente, limitarlo a
loopback e non pubblicare Compose/Slurm come deployment remoto sicuro.

### F2 — Critico: `SlurmExecutor` consente command injection tramite `gpu_type`

`ResourceRequest.gpu_type` e `node` sono stringhe senza pattern o divieto di
newline (`backend/models.py:17-32`). In `SlurmExecutor.build_batch_script`
vengono interpolate testualmente nelle direttive `#SBATCH`
(`backend/executors/slurm.py:81-85`). Quando la capacità del profilo non
specifica `gpu_type` — il default e un caso valido della configurazione —
`can_run` accetta qualsiasi `gpu_type` (`slurm.py:54-64`).

La prova costruisce un job con `gpu_type` contenente newline e una riga shell:
`can_run` restituisce `True` e lo script risultante contiene quella riga. Una
newline chiude la direttiva Slurm e trasforma il testo successivo in shell
eseguita nel job. Ciò è più grave di una semplice injection di opzione, e
contraddice l'affermazione che batch script e comandi client non siano accettati
(`plan.md:141-148`; `docs2/source/remote_training.rst:190-194`).

**Richiesta:** non serializzare stringhe client in shell. Rappresentare i
selector come identificatori/enum e validare rigidamente hostname e GPU type
(nessun whitespace o newline); quotare tutte le path/valori amministrativi;
generare lo script con un template che non accetti frammenti shell. Aggiungere
test negativi per newline, flag Slurm aggiuntivi e target non autorizzati.

## Problemi di correttezza della coda e del lifecycle

### F3 — Alta: un job incompatibile ad alta priorità blocca tutta la coda

`JobManager.run_once` fa claim del job di priorità massima, verifica il profilo
solo dopo (`manager.py:173-186`) e, se incompatibile, lo reinserisce con la
stessa priorità (`:187-188`). Al ciclo seguente reclama quindi lo stesso job.
Un job CPU compatibile a priorità inferiore non viene mai eseguito.

La riproduzione ha inserito un job GPU incompatibile a priorità 10 e uno CPU
compatibile a priorità 1: tre chiamate a `run_once()` hanno restituito
`False, False, False`; il job CPU era ancora `queued`.

Questo non realizza la promessa «compatible executor profiles are selected
round robin» (`docs2/source/remote_training.rst:77-78`).

**Richiesta:** selezionare il primo job *runnable*, mantenere una lista/stato
esplicito `blocked` con ragione, oppure rifiutare alla submission richieste che
nessun compute unit può soddisfare. Non riaccodare indefinitamente il job in
testa senza esaminare quelli successivi.

### F4 — Alta: dopo 1.000 eventi SSE il cursore Valkey perde gli eventi nuovi

Gli stream sono limitati a 1.000 elementi (`store.py:163-164`), ma
`get_events` legge sempre solo i primi 1.000 e inventa un id con
`enumerate(..., start=1)` (`:166-172`). L'id non è lo stream ID persistente
Valkey e ricomincia da 1 dopo il trimming.

Con una Valkey effimera la review ha scritto 1.001 eventi: la prima lettura
restituiva 1.000 elementi con ultimo `sequence=999`; la lettura con
`after=1000` restituiva `[]`. Un job locale manda heartbeat ogni secondo
(`executors/local.py:119-134`): dopo circa 17 minuti il frontend/MCP può non
ricevere più completamento, errore o cancellazione.

**Richiesta:** esporre e riusare l'id nativo dello stream (`ms-seq`), consultare
con `XREAD`/range a partire da quell'id, definire retention e risposta al
cursore troppo vecchio. Testare reconnect EventSource e oltre 1.000 heartbeat.

### F5 — Alta: restart del backend orfana il processo di training

`JobManager.stop()` interrompe solo il thread scheduler
(`manager.py:91-96`), non gli esecutori/processi attivi. Al riavvio,
`_recover()` marca ogni job `running` come `failed`
(`:108-120`), ma non termina né riaggancia il processo locale o Slurm. Il
processo locale è in una nuova sessione (`LocalExecutor.submit`, `local.py:103-109`)
e quindi può continuare a consumare risorse e scrivere artifact mentre il job
persistito risulta fallito.

**Richiesta:** introdurre un lifecycle di recovery esplicito: processo
supervisionato e riagganciabile, lease/heartbeat con PID verificato, oppure
terminazione affidabile di tutti i figli al shutdown prima di cambiare stato.
L'utente deve vedere lo stato reale e poter riprendere/riprovare in modo
idempotente.

### F6 — Media: cancellazione e osservabilità non sono coerenti fra API e UI

L'API cancella sia job `queued` sia `running` (`manager.py:273-289`) e la
documentazione lo dichiara (`docs2/source/remote_training.rst:120-122`). La UI
mostra però il bottone **Annulla** soltanto per `running`
(`TrainingSidebar.svelte:260-271`). Inoltre la cancellazione del job queued non
emette un evento `cancelled`, a differenza di quella running (`manager.py:279-288`).

La sidebar non mostra neppure log, checkpoint, metriche, progress o artifact:
mostra solo l'eventuale errore sintetico. Il polling generale ogni tre secondi
attenua il problema SSE, ma non sostituisce una timeline affidabile.

**Richiesta:** consentire cancel anche in coda, emettere lo stesso evento per
entrambe le transizioni e progettare una pagina/drawer di dettaglio job con
log incrementali, metriche e link ai risultati autorizzati.

## Divergenze tra design, implementazione e documentazione ufficiale

| Aspettativa | Stato effettivo | Valutazione |
|---|---|---|
| Contratto job **versionato** (`plan.md:27-64`) | `schema_version` è solo `ge=1`; `999` è accettato senza dispatch/migrazione. | Manca il contratto di compatibilità; validare `Literal[1]` finché esiste una sola versione. |
| Risorse CPU/RAM/GPU dichiarate (`docs2:70-88`) | Per `LocalExecutor` sono solo un filtro logico; non impongono cgroup/ulimit, timeout, affinity o `CUDA_VISIBLE_DEVICES`. `gpu_memory_gb` non partecipa alla compatibilità. | Il design va esplicitato: scheduling advisory oppure isolamento/enforcement reale. L'issue chiedeva di prevenire job runaway. |
| «Validate, persist, and enqueue» (`docs2:108-110`) | Il network è un `dict` non validato in profondità; target e override sono aperti. | La validazione deve precedere creazione artifact e claim; oggi un errore di config può lasciare directory orfane create da `manager.submit` (`:125-135`). |
| Profili compute configurati (`docs2:105-107`) | L'endpoint esiste, ma la sidebar non lo interroga: l'utente inserisce liberamente CPU/RAM/GPU/nodo. | Mostrare capacità e validare lato UI migliora la comprensibilità; la validazione server resta obbligatoria. |
| Status live tramite SSE (`plan.md:157-168`) | Il cursore è errato oltre 1.000 eventi; l'MCP legge l'intero stream SSE e può restare bloccato fino a 60 s (`mcp-server/src/remote-training.ts:71-85`). | Non è ancora un canale di osservabilità affidabile. |
| Setup locale documentato (`docs2:167-185`) e recipe `just valkey` | `valkey.conf` imposta `dir /data` (`converted/backend/valkey.conf:6`); `valkey-server backend/valkey.conf --dir valkey-data` fallisce su host prima che l'override CLI sia applicato. Il recipe riusa lo stesso file (`justfile:15-18`). | Separare config container e host, oppure eliminare `dir` dal file e passarlo sempre nel recipe. |
| Artifact «checkpoints and results» (`docs2:148-165`) | L'API espone solo metadata, log ed eventi (`backend/app.py:45-115`); non esiste endpoint artifact/result. | La documentazione rende discoverable un risultato che il client non può recuperare in modo supportato. |

## Cosa manca rispetto all'issue #14

Il design locale ha scelto consapevolmente un primo incremento più piccolo, ma
l'issue originaria resta aperta e richiede funzionalità che non sono ancora
presenti né elencate tutte come future work in `docs2`:

1. **Risultati scaricabili.** Manca `GET /jobs/{id}/result`, download di
   checkpoint, manifest degli artifact e controllo dell'accesso. L'utente vede
   una path assoluta `artifact_dir`, non un risultato portabile.
2. **Inferenza remota.** Manca `POST /jobs/{id}/infer`, input validation,
   storage e retrieval degli output. È la Phase 5 dell'issue.
3. **Metriche/progresso.** Heartbeat non equivale a epoch, step, metriche o
   stato Slurm ben modellato. Non esiste parsing strutturato dei risultati
   Lightning/W&B.
4. **Sicurezza e multiutenza.** L'issue la rinviava come «internal network»,
   ma la nuova documentazione presenta Docker e Slurm come deployment remoto:
   servono autenticazione, RBAC/ownership, audit log, rate/size limits e
   segregazione artifact.
5. **Limiti e retention.** Mancano timeout per job, limiti effettivi di RAM/CPU
   e GPU, quota di spazio, paginazione/tailing dei log, TTL/cleanup di job ed
   artifact. `GET /jobs/{id}/logs` legge il file completo in memoria
   (`manager.py:291-301`).
6. **Recovery/operazioni.** Mancano healthcheck che verifichi Valkey, stati
   `blocked`/`retrying`, retry idempotente, recovery del processo e strumenti
   amministrativi per job bloccati.
7. **Usabilità editor.** I parametri `batch_size`, `num_workers` e
   `train_size` appaiono due volte per Autoencoder/MNIST: una volta dalla
   discovery, una nei campi comuni. I primi campi sono testuali e vengono poi
   sovrascritti dai secondi in `buildRequest`
   (`TrainingSidebar.svelte:109-146`). È stato osservato direttamente nella
   sidebar. Validazione form, tipi, vincoli dataset/modello e preview della
   config risolta renderebbero il percorso più affidabile.

Il differimento della concorrenza e della modellazione fisica GPU è ragionevole
ed è già dichiarato come futuro (`plan.md:201-211`); non è una ragione per
bloccare questo primo incremento. Sicurezza, starvation, lifecycle e SSE lo
sono invece perché invalidano il comportamento promesso già con una sola
worker.

## Verifica eseguita

| Area | Risultato |
|---|---|
| Frontend | `pnpm --dir front-end test`: **293 passed, 5 skipped**. `pnpm --dir front-end check`: **0 error**, 11 warning già presenti. |
| Backend | `just --justfile converted/backend/justfile test`: **8 passed**. I test non coprono Valkey reale/SSE, starvation con profili incompatibili, recovery, trust boundary o esecuzione locale reale. |
| MCP | Build e test fuori dal sandbox: **45/45 passed**. L'errore iniziale era il sandbox che vietava `listen`, non una regressione del server. Stack reale avviato: frontend `5174`, Chrome DevTools `9223`, WebSocket browser `9339`, **48 tool MCP**, tab `tab_1` connessa. |
| Browser e caricamento | Con Chrome/CDP ho caricato `examples/diagrams/transformer_classifier.json`: **24 nodi**, input file rimosso dopo il load, nessun alert. MCP `get_type_info(refresh: true)` restituisce zero hard error e la warning attesa `Embedding expects int64 input, got float32`. Screenshot ispezionati: `/tmp/nnm-review-transformer-loaded.png` e `/tmp/nnm-review-training-sidebar.png`. |
| API via justfile | Con backend e Valkey già disponibili, `just health`, `just datasets` e `just jobs` hanno risposto. Il recipe `just valkey` non è stato usato per il run perché la configurazione host fallisce come descritto nella tabella delle divergenze. |
| Documentazione | `UV_CACHE_DIR=/tmp/nnm-review-docs-cache uv run make html` in `docs2`: build Sphinx riuscita. |

Non ho lanciato un nuovo training MNIST completo: comporterebbe download/dati e
creerebbe job persistenti estranei alla review. Il flusso UI/API di discovery e
monitoraggio è stato comunque esercitato contro il backend reale; era presente
un job storico già completato nel suo store.

## Test di regressione da aggiungere prima del merge

1. Un test Valkey reale per ordering e starvation: alta priorità incompatibile
   non deve impedire l'avvio di un job compatibile successivo.
2. Un test SSE con oltre 1.000 heartbeat, reconnect tramite `Last-Event-ID` e
   delivery dell'evento terminale.
3. Test API negativi per schema version non supportata, target Hydra fuori
   allowlist, override che cambia target e stringhe Slurm contenenti newline o
   opzioni aggiuntive.
4. Test lifecycle: shutdown/restart durante `LocalExecutor` e `SlurmExecutor`,
   verificando assenza di processi orfani e stato/evento terminale coerente.
5. Test del recipe host `just valkey` su una directory nuova; non basta testare
   solo la configurazione Docker.
6. E2E browser/API che controlli cancel queued, log tail, validazione form,
   assenza dei campi dataset duplicati e blocco di un diagramma con type error.
7. Smoke test opt-in che sottometta un modello MNIST minimo con backend
   effimero, controlli config/artifact/checkpoint e poi esegua cleanup.

## Sequenza raccomandata

1. Chiudere F1 e F2 definendo il modello di fiducia e bloccando l'esecuzione
   arbitraria.
2. Correggere F3–F5 e aggiungere gli invarianti di coda, SSE e restart.
3. Rendere avviabile il percorso `just valkey` documentato.
4. Completare il ciclo utente minimo: cancel queued, dettagli/log, artifact
   download controllato e form validata.
5. Pianificare result/inferenza, metriche, quote/retention e concorrenza come
   milestone successive, aggiornando issue, design e docs con il medesimo
   contratto.

## Nota sulle modifiche della review

Non sono state modificate implementazione o test della feature e non è stato
creato alcun commit. Le sole prove aggiuntive sono state script temporanei in
`/tmp`, usati per riprodurre F1–F4 e poi lasciati fuori dal worktree.
