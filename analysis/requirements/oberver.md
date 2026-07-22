# Specifica dei nodi `Observable`

## 1. Obiettivo

Introdurre nel DSL di NNModelling un meccanismo visuale e dichiarativo per osservare i segnali interni prodotti da una rete neurale durante training, evaluation o inferenza.

I nodi `Observable` servono esclusivamente per l'interpretabilità e il monitoraggio. Non modificano il comportamento del modello e non partecipano alla produzione del suo output.

Gli obiettivi principali sono:

- osservare le attivazioni prodotte dai nodi;
- osservare gradienti e altri segnali esposti dal runtime;
- raccogliere statistiche sui tensori;
- confrontare rappresentazioni provenienti da nodi diversi;
- pubblicare i risultati su Weights & Biases;
- mantenere separati il grafo computazionale e il grafo di osservazione;
- rendere il comportamento degli Observable estendibile tramite stereotipi JSON.

## 2. Concetti fondamentali

Il sistema distingue due grafi sovrapposti.

### 2.1 Grafo computazionale

Contiene i nodi che partecipano al calcolo del modello, come `Input`, `Module`, `Join`, `Subflow` e `Loss`.

Le connessioni tra questi nodi determinano:

- le dipendenze computazionali;
- l'ordinamento topologico;
- il forward pass;
- la propagazione dei tipi;
- la generazione della configurazione del modello.

### 2.2 Grafo di osservazione

Contiene:

- i nodi `Observable`;
- le connessioni che terminano su un `Observable`;
- gli eventuali punti interni osservabili esposti dai moduli.

Il grafo di osservazione riceve valori dal modello, ma non può influenzarne il calcolo.

## 3. Metamodello

`Observable` è una specializzazione di `Node`.

```text
Node
├── Input
├── Module
├── Join
├── Subflow
├── Loss
└── Observable
```

Come ogni altro nodo, `Observable` può ricevere una `StereotypeApplication`.

```text
Node
└── stereotypeApplication : StereotypeApplication [0..1]
```

La classe `Observable` introduce solamente la semantica strutturale comune:

```text
Observable
────────────────────────
enabled : Boolean = true
```

Non è necessaria una classe `ObserverConfiguration` separata. Il comportamento concreto viene definito dallo stereotipo applicato e dai relativi parametri di istanza.

## 4. Semantica strutturale

Un nodo `Observable`:

- non appartiene al grafo computazionale;
- non contribuisce all'output del modello;
- non modifica i tensori osservati;
- non introduce dipendenze tra i moduli della rete;
- non partecipa all'ordinamento topologico del modello;
- non viene istanziato come layer del modello principale;
- viene compilato in una sezione separata dedicata all'interpretabilità;
- può essere abilitato o disabilitato senza modificare la semantica del modello.

Una connessione che termina su un `Observable` è considerata automaticamente una connessione di osservazione.

Non è necessario introdurre, nella prima versione, una nuova sottoclasse di `Connection`.

```text
edge.target instanceof Observable
    ⇒ observation edge
```

## 5. Handle e connessioni

### 5.1 Sorgenti osservabili

Nella prima versione, il normale `SourceHandle` di un nodo rappresenta anche il punto di osservazione del suo output pubblico.

```text
Module.out ─────────▶ Module successivo
       └────────────▶ Observable
```

La stessa uscita può essere collegata contemporaneamente:

- a uno o più nodi computazionali;
- a uno o più nodi `Observable`.

Questo è coerente con il fork implicito già previsto dal DSL.

### 5.2 Ingressi degli Observable

Un `Observable` possiede uno o più `TargetHandle`.

Il numero, l'identificatore, l'ordine e il significato degli ingressi sono definiti dal suo stereotipo.

Esempi concettuali:

- recorder di attivazioni: un ingresso;
- statistiche delle attivazioni: un ingresso;
- confronto CKA: due ingressi;
- matrice CKA multilayer: numero variabile di ingressi.

Gli ingressi multipli devono conservare l'ordine determinato dai rispettivi `targetHandle`.

### 5.3 Uscite degli Observable

Nella prima versione, un `Observable` non possiede `SourceHandle` computazionali.

I risultati dell'analisi vengono:

- registrati nel runtime;
- pubblicati su Weights & Biases;
- eventualmente salvati come artifact;
- restituiti come metadati dell'esecuzione.

Un risultato prodotto da un `Observable` non può essere collegato a un nodo computazionale.

