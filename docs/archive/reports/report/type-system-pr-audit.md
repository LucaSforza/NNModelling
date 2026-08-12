# Audit della pull request — Type System

Data audit: 2026-07-16  
Branch di audit: `type-system-pr-audit`  
Commit analizzato: `c9e5542`  
Base di confronto locale: `origin/master`

## Esito

**Aggiornamento dopo le correzioni: i cinque problemi bloccanti descritti in
questo audit sono stati risolti e coperti da test.** Le sezioni successive
mantengono l'analisi originale come motivazione delle modifiche; non descrivono
piu lo stato corrente del working tree.

In particolare sono stati corretti l'unificazione completa di Einsum, la
composizione tipata di Repeat, la validazione di Concat e dei parametri, il
blocco della conversione sugli errori hard, la visualizzazione unificata di
errori/warning/suggerimenti e l'harness d'integrazione Hydra. Il server MCP ora
espone tipi e diagnostica tramite `get_type_info`; la sua cattura Chrome puo
anche attivare l'hover di un nodo per verificare il tooltip.

La Loss e ora modellata coerentemente nella DSL come layer concettuale con
output rank-1 `[B]` e source handle visibile. Il backend `converted/` continua
intenzionalmente a estrarla come obiettivo terminale: l'esecuzione e propagazione
del suo output concettuale e documentata come lavoro futuro.

**Esito originale dell'audit: changes requested.**

La PR contiene, rispetto al riferimento locale `origin/master`, 62 commit e 98
file modificati, per circa 15.626 righe aggiunte e 97 rimosse. Lo scope comprende
il motore dei tipi, gli stereotype, l'integrazione nell'editor, i test, la
documentazione, il report LaTeX, la pipeline Python e alcuni artefatti generati.

La base del type system e ampia e promettente: il modello dichiarativo delle
firme, il linguaggio di espressioni, l'inferenza di moduli/join/subflow e la
copertura unitaria costituiscono una buona fondazione. Rimangono pero alcuni
problemi di correttezza che rendono le garanzie dichiarate piu forti di quelle
effettivamente offerte dall'implementazione.

## Problemi bloccanti

### 1. L'inferenza di Einsum accetta forme incompatibili

File: `front-end/src/conversion/typeEngine.ts`, metodo di inferenza Einsum,
circa righe 1621-1736.

L'algoritmo verifica il numero di operandi e il rank, ma la fase principale di
unificazione itera sulle label presenti nell'output. Le dimensioni associate a
label contratte, cioe assenti dall'output, possono quindi non essere confrontate.

Esempi potenzialmente accettati in modo errato:

- `ij,jk->ik` con valori differenti per le due dimensioni `j`;
- `ii->` applicato a una matrice non quadrata.

Il test esistente per il conflitto di label verifica una label presente
nell'output e non copre il caso delle dimensioni contratte.

Possibile soluzione:

1. analizzare tutte le label di tutti gli operandi;
2. costruire un unico ambiente `label -> dimensione`;
3. unificare ogni occorrenza ripetuta, comprese le label contratte e diagonali;
4. produrre le dimensioni di output solo dopo che l'ambiente e stato validato;
5. aggiungere test per mismatch contratto, diagonale non quadrata, ellissi e
   output scalare.

### 2. `Repeat` viene tipizzato sempre come trasformazione identity

File frontend: `front-end/src/conversion/typeEngine.ts`, circa righe 659-693.  
File runtime: `converted/src/ops/repeat.py`, circa righe 16-31.

Il frontend esegue l'inferenza del sottografo per raccogliere eventuali errori,
ma restituisce comunque la forma in ingresso. Il runtime, invece, concatena ed
esegue il sottografo per il numero di iterazioni richiesto.

Un sottografo che implementa `D -> 2D` non e shape-preserving. Anche con una
sola iterazione, il risultato corretto deve essere l'output inferito del
sottografo, non l'input originale.

