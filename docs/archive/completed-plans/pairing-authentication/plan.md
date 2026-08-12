# Piano implementativo — pairing e autorizzazione del training backend

> **Nota archivio (2026-08-12):** lo stato seguente descrive il documento al
> momento della scrittura. Il contratto è implementato; la descrizione corrente
> è in [`docs/knowledge/contracts/pairing.md`](../../../knowledge/contracts/pairing.md).

## Stato originale del documento

**Proposta da approvare prima dell'implementazione.** Questo documento definisce
il primo confine di fiducia del remote training backend. Non modifica il codice
e non include il server MCP.

Decisioni già concordate:

- il frontend si collega inserendo l'URL del backend;
- una nuova connessione deve essere approvata o rifiutata dalla macchina del
  backend tramite comandi `just`;
- la validità predefinita è configurata globalmente dal backend, inizialmente
  24 ore, ma ogni approvazione può scegliere una durata diversa;
- il nome del dispositivo è facoltativo;
- il browser conserva la connessione tra refresh e riavvii;
- ogni connessione vede e gestisce esclusivamente i propri job;
- l'amministratore può elencare, ispezionare e gestire connessioni e job tramite
  `just`;
- il frontend offre sia la disconnessione locale sia la disconnessione con
  revoca lato server;
- senza autenticazione restano disponibili soltanto health check e pairing;
- questa versione è destinata esclusivamente a una LAN fidata e non deve essere
  documentata come sicura per l'esposizione diretta su Internet;
- MCP è esplicitamente fuori ambito e non deve essere modificato.

## Obiettivo e modello di fiducia

L'obiettivo non è introdurre account, password o ruoli utente. L'unità di
identità è una **connessione del browser**, assimilabile a un dispositivo
approvato dall'amministratore.

Una connessione possiede un identificatore stabile e un token opaco. La
scadenza sospende l'accesso, ma non cambia l'identificatore: dopo una nuova
approvazione lo stesso browser torna a vedere i job creati in precedenza. La
revoca disabilita invece quella connessione. Se il browser elimina anche la
copia locale del token, non può recuperare autonomamente l'identità precedente.

Il token è una capability: chi lo possiede agisce come quella connessione. Per
questo motivo deve essere casuale, mai inserito negli URL, mai scritto nei log e
mai mostrato dai comandi amministrativi.

### Confini di sicurezza

- Il browser approvato è considerato attendibile per l'invio di training job.
- Il backend è raggiungibile soltanto da una LAN fidata.
- L'amministratore controlla la macchina backend e i file locali usati dai
  comandi `just`.
- Valkey non deve essere esposto alla LAN; resta accessibile soltanto ai servizi
  backend.
- Un job appartiene alla connessione che lo ha creato, non all'indirizzo IP e
  non al nome facoltativo del dispositivo.
- La verifica del proprietario deve avvenire sul backend per ogni operazione;
  nascondere job nel frontend non costituisce autorizzazione.

### Rischio che resta fuori da questo incremento

Il pairing chiude l'accesso anonimo e definisce l'ownership, ma non rende sicuro
il contratto Hydra attuale. Un browser approvato può ancora inviare target e
override troppo liberi. L'allowlist server-side di dataset, optimizer, trainer
e override resta un intervento di sicurezza separato e necessario prima di
considerare affidabile un client approvato ma non pienamente fidato.

## Esperienza utente prevista

### Prima connessione

1. Nella sidebar Training l'utente inserisce un URL assoluto HTTP/HTTPS e,
   facoltativamente, un nome come `Portatile laboratorio`.
2. Il frontend normalizza l'URL, verifica `GET /health` e crea una richiesta di
   pairing.
3. Il backend restituisce una sola volta il token opaco, l'identificatore della
   richiesta, un codice breve di verifica e la scadenza della richiesta.
4. Il frontend mostra il codice e lo stato `In attesa di approvazione`, quindi
   interroga periodicamente lo stato della richiesta usando il token.
5. Sulla macchina backend l'amministratore esegue `just pairing-pending`,
   confronta il codice e approva o rifiuta.
