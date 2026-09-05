---
kind: knowledge
status: current
updated: 2026-09-05
---

# Dataset e stereotipi UI: difetti noti e QA di regressione

Questo documento raccoglie i difetti individuati nell'integrazione tra gestione
dataset, stereotipi, editor e training. Le procedure di chiusura sono requisiti di verifica,
non dichiarazioni che le correzioni siano già state applicate. Aggiornare o
rimuovere la descrizione del difetto quando la relativa QA passa; conservare
l'evidenza di esecuzione fuori dalla KB corrente.

Fixture: [Variational Autoencoder](../../../examples/diagrams/package/models/variational-autoencoder/model.json).
L'indagine ha usato la UI nel Browser integrato e l'apertura progetto via MCP;
le prove di scrittura hanno usato una copia. Alcuni file applicativi avevano già
modifiche locali: i risultati descrivono lo stato osservato, senza attribuire i
problemi a uno specifico commit.

Contratti di riferimento:

- [Dataset di progetto e batch nominati](../decisions/project-owned-datasets.md).
- [Tipi Input derivati dal dataset](../decisions/dataset-driven-input-types.md).
- [Authoring degli stereotipi di progetto](../decisions/project-workspaces-and-stereotype-authoring.md).
- [Strategia di testing](strategy.md).

Priorità: P1 = perdita di stato o blocco del flusso; P2 = funzionalità limitata
o dati del form interpretati male. Le limitazioni di copertura sono indicate
esplicitamente: una diagnosi da controller/codice non equivale a una prova UI
end-to-end con backend connesso.

## Difetti verificati

### 1. P1 — Dataset e diagramma sovrascrivono reciprocamente lo stato salvato

Riproduzione: creare `project.dataset` da Packages → Dataset. Il manifest su disco contiene il nuovo riferimento, ma `export_diagram` restituisce ancora solo MNIST. Spostare Input da x=330 a x=350 e premere Salva: il riferimento al nuovo dataset scompare dal manifest. Creare poi `audit.second`: la posizione su disco torna a x=330, pur essendo stata salvata a x=350.

Causa: `ProjectDatasetAuthoringCoordinator` conserva una copia iniziale del documento e la riscrive; i callback di FlowCanvas installano il dataset nel controller training senza aggiornare il manifest del Diagram. Il salvataggio del diagramma usa invece `diagram.exportToJson()`.

Fonti: [FlowCanvas.svelte:154](../../../front-end/src/FlowCanvas.svelte), [FlowCanvas.svelte:196](../../../front-end/src/FlowCanvas.svelte), [dataset-authoring.ts:234](../../../front-end/src/project-workspace/dataset-authoring.ts).

**QA richiesta — integrazione persistenza + browser.**

1. Su una copia del VAE, spostare un nodo, modificare un parametro e salvare. Creare un dataset.
2. Confrontare il modello vivo, l'export MCP e model.json: devono contenere sia le modifiche del grafo sia il nuovo dataset.
3. Modificare ancora il grafo e salvare; il dataset deve rimanere nel manifest. Riaprire da disco e ripetere per modifica e cancellazione dataset.
4. Ripetere con modifiche del grafo ancora non salvate e con un salvataggio in corso: nessuna operazione deve ripristinare silenziosamente uno snapshot vecchio o perdere il draft.

**Criterio di chiusura:** nessuna perdita di nodi, parametri, posizioni, package o dataset; tutti i proprietari dello stato concordano dopo il salvataggio. Coprire con un test di integrazione che alterni il writer del modello e il coordinatore dataset, non solo test isolati del coordinatore.

### 2. P1 — Creazione e modifica via MCP non persistono i file dataset

Riproduzione: creare un dataset nella UI. Compare “Dataset created.” e viene salvato il riferimento nel model.json, ma `datasets/project-dataset/dataset.json` non esiste su disco. Riaprendo la copia, la diagnostica è: `Project dataset 'project.dataset@1.0.0' is missing manifest.json, dataset.json, dataset.py`. Il caricamento del catalogo dataset fallisce, rendendo indisponibile anche MNIST nella sessione.

Causa: la sessione per i progetti aperti via MCP usa `MemoryDirectory`; il callback remoto persiste solo model.json. Le scritture di definizioni, Python e dati restano nella mappa in memoria.

Fonte: [path.ts:20](../../../front-end/src/project-workspace/path.ts). Ambito verificato: apertura via MCP; non estendere questo risultato al file picker nativo.