## 6. Osservazione degli stati interni

Ogni nodo espone implicitamente il proprio output pubblico come punto osservabile.

Per osservare valori interni di un modulo monolitico, lo stereotipo del modulo può dichiarare punti osservabili aggiuntivi.

Esempi di segnali interni:

- query, key e value di un modulo di attenzione;
- attention scores;
- attention pattern;
- output delle singole teste;
- residual stream;
- output precedente o successivo alla normalizzazione;
- rappresentazione latente;
- stato interno di un blocco ricorrente.

Questi punti osservabili sono dichiarati dallo stereotipo del modulo, non dallo stereotipo dell'Observable.

```text
ModuleStereotype
└── observablePoints : ObservablePoint [0..*]
```

```text
ObservablePoint
────────────────────────
id          : String
label       : String
tensorType  : TypeSignature [0..1]
```

Il normale output del nodo corrisponde a un punto osservabile implicito denominato `out`.

Gli `ObservablePoint` aggiuntivi possono essere mostrati nell'editor solamente quando è attiva una modalità dedicata all'interpretabilità.

## 7. Responsabilità dello stereotipo Observable

Lo stereotipo applicato a un `Observable` definisce completamente il comportamento dell'analisi.

Lo stereotipo deve dichiarare almeno:

- la categoria `Observable`;
- il numero e il significato degli ingressi;
- il tipo di segnale acquisito;
- le modalità di esecuzione supportate;
- il momento di finalizzazione;
- la strategia predefinita di conservazione;
- l'implementazione Python;
- lo schema logico del risultato;
- i parametri configurabili dall'utente.

### 7.1 Proprietà semantiche fisse

Sono parte del contratto dell'analisi e non devono essere modificate liberamente dall'utente:

- tipo di segnale acquisito;
- fase di finalizzazione;
- numero e significato degli ingressi;
- modalità supportate;
- implementazione Python;
- tipo di risultato prodotto.

### 7.2 Parametri di istanza

Sono dichiarati dallo stereotipo e valorizzati nella `StereotypeApplication`.

Possono comprendere:

- modalità nelle quali abilitare la singola istanza;
- limite massimo di campioni;
- frequenza di campionamento;
- spostamento dei tensori su CPU;
- distacco dal grafo autograd;
- nome della tabella W&B;
- parametri specifici dell'analisi;
- parametri relativi alla visualizzazione;
- parametri relativi alla serializzazione.

## 8. Enumerazioni semantiche

### 8.1 `ExecutionMode`

Specifica i contesti nei quali un Observable può essere eseguito.

```text
ExecutionMode
─────────────
TRAIN
EVAL
PREDICT
```

- `TRAIN`: esecuzione durante l'addestramento.
- `EVAL`: esecuzione durante validation o test.
- `PREDICT`: esecuzione finalizzata alla produzione di predizioni.

Lo stereotipo dichiara le modalità supportate. La singola applicazione può selezionare un sottoinsieme delle modalità supportate.

### 8.2 `CaptureKind`

Specifica quale categoria di segnale viene ricevuta dall'Observable.

```text
CaptureKind
──────────────────
FORWARD_VALUE
BACKWARD_GRADIENT
```

- `FORWARD_VALUE`: osserva il valore prodotto dal punto osservabile durante il forward pass.
- `BACKWARD_GRADIENT`: osserva il gradiente associato al valore durante il backward pass.

Il punto concreto osservato è determinato dalla connessione sorgente. `CaptureKind` appartiene alla specifica dello stereotipo Observable.

### 8.3 `FinalizePhase`

Specifica quando l'Observable elabora definitivamente i dati raccolti e pubblica il risultato.

```text
FinalizePhase
─────────────
IMMEDIATE
POST_BATCH
POST_STEP
POST_EPOCH
POST_RUN
```

- `IMMEDIATE`: il risultato viene prodotto dopo ogni osservazione.
- `POST_BATCH`: il risultato viene prodotto alla fine del batch.
- `POST_STEP`: il risultato viene prodotto dopo un passo dell'ottimizzatore.
- `POST_EPOCH`: il risultato viene prodotto alla fine dell'epoca.
- `POST_RUN`: il risultato viene prodotto alla fine dell'intera esecuzione.

`FinalizePhase` appartiene allo stereotipo, perché dipende dalla semantica dell'analisi.

### 8.4 `RetentionScope`