Possibile soluzione:

- con una iterazione, restituire il tipo effettivo del sottografo;
- con piu iterazioni, comporre astrattamente la trasformazione per `N` volte;
- in alternativa, per firme non componibili simbolicamente, richiedere che
  output e input del sottografo siano compatibili e segnalare un errore;
- validare che `iterations` sia un intero maggiore o uguale a uno;
- aggiungere test con blocchi shape-changing e con iterazioni non valide.

Il report LaTeX deve inoltre smettere di descrivere `Repeat` come necessariamente
shape-preserving.

### 3. Gli errori di tipo non impediscono la conversione

File: `front-end/src/FlowCanvas.svelte`, circa righe 180-183.

L'azione di conversione non consulta `typeResult.ok`. Il diagramma puo quindi
essere convertito anche quando il motore ha gia rilevato errori di tipo. Questo
contraddice la garanzia riportata nel report, secondo cui i tipi inferiti
garantiscono la consistenza dell'NNTree prodotto.

Possibile soluzione:

- ricalcolare l'inferenza immediatamente prima della conversione;
- bloccare la conversione in presenza di errori hard;
- consentire la conversione in presenza di soli warning/advisory;
- mostrare un riepilogo con i nodi che impediscono la conversione;
- mantenere una eventuale modalita `force` soltanto come scelta esplicita.

### 4. Warning e suggerimenti vengono calcolati ma non mostrati

File modello: `front-end/src/conversion/tensortypes.ts`, circa righe 336-350.  
File UI: `front-end/src/components/Sidebar.svelte`, circa righe 323-346.  
Componenti interessati: `CustomNode.svelte`, `JoinNode.svelte`,
`SubflowNode.svelte`.

`TypeResult` contiene `warnings` e `suggestions`, ma la Sidebar e i badge dei
nodi leggono solamente `errors`. Di conseguenza:

- i dtype warning non sono visibili;
- le advisory non sono visibili;
- le shape suggestion non sono utilizzabili dall'utente;
- la documentazione descrive una UI piu completa di quella effettiva.

Possibile soluzione: introdurre un view model unico per diagnostics, mantenendo
separati errori, warning e suggerimenti; mostrare badge con severita distinta e
collegare le suggestion al parametro interessato, eventualmente con un'azione
esplicita di applicazione.

### 5. Il test d'integrazione del training non usa in modo affidabile la config generata

File helper: `front-end/src/__tests__/integration/helpers.ts`, circa righe
253-296.  
Parser Python: `converted/src/main.py`, circa righe 95-117.

`runTraining()` costruisce il comando con:

```text
--config-dir=<directory>
--config-name=base
trainer.devices=1
```

Il parser personalizzato di `main.py` riconosce invece la forma separata:

```text
--config-path <directory> --config-name <name>
```

Inoltre `devices` non e presente nella config Hydra strutturata generata e
l'override richiede attualmente `+trainer.devices=1`, oppure l'aggiunta della
chiave alla YAML di default.

Le conseguenze osservate sono:

- fallimento prima del training per l'override Hydra;
- possibilita di caricare la configurazione predefinita invece di quella del
  diagramma sotto test;
- rischio di un falso positivo su un modello diverso da quello dichiarato dal
  nome del test.

Questo e un blocker perche il Tier 3 non dimostra attualmente che la pipeline
appena generata sia quella realmente addestrata.

## Altri problemi importanti

### Sicurezza del rank in Concat

In `front-end/src/conversion/typeEngine.ts`, circa righe 1097-1117, il codice
accede alla dimensione di concatenazione senza garantire che tutti gli input
abbiano il rank necessario. Anche il confronto delle dimensioni non concatenate
presuppone rank uguali.

Sono necessari controlli espliciti per:

- rank uguale tra gli input;
- asse normalizzato e compreso nell'intervallo;
- wildcard con catture compatibili;
- messaggio di errore invece di accesso a `undefined`.