6. Dopo l'approvazione lo stesso token diventa valido per le API protette. Il
   frontend lo memorizza e carica dataset e job appartenenti alla connessione.

Il codice breve serve soltanto a evitare l'approvazione della richiesta
sbagliata. Non è un segreto e non sostituisce il token casuale.

### Riapertura e scadenza

- All'apertura della sidebar il frontend ripristina URL e token da
  `localStorage`, poi verifica la sessione con `GET /session`.
- Una sessione ancora attiva viene riutilizzata senza intervento umano.
- Una sessione scaduta può creare una richiesta di rinnovo autenticata con il
  vecchio token. Dopo l'approvazione mantiene lo stesso `connection_id`, quindi
  continua a possedere i job precedenti.
- Una sessione revocata non può essere rinnovata con il vecchio token. Può
  soltanto iniziare un nuovo pairing, ottenendo una nuova identità senza accesso
  ai job della connessione revocata.

### Disconnessione

La UI espone due azioni distinte:

- **Dimentica su questo browser**: cancella URL/token locali, senza modificare
  la connessione sul backend; essa resta valida fino alla scadenza o revoca;
- **Disconnetti e revoca**: chiama `DELETE /session`, poi cancella sempre i dati
  locali. Il token non può più accedere alle API.

La seconda azione richiede una conferma esplicita perché interrompe anche
eventuali altre schede che condividono lo stesso storage del browser.

## Protocollo di pairing

### Token

Il backend genera almeno 256 bit casuali tramite un generatore crittografico.
Un formato versionato permette di estrarre l'identificatore senza cercare tutti
i record, per esempio:

```text
nnm_v1.<connection_id>.<random_secret>
```

Valkey conserva soltanto `SHA-256(token)` e il confronto usa una funzione a
tempo costante. Un hash veloce è appropriato perché il token ha alta entropia;
non è una password scelta da una persona. Il token completo compare una sola
volta nella risposta HTTPS/HTTP al browser e in `localStorage`.

### Stati

Una richiesta di pairing attraversa:

```text
pending -> approved
        -> rejected
        -> expired
```

Una connessione attraversa:

```text
pending -> active -> expired -> active  (rinnovo approvato)
                  -> revoked            (terminale per quel token)
```

La richiesta breve scade separatamente dalla sessione, indicativamente dopo
10 minuti. La durata è configurabile, ma non viene scelta dal browser.

### Metadati visibili all'amministratore

I comandi mostrano solo informazioni utili alla decisione:

- ID abbreviato della richiesta e della connessione;
- codice di verifica;
- nome facoltativo del dispositivo;
- IP osservato dal backend;
- `Origin` e user-agent dichiarati;
- data di creazione, stato, scadenza e ultimo utilizzo;
- indicazione `new` oppure `renewal`.

IP, Origin, user-agent e nome sono descrittivi e non partecipano
all'autenticazione.

### Protezione dagli abusi

Gli endpoint pubblici di pairing devono applicare almeno:

- scadenza automatica delle richieste pendenti;
- un numero massimo di richieste pendenti per IP e un limite globale;
- risposta `429` con `Retry-After` quando il limite è superato;
- limite di lunghezza e normalizzazione del nome dispositivo;
- nessuna informazione sulle sessioni o sui job nelle risposte pubbliche;
- audit delle decisioni approve/reject/revoke senza token o hash del token.

## Contratto HTTP proposto

### Endpoint pubblici

| Metodo | Endpoint | Scopo |
|---|---|---|
| `GET` | `/health` | Verifica raggiungibilità, senza dati sensibili |
| `POST` | `/pairing/requests` | Crea una nuova richiesta e restituisce una volta il token |
| `GET` | `/pairing/requests/{request_id}` | Legge solo lo stato della propria richiesta usando il token |
| `POST` | `/pairing/renewals` | Crea una richiesta per una connessione scaduta |

Il token di una richiesta pending è valido esclusivamente per controllare
quella richiesta. Non autorizza dataset, compute unit o job.

### Endpoint della connessione