**QA richiesta — browser + filesystem reale + riapertura MCP.**

1. Aprire via MCP una copia del VAE; creare un dataset con un piccolo file binario locale.
2. Controllare su disco manifest.json, dataset.json, dataset.py e data/: contenuti e hash del binario devono coincidere con quelli scelti nella UI.
3. Modificare nome/descrizione e sostituire esplicitamente un file; verificare che Python e file non modificati conservino gli hash originali.
4. Chiudere e riaprire il progetto in una nuova sessione: elenco, metadati e dati devono essere presenti, senza diagnostiche di risorse mancanti.
5. Simulare errore di scrittura o disconnessione del bridge: nessuna conferma di successo prima del completamento; niente riferimenti pendenti a cartelle incomplete. Eseguire anche il percorso di apertura nativo, se disponibile.

**Criterio di chiusura:** risorse e manifest persistiti coerentemente, confermati dalla riapertura; test del trasporto sul filesystem reale, non soltanto MemoryDirectory.

### 3. P1 — Cambio dataset rifiutato per parametri residui del precedente

Riproduzione attraverso l'API del controller condiviso con la UI: con MNIST selezionato, scegliere il dataset di prova passando i suoi parametri. Risposta: `Parametro dataset sconosciuto: B, num_workers, train_size`.

Causa: `updateConfig` unisce sempre i parametri vecchi e nuovi, anche quando cambia `selectedDataset`. La UI chiama lo stesso metodo e aggiorna prima il proprio draft: il valore visualizzato può quindi divergere da quello accettato dal controller.

Fonti: [controller.ts:371](../../../front-end/src/training/controller.ts), [TrainingSidebar.svelte:184](../../../front-end/src/components/TrainingSidebar.svelte).
Prova effettuata via MCP; il selettore della UI con backend attivo non è stato esercitato.

**QA richiesta — controller + selettore browser con backend attivo.**

1. Preparare due dataset compatibili con il VAE ma con insiemi diversi di parametri facoltativi, mantenendo B obbligatorio.
2. Configurare A, passare a B, compilare i campi obbligatori, poi tornare ad A. Controllare via MCP selezione e tipi dei valori.
3. Verificare che B non contenga chiavi esclusive di A e viceversa; un errore deve lasciare coerenti selettore e configurazione accettata.
4. Rimuovere o rinominare un parametro del dataset selezionato tramite il form; verificare che la riconciliazione non conservi chiavi ormai vietate.

**Criterio di chiusura:** cambio selezione consentito senza parametri estranei; aggiornamento di un singolo valore nello stesso dataset preserva gli altri. La prova include campi obbligatori temporaneamente incompleti.

### 4. P1 — I parametri numerici e booleani del Training restano stringhe

Verifica della funzione reale `coerce`, estratta dal componente e transpilata con TypeScript: `coerce('64','integer')`, `coerce('0.8','number')` e `coerce('true','boolean')` restituiscono tutte stringhe.

Causa: il componente riconosce soltanto `int`, `float`, `bool`; il contratto dataset usa `integer`, `number`, `boolean`. Il controller rifiuta i valori e `syncConfigFromDraft` intercetta l'errore senza mostrarlo. Quindi la modifica non raggiunge la configurazione utilizzata dal training.

Fonte: [TrainingSidebar.svelte:201](../../../front-end/src/components/TrainingSidebar.svelte).
Verifica eseguibile della funzione e lettura del chiamante; non prova end-to-end con backend connesso.

**QA richiesta — componente Svelte + browser + payload di training.**

1. Compilare nella UI parametri integer, number, boolean e string: usare B=64, train_size=0.8, booleani true e false e una stringa ordinaria.
2. Leggere get_training_config e la richiesta effettivamente preparata: i tipi JSON devono essere number/number/boolean/string, senza conversioni in testo.
3. Provare campo vuoto, testo non numerico, decimale per integer e testo booleano errato: mostrare uno stato di validazione comprensibile; non inviare un valore vecchio fingendo di usare il draft.
4. Cambiare B e verificare l'aggiornamento del contratto Input nella UI e via MCP; inviare una breve run VAE con parametri validi.

**Criterio di chiusura:** valore digitato, controller, inferenza e job concordano. Un test della sola funzione coerce non sostituisce l'interazione sul componente.

### 5. P2 — Configurazione dataset locale nascosta senza backend