### Parametri invalidi usati solamente nell'output

In `front-end/src/conversion/typeEngine.ts`, circa righe 1470-1477, un
`param_ref` non risolto durante la costruzione dell'output viene trasformato in
simbolico. Il commento assume che l'errore sia gia stato rilevato durante il
matching dell'input, ma cio non vale per parametri presenti solo nell'output,
come alcuni `out_features`.

Occorre prevalidare tutti i parametri referenziati dall'intera firma e
distinguere in modo uniforme `unset`, `invalid` e `resolved`. Va inoltre chiarita
la semantica delle stringhe `Undefined`, `None` e vuota.

### Ricalcolo incompleto dopo le mutazioni del diagramma

Il ricalcolo viene invocato manualmente in alcuni handler di
`FlowCanvas.svelte`, ma non e centralizzato su tutte le mutazioni. Undo/redo,
alcune cancellazioni e le mutazioni ricevute via RPC possono lasciare
annotazioni obsolete.

Possibile soluzione: collegare l'inferenza all'evento centrale `graph_changed`,
con batching o debounce, e rimuovere progressivamente le chiamate duplicate
dagli handler UI.

### Ordinamento degli handle dei join

Gli handle sono ordinati con `localeCompare`. Con piu di nove input, `in-10`
puo precedere `in-2`. Per i join non commutativi l'ordine e parte della
semantica.

Usare il suffisso numerico degli handle o, preferibilmente, l'ordine esplicito
preservato dalla rappresentazione del diagramma.

### Subflow con ingressi o uscite ambigui

L'inferenza del subflow seleziona il primo nodo sorgente e il primo nodo di
uscita. Un sottografo con piu entry o piu exit non viene rifiutato e le altre
uscite vengono ignorate.

Finche il tipo del DSL rimane single-input/single-output, la struttura deve
essere validata e l'ambiguita deve produrre un errore. In futuro si potra
estendere esplicitamente il modello a tuple o output nominati.

### Advisory non completamente dichiarative

In `front-end/src/conversion/typeEngine.ts`, circa righe 1859-1927, il motore
contiene logica specifica per `kernel_size`, dimensioni H/W/L e confronti
interpretati tramite pattern testuali. Il linguaggio di espressioni non supporta
ancora operatori logici e di confronto sufficienti per rappresentare le
condizioni dichiarate.

Le alternative coerenti sono:

- estendere parser ed evaluator con confronti e operatori logici;
- definire un AST JSON strutturato per le advisory;
- evitare di dichiarare il sistema completamente data-driven finche rimangono
  controlli speciali nel motore.

### Scoping delle variabili locali

Le variabili con prefisso `#` dovrebbero essere locali alla firma. Alcuni cicli
che propagano le annotazioni di output aggiungono pero binding simbolici senza
filtrare sempre il prefisso. Servono test che verifichino che una variabile
locale irrisolta non passi a nodi successivi o fuori da un subflow.

### Clone e validazione degli stereotype

Il parsing in `front-end/src/core/StereotypeCore.ts` clona solo parzialmente
alcune strutture annidate, come advisory, label dei join e configurazioni dei
subflow. Sarebbe preferibile una validazione di schema completa e un clone
profondo dei dati caricati.

## Firme che non rappresentano ancora il runtime

Tutti i 37 file JSON degli stereotype risultano sintatticamente validi e
contengono `type_signature`. La presenza della firma non implica pero che la
semantica sia completa.

Problemi individuati:

- `Flatten` ignora `start_dim` ed `end_dim` e appiattisce sempre le dimensioni
  non-batch;
- `Unflatten` non verifica che il prodotto di `unflattened_size` coincida con la
  dimensione sostituita e ignora parte della semantica di `dim`;
- `SequencePool` produce sempre `[B, D]` e non modella correttamente un `dim`
  arbitrario supportato dal backend;