Tutti richiedono `Authorization: Bearer <token>` con connessione attiva:

| Metodo | Endpoint | Scopo |
|---|---|---|
| `GET` | `/session` | Stato, nome, `connection_id` e scadenza correnti |
| `DELETE` | `/session` | Revoca la connessione corrente |
| `GET` | `/datasets` | Dataset disponibili |
| `GET` | `/compute-units` | Profili di calcolo disponibili |
| `POST` | `/jobs` | Crea un job assegnandogli il proprietario corrente |
| `GET` | `/jobs` | Elenca soltanto i job del proprietario corrente |
| `GET` | `/jobs/{id}` | Legge un job posseduto |
| `GET` | `/jobs/{id}/logs` | Legge i log di un job posseduto |
| `GET` | `/jobs/{id}/events` | Stream degli eventi di un job posseduto |
| `DELETE` | `/jobs/{id}` | Cancella un job posseduto |

Una richiesta autenticata relativa al job di un'altra connessione risponde
`404`, non `403`, per non confermare l'esistenza dell'identificatore. Token
mancante, invalido, scaduto o revocato produce `401` con un codice errore
machine-readable che consenta al frontend di distinguere rinnovo e nuovo
pairing.

### Endpoint amministrativi

Gli endpoint amministrativi non compaiono nella documentazione OpenAPI
pubblica e richiedono una capability generata sulla macchina backend, diversa
dai token browser. I comandi `just` sono il client supportato; il segreto non è
una password utente e non viene stampato.

| Metodo | Endpoint interno | Comando `just` |
|---|---|---|
| `GET` | `/admin/pairing/requests` | `pairing-pending` |
| `POST` | `/admin/pairing/requests/{id}/approve` | `pairing-approve ID [TTL]` |
| `POST` | `/admin/pairing/requests/{id}/reject` | `pairing-reject ID` |
| `GET` | `/admin/sessions` | `sessions` |
| `DELETE` | `/admin/sessions/{id}` | `session-revoke ID` |
| `GET` | `/admin/jobs` | `admin-jobs` |
| `GET` | `/admin/jobs/{id}` | `admin-job ID` |
| `GET` | `/admin/jobs/{id}/logs` | `admin-job-logs ID` |
| `GET` | `/admin/jobs/{id}/events` | `admin-job-events ID [AFTER]` |
| `DELETE` | `/admin/jobs/{id}` | `admin-job-cancel ID` |

Usare il processo backend per la cancellazione amministrativa è importante:
un processo CLI separato che modifichi soltanto Valkey non possiede gli handle
degli executor e potrebbe marcare `cancelled` un training ancora in esecuzione.

## Credenziale amministrativa locale

`just admin-init` genera una capability casuale in un file con permessi `0600`,
fuori dal versionamento, per esempio `converted/valkey-data/admin.token`.
Backend e comandi `just` leggono il percorso da `NNM_ADMIN_TOKEN_FILE`.

Le recipe amministrative:

- leggono il segreto senza stamparlo né inserirlo nella query string;
- lo inviano in un header dedicato alle API amministrative;
- puntano per default a `127.0.0.1`, anche quando il backend ascolta su un
  indirizzo LAN;
- falliscono con un messaggio operativo se il file manca o ha permessi troppo
  aperti;
- non accettano il segreto come argomento della shell.

L'header segreto protegge anche da configurazioni future con proxy che rendano
inaffidabile il solo controllo dell'IP loopback. La documentazione continua
comunque a supportare i comandi amministrativi esclusivamente dalla macchina
backend.

## Configurazione backend

Variabili proposte:

| Variabile | Default | Significato |
|---|---|---|
| `NNM_SESSION_TTL` | `24h` | Durata usata se approve non specifica un override |
| `NNM_PAIRING_REQUEST_TTL` | `10m` | Durata della richiesta pendente |
| `NNM_PAIRING_MAX_PER_IP` | `5` | Richieste pendenti ammesse per IP |
| `NNM_PAIRING_MAX_GLOBAL` | `100` | Limite globale delle pending |
| `NNM_ALLOWED_ORIGINS` | origini Vite locali documentate | Allowlist CORS esatta |
| `NNM_ADMIN_TOKEN_FILE` | `converted/valkey-data/admin.token` | Capability amministrativa locale |

