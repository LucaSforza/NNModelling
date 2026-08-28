# VAE MNIST: wheel scaricata dal backend

Scarica la wheel dal pulsante **Scarica wheel** dopo il training del diagramma
`variational-autoencoder-complete.json`. La wheel contiene il runtime del
package graph, gli stereotipi necessari e i pesi `safetensors`: non richiede
`package_runtime` dal checkout del repository.

Per rigenerare una galleria di ricostruzioni dalla wheel scaricata:

```bash
uv run python examples/vae_mnist/generate_images.py \
  --wheel /percorso/nnm_vae_mnist_qa-0.1.0-py3-none-any.whl \
  --package-name nnm_vae_mnist_qa
```

Lo script legge direttamente il test set MNIST IDX già predisposto in
`converted/data`, senza importare `torch` o `torchvision`, e invoca soltanto
l’API pubblica della wheel: `load_model()`, `predict()` e gli adapter dichiarati
`model.adapter("sample").run(...)` e `model.adapter("forward").run(...)`.
Produce tre immagini:

- `generated/reconstructions.png`: ogni originale affiancato alla propria
  ricostruzione deterministica ottenuta con `predict()`;
- `generated/prior-samples.png`: immagini generate campionando il prior VAE
  tramite l’adapter `sample` e decodificandole tramite `forward`.
- `generated/latent-interpolation-1-to-7.png`: interpolazione lineare nello
  spazio latente tra un esempio di 1 e un esempio di 7.

Il campionamento è intenzionalmente casuale; il parametro `--seed` resta nella
traccia JSON come metadato dell’esperimento, ma non forza il generatore interno
della wheel. La qualità può essere bassa con pochi epoch: l’immagine è una
verifica visiva della ricostruzione e del percorso generativo, non una promessa
di leggibilità.