- `PositionalEncoding` non verifica `d_model` e il limite `max_len`;
- Conv e Pool modellano principalmente parametri scalari e non tutte le tuple;
- MaxPool non rappresenta completamente `dilation` e `ceil_mode`;
- AvgPool non rappresenta completamente `ceil_mode`;
- Unsample privilegia `scale_factor` e non modella in modo completo `size` e
  parametri tuple;
- BatchNorm1d, BatchNorm2d e LayerNorm usano firme troppo permissive e non
  verificano pienamente i parametri di normalizzazione;
- MultiheadAttention, Transformer e TransformerDecoderLayer sono presentati
  come moduli unary shape-preserving, mentre l'interfaccia PyTorch e la gestione
  runtime richiedono semantiche piu articolate;
- i dtype sono controllati solo parzialmente: non e modellato un accordo dtype
  generale per tutti i join e i target delle loss non fanno parte del grafo dei
  tipi.

Per questi moduli occorre scegliere tra:

1. implementare adapter runtime e firme fedeli;
2. documentare esplicitamente il sottoinsieme supportato;
3. rimuovere temporaneamente la dichiarazione di supporto completo.

## Incoerenze nel report LaTeX

File: `analysis/report/ase_report.tex`.

Principali incongruenze:

- la grammatica documentata elenca soltanto const, symbolic, param_ref e
  wildcard, omettendo computed, param_spread e lo scoping `$`/`#`;
- viene ancora descritto il vecchio sistema `formula` + `args` con registry di
  formule, rimosso in favore del linguaggio di espressioni inline;
- ScaledDotProduct viene descritto con Q/K/V, mentre stereotype e backend
  correnti usano Q/K;
- MaskedScaledDotProduct viene presentato con una mask esterna, mentre il backend
  genera internamente una maschera causale;
- Einsum viene dichiarato privo di firma, ma possiede una firma e una action
  dedicata;
- Repeat viene dichiarato shape-preserving;
- viene affermato che ogni mutazione del grafo aggiorna immediatamente i tipi,
  cosa non vera per tutte le mutation path;
- viene affermato che la compilazione riceve tipi verificati, ma la conversione
  non controlla `typeResult.ok`;
- dtype mismatch viene descritto come `TypeError`, mentre il codice usa warning;
- conteggi di moduli, join, stereotype e test sono obsoleti;
- alcune descrizioni del trasferimento frontend/backend non riflettono
  chiaramente la nuova architettura MCP/WebSocket.

Il build `pdflatex` standard fallisce intorno alla riga 706 per il carattere
Unicode `✗`, non configurato per pdfLaTeX. Sono presenti anche warning e box
overfull. Possibili soluzioni: sostituire il simbolo con un comando LaTeX
portabile, dichiararlo tramite `\DeclareUnicodeCharacter`, oppure passare
consapevolmente a LuaLaTeX/XeLaTeX.

## Incoerenze nella documentazione Sphinx

File principale: `docs2/source/type_system.rst`.

Il build con warning trattati come errori fallisce per:

- tabella malformata intorno alla riga 386;
- tabella malformata intorno alla riga 723;
- import autodoc opzionale di `typing_extensions` non disponibile.

Altre incongruenze:

- il sistema viene definito completamente data-driven nonostante advisory,
  Einsum e alcuni controlli di categoria richiedano ancora logica nel motore;
- i conteggi degli stereotype e dei test sono obsoleti;
- le label di ScaledDotProduct non corrispondono all'implementazione;
- alcune note e marcature RST risultano malformate.

`docs/archive/reports/report/type-system-gaps.md` e ancora marcato come analisi con TODO che
risultano implementati, superati o in conflitto con piani successivi. Deve essere
aggiornato con uno stato reale oppure archiviato come documento storico.

## Miglioramento proposto per i test d'integrazione

### Obiettivo

Il test deve dimostrare questa catena precisa:

```text
diagramma selezionato
    -> NNTree compilato da quel diagramma
    -> Hydra config generata da quel NNTree
    -> main.py avviato con quella Hydra config
    -> training realmente eseguito
    -> artefatto nuovo e verificabile
```

### Pipeline proposta

1. Creare una sola directory temporanea per caso di test.
2. Compilare il diagramma sorgente in `<tmp>/nntree.json`.
3. Eseguire `converted/src/convert.py` con output esplicito in
   `<tmp>/hydra_config`.
4. Comporre la config prima del training, tramite Hydra o `--cfg job`.
5. Verificare almeno:
   - dataset atteso;
   - numero di classi;
   - root e nodi non vuoti;
   - stereotype caratteristici del diagramma;
   - assenza di Transformer/Autoencoder nei casi piccoli;
   - path della config corrispondente alla directory temporanea.
6. Avviare `main.py` con un unico contratto CLI:

   ```text
   --config-path <tmp>/hydra_config --config-name base
   ```

7. Aggiungere `devices` alla YAML generata oppure usare coerentemente
   `+trainer.devices=1`.
8. Impostare checkpoint, pesi e log sotto `<tmp>/outputs`, evitando il file
   condiviso `converted/weights.pt`.
9. Verificare che il checkpoint sia stato creato durante il test corrente, non
   che esista un residuo precedente.
10. Su fallimento riportare sempre exit code, signal, timeout, stdout e stderr.
11. Eseguire cleanup unico della directory temporanea, salvo
    `NNM_KEEP_TEMP=true`.

### Selezione dei modelli per CI

Per il Tier 3 ordinario sono sufficienti due o tre modelli piccoli:

- `mninst`, per la catena sequenziale base;
- `mnist_skips`, per fork e join Addition;
- opzionalmente `skip_connections_with_repetition`, per il subflow Repeat.

Transformer e autoencoder devono essere esclusi esplicitamente dalla matrice di
training rapido e collocati, se necessari, in job separati e opt-in.

Per limitare il tempo della CI si possono usare `fast_dev_run`,
`limit_train_batches`, `limit_val_batches` e `limit_test_batches`, mantenendo
almeno un test notturno o manuale con un'epoca completa.

### Skip e dipendenze

Quando il Tier 3 viene richiesto esplicitamente e Python/uv non e disponibile,
il test deve fallire con un messaggio chiaro oppure essere marcato come skipped
dal framework. Non deve essere sostituito da un test fittizio con
`expect(true).toBe(true)`.

Lo stesso vale per i tier inattivi: usare veri skip evita di gonfiare il numero
dei test passati.

### Separazione delle responsabilita

`main.py` esegue attualmente `trainer.test()` dopo `trainer.fit()`. Il Tier 3
definito come training smoke finisce quindi per eseguire anche parte del Tier 4.
Conviene separare esplicitamente:

- training e creazione checkpoint;
- inference/test da checkpoint;
- validazione degli output serializzati.

## Risultati delle verifiche

### Frontend

- test unitari Vitest: 291 passati, 5 skipped;
- `svelte-check`: completato con 0 errori e 11 warning;
- build Vite: completata, con warning Svelte/accessibilita e warning per
  l'externalizzazione browser di `fs`/`path` usati dal loader duale;
- Tier 0 integration smoke: completato, tenendo conto che i placeholder dei
  tier inattivi gonfiano il conteggio.

### Python

Sono stati eseguiti i test non-training di:

- `test_ops.py`;
- `test_convert.py`;
- `test_base.py`;
- `test_integration.py`.

Risultato corrente: 104 test passati. Sono comparsi due warning relativi alla scelta
implicita della dimensione di Softmax in due forward test del transformer. Non
si trattava di training.

### MCP server

- 42 test passati;
- build TypeScript completata con successo.

### Documentazione