Le durate accettano un formato documentato e non ambiguo (`30m`, `24h`, `7d`),
sono validate positive e hanno un limite massimo esplicito per evitare errori
operativi. Il valore passato a `pairing-approve` prevale soltanto per quella
approvazione.

Il wildcard CORS attuale viene rimosso. Per un frontend servito da un'altra
macchina o porta, l'amministratore deve aggiungere la sua Origin esatta a
`NNM_ALLOWED_ORIGINS`. CORS non sostituisce l'autenticazione, ma riduce le
richieste di pairing indotte da siti estranei.

## Modello dati e persistenza

### Sessione/connessione

Record persistente indicativo:

```json
{
  "id": "connection-uuid",
  "token_hash": "sha256-hex",
  "device_name": "Portatile laboratorio",
  "status": "active",
  "created_at": "...",
  "approved_at": "...",
  "expires_at": "...",
  "last_seen_at": "...",
  "revoked_at": null,
  "last_client_host": "192.168.1.25",
  "last_origin": "http://192.168.1.25:5173",
  "last_user_agent": "..."
}
```

La sessione non viene eliminata automaticamente alla scadenza perché conserva
l'identità proprietaria dei job e può essere rinnovata. Una futura policy di
retention potrà rimuoverla solo insieme a una decisione esplicita sui job.

### Richiesta di pairing

Il record contiene ID, `connection_id`, codice, tipo new/renewal, stato,
metadati client e scadenza breve. Valkey applica un TTL alle richieste concluse
o scadute; l'audit minimo rimane separato.

### Job

Ogni nuovo record job aggiunge `owner_connection_id` come campo interno. Non
viene aggiunto a `JobStatus`, per non esporre identificatori non necessari.

I job già presenti al momento dell'upgrade, privi di owner, diventano
`legacy-unowned`: nessun browser può vederli, mentre i comandi amministrativi
continuano a elencarli e gestirli. Non avviene alcuna assegnazione automatica al
primo browser approvato.

Per ridurre il rischio di bypass accidentali, i metodi applicativi per status,
log, eventi e cancellazione richiedono esplicitamente un `owner_connection_id`.
Le operazioni amministrative sono metodi distinti, non un owner opzionale con
default `None`.

### Componenti backend

Separare le responsabilità in:

- `AuthService`: token, pairing, approvazione, scadenza, rinnovo e revoca;
- `AuthStore` protocol: persistenza, con implementazioni Valkey e in-memory;
- dependency FastAPI per estrarre e validare la connessione corrente;
- dependency separata per la capability amministrativa;
- `JobManager`: ownership persistita e metodi user/admin espliciti;
- CLI sottile usata dalle recipe `just`, che parla con le API amministrative.

`create_app` deve permettere l'iniezione di manager, auth service e admin
credential nei test, senza richiedere una Valkey reale.

## Frontend

### Stato della connessione

Introdurre un modulo TypeScript dedicato, separato dalla UI, che gestisca:

- normalizzazione e validazione del base URL a runtime;
- record persistito versionato in `localStorage` e indicizzato per URL backend;
- stati `disconnected`, `checking`, `pending`, `active`, `expired`, `rejected` e
  `error`;
- creazione e polling del pairing;
- rinnovo, revoca e cancellazione locale;
- costruzione degli header Bearer per tutte le richieste protette.

I dati API, come liste dataset e job, vengono riassegnati in blocco e restano
`$state.raw` o stato semplice dove appropriato. Stato derivato della UI viene
espresso con `$derived`; polling e rete partono da handler espliciti e vengono
interrotti nel cleanup del componente.

### UI della sidebar

Prima dei campi di training, la sidebar presenta:

- URL del backend;
- nome dispositivo facoltativo;
- pulsante `Connetti`;
- codice e stato della richiesta pending;
- backend attivo e scadenza della sessione;
- azioni `Dimentica` e `Disconnetti e revoca`.