Riproduzione sul VAE originale: aprire Training con backend irraggiungibile. La UI mostra “Failed to fetch”, URL backend e richiesta di connessione; non permette di selezionare il dataset locale né impostare B. MCP conferma che MNIST è già caricato nel controller e che B manca: l'Input non può risolvere il contratto.

Causa: tutta la sezione Dataset è subordinata a `connectionState === 'active'`, benché sia necessaria anche per l'inferenza locale dei tipi. La mancanza di B nell'esempio è uno stato da completare; il difetto è l'impossibilità di completarlo dalla UI offline.

Fonte: [TrainingSidebar.svelte:427](../../../front-end/src/components/TrainingSidebar.svelte).

**QA richiesta — browser offline e transizione di connessione.**

1. Aprire il VAE senza backend raggiungibile; selezionare MNIST e impostare B da UI.
2. Verificare che i controlli dataset restino accessibili e che Input risolva shape [B,1,28,28] e dtype float32; distinguere eventuali diagnostiche indipendenti del modello.
3. Collegare il backend e poi renderlo irraggiungibile: selezione e configurazione locale devono rimanere utilizzabili; il submit remoto deve indicare il problema di connessione.

**Criterio di chiusura:** editing e inferenza locale del contratto dataset funzionano senza pairing o rete; il backend è richiesto per le operazioni remote.

### 6. P2 — Numero e nomi delle classi scartati

Riproduzione: creare un dataset con Class count=2 e Class names=`cat, dog`. Dopo “Dataset created.”, premere Edit: entrambi i campi sono vuoti.

Causa: il binding Svelte di un input `type=number` produce un numero, ma `requestFromForm` mantiene `classCount` solo se è una stringa. Il numero viene trasformato in stringa vuota e l'intero oggetto `classes` viene omesso.

Fonte: [DatasetForm.svelte:152](../../../front-end/src/components/DatasetForm.svelte).

**QA richiesta — form Svelte reale + round trip.**

1. Creare con count=2 e nomi cat,dog; verificare oggetto classes nel catalogo e su disco, riaprire Edit e poi il progetto.
2. Aggiornare a count=3 con tre nomi; ripetere la verifica. Provare count senza nomi e rimozione intenzionale dei metadati.
3. Provare count=0, negativo, frazionario e numero di nomi diverso dal count: rifiutare con errore senza modificare i dati salvati.

**Criterio di chiusura:** valori validi preservati in creazione e modifica; nessuna omissione silenziosa causata dal binding numerico.

### 7. P2 — Cancellazione non disponibile per progetti aperti via MCP

Riproduzione sul dataset creato nella copia: Delete → Delete dataset. Errore: `The browser cannot remove project dataset directories`. Il dataset rimane nell'elenco.

Causa: `MemoryDirectory` non implementa `removeEntry`; il coordinatore rifiuta l'operazione prima della scrittura.

Fonte: [path.ts:80](../../../front-end/src/project-workspace/path.ts).

**QA richiesta — cancellazione browser su fixture sacrificabile + rollback.**

1. In una copia usa-e-getta del VAE, creare un dataset di prova e selezionarlo; Delete → Cancel deve lasciare tutto invariato.
2. Confermare la cancellazione del solo dataset di prova. Verificare rimozione della cartella esatta, del riferimento nel manifest, del catalogo e del descrittore training; riaprire il progetto.
3. MNIST, il grafo e i file degli altri dataset devono rimanere invariati. Ripetere con dataset non selezionato e con apertura nativa, se disponibile.
4. Simulare errore di rimozione: riferimento e catalogo devono essere ripristinati e l'errore visibile. Non eliminare archivi backend o job storici.

**Criterio di chiusura:** cancellazione completa nel percorso MCP e rollback coerente; mai provare la cancellazione sull'esempio originale.

### 8. P2 — Default booleani errati accettati silenziosamente

Riproduzione: aggiungere un parametro booleano facoltativo, impostare default=`not-a-boolean`, salvare. La UI conferma “Dataset updated.”. Premendo Edit il valore diventa `false`.

Causa: qualsiasi testo diverso da `true` viene convertito in false prima della validazione. Serve validare la rappresentazione oppure usare un controllo booleano.

Fonte: [DatasetForm.svelte:158](../../../front-end/src/components/DatasetForm.svelte).

**QA richiesta — validazione form + catalogo + persistenza.**