Specifica per quanto tempo le osservazioni devono essere considerate prima della finalizzazione.

```text
RetentionScope
──────────────
LAST
BATCH
EPOCH
RUN
```

- `LAST`: conserva solamente l'ultima osservazione.
- `BATCH`: conserva o aggrega le osservazioni del batch corrente.
- `EPOCH`: conserva o aggrega le osservazioni dell'epoca corrente.
- `RUN`: conserva o aggrega le osservazioni dell'intera esecuzione.

Lo stereotipo definisce il valore predefinito e può permettere alla singola istanza di sovrascriverlo.

### 8.5 `StorageStrategy`

Specifica come gestire i dati durante il periodo indicato da `RetentionScope`.

```text
StorageStrategy
───────────────
FULL
STREAMING
SAMPLED
```

- `FULL`: conserva integralmente le osservazioni.
- `STREAMING`: aggiorna progressivamente statistiche o strutture aggregate senza conservare tutti i tensori.
- `SAMPLED`: conserva solamente un sottoinsieme delle osservazioni.

Lo stereotipo definisce quali strategie sono supportate.

Non è prevista una `ReductionMode` comune: media, varianza, istogrammi, CKA e altre trasformazioni appartengono all'implementazione specifica dello stereotipo.

## 9. Esecuzione runtime

Il runtime deve mantenere separati:

- l'esecuzione dei nodi computazionali;
- l'esecuzione degli Observable.

Dopo la produzione di un punto osservabile, il runtime inoltra il valore agli Observable collegati.

```text
1. Il modulo produce un valore.
2. Il valore continua nel grafo computazionale.
3. Il runtime individua gli Observable collegati.
4. Ogni Observable abilitato riceve il valore.
5. L'Observable aggiorna il proprio stato interno.
6. Alla FinalizePhase prevista, produce e pubblica il risultato.
```

L'attivazione effettiva dipende da:

- `Observable.enabled`;
- modalità corrente del runtime;
- modalità supportate dallo stereotipo;
- modalità selezionate nei parametri dell'istanza.

Gli Observable devono essere disattivabili globalmente per evitare overhead durante normali esecuzioni del modello.

## 10. Stato interno e risultato

Il runtime deve distinguere tra:

### 10.1 Stato temporaneo dell'Observable

Contiene i dati necessari per calcolare il risultato.

Può includere:

- tensori;
- campioni;
- somme progressive;
- contatori;
- matrici aggregate;
- istogrammi;
- riferimenti ad artifact temporanei.

Lo stato non è parte del modello e non deve essere serializzato nei pesi.

### 10.2 Risultato dell'Observable

È il valore finalizzato prodotto dall'analisi.

Può includere:

- scalari;
- statistiche;
- matrici;
- immagini;
- istogrammi;
- riferimenti a tensori;
- riferimenti ad artifact;
- tabelle.

## 11. Integrazione con Weights & Biases

Ogni istanza di `Observable` crea una propria W&B Table.

La tabella è identificata in modo stabile mediante l'ID o il nome dell'Observable.

Ogni volta che viene raggiunta la `FinalizePhase`, l'Observable aggiunge una o più righe alla propria tabella.

Le colonne comuni devono includere, quando disponibili:

- identificatore dell'Observable;
- nome dell'Observable;
- stereotipo applicato;
- modalità di esecuzione;
- epoch;
- global step;
- batch index;
- nodi e punti osservati;
- numero di campioni;
- timestamp.

Le colonne specifiche dipendono dallo stereotipo.

I tensori di grandi dimensioni non devono essere inseriti direttamente nella tabella. Devono essere salvati come artifact o file, mentre la tabella conserva:

- riferimento all'artifact;
- shape;
- dtype;
- dimensione;
- metadati dell'osservazione.

Se W&B è disabilitato, il runtime deve poter conservare i risultati localmente senza modificare la semantica dell'Observable.

## 12. Compilazione

Il compilatore deve separare i nodi computazionali dagli Observable.

Una possibile rappresentazione compilata contiene due sezioni:

```text
model.nodes
    nodi del grafo computazionale

interpretability.observables
    definizioni degli Observable e delle loro sorgenti
```

Per ogni Observable devono essere preservati:

- ID;
- nome;
- stereotipo;
- parametri;
- stato `enabled`;
- modalità abilitate;
- ingressi ordinati;
- nodo sorgente;
- punto osservabile sorgente;
- implementazione runtime;
- configurazione W&B.