Dataset, risorse, invio e job non vengono caricati o mostrati come operativi
finché la connessione non è attiva. Errori di rete, CORS, rifiuto e scadenza
devono avere messaggi distinti e suggerire l'azione corretta.

### REST e SSE

`training/api.ts` non deve più calcolare una base URL immutabile al caricamento
del modulo. Ogni client usa la connessione attiva e aggiunge il Bearer token.

Il `EventSource` nativo non permette header `Authorization`. Lo stream eventi
viene quindi consumato con `fetch`, `ReadableStream` e `AbortController`, con
parsing SSE incrementale e riconnessione tramite l'ultimo stream ID. Il token
non deve comparire nella query string, nella cronologia o nei log del server.

## Strategia TDD

Ogni fase parte da test fallenti che descrivono il comportamento pubblico; si
implementa il minimo necessario e si effettua il commit soltanto con suite
verde. Non verranno creati commit contenenti esclusivamente test rossi.

### Backend: unit test

Testare con clock e generatori di token iniettati:

1. token casuale restituito una sola volta e hash persistito;
2. token errato non autentica e confronto non espone dettagli;
3. pending non accede alle API protette;
4. approve usa TTL globale, mentre override usa il valore richiesto;
5. reject, expiry e revoke producono gli stati previsti;
6. renewal conserva `connection_id` e ownership;
7. una connessione revocata non può rinnovare;
8. limiti per IP/globale e TTL delle pending;
9. audit privo di token e token hash;
10. parser delle durate, inclusi valori invalidi e overflow.

I test temporali usano un clock iniettato invece di attese reali.

### Backend: API e autorizzazione

Con due connessioni approvate A e B:

1. senza token soltanto health e pairing rispondono;
2. dataset e compute unit richiedono una sessione active;
3. un job inviato da A salva `owner_connection_id=A`;
4. A elenca, legge, segue, legge log e cancella i propri job;
5. B riceve `404` per tutte le operazioni sul job di A;
6. list jobs di B non include job di A né legacy-unowned;
7. expiry interrompe REST e una nuova apertura SSE;
8. revoca corrente invalida immediatamente il token;
9. capability admin assente/errata viene rifiutata;
10. admin può vedere e cancellare job di A, B e legacy-unowned;
11. CORS accetta solo le Origin configurate;
12. nessuna risposta o log contiene token o hash.

Includere almeno un test Valkey reale per TTL, persistenza tra due istanze del
service e revoca, mantenendo i test unitari veloci con `InMemoryAuthStore`.

### Frontend: Vitest

Test puri TypeScript con `fetch`, storage e clock sostituiti:

1. normalizzazione URL e rifiuto di schemi non HTTP(S);
2. salvataggio/ripristino versionato per backend URL;
3. token aggiunto alle API protette ma mai agli endpoint o URL;
4. pairing pending, approved, rejected ed expired;
5. rinnovo che conserva la connessione;
6. `Dimentica` solo locale e `revoca` locale + remota;
7. risposta `401 session_expired` porta allo stato corretto;
8. parser SSE gestisce chunk spezzati, più eventi e ultimo ID;
9. `AbortController` chiude polling e stream al cambio backend/unmount;
10. nessuna chiamata dataset/job avviene prima dello stato active.

### Verifica browser

Dopo le suite automatiche, usare Chrome direttamente tramite la skill del
progetto, senza MCP, per verificare:

1. inserimento di un URL LAN e nome dispositivo;
2. richiesta visibile con `just pairing-pending` e codice corrispondente;
3. approve con TTL default e custom;
4. persistenza dopo refresh e riapertura;
5. due profili browser che non vedono i job reciproci;
6. stream log/eventi autenticato senza token nella URL;
7. revoca amministrativa e revoca dal frontend;
8. messaggi comprensibili per CORS, backend irraggiungibile, reject ed expiry.

## Sequenza implementativa e commit

1. **`feat(backend): add persistent pairing sessions`**  
   Modelli, `AuthService`, store in-memory/Valkey, clock/token iniettati e test di
   lifecycle, TTL, rinnovo, revoca e rate limit.

