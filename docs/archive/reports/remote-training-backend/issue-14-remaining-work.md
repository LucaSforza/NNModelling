---
id: remote-training-backend-issue-14-remaining-work
kind: historical-report
status: archived
updated: 2026-08-12
archived: 2026-08-12
areas:
  - front-end
  - converted
  - mcp-server
---

# Remote training backend — lavoro rimanente per la issue #14

> **Archived:** issue #14 was closed on 2026-07-28. This report captures a
> historical gap analysis; it is not an approved active plan. Reassess every
> item against current code before creating a new initiative.

Questo documento confrontava il branch storico
`feature/remote-training-backend` con la issue
[#14 — FastAPI Backend for Remote Training Pipeline](https://github.com/LucaSforza/NNModelling/issues/14).
Non è un nuovo piano di autenticazione: registra ciò che manca per poter
considerare completata l'intera issue originale.

## Valutazione sintetica

Al momento di questo snapshot la issue non era ancora considerata chiudibile.
Il verticale principale era disponibile:
frontend, FastAPI, coda persistente, esecuzione locale/Slurm, stato, log,
eventi, cancellazione, Docker e pairing sono integrati. Mancano però due
risultati esplicitamente richiesti dalla issue — download dei risultati e
inferenza — oltre a progress/metriche strutturate e alle proprietà operative
necessarie per una coda concorrente e durevole.

## Funzionalità già presenti

| Area della issue | Stato attuale |
|---|---|
| FastAPI e modelli Pydantic | Implementati per submission, sessioni, risorse e job |
| `POST /jobs` | Implementato con NNTree e configurazione training completa |
| Status e lista job | Implementati e filtrati per proprietario |
| Log | Implementati come stdout/stderr completi |
| Aggiornamenti live | Implementati tramite SSE con cursore Valkey nativo |
| Cancellazione | Implementata per queued/running, anche da admin |
| Workspace per job | Implementato sotto l'artifact root configurabile |
| Esecuzione locale | Implementata con subprocess e log persistenti |
| Coda persistente | Implementata con Valkey, priorità + FIFO e claim atomico |
| Slurm | Implementato con `sbatch` locale o via SSH, monitor e `scancel` |
| Docker | Dockerfile e Compose con volumi persistenti |
| Editor | Sidebar diretta al backend, senza dipendere da MCP |
| Sicurezza LAN | Pairing approvato via `just`, TTL, revoca e ownership job |
| Compatibilità locale | Conversione/training/inferenza CLI esistenti non rimossi |
| Documentazione | User guide e admin guide, incluse installazioni PC/Slurm |

## Mancanze bloccanti rispetto alla issue

### 1. Download di checkpoint e risultati

La issue richiede `GET /jobs/{job_id}/result`. Attualmente il backend restituisce
una path assoluta `artifact_dir`, utile solo all'amministratore della macchina.
Mancano:

- manifest tipizzato degli artifact prodotti;
- endpoint per elencare e scaricare checkpoint, pesi e output;
- autorizzazione owner/admin su ogni artifact;
- filename e content type sicuri, protezione da path traversal;
- streaming dei file senza caricarli interamente in memoria;
- checksum, dimensione e stato `result_ready`;
- formato portabile, per esempio singolo file o archivio costruito dal server.

Senza questa parte l'utente remoto può avviare il training ma non recuperare il
modello tramite il workflow supportato.

### 2. Inferenza remota

La Phase 5 richiede `POST /jobs/{job_id}/infer`. Non esistono ancora:

- contratto degli input per classificazione, autoencoder e casi generici;
- selezione sicura del checkpoint;
- coda/stato separato per le esecuzioni di inferenza;
- limiti di dimensione e validazione dei file/input;
- persistenza e download delle predizioni;
- endpoint e UI per avviare e osservare l'inferenza;
- test end-to-end che confrontino gli output con `converted/src/infer.py`.

### 3. Progresso e metriche strutturate

Heartbeat, stato e log sono presenti, ma la issue chiede epoch/step, progress e
metriche. Occorre aggiungere:

- eventi tipizzati per epoch, step, loss e metriche di validazione;
- adapter/callback Lightning invece di parsing fragile del testo;
- snapshot corrente nel job status;
- API di storico con paginazione/retention;
- UI di progresso e metriche;
- comportamento definito quando W&B è disabilitato o irraggiungibile.

### 4. Concorrenza e worker scalabili

Valkey rende persistente la coda, ma il processo FastAPI contiene ancora un
singolo scheduler e il default è un job attivo. Per completare la Phase 2:

- rendere configurabile e testare `max_running_jobs` da environment;
- modellare capacità occupata e disponibile per ogni compute unit;
- allocare correttamente GPU distinte e memoria GPU;
- introdurre lease atomici e ownership del worker;
- supportare più scheduler senza doppia esecuzione;
- retry idempotente e stati `blocked`, `retrying`, `lost`;
- backpressure, fairness e quote per connessione;
- recovery verificabile dei job locali e Slurm dopo crash del backend.

## Sicurezza necessaria prima di client non fidati

Il pairing risolve accesso anonimo e isolamento tra connessioni, ma non chiude
l'intero rischio di esecuzione configurabile. Prima di considerare sicuro un
browser approvato ma non totalmente fidato servono:

1. allowlist server-side dei dataset installati;
2. allowlist degli optimizer e degli altri target Hydra;
3. schema chiuso per trainer, early stopping e W&B;
4. override Hydra strutturate e allowlistate, oppure disabilitate;
5. `schema_version` limitata alle versioni realmente supportate;
6. limiti sulla dimensione del body e sulla complessità del NNTree;
7. rate limit e quote per submission, storage e compute;
8. timeout, limiti RAM/CPU e isolamento locale reale (cgroup/container);
9. TLS e una strategia di deployment oltre la LAN fidata;
10. audit amministrativo interrogabile e retention definita.

La separazione `owner_connection_id` deve essere riutilizzata anche dai futuri
endpoint result e inference; nessuna path dell'artifact store deve essere
considerata una capability.

## Robustezza e operazioni mancanti

- Health/readiness che verifichino Valkey, artifact filesystem e profili
  executor, non soltanto il processo HTTP.
- Retention e cleanup di pairing request, sessioni, job, stream e artifact.
- Paginazione/tailing dei log; oggi i file completi sono letti in memoria.
- Quota disco e gestione esplicita di filesystem pieno.
- Migrazione/versionamento dei record Valkey.
- Rotazione automatizzata dell'admin token e procedura di disaster recovery
  verificata.
- Gestione di job orfani dopo crash/kill -9: il graceful shutdown è coperto,
  ma non esiste riaggancio affidabile a processo o Slurm job.
- Semantica distinta tra cancellare un'esecuzione ed eliminare definitivamente
  record e artifact; oggi `DELETE /jobs/{id}` cancella ma non rimuove.
- Storage remoto opzionale (S3/object store) o contratto di volume persistente
  per deployment non condivisi.
- Hardening degli script Slurm per path amministrative con spazi/caratteri
  speciali e bootstrap esplicito dell'ambiente Python sui compute node.

## Integrazioni mancanti

### MCP

Gli strumenti MCP per remote training esistono, ma il relativo client HTTP non
partecipa ancora al nuovo pairing e non può usare le API protette. Per
completare l'integrazione opzionale della issue occorre definire una capability
MCP distinta oppure un trasferimento sicuro della sessione, senza leggere il
token dal browser o inserirlo negli URL.

### Frontend

La sidebar copre pairing, submission, status, log e cancellazione. Restano:

- selezione guidata delle compute unit e validazione rispetto alle capacità;
- pagina/drawer di dettaglio invece della lista compatta;
- download di artifact e checkpoint;
- progress e metriche;
- workflow di inferenza;
- gestione visibile di più backend salvati;
- eliminazione dei campi dataset duplicati;
- test component/e2e automatizzati del pairing, oltre ai test TypeScript e al
  collaudo manuale Chrome.

## Testing richiesto per la chiusura

La issue domanda un piccolo training MNIST attraverso un server reale. La
chiusura dovrebbe richiedere almeno:

- FastAPI + Valkey reale + subprocess locale, non soltanto test double;
- submission dal frontend e checkpoint scaricato tramite API;
- inferenza remota sul checkpoint e validazione della predizione;
- due connessioni che provino isolamento di job, log, result e inference;
- scadenza/rinnovo/revoca con clock controllato e test browser automatizzato;
- reconnect SSE oltre la retention e durante restart;
- Slurm contract test per submit, monitor, cancel e recovery;
- Docker Compose smoke test con volumi persistenti;
- test di limiti, target Hydra rifiutati, path traversal e body oversized;
- compatibilità del workflow locale preesistente.

## Ordine consigliato

### P0 — necessario prima di distribuire a utenti non fidati

1. Chiudere Hydra/NNTree con schema e allowlist.
2. Applicare limiti di request, tempo, risorse e storage.
3. Aggiungere result manifest + download autorizzato.

### P1 — necessario per soddisfare la descrizione funzionale

4. Progresso e metriche strutturate.
5. Inferenza remota e output scaricabili.
6. Concorrenza, lease e recovery robusta.
7. UI result/inference e test end-to-end reale.

### P2 — completamento operativo/deployment

8. Cleanup/retention, readiness e migrazioni.
9. Object storage e deployment Kubernetes opzionale.
10. Autenticazione per gli strumenti MCP remote-training.

## Definition of done proposta per la issue #14

La issue può essere chiusa quando un utente, da un frontend su un'altra
macchina, può:

1. collegarsi in modo autorizzato;
2. inviare un diagramma e seguirne stato, progresso, metriche e log;
3. ottenere un checkpoint tramite API senza accesso al filesystem backend;
4. eseguire inferenza e recuperare output validati;
5. cancellare o eliminare il proprio job senza incidere sugli altri utenti;
6. riprendere l'osservazione dopo refresh/restart senza duplicare il job;
7. usare un deployment locale o cluster documentato con persistenza e limiti;
8. superare i test reali locale, Docker e Slurm senza regressioni del workflow
   CLI preesistente.