1. Salvare default true e false, riaprire Edit e controllare che siano booleani nel contratto.
2. Provare not-a-boolean e altri input non supportati: il form deve rifiutarli senza salvare false. Se si usa un controllo a scelta, verificare che non possa produrre valori arbitrari.
3. Provare default assente e parametro obbligatorio, rispettando il contratto; ripetere in creazione e modifica.

**Criterio di chiusura:** nessuna normalizzazione silenziosa di testo invalido; false deve restare distinguibile dall'assenza di default.

## Stereotipi: difetti verificati nella UI

### 9. P1 — La creazione di uno stereotipo fallisce già con il form predefinito

**Riproduzione UI:** aprire una copia del VAE via MCP, Packages → Stereotype,
lasciare ID `model.custom`, kind Layer e nessun parametro, premere Submit
stereotype. Il form mostra `Failed to execute 'structuredClone' on 'Window':
[object Object] could not be cloned.` e il nuovo stereotipo non compare nel
catalogo. Il caso minimo non richiede alcun input malformato.

**Causa:** `parameters` è uno stato Svelte profondamente reattivo, quindi un
Proxy anche quando è un array vuoto. Il form lo passa direttamente alla
richiesta; il generatore usa `structuredClone(input)` e `structuredClone(row)`,
che non accettano Proxy. Serve una richiesta composta da dati ordinari al
confine tra componente e dominio, senza introdurre dipendenze Svelte nel
generatore.

Fonti: [StereotypeForm.svelte](../../../front-end/src/components/StereotypeForm.svelte),
[generator.ts](../../../front-end/src/stereotype-authoring/generator.ts).

**QA richiesta — componente montato + browser.**

1. Eseguire la creazione predefinita attraverso il vero form Svelte, non tramite
   una chiamata al generatore con un oggetto letterale. Verificare assenza
   dell'errore di clonazione e presenza nel catalogo e nel selettore del nodo.
2. Ripetere con uno e più parametri, compresi default strutturati list/shape e
   riferimenti a stereotipi: anche i dati annidati devono attraversare il confine.
3. Controllare manifest, quattro file generati, riapertura da disco e invarianti
   del VAE. Su errore devono rimanere invariati catalogo, grafo e filesystem.

**Criterio di chiusura:** il percorso UI reale crea uno stereotipo valido con e
senza parametri; nessun DataCloneError, nessun falso successo o residuo parziale.

## Dataset e type system: origine delle diagnostiche del VAE

Gli undici messaggi `INCOMPLETE` osservati all'apertura non sono undici difetti
indipendenti dei layer. Input non riceve un contratto dataset risolto; i nodi
a valle propagano `one or more input regions are unresolved`. Con il dataset
MNIST del progetto e `B=32` impostato tramite `update_training_config`, senza
cambiare grafo o stereotipi, il VAE restituisce `complete: true`, tutti i nodi
sono `success` e la UI mostra `Type Check 0` / `No type issues.`. L'Input è
`[32,1,28,28] float32` e l'output `[32,784] float32`.

La mancanza iniziale di B è un parametro ancora da compilare, non un motivo per
modificare le regole matematiche dei layer. I bug 4 e 5 impediscono di completare
correttamente questa configurazione dalla UI; i difetti seguenti riguardano
anche la propagazione della configurazione al type system.

La diagnostica successiva `value does not match parameter type 'integer'` non
dimostra che l'utente abbia digitato un tipo errato: `datasetDefaults` costruisce
anche la voce `B: undefined` per il parametro obbligatorio senza default.
`resolveDatasetContract` valida quella voce come un valore fornito e produce
un errore di tipo anziché il messaggio di valore obbligatorio mancante. Le prove
di regressione devono distinguere un campo ancora vuoto da un valore malformato.
Fonti: [controller.ts](../../../front-end/src/training/controller.ts),
[dataset-contract.ts](../../../front-end/src/project-workspace/dataset-contract.ts).

### 10. P1 — Il dataset selezionato non viene sincronizzato automaticamente con l'inferenza

**Riproduzione:** riaprire il VAE senza aprire Training e interrogare i tipi:
Input è `unresolved`, con `dataset selection is required to resolve Input
'image'`. Chiamare soltanto `get_training_config`: il controller restituisce
MNIST già selezionato e, come effetto collaterale della lettura, cambia la
diagnostica dell'Input in errore sul valore B. La lettura del controller applica
quindi un contesto che il caricamento del progetto non aveva applicato.