- Sphinx con warning trattati come errori: completato con successo dopo la
  conversione delle due tabelle malformate a `list-table`;
- pdfLaTeX: completato, PDF di 23 pagine generato; rimangono solo warning di
  impaginazione non bloccanti;
- `git diff --check`: completato senza errori.

### Training controllato

Le Hydra config sono state generate dal vero script del repository. Per
`mnist_skips`, per esempio, il flusso usato e stato:

1. import di `examples/diagrams/mnist_skips.json`;
2. compilazione tramite `NNTree`;
3. scrittura del JSON intermedio in una directory temporanea;
4. esecuzione equivalente a:

   ```text
   uv run python src/convert.py <nntree.json> <hydra_config> --num-classes 10
   ```

Gli YAML non sono stati creati o modificati manualmente. Prima del training la
config composta e stata controllata per verificare dataset, nodi e modello.

Nella verifica finale sono stati eseguiti tre training piccoli, per una epoca:

| Modello | Risultato | Test metric |
|---|---:|---:|
| `mninst` | riuscito | validato dal Tier 3 |
| `mnist_skips` | riuscito | validato dal Tier 3 |
| `skip_connections_with_repetition` | riuscito | validato dal Tier 3 |

Non e stato completato alcun training di transformer o autoencoder. Durante la
diagnosi, il comando errato dell'helper ha inizialmente selezionato la config
transformer predefinita; il processo e stato interrotto appena identificata la
config errata, prima di completare un'epoca. Questo comportamento e una prova
diretta della necessita di validare la config composta prima di avviare il
training.

## Aspetti positivi gia implementati

- modello dichiarativo delle dimensioni e delle firme;
- parser ed evaluator separati per le espressioni;
- supporto a dimensioni const, symbolic, wildcard, param_ref, computed e
  param_spread;
- supporto di base a moduli, join e subflow;
- annotazioni dei tipi sui nodi e tooltip delle forme;
- scoping globale `$` e locale `#` introdotto nell'architettura;
- strutture dati per errori, warning e suggestion;
- copertura unitaria ampia del TypeEngine;
- tutti i 37 stereotype JSON validi e dotati di `type_signature`;
- pipeline Python non-training e MCP attualmente verdi.

## Stato dell'ordine di implementazione consigliato

1. Correggere la solidita dell'inferenza: Einsum, Repeat, Concat e parametri
   output-only.
2. Bloccare la conversione sugli errori hard e centralizzare il ricalcolo dopo
   ogni mutazione.
3. Rendere visibili warning, advisory e suggestion.
4. Allineare le firme degli stereotype alla reale semantica PyTorch/runtime.
5. Riparare l'integration harness usando un unico contratto CLI e validando la
   config prima del training.
6. Aggiungere regression test per ogni problema di correttezza individuato.
7. Aggiornare report LaTeX e documentazione Sphinx usando il codice come fonte
   di verita.
8. Rendere obbligatori in CI build documentazione, `git diff --check` e test
   d'integrazione piccoli ma reali.

I punti 1, 2, 3, 5, 6 e 7 sono implementati in questo branch. Il punto 4 e
stato corretto per Input tuple/Unflatten e per la semantica concettuale delle
Loss, ma resta un tema evolutivo per le interfacce multi-input dei moduli
PyTorch complessi. Il punto 8 e una raccomandazione di configurazione CI, non
una modifica funzionale della PR.

## Conclusione

La PR dispone ora delle garanzie centrali richieste dall'audit: i mismatch
individuati non vengono piu accettati, le diagnostiche raggiungono UI e MCP, la
conversione rifiuta errori hard e il training usa e valida la config Hydra
generata nello stesso caso di test. Rimangono limiti esplicitamente documentati,
in particolare la semantica terminale delle Loss nel backend e la modellazione
semplificata di alcune API PyTorch complesse; non sono regressioni introdotte
dalle correzioni e costituiscono lavoro futuro circoscritto.