Le connessioni verso gli Observable non devono comparire tra le dipendenze computazionali dei moduli.

## 13. Type system

Il tipo di ciascun ingresso di un Observable deriva dal punto osservabile collegato.

Gli Observable non producono tipi nel grafo computazionale.

Uno stereotipo Observable può dichiarare vincoli sui propri ingressi.

Un errore di tipo relativo a un Observable:

- deve essere attribuito all'Observable;
- non deve rendere invalido il grafo computazionale;
- deve impedire solamente l'esecuzione dell'analisi incompatibile.

## 14. Validazione

Il sistema deve verificare almeno le seguenti condizioni:

1. uno stereotipo applicato a un `Observable` deve essere compatibile con la categoria `Observable`;
2. ogni ingresso obbligatorio deve avere esattamente una connessione;
3. il numero e l'ordine degli ingressi devono rispettare lo stereotipo;
4. il punto osservabile sorgente deve esistere;
5. la modalità scelta dall'istanza deve essere supportata dallo stereotipo;
6. un Observable che richiede gradienti deve essere utilizzato in un contesto che esegue il backward;
7. un Observable non può alimentare nodi del grafo computazionale;
8. gli Observable devono essere esclusi dal rilevamento dei cicli computazionali;
9. gli errori degli Observable non devono bloccare la conversione del modello quando gli Observable sono disabilitati;
10. l'assenza dell'integrazione W&B non deve impedire l'esecuzione del modello.

## 15. Stereotipi iniziali

La prima versione dovrebbe includere un insieme ridotto di stereotipi.

### `ActivationRecorder`

Registra il valore prodotto da un punto osservabile.

### `ActivationStatistics`

Calcola statistiche aggregate sulle attivazioni, come media, varianza, norma e sparsità.

### `GradientStatistics`

Osserva i gradienti e produce statistiche aggregate durante il backward.

### `CKAComparison`

Riceve due rappresentazioni e calcola la loro similarità tramite Centered Kernel Alignment.

### `AttentionVisualizer`

Riceve una matrice di attenzione e produce una rappresentazione visuale o tabellare.

L'implementazione iniziale può limitarsi ai primi tre stereotipi e aggiungere gli altri successivamente.

## 16. Non-obiettivi

Questa funzionalità non introduce:

- memoization dei tensori;
- caching computazionale;
- riuso delle attivazioni per evitare calcoli;
- KV cache;
- stato ricorrente del modello;
- `StateHandle`;
- modifica o sostituzione delle attivazioni;
- ablation;
- activation patching;
- interventi causali sul forward;
- gradienti prodotti dagli Observable verso il modello principale.

Gli Observable sono esclusivamente strumenti passivi di osservazione e analisi.

## 17. Estensioni future

Il design deve consentire future estensioni senza modificare la semantica di base:

- punti osservabili interni dichiarati dagli stereotipi dei moduli;
- confronto tra più layer;
- analisi tra modelli differenti;
- linear probing;
- PCA e altre tecniche di riduzione dimensionale;
- analisi del residual stream;
- logit lens;
- osservazione di query, key, value e attention pattern;
- esportazione di dataset di attivazioni;
- interventi causali tramite un futuro tipo di nodo distinto da `Observable`;
- integrazione con un oggetto simile ad `ActivationCache` per analisi offline.

## 18. Criteri di accettazione della prima versione

La prima versione è completa quando:

1. è possibile creare un nodo `Observable` nel diagramma;
2. un `Observable` può ricevere una connessione dal `SourceHandle` di un nodo;
3. gli Observable non compaiono nel grafo computazionale compilato;
4. la rete produce lo stesso output con Observable abilitati o disabilitati;
5. lo stereotipo determina il comportamento dell'Observable;
6. almeno `ActivationRecorder` e `ActivationStatistics` sono disponibili;
7. gli Observable possono essere abilitati per modalità di esecuzione;
8. ogni Observable crea una propria W&B Table;
9. i risultati vengono pubblicati nella fase definita dallo stereotipo;
10. il type checker valida gli ingressi senza propagare tipi dagli Observable;
11. la conversione e l'esecuzione dei diagrammi esistenti rimangono compatibili;
12. la funzionalità è coperta da test unitari e da almeno un test end-to-end. Questa enumerazione non è necessaria se il metamodello utilizza già le sottoclassi `SourceHandle` e `TargetHandle`.