**Seconda riproduzione, falso verde:** impostare B=32, lasciare Training chiuso,
modificare da Packages → Dataset → Edit la shape input da `B,1,28,28` a
`B,1,14,14` e salvare. Anche `get_type_info(refresh=true)` continua a restituire
`complete: true` e Input `[32,1,28,28]`. Solo dopo `get_training_config` il type
system usa `[32,1,14,14]` e segnala l'incompatibilità dell'encoder. Il refresh
ricalcola quindi su un contratto vecchio, non sul dataset appena salvato.

**Causa:** FlowCanvas installa il catalogo con `setProjectDatasets`, ma non
collega stabilmente gli snapshot del controller a `setDatasetInferenceContext`.
La sincronizzazione vive nel componente TrainingSidebar, montato solo quando
si apre il pannello, e in due richieste MCP (`get_training_config` e
`update_training_config`). La correttezza dell'editor dipende quindi da aver
aperto un pannello o invocato un getter.

Fonti: [FlowCanvas.svelte](../../../front-end/src/FlowCanvas.svelte),
[TrainingSidebar.svelte](../../../front-end/src/components/TrainingSidebar.svelte),
[BrowserRPCHandler.ts](../../../front-end/src/sync/BrowserRPCHandler.ts).

**QA richiesta — lifecycle editor + UI/MCP.**

1. Aprire il VAE senza Training e senza leggere la configurazione via MCP:
   la diagnostica deve riflettere il dataset già selezionato e B da completare,
   non una selezione inesistente.
2. Configurare B e verificare `Type Check 0`; chiudere Training, modificare il
   contratto dataset dalla UI e controllare subito aggiornamento/invalidation
   dei tipi, senza getter MCP usati come riparazione implicita.
3. Ripetere apertura, cambio progetto, selezione e rimozione dataset con sidebar
   chiusa. Confrontare i tipi prima/dopo `get_training_config`: un getter non
   deve correggere o cambiare lo stato osservabile.

**Criterio di chiusura:** la sincronizzazione appartiene al lifecycle
dell'editor e si attiva su ogni cambiamento del catalogo/selezione/parametri,
indipendentemente dai pannelli e dalle letture MCP.

## Altri difetti del form stereotipi

### 11. P1 — I campi numerici dei parametri interrompono la sincronizzazione del form

**Riproduzione UI:** Packages → Stereotype → Add parameter → Type Integer;
inserire Minimum=1 e Maximum=10. La console registra `TypeError: value.trim is
not a function` da `ParameterForm.numberValue`, chiamato da `definition`/`emit`.
Il form non mostra un errore di campo e i valori non vengono inoltrati
correttamente al componente padre. Questo difetto precede e si aggiunge al
DataCloneError del bug 9.

**Causa:** i campi `type=number` usano `bind:value`, che produce numeri (o
undefined sul campo vuoto), mentre `numberValue` chiama incondizionatamente
`.trim()` assumendo una stringa. La stessa funzione serve Minimum, Maximum,
Default, limiti di lunghezza delle liste e valori numerici degli elementi.
Questi ultimi percorsi condividono la causa ma vanno esercitati singolarmente.

Fonte: [ParameterForm.svelte](../../../front-end/src/components/ParameterForm.svelte).

**QA richiesta — componente Svelte reale + console + contratto generato.**

1. Compilare e cancellare Minimum/Maximum/Default per Integer e Number;
   includere zero, negativi validi, decimali per Number e input incompleti.
2. Ripetere con List: min/max items e limiti/default degli elementi numerici.
   Verificare nessuna eccezione in console e nessun valore precedente
   conservato silenziosamente dopo un input valido.
3. Dopo la correzione del bug 9, creare e riaprire lo stereotipo: verificare i
   valori nella definizione effettiva, non soltanto quelli visibili nei campi.
4. Rifiutare in modo visibile limiti contraddittori e default fuori intervallo;
   distinguere campo vuoto da zero. Usare eventi reali di input nel test Svelte.

**Criterio di chiusura:** compilazione, cancellazione e salvataggio dei numeri
non generano eccezioni; richiesta e file generati contengono i valori digitati
con il tipo corretto.

## Lacune e percorsi da verificare prima della chiusura complessiva

Questi punti non sono ulteriori bug end-to-end già riprodotti:

- **Draft iniziale non risolvibile:** il form propone shape B senza dichiarare
  B tra i parametri e consente la creazione. La risoluzione richiede B intero
  obbligatorio. Verificare che la UX produca un default valido oppure esponga
  chiaramente la bozza incompleta, senza promettere che sia pronta al training.