2. **`feat(backend): require paired sessions for training API`**  
   Endpoint pubblici di pairing, dependency Bearer, protezione dataset/compute
   units/job e test API per stati sessione.

3. **`feat(backend): isolate jobs by connection owner`**  
   Owner interno obbligatorio, metodi user/admin distinti, comportamento
   legacy-unowned e matrice di test A/B su list/status/log/events/cancel.

4. **`feat(backend): add just-based administration`**  
   Capability locale, API admin nascoste, CLI, recipe approve/reject/list/revoke
   e gestione completa dei job, con test dei comandi e segreti non esposti.

5. **`feat(frontend): add backend pairing flow`**  
   Base URL runtime, storage, stato connessione, UI di pairing/rinnovo/revoca e
   test Vitest.

6. **`feat(frontend): authenticate training events`**  
   Client SSE su fetch, cancellazione e reconnect con cursore, test del parser e
   integrazione nella sidebar.

7. **`docs(training): document LAN pairing and operations`**  
   Aggiornamento di `docs2/source/remote_training.rst`, README backend, esempi
   `just`, configurazione CORS/firewall, limiti del modello e verifica browser.

Ogni commit deve lasciare funzionanti i test esistenti. Se una modifica del
contratto attraversa backend e frontend, si mantiene temporaneamente una
compatibilità interna oppure si accorpano i due passi senza lasciare la branch
in uno stato non eseguibile.

## Comandi di verifica previsti

Riutilizzare le recipe esistenti e aggiungerne di nuove al justfile del backend:

```bash
just --justfile converted/backend/justfile test
pnpm --dir front-end test
pnpm --dir front-end check
pnpm --dir front-end build
cd docs2 && uv run make html
```

Per la prova operativa:

```bash
just --justfile converted/backend/justfile admin-init
just --justfile converted/backend/justfile pairing-pending
just --justfile converted/backend/justfile pairing-approve REQUEST_ID
just --justfile converted/backend/justfile pairing-approve REQUEST_ID 8h
just --justfile converted/backend/justfile sessions
just --justfile converted/backend/justfile session-revoke CONNECTION_ID
just --justfile converted/backend/justfile admin-jobs
```

## Documentazione operativa obbligatoria

La documentazione ufficiale deve dichiarare chiaramente:

- supporto esclusivo a LAN fidata in questa fase;
- divieto di esporre direttamente API, Valkey o admin token su Internet;
- HTTP trasmette bearer token in chiaro sulla rete: usare una rete fidata e,
  quando possibile, HTTPS anche in LAN;
- configurazione firewall, bind address e allowlist CORS esatta;
- generazione, backup, permessi e rotazione dell'admin token;
- pairing, approve con TTL, reject, list, revoke e rinnovo;
- semantica di ownership e trattamento dei job legacy;
- differenza fra dimenticare localmente e revocare;
- perdita del token browser e conseguenze sull'accesso ai vecchi job;
- rischio Hydra residuo e assenza di account/password/RBAC;
- MCP non supporta ancora questo flusso e non va puntato al backend protetto in
  questa prima iterazione.

## Criteri di accettazione

La feature è completa quando:

1. nessuna API di training è utilizzabile anonimamente;
2. una richiesta non approvata non può creare o osservare job;
3. approve/reject/revoke sono effettuabili dalla macchina backend via `just`;
4. TTL globale 24h e override per singola approvazione sono verificati;
5. refresh e riavvio browser preservano una sessione non scaduta;
6. rinnovo preserva l'accesso ai job della stessa connessione;
7. due connessioni non possono elencare né indirizzare i job reciproci;
8. l'amministratore può gestire tutti i job senza falsificarne l'owner;
9. token browser e admin non compaiono in URL, output dei comandi o log;
10. SSE funziona con Bearer header, reconnect e cancellazione;
11. CORS non usa wildcard e la configurazione LAN è documentata;
12. backend, frontend, documentazione e verifica Chrome risultano verdi;
13. nessun file del server MCP è modificato.
