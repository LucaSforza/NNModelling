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
l’API pubblica della wheel (`load_model()` e `predict()`). Salva una galleria
con ogni immagine originale affiancata alla sua ricostruzione in
`generated/reconstructions.png`, oltre a `generated/generation-summary.json`.
La qualità può essere bassa con pochi epoch: l’immagine è una verifica visiva
della ricostruzione, non una promessa di leggibilità.