- **Gestione dei singoli file:** nella UI osservata non ci sono rimozione o
  rinomina del singolo file né modifica del loader Python. Non confondere la
  creazione dello scaffold con un import automatico di CSV/immagini. Chiarire
  l'eventuale ampliamento di prodotto separatamente dalle correzioni.
- **File picker e trasporto:** esercitare selezione multipla, aggiunta successiva,
  sostituzione omonima, annullamento, errori di lettura, file binari e nomi non
  validi. Controllare hash, confinamento sotto data/ e conservazione dei file
  non toccati. Verificare limiti backend, byte trasferiti e fallimento visibile,
  come richiesto dal contratto; un upload fallito non deve creare un job.
- **Backend:** durante l'indagine era irraggiungibile. Il messaggio Failed to
  fetch non è di per sé classificato come difetto applicativo. Concludere la QA
  con un backend reale associato, senza mock di successo: caricamento dataset,
  scelta e parametri dalla UI, breve job VAE, verifica del riferimento/digest e
  dei parametri effettivamente usati. Non eseguire il Python del dataset sul
  processo API o sull'host per aggirare un errore del worker.
- **Stereotipi:** il bug 9 blocca la creazione nel percorso UI prima di
  persistenza/attivazione. Dopo la sua correzione esercitare l'intero percorso
  dei quattro file generati, selezione nel nodo, salvataggio e riapertura;
  controllare anche il trasporto MCP che usa la sessione in memoria del bug 2.
  Non dichiarare verificati questi passaggi a valle sulla sola base dei test
  del generatore. Nell'elenco osservato gli stereotipi esistenti non hanno
  comandi di modifica/rimozione: la decisione attuale copre creazione ed editing
  esterno dei sorgenti, quindi un CRUD completo richiede una scelta di scope.

## Gate e criteri di accettazione comuni

Usare la skill di browser prevista dall'host e il lifecycle condiviso del
repository. Il DiagramCore del browser resta l'autorità del grafo: usare MCP
per confrontare lo stato, senza modificare direttamente model.json per simulare
un'azione utente. Per la persistenza osservare anche il filesystem e riaprire
una nuova sessione; un toast di successo non è una prova sufficiente.

1. Aggiungere regressioni al confine responsabile e un test Svelte reale per i
   binding del form. Test con oggetti JavaScript già normalizzati non rilevano
   il problema del campo numerico o del testo booleano.
2. Eseguire prima le suite mirate, aggiornando il filtro se vengono aggiunti file:

   ```bash
   pnpm --dir front-end test --run src/__tests__/datasetContract.test.ts src/__tests__/projectDatasetAuthoring.test.ts src/__tests__/projectDatasetResources.test.ts src/__tests__/trainingController.test.ts
   pnpm --dir front-end check
   ```

   Per i bug degli stereotipi e la sincronizzazione dell'inferenza:

   ```bash
   pnpm --dir front-end test --run src/__tests__/stereotypeForm.test.ts src/__tests__/stereotypeAuthoring.test.ts src/__tests__/datasetDrivenInputContract.test.ts src/__tests__/datasetDrivenInputInference.test.ts src/__tests__/trainingController.test.ts
   ```

   `stereotypeForm.test.ts` attualmente verifica helper e disponibilità del
   componente, senza montarlo e digitare nei campi: aggiungere copertura
   dell'interazione per i bug 9 e 11 e del lifecycle dell'editor per il bug 10.

3. Per modifiche a grafo/persistenza aggiungere i test DiagramCore/workspace
   pertinenti e `pnpm --dir front-end guard:package-only`. Per modifiche al
   protocollo eseguire anche `pnpm --dir mcp-server test`, ricompilare e
   riavviare il bridge prima della QA live. Seguire gli ulteriori gate dei
   rispettivi AGENTS.md in base ai file effettivamente modificati.
4. Eseguire le procedure browser di ciascun difetto su copie sacrificabili del
   VAE. Verificare anche la mancata alterazione di grafo, Python e dati estranei
   all'operazione, sia su successo sia su errore/annullamento.
5. Registrare per ogni correzione: comando e risultato attuale, riproduzione
   prima/dopo, confronto UI/MCP/disco e controlli ancora bloccati. Non segnare
   risolto un bug basandosi soltanto sui test unitari.

Le suite esistenti erano verdi nonostante le riproduzioni descritte: serve
copertura delle interazioni tra componenti, controller e persistenza.
