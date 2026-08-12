---
kind: historical-plan
status: completed
archived: 2026-08-12
current_knowledge: ../../../knowledge/contracts/model-package.md
---

# Export di modelli addestrati come wheel pip

**Stato:** implementazione iniziale
**Data:** 2026-07-21

## Obiettivo

Al termine di un job remoto riuscito, NNModelling deve produrre una wheel pip
installabile che permetta di caricare il modello senza il repository, il
backend, Lightning, W&B o il dataset di training.

```text
job riuscito
  ├─ architecture.json
  ├─ weights.safetensors
  ├─ model-package.json
  └─ dist/nnm_<nome_scelto>-0.1.0-py3-none-any.whl
                               ↓ pip install
                         import nnm_<nome_scelto>
                               ↓
                    load_model().predict(...)
```

Il wheel è un artifact del job, scaricabile solo dal proprietario della
connessione che ha creato il job.

Il browser inserisce il solo suffisso del nome: ``mnist_classifier`` diventa
``nnm_mnist_classifier`` sia come wheel sia come modulo importabile. Il
backend accetta esclusivamente ``nnm_<nome>`` con lettere, numeri e underscore
per evitare differenze tra nome della distribuzione e nome da importare.

## Decisioni

### Pesi sicuri e riproducibili

Il training continua a produrre il legacy ``weights.pt`` per non rompere la
CLI esistente, ma produce anche ``weights.safetensors`` contenente soltanto lo
``state_dict``. Il runtime non usa pickle né ``torch.load(...,
weights_only=False)``.

### Runtime incluso nella wheel

Una wheel non dipende dall'installazione del checkout NNModelling. Contiene:

- un ``GraphNet(torch.nn.Module)`` senza le responsabilità Lightning di
  loss/metriche/optimizer;
- le operazioni custom necessarie al grafo, namespaced nella wheel;
- architettura risolta e pesi ``safetensors``;
- un adapter input serializzabile e il manifest.

Restano dipendenze pip dichiarate: ``torch``, ``hydra-core``, ``omegaconf`` e
``safetensors``; ``Pillow`` e ``torchvision`` servono agli adapter immagine.
Lightning, W&B e le classi dataset non sono dipendenze del consumatore del
modello.

### Input adapter, non dataset

Il dataset è responsabile di split, download e label di training; non è la API
di inferenza. Ogni dataset può invece esportare una ``InputAdapterSpec``:

```python
{"kind": "tensor", "version": 1}
{"kind": "image", "version": 1, "channels": 1,
 "mean": [0.1307], "std": [0.3081]}
```

Il package runtime possiede un registry di adapter fidati. Non serializza né
esegue codice Python arbitrario inviato dal browser.

API pubblica:

```python
from nnm_model_example import load_model

model = load_model(device="cpu")
logits = model.predict_tensor(batch_tensor)  # API universale
logits = model.predict(input_value)          # passa dall'adapter
```

``TensorAdapter`` è sempre disponibile. ``MNISTDataset`` esporta
``ImageAdapter`` e consente path, bytes o ``PIL.Image``. Per il testo,
``EnronSpamDataset`` potrà esportare ``TextAdapter`` solo quando la wheel
includerà i file del tokenizer e la revisione esatta: non è sicuro né
riproducibile dipendere da un download implicito durante ``predict``.

## Contratto artifact e API

``model-package.json`` contiene almeno schema, package name/version,
adapter spec, SHA-256 del wheel e path relativo. ``JobStatus`` espone questi
metadati senza path del filesystem.

```text
GET /jobs/{job_id}/package
```

restituisce il wheel in streaming, applicando il controllo di proprietà del
job. Il client non può scegliere un path o un filename.

## Flusso di implementazione

1. Salvare il ``state_dict`` in ``safetensors`` durante il training.
2. Definire adapter declarativi sul dataset base e MNIST.
3. Costruire una wheel pure-Python contenente runtime, config, adapter e pesi.
4. Far generare il package dal ``JobManager`` dopo un job riuscito e pubblicare
   un evento ``package_ready``.
5. Aggiungere download autorizzato e metadati nella API.
6. Testare: artifact, installazione wheel in ambiente isolato, caricamento,
   inferenza tensoriale e conversione immagine MNIST.

## Limiti iniziali

- I tokenizer testuali, label semantiche e post-processing specifici non sono
  inclusi nella prima fase.
- La wheel è un artifact singolo e non viene pubblicata automaticamente su un
  indice PyPI.
- La compatibilità è garantita per lo schema NNTree e runtime dichiarati nel
  manifest, non per qualunque wheel futura.
