# SpamHam classifier wheel consumer

Questo è un progetto `uv` standalone che usa la wheel esportata da NNModelling
per classificare un messaggio come `ham` o `spam`. La wheel deve rimanere nella
stessa cartella e deve avere il nome `nnm_spamham-0.1.0-py3-none-any.whl`.

```bash
cd examples/spamham
uv sync
just classify "hello"
```

In alternativa, si può invocare direttamente lo script installato:

```bash
uv run spamham-classify "hello"
```

Per eseguire i test:

```bash
uv run pytest -q
```

La wheel espone `nnm_spamham.Model`; il classificatore prepara il testo con lo
stesso vocabolario e la stessa lunghezza di sequenza usati dal dataset SpamHam.
